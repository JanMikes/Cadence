import { existsSync } from "node:fs";
import {
  APP_NAME,
  type AppendContextInput,
  type AttentionItem,
  type AttentionResponse,
  type CommitDigestInput,
  type CreateFleetInput,
  type CreateProjectInput,
  type CreateSavedSearchInput,
  type CreateSuggestionInput,
  type CreateTaskInput,
  type HealthStatus,
  type RecapDigestInput,
  type ResolveSuggestionInput,
  type ReviewActionInput,
  SCHEMA_VERSION,
  type SessionDetail,
  type SpawnSessionInput,
  type UpdateFleetInput,
  type UpdateProjectInput,
  type UpdateSessionInput,
  type UpdateTaskInput,
} from "@cadence/shared";
import { runDelivery } from "./agents/delivery";
import { ActivityTracker } from "./activity";
import { runDiscovery } from "./agents/discovery";
import { runFleetImplementer } from "./agents/fleet";
import { runImplementer } from "./agents/implementer";
import { approvePlan, runPlanner } from "./agents/planner";
import { runReflector } from "./agents/reflector";
import { findLiveStage } from "./agents/stage-guard";
import { runVerifier } from "./agents/verifier";
import { answerQuestions, runQuestioner } from "./agents/questioner";
import { type AgentRunner, runTriage } from "./agents/triage";
import { computeAnalytics } from "./analytics";
import { type ApprovalDecision, ApprovalRegistry } from "./approvals";
import { composeContext } from "./context";
import { addDependency, getDeps, getSubtasks, removeDependency } from "./deps";
import type { Db } from "./db/client";
import { searchTaskHits } from "./db/search";
import { commitDigest, getDigest, recapDigest } from "./digest";
import { listTaskEvents, recordEvent } from "./events";
import { projectLocks } from "./project-locks";
import { executionLockTarget } from "./worktree";
import { runWorktreeCheck } from "./agents/worktree-check";
import { createFleet, getFleet, getFleetById, listFleets, updateFleet } from "./fleets";
import { importProjects, scanClaudeProjects } from "./import";
import {
  listLearnedEntries,
  listMemoryFiles,
  readProjectMemory,
  revertLearnedEntry,
  writeMemoryFile,
  writeProjectMemory,
} from "./memory";
import { createSavedSearch, deleteSavedSearch, listSavedSearches } from "./searches";
import { buildProposals } from "./proposals";
import { computeSelfMonitor } from "./selfmonitor";
import { runSweep } from "./sweep";
import { searchTranscripts } from "./transcript-search";
import { allowedTransitions, canTransition, isValidStatus } from "./lifecycle";
import { notifyOnTransition } from "./notify";
import { mergeTask, taskDiff } from "./review";
import {
  createProject,
  getProject,
  getProjectById,
  listProjects,
  resolveProjectAutonomy,
  updateProject,
} from "./projects";
import {
  appendContext,
  applyClaudeBinEnv,
  readContext,
  readDelivery,
  readPlan,
  readQa,
  readSettings,
  readVerify,
  writeSettings,
} from "./store/store";
import {
  deleteSession,
  endSession,
  getSession,
  isProcessAlive,
  listSessions,
  listTaskSessions,
  recordTranscriptPath,
  sessionRunState,
  signalSession,
  type SpawnManager,
  updateSession,
} from "./sessions";
import { createSuggestion, listSuggestions, resolveSuggestion } from "./suggestions";
import { buildResumeCommand } from "./terminal";
import { readLiveSessions, readTranscript, resolveTranscriptPath } from "./transcripts";
import { readUsageStats } from "./usage";
import {
  createTask,
  getTask,
  getTaskDetail,
  listTasks,
  resolvePermissionMode,
  resolveTaskCwd,
  updateTask,
} from "./tasks";
import type { WsHub } from "./ws";

export interface ApiContext {
  db: Db;
  hub: WsHub;
  spawn: SpawnManager;
  /** Tracks in-flight autonomy work so the UI can show a spinner (injectable for tests). */
  activity: ActivityTracker;
  /** Launch a terminal app running `command` (injectable for tests). */
  openTerminal: (app: string, command: string) => void;
  /** Enrich an import candidate via a one-shot claude (injectable for tests). */
  enrich: (cwd: string) => Promise<import("@cadence/shared").EnrichResult>;
  /** One-shot agent runner (injectable for tests; default real claude). */
  runAgent: AgentRunner;
  /** In-app tool-approval registry (Manual mode, §9.1). */
  approvals: ApprovalRegistry;
}

