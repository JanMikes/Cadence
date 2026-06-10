# Cadence — Backlog

Our build backlog, phased. Source spec: [`platform-definition.md`](platform-definition.md).
Checkboxes = todos. Phase 1 is detailed; later phases are intentionally lighter until we get there.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done.

---

## Phase 0 — Foundation
- [ ] `git init` the project; set up Bun + TypeScript + Vite + Tailwind + shadcn/ui scaffold
- [ ] Bun HTTP + WebSocket gateway skeleton (serves built frontend + API + WS)
- [ ] Storage: per-task **markdown** files under `~/.cadence/` + **SQLite index** (`bun:sqlite` + Drizzle)
- [ ] File watcher: reindex `task.md` frontmatter → SQLite (index rebuildable from files)
- [ ] Schema (index): projects, fleets, tasks, sessions, deps, events, suggestions (+ provenance)
- [ ] Settings store (global defaults: model, permission mode, delivery mode, global systemPrompt)
- [ ] Design tokens: dark dev theme, monospace accents, spacing scale, **labeled-icon button** primitive

## Phase 1 — Task core + manual spawn (MVP — no autonomy yet)
**Goal: prove the spawn / stream / handoff loop on real tasks while I drive.**
- [ ] **Quick-capture**: global input (+ hotkey) → new task in Inbox
- [ ] **Projects** CRUD incl. `rootPath`, color, default model/permission/delivery, `systemPrompt`
- [ ] **Claude-assisted project import**: scan `~/.claude/projects` dirs → background session
      enriches each (git remote, stack, name, description) → I tick which become Projects
- [ ] **Board**: kanban by lifecycle status; drag between columns; priority + deadline shown
- [ ] **Global search** (tasks) + ⌘K command palette via SQLite **FTS5**
- [ ] **Task detail**: title/body, project assign, priority, deadline, estimate, labels
- [ ] **Free-form context channel** on a task (`contextNotes`, append anytime) — always visible
- [ ] **Manual spawn**: "Run Claude on this task" → spawn warm session in the task's `cwd`
      (`-p --input-format stream-json --output-format stream-json --verbose --session-id … --include-partial-messages`)
- [ ] **Context composition** v1: compose global+project+task context into `--append-system-prompt`
- [ ] **Permission mode selector** per session/task: Auto (default) · Manual · Dangerous
      (resolved task ?? project ?? global); current mode shown on the session tile (§9.1)
- [ ] **Live transcript stream**: gateway parses stdout events → WS → UI (typing, tool cards, result/cost)
- [ ] **Send follow-up** messages to a warm session from the UI (the conversation loop)
- [ ] **Sessions view**: live tiles from the liveness oracle (`~/.claude/sessions/*`) + busy/idle
- [ ] **Transcript reader** for past sessions (tail `projects/**/*.jsonl`, render the DAG)
- [ ] **One-click terminal launch**: copy-paste command **+** "Open in iTerm2/Terminal/…" button
      (gateway runs via `open`/`osascript`); preferred terminal app in Settings
- [ ] **Subagent observability** in session view: nest sidechains (`isSidechain`/`parent_tool_use_id`/`SubagentStop`)
- [ ] **Terminal handoff**: "Open in terminal" → show `cd <cwd> && claude --resume <id>`; reflect
      terminal-started sessions back into the app
- [ ] Cost/usage shown per session (from `result` events)
- [x] **Ambient usage bar**: subscription windows (5h session + weekly) as live meters with reset
      countdowns, from the ✅ verified OAuth usage endpoint (control-surfaces §3.2a; 2026-06-10)
- [ ] **Notifications**: in-app badges + OS notifications (Web Notifications API) for ❓ / delivered
- [ ] **Suggestion pattern** primitive: Accept/Edit/Override control + per-field provenance (§10.2)

## Phase 2 — Autonomy: triage-on-capture + refinement loop
**Goal: tasks arrive pre-refined; I only answer what's needed.**
- [ ] Agent runner abstraction (one-shot `-p --resume` workers + role selection + JSON output parse)
- [ ] **Triage** agent on capture → project/priority/deadline/labels/restatement
- [ ] **Sufficiency gate**: Triage/Discovery may return `insufficient` → **Needs-Feedback (too vague)**
- [ ] **Discovery** agent → spec, acceptance criteria, affected files, approaches, unknowns
- [ ] **Questioner** agent → ranked **Q&A cards**
- [ ] **Needs-Feedback UI**: ❓ badge, Q&A cards (text / choice / boolean), "give me more" cards
- [ ] Answer Q&A **and** free-form context both re-trigger refinement
- [ ] Lifecycle state machine enforced server-side; status timeline on the task
- [ ] Autonomy controls in Settings (per-project enable/disable; spend guardrails)
- [ ] **Agent Library**: reusable subagent defs injected per phase via `--agents` (§7.3)
- [ ] Discovery fans out parallel read-only **explorer** subagents → synthesize spec (§7.2)
- [ ] **Deadline-aware prioritization**: urgency = f(deadline, priority); surface overdue/at-risk
- [ ] **Daily Digest / "Today"**: interactive morning plan (deadline-first) → committed daily goal
- [ ] Daily Digest **gamification**: progress ring, streaks, personalized completion note
- [ ] Daily Digest **evening recap** → `~/.cadence/digests/<date>.md` → seeds tomorrow

