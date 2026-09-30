import type { SignalStore } from '../signal-store.service';
import { emitDevEvent } from '../devtools-bus';
import { PathUtils } from '../../utils/path-utils';
import { readBySegments } from '../../utils/abstracts/path-reader';
import type { StoreDevToolsAction } from '../../devtools/types';

/**
 * What the behavior/computed/version managers share for one store: the store name, direct
 * (already normalized) reads of the store data, and the single devtools emission path.
 */
export class ManagerCtx {
  private rootRef: Record<string, unknown> | null = null;

  constructor(
    readonly storeName: string,
    private readonly signalStore: SignalStore
  ) {}

  get devActive(): boolean {
    return this.signalStore.devActive;
  }

  /** Store data root, resolved on first use (the instance registers itself after construction). */
  get root(): Record<string, unknown> {
    return (this.rootRef ??= this.signalStore.getStore(this.storeName).returnStore() as Record<string, unknown>);
  }

  /** Value at an already-normalized, non-empty path. */
  read(normalized: string): unknown {
    return readBySegments(this.root, PathUtils.splitNormalizedPath(normalized));
  }

  emit(action: StoreDevToolsAction): void {
    emitDevEvent(this.signalStore, this.storeName, action);
  }
}
