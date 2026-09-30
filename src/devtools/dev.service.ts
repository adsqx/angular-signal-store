import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import type { DevToolsEvent } from '../core/signal-store.service';
import type { AngularStoreDevtools } from '../core/devtools-contract';
import type { StoreDevToolsAction } from './types';

type ActionType = StoreDevToolsAction['type'];
type PayloadOf<K extends ActionType> = Extract<StoreDevToolsAction, { type: K }>['payload'];

/** Builds a typed devtools action; the payload type is derived from the action type. */
function act<K extends ActionType>(type: K, payload: PayloadOf<K>): StoreDevToolsAction {
  return { type, payload } as StoreDevToolsAction;
}

const arrays = (value: unknown) => (value as unknown[]) ?? [];

@Injectable({
  providedIn: 'root'
})
export class DevService implements AngularStoreDevtools {
  // Dedicated devtools bus (no nulls exposed)
  private actionSubject = new BehaviorSubject<DevToolsEvent | null>(null);
  private readActionSubject = new BehaviorSubject<DevToolsEvent | null>(null);

  public action$: Observable<DevToolsEvent | null> = this.actionSubject.asObservable();
  public readAction$: Observable<DevToolsEvent | null> = this.readActionSubject.asObservable();

  constructor() {}

  // Explicit emitters to avoid leaking subjects
  emitAction(event: DevToolsEvent) {
    this.actionSubject.next(event);
  }
  emitRead(event: DevToolsEvent) {
    this.readActionSubject.next(event);
  }

  setValue(path: string, value: unknown, oldValue?: unknown) {
    this.actionSubject.next(act('SET_VALUE', { path, value, oldValue }));
  }

  setArrayOperation(path: string, method: string, args: unknown[], oldValue?: unknown, newValue?: unknown) {
    this.actionSubject.next(act('ARRAY_OPERATION', { path, method, args, oldValue: arrays(oldValue), newValue: arrays(newValue) }));
  }

  logUnsubscribe(path: string) {
    this.actionSubject.next(act('UNSUBSCRIBE', { path }));
  }

  logCleanup(path: string, cleanedPaths: string[], cleanedCount: number) {
    this.actionSubject.next(act('CLEANUP', { path, cleanedPaths, cleanedCount }));
  }

  logProxyMetrics(metrics: { hits: number; misses: number; hitRate: number; cacheSize: number }) {
    const { hits, misses, hitRate, cacheSize } = metrics;
    this.actionSubject.next(act('PROXY_METRICS', { path: 'proxy-cache', hits, misses, hitRate, cacheSize, cacheDump: [], cacheKeys: [] }));
  }

  computedStoreUpdate(storeName: string, operation: 'add' | 'remove' | 'update', key: string, keys: string[], snapshot?: Record<string, unknown>) {
    this.actionSubject.next(act('COMPUTED_STORE_UPDATE', { storeName, action: operation, path: key, keys, snapshot }));
  }

  behaviorStoreUpdate(storeName: string, operation: 'add' | 'remove' | 'update', key: string, keys: string[], value?: unknown, snapshot?: Record<string, unknown>) {
    this.actionSubject.next(act('BEHAVIOR_STORE_UPDATE', { storeName, action: operation, path: key, keys, value, snapshot }));
  }

  arrayOperation(storeName: string, path: string, method: string, args: unknown[], oldValue?: unknown, newValue?: unknown) {
    this.actionSubject.next(act('ARRAY_OPERATION', { storeName, path, method, args, oldValue: arrays(oldValue), newValue: arrays(newValue) }));
  }

  arrayOperationUniversal(payload: { storeName?: string; method: string; path: string; oldValue?: unknown; newValue?: unknown; addedElements?: unknown[]; removedElements?: unknown[]; indexes?: number[]; args?: unknown[] }) {
    const { storeName, method, path, oldValue, newValue, addedElements, removedElements, indexes, args } = payload;
    this.actionSubject.next(act('ARRAY_OPERATION', {
      storeName, path, method, args: args ?? [], oldValue: arrays(oldValue), newValue: arrays(newValue),
      added: addedElements, removed: removedElements, indexes
    }));
  }

