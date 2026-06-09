# Cadence — Phase 6 Plan & Ledger (Improvements Wave 1)

> **This file is the SINGLE SOURCE OF TRUTH for Phase 6 progress.** Same loop as
> [`build-plan.md`](build-plan.md): a fresh session orients, reconciles against the repo, implements
> the first unchecked step, verifies, commits, journals. The loop prompt is in
> [`phase-6-prompt.md`](phase-6-prompt.md). Product decisions are **pre-made and locked** in each
> step below — the loop must not stall to ask; if something is genuinely unspecified, make the
> propose-don't-impose call and record it in the Journal under *Decisions*.

## Status snapshot  ← the building agent keeps this current
- **Current step:** 6.1.d (honest liveness in watchdog/reconcile + signature + sweep).
- **Blockers:** none.
- **⚠️ STANDING HAZARD until 6.1 lands:** global `autonomy: true` + dev gateway under `bun --watch`
  means **every server/shared file save restarts the gateway → `healStuckTasks` → may spawn a real
  discovery agent (real money)** for any task sitting in `refining`. **6.1.a containment MUST be
  completed before any other code edit in this phase.**
- **Last updated:** 2026-06-10 (plan authored; investigation evidence baked in below).

## Rules (the idempotent loop)
1. **Orient** — read `CLAUDE.md`, `docs/platform-definition.md`, this file, `docs/backlog.md` §Phase 6.
2. **Reconcile** — `git log --oneline -n 30`; run gates (below). Repo + git history WIN over this
   ledger; fix drift as `chore(ledger): reconcile`.
3. **Select** the FIRST unchecked sub-step, in order (6.1 → 6.5; sub-steps in order).
4. **Implement** that ONE sub-step. Small focused diff; smoke test for new logic.
5. **Verify** — the sub-step's *Verify* line **and** the global gates:
   `bun run typecheck && bun test && bun run build` (all three green).
6. **Commit** just that sub-step: `build(6.x.y): <summary>`. Do not push.
7. **Record** — check the box; append a Journal entry (what / decisions / deviations / notes);
   update the Status snapshot. Commit the ledger update (may be squashed into the step commit).
8. **Continue.** Multiple sub-steps per session/iteration are fine; always end at a
   committed+journaled boundary.
9. **Autonomy rule (differs from the original build loop):** do **not** stop for product decisions —
   they are locked below; decide-and-journal anything residual. If a verification cannot pass after
   honest attempts, mark the sub-step `[blocked: reason]` in this file, journal it, and **move on to
   the next sub-step** (retry blocked ones on a later pass). Stop the loop only when everything is
   `[x]` (or only `[blocked]` items remain — then print the blocker summary).
10. **Security (critical, unchanged):** repo is public-safe — generic code + docs only; no secrets,
    no real client identifiers; runtime data stays in `~/.cadence/`; scan every diff before commit.
11. UX rules apply to every UI change: **labeled icon buttons** (never icon-only), plain-language
    states, propose-don't-impose (Accept/Edit/Override), keyboard-friendly.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done+verified · `[blocked: …]` skipped with reason.

---

- [x] **6.0 Commit this plan.** If `phase-6-plan.md` / `phase-6-prompt.md` / the backlog §Phase 6 /
  the CLAUDE.md status line are uncommitted, commit them as `build(6.0): phase 6 plan + loop prompt`.
  - Verify: `git status` clean afterwards. ✓ 2026-06-10 (baseline gates green: 305 tests).

---

## 6.1 Runaway agent spawns + zombie sessions  🔥 URGENT — this is a money bug

**Symptom (2026-06-10):** task *“Preserve route state on page refresh”* accumulated **15 `discovery`
sessions stuck `status="running"`** (plus 1 stray discovery + 1 planner “running” on other tasks),
while `ps` shows **zero** live `claude -p` processes — rows are zombies and liveness is lying.

**Root cause — confirmed by code investigation (trust these refs; re-verify lines before editing):**
1. `healStuckTasks` (`server/src/heal.ts:25-44`) runs on **every** gateway boot when autonomy is on
   (`gateway.ts:109-113`) and re-runs discovery for **every** task in `refining`. Its only dedupe
   guard is the **in-memory** `activity.isActive` (`heal.ts:30`) — empty after every restart.
2. Dev gateway runs under `bun --watch` (`server/package.json` dev script) → **every file save = a
   boot = a potential spawn**. The dev gateway had been up 2 days across many restarts.
3. Discovery sets the task to `refining` at run **start** (`agents/discovery.ts:149`) and leaves it
   `refining` when unknowns exist until the questioner finishes (`discovery.ts:131`) — a wide window.
