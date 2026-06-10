/**
 * In-app tool-approval registry (spec §9.1, Manual mode). In Manual permission
 * mode the Agent SDK's `canUseTool` callback routes here: each request is parked
 * (the agent blocks) until I approve/deny it in the browser. This is
 * propose-don't-impose at the tool level — and it's the in-app approve/deny that
 * was deferred from Phase 1 to here.
 */
import type { ApprovalDecision, ApprovalRequest } from "@cadence/shared";

export type { ApprovalDecision, ApprovalRequest } from "@cadence/shared";

export type ApprovalEvent = "requested" | "resolved";

export class ApprovalRegistry {
  private pending = new Map<string, { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void }>();

  constructor(private onChange?: (req: ApprovalRequest, event: ApprovalEvent) => void) {}

  /** Park a tool request; resolves when `resolve()` is called for its id. */
  request(
    input: {
      sessionId?: string | null;
      taskId?: string | null;
      toolName: string;
      input?: unknown;
      role?: string | null;
    },
    opts: { id?: string; now?: number } = {},
  ): Promise<ApprovalDecision> {
    const id = opts.id ?? crypto.randomUUID();
    const req: ApprovalRequest = {
      id,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      toolName: input.toolName,
      input: input.input ?? null,
      createdAt: opts.now ?? Date.now(),
      role: input.role ?? null,
    };
    return new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(id, { req, resolve });
      this.onChange?.(req, "requested");
    });
  }

  /** Pending requests, oldest-first. */
  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.req).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Resolve a parked request (approve/deny). Returns false if unknown/already resolved. */
  resolve(id: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.resolve(decision);
    this.onChange?.(entry.req, "resolved");
    return true;
  }

  /** A `canUseTool`-shaped callback bound to this registry (for the Agent SDK). */
  canUseTool(ctx: { sessionId?: string; taskId?: string } = {}) {
    return (toolName: string, input: unknown): Promise<ApprovalDecision> =>
      this.request({ sessionId: ctx.sessionId, taskId: ctx.taskId, toolName, input });
  }
}
