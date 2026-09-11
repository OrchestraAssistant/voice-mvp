/**
 * The one-time microphone grant, done in a full extension tab.
 *
 * A prompt requested from an action popup is flaky -- the popup and the browser
 * prompt contend for focus and it comes back "Permission dismissed". A tab is a
 * stable browsing context: the prompt sits over it, the user allows, and the
 * grant persists for the whole extension origin. The offscreen session (same
 * origin) then holds the mic with no further prompt.
 */
const status = document.getElementById("status");

document.getElementById("enable").addEventListener("click", async () => {
  status.textContent = "Requesting…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // permission is what we wanted; the session opens its own
    status.textContent = "Microphone enabled. Close this tab, open the extension popup, and click Start voice.";
  } catch (err) {
    status.textContent = `Blocked: ${err.message}. If you dismissed it, click Enable again; if you denied it, use the mic icon in the address bar to allow, then retry.`;
  }
});
