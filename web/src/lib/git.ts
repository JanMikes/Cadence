import type { TaskGitContext } from "@cadence/shared";

/**
 * Plain-language rendering of a task's git outcome (design rule: no internal
 * jargon — "Not merged yet", never "unmerged:external").
 */
export function gitStateLabel(ctx: TaskGitContext): string {
  if (ctx.kind === "direct") {
    return ctx.baseBranch ? `Committed directly to ${ctx.baseBranch}` : "Committed directly";
  }
  switch (ctx.merged) {
    case "merged": {
      const into = ctx.baseBranch ? ` into ${ctx.baseBranch}` : "";
      if (ctx.mergedVia === "cadence") return `Merged${into} via Cadence`;
      if (ctx.mergedVia === "forge") return `Merged${into} via the PR/MR`;
      return `Merged${into} outside Cadence`;
    }
    case "unmerged":
      return "Not merged yet";
    case "branch_gone":
      return "Branch gone — possibly squash-merged";
    default:
      return "Merge state unknown";
  }
}

/** Color semantics for the state: shipped = green, waiting-on-you = amber, else quiet. */
export function gitStateTone(ctx: TaskGitContext): "ok" | "warn" | "muted" {
  if (ctx.kind === "direct" || ctx.merged === "merged") return "ok";
  if (ctx.merged === "unmerged" || ctx.merged === "branch_gone") return "warn";
  return "muted";
}
