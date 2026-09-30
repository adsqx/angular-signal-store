import { Inject, Injectable, Optional } from '@angular/core';
import { CreateStore } from './create-store.class';
import { StoreProxy } from '../interfaces/types';
import type { IStoreInstance } from '../interfaces/store-instance.interface';
import { ProxyFactory } from '../proxy/proxy-factory.class';
import { createCallableProxy as createCallableProxyUtil } from '../proxy/proxy-node';
import { EMPTY, Observable, Subscription } from 'rxjs';
import { StoreData } from '../types/advanced-types';
import { PathUtils } from '../utils/path-utils';
import type { Stores } from '../types/registry';
import type { StoreDevToolsAction } from '../devtools/types';
import { setLoggerActive } from '../utils/logger';
import { emitDevEvent } from './devtools-bus';
import {
  SIGNAL_STORE_DEVTOOLS,
  type AngularStoreDevtools,
  type DevToolsEvent,
} from './devtools-contract';

export type { DevToolsEvent } from './devtools-contract';

export interface WaitForStoreOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

type StoreWaiter = {
  resolve(store: StoreProxy<StoreData>): void;
  reject(error: Error): void;
  cleanup(): void;
};

@Injectable({
  providedIn: 'root'
})
export class SignalStore {
  devActive:boolean = false;
  // Map przechowujący "surowe" instancje CreateStore (pełna funkcjonalność)
  private storeInstances: Record<string, CreateStore<StoreData>> = Object.create(null);

  // Map przechowujący gotowe proxowane sklepy, zwracane na zewnątrz
  private storeProxies: Record<string, StoreProxy<StoreData>> = Object.create(null);
  // Referencje do ProxyFactory, by móc zarządzać timerami metryk
  private proxyFactories: Record<string, ProxyFactory> = Object.create(null);
  // Konfiguracja limitow proxy cache per store
  private proxyCacheLimits: Record<string, number> = Object.create(null);
  private storeWaiters = new Map<string, Set<StoreWaiter>>();
  
  // ------------------------------
  // Graph-based stores - moved to CreateStoreService
  // ------------------------------
  
  constructor(
    @Optional() @Inject(SIGNAL_STORE_DEVTOOLS)
    private devService: AngularStoreDevtools | null = null
  ) {
    setLoggerActive(this.devActive);
  }

  /* ----------------------------------------------------------------
   * DevTools helpers – serve jako centralny "bus" dla panelu DevTools
   * --------------------------------------------------------------*/
  public get devAction$() { return this.devService?.action$ ?? EMPTY; }
  public get devReadAction$() { return this.devService?.readAction$ ?? EMPTY; }

  attachDevtools(devtools: AngularStoreDevtools | null): void {
    this.devService = devtools;
  }

  getDevtoolsAdapter(): AngularStoreDevtools | undefined {
    return this.devService ?? undefined;
  }

  emitDevAction(storeName: string, action: StoreDevToolsAction) {
    emitDevEvent(this, storeName, action, 'direct');
  }
  devActivation(devActive:boolean) {
    this.devActive = devActive;
    setLoggerActive(devActive);
    // Toggle metrics timers for all proxy factories
    Object.values(this.proxyFactories).forEach((pf) => pf.updateMetricsTimer(devActive));
  }
  setMetricsThrottle(ms: number) {
    this.metricsThrottleMs = Math.max(0, ms);
  }

  // Optional: bind an external observable<boolean> to drive dev activation
  bindDevActivation(devActive$: Observable<boolean>): Subscription {
    return devActive$.subscribe((active) => this.devActivation(!!active));
  }
  // manual push to read stream if needed
  emitDevReadAction(storeName: string, data: StoreDevToolsAction) {
    const event: DevToolsEvent = { ...data, storeName };
    this.devService?.emitRead(event);
  }

  // Throttle metrics emission per store
  private lastMetricsEmit: Record<string, number> = Object.create(null);
  private metricsThrottleMs = 250; // conservative default

  emitProxyMetrics(storeName: string, metrics: { hits: number; misses: number; hitRate: number; cacheSize: number }) {
    if (!this.devActive) return;
    const now = Date.now();
    if (now - (this.lastMetricsEmit[storeName] || 0) < this.metricsThrottleMs) return;
    this.lastMetricsEmit[storeName] = now;
    // Action stream only: PROXY_METRICS never reaches the read history.
    emitDevEvent(this, storeName, {
      type: 'PROXY_METRICS',
      payload: { path: 'proxy-cache', ...metrics, cacheDump: [], cacheKeys: [] }
    }, 'direct');
  }

