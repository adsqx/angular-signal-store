/**
 * Optional JSNQ integration for @adsq/angular-signal-store.
 *
 * Import this entry point once in an application that uses `mutate`, `$query`,
 * `$queryOne`, `$liveQuery`, or `$liveQueryOne`:
 *
 * ```ts
 * import '@adsq/angular-signal-store/jsnq';
 * ```
 *
 * Importing it registers the engine synchronously as a side effect — there is no dynamic
 * import and no promise to await, so a mutation issued immediately after bootstrap works.
 * Applications that only read and write store paths never load this file, and therefore do
 * not pay for the query engine.
 */
import JsnqPipeline from '@adsq/jsnq/core/pipeline';
import {
  applyDeepSugarPatch,
  collectPipelineIntent,
  isDeepSugarAction,
  tryFastMutation,
  tryFastPipelineMutation,
  tryFastStructuralMutation,
} from '@adsq/jsnq/core/pipeline-fastpath';
import { registerJsnqBridge } from './core/jsnq-contract';
import type { FastMutationResult, JsnqBridge } from './core/jsnq-contract';

// The core contract is untyped (`unknown`) so it never imports engine types. Where the engine
// is stricter than the contract, the value is narrowed here, in exactly these two helpers.
type EngineArg<F extends (...args: never[]) => unknown, N extends number> = Parameters<F>[N];
const asEngine = <T>(value: unknown): T => value as T;
const asResult = (value: unknown): FastMutationResult | null | undefined =>
  value as FastMutationResult | null | undefined;

const angularJsnqBridge: JsnqBridge = {
  createPipeline: (data, options) =>
    new JsnqPipeline(asEngine<ConstructorParameters<typeof JsnqPipeline>[0]>(data), options),
  tryFastPipelineMutation: (value, operators, options) =>
    asResult(tryFastPipelineMutation(value, operators, options)),
  tryFastStructuralMutation: (value, intent) =>
    asResult(tryFastStructuralMutation(value, asEngine<EngineArg<typeof tryFastStructuralMutation, 1>>(intent))),
  tryFastMutation: (value, operators, options) => asResult(tryFastMutation(value, operators, options)),
  collectPipelineIntent,
  isDeepSugarAction,
  applyDeepSugarPatch: (value, criteria, actions) => asResult(applyDeepSugarPatch(value, criteria, actions)),
};

registerJsnqBridge(angularJsnqBridge);

export { angularJsnqBridge };
