import { BehaviorSubject, Observable } from 'rxjs';
import { Signal, WritableSignal, computed } from '@angular/core';
import { PathUtils } from '../utils/path-utils';
import type { ProxyCallable } from '../interfaces/types';
import { SignalStore } from './signal-store.service';
import { ComputedService, type ArrayQueryPredicate } from './services/computed.manager';
import { BehaviorService } from './services/behavior.manager';
import { ProxyCacheManager, CacheMetrics } from './services/proxy-cache.manager';
import { ManagerCtx } from './services/manager-ctx';
import {
  StoreData,
  ValidPath,
  PathValue,
  ArrayElement,
  ArrayOperationResult,
  ArrayQueryMethod,
  PredicateFn,
  MapFn,
  ReduceFn
} from '../types/advanced-types';
import { VersionManager } from './services/version.manager';
import { DependencyTracker } from './services/dependency-tracker';
import { WakeEngine } from './wake/wake-engine';
import type { StoreWakeupMode, WakeUpPathOptions } from './wake/wake-types';
import { selectObservable, warnOnWideDependencies } from './store-select';
import { readBySegments, segmentsOf } from '../utils/abstracts/path-reader';

export type { StoreWakeupMode } from './wake/wake-types';

export class CreateStoreService<TState extends StoreData = StoreData> {
  private readonly dependencyTracker = new DependencyTracker();
  private usingComputedStoreFallback = false;
  private readonly ctx: ManagerCtx;
  private readonly versions: VersionManager;
  private readonly behaviors: BehaviorService;
  private readonly wake: WakeEngine;
  private _computedSvc?: ComputedService<TState>;
  private cloneComputedOutputs = true;
  private _storeProxy?: object;

  startCollect(): void { this.dependencyTracker.startCollect(); }
  stopCollect(): Set<string> | null { return this.dependencyTracker.stopCollect(); }
  registerRead(path: string): void { this.dependencyTracker.registerRead(path); }
  registerReadNormalized(path: string): void { this.dependencyTracker.registerReadNormalized(path); }
  setTrackReads(enabled: boolean) { this.dependencyTracker.setTrackReads(enabled); }
  getTrackReads(): boolean { return this.dependencyTracker.getTrackReads(); }
  isCollectingReads(): boolean { return this.dependencyTracker.isCollecting(); }

  // ------------------
  // Wake configuration (plain options read by the wake engine on every write)
  // ------------------
  setDependencyMode(mode: 'exact' | 'container') { this.wake.config.dependencyMode = mode; }
  getDependencyMode(): 'exact' | 'container' { return this.wake.config.dependencyMode; }
  setAutoBatchBumps(enabled: boolean): void { this.wake.config.autoBatch = !!enabled; }
  getAutoBatchBumps(): boolean { return this.wake.config.autoBatch; }
  setBumpNumericParent(enabled: boolean): void { this.wake.config.bumpNumericParent = !!enabled; }
  getBumpNumericParent(): boolean { return this.wake.config.bumpNumericParent; }
  setPartialInvalidation(enabled: boolean): void { this.wake.config.partial = !!enabled; }
  setVersionBumpStrategy(strategy: 'microtask' | 'raf'): void { this.wake.scheduler.setStrategy(strategy); }
  setVersionBumpThrottle(ms: number): void { this.wake.scheduler.setThrottle(ms); }
  // Control BehaviorSubject update propagation on writes
  setBehaviorUpdatesEnabled(enabled: boolean) { this.wake.config.behaviors = !!enabled; }

  beginAction(): void { this.wake.scheduler.begin(); }
  endAction(): void { this.wake.scheduler.end(); }
  flushPendingBumps(): void { this.wake.scheduler.flushNow(); }

  resolveVersionPath(path: string): string {
    return this.wake.resolve(PathUtils.normalizePath(path));
  }

  resolveVersionPathNormalized(normalized: string): string {
    return this.wake.resolve(normalized);
  }

  /** Delegated to the shared path reader */
  getPathSegments(path: string): readonly string[] {
    return segmentsOf(path);
  }

