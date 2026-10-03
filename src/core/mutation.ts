import type { StoreData } from '../types/advanced-types';
import { PathUtils } from '../utils/path-utils';
import type { CreateStoreService } from './create-store.core';
import { FlatStoreMap } from '../utils/flat-store-map';
import { JsonDataCursor, createJsonPathPlan, getJsonBySegments, type JsonPathPlan } from '@adsq/jsnq/data-engine';
import type { StoreDevtools } from './store-devtools';
import { wakeOptions } from './wake/wake-types';

/**
 * The single write pipeline of a store: cursor write, optional key removal, wake, devtools,
 * deferred cleanup of derived state. `setValueFast` and `setValueObserve` differ only in `observe`.
 */
export class StoreMutator {
  /** Cached path plans and the cursor that applies them, created on the first write. */
  /**
   * Where the cursor currently points (mirrors the cursor's own bookkeeping): the parent segments
   * of the last write, or the path of the last prefetch, parsed only when an array reorders.
   */
  private cursorAt: readonly string[] | null = null;
  private cursorAtPath: string | null = null;
  private cursorState?: { plans: FlatStoreMap<JsonPathPlan>; cursor: JsonDataCursor };

  constructor(
    /** The store data, read live: the store may be reassigned. */
    private readonly getStore: () => StoreData,
    private readonly service: CreateStoreService,
    private readonly devtools: StoreDevtools
  ) {}

  private get cursors() {
    return (this.cursorState ??= { plans: new FlatStoreMap<JsonPathPlan>(), cursor: new JsonDataCursor() });
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
    this.cursors.plans.deleteByPrefix(normalized);
    this.cursors.cursor.invalidateForDeletion(normalized);
  }

  /**
   * Forget the cached write cursor when it sits inside an element of the array at `arrayPath` whose
   * index is `fromIndex` or later (that element moved or was removed). A cursor anywhere else is
   * still valid and is kept: the array object itself is unchanged.
   */
  resetCursor(arrayPath: string, fromIndex: number): void {
    const at = this.cursorAt ?? (this.cursorAtPath !== null ? createJsonPathPlan(this.cursorAtPath).segments : null);
    if (!at) return;
    const array = createJsonPathPlan(arrayPath).segments;
    if (at.length <= array.length) return;
    for (let i = 0; i < array.length; i++) if (at[i] !== array[i]) return;
    if (Number(at[array.length]) < fromIndex) return;
    this.cursors.cursor.clear();
    this.cursorAt = null;
    this.cursorAtPath = null;
  }

  prefetch(path: string, node: Record<string, unknown> | null): void {
    try {
      this.cursors.cursor.prefetch(path, node);
      this.cursorAt = null;
      this.cursorAtPath = path;
    } catch (e) {
      console.warn('CreateStore prefetchCursor error:', e);
    }
  }

  destroy(): void {
    this.cursorState?.plans.clear();
    this.cursorState?.cursor.clear();
    this.cursorAt = null;
    this.cursorAtPath = null;
  }

  /** Cursor write at a normalized path; returns the previous value. */
  put(normalized: string, value: unknown): unknown {
    const { plans, cursor } = this.cursors;
    const found = plans.getOrCreate(normalized, createJsonPathPlan);
    const plan = found.path === normalized ? found : createJsonPathPlan(normalized);
    const result = cursor.writeWithPlan(this.getStore() as Record<string, unknown>, plan, value);
    if (plan.key != null) {
      this.cursorAt = plan.parentSegments;
      this.cursorAtPath = null;
    }
    return result.previous;
  }

  /** Remove the key (or splice the index, for arrays) at `normalized`; a missing or primitive parent is a no-op. */
  private deleteAt(normalized: string): void {
    const segments = PathUtils.splitNormalizedPath(normalized);
    const last = segments[segments.length - 1];
    const store = this.getStore();
    const parent = segments.length > 1 ? getJsonBySegments(store, segments.slice(0, -1)) : store;
    if (parent == null || typeof parent !== 'object') return;
    if (!Array.isArray(parent)) {
      delete (parent as Record<string, unknown>)[last];
      return;
    }
    const index = Number(last);
    if (index >= 0 && index < parent.length) parent.splice(index, 1);
  }
}
