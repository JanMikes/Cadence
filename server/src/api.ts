import {
  APP_NAME,
  type AppendContextInput,
  type CreateProjectInput,
  type CreateTaskInput,
  type HealthStatus,
  SCHEMA_VERSION,
  type SpawnSessionInput,
  type UpdateProjectInput,
  type UpdateTaskInput,
} from "@cadence/shared";
import { composeContext } from "./context";
import type { Db } from "./db/client";
import { importProjects, scanClaudeProjects } from "./import";
import { notifyOnTransition } from "./notify";
import { createProject, getProject, listProjects, updateProject } from "./projects";
import { appendContext, readContext, readSettings, writeSettings } from "./store/store";
import { getSession, listSessions, listTaskSessions, type SpawnManager } from "./sessions";
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
      return Response.json(listTasks(ctx.db, { status }));
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
      const updated = updateTask(ctx.db, id, patch);
      if (!updated) return notFound(pathname);
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: updated.id });
      notifyOnTransition(ctx.hub, before?.status, updated);
      return Response.json(updated);
    }
    return methodNotAllowed();
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

function badRequest(message: string): Response {
  return Response.json({ error: "bad_request", message }, { status: 400 });
}
function notFound(path: string): Response {
  return Response.json({ error: "not_found", path }, { status: 404 });
}
function methodNotAllowed(): Response {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
