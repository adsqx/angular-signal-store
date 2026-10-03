import { getJsonBySegments } from '@adsq/jsnq/core/data-engine';

export type PathSegments = readonly string[];
export type VersionDependencyMode = 'exact' | 'container';

export interface ResolveVersionPathOptions {
  dependencyMode: VersionDependencyMode;
  bumpNumericParent: boolean;
}

const BRACKET_SEGMENT_RE = /\[(.*?)\]/g;
const NORMALIZED_PATH_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z0-9_$]+)*$/;
const NUMERIC_SEGMENT_RE = /^\d+$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export function normalizePathCore(path: string): string {
  if (!path) return '';
  return path.indexOf('[') === -1 ? path : path.replace(BRACKET_SEGMENT_RE, '.$1');
}

export function isNumericSegmentCore(segment: string | undefined | null): boolean {
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

/** Segment read delegated to jsnq: same walk, and forbidden segments read as `undefined`. */
export function getBySegmentsCore<T = unknown>(obj: unknown, segments: PathSegments): T | undefined {
  return getJsonBySegments<T>(obj, segments);
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