  setValueObserve(storeName: string, path: string, value: unknown, oldValue?: unknown) {
    this.actionSubject.next(act('SET_VALUE_OBSERVE', { storeName, path, value, oldValue }));
  }

  getDisplayData() {
    return this.readAction$;
  }

  createVisualizer() {
    if (typeof window === 'undefined') return;
    // A panel already rendered in an Angular template (<app-dev-tools> in app.html) must stay: removing
    // it destroys the component, and a dynamically added element would not be bootstrapped again.
    if (document.querySelector('app-dev-tools')) return;
    // A standalone component in the root component's `imports` is bootstrapped automatically if its
    // element exists before change detection runs.
    document.body.appendChild(document.createElement('app-dev-tools'));
  }

  versionStoreUpdate(storeName: string, operation: 'add' | 'remove' | 'update', path: string, keys: string[], graph?: unknown) {
    this.emitAction({ ...act('VERSION_STORE_UPDATE', { storeName, action: operation, path, keys, graph }), storeName });
  }

  proxyMetrics(storeName: string, metrics: { hits: number; misses: number; hitRate: number; cacheSize: number; cacheDump?: Array<{ key: string; value: string }>; cacheKeys?: string[] }) {
    this.emitAction({
      ...act('PROXY_METRICS', { path: 'proxy-cache', ...metrics, cacheDump: metrics.cacheDump ?? [], cacheKeys: metrics.cacheKeys ?? [] }),
      storeName
    });
  }

  behaviorSubscriptionStats(storeName: string, stats: { totalNodes?: number; activeSubscriptions?: number; inactiveNodes?: number; subscriptionDetails?: Array<{ path: string; count: number; hasValue: boolean }> }) {
    this.emitAction({
      ...act('BEHAVIOR_STORE_UPDATE', { storeName, action: 'update', path: 'behavior-subscriptions', keys: [], ...stats, graph: undefined }),
      storeName
    });
  }

  computedStoreUpdateWithSnapshot(storeName: string, operation: 'add' | 'remove' | 'update', path: string, keys: string[], snapshot?: Record<string, unknown>, graph?: unknown) {
    this.emitActionAsync({ ...act('COMPUTED_STORE_UPDATE', { storeName, action: operation, path, keys, snapshot, graph }), storeName });
  }

  behaviorStoreUpdateWithState(storeName: string, operation: 'add' | 'remove' | 'update', path: string, keys: string[], value?: unknown, currentState?: Record<string, BehaviorSubject<unknown>>, graph?: unknown) {
    this.emitActionAsync({ ...act('BEHAVIOR_STORE_UPDATE', { storeName, action: operation, path, keys, value, currentState, graph }), storeName });
  }

  // Emit action in microtask (non-blocking)
  private emitActionAsync(event: DevToolsEvent) {
    queueMicrotask(() => this.emitAction(event));
  }

  /** Behavior subscription statistics for DevTools. */
  getBehaviorSubscriptionStats(
    behaviorStore: Record<string, BehaviorSubject<unknown>>,
    subscriptionCounts: Record<string, number>
  ): {
    totalNodes: number;
    activeSubscriptions: number;
    inactiveNodes: number;
    subscriptionDetails: Array<{ path: string; count: number; hasValue: boolean }>
  } {
    const details: Array<{ path: string; count: number; hasValue: boolean }> = [];
    let activeSubscriptions = 0;
    let inactiveNodes = 0;

    for (const k of Object.keys(behaviorStore)) {
      const count = subscriptionCounts[k] || 0;
      activeSubscriptions += count;
      if (count === 0) inactiveNodes++;
      details.push({ path: k, count, hasValue: !!behaviorStore[k] });
    }

    return { totalNodes: details.length, activeSubscriptions, inactiveNodes, subscriptionDetails: details };
  }

  getBehaviorKeys(behaviorStore: Record<string, unknown>): string[] {
    return Object.keys(behaviorStore);
  }

  getComputedKeys(computedStore: Record<string, unknown>): string[] {
    return Object.keys(computedStore);
  }
}
