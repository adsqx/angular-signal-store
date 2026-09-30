type BumpStrategy = 'microtask' | 'raf';

/** Starts a deferred run; returns a cancellable frame id, or null when it cannot be cancelled. */
const START: Record<BumpStrategy, (run: () => void) => number | null> = {
  microtask: (run) => (queueMicrotask(run), null),
  raf: (run) =>
    typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(run) : (queueMicrotask(run), null),
};

/**
 * Schedules version signal bumps with optional batching, RAF scheduling and throttling.
 */
export class VersionBumpScheduler {
  private depth = 0;
  private pending = new Set<string>();
  private scheduled = false;
  private strategy: BumpStrategy = 'microtask';
  private throttle = 0;
  private lastFlush = 0;
  private rafId: number | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly flush: (items: Set<string>) => void) {}

  begin(): void {
    this.depth++;
  }

  end(): void {
    if (this.depth === 0) return;
    if (--this.depth === 0) this.schedule();
  }

  flushNow(): void {
    if (this.depth > 0) return;
    this.cancelPending();
    if (this.pending.size === 0) return;
    this.drain();
    this.lastFlush = Date.now();
  }

  queue(paths: string[]): void {
    for (const path of paths) this.pending.add(path);
  }

  setStrategy(strategy: 'microtask' | 'raf'): void {
    this.strategy = strategy;
  }

  setThrottle(ms: number): void {
    this.throttle = Math.max(0, ms);
  }

  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.rafId = START[this.strategy](() => this.execute());
  }

  destroy(): void {
    this.cancelPending();
    this.pending.clear();
    this.depth = 0;
    this.lastFlush = 0;
  }

  private cancelPending(): void {
    this.scheduled = false;
    if (this.rafId !== null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.timeoutId !== null) clearTimeout(this.timeoutId);
    this.timeoutId = null;
  }

  /** Hands the pending set to the flush callback and starts a fresh one (no copy). */
  private drain(): void {
    const items = this.pending;
    this.pending = new Set();
    this.flush(items);
  }

  private execute(): void {
    this.scheduled = false;
    this.rafId = null;
    if (this.pending.size === 0) return;
    if (this.throttle > 0) {
      const now = Date.now();
      const wait = this.throttle - (now - this.lastFlush);
      if (wait > 0) {
        this.timeoutId = setTimeout(() => {
          this.timeoutId = null;
          this.execute();
        }, wait);
        return;
      }
      this.lastFlush = now;
    }
    this.drain();
  }
}
