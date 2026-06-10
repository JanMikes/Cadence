import { Combobox, ComboboxButton, ComboboxInput } from "@headlessui/react";
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "../lib/utils";
import { filterGroups, flattenGroups, guardComboboxKeys, SelectOptionsPanel } from "./SelectBox";

export interface ChipOption {
  value: string;
  label: string;
}

/** A titled section of options; omit the label for bare options. */
export interface ChipGroup {
  label?: string;
  options: ChipOption[];
}

/**
 * A compact pill selector (composer-style "chip") on the shared autocomplete
 * mechanism (Headless UI Combobox, see SelectBox.tsx): clicking the pill opens
 * the full list, typing in place filters it, arrows + Enter pick, Esc restores.
 * `active` tints the pill when the value is off its default.
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
  /** Pill prefix and the control's accessible name (icon buttons always carry text — §10.1). */
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
  const flat = flattenGroups(groups);
  const labelFor = (v: string) => {
    const selected = flat.find((o) => o.value === v);
    return display ?? selected?.label ?? v;
  };
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <Combobox
      immediate
      value={value}
      onChange={(v: string | null) => {
        if (v != null) onChange(v);
      }}
      onClose={() => setQuery("")}
    >
      {({ open }) => {
        // The input is sized to its visible text (ch ≈ a character) so the pill
        // hugs its content like the old static pill did; capped so a long label
        // can't blow the composer row apart.
        const shown = open && query ? query : labelFor(value);
        const widthCh = Math.min(24, Math.max(3, shown.length + 1));
        return (
          <>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-focus convenience; the input itself is fully keyboard-accessible */}
            <span
              title={title}
              onClick={() => inputRef.current?.focus()}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1 text-xs focus-within:ring-2 focus-within:ring-ring",
                active
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-muted text-muted-foreground",
              )}
            >
              <span className="shrink-0 font-medium">{label}:</span>
              <ComboboxInput
                ref={inputRef}
                aria-label={label}
                displayValue={labelFor}
                // SSR/first paint: the selected label is real markup, not a post-mount effect.
                defaultValue={labelFor(value)}
                autoComplete="off"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => guardComboboxKeys(e, open)}
                style={{ width: `${widthCh}ch` }}
                className="bg-transparent text-current outline-none placeholder:text-muted-foreground"
              />
              <ComboboxButton
                className="shrink-0 text-current"
                aria-label={`Show ${label} options`}
              >
                <ChevronDown className="size-3" />
              </ComboboxButton>
            </span>
            <SelectOptionsPanel groups={filterGroups(groups, query)} value={value} widthClass="w-56" />
          </>
        );
      }}
    </Combobox>
  );
}
