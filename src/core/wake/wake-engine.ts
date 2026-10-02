import { PathUtils } from '../../utils/path-utils';
import { resolveVersionPathCore } from '../../utils/path-core';
import { VersionBumpScheduler } from '../../utils/version-bump-scheduler';
import type { BehaviorService } from '../services/behavior.manager';
import type { ProxyCacheManager } from '../services/proxy-cache.manager';
import type { VersionManager } from '../services/version.manager';
import { NO_WAKE_OPTIONS, type StoreWakeupMode, type WakeConfig, type WakeUpPathOptions } from './wake-types';

interface AncestorEntry {
  /** Ancestors in `enumerateAncestors` order: the path itself first, then its parents. */
  selfFirst: string[];
  /** Same paths reversed; built on first use so the hot path never copies. */
  rootFirst?: string[];
}

const MAX_ENTRIES = 1000;

/**
 * Insertion-order FIFO cache of `PathUtils.enumerateAncestors`. The computation is pure (the numeric
 * parent is always one of the ancestors), so eviction only affects performance. Returned arrays are
 * shared: callers must not mutate them.
 */
class AncestorCache {
  private readonly entries = new Map<string, AncestorEntry>();

  selfFirst(path: string): string[] {
    return this.entry(path).selfFirst;
  }

  rootFirst(path: string): string[] {
    const entry = this.entry(path);
    return (entry.rootFirst ??= [...entry.selfFirst].reverse());
  }

  clear(): void {
    this.entries.clear();
  }

  private entry(path: string): AncestorEntry {
    const cached = this.entries.get(path);
    if (cached) return cached;
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const entry: AncestorEntry = { selfFirst: PathUtils.enumerateAncestors(path) };
    this.entries.set(path, entry);
    return entry;
  }
}

type BehaviorUpdater = (path: string, value: unknown) => void;

/**
 * Turns a store write into version-signal bumps and BehaviorSubject refreshes. Holds direct references
 * to the managers it drives, so a leaf write costs no hook lambdas or per-call option objects.
 */
export class WakeEngine {
  readonly config: WakeConfig = {
    autoBatch: false,
    bumpNumericParent: true,
    partial: false,
    dependencyMode: 'exact',
    behaviors: true
  };
  readonly scheduler: VersionBumpScheduler;
  private readonly ancestors = new AncestorCache();

  constructor(
    private readonly versions: VersionManager,
    private readonly behaviors: BehaviorService,
    private readonly proxyCache: ProxyCacheManager
  ) {
    this.scheduler = new VersionBumpScheduler((items) => {
      for (const path of items) versions.updateIfExists(path);
    });
  }

  /** The version signal path that observers of `normalized` subscribe to. */
  resolve(normalized: string): string {
    return resolveVersionPathCore(normalized, this.config);
  }

  /** Bump versions, refresh behaviors, optionally sync descendants. Returns whether behaviors are enabled. */
  wakePath(
    normalized: string,
    value: unknown,
    options: WakeUpPathOptions = NO_WAKE_OPTIONS,
    behaviorUpdater?: BehaviorUpdater
  ): boolean {
    const behaviorsEnabled = this.config.behaviors;
    this.bump(normalized);
    if (behaviorsEnabled) {
      if (behaviorUpdater) behaviorUpdater(normalized, value);
      else this.updateBehaviors(normalized, value);
      if (options.ensureBehavior) this.behaviors.add(normalized);
    }
    if (options.syncDescendants) this.wakeBranch(normalized);
    return behaviorsEnabled;
  }

  wakeArray(normalized: string, value: unknown, afterVersion?: () => void, behaviorUpdater?: BehaviorUpdater): void {
    this.bump(normalized);
    afterVersion?.();
    if (behaviorUpdater) behaviorUpdater(normalized, value);
    else this.updateBehaviors(normalized, value);
    this.updateBehaviorsByPrefix(normalized, true);
  }

  /** Push `value` to `path`'s behavior and re-read its existing ancestors' behaviors. */
  updateBehaviors(path: string, value?: unknown): void {
    if (!this.config.behaviors || !this.behaviors.hasNodes()) return;
    this.behaviors.updateAncestors(this.ancestors.selfFirst(path), value);
  }

  updateBehaviorsByPrefix(prefix: string, skipSelf = false): void {
    if (!this.config.behaviors || !prefix || typeof prefix !== 'string') return;
    this.behaviors.updateByPrefix(prefix, skipSelf);
  }

  /** Default bump: the path and its ancestors (or only the path itself under partial invalidation). */
  bump(normalized: string): void {
    if (!this.versions.hasNodes()) return;
    if (this.config.partial) this.versions.updateIfExists(normalized);
    else this.apply(this.ancestors.selfFirst(normalized));
  }

  /** Ancestors, root first. */
  bumpLeaf(normalized: string): void {
    if (this.versions.hasNodes()) this.apply(this.ancestors.rootFirst(normalized));
  }

  bumpExact(normalized: string): void {
    if (this.versions.hasNodes()) this.apply([normalized]);
  }

  bumpDescendants(normalizedPrefix: string): void {
    if (this.versions.hasNodes()) this.apply(this.versions.descendants(normalizedPrefix));
  }

  bumpByMode(mode: StoreWakeupMode, normalized: string): void {
    const bump = MODE_BUMPS[mode];
    if (!bump) throw new Error(`Unsupported wakeup mode: ${String(mode)}`);
    bump(this, normalized);
  }

  destroy(): void {
    this.scheduler.destroy();
    this.ancestors.clear();
  }

  /** Branch replaced: refresh nested behaviors, bump nested versions, drop cached nested proxies. */
  private wakeBranch(normalized: string): void {
    // Versions first: a behavior subscriber that reads through the proxy must see fresh computeds.
    this.bumpDescendants(normalized);
    this.updateBehaviorsByPrefix(normalized, true);
    this.proxyCache.delete(normalized);
  }

  private apply(targets: string[]): void {
    if (targets.length === 0) return;
    if (this.config.autoBatch) {
      this.scheduler.queue(targets);
      this.scheduler.schedule();
      return;
    }
    for (let i = 0; i < targets.length; i++) this.versions.updateIfExists(targets[i]);
  }
}

const bumpLeaf = (engine: WakeEngine, normalized: string) => engine.bumpLeaf(normalized);
const bumpExact = (engine: WakeEngine, normalized: string) => engine.bumpExact(normalized);

/** Cold-path dispatch for `wakeup(path, mode)`. Null prototype: 'constructor' must not resolve to a handler. */
const MODE_BUMPS: Record<StoreWakeupMode, (engine: WakeEngine, normalized: string) => void> = Object.assign(
  Object.create(null),
  { leaf: bumpLeaf, grained: bumpExact, granular: bumpExact, exact: bumpExact, graied: bumpExact, graned: bumpExact }
);
