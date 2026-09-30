import { Observable, Subscription, combineLatest } from 'rxjs';
import type { VersionDependencyMode } from '../utils/path-utils';

/** What `select()` needs from its store service. */
export interface SelectHost<TState> {
  /** Store proxy the projection reads (falls back to the computed store for standalone instances). */
  proxy(): TState;
  /** True when `proxy()` had to fall back to the computed store. */
  usingFallback(): boolean;
  computedKeys(): string[];
  trackProjection<TOut>(project: () => TOut): { value: TOut; deps: string[] };
  resolveVersionPath(normalized: string): string;
  observe(versionPath: string): Observable<unknown>;
  dependencyMode(): VersionDependencyMode;
}

/** Dev-only: warn when dependency selection is too broad in 'container' mode. */
export function warnOnWideDependencies(mode: VersionDependencyMode, deps: string[]): void {
  if (mode !== 'container') return;
  const shortDeps = deps.filter((d) => d.split('.').length <= 1);
  if (shortDeps.length > 0 && (globalThis as { ngDevMode?: boolean } | undefined)?.ngDevMode !== false) {
    console.warn('[SignalStore] Container dependency mode: very broad dependencies detected:', shortDeps.slice(0, 5));
  }
}

/**
 * Observable of `project(state)` that re-runs whenever a path it read changes, re-subscribing to
 * the tracked dependencies after every run.
 */
export function selectObservable<TState, TOut>(host: SelectHost<TState>, project: (s: TState) => TOut): Observable<TOut> {
  return new Observable<TOut>((subscriber) => {
    const proxy = host.proxy();
    let depSub: Subscription | null = null;
    let depKey = '';
    let hasValue = false;
    let lastValue!: TOut;
    let closed = false;
    let computing = false;
    let pending = false;

    const toDepPaths = (deps: string[]): string[] => {
      const tracked = deps.length === 0 && host.usingFallback() ? host.computedKeys() : deps;
      return Array.from(new Set(tracked.map((dep) => host.resolveVersionPath(dep)))).sort();
    };

    const resubscribe = (depPaths: string[]) => {
      const nextKey = depPaths.join('\0');
      if (nextKey === depKey) return;

      depSub?.unsubscribe();
      depSub = null;
      depKey = nextKey;

      if (depPaths.length === 0) return;

      let skipInitial = true;
      depSub = combineLatest(depPaths.map((depPath) => host.observe(depPath))).subscribe({
        next: () => {
          if (skipInitial) {
            skipInitial = false;
            return;
          }
          recompute();
        },
        error: (error) => {
          subscriber.error(error);
        }
      });
    };

    const recompute = () => {
      if (closed) return;
      if (computing) {
        pending = true;
        return;
      }

      computing = true;
      try {
        do {
          pending = false;
          const { value, deps } = host.trackProjection(() => project(proxy));
          warnOnWideDependencies(host.dependencyMode(), deps);

          if (!hasValue || !Object.is(value, lastValue)) {
            lastValue = value;
            hasValue = true;
            subscriber.next(value);
          }

          resubscribe(toDepPaths(deps));
        } while (pending && !closed);
      } catch (error) {
        closed = true;
        depSub?.unsubscribe();
        subscriber.error(error);
      } finally {
        computing = false;
      }
    };

    recompute();

    return () => {
      closed = true;
      depSub?.unsubscribe();
      depSub = null;
    };
  });
}
