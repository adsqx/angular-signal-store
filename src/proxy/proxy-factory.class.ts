import { ProxyFactoryConfig } from '../interfaces/proxy-factory-config.interface';
import { ILogger } from '../interfaces/logger.interface';
import { StoreProxy, ProxyCallable } from '../interfaces/types';
import { IStoreInstance } from '../interfaces/store-instance.interface';
import { createCallableProxy, type CallableProxyOptions } from './callable-proxy.util';
import { asHost, type StoreHost } from './store-host';
import { createWriteFns } from './store-writes';
import { GenericProxyHandler } from './generic-proxy-handler.class';
import { StoreData } from '../types/advanced-types';
import { SignalStore } from '../core/signal-store.service';
import { CreateStoreService } from '../core/create-store.core';
import type { CacheMetrics } from '../core/services/proxy-cache.manager';
import { PathReader } from '../utils/abstracts/path-reader';

export class ProxyFactory {
  private readonly maxCacheSize: number;
  private readonly logger: ILogger;
  private readonly metricsCallback?: (storeName: string, metrics: { hits: number; misses: number; hitRate: number; cacheSize: number }) => void;
  private readonly storeName?: string;
  private readonly signalStore: SignalStore;
  private readonly useInPlaceIteration: boolean;
  private readonly createStoreService: CreateStoreService;
  private readonly strictInvalidPath: boolean;
  private readonly strictRootRxjs: boolean;
  private readonly strictDeleteUndefined: boolean;
  private readonly rxjsAllowedOnRoot: boolean;
  private metricsIntervalId: ReturnType<typeof setInterval> | null = null;
  private readonly pathReader = new PathReader();

  constructor(config: ProxyFactoryConfig = {}) {
    this.maxCacheSize = config.maxCacheSize ?? 1000;
    this.logger = config.logger ?? console;
    this.metricsCallback = config.metricsCallback;
    this.storeName = config.storeName;
    this.signalStore = config.signalStore!;
    this.useInPlaceIteration = config.useInPlaceIteration ?? false;
    this.createStoreService = config.createStoreService!;
    this.strictInvalidPath = !!config.strictInvalidPath;
    this.strictRootRxjs = !!config.strictRootRxjs;
    this.strictDeleteUndefined = !!config.strictDeleteUndefined;
    this.rxjsAllowedOnRoot = config.rxjsAllowedOnRoot ?? true;
    this.configureProxyCacheLimit();

    if (this.metricsCallback && this.storeName) {
      this.updateMetricsTimer(!!this.signalStore?.devActive);
    }
  }

  public updateMetricsTimer(active: boolean) {
    if (!this.metricsCallback || !this.storeName) return;
    if (active) {
      if (this.metricsIntervalId) return;
      this.metricsIntervalId = setInterval(() => {
        const metrics = this.createStoreService.getProxyCacheMetrics();
        if (this.metricsCallback) {
          this.metricsCallback(this.storeName!, metrics);
        }
      }, 2000);
    } else {
      if (this.metricsIntervalId) {
        clearInterval(this.metricsIntervalId);
        this.metricsIntervalId = null;
      }
    }
  }

  destroy() {
    if (this.storeName) {
      this.createStoreService.resetProxyCache();
      this.clearProxyCacheLimit();
    }
    if (this.metricsIntervalId) {
      clearInterval(this.metricsIntervalId);
      this.metricsIntervalId = null;
    }
  }

  getCacheMetrics(): CacheMetrics & { cacheSize: number; cacheKeys: string[]; cacheDump: Array<{ key: string; value: string }> } {
    if (!this.storeName) {
      return { hits: 0, misses: 0, hitRate: 0, cacheSize: 0, cacheKeys: [], cacheDump: [] };
    }
    const metrics = this.createStoreService.getProxyCacheMetrics();
    const cacheDump = this.createStoreService.getProxyCacheDump();
    return {
      ...metrics,
      cacheSize: metrics.cacheKeys.length,
      cacheKeys: metrics.cacheKeys,
      cacheDump
    };
  }

  resetCache() {
    if (this.storeName) {
      this.createStoreService.resetProxyCache();
    }
  }

  private recordCacheHit() {
    if (this.storeName) {
      this.createStoreService.recordProxyCacheHit();
    }
  }

