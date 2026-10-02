import type { ArrayMutationMethod, SpliceOperation } from '../types/advanced-types';
import type { CreateStore } from '../core/create-store.class';

interface MutationEntry {
  apply(arrayRef: unknown[], payload: unknown): unknown;
  /** First index whose cached proxies go stale, or null when none do. */
  invalidateFrom(arrayRef: unknown[], payload: unknown): number | null;
}

const fromStart = (): number => 0;
const items = (payload: unknown) => payload as unknown[];
const fromEnd = (arr: unknown[]) => arr.length - 1;

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
  pop: { apply: (arr) => arr.pop(), invalidateFrom: fromEnd },
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
 * Applies array mutations to a store's data and keeps everything derived from it consistent: wakes
 * the array path, drops cached proxies past the first changed index, and cleans up the nodes of a
 * removed tail.
 */
export class ArrayMutationOrchestrator {
  constructor(private readonly store: CreateStore) {}

  /** Runs `method` on `arrayRef` and returns the native result. */
  mutate(arrayPath: string, arrayRef: unknown[], method: ArrayMutationMethod, payload: unknown): unknown {
    const entry = MUTATIONS[method];
    const oldLength = arrayRef.length;
    const invalidateFrom = oldLength ? entry.invalidateFrom(arrayRef, payload) : null;
    const result = entry.apply(arrayRef, payload);
    this.finalizeArrayChange(arrayPath, arrayRef, oldLength, arrayRef.length, invalidateFrom);
    return result;
  }

  updateItem(arrayPath: string, arrayRef: unknown[], index: number, newValue: unknown): void {
    if (index < 0 || index >= arrayRef.length) {
      throw new Error(`Index ${index} out of bounds for array at ${arrayPath}`);
    }
    arrayRef[index] = newValue;
    this.store.createServiceGetter.resetWriteCursor?.(arrayPath, index);
    this.store.wakeUpArrayMutation(`${arrayPath}.${index}`, newValue);
  }

  finalizeArrayChange(arrayPath: string, value: unknown, oldLength: number, newLength: number, invalidateFrom: number | null): void {
    const service = this.store.createServiceGetter;
    // The write cursor may sit inside an element that just moved or was removed.
    const movedFrom = invalidateFrom ?? (newLength < oldLength ? newLength : null);
    if (movedFrom !== null) service.resetWriteCursor?.(arrayPath, movedFrom);
    this.store.wakeUpArrayMutation(arrayPath, value, () => {
      if (invalidateFrom !== null && service.hasIndexedProxyCacheFrom(arrayPath, invalidateFrom)) {
        service.deleteIndexedProxyCacheRange(arrayPath, invalidateFrom, oldLength);
      }
      if (oldLength <= newLength) return;
      const clearProxies = service.hasIndexedProxyCacheFrom(arrayPath, newLength);
      const cleanupDerived = service.hasIndexedDerivedNodeFrom(arrayPath, newLength);
      if (clearProxies) service.deleteIndexedProxyCacheRange(arrayPath, newLength, oldLength);
      if (!cleanupDerived) return;
      // One microtask for the whole removed tail (per-index microtasks ran contiguously and in this order anyway).
      queueMicrotask(() => {
        for (let index = newLength; index < oldLength; index++) {
          const elementPath = `${arrayPath}.${index}`;
          service.cleanupBehaviorStore(elementPath);
          service.cleanupComputedStore(elementPath);
          service.cleanupVersionStore(elementPath);
        }
      });
    });
  }
}
