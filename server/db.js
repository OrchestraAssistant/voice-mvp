// In-memory data store for the demo app. Stands in for a real backend.
let nextId = 4;

export const db = {
  tasks: [
    { id: 1, title: "Write Q3 report", done: false, dueDate: "2026-09-05", notes: "" },
    { id: 2, title: "Review PR #482", done: false, dueDate: "2026-09-02", notes: "" },
    { id: 3, title: "Buy groceries", done: true, dueDate: "2026-08-30", notes: "Milk, eggs, bread" },
  ],
  settings: {
    name: "Ada Lovelace",
    email: "ada@example.com",
    theme: "light",
  },
};

export function nextTaskId() {
  return nextId++;
}
