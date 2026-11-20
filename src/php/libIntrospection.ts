// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { consumeCallbackResult } from './callables';
import { backtraceLimit, callArguments, callNamedArguments, type CallRecord, callStack } from './calls';
import * as conversionsModule from './conversions';
import { clearLastError, errorFile, lastError, throwError, warn } from './errors';
import { defineConstant, defineFunction, markDeprecated } from './native';
import { toStr } from './operators';
import { PhpThrow, rt, SCRIPT_PATH } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { PhpArray, PhpObject } from './values';

// Errors -------------------------------------------------------------------------------------------------------------

defineFunction('error_get_last(): ?array', () => {
  const error = lastError();
  if (!error) return null;
  const array = new PhpArray();
  array.set('type', error.level);
  array.set('message', error.message);
  array.set('file', errorFile(error.row));
  array.set('line', BigInt(Math.max(error.row + 1, 0)));
  return array;
});
defineFunction('error_clear_last(): void', () => {
  clearLastError();
  return null;
});

// Backtraces ---------------------------------------------------------------------------------------------------------

defineConstant('DEBUG_BACKTRACE_PROVIDE_OBJECT', 1n);
defineConstant('DEBUG_BACKTRACE_IGNORE_ARGS', 2n);

defineFunction('debug_backtrace(int $options = DEBUG_BACKTRACE_PROVIDE_OBJECT, int $limit = 0): array', ({ args }) => {
  const options = (args[0] as bigint | undefined) ?? 1n;
  const limit = backtraceLimit(args[1] as bigint | undefined);
  // The last record is debug_backtrace's own call.
  const records = callStack.slice(0, -1);
  const trace = new PhpArray();
  for (let index = records.length - 1; index >= 0; index--) {
    if (trace.size >= limit) break;
    trace.append(backtraceFrame(records[index], options));
  }
  return trace;
});

function backtraceFrame(record: CallRecord, options: bigint): PhpArray {
  const entry = new PhpArray();
  if (record.row !== undefined) {
    entry.set('file', SCRIPT_PATH);
    entry.set('line', BigInt(record.row + 1));
  }
  entry.set('function', record.name);
  if (record.className !== undefined) {
    entry.set('class', record.className);
    if ((options & 1n) !== 0n && record.type === '->' && record.thisObj) entry.set('object', record.thisObj);
    entry.set('type', record.type ?? '::');
  }
  if ((options & 2n) === 0n) {
    const args = PhpArray.list(callArguments(record));
    for (const [name, value] of callNamedArguments(record)) args.set(name, value);
    entry.set('args', args);
  }
  return entry;
}

// Assertions ---------------------------------------------------------------------------------------------------------

/** The settings that `assert_options` reads and changes, as PHP's `assert.*` INI settings hold them. */
interface AssertOptions {
  active: boolean;
  bail: boolean;
  warning: boolean;
  exception: boolean;
}

const assertOptions = new WeakMap<object, AssertOptions>();

function currentAssertOptions(): AssertOptions {
  let options = assertOptions.get(rt());
  if (!options) {
    options = { active: true, bail: false, warning: true, exception: true };
    assertOptions.set(rt(), options);
  }
  return options;
}

const ASSERT_OPTIONS = ['active', 'callback', 'bail', 'warning', 'exception'] as const;
for (const [index, name] of ASSERT_OPTIONS.entries()) {
  const constant = `ASSERT_${name.toUpperCase()}`;
  defineConstant(
    constant,
    BigInt(index + 1),
    `Constant ${constant} is deprecated since 8.3, as assert_options() is deprecated`
  );
}

defineFunction('assert_options(int $option, mixed $value = UNKNOWN): mixed', ({ args }) => {
  const name = ASSERT_OPTIONS[Number(args[0]) - 1] as (typeof ASSERT_OPTIONS)[number] | undefined;
  if (name === undefined)
    throwError('ValueError', 'assert_options(): Argument #1 ($option) must be an ASSERT_* constant');
  const options = currentAssertOptions();
  if (name === 'callback') {
    const runtime = rt();
    const previous = runtime.assertionCallback ?? null;
    if (args.length > 1) {
      runtime.nativeHeld.at(-1)?.push(previous);
      runtime.assertionCallback = args[1] ?? undefined;
    }
    return previous;
  }
  const previous = BigInt(options[name]);
  if (args.length > 1) options[name] = parseIniBool(toStr(args[1]));
  return previous;
});
markDeprecated('assert_options', 'Function assert_options() is deprecated since 8.3');

/** Reads a boolean INI value as zend_ini_parse_bool does. */
function parseIniBool(text: string): boolean {
  if (['true', 'yes', 'on'].includes(text.toLowerCase())) return true;
  return Number.parseInt(/^\s*[+-]?\d+/.exec(text)?.[0] ?? '0', 10) !== 0;
}

defineFunction('assert(mixed $assertion, Throwable|string|null $description = null): bool', ({ args, row }) => {
  const [assertion, description] = args;
  const options = currentAssertOptions();
  if (!options.active || conversionsModule.toBool(assertion)) return true;
  if (description instanceof PhpObject) throw new PhpThrow(description);
  if (options.bail) throw new UnsupportedFeatureError('assert_options() の ASSERT_BAIL');
  const text = typeof description === 'string' ? description : undefined;
  const pending = runAssertionCallback(text, row);
  if (options.exception) throwError('AssertionError', text ?? '', pending?.object);
  if (options.warning) warn(`assert(): ${text ?? 'Assertion'} failed`, pending !== undefined);
  if (pending) throw pending;
  return false;
});

function runAssertionCallback(text: string | undefined, row: number | undefined): PhpThrow | undefined {
  const callback = rt().assertionCallback;
  if (callback === undefined) return undefined;
  const line = BigInt((row ?? rt().row) + 1);
  const parameters = text === undefined ? [SCRIPT_PATH, line, null] : [SCRIPT_PATH, line, null, text];
  try {
    consumeCallbackResult(callback, parameters, () => {});
  } catch (error) {
    if (!(error instanceof PhpThrow)) throw error;
    return error;
  }
  return undefined;
}
