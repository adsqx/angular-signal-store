import { Signal } from '@angular/core';
import { TypedArrayOperations, ArrayChain } from '../operations/typed-array-operations.class';

import { PathUtils } from '../utils/path-utils';
import { CursorManager } from './services/cursor.manager';
import { SignalStore } from './signal-store.service';
import { CreateStoreService, type StoreWakeupMode } from './create-store.core';
import type { WakeUpPathOptions } from './services/reactivity-wakeup.service';
import type { AngularStoreDevtools } from './devtools-contract';
import {
  StoreData,
  PathValue,
  ValidPath,
  PathKeys,
  ArrayMutationMethod,
  ArrayQueryMethod,
  PredicateFn,
  MapFn,
  ReduceFn,
  SignalType,
  BehaviorSubjectType,
  ObservableType,
  SpliceOperation
} from '../types/advanced-types';
import { StoreErrorFactory } from '../types/errors';
import { isValidPath } from '../types/type-guards';
import { StoreDevToolsAction } from '../devtools/types';
import type { ProxyFactory } from '../proxy/proxy-factory.class';

export class CreateStore<T extends StoreData = StoreData> {
  store: T = {} as T;
  
  // Gettery do service dla interfejsu
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

  private readonly arrayOpsCache: Record<string, TypedArrayOperations<T, ValidPath<T> & string>> = Object.create(null);
  
  // Per-call factory for array operations bound to a specific path
  private arrayOps<P extends ValidPath<T> & string>(path: P): TypedArrayOperations<T, P> {
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

  private readonly devService?: AngularStoreDevtools;
  private readonly createService: CreateStoreService<T>;
  private _cursor?: CursorManager;
  private get cursor(): CursorManager { return this._cursor ??= new CursorManager(); }


  private emitStoreUpdate(
    type: StoreDevToolsAction['type'],
    payload: Record<string, unknown>
  ): void {
    this.emitDevAction({
      type,
      payload: {
        storeName: this.storeName,
        ...payload,
        graph: undefined
      }
    } as StoreDevToolsAction);
  }

  private snapshotForDevtools(value: unknown): unknown {
    if (value === undefined || value === null) return value;
    try {
      return structuredClone(value);
    } catch {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return value;
      }
    }
  }

  private emitDevtoolsEvent(normalizedPath: string, value: unknown, oldValue: unknown): void {
    this.emitStoreUpdate('SET_VALUE_OBSERVE', {
      path: normalizedPath,
      value: this.snapshotForDevtools(value),
      oldValue: this.snapshotForDevtools(oldValue)
    });
  }

  private computedKeys(): string[] {
    return this.devService ? this.devService.getComputedKeys(this.createService.getComputedStore()) : Object.keys(this.computedStore);
  }

  private behaviorKeys(): string[] {
    return this.devService ? this.devService.getBehaviorKeys(this.createService.getBehaviorStore()) : [];
  }

  private emitComputedEvent(action: 'add' | 'remove', path: string): void {
    this.emitStoreUpdate('COMPUTED_STORE_UPDATE', {
      action,
      path,
      keys: this.computedKeys(),
      snapshot: this.getComputedSnapshot()
    });
  }

  private emitBehaviorEvent(
    path: string,
    action: 'add' | 'update' | 'remove',
    value?: unknown,
    currentState?: Record<string, BehaviorSubjectType<unknown>>
  ): void {
    this.emitStoreUpdate('BEHAVIOR_STORE_UPDATE', {
      action,
      path,
      keys: this.behaviorKeys(),
      value,
      currentState
    });
  }

  private withValidatedPath<R>(path: string, context: string, action: (normalizedPath: string) => R): R {
    return action(this.validateAndGet(path, context));
  }

  private withReactiveAccessor<R>(
    path: string,
    context: string,
    exists: (normalizedPath: string) => boolean,
    read: (normalizedPath: string) => R,
    emitAdd: (normalizedPath: string) => void
  ): R {
    return this.withValidatedPath(path, context, (normalizedPath) => {
      const existed = exists(normalizedPath);
      const value = read(normalizedPath);
      if (!existed && exists(normalizedPath)) {
        emitAdd(normalizedPath);
      }
      return value;
    });
  }

