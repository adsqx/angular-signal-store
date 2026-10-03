/**
 * v2 core: the store data is immutable and every read path has its own signal (a signal tree).
 *
 * - A write copies the path from the root to the target (structural sharing), then sets the signals of
 *   that path's existing nodes and of the changed part of its subtree. Sibling branches and untouched
 *   array elements get no notification at all, and `signal.set` skips values whose reference is unchanged.
 * - Copy only when someone has seen it: a copy made by a write stays editable in place (across commits)
 *   until the data is observed (a node read, or a raw read that hands out a reference). The next write
 *   after an observation starts a new generation and copies again. A loop of writes with no reads in
 *   between costs about what in-place mutation does; `batch()` makes one commit.
 */
import { computed, signal, untracked, type Signal, type WritableSignal } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { normalizeDotPath, splitDotPath } from '@adsq/jsnq/data-engine';

export type Data = Record<string, unknown>;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

export const isObj = (v: unknown): v is Data => v !== null && typeof v === 'object';
export function isIndex(s: string | undefined): boolean {
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}
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

interface Node {
  readonly path: string;
  readonly segs: readonly string[];
  readonly parent: Node | null;
  readonly value: WritableSignal<unknown>;
  /** What consumers read: marks the data as observed, then reads `value`. */
  readonly read: Signal<unknown>;
  /** Existing child nodes. */
  readonly children: Set<Node>;
  /** The non-index ones among them (`length`, named keys), refreshed also by a ranged array write. */
  readonly named: Set<Node>;
  /** The commit that last queued this node for a refresh. */
  mark: number;
  /** The commit that last queued this node's whole subtree. */
  tree: number;
  /** Its value in the commit `seen` (memoized during a commit, so each node reads one key of its parent). */
  seen: number;
  next: unknown;
}

/** Array elements of a written path that can have changed: indexes `from` up to (not including) `until`. */
export interface Range { from: number; until: number }

const merge = (a: Range | null, b: Range | null): Range | null =>
  a && b ? { from: Math.min(a.from, b.from), until: Math.max(a.until, b.until) } : null;

export class StoreCore {
  /** The whole data, for root-level consumers; nodes are refreshed from it on every commit. */
  readonly root: WritableSignal<Data>;
  private pending: Data | null = null;
  private depth = 0;
  private readonly owner = new WeakMap<object, number>();
  private gen = 0;
  private sealed = true;
  private readonly nodes = new Map<string, Node>();
  private readonly topLevel = new Set<Node>();
  /** Commit counter: `Node.mark` / `Node.seen` compare against it. */
  private mark = 0;
  private committed: Data | null = null;
  private readonly queue: Node[] = [];
  /**
   * Paths written in the open transaction with the array range that can have changed (`null`: the whole
   * subtree). The first one is kept in fields, so a single write allocates no map.
   */
  private firstPath: string | null = null;
  private firstRange: Range | null = null;
  private moreTouched: Map<string, Range | null> | null = null;
  private readonly listeners = new Set<() => void>();
  private subjects?: Map<string, BehaviorSubject<unknown>>;
  behaviorUpdates = true;

  constructor(initial: Data) {
    this.root = signal(initial);
  }

  /** Root read for root-level consumers: marks the data as observed. */
  readonly readRoot = (): Data => {
    this.sealed = true;
    return this.root();
  };

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

  /** The signal of a normalized path (its ancestors get nodes too, so the tree has no gaps). */
  node(path: string): Signal<unknown> {
    return this.ensure(path).read;
  }

  private ensure(path: string): Node {
    let n = this.nodes.get(path);
    if (n) return n;
    const dot = path.lastIndexOf('.');
    const parent = dot < 0 ? null : this.ensure(path.slice(0, dot));
    const segs = segmentsOf(path);
    const value = signal<unknown>(getIn(this.raw, segs));
    n = {
      path,
      segs,
      parent,
      mark: 0,
      tree: 0,
      seen: 0,
      next: undefined,
      value,
      read: computed(() => {
        this.sealed = true;
        return value();
      }),
      children: new Set(),
      named: new Set(),
    };
    this.nodes.set(path, n);
    if (!parent) this.topLevel.add(n);
    else {
      parent.children.add(n);
      if (!isIndex(path.slice(dot + 1))) parent.named.add(n);
    }
    return n;
  }