4. One-shot children **survive** gateway restarts by design (`gateway.ts:186` kills warm handles
   only; `watchdog.ts:108-111`), but their driving JS promise dies with the gateway → results are
   never collected, the task never leaves `refining` → permanent heal-bait.
5. `reconcileOrphans` (`watchdog.ts:113-136`) keeps alive-pid sessions “running”, but liveness is
   `process.kill(pid, 0)` (`sessions.ts:29-36`) → **PID reuse makes dead rows look alive forever**;
   the watchdog stuck-pass (`watchdog.ts:143-195`, the "A run looks stuck" string at :187) only
   nudges — it never kills or finalizes an idle-but-“alive” run.
6. Unguarded duplicate-spawn endpoints: `POST /api/tasks/:id/refine` (`api.ts:432-449`) has **no**
   in-flight check; plan-approve (`api.ts:317-338`) runs the execution chain even when already
   `implementing` (“back-compat”, :330) → double chains.
7. `ActivityTracker` (`activity.ts:24-44`) is keyed by taskId only → a second concurrent stage
   overwrites the entry and the first `end()` deletes it — the guard self-corrupts.
8. One-shots have **no timeout** (`runner.ts:137-142` supports `timeoutMs`; no pipeline caller sets it).

**Live forensics refinement (2026-06-10):** the 17 zombie pids were **`<defunct>`** — literal Unix
zombies. Implications the fix MUST honor:
- `process.kill(pid, 0)` returns **alive for defunct processes** → that is precisely why
  reconcile/watchdog believed them for 15+ hours. Honest liveness (6.1.d) must treat Z-state as dead
  (`ps -p <pid> -o stat=` starts with `Z`, or empty `command=`).
- `bun --watch` re-execs **in the same PID**: the re-exec'd server loses all child handles (no one
  ever `wait()`s → defunct on exit) while heal-on-boot spawns replacements. So “one-shots survive
  restarts” (`watchdog.ts:108-111`) does not hold in dev: orphans die on SIGPIPE at their next
  stdout write (stdio pipes closed) or finish unobserved — cost is bounded but results are always
  lost, and the rows lie forever. Defunct entries are only reaped when the gateway process dies.
- The storm was **15 spawns in 2.5 min (22:29:12–22:31:49 on 2026-06-09), two in the same second**
  (pids 3610/3659) → at least two spawn paths raced (heal × capture-chain or double heal). Root-cause
  lead: check git reflog / `~/.claude` transcripts around that time — likely an implementer session
  editing this very repo, each file edit re-exec'ing the watch → heal → spawn (Cadence amplifying
  itself).

### Sub-steps

- [x] **6.1.a Containment — DO THIS BEFORE ANY OTHER CODE EDIT IN PHASE 6.** ✓ complete 2026-06-10
  (data cleanup + gateway stop + `autonomy: false`; all verify checks pass — see Journal).
  1. Stop the dev gateway if running (`pgrep -f "bun run --filter=@cadence"`; also the
     `bun --watch src/index.ts` child) and any Tauri-supervised sidecar.
  2. `ps` sweep: kill any live Cadence-spawned `claude -p … stream-json` process (none expected;
     never touch interactive `claude` sessions attached to a tty).
  3. Set `"autonomy": false` in `~/.cadence/settings.json` for the duration of 6.1 (restore in 6.1.h).
  4. Finalize zombie rows in `~/.cadence/cadence.db`: every `kind='oneshot'` session in
     `spawning|running` whose pid is dead/foreign → `status='failed'`, note
     `orphaned — finalized by 6.1.a`. Same for stale `warm` rows.
  5. Tasks stuck in `refining` with no live run → `needs_feedback` with an explanatory context note
     (don’t lose them; don’t leave them as heal-bait).
  6. Journal exact counts (sessions finalized, tasks moved).
  - Verify: SQL shows 0 oneshot sessions in `spawning|running`; `ps` shows no `claude -p`; journal
    has the counts.
  - **Partially done 2026-06-10 (see Journal):** items 4–5 complete — 17 zombie rows finalized
    `failed`, stranded task reset to `ready`, **no tasks left in `refining`** (heal-bait cleared, so
    restarts currently spawn nothing). Items 1–3 (stop gateway, sweep, `autonomy: false`) still
    apply **for the duration of the 6.1 code work**; re-verify the SQL/ps checks then.
- [x] **6.1.b DB-level in-flight dedupe.** Central guard (e.g. `canSpawnStage(db, taskId, role)` next
  to the recording-runner): refuse to spawn when a live one-shot session row exists for the same
  `(taskId, role)` with a **verified-alive** pid (see 6.1.d). Apply at every spawn site: capture
  pipeline (`api.ts:1199-1240`), `/refine`, heal, execution chain, fleet.
  - Verify: unit test — two concurrent discovery starts → one spawn; `/refine` during an active
    discovery → 409 with a plain-language error. ✓ 2026-06-10 (`de021e7`, 10 new tests, 315 total).
