import type {
  AgentPromptInfo,
  AnalyticsSummary,
  ApprovalRequest,
  AttentionResponse,
  CommitDigestInput,
  ContextChannel,
  CreateFleetInput,
  CreateProjectInput,
  CreateTaskInput,
  DailyDigest,
  DeliveryResult,
  Fleet,
  EnrichResult,
  GlobalSettings,
  ImportCandidate,
  ImportSelection,
  LearnedEntry,
  LiveSession,
  MemoryFile,
  OpenTerminalResult,
  Project,
  ProjectForgeStatus,
  ReviewInspectResult,
  Proposal,
  QAChannel,
  SavedSearch,
  SearchHit,
  SelfMonitor,
  Session,
  SessionDetail,
  SpawnSessionInput,
  Suggestion,
  SuggestionAction,
  SweepReport,
  Task,
  TaskDepsView,
  TaskDetail,
  TaskDiff,
  TaskEvent,
  TaskPlan,
  TranscriptEntry,
  TranscriptHit,
  UpdateFleetInput,
  VerifyReport,
  UpdateProjectInput,
  UpdateSessionInput,
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

export function playTask(id: string): Promise<TaskDetail> {
  return fetch(`/api/tasks/${id}/play`, { method: "POST" }).then(json<TaskDetail>);
}

export function getPlan(id: string): Promise<TaskPlan> {
  return fetch(`/api/tasks/${id}/plan`).then(json<TaskPlan>);
}

export function getVerify(id: string): Promise<VerifyReport> {
  return fetch(`/api/tasks/${id}/verify`).then(json<VerifyReport>);
}

export function getDelivery(id: string): Promise<DeliveryResult> {
  return fetch(`/api/tasks/${id}/delivery`).then(json<DeliveryResult>);
}

export function getDiff(id: string): Promise<TaskDiff> {
  return fetch(`/api/tasks/${id}/diff`).then(json<TaskDiff>);
}

export function mergeReview(id: string): Promise<{ merged: boolean; task: TaskDetail }> {
  return fetch(`/api/tasks/${id}/review/merge`, { method: "POST" }).then(
    json<{ merged: boolean; task: TaskDetail }>,
  );
}

export function requestChanges(id: string, note: string): Promise<TaskDetail> {
  return fetch(`/api/tasks/${id}/review/request-changes`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ note }),
  }).then(json<TaskDetail>);
}

export function approvePlan(id: string): Promise<TaskPlan> {
  return fetch(`/api/tasks/${id}/plan/approve`, { method: "POST" }).then(json<TaskPlan>);
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

export function getDeps(taskId: string): Promise<TaskDepsView> {
  return fetch(`/api/tasks/${taskId}/deps`).then(json<TaskDepsView>);
}

export function addDep(taskId: string, blockerId: string): Promise<TaskDepsView> {
  return fetch(`/api/tasks/${taskId}/deps`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ blockerId }),
  }).then(json<TaskDepsView>);
}

export function removeDep(taskId: string, blockerId: string): Promise<TaskDepsView> {
  return fetch(`/api/tasks/${taskId}/deps/${blockerId}`, { method: "DELETE" }).then(json<TaskDepsView>);
}

export function getSubtasks(taskId: string): Promise<Task[]> {
  return fetch(`/api/tasks/${taskId}/subtasks`).then(json<Task[]>);
}

export function getAnalytics(): Promise<AnalyticsSummary> {
  return fetch("/api/analytics").then(json<AnalyticsSummary>);
}

export function getSweep(): Promise<SweepReport> {
  return fetch("/api/sweep").then(json<SweepReport>);
}

export function getSelfMonitor(): Promise<SelfMonitor> {
  return fetch("/api/self-monitor").then(json<SelfMonitor>);
}

export function getProposals(): Promise<Proposal[]> {
  return fetch("/api/proposals").then(json<Proposal[]>);
}

