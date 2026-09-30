/**
 * Runtime type guards. Path format validation goes exclusively through PathUtils.isValidPath (SSOT).
 */

import type { StoreData, StrictPath } from './advanced-types';
import type { IStoreInstance } from '../interfaces/store-instance.interface';
import { PathUtils } from '../utils/path-utils';

export function isValidPath<T extends StoreData>(path: string): path is StrictPath<T> {
  return PathUtils.isValidPath(path);
}

/** True when `path` is well-formed and currently holds an array. */
export function isArrayPath<T extends StoreData>(
  storeInstance: IStoreInstance<T>,
  path: string
): path is StrictPath<T> {
  if (!isValidPath<T>(path)) return false;
  try {
    return Array.isArray(storeInstance.readStore(path));
  } catch {
    return false;
  }
}
