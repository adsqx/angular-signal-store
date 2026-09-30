/** True when `key` is `prefix` (already ending in '.') plus an integer index segment in [startIndex, endIndex). */
export function isIndexedChild(key: string, prefix: string, startIndex: number, endIndex = Infinity): boolean {
  if (!key.startsWith(prefix)) return false;
  const dot = key.indexOf('.', prefix.length);
  const segment = dot === -1 ? key.slice(prefix.length) : key.slice(prefix.length, dot);
  const index = Number(segment);
  return !!segment && Number.isInteger(index) && index >= startIndex && index < endIndex;
}

/** True when some key under `normalized` continues with an integer segment >= `startIndex`. */
export function hasIndexedKeyFrom(keys: string[], normalized: string, startIndex: number): boolean {
  if (!normalized) return false;
  const prefix = `${normalized}.`;
  for (const key of keys) if (isIndexedChild(key, prefix, startIndex)) return true;
  return false;
}
