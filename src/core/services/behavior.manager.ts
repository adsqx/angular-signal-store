import { BehaviorSubject, Observable, Subscription, type Observer } from 'rxjs';
import type { CreateStoreService } from '../create-store.core';
import { BaseManager } from './base.manager';
import { FlatStoreMap } from '../../utils/flat-store-map';
import { CleanupScheduler } from '../../utils/cleanup-scheduler';
import { StoreConfig } from '../../utils/store-config';
import { PathUtils } from '../../utils/path-utils';
import { StoreData } from '../../types/advanced-types';

type NextObserver<T> = Partial<Observer<T>> | ((value: T) => void) | null;

class TrackedBehaviorSubject<T> extends BehaviorSubject<T> {
  constructor(
    initialValue: T,
    private readonly onSubscribe: () => void,
    private readonly onUnsubscribe: () => void
  ) {
    super(initialValue);
  }

  override subscribe(
    observerOrNext?: NextObserver<T>,
    error?: ((error: unknown) => void) | null,
    complete?: (() => void) | null
  ): Subscription {
    this.onSubscribe();
    let subscription: Subscription;
    try {
      // Runtime accepts the observer-object form too; rxjs only types it on the 1-arg overload.
      subscription = super.subscribe(observerOrNext as (value: T) => void, error, complete);
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

interface BehaviorNode {
  subject: BehaviorSubject<unknown>;
  count: number;
}

function safeNext(subject: BehaviorSubject<unknown>, value: unknown): void {
  try {
    subject.next(value);
  } catch (e) {
    console.warn('BehaviorService emit error:', e);
  }
}

function safeComplete(subject: BehaviorSubject<unknown>, context: string): void {
  try {
    subject.complete();
  } catch (e) {
    console.warn(`BehaviorService ${context} error:`, e);
  }
}

/**
 * Manages BehaviorSubject cache for a single store instance with subscription tracking and cleanup.
 * One node per path holds the subject and its live subscriber count.
 */
export class BehaviorService<TStore extends StoreData = StoreData> extends BaseManager<TStore> {
  private nodes = new FlatStoreMap<BehaviorNode>();
  private cleanupScheduler = new CleanupScheduler();

  constructor(core: CreateStoreService<TStore>, storeName: string) {
    super(core, storeName);
  }

  private scheduleCleanup(path: string): void {
    this.cleanupScheduler.schedule(
      path,
      () => {
        const node = this.nodes.get(path);
        if (!node || node.count > 0) return;
        safeComplete(node.subject, 'cleanup');
        this.nodes.delete(path);
        this.emitSubscriptionStats();
      },
      StoreConfig.BEHAVIOR_CLEANUP_DELAY_MS
    );
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
    this.nodes.addIfMissing(path, (normalizedPath) => {
      const node: BehaviorNode = {
        count: 0,
        subject: new TrackedBehaviorSubject(
          this.readStore(normalizedPath),
          () => {
            this.cleanupScheduler.cancel(normalizedPath);
            node.count++;
            this.emitSubscriptionStats();
          },
          () => {
            node.count = node.count > 1 ? node.count - 1 : 0;
            if (node.count === 0) this.scheduleCleanup(normalizedPath);
            this.emitSubscriptionStats();
          }
        )
      };
      return node;
    });
  }

  getTrackedObservable(path: string): Observable<unknown> {
    return this.get(path).asObservable();
  }

  get(path: string): BehaviorSubject<unknown> {
    this.add(path);
    return this.nodes.get(path)!.subject;
  }

  // Zwróć istniejący BehaviorSubject bez tworzenia nowego (peek)
  peek(path: string): BehaviorSubject<unknown> | undefined {
    return this.nodes.get(path)?.subject;
  }

  // Zaktualizuj wszystkie istniejące BehaviorSubject-y na ścieżce i jej przodkach
  updateBySegments(path: string, newValue?: unknown): void {
    const paths = PathUtils.enumerateAncestors(path);
    for (let i = 0; i < paths.length; i++) {
      const subject = this.peek(paths[i]);
      if (!subject) continue; // emituj wyłącznie dla już istniejących BS
      safeNext(subject, i === 0 ? newValue : this.readStore(paths[i]));
    }
  }

  /**
   * Update all existing BehaviorSubjects under the given prefix (including the prefix).
   * This keeps nested subscriptions in sync after array reindexing or bulk updates.
   */
  updateByPrefix(prefix: string, options: { skipSelf?: boolean } = {}): void {
    const keys = this.nodes.getByPrefix(prefix);
    if (!keys.length) return;
    const normalized = this.normalizePath(prefix);
    for (const key of keys) {
      if (options.skipSelf && key === normalized) continue;
      const subject = this.peek(key);
      if (subject) safeNext(subject, this.readStore(key));
    }
  }

  getSubscriptionStats(): {
    totalNodes: number;
    activeSubscriptions: number;
    inactiveNodes: number;
    subscriptionDetails: Array<{ path: string; count: number; hasValue: boolean }>;
  } {
    const details: Array<{ path: string; count: number; hasValue: boolean }> = [];
    this.nodes.forEach((node, path) => details.push({ path, count: node.count, hasValue: true }));

    return {
      totalNodes: details.length,
      activeSubscriptions: details.reduce((sum, d) => sum + d.count, 0),
      inactiveNodes: details.filter((d) => d.count === 0).length,
      subscriptionDetails: details,
    };
  }

  // management
  isExists(path: string): boolean {
    return this.nodes.has(path);
  }

  keys(): string[] {
    return this.nodes.keys();
  }

  store(): Record<string, BehaviorSubject<unknown>> {
    const out: Record<string, BehaviorSubject<unknown>> = {};
    this.nodes.forEach((node, path) => { out[path] = node.subject; });
    return out;
  }

  cleanup(pathPrefix?: string): void {
    this.cancelScheduledCleanup(pathPrefix);
    if (!pathPrefix) {
      this.nodes.forEach((node) => safeComplete(node.subject, 'cleanup'));
      this.nodes.clear();
      return;
    }

    this.nodes.deleteByPrefix(pathPrefix, (_, node) => safeComplete(node.subject, 'cleanup'));
  }

  destroy(): void {
    this.cleanupScheduler.destroy();
    this.cleanup();
  }
}
