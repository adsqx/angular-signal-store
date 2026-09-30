import { Signal } from '@angular/core';
import { ManageFinalizationRegistry } from '../../utils/manage-finalization-registry';
import { PathUtils } from '../../utils/path-utils';
import { ProxyCallable } from '../../interfaces/types';
import { SignalStore } from '../signal-store.service';
import { StoreDevToolsAction } from '../../devtools/types';
import { CacheMetricsTracker } from '../../utils/abstracts/cache-metrics';
import { PathRingOrder } from '../../utils/path-ring-order';

export type CacheMetrics = { hits: number; misses: number; hitRate: number };

export class ProxyCacheManager {
  private cache: Record<string, WeakRef<ProxyCallable>> = Object.create(null);
  private signalCache: Record<string, WeakRef<Signal<unknown>>> = Object.create(null);
  private readonly cacheOrder = new PathRingOrder();
  private readonly metrics = new CacheMetricsTracker();
  private readonly finalizer: ManageFinalizationRegistry<ProxyCallable, string>;

  constructor(
    private readonly storeName: string,
    private readonly signalStore: SignalStore
  ) {
    this.finalizer = new ManageFinalizationRegistry<ProxyCallable, string>((path) => {
      this.delete(path);
    });
  }

  get(path: string): ProxyCallable | undefined {
    const proxy = this.peek(path);
    if (proxy) {
      this.metrics.hit();
    }
    return proxy;
  }

  peek(path: string): ProxyCallable | undefined {
    return this.lookup(PathUtils.normalizePath(path));
  }

  getOrCreate<T>(
    path: string,
    factory: (path: string, value: T) => ProxyCallable,
    valueReader: (path: string) => T | undefined
  ): ProxyCallable | undefined {
    const normalized = PathUtils.normalizePath(path);
    const cached = this.lookup(normalized);
    if (cached) {
      this.metrics.hit();
      return cached;
    }

    const value = valueReader(normalized);
    if (value === undefined) {
      return undefined;
    }

    const proxy = factory(normalized, value);
    this.storeEntry(normalized, proxy);
    this.metrics.miss();
    this.evictIfNeeded();
    return proxy;
  }

  add(path: string, proxy: ProxyCallable): void {
    this.storeEntry(PathUtils.normalizePath(path), proxy);
    this.evictIfNeeded();
  }

  delete(path: string): void {
    this.deleteNormalized(PathUtils.normalizePath(path));
  }

  cleanup(pathPrefix?: string): void {
    if (!pathPrefix) {
      this.reset();
      return;
    }
    this.delete(pathPrefix);
  }

  reset(): void {
    this.cache = Object.create(null);
    this.signalCache = Object.create(null);
    this.cacheOrder.clear();
    this.metrics.reset();
  }

  metricsSnapshot(): CacheMetrics & { cacheSize: number; cacheKeys: string[] } {
    const cacheKeys = this.keys();
    return {
      ...this.metrics.snapshot(),
      cacheSize: cacheKeys.length,
      cacheKeys
    };
  }

  emitMetrics(metrics: { hits: number; misses: number; hitRate: number; cacheSize: number }): void {
    if (!this.signalStore.devActive) return;
    const cacheDump = this.dump();
    const proxyAction: StoreDevToolsAction = {
      type: 'PROXY_METRICS',
      payload: {
        path: 'proxy-cache',
        ...metrics,
        cacheDump,
        cacheKeys: cacheDump.map(({ key }) => key),
        graph: undefined
      }
    };
    this.signalStore.emitDevAction(this.storeName, proxyAction);
  }

  getSignal(path: string): Signal<unknown> | undefined {
    const normalized = PathUtils.normalizePath(path);
    const ref = this.signalCache[normalized];
    if (!ref) return undefined;
    const signal = ref.deref();
    if (!signal) {
      delete this.signalCache[normalized];
      return undefined;
    }
    return signal;
  }

  setSignal(path: string, signalRef: Signal<unknown>): void {
    if (!signalRef) return;
    const normalized = PathUtils.normalizePath(path);
    this.signalCache[normalized] = new WeakRef(signalRef);
  }

