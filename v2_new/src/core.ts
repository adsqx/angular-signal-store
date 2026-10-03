/**
 * v2 core: the store data is immutable. One root signal holds it; every path is a `computed` over its
 * parent, so Angular's own equality check wakes exactly the branches whose reference changed. A write
 * copies the path from the root to the target (structural sharing); inside a transaction each node is
 * copied once and then edited in place, and the root signal is set once at the end.
 */
import { computed, signal, untracked, type Signal, type WritableSignal } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { normalizeDotPath, splitDotPath } from '@adsq/jsnq/data-engine';

export type Data = Record<string, unknown>;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const NODE_CAP = 5000;

export const isObj = (v: unknown): v is Data => v !== null && typeof v === 'object';
export const isIndex = (s: string | undefined): boolean => !!s && /^\d+$/.test(s);
export const segmentsOf = (path: string): readonly string[] => splitDotPath(normalizeDotPath(path));

/** JSON read: only objects and arrays are traversed (a string's characters are not children). */
export function getIn(root: unknown, segs: readonly string[]): unknown {
  let current = root;
  for (let i = 0; i < segs.length; i++) {
    if (current === null || typeof current !== 'object' || FORBIDDEN.has(segs[i]!)) return undefined;
    current = (current as Data)[segs[i]!];
  }
  return current;
}

export class StoreCore {
  readonly root: WritableSignal<Data>;
  private pending: Data | null = null;
  private depth = 0;
  /**
   * Copies made in the current generation. A generation stays open (its copies editable in place,
   * across commits) until something observes the data: a computed reading the root, or any read that
   * hands out a reference. The next write after an observation starts a new generation and copies again.
   */
  private readonly owner = new WeakMap<object, number>();
  private gen = 0;
  private sealed = true;
  /** Root read for the top-level computeds: marks the data as observed. */
  readonly readRoot = (): Data => {
    this.sealed = true;
    return this.root();
  };
  private readonly nodes = new Map<string, Signal<unknown>>();
  private readonly listeners = new Set<() => void>();
  private subjects?: Map<string, BehaviorSubject<unknown>>;
  behaviorUpdates = true;

  constructor(initial: Data) {
    this.root = signal(initial);
  }

  /** Current data, uncommitted transaction writes included (untracked); the caller may keep references. */
  get data(): Data {
    this.sealed = true;
    return this.raw;
  }

  private get raw(): Data {
    return this.pending ?? untracked(this.root);
  }

  read(path: string): unknown {
    return path ? getIn(this.data, segmentsOf(path)) : this.data;
  }

  /** Value at `path` for checks only (type, existence, length): does not count as an observation. */
  peek(path: string): unknown {
    return path ? getIn(this.raw, segmentsOf(path)) : this.raw;
  }

  /** Marks the data as observed (the next write copies). */
  seal(): void {
    this.sealed = true;
  }

  /** The computed of a normalized path (created on first use). Stale nodes stay valid after eviction. */
  node(path: string): Signal<unknown> {
    let n = this.nodes.get(path);
    if (n) return n;
    if (this.nodes.size >= NODE_CAP) this.nodes.clear();
    const dot = path.lastIndexOf('.');
    const parent: () => unknown = dot < 0 ? this.readRoot : this.node(path.slice(0, dot));
    const key = dot < 0 ? path : path.slice(dot + 1);
    n = FORBIDDEN.has(key)
      ? computed(() => undefined)
      : computed(() => {
          const p = parent();
          return p !== null && typeof p === 'object' ? (p as Data)[key] : undefined;
        });
    this.nodes.set(path, n);
    return n;
  }

  /** Runs `fn` as one transaction: consumers see a single root change when the outermost one ends. */
  batch<R>(fn: () => R): R {
    if (this.depth++ === 0 && this.sealed) {
      this.gen++;
      this.sealed = false;
    }
    try {
      return fn();
    } finally {
      if (--this.depth === 0) this.commit();
    }
  }

  /** Replaces the whole data root (one commit). */
  setRoot(next: Data): void {
    this.batch(() => {
      this.pending = next;
    });
  }

  /** Replaces the value at `segs` (missing or wrongly shaped parents are created); returns the previous value. */
  write(segs: readonly string[], value: unknown): unknown {
    let previous: unknown;
    this.update(segs, (current) => ((previous = current), value));
    return previous;
  }

