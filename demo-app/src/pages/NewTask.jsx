import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNavigate } from "react-router-dom";
import { useCreateTask } from "../api.js";

export const NewTaskSchema = z.object({
  title: z.string().min(1, "Title is required"),
  dueDate: z.string().optional(),
  notes: z.string().optional(),
});

export default function NewTask() {
  const navigate = useNavigate();
  const createTask = useCreateTask();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({ resolver: zodResolver(NewTaskSchema) });

  const onSubmit = async (values) => {
    await createTask.mutateAsync(values);
    navigate("/");
  };

  return (
    <div className="page">
      <h1>New Task</h1>
      <form onSubmit={handleSubmit(onSubmit)}>
        <label htmlFor="title">Title</label>
        <input id="title" {...register("title")} />
        {errors.title && <p className="error">{errors.title.message}</p>}

        <label htmlFor="dueDate">Due date</label>
        <input id="dueDate" type="date" {...register("dueDate")} />

        <label htmlFor="notes">Notes</label>
        <textarea id="notes" {...register("notes")} />

        <button type="submit" id="create-task-submit">
          Create Task
        </button>
      </form>
    </div>
  );
}
