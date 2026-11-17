// code-gauge-allow-file fileNcss 496 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { lower } from './bytes';
import { callCallback, callTargetOf, callValue } from './callables';
import { callStack, setCallableExplainer } from './calls';
import * as classesModule from './classes';
import { findClass, lookupMethod, visibleProps } from './classes';
import * as conversionsModule from './conversions';
import { debugType, getType, isNumericString, normalizeKeyString, valueName } from './conversions';
import {
  E_ALL,
  E_COMPILE_ERROR,
  E_COMPILE_WARNING,
  E_CORE_ERROR,
  E_CORE_WARNING,
  E_DEPRECATED,
  E_ERROR,
  E_NOTICE,
  E_PARSE,
  E_RECOVERABLE_ERROR,
  E_STRICT,
  E_USER_DEPRECATED,
  E_USER_ERROR,
  E_USER_NOTICE,
  E_USER_WARNING,
  E_WARNING,
  emitError,
  throwError,
  warn,
} from './errors';
import { cast, iterate } from './interp';
import { defineAlias, defineConstant, defineFunction } from './native';
import { toFloat, toInt, toStr } from './operators';
import { printR, varDump, varExport } from './output';
import { PhpThrow, rt } from './runtime';
import { formatPrintf } from './sprintf';
import { constantKey, defineConstant as defineUserConstant } from './statements';
import { setCallableCheck } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { isClosure, PhpArray, PhpClass, PhpObject, type Value } from './values';

// Constants ------------------------------------------------------------------------------------------------------------

const errorConstants: [string, bigint][] = [
  ['E_ERROR', E_ERROR],
  ['E_WARNING', E_WARNING],
  ['E_PARSE', E_PARSE],
  ['E_NOTICE', E_NOTICE],
  ['E_CORE_ERROR', E_CORE_ERROR],
  ['E_CORE_WARNING', E_CORE_WARNING],
  ['E_COMPILE_ERROR', E_COMPILE_ERROR],
  ['E_COMPILE_WARNING', E_COMPILE_WARNING],
  ['E_USER_ERROR', E_USER_ERROR],
  ['E_USER_WARNING', E_USER_WARNING],
  ['E_USER_NOTICE', E_USER_NOTICE],
  ['E_STRICT', E_STRICT],
  ['E_RECOVERABLE_ERROR', E_RECOVERABLE_ERROR],
  ['E_DEPRECATED', E_DEPRECATED],
  ['E_USER_DEPRECATED', E_USER_DEPRECATED],
  ['E_ALL', E_ALL],
];
for (const [name, value] of errorConstants) defineConstant(name, value);
defineConstant('PHP_EOL', '\n');
defineConstant('PHP_INT_MAX', 9_223_372_036_854_775_807n);
defineConstant('PHP_INT_MIN', -9_223_372_036_854_775_808n);
defineConstant('PHP_INT_SIZE', 8n);
defineConstant('PHP_FLOAT_EPSILON', Number.EPSILON);
defineConstant('PHP_FLOAT_MAX', Number.MAX_VALUE);
defineConstant('PHP_FLOAT_MIN', 2.2250738585072014e-308);
defineConstant('PHP_FLOAT_DIG', 15n);
defineConstant('NAN', Number.NaN);
defineConstant('INF', Number.POSITIVE_INFINITY);
defineConstant('PHP_VERSION', '8.5.12');
defineConstant('PHP_MAJOR_VERSION', 8n);
defineConstant('PHP_MINOR_VERSION', 5n);
defineConstant('PHP_RELEASE_VERSION', 12n);
defineConstant('PHP_VERSION_ID', 80_512n);
defineConstant('PHP_EXTRA_VERSION', '');
defineConstant('DIRECTORY_SEPARATOR', '/');
defineConstant('PATH_SEPARATOR', ':');
defineConstant('PHP_MAXPATHLEN', 1024n);
defineConstant('PHP_DEBUG', 0n);
defineConstant('PHP_SAPI', 'cli');
defineConstant('PHP_ZTS', 0n);

