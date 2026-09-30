import type { Signal } from '@angular/core';
import type { StoreDevToolsAction } from '../devtools/types';
import type { AngularStoreDevtools } from './devtools-contract';
import type { CreateStoreService } from './create-store.core';
import type { SignalStore } from './signal-store.service';

type BehaviorAction = 'add' | 'update' | 'remove';

/** Structured clone with a JSON fallback: devtools events must not alias live store data. */
export function snapshotForDevtools(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
}

/**
 * The one emission path of a `CreateStore` for its store-level events. Every method returns before
 * touching the store or the adapter unless dev tools are active.
 */
export class StoreDevtools {
  constructor(
    private readonly signalStore: SignalStore,
    private readonly storeName: string,
    private readonly adapter: AngularStoreDevtools | undefined,
    private readonly service: CreateStoreService
  ) {}

  get active(): boolean {
    return this.signalStore.devActive;
  }

  setValueObserve(path: string, value: unknown, oldValue: unknown): void {
    if (!this.active) return;
    this.emit('SET_VALUE_OBSERVE', { path, value: snapshotForDevtools(value), oldValue: snapshotForDevtools(oldValue) });
  }

  computed(action: 'add' | 'remove', path: string): void {
    if (!this.active) return;
    const store = this.service.getComputedStore();
    const keys = this.adapter ? this.adapter.getComputedKeys(store) : Object.keys(store);
    this.emit('COMPUTED_STORE_UPDATE', { action, path, keys, snapshot: this.computedSnapshot() });
  }

  /** `withState`: attach the live BehaviorSubject map (`currentState`). */
  behavior(path: string, action: BehaviorAction, value?: unknown, withState = false): void {
    if (!this.active) return;
    const keys = this.adapter ? this.adapter.getBehaviorKeys(this.service.getBehaviorStore()) : [];
    this.emit('BEHAVIOR_STORE_UPDATE', {
      action,
      path,
      keys,
      value,
      currentState: withState ? this.service.getBehaviorStore() : undefined
    });
  }

  private computedSnapshot(): Record<string, unknown> {
    const store = this.service.getComputedStore();
    const snapshot: Record<string, unknown> = {};
    for (const key of Object.keys(store)) {
      try {
        snapshot[key] = (store[key] as Signal<unknown>)();
      } catch {
        snapshot[key] = '[signal]';
      }
    }
    return snapshot;
  }

  private emit(type: StoreDevToolsAction['type'], payload: Record<string, unknown>): void {
    if (!this.active) return;
    this.signalStore.emitDevAction(this.storeName, {
      type,
      payload: { storeName: this.storeName, ...payload, graph: undefined }
    } as StoreDevToolsAction);
  }
}
