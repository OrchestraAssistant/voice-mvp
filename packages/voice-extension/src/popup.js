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

document.getElementById("start").addEventListener("click", async () => {
  status.textContent = "requesting microphone…";
  try {
    // Grant for the extension origin, with this click. Stop the tracks right
    // away -- we only needed the permission; the offscreen document opens its
    // own stream against the now-granted permission.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    status.textContent = `microphone blocked: ${err.message}`;
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