// Output -------------------------------------------------------------------------------------------------------------

defineFunction('print_r(mixed $value, bool $return = false): string|bool', ({ args }) => {
  const text = printR(args[0]);
  if (args[1] === true) return text;
  rt().echo(text);
  return true;
});
defineFunction('var_dump(mixed $value, mixed ...$values): void', ({ args }) => {
  for (const value of args) rt().echo(varDump(value));
  return null;
});
defineFunction('var_export(mixed $value, bool $return = false): ?string', ({ args }) => {
  const text = varExport(args[0]);
  if (args[1] === true) return text;
  rt().echo(text);
  return null;
});
defineFunction('printf(string $format, mixed ...$values): int', ({ args }) => {
  const text = formatPrintf(args[0] as string, args.slice(1));
  rt().echo(text);
  return BigInt(text.length);
});
defineFunction('sprintf(string $format, mixed ...$values): string', ({ args }) =>
  formatPrintf(args[0] as string, args.slice(1))
);
defineFunction('vsprintf(string $format, array $values): string', ({ args }) =>
  formatPrintf(args[0] as string, (args[1] as PhpArray).values(), true)
);
defineFunction('vprintf(string $format, array $values): int', ({ args }) => {
  const text = formatPrintf(args[0] as string, (args[1] as PhpArray).values(), true);
  rt().echo(text);
  return BigInt(text.length);
});

// Types --------------------------------------------------------------------------------------------------------------

defineFunction('gettype(mixed $value): string', ({ args }) => getType(args[0]));
defineFunction('get_debug_type(mixed $value): string', ({ args }) => debugType(args[0]));
defineFunction('is_int(mixed $value): bool', ({ args }) => typeof args[0] === 'bigint');
defineAlias('is_integer', 'is_int');
defineAlias('is_long', 'is_int');
defineFunction('is_float(mixed $value): bool', ({ args }) => typeof args[0] === 'number');
defineAlias('is_double', 'is_float');
defineFunction('is_string(mixed $value): bool', ({ args }) => typeof args[0] === 'string');
defineFunction('is_bool(mixed $value): bool', ({ args }) => typeof args[0] === 'boolean');
defineFunction('is_array(mixed $value): bool', ({ args }) => args[0] instanceof PhpArray);
defineFunction('is_object(mixed $value): bool', ({ args }) => args[0] instanceof PhpObject);
defineFunction('is_null(mixed $value): bool', ({ args }) => args[0] === null);
defineFunction('is_numeric(mixed $value): bool', ({ args }) => {
  const [value] = args;
  if (typeof value === 'bigint' || typeof value === 'number') return true;
  return typeof value === 'string' && isNumericString(value);
});
defineFunction('is_scalar(mixed $value): bool', ({ args }) => {
  const [value] = args;
  return (
    typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
  );
});
defineFunction('is_iterable(mixed $value): bool', ({ args }) => {
  const [value] = args;
  if (value instanceof PhpArray) return true;
  const traversable = rt().classes.get('traversable');
  return value instanceof PhpObject && traversable !== undefined && value.cls.isSubclassOf(traversable);
});
defineFunction('is_countable(mixed $value): bool', ({ args }) => {
  const [value] = args;
  if (value instanceof PhpArray) return true;
  const countable = rt().classes.get('countable');
  return value instanceof PhpObject && countable !== undefined && value.cls.isSubclassOf(countable);
});
defineFunction('is_callable(mixed $value, bool $syntax_only = false, &$callable_name = null): bool', ({ args }) =>
  isCallable(args[0])
);
defineFunction('is_resource(mixed $value): bool', () => false);
defineFunction('intval(mixed $value, int $base = 10): int', ({ args }) => {
  const [value, base = 10n] = args;
  if (typeof value === 'string' && base !== 10n) return parseIntBase(value, Number(base));
  return toInt(value);
});
defineFunction('floatval(mixed $value): float', ({ args }) => toFloat(args[0]));
defineAlias('doubleval', 'floatval');
defineFunction('strval(mixed $value): string', ({ args }) => toStr(args[0]));
defineFunction('boolval(mixed $value): bool', ({ args }) => cast('bool', args[0]));
defineFunction('settype(mixed &$var, string $type): bool', ({ args, refs }) => {
  const ref = refs[0];
  const type = lower(args[1] as string);
  const map: Record<string, string> = {
    int: 'int',
    integer: 'int',
    float: 'float',
    double: 'float',
    string: 'string',
    bool: 'bool',
    boolean: 'bool',
    array: 'array',
    object: 'object',
    null: 'null',
  };
  const target = map[type];
  if (!target) throwError('ValueError', 'settype(): Argument #2 ($type) must be a valid type');
  if (ref) ref.v = target === 'null' ? null : cast(target, ref.v);
  return true;
});

