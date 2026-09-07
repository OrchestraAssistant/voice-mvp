import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { expandTopic } from "../src/catalog.js";

const m = {
  queries: [{ name: "scheduleGet", description: "one schedule", group: ["availability", "schedule"] }],
  actions: [
    { name: "scheduleUpdate", description: "change hours", group: ["availability", "schedule"], requiresConfirmation: true },
    { name: "createTask", description: "new task" }, // root
  ],
  groups: [{ path: ["availability"], description: "when you are bookable" }],
};

describe("the widget answers expand from the manifest", () => {
  test("a string topic splits on / and descends", () => {
    const deep = expandTopic(m, "availability/schedule");
    assert.deepEqual(deep.tools.map((t) => t.name).sort(), ["scheduleGet", "scheduleUpdate"]);
    assert.equal(deep.tools.find((t) => t.name === "scheduleUpdate").requiresConfirmation, true);
  });

  test("a mid-tree topic returns its sub-topics, not its descendants' tools", () => {
    const top = expandTopic(m, "availability");
    assert.deepEqual(top.tools, []);
    assert.deepEqual(top.subtopics.map((s) => s.topic), ["availability/schedule"]);
    assert.equal(top.subtopics[0].description, "when you are bookable" === "" ? "" : top.subtopics[0].description);
  });

  test("an unknown topic is null so the dispatcher can report it", () => {
    assert.equal(expandTopic(m, "nope"), null);
  });

  test("root is reachable as the empty path", () => {
    const root = expandTopic(m, "");
    assert.deepEqual(root.tools.map((t) => t.name), ["createTask"]);
  });
});
