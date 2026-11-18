import { ExitSignal, FatalError, PhpThrow, rt, type Runtime, SCRIPT_PATH } from './runtime';
import { PhpObject, Ref, type Value } from './values';

let formatThrowable: (object: PhpObject) => string;

export function setThrowableFormatter(format: typeof formatThrowable): void {
  formatThrowable = format;
}

export function reportUncaughtWarning(object: PhpObject): void {
  const runtime = rt();
  const show = (): boolean => runtime.silence === 0 && (runtime.errorReporting & E_WARNING) !== 0n;
  const suspended = runtime.thrown;
  runtime.held.push(object);
  runtime.thrown = undefined;
  try {
    let text: string;
    try {
      text = formatThrowable(object);
    } catch (error) {
      if (!(error instanceof PhpThrow)) throw error;
      if (show()) {
        runtime.echo(
          `\nWarning: Uncaught ${error.object.cls.name} in exception handling during call to ${object.cls.name}::__toString() in ${throwableLocation(error.object)}\n`
        );
      }
      const stored = object.props.get(throwableKey(object, 'string'));
      const value = stored instanceof Ref ? stored.v : stored;
      text = typeof value === 'string' ? value : '';
    }
    if (show()) runtime.echo(`\nWarning: Uncaught ${text}\n  thrown in ${throwableLocation(object)}\n`);
  } finally {
    runtime.thrown = suspended === object ? undefined : suspended;
    runtime.held.pop();
  }
}

export function throwableLocation(object: PhpObject): string {
  const file = object.props.get('file');
  const line = object.props.get('line');
  return `${typeof file === 'string' ? file : SCRIPT_PATH} on line ${typeof line === 'bigint' ? line : 0}`;
}

/** Creates a throwable of a builtin class with a message, which the interpreter provides. */
let createThrowable: (className: string, message: string, code?: bigint) => PhpObject = () => {
  throw new Error('The PHP runtime is not loaded');
};
let callUserHandler: (handler: Value, level: bigint, message: string, row: number) => boolean = () => false;

export function setErrorFactories(
  create: typeof createThrowable,
  handle: (handler: Value, level: bigint, message: string, row: number) => boolean
): void {
  createThrowable = create;
  callUserHandler = handle;
}

/** Throws a PHP exception of a builtin class, such as `TypeError`. */
export function throwError(className: string, message: string, previous?: PhpObject): never {
  if (probes > 0) throw new ProbeFailure();
  const object = createThrowable(className, message);
  if (previous) setPrevious(object, previous);
  throw new PhpThrow(object);
}

/** How many checks are running that only ask whether code would throw, such as `is_callable`. */
let probes = 0;

/** The failure of a check that {@link probe} runs, which PHP reports without creating an exception object. */
export class ProbeFailure {}

/**
 * Runs a check that only asks whether code succeeds: an error it raises throws {@link ProbeFailure} instead of an
 * exception object, since PHP's checks create none, which would take an object handle.
 */
export function probe<T>(check: () => T): T {
  probes++;
  try {
    return check();
  } finally {
    probes--;
  }
}

export function newThrowable(className: string, message: string, code = 0n): PhpObject {
  return createThrowable(className, message, code);
}

export const E_ERROR = 1n;
export const E_WARNING = 2n;
export const E_PARSE = 4n;
export const E_NOTICE = 8n;
export const E_CORE_ERROR = 16n;
export const E_CORE_WARNING = 32n;
export const E_COMPILE_ERROR = 64n;
export const E_COMPILE_WARNING = 128n;
export const E_USER_ERROR = 256n;
export const E_USER_WARNING = 512n;
export const E_USER_NOTICE = 1024n;
export const E_STRICT = 2048n;
export const E_RECOVERABLE_ERROR = 4096n;
export const E_DEPRECATED = 8192n;
export const E_USER_DEPRECATED = 16_384n;
export const E_ALL = 30_719n;

const LEVEL_NAMES = new Map<bigint, string>([
  [E_WARNING, 'Warning'],
  [E_NOTICE, 'Notice'],
  [E_DEPRECATED, 'Deprecated'],
  [E_USER_WARNING, 'Warning'],
  [E_USER_NOTICE, 'Notice'],
  [E_USER_DEPRECATED, 'Deprecated'],
  [E_USER_ERROR, 'Fatal error'],
  [E_RECOVERABLE_ERROR, 'Recoverable fatal error'],
]);

/** An error that `error_get_last` reports. */
export interface ReportedError {
  level: bigint;
  message: string;
  row: number;
}

/** The last error of each run that no user handler took, even one that `@` or `error_reporting` hid. */
const lastErrors = new WeakMap<object, ReportedError>();

export function lastError(): ReportedError | undefined {
  return lastErrors.get(rt());
}

export function clearLastError(): void {
  lastErrors.delete(rt());
}

