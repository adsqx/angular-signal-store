import { TypedArrayOperations, ArrayChain } from '../operations/typed-array-operations.class';
import { PathUtils } from '../utils/path-utils';
import type { SignalStore } from './signal-store.service';
import { CreateStoreService } from './create-store.core';
import type { WakeUpPathOptions } from './wake/wake-types';
import type { AngularStoreDevtools } from './devtools-contract';
import { StoreDevtools } from './store-devtools';
import { StoreMutator } from './mutation';
import type { CreateStore } from './create-store.class';
import { StoreData, ValidPath, SignalType, BehaviorSubjectType } from '../types/advanced-types';
import { StoreErrorFactory } from '../types/errors';
import type { ProxyFactory } from '../proxy/proxy-factory.class';

/** How `getComputed` / `getBehaviorSubject` create-on-read and announce a newly created node. */
export interface ReactiveKind {
  readonly context: string;
  exists(service: CreateStoreService, path: string): boolean;
  read(service: CreateStoreService, path: string): unknown;
  announceAdd(devtools: StoreDevtools, path: string): void;
}

export const COMPUTED_KIND: ReactiveKind = {
  context: 'computed signal',
  exists: (service, path) => service.isComputedExists(path),
  read: (service, path) => service.getComputed(path),
  announceAdd: (devtools, path) => devtools.computed('add', path)
};

export const BEHAVIOR_KIND: ReactiveKind = {
  context: 'BehaviorSubject',
  exists: (service, path) => service.isBehaviorExists(path),
  read: (service, path) => service.getObservable(path),
  announceAdd: (devtools, path) => devtools.behavior(path, 'add', undefined, true)
};

/**
 * The path-agnostic half of `CreateStore`: state, wiring (service, devtools, mutation pipeline),
 * writes by normalized path, wake, batching, configuration, lifecycle. The path-typed overload
 * families live on the `CreateStore` facade that extends it.
 */
export class CreateStoreBase<T extends StoreData = StoreData> {
  store: T = {} as T;

  get computedStore(): Record<string, SignalType<unknown>> {
    return this.createService.getComputedStore();
  }

  get behaviorStore(): Record<string, BehaviorSubjectType<unknown>> {
    return this.createService.getBehaviorStore();
  }

  // Single getter for createService (used by proxy handler, TypedArrayOperations, and external consumers)
  get createServiceGetter(): CreateStoreService {
    return this.createService;
  }

  // Alias for backward compatibility (deprecated: use createServiceGetter)
  get getCreateService(): CreateStoreService {
    return this.createServiceGetter;
  }

  protected readonly createService: CreateStoreService<T>;
  protected readonly devtools: StoreDevtools;
  private readonly mutator: StoreMutator;
  private readonly arrayOpsCache: Record<string, TypedArrayOperations<T, ValidPath<T> & string>> = Object.create(null);
  /** Bound once: wake calls hand it to the engine instead of allocating a closure per write. */
  private readonly behaviorUpdater = (path: string, value: unknown): void => this.updateBehaviorsBySegments(path, value);

  constructor(
    protected readonly signalStore: SignalStore,
    protected readonly storeName: string,
    _proxyFactory?: ProxyFactory,
    devService?: AngularStoreDevtools
  ) {
    this.createService = new CreateStoreService<T>(storeName, signalStore);
    this.devtools = new StoreDevtools(signalStore, storeName, devService, this.createService);
    const self = this;
    this.mutator = new StoreMutator(
      {
        get store() { return self.store; },
        batch: (fn) => this.batch(fn),
        readStore: (path) => signalStore.read(storeName, path),
        wakeUpMutationPath: (path, value, options) => this.wakeUpMutationPath(path, value, options)
      },
      this.createService,
      this.devtools
    );

    if (!storeName || typeof storeName !== 'string') {
      throw StoreErrorFactory.pathValidation(storeName, 'Store name must be a non-empty string');
    }
    // Default: sync version bumps for JSON-like read-after-write behavior
    this.createService.setAutoBatchBumps(false);

    // Self-register so getStore(storeName) resolves instances built directly via
    // `new CreateStore(...)` (e.g. tests / advanced usage), not only via the createStore
    // factory. The factory re-registers the same instance afterwards — idempotent.
    this.signalStore.registerStoreInstance(storeName, this as unknown as CreateStore<StoreData>);
  }

  returnStore(): T {
    return this.store;
  }

  // ------------------
  // Array operations
  // ------------------
  // Per-path array operations, cached by normalized path (used by the array members and array()).
  protected arrayOps<P extends ValidPath<T> & string>(path: P): TypedArrayOperations<T, P> {
    const normalizedPath = PathUtils.normalizePath(path);
    const cached = this.arrayOpsCache[normalizedPath];
    if (cached) return cached as TypedArrayOperations<T, P>;
    const ops = new TypedArrayOperations<T, P>(this.signalStore, this.storeName, normalizedPath as P);
    this.arrayOpsCache[normalizedPath] = ops as TypedArrayOperations<T, ValidPath<T> & string>;
    return ops;
  }