/** Parses an integer in a base as `intval($string, $base)` does, with base 0 detecting a prefix. */
// code-gauge-allow functionCognitiveComplexity 25 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
// code-gauge-allow functionNcss 43 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function parseIntBase(text: string, base: number): bigint {
  let rest = text.trimStart();
  let negative = false;
  if (rest.startsWith('-') || rest.startsWith('+')) {
    negative = rest.startsWith('-');
    rest = rest.slice(1);
  }
  let radix = base;
  if (radix === 0) {
    if (/^0[xX]/.test(rest)) {
      radix = 16;
      rest = rest.slice(2);
    } else if (/^0[bB]/.test(rest)) {
      radix = 2;
      rest = rest.slice(2);
    } else if (/^0[oO]/.test(rest)) {
      radix = 8;
      rest = rest.slice(2);
    } else if (rest.startsWith('0')) radix = 8;
    else radix = 10;
  } else if (radix === 16 && /^0[xX]/.test(rest)) rest = rest.slice(2);
  else if (radix === 2 && /^0[bB]/.test(rest)) rest = rest.slice(2);
  else if (radix === 8 && /^0[oO]/.test(rest)) rest = rest.slice(2);
  let value = 0n;
  const big = BigInt(radix);
  for (const char of rest) {
    const digit = Number.parseInt(char, 36);
    if (Number.isNaN(digit) || digit >= radix) break;
    value = value * big + BigInt(digit);
    if (value > 9_223_372_036_854_775_807n) return negative ? -9_223_372_036_854_775_808n : 9_223_372_036_854_775_807n;
  }
  return negative ? -value : value;
}

// Constants and functions --------------------------------------------------------------------------------------------

defineFunction('define(string $constant_name, mixed $value, bool $case_insensitive = false): bool', ({ args }) => {
  if (args[2] === true)
    warn(
      'define(): Argument #3 ($case_insensitive) is ignored since declaration of case-insensitive constants is no longer supported'
    );
  const name = args[0] as string;
  if (name.includes('::'))
    throwError('ValueError', 'define(): Argument #1 ($constant_name) cannot be a class constant');
  return defineUserConstant(name.replace(/^\\/, ''), args[1], false);
});
defineFunction('defined(string $constant_name): bool', ({ args }) => {
  const name = (args[0] as string).replace(/^\\/, '');
  if (name.includes('::')) {
    const [className, constName] = name.split('::');
    return findClass(className)?.findConst(constName) !== undefined;
  }
  return rt().constants.has(constantKey(name));
});
defineFunction('constant(string $name): mixed', ({ args }) => {
  const name = (args[0] as string).replace(/^\\/, '');
  if (name.includes('::')) {
    const [className, constName] = name.split('::');
    const cls = findClass(className);
    if (!cls) throwError('Error', `Class "${className}" not found`);
    const { classConstant } = classesModule;
    return classConstant(cls, constName, rt().frame.scope);
  }
  const value = rt().constants.get(constantKey(name));
  if (value === undefined) throwError('Error', `Undefined constant "${name}"`);
  return value;
});

