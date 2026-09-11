/**
 * The one place the microphone is granted -- and why it is here.
 *
 * getUserMedia needs a user gesture to PROMPT, and mic permission is per-ORIGIN.
 * A content script runs as the PAGE's origin (so it would prompt on every site);
 * the offscreen document, where the persistent session lives, has no gesture.
 * This popup is an EXTENSION-origin context WITH a gesture, so granting here
 * grants the mic for the whole extension -- once, for every site -- and the
 * offscreen session (same origin) then holds it with no further prompt. That is
 * the crux that lets the session live outside any page.
 */
const status = document.getElementById("status");

const send = (kind) =>
  new Promise((resolve) => chrome.runtime.sendMessage({ kind }, (r) => resolve(r ?? {})));

async function micGranted() {
  try {
    return (await navigator.permissions.query({ name: "microphone" })).state === "granted";
  } catch {
    return false; // can't tell -> assume not, send them through the grant flow
  }
}

document.getElementById("start").addEventListener("click", async () => {
  // A popup is the wrong place to PROMPT for the mic (it gets dismissed), so the
  // grant happens in a tab. Here we only start once it is already granted.
  if (!(await micGranted())) {
    status.textContent = "opening a tab to enable the microphone…";
    await chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
    status.textContent = "grant the mic in the new tab, then reopen this and click Start voice.";
    return;
  }
  status.textContent = "starting the session…";
  const res = await send("start-on-active-tab");
  status.textContent = res.error
    ? `could not start: ${res.error}`
    : "listening — talk to this tab. You can close this popup; the session keeps running across page loads.";
});

document.getElementById("stop").addEventListener("click", async () => {
  await send("stop-session");
  status.textContent = "stopped.";
});
