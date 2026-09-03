import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultReplyModality, sessionUpdate } from "../src/realtimeClient.js";

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/realtimeClient.js"), "utf8");

/**
 * These cover a failure mode with no symptom at the call site. A malformed
 * event is answered with an async `error` on the data channel: nothing throws,
 * no promise rejects, and the patch is silently dropped. Two session.update
 * payloads shipped without `session.type` for exactly that reason, which meant
 * push-to-talk muted the mic but never switched server VAD off.
 */
describe("realtime client", () => {
  test("session.update carries session.type", () => {
    const patch = JSON.parse(sessionUpdate({ turn_detection: null }));
    assert.equal(patch.type, "session.update");
    assert.equal(patch.session.type, "realtime", "the API rejects the patch without this, without saying so");
    assert.deepEqual(patch.session.audio.input, { turn_detection: null });
  });

  test("both turn-detection states go through the same builder", () => {
    const off = JSON.parse(sessionUpdate({ turn_detection: null }));
    const on = JSON.parse(sessionUpdate({ turn_detection: { type: "server_vad" } }));
    assert.equal(off.session.type, "realtime");
    assert.equal(on.session.type, "realtime");
    assert.deepEqual(on.session.audio.input.turn_detection, { type: "server_vad" });
  });

  test("nothing builds a session.update by hand", () => {
    // One builder means one place for the field to go missing from. A literal
    // outside it is how this bug got in twice.
    const literals = source.match(/"session\.update"/g) ?? [];
    assert.equal(literals.length, 1, "session.update is constructed somewhere other than sessionUpdate()");
  });

  test("connect waits for the channel to open", () => {
    // Resolving after setRemoteDescription hands back a session whose every
    // method throws InvalidStateError until the channel opens.
    assert.match(source, /await opened;/);
  });
});

describe("reply modality", () => {
  test("commands get a written reply", () => {
    for (const turn of [
      "Go back to the dashboard.",
      "Create a task called buy milk.",
      "Mark buy milk as done.",
      "Open the new task page.",
      "Delete the second task",
    ]) {
      assert.equal(defaultReplyModality(turn), "text", `"${turn}" should not be answered aloud`);
    }
  });

  test("questions get a spoken reply", () => {
    for (const turn of [
      "How many tasks do I have?",
      "What is on my list",
      "Which task is overdue",
      "Tell me how many users there are",
      "Read me the first task",
      "Is the report done?",
    ]) {
      assert.equal(defaultReplyModality(turn), "audio", `"${turn}" asked for an answer`);
    }
  });

  test("an unknown turn is written, not spoken", () => {
    // Speech is the expensive default, so silence about the user's intent
    // should fall to the cheap side rather than the loud one.
    assert.equal(defaultReplyModality(""), "text");
    assert.equal(defaultReplyModality(undefined), "text");
  });
});
