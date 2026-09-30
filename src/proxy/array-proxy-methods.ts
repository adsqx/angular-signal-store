import type { ArrayMutationMethod, ArrayQueryMethod } from '../types/advanced-types';
import { isArrayPath } from '../types/type-guards';
import { buildArrayQueryCacheKey } from '../utils/array-query-key.utils';
import type { ProxyNode } from './proxy-node';
import type { StoreHost } from './store-host';

export type ArrayMemberKind = 'mutation' | 'query' | 'length';

/** Single source of truth for the array members a proxy node exposes; the kind drives dispatch. */
export const ARRAY_MEMBER_KINDS: ReadonlyMap<string, ArrayMemberKind> = new Map<string, ArrayMemberKind>([
  ...(['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort'] as const).map((m) => [m, 'mutation'] as const),
  ...(['find', 'findIndex', 'filter', 'map', 'reduce', 'some', 'every', 'includes', 'indexOf'] as const).map(
    (m) => [m, 'query'] as const
  ),
  ['length', 'length'],
]);

/** A stable per-node method plus, for mutations, the array captured when it was last read. */
export interface BoundMethod {
  readonly handler: (...args: never[]) => unknown;
  arrayRef?: unknown[];
}

/**
 * The array member `key` of `node`, or null when the node's value is not an array (the key
 * then resolves like any other property). Mutation methods are stable per node; query
 * methods are created per access, exactly like the store's array API.
 */
export function resolveArrayMember(node: ProxyNode, kind: ArrayMemberKind, key: string): unknown {
  const targetPath = node.path || key;
  const candidate = node.read(targetPath);
  if (!Array.isArray(candidate)) return null;
  if (kind === 'mutation') return mutationMethod(node, key as ArrayMutationMethod, targetPath, candidate);
  if (kind === 'query') return queryMethod(node, key as ArrayQueryMethod, targetPath);
  return arrayLength(node, targetPath, candidate);
}

/* --------------------------------- mutations -------------------------------- */

type NormalizedArgs = { value: unknown; extra: unknown[] };
type ArgNormalizer = (args: unknown[]) => NormalizedArgs;

const EMPTY_ARGS: unknown[] = [];
const noArgs: ArgNormalizer = () => ({ value: undefined, extra: EMPTY_ARGS });
const singleArg: ArgNormalizer = (args) => ({ value: args[0], extra: EMPTY_ARGS });
const variadicArgs: ArgNormalizer = (args) => ({ value: args[0], extra: args.length <= 1 ? EMPTY_ARGS : args.slice(1) });

const MUTATION_ARGS: Record<ArrayMutationMethod, ArgNormalizer> = {
  splice: (args) => {
    const [start, deleteCount, ...items] = args;
    return { value: { start, deleteCount: args.length > 1 ? deleteCount : undefined, items }, extra: [] };
  },
  push: variadicArgs,
  unshift: variadicArgs,
  sort: singleArg,
  pop: noArgs,
  shift: noArgs,
  reverse: noArgs,
};

function runMutation(
  node: ProxyNode,
  method: ArrayMutationMethod,
  path: string,
  args: unknown[],
  arrayRef: unknown[] | undefined
): unknown {
  const host = node.ctx.host;
  if ((method === 'push' || method === 'unshift') && args.length === 0) {
    const current = arrayRef ?? host.readStore(path);
    return Array.isArray(current) ? current.length : undefined;
  }
  const { value, extra } = MUTATION_ARGS[method](args);
  let result: unknown;
  if (arrayRef && host.setArrayMethodRef) result = host.setArrayMethodRef(path, arrayRef, value, method, ...extra);
  else if (isArrayPath(host, path)) result = host.setArrayMethod(path, value, method, ...extra);
  node.clearChildren();
  return result;
}

function mutationMethod(node: ProxyNode, method: ArrayMutationMethod, path: string, candidate: unknown[]): BoundMethod['handler'] {
  const bound = node.boundMethods();
  let entry = bound[method];
  if (entry === undefined) {
    const created: BoundMethod = {
      arrayRef: candidate,
      handler: function (this: unknown, ...args: unknown[]) {
        // A detached call (`const push = list.push`) has no receiver and takes the validated path.
        const calledAsMethod = this !== undefined && this !== globalThis;
        return runMutation(node, method, path, args, calledAsMethod ? created.arrayRef : undefined);
      },
    };
    bound[method] = entry = created;
  }
  entry.arrayRef = candidate;
  return entry.handler;
}

/* ----------------------------------- queries -------------------------------- */

/** `list.filter(...)` and friends: a memoized computed signal per (path, method, arguments). */
function queryMethod(node: ProxyNode, method: ArrayQueryMethod, path: string): BoundMethod['handler'] | null {
  const { host, service } = node.ctx;
  if (!isArrayPath(host, path)) return null;
  const cache = node.queryCache();
  return (...args: unknown[]) => {
    if (!isArrayPath(host, path)) return undefined;
    const [first, ...rest] = args;
    const cacheKey = buildArrayQueryCacheKey(path, method, first, rest);
    const cached = cache[cacheKey]?.deref();
    if (cached) return cached;

    const result = service.createArrayQueryComputed(path, method, first, ...rest);
    if (result !== undefined) {
      try {
        cache[cacheKey] = new WeakRef(result);
      } catch {
        // environments without WeakRef support: run uncached
      }
    }
    return result;
  };
}

/* ----------------------------------- length --------------------------------- */

function arrayLength(node: ProxyNode, path: string, candidate: unknown[]): number {
  const lengthSignal = node.ctx.service.createArrayQueryComputed(path, 'length', undefined);
  return lengthSignal ? lengthSignal() : candidate.length;
}