defineFunction('function_exists(string $function): bool', ({ args }) =>
  rt().functions.has(lower((args[0] as string).replace(/^\\/, '')))
);
defineFunction(
  'func_get_args(): array',
  () => {
    const frame = rt().frame;
    if (!frame.fn) throwError('Error', 'func_get_args() cannot be called from the global scope');
    return PhpArray.list(currentArgs());
  },
  true
);
defineFunction(
  'func_num_args(): int',
  () => {
    const frame = rt().frame;
    if (!frame.fn) throwError('Error', 'func_num_args() must be called from a function context');
    return BigInt(currentArgs().length);
  },
  true
);
defineFunction(
  'func_get_arg(int $position): mixed',
  ({ args }) => {
    const values = currentArgs();
    const position = Number(args[0]);
    if (position < 0 || position >= values.length) {
      throwError(
        'ValueError',
        'func_get_arg(): Argument #1 ($position) must be less than the number of the arguments passed to the currently executed function'
      );
    }
    return values[position];
  },
  true
);

/** The arguments of the running function, with parameters a call left out taken from their current values. */
function currentArgs(): Value[] {
  const frame = rt().frame;
  const fn = frame.fn;
  const values = [...frame.args];
  if (fn?.kind === 'user') {
    for (const [index, param] of fn.params.entries()) {
      if (index >= values.length || param.variadic) break;
      const ref = frame.vars.get(param.name);
      if (ref) values[index] = ref.v;
    }
  }
  return values;
}

defineFunction('call_user_func(callable $callback, mixed ...$args): mixed', ({ args, named }) => {
  const [callback, ...rest] = args;
  const argValues = rest.map((v) => ({ v }));
  for (const [name, v] of named ?? []) argValues.push({ v, name } as { v: Value; name: string });
  return callValue(callback, argValues, undefined);
});
defineFunction('call_user_func_array(callable $callback, array $args): mixed', ({ args }) => {
  const array = args[1] as PhpArray;
  const argValues: { v: Value; name?: string }[] = [];
  for (const [key, v] of array.entries()) {
    if (typeof key === 'string') argValues.push({ v, name: key });
    else {
      if (argValues.some((arg) => arg.name !== undefined))
        throwError('Error', 'Cannot use positional argument after named argument during unpacking');
      argValues.push({ v });
    }
  }
  return callValue(args[0], argValues, undefined);
});

export function isCallable(value: Value): boolean {
  try {
    if (value instanceof PhpObject) return isClosure(value) || value.cls.findMethod('__invoke') !== undefined;
    if (typeof value !== 'string' && !(value instanceof PhpArray)) return false;
    callTargetOf(value, false);
    return true;
  } catch (error) {
    if (error instanceof UnsupportedFeatureError) throw error;
    return false;
  }
}

/** Explains why a value is no valid callback, as PHP's messages for callable parameters do. */
// code-gauge-allow functionCognitiveComplexity 21 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function callableProblem(value: Value): string {
  if (typeof value === 'string') {
    if (value.includes('::')) {
      const [className, method] = value.split('::');
      const cls = findClass(className);
      if (!cls) return `class "${className}" not found`;
      return `class ${cls.name} does not have a method "${method}"`;
    }
    return `function "${value}" not found or invalid function name`;
  }
  if (value instanceof PhpArray) {
    if (value.size !== 2) return 'array callback must have exactly two members';
    const target = value.get(0n);
    const method = value.get(1n);
    if (typeof method !== 'string') return 'second array member is not a valid method';
    if (target instanceof PhpObject) {
      const found = lookupMethod(target.cls, lower(method), rt().frame.scope);
      if (!found) return `class ${target.cls.name} does not have a method "${method}"`;
      return `cannot access ${found.visibility} method ${target.cls.name}::${found.name}()`;
    }
    if (typeof target === 'string') {
      const cls = findClass(target);
      if (!cls) return `class "${target}" not found`;
      return `class ${cls.name} does not have a method "${method}"`;
    }
    return 'first array member is not a valid class name or object';
  }
  return 'no array or string given';
}

