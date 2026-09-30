import { PathValue, StoreData } from '../types/advanced-types';
import { StoreErrorFactory } from '../types/errors';
import { logger } from './logger';
import {
  enumerateAncestorPathsCore,
  hasForbiddenPathSegmentCore,
  isValidNormalizedPathCore,
  isValidPathCore,
  normalizePathCore,
  parentPathOfCore,
  resolveVersionPathCore,
  type ResolveVersionPathOptions,
} from './path-core';
import { GenerationalCache } from './generational-cache';
import { getJsonBySegments, writeJsonPathValue } from '@adsq/jsnq/core/data-engine';

export type { VersionDependencyMode } from './path-core';

/** Cached read plan for a raw path: its segments, or `false` when it must never be read. */
type ReadPlan = readonly string[] | false;

export class PathUtils {
  // Small generational caches to avoid repeated regex + split work in hot paths.
  private static readonly CACHE_MAX = 5000;
  // Only operations that measurably profit from caching are cached. Benchmarked on a
  // realistic 90% repeated / 10% new path mix (200k ops): splitting 30.0ms -> 23.8ms and
  // validation 56.6ms -> 29.0ms, while normalisation and version-path resolution were
  // *slower* cached than computed directly. See GenerationalCache for eviction strategy.
  private static readonly segmentsCache = new GenerationalCache<readonly string[]>(PathUtils.CACHE_MAX);
  private static readonly validCache = new GenerationalCache<boolean>(PathUtils.CACHE_MAX);
  private static readonly readPlanCache = new GenerationalCache<ReadPlan>(PathUtils.CACHE_MAX);

  /**
   * Type-safe path value getter; never throws, unsafe or blank paths read as `undefined`.
   */
  static getByPath<T extends StoreData, P extends string>(
    obj: T | null | undefined,
    path: P
  ): PathValue<T, P> | undefined {
    if (!obj || !path || typeof path !== 'string') return undefined;

    let plan = PathUtils.readPlanCache.get(path);
    if (plan === undefined) {
      // trim/normalize/split/forbidden-check run once per distinct path, on a miss only
      plan = path.trim().length === 0
        ? false
        : PathUtils.splitNormalizedPath(normalizePathCore(path));
      if (plan && hasForbiddenPathSegmentCore(plan)) plan = false;
      PathUtils.readPlanCache.set(path, plan);
    }
    if (plan === false) return undefined;

    try {
      return getJsonBySegments<PathValue<T, P>>(obj, plan);
    } catch (error) {
      // Don't throw for read operations, just return undefined
      logger.warn(`Failed to access path "${path}":`, error);
      return undefined;
    }
  }

  /**
   * Type-safe path value setter with validation and error handling
   */
  static setByPath<T extends StoreData>(obj: T, path: string, value: unknown): void {
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

  /**
   * Normalizes any path expression to dot notation (`users[0].name` -> `users.0.name`).
   */
  static normalizePath(path: string): string {
    if (!path || typeof path !== 'string') {
      throw StoreErrorFactory.pathValidation(path, 'Path must be a non-empty string');
    }
    return normalizePathCore(path);
  }

  /** Validates that a path string has correct format. */
  static isValidPath(path: string): boolean {
    if (!path || typeof path !== 'string') return false;
    const cached = PathUtils.validCache.get(path);
    if (cached !== undefined) return cached;
    // Blank and padded inputs fail the anchored path regex, so no trim() is needed.
    const valid = isValidPathCore(path);
    PathUtils.validCache.set(path, valid);
    return valid;
  }

  static isValidNormalizedPath(normalized: string): boolean {
    if (!normalized || typeof normalized !== 'string') return false;
    const cached = PathUtils.validCache.get(normalized);
    if (cached !== undefined) return cached;
    const valid = isValidNormalizedPathCore(normalized);
    PathUtils.validCache.set(normalized, valid);
    return valid;
  }

  static splitNormalizedPath(normalized: string): readonly string[] {
    if (!normalized) return [];
    const cached = PathUtils.segmentsCache.get(normalized);
    if (cached !== undefined) return cached;
    const segs = normalized.split('.');
    PathUtils.segmentsCache.set(normalized, segs);
    return segs;
  }

  /** Gets the parent path of a given path. */
  static getParentPath(path: string): string | null {
    // `isValidPath` already validated the normalized form, so no second validation here.
    return PathUtils.isValidPath(path) ? parentPathOfCore(normalizePathCore(path)) : null;
  }

  static getParentPathNormalized(normalized: string): string | null {
    return PathUtils.isValidNormalizedPath(normalized) ? parentPathOfCore(normalized) : null;
  }

  static resolveVersionPath(normalized: string, options: ResolveVersionPathOptions): string {
    return resolveVersionPathCore(normalized, options);
  }

  /**
   * Ancestor paths from the full path down to the top-level key.
   * Example: 'users[0].name' -> ['users.0.name','users.0','users']. The numeric parent is
   * always among them, so `includeNumericParent` is accepted for compatibility only.
   */
  static enumerateAncestors(path: string, _options: { includeNumericParent?: boolean } = {}): string[] {
    return enumerateAncestorPathsCore(path);
  }

  static isBranchValue(value: unknown): value is object {
    return value !== null && typeof value === 'object';
  }
}
