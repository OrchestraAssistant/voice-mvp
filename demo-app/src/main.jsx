import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { VoiceProvider } from "@yourco/voice";
import "@yourco/voice/styles.css";
import "./index.css";
import App from "./App.jsx";

const queryClient = new QueryClient();

// ?warm=off|open|eager -- how much of the connect happens before the Talk
// click, so the three can be compared by feel rather than by argument.
//   off    everything on the click (~1.6s of dead air)
//   open   mint + connect when the panel opens
//   eager  mint on mount and keep it fresh, connect when the panel opens
//   hover  mint on mount, connect when the pointer reaches the pill
const WARMUP = new URLSearchParams(window.location.search).get("warm") ?? "hover";

/**
 * The host's half of the integration. The widget doesn't import
 * react-router or react-query -- it takes `navigate` and `onAfterAction`
 * as props, so an app using neither still works. This app uses both, so
 * it hands them over here.
 */
function VoiceIntegration({ children }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    // The host opts IN; it does not implement anything. The widget posts its
    // own events to the relay, and the relay ignores them unless VOICE_LOG=1.
    // Both switches are deliberate because this records what people say.
    <VoiceProvider
      navigate={navigate}
      onAfterAction={() => qc.invalidateQueries()}
      logToRelay
      warmup={WARMUP}
    >
      {children}
    </VoiceProvider>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <VoiceIntegration>
          <App />
        </VoiceIntegration>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
