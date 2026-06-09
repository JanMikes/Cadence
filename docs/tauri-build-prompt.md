# Cadence — Tauri Wrap Bootstrap Prompt (autonomous `/loop`)

Run the block below in a Claude Code session started in the repo root (`/Users/janmikes/www/cadence`),
wrapped in the `/loop` skill so it runs to completion unattended. It is **idempotent, self-healing, and
resumable from any point**: each iteration re-derives the true state from git + the filesystem + the
verification suites, does exactly one *verified* step, commits it, updates the ledger
([`tauri-build-plan.md`](tauri-build-plan.md)), and continues — until the whole wrap is built or it hits a
real blocker.

**Exact invocation (copy this):**

```text
/loop Continue building the Cadence Tauri desktop wrap, fully autonomously, per docs/tauri-build-prompt.md and docs/tauri-build-plan.md. Each iteration: ORIENT → RECONCILE (reality wins) → pick the FIRST unchecked/regressed step in docs/tauri-build-plan.md → implement ONE step → VERIFY (run its Verify line + all gates; self-repair up to 3 attempts) → COMMIT build(4.7.<stage>.<step>) → RECORD (check box, journal, update snapshot) → continue. [auto] steps must pass before checking the box; for [visual] steps, pass the automated criteria then append the item to "§ Visual smoke checklist" without waiting. Do NOT push. STOP only when every stage is done (print "🎉 TAURI WRAP COMPLETE" + the visual checklist) or a step can't be made to pass after 3 attempts (write a precise Blocker to the journal and stop). Run docs/tauri-build-prompt.md now.
```

Recommended permission mode: `acceptEdits` (it edits + commits locally + runs builds). It will install the
Rust toolchain + Tauri CLI on first run if missing. It commits locally and never pushes.

---

