// src/app/store/types/advanced-types.ts

// Advanced TypeScript types for type-safe store operations.
// These types provide compile-time safety for path-based operations.

// Helper types for path construction. Path unions must stay bounded for TS performance;
// PathValue below resolves concrete string literals independently from this autocomplete depth.
type PrevDepth = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
type Prev<Depth extends number> = Depth extends keyof PrevDepth ? PrevDepth[Depth] : never;

type ArrayPathKeys<T, Depth extends number> = T extends readonly (infer U)[]
  ? U extends Record<PropertyKey, unknown>
    ? `${number}` | `${number}.${PathKeys<U, Prev<Depth>>}`
    : `${number}`
  : never;

type ObjectPathKeys<T, Depth extends number> = T extends Record<PropertyKey, unknown>
  ? {
      [K in keyof T]: K extends string | number
        ? T[K] extends Record<PropertyKey, unknown> | readonly unknown[]
          ? `${K}` | `${K}.${PathKeys<T[K], Prev<Depth>>}`
          : `${K}`
        : never;
    }[keyof T]
  : never;

// Enhanced deep object key paths with better type safety
export type PathKeys<T, Depth extends number = 12> = [Depth] extends [never]
  ? never
  : Depth extends 0
  ? never
  : ArrayPathKeys<T, Depth> | ObjectPathKeys<T, Depth>;

// Strict path type that enforces exact path matching
export type StrictPath<T> = T extends Record<string, unknown>
  ? {
      [K in keyof T]: K extends string
        ? T[K] extends Record<string, unknown>
          ? T[K] extends readonly unknown[]
            ? `${K}` | `${K}.${number}` | `${K}.${number}.${StrictPath<T[K][number]>}`
            : `${K}` | `${K}.${StrictPath<T[K]>}`
          : T[K] extends readonly unknown[]
            ? `${K}` | `${K}.${number}`
            : `${K}`
        : never
    }[keyof T]
  : string;

// Enhanced path value extraction with better type inference
export type PathValue<T, P extends string> = P extends `${infer Key}.${infer Rest}`
  ? Key extends keyof NonNullable<T>
    ? PathValue<NonNullable<T>[Key], Rest>
    : Key extends `${number}`
      ? NonNullable<T> extends readonly (infer U)[]
        ? PathValue<U, Rest>
        : unknown
      : unknown
  : P extends keyof NonNullable<T>
    ? NonNullable<T>[P]
    : P extends `${number}`
      ? NonNullable<T> extends readonly (infer U)[]
        ? U
        : unknown
      : unknown;

// Safe path validation
export type ValidPath<T> = PathKeys<T> | string;

// Array operation types with strict typing
export type ArrayElement<T> = T extends readonly (infer U)[] ? U : never;

// Array method categories for better organization
export type ArrayMutationMethod = 'push' | 'pop' | 'shift' | 'unshift' | 'splice' | 'reverse' | 'sort';
export type ArrayQueryMethod = 'find' | 'findIndex' | 'filter' | 'map' | 'reduce' | 'some' | 'every' | 'includes' | 'indexOf';
export type ArrayMethod = ArrayMutationMethod | ArrayQueryMethod;

// Helper types for array operation results
type QueryMethodResult<T, M extends ArrayQueryMethod> = M extends 'find' ? T | undefined
  : M extends 'findIndex' | 'indexOf' ? number
  : M extends 'filter' | 'map' ? T[]
  : M extends 'some' | 'every' | 'includes' ? boolean
  : M extends 'reduce' ? unknown
  : never;

type MutationMethodResult<T, M extends ArrayMutationMethod> = M extends 'push' | 'unshift' ? number
  : M extends 'pop' | 'shift' ? T | undefined
  : M extends 'splice' ? T[]
  : M extends 'reverse' | 'sort' ? T[]
  : never;

// Predicate function types
export type PredicateFn<T> = (item: T, index: number, array: T[]) => boolean;
export type MapFn<T, R> = (item: T, index: number, array: T[]) => R;
export type ReduceFn<T, R> = (accumulator: R, currentValue: T, currentIndex: number, array: T[]) => R;

// Enhanced array operation interfaces
export interface ArrayOperationResult<T, M extends ArrayMethod> {
  method: M;
  success: boolean;
  result: M extends ArrayQueryMethod
    ? QueryMethodResult<T, M>
    : M extends ArrayMutationMethod
      ? MutationMethodResult<T, M>
      : unknown;
}

// Splice operation specific types
export interface SpliceOperation {
  start: number;
  deleteCount?: number;
  items: unknown[];
}

// Observable and Signal types (re-export for convenience)
export type ObservableType<T> = import('rxjs').Observable<T>;
export type SignalType<T> = import('@angular/core').Signal<T>;
export type BehaviorSubjectType<T> = import('rxjs').BehaviorSubject<T>;

// Store instance constraint
export type StoreData = Record<string, unknown>;

// Helper type for function detection
type IsFunction<T> = T extends (...args: unknown[]) => unknown ? true : false;

// Type for callable proxy
export type CallableProxy<T> = T & {
  (): T;
} & {
  [K in keyof T]: IsFunction<T[K]> extends true ? T[K] : CallableProxy<T[K]>;
};
