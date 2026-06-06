import type { CreateTaskInput, Task } from "@cadence/shared";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export function getTasks(status?: string): Promise<Task[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  return fetch(`/api/tasks${q}`).then(json<Task[]>);
}

export function createTask(input: CreateTaskInput): Promise<Task> {
  return fetch("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).then(json<Task>);
}
