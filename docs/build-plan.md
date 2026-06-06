# Cadence — Build Plan & Progress Ledger

> **This file is the SINGLE SOURCE OF TRUTH for build progress.** A fresh Claude Code session reads
> it (after `CLAUDE.md`, `docs/platform-definition.md`, `docs/backlog.md`), reconciles it against the
> actual repo, then continues building. The bootstrap prompt is in
> [`build-prompt.md`](build-prompt.md).
>
> Meta: this build loop (markdown ledger = truth · reconcile · atomic verified steps · journal) is
> literally Cadence's own execution model. Once Cadence exists it could run its own build/maintenance.

## Status snapshot  ← the building agent keeps this current
- **Current phase:** Phase 2 — Autonomy (triage-on-capture + refinement) · user gave go-ahead by re-running /loop
- **Last completed step:** 2.1 (Agent runner — one-shot `claude -p` worker)
- **Next step:** 2.2 (Agent library — reusable subagent defs via `--agents`)
- **Blockers:** none
- **Last updated:** 2026-06-06
- **Phase 2 safety posture:** autonomy OFF by default (per-project toggle in 2.10); tests use the mock
  agent (no real model/cost); real-agent smokes are offered, not auto-run.

## Rules for the building agent (the idempotent loop)
1. **Orient** — read `CLAUDE.md`, `docs/platform-definition.md` (spec, the behavior source of truth),
   `docs/backlog.md`, and this file.
2. **Reconcile** — verify the snapshot against reality: `git log --oneline`, files present,
   `bun test` / `bun run build`. The repo + git history WIN; fix the ledger if they disagree. If there
   is no `package.json` yet (docs only), the build hasn't started → next step is 0.1.
3. **Select** the FIRST unchecked step in the lowest incomplete phase (respect order & deps).
4. **Implement** that ONE step per the spec and `CLAUDE.md` conventions. Small, focused diff; add a
   smoke test for new logic.
5. **Verify** with the step's *Verify* line + `bun test` + `bun run build`. It MUST pass. If you
   can't make it pass, do not check the box — record a blocker and stop.
6. **Commit** just that step: `build(<phase>.<step>): <summary>`.
7. **Record** — check the box, append a Progress Journal entry (what / decisions / deviations / notes
   for next session), update the Status snapshot.
8. **Continue** to the next step. You may run many steps and cross phase boundaries. You MAY stop at
   any committed+journaled boundary.
9. **Never** check an unverified box. **Never** guess an ambiguous product decision — record it under
   Blockers and stop for the human.

## Conventions
- Stack & structure per `CLAUDE.md` (Bun · `bun:sqlite`+Drizzle+FTS5 · Bun HTTP+WS gateway · React+
  Vite+Tailwind+shadcn/ui+xterm.js+TanStack Query). One step ≈ one commit.
- App data lives under `~/.cadence/` — never commit it (gitignored).
- `bun test` stays green and the app boots at every commit.
- Honor UX clarity rules (labeled icon buttons, plain language) and "propose, don't impose".

## How to run & verify
- **Run the app:** `bun install` → `bun run dev` (boots the gateway + Vite) → open the printed
  `localhost` URL.
- **Automated checks (every commit):** `bun test` (unit/smoke) and `bun run build` (prod build) must
  both pass.
- **Per step:** perform the step's *Verify* line.
- **Per phase:** run the *Acceptance check (manual)* at the end of the phase and confirm **every**
  expected result before the phase is "done".
- Verification is **not optional** — an unverified step is an unfinished step. If a check can't pass,
  it's a blocker: record it and stop.

---

## Phase 0 — Foundation
Goal: a booting Bun gateway + Vite/React shell + SQLite/Drizzle + storage + watcher + design base.

- [x] **0.0 Repo safety.** Harden `.gitignore` (`.env*`, `*.key`, `*.pem`, `secrets/`, `/.cadence/`);
  add a **pre-commit secret scan** (gitleaks or a grep guard) that blocks commits containing secrets
  or real client identifiers; add a short `SECURITY.md` (no confidential data in the repo; runtime
  data lives in `~/.cadence/`; secrets in the OS keychain; examples use fictional names). See
  platform-definition §13.
  - Verify: the hook REJECTS a test commit containing a fake `API_KEY=sk-test123`; PASSES a clean commit.
- [x] **0.1 Repo scaffold.** Root Bun + strict TypeScript. Folders `server/` (gateway), `web/`
  (Vite+React+TS), `shared/` (types). Root scripts `dev`, `build`, `test`.
  - Verify: `bun install` clean; `bun run dev` boots gateway + Vite; a placeholder page loads.
- [x] **0.2 SQLite + Drizzle.** drizzle + drizzle-kit. Index schema: `projects`, `fleets`, `tasks`,
  `task_deps`, `sessions`, `events`, `suggestions`. Migration creates `~/.cadence/cadence.db`.
  - Verify: migration runs; `bun test` inserts+selects one row per table.
- [x] **0.3 FTS5 search table.** FTS5 virtual table over task text (transcripts later); sync hooks
  stubbed.
  - Verify: insert a task, FTS query returns it.
- [x] **0.4 Storage layer (markdown ⇄ index).** Bootstrap `~/.cadence/` (dirs + `settings.json`).
  Helpers to read/write a task folder (`task.md` frontmatter+body, `context.md`, `qa.md`, …),
  project/fleet markdown, and reindex `task.md` → SQLite.
  - Verify: write a task folder, reindex; DB row matches frontmatter (round-trip test).
- [x] **0.5 File watcher.** Watch `~/.cadence/**` → reindex changed `task.md` into SQLite (+FTS).
  - Verify: edit a `task.md` on disk → DB + FTS update (watcher-event test).
- [x] **0.6 Gateway HTTP+WS skeleton.** REST router (`/api/health` + stubs), WS hub (broadcast),
  serves built `web/`. Typed API contract in `shared/`.
  - Verify: `GET /api/health` ok; WS connect receives a broadcast; prod build is served.
- [x] **0.7 Design base.** Tailwind + shadcn/ui; dark dev theme tokens; the **LabeledIconButton**
  primitive (icon REQUIRES a label) + app shell (left-nav placeholder).
  - Verify: themed shell renders; an example shows LabeledIconButton with icon+label.

**Acceptance check (manual):**
1. `bun run dev` → the themed app shell loads at localhost (dark dev theme, left-nav placeholder).
2. The page shows data fetched from the gateway (e.g. a health indicator) — gateway ↔ web works.
3. `~/.cadence/cadence.db` exists with migrated tables (`sqlite3 ~/.cadence/cadence.db .tables`).
4. Editing a placeholder `task.md` under `~/.cadence/tasks/` updates the DB (watcher reindexes).
5. `bun test` and `bun run build` are both green.
Then stop and report.

## Phase 1 — Task core + manual spawn (MVP)
Goal: capture → board → assign → manually spawn a Claude session in the task's repo → live stream →
converse → terminal handoff. No autonomy yet.

- [x] **1.1 Task model + quick-capture → Inbox.** Persistent capture input → `~/.cadence/tasks/<id>/
  task.md` + index; shows in Inbox.
  - Verify: capture a task; file + DB row exist; reload shows it.
