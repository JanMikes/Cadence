# Cadence — Platform Definition

The product spec and source of truth for what we're building. Pairs with:
- [`backlog.md`](backlog.md) — the phased feature list / todos we build from.
- [`agent-prompts.md`](agent-prompts.md) — the prompts that drive each pipeline stage.
- [`claude-code-control-surfaces.md`](claude-code-control-surfaces.md) — the verified technical
  reference for spawning/monitoring Claude Code.

---

## 1. Vision

A **local, single-user** task-management + autonomous-execution platform that turns my daily-job
backlog into work Claude Code does for me. I capture tasks all day; the platform triages, refines
(asking me only what it needs), and — on my **PLAY** — implements, verifies, and delivers, while I
watch and steer in real time. No cloud, no external API, no Docker, no other users. Everything is
saved locally (markdown files + a SQLite index + the existing `~/.claude/` files).

## 2. Principles

1. **Task is the center of gravity.** Everything hangs off a task; the platform exists to get
   tasks *delivered*, not just tracked.
2. **Encourage, don't nag.** The UI nudges me toward the next action (a glowing PLAY, a ❓ that
   needs me) and does background work so tasks arrive pre-refined.
3. **Two-channel feedback.** Agents ask structured **Q&A cards**; I can *also* drop **free-form
   context** onto any task at any time, outside the Q&A. Both feed the agents.
4. **Tell, don't hardcode.** Behavior is shaped by **layered context/prompts** (global → project →
   fleet → task), not baked-in logic. Adding a sentence of context must always be an option.
5. **Isolation when the repo is ready for it.** Autonomous code changes happen on a per-task
   branch — in an isolated worktree where the project opted in (§9.0), else serialized in the
   project dir with the base branch restored after delivery; my working tree is never surprised.
6. **Files are truth, DB is index.** *Content* lives in files — Claude Code's `~/.claude/`
   transcripts and our own per-task **markdown** are authoritative; **SQLite is a fast index** over
   them for the board, filters, and status. (See §5.)
7. **Clarity over confusion.** This is my daily operational center — good UX means I understand
   everything *without explanation*. Self-explanatory states, plain language, visible system
   status. **Icon buttons always carry a short text label/caption** — never icon-only. (See §10.1.)
8. **Bailing early is fine.** An agent concluding "too vague — need a better description / more
   context" is a *correct* outcome, not a failure. Agents must ask rather than fabricate scope.
9. **Claude Code is the workforce.** Prefer delegating to **background Claude sessions** over
   hardcoding heuristics — import enrichment, triage, labeling, estimates, dedup, digests, not just
   the core pipeline. Cheap models for cheap jobs; it's a Max-20x subscription, so lean on it. (§8)
10. **Propose, don't impose — "What would Claude do?"** Anywhere a decision is needed (project,
    priority, deadline, labels, spec, next action, delivery mode, "what next?"…), Claude offers a
    *recommended default* with a short rationale; I **Accept / Edit / Override** in one move.
    Automation is the default, not the exception — but nothing AI-decided is ever locked, and my
    correction is always one click away. (See §10.2.)
11. **Lean contexts, sharp reasoning.** Each phase delegates heavy read-only exploration and
    parallel review to **subagents** (isolated contexts that read a lot but return only a distilled
    summary), so the phase's own reasoning never drowns in raw file dumps. (See §7.2.)
12. **Deadlines drive priority.** Urgency = f(deadline proximity, priority). Claude weighs it in
    triage, the daily plan, and what surfaces first; overdue / at-risk tasks never hide. (See §10.3.)

13. **Cadence learns.** It treats its own markdown **memory** as a self-written context layer,
    distilling my corrections and outcomes into durable lessons (communication style, routing,
    project gotchas) and occasionally proposing improvements — self-improving, self-monitoring,
    self-proposing, always reviewable. (See §8.1.)
14. **Nothing confidential in the repo.** The repository holds only generic app code + docs — never
    secrets, credentials, or client/task data. **All runtime data lives outside the repo in
    `~/.cadence/`**; integration secrets live in the OS keychain. Treat the repo as public-safe at
    all times. (See §13.)

## 3. Decisions log (locked 2026-06-06)

