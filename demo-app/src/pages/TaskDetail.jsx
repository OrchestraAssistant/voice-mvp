import { useParams, useNavigate } from "react-router-dom";
import { useTask, useUpdateTask, useDeleteTask } from "../api.js";

export default function TaskDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: task, isLoading } = useTask(id);
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  if (isLoading || !task) return <p>Loading...</p>;

  return (
    <div className="page">
      <h1>{task.title}</h1>
      <p>Due: {task.dueDate || "no due date"}</p>
      <p>{task.notes}</p>

      <button
        id="toggle-done"
        onClick={() => updateTask.mutate({ id: task.id, done: !task.done })}
      >
        {task.done ? "Mark as not done" : "Mark as done"}
      </button>

      <button
        id="delete-task"
        aria-label={`Delete "${task.title}"`}
        onClick={async () => {
          await deleteTask.mutateAsync(task.id);
          navigate("/");
        }}
      >
        Delete Task
      </button>
    </div>
  );
}
