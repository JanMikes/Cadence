const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");

/**
 * ⌘⇧A / Ctrl⇧A — toggles the "needs you" Attention Center. Single source of truth so the
 * keycap shown on the pill (`label`) and the keydown matcher (`matches`) can never drift.
 */
export const ATTENTION_SHORTCUT = {
  label: isMac ? "⇧⌘A" : "Ctrl⇧A",
  matches: (e: KeyboardEvent): boolean =>
    (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "a",
};