  private cleanupDerivedPath(normalizedPath: string): void {
    this.createService.cleanupBehaviorStore(normalizedPath);
    this.createService.cleanupComputedStore(normalizedPath);
    this.createService.cleanupVersionStore(normalizedPath);
    this.createService.clearProxyCacheForPath(normalizedPath);
    this.cursor.invalidateCache(normalizedPath);
    this.cursor.invalidateForDeletion(normalizedPath);
  }

  private queueDerivedCleanup(normalizedPath: string): void {
    queueMicrotask(() => this.cleanupDerivedPath(normalizedPath));
  }

  private emitBehaviorUpdateIfTracked(
    normalizedPath: string,
    behaviorsEnabled: boolean,
    emitBehaviorUpdate: boolean,
    behaviorValue?: unknown,
    behaviorState?: Record<string, BehaviorSubjectType<unknown>>
  ): void {
    if (behaviorsEnabled && emitBehaviorUpdate && this.createService.isBehaviorExists(normalizedPath)) {
      this.emitBehaviorEvent(normalizedPath, 'update', behaviorValue, behaviorState);
    }
  }

  private isBranchValue(value: unknown): boolean {
    return PathUtils.isBranchValue(value);
  }

  private mutateStoreNormalized(
    normalizedPath: string,
    value: unknown,
    options: {
      ensureBehavior?: boolean;
      emitBehaviorUpdate?: boolean;
      cleanupOnUndefined?: boolean;
      emitDevtools?: boolean;
      behaviorValue?: unknown;
      behaviorState?: Record<string, BehaviorSubjectType<unknown>>;
    } = {}
  ): void {
    const {
      ensureBehavior = false,
      emitBehaviorUpdate = false,
      cleanupOnUndefined = false,
      emitDevtools = false,
      behaviorValue,
      behaviorState
    } = options;

    let previousValue: unknown;
    let shouldDeleteNode = false;

    const plan = this.cursor.applyPathPlan(normalizedPath);
    previousValue = this.cursor.mutateNode(this.store as unknown as Record<string, unknown>, plan, normalizedPath, value);
    shouldDeleteNode = cleanupOnUndefined && value === undefined;
    if (shouldDeleteNode) {
      this.deletePathFromStore(normalizedPath);
    }

    const behaviorsEnabled = this.createService.wakeUpMutationPathNormalized(normalizedPath, value, {
      ensureBehavior,
      syncDescendants: this.isBranchValue(previousValue) || this.isBranchValue(value)
    });

    if (emitDevtools && this.signalStore.devActive) {
      this.emitDevtoolsEvent(normalizedPath, value, previousValue);
    }

    this.emitBehaviorUpdateIfTracked(
      normalizedPath,
      behaviorsEnabled,
      emitBehaviorUpdate,
      behaviorValue,
      behaviorState
    );

    if (shouldDeleteNode) {
      this.queueDerivedCleanup(normalizedPath);
    }
  }


  // numeric segment helper removed; use PathUtils/isNumericSegment (SSOT) where needed

  constructor(
    private readonly signalStore: SignalStore,
    private readonly storeName: string,
    _proxyFactory?: ProxyFactory,
    devService?: AngularStoreDevtools
  ) {
    this.devService = devService;

    // Initialize CreateStoreService for this instance
    this.createService = new CreateStoreService<T>(storeName, signalStore);

    // Validate initial store name
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

  // Removed: getDevTools() - DevService now injected via constructor

  // Helper method to emit DevTools actions consistently
  private emitDevAction(action: StoreDevToolsAction): void {
    if (this.signalStore.devActive) {
      this.signalStore.emitDevAction(this.storeName, action);
    }
  }

  private getComputedSnapshot(): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {};
    Object.keys(this.computedStore).forEach(k => {
      try {
        const s = this.computedStore[k] as Signal<unknown>;
        snapshot[k] = s();
      } catch {
        snapshot[k] = '[signal]';
      }
    });
    return snapshot;
  }

