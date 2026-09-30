import { BehaviorSubject, Observable, Subscription, type Observer } from 'rxjs';
import type { ManagerCtx } from './manager-ctx';
import { FlatStoreMap } from '../../utils/flat-store-map';
import { CleanupScheduler } from '../../utils/cleanup-scheduler';
import { PathUtils } from '../../utils/path-utils';

const BEHAVIOR_CLEANUP_DELAY_MS = 50;

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
export class BehaviorService {
  private readonly nodes = new FlatStoreMap<BehaviorNode>();
  private readonly cleanupScheduler = new CleanupScheduler();

  constructor(private readonly ctx: ManagerCtx) {}

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
      BEHAVIOR_CLEANUP_DELAY_MS
    );
  }

  private emitSubscriptionStats(): void {
    if (!this.ctx.devActive) return;
    const stats = this.getSubscriptionStats();
    this.ctx.emit({
      type: 'BEHAVIOR_STORE_UPDATE',
      payload: {
        storeName: this.ctx.storeName,
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

    const normalized = PathUtils.normalizePath(pathPrefix);
    const pref = normalized ? `${normalized}.` : '';
    for (const key of this.cleanupScheduler.keys()) {
      if (key === normalized || key.startsWith(pref)) {
        this.cleanupScheduler.cancel(key);
      }
    }
  }

  // API
  add(path: string): void {
    this.node(path);
  }

  getTrackedObservable(path: string): Observable<unknown> {
    return this.get(path).asObservable();
  }

  get(path: string): BehaviorSubject<unknown> {
    return this.node(path).subject;
  }

  // Return an existing BehaviorSubject without creating one (peek)
  peek(path: string): BehaviorSubject<unknown> | undefined {
    return this.nodes.get(path)?.subject;
  }

  hasNodes(): boolean {
    return this.nodes.size > 0;
  }

  /**
   * Push fresh values to the already-existing subjects on `ancestors` (self first, then parents).
   * Self receives `newValue`; parents are re-read from the store.
   */
  updateAncestors(ancestors: readonly string[], newValue?: unknown): void {
    for (let i = 0; i < ancestors.length; i++) {
      const subject = this.peek(ancestors[i]);
      if (!subject) continue;
      safeNext(subject, i === 0 ? newValue : this.ctx.read(ancestors[i]));
    }
  }

  /**
   * Update all existing BehaviorSubjects under the given prefix (including the prefix unless `skipSelf`).
   * This keeps nested subscriptions in sync after array reindexing or bulk updates.
   */
  updateByPrefix(prefix: string, skipSelf = false): void {
    const keys = this.nodes.getByPrefix(prefix);
    if (!keys.length) return;
    const normalized = PathUtils.normalizePath(prefix);
    for (const key of keys) {
      if (skipSelf && key === normalized) continue;
      const subject = this.peek(key);
      if (subject) safeNext(subject, this.ctx.read(key));
    }
  }

  private node(path: string): BehaviorNode {
    return this.nodes.getOrCreate(path, (normalizedPath) => {
      const node: BehaviorNode = {
        count: 0,
        subject: new TrackedBehaviorSubject(
          this.ctx.read(normalizedPath),
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
