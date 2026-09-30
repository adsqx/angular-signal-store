import type { StoreData, PredicateFn, MapFn, ReduceFn, ValidPath } from '../types/advanced-types';
import type { ArrayElementType, TypedArrayOperations } from './typed-array-operations.class';

/** Element type, or a predicate over it (what find/update/delete accept). */
type Match<E> = E | PredicateFn<E>;

/** Fluent, chainable facade over `TypedArrayOperations` for one array path. */
export class ArrayChain<T extends StoreData, P extends ValidPath<T> & string> {
  constructor(private readonly ops: TypedArrayOperations<T, P>) {}
  push(value: ArrayElementType<T, P>): this { this.ops.setArrayMethod(value, 'push'); return this; }
  unshift(value: ArrayElementType<T, P>): this { this.ops.setArrayMethod(value, 'unshift'); return this; }
  pop(): this { this.ops.setArrayMethod('pop'); return this; }
  shift(): this { this.ops.setArrayMethod('shift'); return this; }
  sort(compareFn?: (a: ArrayElementType<T, P>, b: ArrayElementType<T, P>) => number): this { this.ops.setArrayMethod(compareFn, 'sort'); return this; }
  splice(start: number, deleteCount = 0, ...items: Array<ArrayElementType<T, P>>): this { this.ops.setArrayMethod({ start, deleteCount, items }, 'splice'); return this; }
  update(index: number, newValue: ArrayElementType<T, P>): this { this.ops.updateArrayItem<ArrayElementType<T, P>>(index, newValue); return this; }
  updateByFind(predicateOrValue: Match<ArrayElementType<T, P>>, newValue: ArrayElementType<T, P>): this { this.ops.updateArrayItemByFind<ArrayElementType<T, P>>(predicateOrValue, newValue); return this; }
  delete(predicateOrValue: Match<ArrayElementType<T, P>>): this { this.ops.deleteFromArray<ArrayElementType<T, P>>(predicateOrValue); return this; }
  deleteByIndex(index: number): this { this.ops.deleteByIndex(index); return this; }
  find(predicateOrValue: Match<ArrayElementType<T, P>>): ArrayElementType<T, P> | undefined { return this.ops.findInArray<ArrayElementType<T, P>>(predicateOrValue); }
  findIndex(predicateOrValue: Match<ArrayElementType<T, P>>): number { return this.ops.findIndexInArray<ArrayElementType<T, P>>(predicateOrValue); }
  filter(predicate: PredicateFn<ArrayElementType<T, P>>): Array<ArrayElementType<T, P>> { return this.ops.filterArray<ArrayElementType<T, P>>(predicate); }
  map<R>(mapFn: MapFn<ArrayElementType<T, P>, R>): R[] { return this.ops.mapArray<ArrayElementType<T, P>, R>(mapFn); }
  reduce<R>(reduceFn: ReduceFn<ArrayElementType<T, P>, R>, initialValue: R): R { return this.ops.reduceArray<ArrayElementType<T, P>, R>(reduceFn, initialValue); }
  some(predicate: PredicateFn<ArrayElementType<T, P>>): boolean { return this.ops.someArray<ArrayElementType<T, P>>(predicate); }
  every(predicate: PredicateFn<ArrayElementType<T, P>>): boolean { return this.ops.everyArray<ArrayElementType<T, P>>(predicate); }
  includes(value: ArrayElementType<T, P>): boolean { return this.ops.includesInArray<ArrayElementType<T, P>>(value); }
  indexOf(value: ArrayElementType<T, P>): number { return this.ops.indexOfInArray<ArrayElementType<T, P>>(value); }
  length(): number { return this.ops.lengthOfArray(); }
}
