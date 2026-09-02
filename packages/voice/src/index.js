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
// <VoiceProvider> is required around any of them. <ListeningGlow> is
// independent -- it renders into its own overlay outside the host's DOM,
// so it can be mounted anywhere inside the provider.

// Imported here so the build emits dist/voice.css; consumers still
// import it explicitly via "@yourco/voice/styles.css".
import "./styles.css";

export { VoiceProvider, useInterpreter } from "./VoiceProvider.jsx";
export { InterpreterBubble } from "./InterpreterBubble.jsx";
export { InterpreterPanel } from "./InterpreterPanel.jsx";
export { ListeningGlow, isListening } from "./ListeningGlow.jsx";
