# Execution-flow hardening — "a run is never silently dead"

> Captured 2026-06-09 while investigating a task stuck in **In progress** with no active
> Claude and no feedback (worktree `cadence-b24c2083`, session `5e6f628e`). Two distinct
> flaws in the autonomy execution flow; both fixed. This is the source-of-truth note for why
> the code looks the way it does.

## Flaw 1 — the Implementer stalls on a gated `git` (critical, in the flow)

**Symptom.** A task PLAYed, the plan was approved, the Implementer edited all files in its
worktree — then ended its turn with *"the git write operations are gated by this environment's
permission policy and need your approval"*. The changes were never committed and the task never
advanced past `implementing`.

**Root cause.** One-shot agent runs (`server/src/agents/runner.ts → runAgent`) spawn
`claude -p <prompt> --permission-mode <mode>` and read the JSON result. **They do not wire
`canUseTool`** — that (the `ApprovalRegistry` → in-app approve/deny) exists **only for warm
interactive sessions** (`SpawnManager`). So for the one-shot Implementer:

| Resolved mode | `--permission-mode` | File edits | `git`/Bash |
|---|---|---|---|
| Auto (default) | `acceptEdits` | auto-approved | **gated → asks → no channel → stalls** |
| Manual | `default` | asks → stalls | asks → stalls |
| Dangerous | `bypassPermissions` | allowed | allowed |

The Implementer's prompt tells it to *"make focused commits"*, but under `acceptEdits` it
**can't** — and a one-shot has nobody to ask. The run dies without committing. The per-tool
Manual approval was never the autonomy gate anyway: the human gates in this flow are **plan
approval** (before implementing) and **review/merge** (before it lands). Per-tool gating just
makes the sandboxed implementer stall invisibly.

**Fix (`server/src/agents/implementer.ts`).** The Implementer runs in an **isolated, disposable
git worktree** — that sandbox *is* the safety boundary. So when a worktree is provisioned, run it
with `bypassPermissions` (full tool access: edit, commit, build, test) regardless of Auto/Manual.
`apply_in_place` (no worktree) keeps the safer resolved mode and the existing Dangerous guardrail
(bypass requires a worktree) still holds.

**Fix (`server/src/agents/delivery.ts`) — safety net.** Delivery now *deterministically* commits
any remaining working-tree changes to the task branch (`git add -A && git commit`, run as a direct
subprocess — never gated like an agent tool call), for `branch_summary`/`auto_pr`. So the branch is
always real even if the Implementer left changes uncommitted, and pre-existing focused commits are
preserved (the commit is skipped when the tree is clean).

## Flaw 2 — orphaned runs left tasks silently in "In progress"

**Symptom (the same incident).** The gateway had restarted while the Implementer run was in
flight. The session row stayed `status=running, ended_at=null` forever (a second `chat` session
too); the task stayed `implementing`. No spinner (the `ActivityTracker` is in-memory, wiped on
restart), no notification, no recovery — invisible limbo.

**Fix — `server/src/watchdog.ts` (three layers, deterministic, no agent spawn):**

1. **`reconcileOrphans`** (startup, runs **regardless of autonomy**): every session still
   `running`/`spawning` from a previous process is dead → end it; any task stranded in
   `implementing`/`verifying` is rescued to a visible, actionable state — **Review** if the
   worktree has changes, **Plan review** if a plan exists, else **Ready** — with a context note +
   notification.
2. **`startSessionWatchdog`** (every 60s): a session whose **process died** (pid gone) → end +
   rescue task; a session **idle too long** (no transcript write past `CADENCE_SESSION_STUCK_MS`,
   default 10 min) → a one-time "looks stuck — check it" nudge (not killed — a long build can look
   idle).
3. **Stalled surfacing** (`/api/attention` + Board): any `implementing`/`verifying` task with no
   live run (and not just dispatched) shows a red **⚠ Stalled** badge and a top-priority item in
   the "needs you" pill — the safety net for any failure mode between watchdog ticks.

**Invariant established:** a task in an active-work state always has *either* a live run (spinner)
*or* a surfaced "needs you" reason. Never silent limbo.

## Residual / follow-ups

- **Manual mode + the one-shot autonomy chain.** Manual is honored for *warm* sessions
  (`canUseTool` parks → Attention Center). The one-shot Implementer in a worktree now uses
  `bypassPermissions`; the human checkpoints are plan-approval + review/merge. If true per-tool
  approval is ever wanted for the autonomy chain, wire `canUseTool` into `runAgent` (Agent SDK) and
  route to the same `ApprovalRegistry`.
- **`apply_in_place`** never bypasses the main tree and won't make commits; its changes stay in the
  working tree by design. The Implementer prompt's "make commits" line is a no-op there.
- **One-shot pid.** The recording runner doesn't store a pid for one-shot runs, so the watchdog
  can't *kill* a hung one-shot (only surface it). Storing the child pid would let us terminate hung
  runs — a worthwhile follow-up.
