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

/**
 * The bridge: model tool call -> service worker -> the world that can run it.
 * Timed out, because a tool that never comes back (a tab with no content script,
 * a page that will not answer) would otherwise block the whole turn -- the
 * "reply arrived minutes later" symptom. A fast error lets the model recover.
 */
async function onToolCall(name, args) {
  if (LOCAL_ACK.has(name)) return { acknowledged: true, ...(args?.because ? { because: args.because } : {}) };
  const result = await Promise.race([
    sendToRuntime({ kind: KIND.TOOL_CALL, name, args }),
    new Promise((resolve) => setTimeout(() => resolve({ error: `tool ${name} timed out reaching the page` }), 10000)),
  ]);
  return result ?? { error: "no result" };
}

const log = (...a) => console.log("[voice-offscreen]", ...a);

// The UI lives in the content script (across the process boundary), so the
// panel's state is streamed to it. Kept here too, so a content script that
// re-mounts after a navigation can be handed the whole history.
let uiStatus = "idle";
const transcripts = [];
/** Push a UI update toward the content panel (the worker relays it to the tab). */
const toUI = (msg) => sendToRuntime(msg).catch(() => {});

// Synchronous, so two starts racing before the await (the start-session message
// AND the ready-handshake both fire on first activation) cannot both connect --
// which is the double "connected" in the logs, two sessions fighting.
let starting = false;

/** Start the single session, minted with the active tab's manifest. */
async function startSession(manifest) {
  if (session || starting) return;
  starting = true;
  uiStatus = "connecting";
  toUI({ kind: KIND.STATE, status: "connecting" });
  try {
    session = await connectRealtimeSession({
      relayUrl: RELAY_URL,
      manifest: manifest ?? { routes: [], queries: [], actions: [] },
      // We ARE a browser: this earns open_url (and any later browser tools) from
      // the relay, which the in-page widget never gets.
      surface: "extension",
      onToolCall,
      onStatus: (s) => {
        uiStatus = s;
        log("status:", s);
        toUI({ kind: KIND.STATE, status: s });
      },
      onActivity: (a) => toUI({ kind: KIND.STATE, userSpeaking: a?.userSpeaking, agentBusy: a?.agentBusy }),
      onTranscript: (t) => {
        if (!t?.text) return;
        transcripts.push({ role: t.role, text: t.text });
        log("transcript:", t.role, t.text);
        toUI({ kind: KIND.TRANSCRIPT, role: t.role, text: t.text });
      },
      // The full event stream, so we can see a response being requested and a
      // tool being called (a silent navigate/dom_snapshot has no transcript).
      onEvent: (e) => log("event:", e?.type, e?.name ?? e?.modality ?? "", e?.because ?? ""),
      onHangUp: () => {
        log("hang up");
        session?.stop?.();
        session = null;
      },
    });
    log("connected -- speak to drive the active tab");
  } catch (err) {
    log("failed to connect:", err?.message ?? err);
    uiStatus = "error";
    toUI({ kind: KIND.STATE, status: "error" });
    session = null;
  } finally {
    starting = false;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind === "start-session") startSession(msg.manifest);
  if (msg?.kind === "stop-session") {
    session?.stop?.();
    session = null;
  }
  // A content-script panel (re)mounted -- hand it the whole current state so it
  // renders the ongoing conversation, not a blank box.
  if (msg?.kind === KIND.UI_READY) {
    toUI({ kind: KIND.SNAPSHOT, status: uiStatus, transcripts });
  }
  // The user typed into the panel.
  if (msg?.kind === KIND.CMD) {
    if (msg.cmd === "sendText" && msg.text && session) {
      transcripts.push({ role: "user", text: msg.text });
      toUI({ kind: KIND.TRANSCRIPT, role: "user", text: msg.text });
      session.sendTextTurn(msg.text);
    }
  }
});

// Tell the worker we are alive; it replies with the pending start (if the user
// already clicked), which avoids the race where start-session is sent before
// this document's listener is attached.
sendToRuntime({ kind: "offscreen-ready" }).then((pending) => {
  if (pending?.start) startSession(pending.manifest);
});
