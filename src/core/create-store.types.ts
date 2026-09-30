import type {
  StoreData,
  PathValue,
  ValidPath,
  ArrayMutationMethod,
  ArrayQueryMethod,
  PredicateFn,
  MapFn,
  ReduceFn
} from '../types/advanced-types';

/**
 * Array members of `CreateStore`, declared once here (merged into the class by declaration merging) and
 * installed on its prototype by `installArrayForwarders`. `setArrayMethod`, `deleteFromArray` and
 * `deleteByIndex` stay on the class (see notes there).
 */
export interface CreateStoreArrayApi<T extends StoreData> {
  // Mutations. (`setArrayMethod` stays on the class: declared here, its PathKeys<T> constraints would resolve to their expansion in the public API text.)
  setArrayMethodRef(
    path: string,
    arrayRef: unknown[],
    val: unknown,
    method: ArrayMutationMethod,
    ...args: unknown[]
  ): unknown;

  // Queries
  queryArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(path: P, val: PredicateFn<U> | U, method: 'find'): U | undefined;
  queryArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(path: P, val: PredicateFn<U> | U, method: 'findIndex'): number;
  queryArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(path: P, val: PredicateFn<U>, method: 'filter'): U[];
  queryArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never, R = unknown>(path: P, val: MapFn<U, R>, method: 'map'): R[];
  queryArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never, R = unknown>(
    path: P,
    val: ReduceFn<U, R>,
    method: 'reduce',
    initialValue: R
  ): R;
  queryArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(path: P, val: PredicateFn<U>, method: 'some' | 'every'): boolean;
  queryArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(path: P, val: U, method: 'includes'): boolean;
  queryArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(path: P, val: U, method: 'indexOf'): number;
  queryArray<P extends ValidPath<T>>(path: P, _: unknown, method: 'length'): number;
  queryArray(path: string, val: unknown, method: ArrayQueryMethod | 'length', ...args: unknown[]): unknown;

  findInArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(
    path: P, predicate: U extends never ? unknown : PredicateFn<U> | U
  ): U | undefined;
  findIndexInArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(
    path: P, predicate: U extends never ? unknown : PredicateFn<U> | U
  ): number;
  filterArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(path: P, predicate: U extends never ? unknown : PredicateFn<U>): U[];
  mapArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never, R = unknown>(
    path: P, callback: U extends never ? unknown : MapFn<U, R>
  ): R[];
  reduceArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never, R = unknown>(
    path: P, callback: U extends never ? unknown : ReduceFn<U, R>, initialValue: R
  ): R;
  someArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(path: P, predicate: U extends never ? unknown : PredicateFn<U>): boolean;
  everyArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(path: P, predicate: U extends never ? unknown : PredicateFn<U>): boolean;
  includesInArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(path: P, searchElement: U extends never ? unknown : U): boolean;
  indexOfInArray<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(path: P, searchElement: U extends never ? unknown : U): number;
  lengthOfArray<P extends ValidPath<T>>(path: P): number;

  // Item updates
  updateArrayItem<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(path: P, index: number, newValue: U): void;
  updateArrayItemByFind<P extends ValidPath<T>, U = PathValue<T, P> extends readonly (infer V)[] ? V : never>(path: P, predicate: PredicateFn<U> | U, newValue: U): void;
}
