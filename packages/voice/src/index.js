// Public API of @yourco/voice.
//
// Three layers, all built on the same hook, in increasing order of "we
// made the decisions for you":
//
//   useInterpreter()    -- headless. All state and controls; build any UI.
//   <InterpreterPanel/> -- the full functional UI, unpositioned; drop it
//                          wherever you want the controls to live.
//   <InterpreterBubble/> -- the default drop-in: floating bubble that
//                          expands into the panel.
//
// Connection state and listening state are separate throughout:
//   transport    -- "idle" | "connecting" | "ready" | "error". Is the realtime
//                   connection up. Says nothing about the microphone.
//   micAttached  -- is a microphone actually on that session.
//   isListening({ transport, micAttached, mode, holding })
//                -- the only thing that should drive a "we can hear you"
//                   affordance. A connection can be up with no mic on it.
//
// <VoiceProvider> is required around all of them: besides the session, it
// mounts the single overlay every piece of chrome draws into. <ListeningGlow>
// needs no position of its own -- it renders into that overlay, outside the
// host's DOM -- so it can go anywhere inside the provider.

// Imported here so the build emits dist/voice.css; consumers still
// import it explicitly via "@yourco/voice/styles.css".
import "./styles.css";

export { VoiceProvider, useInterpreter } from "./VoiceProvider.jsx";
export { InterpreterBubble } from "./InterpreterBubble.jsx";
export { InterpreterPanel } from "./InterpreterPanel.jsx";
export { ListeningGlow } from "./ListeningGlow.jsx";
export { isListening } from "./listening.js";
