import { BehaviorSubject, Observable, Subscription } from 'rxjs';
import type { CreateStoreService } from '../create-store.core';
import { BaseManager } from './base.manager';
import { FlatStoreMap } from '../../utils/flat-store-map';
import { CleanupScheduler } from '../../utils/cleanup-scheduler';
import { PathUtils } from '../../utils/path-utils';
import { StoreData } from '../../types/advanced-types';

const BEHAVIOR_CLEANUP_DELAY_MS = 50;

class TrackedBehaviorSubject<T> extends BehaviorSubject<T> {
  constructor(
    initialValue: T,
    private readonly onSubscribe: () => void,
    private readonly onUnsubscribe: () => void
  ) {
    super(initialValue);
  }

  override subscribe(observerOrNext?: any, error?: any, complete?: any): Subscription {
    this.onSubscribe();
    let subscription: Subscription;
    try {
      subscription = super.subscribe(observerOrNext, error, complete);
    } catch (error) {
      this.onUnsubscribe();
      throw error;
    }

    if (subscription.closed) {
      this.onUnsubscribe();
      return subscription;
    }

    let finalized = false;
    subscription.add(() => {
      if (finalized) return;
      finalized = true;
      this.onUnsubscribe();
    });
    return subscription;
  }
}

/**
 * Manages BehaviorSubject cache for a single store instance with subscription tracking and cleanup.
 * Refaktoryzacja z użyciem BaseManager, FlatStoreMap i CleanupScheduler.
 */
export class BehaviorService<TStore extends StoreData = StoreData> extends BaseManager<TStore> {
  private behaviorStore = new FlatStoreMap<BehaviorSubject<unknown>>();
  private behaviorSubscriptionCount = new FlatStoreMap<number>();
  private cleanupScheduler = new CleanupScheduler();

  constructor(core: CreateStoreService<TStore>, storeName: string) {
    super(core, storeName);
  }

  // helpers - using BaseManager methods
  private scheduleCleanup(path: string): void {
    this.cleanupScheduler.schedule(
      path,
      () => {
        const count = this.behaviorSubscriptionCount.get(path) || 0;
        if (count > 0) return;
        this.removeBehaviorNode(path, 'cleanup');
        this.emitSubscriptionStats();
      },
      BEHAVIOR_CLEANUP_DELAY_MS
    );
  }

  private completeSubject(subject: BehaviorSubject<unknown> | undefined, context: string): void {
    try {
      subject?.complete?.();
    } catch (e) {
      console.warn(`BehaviorService ${context} error:`, e);
    }
  }

  private removeBehaviorNode(path: string, context: string): void {
    this.completeSubject(this.behaviorStore.get(path), context);
    this.behaviorStore.delete(path);
    this.behaviorSubscriptionCount.delete(path);
  }

  private emitSubscriptionStats(): void {
    if (!this.devActive) return;
    const stats = this.getSubscriptionStats();
    this.emitDevTools({
      type: 'BEHAVIOR_STORE_UPDATE',
      payload: {
        storeName: this.storeName,
        action: 'update',
        path: 'behavior-subscriptions',
        keys: [],
        ...stats,
        graph: undefined
      }
    });
  }

  private cancelScheduledCleanup(pathPrefix?: string): void {
    if (!pathPrefix) {
      this.cleanupScheduler.cancelAll();
      return;
    }

    const normalized = this.normalizePath(pathPrefix);
    const pref = normalized ? `${normalized}.` : '';
    for (const key of this.cleanupScheduler.keys()) {
      if (key === normalized || key.startsWith(pref)) {
        this.cleanupScheduler.cancel(key);
      }
    }
  }

  // API
  add(path: string): void {
    this.behaviorStore.addIfMissing(path, (normalizedPath) => {
      const initialValue = this.readStore(normalizedPath);
      this.behaviorSubscriptionCount.set(normalizedPath, 0);

      return new TrackedBehaviorSubject(
        initialValue,
        () => {
          this.cleanupScheduler.cancel(normalizedPath);
          const currentCount = this.behaviorSubscriptionCount.get(normalizedPath) || 0;
          this.behaviorSubscriptionCount.set(normalizedPath, currentCount + 1);
          this.emitSubscriptionStats();
        },
        () => {
          const count = this.behaviorSubscriptionCount.get(normalizedPath) || 0;
          const next = count - 1;
          this.behaviorSubscriptionCount.set(normalizedPath, next > 0 ? next : 0);

          if (next <= 0) {
            this.scheduleCleanup(normalizedPath);
          }

          this.emitSubscriptionStats();
        }
      );
    });
  }

  getTrackedObservable(path: string): Observable<unknown> {
    return this.get(path).asObservable();
  }

  get(path: string): BehaviorSubject<unknown> {
    this.add(path);
    return this.behaviorStore.get(path)!;
  }

  getIfExists(path: string): BehaviorSubject<unknown> | undefined {
    return super.pathHasValue(path) ? this.peek(path) : undefined;
  }

  // Zwróć istniejący BehaviorSubject bez tworzenia nowego (peek)
  peek(path: string): BehaviorSubject<unknown> | undefined {
    return this.behaviorStore.get(path);
  }

