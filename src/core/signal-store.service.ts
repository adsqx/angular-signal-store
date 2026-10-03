import { Inject, Injectable, Optional } from '@angular/core';
import type { CreateStore } from './create-store.class';
import { StoreProxy } from '../interfaces/types';
import type { IStoreInstance } from '../interfaces/store-instance.interface';
import type { ProxyFactory } from '../proxy/proxy-factory.class';
import { createCallableProxy as createCallableProxyUtil } from '../proxy/proxy-node';
import { EMPTY, Observable, Subscription } from 'rxjs';
import { StoreData } from '../types/advanced-types';
import { PathUtils } from '../utils/path-utils';
import { getJsonBySegments } from '@adsq/jsnq/data-engine';
import type { Stores } from '../types/registry';
import type { StoreDevToolsAction } from '../devtools/types';
import { setLoggerActive } from '../utils/logger';
import { SIGNAL_STORE_DEVTOOLS, emitDevEvent, type AngularStoreDevtools, type DevToolsEvent } from './devtools-contract';
import { buildStore, type CreateStoreOptions } from './store-factory';
import { StoreWaiters, type WaitForStoreOptions } from './store-waiters';
import { wakeOptions } from './wake/wake-types';

export type { DevToolsEvent } from './devtools-contract';
export type { WaitForStoreOptions } from './store-waiters';
export type { CreateStoreOptions } from './store-factory';

@Injectable({
  providedIn: 'root'
})
export class SignalStore {
  devActive:boolean = false;
  /** Raw `CreateStore` instances (full functionality). */
  private storeInstances: Record<string, CreateStore<StoreData>> = Object.create(null);
  /** Proxied stores handed out to consumers. */
  private storeProxies: Record<string, StoreProxy<StoreData>> = Object.create(null);
  /** Kept to manage their metrics timers. */
  private proxyFactories: Record<string, ProxyFactory> = Object.create(null);
  private proxyCacheLimits: Record<string, number> = Object.create(null);
  private readonly waiters = new StoreWaiters();

  constructor(
    @Optional() @Inject(SIGNAL_STORE_DEVTOOLS)
    private devService: AngularStoreDevtools | null = null
  ) {
    setLoggerActive(this.devActive);
  }

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

  bindDevActivation(devActive$: Observable<boolean>): Subscription {
    return devActive$.subscribe((active) => this.devActivation(!!active));
  }
  emitDevReadAction(storeName: string, data: StoreDevToolsAction) {
    const event: DevToolsEvent = { ...data, storeName };
    this.devService?.emitRead(event);
  }

  private lastMetricsEmit: Record<string, number> = Object.create(null);
  private metricsThrottleMs = 250;

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

  // `options` is CreateStoreOptions written as an identity mapped type, so the emitted public signature
  // stays a structurally expanded object type instead of an alias reference (API surface unchanged).
  createStore<T extends object = StoreData>(
    val: T,
    name: string,
    options?: { [K in keyof CreateStoreOptions]: CreateStoreOptions[K] }
  ): StoreProxy<T> {
    if (!name || typeof name !== 'string') {
      throw new Error(`Store name must be a non-empty string. Received: ${String(name)}`);
    }
    if (this.storeInstances[name] || this.storeProxies[name]) {
      throw new Error(`Store '${name}' already exists. Use useStore('${name}') instead of creating it again.`);
    }

    const { instance, proxy, factory } = buildStore(this, val, name, options, this.getDevtoolsAdapter());

    this.storeInstances[name] = instance as unknown as CreateStore<StoreData>;
    this.storeProxies[name] = proxy as StoreProxy<StoreData>;
    this.proxyFactories[name] = factory;
    this.waiters.resolve(name, proxy as StoreProxy<StoreData>);
    return proxy;
  }

