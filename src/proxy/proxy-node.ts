import type { Signal } from '@angular/core';
import type { CreateStoreService } from '../core/create-store.core';
import type { IStoreInstance } from '../interfaces/store-instance.interface';
import type { ProxyCallable } from '../interfaces/types';
import type { StoreData } from '../types/advanced-types';
import { PathUtils } from '../utils/path-utils';
import type { BoundMethod } from './array-proxy-methods';
import { resolveMiss } from './proxy-resolve';
import { asHost, serviceOf } from './store-host';
import { applyDelete, applySet, type WritePolicy } from './store-writes';

/** Store-wide state shared by every node of one proxy tree. */
export interface ProxyContext extends WritePolicy {
  readonly service: CreateStoreService;
  /** Strict mode: `pipe` / `subscribe` on the root proxy throw instead of resolving as plain keys. */
  readonly throwOnRootRxjs: boolean;
  /** Builds (and, for the store proxy, caches) the callable proxy of a child path. */
  readonly makeChild: (path: string) => ProxyCallable;
  /** Value at a root-level path. */
  readonly readRoot: (path: string) => unknown;
}

type Coercion = (hint?: string) => unknown;
export type CoercionKey = 'toString' | 'valueOf' | 'toJSON' | typeof Symbol.toPrimitive;

/** Above this many cached children a node drops its child cache before adding another. */
const CHILD_CACHE_CAP = 200;

/** Prototype-less string-keyed record: the cheapest lookup table on the hot path (no `__proto__` keys to guard). */
type Dict<V> = Record<string, V | undefined>;
const newDict = <V>(): Dict<V> => Object.create(null);

