import type {
  ContextChannel,
  CreateTaskInput,
  Task,
  TaskDetail,
  UpdateTaskInput,
} from "@cadence/shared";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

export function getTasks(status?: string): Promise<Task[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  return fetch(`/api/tasks${q}`).then(json<Task[]>);
}

export function createTask(input: CreateTaskInput): Promise<Task> {
  return fetch("/api/tasks", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  }).then(json<Task>);
}

export function getTaskDetail(id: string): Promise<TaskDetail> {
  return fetch(`/api/tasks/${id}`).then(json<TaskDetail>);
}

export function updateTask(id: string, patch: UpdateTaskInput): Promise<TaskDetail> {
  return fetch(`/api/tasks/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  }).then(json<TaskDetail>);
}

export function getContext(id: string): Promise<ContextChannel> {
  return fetch(`/api/tasks/${id}/context`).then(json<ContextChannel>);
}

export function appendContext(id: string, text: string): Promise<ContextChannel> {
  return fetch(`/api/tasks/${id}/context`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ text }),
  }).then(json<ContextChannel>);
}
