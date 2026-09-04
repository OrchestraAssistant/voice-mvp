import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { PRICES, priceSession, summaryEvent, tallySession } from "./usage.js";

/** One response's usage, in the shape the API actually sends it. */
const usage = ({ input = 0, output = 0, text = 0, audio = 0, cachedText = 0, cachedAudio = 0, outText = 0, outAudio = 0 }) => ({
  type: "usage",
  usage: {
    input_tokens: input,
    output_tokens: output,
    input_token_details: {
      text_tokens: text,
      audio_tokens: audio,
      image_tokens: 0,
      cached_tokens: cachedText + cachedAudio,
      cached_tokens_details: { text_tokens: cachedText, audio_tokens: cachedAudio, image_tokens: 0 },
    },
    output_token_details: { text_tokens: outText, audio_tokens: outAudio },
  },
});

describe("tallying a session", () => {
  test("cached tokens are subtracted out, not added on", () => {
    // input_tokens INCLUDES the cached prefix. Treating the two as separate
    // charges the largest thing in the session twice: one measured session had
    // 4,160 cached tokens inside 6,431 input tokens.
    const t = tallySession([usage({ input: 6431, text: 6431, cachedText: 4160 })]);
    assert.equal(t.input.total, 6431);
    assert.equal(t.input.cachedText, 4160);
    assert.equal(t.input.text, 2271, "fresh text must exclude the cached prefix");
    assert.equal(t.input.text + t.input.cachedText, t.input.total);
  });

  test("audio and text are kept apart in both directions", () => {
    // They price differently by roughly an order of magnitude, and the whole
    // question this tool answers is what the audio costs.
    const t = tallySession([usage({ input: 900, text: 400, audio: 500, output: 300, outText: 100, outAudio: 200 })]);
    assert.equal(t.input.audio, 500);
    assert.equal(t.input.text, 400);
    assert.equal(t.output.audio, 200);
    assert.equal(t.output.text, 100);
  });

  test("responses accumulate across a session", () => {
    const t = tallySession([usage({ input: 100, text: 100 }), usage({ input: 250, text: 250, cachedText: 100 })]);
    assert.equal(t.responses, 2);
    assert.equal(t.input.total, 350);
    assert.equal(t.input.text, 250);
  });

  test("the model comes from the session header the relay writes", () => {
    // The client asks for a name or for nothing; only the relay knows what it
    // resolved to, and an unattributed session cannot be priced or compared.
    const t = tallySession([{ type: "session", model: "gpt-realtime-mini", language: "es" }, usage({ input: 10 })]);
    assert.equal(t.model, "gpt-realtime-mini");
    assert.equal(t.language, "es");
  });

  test("only spoken turns add transcription time", () => {
    // A typed turn has no duration. Defaulting it to zero would be harmless
    // here but hides the case where `seconds` is missing from a spoken turn.
    const t = tallySession([
      { type: "user_turn", text: "typed" },
      { type: "user_turn", text: "spoken", seconds: 4 },
      { type: "user_turn", text: "spoken", seconds: 2 },
    ]);
    assert.equal(t.turns, 3);
    assert.equal(t.transcription.seconds, 6);
  });

  test("an unknown event type is ignored rather than fatal", () => {
    // The point of this tool is to measure providers we have not seen yet.
    const t = tallySession([null, "nonsense", { type: "who_knows", weird: true }, usage({ input: 5 })]);
    assert.equal(t.responses, 1);
    assert.equal(t.input.total, 5);
  });

  test("wall time comes from the timestamps, not from a counter", () => {
    const t = tallySession([
      { type: "session", at: "2026-09-04T10:00:00.000Z", model: "gpt-realtime" },
      { ...usage({ input: 5 }), at: "2026-09-04T10:02:30.000Z" },
    ]);
    assert.equal(t.wallSeconds, 150);
  });

  test("a session with nothing in it still has the right shape", () => {
    const t = tallySession([]);
    assert.equal(t.responses, 0);
    assert.equal(t.input.total, 0);
    assert.equal(t.wallSeconds, 0);
  });
});

