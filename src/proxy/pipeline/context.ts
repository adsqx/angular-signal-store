import { cloneJsonData } from '@adsq/jsnq/core/data-engine';
import type { JsonLike } from '@adsq/jsnq/core/types';
import { requireJsnqBridge } from '../../core/jsnq-contract';
import type { StoreHost } from '../store-host';
import type { Operator, Pipeline } from './types';

/** Applies the operators left to right. */
export function runOperators(pipeline: Pipeline, ops: readonly Operator[]): Pipeline {
  for (const op of ops) pipeline = op(pipeline);
  return pipeline;
}

/** Result nodes carry the matched value in `data`; plain values pass through untouched. */
export function unwrapNode(node: unknown): unknown {
  return typeof node === 'object' && node !== null && 'data' in node ? node.data : node;
}

/**
 * Builds a pipeline over `data` and applies `ops`. Data is deep-cloned when the caller
 * insists (`forceClone`) or when the operators contain actions, so the live store branch
 * is never edited in place. `api` names the entry point in the "jsnq not imported" error.
 */
export function openPipeline(
  api: string,
  host: StoreHost,
  data: unknown,
  ops: readonly Operator[],
  forceClone = false,
): Pipeline {
  const jsnq = requireJsnqBridge(api);
  const clone = forceClone || jsnq.collectPipelineIntent(ops).actions.length > 0;
  const pipeline = jsnq.createPipeline(clone ? cloneJsonData(data as JsonLike) : data, {
    trackOperations: host.createServiceGetter?.signalStore?.devActive === true,
  }) as Pipeline;
  return runOperators(pipeline, ops);
}