  createStore<T extends StoreData = StoreData>(
    val: T,
    name: string,
    options?: {
      useInPlaceIteration?: boolean;
      dependencyMode?: 'exact' | 'container';
      cloneInitialValue?: 'none' | 'structured';
      strict?: { invalidPath?: boolean; rootRxjs?: boolean; deleteUndefined?: boolean };
      rxjsAllowedOnRoot?: boolean;
      metricsThrottleMs?: number;
      proxyCacheMaxSize?: number;
      versionBump?: {
        strategy?: 'microtask' | 'raf';
        throttleMs?: number;
        partialInvalidation?: boolean;
      };
    }
  ): StoreProxy<T> {
    if (!name || typeof name !== 'string') {
      throw new Error(`Store name must be a non-empty string. Received: ${String(name)}`);
    }
    if (this.storeInstances[name] || this.storeProxies[name]) {
      throw new Error(`Store '${name}' already exists. Use useStore('${name}') instead of creating it again.`);
    }

    // 1. Create low-level store instance responsible for all logic
    const storeInstance = new CreateStore(this, name, undefined, this.devService ?? undefined);

    // Apply dependency mode if provided
    if (options?.dependencyMode) {
      storeInstance.createServiceGetter.setDependencyMode(options.dependencyMode);
    }

    // Apply version bump configuration if provided
    if (options?.versionBump) {
      const vb = options.versionBump;
      if (vb.strategy) storeInstance.createServiceGetter.setVersionBumpStrategy(vb.strategy);
      if (typeof vb.throttleMs === 'number') storeInstance.createServiceGetter.setVersionBumpThrottle(vb.throttleMs);
      if (typeof vb.partialInvalidation === 'boolean') storeInstance.createServiceGetter.setPartialInvalidation(vb.partialInvalidation);
    }

    // 2. Set initial value inside the store **before** proxy is built
    const initial = options?.cloneInitialValue === 'none' ? val : structuredClone(val);
    Object.assign(storeInstance.returnStore(), initial);

    // 3. Create proxy that exposes reactive API for consumers
    const proxyFactory = new ProxyFactory({
      metricsCallback: (_storeName, metrics) => {
        storeInstance.createServiceGetter.emitProxyMetrics(metrics);
      },
      maxCacheSize: options?.proxyCacheMaxSize,
      storeName: name,
      signalStore: this,
      createStoreService: (storeInstance as unknown as { createService: CreateStore<StoreData>['createService'] }).createService,
      useInPlaceIteration: !!options?.useInPlaceIteration,
      strictInvalidPath: !!options?.strict?.invalidPath,
      strictRootRxjs: !!options?.strict?.rootRxjs,
      strictDeleteUndefined: !!options?.strict?.deleteUndefined,
      rxjsAllowedOnRoot: options?.rxjsAllowedOnRoot ?? true
    });
    if (typeof options?.metricsThrottleMs === 'number') {
      this.metricsThrottleMs = Math.max(0, options!.metricsThrottleMs!);
    }
    const proxyStore = proxyFactory.createStoreProxy<T>(storeInstance as unknown as IStoreInstance<T>);

    // 4. Zapisz oddzielnie instancję i proxy
    this.storeInstances[name] = storeInstance as CreateStore<StoreData>;
    this.storeProxies[name] = proxyStore as StoreProxy<StoreData>;
    this.proxyFactories[name] = proxyFactory;
    this.resolveStoreWaiters(name, proxyStore as StoreProxy<StoreData>);

    return proxyStore;
  }

