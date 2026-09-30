/**
 * Reference implementations of path helpers the library itself no longer calls (it delegates to the
 * jsnq data engine). Kept only so `path-core-jsnq-parity.test.ts` can keep probing them against the engine.
 */
import { getBySegmentsCore, hasForbiddenPathSegmentCore, isNumericSegmentCore, normalizePathCore, type PathSegments } from '../src/utils/path-core';

export interface SplitPathOptions {
  normalize?: boolean;
  filterEmpty?: boolean;
}

export interface PathMutationOptions {
  createArrays?: boolean;
  guardForbidden?: boolean;
}

function isTraversable(value: unknown): value is Record<string, unknown> {
  return value != null && (typeof value === 'object' || typeof value === 'function');
}

export function splitPathCore(path: string, options: SplitPathOptions = {}): string[] {
  if (!path) return [];
  const normalized = options.normalize === false ? path : normalizePathCore(path);
  const parts = normalized ? normalized.split('.') : [];
  return options.filterEmpty ? parts.filter(Boolean) : parts;
}

export function getByPathCore<T = unknown>(
  obj: unknown,
  path: string,
  options: { rootReturnsObject?: boolean; guardForbidden?: boolean; filterEmpty?: boolean } = {}
): T | undefined {
  if (!obj) return undefined;
  if (!path) return options.rootReturnsObject ? (obj as T) : undefined;
  const segments = splitPathCore(path, { filterEmpty: options.filterEmpty });
  return options.guardForbidden && hasForbiddenPathSegmentCore(segments) ? undefined : getBySegmentsCore<T>(obj, segments);
}

export function setByPathCore(
  obj: unknown,
  path: string,
  value: unknown,
  options: PathMutationOptions = {}
): void {
  const segments = splitPathCore(path, { filterEmpty: true });
  if (segments.length === 0) return;
  if (options.guardForbidden !== false && hasForbiddenPathSegmentCore(segments)) {
    throw new Error(`Unsafe path segment in '${path}'`);
  }

  let current = obj as Record<string, unknown>;
  const lastIndex = segments.length - 1;
  for (let i = 0; i < lastIndex; i++) {
    const segment = segments[i]!;
    const nextSegment = segments[i + 1];
    const shouldCreateArray = options.createArrays !== false && isNumericSegmentCore(nextSegment);
    const currentValue = current[segment];

    if (!isTraversable(currentValue)) {
      current[segment] = shouldCreateArray ? [] : {};
    } else if (shouldCreateArray && !Array.isArray(currentValue)) {
      current[segment] = [];
    }

    current = current[segment] as Record<string, unknown>;
  }

  const last = segments[lastIndex]!;
  if (Array.isArray(current) && isNumericSegmentCore(last)) {
    current[Number(last)] = value;
  } else {
    current[last] = value;
  }
}

export function pathExistsCore(obj: unknown, path: string, options: { guardForbidden?: boolean } = {}): boolean {
  if (!obj || typeof obj !== 'object' || !path) return false;
  const segments = splitPathCore(path);
  if (options.guardForbidden !== false && hasForbiddenPathSegmentCore(segments)) return false;

  let current: unknown = obj;
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') return false;
    if (Array.isArray(current) && isNumericSegmentCore(segment)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return false;
      current = current[index];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

export function resolveParentAndKeyCore(obj: unknown, path: string): { parent: unknown; key: string | null; segments: string[] } {
  const segments = splitPathCore(path, { filterEmpty: true });
  if (segments.length === 0) return { parent: obj, key: null, segments };
  const key = segments[segments.length - 1]!;
  let parent: unknown = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    if (!isTraversable(parent)) return { parent: undefined, key, segments };
    parent = (parent as Record<string, unknown>)[segments[i]!];
  }
  return { parent, key, segments };
}

export function getParentSegmentsCore(segments: PathSegments): PathSegments {
  return !segments || segments.length <= 1 ? [] : segments.slice(0, -1);
}

export function cloneJsonCore<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
}
