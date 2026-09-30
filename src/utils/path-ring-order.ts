type CacheOrderEntry = { key: string; token: number };
export type CacheOrderPredicate = (key: string) => boolean;

/**
 * Insertion-ordered set of path keys with lazy deletion: `delete` only drops the live token,
 * stale ring entries are skipped and compacted once the ring gets sparse.
 */
export class PathRingOrder {
  private entries: CacheOrderEntry[] = [];
  private head = 0;
  private nextToken = 0;
  private liveTokens: Record<string, number> = Object.create(null);
  private liveCount = 0;

  add(key: string): void {
    if (this.liveTokens[key] === undefined) {
      this.liveCount++;
    }
    const token = ++this.nextToken;
    this.liveTokens[key] = token;
    this.entries.push({ key, token });
    this.compactIfSparse();
  }

  delete(key: string): void {
    if (this.liveTokens[key] === undefined) return;
    delete this.liveTokens[key];
    this.liveCount--;
  }

  deleteByPrefix(prefix: string): void {
    const pref = prefix ? `${prefix}.` : '';
    this.deleteWhere((key) => key === prefix || (!!pref && key.startsWith(pref)));
  }

  deleteWhere(predicate: CacheOrderPredicate): void {
    for (const key of Object.keys(this.liveTokens)) {
      if (predicate(key)) this.delete(key);
    }
    this.compactIfSparse();
  }

  evictOver(maxSize: number, onEvict: (key: string) => void, keep?: CacheOrderPredicate): void {
    while (this.liveCount > maxSize) {
      const oldest = this.shiftOldest(keep);
      if (!oldest) break;
      onEvict(oldest);
    }
    this.compactIfSparse();
  }

  keys(keep?: CacheOrderPredicate): string[] {
    this.compact(keep);
    const keys: string[] = [];
    for (let index = this.head; index < this.entries.length; index++) {
      const entry = this.entries[index];
      if (this.liveTokens[entry.key] === entry.token) keys.push(entry.key);
    }
    return keys;
  }

  some(predicate: CacheOrderPredicate): boolean {
    for (let index = this.head; index < this.entries.length; index++) {
      const entry = this.entries[index];
      if (this.liveTokens[entry.key] === entry.token && predicate(entry.key)) return true;
    }
    return false;
  }

  clear(): void {
    this.entries = [];
    this.head = 0;
    this.liveTokens = Object.create(null);
    this.liveCount = 0;
  }

  private shiftOldest(keep?: CacheOrderPredicate): string | undefined {
    while (this.head < this.entries.length) {
      const entry = this.entries[this.head++];
      if (this.liveTokens[entry.key] !== entry.token) continue;
      this.delete(entry.key);
      if (!keep || keep(entry.key)) return entry.key;
    }
    return undefined;
  }

  private compact(keep?: CacheOrderPredicate): void {
    const next: CacheOrderEntry[] = [];
    for (let index = this.head; index < this.entries.length; index++) {
      const entry = this.entries[index];
      if (this.liveTokens[entry.key] !== entry.token) continue;
      if (keep && !keep(entry.key)) {
        this.delete(entry.key);
        continue;
      }
      next.push(entry);
    }
    this.entries = next;
    this.head = 0;
  }

  private compactIfSparse(): void {
    if (this.head < 256 && this.entries.length <= Math.max(512, this.liveCount * 4)) return;
    this.compact();
  }
}
