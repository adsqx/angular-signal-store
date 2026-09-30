// Shared helpers to build stable cache keys and hashed segments for array queries

// Function.toString() re-slices the source on every call; stable callbacks hit this cache.
const fnKeys = new WeakMap<object, string>();

export function serializeForKey(v: unknown): string {
  if (typeof v === 'function') {
    let key = fnKeys.get(v);
    if (key === undefined) fnKeys.set(v, (key = v.toString()));
    return key;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0; // Convert to 32bit
  }
  return Math.abs(hash).toString(36);
}

export function buildMethodHashSegment(method: string, predicate: unknown, args: unknown[]): string {
  const keySeed = serializeForKey(predicate) + (args.length ? serializeForKey(args) : '');
  return `${method}_${hashString(keySeed)}`;
}

export function buildArrayQueryCacheKey(path: string, method: string, predicate: unknown, args: unknown[]): string {
  // Stable, human-readable key for per-proxy cache
  const safe = serializeForKey(predicate);
  const rest = args.length ? serializeForKey(args) : '';
  return `${path}|${method}|${safe}|${rest}`;
}
