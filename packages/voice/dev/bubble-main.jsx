import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { VoiceProvider } from "../src/VoiceProvider.jsx";
import { InterpreterBubble } from "../src/InterpreterBubble.jsx";
import { ListeningGlow } from "../src/ListeningGlow.jsx";

// The inline mount has no shadow root to inject into, so the stylesheet has
// to reach the document the way a host app's `import "@yourco/voice/styles.css"`
// does. In shadow mode it's redundant but harmless.
import "../src/styles.css";

/**
 * Entry point for bubble.html -- the *clean* host, as opposed to
 * stress.html's hostile one. There is no relay behind this page, so the
 * manifest fetch fails and the session never connects; that's fine, since
 * what this harness is for is the panel's shell -- sizing, the open/close
 * animation, the tab strip -- which doesn't depend on a live session.
 */
const params = new URLSearchParams(window.location.search);
const MOUNT = params.get("mount") === "shadow" ? "shadow" : "inline";
if (params.get("bg") === "dark") document.body.classList.add("dark");

// ?shadow=open -- force every shadow root on the page open, so the real
// overlay path can be inspected. The widget ships with a CLOSED root
// (DESIGN-CHOICES §1), which is exactly what makes it unreachable: no
// selector, no devtools query, and `host.shadowRoot` is null. That opacity
// hid a real bug -- popLayout works at mount="inline" and silently does not
// inside a shadow root -- so being able to look inside the thing that
// actually ships is worth a harness-only override.
//
// It is a patch on the platform, not a prop, so nothing in the package knows
// it happened. One behaviour genuinely differs under it: composedPath() stops
// truncating, so the click-outside code takes its open-root branch rather than
// the closed-root one. Trust this for layout questions, not for event ones.
if (params.get("shadow") === "open") {
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    return attachShadow.call(this, { ...init, mode: "open" });
  };
}

/**
 * Query inside the widget wherever it happens to be mounted -- the host tree
 * at mount="inline", or an overlay's shadow root. Only reaches into the root
 * when ?shadow=open has forced it open.
 */
function inWidget(selector) {
  const roots = [document, ...[...document.querySelectorAll("[data-interpreter-overlay]")].map((h) => h.shadowRoot)];
  for (const root of roots) {
    const el = root?.querySelector(selector);
    if (el) return el;
  }
  return null;
}

/**
 * Keyboard driver: 1 selects the Talk tab, 2 selects Settings, each toggling
 * as a real click would. It exists because the panel cannot be driven from
 * outside itself. A selector cannot reach into the shadow root, and clicking
 * a button on this page to proxy the click is worse than useless: the
 * mousedown lands outside the widget, click-outside fires, and the panel
 * closes before the proxied click arrives. A keydown touches neither.
 */
document.addEventListener("keydown", (e) => {
  const label = { 1: "Talk", 2: "Settings" }[e.key];
  if (label) inWidget(`.interpreter-widget button[aria-label="${label}"]`)?.click();
});

// ?glow=1 mounts the listening rim alongside the panel. That is the only way
// to reproduce anything about how our TWO overlays interact -- each is a
// separate top-layer popover, and the interesting bugs are the ones that need
// both of them raised at once.
createRoot(document.getElementById("widget-mount")).render(
  <StrictMode>
    <VoiceProvider>
      {params.has("glow") && <ListeningGlow active />}
      <InterpreterBubble mount={MOUNT} />
    </VoiceProvider>
  </StrictMode>,
);

// ?trace=1 -- resize recorder. Samples the animated container and the measured
// wrapper every frame for a second after each click in the widget, and writes
// the result into #trace where inspect_page can read it back.
//
// This exists because "the panel grows weird" is not a question a screenshot
// can answer -- you cannot see a 350ms overshoot in a still, and the numbers
// name the cause immediately. It found this one: opening the panel, the
// measured wrapper reported 348px tall at a container width of 56px, then
// unwrapped down to 188 as the width animated out, so the panel ballooned
// before settling. `inner` holding steady while `outer` moves is what a
// healthy transition looks like.
// Top-layer churn counter. Two overlays that both re-raise themselves when
// anything else enters the top layer will re-raise each other forever, and a
// runaway shows up here as a number climbing by thousands rather than sitting
// at a handful.
if (params.has("trace")) {
  let toggles = 0;
  document.addEventListener("toggle", () => toggles++, true);
  setInterval(() => {
    document.getElementById("toggles").textContent = `toggle events: ${toggles}`;
  }, 200);
}

if (params.has("trace")) {
  const out = document.getElementById("trace");
  const record = () => {
    const rows = [];
    const t0 = performance.now();
    const tick = () => {
      const outer = inWidget(".interpreter-widget > div");
      const inner = outer?.firstElementChild;
      // Everything in the wrapper except the tab strip, which is absolute and
      // so contributes nothing to the measured height. Two entries mean a
      // transition is mid-flight: the outgoing pane and the incoming one.
      const panes = inner ? [...inner.children].filter((c) => !c.className.includes("absolute")) : [];
      const box = (el) => `${el?.offsetHeight}x${el?.offsetWidth}`;
      rows.push(
        `${String(Math.round(performance.now() - t0)).padStart(4)}  outer ${box(outer)}  inner ${box(inner)}  panes ${panes.map((p) => p.offsetHeight).join(",")}`,
      );
      if (performance.now() - t0 < 1200) requestAnimationFrame(tick);
      else out.textContent = rows.filter((_, i) => i % 3 === 0).join("\n");
    };
    requestAnimationFrame(tick);
  };
  document.addEventListener("click", record, true);
  document.addEventListener("keydown", record, true);
}
