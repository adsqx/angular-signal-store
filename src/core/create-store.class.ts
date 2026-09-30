import { PathUtils } from '../utils/path-utils';
import type { StoreWakeupMode } from './create-store.core';
import { CreateStoreBase, COMPUTED_KIND, BEHAVIOR_KIND } from './create-store.base';
import { installArrayForwarders } from './array-forwarders';
import type { CreateStoreArrayApi } from './create-store.types';
import {
  StoreData,
  PathValue,
  ValidPath,
  PathKeys,
  PredicateFn,
  ArrayMutationMethod,
  SpliceOperation,
  SignalType,
  BehaviorSubjectType,
  ObservableType
} from '../types/advanced-types';
import { StoreErrorFactory } from '../types/errors';

// Array members are declared in CreateStoreArrayApi and installed by installArrayForwarders (static block).
export interface CreateStore<T extends StoreData = StoreData> extends CreateStoreArrayApi<T> {}

/**
 * The exported store facade: the path-typed overload families (writes, reads, reactive accessors,
 * wake, array mutation) on top of the plumbing in `CreateStoreBase`.
 */
export class CreateStore<T extends StoreData = StoreData> extends CreateStoreBase<T> {
  static {
    // Bound to the class definition itself, so no bundler can keep the class and drop its members.
    installArrayForwarders(CreateStore.prototype);
  }

  // Writes: overloads are strict path, typed literal fallback, and dynamic string fallback
  setValue<P extends PathKeys<T>>(path: P, value: PathValue<T, P>): void;
  setValue<P extends string>(path: P, value: PathValue<T, P>): void;
  setValue(path: string, value: unknown): void;
  setValue(path: string, value: unknown): void {
    if (!PathUtils.isValidPath(path)) {
      throw StoreErrorFactory.pathValidation(path, 'Invalid path format for setValue');
    }
    try {
      this.writeObserve(PathUtils.normalizePath(path), value);
    } catch (error) {
      // Same nesting as the former setValue -> setValueObserve pair.
      throw StoreErrorFactory.pathAccess(path, 'setValue', StoreErrorFactory.pathAccess(path, 'setValueObserve', error as Error));
    }
  }

  setValueObserve<P extends PathKeys<T>>(path: P, value: PathValue<T, P>): void;
  setValueObserve<P extends string>(path: P, value: PathValue<T, P>): void;
  setValueObserve(path: string, value: unknown): void;
  setValueObserve(path: string, value: unknown): void {
    try {
      this.writeObserve(this.validPath(path, 'observe operation'), value);
    } catch (error) {
      throw StoreErrorFactory.pathAccess(path, 'setValueObserve', error as Error);
    }
  }

  deleteValue<P extends PathKeys<T>>(path: P): void;
  deleteValue<P extends string>(path: P): void;
  deleteValue(path: string): void;
  deleteValue(path: string): void {
    try {
      if (!PathUtils.isValidPath(path)) {
        throw StoreErrorFactory.pathValidation(path, 'Invalid path format for delete operation');
      }
      this.setValue(path, undefined); // undefined removes the key
    } catch (error) {
      throw StoreErrorFactory.pathAccess(path, 'deleteValue', error as Error);
    }
  }

  // Reads and reactive accessors
  getSignalValue<P extends PathKeys<T>>(path: P): PathValue<T, P> | undefined;
  getSignalValue<P extends string>(path: P): PathValue<T, P> | undefined;
  getSignalValue(path: string): unknown | undefined;
  getSignalValue(path: string): unknown | undefined {
    return PathUtils.isValidPath(path) ? this.signalStore.read(this.storeName, path) : undefined;
  }

  readStore<P extends PathKeys<T>>(path: P): PathValue<T, P> | undefined;
  readStore<P extends string>(path: P): PathValue<T, P> | undefined;
  readStore(path: string): unknown | undefined;
  readStore(path: string): unknown | undefined {
    return path && typeof path === 'string' ? this.signalStore.read(this.storeName, path) : undefined;
  }

  getComputed<P extends PathKeys<T>>(path: P): SignalType<PathValue<T, P>>;
  getComputed<P extends string>(path: P): SignalType<PathValue<T, P>>;
  getComputed(path: string): SignalType<unknown>;
  getComputed(path: string): SignalType<unknown> {
    return this.reactive(COMPUTED_KIND, path) as SignalType<unknown>;
  }

  getBehaviorSubject<P extends PathKeys<T>>(path: P): BehaviorSubjectType<PathValue<T, P>>;
  getBehaviorSubject<P extends string>(path: P): BehaviorSubjectType<PathValue<T, P>>;
  getBehaviorSubject(path: string): BehaviorSubjectType<unknown>;
  // BehaviorSubject<T> is invariant in T, so only a supertype return (unknown) is compatible with every overload.
  getBehaviorSubject(path: string): unknown {
    return this.reactive(BEHAVIOR_KIND, path);
  }

  getObservable<P extends PathKeys<T>>(path: P): ObservableType<PathValue<T, P>>;
  getObservable<P extends string>(path: P): ObservableType<PathValue<T, P>>;
  getObservable(path: string): ObservableType<unknown>;
  getObservable(path: string): ObservableType<unknown> {
    return this.createService.getObservable(this.validPath(path, 'Observable'));
  }

  // Wake
  wakeup<P extends PathKeys<T>>(path: P, mode?: StoreWakeupMode): void;
  wakeup<P extends string>(path: P, mode?: StoreWakeupMode): void;
  wakeup(path: string, mode: StoreWakeupMode = 'leaf'): void {
    this.createService.wakeUpVersionPathWithMode(this.validPath(path, 'wakeup'), mode);
  }

  wakeUp<P extends PathKeys<T>>(path: P, mode?: StoreWakeupMode): void;
  wakeUp<P extends string>(path: P, mode?: StoreWakeupMode): void;
  wakeUp(path: string, mode: StoreWakeupMode = 'leaf'): void {
    this.wakeup(path, mode);
  }

  // Array mutation (the other array members: CreateStoreArrayApi)
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
  setArrayMethod<P extends PathKeys<T>>(path: P, method: Extract<ArrayMutationMethod, 'pop' | 'shift'>): unknown;
  setArrayMethod<P extends PathKeys<T>>(path: P, val: SpliceOperation, method: 'splice'): unknown;
  setArrayMethod<P extends PathKeys<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(
    path: P,
    compareFn: (a: U, b: U) => number,
    method: 'sort'
  ): unknown;
  setArrayMethod(path: string, val: unknown, method: ArrayMutationMethod, ...args: unknown[]): unknown;
  setArrayMethod(path: string, method: Extract<ArrayMutationMethod, 'pop' | 'shift'>): unknown;
  setArrayMethod(path: string, a: unknown, method?: ArrayMutationMethod, ...args: unknown[]): unknown {
    const ops = this.arrayOps(path as ValidPath<T> & string);
    // form: setArrayMethod(path, 'pop' | 'shift')
    return a === 'pop' || a === 'shift' ? ops.setArrayMethod(undefined, a) : ops.setArrayMethod(a, method as ArrayMutationMethod, ...args);
  }

  deleteFromArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(
    path: P, predicate: U extends never ? unknown : PredicateFn<U> | U
  ) { return this.arrayOps(path).deleteFromArray(predicate); }

  deleteByIndex<P extends ValidPath<T>>(path: P, index: number) { return this.arrayOps(path).deleteByIndex(index); }
}
