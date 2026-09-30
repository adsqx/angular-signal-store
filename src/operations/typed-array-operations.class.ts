import type {
  StoreData, ArrayMutationMethod, ArrayQueryMethod, PredicateFn, MapFn, ReduceFn, PathValue, ValidPath, SpliceOperation
} from '../types/advanced-types';
import { StoreErrorFactory } from '../types/errors';
import type { SignalStore } from '../core/signal-store.service';
import type { CreateStore } from '../core/create-store.class';
import { PathUtils } from '../utils/path-utils';
import { ArrayMutationOrchestrator } from './array-mutation-orchestrator';
import { ArrayQueryMethodWithLength, asPredicate, executeArrayQuery } from '../utils/array-query';

export { ArrayChain } from './array-chain';

export type ArrayElementType<T, P extends string> = PathValue<T, P> extends readonly (infer V)[] ? V : never;
type ArrayQueryPredicate<E, M extends ArrayQueryMethodWithLength> =
  M extends 'find' | 'findIndex' | 'filter' | 'some' | 'every' ? PredicateFn<E> :
  M extends 'map' ? MapFn<E, unknown> :
  M extends 'reduce' ? ReduceFn<E, unknown> :
  M extends 'includes' | 'indexOf' ? E :
  undefined;

type NormalizedMutationInput = { method: ArrayMutationMethod; payload: unknown; devArgs: unknown[] };
type MutationInputNormalizer = (value: unknown, args: unknown[]) => NormalizedMutationInput;

const isSpliceOperation = (value: unknown): value is SpliceOperation =>
  !!value && typeof value === 'object' && 'start' in value && 'deleteCount' in value && 'items' in value;

const variadicInput = (method: 'push' | 'unshift'): MutationInputNormalizer => (value, args) => {
  const items = [value, ...args];
  return { method, payload: items, devArgs: items };
};

const singlePayloadInput = (method: ArrayMutationMethod): MutationInputNormalizer => (value, args) =>
  ({ method, payload: value, devArgs: [value, ...args] });

const mutationInputNormalizers: Record<ArrayMutationMethod, MutationInputNormalizer> = {
  splice: (value) => {
    if (!isSpliceOperation(value)) throw new Error('Invalid splice operation payload');
    const op: SpliceOperation = { start: value.start, deleteCount: value.deleteCount, items: Array.isArray(value.items) ? value.items : [] };
    return { method: 'splice', payload: op, devArgs: [op.start, op.deleteCount, ...op.items] };
  },
  push: variadicInput('push'),
  unshift: variadicInput('unshift'),
  pop: singlePayloadInput('pop'),
  shift: singlePayloadInput('shift'),
  sort: singlePayloadInput('sort'),
  reverse: singlePayloadInput('reverse')
};

/** What a query answers when the path holds no array yet. */
const emptyArrayQueryFallbacks: Record<ArrayQueryMethodWithLength, () => unknown> = {
  length: () => 0,
  filter: () => [],
  map: () => [],
  find: () => undefined,
  findIndex: () => undefined,
  reduce: () => undefined,
  some: () => undefined,
  every: () => undefined,
  includes: () => undefined,
  indexOf: () => undefined
};

function normalizeMutationInput(a: unknown, method: ArrayMutationMethod | undefined, args: unknown[]): NormalizedMutationInput {
  if (a === 'pop' || a === 'shift') return mutationInputNormalizers[a](undefined, args);
  if (!method) throw new Error('Missing array mutation method');
  return mutationInputNormalizers[method](a, args);
}

/** Array operations bound to one path of a named store; the store's array members forward here. */
export class TypedArrayOperations<
  T extends StoreData = StoreData,
  P extends ValidPath<T> & string = ValidPath<T> & string
