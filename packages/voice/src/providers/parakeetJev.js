/**
 * A cascade provider: NVIDIA Parakeet (STT) + JEV (routing/decision) + a small
 * text model (free-text args & spoken replies) + TTS. The alternative to OpenAI
 * Realtime's integrated speech-to-speech -- cheaper and self-hostable, at the
 * cost of running the pieces yourself. See PROVIDERS.md.
 *
 * It is evaluator- and transport-agnostic: every external service is an INJECTED
 * client, so the keys live in the dev's broker (BYOK) and this file holds none.
 * The tested heart is the JEV decision engine (jevDecide.js); this file is the
 * loop that wires it to the mic, the tool executor, and the speaker.
 *
 *   parakeetJev({
 *     stt,          // Parakeet client: start({onFinal,onSpeechStart,onSpeechEnd,withMic}),
 *                   //   stop(), setEnabled(b), attachMic(), releaseMic(), hasMic(),
 *                   //   setTurnDetection(auto), beginTurn(), endTurn()
 *     evaluate,     // JEV: (state, questions) => Promise<answers>  (e.g. AI SDK experimental_evaluate)
 *     generateText, // small LLM: ({ prompt }) => Promise<string>   (free-text args + replies)
 *     tts,          // optional: { speak(text), cancel() }
 *   })
 *
 * This is a reference that would graduate to its own package
 * (`@yourco/voice-parakeet-jev`); it lives here beside openaiRealtime for now.
 */
import { decide as defaultDecide } from "./jevDecide.js";

function requireClients({ stt, evaluate, generateText }) {
  const missing = [];
  if (!stt || typeof stt.start !== "function") missing.push("stt (a Parakeet client with start())");
  if (typeof evaluate !== "function") missing.push("evaluate (a JEV client: (state, questions) => answers)");
  if (typeof generateText !== "function") missing.push("generateText (a small LLM for free-text args and replies)");
  if (missing.length) {
    throw new Error(`parakeetJev is missing required clients: ${missing.join("; ")}. They hold the keys, so wire them to your broker (BYOK). See PROVIDERS.md.`);
  }
}

/** Ask the text model to write the free-text/number/date args JEV could not. */
async function fillFreeText({ generateText, transcript, op, missing, closedArgs }) {
  const prompt =
    `The user said: "${transcript}".\n` +
    `Call the operation "${op}". These arguments still need values: ${missing.join(", ")}.\n` +
    `Already decided: ${JSON.stringify(closedArgs)}.\n` +
    `Reply with ONLY a JSON object of the missing arguments, values taken from the user's words.`;
  const raw = (await generateText({ prompt })) ?? "";
  try {
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* fall through */
  }
  // Last resort: a single missing field gets the raw text, trimmed.
  return missing.length === 1 ? { [missing[0]]: raw.trim() } : {};
}

export function parakeetJev(config = {}) {
  const { stt, evaluate, generateText, tts, decide = defaultDecide } = config;

  return {
    id: "parakeet-jev",
    capabilities: {
      pushToTalk: true,
      bargeIn: !!tts, // only if there is speech to interrupt
      textInput: true,
      warm: false, // no credential to pre-mint; the broker is hit per turn
    },

    async connect(deps = {}) {
      requireClients(config);
      const catalog = deps.toolCatalog ?? [];
      const cb = deps.callbacks ?? {};
      let stopped = false;

      const activity = (userSpeaking, agentBusy) => cb.onActivity?.({ userSpeaking, agentBusy });

      async function handleTurn(text) {
        if (stopped || !text) return;
        cb.onTranscript?.({ role: "user", text });
        activity(false, true);
        try {
          const d = await decide({ transcript: text, catalog, evaluate });

          if (d.kind === "dismiss") return cb.onHangUp?.({ because: text });

          if (d.kind === "command") {
            let args = d.args ?? {};
            if (d.needsText) {
              const filled = await fillFreeText({ generateText, transcript: text, op: d.name, missing: d.missing, closedArgs: args });
              args = { ...args, ...filled };
            }
            // The core executes it (manifest/DOM, user's cookies) and runs the
            // confirmation gate; this provider only ever PROPOSES the call.
            return await cb.onToolCall?.(d.name, args);
          }

          if (d.kind === "answer") {
            const reply = await generateText({
              prompt: `The user asked: "${text}". Answer in one short sentence, from what the app shows. Do not offer further help.`,
            });
            cb.onTranscript?.({ role: "assistant", text: reply });
            if (tts) await tts.speak?.(reply);
          }
          // kind === "none": nothing matched; stay silent, let them try again.
        } finally {
          activity(false, false);
        }
      }

      await stt.start({
        withMic: deps.withMic !== false,
        onFinal: handleTurn,
        onSpeechStart: () => activity(true, false),
        onSpeechEnd: () => activity(false, false),
      });
      cb.onStatus?.("ready");

      return {
        stop() {
          stopped = true;
          stt.stop?.();
          tts?.cancel?.();
          cb.onStatus?.("closed");
        },
        sendTextTurn: (text) => handleTurn(text),
        attachMic: () => stt.attachMic?.(),
        releaseMic: async () => stt.releaseMic?.(),
        hasMic: () => stt.hasMic?.() ?? false,
        setMicEnabled: (on) => stt.setEnabled?.(on),
        setTurnDetection: (auto) => stt.setTurnDetection?.(auto),
        clearInputBuffer: () => stt.beginTurn?.(), // PTT press
        commitAndRespond: () => stt.endTurn?.(), // PTT release
        cancelResponse: () => tts?.cancel?.(), // barge-in: stop speaking
      };
    },
  };
}
