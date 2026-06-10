import {
  Bot,
  BrainCircuit,
  ChevronRight,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  HardDrive,
  LayoutGrid,
  ListChecks,
  MessagesSquare,
  PackageCheck,
  Play,
  Rocket,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wand2,
  Zap,
} from "lucide-react";
import type { ComponentType } from "react";
import type { ViewId } from "../../components/AppShell";
import { LabeledIconButton } from "../../components/LabeledIconButton";
import { cn } from "../../lib/utils";

type Icon = ComponentType<{ className?: string }>;

/** Who drives a pipeline step — the chip that makes the autonomy model legible at a glance. */
type Actor = "you" | "cadence" | "both";

const ACTOR_CHIP: Record<Actor, { label: string; className: string }> = {
  you: { label: "You", className: "bg-amber-500/15 text-amber-300" },
  cadence: { label: "Cadence — autonomous", className: "bg-primary/10 text-primary" },
  both: { label: "Cadence asks · you answer", className: "bg-indigo-500/15 text-indigo-300" },
};

const STEPS: Array<{ icon: Icon; actor: Actor; title: string; text: string }> = [
  {
    icon: Zap,
    actor: "you",
    title: "Capture",
    text: "Drop a one-liner the moment it hits you — the Add task button, ⌘K, or the global hotkey. A title is enough; Cadence takes it from there.",
  },
  {
    icon: Wand2,
    actor: "cadence",
    title: "Triage & refine",
    text: "Background agents sort it into a project, propose priority, deadline and labels, then build a spec with acceptance criteria.",
  },
  {
    icon: MessagesSquare,
    actor: "both",
    title: "Questions, only when needed",
    text: "Unclear points come back as short Q&A cards (❓). “Too vague” is a valid outcome — Cadence asks instead of guessing. Add free-form context to any task, anytime.",
  },
  {
    icon: Play,
    actor: "you",
    title: "You press PLAY",
    text: "Nothing runs without your green light. A refined task waits as Ready (▶) until you start it.",
  },
  {
    icon: GitBranch,
    actor: "cadence",
    title: "Implement & verify",
    text: "Claude Code plans, codes on an isolated task branch (or worktree), then verifies: tests, build, and your acceptance criteria.",
  },
  {
    icon: PackageCheck,
    actor: "you",
    title: "Review & deliver",
    text: "You review the diff and summary, then deliver — as a branch, an automatic PR, or applied in place. Done.",
  },
];

const FEATURES: Array<{ icon: Icon; title: string; text: string; view: ViewId; open: string }> = [
  {
    icon: Sparkles,
    title: "Today — your daily ritual",
    text: "Each morning Cadence proposes a deadline-first shortlist for the day; you commit to it, watch the progress ring and streak fill, and close with an evening recap.",
    view: "today",
    open: "Open Today",
  },
  {
    icon: LayoutGrid,
    title: "Board — the live lifecycle",
    text: "Every task on a kanban, with agents visibly working. ❓ needs-input and ▶ ready badges pull your attention to exactly what's actionable.",
    view: "board",
    open: "Open Board",
  },
  {
    icon: Terminal,
    title: "Sessions & terminal handoff",
    text: "Every Claude session streams live. Take any of them over in iTerm2/Terminal with one click, or copy a ready-made claude --resume command.",
    view: "sessions",
    open: "Open Sessions",
  },
  {
    icon: FolderGit2,
    title: "Projects & Fleets",
    text: "Per-repo defaults — model, permission mode, delivery, worktree isolation. Group repos into a fleet to run one task across many of them.",
    view: "projects",
    open: "Open Projects",
  },
  {
    icon: BrainCircuit,
    title: "Memory — Cadence learns",
    text: "Your corrections become durable lessons in reviewable markdown memory. It proposes improvements occasionally; you accept, edit, or revert.",
    view: "memory",
    open: "Open Memory",
  },
];

const CONTROLS: Array<{ icon: Icon; title: string; text: string }> = [
  {
    icon: ListChecks,
    title: "Accept · Edit · Override",
    text: "Every AI decision — project, priority, spec, plan — is a proposal with a rationale. One click to change it; nothing is locked in.",
  },
  {
    icon: ShieldCheck,
    title: "Permission modes",
    text: "Auto approves the safe and asks on the rest; Manual gates every action; Dangerous is allowed only in isolated worktrees.",
  },
  {
    icon: Send,
    title: "Explicit publishing",
    text: "Anything outward-facing — review comments, replies, PRs — reaches GitHub/GitLab only after your explicit confirm.",
  },
  {
    icon: HardDrive,
    title: "Local-first",
    text: "Everything lives on this machine — markdown + SQLite under ~/.cadence/. No cloud, no accounts, no telemetry.",
  },
];

const KBD = "rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground";

/**
 * The first-launch guide (auto-opens once, then lives at the bottom of the sidebar).
 * Pure/presentational — App.tsx owns the "seen" persistence and the initial-view decision.
 */