  // Fluent API entrypoint: chainable array operations
  array<P extends ValidPath<T> & string>(path: P): ArrayChain<T, P> {
    return new ArrayChain<T, P>(this.arrayOps(path));
  }

  // ------------------
  // Writes
  // ------------------
  protected validPath(path: string, context: string): string {
    if (!PathUtils.isValidPath(path)) {
      throw StoreErrorFactory.pathValidation(path, `Invalid path format for ${context}`);
    }
    return PathUtils.normalizePath(path);
  }

  /** Write at a validated path, removing the key on undefined (shared by setValue and setValueObserve). */
  protected writeObserve(normalizedPath: string, value: unknown): void {
    this.mutator.write(normalizedPath, value, true);
  }

  // Fast setter used by proxy: assumes path is normalized ('a.b.c'), skips validation/normalize
  setValueFast(path: string, value: unknown): void {
    this.mutator.write(path, value, false);
  }

  // Opt-in fine-grained mutate wake (default false = historical behaviour). Mirrors
  // SolidStoreOptions.preciseMutationWake so both engines behave identically.
  preciseMutationWake = false;

  setPreciseMutationWake(enabled: boolean): void {
    this.preciseMutationWake = enabled;
  }

  // Wakes only the changed leaves + the branch itself (no syncDescendants); see StoreMutator.commitPrecise.
  commitMutationPrecise(branch: string, value: unknown, relPaths: readonly string[]): void {
    this.mutator.commitPrecise(branch, value, relPaths);
  }

  // ------------------
  // Reactive accessors
  // ------------------
  /** Read (creating on first use) the node of `kind`, announcing it to devtools when it was created. */
  protected reactive(kind: ReactiveKind, path: string): unknown {
    const normalized = this.validPath(path, kind.context);
    const service = this.createService;
    const existed = kind.exists(service, normalized);
    const value = kind.read(service, normalized);
    if (!existed && kind.exists(service, normalized)) kind.announceAdd(this.devtools, normalized);
    return value;
  }

  addToComputeStore(path: string): void {
    this.createService.addToComputeStore(path);
    this.devtools.computed('add', path);
  }

  deleteFromComputeStore(path: string): void {
    this.createService.deleteFromComputeStore(path);
    this.devtools.computed('remove', path);
  }

  select<TOut>(project: (s: T) => TOut) {
    return this.createService.select(project);
  }

  computedOf<TOut>(project: (s: T) => TOut) {
    return this.createService.computedOf(project);
  }

  // ------------------
  // Wake
  // ------------------
  updateBehaviorsBySegments(path: string, newValue?: unknown): void {
    this.createService.updateBehaviorsBySegments(path, newValue);
    const normalized = PathUtils.normalizePath(path);
    if (this.devtools.active && this.createService.isBehaviorExists(normalized)) {
      this.devtools.behavior(normalized, 'update', this.signalStore.read(this.storeName, normalized), true);
    }
  }

  wakeUpArrayMutation(path: string, value: unknown, afterVersion?: () => void): void {
    this.createService.wakeUpArrayMutation(path, value, afterVersion, this.behaviorUpdater);
  }

  wakeUpMutationPath(path: string, value: unknown, options?: WakeUpPathOptions): boolean {
    return this.createService.wakeUpMutationPath(path, value, options, this.behaviorUpdater);
  }

  wakeUpVersionPath(path: string): void {
    this.createService.wakeUpVersionPath(path);
  }

  batch<R>(fn: () => R): R {
    const service = this.createService;
    const previousAutoBatch = service.getAutoBatchBumps();
    service.setAutoBatchBumps(true);
    service.beginAction();
    try {
      return fn();
    } finally {
      service.endAction();
      service.flushPendingBumps();
      service.setAutoBatchBumps(previousAutoBatch);
    }
  }

  // ------------------
  // Configuration and lifecycle
  // ------------------
  setDependencyMode(mode: 'exact' | 'container') { this.createService.setDependencyMode(mode); }
  setTrackReads(enabled: boolean) { this.createService.setTrackReads(enabled); }
  setCloneComputedOutputs(enabled: boolean) { this.createService.setCloneComputedOutputs(enabled); }
  setBehaviorUpdatesEnabled(enabled: boolean) { this.createService.setBehaviorUpdatesEnabled(enabled); }

  // Prefetch cursor during proxy navigation to narrow subsequent sets
  prefetchCursorWithNode(path: string, node: Record<string, unknown> | null) {
    this.mutator.prefetch(path, node);
  }

  cleanupPath(path: string): void {
    const normalizedPath = PathUtils.normalizePath(path);
    if (normalizedPath) this.mutator.cleanupPath(normalizedPath);
  }

  destroy(): void {
    this.createService.destroy();
    this.mutator.destroy();
    for (const path of Object.keys(this.arrayOpsCache)) delete this.arrayOpsCache[path];
  }

  enableDevTools(_storeName: string, showVisualizer = true): void {
    // Visualizer handled globally; nothing to do here besides mounting the panel element
    if (showVisualizer && typeof document !== 'undefined' && !document.querySelector('app-dev-tools')) {
      document.body.appendChild(document.createElement('app-dev-tools'));
    }
  }
}