  /** Runs `fn` as one transaction: signals change once, when the outermost one ends. */
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
      this.touch('', null);
    });
  }

  /** Replaces the value at `segs` (missing or wrongly shaped parents are created); returns the previous value. */
  write(segs: readonly string[], value: unknown, path?: string): unknown {
    let previous: unknown;
    this.update(segs, (current) => ((previous = current), value), null, path);
    return previous;
  }

  /**
   * `next(current)` becomes the value at `segs`. `range` limits which array elements can have changed,
   * so a push or pop does not revisit the array's other elements.
   */
  update(segs: readonly string[], next: (current: unknown) => unknown, range: Range | null = null, path = segs.join('.')): void {
    if (segs.length === 0) return;
    this.batch(() => {
      this.pending = this.setIn(this.raw, segs, 0, next) as Data;
      this.touch(path, range);
    });
  }

  /** Removes the key (splices the index of an array) at `segs`; a missing parent is a no-op. */
  remove(segs: readonly string[]): unknown {
    const parent = segs.length > 1 ? getIn(this.raw, segs.slice(0, -1)) : this.raw;
    if (!isObj(parent)) return undefined;
    const key = segs[segs.length - 1]!;
    const previous = parent[key];
    const length = Array.isArray(parent) ? parent.length : 0; // before the splice: `parent` may be edited in place
    this.batch(() => {
      this.pending = this.removeIn(this.raw, segs, 0) as Data;
      // Removing an array element shifts the ones after it.
      if (Array.isArray(parent) && isIndex(key)) this.touch(segs.slice(0, -1).join('.'), { from: Number(key), until: length });
      else this.touch(segs.join('.'), null);
    });
    return previous;
  }

  /** An owned (editable in this generation) copy of `o`. */
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

  private touch(path: string, range: Range | null): void {
    if (this.firstPath === null || this.firstPath === path) {
      this.firstRange = this.firstPath === null ? range : merge(this.firstRange, range);
      this.firstPath = path;
      return;
    }
    const more = (this.moreTouched ??= new Map());
    more.set(path, more.has(path) ? merge(more.get(path)!, range) : range);
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
      // A replaced value changes everything below it, not only the written path.
      if (!fits) this.touch(segs.slice(0, i + 1).join('.'), null);
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
    const first = this.firstPath;
    const firstRange = this.firstRange;
    const more = this.moreTouched;
    this.pending = this.firstPath = this.firstRange = this.moreTouched = null;
    if (!next) return;
    if (next !== untracked(this.root)) this.root.set(next);
    // Nodes to refresh: the existing ancestors-or-self of each written path and the changed part of its subtree.
    this.mark++;
    this.committed = next;
    const queue = this.queue;
    if (first !== null) this.visit(first, firstRange);
    if (more) for (const [path, range] of more) this.visit(path, range);
    for (let i = 0; i < queue.length; i++) queue[i]!.value.set(this.valueOf(queue[i]!));
    for (let i = 0; i < queue.length; i++) queue[i]!.next = undefined; // holds no data between commits
    queue.length = 0;
    this.committed = null;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (e) {
        console.warn('SignalStore listener error:', e);
      }
    }
  }

  private queueNode(n: Node): void {
    if (n.mark === this.mark) return;
    n.mark = this.mark;
    this.queue.push(n);
  }

  /** `n` and its existing descendants. */
  private queueTree(n: Node): void {
    if (n.tree === this.mark) return; // an ancestor queued alone can still need its subtree queued
    n.tree = this.mark;
    this.queueNode(n);
    for (const c of n.children) this.queueTree(c);
  }

  /** Value of `n` in the data being committed (each node reads one key of its parent's memoized value). */
  private valueOf(n: Node): unknown {
    if (n.seen === this.mark) return n.next;
    const holder = n.parent ? this.valueOf(n.parent) : this.committed;
    const key = n.segs[n.segs.length - 1]!;
    n.seen = this.mark;
    return (n.next = isObj(holder) && !FORBIDDEN.has(key) ? holder[key] : undefined);
  }

  private visit(path: string, range: Range | null): void {
    const self = path ? this.nodes.get(path) : undefined;
    let up: Node | null | undefined = self;
    for (let end = path.lastIndexOf('.'); !up && end > 0; end = path.lastIndexOf('.', end - 1)) up = this.nodes.get(path.slice(0, end));
    for (; up; up = up.parent) {
      this.queueNode(up);
      // An array's named children can change with any write below it: `length`, and keys a copy drops.
      if (up !== self && up.named.size && Array.isArray(this.valueOf(up))) for (const c of up.named) this.queueTree(c);
    }
    if (!path) for (const c of this.topLevel) this.queueTree(c);
    else if (self && range === null) for (const c of self.children) this.queueTree(c);
    else if (self) {
      for (const c of self.named) this.queueTree(c);
      for (let i = range!.from; i < range!.until; i++) {
        const c = this.nodes.get(`${path}.${i}`);
        if (c) this.queueTree(c);
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

  subjectsObject(): Record<string, BehaviorSubject<unknown>> {
    return Object.fromEntries(this.subjects ?? []);
  }

  /** Completes and drops the subjects at and below `path` (all of them without one). Node signals stay valid. */
  cleanup(path?: string): void {
    const inside = (k: string) => !path || k === path || k.startsWith(`${path}.`);
    for (const [k, s] of this.subjects ?? []) if (inside(k)) { s.complete(); this.subjects!.delete(k); }
  }

  destroy(): void {
    this.cleanup();
    this.listeners.clear();
    this.subjects = undefined;
  }
}
