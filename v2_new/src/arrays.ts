/** Array mutations and queries over the immutable core: a mutation edits an owned copy of the array. */
import type { StoreCore } from './core';
import { segmentsOf } from './core';

export type Predicate = (item: unknown, index: number, array: unknown[]) => unknown;
export const asPredicate = (input: unknown): Predicate =>
  typeof input === 'function' ? (input as Predicate) : (item) => item === input;

export const MUTATIONS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort']);
export const QUERIES = new Set(['find', 'findIndex', 'filter', 'map', 'reduce', 'some', 'every', 'includes', 'indexOf']);

/** Runs a native array method on an owned copy of the array at `path`; undefined when it holds no array. */
export function arrayOp(core: StoreCore, path: string, method: string, args: unknown[]): unknown {
  if (!Array.isArray(core.peek(path))) return undefined;
  let result: unknown;
  core.update(segmentsOf(path), (current) => {
    const copy = core.own(current as unknown[]);
    result = (copy as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args);
    return copy;
  });
  return result;
}

const QUERY_RUN: Record<string, (arr: unknown[], input: unknown, extra: unknown[]) => unknown> = {
  find: (a, i) => a.find(asPredicate(i)),
  findIndex: (a, i) => a.findIndex(asPredicate(i)),
  filter: (a, i) => a.filter(asPredicate(i)),
  map: (a, i) => a.map(i as Predicate),
  reduce: (a, i, x) => (x.length ? a.reduce(i as never, x[0]) : a.reduce(i as never)),
  some: (a, i) => a.some(asPredicate(i)),
  every: (a, i) => a.every(asPredicate(i)),
  includes: (a, i) => a.includes(i),
  indexOf: (a, i) => a.indexOf(i),
  length: (a) => a.length,
};

/** `method` over `array` (the store's queryArray semantics). */
export function runQuery(array: unknown, method: string, input: unknown, extra: unknown[] = []): unknown {
  if (!Array.isArray(array)) return method === 'length' ? 0 : method === 'filter' || method === 'map' ? [] : undefined;
  return QUERY_RUN[method]!(array, input, extra);
}

/** Store-API argument forms of setArrayMethod: (val, 'push', ...more) / ({start, deleteCount, items}, 'splice') / ('pop'). */
export function nativeArgs(method: string, val: unknown, extra: unknown[]): unknown[] {
  if (method === 'push' || method === 'unshift') return [val, ...extra];
  if (method === 'sort') return val === undefined ? [] : [val];
  if (method === 'splice') {
    const op = val as { start: number; deleteCount?: number; items?: unknown[] };
    if (!op || typeof op !== 'object' || !('start' in op)) throw new Error('Invalid splice operation payload');
    return op.deleteCount === undefined ? [op.start] : [op.start, op.deleteCount, ...(op.items ?? [])];
  }
  return [];
}
