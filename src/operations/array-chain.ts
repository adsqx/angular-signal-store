import type { StoreData, PredicateFn, MapFn, ReduceFn, ValidPath } from '../types/advanced-types';
import type { ArrayElementType, TypedArrayOperations } from './typed-array-operations.class';

/** Element type, or a predicate over it (what find/update/delete accept). */
type Match<E> = E | PredicateFn<E>;

/** Fluent, chainable facade over `TypedArrayOperations` for one array path. */
export class ArrayChain<T extends object, P extends ValidPath<T> & string> {
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
  find(predicateOrValue: Match<ArrayElementType<T, P>>): ArrayElementType<T, P> | undefined { return this.ops.queryArray(predicateOrValue, 'find'); }
  findIndex(predicateOrValue: Match<ArrayElementType<T, P>>): number { return this.ops.queryArray(predicateOrValue, 'findIndex'); }
  filter(predicate: PredicateFn<ArrayElementType<T, P>>): Array<ArrayElementType<T, P>> { return this.ops.queryArray(predicate, 'filter'); }
  map<R>(mapFn: MapFn<ArrayElementType<T, P>, R>): R[] { return this.ops.queryArray(mapFn, 'map'); }
  reduce<R>(reduceFn: ReduceFn<ArrayElementType<T, P>, R>, initialValue: R): R { return this.ops.queryArray(reduceFn, 'reduce', initialValue); }
  some(predicate: PredicateFn<ArrayElementType<T, P>>): boolean { return this.ops.queryArray(predicate, 'some'); }
  every(predicate: PredicateFn<ArrayElementType<T, P>>): boolean { return this.ops.queryArray(predicate, 'every'); }
  includes(value: ArrayElementType<T, P>): boolean { return this.ops.queryArray(value, 'includes'); }
  indexOf(value: ArrayElementType<T, P>): number { return this.ops.queryArray(value, 'indexOf'); }
  length(): number { return this.ops.queryArray(undefined, 'length'); }
}
