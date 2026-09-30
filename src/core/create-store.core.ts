import { BehaviorSubject, Observable, Subscription, combineLatest } from 'rxjs';
import { Signal, WritableSignal, computed } from '@angular/core';
import { PathUtils } from '../utils/path-utils';
import type { ProxyCallable } from '../interfaces/types';
import { SignalStore } from './signal-store.service';
import { ComputedService, type ArrayQueryPredicate } from './services/computed.manager';
import { BehaviorService } from './services/behavior.manager';
import { ProxyCacheManager, CacheMetrics } from './services/proxy-cache.manager';
import { PathReader } from '../utils/abstracts/path-reader';
import { VersionBumpScheduler } from '../utils/version-bump-scheduler';
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
import { VersionBumpCoordinator } from './services/version-bump-coordinator';
import { VersionBumpPolicy } from './services/version-bump-policy';
import { ReactivityWakeupService, NO_WAKE_OPTIONS, type WakeUpPathOptions } from './services/reactivity-wakeup.service';

export type StoreWakeupMode = 'leaf' | 'grained' | 'granular' | 'exact' | 'graied' | 'graned';

export class CreateStoreService<TState extends StoreData = StoreData> {
  private readonly dependencyTracker = new DependencyTracker();
  private usingComputedStoreFallback = false;

  startCollect(): void { this.dependencyTracker.startCollect(); }
  stopCollect(): Set<string> | null { return this.dependencyTracker.stopCollect(); }
  registerRead(path: string): void { this.dependencyTracker.registerRead(path); }
  registerReadNormalized(path: string): void { this.dependencyTracker.registerReadNormalized(path); }
  setTrackReads(enabled: boolean) { this.dependencyTracker.setTrackReads(enabled); }
  getTrackReads(): boolean { return this.dependencyTracker.getTrackReads(); }
  isCollectingReads(): boolean { return this.dependencyTracker.isCollecting(); }

  // Execute a projection within a read-tracking scope and return dependencies list
  private trackProjection<TOut>(project: () => TOut): { value: TOut; deps: string[] } {
    return this.dependencyTracker.trackProjection(project);
  }

  private readonly versionPolicy = new VersionBumpPolicy();

  setDependencyMode(mode: 'exact' | 'container') { this.versionPolicy.setDependencyMode(mode); }
  getDependencyMode(): 'exact' | 'container' { return this.versionPolicy.getDependencyMode(); }

  // Dev-only helper to warn when dependency selection is too broad in 'container' mode
  private warnOnWideDependencies(deps: string[]) {
    if (this.versionPolicy.getDependencyMode() !== 'container') return;
    // Heuristics: if many top-level deps or very short paths are tracked, warn in dev mode
    const shortDeps = deps.filter((d) => d.split('.').length <= 1);
    if (shortDeps.length > 0 && (globalThis as { ngDevMode?: boolean } | undefined)?.ngDevMode !== false) {
      console.warn('[SignalStore] Container dependency mode: very broad dependencies detected:', shortDeps.slice(0, 5));
    }
  }
  resolveVersionPath(path: string): string {
    return this.versionBumpCoordinator.resolvePath(path);
  }

  resolveVersionPathNormalized(normalized: string): string {
    return this.versionBumpCoordinator.resolveNormalizedPath(normalized);
  }

  private readonly pathReader = new PathReader();

  private bumpScheduler = new VersionBumpScheduler((items) => {
    for (const p of items) this.updateVersionIfExists(p);
  });

  private versionBumpCoordinator = new VersionBumpCoordinator(this.versionPolicy, this.bumpScheduler, {
    hasNodes: () => this._versionSvc?.hasNodes() ?? false,
    keys: () => this._versionSvc?.keys() ?? [],
    updateIfExists: (path) => this.updateVersionIfExists(path)
  });

