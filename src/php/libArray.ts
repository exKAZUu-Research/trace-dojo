// code-gauge-allow-file fileNcss 883 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { lower, upper } from './bytes';
import { callCallback, callCallbackRefs, callMethod } from './callables';
import { canAccessProp, issetProp, lookupProp, objectToArray, readProp } from './classes';
import * as conversionsModule from './conversions';
import { compareBytes, compareNumbers, debugType, floatFitsInt, normalizeKeyString, valueName } from './conversions';
import { deprecated, throwError, warn } from './errors';
import { cast } from './interp';
import { naturalCompare } from './libString';
import { defineAlias, defineConstant, defineFunction, markInlined } from './native';
import { arithmetic, compare, looseEquals, strictEquals, toFloat, toKey, toStr } from './operators';
import { ElementPlace, share, VarPlace } from './places';
import { rt } from './runtime';
import { INT_MIN, type Key, type NativeContext, PhpArray, PhpObject, Ref, UNINIT, type Value } from './values';
import { zendSort } from './zendSort';

defineConstant('SORT_REGULAR', 0n);
defineConstant('SORT_NUMERIC', 1n);
defineConstant('SORT_STRING', 2n);
defineConstant('SORT_LOCALE_STRING', 5n);
defineConstant('SORT_NATURAL', 6n);
defineConstant('SORT_FLAG_CASE', 8n);
defineConstant('SORT_ASC', 4n);
defineConstant('SORT_DESC', 3n);
defineConstant('COUNT_NORMAL', 0n);
defineConstant('COUNT_RECURSIVE', 1n);
defineConstant('CASE_LOWER', 0n);
defineConstant('CASE_UPPER', 1n);
defineConstant('ARRAY_FILTER_USE_KEY', 2n);
defineConstant('ARRAY_FILTER_USE_BOTH', 1n);
defineConstant('EXTR_OVERWRITE', 0n);
defineConstant('EXTR_SKIP', 1n);
defineConstant('EXTR_PREFIX_SAME', 2n);
defineConstant('EXTR_PREFIX_ALL', 3n);
defineConstant('EXTR_PREFIX_INVALID', 4n);
defineConstant('EXTR_IF_EXISTS', 6n);
defineConstant('EXTR_PREFIX_IF_EXISTS', 5n);
defineConstant('EXTR_REFS', 256n);

const arr = (value: Value): PhpArray => value as PhpArray;

/** The array a by-reference parameter holds, separated from other holders so that the function may change it. */
function writableArray(ctx: NativeContext, index: number): PhpArray {
  const ref = ctx.refs[index] as Ref;
  let array = ref.v as PhpArray;
  if (array.shared) {
    array = array.copy();
    ref.v = array;
  }
  return array;
}

function checkArrayRef(ctx: NativeContext, index: number, name: string, parameter: string): void {
  const value = ctx.refs[index]?.v ?? ctx.args[index];
  if (!(value instanceof PhpArray)) {
    throwError(
      'TypeError',
      `${name}(): Argument #${index + 1} ($${parameter}) must be of type array, ${valueName(value)} given`
    );
  }
}

function keyValue(key: Key): Value {
  return key;
}

function rebuild(entries: [Key, Value | Ref][], renumber: boolean): PhpArray {
  const array = new PhpArray();
  for (const [key, slot] of entries) {
    if (renumber && typeof key === 'bigint') array.append(slot);
    else if (slot instanceof Ref) array.setSlot(key, slot);
    else array.set(key, slot);
  }
  return array;
}

// Counting and access ------------------------------------------------------------------------------------------------

defineFunction('count(Countable|array $value, int $mode = COUNT_NORMAL): int', ({ args }) => {
  const [value, mode = 0n] = args;
  if (value instanceof PhpArray) return BigInt(mode === 1n ? countRecursive(value) : value.size);
  if (value instanceof PhpObject) {
    const countable = rt().classes.get('countable');
    if (countable && value.cls.isSubclassOf(countable)) {
      return callMethod(value, 'count', []);
    }
  }
  throwError('TypeError', `count(): Argument #1 ($value) must be of type Countable|array, ${valueName(value)} given`);
});
defineAlias('sizeof', 'count');
markInlined('count');
markInlined('sizeof');

function countRecursive(array: PhpArray): number {
  let count = array.size;
  for (const item of array.values()) {
    rt().spend();
    if (item instanceof PhpArray) count += countRecursive(item);
  }
  return count;
}

defineFunction('array_push(array &$array, mixed ...$values): int', (ctx) => {
  checkArrayRef(ctx, 0, 'array_push', 'array');
  const array = writableArray(ctx, 0);
  for (const value of ctx.args.slice(1)) {
    if (!array.append(share(value)))
      throwError('Error', 'Cannot add element to the array as the next element is already occupied');
  }
  return BigInt(array.size);
});
defineFunction('array_pop(array &$array): mixed', (ctx) => {
  checkArrayRef(ctx, 0, 'array_pop', 'array');
  const array = writableArray(ctx, 0);
  const last = [...array.map.keys()].at(-1);
  if (last === undefined) return null;
  const value = array.get(last) as Value;
  array.delete(last);
  if (last === array.nextFree - 1n) array.nextFree = last;
  array.pointer = null;
  return value;
});
defineFunction('array_shift(array &$array): mixed', (ctx) => {
  checkArrayRef(ctx, 0, 'array_shift', 'array');
  const array = writableArray(ctx, 0);
  const first = array.map.keys().next();
  if (first.done) return null;
  const value = array.get(first.value) as Value;
  array.delete(first.value);
  const rebuilt = rebuild([...array.map], true);
  array.map = rebuilt.map;
  array.nextFree = rebuilt.nextFree;
  array.pointer = null;
  return value;
});
defineFunction('array_unshift(array &$array, mixed ...$values): int', (ctx) => {
  checkArrayRef(ctx, 0, 'array_unshift', 'array');
  const array = writableArray(ctx, 0);
  const entries: [Key, Value | Ref][] = [
    ...ctx.args.slice(1).map((value): [Key, Value] => [0n, share(value)]),
    ...array.map,
  ];
  const rebuilt = rebuild(entries, true);
  array.map = rebuilt.map;
  array.nextFree = rebuilt.nextFree;
  array.pointer = null;
  return BigInt(array.size);
});

