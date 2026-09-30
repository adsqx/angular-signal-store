import { PathUtils } from '../utils/path-utils';
import { logger } from '../utils/logger';
import type { StoreHost } from './store-host';

type Warn = (message: string) => void;

/** Throws in strict mode, otherwise reports through `warn`. */
function invalidPath(op: string, path: string, strict: boolean, warn: Warn): void {
  const message = `Invalid path for ${op}: ${path}`;
  if (strict) throw new Error(message);
  warn(message);
}

const rejectUndefinedWrite = (path: string): never => {
  throw new Error(`Setting undefined is not allowed in strict mode for path: ${path}`);
};
const rejectDelete = (path: string): never => {
  throw new Error(`Delete operation is not allowed in strict mode for path: ${path}`);
};

/**
 * What a proxy node needs to route a write: the host, the strictness flags, and optional custom
 * writers (the root store proxy supplies `createWriteFns`; a standalone callable proxy uses the
 * validated fallbacks below).
 */
export interface WritePolicy {
  readonly host: StoreHost;
  readonly strictInvalidPath: boolean;
  readonly strictDeleteUndefined: boolean;
  readonly setFn?: (path: string, value: unknown) => void;
  readonly deleteFn?: (path: string) => void;
}

const warnDev: Warn = (message) => logger.warn(message);

/** `proxy.key = value`: a dedicated `setFn` wins, otherwise validate, then write through the store. */
export function applySet(policy: WritePolicy, path: string, value: unknown): void {
  if (value === undefined && policy.strictDeleteUndefined) rejectUndefinedWrite(path);
  if (policy.setFn) policy.setFn(path, value);
  else if (PathUtils.isValidPath(path)) policy.host.setValue(path, value);
  else invalidPath('setValue', path, policy.strictInvalidPath, warnDev);
}

/** `delete proxy.key`: a dedicated `deleteFn` is trusted to clean up safely, even in strict mode. */
export function applyDelete(policy: WritePolicy, path: string): void {
  if (policy.deleteFn) return policy.deleteFn(path);
  if (!PathUtils.isValidPath(path)) return invalidPath('deleteValue', path, policy.strictInvalidPath, warnDev);
  if (policy.strictDeleteUndefined) rejectDelete(path);
  policy.host.setValue(path, undefined);
}

/** Root-level writers: prefer the store's fast setter, route `undefined` to delete. */
export function createWriteFns(host: StoreHost, config: { strictInvalidPath: boolean; strictDeleteUndefined: boolean; warn: Warn }) {
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
