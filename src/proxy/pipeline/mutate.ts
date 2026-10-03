import type { JsonLike, PipelineStats } from '@adsq/jsnq/core/types';
import { requireJsnqBridge } from '../../core/jsnq-contract';
import { logger } from '../../utils/logger';
import { readBranch, type StoreHost } from '../store-host';
import { openPipeline } from './query';
import type { MutationResult, Operator, PipelineMode } from './types';

const mutationCount = (s: PipelineStats): number =>
  s.replaces + s.updates + s.mergeUpdates + s.deletedKeys + s.deletedElements + s.inserted + s.moved + s.copied;

/** Writes a mutated branch back: one setValue for a sub-path, a per-key diff for the root. */
function commit(host: StoreHost, path: string, data: JsonLike): void {
  const service = host.createServiceGetter;
  service?.beginAction();
  try {
    if (path) {
      host.setValue(path, data);
      return;
    }
    const next = data as Record<string, unknown>;
    const current = host.store as Record<string, unknown>;
    for (const key of new Set([...Object.keys(current || {}), ...Object.keys(next || {})])) {
      if (key in next) host.setValue(key, next[key]);
      else host.deleteValue(key);
    }
  } finally {
    service?.endAction();
  }
}

/** Full clone + pipeline flow: `pipeline().all()/first()/count()` on mutating operators. */
export function executeMutating(
  host: StoreHost,
  path: string,
  operators: readonly Operator[],
  mode: PipelineMode,
): MutationResult | undefined {
  const current = readBranch(host, path);
  if (current === undefined) {
    logger.warn(`Cannot mutate undefined value at path: ${path || 'root'}`);
    return undefined;
  }
  const pipeline = openPipeline('mutate', host, current, operators, true);
  // `first` stops at the first match; `count` only counts.
  const executable = mode === 'first' ? pipeline.with({ options: { ...pipeline.options, earlyTermination: true } }) : pipeline;
  const results = mode === 'count' ? [] : executable.all();
  const count = mode === 'count' ? pipeline.count() : results.length;
  const stats = executable.getStats();
  if (mutationCount(stats) > 0) commit(host, path, executable.data);
  const value = executable.data;
  return mode === 'count' ? { value, stats, count } : { value, stats, results };
}

const MISS = Symbol('no-fast-mutation');

/**
 * COW hot paths for mutate(): jsnq's fast cascade (shared with the Solid store) computes the next
 * value without deep-cloning untouched branches, then it is committed exactly like the pipeline
 * path would. Returns MISS outside its guards, and the full clone+pipeline flow runs instead.
 */
function tryFastMutate(host: StoreHost, path: string, operators: readonly Operator[]): unknown {
  const current = readBranch(host, path);
  if (current === undefined) return MISS;

  // Opt-in fine-grained wake for sub-path branches (flat value-action shape only) - mirrors
  // SolidStore: wake exactly the changed leaves instead of the whole branch.
  const precise = !!(path && host.preciseMutationWake && host.commitMutationPrecise);
  const fast = requireJsnqBridge('mutate').tryFastMutation(current, operators, { collectAffectedPaths: precise });
  if (!fast) return MISS;
  if (fast.mutations > 0) {
    const paths = fast.affectedPaths;
    if (precise && paths && paths.length > 0) host.commitMutationPrecise?.(path, fast.value, paths);
    else commit(host, path, fast.value as JsonLike);
  }
  return fast.value;
}

/** `store.branch.mutate(...ops)`: immediate execution, auto-clones and commits to the store. */
export function createMutateMethod(host: StoreHost, path: string): (...ops: Operator[]) => unknown {
  return (...ops) => {
    const fast = tryFastMutate(host, path, ops);
    return fast !== MISS ? fast : executeMutating(host, path, ops, 'all')?.value;
  };
}
