import type { VersionDependencyMode } from '../../utils/path-utils';

export interface WakeUpPathOptions {
  ensureBehavior?: boolean;
  syncDescendants?: boolean;
}

/** Shared default: the write hot path must not allocate an options object per call. */
export const NO_WAKE_OPTIONS: WakeUpPathOptions = Object.freeze({});

// Aliases (incl. legacy misspellings) of the 'leaf' and 'exact' bump modes.
export type StoreWakeupMode = 'leaf' | 'grained' | 'granular' | 'exact' | 'graied' | 'graned';

/** Per-store wake settings. Mutated in place by the service setters and read directly on every write. */
export interface WakeConfig {
  autoBatch: boolean;
  bumpNumericParent: boolean;
  partial: boolean;
  dependencyMode: VersionDependencyMode;
  /** Whether writes refresh BehaviorSubjects. */
  behaviors: boolean;
}