defineFunction('array_key_exists($key, array $array): bool', ({ args, row }) => {
  const [key, array] = args;
  if (!(array instanceof PhpArray))
    throwError(
      'TypeError',
      `array_key_exists(): Argument #2 ($array) must be of type array, ${valueName(array)} given`
    );
  return array.has(arrayKeyOf(key, row !== undefined));
});
markInlined('array_key_exists');
defineAlias('key_exists', 'array_key_exists');

/** The key `array_key_exists` looks up; the opcode a direct call compiles to rejects an invalid key as an offset does. */
function arrayKeyOf(key: Value, inlined: boolean): Key {
  if ((key instanceof PhpArray || key instanceof PhpObject) && !inlined)
    throwError('TypeError', 'array_key_exists(): Argument #1 ($key) must be a valid array offset type');
  if (key !== null) return toKey(key);
  deprecated('Using null as the key parameter for array_key_exists() is deprecated, use an empty string instead');
  return '';
}

defineFunction('array_key_first(array $array): int|string|null', ({ args }) => {
  const first = arr(args[0]).map.keys().next();
  return first.done ? null : keyValue(first.value);
});
defineFunction('array_key_last(array $array): int|string|null', ({ args }) => {
  const last = [...arr(args[0]).map.keys()].at(-1);
  return last === undefined ? null : keyValue(last);
});
defineFunction('array_first(array $array): mixed', ({ args }) => arr(args[0]).values()[0] ?? null);
defineFunction('array_last(array $array): mixed', ({ args }) => arr(args[0]).values().at(-1) ?? null);
defineFunction('array_keys(array $array, mixed $filter_value = UNKNOWN, bool $strict = false): array', ({ args }) => {
  const array = arr(args[0]);
  const keys = new PhpArray();
  for (const [key, value] of array.entries()) {
    if (args.length >= 2) {
      const matches = args[2] === true ? strictEquals(value, args[1]) : looseEquals(value, args[1]);
      if (!matches) continue;
    }
    keys.append(keyValue(key));
  }
  return keys;
});
defineFunction('array_values(array $array): array', ({ args }) => {
  const array = arr(args[0]);
  // PHP returns a list as it is, sharing it with its internal pointer.
  if (array.isList()) return share(array);
  return PhpArray.list(array.values().map((value) => share(value)));
});
defineFunction('array_is_list(array $array): bool', ({ args }) => arr(args[0]).isList());
defineFunction('in_array(mixed $needle, array $haystack, bool $strict = false): bool', ({ args }) => {
  const [needle, haystack, strict] = args;
  for (const value of arr(haystack).values()) {
    rt().spend();
    if (strict === true ? strictEquals(value, needle) : looseEquals(value, needle)) return true;
  }
  return false;
});
defineFunction('array_search(mixed $needle, array $haystack, bool $strict = false): int|string|false', ({ args }) => {
  const [needle, haystack, strict] = args;
  for (const [key, value] of arr(haystack).entries()) {
    rt().spend();
    if (strict === true ? strictEquals(value, needle) : looseEquals(value, needle)) return keyValue(key);
  }
  return false;
});

// Building arrays ----------------------------------------------------------------------------------------------------

defineFunction('array_merge(array ...$arrays): array', ({ args }) => {
  const result = new PhpArray();
  for (const [index, value] of args.entries()) {
    if (!(value instanceof PhpArray))
      throwError('TypeError', `array_merge(): Argument #${index + 1} must be of type array, ${valueName(value)} given`);
    for (const [key, item] of value.entries()) {
      if (typeof key === 'bigint') result.append(share(item));
      else result.set(key, share(item));
    }
  }
  return result;
});
defineFunction('array_merge_recursive(array ...$arrays): array', ({ args }) => {
  const result = new PhpArray();
  for (const value of args) mergeRecursive(result, arr(value));
  return result;
});

function mergeRecursive(target: PhpArray, source: PhpArray): void {
  for (const [key, item] of source.entries()) {
    if (typeof key === 'bigint') {
      target.append(share(item));
      continue;
    }
    const existing = target.get(key);
    if (existing === undefined) {
      target.set(key, share(item));
      continue;
    }
    const merged = existing instanceof PhpArray ? existing.copy() : PhpArray.list([existing]);
    if (item instanceof PhpArray) mergeRecursive(merged, item);
    else merged.append(item);
    target.set(key, merged);
  }
}

defineFunction('array_replace(array $array, array ...$replacements): array', ({ args }) => {
  const result = arr(args[0]).copy();
  for (const replacement of args.slice(1))
    for (const [key, item] of arr(replacement).entries()) result.set(key, share(item));
  return result;
});
defineFunction('array_replace_recursive(array $array, array ...$replacements): array', ({ args }) => {
  const replace = (base: PhpArray, replacement: PhpArray): PhpArray => {
    const result = base.copy();
    for (const [key, item] of replacement.entries()) {
      const existing = result.get(key);
      if (item instanceof PhpArray && existing instanceof PhpArray) result.set(key, replace(existing, item));
      else result.set(key, share(item));
    }
    return result;
  };
  let result = arr(args[0]);
  for (const replacement of args.slice(1)) result = replace(result, arr(replacement));
  return result;
});
defineFunction('array_combine(array $keys, array $values): array', ({ args }) => {
  const keys = arr(args[0]).values();
  const values = arr(args[1]).values();
  if (keys.length !== values.length) {
    throwError(
      'ValueError',
      'array_combine(): Argument #1 ($keys) and argument #2 ($values) must have the same number of elements'
    );
  }
  const result = new PhpArray();
  for (const [index, key] of keys.entries()) result.set(toKey(toStrKey(key)), share(values[index]));
  return result;
});

function toStrKey(value: Value): Value {
  if (typeof value === 'bigint' || typeof value === 'string') return value;
  return toStr(value);
}

