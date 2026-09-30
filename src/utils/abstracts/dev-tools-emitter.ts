import type { StoreDevToolsAction } from '../../devtools/types';
import type { DevToolsEvent } from '../../core/signal-store.service';

/** Emits store DevTools events asynchronously (action channel, plus read channel except for metrics). */
export class DevToolsEmitter {
  constructor(
    private readonly devActive: () => boolean,
    private readonly emitAction: (event: DevToolsEvent) => void,
    private readonly emitRead: (event: DevToolsEvent) => void
  ) {}

  emit(storeName: string, action: StoreDevToolsAction): void {
    if (!this.devActive()) return;
    const event: DevToolsEvent = { ...action, storeName };
    queueMicrotask(() => this.emitAction(event));
    if (action.type !== 'PROXY_METRICS') queueMicrotask(() => this.emitRead(event));
  }
}