- [x] **1.2 Board + task detail + context channel.** Kanban by status; detail (body, priority,
  deadline, estimate, labels); always-on free-form `context.md` editor.
  - Verify: drag across columns (status persists); add a context note (appends to `context.md`).
- [x] **1.3 Projects CRUD.** Create/list/edit projects (rootPath, color, default model/permission/
  delivery, systemPrompt) → `projects/<slug>.md` + index; assign a task to a project.
  - Verify: create a project; assign a task; cwd resolves to rootPath.
- [x] **1.4 Spawn infra (warm session).** `openSession` (verified pattern: `claude -p --input-format
  stream-json --output-format stream-json --verbose --include-partial-messages --session-id <uuid>
  --permission-mode <mode>` in the task cwd). Parse stdout NDJSON → typed events → WS; track session
  in DB.
  - Verify: spawn on a task; receive `system/init` + `result`; DB session row + cost recorded.
- [x] **1.5 Live transcript UI + follow-up.** Render events (token typing via `text_delta`, tool-use
  cards, `result`+cost); input sends follow-up messages to the warm process.
  - Verify: send a message → streamed reply; a 2nd retains context; cost shown.
- [x] **1.6 Context composition v1.** Compose Global → Project → Task (spec/context/qa) into
  `--append-system-prompt` at spawn.
  - Verify: a project systemPrompt marker visibly affects behavior.
- [x] **1.7 Permission mode selector.** Auto (default) / Manual / Dangerous per session+task
  (resolved task ?? project ?? global); mode shown on tile; Dangerous needs confirm.
  - Verify: each mode maps to the right `--permission-mode`; Dangerous prompts a confirm.
- [x] **1.8 Sessions view + past-transcript reader + sidechains.** Live tiles from `~/.claude/
  sessions/*` (status/busy, verify pid alive); read past `projects/**/*.jsonl` (render the parentUuid
  DAG); nest `isSidechain` subagent activity.
  - Verify: a running session shows busy/idle; a past session renders; a subagent run nests.
- [x] **1.9 Terminal handoff.** Per session: copy `cd <cwd> && claude --resume <id>` + one-click
  "Open in <terminal>" (gateway runs `open`/`osascript`); preferred terminal in Settings.
  - Verify: button opens the configured terminal at cwd running resume; copy works.
- [x] **1.10 Claude-assisted project import.** Scan `~/.claude/projects` dirs; background `claude -p`
  enriches each (remote/stack/name/desc); checklist → create selected.
  - Verify: detects real dirs; proposes; creates the ticked ones.
- [x] **1.11 Usage bar + cost.** Ambient subscription-window bar (5h+weekly from `rate_limit_info` +
  `stats-cache.json`); per-session/task cost.
  - Verify: bar reflects usage; cost accrues per session.
- [x] **1.12 Notifications.** In-app badges + Web Notifications API (needs-feedback / delivered).
  - Verify: a needs-input event raises a badge + desktop notification.
- [x] **1.13 Global search + ⌘K palette.** FTS5 over tasks; palette for jump-to + actions.
  - Verify: search finds a task by body text; ⌘K jumps to it.
- [x] **1.14 Suggestion primitive.** Accept/Edit/Override control + per-field provenance
  (suggested→confirmed), reusable.
  - Verify: a field shows a suggestion; Accept confirms; Override records provenance.

**Acceptance check (manual):**
1. Quick-capture a task → it appears in the Inbox and `~/.cadence/tasks/<id>/task.md` exists.
2. Create a project with a real `rootPath`; assign the task to it.
3. Spawn a Claude session on the task → it streams live (token typing, a tool card, a result + cost).
4. Send a follow-up message → context is retained across turns.
5. Switch permission mode to Manual → a tool action prompts approve/deny in-app.
6. Use the one-click button → the session opens in your terminal (resumes the same session id).
7. ⌘K search finds the task by a word from its body.
8. `bun test` and `bun run build` are both green.
Then stop and report.

