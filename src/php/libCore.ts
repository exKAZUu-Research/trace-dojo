// code-gauge-allow-file fileNcss 559 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { lower, untilNul } from './bytes';
import { callValue, checkCallable, explainCallable } from './callables';
import { type ArgValue, backtraceLimit, callStack, frameArguments, setCallableExplainer } from './calls';
import * as classesModule from './classes';
import { classConstant, findClass, requireClassScope } from './classes';
import { debugType, getType, isNumericString, normalizeKeyString, toBool, valueName } from './conversions';
import {
  deprecated,
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
import { traceLine } from './exceptions';
import { collectGarbage } from './garbage';
import { cast, cloneObject, deprecatedConstant, iterate } from './interp';
import { defineAlias, defineConstant, defineFunction, defineRuntimeConstant, markInlined } from './native';
import { toFloat, toInt, toKey, toStr } from './operators';
import { printR, varDump, varExport } from './output';
import { share } from './places';
import { ExitSignal, rt } from './runtime';
import { formatPrintf } from './sprintf';
import { constantKey, defineConstant as defineUserConstant } from './statements';
import { setCallableCheck } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { copyValueSlot, PhpArray, PhpClass, PhpObject, Ref, type Value } from './values';

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
  ['E_RECOVERABLE_ERROR', E_RECOVERABLE_ERROR],
  ['E_DEPRECATED', E_DEPRECATED],
  ['E_USER_DEPRECATED', E_USER_DEPRECATED],
  ['E_ALL', E_ALL],
];
for (const [name, value] of errorConstants) defineConstant(name, value);
defineConstant('E_STRICT', E_STRICT, 'Constant E_STRICT is deprecated since 8.4, the error level was removed');
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
const PHP_VERSION = '8.5.12';
defineConstant('PHP_VERSION', PHP_VERSION);
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