- [x] **6.1.c Attempt budget + circuit breaker.** Cap automatic attempts per `(task, role)`:
  default **3 per 24h** (constant now; becomes a setting in 6.3.e). On breach: task →
  `needs_feedback` + auto context note “Automatic refinement halted after N failed attempts — needs
  your input”, plus in-app + OS notification. Manual user-initiated runs may exceed the budget but
  still respect 6.1.b dedupe. Never silent-spawn.
  - Verify: test — 4th auto attempt inside the window refuses, flips status, records a notification.
    ✓ 2026-06-10 (`cc6d3d3`, 3 new tests, 318 total).
- [ ] **6.1.d Honest liveness (defeat PID reuse AND defunct zombies).** At spawn, persist a process
  signature alongside pid (spawn timestamp + verify `ps -p <pid> -o command=` contains the claude
  binary). Liveness = pid alive **and not Z-state** (`ps -p <pid> -o stat=` not starting with `Z`)
  **and** signature matches — `process.kill(pid, 0)` alone is proven insufficient (defunct passes
  it). Watchdog + reconcile use it; periodic sweep finalizes any `running` row that fails the check
  (this is what retires zombie rows automatically from now on).
  - Verify: test with a recycled-pid fixture → row finalized; seeded zombie rows get swept.
- [ ] **6.1.e Boot reconcile = adopt-or-kill; heal only after, within budget.** On boot, for each
  live one-shot row: read `recording-runner.ts:71-104` (transcript self-heal) and choose — **adopt**
  (re-attach a monitor that finalizes the row + recovers the result from the transcript on exit) if
  reliable, else **kill** (SIGTERM → 5s → SIGKILL) + finalize `killed`. Either way a task never has
  an invisible live run. Run `healStuckTasks` only **after** reconcile, only for tasks with no
  live/adopted run, within the 6.1.c budget. Spawn one-shots in their own **process group**
  (`detached: true`, kill `-pid`) so claude’s children die with it.
  - Verify: integration test — boot the gateway twice with a task in `refining` → exactly **one**
    spawn total; orphan from boot #1 is adopted-or-killed at boot #2.
- [ ] **6.1.f Close the duplicate-spawn endpoints.** `/refine` goes through 6.1.b; plan-approve
  becomes idempotent (409/no-op when a chain is already active — remove the `implementing`
  back-compat double-run at `api.ts:330`); fix `ActivityTracker` keying to `(taskId, role)` with
  proper refcounting.
  - Verify: tests — double POST approve → single chain; tracker survives concurrent stages.
- [ ] **6.1.g Stuck-run UX with teeth + default timeouts.** The “A run looks stuck” path and the
  Sessions tile gain labeled actions: **View output** · **Kill run** · **Kill & retry** (budgeted).
  Default `timeoutMs` per role class (read stages 15 min; implementer/fleet 60 min; configurable in
  6.3.e) so no one-shot can run forever. Sessions view: bulk **Clear finished agent runs** action.
  - Verify: UI shows the actions on a stuck session; kill finalizes row + process group; timeout
    test fires; typecheck/build green.
- [ ] **6.1.h Re-enable + acceptance.** Restore `autonomy: true`. **Acceptance (scriptable parts
  automated, rest manual):** with the dev gateway watching, save a server file 3× with a task parked
  in `refining` → spawns ≤ budget and each new spawn first reconciles the previous; Sessions view
  shows no eternal “running” rows; `ps` after each run shows no leaked processes.
  - Verify: the acceptance run above + journal the observations.

---

## 6.2 Remove the Inbox page (nav simplification)

**Locked decision:** remove the Inbox view. Evidence: its capture input is a strict subset of the
global AddTaskModal (`web/src/features/task/AddTaskModal.tsx`, openable via sidebar button, ⌘K,
bare `c`, and the Tauri global hotkey), and `status=inbox` tasks already appear as the Board’s inbox
column. Nothing unique lives there (`web/src/features/inbox/Inbox.tsx`).

- [ ] **6.2.a Remove view + nav.** Drop `"inbox"` from `ViewId` (`web/src/App.tsx:17-28` union /
  `AppShell.tsx:37-49` nav), delete `features/inbox/`, remap any stored/default view of `inbox` →
  `board` (check persisted last-view state, ⌘K palette entries, keyboard shortcuts, Tauri tray menu
  items if any reference it). Grep for `"inbox"` view references (do NOT touch the `inbox` **task
  status** — that stays).
  - Verify: typecheck/build/tests green; grep shows no dangling view refs; app boots to a valid view
    when the previously-persisted view was `inbox`.