defineFunction('array_change_key_case(array $array, int $case = CASE_LOWER): array', ({ args }) => {
  const changeCase = (args[1] ?? 0n) === 0n ? lower : upper;
  return rebuild(
    [...arr(args[0]).map].map(([key, slot]) => [typeof key === 'string' ? changeCase(key) : key, slot]),
    false
  );
});
defineFunction('array_flip(array $array): array', ({ args }) => {
  const result = new PhpArray();
  for (const [key, value] of arr(args[0]).entries()) {
    if (typeof value !== 'bigint' && typeof value !== 'string') {
      warn('array_flip(): Can only flip string and integer values, entry skipped');
      continue;
    }
    result.set(toKey(value), keyValue(key));
  }
  return result;
});
defineFunction('array_fill(int $start_index, int $count, mixed $value): array', ({ args }) => {
  const [start, count, value] = args as [bigint, bigint, Value];
  if (count < 0n) throwError('ValueError', 'array_fill(): Argument #2 ($count) must be greater than or equal to 0');
  if (count >= 2n ** 31n) throwError('ValueError', 'array_fill(): Argument #2 ($count) is too large');
  rt().ensureRoom(Number(count));
  const result = new PhpArray();
  rt().spend(Number(count) / 16);
  for (let index = 0n; index < count; index++) result.set(start + index, share(value));
  return result;
});
defineFunction('array_fill_keys(array $keys, mixed $value): array', ({ args }) => {
  const result = new PhpArray();
  for (const key of arr(args[0]).values()) result.set(toKey(toStrKey(key)), share(args[1]));
  return result;
});
defineFunction('array_pad(array $array, int $length, mixed $value): array', ({ args }) => {
  const array = arr(args[0]);
  const length = Number(args[1]);
  const size = Math.abs(length);
  if (size <= array.size) return array;
  rt().ensureRoom(size);
  const padding: [Key, Value][] = Array.from({ length: size - array.size }, (): [Key, Value] => [0n, share(args[2])]);
  const entries: [Key, Value | Ref][] = length > 0 ? [...array.map, ...padding] : [...padding, ...array.map];
  return rebuild(entries, true);
});
defineFunction('range(string|int|float $start, string|int|float $end, int|float $step = 1): array', ({ args }) =>
  range(args[0] as RangeInput, args[1] as RangeInput, (args[2] ?? 1n) as bigint | number)
);

type RangeInput = string | bigint | number;

/** How `range` reads an input, ordered as PHP orders them: a one-digit string may be a number or a character. */
const enum RangeKind {
  Int,
  Float,
  Character,
  Digit,
}

interface RangeValue {
  kind: RangeKind;
  int: bigint;
  float: number;
}

const RANGE_ARGUMENTS = ['', '$start', '$end', '$step'];

/** Builds the array of `range`, following PHP's checks and its choice between ints, floats, and characters. */
function range(startInput: RangeInput, endInput: RangeInput, stepInput: bigint | number): PhpArray {
  const step = rangeStep(stepInput);
  const start = rangeValue(startInput, 1);
  const end = rangeValue(endInput, 2);
  const hasCharacter = start.kind >= RangeKind.Character || end.kind >= RangeKind.Character;
  if (hasCharacter && charactersAllowed(start, end, step.isFloat)) {
    return characterRange(
      (startInput as string).charCodeAt(0),
      (endInput as string).charCodeAt(0),
      Number(step.int),
      step.isNegative
    );
  }
  if (start.kind === RangeKind.Float || end.kind === RangeKind.Float || step.isFloat)
    return numberRange(start.float, end.float, step.float, step.isNegative, (value) => value);
  return numberRange(start.int, end.int, step.int, step.isNegative, BigInt);
}

/** The size of a step of `range`, which PHP makes positive and reads as an int when a float holds an integer. */
function rangeStep(input: bigint | number): {
  int: bigint;
  float: number;
  isFloat: boolean;
  isNegative: boolean;
} {
  if (typeof input === 'number') {
    const value = finiteRangeNumber(input, 3);
    const float = Math.abs(value);
    const int = floatFitsInt(float) ? BigInt(Math.trunc(float)) : 0n;
    if (float === 0) rangeError(3, 'cannot be 0');
    return { int, float, isFloat: Number(int) !== float, isNegative: value < 0 };
  }
  if (input === INT_MIN) rangeError(3, `must be greater than ${INT_MIN}`);
  if (input === 0n) rangeError(3, 'cannot be 0');
  const int = input < 0n ? -input : input;
  return { int, float: Number(int), isFloat: false, isNegative: input < 0n };
}

/**
 * Whether `range` builds characters when a bound is a string, turning the bounds into ints otherwise with PHP's
 * warnings: both bounds must be single bytes and the step an int.
 */
function charactersAllowed(start: RangeValue, end: RangeValue, stepIsFloat: boolean): boolean {
  if (start.kind < RangeKind.Character) {
    if (end.kind !== RangeKind.Digit)
      warn(
        'range(): Argument #1 ($start) must be a single byte string if argument #2 ($end) is a single byte string, argument #2 ($end) converted to 0'
      );
    end.kind = RangeKind.Int;
    return false;
  }
  if (end.kind < RangeKind.Character) {
    if (start.kind !== RangeKind.Digit)
      warn(
        'range(): Argument #2 ($end) must be a single byte string if argument #1 ($start) is a single byte string, argument #1 ($start) converted to 0'
      );
    start.kind = RangeKind.Int;
    return false;
  }
  if (!stepIsFloat) return true;
  if (start.kind === RangeKind.Character || end.kind === RangeKind.Character)
    warn(
      'range(): Argument #3 ($step) must be of type int when generating an array of characters, inputs converted to 0'
    );
  start.kind = RangeKind.Int;
  end.kind = RangeKind.Int;
  return false;
}

function rangeValue(input: RangeInput, position: number): RangeValue {
  if (typeof input === 'bigint') return { kind: RangeKind.Int, int: input, float: Number(input) };
  if (typeof input === 'number') return { kind: RangeKind.Float, int: 0n, float: finiteRangeNumber(input, position) };
  if (input === '') {
    warn(`range(): Argument #${position} (${RANGE_ARGUMENTS[position]}) must not be empty, casted to 0`);
    return { kind: RangeKind.Int, int: 0n, float: 0 };
  }
  const numeric = numericOf(input);
  if (typeof numeric === 'number')
    return { kind: RangeKind.Float, int: 0n, float: finiteRangeNumber(numeric, position) };
  if (numeric !== undefined)
    return {
      kind: input.length === 1 ? RangeKind.Digit : RangeKind.Int,
      int: numeric,
      float: Number(numeric),
    };
  if (input.length !== 1)
    warn(
      `range(): Argument #${position} (${RANGE_ARGUMENTS[position]}) must be a single byte, subsequent bytes are ignored`
    );
  return { kind: RangeKind.Character, int: 0n, float: 0 };
}