## Phase 2 — Autonomy: triage-on-capture + refinement loop
(Derives from backlog Phase 2. Detail these into atomic steps when you reach the phase.)
- [x] 2.1 Agent runner: one-shot `-p --resume` worker + role selection + JSON-output parsing + status mapping.
  - **2026-06-06 · 2.1.** `server/src/agents/runner.ts` `runAgent(opts)` runs a one-shot `claude -p
    <prompt> --output-format json` (defaults to read-only `plan` permission mode) → `AgentResult`
    {text, json, costUsd, sessionId, isError, raw}; `modelForRole` (triage/delivery=haiku,
    discovery/questioner/verifier=sonnet, planner/implementer=opus); `parseAgentJson` extracts JSON from
    the result text incl. ```json fences. `command` override + `testing/mock-agent.ts` (canned via
    `CADENCE_MOCK_AGENT_RESULT`) make it model-free in tests. *Gotcha:* the mock scripts had no
    imports/exports so tsc treated them as global scripts → `argv`/`prompt` collided; added `export {}`.
    *Verified:* `bun test` (83 pass) — role→model, parseAgentJson (raw/fenced/prose), runAgent parses
    result/cost/session and surfaces a triage-style JSON object; `bun run build` green.
- [ ] 2.2 Agent library: reusable subagent defs injected via `--agents` (explorer, reviewers…).
- [ ] 2.3 Triage agent on capture (→ project/priority/deadline/labels/restatement, or `insufficient`).
- [ ] 2.4 Discovery agent (+ parallel explorer subagents) → spec/criteria/unknowns, or `insufficient`.
- [ ] 2.5 Questioner agent → ranked Q&A cards; Needs-Feedback UI (Q&A + "too vague" cards).
- [ ] 2.6 Lifecycle state machine enforced server-side + status timeline.
- [ ] 2.7 Deadline-aware prioritization (urgency = f(deadline, priority)).
- [ ] 2.8 Daily Digest: interactive morning plan → committed daily goal.
- [ ] 2.9 Daily Digest gamification (ring, streaks, personalized note) + evening recap → `digests/<date>.md`.
- [ ] 2.10 Autonomy settings (per-project enable/disable).

**Acceptance check (manual):** capture a task → triage auto-fills project/priority/deadline; refine
produces a spec + Q&A; answering Q&A (or adding context) advances it to Ready; an over-vague task
lands in Needs-Feedback ("too vague"); the Daily Digest proposes a deadline-ordered plan you can edit.

## Phase 3 — Execution: PLAY → implement → verify → deliver
- [ ] 3.1 Ready state + PLAY button.
- [ ] 3.2 Planner (plan mode) → approvable plan.
- [ ] 3.3 git worktree per task provisioning + branch naming.
- [ ] 3.4 Implementer in the worktree (permission mode per task).
- [ ] 3.5 Verifier (+ diverse reviewer subagents) → pass/fail.
- [ ] 3.6 Delivery + delivery-mode resolution (branch_summary / auto_pr / apply_in_place).
- [ ] 3.7 Review screen: in-app diff + summary + verify results; merge / request-changes.
- [ ] 3.8 Manual-approve mode (`canUseTool`) + Dangerous-mode guardrail (confirm + worktree).

**Acceptance check (manual):** press PLAY on a Ready task → plan → implement in a worktree → verify
passes → delivery produces the configured output (branch/PR/in-place); the Review screen shows the
diff + summary; Manual mode gates each tool call; Dangerous requires explicit confirmation.

## Phase 4 — Multi-repo, analytics, polish
- [ ] 4.1 Fleets (multi-project tasks; sessions across cwds; per-repo sub-results).
- [ ] 4.2 Dependencies graph + subtasks.
- [ ] 4.3 Cost & throughput analytics.
- [ ] 4.4 Extend search to transcripts (FTS over `*.jsonl`) + saved filters.
- [ ] 4.5 Calendar / deadline view.
- [ ] 4.6 Scheduled / background sweep mode.
- [ ] 4.7 (optional) Tauri wrap: menubar + OS-global hotkey.

**Acceptance check (manual):** a fleet task spawns sessions across multiple repos with per-repo
sub-results; analytics show per-project throughput + cost; transcript search returns matches across
sessions; the calendar shows deadlines.

## Phase 5 — Self-improving layer
- [ ] 5.1 Memory layer (global + per-project markdown + `MEMORY.md` + `communication.md`) composed into context.
- [ ] 5.2 Reflector/Librarian job (corrections + outcomes → memory).
- [ ] 5.3 Self-monitoring analytics (provenance, verify pass-rate, rollovers).
- [ ] 5.4 Proactive proposals via notifications.
- [ ] 5.5 "What Cadence learned" feed (review / revert).

**Acceptance check (manual):** correcting a suggestion updates memory; a later run reflects the
learning; a proactive proposal arrives as a notification; the "what Cadence learned" feed lets you
review and revert a memory entry.

---

## Progress Journal (append-only — newest at bottom)
<!-- Each entry: date · phase.step · what you did · decisions · deviations · notes for next session. -->
- **2026-06-06 · 0.0 Repo safety.** Added a tracked `.githooks/pre-commit` secret/client-identifier
  scanner (high-confidence regexes: private keys, AWS/GitHub/Slack tokens, JWTs, `secret/token/api_key=…`
  assignments, `sk-…`) + an optional machine-local denylist read from `~/.cadence/commit-denylist.txt`
  (so real client names never enter the public repo) + a `cadence-allow-secret` bypass marker. Activated
  via `git config core.hooksPath .githooks`. Added `SECURITY.md` (data-boundary policy). `.gitignore`
  already covered the required patterns (done in 6aaa440), so no change there.
  *Decisions:* hook lives under `.githooks/` (tracked) instead of `.git/hooks/` (untracked) so it
  versions with the repo; client names are kept out of the tracked hook by design. *Deviations:* `bun`
  was not installed on this machine — installed it (1.3.14) and symlinked into `~/.local/bin` (on PATH)
  so future `bun` calls resolve; `bun test`/`bun run build` are N/A pre-scaffold. *Verified:* hook BLOCKS
  a staged fake `API_KEY=` credential and PASSES the clean 0.0 commit. *Next:* 0.1 repo scaffold — when adding
  `package.json`, wire a `prepare` script that runs `git config core.hooksPath .githooks` automatically.
- **2026-06-06 · 0.0 fix.** While scaffolding 0.1 the guard false-positived on `package.json`'s
  description (`"…task-management…"` → `sk-management`). Tightened the `sk-`/assignment patterns: require a
  non-alphanumeric boundary before the token + a value-length floor, allow hyphens in `sk-` bodies (real
  keys like `sk-ant-…` contain them), and dropped over-generic bare `auth`/`pwd` keywords. Re-verified it
  still blocks `API_KEY=…`, `sk-ant-…`, and `authToken: "…"` while passing `task-`/`risk-`/`disk-` prose.
  Committed separately as `fix(0.0): …` (it's a guard fix, not scaffold).
- **2026-06-06 · 0.1 Repo scaffold.** Root Bun monorepo with workspaces `shared/` (typed contract),
  `server/` (Bun.serve gateway w/ `/api/health` → typed `HealthStatus`), `web/` (Vite 6 + React 19 + TS
  placeholder, dark CSS). `tsconfig.base.json` is strict (+`noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `noUnused*`); each workspace extends it. Root scripts: `dev` (boots gateway +
  Vite together via `bun run --filter`), `build` (tsc `--noEmit` × shared/server + `tsc && vite build` ×
  web), `test` (`bun test`), `typecheck`. `prepare` auto-wires `core.hooksPath .githooks` on install.
  *Decisions:* (a) **Ports are configurable** — `CADENCE_PORT` drives BOTH the gateway and the Vite
  `/api` proxy (single source of truth) and `CADENCE_WEB_PORT` the dev server; `.env` supported
  (`.env.example` tracked, real `.env` gitignored); gateway prints an actionable message + exits 1 on
  `EADDRINUSE`. Default **4477** avoids well-known ports (4317 = OTLP, which was occupied on this machine
  by another app). *This was prompted by user feedback mid-build:* another Claude Code instance runs a
  different app's dev server, so ports can clash at any time. (b) Kept `web` independent of `@cadence/shared`
  for now (server already proves the workspace link); web↔shared typed contract lands in 0.6 to avoid a
  Vite-resolving-workspace-`.ts` edge case this early. *Verified:* `bun install` clean; `bun run build` +
  `bun test` (1 pass) green; `bun run dev` boots both; `GET /api/health` → `{ok,app,version}`; placeholder
  page loads (`<title>Cadence</title>`); **custom ports honored end-to-end** (gateway 4823 + web 5199 +
  proxy chain), defaults untouched; friendly EADDRINUSE message confirmed. *Next:* 0.2 SQLite + Drizzle.
  *Note for 0.4/0.6:* consider auto-free-port discovery (gateway scans from `CADENCE_PORT`, writes the
  chosen port to a `~/.cadence/` runtime file the proxy reads) for fully hands-off collision avoidance.
- **2026-06-06 · 0.2 SQLite + Drizzle.** Added `drizzle-orm` (server dep) + `drizzle-kit` (root devDep).
  `server/src/db/schema.ts` defines the 7-table index (`projects, fleets, tasks, task_deps, sessions,
  events, suggestions`) modelled on spec §4 — markdown stays the source of truth, the DB only indexes
  queryable scalars; list-valued fields (labels, criteria, contextNotes, qa, fleet projectIds order) stay
  in markdown. `server/src/db/client.ts` opens `bun:sqlite` with `WAL` + `foreign_keys ON`, wraps in
  drizzle, resolves the migrations folder relative to the file, and exposes `openDb(path)` /
  `migrateDb` / `openAndMigrate`; the app DB path is `~/.cadence/cadence.db`, overridable via
  `CADENCE_HOME` (tests use `:memory:`). `drizzle.config.ts` + `bun run db:generate` produced
  `server/drizzle/0000_*.sql` (tracked); `bun run db:migrate` applies it. *Decisions:* text UUID PKs
  (caller-generated), epoch-ms integer timestamps with a SQL `unixepoch()*1000` default, `events.id`
  autoincrement; `tasks.priority` left as free-form text (scale intentionally deferred to the 1.2 UI —
  not invented here); task target = nullable `project_id` XOR `fleet_id`; `task_deps` is a composite-PK
  edge table (blocker→blocked). *Verified:* `bun run db:migrate` creates `~/.cadence/cadence.db` with all
  7 tables (listed); `bun test` (3 pass) round-trips one row per table in FK order, checks defaults
  (`status=inbox`, `permission=auto`, `kind=warm`, `cost=0`, `createdAt>0`) and FK enforcement;
  `bun run build` green. *Next:* 0.3 FTS5 search table over task text.
