# Understanding Claude's output — interactive asks, failures, and the road to bulletproof

> Written 2026-06-10 after two live incidents (see §1). Part A documents the verified facts
> and the detection layers **shipped that day**; Part B is the proposal for the long-term
> control surface. Companion to [claude-code-control-surfaces.md](claude-code-control-surfaces.md).

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

## 4. Proposal: the long-term control surface (Part B)

The raw CLI fundamentally cannot **answer** an ask mid-run — only the Agent SDK can. The
bulletproof end-state is a phased migration, keeping the CLI path as fallback:

### B1. Adopt `@anthropic-ai/claude-agent-sdk` for one-shot stage runs
Replace `spawn("claude", ["-p", …])` in `runner.ts` with the SDK's `query()`, preserving the
`AgentRunner` interface (callers untouched, tests keep their mocks). Gains:
- **`canUseTool` wired to the existing `ApprovalRegistry`** (today scaffolded end-to-end —
  registry → REST → WS → ToolApprovalModal — but fed by nothing). Manual permission mode
  becomes real: a gated tool parks an approval card instead of stalling.
- **Questions answered in-flight, optionally**: for short asks, `canUseTool` can hold the run
  (bounded, e.g. 5 min) while the Q&A card is live; answered in time → `{behavior:"allow",
  updatedInput}` and the run continues with full context. Timeout → today's behavior (stop,
  park, resume on next run). Best of both: no lost momentum when the user is watching, no
  hang when they're not.
- `ExitPlanMode` deniable with a corrective message ("print your final JSON") — a second
  chance instead of a dead run.
- `includePartialMessages` keeps the live-streaming UI contract unchanged.

### B2. Tool-inventory awareness
Persist `system/init`'s `tools[]` (+ model, permissionMode) on the session row. Uses:
diagnostics ("this run had no Write tool"), a future settings surface for per-stage
allow/disallow lists, and drift detection — log once when an unknown tool name appears in a
`tool_use` block, so new CLI tools are noticed in days, not after an incident.

### B3. Version pinning + canary
The stream schema is internal/unversioned (control-surfaces §7). Record the binary version
from `claude --version` at gateway boot; on change, run a 1-turn canary (`-p "say hi"`)
and assert the invariants we build on (init has `tools`, result has `permission_denials`
key shape). A failed canary degrades loudly (banner: "Claude Code N.N.N changed its output
format; live question detection may be degraded") instead of silently misparsing.

### B4. Explicitly rejected
- `--permission-prompt-tool`: undocumented semantics, doesn't carry AskUserQuestion. ⚠️
- `--disallowedTools AskUserQuestion`: hides the model's need instead of surfacing it.
- Parsing the CLI's denial strings ("Answer questions?"): locale/version-fragile; the
  structured `tool_use` + `permission_denials` carry the same information reliably.
- Hosted `/v1/sessions` event names: marked unverified in control-surfaces §9.

**Sequencing**: B2/B3 are small and standalone (do anytime). B1 is the meaningful lift —
worth a phase of its own, behind a setting (`runnerBackend: "cli" | "sdk"`), with the CLI
path kept until the SDK path has survived a real week.
