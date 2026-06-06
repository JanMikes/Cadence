# Cadence — Build Plan & Progress Ledger

> **This file is the SINGLE SOURCE OF TRUTH for build progress.** A fresh Claude Code session reads
> it (after `CLAUDE.md`, `docs/platform-definition.md`, `docs/backlog.md`), reconciles it against the
> actual repo, then continues building. The bootstrap prompt is in
> [`build-prompt.md`](build-prompt.md).
>
> Meta: this build loop (markdown ledger = truth · reconcile · atomic verified steps · journal) is
> literally Cadence's own execution model. Once Cadence exists it could run its own build/maintenance.

## Status snapshot  ← the building agent keeps this current
- **Current phase:** Phase 0 — Foundation
- **Last completed step:** 0.2 (SQLite + Drizzle: 7-table index schema + migrations)
- **Next step:** 0.3
- **Blockers:** none
- **Last updated:** 2026-06-06

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
- [ ] **0.3 FTS5 search table.** FTS5 virtual table over task text (transcripts later); sync hooks
  stubbed.
  - Verify: insert a task, FTS query returns it.
- [ ] **0.4 Storage layer (markdown ⇄ index).** Bootstrap `~/.cadence/` (dirs + `settings.json`).
  Helpers to read/write a task folder (`task.md` frontmatter+body, `context.md`, `qa.md`, …),
  project/fleet markdown, and reindex `task.md` → SQLite.
  - Verify: write a task folder, reindex; DB row matches frontmatter (round-trip test).
- [ ] **0.5 File watcher.** Watch `~/.cadence/**` → reindex changed `task.md` into SQLite (+FTS).
  - Verify: edit a `task.md` on disk → DB + FTS update (watcher-event test).
- [ ] **0.6 Gateway HTTP+WS skeleton.** REST router (`/api/health` + stubs), WS hub (broadcast),
  serves built `web/`. Typed API contract in `shared/`.
  - Verify: `GET /api/health` ok; WS connect receives a broadcast; prod build is served.
- [ ] **0.7 Design base.** Tailwind + shadcn/ui; dark dev theme tokens; the **LabeledIconButton**
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

- [ ] **1.1 Task model + quick-capture → Inbox.** Persistent capture input → `~/.cadence/tasks/<id>/
  task.md` + index; shows in Inbox.
  - Verify: capture a task; file + DB row exist; reload shows it.
- [ ] **1.2 Board + task detail + context channel.** Kanban by status; detail (body, priority,
  deadline, estimate, labels); always-on free-form `context.md` editor.
  - Verify: drag across columns (status persists); add a context note (appends to `context.md`).
- [ ] **1.3 Projects CRUD.** Create/list/edit projects (rootPath, color, default model/permission/
  delivery, systemPrompt) → `projects/<slug>.md` + index; assign a task to a project.
  - Verify: create a project; assign a task; cwd resolves to rootPath.
- [ ] **1.4 Spawn infra (warm session).** `openSession` (verified pattern: `claude -p --input-format
  stream-json --output-format stream-json --verbose --include-partial-messages --session-id <uuid>
  --permission-mode <mode>` in the task cwd). Parse stdout NDJSON → typed events → WS; track session
  in DB.
  - Verify: spawn on a task; receive `system/init` + `result`; DB session row + cost recorded.
- [ ] **1.5 Live transcript UI + follow-up.** Render events (token typing via `text_delta`, tool-use
  cards, `result`+cost); input sends follow-up messages to the warm process.
  - Verify: send a message → streamed reply; a 2nd retains context; cost shown.
- [ ] **1.6 Context composition v1.** Compose Global → Project → Task (spec/context/qa) into
  `--append-system-prompt` at spawn.
  - Verify: a project systemPrompt marker visibly affects behavior.
- [ ] **1.7 Permission mode selector.** Auto (default) / Manual / Dangerous per session+task
  (resolved task ?? project ?? global); mode shown on tile; Dangerous needs confirm.
  - Verify: each mode maps to the right `--permission-mode`; Dangerous prompts a confirm.
- [ ] **1.8 Sessions view + past-transcript reader + sidechains.** Live tiles from `~/.claude/
  sessions/*` (status/busy, verify pid alive); read past `projects/**/*.jsonl` (render the parentUuid
  DAG); nest `isSidechain` subagent activity.
  - Verify: a running session shows busy/idle; a past session renders; a subagent run nests.
- [ ] **1.9 Terminal handoff.** Per session: copy `cd <cwd> && claude --resume <id>` + one-click
  "Open in <terminal>" (gateway runs `open`/`osascript`); preferred terminal in Settings.
  - Verify: button opens the configured terminal at cwd running resume; copy works.
- [ ] **1.10 Claude-assisted project import.** Scan `~/.claude/projects` dirs; background `claude -p`
  enriches each (remote/stack/name/desc); checklist → create selected.
  - Verify: detects real dirs; proposes; creates the ticked ones.
- [ ] **1.11 Usage bar + cost.** Ambient subscription-window bar (5h+weekly from `rate_limit_info` +
  `stats-cache.json`); per-session/task cost.
  - Verify: bar reflects usage; cost accrues per session.
- [ ] **1.12 Notifications.** In-app badges + Web Notifications API (needs-feedback / delivered).
  - Verify: a needs-input event raises a badge + desktop notification.
- [ ] **1.13 Global search + ⌘K palette.** FTS5 over tasks; palette for jump-to + actions.
  - Verify: search finds a task by body text; ⌘K jumps to it.
- [ ] **1.14 Suggestion primitive.** Accept/Edit/Override control + per-field provenance
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
- [ ] 2.1 Agent runner: one-shot `-p --resume` worker + role selection + JSON-output parsing + status mapping.
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
