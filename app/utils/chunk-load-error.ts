const CHUNK_LOAD_ERROR_PATTERN =
  /chunkloaderror|failed to fetch dynamically imported module|loading chunk/i;

/**
 * Returns true when the thrown value looks like a dynamic-import or webpack
 * chunk-load failure (e.g. after a new deployment invalidates stale assets).
 * Safely handles non-Error throwables.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (typeof error === "string") {
    return CHUNK_LOAD_ERROR_PATTERN.test(error);
  }
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { name?: unknown; message?: unknown };
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const message =
    typeof candidate.message === "string" ? candidate.message : "";
  return CHUNK_LOAD_ERROR_PATTERN.test(`${name} ${message}`);
}
