import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ROLES, STATIC_ROLES, validateDetector, validateRegistry } from "./contract.js";
import { runDetectors, activeExcludes, selectStages } from "./run.js";
import { DETECTORS } from "../registry.js";

const ok = (over = {}) => ({ name: "x", describe: "y", role: "producer", run: () => ({}), ...over });

describe("the detector contract", () => {
  test("every shipped detector satisfies it", () => {
    assert.deepEqual(validateRegistry(DETECTORS), []);
  });

  test("a describe is required, because it is what a user reads on a miss", () => {
    // The one output an app we cannot read produces. Without it the report
    // says a detector found nothing and not what it was looking for, which is
    // how someone concludes the product is broken rather than unsuited.
    assert.match(validateDetector(ok({ describe: "" })).join(), /describe/);
  });

  test("a role is required and must be known", () => {
    assert.match(validateDetector(ok({ role: "whatever" })).join(), /role must be one of/);
  });

  test("exclusion rules must be usable, not just present", () => {
    assert.match(validateDetector(ok({ excludes: [{ pattern: "/api/x", why: "no" }] })).join(), /RegExp/);
    assert.match(validateDetector(ok({ excludes: [{ pattern: /x/ }] })).join(), /why/);
  });

  test("two detectors cannot share a name", () => {
    // Names key the conflict report, so a duplicate would make two different
    // readings look like one.
    assert.match(validateRegistry([ok(), ok()]).join(), /duplicate name/);
  });

  test("a malformed registry fails at the start, not mid-run", () => {
    assert.throws(() => runDetectors([ok({ role: "nonsense" })], {}), /registry is invalid/);
  });
});

describe("the runner", () => {
  test("producers run before enrichers, whatever order the registry is in", () => {
    // Enrichers read what producers found. Ordering used to be a property of
    // the array, so reordering it was enough to make every enricher silently
    // do nothing -- a failure with no error and no missing output, just
    // actions that quietly had no body.
    const order = [];
    const registry = [
      ok({ name: "late-enricher", role: "enricher", run: (ctx) => order.push(`enricher saw ${ctx.actions.length}`) }),
      ok({ name: "early-producer", role: "producer", run: () => (order.push("producer"), { actions: [{ name: "a" }] }) }),
    ];
    runDetectors(registry, {});
    assert.deepEqual(order, ["producer", "enricher saw 1"]);
  });

  test("one detector throwing does not cost the others their results", () => {
    const { results, context } = runDetectors(
      [
        ok({ name: "boom", run: () => { throw new Error("bad day"); } }),
        ok({ name: "fine", run: () => ({ routes: [{ path: "/" }] }) }),
      ],
      {},
    );
    assert.match(results.find((r) => r.detector === "boom").failed, /bad day/);
    assert.equal(context.routes.length, 1);
  });

  test("not applicable is recorded differently from found nothing", () => {
    const { results } = runDetectors([ok({ name: "nope", applies: () => false })], {});
    assert.equal(results[0].skipped, true);
  });
});

describe("exclusion rules belong to the framework that applied", () => {
  test("a framework that did not apply filters nothing", () => {
    // A plain React app must never be filtered by Next.js conventions. The
    // rules used to live in one global list, so every app got every
    // framework's opinions whether or not it used that framework.
    const nextish = ok({
      name: "nextish",
      applies: () => false,
      excludes: [{ pattern: /^\/api\/auth\//, why: "auth" }],
    });
    const { results } = runDetectors([nextish], {});
    assert.deepEqual(activeExcludes([nextish], results), []);
  });

  test("and one that did applies its own", () => {
    const nextish = ok({ name: "nextish", excludes: [{ pattern: /^\/api\/auth\//, why: "auth" }] });
    const { results } = runDetectors([nextish], {});
    assert.equal(activeExcludes([nextish], results).length, 1);
  });
});

describe("stages, not just detectors", () => {
  test("every role a stage can have is known and ordered", () => {
    // Detection was modular from the start; everything after it was a fixed
    // sequence in generate.js. Naming the later steps the same way is what
    // makes them removable and switchable.
    assert.deepEqual(ROLES, ["producer", "enricher", "policy", "probe"]);
    assert.deepEqual(STATIC_ROLES, ["producer", "enricher", "policy"]);
    assert.ok(!STATIC_ROLES.includes("probe"), "a probe needs a running app, so it cannot run at generate time");
  });

  test("policies run after everything that finds or annotates", () => {
    const order = [];
    const stage = (name, role) => ok({ name, role, run: () => (order.push(name), {}) });
    runDetectors([stage("p", "policy"), stage("e", "enricher"), stage("d", "producer")], {});
    assert.deepEqual(order, ["d", "e", "p"]);
  });

  test("a stage can hand something to the ones after it", () => {
    // The overlay names what the exclusion policy must keep; without a way to
    // pass that along, a deliberate include would be filtered by a default.
    const registry = [
      ok({ name: "first", role: "enricher", run: () => ({ named: ["keepMe"] }) }),
      ok({ name: "second", role: "policy", run: (ctx) => ({ notes: [`saw ${ctx.named?.join()}`] }) }),
    ];
    const { results } = runDetectors(registry, {});
    assert.match(results.find((r) => r.detector === "second").found.notes[0], /saw keepMe/);
  });
});

describe("choosing a configuration", () => {
  const registry = [ok({ name: "a" }), ok({ name: "b" }), ok({ name: "c" })];

  test("--only keeps just what was asked for", () => {
    // Comparing nine versions of this tool meant nine git worktrees.
    // Comparing nine configurations should mean nine flags.
    assert.deepEqual(selectStages(registry, { only: ["a", "c"] }).stages.map((s) => s.name), ["a", "c"]);
  });

  test("--without drops it and keeps the rest", () => {
    assert.deepEqual(selectStages(registry, { without: ["b"] }).stages.map((s) => s.name), ["a", "c"]);
  });

  test("a name nobody recognises is reported, not ignored", () => {
    // Silently running everything because a flag was misspelled would make a
    // comparison say the opposite of the truth.
    assert.deepEqual(selectStages(registry, { without: ["typo"] }).unknown, ["typo"]);
  });

  test("asking for nothing runs everything", () => {
    assert.equal(selectStages(registry, {}).stages.length, 3);
  });
});
