import type { ArrayMutationMethod } from '../types/advanced-types';

type OpsFn = (...args: unknown[]) => unknown;
/** A prototype member; `never[]` parameters accept any concrete signature. */
type Member = (this: ArrayOpsHost, ...args: never[]) => unknown;

/** What the forwarders need from `CreateStore`: its cached per-path `TypedArrayOperations`. */
interface ArrayOpsHost {
  arrayOps(path: string): Record<string, OpsFn>;
}

/** Array members that forward `(path, ...extra)` to `arrayOps(path)[name](...extra)`, by number of extra arguments. */
const FORWARD_ARITY: Readonly<Record<string, 0 | 1 | 2>> = {
  findInArray: 1,
  findIndexInArray: 1,
  filterArray: 1,
  mapArray: 1,
  reduceArray: 2,
  someArray: 1,
  everyArray: 1,
  includesInArray: 1,
  indexOfInArray: 1,
  lengthOfArray: 0,
  updateArrayItem: 2,
  updateArrayItemByFind: 2
};

/** Fixed arities: the write path of these members must not pay for rest-argument arrays. */
const forwarder = (name: string, arity: 0 | 1 | 2): Member =>
  arity === 0
    ? function (this: ArrayOpsHost, path: string) { return this.arrayOps(path)[name](); }
    : arity === 1
      ? function (this: ArrayOpsHost, path: string, a: unknown) { return this.arrayOps(path)[name](a); }
      : function (this: ArrayOpsHost, path: string, a: unknown, b: unknown) { return this.arrayOps(path)[name](a, b); };

/** Members whose extra arguments are variadic. */
const CUSTOM_MEMBERS: Record<string, Member> = {
  setArrayMethodRef(this: ArrayOpsHost, path: string, arrayRef: unknown[], val: unknown, method: ArrayMutationMethod, ...args: unknown[]) {
    return this.arrayOps(path).setArrayMethodOnRef(arrayRef, val, method, ...args);
  },
  queryArray(this: ArrayOpsHost, path: string, val: unknown, method: string, ...args: unknown[]) {
    return this.arrayOps(path).queryArray(val, method, ...args);
  }
};

/**
 * Install the array members declared by `CreateStoreArrayApi` on `proto`. They are pure forwards to
 * `TypedArrayOperations`, so they are generated from a name table instead of written out one by one.
 */
export function installArrayForwarders(proto: object): void {
  const members: Record<string, Member> = { ...CUSTOM_MEMBERS };
  for (const name of Object.keys(FORWARD_ARITY)) members[name] = forwarder(name, FORWARD_ARITY[name]);
  for (const name of Object.keys(members)) {
    Object.defineProperty(proto, name, { value: members[name], writable: true, configurable: true, enumerable: false });
  }
}
