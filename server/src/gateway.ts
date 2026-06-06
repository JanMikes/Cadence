import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { APP_NAME, APP_TAGLINE, SCHEMA_VERSION, type ServerMessage } from "@cadence/shared";
import { runAgent } from "./agents/runner";
import { ApprovalRegistry } from "./approvals";
import { emitProposals } from "./proposals";
import { startSweep } from "./sweep";
import type { AgentRunner } from "./agents/triage";
import { handleApi } from "./api";
import { type Db, openAndMigrate } from "./db/client";
import { claudeEnrich } from "./import";
import { SpawnManager } from "./sessions";
import { bootstrap } from "./store/store";
import { openInTerminal } from "./terminal";
import { startWatcher, type WatcherHandle } from "./store/watcher";
import { WsHub, type WsData } from "./ws";

const DEFAULT_WEB_DIR = join(import.meta.dir, "..", "..", "web", "dist");

export interface GatewayOptions {
  /** Port to bind (default CADENCE_PORT or 4477). Use 0 for an ephemeral port. */
  port?: number;
  /** Built web assets to serve (default ../../web/dist). */
  webDir?: string;
  /** Inject a db (tests). When omitted, bootstraps ~/.cadence and opens the app db. */
  db?: Db;
  /** Start the file watcher (default true; tests pass false). */
  startWatcher?: boolean;
  /** Override the terminal launcher (tests pass a mock to avoid opening windows). */
  openTerminal?: (app: string, command: string) => void;
  /** Override the import enricher (tests pass a mock to avoid a real claude call). */
  enrich?: (cwd: string) => Promise<import("@cadence/shared").EnrichResult>;
  /** Override the one-shot agent runner (tests pass a mock; default real claude). */
  runAgent?: AgentRunner;
}

export interface Gateway {
  port: number;
  url: string;
  db: Db;
  hub: WsHub;
  spawn: SpawnManager;
  approvals: ApprovalRegistry;
  broadcast: (msg: ServerMessage) => void;
  stop: () => Promise<void>;
}

/** Start the local gateway: REST (/api/*), a WS hub (/ws), and the built web app. */
export function startGateway(opts: GatewayOptions = {}): Gateway {
  const port = opts.port ?? Number(process.env.CADENCE_PORT ?? 4477);
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const hub = new WsHub();

  let db: Db;
  if (opts.db) {
    db = opts.db;
  } else {
    bootstrap();
    db = openAndMigrate();
  }

  const spawnManager = new SpawnManager(db, hub);
  const approvals = new ApprovalRegistry((req, event) =>
    hub.broadcast({ type: "event", name: `approval:${event}`, payload: req.id }),
  );

  let watcher: WatcherHandle | undefined;
  if (opts.startWatcher !== false) {
    watcher = startWatcher(db, {
      onChange: (kind, rel) => hub.broadcast({ type: "event", name: `reindex:${kind}`, payload: rel }),
    });
  }

  // Background sweep (§8) — disabled unless CADENCE_SWEEP_MS is set; off in tests.
  // Each tick also emits not-yet-seen proactive proposals as notifications (5.4).
  const emittedProposals = new Set<string>();
  const sweep =
    opts.startWatcher === false
      ? { close() {} }
      : startSweep(db, hub, { onTick: () => emitProposals(db, hub, emittedProposals) });

  const server = Bun.serve<WsData>({
    port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        const ok = srv.upgrade(req, { data: { id: crypto.randomUUID() } satisfies WsData });
        return ok ? undefined : new Response("WebSocket upgrade failed", { status: 426 });
      }

      if (url.pathname.startsWith("/api/")) {
        return handleApi(req, url, {
          db,
          hub,
          spawn: spawnManager,
          openTerminal: opts.openTerminal ?? openInTerminal,
          enrich: opts.enrich ?? claudeEnrich,
          runAgent: opts.runAgent ?? runAgent,
          approvals,
        });
      }

      return serveStatic(url.pathname, webDir);
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        hub.add(ws);
        hub.send(ws, { type: "hello", app: APP_NAME, version: SCHEMA_VERSION });
      },
      close(ws: ServerWebSocket<WsData>) {
        hub.remove(ws);
      },
      message() {
        // Client messages handled as live features land (subscribe, ping, …).
      },
    },
  });

  const boundPort = server.port ?? port;
  return {
    port: boundPort,
    url: `http://localhost:${boundPort}`,
    db,
    hub,
    spawn: spawnManager,
    approvals,
    broadcast: (msg) => hub.broadcast(msg),
    stop: async () => {
      watcher?.close();
      sweep.close();
      for (const id of spawnManager.liveIds()) spawnManager.kill(id);
      await server.stop(true);
    },
  };
}

/** Serve a static file from the built web dir with SPA fallback to index.html. */
async function serveStatic(pathname: string, webDir: string): Promise<Response> {
  if (!existsSync(webDir)) {
    return new Response(
      `${APP_NAME} gateway — ${APP_TAGLINE}\n(run "bun run build" to serve the web app)\n`,
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const root = resolve(webDir);
  const candidate = resolve(join(webDir, rel));
  // Block path traversal even though we bind to localhost.
  const safe = candidate.startsWith(`${root}/`) || candidate === root;

  let file = safe ? Bun.file(candidate) : Bun.file(join(root, "index.html"));
  if (!(await file.exists())) file = Bun.file(join(root, "index.html")); // SPA fallback
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file);
}
