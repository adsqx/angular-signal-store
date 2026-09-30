import { PathUtils } from './path-utils';

/**
 * String-keyed map that normalizes every path (bracket notation to dot notation) on access.
 * `PathUtils.normalizePath` is a single `indexOf` for already-normalized paths, so no
 * normalization cache is kept. Prefix operations scan linearly, which is enough for store sizes.
 */
export class FlatStoreMap<T> {
  private readonly map = new Map<string, T>();

  /** Number of stored entries (O(1)). */
  get size(): number {
    return this.map.size;
  }

  get(path: string): T | undefined {
    return this.map.get(PathUtils.normalizePath(path));
  }

  set(path: string, value: T): void {
    this.map.set(PathUtils.normalizePath(path), value);
  }

  has(path: string): boolean {
    return this.map.has(PathUtils.normalizePath(path));
  }

  delete(path: string): boolean {
    return this.map.delete(PathUtils.normalizePath(path));
  }

  /** Deletes `prefix` and everything below it; `onDelete` errors are logged, not thrown. */
  deleteByPrefix(prefix: string, onDelete?: (key: string, value: T) => void): number {
    const keys = this.keysUnder(prefix);
    for (const key of keys) {
      if (onDelete) {
        try {
          onDelete(key, this.map.get(key) as T);
        } catch (e) {
          console.warn('FlatStoreMap onDelete error:', e);
        }
      }
      this.map.delete(key);
    }
    return keys.length;
  }

  /** Keys equal to `prefix` or nested below it. */
  getByPrefix(prefix: string): string[] {
    return this.keysUnder(prefix);
  }

  keys(): string[] {
    return Array.from(this.map.keys());
  }

  toObject(): Record<string, T> {
    return Object.fromEntries(this.map);
  }

  clear(): void {
    this.map.clear();
  }

  /** Iterates over a snapshot, so callbacks may mutate the map. */
  forEach(callback: (value: T, key: string) => void): void {
    for (const [key, value] of Array.from(this.map)) callback(value, key);
  }

  getOrCreate(path: string, factory: (normalizedPath: string) => T): T {
    const normalized = PathUtils.normalizePath(path);
    let value = this.map.get(normalized);
    if (value === undefined) {
      value = factory(normalized);
      this.map.set(normalized, value);
    }
    return value;
  }

  addIfMissing(path: string, factory: (normalizedPath: string) => T | undefined): void {
    const normalized = PathUtils.normalizePath(path);
    if (this.map.has(normalized)) return;
    const value = factory(normalized);
    if (value !== undefined) this.map.set(normalized, value);
  }

  /** Kept only for `CursorManager.getCacheStats`; nothing is cached any more. */
  getCacheStats(): { size: number } {
    return { size: this.map.size };
  }

  private keysUnder(prefix: string): string[] {
    const normalized = PathUtils.normalizePath(prefix);
    const nested = normalized + '.';
    const result: string[] = [];
    for (const key of this.map.keys()) {
      if (key === normalized || key.startsWith(nested)) result.push(key);
    }
    return result;
  }
}
