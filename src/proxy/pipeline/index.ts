import type { StoreHost } from '../store-host';
import { createMutateMethod, executeMutating } from './mutate';
import { createLiveQuery, createPipelineEntry, createReactiveEntry, createSnapshotQuery } from './query';
import type { Operator } from './types';

type ApiMethod = (...ops: Operator[]) => unknown;
type ApiFactory = (host: StoreHost, path: string) => ApiMethod;

/** `pipeline(...)`: routes to the mutating or the reactive builder by inspecting the operators. */
const createSmartEntry: ApiFactory = (host, path) => (...ops) => {
  const entry = ops.some((op) => op.__isMutation === true)
    ? createPipelineEntry((operators, mode) => executeMutating(host, path, operators, mode))
    : createReactiveEntry(host, path);
  return entry(...ops);
};

// Cold path (runs once per accessed proxy member): static, keyed by the property name.
const API_FACTORIES: ReadonlyMap<string, ApiFactory> = new Map<string, ApiFactory>([
  ['mutate', createMutateMethod],
  ['$mutate', createMutateMethod],
  ['query', createReactiveEntry],
  ['pipeline', createSmartEntry],
  ['$query', (host, path) => createSnapshotQuery(host, path, 'all')],
  ['$queryOne', (host, path) => createSnapshotQuery(host, path, 'first')],
  ['$liveQuery', (host, path) => createLiveQuery(host, path, 'all')],
  ['$liveQueryOne', (host, path) => createLiveQuery(host, path, 'first')],
]);

/** Names of the jsnq surface exposed on a proxy node (the keys of the factory table). */
export const PROXY_API_KEYS: readonly string[] = [...API_FACTORIES.keys()];

/** The jsnq surface exposed on a proxy node (`mutate`, `query`, `$query`, ...), or null. */
export function createProxyApiMethod(key: string, host: StoreHost, path: string): ApiMethod | null {
  return API_FACTORIES.get(key)?.(host, path) ?? null;
}
