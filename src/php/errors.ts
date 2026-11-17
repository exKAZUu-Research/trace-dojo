import { FatalError, PhpThrow, rt, SCRIPT_PATH } from './runtime';
import { PhpObject, type Value } from './values';

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
export function throwError(className: string, message: string): never {
  throw new PhpThrow(createThrowable(className, message));
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
export function emitError(level: bigint, message: string, row = rt().row): void {
  const runtime = rt();
  for (let index = runtime.errorHandlers.length - 1; index >= 0; index--) {
    const { handler, mask } = runtime.errorHandlers[index];
    if (handler === null) break;
    if ((mask & level) === 0n) break;
    if (callUserHandler(handler, level, message, row)) return;
    break;
  }
  lastErrors.set(runtime, { level, message, row });
  if (runtime.silence > 0 && level !== E_USER_ERROR) return;
  const reported = (runtime.errorReporting & level) !== 0n;
  // A fatal error ends the program even when it is not reported, and PHP 8.5 prints its stack trace.
  if (level === E_USER_ERROR) throw new FatalError(reported ? message : '', row);
  if (!reported) return;
  const name = LEVEL_NAMES.get(level) ?? 'Warning';
  runtime.echo(`\n${name}: ${message} in ${SCRIPT_PATH} on line ${row + 1}\n`);
}

export function warn(message: string): void {
  emitError(E_WARNING, message);
}

export function notice(message: string): void {
  emitError(E_NOTICE, message);
}

export function deprecated(message: string): void {
  emitError(E_DEPRECATED, message);
}

/** Ends the program with a fatal error that no handler can catch. */
export function fatal(message: string): never {
  throw new FatalError(message, rt().row);
}

export function isThrowable(value: Value): value is PhpObject {
  return value instanceof PhpObject && value.cls.isSubclassOf(rt().classes.get('throwable') as never);
}
