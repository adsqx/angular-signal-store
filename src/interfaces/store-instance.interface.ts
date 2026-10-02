import type { StoreProxy } from './types';
import {
  StoreData, PathValue, ValidPath, PathKeys, ArrayMutationMethod, ArrayQueryMethod, ArrayOperationResult,
  SpliceOperation, PredicateFn, MapFn, ReduceFn, ObservableType, SignalType, BehaviorSubjectType
} from '../types/advanced-types';
import type { StoreWakeupMode } from '../core/create-store.core';

/**
 * Element type of the array at `P`. Deliberately not `ArrayElement<PathValue<T, P>>`:
 * that one is distributive, this one is not (`string[] | undefined` yields `never`).
 */
type ElementOf<T, P extends string> = PathValue<T, P> extends readonly (infer V)[] ? V : never;

// Argument shapes that collapse to `unknown` when the element type is `never` (non-array
// path). Each alias repeats the conditional so it stays distributive over `U` exactly like
// the inline form did; do not factor the branch out into a second parameter.
type ElemArg<U> = U extends never ? unknown : U;
type PredicateArg<U> = U extends never ? unknown : PredicateFn<U>;
type PredicateOrElem<U> = U extends never ? unknown : PredicateFn<U> | U;
type MapArg<U, R> = U extends never ? unknown : MapFn<U, R>;
type ReduceArg<U, R> = U extends never ? unknown : ReduceFn<U, R>;
// The `any` in the callback unions is load-bearing: with `unknown` the generic fallback
// stops accepting typed MapFn/ReduceFn callbacks.
type QueryArg<U> = U extends never ? unknown : PredicateFn<U> | MapFn<U, any> | ReduceFn<U, any> | U;

/**
 * Generic reactive store instance: value and array manipulation, observability, cleanup.
 *
 * Path-taking methods are overloaded three ways, in this order: a strict `PathKeys<T>`
 * overload, a `string` literal fallback that keeps deep paths typed once the `PathKeys`
 * depth is exceeded, and a plain dynamic `string` fallback returning `unknown`.
 */
export interface IStoreInstance<T extends StoreData = StoreData> {
  /** The current store value (root object). */
  store: T;

  /** Type-safe observable for a path. */
  getObservable<P extends PathKeys<T>>(path: P): ObservableType<PathValue<T, P>>;
  getObservable<P extends string>(path: P): ObservableType<PathValue<T, P>>;
  getObservable(path: string): ObservableType<unknown>;

  /** Projections; dependencies are collected from callable proxy reads. */
  /** `state` is the live store proxy: read through it (`state.user.name()`) to track dependencies. */
  select<TOut>(project: (state: StoreProxy<T>) => TOut): ObservableType<TOut>;
  /** `state` is the live store proxy: read through it (`state.user.name()`) to track dependencies. */
  computedOf<TOut>(project: (state: StoreProxy<T>) => TOut): SignalType<TOut>;

  /** Sets a value at the given path. */
  setValue<P extends PathKeys<T>>(path: P, value: PathValue<T, P>): void;
  setValue<P extends string>(path: P, value: PathValue<T, P>): void;
  setValue(path: string, value: unknown): void;

  /**
   * Manually invalidates version signals without mutating the store.
   * - leaf: bumps the full branch chain, e.g. a, a.b, a.b.c
   * - grained: bumps only the exact path, e.g. a.b.c
   */
  wakeup<P extends PathKeys<T>>(path: P, mode?: StoreWakeupMode): void;
  wakeup<P extends string>(path: P, mode?: StoreWakeupMode): void;
  wakeup(path: string, mode?: StoreWakeupMode): void;
  wakeUp<P extends PathKeys<T>>(path: P, mode?: StoreWakeupMode): void;
  wakeUp<P extends string>(path: P, mode?: StoreWakeupMode): void;
  wakeUp(path: string, mode?: StoreWakeupMode): void;

