/**
 * The session host: mic + Realtime connection, in an offscreen document.
 *
 * One session for the whole browser, with a FIXED, generic toolset -- DOM
 * primitives, tab orchestration, and the three dispatchers (run_query /
 * run_action / expand). It is never re-minted as the user moves between tabs;
 * landing on a manifest page swaps the dispatcher's catalog DATA, not the tools.
 * That is the seam DIRECTIONS §1 describes, and it is why the extension can walk
 * the whole web in one session.
 *
 * Every tool the model calls is forwarded to the service worker, which routes
 * it to the world that can run it (tab tools here-adjacent; DOM/API in the
 * active tab's content script). This file only owns the audio and the loop.
 */
import { connectRealtimeSession, mintSession } from "../../voice/src/realtimeClient.js";
import { KIND, sendToRuntime } from "./messaging.js";

// The relay that mints Realtime sessions. Unlike the embedded widget (billed to
// the app developer), the extension's relay/billing is an open question -- see
// README 'Who pays'. For local testing, point it at the trial relay.
const RELAY_URL = "https://interpreter.hub.tailnet:3003";

let session = null;
let boundManifest = null; // the current tab's manifest, swapped in as the user moves

/**
 * The bridge: a tool the model calls becomes a message to the service worker,
 * which routes it and returns a result we hand back to the session. This is the
 * ONE function that makes every tier reachable from one session.
 */
async function onToolCall(name, args) {
  const result = await sendToRuntime({ kind: KIND.TOOL_CALL, name, args });
  return result ?? { error: "no result" };
}

/**
 * Start the single session. Minted with a DOM-only baseline manifest so a page
 * that serves nothing still works; a real manifest is swapped in via bindManifest.
 */
async function startSession(manifest) {
  if (session) return;
  boundManifest = manifest ?? { routes: [], queries: [], actions: [] };
  const minted = await mintSession({ relayUrl: RELAY_URL, manifest: boundManifest });
  // TODO(realtime): connectRealtimeSession wires the mic, the data channel and
  // the tool-call callbacks. Route its tool calls through onToolCall above, and
  // its audio to this document's WebRTC peer. Signature lives in
  // packages/voice/src/realtimeClient.js; the embedded widget (VoiceProvider)
  // is the reference for wiring executeTool -> onToolCall.
  session = await connectRealtimeSession({
    minted,
    manifest: boundManifest,
    onToolCall, // <- the bridge; the rest of the callback shape is the TODO
  });
}

/**
 * Swap the catalog to a new tab's manifest WITHOUT re-minting -- the dispatcher
 * makes this a data change, not a tools change.
 * TODO(realtime): push the new catalog into the live session (a session.update
 * with the new instructions/catalog, or the dispatcher reading `boundManifest`).
 */
function bindManifest(manifest) {
  boundManifest = manifest ?? { routes: [], queries: [], actions: [] };
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind === "start-session") startSession(msg.manifest);
  if (msg?.kind === "bind-manifest") bindManifest(msg.manifest);
});