  /** Delegated to the shared path reader */
  fastReadBySegments(root: unknown, pathSegments: readonly string[]): unknown {
    return readBySegments(root as Record<string, unknown>, pathSegments);
  }

  private get computedSvc(): ComputedService<TState> {
    return (this._computedSvc ??= new ComputedService<TState>(this, this.ctx));
  }

  // ------------------
  // Wake operations (delegated to the wake engine)
  // ------------------
  updateBehaviorsBySegments(path: string, newValue?: unknown): void {
    this.wake.updateBehaviors(path, newValue);
  }

  wakeUpMutationPath(
    path: string,
    value: unknown,
    options?: WakeUpPathOptions,
    behaviorUpdater?: (path: string, value: unknown) => void
  ): boolean {
    return this.wake.wakePath(PathUtils.normalizePath(path), value, options, behaviorUpdater);
  }

  wakeUpMutationPathNormalized(
    normalized: string,
    value: unknown,
    options?: WakeUpPathOptions,
    behaviorUpdater?: (path: string, value: unknown) => void
  ): boolean {
    return this.wake.wakePath(normalized, value, options, behaviorUpdater);
  }

  wakeUpArrayMutation(
    path: string,
    value: unknown,
    afterVersion?: () => void,
    behaviorUpdater?: (path: string, value: unknown) => void
  ): void {
    this.wake.wakeArray(PathUtils.normalizePath(path), value, afterVersion, behaviorUpdater);
  }

  wakeUpVersionPath(path: string, mode?: StoreWakeupMode): void {
    if (mode) this.wakeUpVersionPathWithMode(path, mode);
    else this.wake.bump(PathUtils.normalizePath(path));
  }

  wakeUpVersionPathWithMode(path: string, mode: StoreWakeupMode): void {
    this.wake.bumpByMode(mode, PathUtils.normalizePath(path));
  }

  // ------------------
  // Type-safe selection API: select(fn) and computedOf(fn)
  // ------------------
  private getStoreProxy(): TState {
    try {
      this._storeProxy ??= this.signalStore.useStore(this.storeName);
      this.usingComputedStoreFallback = false;
      return this._storeProxy as TState;
    } catch {
      // Fallback for standalone CreateStore instances (no proxy registered)
      this.usingComputedStoreFallback = true;
      return this.getComputedStore() as unknown as TState;
    }
  }

  select<TOut>(project: (s: TState) => TOut): Observable<TOut> {
    return selectObservable<TState, TOut>(
      {
        proxy: () => this.getStoreProxy(),
        usingFallback: () => this.usingComputedStoreFallback,
        computedKeys: () => Object.keys(this.getComputedStore()),
        trackProjection: (fn) => this.dependencyTracker.trackProjection(fn),
        resolveVersionPath: (dep) => this.wake.resolve(dep),
        observe: (versionPath) => this.getTrackedObservable(versionPath),
        dependencyMode: () => this.wake.config.dependencyMode
      },
      project
    );
  }

  computedOf<TOut>(project: (s: TState) => TOut) {
    const proxy = this.getStoreProxy();
    return computed(() => {
      const { value, deps } = this.dependencyTracker.trackProjection(() => project(proxy));
      warnOnWideDependencies(this.wake.config.dependencyMode, deps);
      return value;
    });
  }

  // Observable method cache, stored as flat map
  private observableMethodCache: Record<string, (...args: unknown[]) => unknown> = Object.create(null);

  // Proxy cache orchestration
  private readonly proxyCacheManager: ProxyCacheManager;

  constructor(
    private storeName: string,
    public readonly signalStore: SignalStore
  ) {
    this.proxyCacheManager = new ProxyCacheManager(this.storeName, this.signalStore);
    this.ctx = new ManagerCtx(storeName, signalStore);
    this.versions = new VersionManager(this.ctx);
    this.behaviors = new BehaviorService(this.ctx);
    this.wake = new WakeEngine(this.versions, this.behaviors, this.proxyCacheManager);
  }

