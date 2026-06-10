/**
 * Deterministic branch handling for the review-apply phase (§6.5.d): Cadence — not
 * the agent — fetches and checks out the PR/MR branch, and restores the previous
 * branch afterwards (the in-place guardrail "never switch branches" stays true for
 * the AGENT; the switching is ours, under the project write lock).
 */

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, stdout: r.stdout.toString().trim(), stderr: r.stderr.toString().trim() };
}

export interface ReviewBranchSession {
  ok: boolean;
  /** The branch to restore afterwards. */
  previousBranch?: string;
  reason?: string;
}

/** Fetch + switch to the PR/MR head branch. Refuses on a dirty tree (user's checkout!). */
export function prepareReviewBranch(cwd: string, branch: string): ReviewBranchSession {
  const dirty = git(["status", "--porcelain"], cwd);
  if (!dirty.ok) return { ok: false, reason: `not a git repo (${dirty.stderr.slice(0, 120)})` };
  if (dirty.stdout) return { ok: false, reason: "working tree has uncommitted changes — commit or stash first" };

  const current = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (!current.ok) return { ok: false, reason: "couldn't read the current branch" };

  const fetched = git(["fetch", "origin", branch], cwd);
  if (!fetched.ok) return { ok: false, reason: `fetch failed: ${fetched.stderr.slice(0, 160)}` };

  // Switch to the local branch if it exists, else create it tracking origin.
  const sw = git(["switch", branch], cwd);
  if (!sw.ok) {
    const create = git(["switch", "-c", branch, "--track", `origin/${branch}`], cwd);
    if (!create.ok) return { ok: false, reason: `switch failed: ${create.stderr.slice(0, 160)}` };
  } else {
    // Fast-forward to the remote tip so the agent works on the latest review state.
    git(["merge", "--ff-only", `origin/${branch}`], cwd);
  }
  return { ok: true, previousBranch: current.stdout };
}

/** Push the branch (best-effort) and restore the previous branch. */
export function finalizeReviewBranch(
  cwd: string,
  branch: string,
  previousBranch: string,
): { pushed: boolean; restored: boolean; reason?: string } {
  const pushed = git(["push", "origin", branch], cwd);
  const back = git(["switch", previousBranch], cwd);
  return {
    pushed: pushed.ok,
    restored: back.ok,
    reason: !pushed.ok ? `push failed: ${pushed.stderr.slice(0, 160)}` : !back.ok ? "couldn't restore branch" : undefined,
  };
}
