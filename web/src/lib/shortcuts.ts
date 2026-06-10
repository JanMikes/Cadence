/** True when the event originates from somewhere the user is typing — bare-letter
 *  shortcuts must never fire there. */
function isTyping(e: KeyboardEvent): boolean {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

/**
 * A — toggles the "needs you" Attention Center. Single source of truth so the
 * keycap shown on the pill (`label`) and the keydown matcher (`matches`) can never
 * drift. A bare letter: inert while typing in any field and with any modifier held.
 */
export const ATTENTION_SHORTCUT = {
  label: "A",
  matches: (e: KeyboardEvent): boolean =>
    e.key.toLowerCase() === "a" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !isTyping(e),
};
