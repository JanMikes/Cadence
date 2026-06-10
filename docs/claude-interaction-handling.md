# Understanding Claude's output — interactive asks, failures, and the road to bulletproof

> Written 2026-06-10 after two live incidents (see §1). Part A documents the verified facts
> and the detection layers shipped that day; **Part B (the Agent-SDK ask-gate) shipped the
> same day** — see §5 for what's now live and how the layers compose. Companion to
> [claude-code-control-surfaces.md](claude-code-control-surfaces.md).

## 1. The incidents (what "poor question detection" actually was)

Both failures shared one root cause: **one-shot stage runs spawn `claude -p` with stdin
ignored, so the model has no human and no channel** — yet nothing detected when it tried to
reach one.

- **Planner** (task "delete/cancel task from board"): the agent called **`AskUserQuestion`**
  with two fully-structured questions (placement of the button, confirmation strength). The
  CLI auto-denied it (`tool_result is_error:true, content:"Answer questions?"`), the run hung,
  the gateway restart killed it, the watchdog moved the task back to Ready — and the user
  never saw the questions. The board card meanwhile showed a stale "Planning…" (status-derived,
  not run-derived) and a generic "Working…" spinner.
- **Discovery** (task "Show remaining time in Claude usage display"): in plan permission mode
  the agent behaved like an interactive plan session — wrote `~/.claude/plans/…` and called
  **`ExitPlanMode`** (auto-denied: `"Exit plan mode?"`), exited with no result text. The UI
  said only "discovery failed"; stderr/exit detail lived in a `console.warn` nobody sees.

## 2. Verified facts about headless `claude -p` (binary v2.1.x, 2026-06-10)

| Fact | Status |
|---|---|
| `AskUserQuestion` / `ExitPlanMode` in `-p` mode are **auto-denied**: `tool_result` with `is_error:true`, content `"Answer questions?"` / `"Exit plan mode?"`. The run may continue in degraded prose, exit empty, or hang. | ✅ verified live + incident transcripts |
| The full ask payload (questions, options, multiSelect / the drafted plan) is visible **in real time** in the `assistant` event's `tool_use` block — before the denial. | ✅ verified |
| The final `result` event carries **`permission_denials: [{tool_name, tool_use_id, tool_input}]`** — every denied tool call, by name, with input. | ✅ verified live |
| The `system/init` event carries **`tools: string[]`** — the complete tool inventory of the session (incl. `mcp__server__tool` names). | ✅ verified live |
| `--disallowedTools "AskUserQuestion" "ExitPlanMode"` removes the tools from the model's surface entirely. | ✅ verified (not used — see §3 "allow + intercept") |
| `--permission-prompt-tool <mcp tool>` exists but does **not** route AskUserQuestion; semantics undocumented. | ⚠️ do not build on it |
| Agent SDK `canUseTool(toolName, input)` fires mid-stream for AskUserQuestion / ExitPlanMode / any permission-gated tool and can return `{behavior:"allow", updatedInput}` or `{behavior:"deny", message}` — the supported way to answer programmatically. | ✅ documented (docs: agent-sdk/user-input.md, agent-sdk/permissions.md) |

## 3. Shipped: layered detection on the raw CLI (Part A)

Design principle: **allow + intercept**, not disable. The model deciding to ask is signal we
want; we catch the ask and route it to the user instead of letting it dead-end. Four layers:

1. **Prevention** — every one-shot gets a standing `NON_INTERACTIVE_CONTRACT` appended to its
   system prompt (`runner.ts`): no human is present; put open questions in the final JSON.
   This fights plan-mode's own nudging toward `ExitPlanMode`.
2. **Live interception** (`runner.ts`) — the stream watcher scans `assistant` `tool_use`
   blocks for the known interactive tools (`INTERACTIVE_TOOLS`). On sight: the run is stopped
   immediately (we already hold the full payload; everything after is wasted tokens or a
   hang) and the ask is returned on `AgentResult.asks`.
3. **Name-agnostic catch-all** (`runner.ts`) — `result.permission_denials` is merged into
   `asks` for **any** denied tool, by name we've never seen. A future interactive tool that
   slips past layer 2 still surfaces, just post-run instead of instantly. This is the
   forward-compatibility guarantee: detection degrades from "instant" to "at run end",
   never to "invisible".
4. **Uniform surfacing** (`interactive.ts` + `recording-runner.ts`) — any ask becomes the
   things Cadence already knows: AskUserQuestion payloads convert 1:1 into **Q&A cards**
   (qa.md; options→single/multi choice, header→why), a context note says what happened, the
   task parks in **Needs input**, a role-titled notification fires, the session row reads
   `awaiting_feedback`, the run report reads `needs_input` (amber, not red). Answers land on
   the context channel and feed the next run — the existing answer→Ready→PLAY loop closes it.
   Every stage caller (triage/discovery/questioner/planner/implementer/verifier) recognizes
   `askedUser` and stands down its generic failure recovery so it can't bury the questions.

Failure honesty shipped alongside: `AgentResult.errorDetail` (stderr tail / exit code)
flows into run reports and failure notes ("no parseable JSON — \<why\>"), the Plan panel shows
"Planning…" only while a Planner run is **verifiably alive** (activity feed, not status), and
Needs-input tasks have a one-click **Refine again**.