  keys(): string[] {
    return this.cacheOrder.keys((key) => this.isLiveProxyKey(key));
  }

  entries(): Record<string, WeakRef<ProxyCallable>> {
    return { ...this.cache };
  }

  isCached(path: string): boolean {
    return !!this.cache[PathUtils.normalizePath(path)]?.deref();
  }

  hasIndexedChildAtOrAfter(path: string, startIndex: number): boolean {
    const normalized = PathUtils.normalizePath(path);
    if (!normalized) return false;
    const prefix = `${normalized}.`;
    const inRange = (key: string) => isIndexedChild(key, prefix, startIndex);
    return this.cacheOrder.some(inRange) || Object.keys(this.signalCache).some(inRange);
  }

  deleteIndexedRange(path: string, startIndex: number, endIndex: number): void {
    if (startIndex < 0 || endIndex <= startIndex) return;
    const normalized = PathUtils.normalizePath(path);
    if (!normalized) return;
    const prefix = `${normalized}.`;
    const inRange = (key: string) => isIndexedChild(key, prefix, startIndex, endIndex);
    deleteWhere(this.cache, inRange);
    deleteWhere(this.signalCache, inRange);
    this.cacheOrder.deleteWhere(inRange);
  }

  markHit(): void {
    this.metrics.hit();
  }

  markMiss(): void {
    this.metrics.miss();
  }

  dump(): Array<{ key: string; value: string }> {
    return this.keys().map((key) => ({ key, value: '[ProxyCallable]' }));
  }

  private getMaxCacheSize(): number {
    const configured = this.signalStore.getProxyCacheLimit(this.storeName);
    if (typeof configured === 'number' && Number.isFinite(configured)) {
      return Math.max(0, Math.floor(configured));
    }
    return 1000;
  }

  /** Cached proxy for an already-normalized path; drops the entry once its target was collected. */
  private lookup(normalized: string): ProxyCallable | undefined {
    const ref = this.cache[normalized];
    if (!ref) return undefined;
    const proxy = ref.deref();
    if (!proxy) this.deleteNormalized(normalized);
    return proxy;
  }

  private deleteNormalized(normalized: string): void {
    const pref = normalized ? normalized + '.' : '';
    const inSubtree = (key: string) => key === normalized || key.startsWith(pref);
    deleteWhere(this.cache, inSubtree);
    deleteWhere(this.signalCache, inSubtree);
    this.cacheOrder.deleteByPrefix(normalized);
  }

  private storeEntry(normalized: string, proxy: ProxyCallable): void {
    this.cache[normalized] = this.finalizer.create(proxy, normalized);
    this.cacheOrder.add(normalized);
  }

  private evictIfNeeded(): void {
    const maxSize = this.getMaxCacheSize();
    if (maxSize < 0) return;

    this.cacheOrder.evictOver(
      maxSize,
      (oldest) => {
        delete this.cache[oldest];
        delete this.signalCache[oldest];
      },
      (key) => this.isLiveProxyKey(key)
    );
  }

  private isLiveProxyKey(key: string): boolean {
    const ref = this.cache[key];
    if (ref?.deref()) return true;
    delete this.cache[key];
    delete this.signalCache[key];
    return false;
  }
}

function deleteWhere<V>(map: Record<string, V>, predicate: (key: string) => boolean): void {
  for (const key of Object.keys(map)) {
    if (predicate(key)) delete map[key];
  }
}

/** True when `key` is `prefix` + an integer index segment in [startIndex, endIndex). */
function isIndexedChild(key: string, prefix: string, startIndex: number, endIndex = Infinity): boolean {
  if (!key.startsWith(prefix)) return false;
  const dotIndex = key.indexOf('.', prefix.length);
  const segment = dotIndex === -1 ? key.slice(prefix.length) : key.slice(prefix.length, dotIndex);
  if (!segment) return false;
  const index = Number(segment);
  return Number.isInteger(index) && index >= startIndex && index < endIndex;
}
