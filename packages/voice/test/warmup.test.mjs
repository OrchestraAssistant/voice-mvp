import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isUsable } from "../src/realtimeClient.js";

const src = (f) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src", f), "utf8");

describe("warming", () => {
  test("a key is usable until it is nearly out of time", () => {
    // Measured: expires_at comes back ~600s out, not the 60s the docs'
    // summaries suggest. The margin covers a slow connect after the check.
    assert.equal(isUsable({ key: "k", expiresAt: Date.now() + 600_000 }), true);
    assert.equal(isUsable({ key: "k", expiresAt: Date.now() + 30_000 }), false);
    assert.equal(isUsable({ key: "k", expiresAt: Date.now() - 1 }), false);
    assert.equal(isUsable(null), false);
    assert.equal(isUsable({ expiresAt: Date.now() + 600_000 }), false, "no key is not usable");
  });

  test("freshness is checked at the point of use, not left to a timer", () => {
    // A backgrounded tab has its intervals throttled to roughly one a minute,
    // so a refresh timer may simply not fire. The check before use is the
    // guarantee; the timer is an optimisation.
    const p = src("VoiceProvider.jsx");
    assert.match(p, /const ensureMinted = useCallback\([\s\S]{0,200}if \(isUsable\(mintedRef\.current\)\) return/);
    assert.match(p, /minted: await ensureMinted\(/);
  });

  test("warming never attaches a microphone", () => {
    // A warm connection with micAttached false keeps isListening() false, so
    // the rim stays dark on a session the user never started. Scoped to the
    // warm() body: `start()` legitimately sets it, and lives nearby.
    const p = src("VoiceProvider.jsx");
    const body = p.slice(p.indexOf("const warm = useCallback"), p.indexOf("// \"eager\" mints on mount"));
    assert.ok(body.length > 200, "could not isolate warm()");
    assert.match(body, /withMic: false/);
    assert.doesNotMatch(body, /setMicAttached\(true\)/);
    assert.doesNotMatch(body, /attachMic/);
  });

  test("the audio sender is negotiated up front so no renegotiation is needed", () => {
    // replaceTrack does not renegotiate; addTrack after the fact would need a
    // second offer/answer, which this endpoint may not accept.
    const c = src("realtimeClient.js");
    assert.match(c, /addTransceiver\("audio", \{ direction: "sendrecv" \}\)/);
    assert.match(c, /sender\.replaceTrack\(micTrack\)/);
  });

  test("warming is silent about its own failures", () => {
    // Nobody asked for it. The Talk button mints again and reports properly.
    assert.match(src("VoiceProvider.jsx"), /catch \{\s*\n\s*setTransport\("idle"\); \/\/ silent/);
  });
});

describe("the default strategy", () => {
  test("is hover, and hover mints on mount", () => {
    const p = src("VoiceProvider.jsx");
    assert.match(p, /warmup = "hover"/);
    // "hover" and "eager" both keep a key in hand; only the connect trigger
    // differs between them.
    assert.match(p, /warmup !== "eager" && warmup !== "hover"/);
  });

  test("off really does nothing", () => {
    assert.match(src("VoiceProvider.jsx"), /if \(warmup === "off" \|\| sessionRef\.current/);
  });

  test("touch devices fall back to the panel-open trigger", () => {
    // There is no pointerenter on a touchscreen, so hover alone would warm
    // nothing there.
    const b = src("InterpreterBubble.jsx");
    assert.match(b, /if \(selected !== null\) warm\?\.\(\)/);
    assert.match(b, /warmup === "hover" \? \(\) => warm\?\.\(\) : undefined/);
  });
});
