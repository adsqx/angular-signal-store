export type PathSegments = readonly string[];
export type VersionDependencyMode = 'exact' | 'container';

export interface SplitPathOptions {
  normalize?: boolean;
  filterEmpty?: boolean;
}

export interface PathMutationOptions {
  createArrays?: boolean;
  guardForbidden?: boolean;
}

export interface ResolveVersionPathOptions {
  dependencyMode: VersionDependencyMode;
  bumpNumericParent: boolean;
}

const BRACKET_SEGMENT_RE = /\[(.*?)\]/g;
const NORMALIZED_PATH_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z0-9_$]+)*$/;
const NUMERIC_SEGMENT_RE = /^\d+$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function isTraversable(value: unknown): value is Record<string, unknown> {
  return value != null && (typeof value === 'object' || typeof value === 'function');
}

export function normalizePathCore(path: string): string {
  if (!path) return '';
  return path.indexOf('[') === -1 ? path : path.replace(BRACKET_SEGMENT_RE, '.$1');
}

export function splitPathCore(path: string, options: SplitPathOptions = {}): string[] {
  if (!path) return [];
  const normalized = options.normalize === false ? path : normalizePathCore(path);
  const parts = normalized ? normalized.split('.') : [];
  return options.filterEmpty ? parts.filter(Boolean) : parts;
}

function isNumericSegmentCore(segment: string | undefined | null): boolean {
  return !!segment && NUMERIC_SEGMENT_RE.test(segment);
}

export function hasForbiddenPathSegmentCore(segments: PathSegments): boolean {
  for (let i = 0; i < segments.length; i++) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segments[i]!)) return true;
  }
  return false;
}

export function isValidNormalizedPathCore(normalized: string): boolean {
  return typeof normalized === 'string' &&
    normalized.length > 0 &&
    NORMALIZED_PATH_RE.test(normalized) &&
    !hasForbiddenPathSegmentCore(normalized.split('.'));
}

/** Whitespace-only and padded inputs fail the anchored regex, so no trim is needed. */
export function isValidPathCore(path: string): boolean {
  return typeof path === 'string' && isValidNormalizedPathCore(normalizePathCore(path));
}

export function getBySegmentsCore<T = unknown>(
  obj: unknown,
  segments: PathSegments,
  options: { guardForbidden?: boolean } = {}
): T | undefined {
  if (options.guardForbidden && hasForbiddenPathSegmentCore(segments)) return undefined;
  let current: unknown = obj;
  for (const segment of segments) {
    if (current == null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current as T | undefined;
}

export function getByPathCore<T = unknown>(
  obj: unknown,
  path: string,
  options: { rootReturnsObject?: boolean; guardForbidden?: boolean; filterEmpty?: boolean } = {}
): T | undefined {
  if (!obj) return undefined;
  if (!path) return options.rootReturnsObject ? (obj as T) : undefined;
  return getBySegmentsCore<T>(
    obj,
    splitPathCore(path, { filterEmpty: options.filterEmpty }),
    { guardForbidden: options.guardForbidden }
  );
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

/** Parent of an already validated normalized path (no re-validation); null for a root key. */
export function parentPathOfCore(normalized: string): string | null {
  const index = normalized.lastIndexOf('.');
  return index === -1 ? null : normalized.slice(0, index);
}

/** Shared prologue: normalize `path` and return it only when it is a valid normalized path. */
function validNormalizedOrNull(path: string): string | null {
  if (!path || typeof path !== 'string') return null;
  const normalized = normalizePathCore(path);
  return isValidNormalizedPathCore(normalized) ? normalized : null;
}

export function nearestNumericContainerPathCore(path: string): string | null {
  const normalized = validNormalizedOrNull(path);
  if (normalized === null) return null;
  const parts = normalized.split('.');
  const index = parts.findIndex(isNumericSegmentCore);
  return index > 0 ? parts.slice(0, index).join('.') : null;
}

export function resolveVersionPathCore(normalized: string, options: ResolveVersionPathOptions): string {
  const parent = options.dependencyMode === 'container' && isValidNormalizedPathCore(normalized)
    ? parentPathOfCore(normalized)
    : null;
  const base = parent ?? normalized;
  return options.bumpNumericParent ? nearestNumericContainerPathCore(base) ?? base : base;
}

/** Ancestors from the full path down to the top-level key: `a.0.b` -> `a.0.b`, `a.0`, `a`. */
export function enumerateAncestorPathsCore(path: string): string[] {
  const normalized = validNormalizedOrNull(path);
  if (normalized === null) return [];
  const out: string[] = [];
  for (let end = normalized.length; end > 0; end = normalized.lastIndexOf('.', end - 1)) {
    out.push(normalized.slice(0, end));
  }
  return out;
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
