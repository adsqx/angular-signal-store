/** Callable proxies over the immutable core: `node()` reads (tracked), assignment writes, arrays expose their methods. */
import { computed, type Signal } from '@angular/core';
import { getActiveConsumer } from '@angular/core/primitives/signals';
import type { Observable, OperatorFunction } from 'rxjs';
import { isValidDotPath, normalizeDotPath } from '@adsq/jsnq/data-engine';
import { MUTATIONS, QUERIES, arrayOp, runQuery } from './arrays';
import type { StoreCore } from './core';

/** What a proxy tree needs from its store instance. */
export interface ProxyHost {
  readonly core: StoreCore;
  readonly strictInvalidPath: boolean;
  readonly strictDeleteUndefined: boolean;
  set(path: string, value: unknown): void;
  remove(path: string): void;
  arrayMutation(path: string, method: string, args: unknown[]): unknown;
  draft(): unknown;
  member(key: string): unknown;
  apiMethod(key: string, path: string): unknown;
  /** The computed of a proxy path, registered in the store's computed map on first use. */
  signalOf(path: string): Signal<unknown>;
}

export const API_KEYS = new Set(['mutate', '$mutate', 'query', 'pipeline', '$query', '$queryOne', '$liveQuery', '$liveQueryOne']);
const CHILD_CAP = 200;

const stringify = (v: unknown): string => {
  try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch { return String(v); }
};
const toPrimitive = (v: unknown, hint?: string): unknown => {
  if (typeof v !== 'object' && typeof v !== 'function') return v;
  if (hint === 'number') return NaN;
  try { return JSON.stringify(v); } catch { return '[object Object]'; }
};

class Node implements ProxyHandler<object> {
  private children: Record<string, unknown> = Object.create(null);
  private childCount = 0;
  private sig?: Signal<unknown>;
  private methods?: Record<string, unknown>;
  private queries?: Record<string, Signal<unknown>>;

  constructor(readonly host: ProxyHost, readonly path: string, readonly isRoot: boolean) {}

  value(): unknown {
    return (this.sig ??= this.host.signalOf(normalizeDotPath(this.path)))();
  }

  get(target: object, key: string | symbol): unknown {
    if (typeof key === 'symbol') {
      if (this.isRoot) return undefined;
      if (key === Symbol.toPrimitive) return this.method('@prim', () => (hint?: string) => toPrimitive(this.value(), hint));
      return key === Symbol.toStringTag ? Reflect.get(target, key) : undefined;
    }
    const hit = this.children[key];
    return hit !== undefined ? hit : this.miss(key);
  }

  private miss(key: string): unknown {
    const { host, path } = this;
    if (key === '$val') return path ? host.core.read(path) : undefined;
    if (key === '$signal') return path ? host.core.node(normalizeDotPath(path)) : undefined;
    if (key === '$draft' && this.isRoot) return host.draft();
    if (API_KEYS.has(key)) return host.apiMethod(key, path);
    if (!this.isRoot) {
      if (key === 'toString') return this.method(key, () => () => stringify(this.value()));
      if (key === 'valueOf') return this.method(key, () => () => Object(this.value()));
      if (key === 'toJSON') return this.method(key, () => () => this.value());
    } else {
      const member = host.member(key);
      if (member !== undefined) return member;
    }
    if (path && (key === 'pipe' || key === 'subscribe')) return this.rx(key);

    const current = path ? host.core.peek(path) : undefined;
    if (Array.isArray(current)) {
      if (MUTATIONS.has(key)) {
        return this.method(key, () => (...args: unknown[]) =>
          (key === 'push' || key === 'unshift') && args.length === 0
            ? (host.core.peek(path) as unknown[] | undefined)?.length
            : host.arrayMutation(path, key, args));
      }
      if (QUERIES.has(key)) return (...args: unknown[]) => this.query(key, args);
      if (key === 'length') return (this.value() as unknown[] | undefined)?.length ?? current.length;
    }

    const childPath = path ? `${path}.${key}` : key;
    if (host.core.peek(childPath) === undefined) {
      // A reactive read of a missing path still depends on it, so the consumer re-runs once it exists.
      if (getActiveConsumer() !== null && isValidDotPath(childPath)) host.core.node(normalizeDotPath(childPath))();
      return undefined;
    }
    if (this.childCount >= CHILD_CAP) { this.children = Object.create(null); this.childCount = 0; }
    this.childCount++;
    return (this.children[key] = createNode(host, childPath));
  }

  /** Stable per node, so detached calls (`const push = list.push`) keep working. */
  private method(key: string, make: () => unknown): unknown {
    const methods = (this.methods ??= Object.create(null) as Record<string, unknown>);
    return (methods[key] ??= make());
  }

  /** `list.filter(fn)`: a memoized computed per (method, arguments). */
  private query(method: string, args: unknown[]): Signal<unknown> {
    const key = method + '|' + args.map((a) => (typeof a === 'function' ? a.toString() : stringify(a))).join('|');
    const queries = (this.queries ??= Object.create(null) as Record<string, Signal<unknown>>);
    return (queries[key] ??= computed(() => {
      const result = runQuery(this.value(), method, args[0], args.slice(1));
      return method === 'find' && result && typeof result === 'object' ? { ...(result as object) } : result;
    }));
  }

  private rx(key: 'pipe' | 'subscribe'): unknown {
    return this.method(key, () => {
      const source = () => this.host.core.subject(normalizeDotPath(this.path)).asObservable();
      return key === 'pipe'
        ? (...ops: OperatorFunction<unknown, unknown>[]) => ops.reduce<Observable<unknown>>((acc, op) => acc.pipe(op), source())
        : (...args: Parameters<Observable<unknown>['subscribe']>) => source().subscribe(...args);
    });
  }

  set(_target: object, key: string | symbol, value: unknown): boolean {
    if (typeof key === 'symbol') return false;
    const path = this.path ? `${this.path}.${key}` : key;
    if (value === undefined) {
      this.host.remove(path);
      if (this.children[key] !== undefined) { delete this.children[key]; this.childCount--; }
    } else {
      this.host.set(path, value);
    }
    return true;
  }

  deleteProperty(_target: object, key: string | symbol): boolean {
    if (typeof key === 'symbol') return false;
    this.host.remove(this.path ? `${this.path}.${key}` : key);
    if (this.children[key] !== undefined) { delete this.children[key]; this.childCount--; }
    return true;
  }
}

export function createNode(host: ProxyHost, path: string): unknown {
  const node = new Node(host, path, false);
  const { callable } = { callable: (): unknown => node.value() };
  return new Proxy(callable, node);
}

export function createRoot(host: ProxyHost): unknown {
  return new Proxy({}, new Node(host, '', true));
}
