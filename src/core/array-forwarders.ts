import type { ArrayMutationMethod } from '../types/advanced-types';

type OpsFn = (...args: unknown[]) => unknown;
/** A prototype member; `never[]` parameters accept any concrete signature. */
type Member = (this: ArrayOpsHost, ...args: never[]) => unknown;

/** What the forwarders need from `CreateStore`: its cached per-path `TypedArrayOperations`. */
interface ArrayOpsHost {
  arrayOps(path: string): Record<string, OpsFn>;
}

/** Single-argument members that run one `queryArray` method. */
const QUERY_MEMBERS: Readonly<Record<string, string>> = {
  findInArray: 'find',
  findIndexInArray: 'findIndex',
  filterArray: 'filter',
  mapArray: 'map',
  someArray: 'some',
  everyArray: 'every',
  includesInArray: 'includes',
  indexOfInArray: 'indexOf'
};

// Fixed arities: the write path of these members must not pay for rest-argument arrays.
const MEMBERS: Record<string, Member> = {
  lengthOfArray(this: ArrayOpsHost, path: string) { return this.arrayOps(path).queryArray(undefined, 'length'); },
  reduceArray(this: ArrayOpsHost, path: string, callback: unknown, initial: unknown) {
    return this.arrayOps(path).queryArray(callback, 'reduce', initial);
  },
  updateArrayItem(this: ArrayOpsHost, path: string, a: unknown, b: unknown) { return this.arrayOps(path).updateArrayItem(a, b); },
  updateArrayItemByFind(this: ArrayOpsHost, path: string, a: unknown, b: unknown) { return this.arrayOps(path).updateArrayItemByFind(a, b); },
  // Variadic extra arguments
  setArrayMethodRef(this: ArrayOpsHost, path: string, arrayRef: unknown[], val: unknown, method: ArrayMutationMethod, ...args: unknown[]) {
    return this.arrayOps(path).setArrayMethodOnRef(arrayRef, val, method, ...args);
  },
  queryArray(this: ArrayOpsHost, path: string, val: unknown, method: string, ...args: unknown[]) {
    return this.arrayOps(path).queryArray(val, method, ...args);
  }
};
for (const name of Object.keys(QUERY_MEMBERS)) {
  MEMBERS[name] = function (this: ArrayOpsHost, path: string, a: unknown) { return this.arrayOps(path).queryArray(a, QUERY_MEMBERS[name]); };
}

/**
 * Install the array members declared by `CreateStoreArrayApi` on `proto`. They are pure forwards to
 * `TypedArrayOperations`, so they are generated from tables instead of written out one by one.
 */
export function installArrayForwarders(proto: object): void {
  for (const name of Object.keys(MEMBERS)) {
    Object.defineProperty(proto, name, { value: MEMBERS[name], writable: true, configurable: true, enumerable: false });
  }
}
