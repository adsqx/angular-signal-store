/** v2 `SignalStore`: the registry of named stores, with the current service's public members. */
import { Inject, Injectable, InjectionToken, Optional } from '@angular/core';
import { Observable, type Subscription } from 'rxjs';
import { normalizeDotPath } from '@adsq/jsnq/data-engine';
import { CreateStore } from './create-store';
import { createNode } from './proxy';
import { segmentsOf } from './core';

export interface DevToolsEvent { type: string; payload?: Record<string, unknown>; storeName?: string }
export interface AngularStoreDevtools {
  readonly action$: Observable<DevToolsEvent | null>;
  readonly readAction$: Observable<DevToolsEvent | null>;
  emitAction(event: DevToolsEvent): void;
  emitRead(event: DevToolsEvent): void;
  getBehaviorKeys(store: Record<string, unknown>): string[];
  getComputedKeys(store: Record<string, unknown>): string[];
}
export const SIGNAL_STORE_DEVTOOLS = new InjectionToken<AngularStoreDevtools>('SIGNAL_STORE_DEVTOOLS');

export interface CreateStoreOptions {
  cloneInitialValue?: 'none' | 'structured';
  strict?: { invalidPath?: boolean; rootRxjs?: boolean; deleteUndefined?: boolean };
  [option: string]: unknown;
}
export interface WaitForStoreOptions { timeoutMs?: number; signal?: AbortSignal }

const EMPTY = new Observable<never>((s) => s.complete());

@Injectable({ providedIn: 'root' })
export class SignalStore {
  devActive = false;
  private instances: Record<string, CreateStore> = Object.create(null);
  private proxies: Record<string, unknown> = Object.create(null);
  private limits: Record<string, number> = Object.create(null);
  private waiters = new Map<string, Array<(proxy: unknown) => void>>();

  constructor(@Optional() @Inject(SIGNAL_STORE_DEVTOOLS) private devService: AngularStoreDevtools | null = null) {}

  get devAction$() { return this.devService?.action$ ?? EMPTY; }
  get devReadAction$() { return this.devService?.readAction$ ?? EMPTY; }
  attachDevtools(devtools: AngularStoreDevtools | null): void { this.devService = devtools; }
  getDevtoolsAdapter(): AngularStoreDevtools | undefined { return this.devService ?? undefined; }
  devActivation(active: boolean): void { this.devActive = active; }
  bindDevActivation(active$: Observable<boolean>): Subscription { return active$.subscribe((a) => this.devActivation(!!a)); }
  setMetricsThrottle(_ms: number): void {}
  emitProxyMetrics(): void {}

  emitDevAction(storeName: string, action: DevToolsEvent): void {
    if (!this.devActive) return;
    const event = { ...action, storeName };
    queueMicrotask(() => this.devService?.emitAction(event));
    this.devService?.emitRead(event);
  }

  emitDevReadAction(storeName: string, data: DevToolsEvent): void {
    this.devService?.emitRead({ ...data, storeName });
  }

  createStore<T extends object>(val: T, name: string, options?: CreateStoreOptions): any {
    if (!name || typeof name !== 'string') throw new Error(`Store name must be a non-empty string. Received: ${String(name)}`);
    if (this.instances[name] || this.proxies[name]) {
      throw new Error(`Store '${name}' already exists. Use useStore('${name}') instead of creating it again.`);
    }
    const instance = new CreateStore<T>(this, name);
    instance.core.root.set((options?.cloneInitialValue === 'none' ? val : structuredClone(val)) as Record<string, unknown>);
    instance.host.strictInvalidPath = !!options?.strict?.invalidPath;
    instance.host.strictDeleteUndefined = !!options?.strict?.deleteUndefined;
    const proxy = instance.proxy;
    this.instances[name] = instance as unknown as CreateStore;
    this.proxies[name] = proxy;
    for (const resolve of this.waiters.get(name) ?? []) resolve(proxy);
    this.waiters.delete(name);
    return proxy;
  }

  waitForStore(name: string, options: WaitForStoreOptions = {}): Promise<any> {
    if (this.proxies[name]) return Promise.resolve(this.proxies[name]);
    const aborted = () => Object.assign(new Error(`waitForStore('${name}') aborted.`), { name: 'AbortError' });
    if (options.signal?.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const list = this.waiters.get(name) ?? [];
      const settle = (proxy: unknown) => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); resolve(proxy); };
      const fail = (error: Error) => {
        const rest = (this.waiters.get(name) ?? []).filter((w) => w !== settle);
        if (rest.length) this.waiters.set(name, rest); else this.waiters.delete(name);
        clearTimeout(timer);
        reject(error);
      };
      const onAbort = () => fail(aborted());
      list.push(settle);
      this.waiters.set(name, list);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        const ms = Math.max(0, options.timeoutMs);
        timer = setTimeout(() => fail(new Error(`waitForStore('${name}') timed out after ${ms}ms.`)), ms);
      }
    });
  }

  getStore(name: string): CreateStore { return this.instances[name]!; }
  registerStoreInstance(name: string, instance: CreateStore): void { if (name && !this.instances[name]) this.instances[name] = instance; }

  destroyStore(name: string): void {
    const instance = this.instances[name];
    if (!instance && !this.proxies[name]) return;
    try { instance?.destroy(); } catch (e) { console.warn('SignalStore storeInstance destroy error:', e); }
    delete this.instances[name];
    delete this.proxies[name];
    delete this.limits[name];
  }

  removeStore(name: string): void { this.destroyStore(name); }

  useStore(name: string): any {
    const proxy = this.proxies[name];
    if (!proxy) throw new Error(`Store '${name}' not found. Make sure to create it first with createStore().`);
    return proxy;
  }

  createCallableProxy(nestedPath: string, storeInstance: unknown): unknown {
    return createNode((storeInstance as CreateStore).host, nestedPath);
  }

  /** Legacy write: no undefined-key removal. */
  setValue(storeName: string, path: string, val: object): void {
    const store = this.getStore(storeName);
    store.core.write(segmentsOf(path), val);
  }

  read(storeName: string, path: string): unknown { return this.getStore(storeName).core.read(normalizeDotPath(path)); }
  readStore(storeName: string, path: string): unknown { return this.read(storeName, path); }
  getSignalValue(storeName: string, path: string): unknown { return this.read(storeName, path); }
  setProxyCacheLimit(storeName: string, limit: number): void { if (storeName) this.limits[storeName] = Math.max(0, Math.floor(limit)); }
  getProxyCacheLimit(storeName: string): number | undefined { return this.limits[storeName]; }
  clearProxyCacheLimit(storeName: string): void { delete this.limits[storeName]; }
  select<R>(storeName: string, selector: (state: any) => R): R { return selector(this.getStore(storeName).returnStore()); }
}
