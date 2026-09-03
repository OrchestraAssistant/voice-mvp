import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decideModality, defaultReplyModality, sessionUpdate } from "../src/realtimeClient.js";

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

describe("who decides the modality", () => {
  test("answer_aloud wins over a command-shaped turn", () => {
    // The whole point of the flag: the model knows what it is about to say,
    // and "and the other one?" is hopeless to classify from phrasing.
    assert.equal(decideModality({ transcript: "And the other one.", aloudRequested: true }), "audio");
    assert.equal(decideModality({ transcript: "Mark it done.", aloudRequested: true }), "audio");
  });

  test("without the flag it falls back to the transcript", () => {
    assert.equal(decideModality({ transcript: "How many tasks do I have?", aloudRequested: false }), "audio");
    assert.equal(decideModality({ transcript: "Go to the dashboard.", aloudRequested: false }), "text");
  });

  test("neither signal means text", () => {
    // Speech is the expensive default; silence about intent falls to the cheap
    // side rather than the loud one.
    assert.equal(decideModality({ transcript: "", aloudRequested: false }), "text");
    assert.equal(decideModality({ transcript: undefined, aloudRequested: undefined }), "text");
  });

  test("every path that commits audio asks for a response", () => {
    // create_response: false means a turn nobody answers is silence, with no
    // error and no server retry, so this is a correctness property.
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/realtimeClient.js"), "utf8");
    assert.match(source, /input_audio_buffer\.committed" && serverTurns[\s\S]{0,120}requestResponse\(\)/);
    assert.match(source, /commitAndRespond\(\)[\s\S]{0,200}requestResponse\(\)/);
    // A bare server_vad patch resets create_response to true and silently
    // hands generation back to the server.
    assert.doesNotMatch(source, /turn_detection: auto \? \{ type: "server_vad" \}/);
    assert.match(source, /server_vad", create_response: false/);
  });
});

describe("one response at a time", () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/realtimeClient.js"), "utf8");

  test("a request while one is in flight is deferred, not fired", () => {
    // Asking twice is `conversation_already_has_active_response`, which arrives
    // as an async error and DROPS the request -- so the turn that prompted it
    // gets no answer in any medium. Observed live: a user talking over a long
    // sequence had turns silently ignored.
    assert.match(source, /if \(responseActive\) \{[\s\S]{0,200}responseQueued = true/);
  });

  test("the flag is set on send, not on the server's echo", () => {
    // Two requests can leave before the first response.created comes back.
    assert.match(source, /responseActive = true;[\s\S]{0,500}type: "response\.create"/);
  });

  test("the queue is drained once, after tool calls have run", () => {
    // Draining at the top of response.done would race the tool-call path,
    // which ends in a request of its own -- two requests, same collision.
    assert.match(source, /if \(msg\.type === "response\.done"\) responseActive = false;/);
    assert.doesNotMatch(source, /responseActive = false;\s*\n\s*if \(responseQueued\)/);
  });
});

describe("batch execution", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/VoiceProvider.jsx"), "utf8");

  test("both call shapes collapse to a list before anything runs", () => {
    assert.match(source, /const \{ items, \.\.\.single \} = args;/);
    assert.match(source, /Array\.isArray\(items\) && items\.length > 0 \? items : \[single\]/);
  });

  test("a destructive batch stages the whole set and is confirmed once", () => {
    assert.match(source, /setPendingAction\(\{ action, batch \}\)/);
    assert.match(source, /runBatch\(pending\.action, pending\.batch\)/);
    assert.match(source, /Ask ONCE, for the whole set/);
  });

  test("a single-item batch is indistinguishable from before", () => {
    // The model should see exactly what it saw when batching did not exist.
    assert.match(source, /batch\.length === 1 \? results\[0\] :/);
  });

  test("writes run in order, not in parallel", () => {
    // A batch of creates that races itself lands in an order nobody asked for.
    assert.match(source, /for \(const one of batch\)[\s\S]{0,160}await runAction/);
  });
});

describe("batched queries", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/VoiceProvider.jsx"), "utf8");

  test("reads run together, unlike writes", () => {
    // There is no order to get wrong on a read, and the latency is the point.
    assert.match(source, /Promise\.all\([\s\S]{0,160}runQuery/);
  });

  test("a single lookup is untouched by the batch path", () => {
    assert.match(source, /if \(batch\.length === 1\) return await runQuery\(query, batch\[0\]\)/);
  });

  test("one failing lookup does not sink the batch", () => {
    assert.match(source, /runQuery\(query, one\)\.catch/);
  });
});