  /** Runs several mutations as one batched version update: writes stay synchronous, bumps flush before this returns. */
  batch<R>(fn: () => R): R;

  /** Type-safe array mutation at the given path. */
  setArrayMethod<P extends PathKeys<T>, U = ElementOf<T, P>>(path: P, val: U, method: Extract<ArrayMutationMethod, 'push' | 'unshift'>, ...args: unknown[]): unknown;
  setArrayMethod<P extends PathKeys<T>>(path: P, method: Extract<ArrayMutationMethod, 'pop' | 'shift'>): unknown;
  setArrayMethod<P extends PathKeys<T>>(path: P, val: SpliceOperation, method: 'splice'): unknown;
  setArrayMethod<P extends PathKeys<T>, U = ElementOf<T, P>>(path: P, compareFn: (a: U, b: U) => number, method: 'sort'): unknown;
  // Generic fallback (preserves existing API)
  setArrayMethod<P extends ValidPath<T>>(path: P, val: ElementOf<T, P>, method: ArrayMutationMethod, ...args: unknown[]): unknown;
  // String fallback
  setArrayMethod(path: string, val: unknown, method: ArrayMutationMethod, ...args: unknown[]): unknown;
  setArrayMethod(path: string, method: Extract<ArrayMutationMethod, 'pop' | 'shift'>): unknown;
  setArrayMethodRef?(path: string, arrayRef: unknown[], val: unknown, method: ArrayMutationMethod, ...args: unknown[]): unknown;

  /** Type-safe array query at the given path. */
  queryArray<P extends PathKeys<T>, U = ElementOf<T, P>>(path: P, val: PredicateFn<U> | U, method: 'find'): U | undefined;
  queryArray<P extends PathKeys<T>, U = ElementOf<T, P>>(path: P, val: PredicateFn<U> | U, method: 'findIndex'): number;
  queryArray<P extends PathKeys<T>, U = ElementOf<T, P>>(path: P, val: PredicateFn<U>, method: 'filter'): U[];
  queryArray<P extends PathKeys<T>, U = ElementOf<T, P>, R = unknown>(path: P, val: MapFn<U, R>, method: 'map'): R[];
  queryArray<P extends PathKeys<T>, U = ElementOf<T, P>, R = unknown>(path: P, val: ReduceFn<U, R>, method: 'reduce', initialValue: R): R;
  queryArray<P extends PathKeys<T>, U = ElementOf<T, P>>(path: P, val: PredicateFn<U>, method: 'some' | 'every'): boolean;
  queryArray<P extends PathKeys<T>, U = ElementOf<T, P>>(path: P, val: U, method: 'includes'): boolean;
  queryArray<P extends PathKeys<T>, U = ElementOf<T, P>>(path: P, val: U, method: 'indexOf'): number;
  queryArray<P extends PathKeys<T>>(path: P, _: unknown, method: 'length'): number;
  // Generic fallback (preserves existing API)
  queryArray<P extends ValidPath<T>, M extends ArrayQueryMethod, U = ElementOf<T, P>>(
    path: P, val: QueryArg<U>, method: M, ...args: unknown[]
  ): ArrayOperationResult<U, M>['result'];
  // String fallback
  queryArray(path: string, val: unknown, method: ArrayQueryMethod | 'length', ...args: unknown[]): unknown;

  /** Reads the value at the given path. */
  readStore<P extends PathKeys<T>>(path: P): PathValue<T, P> | undefined;
  readStore<P extends string>(path: P): PathValue<T, P> | undefined;
  readStore(path: string): unknown | undefined;

  /** Sets a value and notifies observers (internal use). */
  setValueObserve<P extends PathKeys<T>>(path: P, value: PathValue<T, P>): void;
  setValueObserve<P extends string>(path: P, value: PathValue<T, P>): void;
  setValueObserve(path: string, value: unknown): void;

