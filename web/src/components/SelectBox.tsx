import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from "@headlessui/react";
import { Check, ChevronDown } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { cn } from "../lib/utils";

/**
 * The app-wide select mechanism (Headless UI Combobox): every dropdown is a
 * type-to-filter autocomplete — click (or focus) opens the full list, typing
 * narrows it, arrows + Enter pick, Esc restores. Replaces all native <select>s
 * for a consistent, searchable experience (long project/task lists especially).
 * The options panel is portalled + anchor-positioned, so it never gets clipped
 * by scrolling modals.
 */

export interface SelectOption {
  value: string;
  label: string;
  /** Secondary line shown under the label in the dropdown (e.g. a mode description). */
  hint?: string;
}

/** A titled section of options; omit the label for a bare group. */
export interface SelectGroup {
  label?: string;
  options: SelectOption[];
}

export function flattenGroups(groups: SelectGroup[]): SelectOption[] {
  return groups.flatMap((g) => g.options);
}

/**
 * Keep the combobox's keyboard behavior select-like inside forms/modals:
 * Enter in a CLOSED combobox must not submit the surrounding form, and Esc in
 * an OPEN one closes just the dropdown — not the modal listening on window.
 * (Cmd/Ctrl+Enter passes through so "⌘↵ to save" keeps working everywhere.)
 */
export function guardComboboxKeys(e: KeyboardEvent, open: boolean): void {
  if (e.key === "Enter" && !open && !e.metaKey && !e.ctrlKey) e.preventDefault();
  if (e.key === "Escape" && open) e.stopPropagation();
}

/** Case-insensitive label filter, keeping only groups that still have matches. */
export function filterGroups(groups: SelectGroup[], query: string): SelectGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups.filter((g) => g.options.length > 0);
  return groups
    .map((g) => ({ ...g, options: g.options.filter((o) => o.label.toLowerCase().includes(q)) }))
    .filter((g) => g.options.length > 0);
}

/** The shared dropdown panel (groups, hints, check on the current value). */
export function SelectOptionsPanel({
  groups,
  value,
  widthClass = "w-[max(var(--input-width),11rem)]",
}: {
  groups: SelectGroup[];
  value: string;
  /** Panel width; defaults to the control's width but never narrower than 11rem. */
  widthClass?: string;
}) {
  return (
    <ComboboxOptions
      anchor="bottom start"
      className={cn(
        "z-[90] max-h-64 overflow-auto rounded-md border border-border bg-card p-1 shadow-xl [--anchor-gap:4px] focus:outline-none",
        widthClass,
      )}
    >
      {groups.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">No matches</div>
      ) : (
        groups.map((g, gi) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: group sets are static per render
          <div key={g.label ?? gi}>
            {g.label ? (
              <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {g.label}
              </div>
            ) : null}
            {g.options.map((o) => (
              <ComboboxOption
                key={o.value}
                value={o.value}
                className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm data-focus:bg-accent"
              >
                <Check
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    o.value === value ? "text-primary" : "invisible",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{o.label}</span>
                  {o.hint ? (
                    <span className="block text-xs leading-snug text-muted-foreground">{o.hint}</span>
                  ) : null}
                </span>
              </ComboboxOption>
            ))}
          </div>
        ))
      )}
    </ComboboxOptions>
  );
}

/**
 * Field-style select (the form-input look). Drop-in for a native <select>:
 * pass flat `options` or titled `groups`; size the control via `className`.
 */
export function SelectBox({
  label,
  value,
  options,
  groups,
  onChange,
  placeholder = "Select…",
  disabled = false,
  size = "md",
  className,
  title,
}: {
  /** Accessible name (and the search input's aria-label). */
  label: string;
  value: string;
  options?: SelectOption[];
  groups?: SelectGroup[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  /** Extra classes for the control (width etc.). */
  className?: string;
  title?: string;
}) {
  const allGroups: SelectGroup[] = groups ?? [{ options: options ?? [] }];
  const flat = flattenGroups(allGroups);
  const labelFor = (v: string) => flat.find((o) => o.value === v)?.label ?? "";
  const [query, setQuery] = useState("");

  return (
    <Combobox
      immediate
      value={value}
      onChange={(v: string | null) => {
        if (v != null) onChange(v);
      }}
      onClose={() => setQuery("")}
      disabled={disabled}
    >
      {({ open }) => (
        <>
          <div
            title={title}
            className={cn(
              "relative flex items-center rounded-md border border-border bg-card focus-within:ring-2 focus-within:ring-ring",
              disabled && "pointer-events-none opacity-50",
              className,
            )}
          >
            <ComboboxInput
              aria-label={label}
              displayValue={labelFor}
              // SSR/first paint: the selected label is real markup, not a post-mount effect.
              defaultValue={labelFor(value)}
              placeholder={placeholder}
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => guardComboboxKeys(e, open)}
              className={cn(
                "w-full min-w-0 bg-transparent outline-none placeholder:text-muted-foreground",
                size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-2 text-sm",
              )}
            />
            <ComboboxButton
              className="shrink-0 self-stretch pl-1 pr-2 text-muted-foreground hover:text-foreground"
              aria-label={`Show ${label} options`}
            >
              <ChevronDown className={size === "sm" ? "size-3" : "size-3.5"} />
            </ComboboxButton>
          </div>
          <SelectOptionsPanel groups={filterGroups(allGroups, query)} value={value} />
        </>
      )}
    </Combobox>
  );
}
