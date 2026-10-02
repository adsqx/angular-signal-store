import { PathValue, StoreData } from '../types/advanced-types';
import { StoreErrorFactory } from '../types/errors';
import { logger } from './logger';
import {
  enumerateAncestorPathsCore,
  hasForbiddenPathSegmentCore,
  isValidPathCore,
  normalizePathCore,
} from './path-core';
import { getJsonBySegments, writeJsonPathValue } from '@adsq/jsnq/core/data-engine';

export type { VersionDependencyMode } from './path-core';

/**
 * Bounded string-keyed cache with generational eviction. Evicting the oldest entry with
 * `map.delete(map.keys().next().value)` measured 6.85 us per insert once full (a fresh iterator
 * over a tombstoned V8 hash map), ~10x slower than the uncached work. Two maps instead: lookups check
 * `current` then `previous` (promoting a hit), and on overflow `current` becomes `previous` and a
 * fresh map is allocated (O(1), 0.33 us per insert) while roughly one generation stays warm.
 * Values must never be `undefined`: it signals absence.
 */
class GenerationalCache<V> {
  private current = new Map<string, V>();
  private previous = new Map<string, V>();

  constructor(private readonly limit: number) {}

  get(key: string): V | undefined {
    const hit = this.current.get(key);
    if (hit !== undefined) return hit;
    const stale = this.previous.get(key);
    if (stale !== undefined) this.current.set(key, stale); // promote so the next generation keeps it
    return stale;
  }

  set(key: string, value: V): void {
    this.current.set(key, value);
    if (this.current.size > this.limit) {
      this.previous = this.current;
      this.current = new Map();
    }
  }
}

/** Cached read plan for a raw path: its segments, or `false` when it must never be read. */
type ReadPlan = readonly string[] | false;

const CACHE_MAX = 5000;
// Only operations that measurably profit from caching are cached (90% repeated / 10% new path mix,
// 200k ops: splitting 30.0 -> 23.8 ms, validation 56.6 -> 29.0 ms); normalisation and version-path
// resolution were slower cached than computed directly.
const segmentsCache = new GenerationalCache<readonly string[]>(CACHE_MAX);
const validCache = new GenerationalCache<boolean>(CACHE_MAX);
const readPlanCache = new GenerationalCache<ReadPlan>(CACHE_MAX);

export class PathUtils {
  /** Type-safe path value getter; never throws, unsafe or blank paths read as `undefined`. */
  static getByPath<T extends object, P extends string>(
    obj: T | null | undefined,
    path: P
  ): PathValue<T, P> | undefined {
    if (!obj || !path || typeof path !== 'string') return undefined;

    let plan = readPlanCache.get(path);
    if (plan === undefined) {
      // trim/normalize/split/forbidden-check run once per distinct path, on a miss only
      plan = path.trim().length === 0 ? false : PathUtils.splitNormalizedPath(normalizePathCore(path));
      if (plan && hasForbiddenPathSegmentCore(plan)) plan = false;
      readPlanCache.set(path, plan);
    }
    if (plan === false) return undefined;

    try {
      return getJsonBySegments<PathValue<T, P>>(obj, plan);
    } catch (error) {
      logger.warn(`Failed to access path "${path}":`, error);
      return undefined;
    }
  }

  /** Type-safe path value setter with validation and error handling. */
  static setByPath<T extends object>(obj: T, path: string, value: unknown): void {
    if (!obj || typeof obj !== 'object') {
      throw StoreErrorFactory.typeValidation(path, 'object', typeof obj);
    }
    if (!PathUtils.isValidPath(path)) {
      throw StoreErrorFactory.pathValidation(path, 'Invalid path format');
    }
    try {
      writeJsonPathValue(obj, normalizePathCore(path), value);
    } catch (error) {
      throw StoreErrorFactory.pathAccess(path, 'set', error as Error);
    }
  }

  /** Normalizes any path expression to dot notation (`users[0].name` -> `users.0.name`). */
  static normalizePath(path: string): string {
    if (!path || typeof path !== 'string') {
      throw StoreErrorFactory.pathValidation(path, 'Path must be a non-empty string');
    }
    return normalizePathCore(path);
  }

  /** Validates that a path string has correct format. */
  static isValidPath(path: string): boolean {
    if (!path || typeof path !== 'string') return false;
    const cached = validCache.get(path);
    if (cached !== undefined) return cached;
    const valid = isValidPathCore(path);
    validCache.set(path, valid);
    return valid;
  }

  static splitNormalizedPath(normalized: string): readonly string[] {
    if (!normalized) return [];
    const cached = segmentsCache.get(normalized);
    if (cached !== undefined) return cached;
    const segs = normalized.split('.');
    segmentsCache.set(normalized, segs);
    return segs;
  }

  /**
   * Ancestor paths from the full path down to the top-level key: 'users[0].name' ->
   * ['users.0.name','users.0','users']. The numeric parent is always among them.
   */
  static enumerateAncestors(path: string): string[] {
    return enumerateAncestorPathsCore(path);
  }

  static isBranchValue(value: unknown): value is object {
    return value !== null && typeof value === 'object';
  }
}

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