function finiteRangeNumber(value: number, position: number): number {
  if (Number.isFinite(value)) return value;
  rangeError(position, `must be a finite number, ${Number.isNaN(value) ? 'NAN' : 'INF'} provided`);
}

function rangeError(position: number, message: string): never {
  throwError('ValueError', `range(): Argument #${position} (${RANGE_ARGUMENTS[position]}) ${message}`);
}

function characterRange(low: number, high: number, step: number, stepIsNegative: boolean): PhpArray {
  const result = new PhpArray();
  if (low > high) {
    if (low - high < step) rangeBoundaryError();
    for (; low >= high; low -= step) result.append(String.fromCharCode(low));
  } else if (high > low) {
    if (stepIsNegative) rangeError(3, 'must be greater than 0 for increasing ranges');
    if (high - low < step) rangeBoundaryError();
    for (; low <= high; low += step) result.append(String.fromCharCode(low));
  } else result.append(String.fromCharCode(low));
  return result;
}

/** The ints or floats from `start` to `end`, which PHP computes as `start ± i * step` to avoid accumulating errors. */
function numberRange<T extends bigint | number>(
  start: T,
  end: T,
  step: T,
  stepIsNegative: boolean,
  fromIndex: (index: number) => T
): PhpArray {
  const result = new PhpArray();
  if (start === end) {
    result.append(start);
    return result;
  }
  if (end > start && stepIsNegative) rangeError(3, 'must be greater than 0 for increasing ranges');
  const span = (end > start ? (end as number) - (start as number) : (start as number) - (end as number)) as T;
  if (span < step) rangeBoundaryError();
  const size =
    typeof span === 'bigint'
      ? Number((span as bigint) / (step as bigint)) + 1
      : Math.round(span / (step as number) + 1);
  rt().spend(size / 16);
  for (let index = 0; index < size; index++) {
    const offset = (fromIndex(index) as number) * (step as number);
    const value = (end > start ? (start as number) + offset : (start as number) - offset) as T;
    if (typeof value === 'number' && (end > start ? value > (end as number) : value < (end as number))) break;
    result.append(value);
  }
  return result;
}

function rangeBoundaryError(): never {
  rangeError(3, 'must be less than the range spanned by argument #1 ($start) and argument #2 ($end)');
}

function numericOf(text: string): bigint | number | undefined {
  const { numericValue } = conversionsModule;
  return numericValue(text);
}

defineFunction(
  'compact($var_name, ...$var_names): array',
  ({ args }) => {
    const frame = rt().frame;
    const result = new PhpArray();
    const visit = (value: Value): void => {
      if (value instanceof PhpArray) {
        for (const item of value.values()) visit(item);
        return;
      }
      const name = toStr(value);
      const ref = frame.vars.get(name);
      if (name === 'this' && frame.thisObj) result.set('this', frame.thisObj);
      else if (ref) result.set(normalizeKeyString(name), share(ref.v));
      else warn(`compact(): Undefined variable $${name}`);
    };
    for (const value of args) visit(value);
    return result;
  },
  true
);
defineFunction(
  'extract(array &~$array, int $flags = EXTR_OVERWRITE, string $prefix = UNKNOWN): int',
  ({ args, refs }) => {
    const flags = (args[1] as bigint | undefined) ?? 0n;
    const mode = Number(flags & 0xffn);
    const prefix = args[2] as string | undefined;
    checkExtractArguments(mode, prefix);
    const byReference = (flags & 256n) !== 0n;
    let array = (refs[0]?.v ?? args[0]) as PhpArray;
    if (byReference && array.shared) {
      array = array.copy();
      if (refs[0]) refs[0].v = array;
    }
    const frame = rt().frame;
    let count = 0n;
    for (const key of array.keys()) {
      const name = extractedName(key, mode, `${prefix ?? ''}_`, (candidate) => frame.vars.has(candidate));
      if (name === undefined) continue;
      if (name === 'this') throwError('Error', 'Cannot re-assign $this');
      const place = new VarPlace(frame, name);
      if (byReference) place.bind(new ElementPlace(array, key).ref());
      else place.set(share(array.get(key) as Value));
      count++;
    }
    return count;
  },
  true
);

function checkExtractArguments(mode: number, prefix: string | undefined): void {
  if (mode > 6) throwError('ValueError', 'extract(): Argument #2 ($flags) must be a valid extract type');
  if (mode > 1 && mode <= 5 && prefix === undefined)
    throwError('ValueError', 'extract(): Argument #3 ($prefix) is required when using this extract type');
  if (prefix && !isVariableName(prefix))
    throwError('ValueError', 'extract(): Argument #3 ($prefix) must be a valid identifier');
}

/** How each extract mode (EXTR_OVERWRITE to EXTR_IF_EXISTS) names the variable of a string key. */
const EXTRACT_MODES: ((key: string, prefixed: () => string | undefined, exists: boolean) => string | undefined)[] = [
  (key, _prefixed, exists) => (key === 'GLOBALS' && exists ? undefined : validName(key)),
  (key, _prefixed, exists) => (key === 'this' || exists ? undefined : validName(key)),
  (key, prefixed, exists) => {
    if (key !== '') return exists || key === 'this' ? prefixed() : validName(key);
  },
  (_key, prefixed) => prefixed(),
  (key, prefixed) => (key !== 'this' && isVariableName(key) ? key : prefixed()),
  (_key, prefixed, exists) => (exists ? prefixed() : undefined),
  (key, _prefixed, exists) => (exists && key !== 'GLOBALS' ? validName(key) : undefined),
];

/** The variable `extract` writes an element to in `mode`, or undefined to skip it, as ext/standard/array.c decides. */
function extractedName(key: Key, mode: number, prefix: string, exists: (name: string) => boolean): string | undefined {
  const prefixed = (): string | undefined => validName(prefix + key);
  if (typeof key === 'bigint') return mode === 3 || mode === 4 ? prefixed() : undefined;
  return EXTRACT_MODES[mode](key, prefixed, exists(key));
}

