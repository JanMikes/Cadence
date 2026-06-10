# Cadence

> *Your backlog, in flow.*

A **local, single-user daily operational center**: task management + autonomous execution on
top of [Claude Code](https://claude.com/claude-code). Capture tasks all day; Cadence triages,
refines (asking only what it needs), and on **PLAY** plans, implements, verifies, and delivers —
while you watch and steer in real time. No cloud, no Docker, no other users; everything lives
locally in `~/.cadence/` (SQLite + per-task markdown) and Claude Code's own `~/.claude/`.

Start with [CLAUDE.md](CLAUDE.md) and [docs/platform-definition.md](docs/platform-definition.md)
(the product spec) for the full picture.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2
- [Claude Code](https://claude.com/claude-code) installed and **logged in with your Claude
  subscription** (`claude` works in your terminal). Agent runs use the same login.

### Billing — subscription by design

Cadence runs every agent on your **Claude subscription** (Max plan windows, no marginal cost).
It never switches to pay-per-token API billing on its own: every spawned Claude process gets a
sanitized environment that strips a stray `ANTHROPIC_API_KEY` (you'd see a warning in the
gateway log). If you genuinely want API billing, set `CADENCE_ALLOW_API_BILLING=1`.

Agent runs use the Claude Agent SDK (so a running agent can ask you questions in the app and
continue with your answer) with an automatic fallback to the raw `claude` CLI — that choice is
internal and self-healing, not something you configure.

## Build & run

```bash
bun install

# Development (two processes: gateway with watch + Vite web app)
bun run dev          # web UI on the Vite port, gateway on http://localhost:4477

# Production (single process: gateway serves the built web app)
bun run build
bun run --filter='@cadence/server' start   # → http://localhost:4477
```

Verify a checkout:

```bash
bun run typecheck
bun test
```

### Desktop app (optional)

The Tauri wrap ships the gateway as a sidecar inside `Cadence.app` (tray, global hotkey, OS
notifications, autostart):

```bash
bun run sidecar:build   # compile the gateway sidecar
bun run tauri:dev       # run the desktop shell in dev
bun run tauri:build     # build Cadence.app
```

See [docs/tauri-wrap.md](docs/tauri-wrap.md).

## Configure

Almost everything is configured **in the app** under Settings — no config files to edit:

- **Global** — default model, permission mode (Auto / Manual / Dangerous), delivery mode,
  system prompt, the autonomy master switch.
- **Agents** — per-stage prompt and model overrides (triage, discovery, planner, …).
- **Operations** — safety limits: stage timeouts, max concurrent agents, automatic-retry
  circuit breaker, stuck-run threshold, and how long a paused run waits for your answer when
  an agent asks a question mid-run (default 10 min).
- **Projects** — working dir, per-project autonomy, opt-in git worktrees, per-project agent
  prompt additions.

Settings persist in `~/.cadence/settings.json` (managed by the app); task data lives in
`~/.cadence/tasks/`; secrets belong in the OS keychain, never in the repo
(see [SECURITY.md](SECURITY.md)).

### Environment variables (optional)

| Variable | Purpose |
|---|---|
| `CADENCE_PORT` | Gateway port (default `4477`; `0` = ephemeral). |
| `CADENCE_HOME` | Data directory (default `~/.cadence`). |
| `CADENCE_CLAUDE_BIN` | Explicit path to the `claude` binary (also settable in Settings). |
| `CADENCE_ALLOW_API_BILLING` | `1` opts agent runs into API-key billing (default: stripped). |
| `CADENCE_SWEEP_MS` | Enable the background git/proposal sweep at this interval. |
| `CADENCE_RUNNER_BACKEND` | Debug lever: force the `sdk` or `cli` agent engine. |

## Where things are

| Path | What |
|---|---|
| `server/` | Bun gateway: REST + WebSocket, agent pipeline, SQLite (Drizzle). |
| `web/` | React + Vite + Tailwind web app (served by the gateway in production). |
| `shared/` | Types shared between server and web. |
| `docs/` | Product spec, build ledger, agent prompts, Claude Code control surfaces. |
| `src-tauri/` | Optional desktop shell. |