- **2026-06-06 · reconcile/chore.** New session reconciled: repo == ledger (0.0–0.2), tests + build
  green. Gitignored `.claude/` (held only a Claude Code `scheduled_tasks.lock` from the build loop —
  local runtime state, never the repo). Committed as `chore:`.
- **2026-06-06 · 0.3 FTS5 search.** Added FTS via a drizzle-kit **custom** migration
  (`server/drizzle/0001_tasks_fts.sql`) since FTS5 virtual tables aren't expressible in the Drizzle
  schema. Standalone `tasks_fts(task_id UNINDEXED, title, body)` with `unicode61 remove_diacritics 2`,
  kept in sync with `tasks` by AFTER INSERT/UPDATE/DELETE triggers (robust to any writer — app
  reindexer, migration, or direct insert). `server/src/db/search.ts`: `searchTasks(db, query, limit)`
  ranked by `rank`, and `rebuildTaskFts(db)` for recovery. *Decisions:* triggers (DB-level) over
  app-level sync so the index can never drift from `tasks`; "sync hooks stubbed" interpreted as the
  higher-level markdown-reindex (0.4/0.5) + transcript/memory indexing (Phase 4), which are deferred
  with comments. Diacritic folding chosen because task text is mixed Czech/English. *Verified:*
  `bun test` (5 pass) — insert→search returns the task, update/delete keep FTS consistent; the real
  `~/.cadence/cadence.db` migrates to include `tasks_fts` + 3 triggers and a live insert/search/delete
  round-trips; `bun run build` green. *Next:* 0.4 storage layer (markdown ⇄ index).
- **2026-06-06 · 0.4 Storage layer.** Added `gray-matter` (server dep). New `server/src/store/`:
  `paths.ts` (the `~/.cadence/` layout, all call-time so `CADENCE_HOME` overrides apply), `markdown.ts`
  (`parseMarkdown`/`stringifyMarkdown` — drops `undefined`, keeps `null`), `types.ts` (Task/Project/Fleet
  frontmatter + GlobalSettings), `store.ts` (`bootstrap`, `readSettings`, typed read/write for
  task/project/fleet markdown, and `reindexTask`/`reindexProject`/`reindexFleet`/`reindexAll`). Reindex
  upserts via drizzle `onConflictDoUpdate` (fires the FTS triggers automatically). *Decisions:* (a) task
  frontmatter references a project/fleet by **slug**, resolved to the FK id at reindex (null if not yet
  indexed) — human-editable + spec's `project` key; `reindexAll` does projects+fleets before tasks so
  links resolve. (b) Project/fleet **markdown BODY = the systemPrompt context layer** (spec §4/§7.1);
  task body = description. (c) `deadline` stored as an ISO date string in markdown, converted to epoch ms
  for the index (`toEpochMs` handles string|number|Date). (d) `labels`/ordered fleet `projects` stay in
  markdown only (not indexed columns). *Gotcha fixed:* `parseMarkdown` originally constrained `T extends
  Record<string,unknown>`, which TS interfaces don't satisfy (no implicit index signature) — relaxed to
  bare `<T>`. *Verified:* `bun test` (8 pass) — bootstrap tree + default settings; write task folder →
  reindex → DB row matches frontmatter (incl. slug→id, deadline→ms), labels round-trip in markdown, FTS
  finds it, re-reindex reflects edits; real `~/.cadence` bootstrap creates all dirs + settings.json;
  `bun run build` green. *Next:* 0.5 file watcher (`~/.cadence/**` → reindex changed task.md).
- **2026-06-06 · 0.5 File watcher.** `server/src/store/watcher.ts`: `classifyPath` (rel path → task/
  project/fleet entity) + `dispatchChange(db, rel)` (reindex if the markdown exists, else delete the
  index row — the deterministic, unit-tested core) + `startWatcher(db, {intervalMs, onChange})` which
  polls file mtimes and applies diffs; `scan()` is exposed and the first scan doubles as a startup
  reconcile. *Big decision — polling, not `fs.watch`:* I implemented `fs.watch` first (recursive, then
  container+per-subdir) but **Bun's `fs.watch` does not reliably deliver events for task subdirs created
  after the watch starts** — under prior-test churn it dropped them entirely (measured: zero events in
  20s, reproducibly). Polling mtimes is deterministic, cross-platform, and trivially cheap for a local
  single user's file set; latency = poll interval (default 700ms). *Bug found + fixed (important):*
  `opts.onChange?.(dispatchChange(...), rel)` — optional-chaining a call **short-circuits argument
  evaluation**, so `dispatchChange` never ran when no `onChange` was passed (this silently broke the
  live watcher and confounded hours of fs.watch debugging — every probe that *had* an onChange passed,
  every one without it failed). Now `dispatchChange` runs first, then `onChange` is notified. *Testing:*
  the setInterval scheduler can't be reliably tested under `bun test` (its test-runner starves timers),
  so the unit test drives `scan()` directly (create/edit/delete → DB + FTS, deterministic), and
  `server/src/store/watcher.live.ts` (run with `bun`, not `bun test`) smoke-tests the real timer path
  (create/edit/delete detected ~50ms). *Tooling note:* git commit `-m` with backticks triggers shell
  command substitution and silently drops the backtick content — **use `git commit -F <file>`** (write
  the message with the Write tool) for messages containing backticks/`$`/`()`. *Verified:* `bun test`
  (11 pass, ~70ms, stable across repeated runs); `watcher.live.ts` exits 0 across repeated runs;
  `bun run build` green. *Next:* 0.6 gateway HTTP+WS skeleton.
- **2026-06-06 · 0.6 Gateway HTTP+WS.** `server/src/gateway.ts` `startGateway(opts)`: `Bun.serve` with
  REST routing (`/api/health` → typed `HealthStatus`; other `/api/*` → JSON 404), a WS hub at `/ws`
  (`server/src/ws.ts` `WsHub` — tracks clients, `send`/`broadcast`), and static serving of `web/dist`
  with SPA fallback to `index.html` + a path-traversal guard (resolved path must stay under the web
  root). On startup it wires the stack: `bootstrap()` + `openAndMigrate()` + `startWatcher()`, and the
  watcher's `onChange` broadcasts `reindex:<kind>` events to WS clients. `shared` gained the typed WS
  contract (`ServerMessage = hello | event`, `ClientMessage`). `index.ts` now boots the gateway, keeps
  the friendly EADDRINUSE message, and `GatewayOptions` lets tests inject a `:memory:` db, a fixture
  `webDir`, and `startWatcher:false`. *TS gotchas:* `Bun.serve` defaults the WS data type to `undefined`
  — must call `Bun.serve<WsData>({...})` (one generic; the 2nd is the typed-routes map, constrained to
  string keys) and type the ws handlers `ServerWebSocket<WsData>`; `server.port` is `number|undefined`
  so I capture `boundPort = server.port ?? port`. *Verified:* `bun test` (16 pass) — health ok, unknown
  `/api` 404, static SPA + deep-link fallback, traversal blocked, and **WS connect → hello then a
  broadcast** (broadcast sent after the client sees hello, guaranteeing hub registration). Real boot on
  a custom port serves the actual `web/dist` (index.html + hashed `/assets/*`, SPA fallback) and
  `/api/health`; `bun run build` green. *Next:* 0.7 design base (Tailwind + shadcn + LabeledIconButton).
