import type { StoreProxy } from '../interfaces/types';
import type { IStoreInstance } from '../interfaces/store-instance.interface';
import { ProxyFactory } from '../proxy/proxy-factory.class';
import type { StoreData } from '../types/advanced-types';
import { CreateStore } from './create-store.class';
import type { AngularStoreDevtools } from './devtools-contract';
import type { SignalStore } from './signal-store.service';

/** Options of `SignalStore.createStore`. */
export type CreateStoreOptions = {
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
};

export interface BuiltStore<T extends object> {
  instance: CreateStore<T>;
  proxy: StoreProxy<T>;
  factory: ProxyFactory;
}

/** Build the low-level instance, seed it with `val`, and wrap it in its proxy. Registration is the caller's job. */
export function buildStore<T extends object>(
  host: SignalStore,
  val: T,
  name: string,
  options: CreateStoreOptions | undefined,
  devtools: AngularStoreDevtools | undefined
): BuiltStore<T> {
  // 1. Low-level store instance responsible for all logic
  const instance = new CreateStore<T>(host, name, undefined, devtools);
  const service = instance.createServiceGetter;

  if (options?.dependencyMode) service.setDependencyMode(options.dependencyMode);
  const bump = options?.versionBump;
  if (bump) {
    if (bump.strategy) service.setVersionBumpStrategy(bump.strategy);
    if (typeof bump.throttleMs === 'number') service.setVersionBumpThrottle(bump.throttleMs);
    if (typeof bump.partialInvalidation === 'boolean') service.setPartialInvalidation(bump.partialInvalidation);
  }

  // 2. Initial value goes in **before** the proxy is built
  Object.assign(instance.returnStore(), options?.cloneInitialValue === 'none' ? val : structuredClone(val));

  // 3. Proxy exposing the reactive API to consumers
  const factory = new ProxyFactory({
    metricsCallback: (_storeName, metrics) => service.emitProxyMetrics(metrics),
    maxCacheSize: options?.proxyCacheMaxSize,
    storeName: name,
    signalStore: host,
    createStoreService: service,
    useInPlaceIteration: !!options?.useInPlaceIteration,
    strictInvalidPath: !!options?.strict?.invalidPath,
    strictRootRxjs: !!options?.strict?.rootRxjs,
    strictDeleteUndefined: !!options?.strict?.deleteUndefined,
    rxjsAllowedOnRoot: options?.rxjsAllowedOnRoot ?? true
  });
  if (typeof options?.metricsThrottleMs === 'number') host.setMetricsThrottle(options.metricsThrottleMs);
  const proxy = factory.createStoreProxy<T>(instance as unknown as IStoreInstance<T>);
  return { instance, proxy, factory };
}
