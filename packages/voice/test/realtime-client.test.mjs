import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decideModality, defaultReplyModality, readyToHangUp, sessionUpdate } from "../src/realtimeClient.js";

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
    assert.match(source, /if \(msg\.type === "response\.done"\) \{\s*\n\s*responseActive = false;/);
    assert.doesNotMatch(source, /responseActive = false;\s*\n\s*if \(responseQueued\)/);
  });
});

describe("batch execution", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/VoiceProvider.jsx"), "utf8");

  test("a list is the only shape, with a fallback for a model that ignores it", () => {
    // The schema now says required: ["items"], so there is nothing to
    // normalise -- but a model that sent {"/":"dashboard"} against a valid
    // `path` declaration is not one to trust with a schema.
    assert.match(source, /Array\.isArray\(args\.items\) && args\.items\.length > 0 \? args\.items : \[args\]/);
  });

  test("a destructive batch stages the whole set and is confirmed once", () => {
    assert.match(source, /setPendingAction\(\{ action, batch \}\)/);
    assert.match(source, /runBatch\(pending\.action, pending\.batch\)/);
    assert.match(source, /Ask the user once to confirm/);
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


describe("staging a destructive batch", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/VoiceProvider.jsx"), "utf8");

  test("says it is staged rather than executed", () => {
    assert.match(source, /Staged, NOT executed/);
  });

  test("does not echo the batch back to the model", () => {
    // It just sent it. Repeating eleven objects costs tokens to say nothing.
    assert.doesNotMatch(source, /needs_confirmation[\s\S]{0,400}JSON\.stringify\(batch\)/);
  });
});

describe("a typed turn is a new turn", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/realtimeClient.js"), "utf8");

  test("sendTextTurn clears the spoken-reply flag", () => {
    // It reaches neither of the places that reset it for a spoken turn --
    // input_audio_buffer.committed or clearInputBuffer -- so an answer_aloud
    // from an earlier question would otherwise stick to every typed turn after.
    assert.match(source, /sendTextTurn\(text\) \{[\s\S]{0,600}aloudRequested = false;/);
  });

  test("every path that begins a turn resets it", () => {
    // Three turn starts -- input_audio_buffer.committed, clearInputBuffer for
    // push-to-talk, and sendTextTurn -- plus the declaration itself.
    const resets = source.match(/aloudRequested = false/g) ?? [];
    assert.equal(resets.length, 4, "a turn start is missing its reset");
  });
});

describe("hanging up", () => {
  const quiet = { because: "that's all for now", responseActive: false, audioPlaying: false };

  test("nothing happens without a request", () => {
    // The predicate runs on every audio-stopped event in the session, which is
    // most of them. A missing `because` is the normal case, not an edge one.
    assert.equal(readyToHangUp({ ...quiet, because: null }), false);
    assert.equal(readyToHangUp({ ...quiet, because: null, force: true }), false);
  });

  test("an empty reason still hangs up", () => {
    // The model is required to send `because`, so an empty string means it
    // sent something odd -- not that it changed its mind. Falsy-checking the
    // reason would silently ignore the call and leave the mic live.
    assert.equal(readyToHangUp({ ...quiet, because: "" }), true);
  });

  test("it waits for the goodbye to be generated", () => {
    // end_session arrives inside a response. The farewell is a SECOND response,
    // created after the tool result goes back, so acting where the call lands
    // means tearing the connection down before the goodbye is even written.
    assert.equal(readyToHangUp({ ...quiet, responseActive: true }), false);
  });

  test("it waits for the goodbye to finish being spoken", () => {
    // response.done fires while audio is still coming out of the speaker.
    // Without this the farewell is cut off mid-word, which is a worse ending
    // than no farewell at all.
    assert.equal(readyToHangUp({ ...quiet, audioPlaying: true }), false);
  });

  test("once the room is quiet, it goes", () => {
    assert.equal(readyToHangUp(quiet), true);
  });

  test("the timeout overrides the wait, and only the wait", () => {
    // If a response or an audio-buffer event never completes, waiting forever
    // leaves a live microphone after the user said they were done -- the one
    // outcome this feature must not produce.
    assert.equal(readyToHangUp({ ...quiet, responseActive: true, audioPlaying: true, force: true }), true);
  });
});

describe("hang-up wiring", () => {
  test("both ways a turn can go quiet reach the gate", () => {
    // Neither covers both media on its own: a spoken goodbye ends at
    // output_audio_buffer.stopped, a written one at response.done with no
    // audio ever starting. Wiring only the first loses every text hang-up.
    const calls = source.match(/maybeHangUp\(/g) ?? [];
    assert.ok(calls.length >= 4, `expected the gate to be armed and called from several places, saw ${calls.length}`);
    assert.match(source, /audioPlaying = false;\s*\n\s*reportActivity\(\);\s*\n\s*maybeHangUp\(\);/);
  });

  test("a hang-up that never completes still releases the microphone", () => {
    assert.match(source, /hangUpTimer = setTimeout\(\(\) => maybeHangUp\(\{ force: true \}\), 15_000\)/);
  });

  test("a spoken dismissal earns a spoken goodbye", () => {
    // Otherwise the farewell is decided by the transcript heuristic, and
    // "thanks, that's all" is command-shaped -- so someone who has already
    // looked away gets a silent goodbye they never see.
    assert.match(source, /if \(lastTurnWasSpoken\) aloudRequested = true;/);
    assert.match(source, /lastTurnWasSpoken = true;/);
    assert.match(source, /lastTurnWasSpoken = false;/);
  });

  test("releasing the mic is not closing the session", () => {
    // The two are separate on purpose: prompt caching is session-scoped, so
    // closing is the expensive way to pause.
    assert.match(source, /async releaseMic\(\)/);
    assert.match(source, /micTrack\.stop\(\);\s*\n\s*micTrack = null;/);
    assert.doesNotMatch(source, /async releaseMic\(\)[\s\S]{0,400}pc\.close\(\)/);
  });
});
