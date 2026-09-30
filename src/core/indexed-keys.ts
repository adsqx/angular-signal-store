/** True when some key under `normalized` continues with an integer segment >= `startIndex`. */
export function hasIndexedKeyFrom(keys: string[], normalized: string, startIndex: number): boolean {
  if (!normalized) return false;
  const prefix = `${normalized}.`;
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const dotIndex = key.indexOf('.', prefix.length);
    const segment = dotIndex === -1 ? key.slice(prefix.length) : key.slice(prefix.length, dotIndex);
    const index = Number(segment);
    if (Number.isInteger(index) && index >= startIndex) return true;
  }
  return false;
}