### Compatibility posture (both directions)

- **Backward**: nothing here requires new CLI behavior — `tool_use` blocks and exit codes
  exist on all v2 binaries; `permission_denials` absence just means layer 3 contributes
  nothing.
- **Forward**: zero hardcoded tool-name dependence for *failure* detection (layer 3 + the
  empty-output/`is_error` checks); the only name list (`INTERACTIVE_TOOLS`) is a fast-path
  optimization, safe to extend, harmless when stale. Event parsing stays tolerant
  (`ClaudeEvent {type:string, …}`, unknown lines skipped) per the unversioned-schema rule.

## 4. Part B as proposed (historical) — and what shipped

The raw CLI fundamentally cannot **answer** an ask mid-run — only the Agent SDK can. B1
(SDK migration with a live ask-gate) and the B4 rejections shipped 2026-06-10 (see §5).
B2 (persist `system/init`'s `tools[]` on the session row for drift detection) and B3
(version canary at boot) remain open, lower-stakes now that the SDK pins its own bundled
Claude Code version per release.

### Explicitly rejected (B4)
- `--permission-prompt-tool`: undocumented semantics, doesn't carry AskUserQuestion. ⚠️
- `--disallowedTools AskUserQuestion`: hides the model's need instead of surfacing it.
- Parsing the CLI's denial strings ("Answer questions?"): locale/version-fragile; the
  structured `tool_use` + `permission_denials` carry the same information reliably.
- Hosted `/v1/sessions` event names: marked unverified in control-surfaces §9.

## 5. Shipped: the SDK ask-gate (Part B live, 2026-06-10)

Why prompts alone were never enough: the non-interactive contract is appended at the runner
layer (user prompt layers can't remove it), but any instruction is advisory — the model can
ignore it. The hard guarantee is the **tool-permission layer**: with the Agent SDK
(`@anthropic-ai/claude-agent-sdk@0.3.x`, verified against its `sdk.d.ts`), every gated tool
call MUST pass through the `canUseTool` callback before executing. No prompt wording can
route around it.

What runs now (`runnerBackend()` default `"sdk"`, override via Settings → Operations or
`CADENCE_RUNNER_BACKEND`; automatic CLI fallback when the SDK can't start —
`SdkUnavailableError`):

- **`sdk-runner.ts`** — `query()` with the same `AgentRunner` contract: forced `sessionId`
  (deterministic transcripts), `systemPrompt` preset+append, `agents` subagents, message
  shapes identical to the CLI stream so every consumer (live transcript, recording,
  watchdog) is untouched. The stage timeout's clock **pauses while an ask waits** on the
  user.
- **`ask-gate.ts`** — `AskUserQuestion` parks in the `ApprovalRegistry` → top-urgency
  attention item + notification → the run WAITS (it is not killed). The user answers in the
  **ToolApprovalModal** (real radio/checkbox/free-text form) → answers return as
  `{behavior:"allow", updatedInput:{questions, answers}}` (the SDK's verified contract) →
  **the run continues with the answers**, which are also persisted to qa.md + the context
  channel. Timeout (`askWaitMinutes`, default 10) or "Skip" → deny with "proceed on stated
  assumptions"; the parked card is withdrawn so the UI never shows a stale ask.
- **`ExitPlanMode`** → corrective deny ("print your final output") — the run stays alive and
  recovers, instead of dying like the discovery incident.
- **Manual permission mode is real now**: any other gated tool routes to the approve/deny
  modal — the previously-orphaned ApprovalRegistry → REST → WS → modal chain is fed.
- **Liveness without a pid**: the SDK doesn't expose its child's pid, so `liveness.ts` keeps
  an in-process run registry (sessionId → abort handle). Stage-guard dedupe, the watchdog,
  the sessions UI, and Stop/Kill all consult it; a gateway crash empties it, so boot
  reconcile treats SDK rows like any orphan.
- **Success-first outcomes**: a run that produced usable output stands even if an ask timed
  out (the miss is noted on the context channel); only a run with nothing usable turns its
  asks into Q&A cards + Needs-input.
- **Billing: subscription, verified.** The SDK's bundled Claude Code authenticates exactly
  like the terminal `claude` — the stored subscription OAuth in `~/.claude`/keychain. Live
  check 2026-06-10: a real SDK run reported `apiKeySource: "none"` (the per-run
  `total_cost_usd` is the notional API-equivalent figure, not a charge). Guard: every claude
  subprocess (CLI, SDK, warm chats) gets its env via `claude-env.ts`, which strips a stray
  `ANTHROPIC_API_KEY` so nothing can silently flip runs to pay-per-token API billing
  (explicit opt-in: `CADENCE_ALLOW_API_BILLING=1`).

Layer map after this wave:
| Layer | Mechanism | Guarantee |
|---|---|---|
| 1 Prevention | system-prompt contract (per backend) | soft — model may ignore |
| 2 Live answer | SDK `canUseTool` ask-gate | **hard** — in the tool-call path |
| 3 Live interception (CLI fallback) | `tool_use` watch + kill | hard for known tools |
| 4 Catch-all | `result.permission_denials` | name-agnostic, any backend |
| 5 Surfacing | Q&A cards / approval modal / context notes / run reports | nothing invisible |
