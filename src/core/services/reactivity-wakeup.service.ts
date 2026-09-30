import { PathUtils } from '../../utils/path-utils';

export interface WakeUpPathOptions {
  ensureBehavior?: boolean;
  syncDescendants?: boolean;
}

export interface WakeUpHooks {
  behaviorUpdatesEnabled: () => boolean;
  updateBehavior: (path: string, value: unknown) => void;
  ensureBehavior: (path: string) => void;
  bumpVersionNormalized: (normalized: string) => void;
  bumpDescendantVersionsNormalized: (normalizedPrefix: string) => void;
  clearProxyCache: (pathPrefix: string) => void;
  updateBehaviorByPrefix: (pathPrefix: string, options?: { skipSelf?: boolean }) => void;
}

/** Shared defaults: the write hot path must not allocate an options object per call. */
export const NO_WAKE_OPTIONS: WakeUpPathOptions = Object.freeze({});
const SKIP_SELF = Object.freeze({ skipSelf: true });

export class ReactivityWakeupService {
  constructor(private readonly hooks: WakeUpHooks) {}

  wakeUpPath(
    path: string,
    value: unknown,
    options: WakeUpPathOptions = NO_WAKE_OPTIONS,
    behaviorUpdater?: (path: string, value: unknown) => void
  ): boolean {
    return this.wakeUpPathNormalized(PathUtils.normalizePath(path), value, options, behaviorUpdater);
  }

  wakeUpPathNormalized(
    normalized: string,
    value: unknown,
    options: WakeUpPathOptions = NO_WAKE_OPTIONS,
    behaviorUpdater?: (path: string, value: unknown) => void
  ): boolean {
    const behaviorsEnabled = this.hooks.behaviorUpdatesEnabled();
    this.hooks.bumpVersionNormalized(normalized);
    if (behaviorsEnabled) {
      (behaviorUpdater ?? this.hooks.updateBehavior)(normalized, value);
      if (options.ensureBehavior) this.hooks.ensureBehavior(normalized);
    }
    if (options.syncDescendants) this.wakeUpBranchNormalized(normalized);
    return behaviorsEnabled;
  }

  wakeUpArrayPath(
    path: string,
    value: unknown,
    afterVersion?: () => void,
    behaviorUpdater?: (path: string, value: unknown) => void
  ): void {
    const normalized = PathUtils.normalizePath(path);
    this.hooks.bumpVersionNormalized(normalized);
    afterVersion?.();
    (behaviorUpdater ?? this.hooks.updateBehavior)(normalized, value);
    this.hooks.updateBehaviorByPrefix(normalized, SKIP_SELF);
  }

  wakeUpVersionOnly(path: string): void {
    this.hooks.bumpVersionNormalized(PathUtils.normalizePath(path));
  }

  private wakeUpBranchNormalized(normalized: string): void {
    this.hooks.updateBehaviorByPrefix(normalized, SKIP_SELF);
    this.hooks.bumpDescendantVersionsNormalized(normalized);
    this.hooks.clearProxyCache(normalized);
  }
}
