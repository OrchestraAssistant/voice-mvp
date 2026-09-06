import { Routes, Route, Link } from "react-router-dom";
import Dashboard from "./pages/Dashboard.jsx";
import NewTask from "./pages/NewTask.jsx";
import TaskDetail from "./pages/TaskDetail.jsx";
import Settings from "./pages/Settings.jsx";
import { Interpreter } from "@yourco/voice";

// Forcing the rim on without a live session used to live here, as `?glow=`.
// It moved to the tuner at dev/rim.html, which drives the same component with
// state buttons, live colour pickers and a hue-separation readout -- and this
// app now renders <Interpreter/>, which owns the rim's state itself.
const params = new URLSearchParams(window.location.search);

// `?mount=inline` renders the widget into this app's own DOM instead of the
// shadow overlay, so the effect of THIS app's stylesheet on it can be seen
// directly. This app is an ordinary host: it styles `button {}` and
// `form {}` globally, like most apps do, and index.css loads after the
// widget's stylesheet -- which is exactly the collision the shadow root
// exists to prevent. Compare / against /?mount=inline.
const MOUNT = params.get("mount") === "inline" ? "inline" : "shadow";

export default function App() {
  return (
    <div className="app">
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
      {/* The whole interface, top tier: bubble and rim, with the rim's state
          derived from the session. This app used to wire that by hand, and a
          real host forgot to, ending up with no rim and nothing saying so. */}
      <Interpreter mount={MOUNT} />
    </div>
  );
}
