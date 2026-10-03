import { computed, type Signal } from '@angular/core';
import { cloneJsonData } from '@adsq/jsnq/data-engine';
import type { JsonLike } from '@adsq/jsnq/core/types';
import JsnqPipeline from '@adsq/jsnq/core/pipeline';
import { collectPipelineIntent } from '@adsq/jsnq/core/pipeline-fastpath';
import { hashString } from '../../utils/array-query';
import { readBranch, type StoreHost } from '../store-host';
import type { Operator, Pipeline, PipelineBuilder, PipelineEntry, PipelineMode, ReadMode } from './types';

type QueryMode = 'all' | 'first';
type QueryMethod<R> = (...ops: Operator[]) => R;

/**
 * The callable-entry + `{pipe, all, first, count}` scaffold shared by the mutating and the
 * reactive pipelines: `entry(...ops)` and `entry.pipe(...ops)` accumulate operators, the
 * terminals hand the accumulated operators to `execute`.
 */
export function createPipelineEntry<R>(execute: (operators: Operator[], mode: PipelineMode) => R): PipelineEntry<R> {
  const operators: Operator[] = [];
  const builder: PipelineBuilder<R> = {
    pipe: (...ops) => {
      operators.push(...ops);
      return builder;
    },
    all: () => execute(operators, 'all'),
    first: () => execute(operators, 'first'),
    count: () => execute(operators, 'count'),
  };
  const entry = (...ops: Operator[]): PipelineBuilder<R> => (ops.length ? builder.pipe(...ops) : builder);
  return Object.assign(entry, builder);
}

/** Result nodes carry the matched value in `data`; plain values pass through untouched. */
const unwrapNode = (node: unknown): unknown =>
  typeof node === 'object' && node !== null && 'data' in node ? node.data : node;

/**
 * Builds a pipeline over `data` and applies `ops`. Data is deep-cloned when the caller
 * insists (`forceClone`) or when the operators contain actions, so the live store branch
 * is never edited in place. `api` names the entry point in the "jsnq not imported" error.
 */
export function openPipeline(host: StoreHost, data: unknown, ops: readonly Operator[], forceClone = false): Pipeline {
  const clone = forceClone || collectPipelineIntent(ops).actions.length > 0;
  let pipeline = new JsnqPipeline(clone ? cloneJsonData(data as JsonLike) : data as JsonLike, {
    trackOperations: host.createServiceGetter?.signalStore?.devActive === true,
  }) as unknown as Pipeline;
  for (const op of ops) pipeline = op(pipeline);
  return pipeline;
}

const READ_MODES: Record<PipelineMode, ReadMode> = {
  all: { run: (pipeline) => pipeline.all(), empty: () => [] },
  first: { run: (pipeline) => pipeline.first() ?? undefined, empty: () => undefined },
  count: { run: (pipeline) => pipeline.count(), empty: () => 0 },
};

const SNAPSHOT_MODES: Record<QueryMode, ReadMode> = {
  all: { run: (pipeline) => pipeline.all().map(unwrapNode), empty: () => [] },
  first: { run: (pipeline) => pipeline.first(), empty: () => null },
};

// Operators without an explicit __cacheKey get a stable per-function id for the cache key.
const operatorIds = new WeakMap<Operator, number>();
let nextOperatorId = 0;

function operatorCacheSegment(operator: Operator): string {
  if (operator.__cacheKey) return String(operator.__cacheKey);
  let id = operatorIds.get(operator);
  if (id === undefined) operatorIds.set(operator, (id = ++nextOperatorId));
  return `fn:${id}`;
}

/** One version-tracked computed per (branch, operators, mode), shared through the proxy cache. */
function reactiveSignal(host: StoreHost, path: string, operators: Operator[], mode: PipelineMode): Signal<unknown> {
  const service = host.createServiceGetter;
  const hash = hashString(operators.map(operatorCacheSegment).join('|') + mode);
  const cacheKey = `${path ? `${path}.` : ''}$pipeline.${hash}`;

  const cached = service?.getSignalFromProxyCache(cacheKey);
  if (cached) return cached;

  const strategy = READ_MODES[mode];
  const signal = computed(() => {
    if (service) service.getVersion(service.resolveVersionPathNormalized(path))();
    const current = readBranch(host, path);
    if (current === undefined) return strategy.empty();
    return strategy.run(openPipeline(host, current, operators));
  });
  service?.registerPipelineComputed(cacheKey, signal);
  return signal;
}

/** `store.branch.query(...ops).all() | .first() | .count()`: Signal-returning reactive pipeline. */
export function createReactiveEntry(host: StoreHost, path: string): PipelineEntry<Signal<unknown>> {
  return createPipelineEntry((operators, mode) => reactiveSignal(host, path, operators, mode));
}

/**
 * One-shot snapshot query using the JSNQ DSL. Returns matched values (not result nodes),
 * mirroring solid-store's $query/$queryOne. Non-reactive: reads the current value once.
 */
export function createSnapshotQuery(host: StoreHost, path: string, mode: QueryMode): QueryMethod<unknown> {
  const strategy = SNAPSHOT_MODES[mode];
  return (...ops) => {
    const current = readBranch(host, path);
    if (current === undefined) return strategy.empty();
    return strategy.run(openPipeline(host, current, ops));
  };
}

/**
 * Reactive live query: a callable accessor (read it in a computed/effect/template) that
 * recomputes when the queried branch changes. Built on the reactive pipeline entry
 * (version-tracked Angular computed) and maps result nodes to matched values.
 */
export function createLiveQuery(host: StoreHost, path: string, mode: QueryMode): QueryMethod<() => unknown> {
  return (...ops) => {
    const chained = createReactiveEntry(host, path)(...ops);
    if (mode === 'first') {
      const signal = chained.first();
      return () => signal() ?? null;
    }
    const signal = chained.all() as Signal<unknown[] | undefined>;
    return () => (signal() ?? []).map(unwrapNode);
  };
}
