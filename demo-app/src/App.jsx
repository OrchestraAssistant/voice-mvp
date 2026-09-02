import { Routes, Route, Link } from "react-router-dom";
import Dashboard from "./pages/Dashboard.jsx";
import NewTask from "./pages/NewTask.jsx";
import TaskDetail from "./pages/TaskDetail.jsx";
import Settings from "./pages/Settings.jsx";
import { InterpreterBubble, ListeningGlow, isListening, useInterpreter } from "@yourco/voice";

// `?glow=1` forces the listening rim on without a live mic session, so the
// visual can be looked at (and screenshotted) on the real app's real
// background without an OpenAI key. Read once at module load; a dev
// affordance, not a feature.
const params = new URLSearchParams(window.location.search);
const FORCE_GLOW = params.has("glow");

// `?mount=inline` renders the widget into this app's own DOM instead of the
// shadow overlay, so the effect of THIS app's stylesheet on it can be seen
// directly. This app is an ordinary host: it styles `button {}` and
// `form {}` globally, like most apps do, and index.css loads after the
// widget's stylesheet -- which is exactly the collision the shadow root
// exists to prevent. Compare / against /?mount=inline.
const MOUNT = params.get("mount") === "inline" ? "inline" : "shadow";

export default function App() {
  const { transport, micAttached, mode, holding } = useInterpreter();
  const listening = FORCE_GLOW || isListening({ transport, micAttached, mode, holding });

  return (
    <div className="app">
      <ListeningGlow active={listening} />
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
