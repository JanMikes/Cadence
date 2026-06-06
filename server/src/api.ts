import {
  APP_NAME,
  type AppendContextInput,
  type CreateProjectInput,
  type CreateSuggestionInput,
  type CreateTaskInput,
  type HealthStatus,
  type ResolveSuggestionInput,
  SCHEMA_VERSION,
  type SpawnSessionInput,
  type UpdateProjectInput,
  type UpdateTaskInput,
} from "@cadence/shared";
import { runDiscovery } from "./agents/discovery";
import { answerQuestions, runQuestioner } from "./agents/questioner";
import { type AgentRunner, runTriage } from "./agents/triage";
import { composeContext } from "./context";
import type { Db } from "./db/client";
import { searchTaskHits } from "./db/search";
import { listTaskEvents } from "./events";
import { importProjects, scanClaudeProjects } from "./import";
import { allowedTransitions, canTransition, isValidStatus } from "./lifecycle";
import { notifyOnTransition } from "./notify";
import { createProject, getProject, listProjects, updateProject } from "./projects";
import { appendContext, readContext, readQa, readSettings, writeSettings } from "./store/store";
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

  if (pathname === "/api/search" && method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    return Response.json(q.trim() ? searchTaskHits(ctx.db, q) : []);
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
      // Triaged → auto-continue into Discovery (the refinement loop).
      ctx.hub.broadcast({ type: "event", name: "task:triaged", payload: taskId });
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