/** Reports a non-fatal error as PHP's CLI does: through a user handler, or printed to standard output. */
export function emitError(level: bigint, message: string, row = rt().diagnosticRow, skipMatchingHandler = false): void {
  const runtime = rt();
  runtime.constantEvaluationEpoch++;
  const current = runtime.errorHandlers.at(-1);
  if (
    current &&
    current.handler !== null &&
    !runtime.activeErrorHandlers.has(current.handler) &&
    (current.mask & level) !== 0n &&
    (skipMatchingHandler ||
      runtime.pendingAssignmentWarning ||
      runtime.nativeStringConversionPending ||
      callUserHandler(current.handler, level, message, row))
  )
    return;
  lastErrors.set(runtime, { level, message, row });
  if (runtime.silence > 0 && level !== E_USER_ERROR) return;
  const reported = (runtime.errorReporting & level) !== 0n;
  // A fatal error ends the program even when it is not reported, and PHP 8.5 prints its stack trace.
  if (level === E_USER_ERROR) throw new FatalError(reported ? message : '', row);
  if (!reported) return;
  const name = LEVEL_NAMES.get(level) ?? 'Warning';
  runtime.echo(`\n${name}: ${message} in ${SCRIPT_PATH} on line ${row + 1}\n`);
}

export function warn(message: string, pending = false): void {
  emitError(E_WARNING, message, rt().diagnosticRow, pending);
}

export function notice(message: string): void {
  emitError(E_NOTICE, message);
}

export function deprecated(message: string): void {
  emitError(E_DEPRECATED, message);
}

/** Ends the program with a fatal error that no handler can catch. */
export function fatal(message: string): never {
  throw new FatalError(message, rt().diagnosticRow);
}

export function isThrowable(value: Value): value is PhpObject {
  return value instanceof PhpObject && value.cls.isSubclassOf(rt().classes.get('throwable') as never);
}

/** Appends `previous` to the end of the chain of previous exceptions of `exception`, as zend_exception_set_previous does. */
export function setPrevious(exception: PhpObject, previous: PhpObject): void {
  if (exception === previous) return;
  for (let current = exception; ;) {
    if (current === previous) return;
    for (let ancestor = previousOf(previous); ancestor instanceof PhpObject; ancestor = previousOf(ancestor)) {
      if (ancestor === current) return;
    }
    const next = previousOf(current);
    if (!(next instanceof PhpObject)) {
      current.props.set(throwableKey(current, 'previous'), previous);
      return;
    }
    current = next;
  }
}

export function withPendingException(runtime: Runtime, pending: PhpThrow | undefined, cleanup: () => void): void {
  let failure: unknown = pending;
  if (pending) runtime.held.push(pending.object);
  try {
    cleanup();
  } catch (error) {
    failure = error;
    if (error instanceof PhpThrow && pending) setPrevious(error.object, pending.object);
    throw error;
  } finally {
    if (pending) runtime.held.pop();
    if (failure instanceof PhpThrow) runtime.thrown = failure.object;
  }
}

export type CleanupException = PhpThrow | ExitSignal;

// code-gauge-allow functionCognitiveComplexity 18 -- Captures cleanup failures and their ownership in propagation order.
export function withCleanupExceptions(
  runtime: Runtime,
  cleanup: (capture: (error: CleanupException) => void) => void
): void {
  const heldMark = runtime.held.length;
  let failure: CleanupException | undefined;
  const capture = (error: CleanupException): void => {
    if (failure instanceof ExitSignal) {
      if (error instanceof PhpThrow && runtime.thrown === error.object) runtime.thrown = undefined;
      return;
    }
    if (error instanceof PhpThrow) {
      if (failure) setPrevious(error.object, failure.object);
      runtime.held.push(error.object);
    } else if (failure && runtime.thrown === failure.object) {
      runtime.thrown = undefined;
    }
    failure = error;
  };
  try {
    try {
      cleanup(capture);
    } catch (error) {
      if (!(error instanceof PhpThrow)) throw error;
      capture(error);
    }
    if (failure instanceof PhpThrow) runtime.thrown = failure.object;
    if (failure) throw failure;
  } finally {
    runtime.held.length = heldMark;
  }
}

export function invalidObjectDimension(object: PhpObject, previous?: PhpThrow | 'same'): never {
  if (probes > 0) throw new ProbeFailure();
  const message = `Cannot use object of type ${object.cls.name} as array`;
  throwError('Error', message, previous === 'same' ? createThrowable('Error', message) : previous?.object);
}

export type UpdateWarning = (emit: () => void, whilePending?: () => void) => boolean;

export function withOperandWarnings(
  update: (warning: UpdateWarning, pending: () => PhpThrow | undefined) => Value
): Value {
  // oxlint-disable-next-line unicorn/no-null -- PHP operators can return a null zval.
  let result: Value = null;
  withCleanupExceptions(rt(), (capture) => {
    let pending: PhpThrow | undefined;
    const warning: UpdateWarning = (emit, whilePending) => {
      if (pending) {
        whilePending?.();
        return false;
      }
      try {
        emit();
        return true;
      } catch (error) {
        if (!(error instanceof PhpThrow)) throw error;
        capture(error);
        pending = error;
        return false;
      }
    };
    result = update(warning, () => pending);
  });
  return result;
}

function previousOf(exception: PhpObject): PhpObject | undefined {
  const slot = exception.props.get(throwableKey(exception, 'previous'));
  const value = slot instanceof Ref ? slot.v : slot;
  return value instanceof PhpObject ? value : undefined;
}

export function throwableKey(exception: PhpObject, name: string): string {
  let base = exception.cls;
  while (base.parent) base = base.parent;
  return `\0${base.name}\0${name}`;
}
