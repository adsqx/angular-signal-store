import type { Operator, PipelineBuilder, PipelineEntry, PipelineMode } from './types';

/**
 * The callable-entry + `{pipe, all, first, count}` scaffold shared by the mutating and the
 * reactive pipelines: `entry(...ops)` and `entry.pipe(...ops)` accumulate operators, the
 * terminals hand the accumulated operators to `execute`.
 */
export function createPipelineEntry<R>(
  execute: (operators: Operator[], mode: PipelineMode) => R,
): PipelineEntry<R> {
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
