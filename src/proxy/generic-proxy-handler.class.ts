import { BaseProxyHandler } from './base-proxy-handler.abstract';
import { IStoreInstance } from '../interfaces/store-instance.interface';
import { StoreData } from '../types/advanced-types';
import type { ProxyCallable } from '../interfaces/types';
import { createProxyApiMethod } from './pipeline';
import { asHost, type StoreHost } from './store-host';
import { directDeleteValue, directSetValue, rejectUndefinedWrite } from './store-writes';

interface GenericHandlerOptions {
  /** Path prefix representing the current depth ("" for root). */
  pathPrefix: string;
  /** Should the proxy expose methods that live directly on the store instance? */
  exposeStoreMethods: boolean;
  /** Original value found at path – needed for correct array-method handling. */
  originalNestedValue?: unknown;
  /** Resolver responsible for returning the up-to-date value for any path. */
  resolveFn: (path: string) => unknown;
  /** Factory used to build deeper callable proxies. */
  nestedProxyFactory: (path: string, value: unknown) => ProxyCallable<unknown>;
  /** If false, pipe/subscribe are blocked (root level behaviour). */
  rxjsAllowedOnRoot?: boolean;
  /** Strict mode: throw on invalid path usage instead of warn. */
  strictInvalidPath?: boolean;
  /** Strict mode: throw when pipe/subscribe used on root. */
  strictRootRxjs?: boolean;
  /** Strict mode: throw when deleting (setting undefined) without explicit allowance. */
  strictDeleteUndefined?: boolean;
  /** Custom setter/deleter/cleanup hooks (root uses them). */
  setFn?: (path: string, value: unknown) => void;
  deleteFn?: (path: string) => void;
  cleanupFn?: () => void;
}

type RootRxJSMethod = 'pipe' | 'subscribe';
type ArrayMutationMethodCacheEntry = { handler: Function; arrayRef: unknown[] };

export class GenericProxyHandler<T extends StoreData = StoreData> extends BaseProxyHandler<T> {
  private readonly host: StoreHost;
  /** Path of this proxy node ("" for root). */
  private readonly prefix: string;
  // Per-proxy cache for array query computed signals (WeakRef to allow GC) – flat JSON map
  private readonly arrayQueryCache: Record<string, WeakRef<object> | undefined> = Object.create(null);
  private readonly arrayMutationMethodCache: Record<string, ArrayMutationMethodCacheEntry | undefined> = Object.create(null);
  // Strong nested cache per level to speed up repeated child gets – flat JSON map
  private readonly nestedCache: Record<string, unknown> = Object.create(null);
  private nestedCacheSize = 0;

  constructor(
    storeInstance: IStoreInstance<T>,
    private readonly options: GenericHandlerOptions
  ) {
    super(storeInstance);
    this.host = asHost(storeInstance);
    this.prefix = options.pathPrefix;
  }

  private clearNestedCache(): void {
    for (const key in this.nestedCache) {
      delete this.nestedCache[key];
    }
    this.nestedCacheSize = 0;
  }

