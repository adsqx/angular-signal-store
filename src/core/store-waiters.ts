import type { StoreProxy } from '../interfaces/types';
import type { StoreData } from '../types/advanced-types';

export interface WaitForStoreOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface StoreWaiter {
  resolve(store: StoreProxy<StoreData>): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** Pending `waitForStore(name)` promises, settled when the store is created, aborted, or timed out. */
export class StoreWaiters {
  private readonly byName = new Map<string, Set<StoreWaiter>>();

  /** A promise for the store `name` once it is created (the caller has already checked it does not exist yet). */
  wait<T extends StoreData>(name: string, options: WaitForStoreOptions): Promise<StoreProxy<T>> {
    const abortError = () => Object.assign(new Error(`waitForStore('${name}') aborted.`), { name: 'AbortError' });
    if (options.signal?.aborted) return Promise.reject(abortError());

    return new Promise<StoreProxy<T>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiters = this.byName.get(name) ?? new Set<StoreWaiter>();
      const onAbort = () => finishReject(abortError());
      const waiter: StoreWaiter = {
        resolve: (store) => resolve(store as StoreProxy<T>),
        reject,
        cleanup: () => {
          if (timer !== undefined) clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
        },
      };
      const finishReject = (error: Error) => {
        waiters.delete(waiter);
        if (waiters.size === 0) this.byName.delete(name);
        waiter.cleanup();
        waiter.reject(error);
      };

      waiters.add(waiter);
      this.byName.set(name, waiters);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        const timeoutMs = Math.max(0, options.timeoutMs);
        timer = setTimeout(() => finishReject(new Error(`waitForStore('${name}') timed out after ${timeoutMs}ms.`)), timeoutMs);
      }
    });
  }

  /** Settle every waiter for `name` with the created store. */
  resolve(name: string, store: StoreProxy<StoreData>): void {
    const waiters = this.byName.get(name);
    if (!waiters) return;
    this.byName.delete(name);
    for (const waiter of waiters) {
      waiter.cleanup();
      waiter.resolve(store);
    }
  }
}
