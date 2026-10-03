/** Optional jsnq surface for v2: `import '.../jsnq'` registers it (synchronously, as a side effect). */
import { computed, type Signal } from '@angular/core';
import JsnqPipeline from '@adsq/jsnq/core/pipeline';
import { collectPipelineIntent, tryFastMutation } from '@adsq/jsnq/core/pipeline-fastpath';
import { cloneJsonData, normalizeDotPath } from '@adsq/jsnq/data-engine';
import type { JsonLike, PipelineStats } from '@adsq/jsnq/core/types';
import { ɵsetJsnqApi as setJsnqApi } from './index';
import type { CreateStore } from './create-store';

type Op = ((p: any) => any) & { __isMutation?: boolean };
type Mode = 'all' | 'first' | 'count';
const unwrapNode = (n: unknown): unknown => (n !== null && typeof n === 'object' && 'data' in n ? (n as { data: unknown }).data : n);
const mutations = (s: PipelineStats): number =>
  s.replaces + s.updates + s.mergeUpdates + s.deletedKeys + s.deletedElements + s.inserted + s.moved + s.copied;

function open(store: CreateStore, data: unknown, ops: readonly Op[], forceClone = false): any {
  const clone = forceClone || collectPipelineIntent(ops).actions.length > 0;
  let pipeline: any = new JsnqPipeline((clone ? cloneJsonData(data as JsonLike) : data) as JsonLike, {
    trackOperations: store.signalStore.devActive,
  });
  for (const op of ops) pipeline = op(pipeline);
  return pipeline;
}

const read = (store: CreateStore, path: string): unknown => (path ? store.core.read(path) : store.core.data);
const commit = (store: CreateStore, path: string, value: unknown): void => {
  if (path) store.setValueFast(normalizeDotPath(path), value);
  else store.core.setRoot(value as Record<string, unknown>);
};

function runMutating(store: CreateStore, path: string, ops: readonly Op[], mode: Mode) {
  const current = read(store, path);
  if (current === undefined) return undefined;
  const pipeline = open(store, current, ops, true);
  const executable = mode === 'first' ? pipeline.with({ options: { ...pipeline.options, earlyTermination: true } }) : pipeline;
  const results = mode === 'count' ? [] : executable.all();
  const count = mode === 'count' ? pipeline.count() : results.length;
  const stats = executable.getStats();
  if (mutations(stats) > 0) commit(store, path, executable.data);
  return mode === 'count' ? { value: executable.data, stats, count } : { value: executable.data, stats, results };
}

function mutate(store: CreateStore, path: string) {
  return (...ops: Op[]) => {
    const current = read(store, path);
    if (current === undefined) return undefined;
    const fast = tryFastMutation(current, ops, { collectAffectedPaths: false });
    if (fast) {
      if (fast.mutations > 0) commit(store, path, fast.value);
      return fast.value;
    }
    return runMutating(store, path, ops, 'all')?.value;
  };
}

/** `entry(...ops)` / `.pipe(...ops)` accumulate; `all` / `first` / `count` run. */
function builder<R>(run: (ops: Op[], mode: Mode) => R) {
  const ops: Op[] = [];
  const b = { pipe: (...more: Op[]) => (ops.push(...more), b), all: () => run(ops, 'all'), first: () => run(ops, 'first'), count: () => run(ops, 'count') };
  return Object.assign((...more: Op[]) => (more.length ? b.pipe(...more) : b), b);
}

const READ: Record<Mode, (p: any) => unknown> = { all: (p) => p.all(), first: (p) => p.first() ?? undefined, count: (p) => p.count() };
const EMPTY: Record<Mode, unknown> = { all: [], first: undefined, count: 0 };

/** A computed over the branch: re-runs the pipeline when the branch's reference changes. */
const reactive = (store: CreateStore, path: string, ops: Op[], mode: Mode): Signal<unknown> => {
  const branch = path ? store.core.node(normalizeDotPath(path)) : store.core.readRoot;
  return computed(() => {
    const current = branch();
    return current === undefined ? EMPTY[mode] : READ[mode](open(store, current, ops));
  });
};

const API: Record<string, (store: CreateStore, path: string) => unknown> = {
  mutate,
  $mutate: mutate,
  query: (store, path) => builder((ops, mode) => reactive(store, path, ops, mode)),
  pipeline: (store, path) => (...ops: Op[]) =>
    (ops.some((op) => op.__isMutation === true)
      ? builder((o, mode) => runMutating(store, path, o, mode))
      : builder((o, mode) => reactive(store, path, o, mode)))(...ops),
  $query: (store, path) => (...ops: Op[]) => {
    const current = read(store, path);
    return current === undefined ? [] : open(store, current, ops).all().map(unwrapNode);
  },
  $queryOne: (store, path) => (...ops: Op[]) => {
    const current = read(store, path);
    return current === undefined ? null : open(store, current, ops).first();
  },
  $liveQuery: (store, path) => (...ops: Op[]) => {
    const signal = reactive(store, path, ops, 'all') as Signal<unknown[]>;
    return () => (signal() ?? []).map(unwrapNode);
  },
  $liveQueryOne: (store, path) => (...ops: Op[]) => {
    const signal = reactive(store, path, ops, 'first');
    return () => signal() ?? null;
  },
};

setJsnqApi((key, store, path) => API[key]?.(store as CreateStore, path) ?? null);