- [ ] **6.2.b Docs touch-up.** Note the removal in `platform-definition.md` §10/UX nav list if it
  enumerates views; one Journal line.
  - Verify: docs consistent; commit.

---

## 6.3 Settings expansion — per-agent prompts & models, formats, operations knobs

Current state: settings = JSON at `~/.cadence/settings.json` (`server/src/store/store.ts:22-68`,
shape `shared/src/index.ts:506-520`, API `api.ts:808-836`), single-page UI
(`web/src/features/settings/SettingsView.tsx`) with one global system prompt textarea. All stage
prompts are hardcoded TS template builders: triage `agents/triage.ts:33`, discovery
`agents/discovery.ts:34`, questioner `:26`, planner `:20`, implementer `:19`, fleet (reuses
implementer) `:41`, verifier `:28`, delivery `:47`, reflector `:39`, worktree-check `:22`, plus the
subagent library `agents/library.ts:16-59`. Per-role default models: `agents/runner.ts:5-22`.
**Known gap (locked decision to fix):** `composeContext` (`server/src/context.ts:26-61`) is wired
only into warm chat sessions — one-shot pipeline agents never receive the composed
global→project→fleet→task context, violating the “compose into every agent run” locked decision.

- [ ] **6.3.a Prompt registry.** New `server/src/agents/prompts.ts`: for every agent above —
  `{role, label, description, defaultModel, defaultTemplate, variables[]}`. Refactor each builder to
  render `template + vars` via a tiny `renderTemplate()` (keep `{{var}}` placeholders; document each
  agent’s variables). Include the 6 library subagents as editable entries too.
  - Verify: snapshot tests prove **byte-identical prompts** vs. before when no override is set.
- [ ] **6.3.b Override storage.** `GlobalSettings.agents?: Record<role, {prompt?, model?}>` — only
  overrides persisted; PATCH deep-merges; `getAgentConfig(role)` = override ?? default. Runner uses
  it for model resolution (replacing direct `modelForRole` calls).
  - Verify: round-trip + reset tests; an overridden model reaches the spawn args (mock runner).
- [ ] **6.3.c Settings UI restructure.** Left sub-nav sections within Settings: **General**
  (existing fields) · **Agents & Prompts** · **Formats** · **Operations**. *Agents & Prompts*: agent
  list (label, model chip, “customized” dot) → editor pane: description, variables legend (chips),
  monospace autosizing textarea, per-agent **model select** (default/haiku/sonnet/opus), labeled
  **Reset to default** with confirm, Save with unsaved-changes guard. Inline copy explains the
  difference between the **global system prompt** (context layer composed into every run — stays in
  General) and **per-agent stage templates** (the agent’s instructions).
  - Verify: edit the discovery prompt → next discovery run uses it (mock-runner test); reset
    restores default; keyboard navigable; gates green.
- [ ] **6.3.d Date/time format (Czech default).** Settings `dateTimeFormat` + `dateFormat` with
  presets — **`d.m.Y H:i:s` / `d.m.Y` (DEFAULT)**, ISO, US, System locale — plus a custom
  PHP-style token input (`d m Y H i s`) with live preview. New `web/src/lib/datetime.ts`
  (`formatDate`, `formatDateTime`; tiny token renderer, no date lib). Replace all 5 `toLocale*`
  call sites: `Board.tsx:430`, `TaskDetail.tsx:277`, `Projects.tsx:283`, `StatusTimeline.tsx:41`,
  `SessionDetail.tsx:217`. Settings reach the web app via existing GET `/api/settings` + the
  `settings:updated` WS event.
  - Verify: formatter unit tests (incl. `10.06.2026 14:05:09`); all five UI spots render the Czech
    format by default.
- [ ] **6.3.e Operations knobs.** Settings + Operations section UI (plain-language labels + help
  text): `stuckThresholdMinutes` (default 10; watchdog reads it, env var stays as override),
  `stageTimeoutMinutes` {read, implement} (wires 6.1.g), `maxStageAttemptsPer24h` (default 3; wires
  6.1.c), `maxConcurrentAgents` (default 4; enforced at spawn).
  - Verify: watchdog/budget/runner read live settings (tests); UI saves and broadcasts.
- [ ] **6.3.f Composed context for one-shot agents.** Pass `composeContext` output as
  `--append-system-prompt` to **every** pipeline stage run (`runner.ts:102` already accepts it);
  stage template remains the prompt body. Mind token economy: context layers only (no transcript
  dumps).
  - Verify: mock-runner test asserts a project systemPrompt phrase reaches a discovery and a
    delivery run; gates green.

---

## 6.4 GitHub/GitLab (forge) integration foundation