function validName(name: string): string | undefined {
  return isVariableName(name) ? name : undefined;
}

function isVariableName(name: string): boolean {
  return /^[A-Za-z_\u007F-ÿ][\w\u007F-ÿ]*$/.test(name);
}

// Transforming arrays ------------------------------------------------------------------------------------------------

defineFunction('array_map(?callable $callback, array $array, array ...$arrays): array', ({ args }) => {
  const [callback, first, ...rest] = args;
  if (!(first instanceof PhpArray))
    throwError('TypeError', `array_map(): Argument #2 ($array) must be of type array, ${valueName(first)} given`);
  if (rest.length === 0) {
    if (callback === null) return first;
    const result = new PhpArray();
    rt().held.push(first);
    try {
      for (const [key, value] of first.entries()) result.set(key, share(callCallback(callback, [value])));
    } finally {
      rt().held.pop();
    }
    return result;
  }
  for (const [index, value] of rest.entries()) {
    if (!(value instanceof PhpArray)) {
      throwError('TypeError', `array_map(): Argument #${index + 3} must be of type array, ${valueName(value)} given`);
    }
  }
  const lists = [first, ...rest].map((value) => (value as PhpArray).values());
  const length = Math.max(...lists.map((list) => list.length));
  const result = new PhpArray();
  for (let index = 0; index < length; index++) {
    const items = lists.map((list) => (index < list.length ? list[index] : null));
    result.append(callback === null ? PhpArray.list(items) : share(callCallback(callback, items)));
  }
  return result;
});
defineFunction('array_filter(array $array, ?callable $callback = null, int $mode = 0): array', ({ args }) => {
  const [array, callback = null, mode = 0n] = args;
  const result = new PhpArray();
  rt().held.push(array);
  try {
    for (const [key, value] of arr(array).entries()) {
      let keep: Value;
      if (callback === null) keep = value;
      else if (mode === 2n) keep = callCallback(callback, [key]);
      else if (mode === 1n) keep = callCallback(callback, [value, key]);
      else keep = callCallback(callback, [value]);
      if (conversionsModule.toBool(keep)) result.set(key, share(value));
    }
  } finally {
    rt().held.pop();
  }
  return result;
});
defineFunction('array_reduce(array $array, callable $callback, mixed $initial = null): mixed', ({ args }) => {
  let carry = args[2] ?? null;
  for (const value of arr(args[0]).values()) carry = callCallback(args[1], [carry, value]);
  return carry;
});
defineFunction('array_walk(array|object &$array, callable $callback, mixed $arg = UNKNOWN): true', (ctx) => {
  const ref = ctx.refs[0] as Ref;
  if (ref.v instanceof PhpArray) {
    const array = writableArray(ctx, 0);
    for (const key of array.keys()) {
      if (!array.map.has(key)) continue;
      const elementRef = new ElementPlace(array, key).ref();
      const callArgs = [{ v: elementRef.v, ref: elementRef }, { v: keyValue(key) }];
      if (ctx.args.length > 2) callArgs.push({ v: ctx.args[2] });
      callCallbackRefs(ctx.args[1], callArgs);
    }
  }
  return true;
});
defineFunction('array_walk_recursive(array|object &$array, callable $callback, mixed $arg = UNKNOWN): true', (ctx) => {
  const walk = (ref: Ref): void => {
    let array = ref.v as PhpArray;
    if (array.shared) {
      array = array.copy();
      ref.v = array;
    }
    for (const key of array.keys()) {
      const elementRef = new ElementPlace(array, key).ref();
      if (elementRef.v instanceof PhpArray) {
        walk(elementRef);
        continue;
      }
      const callArgs = [{ v: elementRef.v, ref: elementRef }, { v: keyValue(key) }];
      if (ctx.args.length > 2) callArgs.push({ v: ctx.args[2] });
      callCallbackRefs(ctx.args[1], callArgs);
    }
  };
  walk(ctx.refs[0] as Ref);
  return true;
});
defineFunction(
  'array_slice(array $array, int $offset, ?int $length = null, bool $preserve_keys = false): array',
  ({ args }) => {
    const entries = [...arr(args[0]).map];
    const { start, end } = sliceBounds(
      entries.length,
      Number(args[1]),
      args[2] === undefined || args[2] === null ? undefined : Number(args[2])
    );
    return rebuild(entries.slice(start, end), args[3] !== true);
  }
);

function sliceBounds(size: number, offset: number, length: number | undefined): { start: number; end: number } {
  let start = offset < 0 ? Math.max(size + offset, 0) : Math.min(offset, size);
  let end = size;
  if (length !== undefined) end = length < 0 ? Math.max(size + length, start) : Math.min(start + length, size);
  if (end < start) start = end;
  return { start, end };
}

defineFunction(
  'array_splice(array &$array, int $offset, ?int $length = null, mixed $replacement = []): array',
  (ctx) => {
    const array = writableArray(ctx, 0);
    const entries = [...array.map];
    const { start, end } = sliceBounds(
      entries.length,
      Number(ctx.args[1]),
      ctx.args[2] === undefined || ctx.args[2] === null ? undefined : Number(ctx.args[2])
    );
    const replacementValue = ctx.args[3];
    const replacement: [Key, Value][] =
      replacementValue === undefined
        ? []
        : replacementValue instanceof PhpArray
          ? replacementValue.values().map((value): [Key, Value] => [0n, share(value)])
          : [[0n, replacementValue]];
    const removed = rebuild(entries.slice(start, end), true);
    const rebuilt = rebuild([...entries.slice(0, start), ...replacement, ...entries.slice(end)], true);
    array.map = rebuilt.map;
    array.nextFree = rebuilt.nextFree;
    array.pointer = null;
    return removed;
  }
);
defineFunction('array_reverse(array $array, bool $preserve_keys = false): array', ({ args }) =>
  rebuild([...arr(args[0]).map].toReversed(), args[1] !== true)
);
defineFunction('array_unique(array $array, int $flags = SORT_STRING): array', ({ args }) => {
  const flags = (args[1] as bigint | undefined) ?? 2n;
  const result = new PhpArray();
  const kept: Value[] = [];
  for (const [key, value] of arr(args[0]).entries()) {
    rt().spend();
    const duplicate = kept.some((other) => sortComparator(flags)(other, value) === 0);
    if (duplicate) continue;
    kept.push(value);
    result.set(key, share(value));
  }
  return result;
});
defineFunction('array_sum(array $array): int|float', ({ args }) => {
  let sum: Value = 0n;
  for (const value of arr(args[0]).values()) sum = accumulate('array_sum', '+', 'Addition', sum, value);
  return sum;
});
defineFunction('array_product(array $array): int|float', ({ args }) => {
  let product: Value = 1n;
  for (const value of arr(args[0]).values())
    product = accumulate('array_product', '*', 'Multiplication', product, value);
  return product;
});

