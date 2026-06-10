import { join } from "node:path";
import { cadenceHome } from "../db/client";

/**
 * Filesystem layout under ~/.cadence/ (spec §5). All functions read
 * `cadenceHome()` at call time so CADENCE_HOME overrides (tests) take effect.
 */
export const paths = {
  home: () => cadenceHome(),
  settings: () => join(cadenceHome(), "settings.json"),
  savedSearches: () => join(cadenceHome(), "searches.json"),

  tasksDir: () => join(cadenceHome(), "tasks"),
  taskDir: (id: string) => join(cadenceHome(), "tasks", id),
  taskFile: (id: string) => join(cadenceHome(), "tasks", id, "task.md"),
  taskContext: (id: string) => join(cadenceHome(), "tasks", id, "context.md"),
  taskQa: (id: string) => join(cadenceHome(), "tasks", id, "qa.md"),
  taskReviewFindings: (id: string) => join(cadenceHome(), "tasks", id, "findings.json"),
  taskReviewProposal: (id: string) => join(cadenceHome(), "tasks", id, "review-proposal.json"),
  taskSpec: (id: string) => join(cadenceHome(), "tasks", id, "spec.md"),
  taskPlan: (id: string) => join(cadenceHome(), "tasks", id, "plan.md"),
  taskVerify: (id: string) => join(cadenceHome(), "tasks", id, "verify.md"),
  taskDelivery: (id: string) => join(cadenceHome(), "tasks", id, "delivery.md"),
  // Append-only record of every agent run's final output (content truth — survives
  // transcript GC; the Sessions list is the live/streaming view of the same runs).
  taskRuns: (id: string) => join(cadenceHome(), "tasks", id, "runs.md"),
  // Runtime state for an in-place execution (base branch + untracked snapshot) — JSON,
  // not markdown: machine state for crash-safe restore, not user-editable content.
  taskExecution: (id: string) => join(cadenceHome(), "tasks", id, "execution.json"),
  // User-uploaded files passed to agents as context (referenced by absolute path).
  taskAttachmentsDir: (id: string) => join(cadenceHome(), "tasks", id, "attachments"),
  taskAttachment: (id: string, name: string) => join(cadenceHome(), "tasks", id, "attachments", name),

  projectsDir: () => join(cadenceHome(), "projects"),
  projectFile: (slug: string) => join(cadenceHome(), "projects", `${slug}.md`),

  fleetsDir: () => join(cadenceHome(), "fleets"),
  fleetFile: (slug: string) => join(cadenceHome(), "fleets", `${slug}.md`),

  recurringDir: () => join(cadenceHome(), "recurring"),
  recurringFile: (id: string) => join(cadenceHome(), "recurring", `${id}.md`),

  memoryDir: () => join(cadenceHome(), "memory"),
  memoryFile: (name: string) => join(cadenceHome(), "memory", `${name}.md`),
  projectMemoryDir: () => join(cadenceHome(), "memory", "projects"),
  projectMemoryFile: (slug: string) => join(cadenceHome(), "memory", "projects", `${slug}.md`),
  digestsDir: () => join(cadenceHome(), "digests"),
  digestFile: (date: string) => join(cadenceHome(), "digests", `${date}.md`),
} as const;