  /** Wait for a named proxy without changing the synchronous useStore/getStore contract. */
  waitForStore<T extends object = StoreData>(
    name: string,
    options: WaitForStoreOptions = {}
  ): Promise<StoreProxy<T>> {
    const existing = this.storeProxies[name];
    return existing ? Promise.resolve(existing as StoreProxy<T>) : this.waiters.wait<T>(name, options);
  }

  /** The internal CreateStore instance behind a name. Internal use only; consumers should use useStore(). */
  getStore(name: string) {
    return this.storeInstances[name];
  }

  /**
   * Register a store instance built directly via `new CreateStore(name)` so `getStore(name)` resolves
   * it. Idempotent: the createStore factory assigns the same instance afterwards.
   */
  registerStoreInstance(name: string, instance: CreateStore<StoreData>): void {
    if (name && !this.storeInstances[name]) {
      this.storeInstances[name] = instance;
    }
  }

  destroyStore(name: string): void {
    const storeInstance = this.storeInstances[name];
    const proxyFactory = this.proxyFactories[name];
    if (!storeInstance && !proxyFactory && !this.storeProxies[name]) return;

    warnOnFailure('proxyFactory', () => proxyFactory?.destroy?.());
    warnOnFailure('storeInstance', () => {
      if (typeof storeInstance?.destroy === 'function') storeInstance.destroy();
    });
    for (const registry of [this.storeInstances, this.storeProxies, this.proxyFactories, this.lastMetricsEmit, this.proxyCacheLimits]) {
      delete registry[name];
    }
  }

  removeStore(name: string): void {
    this.destroyStore(name);
  }

  useStore<K extends keyof Stores & string>(name: K): StoreProxy<Stores[K]>;
  useStore(name: string): StoreProxy<StoreData>;
  useStore(name: string): StoreProxy<StoreData> {
    const proxy = this.storeProxies[name];
    if (!proxy) {
      throw new Error(`Store '${name}' not found. Make sure to create it first with createStore().`);
    }
    return proxy;
  }

  createCallableProxy(nestedPath: string, storeInstance: unknown, nestedValue: unknown) {
    return createCallableProxyUtil(nestedPath, storeInstance as IStoreInstance<StoreData>, nestedValue);
  }

  /**
   * Legacy in-place write (no undefined-key removal, `SET_VALUE` event). Deliberately not routed through
   * `CreateStore`'s mutation pipeline: that one emits `SET_VALUE_OBSERVE` with cloned snapshots, removes
   * keys on undefined, creates BehaviorSubjects, and writes through the cursor engine, so unifying
   * would change events and results.
   */
  setValue(storeName: string, path: string, val: object): void {
    const store = this.getStore(storeName);
    const normalized = PathUtils.normalizePath(path);
    const previousValue = store.readStore(normalized);

    PathUtils.setByPath(store.returnStore() as StoreData, normalized, val);

    if (this.devActive) {
      this.emitDevAction(storeName, {
        type: 'SET_VALUE',
        payload: { path: normalized, oldValue: previousValue, value: val }
      });
    }

    store.wakeUpMutationPath(
      normalized,
      val,
      wakeOptions(false, PathUtils.isBranchValue(previousValue) || PathUtils.isBranchValue(val))
    );
  }

  /** Value at `path` in the named store's data. */
  read(storeName: string, path: string) {
    const store = this.getStore(storeName);
    // Normalized twice on purpose: malformed bracket input is not a fixed point of normalization.
    const normalized = PathUtils.normalizePath(PathUtils.normalizePath(path));
    return getJsonBySegments(store.returnStore(), PathUtils.splitNormalizedPath(normalized));
  }

  readStore(storeName: string, path: string) { return this.read(storeName, path); }
  getSignalValue(storeName: string, path: string) { return this.read(storeName, path); }

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

  select<K extends keyof Stores & string, R>(storeName: K, selector: (state: Stores[K]) => R): R {
    return selector(this.getStore(storeName).returnStore() as Stores[K]);
  }
}

function warnOnFailure(label: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn(`SignalStore ${label} destroy error:`, e);
  }
}
