import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { VoiceProvider } from "@yourco/voice";
import "@yourco/voice/styles.css";
import "./index.css";
import App from "./App.jsx";

const queryClient = new QueryClient();

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
    <VoiceProvider navigate={navigate} onAfterAction={() => qc.invalidateQueries()} logToRelay>
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
