import { computed, type Signal, type WritableSignal } from '@angular/core';
import type { CreateStoreService } from '../create-store.core';
import { FlatStoreMap } from '../../utils/flat-store-map';
import type { ManagerCtx } from './manager-ctx';
import { PathUtils } from '../../utils/path-utils';
import { buildMethodHashSegment } from '../../utils/array-query-key.utils';
import { executeArrayQuery } from '../../utils/array-query-executor';
import type {
  StoreData,
  ValidPath,
  ArrayQueryMethod,
  ArrayElement,
  PredicateFn,
  MapFn,
  ReduceFn,
  PathValue
} from '../../types/advanced-types';

export type ArrayQueryResult<E, M extends ArrayQueryMethod | 'length'> =
  M extends 'find' ? E | undefined :
  M extends 'findIndex' | 'indexOf' ? number :
  M extends 'filter' | 'map' ? E[] :
  M extends 'some' | 'every' | 'includes' ? boolean :
  M extends 'reduce' ? unknown :
  M extends 'length' ? number :
  unknown;

export type ArrayQueryPredicate<E, M extends ArrayQueryMethod | 'length'> =
  M extends 'find' | 'findIndex' | 'filter' | 'some' | 'every' ? PredicateFn<E> :
  M extends 'map' ? MapFn<E, unknown> :
  M extends 'reduce' ? ReduceFn<E, unknown> :
  M extends 'includes' | 'indexOf' ? E :
  undefined;

/**
 * Manages computed signals graph for a single store instance.
 */
export class ComputedService<TStore extends StoreData = StoreData> {
  private readonly computedStore = new FlatStoreMap<Signal<unknown>>();

  constructor(
    private readonly core: CreateStoreService<TStore>,
    private readonly ctx: ManagerCtx
  ) {}

  // --- public API used by core ---
  get<T>(path: ValidPath<TStore> & string): Signal<T> | undefined {
    const existing = this.computedStore.get(path);
    if (existing) return existing as Signal<T>;
    this.add(path);
    return this.computedStore.get(path) as Signal<T> | undefined;
  }

  add(path: ValidPath<TStore> & string): void {
    const normalizedPath = PathUtils.normalizePath(path);
    if (this.ctx.read(normalizedPath) === undefined) return;
    if (this.computedStore.has(normalizedPath)) return;

    const s = this.versionedComputed(normalizedPath, (value) =>
      this.core.getCloneComputedOutputs() ? cloneShallow(value) : value
    );
    this.core.setSignalInProxyCache(normalizedPath, s);
    this.computedStore.set(normalizedPath, s);
  }

  /**
   * `computed` over the value at `normalizedPath`, invalidated by that path's version signal.
   * The resolved version signal is cached so steady-state re-evaluation skips the lookup.
   */
  private versionedComputed<R>(normalizedPath: string, project: (value: unknown) => R): Signal<R> {
    const pathSegments = this.core.getPathSegments(normalizedPath);
    let cachedVersionPath: string | undefined;
    let versionRef: WritableSignal<number> | undefined;
    return computed(() => {
      const versionPath = this.core.resolveVersionPathNormalized(normalizedPath);
      if (!versionRef || cachedVersionPath !== versionPath) {
        versionRef = this.core.getVersion(versionPath);
        cachedVersionPath = versionPath;
      }
      versionRef();
      return project(this.ctx.reader.readBySegments(this.ctx.root, pathSegments));
    });
  }

  remove(path: string): void {
    this.computedStore.deleteByPrefix(path);
  }

  cleanup(pathPrefix?: string): void {
    if (!pathPrefix) {
      this.computedStore.clear();
    } else {
      this.computedStore.deleteByPrefix(pathPrefix);
    }
  }

  isExists(path: string): boolean {
    return this.computedStore.has(path);
  }

  keys(): string[] {
    return this.computedStore.keys();
  }

  store(): Record<string, Signal<unknown>> {
    return this.computedStore.toObject();
  }

  // Array query computed
  createArrayQueryComputed<
    P extends ValidPath<TStore> & string,
    M extends ArrayQueryMethod | 'length',
    A = PathValue<TStore, P>,
    E = ArrayElement<A>,
    R = ArrayQueryResult<E, M>
  >(
    path: P,
    method: M,
    predicate: ArrayQueryPredicate<E, M>,
    ...args: unknown[]
  ): Signal<R> | undefined {
    const normalizedPath = PathUtils.normalizePath(path);
    if (this.ctx.read(normalizedPath) === undefined) return undefined;

    const keySegment = buildMethodHashSegment(method, predicate, args);
    const fullPath = [...this.core.getPathSegments(normalizedPath), '$arrayQuery', keySegment].join('.');

    const existing = this.computedStore.get(fullPath);
    if (existing) return existing as Signal<R>;

    const s = this.versionedComputed(normalizedPath, (arrayRef): R | undefined => {
      if (!Array.isArray(arrayRef)) return undefined;
      try {
        return executeArrayQuery(arrayRef as E[], method, predicate, args, { cloneFoundObject: true }) as R;
      } catch {
        return undefined;
      }
    });
    this.core.setSignalInProxyCache(fullPath, s);
    this.computedStore.set(fullPath, s);

    this.emitUpdate('add', fullPath);

    return s as Signal<R>;
  }

  registerPipelineComputed(path: string, signalRef: Signal<unknown>): void {
    if (!signalRef) return;
    const normalizedPath = PathUtils.normalizePath(path);
    const existed = this.computedStore.has(normalizedPath);
    this.computedStore.set(normalizedPath, signalRef);
    this.core.setSignalInProxyCache(normalizedPath, signalRef);

    this.emitUpdate(existed ? 'update' : 'add', normalizedPath);
  }

  private emitUpdate(action: 'add' | 'update', path: string): void {
    if (!this.ctx.devActive) return;
    this.ctx.emit({
      type: 'COMPUTED_STORE_UPDATE',
      payload: { storeName: this.ctx.storeName, action, path, keys: this.keys() }
    });
  }
}

function cloneShallow(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  return Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) };
}