setCallableExplainer(callableProblem);

setCallableCheck(isCallable);

// Classes and objects ------------------------------------------------------------------------------------------------

defineFunction('get_class(object $object): string', ({ args }) => {
  if (args.length === 0) {
    const scope = rt().frame.scope;
    if (!scope) throwError('Error', 'get_class() without arguments must be called from within a class');
    return scope.name;
  }
  const object = args[0] as PhpObject;
  return object.cls.isAnonymous ? 'class@anonymous' : object.cls.name;
});
defineFunction('get_parent_class(object|string $object_or_class): string|false', ({ args }) => {
  const cls = args.length === 0 ? rt().frame.scope : classOf(args[0]);
  return cls?.parent?.name ?? false;
});
defineFunction('get_called_class(): string', () => {
  const cls = rt().frame.staticClass;
  if (!cls) throwError('Error', 'get_called_class() must be called from within a class');
  return cls.name;
});
defineFunction('get_object_vars(object $object): array', ({ args }) => {
  const object = args[0] as PhpObject;
  const array = new PhpArray();
  for (const [name, value] of visibleProps(object, rt().frame.scope)) array.set(normalizeKeyString(name), value);
  return array;
});
defineFunction('get_class_methods(object|string $object_or_class): array', ({ args }) => {
  const cls = classOf(args[0]);
  if (!cls)
    throwError(
      'TypeError',
      `get_class_methods(): Argument #1 ($object_or_class) must be an object or a valid class name, string given`
    );
  const names: string[] = [];
  const seen = new Set<string>();
  const scope = rt().frame.scope;
  const owners = [];
  for (let current: typeof cls | undefined = cls; current; current = current.parent) owners.push(current);
  if (cls.kind === 'interface') owners.push(...cls.interfaces);
  for (const owner of owners) {
    for (const method of owner.methods.values()) {
      if (seen.has(method.lname)) continue;
      seen.add(method.lname);
      if (classesModule.canCall(method, scope)) names.push(method.name);
    }
  }
  return PhpArray.list(names);
});
defineFunction('method_exists(object|string $object_or_class, string $method): bool', ({ args }) => {
  const cls = classOf(args[0]);
  return cls?.findMethod(lower(args[1] as string)) !== undefined;
});
defineFunction('property_exists(object|string $object_or_class, string $property): bool', ({ args }) => {
  const target = args[0];
  const name = args[1] as string;
  const cls = classOf(target);
  if (!cls) return false;
  if (cls.propByName.has(name) || cls.findStatic(name)) return true;
  return target instanceof PhpObject && target.props.has(name);
});
defineFunction('class_exists(string $class, bool $autoload = true): bool', ({ args }) => {
  const cls = findClass(args[0] as string);
  return cls !== undefined && cls.kind === 'class';
});
defineFunction(
  'interface_exists(string $interface, bool $autoload = true): bool',
  ({ args }) => findClass(args[0] as string)?.kind === 'interface'
);
defineFunction(
  'trait_exists(string $trait, bool $autoload = true): bool',
  ({ args }) => findClass(args[0] as string)?.kind === 'trait'
);
defineFunction(
  'enum_exists(string $enum, bool $autoload = true): bool',
  ({ args }) => findClass(args[0] as string)?.kind === 'enum'
);
defineFunction('is_a(mixed $object_or_class, string $class, bool $allow_string = false): bool', ({ args }) => {
  const [value, className, allowString] = args;
  const target = findClass(className as string);
  if (!target) return false;
  if (value instanceof PhpObject) return value.cls.isSubclassOf(target);
  if (typeof value === 'string' && allowString === true) return findClass(value)?.isSubclassOf(target) ?? false;
  return false;
});
defineFunction('is_subclass_of(mixed $object_or_class, string $class, bool $allow_string = true): bool', ({ args }) => {
  const [value, className, allowString = true] = args;
  const target = findClass(className as string);
  if (!target) return false;
  let cls;
  if (value instanceof PhpObject) cls = value.cls;
  else if (typeof value === 'string' && allowString === true) cls = findClass(value);
  return cls !== undefined && cls !== target && cls.isSubclassOf(target);
});
defineFunction('class_implements(object|string $object_or_class, bool $autoload = true): array|false', ({ args }) => {
  const cls = classOf(args[0]);
  if (!cls) return false;
  const array = new PhpArray();
  for (const iface of cls.interfaces) array.set(iface.name, iface.name);
  return array;
});
defineFunction('class_parents(object|string $object_or_class, bool $autoload = true): array|false', ({ args }) => {
  const cls = classOf(args[0]);
  if (!cls) return false;
  const array = new PhpArray();
  for (let parent = cls.parent; parent; parent = parent.parent) array.set(parent.name, parent.name);
  return array;
});
defineFunction('spl_object_id(object $object): int', ({ args }) => BigInt((args[0] as PhpObject).id));
defineFunction(
  'spl_object_hash(object $object): string',
  ({ args }) => `${(args[0] as PhpObject).id.toString(16).padStart(16, '0')}${'0'.repeat(16)}`
);
defineFunction('iterator_to_array(Traversable|array $iterator, bool $preserve_keys = true): array', ({ args }) => {
  const [iterable, preserveKeys = true] = args;
  const array = new PhpArray();
  for (const [key, value] of iterate(iterable)) {
    if (preserveKeys === true) {
      if (typeof key !== 'bigint' && typeof key !== 'string')
        throwError('TypeError', 'Cannot access offset of type ' + debugType(key) + ' on array');
      array.set(normalizeKeyString(String(key)), value);
    } else array.append(value);
  }
  return array;
});
defineFunction('iterator_count(Traversable|array $iterator): int', ({ args }) => {
  let count = 0n;
  for (const entry of iterate(args[0])) if (entry) count++;
  return count;
});
defineFunction('iterator_apply(Traversable $iterator, callable $callback, ?array $args = null): int', ({ args }) => {
  let count = 0n;
  const extra = args[2] instanceof PhpArray ? args[2].values() : [];
  for (const entry of iterate(args[0])) {
    if (!entry) continue;
    count++;
    if (callCallback(args[1], extra) !== true) break;
  }
  return count;
});

