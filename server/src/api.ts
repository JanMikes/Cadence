import {
  APP_NAME,
  type CreateTaskInput,
  type HealthStatus,
  SCHEMA_VERSION,
} from "@cadence/shared";
import type { Db } from "./db/client";
import { createTask, getTask, listTasks } from "./tasks";
import type { WsHub } from "./ws";

export interface ApiContext {
  db: Db;
  hub: WsHub;
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
      const task = getTask(ctx.db, id);
      return task ? Response.json(task) : notFound(pathname);
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