Current state: `projects.gitRemote` exists (`schema.ts:27-49`) and is detected at import
(`server/src/import.ts:14-25`) but **no forge parsing exists anywhere**; delivery already shells
`gh pr create` blindly for `auto_pr` (`agents/delivery.ts:39`); `gitRemote` isn’t editable in the
project UI. Both `gh` and `glab` may or may not be installed/authenticated — always probe, never
assume.

- [ ] **6.4.a `server/src/forge.ts`.** Parse a remote URL (ssh `git@host:owner/repo.git`, https,
  self-hosted) → `{forge: 'github'|'gitlab'|null, host, owner, repo, webUrl}`. Heuristic: host
  contains `github` → github, `gitlab` → gitlab; unknown → null + new project field
  `forgeOverride` (`'github'|'gitlab'|null`) for self-hosted instances. ⚠ test against real-world
  URL shapes.
  - Verify: unit-test matrix (gh ssh/https, gl ssh/https, self-hosted gitlab, no remote).
- [ ] **6.4.b CLI capability probe.** `gh --version` + `gh auth status` / `glab --version` +
  `glab auth status` (⚠ add `--hostname <host>` for self-hosted); capture the authenticated
  account login (needed by 6.5 direction inference). Cache in `~/.cadence/runtime.json` with a
  probedAt timestamp; `GET /api/projects/:id/forge` + a refresh endpoint.
  - Verify: probe returns `{installed, authenticated, account}` on this machine; mocked unit tests.
- [ ] **6.4.c Project UI: Repository card.** In the project edit drawer: editable **Git remote**
  field, detected forge badge (GitHub/GitLab + `owner/repo`), CLI status line (“✓ gh authenticated
  as @user” / “✗ glab not installed — `brew install glab`, then `glab auth login`”), labeled
  **Refresh** button.
  - Verify: a GitHub-remote project shows the GitHub card; a GitLab one shows glab status.
- [ ] **6.4.d Forge-aware delivery.** `auto_pr` branches by forge: `gh pr create` vs
  `glab mr create` (⚠ verify flags); parse the created PR/MR URL; persist on the task (new
  `tasks.prUrl` column + task.md frontmatter); include the link in `delivery.md` + the delivery
  summary. Graceful failure when CLI missing/unauthenticated → deliver falls back to
  `branch_summary` with a plain-language note (never hard-fail the whole delivery on a missing CLI).
  - Verify: mocked delivery tests per forge assert the right CLI + captured URL + fallback path.
- [ ] **6.4.e Surface the link.** Task detail metadata row + board card chip: **Open PR/MR**
  (labeled, external-link icon).
  - Verify: a task with `prUrl` renders the link in both spots.
- [ ] **6.4.f Forge context injection.** `composeContext` project layer gains a capability line
  (e.g. “Repo: github.com/acme/app — `gh` CLI is installed and authenticated; use it for PR/issue/CI
  operations when relevant”). Reaches every agent thanks to 6.3.f. *Tell Claude, don’t hardcode.*
  - Verify: composed context for a GitHub project contains the capability line (test).
- [ ] **6.4.g Journal future forge ideas** (no code): issue import → tasks; PR-comment → follow-up
  task; CI-failure → auto fix-task; richer review integration (6.5 consumes this foundation).
  - Verify: journal entry exists.

---

## 6.5 Code-review module  ⭐ flagship

**Why it fits:** code review is a daily job in both directions and is exactly the kind of routine
cognition Cadence delegates to autonomous Claude — while keeping the human as the editor-in-chief.

### Locked product decisions
1. **Reviews are tasks on the board — no new nav item.** One lifecycle, one place to look; digest,
   deadlines, urgency, search all apply for free. Board gets a **type filter** (segmented control
   `All · Tasks · Reviews` beside the project filter, pattern of `Board.tsx:114-222`) and review
   cards carry a **Review** badge.
2. **One task type, two directions.** `tasks.taskType: 'standard' | 'code_review'` (default
   standard) + for reviews: `reviewDirection: 'perform'` (I review someone’s PR) `| 'address'` (fix
   feedback on my PR), `reviewRef` (PR/MR URL, `#number`, or branch), `reviewState` (JSON pointer to
   workspace artifacts under the task folder). Direction is **inferred, propose-don’t-impose**: PR
   author == the authenticated CLI account (from 6.4.b) → `address`, else `perform`; shown as an
   editable chip at capture and in task detail.
3. **Two new editable agents** (registered via 6.3 registry; prompts drafted below; both default
   **opus** — review quality > token cost; user can downgrade in settings): `reviewer` and
   `review-responder`. The reviewer fans out to the existing library subagents
   (security-reviewer / convention-reviewer / test-reviewer, `agents/library.ts:16-59`) per §7.3.
