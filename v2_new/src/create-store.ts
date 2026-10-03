/** v2 `CreateStore`: the same public members as the current store, over the immutable core. */
import { computed, untracked, type Signal } from '@angular/core';
import { Observable, type BehaviorSubject } from 'rxjs';
import { isValidDotPath, normalizeDotPath } from '@adsq/jsnq/data-engine';
import { StoreCore, isObj, segmentsOf } from './core';
import { arrayOp, asPredicate, nativeArgs, runQuery } from './arrays';
import { createRoot, type ProxyHost } from './proxy';
import { draftView } from './draft';
import { jsnqApi, requireJsnq } from './jsnq-contract';
import type { SignalStore } from './signal-store';

type Data = Record<string, unknown>;
const shallow = (v: unknown): unknown => (Array.isArray(v) ? v.slice() : isObj(v) ? { ...v } : v);

export class CreateStore<T extends object = Data> {
  readonly core = new StoreCore({});
  preciseMutationWake = false;
  private proxyRef?: unknown;
  private readonly drafts = new Map<string, object>();
  private readonly computeds = new Map<string, Signal<unknown>>();
  /** The proxy tree's view of this store (kept off the instance so its names never shadow data keys). */
  readonly host: ProxyHost & { strictInvalidPath: boolean; strictDeleteUndefined: boolean };

  constructor(readonly signalStore: SignalStore, readonly storeName: string, _proxyFactory?: unknown, _devService?: unknown) {
    if (!storeName || typeof storeName !== 'string') throw new Error(`Invalid store name: ${String(storeName)}`);
    const self = this;
    this.host = {
      core: this.core,
      strictInvalidPath: false,
      strictDeleteUndefined: false,
      set(path, value) {
        if (value === undefined) return this.remove(path);
        if (!isValidDotPath(path)) return self.invalidPath('setValueFast', path);
        self.setValueFast(path, value);
      },
      remove(path) {
        if (this.strictDeleteUndefined) throw new Error(`Delete operation is not allowed in strict mode for path: ${path}`);
        if (!isValidDotPath(path)) return self.invalidPath('deleteValue', path);
        self.deleteValue(path);
      },
      arrayMutation: (path, method, args) => this.arrayMutation(path, method, args),
      draft: () => this.draft,
      member: (key) => {
        const m = (this as unknown as Record<string, unknown>)[key];
        return typeof m === 'function' ? m.bind(this) : undefined;
      },
      signalOf: (normalized) => this.register(normalized),
      apiMethod: (key, path) => {
        const api = jsnqApi();
        return api ? api(key, this, path) : () => requireJsnq(key);
      },
    };
    signalStore.registerStoreInstance(storeName, this as unknown as CreateStore);
  }

  get store(): T { return this.core.data as T; }
  returnStore(): T { return this.store; }
  /** The callable store proxy (also what `select` / `computedOf` projections receive). */
  get proxy(): unknown { return (this.proxyRef ??= createRoot(this.host)); }
  get draft(): unknown { return draftView(this.host, '', this.drafts); }
  get createServiceGetter(): undefined { return undefined; }
  get getCreateService(): undefined { return undefined; }
  get computedStore(): Record<string, Signal<unknown>> { return Object.fromEntries(this.computeds); }
  get behaviorStore(): Record<string, BehaviorSubject<unknown>> { return this.core.subjectsObject(); }

  private invalidPath(op: string, path: string): void {
    const message = `Invalid path for ${op}: ${path}`;
    if (this.host.strictInvalidPath) throw new Error(message);
    console.warn(message);
  }

  private valid(path: string, context: string): string {
    if (!isValidDotPath(path)) throw new Error(`Invalid path format for ${context}: ${String(path)}`);
    return normalizeDotPath(path);
  }

  private dev(type: string, payload: Data): void {
    if (!this.signalStore.devActive) return;
    this.core.seal(); // the event holds references: the next write must not edit them in place
    this.signalStore.emitDevAction(this.storeName, { type, payload } as never);
  }

  // Writes
  private put(normalized: string, value: unknown, observe: boolean): void {
    const segs = segmentsOf(normalized);
    const previous = observe && value === undefined ? this.core.remove(segs) : this.core.write(segs, value, normalized);
    if (observe) this.core.subject(normalized);
    this.dev('SET_VALUE_OBSERVE', { path: normalized, value, oldValue: previous });
    // Unlike the current store, a removed path keeps its subjects: subscribers see `undefined`, then the next value.
  }

  setValue(path: string, value: unknown): void { this.put(this.valid(path, 'setValue'), value, true); }
  setValueObserve(path: string, value: unknown): void { this.put(this.valid(path, 'observe operation'), value, true); }
  setValueFast(path: string, value: unknown): void { this.put(path, value, false); }
  deleteValue(path: string): void { this.put(this.valid(path, 'delete operation'), undefined, true); }
  batch<R>(fn: () => R): R { return this.core.batch(fn); }

