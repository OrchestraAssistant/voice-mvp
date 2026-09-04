/**
 * What a session actually cost.
 *
 * This exists to compare providers, not to bill anyone, so it is deliberately
 * separate from everything the package ships: no client changes, no public
 * hook, nothing a host app can read. The relay already receives every event a
 * session produces, so totalling them is a server-side concern end to end.
 *
 * Two things make this less trivial than summing a column.
 *
 * Cached input is included in `input_tokens`, not additional to it. Adding
 * both counts the cached prefix twice, and the prefix is by far the largest
 * thing in these sessions -- 4,160 of one measured session's 6,431 input
 * tokens. It also prices differently, so it cannot simply be left in.
 *
 * Audio and text price differently too, in both directions, and the split is
 * the whole reason §9 exists. A total that hides it cannot answer the only
 * question worth asking here, which is what the audio is costing.
 */

/** Zeroed totals, so a session with no responses still has the right shape. */
const empty = () => ({
  responses: 0,
  turns: 0,
  toolCalls: 0,
  input: { total: 0, cachedText: 0, cachedAudio: 0, text: 0, audio: 0, image: 0 },
  output: { total: 0, text: 0, audio: 0 },
  // Transcription is billed by duration rather than by token, and by a
  // different model than the one answering. Kept separate for both reasons.
  transcription: { seconds: 0 },
});

/**
 * Fold one session's log into totals.
 *
 * Takes the parsed lines of a .jsonl log. Unknown event types are ignored
 * rather than rejected: this has to survive a provider whose events we have
 * not seen yet, which is the entire point of building it.
 */
export function tallySession(events) {
  const t = empty();
  let model = null;
  let language = null;
  let first = null;
  let last = null;

  for (const raw of events) {
    const e = raw?.event ?? raw;
    if (!e || typeof e !== "object") continue;
    if (e.at) {
      const ms = Date.parse(e.at);
      if (!Number.isNaN(ms)) {
        if (first === null || ms < first) first = ms;
        if (last === null || ms > last) last = ms;
      }
    }

    if (e.type === "session") {
      model = e.model ?? model;
      language = e.language ?? language;
    }
    if (e.type === "connected" && e.model) model = model ?? e.model;
    if (e.type === "tool_call") t.toolCalls += 1;
    if (e.type === "user_turn") {
      t.turns += 1;
      // Present only for spoken turns, and only when the transcriber reports
      // it. A typed turn has no duration and must not be counted as zero-cost
      // audio, which is why this is guarded rather than defaulted.
      if (typeof e.seconds === "number") t.transcription.seconds += e.seconds;
    }

    if (e.type !== "usage" || !e.usage) continue;
    const u = e.usage;
    const din = u.input_token_details ?? {};
    const dcache = din.cached_tokens_details ?? {};
    const dout = u.output_token_details ?? {};

    t.responses += 1;
    t.input.total += u.input_tokens ?? 0;
    t.output.total += u.output_tokens ?? 0;
    t.output.text += dout.text_tokens ?? 0;
    t.output.audio += dout.audio_tokens ?? 0;

    // The cached half is subtracted out here rather than at pricing time, so
    // every field below is what it says it is: fresh tokens, billed in full.
    const cachedText = dcache.text_tokens ?? 0;
    const cachedAudio = dcache.audio_tokens ?? 0;
    t.input.cachedText += cachedText;
    t.input.cachedAudio += cachedAudio;
    t.input.text += (din.text_tokens ?? 0) - cachedText;
    t.input.audio += (din.audio_tokens ?? 0) - cachedAudio;
    t.input.image += din.image_tokens ?? 0;
  }

  return {
    model,
    language,
    ...t,
    wallSeconds: first !== null && last !== null ? Math.round((last - first) / 1000) : 0,
  };
}

/**
 * What each provider charges.
 *
 * Rates are dollars per MILLION tokens, or per MINUTE where a provider bills
 * by time -- both are supported, and an entry may use either or both, because
 * providers do not agree on the unit. A entry missing a rate contributes
 * nothing to that line rather than defaulting to zero: a silent zero is how a
 * comparison comes out confidently wrong.
 *
 * THESE ARE LIST PRICES AND THEY GO STALE. Check them against the provider's
 * own page before believing a comparison, and override the whole table with
 * `--prices <file.json>` rather than editing this in place.
 */