4. **Publishing is ALWAYS explicit-confirm in-app** — posting reviews/comments/replies to the forge
   is outward-facing and never autonomous, regardless of permission mode. Draft-first, always.
5. **Pipeline mapping — reuse existing statuses, no new lifecycle states.**
   - *perform*: capture → triage (detects type) → `ready` → PLAY → reviewer runs (board column
     shows stage label “Reviewing…”) → findings ready → `review` = human triages findings in the
     Review Workspace → publish (or copy) → `done`.
   - *address*: capture → `ready` → PLAY → responder fetches threads + proposes per-thread actions →
     `plan_review` (the proposal IS the plan; reuse the plan-approval pattern) → approve → applies
     fixes on the PR branch (`implementing`; worktree/RW-lock rules apply as for any implementation)
     → `review` = approve replies → push + post replies/resolve (explicit confirms) → `done`.
6. **UI = Review Workspace** section inside TaskDetail for review tasks (in the PlanView/ReviewPanel
   slot) with a labeled **Expand** button → full-screen overlay (the modal is too cramped for diffs).
   Findings-centric, not a full diff IDE (wave 1).

### Sub-steps

- [ ] **6.5.a Schema + capture.** Add `taskType`, `reviewDirection`, `reviewRef`, `reviewState`,
  (+ `prUrl` exists from 6.4.d) to tasks (+ task.md frontmatter mirror + migration). Capture: pasting
  a GitHub/GitLab PR/MR URL into AddTaskModal proposes `code_review` type, infers direction (6.4.b
  account vs PR author), matches the project by remote `owner/repo` — all as editable
  propose-don’t-impose chips. Triage prompt updated to classify review tasks it recognizes.
  - Verify: paste a PR URL → proposed review task with inferred direction + matched project;
    frontmatter round-trip test.
- [ ] **6.5.b Forge review data layer.** `server/src/forge-review.ts`, one interface, two impls:
  fetch PR/MR meta + diff (`gh pr view --json …` / `gh pr diff`; `glab mr view` / `glab mr diff` ⚠
  verify flags); fetch review threads + comments (GitHub: `gh api repos/:o/:r/pulls/:n/comments` +
  reviews; thread resolution via GraphQL `resolveReviewThread` ⚠; GitLab: `glab api
  projects/:id/merge_requests/:iid/discussions`, resolve via discussion API ⚠); post a review with
  inline comments (GitHub reviews API with `comments[]`; GitLab discussions with `position` ⚠);
  reply to a thread. Everything mockable; record fixtures for tests.
  - Verify: unit tests against recorded fixtures for both forges; real-API smoke is deferred to the
    human acceptance run.
- [ ] **6.5.c Reviewer agent.** Register `reviewer` in the prompt registry (template below, adapted
  to the codebase’s variable plumbing; also append both prompts to `docs/agent-prompts.md`). Runs in
  the repo with the PR branch available (read stage → read lock per worktree rules). Output: strict
  JSON findings → persisted into `reviewState` artifacts (`review.md` + `findings.json` in the task
  folder).
  - Verify: mock run produces parseable findings rendered into artifacts; snapshot test.
- [ ] **6.5.d Review-responder agent.** Register `review-responder` (template below). Phase 1
  (propose): fetch threads → classify + propose patch/reply per thread → `plan_review`. Phase 2
  (apply, after approval): implementer-style run on the PR branch (RW lock), commits fixes, runs
  relevant tests; replies stay queued for the workspace.
  - Verify: mock proposal round-trips; apply phase commits on a fixture repo branch (test).
- [ ] **6.5.e Review Workspace UI — perform.** Header: PR title, `owner/repo`, `base ← head`,
  author, CI chip, **Open on GitHub/GitLab** link. Findings list grouped by severity — 🔴 blocker /
  🟠 major / 🟡 minor / ⚪ nit — each card: `file:line`, title, explanation, code excerpt, suggested
  patch (diff-rendered), actions **Include · Edit · Dismiss** (labeled). Footer: verdict select
  (Comment / Approve / Request changes), **Publish review** (confirm dialog lists exactly what will
  be posted, count + verdict) and **Copy as Markdown**. Empty/error states: CLI missing → guided
  setup card; no `reviewRef` → input with validation.
  - Verify: seeded findings render; include/dismiss/edit persists to `reviewState`; publish confirm
    shows the exact payload; copy-markdown output is complete; gates green.