function accumulate(name: string, op: string, word: string, total: Value, value: Value): Value {
  if (value instanceof PhpArray || value instanceof PhpObject) {
    warn(`${name}(): ${word} is not supported on type ${debugType(value)}`);
    return total;
  }
  // A string that holds no number counts as 0, after the same warning.
  if (typeof value === 'string' && conversionsModule.numericPrefix(value) === undefined) {
    warn(`${name}(): ${word} is not supported on type string`);
    return arithmetic(op, total, 0n);
  }
  return arithmetic(op, total, value === null || typeof value === 'boolean' ? (value ? 1n : 0n) : value);
}

defineFunction(
  'array_column(array $array, int|string|null $column_key, int|string|null $index_key = null): array',
  ({ args }) => {
    const [rows, column, index] = args;
    const result = new PhpArray();
    for (const row of arr(rows).values()) {
      const value = column === null ? row : columnField(row, column);
      if (value === undefined) continue;
      const indexValue = index === null || index === undefined ? undefined : columnField(row, index);
      if (indexValue === undefined) result.append(share(value));
      else result.set(toKey(indexValue), share(value));
    }
    return result;
  }
);

/** A row's field for `array_column`: an element of an array row or a property of an object row that the caller can read. */
function columnField(row: Value, key: Value): Value | undefined {
  if (row instanceof PhpArray) return row.get(toKey(key));
  if (!(row instanceof PhpObject)) return undefined;
  const name = toStr(key);
  const scope = rt().frame.scope;
  const decl = lookupProp(row.cls, name, scope);
  let exists = row.props.has(name);
  if (decl && !decl.isStatic) {
    const slot = row.props.get(decl.key);
    exists = canAccessProp(decl, scope) && ((slot !== undefined && slot !== UNINIT) || decl.hooks?.get !== undefined);
  }
  return exists || issetProp(row, name, scope) ? readProp(row, name, scope) : undefined;
}

defineFunction('array_chunk(array $array, int $length, bool $preserve_keys = false): array', ({ args }) => {
  const length = Number(args[1]);
  if (length < 1) throwError('ValueError', 'array_chunk(): Argument #2 ($length) must be greater than 0');
  const result = new PhpArray();
  let chunk: PhpArray | undefined;
  for (const [key, value] of arr(args[0]).entries()) {
    if (!chunk || chunk.size >= length) {
      chunk = new PhpArray();
      result.append(chunk);
    }
    if (args[2] === true) chunk.set(key, share(value));
    else chunk.append(share(value));
  }
  return result;
});
defineFunction('array_count_values(array $array): array', ({ args }) => {
  const result = new PhpArray();
  for (const value of arr(args[0]).values()) {
    if (typeof value !== 'bigint' && typeof value !== 'string') {
      warn('array_count_values(): Can only count string and integer values, entry skipped');
      continue;
    }
    const key = toKey(value);
    result.set(key, ((result.get(key) as bigint | undefined) ?? 0n) + 1n);
  }
  return result;
});

type SetCompare = (a: [Key, Value], b: [Key, Value]) => boolean;

function setOperation(name: string, args: Value[], keep: boolean, same: SetCompare): PhpArray {
  checkSetArguments(name, args);
  const [first, ...others] = args as PhpArray[];
  const result = new PhpArray();
  for (const entry of first.entries()) {
    rt().spend();
    const inAll = others.every((other) => [...other.entries()].some((candidate) => same(entry, candidate)));
    const inAny = others.some((other) => [...other.entries()].some((candidate) => same(entry, candidate)));
    if (keep ? inAll : !inAny) result.set(entry[0], share(entry[1]));
  }
  return result;
}

export function checkSetArguments(name: string, arrays: Value[]): void {
  for (const [index, value] of arrays.entries()) {
    if (!(value instanceof PhpArray)) {
      throwError(
        'TypeError',
        `${name}(): Argument #${index + 1}${index === 0 ? ' ($array)' : ''} must be of type array, ${valueName(value)} given`
      );
    }
  }
}

const sameValue: SetCompare = (a, b) => toStr(a[1]) === toStr(b[1]);
const sameKey: SetCompare = (a, b) => a[0] === b[0];
const sameAssoc: SetCompare = (a, b) => a[0] === b[0] && toStr(a[1]) === toStr(b[1]);

defineFunction('array_diff(array $array, array ...$arrays): array', ({ args }) => {
  const [first, ...others] = args;
  checkSetArguments('array_diff', [first]);
  return diffByString(first as PhpArray, others);
});

/** Transcribes PHP's array_diff, which converts each value to a string once, so each conversion warns once. */
function diffByString(first: PhpArray, others: Value[]): PhpArray {
  if (first.size === 0) {
    checkSetArguments('array_diff', [first, ...others]);
    return new PhpArray();
  }
  if (first.size === 1) return diffSingle(first, others);
  checkSetArguments('array_diff', [first, ...others]);
  const exclude = new Set<string>();
  for (const other of others) for (const value of (other as PhpArray).values()) exclude.add(toStr(value));
  const result = new PhpArray();
  for (const [key, value] of first.entries()) if (!exclude.has(toStr(value))) result.set(key, share(value));
  return result;
}

