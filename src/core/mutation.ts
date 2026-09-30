import type { StoreData } from '../types/advanced-types';
import { PathUtils } from '../utils/path-utils';
import { getBySegmentsCore } from '../utils/path-core';
import type { CreateStoreService } from './create-store.core';
import { CursorManager } from './services/cursor.manager';
import type { StoreDevtools } from './store-devtools';
import { wakeOptions } from './wake/wake-types';

/**
 * The single write pipeline of a store: cursor write, optional key removal, wake, devtools,
 * deferred cleanup of derived state. `setValueFast` and `setValueObserve` differ only in `observe`.
 */
export class StoreMutator {
  private cursorRef?: CursorManager;

  constructor(
    /** The store data, read live: the store may be reassigned. */
    private readonly getStore: () => StoreData,
    private readonly service: CreateStoreService,
    private readonly devtools: StoreDevtools
  ) {}

  private get cursor(): CursorManager {
    return (this.cursorRef ??= new CursorManager());
  }

  /**
   * Write `value` at an already-normalized path and wake its consumers.
   * `observe`: create the path's BehaviorSubject, remove the key when `value` is undefined, and
   * report the behavior update to devtools.
   */
  write(normalized: string, value: unknown, observe: boolean): void {
    const { service, devtools } = this;
    const previous = this.put(normalized, value);
    const remove = observe && value === undefined;
    if (remove) this.deleteAt(normalized);

    const behaviorsOn = service.wakeUpMutationPathNormalized(
      normalized,
      value,
      wakeOptions(observe, PathUtils.isBranchValue(previous) || PathUtils.isBranchValue(value))
    );

    if (devtools.active) {
      devtools.setValueObserve(normalized, value, previous);
      if (observe && behaviorsOn && service.isBehaviorExists(normalized)) devtools.behavior(normalized, 'update');
    }
    if (remove) queueMicrotask(() => this.cleanupPath(normalized));
  }

  /** Drop everything derived from `normalized` (behaviors, computeds, versions, proxies, cursor plans). */
  cleanupPath(normalized: string): void {
    const service = this.service;
    service.cleanupBehaviorStore(normalized);
    service.cleanupComputedStore(normalized);
    service.cleanupVersionStore(normalized);
    service.clearProxyCacheForPath(normalized);
    this.cursor.invalidateCache(normalized);
    this.cursor.invalidateForDeletion(normalized);
  }

  prefetch(path: string, node: Record<string, unknown> | null): void {
    try {
      this.cursor.prefetch(path, node);
    } catch (e) {
      console.warn('CreateStore prefetchCursor error:', e);
    }
  }

  destroy(): void {
    this.cursorRef?.clearCaches();
  }

  /** Cursor write at a normalized path; returns the previous value. */
  put(normalized: string, value: unknown): unknown {
    const cursor = this.cursor;
    return cursor.mutateNode(this.getStore() as Record<string, unknown>, cursor.applyPathPlan(normalized), normalized, value);
  }

  /** Remove the key (or splice the index, for arrays) at `normalized`; a missing or primitive parent is a no-op. */
  private deleteAt(normalized: string): void {
    const segments = PathUtils.splitNormalizedPath(normalized);
    const last = segments[segments.length - 1];
    const store = this.getStore();
    const parent = segments.length > 1 ? getBySegmentsCore(store, segments.slice(0, -1)) : store;
    if (parent == null || typeof parent !== 'object') return;
    if (!Array.isArray(parent)) {
      delete (parent as Record<string, unknown>)[last];
      return;
    }
    const index = Number(last);
    if (index >= 0 && index < parent.length) parent.splice(index, 1);
  }
}