| Decision | Choice | Notes |
|---|---|---|
| **First slice (MVP)** | Task core + manual spawn | Entities, kanban, quick-capture, click-to-spawn a session in the task's cwd, live stream. No autonomy in Phase 1. |
| **Autonomy trigger (target)** | Instantly on capture | Triage runs the moment a task lands; refinement continues after I assign/confirm. **Enabled in Phase 2.** |
| **Feedback UX** | Q&A cards **+** always-on free-form context | Q&A primary; every task has an "add context" channel outside the Q&A. |
| **Delivery output** | Overridable per task | `task ?? project ?? global`. Default = branch + summary. |
| **Config philosophy** | Layered system/global prompts | Global → project → fleet → task context compose into every agent run. |
| **Storage** | SQLite **index** + per-task **markdown** files | Markdown = content truth; SQLite = queryable index. (§5) |
| **Workforce** | Background Claude sessions do the work | Delegate over hardcode; cheap models for cheap jobs. (§8) |
| **App shell** | Web-first (localhost), **Tauri-wrappable later** | Menubar/tray + OS-global hotkey are just a wrapper over the same UI — additive, zero rework. |
| **Onboarding** | Claude-assisted project import (I confirm) | Scan `~/.claude/projects` dirs; a background session enriches each (remote, stack, name, desc); I tick which to create. |
| **Usage guardrails** | Ambient usage indicator, no hard caps | On Max-20x there's no marginal $; show a small **subscription-window** bar (5h session + weekly) + per-task notional cost as an *effort* signal. |
| **Notifications** | In-app badges **+** OS notifications | Web Notifications API in the browser; native if/when wrapped in Tauri. |
| **Decision UX** | Propose-and-confirm everywhere | Claude suggests a default + rationale; I Accept/Edit/Override. Automation is the default. (§10.2) |
| **Orchestration** | App-level lifecycle + in-session subagents | Cadence runs phases/gates/persistence/multi-repo; each phase session uses subagents for context-isolated reading & parallel review. Not Agent Teams. (§7.2) |
| **Daily Digest** | Interactive, gamified daily planning ritual | Claude plans the day *with me* (deadline-first), encourages on completion; evening recap → tomorrow. (§10.3) |
| **Deadlines** | First-class prioritization input | Urgency = f(deadline, priority); weighed in triage, digest, board. (Principle 12) |
| **Terminal handoff** | Copy command + one-click launch | Per session: copy-paste `claude --resume`, or "Open in iTerm2/Terminal/…" button. |
| **Self-improvement** | Markdown memory + Reflector + proactive proposals | Cadence learns from my Accept/Edit/Override + outcomes; updates memory; proposes occasionally via notifications; all reviewable. (§8.1) |
| **Permission modes** | Auto (default) · Manual · Dangerous | Maps to `auto` / `default`+`canUseTool` / `bypassPermissions`; resolved task ?? project ?? global; per-project auto-mode rules; Planner uses `plan`. (§9.1) |
| **Search** | Full-text global search + ⌘K palette | SQLite **FTS5** over tasks + transcripts + projects + memory + digests; doubles as command palette. (§10) |

## 4. Entities

### Project — organizing unit, usually a git repo / working directory
```
id, name, slug, color, rootPath?, gitRemote?,
defaultModel,
defaultPermissionMode,   -- auto (default) | manual | dangerous → real modes (§9.1)
defaultDeliveryMode,     -- branch_summary | auto_pr | apply_in_place
systemPrompt?,   -- project-level context layer (§4.x → §7 composition)
notes, createdAt
```

### Fleet — named set of projects/working dirs for **multi-repo tasks**
```
id, name, projectIds[] (ordered), systemPrompt?, notes
```

### Task — the core entity
```
id, title, body,
target: projectId | fleetId | null(unassigned),
status,               -- §6 state machine
priority, deadline?, estimate?, labels[],
spec?, acceptanceCriteria[],   -- from Discovery (live in spec.md)
contextNotes[],       -- FREE-FORM context I add anytime (context.md, append-only)
qa[],                 -- structured questions+answers (qa.md)
deliveryMode?,        -- per-task override
blocks[], blockedBy[], parentTaskId?,
sessionIds[], createdAt, updatedAt
```

