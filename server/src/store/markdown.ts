import matter from "gray-matter";

export interface ParsedDoc<T> {
  data: T;
  body: string;
}

/** Parse YAML-frontmatter markdown into typed `data` + trimmed `body`. The caller
 *  supplies the frontmatter shape `T` (an interface — hence no Record constraint). */
export function parseMarkdown<T>(raw: string): ParsedDoc<T> {
  const { data, content } = matter(raw);
  return { data: data as T, body: content.trim() };
}

/**
 * Serialize `data` as YAML frontmatter followed by `body`. Keys with `undefined`
 * values are dropped (YAML can't represent them); `null` is kept as an explicit
 * blank. The markdown stays the human-editable source of truth (spec §5).
 */
export function stringifyMarkdown(data: Record<string, unknown>, body: string): string {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  return matter.stringify(body ? `${body.trimEnd()}\n` : "", clean);
}