defineFunction('print_r(mixed $value, bool $return = false): string|bool', ({ args }) =>
  printR(args[0], args[1] === true)
);
defineFunction('var_dump(mixed $value, mixed ...$values): void', ({ args }) => {
  varDump(args);
  return null;
});
defineFunction('var_export(mixed $value, bool $return = false): ?string', ({ args }) =>
  varExport(args[0], args[1] === true)
);
defineFunction('printf(string $format, mixed ...$values): int', ({ args }) => {
  const text = formatPrintf(args[0] as string, args.slice(1), (output) => rt().echo(output));
  return BigInt(text.length);
});
defineFunction('sprintf(string $format, mixed ...$values): string', ({ args }) =>
  formatPrintf(args[0] as string, args.slice(1))
);
defineFunction('vsprintf(string $format, array $values): string', ({ args }) =>
  formatPrintf(args[0] as string, args[1] as PhpArray)
);
defineFunction('vprintf(string $format, array $values): int', ({ args }) => {
  const text = formatPrintf(args[0] as string, args[1] as PhpArray, (output) => rt().echo(output));
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
defineFunction('is_object(mixed $value): bool', ({ args }) => args[0] instanceof PhpObject && !isStream(args[0]));
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
defineFunction(
  'is_callable(mixed $value, bool $syntax_only = false, &$callable_name = null): bool',
  ({ args, refs }) => {
    const value = args[0];
    let name = 'Array';
    let syntax = false;
    if (typeof value === 'string') {
      name = value;
      syntax = true;
    } else if (value instanceof PhpObject && value.cls.name !== '(stream)') {
      name = value.cls.name + '::__invoke';
      syntax = isCallable(value);
    } else if (value instanceof PhpArray && value.size === 2) {
      const owner = value.get(0n);
      const method = value.get(1n);
      if ((typeof owner === 'string' || owner instanceof PhpObject) && typeof method === 'string') {
        name = (typeof owner === 'string' ? owner : owner.cls.name) + '::' + method;
        syntax = true;
      }
    } else if (!(value instanceof PhpArray)) name = toStr(value);
    if (refs[2]) refs[2].v = name;
    return args[1] === true ? syntax : isCallable(value);
  }
);
defineFunction('is_resource(mixed $value): bool', ({ args }) => isStream(args[0]));
defineFunction('intval(mixed $value, int $base = 10): int', ({ args }) => {
  const [value, base = 10n] = args;
  if (typeof value === 'string' && base !== 10n) return parseIntBase(value, Number(BigInt.asIntN(32, base as bigint)));
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
// code-gauge-allow functionCognitiveComplexity 28 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
// code-gauge-allow functionNcss 45 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function parseIntBase(text: string, base: number): bigint {
  if (base !== 0 && (base < 2 || base > 36)) return 0n;
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
  return defineUserConstant(name.replace(/^\\/, ''), args[1]);
});
defineFunction('defined(string $constant_name): bool', ({ args }) => {
  const name = (args[0] as string).replace(/^\\/, '');
  const separator = name.lastIndexOf('::');
  if (separator !== -1) {
    const cls = constantClass(name.slice(0, separator));
    const constName = name.slice(separator + 2);
    const scope = rt().frame.scope;
    const constant = cls?.findConst(constName);
    if (!cls || cls.kind === 'trait' || !constant || !classesModule.canAccessConstant(constant, scope)) return false;
    classConstant(cls, constName, scope);
    return true;
  }
  return rt().constants.has(constantKey(name));
});
defineFunction('constant(string $name): mixed', ({ args }) => {
  const name = (args[0] as string).replace(/^\\/, '');
  const separator = name.lastIndexOf('::');
  if (separator !== -1) {
    const className = name.slice(0, separator);
    const cls = constantClass(className);
    if (!cls) throwError('Error', `Class "${className}" not found`);
    return classConstant(cls, name.slice(separator + 2), rt().frame.scope, className);
  }
  const value = rt().constants.get(constantKey(name));
  if (value === undefined) throwError('Error', `Undefined constant "${name}"`);
  return deprecatedConstant(name, value);
});

function constantClass(name: string): PhpClass | undefined {
  const { scope, staticClass } = rt().frame;
  const word = lower(name);
  if (word === 'self') return requireClassScope(scope, word);
  if (word === 'static') return requireClassScope(staticClass, word);
  if (word === 'parent') {
    const parent = requireClassScope(scope, word).parent;
    if (!parent) throwError('Error', 'Cannot access "parent" when current class scope has no parent');
    return parent;
  }
  return findClass(name);
}

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
    if (!rt().frame.fn) throwError('Error', 'func_get_arg() cannot be called from the global scope');
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
  return frameArguments(rt().frame);
}

defineFunction('clone(object $object, array $withProperties = []): object', ({ args }) => {
  return cloneObject(args[0] as PhpObject, args[1]);
});
markInlined('clone');

defineFunction('call_user_func(callable $callback, mixed ...$args): mixed', ({ args, named, row, discardResult }) => {
  const [callback, ...rest] = args;
  const argValues: ArgValue[] = rest.map((v) => ({ v }));
  for (const [name, v] of named ?? []) argValues.push({ v, name });
  if (row !== undefined) {
    const values = rt().nativeHeld.at(-1)!;
    for (const arg of argValues) arg.nativeTransfer = { values, count: args.length + (named?.size ?? 0) };
  }
  return callValue(callback, argValues, row, 'callback', discardResult);
});
defineFunction('call_user_func_array(callable $callback, array $args): mixed', ({ args, row, discardResult }) => {
  const array = args[1] as PhpArray;
  const forwarded = callbackArrayArguments(array);
  const last = forwarded.at(-1);
  if (last) last.nativeTransfer = { values: rt().nativeHeld.at(-1)!, count: args.length, value: array };
  return callValue(args[0], forwarded, row, 'callback', discardResult);
});
markInlined('call_user_func');
markInlined('call_user_func_array');

export function isCallable(value: Value): boolean {
  return checkCallable(value);
}

setCallableExplainer(explainCallable);

setCallableCheck(isCallable);

// Classes and objects ------------------------------------------------------------------------------------------------

defineFunction('get_class(object $object = UNKNOWN): string', ({ args }) => {
  if (args.length === 0) {
    const scope = rt().frame.scope;
    if (!scope) throwError('Error', 'get_class() without arguments must be called from within a class');
    deprecated('Calling get_class() without arguments is deprecated');
    return scope.fullName;
  }
  const object = args[0] as PhpObject;
  return object.cls.fullName;
});
markInlined('get_class');
defineFunction('get_parent_class(mixed $object_or_class = UNKNOWN): string|false', ({ args }) => {
  if (args.length === 0) deprecated('Calling get_parent_class() without arguments is deprecated');
  const cls = args.length === 0 ? rt().frame.scope : isStream(args[0]) ? undefined : classOf(args[0]);
  if (args.length > 0 && !cls)
    throwError(
      'TypeError',
      `get_parent_class(): Argument #1 ($object_or_class) must be an object or a valid class name, ${valueName(args[0])} given`
    );
  return cls?.parent?.name ?? false;
});
defineFunction('get_called_class(): string', () => {
  const cls = rt().frame.staticClass;
  if (!cls) throwError('Error', 'get_called_class() must be called from within a class');
  return cls.fullName;
});
markInlined('get_called_class');
defineFunction('get_object_vars(object $object): array', ({ args }) => {
  const object = args[0] as PhpObject;
  const scope = rt().frame.scope;
  const array = new PhpArray();
  const dynamic = classesModule.snapshotDynamicProperties(object);
  rt().nativeHeld.at(-1)?.push(dynamic, array);
  for (const decl of object.cls.props) {
    if (!classesModule.isVisibleProperty(object, decl, scope)) continue;
    const slot = classesModule.nativePropertySlot(object, decl.key, decl);
    if (slot !== undefined) array.setSlot(toKey(decl.name), copyValueSlot(slot));
  }
  for (const [key, slot] of dynamic.map) array.setSlot(toKey(key), copyValueSlot(slot));
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
for (const [name, related] of [
  ['class_implements', (cls: PhpClass) => cls.interfaces],
  ['class_parents', (cls: PhpClass) => ancestorsOf(cls)],
  ['class_uses', (cls: PhpClass) => cls.traits],
] as const) {
  defineFunction(`${name}(mixed $object_or_class, bool $autoload = true): array|false`, ({ args }) => {
    if (!(args[0] instanceof PhpObject) && typeof args[0] !== 'string') {
      throwError(
        'TypeError',
        `${name}(): Argument #1 ($object_or_class) must be of type object|string, ${valueName(args[0])} given`
      );
    }
    const cls = classOf(args[0]);
    if (!cls) {
      const loaded = args[1] === false ? '' : ' and could not be loaded';
      warn(`${name}(): Class ${args[0] as string} does not exist${loaded}`);
      return false;
    }
    const array = new PhpArray();
    for (const { name: className } of related(cls)) array.set(className, className);
    return array;
  });
}

function ancestorsOf(cls: PhpClass): PhpClass[] {
  const ancestors: PhpClass[] = [];
  for (let parent = cls.parent; parent; parent = parent.parent) ancestors.push(parent);
  return ancestors;
}

/** The SPL classes and interfaces as PHP 8.5 lists them, some of which the interpreter does not provide. */
const SPL_CLASSES =
  'AppendIterator ArrayIterator ArrayObject BadFunctionCallException BadMethodCallException CachingIterator CallbackFilterIterator DirectoryIterator DomainException EmptyIterator FilesystemIterator FilterIterator GlobIterator InfiniteIterator InvalidArgumentException IteratorIterator LengthException LimitIterator LogicException MultipleIterator NoRewindIterator OuterIterator OutOfBoundsException OutOfRangeException OverflowException ParentIterator RangeException RecursiveArrayIterator RecursiveCachingIterator RecursiveCallbackFilterIterator RecursiveDirectoryIterator RecursiveFilterIterator RecursiveIterator RecursiveIteratorIterator RecursiveRegexIterator RecursiveTreeIterator RegexIterator RuntimeException SeekableIterator SplDoublyLinkedList SplFileInfo SplFileObject SplFixedArray SplHeap SplMinHeap SplMaxHeap SplObjectStorage SplObserver SplPriorityQueue SplQueue SplStack SplSubject SplTempFileObject UnderflowException UnexpectedValueException';
defineFunction('spl_classes(): array', () => {
  const array = new PhpArray();
  for (const name of SPL_CLASSES.split(' ')) array.set(name, name);
  return array;
});
defineFunction('spl_object_id(object $object): int', ({ args }) => BigInt((args[0] as PhpObject).id));
defineFunction(
  'spl_object_hash(object $object): string',
  ({ args }) => `${(args[0] as PhpObject).id.toString(16).padStart(16, '0')}${'0'.repeat(16)}`
);
defineFunction('iterator_to_array(Traversable|array $iterator, bool $preserve_keys = true): array', ({ args }) => {
  const [iterable, preserveKeys = true] = args;
  if (iterable instanceof PhpArray && preserveKeys === true) return share(iterable);
  const array = new PhpArray();
  rt().frame.temporaries.push(array);
  for (const [key, value] of iterate(iterable, preserveKeys === true ? 'both' : 'value', true)) {
    const slot = value instanceof Ref ? (value.rc++, value) : share(value);
    if (preserveKeys === true) array.setSlot(toKey(key), slot);
    else array.append(slot);
  }
  return array;
});
defineFunction('iterator_count(Traversable|array $iterator): int', ({ args }) => {
  let count = 0n;
  const iterator = iterate(args[0], 'none');
  while (!iterator.next().done) count++;
  return count;
});
defineFunction('iterator_apply(Traversable $iterator, callable $callback, ?array $args = null): int', ({ args }) => {
  let count = 0n;
  const iterator = iterate(args[0], 'none');
  while (!iterator.next().done) {
    count++;
    const extra = args[2] instanceof PhpArray ? callbackArrayArguments(args[2]) : [];
    if (!toBool(callValue(args[1], extra, undefined))) break;
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
  runtime.replacedExceptionHandlers.push(previous);
  runtime.exceptionHandler = args[0];
  return previous;
});
defineFunction('restore_exception_handler(): true', () => {
  const runtime = rt();
  runtime.exceptionHandler = runtime.replacedExceptionHandlers.pop() ?? null;
  return true;
});
defineFunction('error_reporting(?int $error_level = null): int', ({ args }) => {
  const runtime = rt();
  // While `@` silences errors, PHP reports only the fatal levels (E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR,
  // E_USER_ERROR, E_RECOVERABLE_ERROR).
  const previous = runtime.silence > 0 ? runtime.errorReporting & 4437n : runtime.errorReporting;
  if (args[0] !== undefined && args[0] !== null) runtime.errorReporting = args[0] as bigint;
  return previous;
});
defineFunction(
  'error_log(string $message, int $message_type = 0, ?string $destination = null, ?string $additional_headers = null): bool',
  ({ args }) => {
    if (args[1] !== undefined && args[1] !== 0n && args[1] !== 4n)
      throw new UnsupportedFeatureError('error_log のファイル・メール出力');
    rt().echoError(`${args[0] as string}\n`);
    return true;
  }
);

// Miscellaneous ------------------------------------------------------------------------------------------------------

defineFunction('exit(string|int $status = 0): never', ({ args }) => {
  const status = args[0] ?? 0n;
  if (typeof status === 'string') rt().echo(status);
  throw new ExitSignal(typeof status === 'string' ? 0 : Number(status));
});
defineAlias('die', 'exit');
const versionedExtensions = new Set(['core', 'ctype', 'hash', 'json', 'mbstring', 'pcre', 'random', 'spl', 'standard']);
defineFunction('phpversion(?string $extension = null): string|false', ({ args }) => {
  const extension = args[0];
  return typeof extension !== 'string' || versionedExtensions.has(lower(untilNul(extension))) ? PHP_VERSION : false;
});
defineFunction('php_sapi_name(): string|false', () => 'cli');
defineFunction('sleep(int $seconds): int', ({ args }) => {
  checkDelay(args[0] as bigint, 'sleep', 'seconds');
  return 0n;
});
defineFunction('usleep(int $microseconds): void', ({ args }) => {
  checkDelay(args[0] as bigint, 'usleep', 'microseconds');
  return null;
});
defineFunction('gc_enabled(): bool', () => rt().gcEnabled);
defineFunction('gc_collect_cycles(): int', () => BigInt(collectGarbage(rt(), true)));
defineFunction('gc_enable(): void', () => {
  rt().gcEnabled = true;
  return null;
});
defineFunction('gc_disable(): void', () => {
  rt().gcEnabled = false;
  return null;
});
defineFunction('debug_print_backtrace(int $options = 0, int $limit = 0): void', ({ args }) => {
  const options = Number(args[0] ?? 0n);
  const limit = backtraceLimit(args[1] as bigint | undefined);
  const records = callStack.toReversed().slice(1, limit + 1);
  rt().echo(records.map((record, index) => traceLine(record, index, (options & 2) !== 0) + '\n').join(''));
  return null;
});

// Standard streams ---------------------------------------------------------------------------------------------------

const streamClass = new PhpClass('(stream)');

/** A standard stream, which PHP's CLI predefines as the resources STDIN, STDOUT, and STDERR. */
function isStream(value: Value): value is PhpObject {
  return value instanceof PhpObject && value.cls === streamClass;
}

const streams: [string, number][] = [
  ['STDIN', 1],
  ['STDOUT', 2],
  ['STDERR', 3],
];
for (const [name, id] of streams) {
  defineRuntimeConstant(name, () => {
    const stream = new PhpObject(streamClass, id);
    stream.internal = name;
    return stream;
  });
}

export function writeStream(stream: PhpObject, text: string): bigint {
  if (stream.internal === 'STDOUT') rt().echo(text);
  else if (stream.internal === 'STDERR') rt().echoError(text);
  else throw new UnsupportedFeatureError('標準入力への書き込み');
  return BigInt(text.length);
}

defineFunction('fwrite(resource $stream, string $data, ?int $length = null): int|false', ({ args }) => {
  const stream = args[0] as PhpObject;
  const data = args[1] as string;
  const length = args[2] === undefined || args[2] === null ? data.length : Number(args[2]);
  return writeStream(stream, data.slice(0, Math.max(length, 0)));
});
defineAlias('fputs', 'fwrite');
defineFunction('fprintf(resource $stream, string $format, mixed ...$values): int', ({ args }) => {
  const stream = args[0] as PhpObject;
  return BigInt(formatPrintf(args[1] as string, args.slice(2), (output) => writeStream(stream, output)).length);
});
defineFunction(
  'get_defined_vars(): array',
  () => {
    const array = new PhpArray();
    for (const [name, ref] of rt().frame.vars) array.setSlot(normalizeKeyString(name), copyValueSlot(ref));
    return array;
  },
  true
);

function checkDelay(value: bigint, name: string, parameter: string): void {
  if (value < 0n) throwError('ValueError', `${name}(): Argument #1 ($${parameter}) must be greater than or equal to 0`);
}

function callbackArrayArguments(array: PhpArray): ArgValue[] {
  const argValues: ArgValue[] = [];
  for (const [key, slot] of array.map) {
    const ref = slot instanceof Ref && slot.isRef ? slot : undefined;
    const v = slot instanceof Ref ? slot.v : slot;
    if (typeof key === 'string') argValues.push({ v, ref, name: key });
    else argValues.push({ v, ref });
  }
  return argValues;
}
