import type {
  CommitDigestInput,
  ContextChannel,
  CreateProjectInput,
  CreateTaskInput,
  DailyDigest,
  EnrichResult,
  GlobalSettings,
  ImportCandidate,
  ImportSelection,
  LiveSession,
  OpenTerminalResult,
  Project,
  QAChannel,
  SearchHit,
  Session,
  SpawnSessionInput,
  Suggestion,
  SuggestionAction,
  Task,
  TaskDetail,
  TaskEvent,
  TranscriptEntry,
  UpdateProjectInput,
  UpdateTaskInput,
  UsageResponse,
} from "@cadence/shared";

/** Mirror of the server's resume command (control surfaces §5) for the copy button. */
export function buildResumeCommand(cwd: string, sessionId: string): string {
  const quoted = `'${cwd.replace(/'/g, `'\\''`)}'`;
  return `cd ${quoted} && claude --resume ${sessionId}`;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

export function getTasks(opts: { status?: string; sort?: "urgency" } = {}): Promise<Task[]> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.sort) params.set("sort", opts.sort);
  const q = params.toString();
  return fetch(`/api/tasks${q ? `?${q}` : ""}`).then(json<Task[]>);
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

export function getQa(taskId: string): Promise<QAChannel> {
  return fetch(`/api/tasks/${taskId}/qa`).then(json<QAChannel>);
}

export function getTimeline(taskId: string): Promise<TaskEvent[]> {
  return fetch(`/api/tasks/${taskId}/timeline`).then(json<TaskEvent[]>);
}

export function getDigest(date?: string): Promise<DailyDigest> {
  const q = date ? `?date=${encodeURIComponent(date)}` : "";
  return fetch(`/api/digest${q}`).then(json<DailyDigest>);
}

export function commitDigest(input: CommitDigestInput): Promise<DailyDigest> {
  return fetch("/api/digest/commit", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  }).then(json<DailyDigest>);
}

export function submitAnswers(
  taskId: string,
  answers: Record<string, string | string[]>,
): Promise<{ status: string }> {
  return fetch(`/api/tasks/${taskId}/qa/answers`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ answers }),
  }).then(json<{ status: string }>);
}

export function getProjects(): Promise<Project[]> {
  return fetch("/api/projects").then(json<Project[]>);
}

export function createProject(input: CreateProjectInput): Promise<Project> {
  return fetch("/api/projects", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  }).then(json<Project>);
}

export function updateProject(slug: string, patch: UpdateProjectInput): Promise<Project> {
  return fetch(`/api/projects/${slug}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  }).then(json<Project>);
}

export function getImportCandidates(): Promise<ImportCandidate[]> {
  return fetch("/api/import/candidates").then(json<ImportCandidate[]>);
}

export function importProjects(selections: ImportSelection[]): Promise<Project[]> {
  return fetch("/api/import", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ selections }),
  }).then(json<Project[]>);
}

export function enrichCandidate(cwd: string): Promise<EnrichResult> {
  return fetch("/api/import/enrich", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cwd }),
  }).then(json<EnrichResult>);
}

export function getTaskSessions(taskId: string): Promise<Session[]> {
  return fetch(`/api/tasks/${taskId}/sessions`).then(json<Session[]>);
}

export function spawnSession(taskId: string, input: SpawnSessionInput = {}): Promise<Session> {
  return fetch(`/api/tasks/${taskId}/sessions`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  }).then(json<Session>);
}

export function getSessions(): Promise<Session[]> {
  return fetch("/api/sessions").then(json<Session[]>);
}

export function getLiveSessions(): Promise<LiveSession[]> {
  return fetch("/api/live-sessions").then(json<LiveSession[]>);
}

export function getUsage(): Promise<UsageResponse> {
  return fetch("/api/usage").then(json<UsageResponse>);
}

export function search(q: string): Promise<SearchHit[]> {
  return fetch(`/api/search?q=${encodeURIComponent(q)}`).then(json<SearchHit[]>);
}

export function getSuggestions(entityType: string, entityId: string): Promise<Suggestion[]> {
  return fetch(
    `/api/suggestions?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}`,
  ).then(json<Suggestion[]>);
}

export function resolveSuggestion(
  id: string,
  action: SuggestionAction,
  value?: unknown,
): Promise<Suggestion> {
  return fetch(`/api/suggestions/${id}/resolve`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ action, value }),
  }).then(json<Suggestion>);
}

export function getTranscript(sessionId: string): Promise<TranscriptEntry[]> {
  return fetch(`/api/sessions/${sessionId}/transcript`).then(json<TranscriptEntry[]>);
}

export function openTerminal(sessionId: string): Promise<OpenTerminalResult> {
  return fetch(`/api/sessions/${sessionId}/open-terminal`, { method: "POST" }).then(
    json<OpenTerminalResult>,
  );
}

export function getSettings(): Promise<GlobalSettings> {
  return fetch("/api/settings").then(json<GlobalSettings>);
}

export function updateSettings(
  patch: Partial<Pick<GlobalSettings, "preferredTerminal">> & {
    global?: Partial<GlobalSettings["global"]>;
  },
): Promise<GlobalSettings> {
  return fetch("/api/settings", {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  }).then(json<GlobalSettings>);
}

export function sendSessionMessage(sessionId: string, text: string): Promise<{ ok: boolean }> {
  return fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ text }),
  }).then(json<{ ok: boolean }>);
}
