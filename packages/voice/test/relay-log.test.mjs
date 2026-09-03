import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRelayLogger } from "../src/relayLog.js";

/**
 * Two switches guard this, because it records what people said out loud: the
 * widget's `logToRelay` and the relay's VOICE_LOG. The relay reports its own
 * state in the mint response, and the logger has to believe it rather than
 * assume. These cover the failure that matters -- shipping transcripts to a
 * server that never asked for them.
 */
describe("relay logger", () => {
  const withFetch = (fn) => {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return new Response("{}"); };
    try { return fn(calls); } finally { globalThis.fetch = real; }
  };

  test("says nothing until the relay says logging is on", async () => {
    await withFetch(async (calls) => {
      const log = createRelayLogger({ flushMs: 0 });
      log.record({ type: "connected", logId: "abc", logging: false });
      log.record({ type: "user_turn", text: "delete everything" });
      log.stop();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(calls.length, 0, "posted a transcript to a relay with logging off");
    });
  });

  test("drops events that arrive before a session handle", async () => {
    await withFetch(async (calls) => {
      const log = createRelayLogger({ flushMs: 0 });
      log.record({ type: "user_turn", text: "before connect" });
      log.stop();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(calls.length, 0);
    });
  });

  test("batches and posts once logging is on", async () => {
    await withFetch(async (calls) => {
      const log = createRelayLogger({ relayUrl: "http://relay", flushMs: 1 });
      log.record({ type: "connected", logId: "abc", logging: true });
      log.record({ type: "user_turn", text: "how many tasks" });
      log.record({ type: "response_requested", modality: "audio", decidedBy: "answer_aloud" });
      log.stop();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(calls.length, 1, "one request, not one per event");
      assert.equal(calls[0].url, "http://relay/voice/log");
      assert.equal(calls[0].body.logId, "abc");
      assert.equal(calls[0].body.events.length, 3);
    });
  });
});
