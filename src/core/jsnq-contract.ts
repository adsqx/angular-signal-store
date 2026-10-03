/**
 * Registration contract for the optional JSNQ integration. The core must not import the JSNQ
 * pipeline (that would pull the whole query and mutation engine into every application), so it
 * holds this contract and the `@adsq/angular-signal-store/jsnq` entry point registers an
 * implementation synchronously as a side effect of being imported: a store mutation must never
 * depend on a promise resolving first. The seam is intentionally untyped: operators and pipelines
 * cross it as `unknown` and are re-cast by the caller that owns the real types.
 */
export interface JsnqBridge {
  createPipeline(data: unknown, options: { trackOperations: boolean }): unknown;
  tryFastPipelineMutation(
    value: unknown,
    operators: readonly unknown[],
    options: { collectAffectedPaths: boolean },
  ): FastMutationResult | null | undefined;
  tryFastStructuralMutation(value: unknown, intent: PipelineIntent): FastMutationResult | null | undefined;
  /** The whole fast cascade (flat copy-on-write mutation, structural shortcut, deep sugar patch) in one call. */
  tryFastMutation(
    value: unknown,
    operators: readonly unknown[],
    options: { collectAffectedPaths: boolean },
  ): FastMutationResult | null | undefined;
  collectPipelineIntent(operators: readonly unknown[]): PipelineIntent;
  isDeepSugarAction(action: unknown): boolean;
  applyDeepSugarPatch(value: unknown, criteria: unknown[], actions: unknown[]): FastMutationResult | null | undefined;
}

export interface FastMutationResult {
  value: unknown;
  mutations: number;
  affectedPaths?: string[];
}

export interface PipelineIntent {
  criteria: unknown[];
  actions: unknown[];
}

let bridge: JsnqBridge | undefined;

/** Called by the `@adsq/angular-signal-store/jsnq` entry point. */
export function registerJsnqBridge(implementation: JsnqBridge): void {
  bridge = implementation;
}

/** Returns the bridge or throws an actionable error naming the missing import. */
export function requireJsnqBridge(api: string): JsnqBridge {
  if (!bridge) {
    throw new Error(
      `${api}() needs the JSNQ integration. Import '@adsq/angular-signal-store/jsnq' once ` +
        `in your application bootstrap to enable mutate/$query/$liveQuery. It is a separate ` +
        `entry point so applications that only read and write store paths do not pay for the ` +
        `query engine.`,
    );
  }
  return bridge;
}
