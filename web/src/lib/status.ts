// Board columns in lifecycle order with plain-language labels (spec §10.1 — no
// internal jargon: states read as what they mean).
export interface StatusColumn {
  id: string;
  label: string;
}

export const BOARD_COLUMNS: StatusColumn[] = [
  { id: "inbox", label: "Inbox" },
  { id: "triaged", label: "Triaged" },
  { id: "refining", label: "Refining" },
  { id: "needs_feedback", label: "Needs input" },
  { id: "ready", label: "Ready" },
  { id: "implementing", label: "In progress" },
  { id: "verifying", label: "Verifying" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

export const STATUS_LABELS: Record<string, string> = Object.fromEntries(
  [
    ...BOARD_COLUMNS,
    { id: "blocked", label: "Blocked" },
    { id: "cancelled", label: "Cancelled" },
  ].map((c) => [c.id, c.label]),
);

export function statusLabel(id: string): string {
  return STATUS_LABELS[id] ?? id;
}

// Plain-language labels for session roles — the agent pipeline stages plus interactive kinds.
export const ROLE_LABELS: Record<string, string> = {
  triage: "Triage",
  discovery: "Discovery",
  questioner: "Questioner",
  planner: "Planner",
  implementer: "Implementer",
  verifier: "Verifier",
  delivery: "Delivery",
  reflector: "Reflector",
  chat: "Chat",
  import: "Import",
  digest: "Digest",
};

export function roleLabel(id: string): string {
  return ROLE_LABELS[id] ?? id;
}