export const PRICES = {
  "gpt-realtime": {
    provider: "openai",
    perMillion: { inputText: 4, inputAudio: 32, cachedText: 0.4, cachedAudio: 0.4, outputText: 16, outputAudio: 64 },
    transcriptionPerMinute: 0.006,
  },
  "gpt-realtime-mini": {
    provider: "openai",
    perMillion: { inputText: 0.6, inputAudio: 10, cachedText: 0.06, cachedAudio: 0.3, outputText: 2.4, outputAudio: 20 },
    transcriptionPerMinute: 0.003,
  },
  "gpt-realtime-2.1": {
    provider: "openai",
    perMillion: { inputText: 4, inputAudio: 32, cachedText: 0.4, cachedAudio: 0.4, outputText: 16, outputAudio: 64 },
    transcriptionPerMinute: 0.006,
  },
  "gpt-realtime-2.1-mini": {
    provider: "openai",
    perMillion: { inputText: 0.6, inputAudio: 10, cachedText: 0.06, cachedAudio: 0.3, outputText: 2.4, outputAudio: 20 },
    transcriptionPerMinute: 0.003,
  },
};

const LINES = [
  ["input text", (t) => t.input.text, "inputText"],
  ["input audio", (t) => t.input.audio, "inputAudio"],
  ["input cached text", (t) => t.input.cachedText, "cachedText"],
  ["input cached audio", (t) => t.input.cachedAudio, "cachedAudio"],
  ["output text", (t) => t.output.text, "outputText"],
  ["output audio", (t) => t.output.audio, "outputAudio"],
];

/**
 * Price a tally.
 *
 * Returns `priced: false` for a model with no entry rather than a total of
 * zero, so an unpriced provider shows up as a gap in the comparison instead of
 * as the cheapest option in it.
 */
export function priceSession(tally, prices = PRICES) {
  const entry = prices[tally.model];
  if (!entry) return { priced: false, model: tally.model, total: 0, lines: [] };

  const lines = [];
  for (const [label, get, rateKey] of LINES) {
    const tokens = get(tally);
    const rate = entry.perMillion?.[rateKey];
    if (!tokens || rate == null) continue;
    lines.push({ label, tokens, rate, cost: (tokens / 1e6) * rate });
  }

  const minutes = tally.transcription.seconds / 60;
  if (minutes && entry.transcriptionPerMinute != null) {
    lines.push({
      label: "transcription",
      minutes: Number(minutes.toFixed(2)),
      rate: entry.transcriptionPerMinute,
      cost: minutes * entry.transcriptionPerMinute,
    });
  }
  // Some providers bill the conversation itself by the minute rather than by
  // token. Supported so a comparison can include one at all.
  if (entry.audioPerMinute != null && tally.wallSeconds) {
    const wall = tally.wallSeconds / 60;
    lines.push({ label: "connected time", minutes: Number(wall.toFixed(2)), rate: entry.audioPerMinute, cost: wall * entry.audioPerMinute });
  }

  return {
    priced: true,
    provider: entry.provider ?? "unknown",
    model: tally.model,
    lines,
    total: lines.reduce((a, l) => a + l.cost, 0),
  };
}

/** One line of the log, appended when a session goes quiet. */
export function summaryEvent(tally, prices = PRICES) {
  const priced = priceSession(tally, prices);
  return {
    type: "summary",
    model: tally.model,
    responses: tally.responses,
    turns: tally.turns,
    toolCalls: tally.toolCalls,
    input: tally.input,
    output: tally.output,
    transcription: tally.transcription,
    wallSeconds: tally.wallSeconds,
    // Stamped with the table that produced it, because the table changes and a
    // cost with no rate attached cannot be re-checked later.
    cost: priced.priced ? { usd: Number(priced.total.toFixed(6)), lines: priced.lines } : null,
  };
}