- [ ] **6.5.f Review Workspace UI — address.** Threads pane (unresolved first; author, age,
  file:line, original comment). Per thread: classification chip (must-fix / question / preference /
  pushback), proposed diff (when code change), editable reply text, actions **Apply · Edit · Skip**.
  Footer, two explicit confirms: **Push fixes** (after apply phase) then **Post replies & resolve
  threads** (shows exact replies to be posted; resolves only threads marked resolvable).
  - Verify: seeded threads render; apply edits the branch (fixture); replies queue until confirmed;
    nothing posts without the confirm.
- [ ] **6.5.g Board + filter polish.** Type segmented control (All · Tasks · Reviews), **Review**
  badge on cards (direction-aware tooltip: “reviewing their PR” / “addressing feedback”), stage
  label “Reviewing…” while the reviewer runs.
  - Verify: filter narrows correctly; badges render; gates green.
- [ ] **6.5.h Settings: Review section.** Under the 6.3 sections: strictness (lenient / standard /
  strict → `{{strictness}}` template variable), default verdict suggestion on/off, “encourage task
  description” hint toggle (capture shows a nudge: a one-line “what should this PR do?” improves
  review quality — optional but encouraged).
  - Verify: strictness reaches the reviewer prompt (test); section renders + saves.
- [ ] **6.5.i Acceptance (human-assisted).** On a scratch repo: perform-review a real PR end-to-end
  (PLAY → findings → publish a *Comment* review with 1 included finding); address-review your own PR
  with a seeded comment (PLAY → proposal → approve → fix applied → reply posted + resolved). Confirm
  no spawn leaks (6.1 guards) during both runs. Automated parts mocked in CI; journal results.
  - Verify: both flows complete; journal entry with observations.

### Agent prompt drafts (transplant into the registry + `docs/agent-prompts.md`, adapt variables)

**`reviewer` — perform a code review** (default model: opus)

```text
You are Cadence's code-review agent. Review {{prKind}} {{reviewRef}} on {{forge}} in this
repository ({{cwd}}).

What this change is supposed to do (from the task; may be empty):
{{taskDescription}}

Strictness: {{strictness}} — lenient: blockers+majors only · standard: skip style nits a formatter
would catch · strict: include minor issues and nits.

PROCESS
1. Fetch context with {{cli}}: PR/MR title, description, linked issues, CI status, and the full diff.
2. Establish INTENT first: state in one line what the change claims to do. If you cannot tell from
   the description + task context, that is itself a major finding ("unclear intent").
3. Read the diff hunk-by-hunk — but NEVER judge a hunk in isolation: open the surrounding file, the
   callers/callees of changed symbols, and related tests. The diff is the question; the codebase is
   the context.
4. Check, in priority order:
   a. CORRECTNESS — does the implementation actually do what it claims? Edge cases, error paths,
      async/races, off-by-ones, null/undefined, broken invariants.
   b. REGRESSIONS — what existing behavior could this break? Search for every other caller/usage of
      each changed symbol before concluding.
   c. SECURITY — injection (SQL/shell/path/HTML), authn/authz gaps, secrets in code, unsafe
      deserialization, SSRF, missing validation at trust boundaries.
   d. CONVENTIONS — does it follow THIS codebase (naming, structure, error handling, test
      patterns)? Cite an existing file as evidence for the convention; never impose outside style.
   e. TESTS — are the claimed behaviors tested? Do the tests assert the right things (not merely run)?
5. ADVERSARIALLY VERIFY every candidate finding before reporting: reopen the code and try to prove
   yourself wrong. Discard anything you cannot back with a concrete failure scenario or cited
   evidence — false positives erode trust faster than missed nits.
6. For each surviving finding, propose a concrete fix (include a patch when ≤ ~15 lines).

OUTPUT — strict JSON only:
{"summary": "...", "verdict_suggestion": "approve|comment|request_changes",
 "findings": [{"severity": "blocker|major|minor|nit", "file": "...", "line": 0,
   "title": "...", "body": "...", "evidence": "...", "suggested_patch": "..."}]}
- body: plain language, reviewer-to-author tone — direct, kind, specific. Note genuinely good
  patterns in the summary. Line numbers MUST anchor to the diff; never invent them.
```

**`review-responder` — address received review feedback** (default model: opus)

