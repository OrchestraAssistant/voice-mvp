import { Routes, Route, Link } from "react-router-dom";
import Dashboard from "./pages/Dashboard.jsx";
import NewTask from "./pages/NewTask.jsx";
import TaskDetail from "./pages/TaskDetail.jsx";
import Settings from "./pages/Settings.jsx";
import { InterpreterBubble } from "./voice/InterpreterBubble.jsx";
import { ListeningGlow, isListening } from "./voice/ListeningGlow.jsx";
import { useInterpreter } from "./voice/VoiceProvider.jsx";

// `?glow=1` forces the listening rim on without a live mic session, so the
// visual can be looked at (and screenshotted) on the real app's real
// background without an OpenAI key. `?glow=rounded` does the same with the
// rim's corners rounded instead of square, for comparing the two. Read once
// at module load; a dev affordance, not a feature.
const GLOW_PARAM = new URLSearchParams(window.location.search).get("glow");
const FORCE_GLOW = GLOW_PARAM !== null;
const GLOW_CORNERS = GLOW_PARAM === "rounded" ? "rounded" : "square";

export default function App() {
  const { status, mode, holding } = useInterpreter();
  const listening = FORCE_GLOW || isListening({ status, mode, holding });

  return (
    <div className="app">
      <ListeningGlow active={listening} corners={GLOW_CORNERS} />
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
      <InterpreterBubble />
    </div>
  );
}
