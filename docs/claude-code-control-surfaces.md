# Claude Code — Control Surfaces Reference

Reference for building **Cadence**: a web app that spawns, monitors, and converses with
Claude Code sessions and hands them off to/from the terminal.

> **Provenance.** Everything marked ✅ was verified against the real `claude` binary
> (`v2.1.165`, `~/.local/bin/claude`) and the real files under `~/.claude/` on this machine
> on 2026-06-06. Items marked ⚠️ are from docs and **not** independently verified — confirm
> before building on them.

---

## 1. The three control surfaces

| Surface | Use it for | Integration cost |
|---|---|---|
| **Filesystem (read-only)** | dashboard, history, live monitoring | zero — read + watch files |
| **`claude` binary, stream-json mode** | spawn, drive, interrupt, resume, fork | spawn a subprocess, talk JSON over stdin/stdout |
| **Agent SDK** (`@anthropic-ai/claude-agent-sdk` / py `claude-agent-sdk`) | typed wrapper over the binary | a library, if backend is Node/Python |

Core insight: **Claude Code externalizes its entire state to flat files.** Monitoring needs no
API — you read files. Control is a separate, equally simple subprocess layer.

---

## 2. On-disk inventory (everything lives under `~/.claude/`)

### 2.1 Transcripts ✅
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`

- `<encoded-cwd>` = the absolute **real** (symlink-resolved) cwd with every
  **non-alphanumeric character** → `-` — not just `/`! Dots and underscores become dashes too
  (✅ verified on disk: `/www/.cadence-worktrees/x` → `-www--cadence-worktrees-x`,
  `/www/ceskakruta.cz` → `-www-ceskakruta-cz`). Because the rule may drift between claude
  versions, resolve defensively: try the encoded guess, then scan `projects/*/<session-id>.jsonl`
  by session id (`findTranscriptPath` in `server/src/transcripts.ts`).
- **Append-only**, one JSON object per line. Track a byte offset and read the delta to tail it.
- It is a **DAG, not a flat log**: every line has `uuid` + `parentUuid`. Forks and subagent
  sidechains (`isSidechain: true`) branch off. Walk parent pointers; don't assume order.

Verified line `type`s:
- `user` / `assistant` — wrap an Anthropic `message` object whose `content` is a string or an
  array of blocks: `thinking`, `text`, `tool_use`, `tool_result`. `user` tool-result lines also
  carry `toolUseResult`. `assistant` lines carry `requestId`.
- Metadata lines: `ai-title` (auto-generated session title — free dashboard labels), `mode`,
  `permission-mode`, `file-history-snapshot` (file checkpoints that power rewind), `last-prompt`
  (`leafUuid` = current DAG leaf), `attachment`.
- Common fields on message lines: `cwd`, `gitBranch`, `sessionId`, `timestamp`, `version`,
  `userType`, `entrypoint`, `promptId`.

### 2.2 Liveness oracle ✅ (the key undocumented bit)
`~/.claude/sessions/<pid>.json`
```json
{ "pid": 14716, "sessionId": "f5db3a99-…", "cwd": "/Users/janmikes/www/productiver",
  "status": "busy", "kind": "interactive", "entrypoint": "cli",
  "version": "2.1.165", "startedAt": 1780698238054, "updatedAt": 1780698414598 }
```
This is the "is it alive / what's it doing" feed. `sessionId → pid → status (busy|idle)`.
Watch this dir for the real-time process list. **Verify the `pid` is actually alive** — a crash
can leave a stale file.

### 2.3 Backlog primitive (already built-in) ✅
`~/.claude/tasks/<uuid>/N.json`
```json
{ "id": "7", "subject": "Support SVG as a fillable placeholder image",
  "description": "…", "activeForm": "Adding SVG-fill support",
  "status": "pending", "blocks": [], "blockedBy": [] }
```
Claude Code already ships a task store **with a dependency graph** (`blocks`/`blockedBy`) and
status, plus `.lock` (concurrency) and `.highwatermark` (streaming-read offset) files. Exposed
via the `TaskCreate/TaskList/TaskGet/TaskUpdate/TaskOutput/TaskStop` tools and the
`claude agents` subcommand. Treat as prior art for our backlog — reuse or model our own.

### 2.4 Background agents ✅
`claude agents` is a real subcommand ("Manage background agents"). Combined with `tasks/`,
that's the headless-worker substrate.

---

## 3. Spawning + streaming (the critical path) ✅

### 3.1 Verified stdin wire format (warm interactive session)
Run a long-lived process; write one JSON object per line to stdin per user turn:
```json
{"type":"user","message":{"role":"user","content":"your text here"}}
```
Proven: two messages → one warm process kept memory between turns ("remember 42" → recalled 42).
**stdin EOF ends the session** — keep the pipe open to keep it warm.

### 3.2 Verified stdout event stream (`--output-format stream-json --verbose`)
Per turn, in order:
- `system` `subtype:init` — session ready: `session_id`, `cwd`, `model`, `tools`, `mcp_servers`,
  `permissionMode`, `slash_commands`, `agents`, `skills`, `plugins`, `memory_paths`.
- `stream_event` — wraps a raw API event (`message_start`, `content_block_delta` with
  `text_delta`, etc.). Fields: `event`, `session_id`, `parent_tool_use_id`, `uuid`, `ttft_ms`.
  These give **live token-by-token typing** (needs `--include-partial-messages`).
- `assistant` — a completed message block (`text` or `tool_use`). Fields: `message`,
  `session_id`, `parent_tool_use_id`, `uuid`, `request_id`.
- `rate_limit_event` — occasional `rate_limit_info`.
- `result` — **turn boundary** (not process end). Carries: `result` (final text), `session_id`,
  `total_cost_usd`, `usage` (input/output/cache tokens), `modelUsage`, `num_turns`,
  `stop_reason`, `duration_ms`, `ttft_ms`, `is_error`, `permission_denials`.

⚠️ **Interactive tools in headless `-p` runs** (`AskUserQuestion`, `ExitPlanMode`, any
permission-gated tool): the CLI **auto-denies** them (`tool_result is_error:true`, content
`"Answer questions?"` / `"Exit plan mode?"`); the run may continue degraded, exit empty, or
hang. The full ask payload is visible live in the `assistant` `tool_use` block, and every
denial lands in `result.permission_denials`. Cadence's detection + handling:
[claude-interaction-handling.md](claude-interaction-handling.md) (✅ verified 2026-06-10).

### 3.2a Subscription usage windows (✅ verified 2026-06-10, the data behind `/usage`)
`GET https://api.anthropic.com/api/oauth/usage` with headers
`Authorization: Bearer <accessToken>` + `anthropic-beta: oauth-2025-04-20` returns:
```json
{ "five_hour":  { "utilization": 40.0, "resets_at": "2026-06-10T16:10:00+00:00" },
  "seven_day":  { "utilization": 32.0, "resets_at": "2026-06-13T17:00:00+00:00" },
  "seven_day_opus": null, "seven_day_sonnet": { "...": "same shape" },
  "extra_usage": { "is_enabled": false, "...": null } }
```
`utilization` is percent of the window consumed. The access token comes from
`~/.claude/.credentials.json` (`claudeAiOauth.accessToken`) or, on macOS, the keychain item
`Claude Code-credentials` (`security find-generic-password -s "Claude Code-credentials" -w`).
The token is local-only and must never leave the gateway — Cadence's `/api/usage` forwards only
the derived numbers (server/src/usage.ts `fetchClaudeWindows`, cached 60s). ⚠️ The endpoint +
beta header are unofficial (what the CLI itself uses) and may change without notice.

### 3.3 Minimal warm-process gateway (Node)
```js
import { spawn } from "node:child_process";

function openSession({ sessionId, cwd, model = "claude-opus-4-8", onEvent }) {
  const child = spawn("claude", [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",                    // REQUIRED with stream-json in print mode
    "--include-partial-messages",   // live token deltas
    "--session-id", sessionId,      // we assign it → correlate before it exists
    "--model", model,
    "--permission-mode", "acceptEdits",
  ], { cwd, stdio: ["pipe", "pipe", "pipe"] });

  let buf = "";
  child.stdout.on("data", c => {            // newline-delimited JSON
    buf += c;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) onEvent(JSON.parse(line));   // → forward to WebSocket
    }
  });

  return {
    send: text => child.stdin.write(
      JSON.stringify({ type:"user", message:{ role:"user", content:text }}) + "\n"),
    close: () => child.stdin.end(),   // EOF ends the warm session cleanly
    kill:  () => child.kill("SIGINT"),
  };
}
```

### 3.4 Two spawn strategies (use both)
- **Warm** (long-lived stream-json process, §3.3) ✅ — lowest latency, true back-and-forth.
  Best for the **interactive chat panel** a human is watching. Cost: babysit a process per chat,
  handle crashes.
- **One-shot** (`claude -p "msg" --resume <id>`) ✅ — stateless gateway, crash-proof, scalable.
  Each turn re-inits but context is **cache-read** (cheap; ~2s first token). Best for the
  **autonomous backlog workers** and intermittent chat.

Recommendation: one-shot+resume for the worker fleet; warm processes only for live panels.

---

## 4. "Terminal-like" experience — three options

| Approach | You get | Trade-off |
|---|---|---|
| **stream-json over WebSocket** (§3) ✅ | structured events: live typing, tool cards, per-turn cost | you build the UI, but see everything programmatically |
| **PTY + xterm.js** (`node-pty` runs interactive `claude` in the cwd) | literal pixel-identical CLI in the browser | opaque ANSI bytes — hard to track tools/cost |
| **`claude --remote-control [name]`** ⚠️ | built-in remote-attach (official primitive) | least plumbing; spike to learn the protocol |

All three write the same transcript, so handoff is uniform (§5).

---

## 5. Terminal ⇄ web handoff ✅

We own the `session_id` and the `cwd`, and a session is just a transcript file, so:
- **Web → terminal:** show `cd <cwd> && claude --resume <session-id>`; user lands mid-conversation.
  (Verified: a fresh `--resume` process recalled prior context.)
- **Terminal → web:** a terminal-started session appears automatically — same `sessions/<pid>.json`
  + transcript. Tail it; offer "take over" by spawning a warm `--resume` process once the
  terminal pid goes idle.
- **Never run two live processes against one `session_id`** — they contend on the transcript.
  Check the liveness oracle (§2.2) first. Want a parallel branch instead? `--fork-session`.

---

## 6. Verified CLI flag reference ✅ (binary v2.1.165)

| Flag | Purpose |
|---|---|
| `-p, --print` | non-interactive: print response and exit |
| `--output-format <text\|json\|stream-json>` | output shape (**stream-json needs `--verbose`**) |
| `--input-format <text\|stream-json>` | stdin shape; stream-json = warm multi-turn |
| `--include-partial-messages` | emit token deltas (with stream-json) |
| `--verbose` | required for stream-json print output |
| `--replay-user-messages` | re-emit stdin user messages back on stdout (UI ordering) |
| `--session-id <uuid>` | assign the session id up front |
| `-r, --resume [id]` | resume a session by id (or pick) |
| `-c, --continue` | resume most recent session in cwd |
| `--fork-session` | on resume, branch to a new id instead of contending |
| `--permission-mode <default\|acceptEdits\|plan\|bypassPermissions>` | autonomy level |
| `--dangerously-skip-permissions` | = bypassPermissions |
| `--model <model>` | e.g. `claude-opus-4-8`, `claude-haiku-4-5` |
| `--effort <level>` | effort level |
| `--append-system-prompt <txt>` / `--append-system-prompt-file <path>` | extend system prompt |
| `--mcp-config <configs...>` | load MCP servers from JSON |
| `--agents <json>` / `--agent <name>` | define / select custom agents |
| `--add-dir <path>` | extra working dirs |
| `-n, --name <name>` | display name (resumable by name) |
| `--no-session-persistence` | don't write transcript |
| `--remote-control [name]` ⚠️ | start interactive session with Remote Control |
| `--from-pr [value]` | resume a session linked to a PR |

Subcommands: `agents`, `auth`, `mcp`, `plugin`, `project`, `setup-token`, `update`, `doctor`,
`install`, `ultrareview`, `auto-mode`.

---

## 7. Gotchas (learned the hard way) ✅

- `--output-format stream-json` **requires `--verbose`** in print mode (errors otherwise).
- A `result` event is a **turn** boundary, not process end. The warm process ends on **stdin EOF**.
- **First token ~2s even on Haiku** (context/cache setup). `cache_read_input_tokens` confirms
  context is cached → cheap but not instant. Don't design for sub-second.
- **One live process per `session_id`** — coordinate via the liveness oracle before attaching.
- Transcripts are **plaintext, unencrypted** and contain real work + any secrets in CLAUDE.md.
  Keep any web UI auth'd and localhost-bound.
- The JSONL schema is **internal / unversioned** — pin a binary version and tolerate new line
  `type`s rather than asserting on them.

---

## 8. Monitoring & events (read path)

- Watch `~/.claude/sessions/*` → live process list + busy/idle transitions.
- Tail `~/.claude/projects/**/<id>.jsonl` (byte-offset delta) → stream turns/tool calls into UI.
- For **push** instead of poll: layer **hooks** (`~/.claude/settings.json`). `SessionStart`,
  `Stop`, `SubagentStop`, `Notification`, `PostToolUse` can be `type:"http"` and POST JSON
  (`session_id`, `cwd`, `timestamp`) to a local endpoint. Use hooks for *events*, files for
  *content*. ⚠️ exact hook payload/response schema not independently verified here.

---

## 9. Agent SDK notes

- `@anthropic-ai/claude-agent-sdk` (TS) / `claude-agent-sdk` (py) wrap exactly this subprocess.
  `query({ prompt, options })` returns an async generator; streaming-input mode = pass an
  async-iterable `prompt` for warm multi-turn. Options include `cwd`, `resume`, `forkSession`,
  `permissionMode`, `includePartialMessages`, `mcpServers`, and a **`canUseTool` callback** —
  the clean way to render an approve/deny permission prompt in the browser. Exposes `.interrupt()`.
- ⚠️ A separate **hosted "managed agents" `/v1/sessions` event API** was described in docs but
  **not verified** on this machine. Do not build on those specific event names
  (`sessions.events.stream`, `agent.tool_use`, etc.) without confirming against live docs.

---

## 10. Open questions for the build (to resolve during planning)

- Backlog store: reuse built-in `tasks/` vs our own SQLite (status, deps, `cwd`, `sessionId` FK).
- Worker isolation for parallel tasks touching the same repo: **git worktree per task**.
- Permission UX: `bypassPermissions` for autonomous workers vs `canUseTool` browser prompts for
  supervised chat.
- Terminal experience: stream-json UI vs PTY+xterm vs `--remote-control` (spike all three).
- Backend language: Node/Bun (use SDK) vs other (raw subprocess).
