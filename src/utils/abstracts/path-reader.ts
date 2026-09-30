import { PathUtils } from '../path-utils';

/**
 * Universal path traversal, the single implementation behind every store read
 * (`ProxyFactory` root reads, `CreateStoreService.fastReadBySegments`, the managers).
 */

/** Segments of a path in any notation; empty for an empty path. */
export function segmentsOf(path: string): readonly string[] {
  const normalized = PathUtils.normalizePath(path);
  return normalized ? PathUtils.splitNormalizedPath(normalized) : [];
}

/** Fast read using pre-split segments; no segments reads the root itself. */
export function readBySegments(root: Record<string, unknown> | undefined, segments: readonly string[]): unknown {
  if (!root || segments.length === 0) return root;
  let current: unknown = root;
  for (const segment of segments) {
    if (current == null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Value at `path` under `root`; blank paths and missing roots read as `undefined`. */
export function readPath(root: Record<string, unknown> | undefined, path: string): unknown {
  return !root || !path ? undefined : readBySegments(root, segmentsOf(path));
}
