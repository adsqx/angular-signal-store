import type { ArrayMutationMethod, SpliceOperation } from '../../types/advanced-types';

/** Store/cache services an orchestrator needs; everything but the wake-up is optional. */
export interface ArrayMutationHost {
  wakeUpArrayMutation(path: string, value: unknown, afterVersion?: () => void): void;
  clearProxyCacheForPath?(path: string): void;
  cleanupBehaviorStore?(path: string): void;
  cleanupComputedStore?(path: string): void;
  cleanupVersionStore?(path: string): void;
  deleteIndexedProxyCacheRange?(arrayPath: string, startIndex: number, endIndex: number): void;
  hasIndexedProxyCacheFrom?(arrayPath: string, startIndex: number): boolean;
  hasIndexedDerivedNodeFrom?(arrayPath: string, startIndex: number): boolean;
}

interface MutationEntry {
  apply(arrayRef: unknown[], payload: unknown): unknown;
  /** First index whose cached proxies go stale, or null when none do. */
  invalidateFrom(arrayRef: unknown[], payload: unknown): number | null;
}

const fromStart = (): number => 0;
const items = (payload: unknown) => payload as unknown[];

function spliceInvalidationStart(arrayRef: unknown[], payload: unknown): number | null {
  const op = payload as SpliceOperation;
  const length = arrayRef.length;
  const start = op.start < 0 ? Math.max(length + op.start, 0) : Math.min(op.start, length);
  const deleteCount = op.deleteCount ?? Math.max(0, length - start);
  if (deleteCount <= 0 && op.items.length <= 0) return null;
  if (start >= length && deleteCount <= 0) return null;
  return start;
}

const MUTATIONS: Record<ArrayMutationMethod, MutationEntry> = {
  push: {
    apply: (arr, payload) => items(payload).length === 1 ? arr.push(items(payload)[0]) : arr.push(...items(payload)),
    invalidateFrom: () => null
  },
  unshift: {
    apply: (arr, payload) => items(payload).length === 1 ? arr.unshift(items(payload)[0]) : arr.unshift(...items(payload)),
    invalidateFrom: fromStart
  },
  pop: { apply: (arr) => arr.pop(), invalidateFrom: (arr) => arr.length - 1 },
  shift: { apply: (arr) => arr.shift(), invalidateFrom: fromStart },
  sort: { apply: (arr, payload) => arr.sort(payload as (a: unknown, b: unknown) => number), invalidateFrom: fromStart },
  reverse: { apply: (arr) => arr.reverse(), invalidateFrom: fromStart },
  splice: {
    apply: (arr, payload) => {
      const op = payload as SpliceOperation;
      return op.deleteCount === undefined ? arr.splice(op.start) : arr.splice(op.start, op.deleteCount, ...op.items);
    },
    invalidateFrom: spliceInvalidationStart
  }
};

/**
 * Single orchestrator for array mutations with automatic:
 * - proxy cache invalidation
 * - version bumping
 * - behavior update propagation
 * - removed tail cleanup
 *
 * TypedArrayOperations owns the actual mutation semantics and proxy array helpers
 * delegate into this path via storeInstance.setArrayMethod().
 */
export class ArrayMutationOrchestrator {
  constructor(private readonly host: ArrayMutationHost) {}

  mutate(
    arrayPath: string,
    arrayRef: unknown[],
    method: ArrayMutationMethod,
    payload: unknown
  ): { oldLength: number; newLength: number; proxyInvalidationStart: number | null; result: unknown } {
    const entry = MUTATIONS[method];
    const oldLength = arrayRef.length;
    const proxyInvalidationStart = oldLength ? entry.invalidateFrom(arrayRef, payload) : null;
    const result = entry.apply(arrayRef, payload);
    const newLength = arrayRef.length;

    this.finalizeArrayChange(arrayPath, arrayRef, oldLength, newLength, proxyInvalidationStart);

    return { oldLength, newLength, proxyInvalidationStart, result };
  }

  updateItem(arrayPath: string, arrayRef: unknown[], index: number, newValue: unknown): void {
    if (index < 0 || index >= arrayRef.length) {
      throw new Error(`Index ${index} out of bounds for array at ${arrayPath}`);
    }
    arrayRef[index] = newValue;
    this.host.wakeUpArrayMutation(`${arrayPath}.${index}`, newValue);
  }

  finalizeArrayChange(
    arrayPath: string,
    value: unknown,
    oldLength: number,
    newLength: number,
    proxyInvalidationStart: number | null
  ): void {
    this.host.wakeUpArrayMutation(arrayPath, value, () => {
      if (proxyInvalidationStart !== null && this.hasProxyCacheFrom(arrayPath, proxyInvalidationStart)) {
        this.invalidateProxyRange(arrayPath, proxyInvalidationStart, oldLength);
      }
      this.cleanupRemovedTailIndices(arrayPath, oldLength, newLength);
    });
  }

  invalidateProxyRange(arrayPath: string, startIndex: number, oldLength: number): void {
    if (startIndex < 0 || startIndex >= oldLength) return;
    const { host } = this;
    if (host.deleteIndexedProxyCacheRange) {
      host.deleteIndexedProxyCacheRange(arrayPath, startIndex, oldLength);
      return;
    }
    for (let i = startIndex; i < oldLength; i++) {
      host.clearProxyCacheForPath?.(`${arrayPath}.${i}`);
    }
  }

  cleanupRemovedTailIndices(arrayPath: string, oldLength: number, newLength: number): void {
    if (oldLength <= newLength) return;
    const clearProxies = this.hasProxyCacheFrom(arrayPath, newLength);
    const cleanupDerived = this.host.hasIndexedDerivedNodeFrom?.(arrayPath, newLength) ?? true;
    if (clearProxies) this.invalidateProxyRange(arrayPath, newLength, oldLength);
    if (!cleanupDerived) return;
    // One microtask for the whole removed tail. The per-index microtasks used to be queued
    // back to back, so they already ran contiguously and in this same order.
    const host = this.host;
    queueMicrotask(() => {
      for (let index = newLength; index < oldLength; index++) {
        const elementPath = `${arrayPath}.${index}`;
        host.cleanupBehaviorStore?.(elementPath);
        host.cleanupComputedStore?.(elementPath);
        host.cleanupVersionStore?.(elementPath);
      }
    });
  }

  private hasProxyCacheFrom(arrayPath: string, startIndex: number): boolean {
    return this.host.hasIndexedProxyCacheFrom?.(arrayPath, startIndex) ?? true;
  }
}