  private deleteNestedCacheKey(key: string): void {
    if (Object.prototype.hasOwnProperty.call(this.nestedCache, key)) {
      delete this.nestedCache[key];
      this.nestedCacheSize--;
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                       BaseProxyHandler abstract impl                       */
  /* -------------------------------------------------------------------------- */
  protected constructPath(key: string): string {
    return this.prefix ? `${this.prefix}.${key}` : key;
  }

  protected resolveValue(path: string): unknown {
    return this.options.resolveFn(path);
  }

  protected createNestedProxy(path: string, value: unknown): unknown {
    return this.options.nestedProxyFactory(path, value);
  }

  protected handleStoreInstanceMethods(keyStr: string): Function | null {
    const proxyApiMethod = createProxyApiMethod(keyStr, this.host, this.prefix);
    if (proxyApiMethod) {
      return proxyApiMethod;
    }

    if (!this.options.exposeStoreMethods) {
      return null;
    }
    const member = this.storeInstance[keyStr];
    return typeof member === 'function' ? member.bind(this.storeInstance) : null;
  }

  protected setValue(path: string, value: unknown): void {
    const { setFn, strictDeleteUndefined, strictInvalidPath } = this.options;
    if (value === undefined && strictDeleteUndefined) rejectUndefinedWrite(path);
    if (setFn) setFn(path, value);
    else directSetValue(this.host, path, value, strictInvalidPath);
  }

  protected deleteValue(path: string): void {
    const { deleteFn, strictDeleteUndefined, strictInvalidPath } = this.options;
    // A dedicated deleteFn is trusted to perform safe cleanup, even in strict mode.
    if (deleteFn) deleteFn(path);
    else directDeleteValue(this.host, path, strictInvalidPath, strictDeleteUndefined);
  }

  protected performCleanup(): void {
    if (this.options.cleanupFn) {
      this.options.cleanupFn();
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                          Special-case method hooks                          */
  /* -------------------------------------------------------------------------- */
  protected override resolveRxJSPath(keyStr: string, path: string): string | null {
    return (keyStr === 'pipe' || keyStr === 'subscribe')
      ? this.resolveRootRxJSPath(keyStr)
      : path;
  }

  private resolveRootRxJSPath(keyStr: RootRxJSMethod): string | null {
    if (this.options.rxjsAllowedOnRoot === false) {
      if (this.options.strictRootRxjs) {
        throw new Error(`RxJS method '${keyStr}' is not allowed on root proxy in strict mode`);
      }
      return null; // Block pipe/subscribe on root-level proxy
    }

    // For RxJS helper methods (pipe / subscribe) we want them to operate on the *current* proxy path,
    // not on a fictitious "path.method" path that includes the method name. The Base implementation
    // receives the full "path.method" string, so we need to strip the trailing method part before
    // delegating.
    return this.prefix;
  }

  protected override getArrayMethodPath(path: string): string {
    return this.prefix || path;
  }

  protected override getArrayMethodCandidate(value: unknown): unknown {
    return this.prefix ? this.resolveValue(this.prefix) : (this.options.originalNestedValue ?? value);
  }

  protected override getPropertyCache(): Record<string, unknown> {
    return this.nestedCache;
  }

  protected override getArrayMutationCleanup(): (() => void) | undefined {
    return () => this.clearNestedCache();
  }

  protected override getArrayQueryCache(): Record<string, unknown> {
    return this.arrayQueryCache as unknown as Record<string, unknown>;
  }

  protected override getArrayMutationMethodCache(): Record<string, ArrayMutationMethodCacheEntry | undefined> {
    return this.arrayMutationMethodCache;
  }

  protected override getCachedProperty(keyStr: string): unknown | typeof BaseProxyHandler.UNHANDLED {
    if (Object.prototype.hasOwnProperty.call(this.nestedCache, keyStr)) {
      return this.nestedCache[keyStr];
    }
    return BaseProxyHandler.UNHANDLED;
  }

  protected override cacheResolvedProperty(
    keyStr: string,
    _currentPath: string,
    _currentValue: unknown,
    resolvedValue: unknown
  ): unknown {
    const hadKey = Object.prototype.hasOwnProperty.call(this.nestedCache, keyStr);
    if (!hadKey && this.nestedCacheSize > 200) {
      this.clearNestedCache();
    }
    if (!hadKey) this.nestedCacheSize++;
    this.nestedCache[keyStr] = resolvedValue;
    return resolvedValue;
  }

  protected override afterSetProperty(keyStr: string, _targetPath: string, value: unknown): void {
    if (value === undefined) {
      this.deleteNestedCacheKey(keyStr);
    }
  }

  protected override afterDeleteProperty(keyStr: string): void {
    this.deleteNestedCacheKey(keyStr);
  }
}
