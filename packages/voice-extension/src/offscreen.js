/**
 * The session host: mic + Realtime connection, in an offscreen document.
 *
 * One session for the whole browser, with a fixed, generic toolset. It is never
 * re-minted as the user moves between tabs; landing on a manifest page swaps the
 * dispatcher's catalog DATA, not the tools (DIRECTIONS §1's seam).
 *
 * `connectRealtimeSession` already owns the entire protocol -- it attaches the
 * mic, plays the model's audio, serialises responses, and runs the tool loop.
 * The browser connects DIRECTLY to OpenAI with the ephemeral key the relay
 * mints, so the relay is only needed for the brief mint at the start. All this
 * file adds is the ONE bridge that makes every tier reachable: a tool the model
 * calls becomes a message to the service worker, which routes it to the world
 * that can run it, and the result comes back.
 */
import { connectRealtimeSession } from "../../voice/src/realtimeClient.js";
import { KIND, sendToRuntime } from "./messaging.js";

// The relay that MINTS Realtime sessions (then the browser talks to OpenAI
// directly). Billing/relay for the extension is an open question -- README.
const RELAY_URL = "https://interpreter.hub.tailnet:3003";

let session = null;

// Session-LOCAL tools: realtimeClient has already acted on the side effect
// (answer_aloud set the modality, end_session armed the hang-up) before calling
// us; it only needs an acknowledgement back, not routing. dom_highlight and the
// confirm/cancel tools are UI the extension does not mount yet -- ack them too.
const LOCAL_ACK = new Set(["answer_aloud", "end_session", "dom_highlight", "confirm_pending_action", "cancel_pending_action"]);

/** The bridge: model tool call -> service worker -> the world that can run it. */
async function onToolCall(name, args) {
  if (LOCAL_ACK.has(name)) return { acknowledged: true, ...(args?.because ? { because: args.because } : {}) };
  const result = await sendToRuntime({ kind: KIND.TOOL_CALL, name, args });
  return result ?? { error: "no result" };
}

const log = (...a) => console.log("[voice-offscreen]", ...a);

/** Start the single session, minted with the active tab's manifest. */
async function startSession(manifest) {
  if (session) return;
  try {
    session = await connectRealtimeSession({
      relayUrl: RELAY_URL,
      manifest: manifest ?? { routes: [], queries: [], actions: [] },
      onToolCall,
      onStatus: (s) => log("status:", s),
      onTranscript: (t) => log("transcript:", t?.role, t?.text),
      onHangUp: () => {
        log("hang up");
        session?.stop?.();
        session = null;
      },
    });
    log("connected -- speak to drive the active tab");
  } catch (err) {
    log("failed to connect:", err?.message ?? err);
    session = null;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind === "start-session") startSession(msg.manifest);
  if (msg?.kind === "stop-session") {
    session?.stop?.();
    session = null;
  }
});

// Tell the worker we are alive; it replies with the pending start (if the user
// already clicked), which avoids the race where start-session is sent before
// this document's listener is attached.
sendToRuntime({ kind: "offscreen-ready" }).then((pending) => {
  if (pending?.start) startSession(pending.manifest);
});
