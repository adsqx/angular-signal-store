import type { IStoreInstance } from '../interfaces/store-instance.interface';
import type { StoreData } from '../types/advanced-types';
import type { CreateStoreService } from '../core/create-store.core';

/**
 * The concrete store instance as the proxy layer sees it: the public `IStoreInstance`
 * contract plus the members `CreateStore` exposes to its own proxies.
 */
export interface StoreHost extends IStoreInstance<StoreData> {
  createServiceGetter?: CreateStoreService;
  getCreateService?: CreateStoreService;
  preciseMutationWake?: boolean;
  commitMutationPrecise?(branch: string, value: unknown, relPaths: readonly string[]): void;
}

/** The single place where a typed store instance is viewed as a `StoreHost`. */
export function asHost<T extends object>(store: IStoreInstance<T>): StoreHost {
  return store as unknown as StoreHost;
}

/** Current value at `path`, or the root object for the empty path. */
export function readBranch(host: StoreHost, path: string): unknown {
  return path ? host.readStore(path) : host.store;
}

/** The reactive service behind the host (`createServiceGetter`, with its legacy alias as fallback). */
export function serviceOf(host: StoreHost): CreateStoreService {
  return (host.createServiceGetter ?? host.getCreateService) as CreateStoreService;
}
