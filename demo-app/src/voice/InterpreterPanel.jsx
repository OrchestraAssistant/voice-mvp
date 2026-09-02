import { useState } from "react";
import { useInterpreter } from "./VoiceProvider.jsx";
import { useRimCorners, setRimCorners } from "./rimCornersDev.js"; // TEMPORARY

const MODES = [
  { id: "continuous", label: "Continuous" },
  { id: "ptt", label: "Push to talk" },
  { id: "ptnt", label: "Push to not talk" },
];

/**
 * The full functional interpreter UI -- mode selector, connect/hold
 * controls, confirmation banner, transcript, text-command fallback. Built
 * entirely on useInterpreter(), same as any custom UI would be. Usable on
 * its own (embed it wherever you want the panel to live) or wrapped by
 * <InterpreterBubble/> for the floating drop-in version.
 */
export function InterpreterPanel() {
  const {
    status,
    transcript,
    pendingAction,
    error,
    mode,
    holding,
    start,
    stop,
    sendText,
    confirmManually,
    cancelManually,
    setMode,
    holdStart,
    holdEnd,
  } = useInterpreter();
  const [textInput, setTextInput] = useState("");
  const connected = status === "connected";
  const rimCorners = useRimCorners(); // TEMPORARY

  const holdLabel = mode === "ptt" ? (holding ? "Listening..." : "Hold to talk") : holding ? "Muted" : "Hold to mute";

  return (
    <div className="interpreter-panel">
      <div className="mode-selector">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={mode === m.id ? "mode-active" : ""}
            onClick={() => setMode(m.id)}
            type="button"
          >
            {m.label}
          </button>
        ))}
      </div>

      <button
        id="voice-mic-button"
        className={`mic-button mic-${status}`}
        onClick={status === "connected" || status === "connecting" ? stop : start}
      >
        {status === "connected" ? "Stop" : status === "connecting" ? "Connecting..." : "Talk"}
      </button>

      {connected && mode !== "continuous" && (
        <button
          id="voice-hold-button"
          type="button"
          className={`hold-button ${holding ? "holding" : ""}`}
          onMouseDown={holdStart}
          onMouseUp={holdEnd}
          onMouseLeave={holdEnd}
          onTouchStart={(e) => {
            e.preventDefault();
            holdStart();
          }}
          onTouchEnd={(e) => {
            e.preventDefault();
            holdEnd();
          }}
        >
          {holdLabel}
        </button>
      )}
      {connected && mode !== "continuous" && <span className="hold-hint">or hold Ctrl+Space</span>}

      <span className="voice-status">{status}</span>
      {error && <p className="error">{error}</p>}

      {pendingAction && (
        <div className="confirm-banner">
          <p>
            Confirm: <strong>{pendingAction.description}</strong> {JSON.stringify(pendingAction.args)}
          </p>
          <button onClick={confirmManually}>Confirm</button>
          <button onClick={cancelManually}>Cancel</button>
        </div>
      )}

      <div className="transcript">
        {transcript.slice(-6).map((turn, i) => (
          <p key={i} className={`turn turn-${turn.role}`}>
            <strong>{turn.role}:</strong> {turn.text}
          </p>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (textInput.trim()) sendText(textInput.trim());
          setTextInput("");
        }}
      >
        <input
          aria-label="Type a voice command for testing"
          placeholder="Or type a command to test without a mic..."
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
        />
        <button type="submit">Send</button>
      </form>

      {/* TEMPORARY -- rim shape comparison, see rimCornersDev.js. Reuses the
          mode-selector styling so it needs no CSS of its own, and lives at
          the bottom so it doesn't read as a second voice mode. */}
      <span className="hold-hint">Rim corners (temporary)</span>
      <div className="mode-selector">
        {["square", "rounded"].map((shape) => (
          <button
            key={shape}
            type="button"
            className={rimCorners === shape ? "mode-active" : ""}
            onClick={() => setRimCorners(shape)}
          >
            {shape === "square" ? "Square" : "Rounded"}
          </button>
        ))}
      </div>
    </div>
  );
}
