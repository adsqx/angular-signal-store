import type { VersionDependencyMode } from '../../utils/path-utils';

export interface WakeUpPathOptions {
  ensureBehavior?: boolean;
  syncDescendants?: boolean;
}

/** Shared default: the write hot path must not allocate an options object per call. */
export const NO_WAKE_OPTIONS: WakeUpPathOptions = Object.freeze({});

const WAKE_OPTION_SETS: readonly WakeUpPathOptions[] = [
  NO_WAKE_OPTIONS,
  Object.freeze({ syncDescendants: true }),
  Object.freeze({ ensureBehavior: true }),
  Object.freeze({ ensureBehavior: true, syncDescendants: true })
];

/** Shared frozen options for the four flag combinations (no per-write allocation). */
export const wakeOptions = (ensureBehavior: boolean, syncDescendants: boolean): WakeUpPathOptions =>
  WAKE_OPTION_SETS[(ensureBehavior ? 2 : 0) | (syncDescendants ? 1 : 0)];

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
