import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  APP_NAME,
  APP_TAGLINE,
  SCHEMA_VERSION,
  type ClientMessage,
  type ServerMessage,
} from "@cadence/shared";
import { ActivityTracker } from "./activity";
import { makeAskGate } from "./agents/ask-gate";
import { makeBackendRunner } from "./agents/backend";
import { makeRecordingRunner } from "./agents/recording-runner";
import { startGitContextSweep } from "./git-context";
import { healStuckTasks } from "./heal";
import { failStaleWorktreeCheckRuns } from "./projects";
import { reconcileOrphans, restoreAbandonedExecutions, startSessionWatchdog } from "./watchdog";
import { ApprovalRegistry } from "./approvals";
import { emitProposals } from "./proposals";
import { startSweep } from "./sweep";
import type { AgentRunner } from "./agents/triage";
import { handleApi, maybeTriageOnCapture } from "./api";
import { startRecurringScheduler } from "./recurring";
import { cadenceHome, type Db, openAndMigrate } from "./db/client";
import { claudeEnrich } from "./import";
import { SpawnManager } from "./sessions";
import { applyClaudeBinEnv, bootstrap, readSettings } from "./store/store";
import { openInTerminal } from "./terminal";
import { startWatcher, type WatcherHandle } from "./store/watcher";
import { WsHub, type WsData } from "./ws";

const DEFAULT_WEB_DIR = join(import.meta.dir, "..", "..", "web", "dist");

export interface GatewayOptions {
  /** Port to bind (default CADENCE_PORT or 4477). Use 0 for an ephemeral port. */
  port?: number;
  /** Built web assets to serve (default `opts.webDir ?? CADENCE_WEB_DIR ?? ../../web/dist`). */
  webDir?: string;
  /** Inject a db (tests). When omitted, bootstraps ~/.cadence and opens the app db. */
  db?: Db;
  /** Start the file watcher (default true; tests pass false). */
  startWatcher?: boolean;
  /** Override the terminal launcher (tests pass a mock to avoid opening windows). */
  openTerminal?: (app: string, command: string) => void;
  /** Override the import enricher (tests pass a mock to avoid a real claude call). */
  enrich?: (cwd: string) => Promise<import("@cadence/shared").EnrichResult>;
  /** Override the PR/MR author lookup (tests avoid real gh/glab calls, 6.5.a). */
  prAuthor?: (ref: import("@cadence/shared").PrRef) => string | null;
  /** Override the forge review data layer (tests avoid real gh/glab calls, 6.5.b). */
  reviewApi?: (forge: "github" | "gitlab") => import("./forge-review").ForgeReviewApi;
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
  // CADENCE_WEB_DIR lets the compiled sidecar serve assets shipped as Tauri resources
  // (no source-relative `web/dist`). Explicit opts.webDir still wins (tests).
  const webDir = opts.webDir ?? process.env.CADENCE_WEB_DIR ?? DEFAULT_WEB_DIR;
  const hub = new WsHub();

  let db: Db;
  if (opts.db) {
    db = opts.db;
  } else {
    bootstrap();
    db = openAndMigrate();
  }

  // Export the configured Claude binary path (if any) so agent spawns find it even when the app was
  // launched from Finder without a shell PATH (4.2). Only sets on startup; clearing is done via PATCH.
  const startupSettings = readSettings();
  if (startupSettings.claudeBinPath) applyClaudeBinEnv(startupSettings);

  const spawnManager = new SpawnManager(db, hub);
  const approvals = new ApprovalRegistry((req, event) =>
    hub.broadcast({ type: "event", name: `approval:${event}`, payload: req.id }),
  );
  // Tracks in-flight autonomy work (triage/discovery/questioner) → WS events → board/task spinner.
  const activity = new ActivityTracker((name, payload) => hub.broadcast({ type: "event", name, payload }));

  // Live ask-gate: an agent's mid-run question/permission request parks in the
  // approvals registry (→ attention modal in the web UI) while the run waits; the
  // answer feeds back into the run via the SDK's canUseTool. The default runner is
  // backend-dispatched (SDK with the gate, CLI fallback/override).
  const askGate = makeAskGate({ approvals, hub, db });
  // Record every task-linked agent stage (triage…delivery) as a first-class oneshot Session with its
  // transcript, so each stage's full output shows up in the Sessions list. An injected
  // runner (tests) is wrapped too — recording (sessions + run reports) is gateway
  // behavior, not an implementation detail of the real claude runner.
  const runAgentImpl = makeRecordingRunner({ db, hub, base: opts.runAgent ?? makeBackendRunner({ askGate }) });

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