  addToComputeStore(path: string): void {
    this.createService.addToComputeStore(path)
    this.emitComputedEvent('add', path);
  }

  deleteFromComputeStore(path: string): void {
    this.createService.deleteFromComputeStore(path)
    this.emitComputedEvent('remove', path);
  }

  returnStore(): T {
    return this.store;
  }

  // Overloads: strict path, typed literal fallback, and dynamic string fallback
  setValue<P extends PathKeys<T>>(path: P, value: PathValue<T, P>): void;
  setValue<P extends string>(path: P, value: PathValue<T, P>): void;
  setValue(path: string, value: unknown): void;
  setValue(path: string, value: unknown): void {
    // Type-safe setValue with runtime validation
    if (isValidPath<T>(path)) {
      try {
        this.setValueObserve(path as ValidPath<T>, value as PathValue<T, typeof path & string>);
      } catch (error) {
        throw StoreErrorFactory.pathAccess(path, 'setValue', error as Error);
      }
    } else {
      throw StoreErrorFactory.pathValidation(path, 'Invalid path format for setValue');
    }
  }

  // Overloads for array mutations
  setArrayMethod<P extends ValidPath<T>>(
    path: P,
    val: PathValue<T, P> extends readonly (infer U)[] ? U : never,
    method: ArrayMutationMethod,
    ...args: unknown[]
  ): unknown;
  setArrayMethod<P extends PathKeys<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(
    path: P,
    val: U,
    method: Extract<ArrayMutationMethod, 'push' | 'unshift'>,
    ...args: unknown[]
  ): unknown;
  setArrayMethod<P extends PathKeys<T>>(
    path: P,
    method: Extract<ArrayMutationMethod, 'pop' | 'shift'>
  ): unknown;
  setArrayMethod<P extends PathKeys<T>>(
    path: P,
    val: SpliceOperation,
    method: 'splice'
  ): unknown;
  setArrayMethod<P extends PathKeys<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(
    path: P,
    compareFn: (a: U, b: U) => number,
    method: 'sort'
  ): unknown;
  setArrayMethod(
    path: string,
    val: unknown,
    method: ArrayMutationMethod,
    ...args: unknown[]
  ): unknown;
  setArrayMethod(
    path: string,
    method: Extract<ArrayMutationMethod, 'pop' | 'shift'>
  ): unknown;
  // Implementation
  setArrayMethod(
    path: string,
    a: unknown,
    method?: ArrayMutationMethod,
    ...args: unknown[]
  ): unknown {
    const ops = this.arrayOps(path as ValidPath<T> & string);
    if (typeof a === 'string' && (a === 'pop' || a === 'shift')) {
      // form: setArrayMethod(path, 'pop' | 'shift')
      return ops.setArrayMethod(undefined as unknown, a);
    }
    return ops.setArrayMethod(a as unknown, method as ArrayMutationMethod, ...args);
  }

  setArrayMethodRef(
    path: string,
    arrayRef: unknown[],
    val: unknown,
    method: ArrayMutationMethod,
    ...args: unknown[]
  ): unknown {
    return this.arrayOps(path as ValidPath<T> & string).setArrayMethodOnRef(arrayRef, val, method, ...args);
  }