### Claude Code Session — our wrapper around a real session (may be standalone/unassigned)
```
id(=claude session_id), taskId?, projectId?, fleetId?,
role,   -- triage|discovery|questioner|planner|implementer|verifier|delivery|chat|import|digest
kind,   -- warm (stream-json) | oneshot (-p --resume)
status, -- spawning|running|idle|awaiting_feedback|done|failed|killed
cwd, branch?, worktreePath?, pid?, model, permissionMode,
costUsd, startedAt, endedAt, transcriptPath
```

## 5. Data architecture (storage)

**Markdown holds content; SQLite indexes it.** App data root: `~/.cadence/`.

```
~/.cadence/
  cadence.db            # SQLite index (Drizzle): tasks, projects, fleets, sessions, deps, events
  settings.json             # global defaults + global systemPrompt
  projects/<slug>.md        # project config (frontmatter) + systemPrompt context layer
  fleets/<name>.md
  tasks/<task-id>/
    task.md                 # frontmatter (title,status,priority,deadline,project,labels) + body
    context.md              # append-only free-form context channel (the out-of-Q&A input)
    qa.md                   # questions + answers
    spec.md                 # Discovery output (spec, scope, acceptance criteria)
    plan.md                 # Planner output
    verify.md               # Verifier output
    delivery.md             # Delivery summary + branch/PR (+ output filenames)
    attachments/            # files the USER gave the task (inputs, passed to agents by path)
    outputs/                # files AGENTS produced (reports, PDFs, exports) — non-code
                            # deliverables live here, never committed to the repo; the
                            # task links each file so it opens directly from the UI
  memory/                   # self-written memory: global learnings + MEMORY.md + communication.md
  digests/<date>.md         # daily plan + evening recap (the productivity journal)
  decisions.md              # optional global decisions/history log
```

- **Source of truth = the markdown.** SQLite caches the queryable fields (status, priority,
  deadline, title, links) derived from each `task.md` frontmatter — rebuilt by a file watcher (same
  pattern we use for `~/.claude/` files). DB loss is recoverable by re-indexing the files.
- Agents read/write these `.md` files **natively** (their strongest medium); the gateway reindexes
  on change. Everything is human-readable, hand-editable, and git-friendly.
- **Code worktrees** for implementation live under each project's repo (git worktree), *not* here.

## 6. Task lifecycle (state machine)

```
            ┌────────────────────────────── add context / answer Q&A ──────────────┐
            ▼                                                                        │
Inbox ──triage──▶ Triaged ──assign──▶ Refining ⇄ Needs-Feedback(❓) ──enough──▶ Ready(▶)
                                                                                     │ PLAY
                                                                                     ▼
                                       Done ◀── Review ◀── Verifying ◀── Implementing
Side states (from most): Blocked, Cancelled.
```

- **Inbox** — raw capture. (Target: Triage fires immediately → Triaged.)
- **Triaged** — has a project/priority/deadline guess; awaiting confirm or auto-continues.
- **Refining** — Discovery is building the spec.
- **Needs-Feedback (❓)** — blocked on me. Two card flavors: (a) specific **Q&A** from the
  Questioner, or (b) a **sufficiency bail** — Triage/Discovery decided it's too vague and asks for a
  better description / more context (Principle 8). Both answered via Q&A *or* the free-form context
  channel, which re-triggers the stage.
- **Ready (▶)** — enough info; the green PLAY button is live.
- **Implementing / Verifying / Review / Done** — execution and delivery.

## 7. Agent pipeline

| # | Role | Trigger | Output | Model |
|---|---|---|---|---|
| 1 | **Triage** | task hits Inbox | project/fleet guess, priority, deadline, labels, restatement — **or** `insufficient` bail | Haiku |
| 2 | **Discovery** | enters Refining | spec, acceptance criteria, affected files, approaches, unknowns — **or** `insufficient` bail | Sonnet |
| 3 | **Questioner** | unknowns remain | ranked Q&A cards → Needs-Feedback | Sonnet |
| 4 | **Planner** | PLAY pressed | ordered implementation plan (plan mode) | Opus |
| 5 | **Implementer** | plan ready | code changes in isolated worktree/branch | Opus |
| 6 | **Verifier** | impl done | tests/build/lint + acceptance-criteria check → pass/fail | Sonnet |
| 7 | **Delivery** | verify passed | summary + commit/PR/branch per delivery mode → Review/Done | Haiku |

