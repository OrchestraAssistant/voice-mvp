/**
 * The message protocol between the extension's three worlds.
 *
 *   content   (per tab, in the page's DOM)  -- DOM tier, manifest, API calls
 *   background (service worker)             -- tab orchestration, the router
 *   offscreen (a hidden document)           -- the mic + Realtime session
 *
 * Every message is `{ kind, ...payload }` and every tool round-trip is a
 * request/response with an `id`, so the offscreen session can `await` a tool
 * result that a content script produces two hops away.
 */

export const KIND = {
  // offscreen -> background -> (content | background): run one tool.
  TOOL_CALL: "tool-call",
  TOOL_RESULT: "tool-result",
  // background -> content: "what manifest, if any, does this page serve?"
  PROBE: "probe-manifest",
  MANIFEST: "manifest",
  // content -> background: the user clicked the widget / said start on this tab.
  ACTIVATE: "activate-tab",

  // The UI channel: the session lives in the offscreen doc, the panel in the
  // content script, so its state is streamed across (via the worker).
  STATE: "ui-state", // offscreen -> content: { status, userSpeaking, agentBusy }
  TRANSCRIPT: "ui-transcript", // offscreen -> content: { role, text }
  SNAPSHOT: "ui-snapshot", // offscreen -> content: { status, transcripts } (on (re)mount)
  UI_READY: "ui-ready", // content -> offscreen: I mounted, send me the current state
  CMD: "ui-command", // content -> offscreen: { cmd: "sendText" | "start" | "stop", ... }
};

/** offscreen -> content fire-and-forget UI updates the worker relays to the tab. */
export const UI_TO_CONTENT = new Set(["ui-state", "ui-transcript", "ui-snapshot"]);
/** content -> offscreen fire-and-forget UI commands the worker relays. */
export const UI_TO_OFFSCREEN = new Set(["ui-ready", "ui-command"]);

/**
 * Which world runs a given tool. The split IS the architecture: the browser
 * tools are the reliable, deterministic core (a browser API); the DOM and API
 * tools must run in the page, where the DOM and the auth cookies are.
 */
export const TAB_TOOLS = new Set(["open_tab", "close_tab", "switch_tab", "list_tabs", "navigate_tab", "look_at_screen"]);
export const PAGE_TOOLS = new Set([
  "navigate",
  "dom_snapshot",
  "dom_click",
  "dom_type",
  "run_query",
  "run_action",
  "expand",
]);

let seq = 0;
export const nextId = () => `${Date.now()}-${seq++}`;

/** Promise wrapper around chrome.tabs.sendMessage (callback API). */
export function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (reply) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(reply);
    });
  });
}

/** Promise wrapper around chrome.runtime.sendMessage (to the service worker). */
export function sendToRuntime(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (reply) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(reply);
    });
  });
}
