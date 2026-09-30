import type { StoreProxy, ProxyCallable } from '../interfaces/types';
import type { IStoreInstance } from '../interfaces/store-instance.interface';
import { createNodeProxy, createRootProxy, type ProxyContext } from './proxy-node';
import { asHost, serviceOf, type StoreHost } from './store-host';
import { createWriteFns } from './store-writes';
import type { StoreData } from '../types/advanced-types';
import type { SignalStore } from '../core/signal-store.service';
import type { CreateStoreService } from '../core/create-store.core';
import { readPath } from '../utils/path-utils';

/** Configuration of a `ProxyFactory` (one per named store). */
export interface ProxyFactoryConfig {
  storeName: string;
  signalStore: SignalStore;
  createStoreService: CreateStoreService;
  /** Reports cache metrics while dev tools are active. */
  metricsCallback: (storeName: string, metrics: { hits: number; misses: number; hitRate: number; cacheSize: number }) => void;
  /** Maximum number of entries in the proxy cache (default 1000). */
  maxCacheSize?: number;
  /** Read dot paths by scanning the string instead of splitting it. */
  useInPlaceIteration?: boolean;
  /** Strict: throw on invalid paths instead of warn. */
  strictInvalidPath?: boolean;
  /** Strict: forbid root-level rxjs methods. */
  strictRootRxjs?: boolean;
  /** Strict: disallow delete (set undefined). */
  strictDeleteUndefined?: boolean;
  /** Whether rxjs methods are allowed on the root proxy (default true). */
  rxjsAllowedOnRoot?: boolean;
}

/** Builds the proxy tree of one store and owns its proxy-cache metrics timer. */
export class ProxyFactory {
  private metricsIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: ProxyFactoryConfig) {
    config.signalStore.setProxyCacheLimit(config.storeName, config.maxCacheSize ?? 1000);
    this.updateMetricsTimer(!!config.signalStore.devActive);
  }

  updateMetricsTimer(active: boolean): void {
    const { storeName, createStoreService, metricsCallback } = this.config;
    if (active) {
      this.metricsIntervalId ??= setInterval(() => metricsCallback(storeName, createStoreService.getProxyCacheMetrics()), 2000);
    } else if (this.metricsIntervalId) {
      clearInterval(this.metricsIntervalId);
      this.metricsIntervalId = null;
    }
  }

  destroy(): void {
    this.resetCache();
    this.config.signalStore.clearProxyCacheLimit(this.config.storeName);
    this.updateMetricsTimer(false);
  }

  getCacheMetrics() {
    const service = this.config.createStoreService;
    return { ...service.getProxyCacheMetrics(), cacheDump: service.getProxyCacheDump() };
  }

  resetCache(): void {
    this.config.createStoreService.resetProxyCache();
  }

  private getValueIteratively(host: StoreHost, path: string): unknown {
    const root = host.store;
    if (!this.config.useInPlaceIteration || path.indexOf('[') !== -1) return readPath(root, path);
    if (!root || !path) return undefined;
    let current: unknown = root;
    let start = 0;
    for (let i = 0; i <= path.length; i++) {
      if (i !== path.length && path.charCodeAt(i) !== 46) continue;
      if (current == null) return undefined;
      current = (current as Record<string, unknown>)[path.slice(start, i)];
      start = i + 1;
    }
    return current;
  }

  private cacheMake(path: string, host: StoreHost, make: (path: string) => ProxyCallable): ProxyCallable {
    const service = this.config.createStoreService;
    const cached = service.getProxyCacheEntry(path);
    if (cached) {
      service.recordProxyCacheHit();
      return cached;
    }
    service.recordProxyCacheMiss();

    const callableProxy = make(path);
    service.setProxyCacheEntry(callableProxy, path);

    // Prefetch missing ancestors, root-most first: "a.b.c" visits "a", then "a.b".
    for (let dot = path.indexOf('.'); dot !== -1; dot = path.indexOf('.', dot + 1)) {
      const prefix = path.slice(0, dot);
      if (service.getProxyCacheEntry(prefix)) continue;
      const intermediateValue = this.getValueIteratively(host, prefix);
      if (intermediateValue === undefined) continue;
      service.setProxyCacheEntry(make(prefix), prefix);
      try {
        host.prefetchCursorWithNode?.(prefix, intermediateValue);
      } catch (e) {
        console.warn('ProxyFactory prefetchCursor error:', e);
      }
    }

    return callableProxy;
  }

  createStoreProxy<T extends StoreData>(storeInstance: IStoreInstance<T>): StoreProxy<T> {
    const { strictInvalidPath = false, strictDeleteUndefined = false, strictRootRxjs = false, rxjsAllowedOnRoot = true } = this.config;
    const host = asHost(storeInstance);
    const { setFn, deleteFn } = createWriteFns(host, {
      strictInvalidPath,
      strictDeleteUndefined,
      warn: (message) => console.warn(message),
    });

    const make = (path: string): ProxyCallable => createNodeProxy(ctx, path);
    const ctx: ProxyContext = {
      host,
      service: serviceOf(host),
      strictInvalidPath,
      strictDeleteUndefined,
      setFn,
      deleteFn,
      throwOnRootRxjs: !rxjsAllowedOnRoot && strictRootRxjs,
      readRoot: (path) => this.getValueIteratively(host, path),
      makeChild: (path) => {
        try {
          return this.cacheMake(path, host, make);
        } catch (error) {
          console.warn(`Error creating proxy for path ${path}:`, error);
          return make(path);
        }
      },
    };
    return createRootProxy(ctx) as StoreProxy<T>;
  }
}