export function getMemory(): Promise<MemoryFile[]> {
  return fetch("/api/memory").then(json<MemoryFile[]>);
}

export function saveMemoryFile(name: string, content: string): Promise<MemoryFile> {
  return fetch(`/api/memory/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ content }),
  }).then(json<MemoryFile>);
}

export function reflectMemory(): Promise<{ ran: boolean; lessons?: number; reason?: string }> {
  return fetch("/api/reflect", { method: "POST" }).then(
    json<{ ran: boolean; lessons?: number; reason?: string }>,
  );
}

export function getLearned(): Promise<LearnedEntry[]> {
  return fetch("/api/learned").then(json<LearnedEntry[]>);
}

export function revertLearned(index: number): Promise<{ reverted: boolean }> {
  return fetch(`/api/learned/${index}`, { method: "DELETE" }).then(json<{ reverted: boolean }>);
}

export function getApprovals(): Promise<ApprovalRequest[]> {
  return fetch("/api/approvals").then(json<ApprovalRequest[]>);
}

/** The unified "needs you" feed (tasks awaiting input/approval/merge + tool approvals). */
export function getAttention(): Promise<AttentionResponse> {
  return fetch("/api/attention").then(json<AttentionResponse>);
}

export function resolveApproval(id: string, allow: boolean): Promise<{ resolved: boolean }> {
  return fetch(`/api/approvals/${id}/resolve`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ allow }),
  }).then(json<{ resolved: boolean }>);
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

export function recapDigest(date?: string): Promise<DailyDigest> {
  return fetch("/api/digest/recap", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(date ? { date } : {}),
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

export function getFleets(): Promise<Fleet[]> {
  return fetch("/api/fleets").then(json<Fleet[]>);
}

export function createFleet(input: CreateFleetInput): Promise<Fleet> {
  return fetch("/api/fleets", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  }).then(json<Fleet>);
}

export function updateFleet(slug: string, patch: UpdateFleetInput): Promise<Fleet> {
  return fetch(`/api/fleets/${slug}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  }).then(json<Fleet>);
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

