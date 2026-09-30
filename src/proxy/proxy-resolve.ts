import type { Observable, OperatorFunction } from 'rxjs';
import { PathUtils } from '../utils/path-utils';
import { ARRAY_MEMBER_KINDS, resolveArrayMember, type ArrayMemberKind, type BoundMethod } from './array-proxy-methods';
import { createProxyApiMethod, PROXY_API_KEYS } from './pipeline';
import type { CoercionKey, ProxyNode } from './proxy-node';

type SpecialKind = 'value' | 'signal' | 'api' | 'rx' | Exclude<CoercionKey, symbol> | ArrayMemberKind;

/** Every property name a node answers itself, looked up once per cache miss. */
const SPECIAL: ReadonlyMap<string, SpecialKind> = new Map<string, SpecialKind>([
  ['$val', 'value'],
  ['$signal', 'signal'],
  ...PROXY_API_KEYS.map((key) => [key, 'api'] as const),
  ['pipe', 'rx'],
  ['subscribe', 'rx'],
  ['toString', 'toString'],
  ['valueOf', 'valueOf'],
  ['toJSON', 'toJSON'],
  ...ARRAY_MEMBER_KINDS,
]);

/**
 * The cold half of the `get` trap: property `key` is not in the node's child cache.
 * Order matters and mirrors the historical handler: helper values, jsnq surface, coercions,
 * store members (root only), rxjs, array members, and finally the child proxy itself.
 */
export function resolveMiss(node: ProxyNode, key: string): unknown {
  const kind = SPECIAL.get(key);
  switch (kind) {
    case 'value':
    case 'signal':
      return helperValue(node, kind);
    case 'api':
      return createProxyApiMethod(key, node.ctx.host, node.path);
    case 'toString':
    case 'valueOf':
    case 'toJSON':
      // The root has no value to coerce: it resolves these like any other key.
      if (!node.isRoot) return node.coercion(kind);
  }

  const { host, throwOnRootRxjs } = node.ctx;
  if (node.isRoot) {
    const member = host[key];
    if (typeof member === 'function') return member.bind(host);
  }

  if (kind === 'rx') {
    // A pathless (root) node never binds rxjs methods: the key resolves as a plain property.
    if (node.path) return rxMethod(node, key === 'pipe' ? 'pipe' : 'subscribe');
    if (throwOnRootRxjs) throw new Error(`RxJS method '${key}' is not allowed on root proxy in strict mode`);
  } else if (kind === 'mutation' || kind === 'query' || kind === 'length') {
    const member = resolveArrayMember(node, kind, key);
    if (member != null) return member;
  }

  const path = node.childPath(key);
  if (node.read(path) === undefined) return undefined;
  const child = node.ctx.makeChild(path);
  node.remember(key, child);
  return child;
}

/** `node.$val` / `node.$signal`: the plain (untracked) value or computed of the node's own path. */
function helperValue(node: ProxyNode, kind: 'value' | 'signal'): unknown {
  const { path } = node;
  if (!path || !PathUtils.isValidPath(path)) return undefined;
  return kind === 'value' ? node.ctx.host.readStore(path) : node.ctx.host.getComputed(path);
}

type SubscribeArgs = Parameters<Observable<unknown>['subscribe']>;

/** `pipe` / `subscribe` bound to the node's path; the function is stable per node. */
function rxMethod(node: ProxyNode, method: 'pipe' | 'subscribe'): BoundMethod['handler'] {
  const bound = node.boundMethods();
  let entry = bound.get(method);
  if (entry === undefined) {
    const { service } = node.ctx;
    const path = node.path;
    let fn: BoundMethod['handler'];
    if (method === 'pipe') {
      fn = (...operators: OperatorFunction<unknown, unknown>[]) =>
        service.getObservableWithPipe(path, (obs) => operators.reduce((acc, op) => acc.pipe(op), obs));
    } else {
      fn = (...args: SubscribeArgs) => service.getTrackedObservable(path).subscribe(...args);
    }
    entry = { handler: fn };
    bound.set(method, entry);
  }
  return entry.handler;
}
