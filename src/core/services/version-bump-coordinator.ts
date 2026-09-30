import { PathUtils } from '../../utils/path-utils';
import { VersionBumpScheduler } from '../../utils/version-bump-scheduler';
import { VersionBumpPolicy } from './version-bump-policy';

export interface VersionBumpHooks {
  hasNodes: () => boolean;
  keys: () => string[];
  updateIfExists: (path: string) => void;
}

type BumpTargetResolver = (normalized: string) => string[];

interface AncestorEntry {
  /** Ancestors in `enumerateAncestors` order. */
  ordered: string[];
  /** Same paths reversed; built on first leaf bump so the hot path never copies. */
  reversed?: string[];
}

/** Shared empty result; `applyTargets` returns before touching it. */
const NO_TARGETS: string[] = [];
const MAX_ANCESTOR_CACHE_SIZE = 1000;

export class VersionBumpCoordinator {
  // Insertion-order FIFO cache. Version target calculation is pure, so eviction only affects performance.
  private readonly ancestorCache = new Map<string, AncestorEntry>();

  private readonly exactTargets: BumpTargetResolver = (normalized) => [normalized];
  private readonly leafTargets: BumpTargetResolver = (normalized) => {
    const entry = this.ancestorEntry(normalized);
    return (entry.reversed ??= [...entry.ordered].reverse());
  };
  private readonly partialTargets: BumpTargetResolver = (normalized) => {
    this.hooks.updateIfExists(normalized);
    return NO_TARGETS;
  };
  private readonly branchTargets: BumpTargetResolver = (normalized) => this.ancestorEntry(normalized).ordered;

  constructor(
    private readonly policy: VersionBumpPolicy,
    private readonly scheduler: VersionBumpScheduler,
    private readonly hooks: VersionBumpHooks
  ) {}

  resolvePath(path: string): string {
    return this.resolveNormalizedPath(PathUtils.normalizePath(path));
  }

  resolveNormalizedPath(normalized: string): string {
    return PathUtils.resolveVersionPath(normalized, {
      dependencyMode: this.policy.getDependencyMode(),
      bumpNumericParent: this.policy.getBumpNumericParent()
    });
  }

  bumpPathNormalized(normalized: string): void {
    this.bump(normalized, this.policy.getPartialInvalidation() ? this.partialTargets : this.branchTargets);
  }

  bumpExactNormalized(normalized: string): void {
    this.bump(normalized, this.exactTargets);
  }

  bumpLeafBranchNormalized(normalized: string): void {
    this.bump(normalized, this.leafTargets);
  }

  bumpDescendantsNormalized(normalized: string): void {
    if (!this.hooks.hasNodes()) return;
    const prefix = `${normalized}.`;
    const targets: string[] = [];
    for (const key of this.hooks.keys()) {
      if (key.startsWith(prefix)) targets.push(key);
    }
    this.applyTargets(targets);
  }

  destroy(): void {
    this.scheduler.destroy();
    this.ancestorCache.clear();
  }

  private ancestorEntry(normalizedPath: string): AncestorEntry {
    const cached = this.ancestorCache.get(normalizedPath);
    if (cached) return cached;
    if (this.ancestorCache.size >= MAX_ANCESTOR_CACHE_SIZE) {
      const firstKey = this.ancestorCache.keys().next().value;
      if (firstKey) this.ancestorCache.delete(firstKey);
    }
    const entry: AncestorEntry = {
      ordered: PathUtils.enumerateAncestors(normalizedPath, {
        includeNumericParent: this.policy.getBumpNumericParent()
      })
    };
    this.ancestorCache.set(normalizedPath, entry);
    return entry;
  }

  private applyTargets(targets: string[]): void {
    if (targets.length === 0) return;
    if (this.policy.getAutoBatchBumps()) {
      this.scheduler.queue(targets);
      this.scheduler.schedule();
      return;
    }
    for (const target of targets) this.hooks.updateIfExists(target);
  }

  private bump(normalized: string, getTargets: BumpTargetResolver): void {
    if (!this.hooks.hasNodes()) return;
    this.applyTargets(getTargets(normalized));
  }
}
