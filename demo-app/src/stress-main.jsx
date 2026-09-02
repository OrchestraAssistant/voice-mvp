import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ListeningGlow } from "./voice/ListeningGlow.jsx";
import { useRimCorners, setRimCorners } from "./voice/rimCornersDev.js"; // TEMPORARY

/**
 * Entry point for stress.html -- the "host app we don't know" harness.
 *
 * Deliberately NOT the demo app: no router, no query client, no
 * VoiceProvider, no index.css. Just the rim, mounted into a hostile page's
 * DOM the way a customer's app would mount it, so what's being tested is
 * the overlay itself and not any support the demo app happens to give it.
 *
 * `active` is driven by a button here rather than by a live mic session,
 * so the visual can be checked without an OpenAI key.
 */
function StressHarness() {
  const [active, setActive] = useState(true);
  // Shared with the interpreter panel's switch rather than local state, so
  // there's one source of truth for the rim's shape. TEMPORARY.
  const corners = useRimCorners();

  return (
    <>
      <ListeningGlow active={active} corners={corners} />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button id="toggle-glow" type="button" onClick={() => setActive((a) => !a)}>
          {active ? "Stop listening" : "Start listening"}
        </button>
        <button
          id="toggle-corners"
          type="button"
          onClick={() => setRimCorners(corners === "square" ? "rounded" : "square")}
        >
          Corners: {corners}
        </button>
        <button id="open-dialog" type="button" onClick={() => document.getElementById("host-dialog").showModal()}>
          Open host modal
        </button>
        <button id="open-popover" type="button" onClick={() => document.getElementById("host-popover").showPopover()}>
          Open host popover
        </button>
      </div>
    </>
  );
}

createRoot(document.getElementById("widget-mount")).render(
  <StrictMode>
    <StressHarness />
  </StrictMode>,
);
