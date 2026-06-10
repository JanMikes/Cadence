import { useSyncExternalStore } from "react";
import { subscribe as subscribeWs } from "./ws";

/**
 * Central date/time formatting (§6.3.d) — every visible timestamp renders through here
 * using PHP-style token patterns from Settings → Formats (default: Czech `d.m.Y H:i:s`).
 * The pattern store hydrates from GET /api/settings and live-updates on the
 * `settings:updated` WS event (same pattern as lib/activity.ts).
 */

export interface DateFormats {
  date: string;
  dateTime: string;
}

export const DEFAULT_FORMATS: DateFormats = { date: "d.m.Y", dateTime: "d.m.Y H:i:s" };

/** Sentinel pattern: defer to the browser's locale formatting. */
export const SYSTEM_FORMAT = "SYSTEM";

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * Render a timestamp with a PHP-style pattern. Supported tokens:
 * d/j (day padded/plain) · m/n (month padded/plain) · Y/y (year full/2-digit) ·
 * H/G (24h hour padded/plain) · i (minutes) · s (seconds). Other characters pass
 * through verbatim; the SYSTEM sentinel falls back to the browser locale.
 */
export function formatTimestamp(
  ts: number | Date | null | undefined,
  pattern: string,
  kind: "date" | "dateTime" = "dateTime",
): string {
  if (ts == null) return "—";
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  if (pattern === SYSTEM_FORMAT) {
    return kind === "date" ? d.toLocaleDateString() : d.toLocaleString();
  }
  return pattern.replace(/[djmnYyHGis]/g, (t) => {
    switch (t) {
      case "d":
        return pad(d.getDate());
      case "j":
        return String(d.getDate());
      case "m":
        return pad(d.getMonth() + 1);
      case "n":
        return String(d.getMonth() + 1);
      case "Y":
        return String(d.getFullYear());
      case "y":
        return pad(d.getFullYear() % 100);
      case "H":
        return pad(d.getHours());
      case "G":
        return String(d.getHours());
      case "i":
        return pad(d.getMinutes());
      case "s":
        return pad(d.getSeconds());
      default:
        return t;
    }
  });
}

export function formatDate(ts: number | Date | null | undefined, f: DateFormats = current): string {
  return formatTimestamp(ts, f.date, "date");
}

/** Format a server-local `YYYY-MM-DD` day key (digest dates, throughput buckets).
 *  Parsed as local time — `new Date("YYYY-MM-DD")` would be UTC midnight and could
 *  shift the day in negative-offset timezones. */
export function formatDayKey(key: string | null | undefined, f: DateFormats = current): string {
  const m = key ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(key) : null;
  if (!m) return key ?? "—";
  return formatTimestamp(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), f.date, "date");
}

export function formatDateTime(ts: number | Date | null | undefined, f: DateFormats = current): string {
  return formatTimestamp(ts, f.dateTime, "dateTime");
}

/** Coarse "time until" label for countdowns ("34 min", "2 h 05 min", "3 d 4 h"). */
export function formatUntil(ts: number, now: number = Date.now()): string {
  const min = Math.max(0, Math.round((ts - now) / 60_000));
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) {
    const rest = min % 60;
    return rest ? `${hours} h ${String(rest).padStart(2, "0")} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  const restH = hours % 24;
  return restH ? `${days} d ${restH} h` : `${days} d`;
}

/** Coarse relative label ("just now", "5 min ago", "3 h ago", "2 d ago"); falls back to
 *  the configured date format beyond two weeks, where relative counts stop being useful. */
export function formatAgo(ts: number, now: number = Date.now(), f: DateFormats = current): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 14) return `${days} d ago`;
  return formatDate(ts, f);
}

// ---------------------------------------------------------------- reactive store

let current: DateFormats = { ...DEFAULT_FORMATS };
const listeners = new Set<() => void>();
let wired = false;

async function hydrate(): Promise<void> {
  try {
    const s = (await fetch("/api/settings").then((r) => r.json())) as {
      formats?: { date?: string; dateTime?: string };
    };
    current = {
      date: s.formats?.date?.trim() || DEFAULT_FORMATS.date,
      dateTime: s.formats?.dateTime?.trim() || DEFAULT_FORMATS.dateTime,
    };
    for (const l of listeners) l();
  } catch {
    /* gateway unreachable — keep defaults */
  }
}

function subscribeStore(listener: () => void): () => void {
  if (!wired) {
    wired = true;
    void hydrate();
    subscribeWs((m) => {
      if (m.type === "event" && m.name === "settings:updated") void hydrate();
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): DateFormats => current;

/** The live date/time patterns from Settings (Czech default), reactive to changes. */
export function useDateFormats(): DateFormats {
  return useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
}
