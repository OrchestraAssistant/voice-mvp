import { useState } from "react";
import { Link } from "react-router-dom";
import { useTasks, useUpdateTask } from "../api.js";

export default function Dashboard() {
  const [search, setSearch] = useState("");
  const { data: tasks, isLoading } = useTasks(search);
  const updateTask = useUpdateTask();

  return (
    <div className="page">
      <h1>Tasks</h1>

      <input
        id="task-search"
        aria-label="Search tasks"
        placeholder="Search tasks..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <Link to="/tasks/new" id="new-task-link">
        + New Task
      </Link>

      {isLoading && <p>Loading...</p>}

      <ul className="task-list">
        {tasks?.map((task) => (
          <li key={task.id} data-task-id={task.id}>
            <label>
              <input
                type="checkbox"
                aria-label={`Mark "${task.title}" as done`}
                checked={task.done}
                onChange={(e) => updateTask.mutate({ id: task.id, done: e.target.checked })}
              />
              <span style={{ textDecoration: task.done ? "line-through" : "none" }}>{task.title}</span>
            </label>
            <span className="due-date">{task.dueDate}</span>
            <Link to={`/tasks/${task.id}`} aria-label={`Open "${task.title}"`}>
              Open
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