function classOf(value: Value): PhpClass | undefined {
  if (value instanceof PhpObject) return value.cls;
  if (typeof value === 'string') return findClass(value);
  return undefined;
}

// Errors -------------------------------------------------------------------------------------------------------------

defineFunction('trigger_error(string $message, int $error_level = E_USER_NOTICE): true', ({ args }) => {
  const level = (args[1] as bigint | undefined) ?? E_USER_NOTICE;
  if (![E_USER_ERROR, E_USER_WARNING, E_USER_NOTICE, E_USER_DEPRECATED].includes(level)) {
    throwError(
      'ValueError',
      'trigger_error(): Argument #2 ($error_level) must be one of E_USER_ERROR, E_USER_WARNING, E_USER_NOTICE, or E_USER_DEPRECATED'
    );
  }
  if (level === E_USER_ERROR)
    emitError(
      E_DEPRECATED,
      'Passing E_USER_ERROR to trigger_error() is deprecated since 8.4, throw an exception or call exit with a string message instead'
    );
  emitError(level, args[0] as string);
  return true;
});
defineAlias('user_error', 'trigger_error');
defineFunction('set_error_handler(?callable $callback, int $error_levels = E_ALL)', ({ args }) => {
  const runtime = rt();
  const previous = runtime.errorHandlers.at(-1)?.handler ?? null;
  runtime.errorHandlers.push({ handler: args[0], mask: (args[1] as bigint | undefined) ?? E_ALL });
  return previous;
});
defineFunction('restore_error_handler(): true', () => {
  rt().errorHandlers.pop();
  return true;
});
defineFunction('set_exception_handler(?callable $callback)', ({ args }) => {
  const runtime = rt();
  const previous = runtime.exceptionHandler;
  runtime.exceptionHandler = args[0];
  return previous;
});
defineFunction('restore_exception_handler(): true', () => {
  rt().exceptionHandler = null;
  return true;
});
defineFunction('error_reporting(?int $error_level = null): int', ({ args }) => {
  const runtime = rt();
  const previous = runtime.errorReporting;
  if (args[0] !== undefined && args[0] !== null) runtime.errorReporting = args[0] as bigint;
  return previous;
});
defineFunction(
  'error_log(string $message, int $message_type = 0, ?string $destination = null, ?string $additional_headers = null): bool',
  ({ args }) => {
    rt().echoError(`${args[0] as string}\n`);
    return true;
  }
);