  private recordCacheMiss() {
    if (this.storeName) {
      this.createStoreService.recordProxyCacheMiss();
    }
  }

  private configureProxyCacheLimit(): void {
    if (!this.storeName || !this.signalStore) return;
    this.signalStore.setProxyCacheLimit(this.storeName, this.maxCacheSize);
  }

  private clearProxyCacheLimit(): void {
    if (!this.storeName || !this.signalStore) return;
    this.signalStore.clearProxyCacheLimit(this.storeName);
  }

  private getValueIteratively(host: StoreHost, path: string): unknown {
    const root = host.store as Record<string, unknown>;
    if (this.useInPlaceIteration && path.indexOf('[') === -1) {
      return this.readDotPathInPlace(root, path);
    }
    return this.pathReader.read(root, path);
  }

  private readDotPathInPlace(root: Record<string, unknown> | undefined, path: string): unknown {
    if (!root || !path) return undefined;
    let current: unknown = root;
    let start = 0;

    for (let i = 0; i <= path.length; i++) {
      if (i !== path.length && path.charCodeAt(i) !== 46) continue;
      if (current == null) return undefined;
      const segment = path.slice(start, i);
      current = (current as Record<string, unknown>)[segment];
      start = i + 1;
    }

    return current;
  }

  private cacheMake(
    path: string,
    value: unknown,
    host: StoreHost,
    make: (path: string, value: unknown) => ProxyCallable
  ): ProxyCallable {
    const service = this.createStoreService;
    const cached = service.getProxyCacheEntry(path);
    if (cached) {
      this.recordCacheHit();
      return cached;
    }

    this.recordCacheMiss();

    const callableProxy = make(path, value);
    service.setProxyCacheEntry(callableProxy, path);

    // Prefetch missing ancestors, root-most first: "a.b.c" visits "a", then "a.b".
    for (let dot = path.indexOf('.'); dot !== -1; dot = path.indexOf('.', dot + 1)) {
      const prefix = path.slice(0, dot);
      if (service.getProxyCacheEntry(prefix)) continue;
      const intermediateValue = this.getValueIteratively(host, prefix);
      if (intermediateValue === undefined) continue;
      service.setProxyCacheEntry(make(prefix, intermediateValue), prefix);
      try {
        host.prefetchCursorWithNode?.(prefix, intermediateValue);
      } catch (e) {
        console.warn('ProxyFactory prefetchCursor error:', e);
      }
    }

    return callableProxy;
  }

  createStoreProxy<T extends StoreData>(storeInstance: IStoreInstance<T>): StoreProxy<T> {
    const host = asHost(storeInstance);
    const { setFn, deleteFn } = createWriteFns(host, {
      strictInvalidPath: this.strictInvalidPath,
      strictDeleteUndefined: this.strictDeleteUndefined,
      warn: (message) => this.logger.warn(message),
    });

    const callableOptions: CallableProxyOptions = {
      strictInvalidPath: this.strictInvalidPath,
      strictDeleteUndefined: this.strictDeleteUndefined,
      setFn,
      deleteFn,
    };

    const make = (path: string, value: unknown): ProxyCallable =>
      createCallableProxy(path, host, value, nestedProxyFactory, callableOptions);

    const nestedProxyFactory = (path: string, value: unknown): ProxyCallable => {
      try {
        return this.cacheMake(path, value, host, make);
      } catch (error) {
        this.logger.warn(`Error creating proxy for path ${path}:`, error);
        return make(path, value);
      }
    };

    const handler = new GenericProxyHandler<T>(storeInstance, {
      pathPrefix: '',
      exposeStoreMethods: true,
      resolveFn: (path) => this.getValueIteratively(host, path),
      nestedProxyFactory,
      rxjsAllowedOnRoot: this.rxjsAllowedOnRoot,
      strictInvalidPath: this.strictInvalidPath,
      strictRootRxjs: this.strictRootRxjs,
      strictDeleteUndefined: this.strictDeleteUndefined,
      originalNestedValue: undefined,
      setFn,
      deleteFn,
    });

    return new Proxy({}, {
      get: handler.createProxyGetter({}),
      set: handler.createProxySetter(),
      deleteProperty: handler.createProxyDeleter()
    }) as StoreProxy<T>;
  }
}
