import { signal, type WritableSignal } from '@angular/core';
import type { ManagerCtx } from './manager-ctx';
import { PathUtils } from '../../utils/path-utils';
import { FlatStoreMap } from '../../utils/flat-store-map';

const newVersion = () => signal(0);

/** VersionManager: stores one version signal per path. */
export class VersionManager {
  private readonly nodes = new FlatStoreMap<WritableSignal<number>>();
  /** Set on first `get`; `cleanup` stays silent (no devtools event) until then. */
  private used = false;

  constructor(private readonly ctx: ManagerCtx) {}

  get(path: string): WritableSignal<number> {
    this.used = true;
    return this.nodes.getOrCreate(path, newVersion);
  }

  updateIfExists(path: string): void {
    const node = this.nodes.get(path);
    if (!node) return;
    node.update((n) => n + 1);
    if (this.ctx.devActive) this.emitDevtools('update', path);
  }

  cleanup(pathPrefix?: string): void {
    if (!this.used) return;
    if (pathPrefix) this.nodes.deleteByPrefix(pathPrefix);
    else this.nodes.clear();
    if (this.ctx.devActive) this.emitDevtools('remove', pathPrefix);
  }

  keys(): string[] {
    return this.nodes.keys();
  }

  hasNodes(): boolean {
    return this.nodes.size > 0;
  }

  /** Keys strictly below `prefix`, in insertion order. */
  descendants(prefix: string): string[] {
    if (!prefix) return [];
    const keys = this.nodes.getByPrefix(prefix);
    const self = keys.indexOf(prefix);
    if (self >= 0) keys.splice(self, 1);
    return keys;
  }

  private emitDevtools(action: 'add' | 'remove' | 'update', path = ''): void {
    this.ctx.emit({
      type: 'VERSION_STORE_UPDATE',
      payload: { storeName: this.ctx.storeName, action, path: path && PathUtils.normalizePath(path), keys: this.keys(), graph: undefined }
    });
  }
}
