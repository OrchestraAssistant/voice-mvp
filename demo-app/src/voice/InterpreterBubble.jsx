import { useState } from "react";
import { useInterpreter } from "./VoiceProvider.jsx";
import { InterpreterPanel } from "./InterpreterPanel.jsx";

/**
 * The default drop-in UI: a floating bubble that expands into the full
 * panel, Intercom-style. Purely a composition of useInterpreter() +
 * InterpreterPanel -- nothing here that a custom UI couldn't do itself.
 * Functionality first; this intentionally isn't styled up yet.
 *
 * The listening indicator lives at the app root (<ListeningGlow/> in
 * App.jsx), not here -- it's a whole-screen signal, not a per-button one.
 * Wherever it's rendered from, it portals itself out of the host tree into
 * a top-layer overlay; see ScreenOverlay.jsx.
 */
export function InterpreterBubble() {
  const [open, setOpen] = useState(false);
  const { status } = useInterpreter();

  return (
    <div className="interpreter-bubble-root">
      {open && (
        <div className="interpreter-bubble-panel">
          <InterpreterPanel />
        </div>
      )}
      <button
        type="button"
        className={`interpreter-bubble-toggle status-${status}`}
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close voice assistant" : "Open voice assistant"}
      >
        {open ? "✕" : "🎙"}
      </button>
    </div>
  );
}
