// The only place in src/proxy that names the jsnq pipeline type. Type-only (erased at
// build time): the runtime engine reaches the core solely through core/jsnq-contract.ts.
import type JsnqPipeline from '@adsq/jsnq/core/pipeline';
import type { JsonOperator, PipelineStats } from '@adsq/jsnq/core/types';

export type Pipeline = JsnqPipeline;
export type Operator = JsonOperator<JsnqPipeline>;
export type PipelineMode = 'all' | 'first' | 'count';

/** Per-mode strategy for read-only pipelines: how to run one and what an empty branch yields. */
export interface ReadMode {
  run(pipeline: Pipeline): unknown;
  empty(): unknown;
}

export interface PipelineExecutionResult {
  value: unknown;
  stats: PipelineStats;
  results: unknown[];
}

export interface PipelineCountResult {
  value: unknown;
  stats: PipelineStats;
  count: number;
}

export type MutationResult = PipelineExecutionResult | PipelineCountResult;

/** `pipe(...).all() | .first() | .count()` builder, generic over what a terminal returns. */
export interface PipelineBuilder<R = unknown> {
  pipe: (...ops: Operator[]) => PipelineBuilder<R>;
  all: () => R;
  first: () => R;
  count: () => R;
}

/** The callable form: `entry(...ops)` returns the builder, and it exposes the builder members too. */
export type PipelineEntry<R = unknown> = PipelineBuilder<R> & ((...ops: Operator[]) => PipelineBuilder<R>);
