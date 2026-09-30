import type { Signal } from '@angular/core';
import { PathUtils } from '../../utils/path-utils';
import type { ProxyCallable } from '../../interfaces/types';
import type { SignalStore } from '../signal-store.service';
import { PathRingOrder } from '../../utils/path-ring-order';
import { isIndexedChild } from '../indexed-keys';

export type CacheMetrics = { hits: number; misses: number; hitRate: number };

function deleteWhere<V>(map: Record<string, V>, predicate: (key: string) => boolean): void {
  for (const key of Object.keys(map)) if (predicate(key)) delete map[key];
}

/**
 * Per-store cache of callable proxies (and computed signals), both held weakly. Insertion-ordered
 * eviction past the store's proxy cache limit; entries whose target was collected drop out lazily.
 */
export class ProxyCacheManager {
  private cache: Record<string, WeakRef<ProxyCallable>> = Object.create(null);
  private signalCache: Record<string, WeakRef<Signal<unknown>>> = Object.create(null);
  private readonly order = new PathRingOrder();
  private hits = 0;
  private misses = 0;
  /** Drops a path's entries once its proxy is collected (absent where FinalizationRegistry is unavailable). */
  private readonly finalizer = typeof FinalizationRegistry !== 'undefined' ? new FinalizationRegistry<string>((path) => this.delete(path)) : undefined;

  constructor(
    private readonly storeName: string,
    private readonly signalStore: SignalStore
  ) {}

  markHit(): void { this.hits++; }
  markMiss(): void { this.misses++; }

  /** Cached proxy for `path`; drops the entry once its target was collected. */
  peek(path: string): ProxyCallable | undefined {
    const normalized = PathUtils.normalizePath(path);
    const proxy = this.cache[normalized]?.deref();
    if (!proxy && this.cache[normalized]) this.deleteSubtree(normalized);
    return proxy;
  }

  add(path: string, proxy: ProxyCallable): void {
    const normalized = PathUtils.normalizePath(path);
    this.finalizer?.register(proxy, normalized);
    this.cache[normalized] = new WeakRef(proxy);
    this.order.add(normalized);
    this.order.evictOver(
      this.signalStore.getProxyCacheLimit(this.storeName) ?? 1000,
      (oldest) => {
        delete this.cache[oldest];
        delete this.signalCache[oldest];
      },
      (key) => this.isLive(key)
    );
  }

  /** Drops `path` and everything cached below it. */
  delete(path: string): void {
    this.deleteSubtree(PathUtils.normalizePath(path));
  }

  reset(): void {
    this.cache = Object.create(null);
    this.signalCache = Object.create(null);
    this.order.clear();
    this.hits = this.misses = 0;
  }

  getSignal(path: string): Signal<unknown> | undefined {
    const normalized = PathUtils.normalizePath(path);
    const signal = this.signalCache[normalized]?.deref();
    if (!signal) delete this.signalCache[normalized];
    return signal;
  }

  setSignal(path: string, signalRef: Signal<unknown>): void {
    if (signalRef) this.signalCache[PathUtils.normalizePath(path)] = new WeakRef(signalRef);
  }

  metricsSnapshot(): CacheMetrics & { cacheSize: number; cacheKeys: string[] } {
    const cacheKeys = this.keys();
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      cacheSize: cacheKeys.length,
      cacheKeys
    };
  }

  dump(): Array<{ key: string; value: string }> {
    return this.keys().map((key) => ({ key, value: '[ProxyCallable]' }));
  }

  emitMetrics(metrics: { hits: number; misses: number; hitRate: number; cacheSize: number }): void {
    if (!this.signalStore.devActive) return;
    const cacheDump = this.dump();
    this.signalStore.emitDevAction(this.storeName, {
      type: 'PROXY_METRICS',
      payload: { path: 'proxy-cache', ...metrics, cacheDump, cacheKeys: cacheDump.map(({ key }) => key), graph: undefined }
    });
  }

  hasIndexedChildAtOrAfter(path: string, startIndex: number): boolean {
    const normalized = PathUtils.normalizePath(path);
    if (!normalized) return false;
    const prefix = `${normalized}.`;
    const inRange = (key: string) => isIndexedChild(key, prefix, startIndex);
    return this.order.some(inRange) || Object.keys(this.signalCache).some(inRange);
  }

  deleteIndexedRange(path: string, startIndex: number, endIndex: number): void {
    if (startIndex < 0 || endIndex <= startIndex) return;
    const normalized = PathUtils.normalizePath(path);
    if (!normalized) return;
    const prefix = `${normalized}.`;
    const inRange = (key: string) => isIndexedChild(key, prefix, startIndex, endIndex);
    deleteWhere(this.cache, inRange);
    deleteWhere(this.signalCache, inRange);
    this.order.deleteWhere(inRange);
  }

  private keys(): string[] {
    return this.order.keys((key) => this.isLive(key));
  }

  private deleteSubtree(normalized: string): void {
    const pref = normalized ? normalized + '.' : '';
    const inSubtree = (key: string) => key === normalized || key.startsWith(pref);
    deleteWhere(this.cache, inSubtree);
    deleteWhere(this.signalCache, inSubtree);
    this.order.deleteByPrefix(normalized);
  }

  private isLive(key: string): boolean {
    if (this.cache[key]?.deref()) return true;
    delete this.cache[key];
    delete this.signalCache[key];
    return false;
  }
}
