import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "@babel/parser";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fieldsOf, zodBodies } from "../../schema/zod.js";

/** Parse a `z.object({...})` snippet and read its fields the way the enricher does. */
function fields(src) {
  const ast = parse(src, { sourceType: "module", plugins: ["typescript"] });
  let obj;
  (function find(n) {
    if (!n || typeof n !== "object" || obj) return;
    if (n.type === "CallExpression" && n.callee?.object?.name === "z" && n.callee?.property?.name === "object") {
      obj = n.arguments[0];
      return;
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(find);
      else if (v && typeof v === "object") find(v);
    }
  })(ast);
  return fieldsOf(obj);
}
const field = (src, name) => fields(src).find((f) => f.name === name);

describe("opaque conventions (case 2)", () => {
  test("a nested array is flagged: the index carries unnamed meaning", () => {
    const f = field("const S = z.object({ schedule: z.array(z.array(z.object({ start: z.date(), end: z.date() }))) })", "schedule");
    assert.equal(f.review.kind, "opaque");
    assert.match(f.review.reason, /nested array/);
    // and the shape a person sees is still the terse one -- scalars stay names.
    assert.equal(f.shape, "Array<Array<{ start, end }>>");
  });

  test("an array of objects with no identifying field is flagged", () => {
    const f = field("const S = z.object({ slots: z.array(z.object({ start: z.string(), end: z.string() })) })", "slots");
    assert.equal(f.review.kind, "opaque");
    assert.match(f.review.reason, /no identifying field/);
  });

  test("an array of objects that DO identify themselves is not flagged", () => {
    const f = field("const S = z.object({ items: z.array(z.object({ id: z.number(), start: z.string() })) })", "items");
    assert.equal(f.review, undefined);
  });

  test("a fixed-length list of bare values is flagged", () => {
    const f = field("const S = z.object({ week: z.array(z.number()).length(7) })", "week");
    assert.equal(f.review.kind, "opaque");
    assert.match(f.review.reason, /positions carry meaning/);
  });

  test("an ordinary list of ids is left alone", () => {
    const f = field("const S = z.object({ ids: z.array(z.number()) })", "ids");
    assert.equal(f.review, undefined);
  });
});

describe("unknown shapes (case 3)", () => {
  test("z.any() is unknown", () => {
    assert.equal(field("const S = z.object({ blob: z.any() })", "blob").review.kind, "unknown");
  });
  test("z.unknown() is unknown", () => {
    assert.equal(field("const S = z.object({ blob: z.unknown() })", "blob").review.kind, "unknown");
  });
  test("z.record() is unknown -- arbitrary keys", () => {
    const f = field("const S = z.object({ meta: z.record(z.string()) })", "meta");
    assert.equal(f.review.kind, "unknown");
    assert.match(f.review.reason, /arbitrary keys/);
  });
});

describe("render truncation (case 4)", () => {
  test("a deep object chain trips the render cap and is flagged truncated", () => {
    // Four object levels under the field: the fourth is at the cap and renders
    // as a bare `object`, so the model is shown a partial shape.
    const f = field(
      "const S = z.object({ a: z.object({ b: z.object({ c: z.object({ d: z.object({ e: z.string() }) }) }) }) })",
      "a",
    );
    assert.equal(f.review.kind, "truncated");
    assert.match(f.shape, /object/);
  });

  test("a shallow object is fully rendered and not flagged", () => {
    const f = field("const S = z.object({ user: z.object({ name: z.string(), email: z.string() }) })", "user");
    assert.equal(f.review, undefined);
    assert.equal(f.shape, "{ name, email }");
  });
});

describe("an empty-body write is flagged unknown, with a reason that points somewhere", () => {
  // Run the enricher over an empty source tree so only the roll-up fires.
  // Nested, because the name-correlation fallback also walks root/../.. and a
  // bare /tmp dir would send it into the system (EACCES on /etc/ssl/private).
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "zod-empty-"));
  const emptyDir = path.join(base, "app", "src");
  fs.mkdirSync(emptyDir, { recursive: true });
  const rollup = (action) => {
    zodBodies.run({ srcDir: emptyDir, root: emptyDir, actions: [action] });
    return action.review;
  };

  test("a declared-but-unresolved schema names the symbol to chase", () => {
    const r = rollup({ name: "webhookCreate", method: "POST", bodyFields: [], _inputSchema: "ZCreateInputSchema" });
    assert.equal(r[0].kind, "unknown");
    assert.match(r[0].reason, /ZCreateInputSchema/);
    assert.match(r[0].reason, /where it is defined/);
  });

  test("a hook with no schema points at the form", () => {
    const r = rollup({ name: "usersUpdate", method: "PUT", bodyFields: [], _hookName: "useUsersUpdate" });
    assert.match(r[0].reason, /useUsersUpdate/);
    assert.match(r[0].reason, /form/);
  });

  test("nothing declared points at the handler", () => {
    const r = rollup({ name: "createCancel", method: "POST", bodyFields: [] });
    assert.match(r[0].reason, /handler/);
  });

  test("a GET with no body is not flagged -- it takes no input to specify", () => {
    const action = { name: "list", method: "GET", bodyFields: [] };
    zodBodies.run({ srcDir: emptyDir, root: emptyDir, actions: [action] });
    assert.equal(action.review, undefined);
  });
});

describe("dates are extracted below the old cap (case 1 correctness)", () => {
  test("a date nested five levels deep is still found", () => {
    // datePaths used to cap at four; a deeper date silently lost its superjson
    // tag and failed at runtime. It must be found now, at full depth.
    const f = field(
      "const S = z.object({ x: z.array(z.array(z.array(z.array(z.object({ at: z.date() })))))  })",
      "x",
    );
    assert.deepEqual(f.dates, [["at"]]);
  });
});
