/**
 * v1: inject the REAL embedded widget onto any page.
 *
 * The cleanest possible extension: the content script mounts `VoiceProvider` +
 * `Interpreter` -- the same bubble, rim, mic and session the embedded package
 * ships -- into the page. Running it in the page (not a hidden offscreen
 * document) is what makes the microphone work: the user's click on the bubble
 * is the gesture getUserMedia requires, and it prompts for mic against the page
 * the user is looking at. The widget already owns the whole loop -- session,
 * DOM tools, navigate, API calls -- so there is nothing to route.
 *
 * The manifest is probed from the page (meta / .well-known); with none, the
 * widget runs its universal DOM tier. The service-worker + offscreen files
 * remain in src/ for the cross-tab, one-persistent-session future (DIRECTIONS
 * §1); this v1 is per-tab, exactly like the embedded widget.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { VoiceProvider, Interpreter } from "../../voice/dist/voice.js";
import { probeManifest } from "./manifestProbe.js";

const RELAY_URL = "https://interpreter.hub.tailnet:3003";

let mounted = false;
async function mount() {
  if (mounted || !document.body) return;
  mounted = true;

  const manifest = (await probeManifest()) ?? { routes: [], queries: [], actions: [] };

  const host = document.createElement("div");
  host.id = "yourco-voice-ext";
  document.body.appendChild(host);

  createRoot(host).render(
    React.createElement(
      VoiceProvider,
      { manifest, relayUrl: RELAY_URL },
      React.createElement(Interpreter, null),
    ),
  );
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", mount, { once: true });
} else {
  mount();
}
