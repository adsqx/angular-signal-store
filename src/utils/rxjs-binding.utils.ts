import type { Observable, OperatorFunction } from 'rxjs';
import type { CreateStoreService } from '../core/create-store.core';

type SubscribeFn = Observable<unknown>['subscribe'];
type PipeFn = (...operators: OperatorFunction<unknown, unknown>[]) => Observable<unknown>;

/** Binds `pipe` / `subscribe` to a store path; returned references are stable per path. */
export class RxJSBindingUtils {
  private readonly subscribeCache = new Map<string, SubscribeFn>();
  private readonly pipeCache = new Map<string, PipeFn>();

  constructor(private readonly createStoreService: CreateStoreService) {}

  getRxJSMethod(path: string, method: 'subscribe'): SubscribeFn;
  getRxJSMethod(path: string, method: 'pipe'): PipeFn;
  getRxJSMethod(path: string, method: 'subscribe' | 'pipe'): SubscribeFn | PipeFn {
    return method === 'pipe' ? this.pipeFor(path) : this.subscribeFor(path);
  }

  private subscribeFor(path: string): SubscribeFn {
    let fn = this.subscribeCache.get(path);
    if (!fn) {
      fn = ((...args: Parameters<SubscribeFn>) =>
        this.createStoreService.getTrackedObservable(path).subscribe(...args)) as SubscribeFn;
      this.subscribeCache.set(path, fn);
    }
    return fn;
  }

  private pipeFor(path: string): PipeFn {
    let fn = this.pipeCache.get(path);
    if (!fn) {
      fn = (...operators) =>
        this.createStoreService.getObservableWithPipe(path, (obs) => operators.reduce((acc, op) => acc.pipe(op), obs));
      this.pipeCache.set(path, fn);
    }
    return fn;
  }
}