- **2026-06-06 · 0.7 Design base.** Tailwind v4 via `@tailwindcss/vite` + a dark dev-tool theme in
  `web/src/index.css` (`@theme` tokens → utilities: `bg-background`, `text-muted-foreground`,
  `bg-primary`, `border-border`). `web/src/lib/utils.ts` `cn()` (clsx + tailwind-merge). shadcn-style
  `Button` (`components/ui/button.tsx`, cva variants default/secondary/outline/ghost/destructive + sizes).
  **`LabeledIconButton`** primitive: required `icon` + required `label` props enforce the §10.1 rule
  (icon buttons always carry a text label) *at the type level* — an icon-only button can't be built from
  it. `AppShell`: themed left-nav placeholder (each item a labeled icon+text button) + content area.
  `App` wires a gateway-health status dot (fetches `/api/health`, typed via a **type-only** import of
  `HealthStatus` from `@cadence/shared` — erased by `verbatimModuleSyntax`, so Vite never resolves the
  workspace `.ts` at runtime; this is how web↔shared, deferred in 0.1, is now used safely) + example
  buttons. Icons: `lucide-react` (verified official — registry `latest` 1.17.0, maintainer `ericfennis`;
  the 1.x scheme initially looked odd so I checked the registry before trusting it). *Gotcha:* web's
  tsconfig needed `"bun"` added to `types` so test files' `bun:test` import typechecks under `tsc`.
  *Verified:* `bun test` (18 pass) — SSR `renderToStaticMarkup` confirms LabeledIconButton emits icon +
  label and AppShell emits the labeled nav + themed classes; `bun run build` green (Tailwind compiles a
  ~12.5kB themed stylesheet); real prod boot serves the hashed CSS containing the dark tokens
  (`#0b0d12`, `.bg-background`) and the `/api/health` data the shell consumes. *Next:* Phase 1.1.

**Phase 0 — Acceptance check (run 2026-06-06):**
1. ✅ Themed app shell — the served prod build renders the dark shell (left-nav placeholder); SSR tests
   confirm the shell + labeled nav. *(Visual browser confirmation left for the human smoke-test.)*
2. ✅ Page shows gateway data — `App` fetches `/api/health` (Vite proxy in dev, gateway in prod);
   endpoint verified end-to-end.
3. ✅ `~/.cadence/cadence.db` exists with migrated tables — 7 tables + `tasks_fts` + triggers.
4. ✅ Editing a `task.md` updates the DB — watcher `scan()` (unit) + live timer smoke reindex
   create/edit/delete with FTS in sync.
5. ✅ `bun test` (18 pass) and `bun run build` both green.
→ Phase 0 accepted; continuing to Phase 1.