  /** Deletes the value at the given path. */
  deleteValue<P extends PathKeys<T>>(path: P): void;
  deleteValue<P extends string>(path: P): void;
  deleteValue(path: string): void;

  /**
   * Cleans up reactive resources and derived caches for a path prefix: BehaviorSubjects,
   * computed nodes, version data, and any proxy or cursor caches associated with the path.
   */
  cleanupPath(path: string): void;

  /** Optional hook to prefetch cursor nodes for proxy caching. */
  prefetchCursorWithNode?(path: string, value: unknown): void;

  /** Optional fast-path setter bypassing validation for internal updates. */
  setValueFast?(path: string, value: unknown): void;

  behaviorStore: Record<string, BehaviorSubjectType<unknown>>;
  computedStore: Record<string, SignalType<unknown>>;
  devService?: unknown;

  // Array-specific helpers
  findInArray<P extends ValidPath<T>, U = ElementOf<T, P>>(path: P, predicate: PredicateOrElem<U>): U | undefined;
  findIndexInArray<P extends ValidPath<T>, U = ElementOf<T, P>>(path: P, predicate: PredicateOrElem<U>): number;
  filterArray<P extends ValidPath<T>, U = ElementOf<T, P>>(path: P, predicate: PredicateArg<U>): U[];
  mapArray<P extends ValidPath<T>, U = ElementOf<T, P>, R = unknown>(path: P, callback: MapArg<U, R>): R[];
  reduceArray<P extends ValidPath<T>, U = ElementOf<T, P>, R = unknown>(path: P, callback: ReduceArg<U, R>, initialValue?: R): R;
  someArray<P extends ValidPath<T>, U = ElementOf<T, P>>(path: P, predicate: PredicateArg<U>): boolean;
  everyArray<P extends ValidPath<T>, U = ElementOf<T, P>>(path: P, predicate: PredicateArg<U>): boolean;
  includesInArray<P extends ValidPath<T>, U = ElementOf<T, P>>(path: P, searchElement: ElemArg<U>): boolean;
  indexOfInArray<P extends ValidPath<T>, U = ElementOf<T, P>>(path: P, searchElement: ElemArg<U>): number;
  lengthOfArray<P extends ValidPath<T>>(path: P): number;
  updateArrayItem<P extends ValidPath<T>, U = ElementOf<T, P>>(path: P, index: number, newValue: ElemArg<U>): void;
  updateArrayItemByFind<P extends ValidPath<T>, U = ElementOf<T, P>>(path: P, predicate: PredicateOrElem<U>, newValue: ElemArg<U>): void;
  deleteFromArray<P extends ValidPath<T>, U = ElementOf<T, P>>(path: P, predicate: PredicateOrElem<U>): void;
  deleteByIndex<P extends ValidPath<T>>(path: P, index: number): void;

  getComputed<P extends PathKeys<T>>(path: P): SignalType<PathValue<T, P>>;
  getComputed<P extends string>(path: P): SignalType<PathValue<T, P>>;
  getComputed(path: string): SignalType<unknown>;

  getBehaviorSubject<P extends PathKeys<T>>(path: P): BehaviorSubjectType<PathValue<T, P>>;
  getBehaviorSubject<P extends string>(path: P): BehaviorSubjectType<PathValue<T, P>>;
  getBehaviorSubject(path: string): BehaviorSubjectType<unknown>;

  getSignalValue<P extends PathKeys<T>>(path: P): PathValue<T, P> | undefined;
  getSignalValue<P extends string>(path: P): PathValue<T, P> | undefined;
  getSignalValue(path: string): unknown | undefined;

  returnStore(): T;
  /** Updates behaviors by path segments (internal). */
  updateBehaviorsBySegments(path: string, newValue?: unknown): void;
  enableDevTools(storeName: string, showVisualizer?: boolean): void;
  addToComputeStore(path: string): void;
  deleteFromComputeStore(path: string): void;

  /** Index signature for dynamic access (kept for backward compatibility). */
  [key: string]: unknown;
}
