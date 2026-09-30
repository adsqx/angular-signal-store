import type { BehaviorSubject, Observable } from 'rxjs';
import { TrackedBehaviorSubject } from './tracked-behavior-subject';
import type { ManagerCtx } from './manager-ctx';
import { FlatStoreMap } from '../../utils/flat-store-map';
import { PathUtils } from '../../utils/path-utils';

/** Grace period before an unobserved BehaviorSubject is completed and dropped. */
const CLEANUP_DELAY_MS = 50;

interface BehaviorNode {
  subject: BehaviorSubject<unknown>;
  count: number;
}

function safely(what: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn(`BehaviorService ${what} error:`, e);
  }
}

const safeNext = (subject: BehaviorSubject<unknown>, value: unknown) => safely('emit', () => subject.next(value));
const safeComplete = (subject: BehaviorSubject<unknown>) => safely('cleanup', () => subject.complete());

/**
 * The BehaviorSubjects of a single store instance. One node per path holds the subject and its live
 * subscriber count; a node nobody observes is completed and dropped after a short delay.
 */
export class BehaviorService {
  private readonly nodes = new FlatStoreMap<BehaviorNode>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly ctx: ManagerCtx) {}

  add(path: string): void { this.node(path); }
  get(path: string): BehaviorSubject<unknown> { return this.node(path).subject; }
  getTrackedObservable(path: string): Observable<unknown> { return this.get(path).asObservable(); }
  hasNodes(): boolean { return this.nodes.size > 0; }
  isExists(path: string): boolean { return this.nodes.has(path); }
  keys(): string[] { return this.nodes.keys(); }

  store(): Record<string, BehaviorSubject<unknown>> {
    const out: Record<string, BehaviorSubject<unknown>> = {};
    this.nodes.forEach((node, path) => { out[path] = node.subject; });
    return out;
  }

  /**
   * Push fresh values to the already-existing subjects on `ancestors` (self first, then parents).
   * Self receives `newValue`; parents are re-read from the store.
   */
  updateAncestors(ancestors: readonly string[], newValue?: unknown): void {
    for (let i = 0; i < ancestors.length; i++) {
      const subject = this.nodes.get(ancestors[i])?.subject;
      if (subject) safeNext(subject, i === 0 ? newValue : this.ctx.read(ancestors[i]));
    }
  }

  /** Re-reads every existing subject under `prefix` (and `prefix` itself unless `skipSelf`), e.g. after array reindexing. */
  updateByPrefix(prefix: string, skipSelf = false): void {
    for (const key of this.nodes.getByPrefix(prefix)) {
      const subject = this.nodes.get(key)?.subject;
      if (subject && !(skipSelf && key === prefix)) safeNext(subject, this.ctx.read(key));
    }
  }

  /** Completes and drops the nodes at and below `pathPrefix` (all of them without one). */
  cleanup(pathPrefix?: string): void {
    if (!pathPrefix) {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
      this.nodes.forEach((node) => safeComplete(node.subject));
      this.nodes.clear();
      return;
    }
    const normalized = PathUtils.normalizePath(pathPrefix);
    for (const key of Array.from(this.timers.keys())) {
      if (key === normalized || key.startsWith(`${normalized}.`)) this.cancelTimer(key);
    }
    this.nodes.deleteByPrefix(pathPrefix, (_, node) => safeComplete(node.subject));
  }

  destroy(): void { this.cleanup(); }

  private node(path: string): BehaviorNode {
    return this.nodes.getOrCreate(path, (normalized) => {
      const node: BehaviorNode = {
        count: 0,
        subject: new TrackedBehaviorSubject(
          this.ctx.read(normalized),
          () => {
            this.cancelTimer(normalized);
            node.count++;
            this.emitSubscriptionStats();
          },
          () => {
            node.count = node.count > 1 ? node.count - 1 : 0;
            if (node.count === 0) this.scheduleCleanup(normalized);
            this.emitSubscriptionStats();
          }
        )
      };
      return node;
    });
  }

  private cancelTimer(path: string): void {
    clearTimeout(this.timers.get(path));
    this.timers.delete(path);
  }

  private scheduleCleanup(path: string): void {
    this.cancelTimer(path);
    this.timers.set(path, setTimeout(() => {
      this.timers.delete(path);
      try {
        const node = this.nodes.get(path);
        if (!node || node.count > 0) return;
        safeComplete(node.subject);
        this.nodes.delete(path);
        this.emitSubscriptionStats();
      } catch (error) {
        console.warn(`Cleanup failed for key "${path}":`, error);
      }
    }, CLEANUP_DELAY_MS));
  }

  private emitSubscriptionStats(): void {
    if (!this.ctx.devActive) return;
    const subscriptionDetails: Array<{ path: string; count: number; hasValue: boolean }> = [];
    this.nodes.forEach((node, path) => subscriptionDetails.push({ path, count: node.count, hasValue: true }));
    this.ctx.emit({
      type: 'BEHAVIOR_STORE_UPDATE',
      payload: {
        storeName: this.ctx.storeName,
        action: 'update',
        path: 'behavior-subscriptions',
        keys: [],
        totalNodes: subscriptionDetails.length,
        activeSubscriptions: subscriptionDetails.reduce((sum, d) => sum + d.count, 0),
        inactiveNodes: subscriptionDetails.filter((d) => d.count === 0).length,
        subscriptionDetails,
        graph: undefined
      }
    });
  }
}
