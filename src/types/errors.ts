/** Error types and helpers for type-safe error handling. */

export type StoreErrorType = 'PATH_ERROR' | 'TYPE_ERROR' | 'VALIDATION_ERROR' | 'ARRAY_ERROR';

type WithStackTrace = ErrorConstructor & {
  captureStackTrace?: (target: object, constructor?: abstract new (...args: never[]) => unknown) => void;
};

export abstract class BaseStoreError extends Error {
  readonly timestamp: number = Date.now();

  constructor(
    readonly type: StoreErrorType,
    message: string,
    readonly path?: string,
    readonly originalError?: Error
  ) {
    super(message);
    this.name = this.constructor.name;
    (Error as WithStackTrace).captureStackTrace?.(this, this.constructor as abstract new (...args: never[]) => unknown);
  }
}

export class PathAccessError extends BaseStoreError {
  constructor(path: string, operation: string, originalError?: Error) {
    super('PATH_ERROR', `Failed to access path "${path}" during ${operation}`, path, originalError);
  }
}

export class PathValidationError extends BaseStoreError {
  constructor(path: string, reason: string) {
    super('VALIDATION_ERROR', `Invalid path "${path}": ${reason}`, path);
  }
}

export class TypeValidationError extends BaseStoreError {
  constructor(path: string, expectedType: string, actualType: string) {
    super('TYPE_ERROR', `Type mismatch at path "${path}": expected ${expectedType}, got ${actualType}`, path);
  }
}

export class ArrayOperationError extends BaseStoreError {
  constructor(path: string, operation: string, reason: string, originalError?: Error) {
    super('ARRAY_ERROR', `Array operation "${operation}" failed at path "${path}": ${reason}`, path, originalError);
  }
}

export const StoreErrorFactory = {
  pathAccess: (path: string, operation: string, originalError?: Error) =>
    new PathAccessError(path, operation, originalError),
  pathValidation: (path: string, reason: string) => new PathValidationError(path, reason),
  typeValidation: (path: string, expectedType: string, actualType: string) =>
    new TypeValidationError(path, expectedType, actualType),
  arrayOperation: (path: string, operation: string, reason: string, originalError?: Error) =>
    new ArrayOperationError(path, operation, reason, originalError),
};

/** Error result wrapper for operations that can fail. */
export type OperationResult<T, E = BaseStoreError> =
  | { success: true; data: T; error: null }
  | { success: false; data: null; error: E };

export function safeOperation<T>(
  operation: () => T,
  errorFactory: (error: Error) => BaseStoreError
): OperationResult<T> {
  try {
    return { success: true, data: operation(), error: null };
  } catch (error) {
    return { success: false, data: null, error: errorFactory(error instanceof Error ? error : new Error(String(error))) };
  }
}
