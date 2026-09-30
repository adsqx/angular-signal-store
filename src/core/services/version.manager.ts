import { signal, type WritableSignal } from '@angular/core';
import type { CreateStoreService } from '../create-store.core';
import { BaseManager } from './base.manager';
import { FlatStoreMap } from '../../utils/flat-store-map';
import type { StoreData } from '../../types/advanced-types';

/** VersionManager: stores one version signal per path. */
export class VersionManager<TStore extends StoreData = StoreData> extends BaseManager<TStore> {
  private readonly nodes = new FlatStoreMap<WritableSignal<number>>();

  constructor(core: CreateStoreService<TStore>, storeName: string) {
    super(core, storeName);
  }

  get(path: string): WritableSignal<number> {
    return this.nodes.getOrCreate(path, () => signal(0));
  }

  updateIfExists(path: string): void {
    const node = this.nodes.get(path);
    if (!node) return;
    node.update((n) => n + 1);
    this.emitDevtoolsUpdate('update', path);
  }

  cleanup(pathPrefix?: string): void {
    if (pathPrefix) this.nodes.deleteByPrefix(pathPrefix);
    else this.nodes.clear();
    this.emitDevtoolsUpdate('remove', pathPrefix);
  }

  keys(): string[] {
    return this.nodes.keys();
  }

  hasNodes(): boolean {
    return this.nodes.size > 0;
  }

  private emitDevtoolsUpdate(action: 'add' | 'remove' | 'update', path = ''): void {
    if (!this.devActive) return;
    this.emitDevTools({
      type: 'VERSION_STORE_UPDATE',
      payload: { storeName: this.storeName, action, path: path && this.normalizePath(path), keys: this.keys(), graph: undefined }
    });
  }
}
