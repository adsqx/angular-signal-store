import { jsnqProxyApi, requireJsnqBridge } from '../core/jsnq-contract';
import type { StoreHost } from './store-host';

/** Names of the jsnq surface on a proxy node; the implementation lives in the `/jsnq` entry. */
export const PROXY_API_KEYS: readonly string[] = ['mutate', '$mutate', 'query', 'pipeline', '$query', '$queryOne', '$liveQuery', '$liveQueryOne'];

/** The jsnq member `key` of the node at `path`; without the `/jsnq` entry, a function that throws naming the import. */
export function createProxyApiMethod(key: string, host: StoreHost, path: string): ((...ops: unknown[]) => unknown) | null {
  const api = jsnqProxyApi();
  return api ? api(key, host, path) : () => requireJsnqBridge(key);
}