  // Recurring-task scheduler: fires due templates (creating real tasks) every 30 s,
  // with a boot catch-up pass so a template due while the app was off fires once now.
  // Created tasks enter the same triage-on-capture chain as manual captures.
  const recurring =
    opts.startWatcher === false
      ? { close() {} }
      : startRecurringScheduler(db, hub, {
          onTaskCreated: (taskId) =>
            maybeTriageOnCapture({ db, hub, activity, runAgent: runAgentImpl }, taskId),
        });

  // Reconcile orphaned runs from a previous process — always, even with autonomy off (a
  // correctness concern, not autonomy): end sessions whose process died with the old gateway,
  // and rescue any task stranded mid-execution so nothing lingers in a silent "In progress".
  if (opts.startWatcher !== false) {
    const orphans = reconcileOrphans(db, hub);
    if (orphans) console.log(`[cadence] reconciled ${orphans} orphaned session(s) from a previous run`);
    // Repo repair AFTER the orphan kill (no dead writer still scribbling): secure
    // interrupted in-place work onto its task branch and restore the base branch,
    // so no project dir stays stranded on a cadence/* branch across restarts.
    const repaired = restoreAbandonedExecutions(db, hub);
    if (repaired) console.log(`[cadence] restored ${repaired} project dir(s) left on a task branch`);
    // A readiness check left "running" by the old process would show "Checking…" forever.
    const staleChecks = failStaleWorktreeCheckRuns(db);
    if (staleChecks) console.log(`[cadence] marked ${staleChecks} interrupted worktree check(s) failed`);
  }

  // Self-heal tasks left in "refining" by a previous run (crash/restart). Background, autonomy-only,
  // skipped in tests (startWatcher === false). Discovery/Questioner are now never-strand.
  if (opts.startWatcher !== false && readSettings().global.autonomy) {
    void healStuckTasks({ db, runAgent: runAgentImpl, activity, hub }).then((n) => {
      if (n) console.log(`[cadence] self-healed ${n} task(s) stuck in refining`);
    });
  }

  // Proactive session watchdog: detect dead/stuck runs at runtime so a conversation is never
  // silently dead — dead sessions are ended + their task rescued, idle ones surface a nudge.
  const watchdog =
    opts.startWatcher === false ? { close() {} } : startSessionWatchdog(db, hub, { activity });

  // Git-context sweep: deterministic local-git checks that catch merges done outside
  // Cadence (terminal merges, forge PR/MR merges) so review/done cards stay honest.
  const gitSweep =
    opts.startWatcher === false ? { close() {} } : startGitContextSweep(db, hub);

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
          activity,
          openTerminal: opts.openTerminal ?? openInTerminal,
          enrich: opts.enrich ?? claudeEnrich,
          prAuthor: opts.prAuthor,
          reviewApi: opts.reviewApi,
          runAgent: runAgentImpl,
          approvals,
        });
      }

      return serveStatic(url.pathname, webDir);
    },
    websocket: {
      // Dead-client cleanup is protocol-level and free: browsers auto-answer ping frames,
      // so a quiet-but-alive tab stays connected while a vanished one is reaped in ≤60s.
      // (App-level ping/pong below exists for the opposite direction — the browser can't
      // observe protocol pongs, so the client proves *server* liveness with its own ping.)
      idleTimeout: 60,
      sendPings: true,
      open(ws: ServerWebSocket<WsData>) {
        hub.add(ws);
        hub.send(ws, { type: "hello", app: APP_NAME, version: SCHEMA_VERSION });
      },
      close(ws: ServerWebSocket<WsData>) {
        hub.remove(ws);
      },
      message(ws: ServerWebSocket<WsData>, raw) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          return;
        }
        if (msg.type === "ping") hub.send(ws, { type: "pong", t: msg.t });
      },
    },
  });

  const boundPort = server.port ?? port;
  const url = `http://localhost:${boundPort}`;

  // Write a runtime descriptor so the Tauri supervisor + smokes can discover the (often ephemeral,
  // CADENCE_PORT=0) bound port without scraping stdout. Captured once so stop() removes the same file
  // even if CADENCE_HOME later changes. Best-effort: a write failure must never stop the gateway serving.
  const runtimePath = join(cadenceHome(), "runtime.json");
  try {
    mkdirSync(cadenceHome(), { recursive: true });
    writeFileSync(runtimePath, `${JSON.stringify({ port: boundPort, url, pid: process.pid }, null, 2)}\n`);
  } catch {
    // non-fatal — runtime.json is a convenience for tooling, not required to serve
  }

  return {
    port: boundPort,
    url,
    db,
    hub,
    spawn: spawnManager,
    approvals,
    broadcast: (msg) => hub.broadcast(msg),
    stop: async () => {
      watcher?.close();
      sweep.close();
      recurring.close();
      watchdog.close();
      gitSweep.close();
      for (const id of spawnManager.liveIds()) spawnManager.kill(id);
      rmSync(runtimePath, { force: true }); // remove the runtime descriptor on graceful stop
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
