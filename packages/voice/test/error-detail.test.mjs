import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { trpc } from "../src/transports.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

describe("a validation error carries the fix, not just 'Invalid input'", () => {
  const errPayload = (fieldErrors) => ({
    error: { json: { message: "Invalid input", data: { zodError: { fieldErrors } } } },
  });

  test("the rejected field and its reason are surfaced", () => {
    assert.throws(() => trpc.read(errPayload({ scheduleId: ["Required"] }), { ok: false, status: 400 }),
      /Invalid input \(scheduleId: Required\)/);
  });

  test("several field errors are all named", () => {
    assert.throws(() => trpc.read(errPayload({ scheduleId: ["Required"], schedule: ["Expected array"] }), { ok: false }),
      /scheduleId: Required; schedule: Expected array/);
  });

  test("an error with no zodError still reads as before", () => {
    assert.throws(() => trpc.read({ error: { json: { message: "Unauthorized" } } }, { ok: false, status: 401 }),
      /^Error: Unauthorized$/);
  });
});

describe("a call that keeps failing the same way is stopped", () => {
  const provider = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/VoiceProvider.jsx"), "utf8");

  test("the widget tracks repeated identical failures and cuts them off", () => {
    assert.match(provider, /repeatFailRef/);
    assert.match(provider, /failed \$\{rf\.count\} times with the same error/);
    // A different error resets the count -- correcting one field to reveal the
    // next is progress, not a loop.
    assert.match(provider, /key === rf\.key \? rf\.count \+ 1 : 1/);
  });
});