/** Handle a REST request under /api/*. Always returns a Response. */
export async function handleApi(req: Request, url: URL, ctx: ApiContext): Promise<Response> {
  const { pathname } = url;
  const method = req.method;

  if (pathname === "/api/health" && method === "GET") {
    return Response.json({ ok: true, app: APP_NAME, version: SCHEMA_VERSION } satisfies HealthStatus);
  }

  if (pathname === "/api/tasks") {
    if (method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      const sort = url.searchParams.get("sort") === "urgency" ? "urgency" : undefined;
      return Response.json(listTasks(ctx.db, { status, sort }));
    }
    if (method === "POST") {
      let input: CreateTaskInput;
      try {
        input = (await req.json()) as CreateTaskInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      // Description-first capture: the body is the primary field; an empty title
      // is fine (one gets derived now and properly named by the triage agent).
      const title = typeof input?.title === "string" ? input.title.trim() : "";
      const body = typeof input?.body === "string" ? input.body.trim() : "";
      if (!title && !body) return badRequest("a description (or title) is required");

      const task = createTask(ctx.db, { title: title || undefined, body: body || undefined });
      ctx.hub.broadcast({ type: "event", name: "task:created", payload: task.id });
      maybeTriageOnCapture(ctx, task.id); // background; no-op unless autonomy is on
      return Response.json(task, { status: 201 });
    }
    return methodNotAllowed();
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const id = taskMatch[1] as string;
    if (method === "GET") {
      const detail = getTaskDetail(ctx.db, id);
      return detail ? Response.json(detail) : notFound(pathname);
    }
    if (method === "PATCH") {
      let patch: UpdateTaskInput;
      try {
        patch = (await req.json()) as UpdateTaskInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (typeof patch?.title === "string" && !patch.title.trim()) {
        return badRequest("title cannot be blank");
      }
      const before = getTask(ctx.db, id);
      if (!before) return notFound(pathname);
      // Enforce the lifecycle state machine (spec §6) on status changes.
      if (typeof patch.status === "string" && patch.status !== before.status) {
        if (!isValidStatus(patch.status)) return badRequest(`unknown status "${patch.status}"`);
        if (!canTransition(before.status, patch.status)) {
          return conflict(`cannot move from ${before.status} to ${patch.status}`, {
            from: before.status,
            to: patch.status,
            allowed: allowedTransitions(before.status),
          });
        }
      }
      const updated = updateTask(ctx.db, id, patch);
      if (!updated) return notFound(pathname);
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: updated.id });
      notifyOnTransition(ctx.hub, before?.status, updated);
      return Response.json(updated);
    }
    return methodNotAllowed();
  }

  const playMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/play$/);
  if (playMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = playMatch[1] as string;
    const task = getTask(ctx.db, taskId);
    if (!task) return notFound(pathname);
    // PLAY is the human gate (§6): only a Ready task can start executing.
    if (task.status !== "ready") {
      return conflict(`PLAY requires a Ready task (currently ${task.status})`, { status: task.status });
    }
    const updated = updateTask(ctx.db, taskId, { status: "implementing" });
    if (!updated) return notFound(pathname);
    ctx.hub.broadcast({ type: "event", name: "task:play", payload: taskId });
    ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    notifyOnTransition(ctx.hub, "ready", updated);
    // Kick off the Planner (read-only, plan mode) in the background; it writes an
    // approvable plan.md, then the task parks in Plan review — a distinct, visible
    // "waiting on you" state rather than sitting silently in "In progress".
    // Activity-tracked so the card spins while the Planner drafts. The Implementer
    // (3.4) runs only after approval.
    void ctx.activity
      .track(taskId, "planner", () => runPlanner(ctx.db, taskId, ctx.runAgent))
      .then((p) => {
        if (!p.ran) return;
        const planned = updateTask(ctx.db, taskId, { status: "plan_review" });
        ctx.hub.broadcast({ type: "event", name: "task:plan", payload: taskId });
        ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
        if (planned) notifyOnTransition(ctx.hub, "implementing", planned);
      })
      .catch((err) => console.error(`[cadence] planner failed for ${taskId}:`, err));
    return Response.json(updated);
  }

  const planMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/plan$/);
  if (planMatch) {
    if (method !== "GET") return methodNotAllowed();
    const taskId = planMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    return Response.json(readPlan(taskId));
  }

  const verifyMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/verify$/);
  if (verifyMatch) {
    if (method !== "GET") return methodNotAllowed();
    const taskId = verifyMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    return Response.json(readVerify(taskId));
  }

  const deliveryMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/delivery$/);
  if (deliveryMatch) {
    if (method !== "GET") return methodNotAllowed();
    const taskId = deliveryMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    return Response.json(readDelivery(taskId));
  }

  const diffMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/diff$/);
  if (diffMatch) {
    if (method !== "GET") return methodNotAllowed();
    const taskId = diffMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    return Response.json(taskDiff(ctx.db, taskId));
  }

  const mergeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/review\/merge$/);
  if (mergeMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = mergeMatch[1] as string;
    const task = getTask(ctx.db, taskId);
    if (!task) return notFound(pathname);
    if (task.status !== "review") return conflict(`merge requires a task in review (currently ${task.status})`, { status: task.status });
    // Merging mutates the project working dir — refuse while an in-place execution
    // holds it (another task implementing in this project right now).
    if (task.projectId) {
      const project = getProjectById(ctx.db, task.projectId);
      const busy =
        project?.rootPath &&
        projectLocks.isWriteBusy(project.id, {
          db: ctx.db,
          rootPath: project.rootPath,
          excludeTaskId: taskId,
        });
      if (busy) {
        return conflict("another task is executing in this project's working dir — try again when it finishes", {
          merged: false,
        });
      }
    }
    const result = mergeTask(ctx.db, taskId);
    if (!result.ok) return conflict(result.message, { merged: false });
    const updated = updateTask(ctx.db, taskId, { status: "done" });
    ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    return Response.json({ merged: true, message: result.message, task: updated });
  }

  const requestChangesMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/review\/request-changes$/);
  if (requestChangesMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = requestChangesMatch[1] as string;
    const task = getTask(ctx.db, taskId);
    if (!task) return notFound(pathname);
    if (task.status !== "review") return conflict(`request-changes requires a task in review (currently ${task.status})`, { status: task.status });
    let body: ReviewActionInput;
    try {
      body = (await req.json().catch(() => ({}))) as ReviewActionInput;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (body?.note?.trim()) appendContext(taskId, `Requested changes: ${body.note.trim()}`);
    const updated = updateTask(ctx.db, taskId, { status: "implementing" });
    ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    return Response.json(updated);
  }

  const planApproveMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/plan\/approve$/);
  if (planApproveMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = planApproveMatch[1] as string;
    const task = getTask(ctx.db, taskId);
    if (!task) return notFound(pathname);
    const plan = approvePlan(taskId);
    ctx.hub.broadcast({ type: "event", name: "task:plan", payload: taskId });
    // Approving the plan starts implementation. From Plan review (or implementing,
    // for back-compat) we move into In progress and run the execution chain. Each
    // stage is activity-tracked so the board card spins while Cadence works; the
    // Implementer runs in the isolated worktree (or the locked project dir) and
    // bails gracefully if it can't.
    if (task.status === "plan_review" || task.status === "implementing") {
      if (task.status !== "implementing") {
        updateTask(ctx.db, taskId, { status: "implementing" });
        ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      }
      void runExecutionChain(ctx, taskId);
    }
    return Response.json(plan);
  }

  // In-flight autonomy work (drives the board/task spinner); hydrates on a fresh page load.
  if (pathname === "/api/activity" && method === "GET") {
    return Response.json(ctx.activity.list());
  }

  // The unified "needs you" feed (§10): everything blocking on the user, built from
  // persistent state so the count survives reloads. Backs the top-bar pill + Attention
  // Center. Resolve one → it drops out → the next surfaces ("keep it flowing").
  if (pathname === "/api/attention" && method === "GET") {
    const items: AttentionItem[] = [];

    for (const t of listTasks(ctx.db, { status: "needs_feedback", sort: "urgency" })) {
      const qa = readQa(t.id);
      const open = qa.questions.filter((q) => !isAnswered(qa.answers[q.id])).length;
      items.push({
        id: `needs_input:${t.id}`,
        kind: "needs_input",
        taskId: t.id,
        title: t.title,
        summary: open === 1 ? "1 question" : `${open} questions`,
        actionLabel: "Answer",
        urgency: t.urgency ?? 0,
        createdAt: t.updatedAt,
      });
    }

    for (const t of listTasks(ctx.db, { status: "plan_review", sort: "urgency" })) {
      const steps = readPlan(t.id).steps.length;
      items.push({
        id: `plan_approval:${t.id}`,
        kind: "plan_approval",
        taskId: t.id,
        title: t.title,
        summary: `Plan ready · ${steps} step${steps === 1 ? "" : "s"}`,
        actionLabel: "Approve plan",
        urgency: t.urgency ?? 0,
        createdAt: t.updatedAt,
      });
    }

    for (const t of listTasks(ctx.db, { status: "review", sort: "urgency" })) {
      items.push({
        id: `review_merge:${t.id}`,
        kind: "review_merge",
        taskId: t.id,
        title: t.title,
        summary: "Verified — ready to merge",
        actionLabel: "Review & merge",
        urgency: t.urgency ?? 0,
        createdAt: t.updatedAt,
      });
    }

    for (const a of ctx.approvals.list()) {
      items.push({
        id: `tool_approval:${a.id}`,
        kind: "tool_approval",
        taskId: a.taskId ?? undefined,
        approvalId: a.id,
        title: a.toolName,
        summary: "Tool action awaiting approval (Manual mode)",
        actionLabel: "Review action",
        urgency: Number.MAX_SAFE_INTEGER, // a live agent is blocked — top priority
        createdAt: a.createdAt,
      });
    }

    // Stalled: a task in an active-work state with no live run (and not just dispatched). The
    // safety net for a run that died or hung between watchdog ticks — "In progress" must never
    // silently lie. Floated to the top: a stuck run is the most urgent thing to see.
    const activeIds = new Set(ctx.activity.list().map((a) => a.taskId));
    const nowMs = Date.now();
    for (const status of ["implementing", "verifying"] as const) {
      for (const t of listTasks(ctx.db, { status, sort: "urgency" })) {
        if (activeIds.has(t.id) || nowMs - t.updatedAt < 60_000) continue;
        items.push({
          id: `stalled:${t.id}`,
          kind: "stalled",
          taskId: t.id,
          title: t.title,
          summary: `Stalled — no active run (${status === "verifying" ? "Verifying" : "In progress"})`,
          actionLabel: "Inspect",
          urgency: (t.urgency ?? 0) + 1_000_000,
          createdAt: t.updatedAt,
        });
      }
    }

    items.sort((x, y) => y.urgency - x.urgency || x.createdAt - y.createdAt);
    return Response.json({ items, count: items.length } satisfies AttentionResponse);
  }

  const refineMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/refine$/);
  if (refineMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = refineMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    // Refuse a duplicate before runDiscovery touches the task's status (§6.1.b) —
    // the recording runner's assertStageIdle still backstops the racy window after.
    const live = findLiveStage(ctx.db, taskId, "discovery");
    if (live) {
      return conflict("a discovery run is already active for this task", { sessionId: live.id });
    }
    const before = getTask(ctx.db, taskId);
    const outcome = await ctx.activity.track(taskId, "discovery", () =>
      runDiscovery(ctx.db, taskId, ctx.runAgent),
    );
    if (outcome.ran) {
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      if (outcome.status === "needs_feedback") {
        const t = getTask(ctx.db, taskId);
        if (t) notifyOnTransition(ctx.hub, before?.status, t);
      }
    }
    return Response.json(outcome);
  }

  const timelineMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/timeline$/);
  if (timelineMatch) {
    if (method !== "GET") return methodNotAllowed();
    const taskId = timelineMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    return Response.json(listTaskEvents(ctx.db, taskId));
  }

  const subtasksMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/subtasks$/);
  if (subtasksMatch) {
    if (method !== "GET") return methodNotAllowed();
    const taskId = subtasksMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    return Response.json(getSubtasks(ctx.db, taskId));
  }

  const depMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/deps$/);
  if (depMatch) {
    const taskId = depMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    if (method === "GET") return Response.json(getDeps(ctx.db, taskId));
    if (method === "POST") {
      let body: { blockerId?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (!body?.blockerId) return badRequest("blockerId required");
      const result = addDependency(ctx.db, taskId, body.blockerId);
      if (!result.ok) return conflict(result.reason);
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      return Response.json(getDeps(ctx.db, taskId));
    }
    return methodNotAllowed();
  }

  const depDeleteMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/deps\/([^/]+)$/);
  if (depDeleteMatch) {
    if (method !== "DELETE") return methodNotAllowed();
    const taskId = depDeleteMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    removeDependency(ctx.db, taskId, depDeleteMatch[2] as string);
    ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    return Response.json(getDeps(ctx.db, taskId));
  }

  const qaMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/qa$/);
  if (qaMatch) {
    if (method !== "GET") return methodNotAllowed();
    if (!getTask(ctx.db, qaMatch[1] as string)) return notFound(pathname);
    return Response.json(readQa(qaMatch[1] as string));
  }

  const answersMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/qa\/answers$/);
  if (answersMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = answersMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    let body: { answers?: Record<string, string | string[]> };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (!body?.answers || typeof body.answers !== "object") return badRequest("answers required");
    const before = getTask(ctx.db, taskId);
    const result = answerQuestions(ctx.db, taskId, body.answers);
    ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    if (before?.status === "needs_feedback" && result.status === "ready") {
      ctx.hub.broadcast({ type: "event", name: "task:ready", payload: taskId });
    }
    return Response.json(result);
  }

  const taskSessionsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/sessions$/);
  if (taskSessionsMatch) {
    const taskId = taskSessionsMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    if (method === "GET") return Response.json(listTaskSessions(ctx.db, taskId));
    if (method === "POST") {
      let input: SpawnSessionInput;
      try {
        input = (await req.json().catch(() => ({}))) as SpawnSessionInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      const task = getTask(ctx.db, taskId);
      const appendSystemPrompt = composeContext(ctx.db, {
        taskId,
        projectId: task?.projectId ?? null,
        fleetId: task?.fleetId ?? null,
      });
      const session = ctx.spawn.spawn({
        cwd: resolveTaskCwd(ctx.db, taskId),
        taskId,
        projectId: task?.projectId ?? null,
        role: input.role ?? "chat",
        model: input.model,
        permissionMode: input.permissionMode ?? resolvePermissionMode(ctx.db, taskId),
        appendSystemPrompt: appendSystemPrompt || undefined,
      });
      if (typeof input.prompt === "string" && input.prompt.trim()) {
        ctx.spawn.send(session.id, input.prompt);
      }
      ctx.hub.broadcast({ type: "event", name: "session:spawned", payload: session.id });
      return Response.json(session, { status: 201 });
    }
    return methodNotAllowed();
  }

  if (pathname === "/api/sessions" && method === "GET") {
    return Response.json(listSessions(ctx.db));
  }

  if (pathname === "/api/live-sessions" && method === "GET") {
    return Response.json(readLiveSessions());
  }

  if (pathname === "/api/usage" && method === "GET") {
    return Response.json({ stats: readUsageStats(), rateLimit: ctx.spawn.latestRateLimit() });
  }

  if (pathname === "/api/analytics" && method === "GET") {
    return Response.json(computeAnalytics(ctx.db));
  }

  if (pathname === "/api/sweep" && method === "GET") {
    return Response.json(runSweep(ctx.db, Date.now()));
  }

  if (pathname === "/api/self-monitor" && method === "GET") {
    return Response.json(computeSelfMonitor(ctx.db));
  }

  if (pathname === "/api/proposals" && method === "GET") {
    return Response.json(buildProposals(ctx.db, Date.now()));
  }

  if (pathname === "/api/memory" && method === "GET") {
    return Response.json(listMemoryFiles());
  }

  if (pathname === "/api/learned" && method === "GET") {
    return Response.json(listLearnedEntries());
  }

  const learnedRevertMatch = pathname.match(/^\/api\/learned\/(\d+)$/);
  if (learnedRevertMatch) {
    if (method !== "DELETE") return methodNotAllowed();
    const ok = revertLearnedEntry("learned", Number(learnedRevertMatch[1]));
    if (ok) ctx.hub.broadcast({ type: "event", name: "memory:updated", payload: "learned" });
    return ok ? Response.json({ reverted: true }) : notFound(pathname);
  }

  if (pathname === "/api/reflect" && method === "POST") {
    const outcome = await runReflector(ctx.db, ctx.runAgent);
    if (outcome.ran) ctx.hub.broadcast({ type: "event", name: "memory:updated", payload: "learned" });
    return Response.json(outcome);
  }

  const memoryFileMatch = pathname.match(/^\/api\/memory\/([^/]+)$/);
  if (memoryFileMatch) {
    if (method !== "PUT") return methodNotAllowed();
    let body: { content?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body?.content !== "string") return badRequest("content (string) required");
    const file = writeMemoryFile(memoryFileMatch[1] as string, body.content);
    ctx.hub.broadcast({ type: "event", name: "memory:updated", payload: file.name });
    return Response.json(file);
  }

  const projectMemoryMatch = pathname.match(/^\/api\/projects\/([^/]+)\/memory$/);
  if (projectMemoryMatch) {
    const slug = projectMemoryMatch[1] as string;
    if (!getProject(ctx.db, slug)) return notFound(pathname);
    if (method === "GET") return Response.json({ content: readProjectMemory(slug) });
    if (method === "PUT") {
      let body: { content?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (typeof body?.content !== "string") return badRequest("content (string) required");
      writeProjectMemory(slug, body.content);
      ctx.hub.broadcast({ type: "event", name: "memory:updated", payload: slug });
      return Response.json({ content: body.content });
    }
    return methodNotAllowed();
  }

  if (pathname === "/api/search" && method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    return Response.json(q.trim() ? searchTaskHits(ctx.db, q) : []);
  }

  if (pathname === "/api/search/transcripts" && method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    return Response.json(q.trim() ? searchTranscripts(ctx.db, q) : []);
  }

  if (pathname === "/api/searches") {
    if (method === "GET") return Response.json(listSavedSearches());
    if (method === "POST") {
      let input: CreateSavedSearchInput;
      try {
        input = (await req.json()) as CreateSavedSearchInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (!input?.name?.trim() || typeof input.query !== "string") {
        return badRequest("name and query are required");
      }
      const saved = createSavedSearch(input);
      ctx.hub.broadcast({ type: "event", name: "search:saved", payload: saved.id });
      return Response.json(saved, { status: 201 });
    }
    return methodNotAllowed();
  }

  const searchDeleteMatch = pathname.match(/^\/api\/searches\/([^/]+)$/);
  if (searchDeleteMatch) {
    if (method !== "DELETE") return methodNotAllowed();
    const ok = deleteSavedSearch(searchDeleteMatch[1] as string);
    return ok ? Response.json({ deleted: true }) : notFound(pathname);
  }

  if (pathname === "/api/approvals" && method === "GET") {
    return Response.json(ctx.approvals.list());
  }

  const approvalResolveMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/resolve$/);
  if (approvalResolveMatch) {
    if (method !== "POST") return methodNotAllowed();
    let body: ApprovalDecision;
    try {
      body = (await req.json()) as ApprovalDecision;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body?.allow !== "boolean") return badRequest("allow (boolean) required");
    const ok = ctx.approvals.resolve(approvalResolveMatch[1] as string, {
      allow: body.allow,
      reason: body.reason,
    });
    return ok ? Response.json({ resolved: true }) : notFound(pathname);
  }

  if (pathname === "/api/digest") {
    if (method === "GET") {
      const date = url.searchParams.get("date") ?? undefined;
      return Response.json(getDigest(ctx.db, Date.now(), date));
    }
    return methodNotAllowed();
  }

  if (pathname === "/api/digest/commit") {
    if (method !== "POST") return methodNotAllowed();
    let input: CommitDigestInput;
    try {
      input = (await req.json()) as CommitDigestInput;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (!Array.isArray(input?.picks)) return badRequest("picks must be an array of task ids");
    const digest = commitDigest(ctx.db, input, Date.now());
    ctx.hub.broadcast({ type: "event", name: "digest:committed", payload: digest.date });
    return Response.json(digest);
  }

  if (pathname === "/api/digest/recap") {
    if (method !== "POST") return methodNotAllowed();
    let input: RecapDigestInput;
    try {
      input = (await req.json().catch(() => ({}))) as RecapDigestInput;
    } catch {
      return badRequest("invalid JSON body");
    }
    const digest = recapDigest(ctx.db, Date.now(), input?.date);
    ctx.hub.broadcast({ type: "event", name: "digest:recapped", payload: digest.date });
    return Response.json(digest);
  }

  if (pathname === "/api/suggestions") {
    if (method === "GET") {
      const entityType = url.searchParams.get("entityType");
      const entityId = url.searchParams.get("entityId");
      if (!entityType || !entityId) return badRequest("entityType and entityId are required");
      return Response.json(listSuggestions(ctx.db, entityType, entityId));
    }
    if (method === "POST") {
      let input: CreateSuggestionInput;
      try {
        input = (await req.json()) as CreateSuggestionInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (!input?.entityType || !input?.entityId || !input?.field) {
        return badRequest("entityType, entityId and field are required");
      }
      const s = createSuggestion(ctx.db, input);
      ctx.hub.broadcast({ type: "event", name: "suggestion:created", payload: s.id });
      return Response.json(s, { status: 201 });
    }
    return methodNotAllowed();
  }

  const resolveMatch = pathname.match(/^\/api\/suggestions\/([^/]+)\/resolve$/);
  if (resolveMatch) {
    if (method !== "POST") return methodNotAllowed();
    let body: ResolveSuggestionInput;
    try {
      body = (await req.json()) as ResolveSuggestionInput;
    } catch {
      return badRequest("invalid JSON body");
    }
    const actions = ["accept", "edit", "override", "dismiss"];
    if (!body?.action || !actions.includes(body.action)) return badRequest("invalid action");
    const resolved = resolveSuggestion(ctx.db, resolveMatch[1] as string, body.action, body.value);
    if (!resolved) return notFound(pathname);
    ctx.hub.broadcast({ type: "event", name: "suggestion:resolved", payload: resolved.id });
    return Response.json(resolved);
  }

  if (pathname === "/api/import/candidates" && method === "GET") {
    return Response.json(scanClaudeProjects(ctx.db));
  }

  if (pathname === "/api/import/enrich" && method === "POST") {
    let body: { cwd?: string };
    try {
      body = (await req.json()) as { cwd?: string };
    } catch {
      return badRequest("invalid JSON body");
    }
    if (!body?.cwd) return badRequest("cwd is required");
    return Response.json(await ctx.enrich(body.cwd));
  }

  if (pathname === "/api/import" && method === "POST") {
    let body: { selections?: unknown };
    try {
      body = (await req.json()) as { selections?: unknown };
    } catch {
      return badRequest("invalid JSON body");
    }
    const selections = Array.isArray(body?.selections) ? body.selections : [];
    const created = importProjects(ctx.db, selections);
    if (created.length) ctx.hub.broadcast({ type: "event", name: "projects:imported" });
    return Response.json(created, { status: 201 });
  }

  if (pathname === "/api/settings") {
    if (method === "GET") return Response.json(readSettings());
    if (method === "PATCH") {
      let patch: {
        preferredTerminal?: string;
        claudeBinPath?: string;
        global?: Record<string, unknown>;
      };
      try {
        patch = (await req.json()) as typeof patch;
      } catch {
        return badRequest("invalid JSON body");
      }
      const current = readSettings();
      const next = {
        ...current,
        ...(patch.preferredTerminal ? { preferredTerminal: patch.preferredTerminal } : {}),
        ...("claudeBinPath" in patch
          ? { claudeBinPath: patch.claudeBinPath?.trim() || undefined }
          : {}),
        global: { ...current.global, ...(patch.global ?? {}) },
      };
      writeSettings(next);
      applyClaudeBinEnv(next); // export CADENCE_CLAUDE_BIN so agent spawns pick up the change
      ctx.hub.broadcast({ type: "event", name: "settings:updated" });
      return Response.json(next);
    }
    return methodNotAllowed();
  }

  // Stop (graceful) / kill (hard) any live session — warm handle or recorded pid.
  // 409 if nothing is alive to signal.
  const sessionSignalMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/(stop|kill)$/);
  if (sessionSignalMatch) {
    if (method !== "POST") return methodNotAllowed();
    const id = sessionSignalMatch[1] as string;
    const action = sessionSignalMatch[2] as "stop" | "kill";
    const session = getSession(ctx.db, id);
    if (!session) return notFound(pathname);
    if (!signalSession(ctx.spawn, session, action)) {
      return Response.json({ error: "session_not_live", id }, { status: 409 });
    }
    return Response.json({ ok: true, action });
  }

  // Single session: detail (+ liveness), re-organize (assign), or delete.
  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const id = sessionMatch[1] as string;
    const session = getSession(ctx.db, id);
    if (!session) return notFound(pathname);
    const withLive = (s: typeof session): SessionDetail => ({
      ...s,
      ...sessionRunState(ctx.spawn, s),
    });
    if (method === "GET") return Response.json(withLive(session));
    if (method === "PATCH") {
      let patch: UpdateSessionInput;
      try {
        patch = (await req.json()) as UpdateSessionInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      // A non-null link must point at an existing entity; null clears it.
      if (patch.taskId && !getTask(ctx.db, patch.taskId)) {
        return badRequest(`unknown task "${patch.taskId}"`);
      }
      if (patch.projectId && !getProjectById(ctx.db, patch.projectId)) {
        return badRequest(`unknown project "${patch.projectId}"`);
      }
      if (patch.fleetId && !getFleetById(ctx.db, patch.fleetId)) {
        return badRequest(`unknown fleet "${patch.fleetId}"`);
      }
      const updated = updateSession(ctx.db, id, patch);
      if (!updated) return notFound(pathname);
      ctx.hub.broadcast({ type: "event", name: "session:updated", payload: id });
      return Response.json(withLive(updated));
    }
    if (method === "DELETE") {
      signalSession(ctx.spawn, session, "kill"); // stop the process (warm or pid) before dropping the row
      const deleted = deleteSession(ctx.db, id);
      ctx.hub.broadcast({ type: "event", name: "session:deleted", payload: id });
      return Response.json({ deleted });
    }
    return methodNotAllowed();
  }

  // Terminal handoff. A RUNNING session can't be safely resumed in a terminal (two
  // writers on one transcript = the "frozen fork" confusion), so:
  //   - default        → 409 session_running (the UI offers Take over instead)
  //   - ?mode=takeover → stop the background process first, then resume interactively
  const openTermMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/open-terminal$/);
  if (openTermMatch) {
    if (method !== "POST") return methodNotAllowed();
    const session = getSession(ctx.db, openTermMatch[1] as string);
    if (!session) return notFound(pathname);
    if (!existsSync(session.cwd)) {
      return Response.json(
        { error: "cwd_missing", message: `The working directory is gone (${session.cwd}).` },
        { status: 409 },
      );
    }
    const command = buildResumeCommand(session.cwd, session.id);
    const { isLive } = sessionRunState(ctx.spawn, session);
    let tookOver = false;
    if (isLive) {
      if (url.searchParams.get("mode") !== "takeover") {
        return Response.json({ error: "session_running", command }, { status: 409 });
      }
      signalSession(ctx.spawn, session, "stop");
      const deadline = Date.now() + 5000;
      while (session.pid != null && isProcessAlive(session.pid) && Date.now() < deadline) {
        await Bun.sleep(150);
      }
      if (session.pid != null && isProcessAlive(session.pid)) {
        signalSession(ctx.spawn, session, "kill");
        await Bun.sleep(500);
        if (isProcessAlive(session.pid)) {
          return Response.json(
            { error: "stop_failed", message: "The running process did not stop — try Kill first." },
            { status: 500 },
          );
        }
      }
      // The row may already be finalized by the warm-handle close hook; make sure.
      const after = getSession(ctx.db, session.id);
      if (after && (after.status === "running" || after.status === "spawning")) {
        endSession(ctx.db, session.id, "killed");
      }
      ctx.hub.broadcast({ type: "event", name: "session:updated", payload: session.id });
      tookOver = true;
    }
    ctx.openTerminal(readSettings().preferredTerminal, command);
    return Response.json({ ok: true, command, tookOver });
  }

  const transcriptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
  if (transcriptMatch) {
    if (method !== "GET") return methodNotAllowed();
    const session = getSession(ctx.db, transcriptMatch[1] as string);
    if (!session) return notFound(pathname);
    // Resolve (and self-heal) where claude actually wrote the file — never 404 a
    // session that simply hasn't produced output yet; the UI renders the empty state.
    const path = resolveTranscriptPath(session, (fixed) => recordTranscriptPath(ctx.db, session.id, fixed));
    const limit = Number(url.searchParams.get("limit")) || undefined;
    return Response.json(path ? readTranscript(path, { limit }) : []);
  }

  const sessionMsgMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (sessionMsgMatch) {
    const sessionId = sessionMsgMatch[1] as string;
    if (method !== "POST") return methodNotAllowed();
    let input: { text?: string };
    try {
      input = (await req.json()) as { text?: string };
    } catch {
      return badRequest("invalid JSON body");
    }
    const text = typeof input?.text === "string" ? input.text.trim() : "";
    if (!text) return badRequest("text is required");
    const sent = ctx.spawn.send(sessionId, text);
    if (!sent) return Response.json({ error: "session_not_live", id: sessionId }, { status: 409 });
    return Response.json({ ok: true });
  }

  const ctxMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/context$/);
  if (ctxMatch) {
    const id = ctxMatch[1] as string;
    if (!getTaskDetail(ctx.db, id)) return notFound(pathname);
    if (method === "GET") {
      return Response.json({ content: readContext(id) });
    }
    if (method === "POST") {
      let input: AppendContextInput;
      try {
        input = (await req.json()) as AppendContextInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      const text = typeof input?.text === "string" ? input.text.trim() : "";
      if (!text) return badRequest("text is required");
      appendContext(id, text);
      ctx.hub.broadcast({ type: "event", name: "task:context", payload: id });
      return Response.json({ content: readContext(id) }, { status: 201 });
    }
    return methodNotAllowed();
  }

  if (pathname === "/api/projects") {
    if (method === "GET") return Response.json(listProjects(ctx.db));
    if (method === "POST") {
      let input: CreateProjectInput;
      try {
        input = (await req.json()) as CreateProjectInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (!name) return badRequest("name is required");
      const project = createProject(ctx.db, { ...input, name });
      ctx.hub.broadcast({ type: "event", name: "project:created", payload: project.slug });
      return Response.json(project, { status: 201 });
    }
    return methodNotAllowed();
  }

  const projMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projMatch) {
    const slug = projMatch[1] as string;
    if (method === "GET") {
      const project = getProject(ctx.db, slug);
      return project ? Response.json(project) : notFound(pathname);
    }
    if (method === "PATCH") {
      let patch: UpdateProjectInput;
      try {
        patch = (await req.json()) as UpdateProjectInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (typeof patch?.name === "string" && !patch.name.trim()) {
        return badRequest("name cannot be blank");
      }
      const updated = updateProject(ctx.db, slug, patch);
      if (!updated) return notFound(pathname);
      ctx.hub.broadcast({ type: "event", name: "project:updated", payload: updated.slug });
      return Response.json(updated);
    }
    return methodNotAllowed();
  }

  // Worktree-readiness check (§9, propose-don't-impose): a read-only Claude run inspects
  // the repo for worktree blockers (.env files, docker ports, install steps…) and the
  // verdict is persisted on the project. Fire-and-forget — the result arrives over WS.
  const worktreeCheckMatch = pathname.match(/^\/api\/projects\/([^/]+)\/worktree-check$/);
  if (worktreeCheckMatch) {
    if (method !== "POST") return methodNotAllowed();
    const slug = worktreeCheckMatch[1] as string;
    const project = getProject(ctx.db, slug);
    if (!project) return notFound(pathname);
    if (!project.rootPath) return conflict("project has no rootPath — set one first");
    void runWorktreeCheck(ctx.db, slug, ctx.runAgent)
      .then((out) => {
        if (out.ran) {
          ctx.hub.broadcast({ type: "event", name: "project:updated", payload: slug });
        } else {
          ctx.hub.broadcast({
            type: "event",
            name: "project:worktree-check-failed",
            payload: { slug, reason: out.reason ?? "check failed" },
          });
        }
      })
      .catch((err) => console.error(`[cadence] worktree check failed for ${slug}:`, err));
    return Response.json({ started: true }, { status: 202 });
  }

  if (pathname === "/api/fleets") {
    if (method === "GET") return Response.json(listFleets(ctx.db));
    if (method === "POST") {
      let input: CreateFleetInput;
      try {
        input = (await req.json()) as CreateFleetInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (!name) return badRequest("name is required");
      const fleet = createFleet(ctx.db, { ...input, name });
      ctx.hub.broadcast({ type: "event", name: "fleet:created", payload: fleet.slug });
      return Response.json(fleet, { status: 201 });
    }
    return methodNotAllowed();
  }

  const fleetRunMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/fleet-run$/);
  if (fleetRunMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = fleetRunMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    const outcome = await runFleetImplementer(ctx.db, taskId, ctx.runAgent);
    if (outcome.ran) {
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      ctx.hub.broadcast({ type: "event", name: "fleet:ran", payload: taskId });
    }
    return Response.json(outcome);
  }

  const fleetMatch = pathname.match(/^\/api\/fleets\/([^/]+)$/);
  if (fleetMatch) {
    const slug = fleetMatch[1] as string;
    if (method === "GET") {
      const fleet = getFleet(ctx.db, slug);
      return fleet ? Response.json(fleet) : notFound(pathname);
    }
    if (method === "PATCH") {
      let patch: UpdateFleetInput;
      try {
        patch = (await req.json()) as UpdateFleetInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (typeof patch?.name === "string" && !patch.name.trim()) {
        return badRequest("name cannot be blank");
      }
      const updated = updateFleet(ctx.db, slug, patch);
      if (!updated) return notFound(pathname);
      ctx.hub.broadcast({ type: "event", name: "fleet:updated", payload: updated.slug });
      return Response.json(updated);
    }
    return methodNotAllowed();
  }

  return notFound(pathname);
}

/**
 * The execution chain: Implementer → Verifier → (passed) Delivery. When the run
 * mutates the project working dir itself (worktrees disabled — the default — or
 * apply_in_place delivery), it holds the project's write lock for the WHOLE chain:
 * one implementation per project at a time, read stages queued meanwhile, and the
 * repo is back on its base branch before the lock is released. Worktree-isolated
 * executions skip the lock entirely and stay fully parallel.
 */
async function runExecutionChain(ctx: ApiContext, taskId: string): Promise<void> {
  let release: (() => void) | null = null;
  try {
    const lockTarget = executionLockTarget(ctx.db, taskId);
    if (lockTarget) {
      release = await projectLocks.acquireWrite(lockTarget.projectId, {
        guard: { db: ctx.db, rootPath: lockTarget.rootPath, excludeTaskId: taskId },
        onQueued: () => {
          // Visible queueing (§10: never lie about state): the project dir is busy with
          // another in-place run — note it on the timeline and let the card spin as "queued".
          recordEvent(ctx.db, {
            taskId,
            type: "execution_queued",
            payload: { projectId: lockTarget.projectId },
          });
          ctx.activity.start(taskId, "queued");
          ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
        },
      });
      ctx.activity.end(taskId); // clear the "queued" spinner if we showed one
    }

    const r = await ctx.activity.track(taskId, "implementer", () =>
      runImplementer(ctx.db, taskId, ctx.runAgent),
    );
    if (!r.ran) {
      // A graceful bail (dirty tree, unapproved plan, dangerous-without-worktree…) must
      // be visible, not a silent stall: note the reason on the task's context channel.
      if (r.reason) {
        appendContext(taskId, `Implementer didn't run: ${r.reason}`);
        ctx.hub.broadcast({ type: "event", name: "task:context", payload: taskId });
        ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      }
      return;
    }
    ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    ctx.hub.broadcast({ type: "event", name: "task:implemented", payload: taskId });
    // Implemented → Verifier (tests/build/lint + diverse reviewers) → pass/fail.
    const v = await ctx.activity.track(taskId, "verifier", () =>
      runVerifier(ctx.db, taskId, ctx.runAgent),
    );
    if (v.ran) {
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      ctx.hub.broadcast({ type: "event", name: "task:verified", payload: taskId });
      // Passed → the task lands in Review for the human to merge (3.7); notify
      // so it surfaces in the "needs you" feed. Delivery then writes the summary.
      if (v.passed) {
        const reviewing = getTask(ctx.db, taskId);
        if (reviewing) notifyOnTransition(ctx.hub, "verifying", reviewing);
        const d = await ctx.activity.track(taskId, "delivery", () =>
          runDelivery(ctx.db, taskId, ctx.runAgent),
        );
        if (d.ran) ctx.hub.broadcast({ type: "event", name: "task:delivered", payload: taskId });
      }
    }
  } catch (err) {
    console.error(`[cadence] execution failed for ${taskId}:`, err);
  } finally {
    release?.();
  }
}

/**
 * Phase 2 autonomy: when the master switch is on, triage a freshly-captured task
 * in the background (fire-and-forget) and broadcast the result. No-op when off,
 * so the default install never spawns claude on capture.
 */
function maybeTriageOnCapture(ctx: ApiContext, taskId: string): void {
  if (!readSettings().global.autonomy) return;
  void ctx.activity
    .track(taskId, "triage", () => runTriage(ctx.db, taskId, ctx.runAgent))
    .then(async (outcome) => {
      if (!outcome.ran) return;
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      if (outcome.status === "needs_feedback") {
        const t = getTask(ctx.db, taskId);
        if (t) notifyOnTransition(ctx.hub, "inbox", t);
        return;
      }
      // Triaged → auto-continue into Discovery (the refinement loop) — unless the
      // assigned project opted out of autonomy (§9.1: per-project enable/disable).
      ctx.hub.broadcast({ type: "event", name: "task:triaged", payload: taskId });
      const triaged = getTask(ctx.db, taskId);
      if (!resolveProjectAutonomy(ctx.db, triaged?.projectId ?? null)) return;
      const disc = await ctx.activity.track(taskId, "discovery", () =>
        runDiscovery(ctx.db, taskId, ctx.runAgent),
      );
      if (!disc.ran) return;
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      if (disc.status === "needs_feedback") {
        const t = getTask(ctx.db, taskId);
        if (t) notifyOnTransition(ctx.hub, "refining", t);
        return;
      }
      // Refining with unknowns → the Questioner turns them into Q&A cards.
      if (disc.status === "refining") {
        const q = await ctx.activity.track(taskId, "questioner", () =>
          runQuestioner(ctx.db, taskId, ctx.runAgent),
        );
        if (!q.ran) return;
        ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
        if (q.status === "needs_feedback") {
          const t = getTask(ctx.db, taskId);
          if (t) notifyOnTransition(ctx.hub, "refining", t);
        }
      }
    })
    .catch((err) => console.error(`[cadence] autonomy pipeline failed for ${taskId}:`, err));
}

/** A Q&A answer counts as given if it's a non-empty string or a non-empty selection. */
function isAnswered(a: string | string[] | undefined): boolean {
  if (a == null) return false;
  return Array.isArray(a) ? a.length > 0 : a.trim().length > 0;
}

function badRequest(message: string): Response {
  return Response.json({ error: "bad_request", message }, { status: 400 });
}
function notFound(path: string): Response {
  return Response.json({ error: "not_found", path }, { status: 404 });
}
function methodNotAllowed(): Response {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
function conflict(message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: "conflict", message, ...extra }, { status: 409 });
}
