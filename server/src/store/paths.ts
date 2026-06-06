import { join } from "node:path";
import { cadenceHome } from "../db/client";

/**
 * Filesystem layout under ~/.cadence/ (spec §5). All functions read
 * `cadenceHome()` at call time so CADENCE_HOME overrides (tests) take effect.
 */
export const paths = {
  home: () => cadenceHome(),
  settings: () => join(cadenceHome(), "settings.json"),

  tasksDir: () => join(cadenceHome(), "tasks"),
  taskDir: (id: string) => join(cadenceHome(), "tasks", id),
  taskFile: (id: string) => join(cadenceHome(), "tasks", id, "task.md"),
  taskContext: (id: string) => join(cadenceHome(), "tasks", id, "context.md"),
  taskQa: (id: string) => join(cadenceHome(), "tasks", id, "qa.md"),
  taskSpec: (id: string) => join(cadenceHome(), "tasks", id, "spec.md"),
  taskPlan: (id: string) => join(cadenceHome(), "tasks", id, "plan.md"),
  taskVerify: (id: string) => join(cadenceHome(), "tasks", id, "verify.md"),
  taskDelivery: (id: string) => join(cadenceHome(), "tasks", id, "delivery.md"),

  projectsDir: () => join(cadenceHome(), "projects"),
  projectFile: (slug: string) => join(cadenceHome(), "projects", `${slug}.md`),

  fleetsDir: () => join(cadenceHome(), "fleets"),
  fleetFile: (slug: string) => join(cadenceHome(), "fleets", `${slug}.md`),

  memoryDir: () => join(cadenceHome(), "memory"),
  digestsDir: () => join(cadenceHome(), "digests"),
} as const;
