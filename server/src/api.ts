import { existsSync } from "node:fs";
import {
  type AgentPromptInfo,
  APP_NAME,
  type AppendContextInput,
  type AttentionItem,
  type AttentionResponse,
  type CommitDigestInput,
  type CreateFleetInput,
  type CreateProjectInput,
  type CreateRecurringInput,
  type CreateSavedSearchInput,
  type CreateSuggestionInput,
  type CreateTaskInput,
  type HealthStatus,
  parseTimeOfDay,
  PERMISSION_MODES,
  RECURRING_CADENCES,
  type PrRef,
  type ProjectForgeStatus,
  type RecapDigestInput,
  type ReviewInspectResult,
  type ResolveSuggestionInput,
  type ReviewActionInput,
  SCHEMA_VERSION,
  type SessionDetail,
  type SpawnSessionInput,
  type UpdateFleetInput,
  type UpdateProjectInput,
  type UpdateRecurringInput,
  type UpdateSessionInput,
  type UpdateTaskInput,
} from "@cadence/shared";
import { runDelivery } from "./agents/delivery";
import { ActivityTracker } from "./activity";
import { runDiscovery } from "./agents/discovery";
import { runFleetImplementer } from "./agents/fleet";
import { runImplementer } from "./agents/implementer";
import { approvePlan, runPlanner } from "./agents/planner";
import { runReflector } from "./agents/reflector";
import { AGENT_PROMPTS } from "./agents/prompts";
import { findLiveStage, StageConflictError } from "./agents/stage-guard";
import { inferDirection, lookupPrAuthor, parsePrUrl, parseRemote, probeCli, projectForgeStatus } from "./forge";
import { type ForgeReviewApi, forgeReviewApi } from "./forge-review";
import { runReviewer } from "./agents/reviewer";
import { runReviewResponderApply, runReviewResponderPropose } from "./agents/review-responder";
import { finalizeReviewBranch, prepareReviewBranch } from "./review-branch";
import { runVerifier } from "./agents/verifier";
import { answerQuestions, runQuestioner } from "./agents/questioner";
import {
  type AgentRunner,
  applyTriageProjectAnswer,
  runTriage,
  TRIAGE_PROJECT_QUESTION_ID,
} from "./agents/triage";
import { computeAnalytics } from "./analytics";
import { type ApprovalDecision, ApprovalRegistry } from "./approvals";
import { composeContext } from "./context";
import { addDependency, getDeps, getSubtasks, removeDependency } from "./deps";
import type { Db } from "./db/client";
import { searchTaskHits } from "./db/search";
import { commitDigest, getDigest, recapDigest } from "./digest";
import { listTaskEvents, recordEvent } from "./events";
import { checkTaskGitContext } from "./git-context";
import { projectLocks } from "./project-locks";
import { clearExecutionState, executionLockTarget, taskWorkEvidence } from "./worktree";
import { runWorktreeCheck } from "./agents/worktree-check";
import { createFleet, getFleet, getFleetById, listFleets, updateFleet } from "./fleets";
import { importProjects, scanClaudeProjects } from "./import";
import {
  listLearnedEntries,
  listMemoryFiles,
  readProjectMemory,
  revertLearnedEntry,
  writeMemoryFile,
  writeProjectMemory,
} from "./memory";
import {
  createRecurring,
  deleteRecurring,
  getRecurring,
  listRecurring,
  triggerRecurring,
  updateRecurring,
} from "./recurring";
import { createSavedSearch, deleteSavedSearch, listSavedSearches } from "./searches";
import { buildProposals } from "./proposals";
import { computeSelfMonitor } from "./selfmonitor";
import { runSweep } from "./sweep";
import { searchTranscripts } from "./transcript-search";
import { allowedTransitions, canTransition, isValidStatus } from "./lifecycle";
import { notifyOnTransition, notifyWorktreeCheck } from "./notify";
import { mergeTask, taskDiff } from "./review";
import {
  createProject,
  getProject,
  getProjectById,
  listProjects,
  resolveProjectAutonomy,
  updateProject,
} from "./projects";
import {
  appendContext,
  applyClaudeBinEnv,
  attachmentPath,
  deleteAttachment,
  deleteRecurringAttachment,
  listAttachments,
  listRecurringAttachments,
  readContext,
  recurringAttachmentPath,
  saveAttachment,
  saveRecurringAttachment,
  readDelivery,
  readPlan,
  readQa,
  readReviewFindings,
  readReviewProposal,
  readRunReports,
  readSettings,
  readVerify,
  writeReviewFindings,
  writeReviewProposal,
  writeSettings,
} from "./store/store";
import {
  clearFinishedOneshots,
  deleteSession,
  endSession,
  getSession,
  isProcessAlive,
  listSessions,
  listTaskSessions,
  recordTranscriptPath,
  sessionRunState,
  signalSession,
  type SpawnManager,
  updateSession,
} from "./sessions";
import { createSuggestion, listSuggestions, resolveSuggestion } from "./suggestions";
import { buildResumeCommand } from "./terminal";
import { readLiveSessions, readTranscript, resolveTranscriptPath } from "./transcripts";
import { fetchClaudeWindows, readUsageStats } from "./usage";
import {
  createTask,
  getTask,
  getTaskDetail,
  listTasks,
  resolvePermissionMode,
  resolveTaskCwd,
  updateTask,
} from "./tasks";
import type { WsHub } from "./ws";

export interface ApiContext {
  db: Db;
  hub: WsHub;
  spawn: SpawnManager;
  /** Tracks in-flight autonomy work so the UI can show a spinner (injectable for tests). */
  activity: ActivityTracker;
  /** Launch a terminal app running `command` (injectable for tests). */
  openTerminal: (app: string, command: string) => void;
  /** Enrich an import candidate via a one-shot claude (injectable for tests). */
  enrich: (cwd: string) => Promise<import("@cadence/shared").EnrichResult>;
  /** One-shot agent runner (injectable for tests; default real claude). */
  runAgent: AgentRunner;
  /** In-app tool-approval registry (Manual mode, §9.1). */
  approvals: ApprovalRegistry;
  /** PR/MR author lookup for review-direction inference (injectable; default = CLI, 6.5.a). */
  prAuthor?: (ref: PrRef) => string | null;
  /** Forge review data layer factory (injectable for tests; default = real CLIs, 6.5.b). */
  reviewApi?: (forge: "github" | "gitlab") => ForgeReviewApi;
}

