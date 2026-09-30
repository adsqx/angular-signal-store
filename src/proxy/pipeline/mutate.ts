import type { JsonLike, PipelineStats } from '@adsq/jsnq/core/types';
import { requireJsnqBridge } from '../../core/jsnq-contract';
import { logger } from '../../utils/logger';
import { readBranch, type StoreHost } from '../store-host';
import { openPipeline } from './context';
import type {
  MutationResult,
  Operator,
  Pipeline,
  PipelineCountResult,
  PipelineExecutionResult,
  PipelineMode,
} from './types';

interface Executed {
  executable: Pipeline;
  results: unknown[];
  count: number;
}

/** Per mode: run the pipeline, then shape the response. Static, shared by every proxy node. */
const MUTATING_MODES: Record<
  PipelineMode,
  { run(pipeline: Pipeline): Executed; shape(executed: Executed, stats: PipelineStats): MutationResult }
> = {
  all: {
    run: (pipeline) => {
      const results = pipeline.all();
      return { executable: pipeline, results, count: results.length };
    },
    shape: toExecutionResult,
  },
  first: {
    run: (pipeline) => {
      const executable = pipeline.with({ options: { ...pipeline.options, earlyTermination: true } });
      const results = executable.all();
      return { executable, results, count: results.length };
    },
    shape: toExecutionResult,
  },
  count: {
    run: (pipeline) => ({ executable: pipeline, results: [], count: pipeline.count() }),
    shape: (executed, stats): PipelineCountResult => ({
      value: executed.executable.data,
      stats,
      count: executed.count,
    }),
  },
};

function toExecutionResult(executed: Executed, stats: PipelineStats): PipelineExecutionResult {
  return { value: executed.executable.data, stats, results: executed.results };
}

function mutationCount(stats: PipelineStats): number {
  return (
    stats.replaces +
    stats.updates +
    stats.mergeUpdates +
    stats.deletedKeys +
    stats.deletedElements +
    stats.inserted +
    stats.moved +
    stats.copied
  );
}

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
  const strategy = MUTATING_MODES[mode];
  const executed = strategy.run(openPipeline('mutate', host, current, operators, true));
  const stats = executed.executable.getStats();
  if (mutationCount(stats) > 0) commit(host, path, executed.executable.data);
  return strategy.shape(executed, stats);
}

const MISS = Symbol('no-fast-mutation');

/**
 * COW hot paths for mutate(): the shared jsnq engine (pipeline-fastpath.ts) computes the
 * next value without deep-cloning untouched branches, then it is committed exactly like the
 * pipeline path would. Covers the flat-array where+actions shape, the single-action
 * structural shortcuts (root insert, flat delete_key, insert_to-inside-array) and the sugar
 * deep patch. Returns MISS outside the guards, and the full clone+pipeline flow runs instead.
 */
function tryFastMutate(host: StoreHost, path: string, operators: readonly Operator[]): unknown {
  const current = readBranch(host, path);
  if (current === undefined) return MISS;

  // Opt-in fine-grained wake for sub-path branches (flat value-action shape only) - mirrors
  // SolidStore: wake exactly the changed leaves instead of the whole branch.
  const precise = !!(path && host.preciseMutationWake && host.commitMutationPrecise);
  const jsnq = requireJsnqBridge('mutate');
  const fast = jsnq.tryFastPipelineMutation(current, operators, { collectAffectedPaths: precise });
  if (fast) {
    if (fast.mutations > 0) {
      const paths = fast.affectedPaths;
      if (precise && paths && paths.length > 0) host.commitMutationPrecise?.(path, fast.value, paths);
      else commit(host, path, fast.value as JsonLike);
    }
    return fast.value;
  }

  const intent = jsnq.collectPipelineIntent(operators);
  const structural = jsnq.tryFastStructuralMutation(current, intent);
  if (structural) {
    commit(host, path, structural.value as JsonLike);
    return structural.value;
  }

  // Sugar deep patch (where + update({patch})): not representable in the raw pipeline,
  // the shared helper is the canonical semantics for every host.
  if (intent.criteria.length > 0 && intent.actions.length > 0 && intent.actions.every(jsnq.isDeepSugarAction)) {
    const patched = jsnq.applyDeepSugarPatch(current, intent.criteria, intent.actions);
    commit(host, path, patched as JsonLike);
    return patched;
  }
  return MISS;
}

/** `store.branch.mutate(...ops)`: immediate execution, auto-clones and commits to the store. */
export function createMutateMethod(host: StoreHost, path: string): (...ops: Operator[]) => unknown {
  return (...ops) => {
    const fast = tryFastMutate(host, path, ops);
    return fast !== MISS ? fast : executeMutating(host, path, ops, 'all')?.value;
  };
}
