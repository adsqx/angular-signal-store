// src/app/store/interfaces/types.ts

/**
 * Shared types for the store library – refined for strong typing.
 */

import type { CallableProxy, SignalType, StoreData } from '../types/advanced-types';
import type { IStoreInstance } from './store-instance.interface';

/**
 * Type for a callable proxy created for nested paths.
 * It is a function that returns the current value and exposes deep
 * property access as further callable proxies. Additionally, it provides
 * `$signal` and `$val` convenience getters.
 */
export type ProxyCallable<T = unknown> = CallableProxy<T> & {
  readonly $signal?: SignalType<T>;
  readonly $val?: T;
};

/**
 * Type for the root store proxy. Each field of the store is exposed
 * as a callable proxy while all store instance methods are also available.
 */
export type StoreProxy<T extends StoreData = StoreData> = {
  [K in keyof T]: T[K] extends (...args: unknown[]) => unknown ? T[K] : ProxyCallable<T[K]>;
} & IStoreInstance<T>;
