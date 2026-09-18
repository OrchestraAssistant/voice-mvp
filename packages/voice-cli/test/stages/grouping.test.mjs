import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { grouping, groupKeyOf } from "../../stages/grouping.js";

describe("groupKeyOf (the entity a name acts on)", () => {
  test("a leading verb strips to the entity", () => {
    assert.equal(groupKeyOf("createCycle"), "cycle");
    assert.equal(groupKeyOf("createIssueLink"), "issue");
    assert.equal(groupKeyOf("deleteWatchlistEntry"), "watchlist");
  });
  test("multi-word verb qualifiers (findMany/createOne) are stripped", () => {
    assert.equal(groupKeyOf("findManyApplicationRegistrations"), "application");
    assert.equal(groupKeyOf("createOneWorkflow"), "workflow");
    assert.equal(groupKeyOf("findAllUsers"), "users");
  });
  test("a namespaced name keeps its namespace (no leading verb)", () => {
    assert.equal(groupKeyOf("availabilityScheduleUpdate"), "availability");
    assert.equal(groupKeyOf("bookingsConfirm"), "bookings");
  });
  test("a single-character fragment is skipped (oAuth -> auth, not o)", () => {
    assert.equal(groupKeyOf("oAuthCreateClient"), "auth");
  });
});

/** `count` realistically-named actions for `entity` (verb + Entity + suffix word). */
function cluster(entity, count) {
  const verbs = ["create", "update", "delete", "get", "list", "archive", "restore", "move", "assign", "toggle"];
  const suffixes = ["Link", "Reaction", "Comment", "Label", "State", "Member", "View", "Note", "Tag", "Field"];
  const Ent = entity[0].toUpperCase() + entity.slice(1);
  return Array.from({ length: count }, (_, i) => ({ name: `${verbs[i % verbs.length]}${Ent}${suffixes[i % suffixes.length]}${i}` }));
}

describe("the grouping policy", () => {
  test("a small app is left entirely at root", () => {
    const m = { queries: [], actions: [...cluster("cycle", 5), ...cluster("issue", 5)] }; // 10 ops, below budget
    grouping.run({ manifest: m });
    assert.ok(m.actions.every((o) => !o.group), "a small app must not be grouped");
  });

  test("a large app clusters entities into topics; singletons stay at root", () => {
    const m = {
      queries: [],
      actions: [
        ...cluster("issue", 44),
        ...cluster("cycle", 44),
        ...["alpha", "beta", "gamma", "delta", "epsilon"].map((u) => ({ name: `create${u[0].toUpperCase()}${u.slice(1)}` })),
      ],
    };
    grouping.run({ manifest: m });
    const inTopic = (k) => m.actions.filter((o) => o.group?.[0] === k).length;
    assert.equal(inTopic("issue"), 44, "the issue cluster is grouped");
    assert.equal(inTopic("cycle"), 44, "the cycle cluster is grouped");
    assert.equal(m.actions.filter((o) => o.group).length, 88, "only the clusters are grouped");
    // singletons (one each) are not worth a topic -> stay at root, callable
    assert.ok(!m.actions.find((o) => o.name === "createAlpha").group);
  });

  test("an operation that already carries a group is left untouched", () => {
    const m = { queries: [], actions: cluster("issue", 44) };
    m.actions[0].group = ["custom"];
    grouping.run({ manifest: m });
    assert.deepEqual(m.actions[0].group, ["custom"], "a hand/overlay group is the floor");
  });
});