function diffSingle(first: PhpArray, others: Value[]): PhpArray {
  const search = toStr(first.values()[0]);
  let found = false;
  for (const [index, other] of others.entries()) {
    checkSetArguments('array_diff', [first, ...others.slice(0, index + 1)]);
    found ||= (other as PhpArray).values().some((value) => toStr(value) === search);
  }
  if (found) return new PhpArray();
  first.shared = true;
  return first;
}
defineFunction('array_diff_key(array $array, array ...$arrays): array', ({ args }) =>
  setOperation('array_diff_key', args, false, sameKey)
);
defineFunction('array_diff_assoc(array $array, array ...$arrays): array', ({ args }) =>
  setOperation('array_diff_assoc', args, false, sameAssoc)
);
defineFunction('array_intersect(array $array, array ...$arrays): array', ({ args }) =>
  setOperation('array_intersect', args, true, sameValue)
);
defineFunction('array_intersect_key(array $array, array ...$arrays): array', ({ args }) =>
  setOperation('array_intersect_key', args, true, sameKey)
);
defineFunction('array_intersect_assoc(array $array, array ...$arrays): array', ({ args }) =>
  setOperation('array_intersect_assoc', args, true, sameAssoc)
);
defineFunction('array_find(array $array, callable $callback): mixed', ({ args }) => {
  for (const [key, value] of arr(args[0]).entries())
    if (conversionsModule.toBool(callCallback(args[1], [value, key]))) return value;
  return null;
});
defineFunction('array_find_key(array $array, callable $callback): mixed', ({ args }) => {
  for (const [key, value] of arr(args[0]).entries())
    if (conversionsModule.toBool(callCallback(args[1], [value, key]))) return key;
  return null;
});
defineFunction('array_any(array $array, callable $callback): bool', ({ args }) => {
  for (const [key, value] of arr(args[0]).entries())
    if (conversionsModule.toBool(callCallback(args[1], [value, key]))) return true;
  return false;
});
defineFunction('array_all(array $array, callable $callback): bool', ({ args }) => {
  for (const [key, value] of arr(args[0]).entries())
    if (!conversionsModule.toBool(callCallback(args[1], [value, key]))) return false;
  return true;
});
defineFunction('array_rand(array $array, int $num = 1): int|string|array', ({ args }) => {
  const array = arr(args[0]);
  const count = Number(args[1] ?? 1n);
  const keys = [...array.map.keys()];
  if (keys.length === 0) throwError('ValueError', 'array_rand(): Argument #1 ($array) must not be empty');
  const mt = rt().mt;
  if (count === 1) return keyValue(keys[Number(mt.range(0n, BigInt(keys.length - 1)))]);
  if (count <= 0 || count > keys.length) {
    throwError(
      'ValueError',
      'array_rand(): Argument #2 ($num) must be between 1 and the number of elements in argument #1 ($array)'
    );
  }
  let wanted = count;
  let negative = false;
  if (wanted > keys.length >> 1) {
    negative = true;
    wanted = keys.length - wanted;
  }
  const chosen = new Set<number>();
  while (chosen.size < wanted) chosen.add(Number(mt.range(0n, BigInt(keys.length - 1))));
  return PhpArray.list(keys.filter((_, index) => chosen.has(index) !== negative).map((key) => keyValue(key)));
});
defineFunction('shuffle(array &$array): true', (ctx) => {
  const array = writableArray(ctx, 0);
  const values = [...array.map.values()];
  const mt = rt().mt;
  for (let left = values.length - 1; left > 0; left--) {
    const index = Number(mt.range(0n, BigInt(left)));
    if (index !== left) [values[left], values[index]] = [values[index], values[left]];
  }
  const rebuilt = rebuild(
    values.map((value): [Key, Value | Ref] => [0n, value]),
    true
  );
  array.map = rebuilt.map;
  array.nextFree = rebuilt.nextFree;
  array.pointer = null;
  return true;
});

// Sorting ------------------------------------------------------------------------------------------------------------

/** The comparison a sort flag selects. */
function sortComparator(flags: bigint): (a: Value, b: Value) => number {
  const caseless = (flags & 8n) !== 0n;
  switch (flags & ~8n) {
    case 1n: {
      return (a, b) => compareNumbers(toFloat(a), toFloat(b));
    }
    case 2n:
    case 5n: {
      return caseless
        ? (a, b) => compareBytes(lower(toStr(a)), lower(toStr(b)))
        : (a, b) => compareBytes(toStr(a), toStr(b));
    }
    case 6n: {
      return (a, b) => naturalCompare(toStr(a), toStr(b), caseless);
    }
    default: {
      return compare;
    }
  }
}

/** Calls a user comparison as PHP's sorts do, accepting a bool result with a deprecation. */
function userComparator(name: string, callback: Value): (a: Value, b: Value) => number {
  const call = userComparisonCaller(name);
  return (a, b) => call(callback, a, b);
}

/** Calls user comparisons, accepting a bool result with one deprecation for all the calls through the caller. */
export function userComparisonCaller(name: string): (callback: Value, a: Value, b: Value) => number {
  let warned = false;
  return (callback, a, b) => {
    const result = callCallback(callback, [a, b]);
    if (typeof result === 'boolean') {
      if (!warned) {
        deprecated(
          `${name}(): Returning bool from comparison function is deprecated, return an integer less than, equal to, or greater than zero`
        );
        warned = true;
      }
      if (!result) return -comparisonSign(callCallback(callback, [b, a]));
    }
    return comparisonSign(result);
  };
}