```text
You are Cadence's review-response agent. {{me}} authored {{prKind}} {{reviewRef}}; reviewers left
feedback. Address it on the branch in this repository ({{cwd}}).

Unresolved threads (JSON): {{threads}}
Task context (what the PR is meant to do; may be empty): {{taskDescription}}

PROCESS
1. Read every thread fully — all comments AND the code at the anchored location (open the file;
   don't trust the snippet).
2. Classify each thread:
   - must_fix — the reviewer is right; a code change is needed.
   - question — answer it; no code change.
   - preference — cheap to satisfy → just do it; expensive → explain the trade-off.
   - pushback — the reviewer is mistaken or the change would harm the code; say why, with evidence.
   NEVER blindly comply — evaluate each comment on the merits. NEVER silently ignore one either —
   every thread gets a response.
3. Group related threads into one coherent change where natural; note the grouping.
4. For code changes: minimal, focused diffs consistent with the branch's existing approach; run the
   project's relevant tests for what you touch.
5. Draft a reply per thread: ≤3 sentences, specific ("done in <sha>", "kept as-is because …"),
   no groveling, no defensiveness.

OUTPUT — strict JSON only:
{"threads": [{"threadId": "...", "classification": "must_fix|question|preference|pushback",
  "reply": "...", "patch": "...", "resolves": true}], "overall_note": "..."}
You PROPOSE; the user approves replies and pushes before anything is posted. Never post or push
yourself.
```

---

## Progress Journal  ← append-only; newest at the bottom

- **2026-06-10 — plan authored.** Investigation evidence for 6.1 captured (15 zombie discovery rows
  on “Preserve route state on page refresh”; root cause = boot-time heal × `bun --watch` restarts ×
  in-memory-only dedupe × PID-reuse-blind liveness). Product decisions for 6.2–6.5 locked above.
- **2026-06-10 — 6.1.a data containment executed early** (user confirmed zombies in the Sessions UI,
  e.g. `c8137e54…`). Forensics: all 17 “running” one-shot rows (15× discovery on “Preserve route
  state on page refresh” spawned 22:29:12–22:31:49 the night before, 1× discovery on “Fix feedback
  answer resubmission context duplication”, 1× planner on “Markdown formatting”) pointed at
  **`<defunct>`** pids — true Unix zombies that pass `process.kill(pid, 0)`; evidence block added to
  §6.1. Actions: 17 rows → `status='failed'` + `ended_at` set (direct SQLite, sessions are not
  markdown-backed); “Markdown formatting” `implementing` → `ready` via
  `PATCH /api/tasks/:id` (planner had died mid-run; no plan artifact existed); verified **no tasks
  remain in `refining`** → heal-on-boot is currently inert. Defunct process-table entries clear when
  the dev gateway (same-PID `bun --watch`, parent of them all) is stopped. Remaining for 6.1.a
  during code work: stop gateway + `autonomy: false` + final re-verify.
- **2026-06-10 — 6.0 + 6.1.a complete.** Baseline gates green (typecheck ✓, **305 tests** ✓ — ledger
  said 226, repo moved on, snapshot was stale —, build ✓); plan committed (`f09015c`). Containment
  finished: `autonomy: false` PATCHed via live API, dev gateway (pids 94134-94137, up 2d6h) stopped —
  killing it **reaped all 17 cadence defunct entries** as predicted. Re-verified: 0 sessions rows in
  `running|spawning`; no `claude -p` / cadence dev processes. 6 unrelated defunct pids remain,
  children of the user's interactive terminal claude sessions — not ours, not actionable. The repo
  is now safe to edit freely. NOTE for 6.1.h: restart dev gateway + restore `autonomy: true` when
  6.1 code work is done; user's web UI is DOWN until then.
- **2026-06-10 — 6.1.b done** (`de021e7`). New `agents/stage-guard.ts`: `assertStageIdle` /
  `findLiveStage` with honest pid liveness (`ps stat=` Z-state check; injectable `PidProbe` for
  tests). **Decision:** single choke point = the recording runner (every task-linked one-shot flows
  through it) instead of per-call-site guards; fleet fan-out needs no exemption because it passes no
  `taskId` (fleet.ts:72) and is never recorded. **Decision:** pid-less rows get a 30s grace
  (insert→onSpawn window) so a starting sibling isn't finalized mid-launch. Stale rows are finalized
  *by the check itself* → zombie rows now retire on contact. heal pre-skips live discoveries;
  `/refine` pre-checks → 409 (before `runDiscovery` mutates status — it flips to `refining` at
  discovery.ts:149). 10 tests incl. the concurrent-race and zombie-retry cases.
- **2026-06-10 — 6.1.c done** (`cc6d3d3`). Breaker lives in heal (the only automatic respawn loop;
  capture-chain is once-per-capture by construction). **Decision:** breach reuses the standard
  `needs_feedback` transition + `notifyOnTransition` instead of a new notification kind — Attention
  Center picks it up for free, and the context note carries the “halted after N attempts” why.
  Counting = session rows of (task, role) within 24h, any outcome (budget bounds *attempts/money*,
  not successes). Replay check: with 6.1.b+c in place, the incident would have stopped at attempt
  #3 with a visible halt note instead of reaching 15. Next: 6.1.d generalizes honest liveness to
  watchdog/reconcile (the sweep that retires zombie rows nobody touches).