  // Reads and reactive accessors
  readStore(path: string): unknown { return path && typeof path === 'string' ? this.core.read(path) : undefined; }
  getSignalValue(path: string): unknown { return isValidDotPath(path) ? this.core.read(path) : undefined; }

  getComputed(path: string): Signal<unknown> | undefined {
    const normalized = this.valid(path, 'computed signal');
    if (this.core.read(normalized) === undefined) return undefined;
    return this.register(normalized);
  }

  private register(normalized: string): Signal<unknown> {
    const node = this.core.node(normalized);
    if (!this.computeds.has(normalized)) {
      this.computeds.set(normalized, node);
      this.dev('COMPUTED_STORE_UPDATE', { action: 'add', path: normalized, keys: [...this.computeds.keys()] });
    }
    return node;
  }

  addToComputeStore(path: string): void { this.getComputed(path); }
  deleteFromComputeStore(path: string): void {
    for (const key of [...this.computeds.keys()]) if (key === path || key.startsWith(`${path}.`)) this.computeds.delete(key);
  }
  getBehaviorSubject(path: string): BehaviorSubject<unknown> { return this.core.subject(this.valid(path, 'BehaviorSubject')); }
  getObservable(path: string): Observable<unknown> { return this.core.subject(this.valid(path, 'Observable')); }

  select<TOut>(project: (s: never) => TOut): Observable<TOut> {
    return new Observable<TOut>((subscriber) => {
      const projected = computed(() => project(this.proxy as never));
      let has = false;
      let last!: TOut;
      const emit = () => {
        let value: TOut;
        try {
          value = untracked(projected);
        } catch (error) {
          subscriber.error(error);
          return;
        }
        if (!has || !Object.is(value, last)) {
          has = true;
          last = value;
          subscriber.next(value);
        }
      };
      emit();
      return this.core.onCommit(emit);
    });
  }

  computedOf<TOut>(project: (s: never) => TOut): Signal<TOut> { return computed(() => project(this.proxy as never)); }

  // Wake: consumers depend on references, so a forced wake replaces the value with a shallow copy.
  wakeup(path: string, _mode?: string): void { this.core.update(segmentsOf(this.valid(path, 'wakeup')), shallow); }
  wakeUp(path: string, mode?: string): void { this.wakeup(path, mode); }
  wakeUpVersionPath(path: string): void { this.core.update(segmentsOf(path), shallow); }
  wakeUpMutationPath(path: string): boolean { this.wakeUpVersionPath(path); return this.core.behaviorUpdates; }
  wakeUpArrayMutation(path: string): void { this.wakeUpVersionPath(path); }
  updateBehaviorsBySegments(): void { /* subjects follow every commit */ }
  commitMutationPrecise(branch: string, value: unknown): void { this.setValueFast(normalizeDotPath(branch), value); }

  // Configuration and lifecycle (the immutable core has no wake modes, read tracking or output cloning to configure)
  setDependencyMode(): void {}
  setTrackReads(): void {}
  setCloneComputedOutputs(): void {}
  setPreciseMutationWake(enabled: boolean): void { this.preciseMutationWake = enabled; }
  setBehaviorUpdatesEnabled(enabled: boolean): void { this.core.behaviorUpdates = !!enabled; }
  prefetchCursorWithNode(): void {}
  cleanupPath(path: string): void { this.core.cleanup(normalizeDotPath(path)); }
  destroy(): void { this.core.destroy(); this.computeds.clear(); this.drafts.clear(); }
  enableDevTools(_storeName: string, showVisualizer = true): void {
    if (showVisualizer && typeof document !== 'undefined' && !document.querySelector('app-dev-tools')) {
      document.body.appendChild(document.createElement('app-dev-tools'));
    }
  }

  // Arrays
  private arrayMutation(path: string, method: string, args: unknown[]): unknown {
    const result = arrayOp(this.core, path, method, args);
    if (this.signalStore.devActive) this.dev('ARRAY_OPERATION', { path, method, args, newValue: this.core.read(path) });
    return result;
  }

  private arrayAt(path: string): unknown[] {
    const array = this.core.read(this.valid(path, 'array operation'));
    if (!Array.isArray(array)) throw new Error(`Path ${String(path)} does not point to an array`);
    return array;
  }

  setArrayMethod(path: string, a: unknown, method?: string, ...args: unknown[]): unknown {
    const name = a === 'pop' || a === 'shift' ? a : method;
    if (!name) throw new Error('Missing array mutation method');
    this.arrayAt(path);
    return this.arrayMutation(normalizeDotPath(path), name as string, a === 'pop' || a === 'shift' ? [] : nativeArgs(name, a, args));
  }

  setArrayMethodRef(path: string, _arrayRef: unknown[], val: unknown, method: string, ...args: unknown[]): unknown {
    return this.setArrayMethod(path, val, method, ...args);
  }