/** The sign of a comparison callback's result, which PHP reads as an int: 0.5 counts as equal. */
export function comparisonSign(result: Value): number {
  const value = typeof result === 'number' ? Math.trunc(result) : Number(cast('int', result));
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

function sortArray(
  ctx: NativeContext,
  name: string,
  compareEntries: (a: [Key, Value | Ref], b: [Key, Value | Ref]) => number,
  renumber: boolean
): true {
  checkArrayRef(ctx, 0, name, 'array');
  const array = writableArray(ctx, 0);
  if (array.size <= 1 && !(renumber && array.size > 0)) return true;
  const entries = [...array.map].map((entry, position) => ({ entry, position }));
  rt().held.push(array);
  try {
    // PHP's sorts are stable: equal entries keep their order.
    zendSort(entries, (a, b) => {
      rt().spend();
      return compareEntries(a.entry, b.entry) || a.position - b.position;
    });
  } finally {
    rt().held.pop();
  }
  if (renumber) {
    const sorted = new PhpArray();
    for (const { entry } of entries) sorted.append(entry[1]);
    array.map = sorted.map;
    array.nextFree = sorted.nextFree;
  } else
    array.map = rebuild(
      entries.map(({ entry }) => entry),
      false
    ).map;
  array.pointer = null;
  return true;
}

const valueOf = (slot: Value | Ref): Value => (slot instanceof Ref ? slot.v : slot);

for (const [name, byKey, reverse, renumber] of [
  ['sort', false, false, true],
  ['rsort', false, true, true],
  ['asort', false, false, false],
  ['arsort', false, true, false],
  ['ksort', true, false, false],
  ['krsort', true, true, false],
] as const) {
  defineFunction(`${name}(array &$array, int $flags = SORT_REGULAR): true`, (ctx) => {
    const comparator = sortComparator((ctx.args[1] as bigint | undefined) ?? 0n);
    return sortArray(
      ctx,
      name,
      (a, b) => {
        const x = byKey ? keyValue(a[0]) : valueOf(a[1]);
        const y = byKey ? keyValue(b[0]) : valueOf(b[1]);
        return reverse ? -comparator(x, y) : comparator(x, y);
      },
      renumber
    );
  });
}
for (const [name, byKey, renumber] of [
  ['usort', false, true],
  ['uasort', false, false],
  ['uksort', true, false],
] as const) {
  defineFunction(`${name}(array &$array, callable $callback): true`, (ctx) => {
    const comparator = userComparator(name, ctx.args[1]);
    return sortArray(
      ctx,
      name,
      (a, b) => (byKey ? comparator(keyValue(a[0]), keyValue(b[0])) : comparator(valueOf(a[1]), valueOf(b[1]))),
      renumber
    );
  });
}
defineFunction('natsort(array &$array): true', (ctx) =>
  sortArray(ctx, 'natsort', (a, b) => naturalCompare(toStr(valueOf(a[1])), toStr(valueOf(b[1])), false), false)
);
defineFunction('natcasesort(array &$array): true', (ctx) =>
  sortArray(ctx, 'natcasesort', (a, b) => naturalCompare(toStr(valueOf(a[1])), toStr(valueOf(b[1])), true), false)
);
// code-gauge-allow functionCognitiveComplexity 18 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
// code-gauge-allow functionNcss 32 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
defineFunction('array_multisort(&~$array, &~...$rest): bool', (ctx) => {
  const columns: { ref: Ref; order: number; flags: bigint }[] = [];
  for (const [index, value] of ctx.args.entries()) {
    if (value instanceof PhpArray) {
      columns.push({ ref: ctx.refs[index] ?? new Ref(value), order: 1, flags: 0n });
    } else if (typeof value === 'bigint' && columns.length > 0) {
      const column = columns.at(-1) as (typeof columns)[number];
      if (value === 3n) column.order = -1;
      else if (value === 4n) column.order = 1;
      else column.flags = value;
    } else throwError('TypeError', `array_multisort(): Argument #${index + 1} must be an array or a sort flag`);
  }
  const size = (columns[0].ref.v as PhpArray).size;
  if (columns.some((column) => (column.ref.v as PhpArray).size !== size)) {
    throwError('ValueError', 'Array sizes are inconsistent');
  }
  const rows = columns.map((column) => [...(column.ref.v as PhpArray).map]);
  const order = Array.from({ length: size }, (_, index) => index);
  zendSort(order, (a, b) => {
    for (const [index, column] of columns.entries()) {
      const comparator = sortComparator(column.flags);
      const result = comparator(valueOf(rows[index][a][1]), valueOf(rows[index][b][1])) * column.order;
      if (result !== 0) return result;
    }
    return a - b;
  });
  for (const [index, column] of columns.entries()) {
    column.ref.v = rebuild(
      order.map((position) => rows[index][position]),
      true
    );
  }
  return true;
});

// The internal pointer -----------------------------------------------------------------------------------------------

defineFunction('current(array|object $array): mixed', ({ args }) =>
  withPointer(args[0], 'current', (array) => {
    const key = array.currentKey();
    return key === undefined ? false : (array.get(key) as Value);
  })
);
defineAlias('pos', 'current');
defineFunction('key(array|object $array): int|string|null', ({ args }) =>
  withPointer(args[0], 'key', (array) => {
    const key = array.currentKey();
    return key === undefined ? null : keyValue(key);
  })
);
defineFunction('next(array|object &$array): mixed', (ctx) =>
  withPointer(ctx.refs[0]?.v ?? ctx.args[0], 'next', (array) => {
    const key = array.currentKey();
    if (key === undefined) return false;
    array.pointer = array.keyAfter(key);
    return array.pointer === undefined ? false : (array.get(array.pointer) as Value);
  })
);
defineFunction('prev(array|object &$array): mixed', (ctx) =>
  withPointer(ctx.refs[0]?.v ?? ctx.args[0], 'prev', (array) => {
    const key = array.currentKey();
    if (key === undefined) return false;
    array.pointer = array.keyBefore(key);
    return array.pointer === undefined ? false : (array.get(array.pointer) as Value);
  })
);
defineFunction('reset(array|object &$array): mixed', (ctx) =>
  withPointer(ctx.refs[0]?.v ?? ctx.args[0], 'reset', (array) => {
    array.pointer = null;
    const key = array.currentKey();
    return key === undefined ? false : (array.get(key) as Value);
  })
);
defineFunction('end(array|object &$array): mixed', (ctx) =>
  withPointer(ctx.refs[0]?.v ?? ctx.args[0], 'end', (array) => {
    const last = [...array.map.keys()].at(-1);
    array.pointer = last;
    return last === undefined ? false : (array.get(last) as Value);
  })
);

/** The internal pointers of objects, which PHP keeps in the property table that the pointer functions walk. */
const objectPointers = new WeakMap<PhpObject, { pointer: Key | undefined | null }>();

/** Runs a pointer function on an array, or deprecatedly on an object's property table with the object's pointer. */
function withPointer(value: Value, name: string, action: (array: PhpArray) => Value): Value {
  if (value instanceof PhpArray) return action(value);
  if (!(value instanceof PhpObject))
    throwError('TypeError', `${name}(): Argument #1 ($array) must be of type array, ${valueName(value)} given`);
  deprecated(`${name}(): Calling ${name}() on an object is deprecated`);
  const table = objectToArray(value);
  const saved = objectPointers.get(value);
  table.pointer = saved ? saved.pointer : null;
  const result = action(table);
  objectPointers.set(value, { pointer: table.pointer });
  return result;
}
