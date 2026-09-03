import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionUpdate } from "../src/realtimeClient.js";

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
