/** The optional jsnq surface (`mutate`, `$query`, ...) is registered by the `/jsnq` entry. */
export type JsnqApi = (key: string, store: unknown, path: string) => unknown;
let api: JsnqApi | undefined;

export const setJsnqApi = (implementation: JsnqApi): void => { api = implementation; };
export const jsnqApi = (): JsnqApi | undefined => api;

export function requireJsnq(name: string): never {
  throw new Error(
    `${name}() needs the JSNQ integration. Import '@adsq/angular-signal-store/jsnq' once in your application bootstrap ` +
      'to enable mutate/$query/$liveQuery.',
  );
}
