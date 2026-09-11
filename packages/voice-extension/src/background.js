/**
 * The service worker: the router and the browser-orchestration host.
 *
 * It holds no DOM and no mic. Its jobs are: run the tab tools (the only world
 * with chrome.tabs), route every other tool call to the world that can run it,
 * own the offscreen document's lifecycle, and remember which tab the session is
 * currently driving.
 *
 * The routing IS the tiered architecture: TAB_TOOLS run here; PAGE_TOOLS
 * (DOM + API + route navigation) go to the active tab's content script; session
 * tools stay in the offscreen document.
 */
import { KIND, TAB_TOOLS, PAGE_TOOLS, sendToTab } from "./messaging.js";
import { TAB_HANDLERS } from "./tabs.js";

let drivingTabId = null; // the tab the session is currently acting on
let pendingStart = null; // { manifest } waiting for the offscreen doc to come up

const OFFSCREEN = "offscreen.html";

/** Create the offscreen document that hosts the mic + Realtime session, once. */
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN,
    // USER_MEDIA: the mic. The Realtime WebRTC connection lives here because a
    // service worker can hold neither a mic nor a long-lived peer connection.
    reasons: ["USER_MEDIA"],
    justification: "Holds the microphone and the Realtime voice session.",
  });
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

/** Route one tool call to whichever world can run it, and return its result. */
async function dispatchTool(name, args) {
  if (TAB_TOOLS.has(name)) {
    return TAB_HANDLERS[name](args ?? {});
  }
  if (PAGE_TOOLS.has(name)) {
    // The tab the session was started on, falling back to whatever is in front
    // if that one is gone. A page with no content script (chrome://, a blocked
    // page, a navigation still settling) answers with a clear error rather than
    // hanging the turn -- and we try the active tab once before giving up.
    const primary = drivingTabId ?? (await activeTabId());
    if (primary == null) return { error: "no page tab to act on" };
    try {
      return await sendToTab(primary, { kind: KIND.TOOL_CALL, name, args });
    } catch (err) {
      const alt = await activeTabId();
      if (alt != null && alt !== primary) {
        try {
          drivingTabId = alt;
          return await sendToTab(alt, { kind: KIND.TOOL_CALL, name, args });
        } catch {
          /* fall through */
        }
      }
      return { error: `could not reach the page (${err.message}); it may be a browser page or still loading` };
    }
  }
  return { error: `background cannot route tool: ${name}` };
}

// Messages from the offscreen session (tool calls) and from content scripts
// (manifest reports).
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.kind === KIND.TOOL_CALL) {
    dispatchTool(msg.name, msg.args).then(reply, (err) => reply({ error: String(err?.message ?? err) }));
    return true;
  }
  if (msg?.kind === KIND.MANIFEST) {
    // A content script reported the page's manifest (or null). If this is the
    // tab we are driving, hand it to the session so the dispatcher can swap its
    // catalog WITHOUT re-minting -- the seam that lets one session walk apps.
    if (sender.tab?.id === drivingTabId) {
      chrome.runtime.sendMessage({ kind: "bind-manifest", manifest: msg.manifest }).catch(() => {});
    }
    return false;
  }
  if (msg?.kind === "offscreen-ready") {
    // The offscreen document attached its listener. Hand it the start the user
    // already asked for, closing the load race. reply() IS the handshake.
    const start = pendingStart;
    pendingStart = null;
    reply(start ? { start: true, manifest: start.manifest } : { start: false });
    return false;
  }
  if (msg?.kind === "start-on-active-tab") {
    // From the popup, after it granted the mic. Point the session at whatever
    // tab is in front.
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => startOnTab(tab?.id))
      .then(() => reply({ ok: true }), (err) => reply({ error: String(err?.message ?? err) }));
    return true;
  }
  if (msg?.kind === "stop-session") {
    chrome.runtime.sendMessage({ kind: "stop-session" }).catch(() => {});
    drivingTabId = null;
    reply({ ok: true });
    return false;
  }
});

/** Point the session at a tab: probe its manifest, ensure the offscreen doc, start. */
async function startOnTab(tabId) {
  if (tabId == null) return;
  drivingTabId = tabId;

  // The page's manifest lights up the high-fidelity tier; null = DOM-only. Probe
  // the tab live rather than trusting an earlier report.
  let manifest = null;
  try {
    manifest = (await sendToTab(tabId, { kind: KIND.PROBE }))?.manifest ?? null;
  } catch {
    // No content script (a chrome:// page, the store): DOM-only baseline.
  }

  pendingStart = { manifest };
  await ensureOffscreen();
  // If the doc was already up, it will not send offscreen-ready again, so push
  // the start directly; the ready-handshake covers the first-creation race.
  chrome.runtime.sendMessage({ kind: "start-session", manifest }).catch(() => {});
}

// The toolbar icon opens the popup (which grants the mic and sends
// start-on-active-tab), so there is no onClicked handler here.

// If the driven tab goes away, stop driving it.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === drivingTabId) drivingTabId = null;
});
