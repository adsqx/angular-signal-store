import { PathUtils } from '../../utils/path-utils';

interface AncestorEntry {
  /** Ancestors in `enumerateAncestors` order: the path itself first, then its parents. */
  selfFirst: string[];
  /** Same paths reversed; built on first use so the hot path never copies. */
  rootFirst?: string[];
}

const MAX_ENTRIES = 1000;

/**
 * Insertion-order FIFO cache of `PathUtils.enumerateAncestors`. The computation is pure (the numeric
 * parent is always one of the ancestors), so eviction only affects performance. Returned arrays are
 * shared: callers must not mutate them.
 */
export class AncestorCache {
  private readonly entries = new Map<string, AncestorEntry>();

  selfFirst(path: string): string[] {
    return this.entry(path).selfFirst;
  }

  rootFirst(path: string): string[] {
    const entry = this.entry(path);
    return (entry.rootFirst ??= [...entry.selfFirst].reverse());
  }

  clear(): void {
    this.entries.clear();
  }

  private entry(path: string): AncestorEntry {
    const cached = this.entries.get(path);
    if (cached) return cached;
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const entry: AncestorEntry = { selfFirst: PathUtils.enumerateAncestors(path) };
    this.entries.set(path, entry);
    return entry;
  }
}