## Phase 3 — Execution: PLAY → implement → verify → deliver
**Goal: green PLAY turns a Ready task into delivered work.**
- [ ] **Ready (▶)** state + PLAY button
- [ ] **Planner** agent (plan mode) → plan shown for approval
- [ ] **git worktree per task** provisioning + branch naming
- [x] **Worktrees opt-in per project** (`worktreesEnabled`, default off) — **DONE 2026-06-10**:
      in-place execution on a task branch when off (dirty-tree guard, untracked snapshot so `.env`
      never gets committed, base branch restored after delivery, branch tidied on merge);
      per-project **RW lock** (one implementation at a time, read stages queue behind it, survivor
      guard across gateway restarts); Claude **worktree-readiness check** (propose-don't-impose
      verdict card in Project settings); fleets + Dangerous mode require worktrees.
- [ ] **Implementer** agent in the worktree (permission mode per task)
- [ ] **Verifier** agent → tests/build/lint + acceptance-criteria check → pass/fail
- [ ] Verifier fans out **diverse reviewer** subagents (correctness/security/tests/conventions) → aggregate (§7.2)
- [ ] **Delivery** agent + delivery-mode resolution (`branch_summary` / `auto_pr` / `apply_in_place`)
- [ ] **Review** screen: in-app diff + summary + verify results; merge / request-changes
- [ ] Interrupt / stop a running session from the UI
- [ ] **Manual approve mode**: in-app approve/deny prompts via SDK `canUseTool` (§9.1)
- [ ] **Dangerous mode guardrail**: confirm-to-enable + require/encourage worktree isolation;
      per-project auto-mode rules (allow / soft_deny / hard_deny)

## Phase 4 — Multi-repo, scheduling, analytics, polish
- [ ] **Fleets**: multi-project tasks; sessions across multiple working dirs; per-repo sub-results
- [ ] Scheduled / background sweep mode (optional autonomy while away)
- [ ] Dependencies graph (`blocks` / `blockedBy`), subtasks
- [ ] Cost & throughput analytics (per project / week)
- [ ] Permission UX via Agent SDK `canUseTool` (approve/deny in-app)
- [ ] Notifications (task needs feedback / delivered)
- [ ] **Extend search to transcripts** (FTS5 over `projects/**/*.jsonl` text) + saved filters
- [ ] Calendar / deadline view
- [x] **Tauri desktop wrap** (4.7, optional) — **DONE 2026-06-09**: native shell — tray/menubar +
      OS-global hotkey + notifications + single-instance + autostart; supervises the Bun gateway as a
      self-contained sidecar. Staged, self-healing loop: [`tauri-build-plan.md`](tauri-build-plan.md);
      docs: [`tauri-wrap.md`](tauri-wrap.md).

### Phase 5 — Self-improving layer (memory & proactivity)
- [ ] **Memory layer** (§8.1): global `~/.cadence/memory/` + per-project memory + `MEMORY.md` + `communication.md`
- [ ] **Reflector / Librarian** job: distill Accept/Edit/Override + outcomes → memory updates
- [ ] **Self-monitoring analytics**: suggestion provenance, verify pass-rate, rollovers, staleness
- [ ] **Proactive proposals** via notifications (stale, merge, recalibrate, "what I learned")
- [ ] **"What Cadence learned" feed**: reviewable / revertable memory changes

## Phase 6 — Improvements wave 1 (post-build)
**Ledger with full specs, locked decisions & journal: [`phase-6-plan.md`](phase-6-plan.md) · loop
prompt: [`phase-6-prompt.md`](phase-6-prompt.md).**
- [x] **6.1 🔥 Runaway agent spawns + zombie sessions** — **DONE 2026-06-10**: DB-level stage
      dedupe + 3-per-24h circuit breaker, honest liveness (defunct/pid-reuse-proof, start-time
      signature), kill-at-boot reconcile + process-group kills, plan-approve idempotency,
      per-stage activity tracking, stage timeouts (15m/60m), Stop/Kill/Kill&retry + bulk-clear UX,
      refining-stalled attention items; verified by a zero-cost live incident replay
- [x] **6.2 Remove Inbox view** — **DONE 2026-06-10**: nav/view/palette/tray entries removed;
      capture modal + board inbox column cover it
- [x] **6.3 Settings expansion** — **DONE 2026-06-10**: prompt registry (byte-identical
      extraction) + per-agent prompt/model overrides + Agents & Prompts editor, Czech `d.m.Y H:i:s`
      formatter everywhere + Formats section, operations knobs incl. a new global concurrency cap,
      composed context wired into every one-shot stage
