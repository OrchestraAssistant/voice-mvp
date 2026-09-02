import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const BASE = "/api";

async function request(url, options) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

// Queries (read-only, safe to auto-run)

export function useTasks(search) {
  return useQuery({
    queryKey: ["tasks", search],
    queryFn: () => request(`${BASE}/tasks${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  });
}

export function useTask(id) {
  return useQuery({
    queryKey: ["tasks", id],
    queryFn: () => request(`${BASE}/tasks/${id}`),
    enabled: !!id,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => request(`${BASE}/settings`),
  });
}

// Mutations (writes)

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (task) => request(`${BASE}/tasks`, { method: "POST", body: JSON.stringify(task) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }) =>
      request(`${BASE}/tasks/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => request(`${BASE}/tasks/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch) => request(`${BASE}/settings`, { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
}