  // ------------------
  // Proxy cache operations (delegated to manager)
  // ------------------
  hasIndexedProxyCacheFrom(path: string, startIndex: number): boolean {
    return this.proxyCacheManager.hasIndexedChildAtOrAfter(path, startIndex);
  }

  deleteIndexedProxyCacheRange(path: string, startIndex: number, endIndex: number): void {
    this.proxyCacheManager.deleteIndexedRange(path, startIndex, endIndex);
  }

  hasIndexedDerivedNodeFrom(path: string, startIndex: number): boolean {
    const hasIndexed = (keys: string[]) => keys.length > 0 && hasIndexedKeyFrom(keys, PathUtils.normalizePath(path), startIndex);
    return hasIndexed(this.behaviors.keys())
      || hasIndexed(this._computedSvc?.keys() ?? [])
      || hasIndexed(this.versions.keys());
  }

  getProxyCacheMetrics(): CacheMetrics & { cacheSize: number; cacheKeys: string[] } {
    return this.proxyCacheManager.metricsSnapshot();
  }

  resetProxyCache(): void {
    this.proxyCacheManager.reset();
  }

  recordProxyCacheHit(): void {
    this.proxyCacheManager.markHit();
  }

  recordProxyCacheMiss(): void {
    this.proxyCacheManager.markMiss();
  }

  getProxyCacheEntry(path: string): ProxyCallable | undefined {
    return this.proxyCacheManager.peek(path);
  }

  setProxyCacheEntry(proxy: ProxyCallable, path: string): void {
    this.proxyCacheManager.add(path, proxy);
  }

  clearProxyCacheForPath(path: string): void {
    this.proxyCacheManager.delete(path);
  }

  getProxyCacheDump(): Array<{ key: string; value: string }> {
    return this.proxyCacheManager.dump();
  }

  getSignalFromProxyCache(path: string): Signal<unknown> | undefined {
    return this.proxyCacheManager.getSignal(path);
  }

  setSignalInProxyCache(path: string, signalRef: Signal<unknown>): void {
    this.proxyCacheManager.setSignal(path, signalRef);
  }

  emitProxyMetrics(metrics: { hits: number; misses: number; hitRate: number; cacheSize: number }) {
    this.proxyCacheManager.emitMetrics(metrics);
  }
  setCloneComputedOutputs(enabled: boolean) { this.cloneComputedOutputs = !!enabled; }
  getCloneComputedOutputs(): boolean { return this.cloneComputedOutputs; }

  // ------------------
  // Observable cache helpers
  // ------------------
  getCachedObservableMethod(
    path: string,
    method: string,
    observable: object
  ): (...args: unknown[]) => unknown {
    const normalized = PathUtils.normalizePath(path);
    const key = `${normalized}.${method}`;
    if (!this.observableMethodCache[key]) {
      const obsMethod = (observable as Record<string, (...args: unknown[]) => unknown>)[method];
      this.observableMethodCache[key] = obsMethod.bind(observable);
    }
    return this.observableMethodCache[key];
  }

  // ------------------
  // Computed operations
  // ------------------
  
  // Typed wrapper delegating to ComputedService for array query methods
  createArrayQueryComputed<
    P extends ValidPath<TState> & string,
    M extends ArrayQueryMethod | 'length',
    A = PathValue<TState, P>,
    E = ArrayElement<A>,
    R = M extends 'length'
      ? number
      : ArrayOperationResult<E, Extract<M, ArrayQueryMethod>>['result']
  >(
    path: P,
    method: M,
    predicate: M extends 'includes' | 'indexOf'
      ? E
      : M extends 'find' | 'findIndex' | 'filter' | 'some' | 'every'
        ? PredicateFn<E>
        : M extends 'map'
          ? MapFn<E, unknown>
          : M extends 'reduce'
            ? ReduceFn<E, unknown>
            : undefined,
    ...args: unknown[]
  ): Signal<R> | undefined {
    return this.computedSvc.createArrayQueryComputed(path, method, predicate as ArrayQueryPredicate<E, M>, ...args) as Signal<R> | undefined;
  }