  /** `next(current)` becomes the value at `segs`; the path is copied (or reused when owned by this transaction). */
  update<R = unknown>(segs: readonly string[], next: (current: unknown) => unknown): void {
    if (segs.length === 0) return;
    this.batch(() => {
      this.pending = this.setIn(this.raw, segs, 0, next) as Data;
    });
  }

  /** Removes the key (splices the index of an array) at `segs`; a missing parent is a no-op. */
  remove(segs: readonly string[]): unknown {
    const parent = segs.length > 1 ? getIn(this.raw, segs.slice(0, -1)) : this.raw;
    if (!isObj(parent)) return undefined;
    const key = segs[segs.length - 1]!;
    const previous = parent[key];
    this.batch(() => {
      this.pending = this.removeIn(this.raw, segs, 0) as Data;
    });
    return previous;
  }

  /** An owned (mutable for this transaction) copy of `o`. */
  own<T extends object>(o: T): T {
    if (this.owner.get(o) === this.gen) return o;
    const copy = (Array.isArray(o) ? o.slice() : { ...o }) as T;
    this.owner.set(copy, this.gen);
    return copy;
  }

  private fresh(array: boolean): Data {
    const created = (array ? [] : {}) as Data;
    this.owner.set(created, this.gen);
    return created;
  }

  private setIn(node: unknown, segs: readonly string[], i: number, next: (current: unknown) => unknown): unknown {
    const key = segs[i]!;
    if (FORBIDDEN.has(key)) throw new Error(`Unsafe path segment '${key}'`);
    const container = isObj(node) ? this.own(node) : this.fresh(isIndex(key));
    let value: unknown;
    if (i === segs.length - 1) {
      value = next(container[key]);
    } else {
      // The engine's container rule: an index segment needs an array, anything else an object.
      const child = container[key];
      const nextIsIndex = isIndex(segs[i + 1]);
      const fits = isObj(child) && (!nextIsIndex || Array.isArray(child));
      value = this.setIn(fits ? child : this.fresh(nextIsIndex), segs, i + 1, next);
    }
    if (Array.isArray(container) && isIndex(key)) (container as unknown[])[Number(key)] = value;
    else container[key] = value;
    return container;
  }

  private removeIn(node: unknown, segs: readonly string[], i: number): unknown {
    const container = this.own(node as Data);
    const key = segs[i]!;
    if (i < segs.length - 1) {
      container[key] = this.removeIn(container[key], segs, i + 1);
    } else if (Array.isArray(container) && isIndex(key)) {
      if (Number(key) < container.length) container.splice(Number(key), 1);
    } else {
      delete container[key];
    }
    return container;
  }

  private commit(): void {
    const next = this.pending;
    this.pending = null;
    // Same root object: the open generation was edited in place and nobody has observed it yet.
    if (!next || next === untracked(this.root)) return;
    this.root.set(next);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (e) {
        console.warn('SignalStore listener error:', e);
      }
    }
  }

  /** Called after every commit (behavior subjects, select). Returns the unsubscribe. */
  onCommit(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The BehaviorSubject of `path`, kept in sync after each commit when its value's reference changed. */
  subject(path: string): BehaviorSubject<unknown> {
    if (!this.subjects) {
      const subjects = (this.subjects = new Map());
      this.onCommit(() => {
        if (!this.behaviorUpdates) return;
        for (const [p, s] of subjects) {
          const v = this.read(p);
          if (!Object.is(v, s.value)) s.next(v);
        }
      });
    }
    let s = this.subjects.get(path);
    if (!s) this.subjects.set(path, (s = new BehaviorSubject(this.read(path))));
    return s;
  }

  hasSubject(path: string): boolean {
    return !!this.subjects?.has(path);
  }

  subjectsObject(): Record<string, BehaviorSubject<unknown>> {
    return Object.fromEntries(this.subjects ?? []);
  }

  /** Completes and drops the subjects and computeds at and below `path` (all of them without one). */
  cleanup(path?: string): void {
    const inside = (k: string) => !path || k === path || k.startsWith(`${path}.`);
    for (const [k, s] of this.subjects ?? []) if (inside(k)) { s.complete(); this.subjects!.delete(k); }
    for (const k of [...this.nodes.keys()]) if (inside(k)) this.nodes.delete(k);
  }

  destroy(): void {
    this.cleanup();
    this.listeners.clear();
    this.subjects = undefined;
  }
}