  // Zaktualizuj wszystkie istniejące BehaviorSubject-y na ścieżce i jej przodkach
  updateBySegments(path: string, newValue?: unknown): void {
    const paths = PathUtils.enumerateAncestors(path);
    for (let i = 0; i < paths.length; i++) {
      const currentPath = paths[i];
      const bs = this.peek(currentPath);
      if (!bs) continue; // emituj wyłącznie dla już istniejących BS

      const valueToEmit = i === 0 ? newValue : this.readStore(currentPath);

      try {
        bs.next(valueToEmit as unknown);
      } catch (e) {
        console.warn('BehaviorService emit error:', e);
      }
    }
  }

  /**
   * Update all existing BehaviorSubjects under the given prefix (including the prefix).
   * This keeps nested subscriptions in sync after array reindexing or bulk updates.
   */
  updateByPrefix(prefix: string, options: { skipSelf?: boolean } = {}): void {
    const keys = this.behaviorStore.getByPrefix(prefix);
    if (!keys.length) return;
    const normalized = this.normalizePath(prefix);
    for (const key of keys) {
      if (options.skipSelf && key === normalized) continue;
      const bs = this.behaviorStore.get(key);
      if (!bs) continue;
      const value = this.readStore(key);
      try {
        bs.next(value);
      } catch (e) {
        console.warn('BehaviorService emit error:', e);
      }
    }
  }

  updateDescendantsByPrefix(prefix: string): void {
    this.updateByPrefix(prefix, { skipSelf: true });
  }

  getWithPipe(path: string, pipeFn?: (obs: Observable<unknown>) => unknown): unknown {
    const subject = this.get(path);
    return pipeFn ? pipeFn(subject) : this.getTrackedObservable(path);
  }

  // stats
  getSubscriptionCount(path: string): number {
    return this.behaviorSubscriptionCount.get(path) || 0;
  }

  hasActiveSubscriptions(path: string): boolean {
    return this.getSubscriptionCount(path) > 0;
  }

  getSubscriptionStats(): {
    totalNodes: number;
    activeSubscriptions: number;
    inactiveNodes: number;
    subscriptionDetails: Array<{ path: string; count: number; hasValue: boolean }>;
  } {
    const details: Array<{ path: string; count: number; hasValue: boolean }> = [];
    const keys = this.behaviorStore.keys();

    for (const k of keys) {
      const count = this.behaviorSubscriptionCount.get(k) || 0;
      const hasValue = this.behaviorStore.has(k);
      details.push({ path: k, count, hasValue });
    }

    return {
      totalNodes: details.length,
      activeSubscriptions: details.reduce((sum, d) => sum + d.count, 0),
      inactiveNodes: details.filter((d) => d.count === 0).length,
      subscriptionDetails: details,
    };
  }

  // management
  isExists(path: string): boolean {
    return this.behaviorStore.has(path);
  }

  keys(): string[] {
    return this.behaviorStore.keys();
  }

  store(): Record<string, BehaviorSubject<unknown>> {
    return this.behaviorStore.toObject();
  }

  delete(path: string): void {
    this.cancelScheduledCleanup(path);
    this.behaviorStore.deleteByPrefix(path, (_, subject) => {
      this.completeSubject(subject, 'delete cleanup');
    });
    this.behaviorSubscriptionCount.deleteByPrefix(path);
  }

  cleanup(pathPrefix?: string): void {
    this.cancelScheduledCleanup(pathPrefix);
    if (!pathPrefix) {
      this.behaviorStore.forEach((subject) => {
        this.completeSubject(subject, 'cleanup');
      });
      this.behaviorStore.clear();
      this.behaviorSubscriptionCount.clear();
      return;
    }

    this.behaviorStore.deleteByPrefix(pathPrefix, (_, subject) => {
      this.completeSubject(subject, 'cleanup');
    });
    this.behaviorSubscriptionCount.deleteByPrefix(pathPrefix);
  }

  destroy(): void {
    this.cleanupScheduler.destroy();
    this.cleanup();
  }

  cleanupInactive(pathPrefix?: string): void {
    const keysToClean: string[] = [];

    if (!pathPrefix) {
      // Cleanup all inactive nodes
      this.behaviorStore.forEach((_, key) => {
        if ((this.behaviorSubscriptionCount.get(key) || 0) === 0) {
          keysToClean.push(key);
        }
      });
    } else {
      // Cleanup inactive nodes under prefix
      const normalized = this.normalizePath(pathPrefix.replace(/\.$/, ''));
      const prefixMatch = normalized ? normalized + '.' : '';

      this.behaviorStore.forEach((_, key) => {
        if ((key === normalized || key.startsWith(prefixMatch)) && (this.behaviorSubscriptionCount.get(key) || 0) === 0) {
          keysToClean.push(key);
        }
      });
    }

    // Perform cleanup
    for (const key of keysToClean) {
      this.removeBehaviorNode(key, 'cleanup');
    }

    this.emitSubscriptionStats();
  }

}