> {
  private orchestrator?: ArrayMutationOrchestrator;
  private orchestratorStore?: CreateStore;

  constructor(
    private readonly signalStore: SignalStore,
    private readonly storeName: string,
    private readonly path: P
  ) {}

  /** Runs `fn`, rewrapping any failure as an array-operation error for this path. */
  private guard<R>(operation: string, reason: string, fn: () => R): R {
    try {
      return fn();
    } catch (error) {
      throw StoreErrorFactory.arrayOperation(this.path, operation, reason, error as Error);
    }
  }

  private withArray<R>(strict: boolean, fn: (store: CreateStore, array: unknown[] | undefined, value: unknown) => R): R {
    if (!PathUtils.isValidPath(this.path)) {
      throw StoreErrorFactory.pathValidation(this.path, 'Invalid path format for array operation');
    }
    const store = this.signalStore.getStore(this.storeName);
    const ref = PathUtils.getByPath(store.returnStore(), this.path as P);
    if (ref !== undefined && !Array.isArray(ref)) {
      throw StoreErrorFactory.typeValidation(this.path, 'array', typeof ref);
    }
    const array = Array.isArray(ref) ? (ref as unknown[]) : undefined;
    if (strict && !array) {
      throw new Error(`Path ${String(this.path)} does not point to an array`);
    }
    return fn(store, array, ref);
  }

  private getOrchestrator(store: CreateStore): ArrayMutationOrchestrator {
    if (this.orchestratorStore !== store) {
      this.orchestrator = new ArrayMutationOrchestrator(store);
      this.orchestratorStore = store;
    }
    return this.orchestrator!;
  }

  private executeMutation(store: CreateStore, array: unknown[], oldValue: unknown, info: NormalizedMutationInput): unknown {
    const dev = this.signalStore.devActive;
    const before = dev ? structuredClone(array) : oldValue;
    const result = this.getOrchestrator(store).mutate(this.path, array, info.method, info.payload);
    if (dev) {
      this.signalStore.emitDevAction(this.storeName, {
        type: 'ARRAY_OPERATION',
        payload: {
          path: String(this.path),
          method: String(info.method),
          args: info.devArgs,
          oldValue: (before as unknown[]) ?? [],
          newValue: array
        }
      });
    }
    return result;
  }

  private mutationFailure(method: unknown, error: unknown): never {
    const name = String(method);
    throw StoreErrorFactory.arrayOperation(this.path, name, `${name} operation failed`, error as Error);
  }

  updateArrayItem<U = ArrayElementType<T, P>>(index: number, newValue: U): void {
    this.guard('updateItem', 'Update array item operation failed', () => {
      this.withArray(true, (store, array) => this.getOrchestrator(store).updateItem(this.path, array as unknown[], index, newValue));
    });
  }

  updateArrayItemByFind<U = ArrayElementType<T, P>>(predicate: PredicateFn<U> | U, newValue: U): void {
    this.guard('updateItemByFind', 'Update array item by find operation failed', () => {
      this.withArray(true, (store, array) => {
        const index = (array as U[]).findIndex(asPredicate(predicate));
        if (index !== -1) this.getOrchestrator(store).updateItem(this.path, array as unknown[], index, newValue);
        else store.wakeUpVersionPath(this.path);
      });
    });
  }

  setArrayMethod(val: unknown, method: ArrayMutationMethod, ...args: unknown[]): unknown;
  setArrayMethod(method: Extract<ArrayMutationMethod, 'pop' | 'shift'>): unknown;
  setArrayMethod(val: undefined, method: Extract<ArrayMutationMethod, 'pop' | 'shift'>): unknown;
  setArrayMethod(a: unknown, method?: ArrayMutationMethod, ...args: unknown[]): unknown {
    let info: NormalizedMutationInput | undefined;
    try {
      info = normalizeMutationInput(a, method, args);
      return this.withArray(true, (store, array, oldValue) => this.executeMutation(store, array as unknown[], oldValue, info!));
    } catch (error) {
      return this.mutationFailure(info?.method ?? (typeof a === 'string' ? a : method ?? 'unknown'), error);
    }
  }

  setArrayMethodOnRef(array: unknown[], val: unknown, method: ArrayMutationMethod, ...args: unknown[]): unknown {
    let info: NormalizedMutationInput | undefined;
    try {
      if (!PathUtils.isValidPath(this.path)) {
        throw StoreErrorFactory.pathValidation(this.path, 'Invalid path format for array operation');
      }
      info = normalizeMutationInput(val, method, args);
      return this.executeMutation(this.signalStore.getStore(this.storeName), array, array, info);
    } catch (error) {
      return this.mutationFailure(info?.method ?? method ?? 'unknown', error);
    }
  }

  queryArray<U = ArrayElementType<T, P>>(val: PredicateFn<U> | U, method: 'find'): U | undefined;
  queryArray<U = ArrayElementType<T, P>>(val: PredicateFn<U> | U, method: 'findIndex'): number;
  queryArray<U = ArrayElementType<T, P>>(val: PredicateFn<U>, method: 'filter'): U[];
  queryArray<U = ArrayElementType<T, P>, R = unknown>(val: MapFn<U, R>, method: 'map'): R[];
  queryArray<U = ArrayElementType<T, P>, R = unknown>(val: ReduceFn<U, R>, method: 'reduce', initialValue: R): R;
  queryArray<U = ArrayElementType<T, P>>(val: PredicateFn<U>, method: 'some' | 'every'): boolean;
  queryArray<U = ArrayElementType<T, P>>(val: U, method: 'includes'): boolean;
  queryArray<U = ArrayElementType<T, P>>(val: U, method: 'indexOf'): number;
  queryArray<U = ArrayElementType<T, P>>(_: unknown, method: 'length'): number;
  queryArray<M extends ArrayQueryMethod, U = ArrayElementType<T, P>>(
    val: ArrayQueryPredicate<U, M | 'length'>,
    method: M | 'length',
    ...extra: unknown[]
  ): unknown {
    return this.guard(method, 'Query array operation failed', () =>
      this.withArray(false, (_, array) =>
        array ? executeArrayQuery(array as U[], method, val, extra) : emptyArrayQueryFallbacks[method]()
      )
    );
  }

  deleteFromArray<U = ArrayElementType<T, P>>(predicate: PredicateFn<U> | U) {
    return this.guard('deleteFromArray', 'Delete from array operation failed', () =>
      this.withArray(true, (store, array, oldValue) => {
        const target = array as U[];
        const oldLength = target.length;
        const predicateFn = asPredicate(predicate);
        const indexes: number[] = [];
        const removed: U[] = [];
        target.forEach((item, index, arr) => {
          if (predicateFn(item, index, arr)) {
            indexes.push(index);
            removed.push(item);
          }
        });
        if (indexes.length) {
          // Compact in place, skipping the matched indexes.
          let write = indexes[0];
          let next = 0;
          for (let read = write; read < oldLength; read++) {
            if (indexes[next] === read) next++;
            else target[write++] = target[read];
          }
          target.length = write;
        }
        const newValue = store.readStore(this.path as P);
        this.getOrchestrator(store).finalizeArrayChange(this.path, newValue, oldLength, target.length, indexes.length ? indexes[0] : null);
        return { method: 'filter', path: this.path, args: [predicate], oldValue, newValue, removedElements: removed, indexes, item: removed };
      })
    );
  }

  deleteByIndex(index: number) {
    return this.guard('deleteByIndex', 'Delete by index operation failed', () =>
      this.withArray(true, (store, array, oldValue) => {
        const target = array as unknown[];
        const oldLength = target.length;
        if (index < 0 || index >= oldLength) {
          store.wakeUpVersionPath(this.path);
          return {
            method: 'splice',
            path: this.path,
            args: [{ start: index, deleteCount: 0, items: [] }],
            oldValue,
            newValue: oldValue,
            removedElements: [],
            indexes: [],
            item: undefined
          };
        }
        const [removed] = target.splice(index, 1);
        this.getOrchestrator(store).finalizeArrayChange(this.path, target, oldLength, target.length, index);
        const removedItems = removed !== undefined ? [removed] : [];
        return {
          method: 'splice',
          path: this.path,
          args: [{ start: index, deleteCount: 1, items: [] }],
          oldValue,
          newValue: store.readStore(this.path as P),
          removedElements: removedItems,
          indexes: removedItems.length ? [index] : [],
          item: removed
        };
      })
    );
  }
}
