import type {
  CreateSuggestionInput,
  Suggestion,
  SuggestionAction,
} from "@cadence/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { suggestions } from "./db/schema";

const STATUS_FOR: Record<SuggestionAction, string> = {
  accept: "confirmed",
  edit: "edited",
  override: "overridden",
  dismiss: "dismissed",
};

function toSuggestion(row: typeof suggestions.$inferSelect): Suggestion {
  let value: unknown = null;
  if (row.suggestedValue != null) {
    try {
      value = JSON.parse(row.suggestedValue);
    } catch {
      value = row.suggestedValue;
    }
  }
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    field: row.field,
    value,
    rationale: row.rationale,
    confidence: row.confidence,
    status: row.status,
    source: row.source,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

export function createSuggestion(db: Db, input: CreateSuggestionInput): Suggestion {
  const id = crypto.randomUUID();
  db.insert(suggestions)
    .values({
      id,
      entityType: input.entityType,
      entityId: input.entityId,
      field: input.field,
      suggestedValue: JSON.stringify(input.value ?? null),
      rationale: input.rationale ?? null,
      confidence: input.confidence ?? null,
      status: "suggested",
      source: input.source ?? null,
    })
    .run();
  const created = getSuggestion(db, id);
  if (!created) throw new Error(`createSuggestion: ${id} missing after insert`);
  return created;
}

export function getSuggestion(db: Db, id: string): Suggestion | null {
  const row = db.select().from(suggestions).where(eq(suggestions.id, id)).get();
  return row ? toSuggestion(row) : null;
}

export function listSuggestions(db: Db, entityType: string, entityId: string): Suggestion[] {
  return db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.entityType, entityType), eq(suggestions.entityId, entityId)))
    .orderBy(asc(suggestions.createdAt))
    .all()
    .map(toSuggestion);
}

/**
 * Resolve a suggestion (the Accept/Edit/Override/Dismiss control), recording the
 * provenance: suggested → confirmed | edited | overridden | dismissed. edit/override
 * also store the new value.
 */
export function resolveSuggestion(
  db: Db,
  id: string,
  action: SuggestionAction,
  value?: unknown,
): Suggestion | null {
  if (!getSuggestion(db, id)) return null;
  const set: Partial<typeof suggestions.$inferInsert> = {
    status: STATUS_FOR[action],
    resolvedAt: Date.now(),
  };
  if ((action === "edit" || action === "override") && value !== undefined) {
    set.suggestedValue = JSON.stringify(value);
  }
  db.update(suggestions).set(set).where(eq(suggestions.id, id)).run();
  return getSuggestion(db, id);
}