  queryArray(path: string, val: unknown, method: string, ...extra: unknown[]): unknown {
    return runQuery(this.core.read(this.valid(path, 'array operation')), method, val, extra);
  }

  findInArray(path: string, p: unknown) { return this.queryArray(path, p, 'find'); }
  findIndexInArray(path: string, p: unknown) { return this.queryArray(path, p, 'findIndex'); }
  filterArray(path: string, p: unknown) { return this.queryArray(path, p, 'filter'); }
  mapArray(path: string, f: unknown) { return this.queryArray(path, f, 'map'); }
  reduceArray(path: string, f: unknown, initial: unknown) { return this.queryArray(path, f, 'reduce', initial); }
  someArray(path: string, p: unknown) { return this.queryArray(path, p, 'some'); }
  everyArray(path: string, p: unknown) { return this.queryArray(path, p, 'every'); }
  includesInArray(path: string, v: unknown) { return this.queryArray(path, v, 'includes'); }
  indexOfInArray(path: string, v: unknown) { return this.queryArray(path, v, 'indexOf'); }
  lengthOfArray(path: string) { return this.queryArray(path, undefined, 'length'); }

  updateArrayItem(path: string, index: number, newValue: unknown): void {
    const array = this.arrayAt(path);
    if (index < 0 || index >= array.length) throw new Error(`Index ${index} out of bounds for array at ${path}`);
    this.core.write([...segmentsOf(normalizeDotPath(path)), String(index)], newValue);
  }

  updateArrayItemByFind(path: string, predicate: unknown, newValue: unknown): void {
    const index = this.arrayAt(path).findIndex(asPredicate(predicate));
    if (index !== -1) this.updateArrayItem(path, index, newValue);
  }

  deleteFromArray(path: string, predicate: unknown) {
    const oldValue = this.arrayAt(path);
    const test = asPredicate(predicate);
    const indexes: number[] = [];
    const removed: unknown[] = [];
    const kept = oldValue.filter((item, i, arr) => (test(item, i, arr) ? (indexes.push(i), removed.push(item), false) : true));
    if (indexes.length) this.core.write(segmentsOf(normalizeDotPath(path)), kept);
    return { method: 'filter', path, args: [predicate], oldValue, newValue: this.core.read(path), removedElements: removed, indexes, item: removed };
  }

  deleteByIndex(path: string, index: number) {
    const oldValue = this.arrayAt(path);
    const inRange = index >= 0 && index < oldValue.length;
    const removed = inRange ? oldValue[index] : undefined;
    if (inRange) this.arrayMutation(normalizeDotPath(path), 'splice', [index, 1]);
    const items = inRange && removed !== undefined ? [removed] : [];
    return {
      method: 'splice', path, args: [{ start: index, deleteCount: inRange ? 1 : 0, items: [] }], oldValue,
      newValue: this.core.read(path), removedElements: items, indexes: items.length ? [index] : [], item: removed,
    };
  }

  /** Fluent, chainable array API for one path. */
  array(path: string) {
    const s = this;
    const chain = {
      push: (v: unknown) => (s.setArrayMethod(path, v, 'push'), chain),
      unshift: (v: unknown) => (s.setArrayMethod(path, v, 'unshift'), chain),
      pop: () => (s.setArrayMethod(path, 'pop'), chain),
      shift: () => (s.setArrayMethod(path, 'shift'), chain),
      sort: (fn?: unknown) => (s.setArrayMethod(path, fn, 'sort'), chain),
      reverse: () => (s.setArrayMethod(path, undefined, 'reverse'), chain),
      splice: (start: number, deleteCount = 0, ...items: unknown[]) => (s.setArrayMethod(path, { start, deleteCount, items }, 'splice'), chain),
      update: (i: number, v: unknown) => (s.updateArrayItem(path, i, v), chain),
      updateByFind: (p: unknown, v: unknown) => (s.updateArrayItemByFind(path, p, v), chain),
      delete: (p: unknown) => (s.deleteFromArray(path, p), chain),
      deleteByIndex: (i: number) => (s.deleteByIndex(path, i), chain),
      find: (p: unknown) => s.queryArray(path, p, 'find'),
      findIndex: (p: unknown) => s.queryArray(path, p, 'findIndex'),
      filter: (p: unknown) => s.queryArray(path, p, 'filter'),
      map: (f: unknown) => s.queryArray(path, f, 'map'),
      reduce: (f: unknown, init: unknown) => s.queryArray(path, f, 'reduce', init),
      some: (p: unknown) => s.queryArray(path, p, 'some'),
      every: (p: unknown) => s.queryArray(path, p, 'every'),
      includes: (v: unknown) => s.queryArray(path, v, 'includes'),
      indexOf: (v: unknown) => s.queryArray(path, v, 'indexOf'),
      length: () => s.queryArray(path, undefined, 'length'),
    };
    return chain;
  }
}