  registerPipelineComputed(path: string, signalRef: Signal<unknown>): void {
    this.computedSvc.registerPipelineComputed(path, signalRef);
  }

  addToComputeStore(path: string): void {
    this.computedSvc.add(path as ValidPath<TState> & string);
  }

  deleteFromComputeStore(path: string): void {
    this.computedSvc.remove(path);
  }

  getComputed(path: string): Signal<unknown> | undefined {
    return this.computedSvc.get(path as ValidPath<TState> & string);
  }

  // ------------------
  // Behavior operations
  // ------------------
  // Pobierz observable z pipe i automatycznie śledź subskrypcje
  getObservableWithPipe<T = unknown>(
    path: string,
    pipeFn?: (obs: Observable<unknown>) => Observable<T>
  ): Observable<T> {
    const observable = this.behaviors.getTrackedObservable(path);
    return pipeFn ? (pipeFn(observable) as Observable<T>) : (observable as Observable<T>);
  }

  getObservable(path: string): BehaviorSubject<unknown> {
    return this.behaviors.get(path);
  }

  getTrackedObservable(path: string): Observable<unknown> {
    return this.behaviors.getTrackedObservable(path);
  }

  // Refresh existing BehaviorSubjects under a prefix (incl. nested paths)
  updateBehaviorByPrefix(pathPrefix: string, options?: { skipSelf?: boolean }): void {
    this.wake.updateBehaviorsByPrefix(pathPrefix, !!options?.skipSelf);
  }

  // ------------------
  // Helper methods for checking and managing stores
  // ------------------
  isBehaviorExists(path: string): boolean {
    return this.behaviors.isExists(path);
  }

  isComputedExists(path: string): boolean {
    return this.computedSvc.isExists(path);
  }

  // Removed: getBehaviorKeys() - moved to DevService
  // Removed: getComputedKeys() - moved to DevService

  getBehaviorStore(): Record<string, BehaviorSubject<unknown>> {
    return this.behaviors.store();
  }

  getComputedStore(): Record<string, Signal<unknown>> {
    return this.computedSvc.store();
  }

  cleanupBehaviorStore(pathPrefix?: string): void {
    this.behaviors.cleanup(pathPrefix);
  }

  cleanupComputedStore(pathPrefix?: string): void {
    this.computedSvc.cleanup(pathPrefix);
  }

  destroy(): void {
    this.stopCollect();
    this.behaviors.destroy();
    this._computedSvc?.cleanup();
    this.versions.cleanup();
    this.wake.destroy();
    this.proxyCacheManager.reset();
    this.observableMethodCache = Object.create(null);
    this._storeProxy = undefined;
    this.usingComputedStoreFallback = false;
  }

  // ------------------
  // Version operations
  // ------------------
  getVersion(path: string): WritableSignal<number> {
    const normalized = PathUtils.normalizePath(path);
    const version = this.versions.get(normalized);
    this.dependencyTracker.registerReadNormalized(normalized);
    return version;
  }

  bumpVersionsForNormalized(normalized: string): void {
    this.wake.bump(normalized);
  }

  bumpDescendantVersionsForNormalized(normalizedPrefix: string): void {
    this.wake.bumpDescendants(normalizedPrefix);
  }

  cleanupVersionStore(pathPrefix?: string): void {
    this.versions.cleanup(pathPrefix);
  }
}

/** True when some key under `normalized` continues with an integer segment >= `startIndex`. */
function hasIndexedKeyFrom(keys: string[], normalized: string, startIndex: number): boolean {
  if (!normalized) return false;
  const prefix = `${normalized}.`;
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const dotIndex = key.indexOf('.', prefix.length);
    const segment = dotIndex === -1 ? key.slice(prefix.length) : key.slice(prefix.length, dotIndex);
    const index = Number(segment);
    if (Number.isInteger(index) && index >= startIndex) return true;
  }
  return false;
}