describe("pricing", () => {
  const tally = (events) => tallySession([{ type: "session", model: "gpt-realtime" }, ...events]);

  test("an unpriced model is a gap, not a zero", () => {
    // A silent $0 makes an unknown provider look like the cheapest one in the
    // table, which is the exact wrong answer for a tool built to compare them.
    const p = priceSession(tallySession([{ type: "session", model: "some-new-provider" }, usage({ input: 999999 })]));
    assert.equal(p.priced, false);
    assert.equal(p.total, 0);
  });

  test("cached input is charged at the cached rate", () => {
    const fresh = priceSession(tally([usage({ input: 1e6, text: 1e6 })]));
    const cached = priceSession(tally([usage({ input: 1e6, text: 1e6, cachedText: 1e6 })]));
    assert.ok(cached.total < fresh.total / 5, "caching has to be visibly cheaper or the number means nothing");
  });

  test("audio dominates, which is the finding the tool exists to show", () => {
    const text = priceSession(tally([usage({ input: 1e6, text: 1e6 })]));
    const audio = priceSession(tally([usage({ input: 1e6, audio: 1e6 })]));
    assert.ok(audio.total > text.total * 4);
  });

  test("every line carries the rate that produced it", () => {
    // A cost with no rate attached cannot be re-checked after the table moves.
    const p = priceSession(tally([usage({ input: 1000, text: 1000, output: 500, outAudio: 500 })]));
    for (const line of p.lines) {
      assert.ok(line.rate != null, `${line.label} has no rate`);
      assert.ok(line.cost >= 0);
    }
  });

  test("a caller can supply its own table", () => {
    // How another provider gets compared without editing the source.
    const mine = { "some-provider": { provider: "elsewhere", perMillion: { inputText: 1000 } } };
    const p = priceSession(tallySession([{ type: "session", model: "some-provider" }, usage({ input: 1e6, text: 1e6 })]), mine);
    assert.equal(p.priced, true);
    assert.equal(p.provider, "elsewhere");
    assert.equal(p.total, 1000);
  });

  test("a provider billing by the minute is priced too", () => {
    // Not every provider bills by token, and a comparison that can only read
    // tokens cannot include them at all.
    const byMinute = { "minute-provider": { provider: "elsewhere", audioPerMinute: 6 } };
    const t = tallySession([
      { type: "session", model: "minute-provider", at: "2026-09-04T10:00:00.000Z" },
      { ...usage({ input: 10 }), at: "2026-09-04T10:10:00.000Z" },
    ]);
    const p = priceSession(t, byMinute);
    assert.equal(p.total, 60);
  });

  test("every shipped entry prices every line it claims to", () => {
    const t = tally([usage({ input: 100, text: 50, audio: 50, cachedText: 10, output: 40, outText: 20, outAudio: 20 })]);
    for (const model of Object.keys(PRICES)) {
      const p = priceSession({ ...t, model });
      assert.equal(p.priced, true, `${model} is in the table but did not price`);
      assert.ok(p.total > 0, `${model} priced a real session at zero`);
    }
  });
});

describe("the summary line", () => {
  test("carries the totals and the rates that priced them", () => {
    const s = summaryEvent(tallySession([{ type: "session", model: "gpt-realtime" }, usage({ input: 1000, text: 1000, output: 50, outText: 50 })]));
    assert.equal(s.type, "summary");
    assert.equal(s.model, "gpt-realtime");
    assert.equal(s.input.total, 1000);
    assert.ok(s.cost.usd > 0);
    assert.ok(s.cost.lines.every((l) => l.rate != null));
  });

  test("an unpriced session still gets its token counts", () => {
    // Losing the measurement because the price table is behind would defeat
    // the purpose: the tokens are the durable part, the rates are not.
    const s = summaryEvent(tallySession([{ type: "session", model: "brand-new" }, usage({ input: 1000 })]));
    assert.equal(s.cost, null);
    assert.equal(s.input.total, 1000);
  });
});
