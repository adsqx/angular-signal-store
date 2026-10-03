import type { Draft as JsonDraft } from '@adsq/jsnq/core/types';
import type { ProxyCallable } from '../interfaces/types';
import type { IStoreInstance } from '../interfaces/store-instance.interface';
import type { StoreData } from '../types/advanced-types';
import { createCallableProxy } from './proxy-node';
import { asHost, readBranch } from './store-host';
import { applyDelete, applySet, type WritePolicy } from './store-writes';

/** Deep-mutable plain data type of `T`: what `store.$draft` is typed as (functions and primitives as is). */
export type Draft<T> = JsonDraft<T>;

/** What a draft needs: the store's write policy plus the callable proxy of a path (array mutators). */
export interface DraftEnv extends WritePolicy {
  makeChild(path: string): ProxyCallable;
}

const META = new WeakMap<object, { env: DraftEnv; path: string }>();
const ROOTS = new WeakMap<DraftEnv, object>();
const BOUND = new WeakMap<object, () => unknown>();
const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse']);
const REWRITERS = new Set(['fill', 'copyWithin']);
const CACHE_CAP = 1000;

const isPlain = (v: unknown): v is object => {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return Array.isArray(v) || proto === Object.prototype || proto === null;
};

/** A draft proxy becomes the plain value currently at its path; anything else passes through. */
function unwrap(value: unknown): unknown {
  const meta = typeof value === 'object' && value !== null ? META.get(value) : undefined;
  return meta ? readBranch(meta.env.host, meta.path) : value;
}

/** The draft view of a store, rooted at `""` (cached per proxy context). */
export function rootDraft(env: DraftEnv): object {
  let root = ROOTS.get(env);
  if (!root) ROOTS.set(env, (root = new DraftNode(env, '', new Map()).proxyFor('', {})));
  return root;
}

/** Wires a store instance to its proxy's `$draft` (the factory calls this; reading stays lazy). */
export const bindDraft = (instance: object, source: () => unknown): void => void BOUND.set(instance, source);

/** `CreateStore#draft`: the bound proxy's view, or a view over default write semantics. */
export function draftOf<T>(instance: object): Draft<T> {
  const bound = BOUND.get(instance);
  if (bound) return bound() as Draft<T>;
  const host = asHost(instance as IStoreInstance<StoreData>);
  const env: DraftEnv = {
    host,
    strictInvalidPath: false,
    strictDeleteUndefined: false,
    makeChild: (path) => createCallableProxy(path, instance as IStoreInstance<StoreData>),
  };
  return rootDraft(env) as Draft<T>;
}

/**
 * One path of the draft view and its `Proxy` handler. The Proxy target is only an empty array or
 * object (so `Array.isArray` is right); every trap reads the CURRENT value at the path from the
 * store, untracked, and every write goes through the store's own write path.
 */
class DraftNode implements ProxyHandler<object> {
  constructor(readonly env: DraftEnv, readonly path: string, private readonly cache: Map<string, object>) {}

  /** The draft proxy of `path` for the value it holds now (reused while the value keeps its kind). */
  proxyFor(path: string, value: unknown): object {
    const isArray = Array.isArray(value);
    let proxy = this.cache.get(path);
    if (proxy === undefined || Array.isArray(proxy) !== isArray) {
      if (this.cache.size >= CACHE_CAP) this.cache.clear();
      proxy = new Proxy(isArray ? [] : {}, path === this.path ? this : new DraftNode(this.env, path, this.cache));
      META.set(proxy, { env: this.env, path });
      this.cache.set(path, proxy);
    }
    return proxy;
  }

  private raw(target: object): object {
    const value = readBranch(this.env.host, this.path);
    return typeof value === 'object' && value !== null ? value : target;
  }

  private childPath(key: string): string {
    return this.path ? `${this.path}.${key}` : key;
  }

  private wrap(key: string, value: unknown): unknown {
    return isPlain(value) ? this.proxyFor(this.childPath(key), value) : value;
  }

  get(target: object, key: string | symbol, receiver: object): unknown {
    if (typeof key === 'symbol') return Reflect.get(target, key, receiver);
    const raw = this.raw(target);
    if (Array.isArray(target)) {
      if (MUTATORS.has(key)) return (...args: unknown[]) => this.mutate(key, args, receiver);
      if (REWRITERS.has(key)) return (...args: unknown[]) => this.rewrite(key, raw as unknown[], args, receiver);
    }
    return Object.hasOwn(raw, key) ? this.wrap(key, (raw as Record<string, unknown>)[key]) : Reflect.get(target, key, receiver);
  }

  /** Array mutators run on the store's own array methods for this path (precise wakes). */
  private mutate(method: string, args: unknown[], receiver: object): unknown {
    const result = this.arrayApi()[method](...args.map(unwrap));
    return method === 'sort' || method === 'reverse' ? receiver : result;
  }

  private arrayApi(): Record<string, (...args: unknown[]) => unknown> {
    return this.env.makeChild(this.path) as unknown as Record<string, (...args: unknown[]) => unknown>;
  }

  /** `fill` / `copyWithin` have no store method: apply on a copy and assign the array. */
  private rewrite(method: string, raw: unknown[], args: unknown[], receiver: object): object {
    const next = raw.slice();
    (Array.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[method].apply(next, args.map(unwrap));
    applySet(this.env, this.path, next);
    return receiver;
  }

  set(target: object, key: string | symbol, value: unknown): boolean {
    if (typeof key === 'symbol') return false;
    const raw = this.raw(target);
    if (key === 'length' && Array.isArray(raw)) {
      const length = Number(value);
      if (length < raw.length) this.arrayApi().splice(length, raw.length - length);
      else if (length > raw.length) applySet(this.env, this.path, Object.assign(raw.slice(), { length }));
      return true;
    }
    applySet(this.env, this.childPath(key), unwrap(value));
    return true;
  }

  deleteProperty(_target: object, key: string | symbol): boolean {
    if (typeof key === 'symbol') return false;
    applyDelete(this.env, this.childPath(key));
    return true;
  }

  has(target: object, key: string | symbol): boolean {
    return Reflect.has(this.raw(target), key);
  }

  ownKeys(target: object): (string | symbol)[] {
    const keys = Reflect.ownKeys(this.raw(target));
    if (Array.isArray(target) && !keys.includes('length')) keys.push('length'); // target invariant
    return keys;
  }

  getOwnPropertyDescriptor(target: object, key: string | symbol): PropertyDescriptor | undefined {
    const raw = this.raw(target);
    if (Array.isArray(target) && key === 'length') {
      return { value: (raw as unknown[]).length ?? 0, writable: true, enumerable: false, configurable: false };
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(raw, key);
    if (!descriptor) return undefined;
    if (typeof key === 'string' && 'value' in descriptor) descriptor.value = this.wrap(key, descriptor.value);
    descriptor.configurable = true;
    return descriptor;
  }

  defineProperty(target: object, key: string | symbol, descriptor: PropertyDescriptor): boolean {
    return 'value' in descriptor && this.set(target, key, descriptor.value);
  }

  preventExtensions(): boolean {
    return false;
  }
}
