import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';
import type { StoreDevToolsAction } from '../devtools/types';

export type DevToolsEvent = StoreDevToolsAction & { storeName?: string };

export interface AngularStoreDevtools {
  readonly action$: Observable<DevToolsEvent | null>;
  readonly readAction$: Observable<DevToolsEvent | null>;
  emitAction(event: DevToolsEvent): void;
  emitRead(event: DevToolsEvent): void;
  getBehaviorKeys(store: Record<string, unknown>): string[];
  getComputedKeys(store: Record<string, unknown>): string[];
}

export const SIGNAL_STORE_DEVTOOLS = new InjectionToken<AngularStoreDevtools>(
  'SIGNAL_STORE_DEVTOOLS'
);

/** The slice of `SignalStore` the bus needs: the activation flag and the (optional) adapter. */
export interface DevBusHost {
  readonly devActive: boolean;
  getDevtoolsAdapter(): AngularStoreDevtools | undefined;
}

/**
 * `deferred`: both channels are delivered in microtasks, and only while dev tools are still active
 * when the microtask runs (store managers). `direct`: the read channel is delivered synchronously and
 * the action channel does not re-check activation (`SignalStore.emitDevAction`).
 */
export type DevEmitMode = 'deferred' | 'direct';

/**
 * Single devtools emission path. Action channel always; read channel (history) for everything except
 * `PROXY_METRICS`, which is action-only.
 */
export function emitDevEvent(
  host: DevBusHost,
  storeName: string,
  action: StoreDevToolsAction,
  mode: DevEmitMode = 'deferred'
): void {
  if (!host.devActive) return;
  const event: DevToolsEvent = { ...action, storeName };
  const recheck = mode === 'deferred';
  const adapter = () => (recheck && !host.devActive ? undefined : host.getDevtoolsAdapter());
  queueMicrotask(() => adapter()?.emitAction(event));
  if (action.type === 'PROXY_METRICS') return;
  if (recheck) queueMicrotask(() => adapter()?.emitRead(event));
  else host.getDevtoolsAdapter()?.emitRead(event);
}