// Miscellaneous ------------------------------------------------------------------------------------------------------

defineFunction('phpversion(?string $extension = null): string|false', ({ args }) => (args[0] ? false : '8.5.12'));
defineFunction('php_sapi_name(): string|false', () => 'cli');
defineFunction('sleep(int $seconds): int', () => 0n);
defineFunction('usleep(int $microseconds): void', () => null);
defineFunction('gc_collect_cycles(): int', () => 0n);
defineFunction('gc_enable(): void', () => null);
defineFunction('gc_disable(): void', () => null);
defineFunction('debug_print_backtrace(int $options = 0, int $limit = 0): void', () => {
  const records = callStack.toReversed().slice(1);
  rt().echo(
    records
      .map(
        (record, index) =>
          `#${index} ${record.row === undefined ? '[internal function]' : `/main.php(${record.row + 1})`}: ${record.className ? `${record.className}${record.type}` : ''}${record.name}()\n`
      )
      .join('')
  );
  return null;
});

// Standard streams ---------------------------------------------------------------------------------------------------

const streamClass = new PhpClass('(stream)');

/** A standard stream, which PHP's CLI predefines as the resources STDIN, STDOUT, and STDERR. */
export function isStream(value: Value): value is PhpObject {
  return value instanceof PhpObject && value.cls === streamClass;
}

const streams: [string, number][] = [
  ['STDIN', 1],
  ['STDOUT', 2],
  ['STDERR', 3],
];
for (const [name, id] of streams) {
  const stream = new PhpObject(streamClass, id);
  stream.internal = name;
  defineConstant(name, stream);
}

function writeStream(stream: Value, text: string, name: string): Value {
  if (!isStream(stream))
    throwError('TypeError', `${name}(): Argument #1 ($stream) must be of type resource, ${valueName(stream)} given`);
  if (stream.internal === 'STDOUT') rt().echo(text);
  else if (stream.internal === 'STDERR') rt().echoError(text);
  else throw new UnsupportedFeatureError('標準入力への書き込み');
  return BigInt(text.length);
}

defineFunction('fwrite($stream, string $data, ?int $length = null): int|false', ({ args }) => {
  const data = args[0] === undefined ? '' : (args[1] as string);
  const length = args[2] === undefined || args[2] === null ? data.length : Number(args[2]);
  return writeStream(args[0], data.slice(0, Math.max(length, 0)), 'fwrite');
});
defineAlias('fputs', 'fwrite');
defineFunction('fprintf($stream, string $format, mixed ...$values): int', ({ args }) => {
  const text = formatPrintf(args[1] as string, args.slice(2));
  writeStream(args[0], text, 'fprintf');
  return BigInt(text.length);
});
defineFunction(
  'get_defined_vars(): array',
  () => {
    const array = new PhpArray();
    for (const [name, ref] of rt().frame.vars) array.set(normalizeKeyString(name), ref.v);
    return array;
  },
  true
);

defineFunction('assert(mixed $assertion, Throwable|string|null $description = null): bool', ({ args }) => {
  const [assertion, description] = args;
  if (conversionsModule.toBool(assertion)) return true;
  if (description instanceof PhpObject) throw new PhpThrow(description);
  throwError('AssertionError', typeof description === 'string' ? description : 'assert(false)');
});
