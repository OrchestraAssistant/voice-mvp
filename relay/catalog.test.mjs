import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nodeAt, rootCatalog, expand, opLine } from "./catalog.js";

const m = {
  queries: [
    { name: "tasksList", description: "list tasks" },                          // root
    { name: "scheduleGet", description: "one schedule", group: ["availability", "schedule"] },
    { name: "appsList", description: "installed apps", group: ["apps"] },
  ],
  actions: [
    { name: "scheduleUpdate", description: "change hours", group: ["availability", "schedule"], requiresConfirmation: true },
    { name: "createTask", description: "new task", bodyFields: [{ name: "title", required: true }] }, // root
  ],
  groups: [
    { path: ["availability"], description: "when you are bookable" },
    { path: ["apps"], description: "integrations" },
  ],
};

describe("the tool tree", () => {
  test("root holds only ungrouped operations", () => {
    const { direct, topics } = nodeAt(m, []);
    assert.deepEqual(direct.map((o) => o.name).sort(), ["createTask", "tasksList"]);
    assert.deepEqual(topics.map((t) => t.name).sort(), ["apps", "availability"]);
  });

  test("a topic counts everything beneath it, at any depth", () => {
    const availability = nodeAt(m, []).topics.find((t) => t.name === "availability");
    assert.equal(availability.count, 2, "scheduleGet + scheduleUpdate");
    assert.equal(availability.description, "when you are bookable");
  });

  test("the root catalog shows root ops in full and topics as names", () => {
    const cat = rootCatalog(m);
    assert.match(cat, /run_query/);
    assert.match(cat, /tasksList/);
    assert.match(cat, /createTask -- takes: title/);
    assert.match(cat, /availability -- when you are bookable \(2 tools\)/);
    assert.doesNotMatch(cat, /scheduleUpdate/, "a grouped op is not spelled out at root");
  });

  test("expand descends one level and reveals sub-topics", () => {
    const top = expand(m, "availability");
    assert.deepEqual(top.tools, [], "nothing sits directly at availability");
    assert.deepEqual(top.subtopics.map((s) => s.topic), ["availability/schedule"]);

    const deep = expand(m, "availability/schedule");
    assert.deepEqual(deep.tools.map((t) => t.name).sort(), ["scheduleGet", "scheduleUpdate"]);
    assert.equal(deep.tools.find((t) => t.name === "scheduleUpdate").requiresConfirmation, true);
  });

  test("an unknown topic returns null, not an empty node", () => {
    assert.equal(expand(m, "nope"), null);
  });

  test("a destructive query never happens; a destructive action is flagged in its line", () => {
    assert.match(opLine({ kind: "action", name: "x", requiresConfirmation: true }), /\[destructive\]/);
    assert.doesNotMatch(opLine({ kind: "query", name: "y" }), /destructive/);
  });
});
