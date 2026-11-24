/**
 * Helpers for the stream `tags` field.
 * Tags are normalised on write (see tagsSchema in stream-validation.ts),
 * so filtering is a plain exact match on the normalised tag.
 * Streams created before tags existed have no `tags` and never match a filter.
 */
export interface Taggable {
  tags?: string[] | null;
}

export function filterStreamsByTag<T extends Taggable>(
  streams: T[],
  tag: string | undefined,
): T[] {
  if (!tag) return streams;
  return streams.filter((s) => Array.isArray(s.tags) && s.tags.includes(tag));
}