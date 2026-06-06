import type { CreateSavedSearchInput, SavedSearch } from "@cadence/shared";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "./store/paths";

/** Saved searches/filters (spec §10), persisted to ~/.cadence/searches.json. */
function readAll(): SavedSearch[] {
  if (!existsSync(paths.savedSearches())) return [];
  try {
    const data = JSON.parse(readFileSync(paths.savedSearches(), "utf8"));
    return Array.isArray(data) ? (data as SavedSearch[]) : [];
  } catch {
    return [];
  }
}

function writeAll(list: SavedSearch[]): void {
  writeFileSync(paths.savedSearches(), `${JSON.stringify(list, null, 2)}\n`);
}

export function listSavedSearches(): SavedSearch[] {
  return readAll().sort((a, b) => a.createdAt - b.createdAt);
}

export function createSavedSearch(input: CreateSavedSearchInput, now: number = Date.now()): SavedSearch {
  const search: SavedSearch = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    query: input.query,
    createdAt: now,
  };
  writeAll([...readAll(), search]);
  return search;
}

export function deleteSavedSearch(id: string): boolean {
  const all = readAll();
  const next = all.filter((s) => s.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}
