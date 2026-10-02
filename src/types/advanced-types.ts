// Path-based types for type-safe store operations. Path unions must stay bounded for TS performance;
// PathValue resolves concrete string literals independently from this autocomplete depth.
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

export type PathKeys<T, Depth extends number = 12> = [Depth] extends [never]
  ? never
  : Depth extends 0
  ? never
  : ArrayPathKeys<T, Depth> | ObjectPathKeys<T, Depth>;

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

export type ValidPath<T> = PathKeys<T> | string;

export type ArrayElement<T> = T extends readonly (infer U)[] ? U : never;

export type ArrayMutationMethod = 'push' | 'pop' | 'shift' | 'unshift' | 'splice' | 'reverse' | 'sort';
export type ArrayQueryMethod = 'find' | 'findIndex' | 'filter' | 'map' | 'reduce' | 'some' | 'every' | 'includes' | 'indexOf';
export type ArrayMethod = ArrayMutationMethod | ArrayQueryMethod;

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

export type PredicateFn<T> = (item: T, index: number, array: T[]) => boolean;
export type MapFn<T, R> = (item: T, index: number, array: T[]) => R;
export type ReduceFn<T, R> = (accumulator: R, currentValue: T, currentIndex: number, array: T[]) => R;

export interface ArrayOperationResult<T, M extends ArrayMethod> {
  method: M;
  success: boolean;
  result: M extends ArrayQueryMethod
    ? QueryMethodResult<T, M>
    : M extends ArrayMutationMethod
      ? MutationMethodResult<T, M>
      : unknown;
}

export interface SpliceOperation {
  start: number;
  deleteCount?: number;
  items: unknown[];
}

// Observable and Signal types (re-exported for convenience)
export type ObservableType<T> = import('rxjs').Observable<T>;
export type SignalType<T> = import('@angular/core').Signal<T>;
export type BehaviorSubjectType<T> = import('rxjs').BehaviorSubject<T>;

export type StoreData = Record<string, unknown>;

type IsFunction<T> = T extends (...args: unknown[]) => unknown ? true : false;

/** An array element test: a predicate, or a value compared with `===`. */
type ElementTest<E> = ((value: E, index: number, array: E[]) => unknown) | E;

/**
 * The query methods of an array node return a reactive signal of the result (not the result itself):
 * `store.items.filter(fn)()` reads it and re-runs its consumer when the array changes.
 */
export interface ArrayQueryProxy<E> {
  filter(test: ElementTest<E>): SignalType<E[]>;
  find(test: ElementTest<E>): SignalType<E | undefined>;
  findIndex(test: ElementTest<E>): SignalType<number>;
  some(test: ElementTest<E>): SignalType<boolean>;
  every(test: ElementTest<E>): SignalType<boolean>;
  map<U>(fn: (value: E, index: number, array: E[]) => U): SignalType<U[]>;
  reduce<U>(fn: (accumulator: U, value: E, index: number, array: E[]) => U, initial: U): SignalType<U>;
  includes(value: E): SignalType<boolean>;
  indexOf(value: E): SignalType<number>;
}

type ArrayQueryKey = keyof ArrayQueryProxy<unknown>;

/** Present on every node: `$val` is the plain (untracked) value, `$signal` its computed signal. */
interface NodeHelpers<T> {
  readonly $val: T;
  readonly $signal: SignalType<T>;
}

/** Arrays keep their element/mutation surface but expose the query methods as signal factories. */
type CallableArray<T extends readonly unknown[]> = Omit<T, ArrayQueryKey> & ArrayQueryProxy<T[number]> & NodeHelpers<T> & {
  (): T;
} & {
  [K in Exclude<keyof T, ArrayQueryKey>]: IsFunction<T[K]> extends true ? T[K] : CallableProxy<T[K]>;
};

export type CallableProxy<T> = T extends readonly unknown[]
  ? CallableArray<T>
  : T & NodeHelpers<T> & {
      (): T;
    } & {
      [K in keyof T]: IsFunction<T[K]> extends true ? T[K] : CallableProxy<T[K]>;
    };
