import {
  APP_NAME,
  type AppendContextInput,
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
  type SpawnSessionInput,
  type UpdateFleetInput,
  type UpdateProjectInput,
  type UpdateTaskInput,
} from "@cadence/shared";
import { runDelivery } from "./agents/delivery";
import { runDiscovery } from "./agents/discovery";
import { runFleetImplementer } from "./agents/fleet";
import { runImplementer } from "./agents/implementer";
import { approvePlan, runPlanner } from "./agents/planner";
import { runReflector } from "./agents/reflector";
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
import { listTaskEvents } from "./events";
import { createFleet, getFleet, listFleets, updateFleet } from "./fleets";
import { importProjects, scanClaudeProjects } from "./import";
import { listMemoryFiles, readProjectMemory, writeMemoryFile, writeProjectMemory } from "./memory";
import { createSavedSearch, deleteSavedSearch, listSavedSearches } from "./searches";
import { computeSelfMonitor } from "./selfmonitor";
import { runSweep } from "./sweep";
import { searchTranscripts } from "./transcript-search";
import { allowedTransitions, canTransition, isValidStatus } from "./lifecycle";
import { notifyOnTransition } from "./notify";
import { mergeTask, taskDiff } from "./review";
import {
  createProject,
  getProject,
  listProjects,
  resolveProjectAutonomy,
  updateProject,
} from "./projects";
import {
  appendContext,
  readContext,
  readDelivery,
  readPlan,
  readQa,
  readSettings,
  readVerify,
  writeSettings,
} from "./store/store";
import { getSession, listSessions, listTaskSessions, type SpawnManager } from "./sessions";
import { createSuggestion, listSuggestions, resolveSuggestion } from "./suggestions";
import { buildResumeCommand } from "./terminal";
import { readLiveSessions, readTranscript } from "./transcripts";
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
      const title = typeof input?.title === "string" ? input.title.trim() : "";
      if (!title) return badRequest("title is required");
      const body = typeof input?.body === "string" ? input.body : undefined;

      const task = createTask(ctx.db, { title, body });
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
    // approvable plan.md. The Implementer (3.4) runs only after approval.
    void runPlanner(ctx.db, taskId, ctx.runAgent)
      .then((p) => {
        if (p.ran) ctx.hub.broadcast({ type: "event", name: "task:plan", payload: taskId });
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
    // Approving the plan starts implementation (only while executing). The
    // Implementer runs in the isolated worktree; it bails gracefully if it can't.
    if (task.status === "implementing") {
      void runImplementer(ctx.db, taskId, ctx.runAgent)
        .then(async (r) => {
          if (!r.ran) return;
          ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
          ctx.hub.broadcast({ type: "event", name: "task:implemented", payload: taskId });
          // Implemented → Verifier (tests/build/lint + diverse reviewers) → pass/fail.
          const v = await runVerifier(ctx.db, taskId, ctx.runAgent);
          if (v.ran) {
            ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
            ctx.hub.broadcast({ type: "event", name: "task:verified", payload: taskId });
            // Passed → Delivery produces the summary + branch/PR (task stays in
            // review for the human to merge in 3.7).
            if (v.passed) {
              const d = await runDelivery(ctx.db, taskId, ctx.runAgent);
              if (d.ran) ctx.hub.broadcast({ type: "event", name: "task:delivered", payload: taskId });
            }
          }
        })
        .catch((err) => console.error(`[cadence] execution failed for ${taskId}:`, err));
    }
    return Response.json(plan);
  }

  const refineMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/refine$/);
  if (refineMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = refineMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    const before = getTask(ctx.db, taskId);
    const outcome = await runDiscovery(ctx.db, taskId, ctx.runAgent);
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

  if (pathname === "/api/memory" && method === "GET") {
    return Response.json(listMemoryFiles());
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
      let patch: { preferredTerminal?: string; global?: Record<string, unknown> };
      try {
        patch = (await req.json()) as typeof patch;
      } catch {
        return badRequest("invalid JSON body");
      }
      const current = readSettings();
      const next = {
        ...current,
        ...(patch.preferredTerminal ? { preferredTerminal: patch.preferredTerminal } : {}),
        global: { ...current.global, ...(patch.global ?? {}) },
      };
      writeSettings(next);
      ctx.hub.broadcast({ type: "event", name: "settings:updated" });
      return Response.json(next);
    }
    return methodNotAllowed();
  }

  const openTermMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/open-terminal$/);
  if (openTermMatch) {
    if (method !== "POST") return methodNotAllowed();
    const session = getSession(ctx.db, openTermMatch[1] as string);
    if (!session) return notFound(pathname);
    const command = buildResumeCommand(session.cwd, session.id);
    ctx.openTerminal(readSettings().preferredTerminal, command);
    return Response.json({ ok: true, command });
  }

  const transcriptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
  if (transcriptMatch) {
    if (method !== "GET") return methodNotAllowed();
    const session = getSession(ctx.db, transcriptMatch[1] as string);
    if (!session?.transcriptPath) return notFound(pathname);
    const limit = Number(url.searchParams.get("limit")) || undefined;
    return Response.json(readTranscript(session.transcriptPath, { limit }));
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
 * Phase 2 autonomy: when the master switch is on, triage a freshly-captured task
 * in the background (fire-and-forget) and broadcast the result. No-op when off,
 * so the default install never spawns claude on capture.
 */
function maybeTriageOnCapture(ctx: ApiContext, taskId: string): void {
  if (!readSettings().global.autonomy) return;
  void runTriage(ctx.db, taskId, ctx.runAgent)
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
      const disc = await runDiscovery(ctx.db, taskId, ctx.runAgent);
      if (!disc.ran) return;
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      if (disc.status === "needs_feedback") {
        const t = getTask(ctx.db, taskId);
        if (t) notifyOnTransition(ctx.hub, "refining", t);
        return;
      }
      // Refining with unknowns → the Questioner turns them into Q&A cards.
      if (disc.status === "refining") {
        const q = await runQuestioner(ctx.db, taskId, ctx.runAgent);
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
