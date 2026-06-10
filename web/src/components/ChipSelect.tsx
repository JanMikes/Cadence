import { ChevronDown } from "lucide-react";

export interface ChipOption {
  value: string;
  label: string;
}

/** A titled section rendered as an <optgroup>; omit the label for bare options. */
export interface ChipGroup {
  label?: string;
  options: ChipOption[];
}

/**
 * A compact pill selector (composer-style "chip"): a presentational pill backed by an
 * invisible native <select> stretched over it, so keyboard behavior (Tab, Space/Enter,
 * arrows, letter typeahead) and screen-reader semantics stay fully native — no custom
 * popover to maintain. `active` tints the pill when the value is off its default.
 */
export function ChipSelect({
  label,
  value,
  display,
  groups,
  onChange,
  active = false,
  title,
}: {
  /** Pill prefix and the select's accessible name (icon buttons always carry text — §10.1). */
  label: string;
  value: string;
  /** Pill value text override (e.g. "✨ Auto"); defaults to the selected option's label. */
  display?: string;
  groups: ChipGroup[];
  onChange: (value: string) => void;
  /** True when the value is off-default — tints the pill so explicit picks stand out. */
  active?: boolean;
  title?: string;
}) {
  const selected = groups.flatMap((g) => g.options).find((o) => o.value === value);
  return (
    <span
      title={title}
      className="relative inline-flex rounded-full focus-within:ring-2 focus-within:ring-ring"
    >
      <span
        aria-hidden
        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
          active
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-border bg-muted text-muted-foreground"
        }`}
      >
        <span className="font-medium">{label}:</span>
        <span className="max-w-40 truncate">{display ?? selected?.label ?? value}</span>
        <ChevronDown className="size-3 shrink-0" />
      </span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      >
        {groups.map((g, i) =>
          g.label ? (
            <optgroup key={g.label} label={g.label}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ) : (
            g.options.map((o) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: bare groups are static
              <option key={`${i}-${o.value}`} value={o.value}>
                {o.label}
              </option>
            ))
          ),
        )}
      </select>
    </span>
  );
}
