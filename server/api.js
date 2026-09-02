import { Router } from "express";
import { db, nextTaskId } from "./db.js";

export const api = Router();

// --- Tasks (queries) ---
api.get("/tasks", (req, res) => {
  const { search } = req.query;
  let results = db.tasks;
  if (search) {
    const q = String(search).toLowerCase();
    results = results.filter((t) => t.title.toLowerCase().includes(q));
  }
  res.json(results);
});

api.get("/tasks/:id", (req, res) => {
  const task = db.tasks.find((t) => t.id === Number(req.params.id));
  if (!task) return res.status(404).json({ error: "not found" });
  res.json(task);
});

// --- Tasks (mutations) ---
api.post("/tasks", (req, res) => {
  const { title, dueDate, notes } = req.body;
  if (!title) return res.status(400).json({ error: "title is required" });
  const task = { id: nextTaskId(), title, dueDate: dueDate || null, notes: notes || "", done: false };
  db.tasks.push(task);
  res.status(201).json(task);
});

api.put("/tasks/:id", (req, res) => {
  const task = db.tasks.find((t) => t.id === Number(req.params.id));
  if (!task) return res.status(404).json({ error: "not found" });
  Object.assign(task, req.body);
  res.json(task);
});

api.delete("/tasks/:id", (req, res) => {
  const idx = db.tasks.findIndex((t) => t.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "not found" });
  const [removed] = db.tasks.splice(idx, 1);
  res.json(removed);
});

// --- Settings (query + mutation) ---
api.get("/settings", (req, res) => {
  res.json(db.settings);
});

api.put("/settings", (req, res) => {
  Object.assign(db.settings, req.body);
  res.json(db.settings);
});
