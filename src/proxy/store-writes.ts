import { PathUtils } from '../utils/path-utils';
import { logger } from '../utils/logger';
import type { StoreHost } from './store-host';

/**
 * Write-path policy shared by the root proxy (ProxyFactory) and every nested handler:
 * the strict/warn behaviour for invalid paths and for undefined/delete writes.
 */
export type WriteOp = 'setValue' | 'deleteValue' | 'setValueFast';
type Warn = (message: string) => void;

export interface WriteConfig {
  strictInvalidPath: boolean;
  strictDeleteUndefined: boolean;
  warn: Warn;
}

/** Throws in strict mode, otherwise reports through `warn`. */
export function invalidPath(op: WriteOp, path: string, strict: boolean | undefined, warn: Warn): void {
  const message = `Invalid path for ${op}: ${path}`;
  if (strict) throw new Error(message);
  warn(message);
}

export function rejectUndefinedWrite(path: string): never {
  throw new Error(`Setting undefined is not allowed in strict mode for path: ${path}`);
}

export function rejectDelete(path: string): never {
  throw new Error(`Delete operation is not allowed in strict mode for path: ${path}`);
}

const warnDev: Warn = (message) => logger.warn(message);

/** Handler fallback (no custom setFn): validate, then write through the store. */
export function directSetValue(host: StoreHost, path: string, value: unknown, strictInvalidPath?: boolean): void {
  if (PathUtils.isValidPath(path)) host.setValue(path, value);
  else invalidPath('setValue', path, strictInvalidPath, warnDev);
}

/** Handler fallback (no custom deleteFn): deleting is writing `undefined`. */
export function directDeleteValue(
  host: StoreHost,
  path: string,
  strictInvalidPath?: boolean,
  strictDeleteUndefined?: boolean,
): void {
  if (!PathUtils.isValidPath(path)) return invalidPath('deleteValue', path, strictInvalidPath, warnDev);
  if (strictDeleteUndefined) rejectDelete(path);
  host.setValue(path, undefined);
}

/** What a proxy node needs to route a write: the host, the strictness flags, optional custom writers. */
export interface WritePolicy {
  readonly host: StoreHost;
  readonly strictInvalidPath: boolean;
  readonly strictDeleteUndefined: boolean;
  readonly setFn?: (path: string, value: unknown) => void;
  readonly deleteFn?: (path: string) => void;
}

/** `proxy.key = value`: a dedicated `setFn` wins, otherwise the validated handler fallback. */
export function applySet(policy: WritePolicy, path: string, value: unknown): void {
  if (value === undefined && policy.strictDeleteUndefined) rejectUndefinedWrite(path);
  if (policy.setFn) policy.setFn(path, value);
  else directSetValue(policy.host, path, value, policy.strictInvalidPath);
}

/** `delete proxy.key`: a dedicated `deleteFn` is trusted to clean up safely, even in strict mode. */
export function applyDelete(policy: WritePolicy, path: string): void {
  if (policy.deleteFn) policy.deleteFn(path);
  else directDeleteValue(policy.host, path, policy.strictInvalidPath, policy.strictDeleteUndefined);
}

/** Root-level writers: prefer the store's fast setter, route `undefined` to delete. */
export function createWriteFns(host: StoreHost, config: WriteConfig) {
  const { strictInvalidPath, strictDeleteUndefined, warn } = config;

  const deleteFn = (path: string): void => {
    if (strictDeleteUndefined) rejectDelete(path);
    if (!PathUtils.isValidPath(path)) return invalidPath('deleteValue', path, strictInvalidPath, warn);
    host.deleteValue(path);
  };

  const setFn = (path: string, value: unknown): void => {
    if (value === undefined) {
      if (strictDeleteUndefined) rejectUndefinedWrite(path);
      return deleteFn(path);
    }
    const fast = host.setValueFast;
    if (!PathUtils.isValidPath(path)) {
      return invalidPath(typeof fast === 'function' ? 'setValueFast' : 'setValue', path, strictInvalidPath, warn);
    }
    if (typeof fast === 'function') fast.call(host, path, value);
    else host.setValueObserve(path, value);
  };

  return { setFn, deleteFn };
}
