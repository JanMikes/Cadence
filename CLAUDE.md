# Cadence

> *Your backlog, in flow.*

My **local, single-user daily operational center**: a task-management + autonomous-execution
platform that wraps Claude Code. I capture tasks all day; the platform triages, refines (asking me
only what it needs), and on my **PLAY** implements, verifies, and delivers — while I watch and
steer in real time. No cloud, no external API, no Docker, no other users. Everything saved locally
(SQLite + Claude Code's `~/.claude/` files).

> **Status:** 🎉 **BUILD COMPLETE** (Phases 0–5, 2026-06-07) **+ the optional Tauri desktop wrap**
> (4.7, 2026-06-09) — `Cadence.app` supervises the Bun gateway as a self-contained sidecar and hosts
> the unchanged web UI; full native shell (tray · hotkey · notifications · single-instance · autostart).
> All `[auto]` gates green. Next: a human real-Claude smoke + the one-time § Visual checklist
> ([docs/tauri-build-plan.md](docs/tauri-build-plan.md)). See [docs/build-plan.md](docs/build-plan.md)
> (build ledger) + [docs/tauri-wrap.md](docs/tauri-wrap.md).
> **Phase 6 — improvements wave 1: CODE COMPLETE (2026-06-10).** Runaway-spawn fix 🔥 (verified by a
> zero-cost live incident replay), inbox removal, settings expansion (per-agent prompts/models, Czech
> dates, ops knobs), GitHub/GitLab forge, and the ⭐ code-review module (capture inference → reviewer/
> responder agents → Review Workspace with explicit-confirm publishing). 427 tests green. Open: the
> human real-forge smoke (§6.5.i instructions in [docs/phase-6-plan.md](docs/phase-6-plan.md)).

## Read these first (in order)

1. 📄 **[docs/platform-definition.md](docs/platform-definition.md)** — the product spec: vision,
   principles, entities, context-layering, lifecycle, agent pipeline, delivery, UX. **Source of truth.**
2. ✅ **[docs/backlog.md](docs/backlog.md)** — phased build backlog / todos. We work from this.
3. 🤖 **[docs/agent-prompts.md](docs/agent-prompts.md)** — draft prompts for each pipeline stage.
4. 🔧 **[docs/claude-code-control-surfaces.md](docs/claude-code-control-surfaces.md)** — verified
   technical reference for spawning/monitoring Claude Code (binary `v2.1.165`, `~/.claude/` files).
5. 🏗️ **[docs/build-plan.md](docs/build-plan.md)** — the **build ledger**: ordered steps,
   verification, per-phase acceptance checks, and the progress journal (source of truth for *build*
   progress). 🤖 **[docs/build-prompt.md](docs/build-prompt.md)** — the idempotent bootstrap prompt a
   fresh session uses to continue the build from where it stopped.

## Entities

**Project** (organizing unit, usually a git repo + working dir) · **Fleet** (named set of projects
for multi-repo tasks) · **Task** (the core entity — tracked from capture to delivery) · **Session**
(our wrapper around a Claude Code session; task-bound or standalone, project-assigned or unassigned).

## Locked decisions

- **MVP = task core + manual spawn** (Phase 1, no autonomy). Autonomy (**triage-on-capture**) lands
  in Phase 2.
- **Feedback = structured Q&A cards + an always-on free-form context channel** on every task.
- **Delivery is per-task overridable** (`task ?? project ?? global`); default = branch + summary.
- **Layered context/prompts** (global → project → fleet → task) compose into every agent run —
  *tell Claude, don't hardcode*.
- **Agents may bail early** with "too vague / need more context" — a correct outcome, not a failure.
- **Storage = per-task markdown (content truth) + SQLite index** under `~/.cadence/`.
- **Claude Code is the workforce** — delegate routine cognition to cheap background sessions, don't
  hardcode heuristics.
- **Propose, don't impose** — Claude suggests a default + rationale everywhere; I Accept/Edit/Override.
- **App shell web-first**, Tauri-wrappable later (menubar + OS-global hotkey are additive).
- **Usage = ambient subscription-window bar** (Max-20x, no marginal $); **notifications** in-app + OS.
- **Orchestration** = app-level lifecycle + in-session **subagents** for context-isolated reading/review.
- **Daily Digest** = interactive, gamified daily-planning ritual (deadline-first); celebrates
  completion; evening recap seeds tomorrow.
- **Deadlines drive priority** — urgency = f(deadline, priority), weighed everywhere.
- **One-click terminal handoff** — copy command + "Open in iTerm2/Terminal" launch button.
- **Cadence learns** — markdown memory + Reflector + proactive proposals; self-improving, reviewable.
- **Permission modes** — Auto (default) · Manual (approve in-app) · Dangerous (skip all); per task/project/global.
- **Worktrees are opt-in per project** (`worktreesEnabled`, default off — not every repo runs from a
  fresh checkout). Off → execution runs in the project dir on a task branch, **serialized per
  project** (RW lock: one implementation at a time; read stages queue behind it; base branch
  restored after delivery). A Claude **readiness check** proposes the verdict (§9.0); Dangerous
  mode + fleet runs require worktrees.
- **Global search** — full-text (SQLite FTS5) across tasks + transcripts + memory; ⌘K palette.
- **Security (critical)** — repo is public-safe: only generic code + docs; **all task/runtime data in
  `~/.cadence/`**, secrets in the OS keychain, fictional names in examples, pre-commit secret scan. See
  platform-definition §13.

## Design north star

**Clarity over confusion.** Self-explanatory UI, plain-language states, visible system status,
keyboard-first, smooth/fast. **Icon buttons always carry a text label** — never icon-only
(platform-definition §10.1). **Propose, don't impose** — automate by default, one-click to correct
(§10.2).

## Stack

Bun · `bun:sqlite` + Drizzle (index) · per-task markdown (content) · Bun HTTP+WS gateway · React +
Vite + Tailwind + shadcn/ui + xterm.js + TanStack Query. **Web-first**, Tauri wrap optional later.
Claude control via the `claude` binary (stream-json), Agent SDK later for `canUseTool`.

## Conventions

- Keep this file short; detail lives in `docs/`. Mark technical claims ✅ verified vs ⚠️ unverified.
- Update `docs/backlog.md` as we complete items (`[ ]`→`[x]`).