/** Kick off the Claude worktree-readiness check (202; the verdict arrives via WS → project). */
export function checkWorktreeReadiness(slug: string): Promise<{ started: boolean }> {
  return fetch(`/api/projects/${slug}/worktree-check`, { method: "POST" }).then(
    json<{ started: boolean }>,
  );
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

export function getSessionDetail(id: string): Promise<SessionDetail> {
  return fetch(`/api/sessions/${id}`).then(json<SessionDetail>);
}

export function updateSession(id: string, patch: UpdateSessionInput): Promise<SessionDetail> {
  return fetch(`/api/sessions/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  }).then(json<SessionDetail>);
}

export function deleteSession(id: string): Promise<{ deleted: boolean }> {
  return fetch(`/api/sessions/${id}`, { method: "DELETE" }).then(json<{ deleted: boolean }>);
}

/** Gracefully stop (EOF) a live warm session; it finishes its turn then exits. */
export function stopSession(id: string): Promise<{ ok: boolean; action: string }> {
  return fetch(`/api/sessions/${id}/stop`, { method: "POST" }).then(
    json<{ ok: boolean; action: string }>,
  );
}

/** Hard-kill (SIGINT) a live warm session. */
export function killSession(id: string): Promise<{ ok: boolean; action: string }> {
  return fetch(`/api/sessions/${id}/kill`, { method: "POST" }).then(
    json<{ ok: boolean; action: string }>,
  );
}

/** Bulk-clear finished agent-stage rows (§6.1.g); transcripts stay on disk. */
export function clearFinishedSessions(): Promise<{ cleared: number }> {
  return fetch("/api/sessions/clear-finished", { method: "POST" }).then(json<{ cleared: number }>);
}

/** Manually re-run Discovery (refinement) on a task — 409s if one is already active. */
export function refineTask(id: string): Promise<{ ran: boolean; status?: string }> {
  return fetch(`/api/tasks/${id}/refine`, { method: "POST" }).then(
    json<{ ran: boolean; status?: string }>,
  );
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

export function searchTranscripts(q: string): Promise<TranscriptHit[]> {
  return fetch(`/api/search/transcripts?q=${encodeURIComponent(q)}`).then(json<TranscriptHit[]>);
}

export function getSavedSearches(): Promise<SavedSearch[]> {
  return fetch("/api/searches").then(json<SavedSearch[]>);
}

export function createSavedSearch(name: string, query: string): Promise<SavedSearch> {
  return fetch("/api/searches", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, query }),
  }).then(json<SavedSearch>);
}

export function deleteSavedSearch(id: string): Promise<{ deleted: boolean }> {
  return fetch(`/api/searches/${id}`, { method: "DELETE" }).then(json<{ deleted: boolean }>);
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

export function getTranscript(sessionId: string, limit = 1000): Promise<TranscriptEntry[]> {
  return fetch(`/api/sessions/${sessionId}/transcript?limit=${limit}`).then(json<TranscriptEntry[]>);
}

const TERMINAL_ERRORS: Record<string, string> = {
  session_running: "This session is still running — take it over instead of resuming.",
  cwd_missing: "The working directory no longer exists (the worktree was likely cleaned up).",
  stop_failed: "The running process didn't stop — try Kill, then open the terminal again.",
};

/** Open the session in the preferred terminal. `takeover` stops a running process first. */
export async function openTerminal(
  sessionId: string,
  opts: { takeover?: boolean } = {},
): Promise<OpenTerminalResult> {
  const qs = opts.takeover ? "?mode=takeover" : "";
  const res = await fetch(`/api/sessions/${sessionId}/open-terminal${qs}`, { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as OpenTerminalResult & {
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    throw new Error(
      body.message ?? TERMINAL_ERRORS[body.error ?? ""] ?? `${res.status} ${res.statusText}`,
    );
  }
  return body;
}

export function getSettings(): Promise<GlobalSettings> {
  return fetch("/api/settings").then(json<GlobalSettings>);
}

export function updateSettings(
  patch: Partial<Pick<GlobalSettings, "preferredTerminal" | "claudeBinPath">> & {
    global?: Partial<GlobalSettings["global"]>;
    /** Per-agent overrides; null clears a field / resets a role (deep-merged server-side, §6.3.b). */
    agents?: Record<string, { prompt?: string | null; model?: string | null } | null>;
    /** Date/time patterns (§6.3.d); blank/null resets a key to the default. */
    formats?: { date?: string | null; dateTime?: string | null };
    /** Operations knobs (§6.3.e); null resets a key to the built-in default. */
    operations?: Record<string, number | null>;
  },
): Promise<GlobalSettings> {
  return fetch("/api/settings", {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  }).then(json<GlobalSettings>);
}

/** The agent prompt registry + current overrides (Settings → Agents & Prompts, §6.3.c). */
export function getAgentPrompts(): Promise<AgentPromptInfo[]> {
  return fetch("/api/agents/prompts").then(json<AgentPromptInfo[]>);
}

/** Capture-time review detection for a pasted PR/MR URL (§6.5.a). */
export function inspectReviewUrl(url: string): Promise<ReviewInspectResult> {
  return fetch("/api/review/inspect", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ url }),
  }).then(json<ReviewInspectResult>);
}

/** A project's forge status: parsed remote + matching CLI capability (§6.4). */
export function getProjectForge(slug: string, refresh = false): Promise<ProjectForgeStatus> {
  return fetch(`/api/projects/${slug}/forge${refresh ? "?refresh=1" : ""}`).then(
    json<ProjectForgeStatus>,
  );
}

export function sendSessionMessage(sessionId: string, text: string): Promise<{ ok: boolean }> {
  return fetch(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ text }),
  }).then(json<{ ok: boolean }>);
}