  // Strongly-typed overloads for array queries (delegates to TypedArrayOperations)
  queryArray<
    P extends ValidPath<T>,
    U = PathValue<T, P> extends readonly (infer V)[] ? V : never
  >(path: P, val: PredicateFn<U> | U, method: 'find'): U | undefined;
  queryArray<
    P extends ValidPath<T>,
    U = PathValue<T, P> extends readonly (infer V)[] ? V : never
  >(path: P, val: PredicateFn<U> | U, method: 'findIndex'): number;
  queryArray<
    P extends ValidPath<T>,
    U = PathValue<T, P> extends readonly (infer V)[] ? V : never
  >(path: P, val: PredicateFn<U>, method: 'filter'): U[];
  queryArray<
    P extends ValidPath<T>,
    U = PathValue<T, P> extends readonly (infer V)[] ? V : never,
    R = unknown
  >(path: P, val: MapFn<U, R>, method: 'map'): R[];
  queryArray<
    P extends ValidPath<T>,
    U = PathValue<T, P> extends readonly (infer V)[] ? V : never,
    R = unknown
  >(path: P, val: ReduceFn<U, R>, method: 'reduce', initialValue: R): R;
  queryArray<
    P extends ValidPath<T>,
    U = PathValue<T, P> extends readonly (infer V)[] ? V : never
  >(path: P, val: PredicateFn<U>, method: 'some' | 'every'): boolean;
  queryArray<
    P extends ValidPath<T>,
    U = PathValue<T, P> extends readonly (infer V)[] ? V : never
  >(path: P, val: U, method: 'includes'): boolean;
  queryArray<
    P extends ValidPath<T>,
    U = PathValue<T, P> extends readonly (infer V)[] ? V : never
  >(path: P, val: U, method: 'indexOf'): number;
  queryArray<P extends ValidPath<T>>(path: P, _: unknown, method: 'length'): number;
  // String fallback
  queryArray(
    path: string,
    val: unknown,
    method: ArrayQueryMethod | 'length',
    ...args: unknown[]
  ): unknown;
  // Fallback implementation signature
  queryArray<P extends ValidPath<T>>(
    path: P,
    val: unknown,
    method: ArrayQueryMethod | 'length',
    ...args: unknown[]
  ): unknown {
    const ops = this.arrayOps(path);
    // Delegate to TypedArrayOperations; casting kept to unknown to avoid any
    return (ops as unknown as { queryArray: (...a: unknown[]) => unknown }).queryArray(val as unknown, method as unknown, ...(args as unknown[]));
  }

  deleteFromArray<
    P extends ValidPath<T>,
    U = PathValue<T, P> extends readonly (infer V)[] ? V : never
  >(path: P, predicate: U extends never ? unknown : PredicateFn<U> | U) {
    return this.arrayOps(path).deleteFromArray(predicate);
  }

  deleteByIndex<P extends ValidPath<T>>(path: P, index: number) {
    return this.arrayOps(path).deleteByIndex(index);
  }

  // Overloads: strict path, typed literal fallback, and dynamic string fallback
  deleteValue<P extends PathKeys<T>>(path: P): void;
  deleteValue<P extends string>(path: P): void;
  deleteValue(path: string): void;
  deleteValue(path: string): void {
    try {
      if (!PathUtils.isValidPath(path)) {
        throw StoreErrorFactory.pathValidation(path, 'Invalid path format for delete operation');
      }
      // Set value to undefined (removes from store)
      this.setValue(path, undefined);
    } catch (error) {
      throw StoreErrorFactory.pathAccess(path, 'deleteValue', error as Error);
    }
  }

  cleanupPath(path: string): void {
    const normalizedPath = PathUtils.normalizePath(path);
    if (!normalizedPath) {
      return;
    }
    this.cleanupDerivedPath(normalizedPath);
  }

  destroy(): void {
    this.createService.destroy();
    this.cursor.clearCaches();
    for (const path of Object.keys(this.arrayOpsCache)) delete this.arrayOpsCache[path];
  }

  // Type-safe array query methods - all delegate to TypedArrayOperations via arrayOps()
  findInArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(
    path: P, predicate: U extends never ? unknown : PredicateFn<U> | U
  ): U | undefined { return this.arrayOps(path).findInArray(predicate as PredicateFn<U> | U); }

  findIndexInArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(
    path: P, predicate: U extends never ? unknown : PredicateFn<U> | U
  ): number { return this.arrayOps(path).findIndexInArray(predicate as PredicateFn<U> | U); }

  filterArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(
    path: P, predicate: U extends never ? unknown : PredicateFn<U>
  ): U[] { return this.arrayOps(path).filterArray(predicate as PredicateFn<U>); }

  mapArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never, R = unknown>(
    path: P, callback: U extends never ? unknown : MapFn<U, R>
  ): R[] { return this.arrayOps(path).mapArray(callback as MapFn<U, R>); }

  reduceArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never, R = unknown>(
    path: P, callback: U extends never ? unknown : ReduceFn<U, R>, initialValue: R
  ): R { return this.arrayOps(path).reduceArray(callback as ReduceFn<U, R>, initialValue); }

  someArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(
    path: P, predicate: U extends never ? unknown : PredicateFn<U>
  ): boolean { return this.arrayOps(path).someArray(predicate as PredicateFn<U>); }

  everyArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(
    path: P, predicate: U extends never ? unknown : PredicateFn<U>
  ): boolean { return this.arrayOps(path).everyArray(predicate as PredicateFn<U>); }

  includesInArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(
    path: P, searchElement: U extends never ? unknown : U
  ): boolean { return this.arrayOps(path).includesInArray(searchElement as U); }

  indexOfInArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(
    path: P, searchElement: U extends never ? unknown : U
  ): number { return this.arrayOps(path).indexOfInArray(searchElement as U); }

  lengthOfArray<P extends ValidPath<T>>(path: P): number {
    return this.arrayOps(path).lengthOfArray();
  }

  // Type-safe array modification methods - delegate to TypedArrayOperations
  updateArrayItem<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(
    path: P, index: number, newValue: U
  ): void { return this.arrayOps(path).updateArrayItem(index, newValue); }

  updateArrayItemByFind<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(
    path: P, predicate: PredicateFn<U> | U, newValue: U
  ): void { return this.arrayOps(path).updateArrayItemByFind(predicate, newValue); }

  // Consolidated reactive accessors with overloads
  getComputed<P extends PathKeys<T>>(path: P): SignalType<PathValue<T, P>>;
  getComputed<P extends string>(path: P): SignalType<PathValue<T, P>>;
  getComputed(path: string): SignalType<unknown>;
  getComputed(path: string): SignalType<unknown> {
    return this.withReactiveAccessor(
      path,
      'computed signal',
      (normalized) => this.createService.isComputedExists(normalized),
      (normalized) => this.createService.getComputed(normalized as ValidPath<T>) as SignalType<unknown>,
      (normalized) => this.emitComputedEvent('add', normalized)
    );
  }

  getSignalValue<P extends PathKeys<T>>(path: P): PathValue<T, P> | undefined;
  getSignalValue<P extends string>(path: P): PathValue<T, P> | undefined;
  getSignalValue(path: string): unknown | undefined;
  getSignalValue(path: string): unknown | undefined {
    return PathUtils.isValidPath(path) ? this.signalStore.getSignalValue(this.storeName, path) : undefined;
  }

  readStore<P extends PathKeys<T>>(path: P): PathValue<T, P> | undefined;
  readStore<P extends string>(path: P): PathValue<T, P> | undefined;
  readStore(path: string): unknown | undefined;
  readStore(path: string): unknown | undefined {
    return path && typeof path === 'string' ? this.signalStore.readStore(this.storeName, path) : undefined;
  }

  getBehaviorSubject<P extends PathKeys<T>>(path: P): BehaviorSubjectType<PathValue<T, P>>;
  getBehaviorSubject<P extends string>(path: P): BehaviorSubjectType<PathValue<T, P>>;
  getBehaviorSubject(path: string): BehaviorSubjectType<unknown>;
  getBehaviorSubject(path: string): any {
    return this.withReactiveAccessor(
      path,
      'BehaviorSubject',
      (normalized) => this.createService.isBehaviorExists(normalized),
      (normalized) => this.createService.getObservable(normalized as ValidPath<T>),
      (normalized) => this.emitBehaviorEvent(normalized, 'add', undefined, this.createService.getBehaviorStore())
    );
  }