  // Aliases (incl. legacy misspellings) share one handler per canonical mode.
  private readonly wakeupModeHandlers: Record<StoreWakeupMode, (normalized: string) => void> = (() => {
    const leaf = (normalized: string) => this.versionBumpCoordinator.bumpLeafBranchNormalized(normalized);
    const grained = (normalized: string) => this.versionBumpCoordinator.bumpExactNormalized(normalized);
    // Null prototype: an inherited key such as 'constructor' must not resolve to a handler.
    return Object.assign(Object.create(null), {
      leaf, grained, granular: grained, exact: grained, graied: grained, graned: grained
    });
  })();

  private reactivityWakeup = new ReactivityWakeupService({
    behaviorUpdatesEnabled: () => this.behaviorUpdatesEnabled,
    updateBehavior: (path, value) => this.updateBehaviorsBySegments(path, value),
    ensureBehavior: (path) => this.behaviorSvc.add(path),
    bumpVersionNormalized: (path) => this.bumpVersionsForNormalized(path),
    bumpDescendantVersionsNormalized: (pathPrefix) => this.bumpDescendantVersionsForNormalized(pathPrefix),
    clearProxyCache: (pathPrefix) => this.clearProxyCacheForPath(pathPrefix),
    updateBehaviorByPrefix: (pathPrefix, options) => this.updateBehaviorByPrefix(pathPrefix, options)
  });

  beginAction(): void { this.bumpScheduler.begin(); }
  endAction(): void { this.bumpScheduler.end(); }
  flushPendingBumps(): void { this.bumpScheduler.flushNow(); }
  setAutoBatchBumps(enabled: boolean): void { this.versionPolicy.setAutoBatchBumps(enabled); }
  getAutoBatchBumps(): boolean { return this.versionPolicy.getAutoBatchBumps(); }
  setBumpNumericParent(enabled: boolean): void { this.versionPolicy.setBumpNumericParent(enabled); }
  getBumpNumericParent(): boolean { return this.versionPolicy.getBumpNumericParent(); }
  setVersionBumpStrategy(strategy: 'microtask' | 'raf'): void { this.bumpScheduler.setStrategy(strategy); }
  setVersionBumpThrottle(ms: number): void { this.bumpScheduler.setThrottle(ms); }
  setPartialInvalidation(enabled: boolean): void { this.versionPolicy.setPartialInvalidation(enabled); }

  /** Delegated to PathReader (universal path traversal engine) */
  getPathSegments(path: string): readonly string[] {
    return this.pathReader.getSegments(path);
  }

  /** Delegated to PathReader */
  fastReadBySegments(root: unknown, pathSegments: readonly string[]): unknown {
    return this.pathReader.readBySegments(root as Record<string, unknown>, pathSegments);
  }

  // ------------------------------
  // Flat string-keyed stores - per instance (no storeName needed)
  // ------------------------------
  private _versionSvc?: VersionManager;
  private get versionSvc() {
    if (!this._versionSvc) this._versionSvc = new VersionManager(this, this.storeName);
    return this._versionSvc!;
  }
  private cloneComputedOutputs = true;
  private behaviorUpdatesEnabled = true;
  private _storeProxy?: object;
  // Lazy services for modular logic
  private _computedSvc?: ComputedService<TState>;
  private _behaviorSvc?: BehaviorService<TState>;
  private get computedSvc(): ComputedService<TState> {
    if (!this._computedSvc) this._computedSvc = new ComputedService<TState>(this, this.storeName);
    return this._computedSvc;
  }
  private get behaviorSvc(): BehaviorService<TState> {
    if (!this._behaviorSvc) this._behaviorSvc = new BehaviorService<TState>(this, this.storeName);
    return this._behaviorSvc;
  }
  // Public facade for behavior updates by segments
  updateBehaviorsBySegments(path: string, newValue?: unknown): void {
    if (!this.behaviorUpdatesEnabled) return;
    this._behaviorSvc?.updateBySegments(path, newValue);
  }

  wakeUpMutationPath(
    path: string,
    value: unknown,
    options: WakeUpPathOptions = NO_WAKE_OPTIONS,
    behaviorUpdater?: (path: string, value: unknown) => void
  ): boolean {
    return this.reactivityWakeup.wakeUpPath(path, value, options, behaviorUpdater);
  }