- [x] **6.4 GitHub/GitLab forge foundation** — **DONE 2026-06-10**: remote-URL forge detection
      (+ forgeOverride for self-hosted), gh/glab capability probe + Repository card, forge-aware
      auto_pr delivery with honest fallback (PR/MR URL on task + Open links), forge capability
      line in composed context
- [x] **6.5 ⭐ Code-review module** — **CODE COMPLETE 2026-06-10** (human real-forge smoke
      pending, see plan §6.5.i): code_review task type + capture inference (author vs account →
      perform/address), reviewer + review-responder agents (editable, pre-fetched PR data, opus),
      gh/glab review data layer (meta/diff/threads/publish/reply/resolve), Review Workspace with
      armed explicit-confirm publishing (dismissed findings never leave the machine), deterministic
      PR-branch apply chain, board type filter + ⇄ Review badges, strictness setting
- [x] **6.6 Per-task git context (branch · base · merged?)** — **DONE 2026-06-10**: delivery
      records `task.gitContext` (kind/branch/baseBranch/deliveryCommit — the ancestry anchor that
      survives branch deletion), Cadence's merge flips it instantly, background git-context sweep
      (deterministic local git + cached gh/glab PR-state for squash/rebase merges) catches merges
      done outside Cadence and nudges review tasks toward "mark done" (never auto-flips); board
      GitChip on review/done cards (green merged / amber done-but-unmerged honest alarm), task
      detail Git row + Re-check button + merged-externally banner, DeliveryRecord closes the
      "done task shows no git outcome" gap; `POST /api/tasks/:id/git-context/check`; migration 0011
- [x] **6.7 File attachments as agent context** — **DONE 2026-06-10**: upload files (incl.
      pasted screenshots) to a task — capture modal (pending until create) + task detail Context
      section (drop zone, paste-into-note, Attach picker, image thumbnails, remove); stored under
      `~/.cadence/tasks/<id>/attachments/` (sanitized + deduped names) and injected into every
      composed agent context as absolute paths — terminal parity with pasting a path/image into
      `claude` (the Read tool renders images); REST: GET/POST `/api/tasks/:id/attachments`,
      GET/DELETE `…/attachments/:name` (traversal-safe)
- [x] **6.8 Recurring tasks** — **DONE 2026-06-10**: task *templates* + schedule (daily / weekly
      day-of-week / monthly day-of-month with short-month clamping, "HH:MM" gateway-local) that a
      background scheduler turns into real inbox tasks (same `createTask` + triage-on-capture path
      as manual capture, with an attribution note in context.md); markdown truth under
      `~/.cadence/recurring/<id>.md` + `recurring_tasks` index (migration 0012, derived
      `nextRunAt`), watcher backstop, 30 s tick (CADENCE_RECURRING_MS) with a boot catch-up pass —
      downtime collapses to one run, never a backlog flood; pause/resume, Run now; REST
      GET/POST `/api/recurring`, GET/PATCH/DELETE `…/:id` (post-merge schedule validation),
      POST `…/:id/run`; dedicated "Recurring tasks" nav view (plain-language schedule sentence,
      live next-run countdown, last-created task link, two-step delete) + editor modal with a
      live "first/next task will be created …" preview; schedule math shared (`computeNextRun`
      in @cadence/shared) so server and UI preview can never disagree
- [x] **6.9 Autocomplete selectboxes everywhere** — **DONE 2026-06-10**: every native `<select>`
      (24 across Settings/Projects/TaskDetail/SessionDetail/Relations/Review/Capture/Recurring)
      replaced with a shared type-to-filter combobox (`components/SelectBox.tsx`, Headless UI v2 —
      Tailwind-native, a11y built-in, portalled + anchor-positioned panel so scrolling modals never
      clip it); ChipSelect pills rebuilt on the same mechanism (same public API); groups, per-option
      hint lines (e.g. delivery-mode descriptions), check on the current value, "No matches" state;
      keyboard guards: Enter in a closed combobox never submits the form, Esc closes just the
      dropdown (not the modal above it)

---

## Cross-cutting (every phase)
- [ ] **UX clarity rules** (platform-definition §10.1): labeled icon buttons, self-explanatory
      states, no jargon, visible system status, undo where possible
- [ ] **Propose-and-confirm everywhere** (§10.2): Claude suggests defaults + rationale;
      Accept/Edit/Override; field provenance; auto-apply high-confidence + low-risk
- [ ] **Background Claude jobs** (§8): import enrichment, inbox grooming, auto-estimate, capture
      cleanup, daily digest, stale-task nudge — added as cheap one-shots where they help
- [ ] Keyboard-first navigation (it's a daily driver)
- [ ] Localhost-only binding + basic auth gate (transcripts are plaintext/sensitive)
- [ ] Resilience: detect dead pids / stale oracle files; never double-attach a session_id
