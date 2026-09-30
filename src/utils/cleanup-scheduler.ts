import { PathUtils } from './path-utils';

/** Manages deferred, per-key cleanup timers; scheduling a key again replaces its pending timer. */
export class CleanupScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  schedule(key: string, cleanupFn: () => void, delayMs: number): void {
    const normalized = PathUtils.normalizePath(key);
    this.cancelNormalized(normalized);
    this.timers.set(normalized, setTimeout(() => {
      this.timers.delete(normalized);
      try {
        cleanupFn();
      } catch (error) {
        console.warn(`Cleanup failed for key "${normalized}":`, error);
      }
    }, delayMs));
  }

  cancel(key: string): void {
    this.cancelNormalized(PathUtils.normalizePath(key));
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  keys(): string[] {
    return Array.from(this.timers.keys());
  }

  destroy(): void {
    this.cancelAll();
  }

  private cancelNormalized(normalized: string): void {
    const timer = this.timers.get(normalized);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(normalized);
    }
  }
}