  wakeUpMutationPathNormalized(
    normalized: string,
    value: unknown,
    options: WakeUpPathOptions = NO_WAKE_OPTIONS,
    behaviorUpdater?: (path: string, value: unknown) => void
  ): boolean {
    return this.reactivityWakeup.wakeUpPathNormalized(normalized, value, options, behaviorUpdater);
  }

  wakeUpArrayMutation(
    path: string,
    value: unknown,
    afterVersion?: () => void,
    behaviorUpdater?: (path: string, value: unknown) => void
  ): void {
    this.reactivityWakeup.wakeUpArrayPath(path, value, afterVersion, behaviorUpdater);
  }

  wakeUpVersionPath(path: string, mode?: StoreWakeupMode): void {
    if (!mode) {
      this.reactivityWakeup.wakeUpVersionOnly(path);
      return;
    }
    this.wakeUpVersionPathWithMode(path, mode);
  }

  wakeUpVersionPathWithMode(path: string, mode: StoreWakeupMode): void {
    const normalized = PathUtils.normalizePath(path);
    const handler = this.wakeupModeHandlers[mode];
    if (!handler) throw new Error(`Unsupported wakeup mode: ${String(mode)}`);
    handler(normalized);
  }

  // Type-safe selection API: select(fn) and computedOf(fn)
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
    return new Observable<TOut>((subscriber) => {
      const proxy = this.getStoreProxy();
      let depSub: Subscription | null = null;
      let depKey = '';
      let hasValue = false;
      let lastValue!: TOut;
      let closed = false;
      let computing = false;
      let pending = false;

      const toDepPaths = (deps: string[]): string[] => {
        const tracked = deps.length === 0 && this.usingComputedStoreFallback
          ? Object.keys(this.getComputedStore())
          : deps;
        return Array.from(new Set(tracked.map((dep) => this.resolveVersionPathNormalized(dep)))).sort();
      };

      const resubscribe = (depPaths: string[]) => {
        const nextKey = depPaths.join('\0');
        if (nextKey === depKey) return;

        depSub?.unsubscribe();
        depSub = null;
        depKey = nextKey;

        if (depPaths.length === 0) return;

        let skipInitial = true;
        depSub = combineLatest(depPaths.map((depPath) => this.getTrackedObservable(depPath))).subscribe({
          next: () => {
            if (skipInitial) {
              skipInitial = false;
              return;
            }
            recompute();
          },
          error: (error) => {
            subscriber.error(error);
          }
        });
      };

      const recompute = () => {
        if (closed) return;
        if (computing) {
          pending = true;
          return;
        }

        computing = true;
        try {
          do {
            pending = false;
            const { value, deps } = this.trackProjection(() => project(proxy));
            this.warnOnWideDependencies(deps);

            if (!hasValue || !Object.is(value, lastValue)) {
              lastValue = value;
              hasValue = true;
              subscriber.next(value);
            }

            resubscribe(toDepPaths(deps));
          } while (pending && !closed);
        } catch (error) {
          closed = true;
          depSub?.unsubscribe();
          subscriber.error(error);
        } finally {
          computing = false;
        }
      };

      recompute();

      return () => {
        closed = true;
        depSub?.unsubscribe();
        depSub = null;
      };
    });
  }

  computedOf<TOut>(project: (s: TState) => TOut) {
    const proxy = this.getStoreProxy();
    return computed(() => {
      const { value, deps } = this.trackProjection(() => project(proxy));
      this.warnOnWideDependencies(deps);
      return value;
    });
  }

  // Observable method cache, stored as flat map
  private observableMethodCache: Record<string, (...args: unknown[]) => unknown> = Object.create(null);
  
  // Proxy cache orchestration
  private readonly proxyCacheManager: ProxyCacheManager;

  // Array-query Computed values są teraz buforowane w samym grafie computedStore

  constructor(
    private storeName: string,
    public readonly signalStore: SignalStore
  ) {
    this.proxyCacheManager = new ProxyCacheManager(this.storeName, this.signalStore);
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
    return this.hasIndexedPathFromKeys(this._behaviorSvc?.keys() ?? [], path, startIndex)
      || this.hasIndexedPathFromKeys(this._computedSvc?.keys() ?? [], path, startIndex)
      || this.hasIndexedPathFromKeys(this._versionSvc?.keys() ?? [], path, startIndex);
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

  // Control BehaviorSubject update propagation on writes
  setBehaviorUpdatesEnabled(enabled: boolean) { this.behaviorUpdatesEnabled = !!enabled; }

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
    const observable = this.behaviorSvc.getTrackedObservable(path);
    return pipeFn ? (pipeFn(observable) as Observable<T>) : (observable as Observable<T>);
  }

  getObservable(path: string): BehaviorSubject<unknown> {
    return this.behaviorSvc.get(path);
  }

  getTrackedObservable(path: string): Observable<unknown> {
    return this.behaviorSvc.getTrackedObservable(path);
  }

  // Refresh existing BehaviorSubjects under a prefix (incl. nested paths)
  updateBehaviorByPrefix(pathPrefix: string, options?: { skipSelf?: boolean }): void {
    if (!this.behaviorUpdatesEnabled) return;
    if (!pathPrefix || typeof pathPrefix !== 'string') return;
    this._behaviorSvc?.updateByPrefix(pathPrefix, options);
  }

  // ------------------
  // Helper methods for checking and managing stores
  // ------------------
  isBehaviorExists(path: string): boolean {
    return this._behaviorSvc?.isExists(path) ?? false;
  }

  isComputedExists(path: string): boolean {
    return this.computedSvc.isExists(path);
  }

  // Removed: getBehaviorKeys() - moved to DevService
  // Removed: getComputedKeys() - moved to DevService

  getBehaviorStore(): Record<string, BehaviorSubject<unknown>> {
    return this._behaviorSvc?.store() ?? {};
  }

  getComputedStore(): Record<string, Signal<unknown>> {
    return this.computedSvc.store();
  }

  cleanupBehaviorStore(pathPrefix?: string): void {
    this._behaviorSvc?.cleanup(pathPrefix);
  }

  cleanupComputedStore(pathPrefix?: string): void {
    this.computedSvc.cleanup(pathPrefix);
  }

  destroy(): void {
    this.stopCollect();
    this._behaviorSvc?.destroy();
    this._computedSvc?.cleanup();
    this._versionSvc?.cleanup();
    this.versionBumpCoordinator.destroy();
    this.proxyCacheManager.reset();
    this.observableMethodCache = Object.create(null);
    this._storeProxy = undefined;
    this.usingComputedStoreFallback = false;
  }

  // ------------------
  // Version operations
  // ------------------
  getVersion(path: string): WritableSignal<number> {
    const v = this.versionSvc.get(path);
    this.registerRead(PathUtils.normalizePath(path));
    return v;
  }

  bumpVersionsForNormalized(normalized: string): void {
    this.versionBumpCoordinator.bumpPathNormalized(normalized);
  }

  bumpDescendantVersionsForNormalized(normalizedPrefix: string): void {
    this.versionBumpCoordinator.bumpDescendantsNormalized(normalizedPrefix);
  }

  cleanupVersionStore(pathPrefix?: string): void {
    this._versionSvc?.cleanup(pathPrefix);
  }

  // Removed: getBehaviorSubscriptionStats() - moved to DevService

  // ------------------
  // Helper methods
  // ------------------
   // Update existing version node without creating new ones; emit DevTools 'update'
  private updateVersionIfExists(path: string): void { this._versionSvc?.updateIfExists(path); }

  private hasIndexedPathFromKeys(keys: string[], path: string, startIndex: number): boolean {
    if (!keys.length) return false;
    const normalized = PathUtils.normalizePath(path);
    const prefix = normalized ? `${normalized}.` : '';
    if (!prefix) return false;
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      const dotIndex = key.indexOf('.', prefix.length);
      const segment = dotIndex === -1 ? key.slice(prefix.length) : key.slice(prefix.length, dotIndex);
      const index = Number(segment);
      if (Number.isInteger(index) && index >= startIndex) return true;
    }
    return false;
  }
}
