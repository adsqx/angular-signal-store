import { IStoreInstance } from '../interfaces/store-instance.interface';
import { StoreData, ArrayMutationMethod, ArrayQueryMethod, StrictPath } from '../types/advanced-types';
import { CreateStoreService } from '../core/create-store.core';
import { isArrayPath } from '../types/type-guards';
import { buildArrayQueryCacheKey } from './array-query-key.utils';

export interface ProxyCacheEntry<T extends object> {
  [key: string]: WeakRef<T> | undefined;
}

type NormalizedMutationArgs = { value: unknown; extra: unknown[] };
type MutationArgNormalizer = (args: unknown[]) => NormalizedMutationArgs;
type FastArrayMutationStore<T extends StoreData> = IStoreInstance<T> & {
  setArrayMethodRef?: (
    path: string,
    arrayRef: unknown[],
    val: unknown,
    method: ArrayMutationMethod,
    ...args: unknown[]
  ) => unknown;
};

const EMPTY_ARGS: unknown[] = [];
const noArgs: MutationArgNormalizer = () => ({ value: undefined, extra: EMPTY_ARGS });
const singleArg: MutationArgNormalizer = (args) => ({ value: args[0], extra: EMPTY_ARGS });
const variadicArgs: MutationArgNormalizer = (args) =>
  ({ value: args[0], extra: args.length <= 1 ? EMPTY_ARGS : args.slice(1) });

const mutationArgNormalizers: Record<ArrayMutationMethod, MutationArgNormalizer> = {
  splice: (args) => {
    const [start, deleteCount, ...items] = args;
    return { value: { start, deleteCount: args.length > 1 ? deleteCount : undefined, items }, extra: [] };
  },
  push: variadicArgs,
  unshift: variadicArgs,
  sort: singleArg,
  pop: noArgs,
  shift: noArgs,
  reverse: noArgs
};

export class ArrayMethodHandler {
  static executeMutatingMethod<T extends StoreData, R = unknown>(
    keyStr: ArrayMutationMethod,
    targetPath: string,
    storeInstance: IStoreInstance<T>,
    args: unknown[],
    afterMutation?: () => void,
    arrayRef?: unknown[]
  ): R | undefined {
    if ((keyStr === 'push' || keyStr === 'unshift') && args.length === 0) {
      const current = arrayRef ?? storeInstance.readStore?.(targetPath);
      return (Array.isArray(current) ? current.length : undefined) as R | undefined;
    }
    const { value, extra } = mutationArgNormalizers[keyStr](args);
    let result: unknown;
    const fastStore = storeInstance as FastArrayMutationStore<T>;

    if (arrayRef && fastStore.setArrayMethodRef) {
      result = fastStore.setArrayMethodRef(targetPath, arrayRef, value, keyStr, ...extra);
    } else if (ArrayMethodHandler.isValidArrayPath<T>(storeInstance, targetPath)) {
      result = storeInstance.setArrayMethod(targetPath as StrictPath<T>, value as never, keyStr, ...extra);
    }

    afterMutation?.();

    return result as R | undefined;
  }

  static createQueryMethod<T extends StoreData, R extends object = Record<string, unknown>>(
    keyStr: ArrayQueryMethod,
    targetPath: string,
    storeInstance: IStoreInstance<T>,
    cache?: ProxyCacheEntry<R>
  ): (...args: unknown[]) => R | undefined {
    return (...args: unknown[]) => {
      if (!ArrayMethodHandler.isValidArrayPath<T>(storeInstance, targetPath)) {
        return undefined;
      }
      const firstArg = args[0];
      const rest = args.slice(1);

      // Build a stable cache key using shared util
      const cacheKey = buildArrayQueryCacheKey(targetPath, keyStr, firstArg, rest);

      if (cache) {
        const ref = cache[cacheKey];
        const cached = ref?.deref?.();
        if (cached) {
          return cached as R;
        }
      }

      // Prefer createService-based computed (reactive), which is memoized under path
      const createService = (storeInstance as { getCreateService?: CreateStoreService }).getCreateService;
      let result: R | undefined;
      if (createService && typeof createService.createArrayQueryComputed === 'function') {
        result = createService.createArrayQueryComputed(targetPath, keyStr, firstArg, ...rest) as R;
      } else {
        // Fallback: non-reactive query
        result = storeInstance.queryArray(targetPath as StrictPath<T>, firstArg as never, keyStr as never, ...rest) as R;
      }

      if (cache && result !== undefined) {
        try {
          cache[cacheKey] = new WeakRef(result);
        } catch {
          // ignore environments without WeakRef support
        }
      }

      return result;
    };
  }

  /**
   * Type guard to validate array paths
   */
  static isValidArrayPath<T extends StoreData>(
    storeInstance: IStoreInstance<T>,
    path: string
  ): path is StrictPath<T> {
    return isArrayPath(storeInstance, path);
  }
}
