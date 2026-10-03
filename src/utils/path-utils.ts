import { PathValue } from '../types/advanced-types';
import { StoreErrorFactory } from '../types/errors';
import { logger } from './logger';
import {
  dotPathAncestors, getJsonBySegments, isValidDotPath, normalizeDotPath, splitDotPath, writeJsonPathValue,
} from '@adsq/jsnq/data-engine';

/** Path dependency granularity: the path itself, or its container. */
export type VersionDependencyMode = 'exact' | 'container';

/** The store's path syntax, parsing and caches are jsnq's dot paths, shared with the Solid store. */
export class PathUtils {
  /** Type-safe path value getter; never throws, unsafe or blank paths read as `undefined`. */
  static getByPath<T extends object, P extends string>(
    obj: T | null | undefined,
    path: P
  ): PathValue<T, P> | undefined {
    if (!obj || !path || typeof path !== 'string' || path.trim().length === 0) return undefined;
    // getJsonBySegments reads forbidden segments as undefined.
    const segments = splitDotPath(normalizeDotPath(path));
    try {
      return getJsonBySegments<PathValue<T, P>>(obj, segments);
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
      writeJsonPathValue(obj, normalizeDotPath(path), value);
    } catch (error) {
      throw StoreErrorFactory.pathAccess(path, 'set', error as Error);
    }
  }

  /** Normalizes any path expression to dot notation (`users[0].name` -> `users.0.name`). */
  static normalizePath(path: string): string {
    if (!path || typeof path !== 'string') {
      throw StoreErrorFactory.pathValidation(path, 'Path must be a non-empty string');
    }
    return normalizeDotPath(path);
  }

  /** Validates that a path string has correct format. */
  static isValidPath(path: string): boolean {
    return isValidDotPath(path);
  }

  static splitNormalizedPath(normalized: string): readonly string[] {
    return splitDotPath(normalized);
  }

  /**
   * Ancestor paths from the full path down to the top-level key: 'users[0].name' ->
   * ['users.0.name','users.0','users']. The numeric parent is always among them.
   */
  static enumerateAncestors(path: string): string[] {
    return dotPathAncestors(path);
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
  return getJsonBySegments(root, segments);
}

/** Value at `path` under `root`; blank paths and missing roots read as `undefined`. */
export function readPath(root: Record<string, unknown> | undefined, path: string): unknown {
  return !root || !path ? undefined : readBySegments(root, segmentsOf(path));
}
