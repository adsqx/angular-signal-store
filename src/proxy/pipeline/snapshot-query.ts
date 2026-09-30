import type { Signal } from '@angular/core';
import { readBranch, type StoreHost } from '../store-host';
import { openPipeline, unwrapNode } from './context';
import { createReactiveEntry } from './reactive-query';
import type { Operator, ReadMode } from './types';

type QueryMode = 'all' | 'first';
type QueryMethod<R> = (...ops: Operator[]) => R;

const SNAPSHOT_MODES: Record<QueryMode, ReadMode> = {
  all: { run: (pipeline) => pipeline.all().map(unwrapNode), empty: () => [] },
  first: { run: (pipeline) => pipeline.first(), empty: () => null },
};

/**
 * One-shot snapshot query using the JSNQ DSL. Returns matched values (not result nodes),
 * mirroring solid-store's $query/$queryOne. Non-reactive: reads the current value once.
 */
export function createSnapshotQuery(host: StoreHost, path: string, mode: QueryMode): QueryMethod<unknown> {
  const strategy = SNAPSHOT_MODES[mode];
  return (...ops) => {
    const current = readBranch(host, path);
    if (current === undefined) return strategy.empty();
    return strategy.run(openPipeline('$query', host, current, ops));
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
