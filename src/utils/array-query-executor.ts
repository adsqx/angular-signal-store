import type {
  ArrayQueryMethod,
  MapFn,
  PredicateFn,
  ReduceFn
} from '../types/advanced-types';

export type ArrayQueryMethodWithLength = ArrayQueryMethod | 'length';
export type ArrayQueryInput<E> = PredicateFn<E> | MapFn<E, unknown> | ReduceFn<E, unknown> | E | undefined;

export interface ArrayQueryExecutorOptions {
  cloneFoundObject?: boolean;
}

/** Coerces a predicate-or-value argument into a predicate (values match by strict equality). */
export function asPredicate<E>(input: ArrayQueryInput<E>): PredicateFn<E> {
  return typeof input === 'function'
    ? (input as PredicateFn<E>)
    : (item: E) => item === (input as E);
}

type ArrayQueryHandler = (
  arrayRef: unknown[],
  input: unknown,
  args: unknown[],
  options: ArrayQueryExecutorOptions
) => unknown;

const handlers: Record<ArrayQueryMethodWithLength, ArrayQueryHandler> = {
  find: (arr, input, _args, options) => {
    const result = arr.find(asPredicate(input));
    return options.cloneFoundObject && result && typeof result === 'object'
      ? { ...(result as Record<string, unknown>) }
      : result;
  },
  findIndex: (arr, input) => arr.findIndex(asPredicate(input)),
  filter: (arr, input) => arr.filter(input as PredicateFn<unknown>),
  map: (arr, input) => arr.map(input as MapFn<unknown, unknown>),
  reduce: (arr, input, args) =>
    args.length > 0
      ? arr.reduce(input as ReduceFn<unknown, unknown>, args[0])
      : arr.reduce(input as ReduceFn<unknown, unknown>),
  some: (arr, input) => arr.some(input as PredicateFn<unknown>),
  every: (arr, input) => arr.every(input as PredicateFn<unknown>),
  includes: (arr, input) => arr.includes(input),
  indexOf: (arr, input) => arr.indexOf(input),
  length: (arr) => arr.length
};

const NO_ARGS: unknown[] = [];
const NO_OPTIONS: ArrayQueryExecutorOptions = {};

export function executeArrayQuery<E>(
  arrayRef: E[],
  method: ArrayQueryMethodWithLength,
  input: ArrayQueryInput<E>,
  args: unknown[] = NO_ARGS,
  options: ArrayQueryExecutorOptions = NO_OPTIONS
): unknown {
  return handlers[method](arrayRef, input, args, options);
}
