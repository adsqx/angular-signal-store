type Keep = (key: string) => boolean;

/**
 * Insertion-ordered set of path keys with lazy deletion: `delete` only drops the live token,
 * stale ring entries are skipped and compacted once the ring gets sparse.
 */
export class PathRingOrder {
  private entries: { key: string; token: number }[] = [];
  private head = 0;
  private nextToken = 0;
  private liveTokens: Record<string, number> = Object.create(null);
  private liveCount = 0;

  add(key: string): void {
    if (this.liveTokens[key] === undefined) this.liveCount++;
    const token = ++this.nextToken;
    this.liveTokens[key] = token;
    this.entries.push({ key, token });
    this.compactIfSparse();
  }

  deleteByPrefix(prefix: string): void {
    const pref = prefix ? `${prefix}.` : '';
    this.deleteWhere((key) => key === prefix || (!!pref && key.startsWith(pref)));
  }

  deleteWhere(predicate: Keep): void {
    for (const key of Object.keys(this.liveTokens)) if (predicate(key)) this.delete(key);
    this.compactIfSparse();
  }

  /** Evicts oldest-first until at most `maxSize` keys are live; keys failing `keep` are dropped without `onEvict`. */
  evictOver(maxSize: number, onEvict: (key: string) => void, keep?: Keep): void {
    while (this.liveCount > maxSize) {
      const oldest = this.shiftOldest(keep);
      if (!oldest) break;
      onEvict(oldest);
    }
    this.compactIfSparse();
  }

  keys(keep?: Keep): string[] {
    this.compact(keep);
    return this.entries.map((e) => e.key); // compaction left only live entries
  }

  some(predicate: Keep): boolean {
    for (let i = this.head; i < this.entries.length; i++) {
      const entry = this.entries[i];
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

  private isLive(entry: { key: string; token: number }): boolean {
    return this.liveTokens[entry.key] === entry.token;
  }

  private delete(key: string): void {
    if (this.liveTokens[key] === undefined) return;
    delete this.liveTokens[key];
    this.liveCount--;
  }

  private shiftOldest(keep?: Keep): string | undefined {
    while (this.head < this.entries.length) {
      const entry = this.entries[this.head++];
      if (!this.isLive(entry)) continue;
      this.delete(entry.key);
      if (!keep || keep(entry.key)) return entry.key;
    }
    return undefined;
  }

  private compact(keep?: Keep): void {
    const next: typeof this.entries = [];
    for (let i = this.head; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (!this.isLive(entry)) continue;
      if (keep && !keep(entry.key)) this.delete(entry.key);
      else next.push(entry);
    }
    this.entries = next;
    this.head = 0;
  }

  private compactIfSparse(): void {
    if (this.head < 256 && this.entries.length <= Math.max(512, this.liveCount * 4)) return;
    this.compact();
  }
}
