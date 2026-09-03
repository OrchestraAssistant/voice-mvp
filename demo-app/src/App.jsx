import { Routes, Route, Link } from "react-router-dom";
import Dashboard from "./pages/Dashboard.jsx";
import NewTask from "./pages/NewTask.jsx";
import TaskDetail from "./pages/TaskDetail.jsx";
import Settings from "./pages/Settings.jsx";
import { InterpreterBubble, ListeningGlow, rimState, useInterpreter } from "@yourco/voice";

// `?glow=1` forces the rim on without a live mic session, so the visual can be
// looked at on the real app's real background without an OpenAI key.
// `?glow=working` (or ready/listening) pins a state as well. A dev affordance,
// not a feature; read once at module load.
const params = new URLSearchParams(window.location.search);
const FORCE_GLOW = params.has("glow");
const FORCED_STATE = ["ready", "listening", "working"].includes(params.get("glow"))
  ? params.get("glow")
  : null;

// `?mount=inline` renders the widget into this app's own DOM instead of the
// shadow overlay, so the effect of THIS app's stylesheet on it can be seen
// directly. This app is an ordinary host: it styles `button {}` and
// `form {}` globally, like most apps do, and index.css loads after the
// widget's stylesheet -- which is exactly the collision the shadow root
// exists to prevent. Compare / against /?mount=inline.
const MOUNT = params.get("mount") === "inline" ? "inline" : "shadow";

export default function App() {
  const { transport, micAttached, mode, holding, userSpeaking, agentBusy } = useInterpreter();
  // Three states rather than a boolean: ready (connected, nothing arriving),
  // listening (audio actually being forwarded), working (the agent has the
  // floor). null means no session worth showing -- a warm connection with no
  // microphone included.
  const state = rimState({ transport, micAttached, mode, holding, userSpeaking, agentBusy });

  return (
    <div className="app">
      <ListeningGlow active={FORCE_GLOW || state !== null} state={FORCED_STATE ?? state ?? "ready"} />
      <nav className="sidebar">
        <h2>Tasker</h2>
        <Link to="/">Dashboard</Link>
        <Link to="/settings">Settings</Link>
      </nav>
      <main className="content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/tasks/new" element={<NewTask />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
      <InterpreterBubble mount={MOUNT} />
    </div>
  );
}