export function Quickstart({
  onNavigate,
  onAddTask,
}: {
  onNavigate: (view: ViewId) => void;
  /** Opens the global Add-task modal (same one as the sidebar button). */
  onAddTask: () => void;
}) {
  return (
    <div className="mx-auto max-w-5xl p-8 pb-16">
      {/* ------------------------------------------------------------- hero */}
      <header className="flex flex-col items-center pt-8 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Welcome to Cadence</h1>
        <p className="mt-1 text-base font-medium text-primary">Your backlog, in flow.</p>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Cadence is your local operational center. Capture tasks all day as they hit you; in the
          background, Claude Code triages and refines them — asking you only when it truly needs
          you. When a task is ready, you press PLAY and watch it get implemented, verified, and
          delivered.
        </p>

        <ul className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {(
            [
              [HardDrive, "100% local"],
              [Bot, "Claude Code does the work"],
              [ShieldCheck, "You stay in control"],
            ] as Array<[Icon, string]>
          ).map(([BadgeIcon, label]) => (
            <li
              key={label}
              className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
            >
              <BadgeIcon className="size-3.5" />
              {label}
            </li>
          ))}
        </ul>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <LabeledIconButton
            icon={<Zap />}
            label="Capture your first task"
            onClick={onAddTask}
          />
          <LabeledIconButton
            variant="outline"
            icon={<Sparkles />}
            label="Open Today"
            onClick={() => onNavigate("today")}
          />
        </div>
      </header>

      {/* ------------------------------------------------------- how it works */}
      <section className="mt-14">
        <h2 className="text-lg font-semibold tracking-tight">How it works</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          From a one-line thought to delivered code — the loop runs itself and stops at the two
          moments that are yours: answering questions and pressing PLAY.
        </p>

        <ol className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {STEPS.map((step, i) => {
            const chip = ACTOR_CHIP[step.actor];
            return (
              <li key={step.title} className="rounded-lg border border-border bg-card/40 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-medium",
                      chip.className,
                    )}
                  >
                    {chip.label}
                  </span>
                </div>
                <div className="mt-3 flex items-center gap-2.5">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <step.icon className="size-4" />
                  </span>
                  <h3 className="text-sm font-medium">{step.title}</h3>
                </div>
                <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">{step.text}</p>
              </li>
            );
          })}
        </ol>

        <p className="mt-4 rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-4 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-indigo-300">Propose, don't impose.</span> Everything
          Cadence decides is a suggestion with a short rationale — you Accept, Edit, or Override in
          one move. Autonomy is the default, but your correction is always one click away.
        </p>
      </section>

      {/* ------------------------------------------------------ what you can do */}
      <section className="mt-14">
        <h2 className="text-lg font-semibold tracking-tight">What you can do with it</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A few places worth knowing on day one — click any card to jump there.
        </p>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {/* Flagship: code review for real PRs/MRs */}
          <button
            type="button"
            onClick={() => onNavigate("board")}
            className="group flex flex-col rounded-lg border border-primary/40 bg-primary/5 p-5 text-left transition-colors hover:border-primary/60 hover:bg-primary/10 sm:col-span-2"
          >
            <div className="flex items-center gap-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
                <GitPullRequest className="size-4.5" />
              </span>
              <h3 className="text-sm font-semibold">
                Code review for real pull & merge requests
              </h3>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Paste a GitHub or GitLab PR/MR URL into Add task — that's the whole setup. Cadence
              detects the direction itself: <span className="text-foreground">someone else's PR</span>{" "}
              → it reads the real diff and drafts review findings for you to triage;{" "}
              <span className="text-foreground">your own PR</span> → it collects reviewer feedback
              and proposes the fixes. Findings and reply drafts land in the Review Workspace first —
              nothing is posted to the forge until you explicitly confirm it.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {["GitHub", "GitLab", "Publishes only on your confirm"].map((chip) => (
                <span
                  key={chip}
                  className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                >
                  {chip}
                </span>
              ))}
            </div>
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary">
              See reviews on the Board
              <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          </button>

          {FEATURES.map((f) => (
            <button
              key={f.title}
              type="button"
              onClick={() => onNavigate(f.view)}
              className="group flex flex-col rounded-lg border border-border bg-card/40 p-4 text-left transition-colors hover:border-primary/40 hover:bg-card/70"
            >
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <f.icon className="size-4" />
                </span>
                <h3 className="text-sm font-medium">{f.title}</h3>
              </div>
              <p className="mt-2.5 flex-1 text-xs leading-relaxed text-muted-foreground">{f.text}</p>
              <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary">
                {f.open}
                <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </button>
          ))}

          {/* ⌘K — informational (the palette opens from anywhere, there's nowhere to navigate) */}
          <div className="flex flex-col rounded-lg border border-border bg-card/40 p-4">
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Search className="size-4" />
              </span>
              <h3 className="text-sm font-medium">Search & command palette</h3>
            </div>
            <p className="mt-2.5 flex-1 text-xs leading-relaxed text-muted-foreground">
              Full-text search across tasks, session transcripts, and memory — doubling as a
              command palette that jumps anywhere and runs quick actions.
            </p>
            <span className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              Press <kbd className={KBD}>⌘K</kbd> anywhere · <kbd className={KBD}>⌘⇧A</kbd> opens
              what needs you
            </span>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ staying in control */}
      <section className="mt-14">
        <h2 className="text-lg font-semibold tracking-tight">You're always in charge</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Autonomous doesn't mean unsupervised — these guardrails hold everywhere.
        </p>

        <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {CONTROLS.map((c) => (
            <li key={c.title} className="rounded-lg border border-border bg-card/40 p-4">
              <div className="flex items-center gap-2">
                <c.icon className="size-4 shrink-0 text-primary" />
                <h3 className="text-sm font-medium">{c.title}</h3>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{c.text}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* ----------------------------------------------------------- send-off */}
      <section className="mt-14 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-primary/30 bg-primary/5 p-5">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Rocket className="size-4 text-primary" />
            You're all set
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            This guide won't open by itself again — reopen it anytime via{" "}
            <span className="font-medium text-foreground">Quickstart</span> at the bottom of the
            sidebar.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LabeledIconButton icon={<Zap />} label="Capture a task" onClick={onAddTask} />
          <LabeledIconButton
            variant="outline"
            icon={<Sparkles />}
            label="Open Today"
            onClick={() => onNavigate("today")}
          />
        </div>
      </section>
    </div>
  );
}