```text
You are an autonomous, self-healing build agent for the **Cadence Tauri desktop wrap**. You are in the
Cadence git repo. CONTINUE the wrap from wherever the last iteration stopped, ONE verified step at a time.
This prompt is IDEMPOTENT and RESUMABLE: a fresh run must reconstruct state from the repo and never redo
completed work, never fake a pass, never leave a half-built tree.

STEP 1 — ORIENT. Read in full: CLAUDE.md; docs/platform-definition.md (spec / behavior source of truth);
docs/build-plan.md (the main build ledger; 4.7 is the item being re-opened); docs/tauri-build-plan.md (the
TAURI LEDGER — stages, steps, Verify lines, verification tiers, the autonomy/self-healing contract, the
§ Visual smoke checklist, and the Progress Journal). The Tauri ledger is the source of truth for steps.

STEP 2 — RECONCILE (reality wins over the ledger).
- git status; git log --oneline -n 20 (each step is one `build(4.7.<stage>.<step>): …` commit).
- If git status is DIRTY: FIRST separate PRE-EXISTING changes you did not make (any file unrelated to the
  current Tauri step — e.g. server/web work already in progress) from changes left by an interrupted Tauri
  step. LEAVE pre-existing changes entirely alone — never stage, commit, restore, or delete a file you didn't
  touch for the current step. For an interrupted Tauri step ONLY: if its changes form a COMPLETE, verifying
  step → finish-verify-commit it; if partial → revert ONLY those specific files (`git checkout -- <file>` or
  delete the specific new file) and redo. NEVER run a blanket `git clean -fd` or `git restore .` — it could
  destroy unrelated work. If you can't tell what's pre-existing vs. yours, STOP and ask rather than guess.
- Re-run the cheap checks for recently-"done" steps: `bun test`; if `src-tauri/` exists, `cargo build` (and
  `cargo test` if it has tests). If a step marked [x] no longer verifies (regression), UN-CHECK it and treat
  it as the next step to fix. If the ledger and repo disagree, FIX the ledger and commit `chore(ledger): reconcile`.

STEP 3 — SELECT the FIRST unchecked (or just-regressed) step in the lowest incomplete stage in
docs/tauri-build-plan.md, respecting order + dependencies. If every step is checked AND every [auto] check is
green, go to DONE.

STEP 4 — IMPLEMENT exactly ONE step. Small, focused diff matching repo conventions (Bun/TS for server/web;
thin Rust under src-tauri). Put Rust logic that can be tested behind pure fns + `#[cfg(test)]` mock-runtime
tests. For server/web changes, add/extend `bun test`. Honor the spec's UX rules and security boundary
(below). Special cases:
- Step 0.1 (toolchain): idempotent ensure — skip what's present; if rust/cargo missing, install non-interactively
  (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y` then source ~/.cargo/env); if the
  Tauri CLI is missing, `bun add -d @tauri-apps/cli`; if Xcode CLT is missing, that needs a human GUI install —
  write a Blocker (`xcode-select --install`) and STOP. (git works here, so CLT is almost certainly present.)

STEP 5 — VERIFY (mandatory; tiered; self-healing).
- Run the step's "Verify" line AND the relevant gates: every TS change keeps `bun test` + `bun run build`
  green; every Rust change keeps `cargo build` + `cargo test` green. Run the smokes when the step names them
  (`bun run sidecar:smoke`, `bun run app:smoke`).
- [auto] step: it MUST pass before you check the box.
- [visual] step: pass the AUTOMATED criteria (cargo test / smokes / bun test), then APPEND a concrete line to
  "§ Visual smoke checklist" in the ledger describing what a human should see. Do NOT wait for a human.
- SELF-REPAIR: on failure, read the actual error and attempt up to 3 focused fixes, re-verifying each time. If
  still failing after 3, go to STOP-BLOCKER. Never check an unverified box; never weaken a test to make it pass.

STEP 6 — COMMIT only this step: write the message to a temp file and `git commit -F` (messages contain
backticks). Format: `build(4.7.<stage>.<step>): <summary>`. Do NOT push. Keep build artifacts
(src-tauri/target, binaries, resources, gen) gitignored.

STEP 7 — RECORD in docs/tauri-build-plan.md: check the step's box (or mark [~] only if mid-stage and you must
stop); append a Progress Journal entry (date, stage.step, what you did, decisions, deviations, notes for the
next iteration); update the Status snapshot (current stage, last completed, next step, blockers, last-updated).
Commit the ledger update (may be folded into the step commit).

STEP 8 — CONTINUE to STEP 2 for the next step. Cross stage boundaries freely — do NOT stop just because a
stage finished; this loop runs to completion.

DONE — when every step in every stage is checked and every [auto] check is green: ensure docs/build-plan.md
4.7 is flipped to done, docs/backlog.md + CLAUDE.md Status updated, then PRINT "🎉 TAURI WRAP COMPLETE",
print the full "§ Visual smoke checklist", and STOP the loop. Everything must be committed.

STOP-BLOCKER — when a step can't be made to pass after 3 attempts, or a product decision is genuinely
ambiguous, or the toolchain truly can't be installed: write a PRECISE Blocker to the Progress Journal
(symptom, exact last error, what you tried, 2-3 hypotheses, the exact next action) + update the Status
snapshot, ensure ALL work is committed (or cleanly reverted), print a short handoff, and STOP. Never guess a
product decision; never thrash.

HARD RULES: idempotent + reconcile-first; reality (repo/tests) beats the ledger; one step ≈ one commit; never
check an unverified box; never fake/weaken verification; keep all gates green at every commit; keep the
working tree clean across stops (commit complete steps, revert partial ones). The webview must keep loading
the UI from the gateway origin (no frontend rewrite); web bridges to Tauri APIs must be feature-detected
(`window.__TAURI__`) so the plain browser build is unchanged.

SECURITY (critical): repo is PUBLIC-safe — generic code + docs ONLY. NEVER commit secrets, credentials, .env
files, signing identities/certificates, or confidential/client data. ALL runtime data lives in ~/.cadence/,
never in the repo. Use fictional placeholder names only. Scan every diff before committing and REFUSE a
commit containing a secret or real client identifier (the repo's pre-commit hook also guards this).

Begin at STEP 1 now.
```

---

## Why this is autonomous, self-healing, and resumable
- **Durable state lives in the repo, not the chat.** The Tauri ledger + git history hold all progress; each
  iteration rebuilds context by reading them and re-running the verification suites.
- **Reality wins.** The agent re-derives truth from `git log` + files + `bun test`/`cargo build`/smokes, so a
  stale or hand-edited ledger (or a regression) self-corrects; a `[x]` step that stops verifying is un-checked
  and fixed.
- **Crash-safe at any point.** Steps are atomic and committed only when green. An interruption loses at most
  the current uncommitted step; on resume a dirty tree is either finished-and-committed or reverted and redone.
- **Self-repair, bounded.** Up to 3 fix attempts per step, then a precise Blocker + clean stop — no thrashing,
  no fake passes.
- **macOS-honest verification.** Because macOS has no WKWebView WebDriver, the loop verifies all *logic*
  (`bun test` + `cargo test` mock runtime) and all *integration it can* (process/HTTP/filesystem smokes:
  `sidecar:smoke`, `app:smoke`), and defers only irreducible *visual/OS* confirmations to the non-blocking
  § Visual smoke checklist it hands you at the end.

> Same model Cadence uses for its own tasks (markdown = truth · reconcile · verify · deliver) — now pointed at
> building Cadence's own desktop shell.