// Coercion semantics, shared by every node (a node only adds the value to read).
const stringify = (v: unknown): unknown => {
  try {
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
};
const toPrimitive = (v: unknown, hint?: string): unknown => {
  if (typeof v === 'object' || typeof v === 'function') {
    if (hint === 'number') return NaN;
    try {
      return JSON.stringify(v);
    } catch {
      return '[object Object]';
    }
  }
  return v;
};
const COERCIONS: Record<CoercionKey, (node: ProxyNode) => Coercion> = {
  toString: (node) => () => stringify(node.readValue()),
  valueOf: (node) => () => Object(node.readValue()),
  toJSON: (node) => () => node.readValue(),
  [Symbol.toPrimitive]: (node) => (hint?: string) => toPrimitive(node.readValue(), hint),
};

/**
 * One node of the proxy tree, and at the same time its `Proxy` handler: the per-node state
 * lives here, the trap logic on the shared prototype. The hot path is the `get` trap
 * (symbol check, child-cache hit); everything else is `resolveMiss`.
 */
export class ProxyNode implements ProxyHandler<object> {
  /** Child proxies handed out so far (strong, capped at `CHILD_CACHE_CAP`). */
  private children: Dict<ProxyCallable> | undefined = undefined;
  private childCount = 0;
  private bound: Dict<BoundMethod> | undefined = undefined;
  private queries: Dict<WeakRef<object>> | undefined = undefined;
  private coercions: Partial<Record<CoercionKey, Coercion>> | undefined = undefined;
  private signalRef: Signal<unknown> | undefined = undefined;
  private normalizedPath: string | undefined = undefined;
  private helpersDefined = false;

  constructor(
    readonly ctx: ProxyContext,
    /** Path of this node ("" for the root). */
    readonly path: string,
    readonly isRoot: boolean
  ) {}

  /* --------------------------------- traps --------------------------------- */

  get(target: object, key: string | symbol): unknown {
    if (typeof key === 'symbol') {
      // The root serves no symbols; a callable node serves its coercion hook and the bare target's tag.
      if (this.isRoot) return undefined;
      if (key === Symbol.toPrimitive) return this.coercion(Symbol.toPrimitive);
      return key === Symbol.toStringTag ? Reflect.get(target, key) : undefined;
    }
    const hit = this.children?.[key];
    return hit !== undefined ? hit : resolveMiss(this, key);
  }

  set(_target: object, key: string | symbol, value: unknown): boolean {
    if (typeof key === 'symbol') return false;
    applySet(this.ctx, this.childPath(key), value);
    if (value === undefined) this.forget(key);
    return true;
  }

  deleteProperty(_target: object, key: string | symbol): boolean {
    if (typeof key === 'symbol') return false;
    applyDelete(this.ctx, this.childPath(key));
    this.forget(key);
    return true;
  }

  // `$val` / `$signal` exist on the callable as accessors, but only reflection can see
  // them (the `get` trap answers those keys itself), so they are defined on first reflection.
  has(target: object, key: string | symbol): boolean {
    this.defineHelpers(target);
    return Reflect.has(target, key);
  }

  ownKeys(target: object): (string | symbol)[] {
    this.defineHelpers(target);
    return Reflect.ownKeys(target);
  }

  getOwnPropertyDescriptor(target: object, key: string | symbol): PropertyDescriptor | undefined {
    this.defineHelpers(target);
    return Reflect.getOwnPropertyDescriptor(target, key);
  }

  defineProperty(target: object, key: string | symbol, descriptor: PropertyDescriptor): boolean {
    this.defineHelpers(target);
    return Reflect.defineProperty(target, key, descriptor);
  }

  preventExtensions(target: object): boolean {
    this.defineHelpers(target);
    return Reflect.preventExtensions(target);
  }

  private defineHelpers(target: object): void {
    if (this.helpersDefined || this.isRoot) return;
    this.helpersDefined = true;
    Object.defineProperties(target, {
      $signal: { get: () => this.signal(), enumerable: false, configurable: true },
      $val: { get: () => this.readValue(), enumerable: false, configurable: true },
    });
  }

  /* ---------------------------------- state --------------------------------- */

  childPath(key: string): string {
    return this.path ? `${this.path}.${key}` : key;
  }

  /** Current value at `path`, read the way this node kind reads. */
  read(path: string): unknown {
    return this.isRoot ? this.ctx.readRoot(path) : PathUtils.getByPath(this.ctx.host.returnStore(), path);
  }

  /** Caches a freshly built child (`key` is not cached yet); a full cache is dropped first. */
  remember(key: string, child: ProxyCallable): void {
    if (this.children === undefined || this.childCount > CHILD_CACHE_CAP) {
      this.children = newDict();
      this.childCount = 0;
    }
    this.children[key] = child;
    this.childCount++;
  }

  private forget(key: string): void {
    const children = this.children;
    if (children !== undefined && children[key] !== undefined) {
      delete children[key];
      this.childCount--;
    }
  }

  clearChildren(): void {
    this.children = undefined;
    this.childCount = 0;
  }

  boundMethods(): Dict<BoundMethod> {
    return (this.bound ??= newDict());
  }

  queryCache(): Dict<WeakRef<object>> {
    return (this.queries ??= newDict());
  }

  /** The coercion function for `key`; stable per node, so detached calls keep working. */
  coercion(key: CoercionKey): Coercion {
    const cache: Partial<Record<CoercionKey, Coercion>> = (this.coercions ??= Object.create(null));
    return (cache[key] ??= COERCIONS[key](this));
  }

  /** The computed signal of this node's path, resolved once. */
  signal(): Signal<unknown> | undefined {
    if (this.signalRef) return this.signalRef;
    const { service, host } = this.ctx;
    const fast = service.getSignalFromProxyCache(this.path);
    if (fast) return (this.signalRef = fast);
    const signal = (this.signalRef = host.getComputed(this.path));
    if (signal) service.setSignalInProxyCache(this.path, signal);
    return signal;
  }

  /** Reads the value as a reactive dependency of the running computation, if any. */
  readValue(): unknown {
    const service = this.ctx.service;
    if (service.isCollectingReads()) {
      service.registerReadNormalized((this.normalizedPath ??= PathUtils.normalizePath(this.path)));
    }
    const signal = this.signalRef ?? this.signal();
    return signal ? signal() : undefined;
  }
}

/** The callable proxy of `path`: `proxy()` reads the value, property access descends. */
export function createNodeProxy(ctx: ProxyContext, path: string): ProxyCallable {
  const node = new ProxyNode(ctx, path, false);
  // Property-name inference keeps the historical `callable` name on every toolchain.
  const { callable } = { callable: (): unknown => node.readValue() };
  return new Proxy(callable, node) as unknown as ProxyCallable;
}

/** The store proxy: an object (not callable) whose keys resolve to the callable children. */
export function createRootProxy(ctx: ProxyContext): object {
  return new Proxy({}, new ProxyNode(ctx, '', true));
}

/**
 * Standalone callable proxy for `nestedPath` of a store instance (children are not cached
 * store-wide and writes take the validated handler path).
 */
export function createCallableProxy(
  nestedPath: string,
  storeInstance: IStoreInstance<StoreData>,
  _nestedValue?: unknown
): ProxyCallable<unknown> {
  const host = asHost(storeInstance);
  const ctx: ProxyContext = {
    host,
    service: serviceOf(host),
    strictInvalidPath: false,
    strictDeleteUndefined: false,
    throwOnRootRxjs: false,
    makeChild: (path) => createNodeProxy(ctx, path),
    readRoot: (path) => PathUtils.getByPath(host.returnStore(), path),
  };
  return createNodeProxy(ctx, nestedPath);
}