/** Handle a REST request under /api/*. Always returns a Response. */
export async function handleApi(req: Request, url: URL, ctx: ApiContext): Promise<Response> {
  const { pathname } = url;
  const method = req.method;

  if (pathname === "/api/health" && method === "GET") {
    return Response.json({ ok: true, app: APP_NAME, version: SCHEMA_VERSION } satisfies HealthStatus);
  }

  if (pathname === "/api/tasks") {
    if (method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      const sort = url.searchParams.get("sort") === "urgency" ? "urgency" : undefined;
      return Response.json(listTasks(ctx.db, { status, sort }));
    }
    if (method === "POST") {
      let input: CreateTaskInput;
      try {
        input = (await req.json()) as CreateTaskInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      // Description-first capture: the body is the primary field; an empty title
      // is fine (one gets derived now and properly named by the triage agent).
      const title = typeof input?.title === "string" ? input.title.trim() : "";
      const body = typeof input?.body === "string" ? input.body.trim() : "";
      if (!title && !body) return badRequest("a description (or title) is required");

      const reviewCapture =
        input.taskType === "code_review"
          ? {
              taskType: "code_review" as const,
              reviewDirection: input.reviewDirection === "address" ? "address" : "perform",
              reviewRef: typeof input.reviewRef === "string" ? input.reviewRef : undefined,
            }
          : {};

      // Capture-time explicit fields. Key presence = the user pinned the field
      // (even to null/None) — triage must never override a pinned field.
      if ("priority" in input && !/^P[0-3]$/.test(String(input.priority))) {
        return badRequest("priority must be P0..P3");
      }
      if ("deadline" in input && input.deadline !== null && typeof input.deadline !== "number") {
        return badRequest("deadline must be epoch ms or null");
      }
      if ("permissionMode" in input && !PERMISSION_MODES.includes(input.permissionMode as never)) {
        return badRequest(`permissionMode must be one of ${PERMISSION_MODES.join("|")}`);
      }
      if ("project" in input && input.project !== null && (typeof input.project !== "string" || !input.project)) {
        return badRequest("project must be a slug or null");
      }
      if ("parentTask" in input) {
        if (typeof input.parentTask !== "string" || !getTask(ctx.db, input.parentTask)) {
          return badRequest("parentTask: no such task");
        }
      }
      if ("blockedBy" in input) {
        const ids = input.blockedBy;
        if (!Array.isArray(ids) || ids.some((b) => typeof b !== "string")) {
          return badRequest("blockedBy must be an array of task ids");
        }
        const missing = ids.find((b) => !getTask(ctx.db, b));
        if (missing) return badRequest(`blockedBy: no such task ${missing}`);
      }
      const fixedFields = (["project", "priority", "deadline"] as const).filter((f) => f in input);

      const task = createTask(ctx.db, {
        title: title || undefined,
        body: body || undefined,
        ...reviewCapture,
        ...(input.project ? { project: input.project } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(typeof input.deadline === "number" ? { deadline: input.deadline } : {}),
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
        ...(typeof input.fleet === "string" && input.fleet ? { fleet: input.fleet } : {}),
        ...(typeof input.parentTask === "string" ? { parentTask: input.parentTask } : {}),
        ...(Array.isArray(input.blockedBy) && input.blockedBy.length ? { blockedBy: input.blockedBy } : {}),
        ...(fixedFields.length ? { fixedFields } : {}),
      });
      ctx.hub.broadcast({ type: "event", name: "task:created", payload: task.id });
      maybeTriageOnCapture(ctx, task.id); // background; no-op unless autonomy is on
      return Response.json(task, { status: 201 });
    }
    return methodNotAllowed();
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const id = taskMatch[1] as string;
    if (method === "GET") {
      const detail = getTaskDetail(ctx.db, id);
      return detail ? Response.json(detail) : notFound(pathname);
    }
    if (method === "PATCH") {
      let patch: UpdateTaskInput;
      try {
        patch = (await req.json()) as UpdateTaskInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (typeof patch?.title === "string" && !patch.title.trim()) {
        return badRequest("title cannot be blank");
      }
      const before = getTask(ctx.db, id);
      if (!before) return notFound(pathname);
      // Enforce the lifecycle state machine (spec §6) on status changes.
      if (typeof patch.status === "string" && patch.status !== before.status) {
        if (!isValidStatus(patch.status)) return badRequest(`unknown status "${patch.status}"`);
        if (!canTransition(before.status, patch.status)) {
          return conflict(`cannot move from ${before.status} to ${patch.status}`, {
            from: before.status,
            to: patch.status,
            allowed: allowedTransitions(before.status),
          });
        }
      }
      const updated = updateTask(ctx.db, id, patch);
      if (!updated) return notFound(pathname);
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: updated.id });
      notifyOnTransition(ctx.hub, before?.status, updated);
      return Response.json(updated);
    }
    return methodNotAllowed();
  }

  const playMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/play$/);
  if (playMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = playMatch[1] as string;
    const task = getTask(ctx.db, taskId);
    if (!task) return notFound(pathname);
    // PLAY is the human gate (§6): only a Ready task can start executing.
    if (task.status !== "ready") {
      return conflict(`PLAY requires a Ready task (currently ${task.status})`, { status: task.status });
    }
    const updated = updateTask(ctx.db, taskId, { status: "implementing" });
    if (!updated) return notFound(pathname);
    ctx.hub.broadcast({ type: "event", name: "task:play", payload: taskId });
    ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    notifyOnTransition(ctx.hub, "ready", updated);
    // Review tasks (§6.5) route to their own agents instead of the planner chain:
    // perform → reviewer (findings → review); address → responder propose (→ plan_review).
    if (task.taskType === "code_review") {
      const direction = task.reviewDirection === "address" ? "address" : "perform";
      const role = direction === "perform" ? "reviewer" : "review_responder";
      void ctx.activity
        .track(taskId, role, () =>
          direction === "perform"
            ? runReviewer(ctx.db, taskId, ctx.runAgent, ctx.reviewApi)
            : runReviewResponderPropose(ctx.db, taskId, ctx.runAgent, ctx.reviewApi),
        )
        .then((outcome) => {
          if (!outcome.ran) return;
          ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
          const after = getTask(ctx.db, taskId);
          if (after) notifyOnTransition(ctx.hub, "implementing", after);
        })
        .catch((err) => console.error(`[cadence] review ${direction} failed for ${taskId}:`, err));
      return Response.json(updated);
    }
    // Kick off the Planner (read-only, plan mode) in the background; it writes an
    // approvable plan.md, then the task parks in Plan review — a distinct, visible
    // "waiting on you" state rather than sitting silently in "In progress".
    // Activity-tracked so the card spins while the Planner drafts. The Implementer
    // (3.4) runs only after approval.
    void ctx.activity
      .track(taskId, "planner", () => runPlanner(ctx.db, taskId, ctx.runAgent))
      .then((p) => {
        if (!p.ran) {
          // No plan came back (agent produced no JSON): don't strand the task in
          // Implementing with nothing running — put it back on PLAY and say why.
          recoverFailedPlay(ctx, taskId, "the Planner produced no plan");
          return;
        }
        const planned = updateTask(ctx.db, taskId, { status: "plan_review" });
        ctx.hub.broadcast({ type: "event", name: "task:plan", payload: taskId });
        ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
        if (planned) notifyOnTransition(ctx.hub, "implementing", planned);
      })
      .catch((err) => {
        console.error(`[cadence] planner failed for ${taskId}:`, err);
        // Another live run owns this task → leave it alone; anything else (cap
        // full, runner crash) → same visible recovery as the no-plan path.
        if (!(err instanceof StageConflictError)) {
          recoverFailedPlay(ctx, taskId, `the Planner failed: ${(err as Error).message}`);
        }
      });
    return Response.json(updated);
  }

  const planMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/plan$/);
  if (planMatch) {
    if (method !== "GET") return methodNotAllowed();
    const taskId = planMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    return Response.json(readPlan(taskId));
  }

  const verifyMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/verify$/);
  if (verifyMatch) {
    if (method !== "GET") return methodNotAllowed();
    const taskId = verifyMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    return Response.json(readVerify(taskId));
  }

  const deliveryMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/delivery$/);
  if (deliveryMatch) {
    if (method !== "GET") return methodNotAllowed();
    const taskId = deliveryMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    return Response.json(readDelivery(taskId));
  }

  // Manual git-context re-check (the "Re-check" button): deterministic local git +
  // an optional forge lookup — fast enough to answer synchronously. Always persists
  // (a fresh checkedAt), broadcasts when the verdict moved.
  const gitContextMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/git-context\/check$/);
  if (gitContextMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = gitContextMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    const result = checkTaskGitContext(ctx.db, taskId, { persist: true });
    if (result?.changed) ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    return Response.json({ gitContext: result?.context ?? null, changed: result?.changed ?? false });
  }

  const diffMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/diff$/);
  if (diffMatch) {
    if (method !== "GET") return methodNotAllowed();
    const taskId = diffMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    // The diff + the work-product verdict together: the Review surface shows not just
    // WHAT changed but whether it's attributably this task's run (never guesswork).
    let evidence: ReturnType<typeof taskWorkEvidence> | undefined;
    try {
      evidence = taskWorkEvidence(ctx.db, taskId);
    } catch {
      evidence = undefined;
    }
    return Response.json({ ...taskDiff(ctx.db, taskId), evidence });
  }

  // Durable per-stage agent outputs (runs.md): what each pipeline run actually
  // said/did, with status + cost — the "what happened here" record.
  const runsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/runs$/);
  if (runsMatch) {
    if (method !== "GET") return methodNotAllowed();
    const taskId = runsMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    return Response.json({ entries: readRunReports(taskId) });
  }

  const mergeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/review\/merge$/);
  if (mergeMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = mergeMatch[1] as string;
    const task = getTask(ctx.db, taskId);
    if (!task) return notFound(pathname);
    if (task.status !== "review") return conflict(`merge requires a task in review (currently ${task.status})`, { status: task.status });
    // Merging mutates the project working dir — refuse while an in-place execution
    // holds it (another task implementing in this project right now).
    if (task.projectId) {
      const project = getProjectById(ctx.db, task.projectId);
      const busy =
        project?.rootPath &&
        projectLocks.isWriteBusy(project.id, {
          db: ctx.db,
          rootPath: project.rootPath,
          excludeTaskId: taskId,
        });
      if (busy) {
        return conflict("another task is executing in this project's working dir — try again when it finishes", {
          merged: false,
        });
      }
    }
    const result = mergeTask(ctx.db, taskId);
    if (!result.ok) return conflict(result.message, { merged: false });
    // Done = no execution leftovers: clear execution.json on every successful merge
    // (mergeTask only clears it for the in-place-branch path; apply_in_place runs
    // whose delivery couldn't finalize would otherwise leak a stale baseBranch).
    clearExecutionState(taskId);
    const updated = updateTask(ctx.db, taskId, { status: "done" });
    ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    return Response.json({ merged: true, message: result.message, task: updated });
  }

  const requestChangesMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/review\/request-changes$/);
  if (requestChangesMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = requestChangesMatch[1] as string;
    const task = getTask(ctx.db, taskId);
    if (!task) return notFound(pathname);
    if (task.status !== "review") return conflict(`request-changes requires a task in review (currently ${task.status})`, { status: task.status });
    let body: ReviewActionInput;
    try {
      body = (await req.json().catch(() => ({}))) as ReviewActionInput;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (body?.note?.trim()) appendContext(taskId, `Requested changes: ${body.note.trim()}`);
    const updated = updateTask(ctx.db, taskId, { status: "implementing" });
    ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    // Re-run the execution chain — without this the task would park in Implementing
    // forever (the plan is already approved, so the Approve→run path is gone). The
    // implementer sees the "Requested changes: …" note via the composed context
    // layers; the recording runner's stage dedupe guards double-POSTs.
    if (task.taskType !== "code_review") void runExecutionChain(ctx, taskId);
    return Response.json(updated);
  }

  const planApproveMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/plan\/approve$/);
  if (planApproveMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = planApproveMatch[1] as string;
    const task = getTask(ctx.db, taskId);
    if (!task) return notFound(pathname);
    // Review-address tasks (§6.5.d): approving the proposal triggers the APPLY chain
    // (write lock + deterministic branch switch + agent) instead of the planner chain.
    if (task.taskType === "code_review" && task.reviewDirection === "address") {
      if (task.status !== "plan_review") {
        return conflict(`the review proposal isn't awaiting approval (currently ${task.status})`, {
          status: task.status,
        });
      }
      updateTask(ctx.db, taskId, { status: "implementing" });
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      void runReviewApplyChain(ctx, taskId);
      return Response.json({ approved: true });
    }
    // Idempotency guard (§6.1.f): approving while a chain is actually running must not
    // start a second one (double-click, double-POST). A task *stranded* in implementing
    // with no live chain (e.g. after a restart) may still re-approve — that's recovery,
    // and the recording runner's stage dedupe backstops any race.
    if (task.status === "implementing" && ctx.activity.isActive(taskId)) {
      return conflict("implementation is already running for this task", { status: task.status });
    }
    // An empty plan must not be approvable: readPlan returns a truthy empty default
    // for a missing plan.md, and approving it would run the Implementer with
    // "(no steps)" — unplanned free-running work (same family as the stale-panel bugs).
    if (readPlan(taskId).steps.length === 0) {
      return conflict("there's no plan to approve yet — the Planner hasn't written steps", { steps: 0 });
    }
    const plan = approvePlan(taskId);
    ctx.hub.broadcast({ type: "event", name: "task:plan", payload: taskId });
    // Approving the plan starts implementation. From Plan review (or a stranded
    // implementing, see above) we move into In progress and run the execution chain.
    // Each stage is activity-tracked so the board card spins while Cadence works; the
    // Implementer runs in the isolated worktree (or the locked project dir) and
    // bails gracefully if it can't.
    if (task.status === "plan_review" || task.status === "implementing") {
      if (task.status !== "implementing") {
        updateTask(ctx.db, taskId, { status: "implementing" });
        ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      }
      void runExecutionChain(ctx, taskId);
    }
    return Response.json(plan);
  }

  // In-flight autonomy work (drives the board/task spinner); hydrates on a fresh page load.
  if (pathname === "/api/activity" && method === "GET") {
    return Response.json(ctx.activity.list());
  }

  // The unified "needs you" feed (§10): everything blocking on the user, built from
  // persistent state so the count survives reloads. Backs the top-bar pill + Attention
  // Center. Resolve one → it drops out → the next surfaces ("keep it flowing").
  if (pathname === "/api/attention" && method === "GET") {
    const items: AttentionItem[] = [];

    for (const t of listTasks(ctx.db, { status: "needs_feedback", sort: "urgency" })) {
      const qa = readQa(t.id);
      const open = qa.questions.filter((q) => !isAnswered(qa.answers[q.id])).length;
      items.push({
        id: `needs_input:${t.id}`,
        kind: "needs_input",
        taskId: t.id,
        title: t.title,
        summary: open === 1 ? "1 question" : `${open} questions`,
        actionLabel: "Answer",
        projectId: t.projectId,
        priority: t.priority,
        urgency: t.urgency ?? 0,
        createdAt: t.updatedAt,
      });
    }

    for (const t of listTasks(ctx.db, { status: "plan_review", sort: "urgency" })) {
      const steps = readPlan(t.id).steps.length;
      items.push({
        id: `plan_approval:${t.id}`,
        kind: "plan_approval",
        taskId: t.id,
        title: t.title,
        summary: `Plan ready · ${steps} step${steps === 1 ? "" : "s"}`,
        actionLabel: "Approve plan",
        projectId: t.projectId,
        priority: t.priority,
        urgency: t.urgency ?? 0,
        createdAt: t.updatedAt,
      });
    }

    for (const t of listTasks(ctx.db, { status: "review", sort: "urgency" })) {
      items.push({
        id: `review_merge:${t.id}`,
        kind: "review_merge",
        taskId: t.id,
        title: t.title,
        summary: "Verified — ready to merge",
        actionLabel: "Review & merge",
        projectId: t.projectId,
        priority: t.priority,
        urgency: t.urgency ?? 0,
        createdAt: t.updatedAt,
      });
    }

    for (const a of ctx.approvals.list()) {
      const t = a.taskId ? getTask(ctx.db, a.taskId) : null;
      items.push({
        id: `tool_approval:${a.id}`,
        kind: "tool_approval",
        taskId: a.taskId ?? undefined,
        approvalId: a.id,
        title: a.toolName,
        summary: "Tool action awaiting approval (Manual mode)",
        actionLabel: "Review action",
        projectId: t?.projectId ?? null,
        priority: t?.priority ?? null,
        urgency: Number.MAX_SAFE_INTEGER, // a live agent is blocked — top priority
        createdAt: a.createdAt,
      });
    }

    // Stalled: a task in an active-work state with no live run (and not just dispatched). The
    // safety net for a run that died or hung between watchdog ticks — "In progress" must never
    // silently lie. Floated to the top: a stuck run is the most urgent thing to see.
    const activeIds = new Set(ctx.activity.list().map((a) => a.taskId));
    const nowMs = Date.now();
    for (const status of ["implementing", "verifying"] as const) {
      for (const t of listTasks(ctx.db, { status, sort: "urgency" })) {
        if (activeIds.has(t.id) || nowMs - t.updatedAt < 60_000) continue;
        items.push({
          id: `stalled:${t.id}`,
          kind: "stalled",
          taskId: t.id,
          title: t.title,
          summary: `Stalled — no active run (${status === "verifying" ? "Verifying" : "In progress"})`,
          actionLabel: "Inspect",
          projectId: t.projectId,
          priority: t.priority,
          urgency: (t.urgency ?? 0) + 1_000_000,
          createdAt: t.updatedAt,
        });
      }
    }

    // Refinement interrupted (§6.1.g): a task sitting in "refining" with no live run used
    // to be invisible until the next gateway boot (heal) — surface it as actionable.
    // findLiveStage also finalizes any lying zombie row it meets along the way.
    for (const t of listTasks(ctx.db, { status: "refining", sort: "urgency" })) {
      if (activeIds.has(t.id) || nowMs - t.updatedAt < 60_000) continue;
      if (findLiveStage(ctx.db, t.id, "discovery")) continue;
      items.push({
        id: `stalled:${t.id}`,
        kind: "stalled",
        taskId: t.id,
        title: t.title,
        summary: "Refinement interrupted — no active run",
        actionLabel: "Inspect",
        projectId: t.projectId,
        priority: t.priority,
        urgency: (t.urgency ?? 0) + 1_000_000,
        createdAt: t.updatedAt,
      });
    }

    // Dead capture pipeline (autonomy on): a task still in inbox/triaged whose
    // triage/discovery attempt died gets only an ephemeral WS notify from the
    // watchdog — give it a persistent item too. Evidence-based: only tasks where a
    // run actually existed are flagged (tasks captured with autonomy off, or in a
    // project that opted out, are legitimately resting — never flag those).
    if (readSettings().global.autonomy) {
      for (const status of ["inbox", "triaged"] as const) {
        for (const t of listTasks(ctx.db, { status, sort: "urgency" })) {
          if (activeIds.has(t.id) || nowMs - t.updatedAt < 60_000) continue;
          if (status === "triaged" && !resolveProjectAutonomy(ctx.db, t.projectId ?? null)) continue;
          const roles = new Set(listTaskSessions(ctx.db, t.id).map((s) => s.role));
          if (!roles.has("triage") && !roles.has("discovery")) continue;
          if (findLiveStage(ctx.db, t.id, "triage") || findLiveStage(ctx.db, t.id, "discovery")) continue;
          items.push({
            id: `stalled:${t.id}`,
            kind: "stalled",
            taskId: t.id,
            title: t.title,
            summary: "Capture pipeline died — triage never finished",
            actionLabel: "Inspect",
            projectId: t.projectId,
            priority: t.priority,
            urgency: (t.urgency ?? 0) + 1_000_000,
            createdAt: t.updatedAt,
          });
        }
      }
    }

    items.sort((x, y) => y.urgency - x.urgency || x.createdAt - y.createdAt);
    return Response.json({ items, count: items.length } satisfies AttentionResponse);
  }

  // ---- Review Workspace (§6.5.e/f) ------------------------------------------

  // Findings artifact: GET for the workspace, PUT to persist include/dismiss/edit decisions.
  const findingsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/review-findings$/);
  if (findingsMatch) {
    const taskId = findingsMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    if (method === "GET") return Response.json(readReviewFindings(taskId));
    if (method === "PUT") {
      let body: import("@cadence/shared").ReviewFindings;
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (!Array.isArray(body?.findings)) return badRequest("findings array is required");
      writeReviewFindings(taskId, body);
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      return Response.json(body);
    }
    return methodNotAllowed();
  }

  // Proposal artifact: GET for the workspace, PUT to persist apply/skip/edited replies.
  const proposalMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/review-proposal$/);
  if (proposalMatch) {
    const taskId = proposalMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    if (method === "GET") return Response.json(readReviewProposal(taskId));
    if (method === "PUT") {
      let body: import("@cadence/shared").ReviewProposal;
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (!Array.isArray(body?.threads)) return badRequest("threads array is required");
      writeReviewProposal(taskId, body);
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      return Response.json(body);
    }
    return methodNotAllowed();
  }

  // Publish the triaged review to the forge (perform direction) — ALWAYS an explicit
  // user action (§6.5 locked decision #4); dismissed findings never leave the machine.
  const publishMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/review\/publish$/);
  if (publishMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = publishMatch[1] as string;
    const task = getTask(ctx.db, taskId);
    if (!task) return notFound(pathname);
    const findings = readReviewFindings(taskId);
    const ref = task.reviewRef ? parsePrUrl(task.reviewRef) : null;
    if (!findings || !ref) return conflict("no findings to publish (run the review first)");
    // Already on the forge → never double-post. (Reachable e.g. by manually moving a
    // done review task back to Review — the first publish stamp survives on disk.)
    if (findings.published) {
      return conflict(
        `this review was already published${findings.published.url ? ` (${findings.published.url})` : ""} — it can't be posted twice`,
        { published: true, url: findings.published.url },
      );
    }
    let body: { verdict?: string };
    try {
      body = (await req.json().catch(() => ({}))) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    const verdict = (
      ["approve", "comment", "request_changes"].includes(body?.verdict ?? "")
        ? body.verdict
        : findings.verdictSuggestion
    ) as import("@cadence/shared").ReviewVerdict;
    const included = findings.findings.filter((f) => f.decision !== "dismiss");
    const comments = included.map((f) => ({
      file: f.file,
      line: f.line,
      body:
        (f.editedBody ?? f.body) +
        (f.suggestedPatch ? `\n\nSuggested fix:\n\`\`\`\n${f.suggestedPatch}\n\`\`\`` : ""),
    }));
    try {
      const out = (ctx.reviewApi ?? forgeReviewApi)(ref.forge).publishReview(
        ref,
        verdict,
        findings.summary,
        comments,
      );
      writeReviewFindings(taskId, {
        ...findings,
        published: { at: Date.now(), url: out.url, verdict },
      });
      const updated = updateTask(ctx.db, taskId, { status: "done" });
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      if (updated) notifyOnTransition(ctx.hub, "review", updated);
      return Response.json({ published: true, url: out.url, comments: comments.length, verdict });
    } catch (err) {
      return conflict(`publish failed: ${(err as Error).message.slice(0, 300)}`);
    }
  }

  // Post the approved replies + resolve threads (address direction) — explicit action.
  const repliesMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/review\/replies$/);
  if (repliesMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = repliesMatch[1] as string;
    const task = getTask(ctx.db, taskId);
    if (!task) return notFound(pathname);
    const proposal = readReviewProposal(taskId);
    const ref = task.reviewRef ? parsePrUrl(task.reviewRef) : null;
    if (!proposal || !ref) return conflict("no proposal to reply from");
    const api = (ctx.reviewApi ?? forgeReviewApi)(ref.forge);
    let posted = 0;
    let resolved = 0;
    const failures: string[] = [];
    for (const t of proposal.threads) {
      if (t.decision === "skip") continue;
      const reply = (t.editedReply ?? t.reply).trim();
      try {
        if (reply) {
          api.replyToThread(ref, t.threadId, reply);
          posted += 1;
        }
        if (t.resolves && api.resolveThread(ref, t.threadId)) resolved += 1;
      } catch (err) {
        failures.push(`${t.threadId}: ${(err as Error).message.slice(0, 120)}`);
      }
    }
    writeReviewProposal(taskId, { ...proposal, repliedAt: Date.now() });
    if (failures.length) appendContext(taskId, `Review replies: ${failures.length} failed — ${failures.join("; ")}`);
    const updated = updateTask(ctx.db, taskId, { status: "done" });
    ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    if (updated) notifyOnTransition(ctx.hub, "review", updated);
    return Response.json({ posted, resolved, failed: failures.length });
  }

  const refineMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/refine$/);
  if (refineMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = refineMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    // Refuse a duplicate before runDiscovery touches the task's status (§6.1.b) —
    // the recording runner's assertStageIdle still backstops the racy window after.
    const live = findLiveStage(ctx.db, taskId, "discovery");
    if (live) {
      return conflict("a discovery run is already active for this task", { sessionId: live.id });
    }
    const before = getTask(ctx.db, taskId);
    const outcome = await ctx.activity.track(taskId, "discovery", () =>
      runDiscovery(ctx.db, taskId, ctx.runAgent),
    );
    if (outcome.ran) {
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      if (outcome.status === "needs_feedback") {
        const t = getTask(ctx.db, taskId);
        if (t) notifyOnTransition(ctx.hub, before?.status, t);
      }
    }
    return Response.json(outcome);
  }

  const timelineMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/timeline$/);
  if (timelineMatch) {
    if (method !== "GET") return methodNotAllowed();
    const taskId = timelineMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    return Response.json(listTaskEvents(ctx.db, taskId));
  }

  const subtasksMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/subtasks$/);
  if (subtasksMatch) {
    if (method !== "GET") return methodNotAllowed();
    const taskId = subtasksMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    return Response.json(getSubtasks(ctx.db, taskId));
  }

  const depMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/deps$/);
  if (depMatch) {
    const taskId = depMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    if (method === "GET") return Response.json(getDeps(ctx.db, taskId));
    if (method === "POST") {
      let body: { blockerId?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (!body?.blockerId) return badRequest("blockerId required");
      const result = addDependency(ctx.db, taskId, body.blockerId);
      if (!result.ok) return conflict(result.reason);
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      return Response.json(getDeps(ctx.db, taskId));
    }
    return methodNotAllowed();
  }

  const depDeleteMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/deps\/([^/]+)$/);
  if (depDeleteMatch) {
    if (method !== "DELETE") return methodNotAllowed();
    const taskId = depDeleteMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    removeDependency(ctx.db, taskId, depDeleteMatch[2] as string);
    ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    return Response.json(getDeps(ctx.db, taskId));
  }

  const qaMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/qa$/);
  if (qaMatch) {
    if (method !== "GET") return methodNotAllowed();
    if (!getTask(ctx.db, qaMatch[1] as string)) return notFound(pathname);
    return Response.json(readQa(qaMatch[1] as string));
  }

  const answersMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/qa\/answers$/);
  if (answersMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = answersMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    let body: { answers?: Record<string, string | string[]> };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (!body?.answers || typeof body.answers !== "object") return badRequest("answers required");
    const before = getTask(ctx.db, taskId);

    // Triage's "which project?" card is answered here like any other question, but it
    // resumes the refinement pipeline (needs_feedback → triaged → discovery) instead
    // of counting toward the Questioner's all-answered → ready math.
    const { [TRIAGE_PROJECT_QUESTION_ID]: projectChoice, ...rest } = body.answers;
    if (projectChoice !== undefined) {
      const choice = Array.isArray(projectChoice) ? (projectChoice[0] ?? "") : projectChoice;
      const applied = applyTriageProjectAnswer(ctx.db, taskId, choice);
      if (!applied.ok && Object.keys(rest).length === 0) {
        return badRequest(applied.reason ?? "invalid project choice");
      }
      if (applied.resume) {
        ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
        void continueRefinement(ctx, taskId).catch((err) =>
          console.error(`[cadence] resume after triage answer failed for ${taskId}:`, err),
        );
      }
      if (Object.keys(rest).length === 0) {
        return Response.json({ status: getTask(ctx.db, taskId)?.status ?? "needs_feedback" });
      }
    }

    const result = answerQuestions(ctx.db, taskId, rest);
    ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    if (before?.status === "needs_feedback" && result.status === "ready") {
      ctx.hub.broadcast({ type: "event", name: "task:ready", payload: taskId });
    }
    return Response.json(result);
  }

  const taskSessionsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/sessions$/);
  if (taskSessionsMatch) {
    const taskId = taskSessionsMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    if (method === "GET") return Response.json(listTaskSessions(ctx.db, taskId));
    if (method === "POST") {
      let input: SpawnSessionInput;
      try {
        input = (await req.json().catch(() => ({}))) as SpawnSessionInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      const task = getTask(ctx.db, taskId);
      const appendSystemPrompt = composeContext(ctx.db, {
        taskId,
        projectId: task?.projectId ?? null,
        fleetId: task?.fleetId ?? null,
      });
      const session = ctx.spawn.spawn({
        cwd: resolveTaskCwd(ctx.db, taskId),
        taskId,
        projectId: task?.projectId ?? null,
        role: input.role ?? "chat",
        model: input.model,
        permissionMode: input.permissionMode ?? resolvePermissionMode(ctx.db, taskId),
        appendSystemPrompt: appendSystemPrompt || undefined,
      });
      if (typeof input.prompt === "string" && input.prompt.trim()) {
        ctx.spawn.send(session.id, input.prompt);
      }
      ctx.hub.broadcast({ type: "event", name: "session:spawned", payload: session.id });
      return Response.json(session, { status: 201 });
    }
    return methodNotAllowed();
  }

  if (pathname === "/api/sessions" && method === "GET") {
    return Response.json(listSessions(ctx.db));
  }

  // Bulk tidy-up (§6.1.g): drop finished agent-stage rows; transcripts stay on disk.
  if (pathname === "/api/sessions/clear-finished" && method === "POST") {
    const cleared = clearFinishedOneshots(ctx.db);
    if (cleared > 0) ctx.hub.broadcast({ type: "event", name: "session:deleted", payload: "" });
    return Response.json({ cleared });
  }

  if (pathname === "/api/live-sessions" && method === "GET") {
    return Response.json(readLiveSessions());
  }

  if (pathname === "/api/usage" && method === "GET") {
    return Response.json({
      stats: readUsageStats(),
      rateLimit: ctx.spawn.latestRateLimit(),
      windows: await fetchClaudeWindows(),
    });
  }

  if (pathname === "/api/analytics" && method === "GET") {
    return Response.json(computeAnalytics(ctx.db));
  }

  if (pathname === "/api/sweep" && method === "GET") {
    return Response.json(runSweep(ctx.db, Date.now()));
  }

  if (pathname === "/api/self-monitor" && method === "GET") {
    return Response.json(computeSelfMonitor(ctx.db));
  }

  if (pathname === "/api/proposals" && method === "GET") {
    return Response.json(buildProposals(ctx.db, Date.now()));
  }

  if (pathname === "/api/memory" && method === "GET") {
    return Response.json(listMemoryFiles());
  }

  if (pathname === "/api/learned" && method === "GET") {
    return Response.json(listLearnedEntries());
  }

  const learnedRevertMatch = pathname.match(/^\/api\/learned\/(\d+)$/);
  if (learnedRevertMatch) {
    if (method !== "DELETE") return methodNotAllowed();
    const ok = revertLearnedEntry("learned", Number(learnedRevertMatch[1]));
    if (ok) ctx.hub.broadcast({ type: "event", name: "memory:updated", payload: "learned" });
    return ok ? Response.json({ reverted: true }) : notFound(pathname);
  }

  if (pathname === "/api/reflect" && method === "POST") {
    const outcome = await runReflector(ctx.db, ctx.runAgent);
    if (outcome.ran) ctx.hub.broadcast({ type: "event", name: "memory:updated", payload: "learned" });
    return Response.json(outcome);
  }

  const memoryFileMatch = pathname.match(/^\/api\/memory\/([^/]+)$/);
  if (memoryFileMatch) {
    if (method !== "PUT") return methodNotAllowed();
    let body: { content?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body?.content !== "string") return badRequest("content (string) required");
    const file = writeMemoryFile(memoryFileMatch[1] as string, body.content);
    ctx.hub.broadcast({ type: "event", name: "memory:updated", payload: file.name });
    return Response.json(file);
  }

  const projectMemoryMatch = pathname.match(/^\/api\/projects\/([^/]+)\/memory$/);
  if (projectMemoryMatch) {
    const slug = projectMemoryMatch[1] as string;
    if (!getProject(ctx.db, slug)) return notFound(pathname);
    if (method === "GET") return Response.json({ content: readProjectMemory(slug) });
    if (method === "PUT") {
      let body: { content?: string };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (typeof body?.content !== "string") return badRequest("content (string) required");
      writeProjectMemory(slug, body.content);
      ctx.hub.broadcast({ type: "event", name: "memory:updated", payload: slug });
      return Response.json({ content: body.content });
    }
    return methodNotAllowed();
  }

  if (pathname === "/api/search" && method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    return Response.json(q.trim() ? searchTaskHits(ctx.db, q) : []);
  }

  if (pathname === "/api/search/transcripts" && method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    return Response.json(q.trim() ? searchTranscripts(ctx.db, q) : []);
  }

  if (pathname === "/api/searches") {
    if (method === "GET") return Response.json(listSavedSearches());
    if (method === "POST") {
      let input: CreateSavedSearchInput;
      try {
        input = (await req.json()) as CreateSavedSearchInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (!input?.name?.trim() || typeof input.query !== "string") {
        return badRequest("name and query are required");
      }
      const saved = createSavedSearch(input);
      ctx.hub.broadcast({ type: "event", name: "search:saved", payload: saved.id });
      return Response.json(saved, { status: 201 });
    }
    return methodNotAllowed();
  }

  const searchDeleteMatch = pathname.match(/^\/api\/searches\/([^/]+)$/);
  if (searchDeleteMatch) {
    if (method !== "DELETE") return methodNotAllowed();
    const ok = deleteSavedSearch(searchDeleteMatch[1] as string);
    return ok ? Response.json({ deleted: true }) : notFound(pathname);
  }

  if (pathname === "/api/approvals" && method === "GET") {
    return Response.json(ctx.approvals.list());
  }

  const approvalResolveMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/resolve$/);
  if (approvalResolveMatch) {
    if (method !== "POST") return methodNotAllowed();
    let body: ApprovalDecision;
    try {
      body = (await req.json()) as ApprovalDecision;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (typeof body?.allow !== "boolean") return badRequest("allow (boolean) required");
    const ok = ctx.approvals.resolve(approvalResolveMatch[1] as string, {
      allow: body.allow,
      reason: body.reason,
    });
    return ok ? Response.json({ resolved: true }) : notFound(pathname);
  }

  if (pathname === "/api/digest") {
    if (method === "GET") {
      const date = url.searchParams.get("date") ?? undefined;
      return Response.json(getDigest(ctx.db, Date.now(), date));
    }
    return methodNotAllowed();
  }

  if (pathname === "/api/digest/commit") {
    if (method !== "POST") return methodNotAllowed();
    let input: CommitDigestInput;
    try {
      input = (await req.json()) as CommitDigestInput;
    } catch {
      return badRequest("invalid JSON body");
    }
    if (!Array.isArray(input?.picks)) return badRequest("picks must be an array of task ids");
    const digest = commitDigest(ctx.db, input, Date.now());
    ctx.hub.broadcast({ type: "event", name: "digest:committed", payload: digest.date });
    return Response.json(digest);
  }

  if (pathname === "/api/digest/recap") {
    if (method !== "POST") return methodNotAllowed();
    let input: RecapDigestInput;
    try {
      input = (await req.json().catch(() => ({}))) as RecapDigestInput;
    } catch {
      return badRequest("invalid JSON body");
    }
    const digest = recapDigest(ctx.db, Date.now(), input?.date);
    ctx.hub.broadcast({ type: "event", name: "digest:recapped", payload: digest.date });
    return Response.json(digest);
  }

  if (pathname === "/api/suggestions") {
    if (method === "GET") {
      const entityType = url.searchParams.get("entityType");
      const entityId = url.searchParams.get("entityId");
      if (!entityType || !entityId) return badRequest("entityType and entityId are required");
      return Response.json(listSuggestions(ctx.db, entityType, entityId));
    }
    if (method === "POST") {
      let input: CreateSuggestionInput;
      try {
        input = (await req.json()) as CreateSuggestionInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (!input?.entityType || !input?.entityId || !input?.field) {
        return badRequest("entityType, entityId and field are required");
      }
      const s = createSuggestion(ctx.db, input);
      ctx.hub.broadcast({ type: "event", name: "suggestion:created", payload: s.id });
      return Response.json(s, { status: 201 });
    }
    return methodNotAllowed();
  }

  const resolveMatch = pathname.match(/^\/api\/suggestions\/([^/]+)\/resolve$/);
  if (resolveMatch) {
    if (method !== "POST") return methodNotAllowed();
    let body: ResolveSuggestionInput;
    try {
      body = (await req.json()) as ResolveSuggestionInput;
    } catch {
      return badRequest("invalid JSON body");
    }
    const actions = ["accept", "edit", "override", "dismiss"];
    if (!body?.action || !actions.includes(body.action)) return badRequest("invalid action");
    const resolved = resolveSuggestion(ctx.db, resolveMatch[1] as string, body.action, body.value);
    if (!resolved) return notFound(pathname);
    ctx.hub.broadcast({ type: "event", name: "suggestion:resolved", payload: resolved.id });
    return Response.json(resolved);
  }

  if (pathname === "/api/import/candidates" && method === "GET") {
    return Response.json(scanClaudeProjects(ctx.db));
  }

  if (pathname === "/api/import/enrich" && method === "POST") {
    let body: { cwd?: string };
    try {
      body = (await req.json()) as { cwd?: string };
    } catch {
      return badRequest("invalid JSON body");
    }
    if (!body?.cwd) return badRequest("cwd is required");
    return Response.json(await ctx.enrich(body.cwd));
  }

  if (pathname === "/api/import" && method === "POST") {
    let body: { selections?: unknown };
    try {
      body = (await req.json()) as { selections?: unknown };
    } catch {
      return badRequest("invalid JSON body");
    }
    const selections = Array.isArray(body?.selections) ? body.selections : [];
    const created = importProjects(ctx.db, selections);
    if (created.length) ctx.hub.broadcast({ type: "event", name: "projects:imported" });
    return Response.json(created, { status: 201 });
  }

  // Capture-time review detection (§6.5.a, propose-don't-impose): parse a pasted PR/MR
  // URL, match it to a known project by remote, and infer the review direction by
  // comparing the PR author with the authenticated CLI account. Everything best-effort —
  // the capture chips stay editable.
  if (pathname === "/api/review/inspect" && method === "POST") {
    let body: { url?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("invalid JSON body");
    }
    const ref = parsePrUrl(body?.url ?? "");
    if (!ref) {
      return Response.json({
        ref: null,
        projectSlug: null,
        author: null,
        account: null,
        direction: "perform",
      } satisfies ReviewInspectResult);
    }
    let projectSlug: string | null = null;
    let account: string | null = null;
    for (const project of listProjects(ctx.db)) {
      const remote = parseRemote(project.gitRemote, project.forgeOverride);
      if (remote && remote.host === ref.host && remote.owner === ref.owner && remote.repo === ref.repo) {
        projectSlug = project.slug;
        account = projectForgeStatus(project.gitRemote, project.forgeOverride).cli?.account ?? null;
        break;
      }
    }
    if (account == null) account = probeCli(ref.forge === "github" ? "gh" : "glab").account;
    const author = ctx.prAuthor ? ctx.prAuthor(ref) : lookupPrAuthor(ref);
    const direction = inferDirection(author, account);
    return Response.json({ ref, projectSlug, author, account, direction } satisfies ReviewInspectResult);
  }

  // The agent prompt registry + current overrides — powers Settings → Agents & Prompts (6.3.c).
  if (pathname === "/api/agents/prompts" && method === "GET") {
    const overrides = readSettings().agents ?? {};
    const list: AgentPromptInfo[] = Object.values(AGENT_PROMPTS).map((def) => ({
      role: def.role,
      kind: def.kind,
      label: def.label,
      description: def.description,
      defaultModel: def.defaultModel ?? null,
      variables: def.variables,
      defaultTemplate: def.defaultTemplate,
      override: overrides[def.role] ?? null,
    }));
    return Response.json(list);
  }

  if (pathname === "/api/settings") {
    if (method === "GET") return Response.json(readSettings());
    if (method === "PATCH") {
      let patch: {
        preferredTerminal?: string;
        claudeBinPath?: string;
        global?: Record<string, unknown>;
        /** Per-agent overrides; a role mapped to null (or with all fields cleared) resets it. */
        agents?: Record<string, { prompt?: string | null; model?: string | null } | null>;
        /** Date/time patterns (6.3.d); blank/null resets a key to the default. */
        formats?: { date?: string | null; dateTime?: string | null };
        /** Operations knobs (6.3.e); null/invalid resets a key to the built-in default. */
        operations?: Record<string, number | null>;
        /** Review settings (6.5.h). */
        review?: { strictness?: string | null };
        /** Persisted UI flags (e.g. quickstartSeen); null/false clears a flag. */
        ui?: { quickstartSeen?: boolean | null };
      };
      try {
        patch = (await req.json()) as typeof patch;
      } catch {
        return badRequest("invalid JSON body");
      }
      const current = readSettings();
      // Deep-merge agent overrides per role (§6.3.b): only customized fields persist;
      // empty/null clears a field; a role with nothing left disappears entirely.
      const agents = { ...(current.agents ?? {}) };
      for (const [role, o] of Object.entries(patch.agents ?? {})) {
        if (o == null) {
          delete agents[role];
          continue;
        }
        const merged = { ...(agents[role] ?? {}) };
        if ("prompt" in o) {
          if (o.prompt?.trim()) merged.prompt = o.prompt;
          else delete merged.prompt;
        }
        if ("model" in o) {
          if (o.model?.trim()) merged.model = o.model.trim();
          else delete merged.model;
        }
        if (Object.keys(merged).length > 0) agents[role] = merged;
        else delete agents[role];
      }
      // Date/time patterns (§6.3.d): set per key; blank/null clears back to the default.
      const formats = { ...(current.formats ?? {}) };
      for (const key of ["date", "dateTime"] as const) {
        if (patch.formats && key in patch.formats) {
          const v = patch.formats[key];
          if (v?.trim()) formats[key] = v.trim();
          else delete formats[key];
        }
      }
      // Operations knobs (§6.3.e): per-key set; null/invalid clears back to the default.
      const OPS_KEYS = [
        "stuckThresholdMinutes",
        "readStageTimeoutMinutes",
        "implementStageTimeoutMinutes",
        "maxStageAttemptsPer24h",
        "maxConcurrentAgents",
      ] as const;
      const operations = { ...(current.operations ?? {}) } as Record<string, number>;
      for (const key of OPS_KEYS) {
        if (patch.operations && key in patch.operations) {
          const v = patch.operations[key];
          if (typeof v === "number" && Number.isFinite(v) && v > 0) operations[key] = v;
          else delete operations[key];
        }
      }
      // Review settings (§6.5.h): strictness allowlist; invalid/null clears to default.
      const review = { ...(current.review ?? {}) };
      if (patch.review && "strictness" in patch.review) {
        const v = patch.review.strictness;
        if (v === "lenient" || v === "standard" || v === "strict") review.strictness = v;
        else delete review.strictness;
      }
      // UI flags: true sets; null/false clears (clearing re-opens Quickstart on next launch).
      const ui = { ...(current.ui ?? {}) };
      if (patch.ui && "quickstartSeen" in patch.ui) {
        if (patch.ui.quickstartSeen === true) ui.quickstartSeen = true;
        else delete ui.quickstartSeen;
      }
      const next = {
        ...current,
        ...(patch.preferredTerminal ? { preferredTerminal: patch.preferredTerminal } : {}),
        ...("claudeBinPath" in patch
          ? { claudeBinPath: patch.claudeBinPath?.trim() || undefined }
          : {}),
        global: { ...current.global, ...(patch.global ?? {}) },
        ...(patch.agents || current.agents ? { agents } : {}),
        ...(patch.formats || current.formats ? { formats } : {}),
        ...(patch.operations || current.operations ? { operations } : {}),
        ...(patch.review || current.review ? { review } : {}),
        ...(patch.ui || current.ui ? { ui } : {}),
      };
      writeSettings(next);
      applyClaudeBinEnv(next); // export CADENCE_CLAUDE_BIN so agent spawns pick up the change
      ctx.hub.broadcast({ type: "event", name: "settings:updated" });
      return Response.json(next);
    }
    return methodNotAllowed();
  }

  // Stop (graceful) / kill (hard) any live session — warm handle or recorded pid.
  // 409 if nothing is alive to signal.
  const sessionSignalMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/(stop|kill)$/);
  if (sessionSignalMatch) {
    if (method !== "POST") return methodNotAllowed();
    const id = sessionSignalMatch[1] as string;
    const action = sessionSignalMatch[2] as "stop" | "kill";
    const session = getSession(ctx.db, id);
    if (!session) return notFound(pathname);
    if (!signalSession(ctx.spawn, session, action)) {
      return Response.json({ error: "session_not_live", id }, { status: 409 });
    }
    return Response.json({ ok: true, action });
  }

  // Single session: detail (+ liveness), re-organize (assign), or delete.
  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const id = sessionMatch[1] as string;
    const session = getSession(ctx.db, id);
    if (!session) return notFound(pathname);
    const withLive = (s: typeof session): SessionDetail => ({
      ...s,
      ...sessionRunState(ctx.spawn, s),
    });
    if (method === "GET") return Response.json(withLive(session));
    if (method === "PATCH") {
      let patch: UpdateSessionInput;
      try {
        patch = (await req.json()) as UpdateSessionInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      // A non-null link must point at an existing entity; null clears it.
      if (patch.taskId && !getTask(ctx.db, patch.taskId)) {
        return badRequest(`unknown task "${patch.taskId}"`);
      }
      if (patch.projectId && !getProjectById(ctx.db, patch.projectId)) {
        return badRequest(`unknown project "${patch.projectId}"`);
      }
      if (patch.fleetId && !getFleetById(ctx.db, patch.fleetId)) {
        return badRequest(`unknown fleet "${patch.fleetId}"`);
      }
      const updated = updateSession(ctx.db, id, patch);
      if (!updated) return notFound(pathname);
      ctx.hub.broadcast({ type: "event", name: "session:updated", payload: id });
      return Response.json(withLive(updated));
    }
    if (method === "DELETE") {
      signalSession(ctx.spawn, session, "kill"); // stop the process (warm or pid) before dropping the row
      const deleted = deleteSession(ctx.db, id);
      ctx.hub.broadcast({ type: "event", name: "session:deleted", payload: id });
      return Response.json({ deleted });
    }
    return methodNotAllowed();
  }

  // Terminal handoff. A RUNNING session can't be safely resumed in a terminal (two
  // writers on one transcript = the "frozen fork" confusion), so:
  //   - default        → 409 session_running (the UI offers Take over instead)
  //   - ?mode=takeover → stop the background process first, then resume interactively
  const openTermMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/open-terminal$/);
  if (openTermMatch) {
    if (method !== "POST") return methodNotAllowed();
    const session = getSession(ctx.db, openTermMatch[1] as string);
    if (!session) return notFound(pathname);
    if (!existsSync(session.cwd)) {
      return Response.json(
        { error: "cwd_missing", message: `The working directory is gone (${session.cwd}).` },
        { status: 409 },
      );
    }
    const command = buildResumeCommand(session.cwd, session.id);
    const { isLive } = sessionRunState(ctx.spawn, session);
    let tookOver = false;
    if (isLive) {
      if (url.searchParams.get("mode") !== "takeover") {
        return Response.json({ error: "session_running", command }, { status: 409 });
      }
      signalSession(ctx.spawn, session, "stop");
      const deadline = Date.now() + 5000;
      while (session.pid != null && isProcessAlive(session.pid) && Date.now() < deadline) {
        await Bun.sleep(150);
      }
      if (session.pid != null && isProcessAlive(session.pid)) {
        signalSession(ctx.spawn, session, "kill");
        await Bun.sleep(500);
        if (isProcessAlive(session.pid)) {
          return Response.json(
            { error: "stop_failed", message: "The running process did not stop — try Kill first." },
            { status: 500 },
          );
        }
      }
      // The row may already be finalized by the warm-handle close hook; make sure.
      const after = getSession(ctx.db, session.id);
      if (after && (after.status === "running" || after.status === "spawning")) {
        endSession(ctx.db, session.id, "killed");
      }
      ctx.hub.broadcast({ type: "event", name: "session:updated", payload: session.id });
      tookOver = true;
    }
    ctx.openTerminal(readSettings().preferredTerminal, command);
    return Response.json({ ok: true, command, tookOver });
  }

  const transcriptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
  if (transcriptMatch) {
    if (method !== "GET") return methodNotAllowed();
    const session = getSession(ctx.db, transcriptMatch[1] as string);
    if (!session) return notFound(pathname);
    // Resolve (and self-heal) where claude actually wrote the file — never 404 a
    // session that simply hasn't produced output yet; the UI renders the empty state.
    const path = resolveTranscriptPath(session, (fixed) => recordTranscriptPath(ctx.db, session.id, fixed));
    const limit = Number(url.searchParams.get("limit")) || undefined;
    return Response.json(path ? readTranscript(path, { limit }) : []);
  }

  const sessionMsgMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (sessionMsgMatch) {
    const sessionId = sessionMsgMatch[1] as string;
    if (method !== "POST") return methodNotAllowed();
    let input: { text?: string };
    try {
      input = (await req.json()) as { text?: string };
    } catch {
      return badRequest("invalid JSON body");
    }
    const text = typeof input?.text === "string" ? input.text.trim() : "";
    if (!text) return badRequest("text is required");
    const sent = ctx.spawn.send(sessionId, text);
    if (!sent) return Response.json({ error: "session_not_live", id: sessionId }, { status: 409 });
    return Response.json({ ok: true });
  }

  const ctxMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/context$/);
  if (ctxMatch) {
    const id = ctxMatch[1] as string;
    if (!getTaskDetail(ctx.db, id)) return notFound(pathname);
    if (method === "GET") {
      return Response.json({ content: readContext(id) });
    }
    if (method === "POST") {
      let input: AppendContextInput;
      try {
        input = (await req.json()) as AppendContextInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      const text = typeof input?.text === "string" ? input.text.trim() : "";
      if (!text) return badRequest("text is required");
      appendContext(id, text);
      ctx.hub.broadcast({ type: "event", name: "task:context", payload: id });
      return Response.json({ content: readContext(id) }, { status: 201 });
    }
    return methodNotAllowed();
  }

  // Attachments: files the user uploads as context for agents (multipart form,
  // any field name). Stored under ~/.cadence/tasks/<id>/attachments/ and injected
  // into every composed agent context as absolute paths (context.ts).
  const attachListMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/attachments$/);
  if (attachListMatch) {
    const id = attachListMatch[1] as string;
    if (!getTaskDetail(ctx.db, id)) return notFound(pathname);
    if (method === "GET") return Response.json(listAttachments(id));
    if (method === "POST") {
      // Structural file type: the global File and undici's (what req.formData()
      // yields) disagree under bun-types, and we only need name + bytes anyway.
      const files: Array<{ name: string; arrayBuffer(): Promise<ArrayBuffer> }> = [];
      try {
        const form = await req.formData();
        for (const [, value] of form) {
          if (typeof value !== "string" && value.size > 0) files.push(value);
        }
      } catch {
        return badRequest("expected multipart/form-data with at least one file");
      }
      if (!files.length) return badRequest("no files in upload");
      for (const file of files) {
        saveAttachment(id, file.name || "pasted-file", new Uint8Array(await file.arrayBuffer()));
      }
      ctx.hub.broadcast({ type: "event", name: "task:attachments", payload: id });
      return Response.json(listAttachments(id), { status: 201 });
    }
    return methodNotAllowed();
  }

  const attachFileMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/attachments\/([^/]+)$/);
  if (attachFileMatch) {
    const id = attachFileMatch[1] as string;
    const name = decodeURIComponent(attachFileMatch[2] as string);
    if (!getTaskDetail(ctx.db, id)) return notFound(pathname);
    if (method === "GET") {
      const file = attachmentPath(id, name);
      if (!file) return notFound(pathname);
      return new Response(Bun.file(file));
    }
    if (method === "DELETE") {
      if (!deleteAttachment(id, name)) return notFound(pathname);
      ctx.hub.broadcast({ type: "event", name: "task:attachments", payload: id });
      return Response.json(listAttachments(id));
    }
    return methodNotAllowed();
  }

  if (pathname === "/api/projects") {
    if (method === "GET") return Response.json(listProjects(ctx.db));
    if (method === "POST") {
      let input: CreateProjectInput;
      try {
        input = (await req.json()) as CreateProjectInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (!name) return badRequest("name is required");
      const project = createProject(ctx.db, { ...input, name });
      ctx.hub.broadcast({ type: "event", name: "project:created", payload: project.slug });
      return Response.json(project, { status: 201 });
    }
    return methodNotAllowed();
  }

  const projMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projMatch) {
    const slug = projMatch[1] as string;
    if (method === "GET") {
      const project = getProject(ctx.db, slug);
      return project ? Response.json(project) : notFound(pathname);
    }
    if (method === "PATCH") {
      let patch: UpdateProjectInput;
      try {
        patch = (await req.json()) as UpdateProjectInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (typeof patch?.name === "string" && !patch.name.trim()) {
        return badRequest("name cannot be blank");
      }
      const updated = updateProject(ctx.db, slug, patch);
      if (!updated) return notFound(pathname);
      ctx.hub.broadcast({ type: "event", name: "project:updated", payload: updated.slug });
      return Response.json(updated);
    }
    return methodNotAllowed();
  }

  // Forge status (§6.4): parsed remote + matching CLI capability. ?refresh=1 re-probes.
  const forgeMatch = pathname.match(/^\/api\/projects\/([^/]+)\/forge$/);
  if (forgeMatch) {
    if (method !== "GET") return methodNotAllowed();
    const project = getProject(ctx.db, forgeMatch[1] as string);
    if (!project) return notFound(pathname);
    const status = projectForgeStatus(project.gitRemote, project.forgeOverride, {
      refresh: url.searchParams.get("refresh") === "1",
    });
    return Response.json({
      remote: status.remote,
      cli: status.cli,
      probedAt: status.probedAt,
    } satisfies ProjectForgeStatus);
  }

  // Worktree-readiness check (§9, propose-don't-impose): a read-only Claude run inspects
  // the repo for worktree blockers (.env files, docker ports, install steps…). The whole
  // lifecycle (running → verdict/failed) is persisted on the project, so a closed panel
  // never loses it. Fire-and-forget — each transition lands as a project:updated event.
  const worktreeCheckMatch = pathname.match(/^\/api\/projects\/([^/]+)\/worktree-check$/);
  if (worktreeCheckMatch) {
    if (method !== "POST") return methodNotAllowed();
    const slug = worktreeCheckMatch[1] as string;
    const project = getProject(ctx.db, slug);
    if (!project) return notFound(pathname);
    if (!project.rootPath) return conflict("project has no rootPath — set one first");
    void runWorktreeCheck(ctx.db, slug, ctx.runAgent)
      .then((out) => {
        ctx.hub.broadcast({ type: "event", name: "project:updated", payload: slug });
        // The check can take minutes — surface the outcome (in-app + OS banner) so it
        // isn't missed when the panel that started it is long closed.
        notifyWorktreeCheck(ctx.hub, project.name, out);
      })
      .catch((err) => console.error(`[cadence] worktree check failed for ${slug}:`, err));
    // runWorktreeCheck persists "running" synchronously before its first await, so this
    // broadcast (and the 202) already reflect an in-flight check.
    ctx.hub.broadcast({ type: "event", name: "project:updated", payload: slug });
    return Response.json({ started: true }, { status: 202 });
  }

  // -------------------------------------------------- recurring tasks (templates)

  if (pathname === "/api/recurring") {
    if (method === "GET") return Response.json(listRecurring(ctx.db));
    if (method === "POST") {
      let input: CreateRecurringInput;
      try {
        input = (await req.json()) as CreateRecurringInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      const title = typeof input?.title === "string" ? input.title.trim() : "";
      const body = typeof input?.body === "string" ? input.body.trim() : "";
      if (!title && !body) return badRequest("a description (or title) is required");
      const scheduleError = validateRecurringSchedule(input);
      if (scheduleError) return badRequest(scheduleError);
      if (input.priority != null && !/^P[0-3]$/.test(String(input.priority))) {
        return badRequest("priority must be P0..P3");
      }
      if (input.project != null && (typeof input.project !== "string" || !input.project)) {
        return badRequest("project must be a slug or null");
      }
      const created = createRecurring(ctx.db, {
        title: title || undefined,
        body: body || undefined,
        cadence: input.cadence,
        dayOfWeek: input.dayOfWeek,
        dayOfMonth: input.dayOfMonth,
        time: input.time,
        ...(input.project ? { project: input.project } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
      });
      ctx.hub.broadcast({ type: "event", name: "recurring:updated", payload: created.id });
      return Response.json(created, { status: 201 });
    }
    return methodNotAllowed();
  }

  const recurringMatch = pathname.match(/^\/api\/recurring\/([^/]+)$/);
  if (recurringMatch) {
    const id = recurringMatch[1] as string;
    if (method === "GET") {
      const rec = getRecurring(ctx.db, id);
      return rec ? Response.json(rec) : notFound(pathname);
    }
    if (method === "PATCH") {
      let patch: UpdateRecurringInput;
      try {
        patch = (await req.json()) as UpdateRecurringInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      const existing = getRecurring(ctx.db, id);
      if (!existing) return notFound(pathname);
      if (typeof patch?.title === "string" && !patch.title.trim()) {
        return badRequest("title cannot be blank");
      }
      // Validate the schedule as it will be after the merge, so a partial patch
      // (e.g. cadence → weekly without a dayOfWeek) can't produce a broken template.
      const merged = {
        cadence: patch.cadence ?? existing.cadence,
        dayOfWeek: patch.dayOfWeek !== undefined ? patch.dayOfWeek : existing.dayOfWeek,
        dayOfMonth: patch.dayOfMonth !== undefined ? patch.dayOfMonth : existing.dayOfMonth,
        time: patch.time ?? existing.time,
      };
      const scheduleError = validateRecurringSchedule(merged);
      if (scheduleError) return badRequest(scheduleError);
      if (patch.priority != null && !/^P[0-3]$/.test(String(patch.priority))) {
        return badRequest("priority must be P0..P3");
      }
      const updated = updateRecurring(ctx.db, id, patch);
      if (!updated) return notFound(pathname);
      ctx.hub.broadcast({ type: "event", name: "recurring:updated", payload: id });
      return Response.json(updated);
    }
    if (method === "DELETE") {
      if (!deleteRecurring(ctx.db, id)) return notFound(pathname);
      ctx.hub.broadcast({ type: "event", name: "recurring:updated", payload: id });
      return Response.json({ deleted: true });
    }
    return methodNotAllowed();
  }

  // "Run now": fire the template immediately. Counts as a trigger — the next
  // run re-anchors at now, and the created task flows through triage like capture.
  const recurringRunMatch = pathname.match(/^\/api\/recurring\/([^/]+)\/run$/);
  if (recurringRunMatch) {
    if (method !== "POST") return methodNotAllowed();
    const fired = triggerRecurring(ctx.db, recurringRunMatch[1] as string);
    if (!fired) return notFound(pathname);
    ctx.hub.broadcast({ type: "event", name: "task:created", payload: fired.task.id });
    ctx.hub.broadcast({ type: "event", name: "recurring:updated", payload: fired.recurring.id });
    maybeTriageOnCapture(ctx, fired.task.id); // background; no-op unless autonomy is on
    return Response.json(fired, { status: 201 });
  }

  // Template attachments (multipart form, any field name) — same contract as task
  // attachments; stored under ~/.cadence/recurring/<id>/attachments/ and copied onto
  // every task the template creates.
  const recurringAttachListMatch = pathname.match(/^\/api\/recurring\/([^/]+)\/attachments$/);
  if (recurringAttachListMatch) {
    const id = recurringAttachListMatch[1] as string;
    if (!getRecurring(ctx.db, id)) return notFound(pathname);
    if (method === "GET") return Response.json(listRecurringAttachments(id));
    if (method === "POST") {
      const files: Array<{ name: string; arrayBuffer(): Promise<ArrayBuffer> }> = [];
      try {
        const form = await req.formData();
        for (const [, value] of form) {
          if (typeof value !== "string" && value.size > 0) files.push(value);
        }
      } catch {
        return badRequest("expected multipart/form-data with at least one file");
      }
      if (!files.length) return badRequest("no files in upload");
      for (const file of files) {
        saveRecurringAttachment(id, file.name || "pasted-file", new Uint8Array(await file.arrayBuffer()));
      }
      ctx.hub.broadcast({ type: "event", name: "recurring:updated", payload: id });
      return Response.json(listRecurringAttachments(id), { status: 201 });
    }
    return methodNotAllowed();
  }

  const recurringAttachFileMatch = pathname.match(/^\/api\/recurring\/([^/]+)\/attachments\/([^/]+)$/);
  if (recurringAttachFileMatch) {
    const id = recurringAttachFileMatch[1] as string;
    const name = decodeURIComponent(recurringAttachFileMatch[2] as string);
    if (!getRecurring(ctx.db, id)) return notFound(pathname);
    if (method === "GET") {
      const file = recurringAttachmentPath(id, name);
      if (!file) return notFound(pathname);
      return new Response(Bun.file(file));
    }
    if (method === "DELETE") {
      if (!deleteRecurringAttachment(id, name)) return notFound(pathname);
      ctx.hub.broadcast({ type: "event", name: "recurring:updated", payload: id });
      return Response.json(listRecurringAttachments(id));
    }
    return methodNotAllowed();
  }

  if (pathname === "/api/fleets") {
    if (method === "GET") return Response.json(listFleets(ctx.db));
    if (method === "POST") {
      let input: CreateFleetInput;
      try {
        input = (await req.json()) as CreateFleetInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (!name) return badRequest("name is required");
      const fleet = createFleet(ctx.db, { ...input, name });
      ctx.hub.broadcast({ type: "event", name: "fleet:created", payload: fleet.slug });
      return Response.json(fleet, { status: 201 });
    }
    return methodNotAllowed();
  }

  const fleetRunMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/fleet-run$/);
  if (fleetRunMatch) {
    if (method !== "POST") return methodNotAllowed();
    const taskId = fleetRunMatch[1] as string;
    if (!getTask(ctx.db, taskId)) return notFound(pathname);
    const outcome = await runFleetImplementer(ctx.db, taskId, ctx.runAgent);
    if (outcome.ran) {
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      ctx.hub.broadcast({ type: "event", name: "fleet:ran", payload: taskId });
    }
    return Response.json(outcome);
  }

  const fleetMatch = pathname.match(/^\/api\/fleets\/([^/]+)$/);
  if (fleetMatch) {
    const slug = fleetMatch[1] as string;
    if (method === "GET") {
      const fleet = getFleet(ctx.db, slug);
      return fleet ? Response.json(fleet) : notFound(pathname);
    }
    if (method === "PATCH") {
      let patch: UpdateFleetInput;
      try {
        patch = (await req.json()) as UpdateFleetInput;
      } catch {
        return badRequest("invalid JSON body");
      }
      if (typeof patch?.name === "string" && !patch.name.trim()) {
        return badRequest("name cannot be blank");
      }
      const updated = updateFleet(ctx.db, slug, patch);
      if (!updated) return notFound(pathname);
      ctx.hub.broadcast({ type: "event", name: "fleet:updated", payload: updated.slug });
      return Response.json(updated);
    }
    return methodNotAllowed();
  }

  return notFound(pathname);
}

/**
 * The execution chain: Implementer → Verifier → (passed) Delivery. When the run
 * mutates the project working dir itself (worktrees disabled — the default — or
 * apply_in_place delivery), it holds the project's write lock for the WHOLE chain:
 * one implementation per project at a time, read stages queued meanwhile, and the
 * repo is back on its base branch before the lock is released. Worktree-isolated
 * executions skip the lock entirely and stay fully parallel.
 */
/**
 * A PLAY whose Planner never delivered (no JSON, cap full, runner crash) must not
 * strand the task in Implementing — move it back to Ready (PLAY reappears), note
 * why on the context channel, and notify. Never silent (§10).
 */
function recoverFailedPlay(ctx: ApiContext, taskId: string, reason: string): void {
  appendContext(taskId, `PLAY didn't start: ${reason} — task moved back to Ready; press PLAY to retry.`);
  const reverted = updateTask(ctx.db, taskId, { status: "ready" });
  ctx.hub.broadcast({ type: "event", name: "task:context", payload: taskId });
  ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
  if (reverted) {
    ctx.hub.broadcast({
      type: "event",
      name: "notify",
      payload: { kind: "stalled", title: "PLAY didn't start", message: reverted.title, taskId },
    });
  }
}

async function runExecutionChain(ctx: ApiContext, taskId: string): Promise<void> {
  let release: (() => void) | null = null;
  try {
    const lockTarget = executionLockTarget(ctx.db, taskId);
    if (lockTarget) {
      release = await projectLocks.acquireWrite(lockTarget.projectId, {
        guard: { db: ctx.db, rootPath: lockTarget.rootPath, excludeTaskId: taskId },
        onQueued: () => {
          // Visible queueing (§10: never lie about state): the project dir is busy with
          // another in-place run — note it on the timeline and let the card spin as "queued".
          recordEvent(ctx.db, {
            taskId,
            type: "execution_queued",
            payload: { projectId: lockTarget.projectId },
          });
          ctx.activity.start(taskId, "queued");
          ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
        },
      });
      ctx.activity.end(taskId, "queued"); // clear the "queued" spinner if we showed one
    }

    const r = await ctx.activity.track(taskId, "implementer", () =>
      runImplementer(ctx.db, taskId, ctx.runAgent),
    );
    if (!r.ran) {
      // A graceful bail (dirty tree, no work product, dangerous-without-worktree…) must
      // be visible AND actionable — not a silent stall in Implementing, which nothing
      // re-enters. Note the reason, move the task back to Ready (PLAY reappears), notify.
      if (r.reason) {
        appendContext(taskId, `Implementer didn't deliver: ${r.reason}`);
        ctx.hub.broadcast({ type: "event", name: "task:context", payload: taskId });
      }
      const bailed = getTask(ctx.db, taskId);
      if (bailed?.status === "implementing") {
        const reverted = updateTask(ctx.db, taskId, { status: "ready" });
        if (reverted) {
          ctx.hub.broadcast({
            type: "event",
            name: "notify",
            payload: {
              kind: "stalled",
              title: "Implementation didn't deliver",
              message: `${reverted.title} — moved back to Ready${r.reason ? ` (${r.reason})` : ""}`,
              taskId,
            },
          });
        }
      }
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      return;
    }
    ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    ctx.hub.broadcast({ type: "event", name: "task:implemented", payload: taskId });
    // Implemented → Verifier (tests/build/lint + diverse reviewers) → pass/fail.
    const v = await ctx.activity.track(taskId, "verifier", () =>
      runVerifier(ctx.db, taskId, ctx.runAgent),
    );
    if (v.ran) {
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      ctx.hub.broadcast({ type: "event", name: "task:verified", payload: taskId });
      // Passed → the task lands in Review for the human to merge (3.7); notify
      // so it surfaces in the "needs you" feed. Delivery then writes the summary.
      if (v.passed) {
        const reviewing = getTask(ctx.db, taskId);
        if (reviewing) notifyOnTransition(ctx.hub, "verifying", reviewing);
        const d = await ctx.activity.track(taskId, "delivery", () =>
          runDelivery(ctx.db, taskId, ctx.runAgent),
        );
        if (d.ran) ctx.hub.broadcast({ type: "event", name: "task:delivered", payload: taskId });
      } else {
        // Failed → ALSO Review (applyVerify routes it there with the red badge), but
        // with its own message — "Ready to merge" would lie about state (§10).
        const failed = getTask(ctx.db, taskId);
        if (failed) {
          ctx.hub.broadcast({
            type: "event",
            name: "notify",
            payload: { kind: "review", title: "Verification failed — review needed", message: failed.title, taskId },
          });
        }
      }
    } else if (v.reason) {
      // Verifier bail (no JSON, missing worktree…) must be visible, not a silent
      // stall in Verifying — same contract as the implementer bail above.
      appendContext(taskId, `Verifier didn't run: ${v.reason}`);
      ctx.hub.broadcast({ type: "event", name: "task:context", payload: taskId });
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    }
  } catch (err) {
    console.error(`[cadence] execution failed for ${taskId}:`, err);
  } finally {
    release?.();
  }
}

/**
 * The review-apply chain (§6.5.d): hold the project write lock, check out the PR/MR
 * head branch deterministically, run the apply agent on it, then push + restore the
 * previous branch. Replies are NOT posted here — that stays an explicit workspace
 * action (6.5.f).
 */
async function runReviewApplyChain(ctx: ApiContext, taskId: string): Promise<void> {
  let release: (() => void) | null = null;
  let session: { previousBranch?: string } = {};
  const task = getTask(ctx.db, taskId);
  const ref = task?.reviewRef ? parsePrUrl(task.reviewRef) : null;
  const cwd = resolveTaskCwd(ctx.db, taskId);
  try {
    const lockTarget = executionLockTarget(ctx.db, taskId);
    if (lockTarget) {
      release = await projectLocks.acquireWrite(lockTarget.projectId, {
        guard: { db: ctx.db, rootPath: lockTarget.rootPath, excludeTaskId: taskId },
        onQueued: () => {
          ctx.activity.start(taskId, "queued");
          ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
        },
      });
      ctx.activity.end(taskId, "queued");
    }

    let branch: string | null = null;
    try {
      branch = ref ? (ctx.reviewApi ?? forgeReviewApi)(ref.forge).fetchMeta(ref).headBranch : null;
    } catch {
      branch = null;
    }
    if (!ref || !branch) {
      appendContext(taskId, "Review apply: couldn't determine the PR/MR head branch — fix the link and re-approve.");
      updateTask(ctx.db, taskId, { status: "plan_review" });
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      return;
    }
    const prep = prepareReviewBranch(cwd, branch);
    if (!prep.ok) {
      appendContext(taskId, `Review apply: ${prep.reason}.`);
      updateTask(ctx.db, taskId, { status: "plan_review" });
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      return;
    }
    session = prep;

    let outcome: Awaited<ReturnType<typeof runReviewResponderApply>>;
    try {
      outcome = await ctx.activity.track(taskId, "review_responder", () =>
        runReviewResponderApply(ctx.db, taskId, cwd, ctx.runAgent),
      );
    } catch (err) {
      // The spawn/track crashed (cap full, stage conflict, runner error). NEVER leave
      // the user's checkout parked on the PR branch — restore it, then re-arm the
      // approval so "Approve & apply" can be retried.
      finalizeReviewBranch(cwd, branch, session.previousBranch ?? branch);
      appendContext(taskId, `Review apply failed: ${(err as Error).message} — branch restored; re-approve to retry.`);
      updateTask(ctx.db, taskId, { status: "plan_review" });
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      throw err; // outer catch logs
    }
    const fin = finalizeReviewBranch(cwd, branch, session.previousBranch ?? branch);
    if (!fin.pushed && outcome.status === "review") {
      appendContext(taskId, `Review apply: changes committed but ${fin.reason ?? "push failed"} — push manually.`);
    }
    ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    const after = getTask(ctx.db, taskId);
    if (after) notifyOnTransition(ctx.hub, "implementing", after);
  } catch (err) {
    console.error(`[cadence] review apply failed for ${taskId}:`, err);
  } finally {
    release?.();
  }
}

/** Validate a recurring schedule (used for create and for the post-merge state of
 *  a patch). Returns a human-readable problem, or null when the schedule is sound. */
function validateRecurringSchedule(s: {
  cadence?: unknown;
  dayOfWeek?: unknown;
  dayOfMonth?: unknown;
  time?: unknown;
}): string | null {
  if (!RECURRING_CADENCES.includes(s.cadence as never)) {
    return `cadence must be one of ${RECURRING_CADENCES.join("|")}`;
  }
  if (typeof s.time !== "string" || !parseTimeOfDay(s.time)) {
    return 'time must be "HH:MM" (24h)';
  }
  if (s.cadence === "weekly") {
    const d = s.dayOfWeek;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6) {
      return "dayOfWeek must be an integer 0–6 (0 = Sunday) for a weekly schedule";
    }
  }
  if (s.cadence === "monthly") {
    const d = s.dayOfMonth;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 31) {
      return "dayOfMonth must be an integer 1–31 for a monthly schedule";
    }
  }
  return null;
}

/** The slice of ApiContext the autonomy pipeline needs — also satisfiable by the
 *  gateway's recurring scheduler, which triages its created tasks like captures. */
export type AutonomyContext = Pick<ApiContext, "db" | "hub" | "activity" | "runAgent">;

/**
 * Phase 2 autonomy: when the master switch is on, triage a freshly-captured task
 * in the background (fire-and-forget) and broadcast the result. No-op when off,
 * so the default install never spawns claude on capture.
 */
export function maybeTriageOnCapture(ctx: AutonomyContext, taskId: string): void {
  if (!readSettings().global.autonomy) return;
  void ctx.activity
    .track(taskId, "triage", () => runTriage(ctx.db, taskId, ctx.runAgent))
    .then(async (outcome) => {
      if (!outcome.ran) return;
      ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
      if (outcome.status === "needs_feedback") {
        const t = getTask(ctx.db, taskId);
        if (t) notifyOnTransition(ctx.hub, "inbox", t);
        return;
      }
      await continueRefinement(ctx, taskId);
    })
    .catch((err) => console.error(`[cadence] autonomy pipeline failed for ${taskId}:`, err));
}

/**
 * Continue a just-triaged task into the refinement loop: Discovery, then (when the
 * spec has unknowns) the Questioner. Shared by triage-on-capture and the resume
 * after the user answers triage's "which project?" card.
 */
async function continueRefinement(ctx: AutonomyContext, taskId: string): Promise<void> {
  // Auto-continue into Discovery — unless the assigned project opted out of
  // autonomy (§9.1: per-project enable/disable, falls back to the global switch).
  ctx.hub.broadcast({ type: "event", name: "task:triaged", payload: taskId });
  const triaged = getTask(ctx.db, taskId);
  if (!resolveProjectAutonomy(ctx.db, triaged?.projectId ?? null)) return;
  const disc = await ctx.activity.track(taskId, "discovery", () =>
    runDiscovery(ctx.db, taskId, ctx.runAgent),
  );
  if (!disc.ran) return;
  ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
  if (disc.status === "needs_feedback") {
    const t = getTask(ctx.db, taskId);
    if (t) notifyOnTransition(ctx.hub, "refining", t);
    return;
  }
  // Refining with unknowns → the Questioner turns them into Q&A cards.
  if (disc.status === "refining") {
    const q = await ctx.activity.track(taskId, "questioner", () =>
      runQuestioner(ctx.db, taskId, ctx.runAgent),
    );
    if (!q.ran) return;
    ctx.hub.broadcast({ type: "event", name: "task:updated", payload: taskId });
    if (q.status === "needs_feedback") {
      const t = getTask(ctx.db, taskId);
      if (t) notifyOnTransition(ctx.hub, "refining", t);
    }
  }
}

/** A Q&A answer counts as given if it's a non-empty string or a non-empty selection. */
function isAnswered(a: string | string[] | undefined): boolean {
  if (a == null) return false;
  return Array.isArray(a) ? a.length > 0 : a.trim().length > 0;
}

function badRequest(message: string): Response {
  return Response.json({ error: "bad_request", message }, { status: 400 });
}
function notFound(path: string): Response {
  return Response.json({ error: "not_found", path }, { status: 404 });
}
function methodNotAllowed(): Response {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
function conflict(message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: "conflict", message, ...extra }, { status: 409 });
}