  getObservable<P extends PathKeys<T>>(path: P): ObservableType<PathValue<T, P>>;
  getObservable<P extends string>(path: P): ObservableType<PathValue<T, P>>;
  getObservable(path: string): ObservableType<unknown>;
  getObservable(path: string): ObservableType<unknown> {
    return this.withValidatedPath(path, 'Observable', (normalizedPath) =>
      this.createService.getObservable(normalizedPath as ValidPath<T>) as ObservableType<unknown>
    );
  }

  // Helper methods
  private validateAndGet(path: string, context: string): string {
    if (!PathUtils.isValidPath(path)) {
      throw StoreErrorFactory.pathValidation(path, `Invalid path format for ${context}`);
    }
    return PathUtils.normalizePath(path);
  }

  // New: type-safe selection APIs delegating to service
  select<TOut>(project: (s: T) => TOut) {
    // createService is generic on T, so pass through
    return this.createService.select(project);
  }

  computedOf<TOut>(project: (s: T) => TOut) {
    return this.createService.computedOf(project);
  }

  // Overloads for observe
  setValueObserve<P extends PathKeys<T>>(path: P, value: PathValue<T, P>): void;
  setValueObserve<P extends string>(path: P, value: PathValue<T, P>): void;
  setValueObserve(path: string, value: unknown): void;
  setValueObserve(path: string, value: unknown): void {
    try {
      this.withValidatedPath(path, 'observe operation', (normalizedPath) => {
        this.mutateStoreNormalized(normalizedPath, value, {
          ensureBehavior: true,
          emitBehaviorUpdate: true,
          cleanupOnUndefined: true,
          emitDevtools: true
        });
      });
    } catch (error) {
      throw StoreErrorFactory.pathAccess(path, 'setValueObserve', error as Error);
    }
  }

  updateBehaviorsBySegments(path: string, newValue?: unknown) {
    this.createService.updateBehaviorsBySegments(path, newValue);

    // DevTools: emit update event for the normalized path if a BehaviorSubject exists
    const normalized = PathUtils.normalizePath(path);
    if (this.createService.isBehaviorExists(normalized)) {
      this.emitBehaviorEvent(normalized, 'update', this.readStore(normalized), this.createService.getBehaviorStore());
    }
  }

  wakeUpArrayMutation(path: string, value: unknown, afterVersion?: () => void): void {
    const normalized = PathUtils.normalizePath(path);
    this.createService.wakeUpArrayMutation(
      normalized,
      value,
      afterVersion,
      (p, v) => this.updateBehaviorsBySegments(p, v)
    );
  }

  wakeUpMutationPath(path: string, value: unknown, options?: WakeUpPathOptions): boolean {
    const normalized = PathUtils.normalizePath(path);
    return this.createService.wakeUpMutationPath(
      normalized,
      value,
      options,
      (p, v) => this.updateBehaviorsBySegments(p, v)
    );
  }

  wakeUpVersionPath(path: string): void {
    this.createService.wakeUpVersionPath(path);
  }

  wakeup<P extends PathKeys<T>>(path: P, mode?: StoreWakeupMode): void;
  wakeup<P extends string>(path: P, mode?: StoreWakeupMode): void;
  wakeup(path: string, mode: StoreWakeupMode = 'leaf'): void {
    this.withValidatedPath(path, 'wakeup', (normalizedPath) => {
      this.createService.wakeUpVersionPathWithMode(normalizedPath, mode);
    });
  }

  wakeUp<P extends PathKeys<T>>(path: P, mode?: StoreWakeupMode): void;
  wakeUp<P extends string>(path: P, mode?: StoreWakeupMode): void;
  wakeUp(path: string, mode: StoreWakeupMode = 'leaf'): void {
    this.wakeup(path, mode);
  }

  batch<R>(fn: () => R): R {
    const previousAutoBatch = this.createService.getAutoBatchBumps();
    this.createService.setAutoBatchBumps(true);
    this.createService.beginAction();
    try {
      return fn();
    } finally {
      this.createService.endAction();
      this.createService.flushPendingBumps();
      this.createService.setAutoBatchBumps(previousAutoBatch);
    }
  }

