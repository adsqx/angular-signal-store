/** `$draft`: a plain-JSON write view. Reads are untracked; writes and array mutators go through the store. */
import { isObj, type StoreCore } from './core';

const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse']);
const REWRITERS = new Set(['fill', 'copyWithin']);
const VIEWS = new WeakMap<object, string>(); // draft proxy -> its path

export interface DraftHost {
  readonly core: StoreCore;
  set(path: string, value: unknown): void;
  remove(path: string): void;
  arrayMutation(path: string, method: string, args: unknown[]): unknown;
}

/** A draft proxy becomes the (immutable, so shareable) value currently at its path. */
const unwrap = (host: DraftHost, value: unknown): unknown => {
  const path = isObj(value) ? VIEWS.get(value) : undefined;
  return path === undefined ? value : host.core.read(path);
};

export function draftView(host: DraftHost, path: string, cache: Map<string, object>): unknown {
  const value = path ? host.core.read(path) : host.core.data;
  if (!isObj(value)) return value;
  const array = Array.isArray(value);
  let proxy = cache.get(path);
  if (!proxy || Array.isArray(proxy) !== array) {
    if (cache.size > 1000) cache.clear();
    proxy = new Proxy(array ? [] : {}, handler(host, path, cache));
    VIEWS.set(proxy, path);
    cache.set(path, proxy);
  }
  return proxy;
}

function handler(host: DraftHost, path: string, cache: Map<string, object>): ProxyHandler<object> {
  const child = (key: string) => (path ? `${path}.${key}` : key);
  const raw = (target: object): object => {
    const value = path ? host.core.read(path) : host.core.data;
    return isObj(value) ? value : target;
  };
  const h: ProxyHandler<object> = {
    get(target, key, receiver) {
      if (typeof key === 'symbol') return Reflect.get(target, key, receiver);
      const cur = raw(target);
      if (Array.isArray(target)) {
        if (MUTATORS.has(key)) {
          return (...args: unknown[]) => {
            const result = host.arrayMutation(path, key, args.map((a) => unwrap(host, a)));
            return key === 'sort' || key === 'reverse' ? receiver : result;
          };
        }
        if (REWRITERS.has(key)) {
          return (...args: unknown[]) => {
            const next = (cur as unknown[]).slice();
            (Array.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[key].apply(next, args.map((a) => unwrap(host, a)));
            host.set(path, next);
            return receiver;
          };
        }
      }
      return Object.hasOwn(cur, key) ? draftView(host, child(key), cache) : Reflect.get(target, key, receiver);
    },
    set(target, key, value) {
      if (typeof key === 'symbol') return false;
      const cur = raw(target);
      if (key === 'length' && Array.isArray(cur)) {
        const length = Number(value);
        if (length < cur.length) host.arrayMutation(path, 'splice', [length, cur.length - length]);
        else if (length > cur.length) host.set(path, Object.assign(cur.slice(), { length }));
        return true;
      }
      host.set(child(key), unwrap(host, value));
      return true;
    },
    deleteProperty(_target, key) {
      if (typeof key === 'symbol') return false;
      host.remove(child(key));
      return true;
    },
    has: (target, key) => Reflect.has(raw(target), key),
    ownKeys(target) {
      const keys = Reflect.ownKeys(raw(target));
      if (Array.isArray(target) && !keys.includes('length')) keys.push('length');
      return keys;
    },
    getOwnPropertyDescriptor(target, key) {
      const cur = raw(target);
      if (Array.isArray(target) && key === 'length') {
        return { value: (cur as unknown[]).length ?? 0, writable: true, enumerable: false, configurable: false };
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(cur, key);
      if (!descriptor) return undefined;
      if (typeof key === 'string' && 'value' in descriptor) descriptor.value = draftView(host, child(key), cache);
      descriptor.configurable = true;
      return descriptor;
    },
    defineProperty: (target, key, descriptor) => 'value' in descriptor && h.set!(target, key, descriptor.value, target),
    preventExtensions: () => false,
  };
  return h;
}
