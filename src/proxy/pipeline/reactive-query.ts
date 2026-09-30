import { computed, type Signal } from '@angular/core';
import { hashString } from '../../utils/array-query-key.utils';
import { readBranch, type StoreHost } from '../store-host';
import { createPipelineEntry } from './builder';
import { openPipeline } from './context';
import type { Operator, PipelineEntry, PipelineMode, ReadMode } from './types';

const READ_MODES: Record<PipelineMode, ReadMode> = {
  all: { run: (pipeline) => pipeline.all(), empty: () => [] },
  first: { run: (pipeline) => pipeline.first() ?? undefined, empty: () => undefined },
  count: { run: (pipeline) => pipeline.count(), empty: () => 0 },
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
    return strategy.run(openPipeline('$liveQuery', host, current, operators));
  });
  service?.registerPipelineComputed(cacheKey, signal);
  return signal;
}

/** `store.branch.query(...ops).all() | .first() | .count()`: Signal-returning reactive pipeline. */
export function createReactiveEntry(host: StoreHost, path: string): PipelineEntry<Signal<unknown>> {
  return createPipelineEntry((operators, mode) => reactiveSignal(host, path, operators, mode));
}
