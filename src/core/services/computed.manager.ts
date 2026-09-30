import { computed, type Signal, type WritableSignal } from '@angular/core';
import type { CreateStoreService } from '../create-store.core';
import { FlatStoreMap } from '../../utils/flat-store-map';
import type { ManagerCtx } from './manager-ctx';
import { PathUtils } from '../../utils/path-utils';
import { readBySegments, segmentsOf } from '../../utils/abstracts/path-reader';
import { buildMethodHashSegment } from '../../utils/array-query-key.utils';
import { executeArrayQuery, type ArrayQueryMethodWithLength } from '../../utils/array-query-executor';
import type { StoreData } from '../../types/advanced-types';

const cloneShallow = (value: unknown): unknown =>
  !value || typeof value !== 'object' ? value : Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) };

/** Manages the computed signals of a single store instance. */
export class ComputedService<TStore extends StoreData = StoreData> {
  private readonly nodes = new FlatStoreMap<Signal<unknown>>();

  constructor(
    private readonly core: CreateStoreService<TStore>,
    private readonly ctx: ManagerCtx
  ) {}

  /** The computed signal of `path`, created on first use (none while the path holds `undefined`). */
  get(path: string): Signal<unknown> | undefined {
    const existing = this.nodes.get(path);
    if (existing) return existing;
    this.add(path);
    return this.nodes.get(path);
  }

  add(path: string): void {
    const normalized = PathUtils.normalizePath(path);
    if (this.ctx.read(normalized) === undefined || this.nodes.has(normalized)) return;
    this.register(normalized, this.versionedComputed(normalized, (value) => (this.core.getCloneComputedOutputs() ? cloneShallow(value) : value)));
  }

  /**
   * `computed` over the value at `normalizedPath`, invalidated by that path's version signal.
   * The resolved version signal is cached so steady-state re-evaluation skips the lookup.
   */
  private versionedComputed<R>(normalizedPath: string, project: (value: unknown) => R): Signal<R> {
    const pathSegments = segmentsOf(normalizedPath);
    let cachedVersionPath: string | undefined;
    let versionRef: WritableSignal<number> | undefined;
    return computed(() => {
      const versionPath = this.core.resolveVersionPathNormalized(normalizedPath);
      if (!versionRef || cachedVersionPath !== versionPath) {
        versionRef = this.core.getVersion(versionPath);
        cachedVersionPath = versionPath;
      }
      versionRef();
      return project(readBySegments(this.ctx.root, pathSegments));
    });
  }

  /** A computed running `method` over the array at `path` (cached per method and arguments). */
  createArrayQueryComputed(
    path: string,
    method: ArrayQueryMethodWithLength,
    predicate: unknown,
    ...args: unknown[]
  ): Signal<unknown> | undefined {
    const normalized = PathUtils.normalizePath(path);
    if (this.ctx.read(normalized) === undefined) return undefined;

    const fullPath = `${normalized}.$arrayQuery.${buildMethodHashSegment(method, predicate, args)}`;
    const existing = this.nodes.get(fullPath);
    if (existing) return existing;

    const signal = this.versionedComputed(normalized, (arrayRef): unknown => {
      if (!Array.isArray(arrayRef)) return undefined;
      try {
        return executeArrayQuery(arrayRef, method, predicate, args, { cloneFoundObject: true });
      } catch {
        return undefined;
      }
    });
    this.register(fullPath, signal);
    this.emitUpdate('add', fullPath);
    return signal;
  }

  registerPipelineComputed(path: string, signalRef: Signal<unknown>): void {
    if (!signalRef) return;
    const normalized = PathUtils.normalizePath(path);
    const existed = this.nodes.has(normalized);
    this.register(normalized, signalRef);
    this.emitUpdate(existed ? 'update' : 'add', normalized);
  }

  isExists(path: string): boolean { return this.nodes.has(path); }
  keys(): string[] { return this.nodes.keys(); }
  store(): Record<string, Signal<unknown>> { return this.nodes.toObject(); }

  /** Drops the nodes at and below `pathPrefix` (all of them without one). */
  cleanup(pathPrefix?: string): void {
    if (pathPrefix) this.nodes.deleteByPrefix(pathPrefix);
    else this.nodes.clear();
  }

  remove(path: string): void { this.nodes.deleteByPrefix(path); }

  private register(normalized: string, signal: Signal<unknown>): void {
    this.core.setSignalInProxyCache(normalized, signal);
    this.nodes.set(normalized, signal);
  }

  private emitUpdate(action: 'add' | 'update', path: string): void {
    if (!this.ctx.devActive) return;
    this.ctx.emit({
      type: 'COMPUTED_STORE_UPDATE',
      payload: { storeName: this.ctx.storeName, action, path, keys: this.keys() }
    });
  }
}