  /** Wait for a named proxy without changing the synchronous useStore/getStore contract. */
  waitForStore<T extends StoreData = StoreData>(
    name: string,
    options: WaitForStoreOptions = {}
  ): Promise<StoreProxy<T>> {
    const existing = this.storeProxies[name];
    if (existing) return Promise.resolve(existing as StoreProxy<T>);

    const abortError = () => Object.assign(new Error(`waitForStore('${name}') aborted.`), { name: 'AbortError' });
    if (options.signal?.aborted) return Promise.reject(abortError());

    return new Promise<StoreProxy<T>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiters = this.storeWaiters.get(name) ?? new Set<StoreWaiter>();
      const onAbort = () => finishReject(abortError());
      const waiter: StoreWaiter = {
        resolve: (store) => resolve(store as StoreProxy<T>),
        reject,
        cleanup: () => {
          if (timer !== undefined) clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
        },
      };
      const finishReject = (error: Error) => {
        waiters.delete(waiter);
        if (waiters.size === 0) this.storeWaiters.delete(name);
        waiter.cleanup();
        waiter.reject(error);
      };

      waiters.add(waiter);
      this.storeWaiters.set(name, waiters);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        const timeoutMs = Math.max(0, options.timeoutMs);
        timer = setTimeout(
          () => finishReject(new Error(`waitForStore('${name}') timed out after ${timeoutMs}ms.`)),
          timeoutMs
        );
      }
    });
  }

  private resolveStoreWaiters(name: string, store: StoreProxy<StoreData>): void {
    const waiters = this.storeWaiters.get(name);
    if (!waiters) return;
    this.storeWaiters.delete(name);
    for (const waiter of waiters) {
      waiter.cleanup();
      waiter.resolve(store);
    }
  }

  /**
   * Zwraca wewnętrzną instancję CreateStore używaną przez logikę biblioteki.
   * Używane jedynie wewnętrznie; dla komponentów/serwisów należy użyć useStore().
   */
  // Public for internal consumers across library (kept for compatibility)
  getStore(name: string) {
    return this.storeInstances[name];
  }

  /**
   * Register a store instance built directly via `new CreateStore(name)` so that
   * `getStore(name)` (used by typed array operations, base manager, etc.) resolves it.
   * Idempotent: the createStore factory assigns the same instance afterwards, and a
   * second direct construction with the same name is left to the factory's own guard.
   */
  registerStoreInstance(name: string, instance: CreateStore<StoreData>): void {
    if (name && !this.storeInstances[name]) {
      this.storeInstances[name] = instance;
    }
  }

  destroyStore(name: string): void {
    const storeInstance = this.storeInstances[name] as (CreateStore<StoreData> & {
      createServiceGetter?: {
        destroy?: () => void;
      };
      destroy?: () => void;
    }) | undefined;
    const proxyFactory = this.proxyFactories[name];

    if (!storeInstance && !proxyFactory && !this.storeProxies[name]) {
      return;
    }

    try {
      proxyFactory?.destroy?.();
    } catch (e) {
      console.warn('SignalStore proxyFactory destroy error:', e);
    }

    try {
      if (typeof storeInstance?.destroy === 'function') {
        storeInstance.destroy();
      }
    } catch (e) {
      console.warn('SignalStore storeInstance destroy error:', e);
    }

    delete this.storeInstances[name];
    delete this.storeProxies[name];
    delete this.proxyFactories[name];
    delete this.lastMetricsEmit[name];
    delete this.proxyCacheLimits[name];
  }

  removeStore(name: string): void {
    this.destroyStore(name);
  }

  /**
   * Zwraca proxy dla danego sklepu – tego powinny używać komponenty.
   */
  // Overloads: typed by registry, and a fallback to keep compatibility when registry is empty
  useStore<K extends keyof Stores & string>(name: K): StoreProxy<Stores[K]>;
  useStore(name: string): StoreProxy<StoreData>;
  useStore(name: string): StoreProxy<StoreData> {
    const proxy = this.storeProxies[name];
    if (!proxy) {
      throw new Error(`Store '${name}' not found. Make sure to create it first with createStore().`);
    }
    return proxy as StoreProxy<StoreData>;
  }

  // Public API compatibility method
  createCallableProxy(nestedPath: string, storeInstance: unknown, nestedValue: unknown) {
    return createCallableProxyUtil(nestedPath, storeInstance as IStoreInstance<StoreData>, nestedValue);
  }

  // Proxy cache operations - moved to CreateStoreService

  // Computed, Behavior and Proxy operations - moved to CreateStoreService

  // Store operations (przeniesione z StoreOperations)
  setValue(storeName: string, path: string, val: object): void {
    const store = this.getStore(storeName);
    const normalized = PathUtils.normalizePath(path);
    const previousValue = store.readStore(normalized);
    const oldValue = this.devActive ? previousValue : undefined;

    // In-place mutation without Immer/root update (legacy API)
    PathUtils.setByPath(store.returnStore() as StoreData, normalized, val);
    
    // DevTools logging
    if (this.devActive) {
      this.emitDevAction(storeName, {
        type: 'SET_VALUE',
        payload: {
          path: normalized,
          oldValue,
          value: val
        }
      });
    }
    
    store.wakeUpMutationPath(normalized, val, {
      syncDescendants:
        PathUtils.isBranchValue(previousValue) ||
        PathUtils.isBranchValue(val)
    });
  }

  read(storeName: string, path: string) {
    const store = this.getStore(storeName);
    const normalized = PathUtils.normalizePath(path);
    const segments = store.createServiceGetter.getPathSegments(normalized);
    return store.createServiceGetter.fastReadBySegments(store.returnStore(), segments);
  }

  // Legacy aliases (kept to avoid breaking internal imports)
  readStore(storeName: string, path: string) {
    return this.read(storeName, path);
  }
  getSignalValue(storeName: string, path: string) {
    return this.read(storeName, path);
  }

  setProxyCacheLimit(storeName: string, limit: number): void {
    if (!storeName) return;
    this.proxyCacheLimits[storeName] = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 1000;
  }

  getProxyCacheLimit(storeName: string): number | undefined {
    return this.proxyCacheLimits[storeName];
  }

  clearProxyCacheLimit(storeName: string): void {
    delete this.proxyCacheLimits[storeName];
  }

  // Typed read via selector function with inference
  select<K extends keyof Stores & string, R>(storeName: K, selector: (state: Stores[K]) => R): R {
    const store = this.getStore(storeName);
    const root = store.returnStore() as Stores[K];
    return selector(root);
  }

  // ensureProxyRoot moved to CreateStoreService
}
