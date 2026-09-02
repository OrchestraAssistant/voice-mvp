import { Routes, Route, Link } from "react-router-dom";
import Dashboard from "./pages/Dashboard.jsx";
import NewTask from "./pages/NewTask.jsx";
import TaskDetail from "./pages/TaskDetail.jsx";
import Settings from "./pages/Settings.jsx";
import { InterpreterBubble } from "./voice/InterpreterBubble.jsx";
import { ListeningGlow, isListening } from "./voice/ListeningGlow.jsx";
import { useInterpreter } from "./voice/VoiceProvider.jsx";
import { useRimCorners } from "./voice/rimCornersDev.js"; // TEMPORARY

// `?glow=1` forces the listening rim on without a live mic session, so the
// visual can be looked at (and screenshotted) on the real app's real
// background without an OpenAI key. Read once at module load; a dev
// affordance, not a feature. Corner shape is no longer a URL parameter --
// it's a live switch at the bottom of the interpreter panel, so comparing
// the two shapes doesn't cost a reload.
const FORCE_GLOW = new URLSearchParams(window.location.search).has("glow");

export default function App() {
  const { status, mode, holding } = useInterpreter();
  const listening = FORCE_GLOW || isListening({ status, mode, holding });
  const corners = useRimCorners(); // TEMPORARY

  return (
    <div className="app">
      <ListeningGlow active={listening} corners={corners} />
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