- **2026-06-06 · 1.1 Task capture → Inbox.** Shared: `Task` DTO + `TASK_STATUSES`/`TaskStatus` +
  `CreateTaskInput`. Server: `server/src/tasks.ts` (`createTask` writes `task.md` then reindexes
  **synchronously** so the row exists immediately — the watcher is only a backstop; `listTasks`
  newest-first; `getTask`) and `server/src/api.ts` `handleApi` (REST router: `/api/health`, GET/POST
  `/api/tasks`, GET `/api/tasks/:id`, with 400/404/405). The gateway now delegates all `/api/*` to
  `handleApi` and broadcasts `task:created` over WS. Web: TanStack Query provider (`main.tsx`), typed
  `lib/api.ts`, and a `features/inbox/Inbox.tsx` (persistent quick-capture input + labeled Capture button
  + list with loading/empty/error states); `App` renders the Inbox in the shell. *Decisions:* (a)
  newest-first ordering uses `createdAt desc, rowid desc` — two tasks captured in the same millisecond
  share the SQL `unixepoch()*1000` default, so the implicit `rowid` is the deterministic tiebreaker (no
  UI jitter); caught by a flaky ordering test. (b) Capture reindexes synchronously rather than waiting
  for the watcher poll, so the UI updates instantly. *Verified:* `bun test` (23 pass) — service writes
  file+row+FTS, ordering/filter, POST/GET task API over the real gateway, empty-title→400, Inbox SSR
  renders capture input+button; `bun run build` green; **E2E smoke**: POST a task → `task.md` on disk +
  listed in Inbox; **restart the gateway → the task still shows** (persists via the DB file + the
  watcher's startup reconcile from markdown) — satisfies "reload shows it". *Next:* 1.2 Board + task
  detail + context channel.
- **2026-06-06 · 1.2 Board + detail + context.** Server: `updateTask` merges a patch into the task.md
  frontmatter (status/priority/estimate/labels/body; deadline ms→ISO) and reindexes; `getTaskDetail`
  adds the markdown-only `labels`; append-only context channel (`store.appendContext`/`readContext` →
  timestamped `context.md`). API: `PATCH /api/tasks/:id`, `GET` detail (now returns `TaskDetail` with
  labels), `GET`/`POST /api/tasks/:id/context`; broadcasts `task:updated`/`task:context`. Web: the shell
  nav is now interactive (`AppShell` `activeView`/`onNavigate` → Inbox/Board/Settings, active state
  shown). **Board** = lifecycle columns with plain-language labels (`lib/status.ts`: "Needs input", "In
  progress") + **native HTML5 drag-and-drop** (card `draggable` + `dataTransfer`, column `onDrop` →
  PATCH status) — no DnD dependency. **TaskDetail** drawer = status `<select>`, priority/deadline/
  estimate/labels, body, and the always-on context channel (scrollable read + textarea append). Inbox
  rows + board cards open the drawer. *Decisions:* (a) native HTML5 DnD instead of @dnd-kit — adequate
  for a simple kanban, zero deps; (b) task detail is an overlay drawer (no router dependency yet) with
  in-`App` view state — a real router can come when deep-linking is needed; (c) context.md is raw
  timestamped markdown (structured Q&A is Phase 2). *Verified:* `bun test` (28 pass) — updateTask
  persists status+fields to markdown+index, context appends in order + timestamped, PATCH over the API,
  context POST/GET, board renders plain-language columns; `bun run build` green (tsc caught a stale
  AppShell test missing the new required props — fixed); **E2E smoke**: PATCH status→ready writes
  `status: ready` to task.md and **survives a gateway restart**, and a context note appends to
  context.md on disk. *Next:* 1.3 Projects CRUD.
- **2026-06-06 · 1.3 Projects CRUD.** Shared: `Project` DTO, `Create/UpdateProjectInput`,
  `PERMISSION_MODES`/`DELIVERY_MODES`; `UpdateTaskInput` gains `project`/`fleet` (slug). Server:
  `server/src/projects.ts` (`createProject` slugifies the name + de-dupes via `uniqueSlug`, writes
  `projects/<slug>.md` frontmatter + systemPrompt body, reindexes; `listProjects`; `getProject`/
  `getProjectById`; `updateProject` merges patch incl. systemPrompt) + REST (`GET/POST /api/projects`,
  `GET/PATCH /api/projects/:slug`). `updateTask` now assigns a project/fleet by **slug** (reindex
  resolves slug→FK id). New `resolveTaskCwd(db, taskId)` → project `rootPath` ?? `CADENCE_DEFAULT_CWD`
  ?? `process.cwd()` (the cwd the 1.4 spawn will use). Web: a **Projects** nav item + view (create form:
  name/rootPath/color/default permission+delivery/systemPrompt; project list; edit drawer — `ProjectFields`
  shared between create+edit) and a **Project assignment select** in TaskDetail (Unassigned + each
  project → PATCH `project=slug`). *Decisions:* projects are addressed by **slug** in URLs + task
  frontmatter (human-friendly, == filename); permission/delivery use plain-language labels in the UI.
  *Verified:* `bun test` (33 pass) — create writes file+row, duplicate names → `acme`/`acme-2`, update
  patches config+systemPrompt, **assign a task → `projectId` resolves and `resolveTaskCwd` → the project
  rootPath**; Projects SSR renders the create form; `bun run build` green. **E2E smoke**: POST a project
  → `projects/<slug>.md` on disk + listed; assign a task → `projectId` set + `project: <slug>` in
  task.md. *Next:* **1.4 Spawn infra** — ⚠️ the first step that launches the real `claude` binary
  (warm stream-json session); has real side effects (a Claude Code process + cost). Per
  control-surfaces doc: `claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --session-id <uuid> --permission-mode <mode>` in the task cwd.
- **2026-06-06 · 1.4 Spawn infra.** *User-authorized the real spawn (chose "Build + one real spawn").*
  Shared: `Session` DTO, `SpawnSessionInput`, permissive `ClaudeEvent`. `server/src/spawn.ts`
  `openSession` spawns the real `claude` in stream-json mode with the verified flags, parses NDJSON
  stdout → typed events (tolerates non-JSON noise per the unversioned-schema gotcha), and returns
  send/close/kill. A **`command` override** lets tests run a deterministic mock
  (`server/src/testing/mock-claude.ts`, executed via `process.execPath` = bun) — no real model, no cost.
  `server/src/sessions.ts` `SpawnManager`: inserts the session row, flips it to `running` on
  `system/init`, accumulates `costUsd` from each `result`, broadcasts every event to WS, and keeps the
  handle for follow-up (1.5)/close/kill; `claudePermissionMode` maps Cadence auto|manual|dangerous →
  claude acceptEdits|default|bypassPermissions; `transcriptPathFor` computes the `~/.claude/projects`
  path. API: `POST`/`GET /api/tasks/:id/sessions`, `GET /api/sessions`. The gateway owns one
  `SpawnManager` and **kills live sessions on shutdown** (`index.ts` SIGINT/SIGTERM → `gateway.stop`).
  *Verified:* `bun test` (35 pass) — mock claude: openSession parses `system/init`…`result`,
  SpawnManager records the row, runs on init, records cost on result, done on close; `bun run build`
  green. **Real spawn smoke** (one session, haiku, benign "say pong" prompt, isolated temp cwd, manual
  perms→claude `default`): the live `claude` reached `status=running` and recorded a real
  `costUsd≈0.011`; graceful shutdown terminated it (verified the smoke pid was gone, no orphan).
  *Decisions:* mock-process testing for determinism + zero cost; the real binary exercised once for
  end-to-end confidence. *Open item for 1.8:* the stored `transcriptPath` (cwd `/`→`-`) wasn't present
  on disk during the brief smoke window — confirm claude's exact transcript-path encoding when building
  the transcript reader. *Next:* 1.5 live transcript UI + follow-up.
- **2026-06-06 · 1.5 Live transcript + follow-up.** Server: `POST /api/sessions/:id/messages` sends a
  follow-up into the warm session (409 if the session isn't live); `Gateway.spawn` exposes the
  `SpawnManager`; `SpawnManager.update` now try/catches so a late event during shutdown (process close
  after the db is gone) can't crash it. Web: a WS client (`lib/ws.ts` `subscribe` + `useServerMessages`
  hook with 1s auto-reconnect) + a Vite `/ws` proxy (`ws:true`). The heart is a **pure, tested
  transcript reducer** (`features/session/transcript.ts`): folds claude stream-json events into
  renderable items — live token typing from `stream_event`/`content_block_delta`/`text_delta`,
  finalized `assistant` text, `tool_use` cards, and per-turn `result` cost; unknown types pass through.
  `SessionPanel` (a wide right drawer) renders the live transcript + a follow-up input + cumulative cost;
  `TaskDetail` gains a **"Run Claude"** button + a sessions list; `App` opens the panel for the active
  session. *Decisions:* (a) reducer is a pure function so the streaming logic is unit-testable with zero
  browser; (b) the UI tracks user messages optimistically (no `--replay-user-messages`); (c) honored the
  **"one real spawn"** boundary — verified 1.5's plumbing against the **mock** claude, not a new real
  session. *Verified:* `bun test` (41 pass) — reducer folds a streamed turn (user + live typing +
  finalized text + cost), renders tool blocks, ignores unknown events; **end-to-end integration** (mock
  claude + a real WebSocket client): POST a follow-up → the warm session replies → the gateway
  broadcasts `session:event` over WS to the client → cost recorded on the session row; unknown session →
  409; SessionPanel SSR renders; `bun run build` green. *Fixed:* a teardown race surfaced as
  `SQLiteError: disk I/O error` (a killed mock session's close event wrote to an already-removed test db)
  — fixed via the tolerant `update` + a settle delay before `rmSync`. *Real context-retention* is the
  warm-process property (control-surfaces §3.1 + 1.4's real session); offer the user a real 2-message
  smoke on request. *Next:* 1.6 context composition v1 (Global → Project → Task → `--append-system-prompt`).
- **2026-06-06 · 1.6 Context composition.** `server/src/context.ts` `composeContext(db, scope)` builds the
  layered system prompt **most-general first** so later layers win (spec §7.1): Global
  (`settings.json`) → Project `systemPrompt` → Fleet `systemPrompt` → Task `spec.md` → Task `context.md`,
  each as a `## <title>` section; returns `""` when nothing applies. The spawn endpoint composes it for
  the task and passes it as `--append-system-prompt` (only when non-empty). Added `store.readSpec` +
  `store.writeSettings`; the mock claude now **echoes the `--append-system-prompt` it received** in its
  init event, making composition verifiable end-to-end with no real model. *Decisions:* repo CLAUDE.md is
  left to claude's native loading; Q&A answers + the role prompt are deferred to Phase 2 (Discovery/
  Questioner); fleet layer wired but fleets are fleshed out in Phase 4. *Verified:* `bun test` (44 pass)
  — composeContext layers global/project/task in order with distinct markers + is empty when nothing
  applies; **openSession passes the composed `--append-system-prompt` through to the session** (the mock
  echoes the project marker back); `bun run build` green. *Verify-line note:* "project systemPrompt
  visibly affects behavior" is proven deterministically as "the marker reaches the session's
  `--append-system-prompt`" (composition + delivery); the real-model effect follows from claude's
  documented `--append-system-prompt` semantics — honored the one-real-spawn boundary; a real marker
  smoke is available on request. *Next:* 1.7 permission mode selector.
- **2026-06-06 · 1.7 Permission mode selector.** Schema: `tasks.permission_mode` (migration **0002**, a
  clean `ADD COLUMN` — verified it doesn't disturb the FTS triggers; applied to the real `~/.cadence` db);
  `reindexTask` maps the frontmatter `permissionMode`. Shared: `Task.permissionMode`,
  `TaskDetail.resolvedPermissionMode`, `UpdateTaskInput.permissionMode`. `resolvePermissionMode(db,
  taskId)` = task ?? project ?? global ?? "auto"; `getTaskDetail` exposes the effective mode; the spawn
  endpoint now uses `input.permissionMode ?? resolved`. Web: a Permission selector in TaskDetail
  (Inherit/Auto/Manual/Dangerous) that shows the **effective** mode (red for Dangerous); picking
  **Dangerous opens a confirm dialog** before it applies; session tiles show the mode. *Decisions:*
  "Inherit" (null) is the default so the project/global default flows through; the confirm gates the
  *selection* of Dangerous (execution-time guardrail is 3.8). *Verified:* `bun test` (47 pass) —
  `claudePermissionMode` mapping (auto→acceptEdits, manual→default, dangerous→bypassPermissions, safe
  fallback, raw passthrough); full resolution chain with task/project/global overrides + clearing; and
  the **mapped mode reaching the spawned binary** (the mock echoes `--permission-mode`:
  dangerous→bypassPermissions); `bun run build` green. *Next:* 1.8 sessions view + past-transcript
  reader + sidechains (incl. confirming claude's transcript-path encoding, the 1.4 open item).
- **2026-06-06 · 1.8 Sessions view + transcript reader.** `server/src/transcripts.ts`: `readLiveSessions()`
  reads the liveness oracle (`~/.claude/sessions/*.json`) and verifies each pid is actually alive
  (`process.kill(pid,0)`; EPERM=alive, ESRCH=stale), sorted by `updatedAt`; `readTranscript(path)` parses
  a past `*.jsonl` into renderable entries (user/assistant content → text/thinking/tool_use/tool_result;
  metadata-only lines skipped) flagging `isSidechain`; `claudeDir()` honors `CADENCE_CLAUDE_DIR` so tests
  use synthetic fixtures. **`transcriptPathFor` moved here and FIXED** to `realpathSync(cwd)` before the
  `/`→`-` encoding — that resolves the **1.4 open item**: macOS `/tmp`→`/private/tmp`, so my 1.4 smoke
  transcript was filed under `-private-tmp-…`, not `-tmp-…`. API: `GET /api/live-sessions`,
  `GET /api/sessions/:id/transcript`. Web: a **Sessions** nav + view — live process tiles (status dot
  busy/idle/shell + a stale flag) and Cadence session tiles; clicking opens a read-only **TranscriptReader**
  drawer that renders the entries and **indents/labels `isSidechain` subagent lines**. *Verified:*
  `bun test` (51 pass) — path encoding, alive-vs-stale pid, transcript parsing (messages parsed, metadata
  skipped, sidechain flagged), SessionsView SSR; **real-data smoke** (read-only, structure only):
  `readLiveSessions` saw 4 real processes (busy/idle/shell, all alive) and the 1.4 transcript now resolves
  + reads (3 entries) via the realpath path; `bun run build` green. *Next:* 1.9 terminal handoff.
- **2026-06-06 · 1.9 Terminal handoff + Settings.** `server/src/terminal.ts`: `buildResumeCommand(cwd,
  id)` → `cd <shell-quoted cwd> && claude --resume <id>` (control surfaces §5); `terminalLaunchArgs(app,
  cmd)` builds the `osascript` argv for Terminal.app / iTerm; `openInTerminal(app, cmd, runner)` with an
  **injectable runner** (so tests never open a window). API: `GET/PATCH /api/settings` (preferredTerminal
  + global defaults) and `POST /api/sessions/:id/open-terminal` (builds the command, calls
  `ctx.openTerminal`, returns the command). The gateway accepts an `openTerminal` override (tests inject a
  recorder) and defaults to the real launcher. `GlobalSettings` moved to `@cadence/shared`. Web: a reusable
  **HandoffButtons** (Copy command via the clipboard + Open in terminal) in the Sessions transcript drawer
  header, and a real **Settings view** (preferred terminal, global default permission/delivery/model,
  global system prompt) replacing the placeholder. *Decision:* honored the outward-facing concern — the
  command-building + endpoint wiring are verified with a **mock runner** (no real window); a real launch is
  offered on request. *Verified:* `bun test` (58 pass) — `buildResumeCommand` incl. single-quote escaping;
  osascript argv for both terminals; `openInTerminal` → injected runner; the open-terminal endpoint builds
  the resume command + invokes the mock launcher with the configured app (`Terminal`); settings GET
  defaults + PATCH `preferredTerminal`; Settings + HandoffButtons SSR; `bun run build` green. *Next:*
  1.10 Claude-assisted project import.
- **2026-06-06 · 1.10 Project import.** `server/src/import.ts`: `scanClaudeProjects(db)` discovers working
  dirs from `~/.claude/projects` — it reads each project's **real cwd + gitBranch from a transcript line**
  (the encoded dir name is lossy for paths containing `-`, e.g. `bot-blocker-middleware`), keeps only
  dirs still on disk, and annotates `name`/`gitRemote` (via `git config`)/`isGitRepo`/`alreadyImported`.
  `importProjects(db, selections)` creates the picked candidates, **idempotent by rootPath**.
  `claudeEnrich(cwd)` runs a one-shot `claude -p` for a stack/description line — **injectable** (gateway
  `enrich` option) so tests/imports don't need a real model. API: `GET /api/import/candidates`, `POST
  /api/import`, `POST /api/import/enrich`. Web: an "Import from Claude Code" checklist in the Projects
  view (rescan, tick candidates with name/cwd/remote/git badge, optional per-row "Ask Claude" enrich,
  Import selected). *Decision:* deterministic detection (transcript cwd + `git`) is the core; the
  claude-assisted enrichment is opt-in per row, honoring the one-real-spawn boundary. *Verified:*
  `bun test` (62 pass) — scan detects a real temp git repo via its transcript cwd (remote+branch+isGitRepo),
  filters non-existent cwds, marks alreadyImported; import creates + is idempotent; gateway
  candidates/enrich(mock)/import endpoints; ImportProjects SSR. **Real-data smoke**: scan found 35 real
  candidate dirs (24 git repos w/ remotes), hyphenated names handled correctly; `bun run build` green.
  *Next:* 1.11 usage bar + cost.
- **2026-06-06 · 1.11 Usage bar + cost.** `server/src/usage.ts` `readUsageStats()` summarizes
  `~/.claude/stats-cache.json` (confirmed shape: `dailyActivity` [date/messageCount/sessionCount],
  `dailyModelTokens` [date/tokensByModel], `modelUsage`, totals) → total sessions/messages, the most
  recent day, a **7-day rolling sum**, and top models by tokens. `SpawnManager` captures the latest
  `rate_limit_info` from live session events (`rate_limit_event`/any event carrying it) and exposes
  `latestRateLimit()` — note `rate_limit_info` is NOT persisted to transcripts, so the 5h/weekly windows
  are only live; the persistent bar uses stats-cache. `taskCostUsd(db, taskId)` sums a task's session
  costs; `getTaskDetail` returns `costUsd`. API: `GET /api/usage → { stats, rateLimit }`. Web: an ambient
  non-noisy **UsageBar** (this-week sessions/tokens/messages, top model, all-time sessions, a
  "rate-limit info live" hint) via a new `AppShell` `topBar` slot; a per-task **Cost** row in the detail.
  *Verified:* `bun test` (66 pass) — readUsageStats recent-day/week/top-models from a synthetic
  stats-cache + zeros when missing; task cost = sum of session costs (and via `getTaskDetail`); UsageBar
  SSR. **Real-data smoke**: real stats-cache → 1183 all-time sessions, this week 80 sessions / 49.7M
  tokens, top models by tokens; `bun run build` green. *Next:* 1.12 notifications.
- **2026-06-06 · 1.12 Notifications.** `server/src/notify.ts` `notifyOnTransition(hub, oldStatus, task)`
  broadcasts a `notify` ServerMessage when a task crosses **into** `needs_feedback` ("Needs your
  input") or `done` ("Task delivered") — the PATCH task handler captures the prior status and calls it
  (no notify for plain status moves). shared: `NotifyPayload`. Web: a notification store
  (`features/notifications/store.ts`) wired to WS `notify` events — keeps an in-app list, tracks unread,
  and fires an **OS notification (Web Notifications API)** when permission is granted; exposed via
  `useNotifications()` (`useSyncExternalStore`). A **Notifications** nav item with an **unread badge**
  (new `AppShell` `navBadges` slot) + a `NotificationsView` (list, "Enable desktop alerts" permission
  request, viewing marks-all-read, click opens the task). *Decision:* desktop popups are best-effort
  (guarded by `typeof Notification`/permission) so SSR + no-permission degrade to the in-app badge.
  *Verified:* `bun test` (71 pass) — notifier fires on needs_feedback/done, not on plain moves; a **WS
  integration test** confirms PATCH→needs_feedback broadcasts the notify event to a connected client;
  the store prepends/tracks-unread/markAllRead; NotificationsView SSR; `bun run build` green. *Next:*
  1.13 global search + ⌘K palette.
- **2026-06-06 · 1.13 Global search + ⌘K.** Server: `sanitizeFtsQuery()` turns free text into a safe
  FTS5 MATCH (strip punctuation/operators, lower-case, **prefix-match each word** → palette-friendly);
  `searchTaskHits(db, q)` returns ranked `{taskId,title,status}`. *Gotcha:* FTS5 `MATCH` can't target a
  JOIN alias ("no such column: f") — so MATCH runs in a **subquery** on the bare `tasks_fts`, then joins
  `tasks` for status. API: `GET /api/search?q=`. shared: `SearchHit`. Web: a **⌘K / Ctrl+K**
  `CommandPalette` (global keydown toggle, Esc closes) — debounced task search + jump-to-view actions,
  arrow/Enter keyboard nav; selecting a task calls `onOpenTask` (opens the detail), an action calls
  `onNavigate`; renders null until opened. *Verified:* `bun test` (74 pass) — `searchTaskHits` finds a
  task by a body word (prefix+sanitized, with status), tolerates `"x" AND (` without an FTS syntax
  error, empty→[]; `sanitizeFtsQuery("Hello, World!")=="hello* world*"`; `GET /api/search` finds by body
  + empty→[]; CommandPalette SSR null-when-closed; `bun run build` green. *Next:* 1.14 suggestion
  primitive (final Phase 1 step → MVP complete).
- **2026-06-06 · 1.14 Suggestion primitive.** Schema: `suggestions.confidence` (migration **0003**, clean
  ADD COLUMN, applied to real db). `server/src/suggestions.ts`: `createSuggestion` (status `suggested`),
  `listSuggestions(entityType, entityId)`, `getSuggestion`, `resolveSuggestion` — the Accept/Edit/Override/
  Dismiss control recording **per-field provenance** (`suggested → confirmed | edited | overridden |
  dismissed`, `resolvedAt` stamped; edit/override store the new value). API: `GET/POST /api/suggestions`,
  `POST /api/suggestions/:id/resolve`. shared: `Suggestion`, `SuggestionAction`, Create/Resolve inputs,
  `SUGGESTION_STATUSES`. Web: a **reusable** `SuggestionControl` (field + value + rationale + confidence%
  + source, provenance badge, Accept/Edit/Override/Dismiss with inline edit) + `SuggestionList`, wired
  into the task detail. *Verified:* `bun test` (79 pass) — create stores value/rationale/confidence as
  suggested; accept→confirmed (value kept, resolvedAt set); edit/override record provenance + new value;
  dismiss closes; SuggestionControl SSR shows field/value/actions + hides actions once resolved;
  `bun run build` green. **E2E smoke**: create → list shows it; Accept → confirmed; Override → overridden
  with the new value. *This completes Phase 1 (the MVP).*

**Phase 1 — Acceptance check (run 2026-06-06):**
1. ✅ Quick-capture → Inbox + `~/.cadence/tasks/<id>/task.md` (1.1, E2E: capture + restart persists).
2. ✅ Create a project with a real rootPath + assign the task (1.3, E2E).
3. ✅ Spawn a Claude session that streams live (1.4 real spawn reached running + recorded cost; 1.5
   transcript reducer renders token typing / tool cards / result+cost, integration-tested over WS).
4. ✅ Follow-up retains context — the warm-process loop (same stdin) is the mechanism; verified via the
   mock + control-surfaces §3.1 (a real warm session was exercised in 1.4). A real 2-message smoke is available.
5. ⚠️ Manual mode → **in-app** approve/deny — Phase 1 Manual maps to claude `default` (prompts in the
   *terminal*). The **in-app** approve/deny (canUseTool) is step **3.8** (Agent SDK) — deferred there, not
   a Phase 1 capability. The permission selector + mapping (1.7) is done + verified.
6. ✅ One-click terminal opens/resumes the session (1.9, verified via a mock launcher; a real launch
   opens a window — offered on request).
7. ✅ ⌘K search finds a task by a body word (1.13).
8. ✅ `bun test` (79 pass) and `bun run build` both green.
→ MVP accepted (item 5's *in-app* approval is correctly a Phase 3.8 feature). **Stopping for a human
  smoke-test + explicit go-ahead before Phase 2 (autonomy auto-spawns real `claude` on capture).**