  enableDevTools(_storeName: string, showVisualizer = true): void {
    // Visualizer handled globally; nothing to do here
    if (showVisualizer && typeof document !== 'undefined') {
      const existing = document.querySelector('app-dev-tools');
      if (!existing) {
        const comp = document.createElement('app-dev-tools');
        document.body.appendChild(comp);
      }
    }
  }

  

  // Convenience to configure dependency mode per store instance
  setDependencyMode(mode: 'exact' | 'container') {
    this.createService.setDependencyMode(mode);
  }

  // Toggle read-tracking (collector) for auto-computed derivations
  setTrackReads(enabled: boolean) {
    this.createService.setTrackReads(enabled);
  }

  // Control shallow-clone of computed outputs (objects/arrays)
  setCloneComputedOutputs(enabled: boolean) {
    this.createService.setCloneComputedOutputs(enabled);
  }

  // Toggle BehaviorSubject updates
  setBehaviorUpdatesEnabled(enabled: boolean) {
    this.createService.setBehaviorUpdatesEnabled(enabled);
  }

  // Prefetch cursor during proxy navigation to narrow subsequent sets
  prefetchCursorWithNode(path: string, node: Record<string, unknown> | null) {
    try { this.cursor.prefetch(path, node); } catch (e) {
      console.warn('CreateStore prefetchCursor error:', e);
    }
  }

  // Fast setter used by proxy: assumes path is normalized ('a.b.c'), skips validation/normalize
  setValueFast(path: string, value: unknown): void {
    this.mutateStoreNormalized(path, value, { emitDevtools: true });
  }

  // Opt-in fine-grained mutate wake (default false = historical behaviour). Mirrors
  // SolidStoreOptions.preciseMutationWake so both engines behave identically.
  preciseMutationWake = false;

  setPreciseMutationWake(enabled: boolean): void {
    this.preciseMutationWake = enabled;
  }

  // Fine-grained mutate commit (opt-in): write the new branch value, then wake ONLY the
  // changed leaves + the branch itself (no syncDescendants). The branch wake keeps
  // whole-array consumers correct; leaf wakes refresh the changed fields. Branch interest
  // (liveQuery-equivalent) still fires via its own version bump. Analogous to
  // SolidStore.#commitPrecise; paths come from the shared mutation pass itself.
  commitMutationPrecise(branch: string, value: unknown, relPaths: readonly string[]): void {
    const normalizedBranch = PathUtils.normalizePath(branch);
    this.batch(() => {
      const plan = this.cursor.applyPathPlan(normalizedBranch);
      this.cursor.mutateNode(this.store as unknown as Record<string, unknown>, plan, normalizedBranch, value);
      // Branch signal (whole-array consumers) without descendants.
      this.wakeUpMutationPath(normalizedBranch, value, { syncDescendants: false });
      // Exact changed leaves without descendants.
      for (const rel of relPaths) {
        const leaf = `${normalizedBranch}.${rel}`;
        this.wakeUpMutationPath(leaf, this.readStore(leaf), { syncDescendants: false });
      }
    });
  }

  private deletePathFromStore(normalizedPath: string): void {
    const segments = normalizedPath.split('.');
    if (segments.length === 0) {
      return;
    }

    const lastSegment = segments.pop()!;
    let parent: unknown = this.store as Record<string, unknown>;

    for (const segment of segments) {
      if (parent == null || typeof parent !== 'object') {
        return;
      }
      parent = (parent as Record<string, unknown>)[segment];
    }

    if (parent == null || typeof parent !== 'object') {
      return;
    }

    if (Array.isArray(parent)) {
      const index = Number(lastSegment);
      if (!Number.isNaN(index) && index >= 0 && index < parent.length) {
        parent.splice(index, 1);
      }
      return;
    }

    {
      delete (parent as Record<string, unknown>)[lastSegment];
    }
  }
}