Prompts: [`agent-prompts.md`](agent-prompts.md). Models are defaults; overridable per project/task.
Context for each run is composed from the layers below.

### 7.1 Context & prompt composition
Each run appends composed context via `--append-system-prompt`; the **user message** is the stage
instruction. Order (later = more specific): **Global → Project `systemPrompt` (+ repo CLAUDE.md,
loaded natively) → Fleet `systemPrompt` → Task spec + acceptance criteria → Task `contextNotes`
(free-form) → Task Q&A answers → Role prompt.** This is the whole "tell, don't hardcode" engine.

### 7.2 Orchestration model: app-level vs in-session subagents
Cadence runs work at **two levels**, and the design rule is *where the context boundary sits*:
- **App-level (Cadence orchestrates the lifecycle).** Phases, the human **PLAY/❓ gates**,
  persistence (SQLite + markdown), cost/usage, multi-repo/fleet, terminal handoff. Each phase is its
  own Claude *session* (one-shot `-p --resume` or warm).
- **In-session subagents (Claude orchestrates context).** *Inside* a phase, the session uses the
  Task/Agent tool to fan out **read-only explorers** and **parallel reviewers** that read a lot but
  return only a distilled summary — their raw file dumps never enter the phase's context.

**Boundary rule** — app-level when it must *ask me*, *persist/resume*, be *gated*, or span *multiple
repos* (subagents can't ask the user, are one-shot, can't nest, and share the parent's cwd);
in-session subagents for non-interactive, read-heavy, parallelizable work in one repo.

**Hard constraint:** the **Questioner / Needs-Feedback** loop is *never* a subagent — it must talk
to me, so it lives at app level / the main session. (This is why our human gate sits there.)

**Per phase:** Discovery → parallel `explorer` subagents map the repo; the session synthesizes the
spec from summaries (biggest win on large repos). Verifier → *diverse* independent reviewers
(correctness / security / tests / conventions) → aggregate. Implementer → mostly single-context
(editing needs shared context); read-only lookups only. Import/grooming → one explorer per repo.

**Why (on Max-20x):** not about $ (no marginal cost) — it's **context quality** (don't pollute a
phase's reasoning) and **speed** (parallel reads).

**Observability:** subagent activity is visible via `isSidechain` transcript lines,
`parent_tool_use_id`, and the `SubagentStop` hook → the UI nests "Discovery → 3 explorers, 2 done".
We deliberately use this simple subagent pattern, *not* experimental Agent Teams.

### 7.3 Agent library
Cadence owns a reusable library of **subagent definitions** (explorer, dependency-mapper,
security/test/convention reviewers, smoke-tester…), each `{ description, prompt, tools, model }`
(read-only + Haiku for explorers; Sonnet/Opus for review). They're **injected per phase at spawn via
`--agents <json>`** (session-scoped, no repo pollution) — or written to a project's `.claude/agents/`
when we want them persistent/shared. Editable config, not code — same "tell, don't hardcode" spirit.

## 8. Background Claude jobs (the workforce in action)

Beyond the core pipeline, we delegate routine cognition to cheap background sessions:
- **Project import enrichment** — inspect a candidate dir (git remote, stack, README/CLAUDE.md) →
  propose name, color, description, default model. (onboarding)
- **Inbox grooming** — detect duplicate/related tasks, suggest merges or links.
- **Auto-estimate & priority** — suggest estimate/priority/deadline from the task + project.
- **Capture cleanup** — turn a messy one-line dump into a clear title + body.
- **Daily digest / standup** — what shipped, what needs me, the suggested next 3.
- **Stale-task nudge** — flag tasks idling in a state too long.
- **Reflector / Librarian** — distill my corrections + outcomes into durable **memory** updates;
  watch acceptance / verify / rollover signals; surface proactive proposals. (§8.1)

Each is a one-shot `claude -p` (usually Haiku) writing structured JSON or a markdown artifact.

### 8.1 Memory & self-improvement (the learning spine)
Cadence treats its own **markdown memory** as a self-written context layer (§7.1) that makes it
better over time — autonomous self-improving, self-monitoring, self-proposing.
- **Memory files (markdown, versioned, hand-editable).** Global `~/.cadence/memory/` (cross-project:
  my preferences, recurring rules) + per-project memory (conventions, build/test commands, gotchas the
  agents learned) + a `MEMORY.md` index. A `communication.md` captures how I like updates phrased
  (signal vs noise, verbosity, Czech/English). All compose into agent runs via the context layers,
  and Claude Code also loads `CLAUDE.md`/memory natively.
- **Self-monitoring (it already has the data).** We track **suggestion provenance** — what I
  Accept / Edit / Override (§10.2) — plus verify pass-rates, "too vague" bounces, rollovers, stale
  tasks. That's the raw signal.
- **Self-improving (the Reflector).** A lightweight Reflector/Librarian background job distills
  durable lessons from my corrections + outcomes and writes/updates memory: "Jan reroutes
  ProjectA→ProjectB — learn it", "delivery needs the DB up — remember", "he trims my priorities up by
  one — recalibrate". My **feedback is the highest-signal training data.**
- **Self-proposing (proactive, occasional).** Cadence reaches out via in-app / OS notifications with
  proposals, not noise: "5 stale tasks — archive?", "these 3 share a root cause — merge?", "I learned
  your commit style ✎ (review)". Everything is **propose-don't-impose** (§10.2) — I Accept / Edit /
  Dismiss, which feeds memory again. Closed loop.
- **Guardrail:** memory writes are reviewable — a **"What Cadence learned" feed** I can edit or
  revert, so learning never drifts silently. Files are truth (Principle 6); memory is inspectable.

## 9. Delivery model

`deliveryMode` resolved as `task ?? project ?? global`. Modes:
- **`branch_summary`** (default) — commit on a per-task branch; in-app diff + summary + verify
  results; I merge.
- **`auto_pr`** — additionally push + `gh pr create`.
- **`apply_in_place`** — edit files directly in `rootPath` (no isolation, no branch; scratch repos).

**Non-code deliverables (outputs).** Some tasks produce reports/PDFs/exports rather than (or in
addition to) repo changes. Every task agent's composed context names the task's
`~/.cadence/tasks/<id>/outputs/` dir and the rule: generated assets go there, never into the repo
(the planner plans for it, the implementer writes there, the verifier checks there). Output files
count as work product (a report task correctly leaves git clean), delivery records and summarizes
them, an outputs-only task skips the empty branch/PR ceremony, and the Review "merge → Done" gate
accepts outputs as the delivery. The task UI lists each file (served by the gateway) so it opens
directly; outputs are deletable but never uploadable — they only get there by a run writing them.

### 9.0 Execution isolation — worktrees are opt-in per project

Not every repo runs from a fresh second checkout (`.env` files outside git, docker-compose with
fixed host ports / repo-path bind mounts, per-checkout dependency installs, submodules). So
**worktree isolation is a per-project setting, `worktreesEnabled`, default OFF**:

- **Enabled** — execution (Implementer → Verifier → Delivery) runs in an isolated per-task
  **git worktree** + branch next to the repo. Parallel-safe across tasks; the Implementer gets
  full tool access (the disposable sandbox is the boundary).
- **Disabled (default)** — execution runs **in the project working dir** on the same per-task
  branch (created off the current HEAD), guarded by a **per-project readers-writer lock**:
  - **one implementation per project at a time** (writer-exclusive, FIFO with writer preference);
  - read stages (Triage/Discovery/Questioner/Planner) share the dir but **queue behind an
    in-place execution**, so investigation always sees the base branch, never a half-written
    task branch;
  - it **refuses to start on a dirty tree** (my uncommitted work is never tangled into a task
    branch), snapshots pre-existing untracked files so a delivery commit never swallows them
    (`.env` stays mine), and **restores the base branch after delivery**; merge tidies the branch.
  - the Implementer keeps the safer resolved permission mode (never `bypassPermissions` in-place);
    fleet runs require worktrees (members that haven't opted in are skipped with a visible reason).
- **"Check readiness" (propose-don't-impose)** — a read-only Claude run inspects the repo for
  worktree blockers (uncommitted-but-required files, docker/port assumptions, install cost,
  submodules…) and persists a verdict + blocker list on the project settings card; **I** flip the
  toggle.

### 9.1 Permission / autonomy modes
How much a session may do without asking. Three user-facing modes (mapping to real
`--permission-mode` values), resolved **task ?? project ?? global**, default **Auto**:
- **Auto (default)** → `auto` — Claude's classifier auto-approves safe actions, **asks** on the
  uncertain, and **hard-denies** the dangerous (per allow / soft_deny / hard_deny rules, tunable per
  project: e.g. hard-deny `git push --force` / `rm -rf`, allow `npm test`). The everyday mode.
- **Manual (approve each)** → `default` — every tool action surfaces an **approve / deny prompt
  in-app** via the SDK `canUseTool` callback, so I gate each step. Maximum control. (This is
  propose-don't-impose, §10.2, at the tool level.)
- **Dangerous (skip all)** → `bypassPermissions` / `--dangerously-skip-permissions` — no prompts.
  For trusted, **isolated** autonomous runs only: enabling asks for confirmation and **requires
  worktree isolation** (§9.0) — it is refused for in-place execution so a runaway can't touch my
  main tree.

Under the hood Cadence also uses **`plan`** (read-only) for the Planner phase and may use
**`acceptEdits`** for trusted implement steps. The live session tile always shows its current mode
(clarity, §10.1) — `Dangerous` is visually loud. Per-project auto-mode rules are editable config
(tell-don't-hardcode); `claude auto-mode critique` can even have Claude sanity-check them.

## 10. Dashboard / UX (clean, modern, dev-style)

- **Quick-capture** everywhere (global hotkey + persistent input) → Inbox; triage runs.
- **Global search & ⌘K palette** — full-text search across tasks, transcripts, projects, memory,
  and digests (SQLite **FTS5**), doubling as a command palette (jump-to, run actions). Results
  grouped and labeled (§10.1).
- **Board** — kanban by lifecycle status; ❓ and ▶ badges pull attention to actionable tasks.
- **Task detail** — spec + acceptance criteria, Q&A cards, free-form context box (always on),
  sessions list, live transcript, diff/changes, status timeline, **PLAY**, delivery controls.
- **Sessions** — live tiles (status/cost from the liveness oracle + transcript tail); attach /
  take-over. **Terminal handoff** per session: a copy-paste command (`cd <cwd> && claude --resume
  <id>`) **and** a one-click **"Open in iTerm2/Terminal/…"** button (the local gateway launches it
  via `open`/`osascript`; preferred terminal app set in Settings).
- **Projects / Fleets** — config incl. `rootPath`, models, delivery mode, and `systemPrompt` layers.
- **Ambient usage bar** — small, non-noisy indicator of subscription windows (5h session + weekly
  utilization) from `rate_limit_info` + `stats-cache.json`. Per-task notional cost shown as an
  *effort* signal, not a budget.
- **Aesthetic** — dark, monospace accents, shadcn/ui + Tailwind, xterm.js panels. Calm and fast.

### 10.1 UX clarity rules (non-negotiable — it's a daily driver)
- **Self-explanatory.** Understand any screen without a manual or tooltip-hunting.
- **Labeled actions.** Icon buttons always pair the icon with a short text label — never icon-only.
  Destructive/irreversible actions clearly labeled and confirmable.
- **Plain language.** No internal jargon; states read as what they mean ("Needs your input",
  "Ready to run", "Reviewing").
- **Visible system status.** Always show what's happening (running / idle / which agent / usage)
  and the *next* action — pull attention to ❓ and ▶.
- **Low friction, keyboard-first.** Capture and common actions are one keystroke away.
- **Forgiving.** Prefer undo/confirm over silent, unrecoverable actions.
- **Smooth & fast.** Optimistic UI, instant feedback; latency is a tax on a productivity tool.

### 10.2 Propose, don't impose — the suggestion pattern (the app's core interaction)
Automation is the goal, so **every decidable thing carries a Claude suggestion** the user can take
or change:
- A suggestion is `{ value, rationale, confidence }`. The UI shows it with one consistent control:
  **Accept** (one click) · **Edit** (tweak the value) · **Override** (do my own) · **Dismiss**.
- **Provenance** is tracked per field: `suggested` (visually marked) until I confirm → `confirmed`.
  I can re-ask **"What would Claude do?"** on any field/task to regenerate a suggestion on demand.
- **High-confidence + low-risk → auto-apply** (still editable). **Low-confidence or risky → wait**
  for me. Bias: keep me in flow; never block on a trivial decision, never silently do a risky one.
- Applies beyond fields to judgment calls: "what should I work on next?", "is this ready to PLAY?",
  "should these two tasks merge?", "is this too vague?" — Claude proposes, I decide.

### 10.3 Daily Digest / "Today" — the daily ritual
A Claude-driven **morning planning ritual** that decides, *with me*, what to achieve today — and an
evening recap that celebrates it. The heart of "encourage, don't nag" (Principle 2).
- **Plan the day (interactive).** Claude reviews open tasks weighing **deadlines first** (overdue /
  at-risk to the top), then priority, in-progress work, ❓ blockers, ▶ ready tasks, quick wins, and
  staleness. It proposes a focused **"Today" shortlist** with a one-line rationale per pick, then
  *asks me* what matters most today and any constraints (meetings, energy) — I Accept / Edit /
  Reorder / Override (§10.2). The result is a committed daily goal.
- **Deadline-aware.** Urgency = f(deadline proximity, priority); overdue / due-soon surface
  prominently. (Principle 12.)
- **Gamified encouragement (tasteful, dev-style — not childish).** A daily-goal progress ring
  ("3/5"), a **streak** of days the plan was met, a momentum signal. On completion Claude writes a
  *personalized* note from what I actually shipped ("cleared the ProjectA deadline + 2 ProjectB fixes
  — strong day"). Positive reinforcement only; rollover framed constructively, never guilt. Honors
  the clarity rules (§10.1).
- **Evening recap → tomorrow.** At day's end Claude summarizes done / shipped / rolled-over and seeds
  tomorrow's digest. Each day is a markdown artifact (`~/.cadence/digests/<date>.md`) — a
  productivity journal over time.
- **Powered by** the Daily-Digest background job (§8), elevated to an interactive surface; it's the
  default landing view each morning.

## 11. Tech stack

Bun (runtime) · `bun:sqlite` + Drizzle (index) + **FTS5** (search) · per-task markdown (content) · Bun HTTP+WS gateway
· React + Vite + Tailwind + shadcn/ui + xterm.js + TanStack Query. **Web-first**, Tauri wrap optional
later (menubar + OS-global hotkey). Claude control via the `claude` binary (stream-json), Agent SDK
later for `canUseTool`. See `claude-code-control-surfaces.md` for the verified mechanics.

## 12. Build phases

See [`backlog.md`](backlog.md). Phase 1 = task core + manual spawn (no autonomy). Phase 2 = triage-
on-capture + refinement/Q&A loop. Phase 3 = PLAY→implement→verify→deliver. Phase 4 = fleets/multi-
repo, scheduling, analytics, optional Tauri wrap.

## 13. Security & data boundaries
Single-user local tool, but the **repo is treated as public-safe** — it must never contain anything
confidential. (Principle 14.)
- **Hard boundary.** Repo = generic application code + docs only. **All runtime data** (tasks,
  session transcripts, memory, digests, project configs, daily plans) lives in **`~/.cadence/`**,
  outside the repo, and is `.gitignore`-protected even if symlinked in.
- **Secrets in the keychain.** Integration tokens (GitHub, Toggl, …) live in the **macOS Keychain**
  (via `security`), never as plaintext in `~/.cadence/settings.json` and never in the repo. Settings
  reference a keychain item id, not the secret itself.
- **Redact before composing context.** Strip tokens/secrets from anything we pass into a Claude
  session's prompt or `--append-system-prompt`.
- **Commit guard.** A **pre-commit secret scan** (e.g. gitleaks or a grep guard) + a hardened
  `.gitignore` (`.env*`, `*.key`, `*.pem`, `secrets/`, `/.cadence/`) block accidental commits. The
  build agent is instructed never to commit secrets or client identifiers (see build-prompt rules).
- **Examples are fictional.** Docs/examples use placeholder names (`ProjectA`, `Acme`) — never real
  client/project names.
- **Local-only surface.** The web UI binds to localhost and is auth-gated; `~/.claude/` and
  `~/.cadence/` are plaintext on disk, so the machine itself is the trust boundary.
