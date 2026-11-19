// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { ArrayRebuild } from './arrayOrder';
import { type Comparisons, type Entry, setEntries, sortedSetEntries, SortedWalk } from './arraySetWalk';
import { lower, upper } from './bytes';
import { callCallback, callCallbackRefs, callMethod, consumeCallbackResult, consumeInvokedResult } from './callables';
import type { ArgValue } from './calls';
import { canAccessProp, declForKey, issetProp, lookupProp, readProp } from './classes';
import * as conversionsModule from './conversions';
import { compareBytes, compareNumbers, debugType, floatFitsInt, normalizeKeyString, valueName } from './conversions';
import { deprecated, throwError, warn, withCleanupExceptions } from './errors';
import { releaseDropped } from './garbage';
import { cast } from './interp';
import { naturalCompare } from './libString';
import { defineAlias, defineConstant, defineFunction, markDirectOnly, markInlined } from './native';
import {
  arithmetic,
  compare,
  looseEquals,
  strictEquals,
  toFloat,
  toInt,
  toKey,
  toStr,
  withStringConversionErrors,
} from './operators';
import { arrayIsShared, ElementPlace, share, VarPlace } from './places';
import { ExitSignal, PhpThrow, rt } from './runtime';
import { shuffle } from './shuffle';
import { checkedDynamicVariable } from './unsupported';
import {
  copyValueSlot,
  deref,
  INT_MAX,
  INT_MIN,
  type Key,
  type NativeContext,
  PhpArray,
  PhpObject,
  Ref,
  UNDEFINED_RESULT,
  UNINIT,
  type Value,
} from './values';
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
  return writableArrayRef(ctx.refs[index] as Ref);
}

function writableArrayRef(ref: Ref): PhpArray {
  let array = ref.v as PhpArray;
  if (arrayIsShared(array)) {
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

// code-gauge-allow functionCognitiveComplexity 24 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function rebuild(
  entries: [Key, Value | Ref][],
  renumber: boolean,
  target?: PhpArray,
  mutation?: ArrayRebuild
): PhpArray {
  const array = target ?? new PhpArray();
  if (target) {
    let position = 0n;
    function* renamed(): Generator<[Key, Value | Ref]> {
      let work = 0;
      for (const [key, slot] of entries) {
        const newKey = renumber && typeof key === 'bigint' ? position++ : key;
        if (++work % 64 === 0) rt().spend();
        yield [newKey, slot];
      }
    }
    array.replaceTable(renamed(), renumber, mutation, !renumber);
    return array;
  }
  for (const [key, source] of entries) {
    const slot = copyValueSlot(source);
    if (renumber && typeof key === 'bigint') array.append(slot);
    else if (slot instanceof Ref) array.setSlot(key, slot);
    else array.set(key, share(slot));
  }
  return array;
}

// Counting and access ------------------------------------------------------------------------------------------------

defineFunction('count(Countable|array $value, int $mode = COUNT_NORMAL): int', ({ args }) => {
  const [value, mode = 0n] = args;
  if (mode !== 0n && mode !== 1n)
    throwError('ValueError', 'count(): Argument #2 ($mode) must be either COUNT_NORMAL or COUNT_RECURSIVE');
  if (value instanceof PhpArray) return BigInt(mode === 1n ? countRecursive(value) : value.size);
  if (value instanceof PhpObject) {
    const countable = rt().classes.get('countable');
    if (countable && value.cls.isSubclassOf(countable)) {
      return toInt(callMethod(value, 'count', []));
    }
  }
  throwError('TypeError', `count(): Argument #1 ($value) must be of type Countable|array, ${valueName(value)} given`);
});
defineAlias('sizeof', 'count');
markInlined('count');
markInlined('sizeof');

function countRecursive(array: PhpArray): number {
  const active = new Set([array]);
  const pending = [{ array, values: array.iterValues() }];
  let count = array.size;
  while (pending.length > 0) {
    const item = pending.at(-1)!;
    const next = item.values.next();
    if (next.done) {
      active.delete(item.array);
      pending.pop();
      continue;
    }
    rt().spend();
    const value = next.value;
    if (!(value instanceof PhpArray)) continue;
    if (active.has(value)) {
      warn('count(): Recursion detected');
      continue;
    }
    active.add(value);
    count += value.size;
    pending.push({ array: value, values: value.iterValues() });
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
  return writableArray(ctx, 0).pop();
});
defineFunction('array_shift(array &$array): mixed', (ctx) => {
  checkArrayRef(ctx, 0, 'array_shift', 'array');
  const array = writableArray(ctx, 0);
  const shifted = array.shiftList() ?? array.shiftStringKey();
  if (shifted) return shifted.value;
  const first = array.map.keys().next();
  if (first.done) return null;
  const value = array.get(first.value) as Value;
  array.delete(first.value);
  rebuild([...array.map], true, array, 'shift');
  array.pointer = null;
  return value;
});
defineFunction('array_unshift(array &$array, mixed ...$values): int', (ctx) => {
  checkArrayRef(ctx, 0, 'array_unshift', 'array');
  const array = writableArray(ctx, 0);
  if (array.prependList(ctx.args.slice(1).map(share))) return BigInt(array.size);
  const entries: [Key, Value | Ref][] = [
    ...ctx.args.slice(1).map((value): [Key, Value] => [0n, share(value)]),
    ...array.map,
  ];
  rebuild(entries, true, array, { prepend: ctx.args.length - 1 });
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
  return first.done ? null : first.value;
});
defineFunction('array_key_last(array $array): int|string|null', ({ args }) => arr(args[0]).lastKey() ?? null);
defineFunction('array_first(array $array): mixed', ({ args }) => arr(args[0]).firstValue() ?? null);
defineFunction('array_last(array $array): mixed', ({ args }) => arr(args[0]).lastValue() ?? null);
defineFunction('array_keys(array $array, mixed $filter_value = UNKNOWN, bool $strict = false): array', ({ args }) => {
  const array = arr(args[0]);
  const keys = new PhpArray();
  if (args.length < 2 && array.map.countsUndefinedSlots && array.hasDensePackedStorage()) {
    for (let key = 0n; key < BigInt(array.size); key++) keys.append(key);
    return keys;
  }
  for (const [key, value] of array.entries()) {
    if (args.length >= 2) {
      const matches = args[2] === true ? strictEquals(value, args[1]) : looseEquals(value, args[1]);
      if (!matches) continue;
    }
    keys.append(key);
  }
  return keys;
});
defineFunction('array_values(array $array): array', ({ args }) => {
  const array = arr(args[0]);
  // PHP returns a list as it is, sharing it with its internal pointer.
  if (array.keepsValuesTable()) return share(array);
  return rebuild(
    Array.from(array.map, ([, slot]): [Key, Value | Ref] => [0n, slot]),
    true
  );
});
defineFunction('array_is_list(array $array): bool', ({ args }) => arr(args[0]).isList());
defineFunction('in_array(mixed $needle, array $haystack, bool $strict = false): bool', ({ args }) => {
  const [needle, haystack, strict] = args;
  for (const value of arr(haystack).iterValues()) {
    rt().spend();
    if (strict === true ? strictEquals(value, needle) : looseEquals(value, needle)) return true;
  }
  return false;
});
defineFunction('array_search(mixed $needle, array $haystack, bool $strict = false): int|string|false', ({ args }) => {
  const [needle, haystack, strict] = args;
  for (const [key, value] of arr(haystack).entries()) {
    rt().spend();
    if (strict === true ? strictEquals(value, needle) : looseEquals(value, needle)) return key;
  }
  return false;
});

// Building arrays ----------------------------------------------------------------------------------------------------

defineFunction('array_merge(array ...$arrays): array', ({ args }) => {
  const reused = mergeReuse(args);
  if (reused) return share(reused);
  const result = new PhpArray();
  for (const [index, value] of args.entries()) {
    if (!(value instanceof PhpArray))
      throwError('TypeError', `array_merge(): Argument #${index + 1} must be of type array, ${valueName(value)} given`);
    for (const [key, slot] of value.map) {
      const item = copyValueSlot(slot);
      if (typeof key === 'bigint') result.append(item);
      else result.setSlot(key, item);
    }
  }
  return result;
});
defineFunction('array_merge_recursive(array ...$arrays): array', ({ args }) => {
  const reused = mergeReuse(args);
  if (reused) return share(reused);
  const result = new PhpArray();
  const combination = new ArrayCombination('merge');
  for (const value of args) combination.run(result, arr(value));
  return result;
});

function mergeReuse(args: Value[]): PhpArray | undefined {
  if (args.length !== 2) return;
  const [left, right] = args;
  if (!(left instanceof PhpArray && right instanceof PhpArray)) return;
  const candidate = left.size === 0 ? right : right.size === 0 ? left : undefined;
  if (candidate?.keepsKeysWhenMerged()) return candidate;
}

interface CombinationFrame {
  target: PhpArray;
  source: PhpArray;
  entries: IterableIterator<[Key, Value | Ref]>;
  sourceOrigin: object;
  targetOrigin: object;
}

class ArrayCombination {
  private readonly frames: CombinationFrame[] = [];
  private readonly sources = new Set<object>();
  private readonly targets = new Set<object>();

  constructor(private readonly mode: 'merge' | 'replace') {}

  run(target: PhpArray, source: PhpArray): void {
    this.push(target, source, target, source);
    while (this.frames.length > 0) {
      rt().spend();
      const frame = this.frames.at(-1) as CombinationFrame;
      const next = frame.entries.next();
      if (next.done) {
        this.frames.pop();
        this.sources.delete(frame.sourceOrigin);
        this.targets.delete(frame.targetOrigin);
      } else this.combineSlot(frame.target, next.value[0], next.value[1]);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private combineSlot(target: PhpArray, key: Key, slot: Value | Ref): void {
    if (this.mode === 'merge' && typeof key === 'bigint') {
      target.append(copyValueSlot(slot));
      return;
    }
    const item = deref(slot);
    const existing = target.get(key);
    if (
      existing === undefined ||
      (this.mode === 'replace' && !(existing instanceof PhpArray && item instanceof PhpArray))
    ) {
      target.setSlot(key, copyValueSlot(slot));
      return;
    }
    if (this.mode === 'replace' && slot instanceof Ref && target.map.get(key) === slot)
      throwError('Error', 'Recursion detected');
    const composite = existing instanceof PhpArray || existing instanceof PhpObject;
    if (this.mode === 'merge' && composite && this.targets.has(existing)) throwError('Error', 'Recursion detected');
    const merged =
      existing instanceof PhpArray
        ? existing.copy()
        : existing instanceof PhpObject
          ? (cast('array', existing) as PhpArray)
          : PhpArray.list([existing]);
    target.setSlot(key, merged);
    const incoming = this.mode === 'merge' && item instanceof PhpObject ? (cast('array', item) as PhpArray) : item;
    if (incoming instanceof PhpArray) this.push(merged, incoming, composite ? existing : merged, item as object);
    else merged.append(incoming);
  }

  private push(target: PhpArray, source: PhpArray, targetOrigin: object, sourceOrigin: object): void {
    if (this.sources.has(sourceOrigin)) throwError('Error', 'Recursion detected');
    this.sources.add(sourceOrigin);
    this.targets.add(targetOrigin);
    this.frames.push({ target, source, entries: source.map.entries(), targetOrigin, sourceOrigin });
  }
}

defineFunction('array_replace(array $array, array ...$replacements): array', ({ args }) => {
  const result = arr(args[0]).copy();
  for (const replacement of args.slice(1))
    for (const [key, slot] of arr(replacement).map) result.setSlot(key, copyValueSlot(slot));
  return result;
});
defineFunction('array_replace_recursive(array $array, array ...$replacements): array', ({ args }) => {
  const result = arr(args[0]).copy();
  const combination = new ArrayCombination('replace');
  for (const replacement of args.slice(1)) combination.run(result, arr(replacement));
  return result;
});
defineFunction('array_combine(array $keys, array $values): array', ({ args }) => {
  const keys = arr(args[0]);
  const values = arr(args[1]);
  if (keys.size !== values.size) {
    throwError(
      'ValueError',
      'array_combine(): Argument #1 ($keys) and argument #2 ($values) must have the same number of elements'
    );
  }
  const result = new PhpArray();
  const slots = values.map.values();
  for (const key of keys.iterValues()) {
    const slot = slots.next();
    if (slot.done) break;
    result.setSlot(toKey(toStrKey(key)), copyValueSlot(slot.value));
  }
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
    result.set(toKey(value), key);
  }
  return result;
});
defineFunction('array_fill(int $start_index, int $count, mixed $value): array', ({ args }) => {
  const [start, count, value] = args as [bigint, bigint, Value];
  if (count < 0n) throwError('ValueError', 'array_fill(): Argument #2 ($count) must be greater than or equal to 0');
  if (count >= 2n ** 31n) throwError('ValueError', 'array_fill(): Argument #2 ($count) is too large');
  if (count > 0n && start + count - 1n > INT_MAX)
    throwError('Error', 'Cannot add element to the array as the next element is already occupied');
  rt().ensureRoom(Number(count));
  const result = new PhpArray();
  rt().spend(Number(count) / 16);
  for (let index = 0n; index < count; index++) result.set(start + index, share(value));
  return result;
});
defineFunction('array_fill_keys(array $keys, mixed $value): array', ({ args }) => {
  const result = new PhpArray();
  for (const key of arr(args[0]).iterValues()) result.set(toKey(toStrKey(key)), share(args[1]));
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
  // code-gauge-allow functionCognitiveComplexity 16 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  ({ args }) => {
    const frame = rt().frame;
    const result = new PhpArray();
    const active = new Set<PhpArray>();
    const visit = (value: Value, argument: number): void => {
      rt().spend();
      if (value instanceof PhpArray) {
        if (active.has(value)) throwError('Error', 'Recursion detected');
        active.add(value);
        for (const item of value.iterValues()) visit(item, argument);
        active.delete(value);
        return;
      }
      if (typeof value !== 'string') {
        warn(`compact(): Argument #${argument} must be string or array of strings, ${valueName(value)} given`);
        return;
      }
      const name = checkedDynamicVariable(value);
      const ref = frame.vars.get(name);
      if (name === 'this' && frame.thisObj) result.set('this', frame.thisObj);
      else if (ref?.isDefinedBinding) result.set(normalizeKeyString(name), share(ref.v));
      else warn(`compact(): Undefined variable $${name}`);
    };
    for (const [index, value] of args.entries()) visit(value, index + 1);
    return result;
  },
  true
);
defineFunction(
  'extract(array &~$array, int $flags = EXTR_OVERWRITE, string $prefix = UNKNOWN): int',
  // code-gauge-allow functionNcss 31 -- The extraction loop shares the source and bindings across modes.
  // code-gauge-allow functionCognitiveComplexity 17 -- The extraction loop shares the source and bindings across modes.
  ({ args, refs, dynamic }) => {
    const flags = (args[1] as bigint | undefined) ?? 0n;
    const mode = Number(flags & 0xffn);
    const prefix = args[2] as string | undefined;
    checkExtractArguments(mode, prefix);
    if (dynamic) throwError('Error', 'Cannot call extract() dynamically');
    const byReference = (flags & 256n) !== 0n;
    let array = (refs[0]?.v ?? args[0]) as PhpArray;
    if (byReference && arrayIsShared(array)) {
      array = array.copy();
      if (refs[0]) refs[0].v = array;
    }
    const runtime = rt();
    const frame = runtime.frame;
    const compiledNames = mode === 5 ? runtime.compiledNames(frame) : undefined;
    const exists = (name: string): boolean => frame.vars.get(name)?.isDefinedBinding === true;
    let count = 0n;
    for (const key of array.keys()) {
      const name =
        typeof key === 'string' && compiledNames?.has(key) && !exists(key)
          ? key
          : extractedName(key, mode, `${prefix ?? ''}_`, exists);
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

markDirectOnly('compact');

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
      for (const [key, value] of first.entries()) result.setSlot(key, callbackSlot(callback, [value]));
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
  const lists = [first, ...rest].map((value) => [...(value as PhpArray).map.values()]);
  const length = Math.max(...lists.map((list) => list.length));
  const result = new PhpArray();
  for (let index = 0; index < length; index++) {
    const items = lists.map((list) => (index < list.length ? list[index] : null));
    result.append(callback === null ? PhpArray.copySlots(items) : callbackSlot(callback, items.map(deref)));
  }
  return result;
});
function callbackSlot(callback: Value, args: Value[]): Value | Ref {
  const value = callCallback(callback, args);
  const ref = rt().lastReturnRef;
  rt().lastReturnRef = undefined;
  if (!ref) return value;
  ref.isRef = true;
  ref.rc++;
  return ref;
}

defineFunction('array_filter(array $array, ?callable $callback = null, int $mode = 0): array', ({ args }) => {
  const [array, callback = null, mode = 0n] = args;
  const result = new PhpArray();
  rt().held.push(array);
  try {
    for (const [key, value] of arr(array).entries()) {
      const keep =
        callback === null
          ? conversionsModule.toBool(value)
          : consumeCallbackResult(
              callback,
              mode === 2n ? [key] : mode === 1n ? [value, key] : [value],
              conversionsModule.toBool
            );
      if (keep) result.setSlot(key, copyValueSlot(arr(args[0]).map.get(key) as Value | Ref));
    }
  } finally {
    rt().held.pop();
  }
  return result;
});
defineFunction('array_reduce(array $array, callable $callback, mixed $initial = null): mixed', ({ args }) => {
  const runtime = rt();
  const holders = runtime.nativeHeld.at(-1)!;
  const slot = holders.length;
  let carry = args[2] ?? null;
  holders.push(null);
  for (const value of arr(args[0]).iterValues()) {
    carry = consumeCallbackResult(args[1], [carry, value], (next) => {
      const previous = holders[slot];
      holders[slot] = next;
      if (previous !== next && (previous instanceof PhpObject || previous instanceof PhpArray)) {
        runtime.release([previous], true);
        runtime.flushReleases();
      }
      return next;
    });
  }
  return carry;
});
for (const name of ['array_walk', 'array_walk_recursive']) {
  defineFunction(`${name}(array|object &$array, callable $callback, mixed $arg = UNKNOWN): true`, (ctx) => {
    walkValues(ctx.refs[0] as Ref, ctx, name === 'array_walk_recursive', new Set());
    return true;
  });
}

function walkValues(ref: Ref, ctx: NativeContext, recursive: boolean, active: Set<PhpArray | PhpObject>): void {
  let container = walkContainer(ref, active);
  active.add(container);
  let keys = walkKeys(container);
  try {
    for (;;) {
      const key = keys.next().value;
      if (key === undefined) return;
      rt().spend();
      visitWalkSlot(container, key, ctx, recursive, active);
      if (ref.v !== container) {
        keys.return(undefined);
        active.delete(container);
        container = walkContainer(ref, active);
        active.add(container);
        keys = walkKeys(container);
      }
    }
  } finally {
    keys.return(undefined);
    active.delete(container);
  }
}

function walkContainer(ref: Ref, active: Set<PhpArray | PhpObject>): PhpArray | PhpObject {
  const container = ref.v;
  if (!(container instanceof PhpArray || (container instanceof PhpObject && !container.isResource)))
    throwError('TypeError', 'Iterated value is no longer an array or object');
  if (active.has(container)) throwError('Error', 'Recursion detected');
  if (container instanceof PhpArray) {
    if (!arrayIsShared(container)) return container;
    const copy = container.copy();
    ref.v = copy;
    return copy;
  }
  return container;
}

function* walkKeys(container: PhpArray | PhpObject): Generator<Key, undefined> {
  if (container instanceof PhpArray) {
    const cursor = container.cursor();
    try {
      while (cursor.key !== undefined) {
        const key = cursor.key;
        cursor.next();
        yield key;
      }
    } finally {
      cursor.close();
    }
  } else yield* container.props.keys();
  return undefined;
}

function visitWalkSlot(
  container: PhpArray | PhpObject,
  key: Key,
  ctx: NativeContext,
  recursive: boolean,
  active: Set<PhpArray | PhpObject>
): void {
  const element = walkSlot(container, key);
  if (!element) return;
  const [ref, callbackKey] = element;
  if (recursive && ref.v instanceof PhpArray) {
    const runtime = rt();
    const frame = runtime.frame;
    const mark = frame.temporaries.length;
    runtime.holdTemporaryReference(ref);
    try {
      walkValues(ref, ctx, true, active);
    } finally {
      runtime.dropTemporaries(frame, mark);
    }
    return;
  }
  const args: ArgValue[] = [{ v: ref.v, ref }, { v: callbackKey }];
  if (ctx.args.length > 2) args.push({ v: ctx.args[2] });
  callCallbackRefs(ctx.args[1], args, true);
}

function walkSlot(container: PhpArray | PhpObject, key: Key): [Ref, Key] | undefined {
  if (container instanceof PhpArray) return [new ElementPlace(container, key).ref(), key];
  const name = key as string;
  const slot = container.props.get(name);
  if (slot === undefined || slot === UNINIT) return;
  const decl = declForKey(container.cls, name);
  const ref = slot instanceof Ref ? slot : new Ref(slot);
  if (decl?.type) ref.addTypeOwner(decl, container);
  container.props.set(name, ref);
  return [ref, decl?.visibility === 'protected' ? `\0*\0${decl.name}` : key];
}
defineFunction(
  'array_slice(array $array, int $offset, ?int $length = null, bool $preserve_keys = false): array',
  ({ args }) => {
    const array = arr(args[0]);
    const { start, end } = sliceBounds(
      array.size,
      Number(args[1]),
      args[2] === undefined || args[2] === null ? undefined : Number(args[2])
    );
    const positional = array.map.countsUndefinedSlots && array.hasDenseSlots();
    const entries = [...array.map];
    const sliced = positional
      ? entries.filter(([key]) => array.slotPosition(key) >= start).slice(0, end - start)
      : entries.slice(start, end);
    return rebuild(sliced, args[3] !== true || (start === 0 && positional && array.hasDensePackedStorage()));
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
    const { start, end } = sliceBounds(
      array.size,
      Number(ctx.args[1]),
      ctx.args[2] === undefined || ctx.args[2] === null ? undefined : Number(ctx.args[2])
    );
    const replacementValue = ctx.args[3];
    const replacement: [Key, Value | Ref][] =
      replacementValue === undefined
        ? []
        : [...(cast('array', replacementValue) as PhpArray).map.values()].map((value): [Key, Value | Ref] => [
            0n,
            value,
          ]);
    const inserted = replacement.map(([, slot]) => copyValueSlot(slot));
    const packedRemoved = array.spliceList(start, end - start, inserted);
    if (packedRemoved) return packedRemoved;
    const entries = [...array.map];
    const removed = rebuild(entries.slice(start, end), true);
    for (const [, slot] of entries.slice(start, end)) if (slot instanceof Ref) slot.rc--;
    rebuild(
      [...entries.slice(0, start), ...inserted.map((slot): [Key, Value | Ref] => [0n, slot]), ...entries.slice(end)],
      true,
      array,
      { start, end, inserted: inserted.length }
    );
    array.pointer = null;
    return removed;
  }
);
defineFunction('array_reverse(array $array, bool $preserve_keys = false): array', ({ args }) =>
  rebuild([...arr(args[0]).map].toReversed(), args[1] !== true)
);
defineFunction('array_unique(array $array, int $flags = SORT_STRING): array', ({ args }) => {
  const array = arr(args[0]);
  if (array.size <= 1) return share(array);
  const flags = (args[1] as bigint | undefined) ?? 2n;
  if (flags !== 2n) return uniqueSortedArray(array, flags);
  const result = new PhpArray();
  const strings = new Set<string>();
  for (const [key, value] of array.entries()) {
    rt().spend();
    const text = toStr(value);
    if (strings.has(text)) continue;
    strings.add(text);
    result.setSlot(key, copyValueSlot(array.map.get(key) as Value | Ref));
  }
  return result;
});

function uniqueSortedArray(array: PhpArray, flags: bigint): PhpArray {
  const result = array.copy();
  const entries = setEntries(array).map((entry, position) => ({ ...entry, position }));
  const runtime = rt();
  withStringConversionErrors((convert, reportWarning, hold, tryConvert) => {
    const compare = sortComparator(flags, convert, reportWarning, tryConvert);
    zendSort(entries, (a, b) => {
      runtime.spend();
      try {
        return compare(a.slot, b.slot);
      } catch (error) {
        hold(error);
        return 0;
      }
    });
    if (!runtime.nativeStringConversionPending) removeSortedDuplicates(entries, result, compare);
  });
  return result;
}

function removeSortedDuplicates(
  entries: (Entry & { position: number })[],
  result: PhpArray,
  compare: (a: Value | Ref, b: Value | Ref) => number
): void {
  let retained = entries[0];
  for (let index = 1; index < entries.length; index++) {
    rt().spend();
    const candidate = entries[index];
    if (compare(retained.slot, candidate.slot) !== 0) retained = candidate;
    else if (retained.position < candidate.position) result.delete(candidate.key);
    else {
      result.delete(retained.key);
      retained = candidate;
    }
  }
}
defineFunction('array_sum(array $array): int|float', ({ args }) => {
  let sum: Value = 0n;
  for (const value of arr(args[0]).iterValues()) sum = accumulate('array_sum', '+', 'Addition', sum, value);
  return sum;
});
defineFunction('array_product(array $array): int|float', ({ args }) => {
  let product: Value = 1n;
  for (const value of arr(args[0]).iterValues())
    product = accumulate('array_product', '*', 'Multiplication', product, value);
  return product;
});

function accumulate(name: string, op: string, word: string, total: Value, value: Value): Value {
  if (value instanceof PhpObject && value.isResource) {
    warn(`${name}(): ${word} is not supported on type resource`);
    return arithmetic(op, total, toInt(value));
  }
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
  'array_column(array $array, string|int|null $column_key, string|int|null $index_key = null): array',
  ({ args: [rows, column, index] }) => arrayColumn(arr(rows), column, index)
);

function arrayColumn(rows: PhpArray, column: Value, index: Value | undefined): PhpArray {
  const runtime = rt();
  const result = new PhpArray();
  runtime.held.push(result);
  try {
    for (const row of rows.iterValues()) addColumnRow(result, row, column, index);
  } catch (error) {
    runtime.held.pop();
    if (error instanceof PhpThrow || error instanceof ExitSignal)
      releaseDropped(runtime, [result], true, 'complete', error);
    throw error;
  }
  runtime.held.pop();
  return result;
}

function addColumnRow(result: PhpArray, row: Value, column: Value, index: Value | undefined): void {
  consumeInvokedResult(
    () => (column === null ? row : columnField(row, column)),
    (value) => {
      if (value === undefined) return;
      consumeInvokedResult(
        () => (index === null || index === undefined ? undefined : columnField(row, index)),
        (key) => {
          if (key === undefined) result.append(share(value));
          else result.set(toKey(key), share(value));
        }
      );
    },
    true
  );
}

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
  return exists || issetProp(row, name, scope, true) ? readProp(row, name, scope, 'native') : undefined;
}

defineFunction('array_chunk(array $array, int $length, bool $preserve_keys = false): array', ({ args }) => {
  const length = Number(args[1]);
  if (length < 1) throwError('ValueError', 'array_chunk(): Argument #2 ($length) must be greater than 0');
  const result = new PhpArray();
  let chunk: PhpArray | undefined;
  for (const key of arr(args[0]).keys()) {
    if (!chunk || chunk.size >= length) {
      chunk = new PhpArray();
      result.append(chunk);
    }
    if (args[2] === true) chunk.setSlot(key, copyValueSlot(arr(args[0]).map.get(key) as Value | Ref));
    else chunk.append(copyValueSlot(arr(args[0]).map.get(key) as Value | Ref));
  }
  return result;
});
defineFunction('array_count_values(array $array): array', ({ args }) => {
  const result = new PhpArray();
  for (const value of arr(args[0]).iterValues()) {
    if (typeof value !== 'bigint' && typeof value !== 'string') {
      warn('array_count_values(): Can only count string and integer values, entry skipped');
      continue;
    }
    const key = toKey(value);
    result.set(key, ((result.get(key) as bigint | undefined) ?? 0n) + 1n);
  }
  return result;
});

type SetCompare = (a: [Key, Value | Ref], b: [Key, Value | Ref]) => boolean;

// code-gauge-allow functionCognitiveComplexity 16 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function setOperation(name: string, args: Value[], keep: boolean, same: SetCompare): PhpArray {
  checkSetArguments(name, args);
  const [first, ...others] = args as PhpArray[];
  const result = new PhpArray();
  if (same === sameValue) {
    const comparisons: Comparisons = {
      data: compareSetValues,
      key: (a, b) => compareBytes(String(a.key), String(b.key)),
      useKey: () => {},
      useData: () => {},
    };
    const lists = [first, ...others].map((array) => {
      const list = sortedSetEntries(array);
      if (list.length > 1) zendSort(list, compareSetValues);
      return list;
    });
    const walk = new SortedWalk(lists, 'normal', comparisons);
    const copied = first.copy();
    for (const key of keep ? walk.intersect() : walk.diff()) copied.delete(key);
    return copied;
  }
  for (const entry of first.map) {
    rt().spend();
    const matches = (other: PhpArray): boolean => {
      const slot = other.getSlot(entry[0]);
      return slot !== undefined && same(entry, [entry[0], slot]);
    };
    if (keep ? others.every(matches) : !others.some(matches)) result.setSlot(entry[0], copyValueSlot(entry[1]));
  }
  return result;
}

export function checkSetArguments(name: string, arrays: Value[]): void {
  for (const [index, value] of arrays.entries()) checkSetArgument(name, value, index + 1);
}

export function checkSetArgument(name: string, value: Value, position: number): asserts value is PhpArray {
  if (!(value instanceof PhpArray)) {
    throwError(
      'TypeError',
      `${name}(): Argument #${position}${position === 1 ? ' ($array)' : ''} must be of type array, ${valueName(value)} given`
    );
  }
}

const sameValue: SetCompare = (a, b) => toStr(deref(a[1])) === toStr(deref(b[1]));
const sameKey: SetCompare = (a, b) => a[0] === b[0];
const sameAssoc: SetCompare = (a, b) => a[0] === b[0] && sameValue(a, b);

defineFunction('array_diff(array $array, array ...$arrays): array', ({ args }) => {
  const [first, ...others] = args;
  checkSetArgument('array_diff', first, 1);
  return diffByString(first, others);
});

/** Transcribes PHP's array_diff, which converts each value to a string once, so each conversion warns once. */
function diffByString(first: PhpArray, others: Value[]): PhpArray {
  if (first.size <= 1) {
    const value = first.firstValue();
    if (value !== undefined) return diffSingle(first, others, value);
    checkSetArguments('array_diff', [first, ...others]);
    return new PhpArray();
  }
  checkSetArguments('array_diff', [first, ...others]);
  if (others.every((other) => (other as PhpArray).size === 0)) {
    first.shared = true;
    return first;
  }
  const exclude = new Set<string>();
  for (const other of others) {
    for (const value of (other as PhpArray).iterValues()) {
      rt().spend();
      exclude.add(toStr(value));
    }
  }
  const result = new PhpArray();
  for (const [key, value] of first.entries()) {
    rt().spend();
    if (!exclude.has(toStr(value))) result.setSlot(key, copyValueSlot(first.map.get(key) as Value | Ref));
  }
  return result;
}

function diffSingle(first: PhpArray, others: Value[], value: Value): PhpArray {
  const search = toStr(value);
  let found = false;
  for (const [index, other] of others.entries()) {
    checkSetArgument('array_diff', other, index + 2);
    if (found) continue;
    for (const value of other.iterValues()) {
      rt().spend();
      if (toStr(value) !== search) continue;
      found = true;
      break;
    }
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
  for (const [key, slot] of arr(args[0]).map)
    if (consumeCallbackResult(args[1], [valueOf(slot), key], conversionsModule.toBool)) return valueOf(slot);
  return null;
});
defineFunction('array_find_key(array $array, callable $callback): mixed', ({ args }) => {
  for (const [key, value] of arr(args[0]).entries())
    if (consumeCallbackResult(args[1], [value, key], conversionsModule.toBool)) return key;
  return null;
});
defineFunction('array_any(array $array, callable $callback): bool', ({ args }) => {
  for (const [key, value] of arr(args[0]).entries())
    if (consumeCallbackResult(args[1], [value, key], conversionsModule.toBool)) return true;
  return false;
});
defineFunction('array_all(array $array, callable $callback): bool', ({ args }) => {
  for (const [key, value] of arr(args[0]).entries())
    if (!consumeCallbackResult(args[1], [value, key], conversionsModule.toBool)) return false;
  return true;
});
defineFunction('array_rand(array $array, int $num = 1): int|string|array', ({ args }) => {
  const array = arr(args[0]);
  const count = Number(args[1] ?? 1n);
  if (array.size === 0) throwError('ValueError', 'array_rand(): Argument #1 ($array) must not be empty');
  const runtime = rt();
  const mt = runtime.mt;
  if (count === 1) {
    runtime.spend(Math.ceil(array.size / 64));
    return array.sampleKey((max) => {
      runtime.spend();
      return Number(mt.range(0n, BigInt(max)));
    });
  }
  const keys = array.keys();
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
  return PhpArray.list(keys.filter((_, index) => chosen.has(index) !== negative));
});
defineFunction('shuffle(array &$array): true', (ctx) => {
  const array = writableArray(ctx, 0);
  const values = [...array.map.values()];
  const mt = rt().mt;
  shuffle(values, (end) => mt.range(0n, end));
  rebuild(
    values.map((value): [Key, Value | Ref] => [0n, value]),
    true,
    array
  );
  array.pointer = null;
  return true;
});

// Sorting ------------------------------------------------------------------------------------------------------------

/** The comparison a sort flag selects. */
function sortComparator(
  flags: bigint,
  convert = toStr,
  reportWarning = warn,
  tryConvert?: (value: Value) => string | undefined
): (a: Value | Ref, b: Value | Ref) => number {
  const caseless = (flags & 8n) !== 0n;
  switch (flags & ~8n) {
    case 1n: {
      return (a, b) => compareNumbers(toFloat(deref(a), reportWarning), toFloat(deref(b), reportWarning));
    }
    case 2n:
    case 5n: {
      return caseless
        ? (a, b) => compareBytes(lower(convert(deref(a))), lower(convert(deref(b))))
        : (a, b) => compareBytes(convert(deref(a)), convert(deref(b)));
    }
    case 6n: {
      return (a, b) => naturalCompare(convert(deref(a)), convert(deref(b)), caseless);
    }
    default: {
      return (a, b) => compare(a, b, tryConvert);
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
    const result = consumeComparisonResult(callback, [a, b], (value) =>
      typeof value === 'boolean' ? value : comparisonSign(value)
    );
    if (typeof result === 'boolean') {
      if (!warned) {
        deprecated(
          `${name}(): Returning bool from comparison function is deprecated, return an integer less than, equal to, or greater than zero`
        );
        warned = true;
      }
      if (!result) return -consumeComparisonResult(callback, [b, a], comparisonSign);
      return 1;
    }
    return result;
  };
}

export function consumeComparisonResult<T>(callback: Value, args: [Value, Value], consume: (value: Value) => T): T {
  if (!args.includes(UNDEFINED_RESULT)) return consumeCallbackResult(callback, args, consume);
  const supplied = args.map((value): ArgValue =>
    value === UNDEFINED_RESULT ? { v: null, omitted: true } : { v: value }
  );
  return consumeInvokedResult(() => callCallbackRefs(callback, supplied), consume);
}

/** The sign of a comparison callback's result, which PHP reads as an int: 0.5 counts as equal. */
export function comparisonSign(result: Value): number {
  const value = Number(cast('int', result));
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

function sortArray(
  ctx: NativeContext,
  name: string,
  {
    flags,
    byKey = false,
    reverse = false,
    renumber = false,
  }: {
    flags: bigint;
    byKey?: boolean;
    reverse?: boolean;
    renumber?: boolean;
  }
): true {
  checkArrayRef(ctx, 0, name, 'array');
  withStringConversionErrors((convert, reportWarning, hold, tryConvert) => {
    const compareValues = sortComparator(flags, convert, reportWarning, tryConvert);
    const compareEntries = (a: [Key, Value | Ref], b: [Key, Value | Ref]): number => {
      const x = byKey ? a[0] : a[1];
      const y = byKey ? b[0] : b[1];
      try {
        return reverse ? -compareValues(x, y) : compareValues(x, y);
      } catch (error) {
        hold(error);
        return 0;
      }
    };
    sortStorage(writableArray(ctx, 0), name, compareEntries, renumber);
  });
  return true;
}

function sortUserArray(
  ctx: NativeContext,
  name: string,
  compareEntries: (a: [Key, Value | Ref], b: [Key, Value | Ref]) => number,
  renumber: boolean
): true {
  checkArrayRef(ctx, 0, name, 'array');
  const reference = ctx.refs[0] as Ref;
  const original = arr(reference.v);
  if (original.size === 0) return true;
  const snapshot = original.copy();
  const runtime = rt();
  runtime.held.push(snapshot);
  try {
    withCleanupExceptions(runtime, (capture) => {
      let failed = false;
      sortStorage(
        snapshot,
        name,
        (a, b) => {
          if (failed) return 0;
          try {
            return compareEntries(a, b);
          } catch (error) {
            if (!(error instanceof PhpThrow)) throw error;
            failed = true;
            capture(error);
            return 0;
          }
        },
        renumber
      );
      reference.v = snapshot;
    });
    return true;
  } finally {
    runtime.held.pop();
  }
}

function sortStorage(
  array: PhpArray,
  name: string,
  compareEntries: (a: [Key, Value | Ref], b: [Key, Value | Ref]) => number,
  renumber: boolean
): true {
  if ((name === 'ksort' || name === 'krsort') && array.size <= 1) return true;
  array.prepareSort();
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
  rebuild(
    entries.map(({ entry }): [Key, Value | Ref] => [renumber ? 0n : entry[0], entry[1]]),
    renumber,
    array
  );
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
  defineFunction(`${name}(array &$array, int $flags = SORT_REGULAR): true`, (ctx) =>
    sortArray(ctx, name, { flags: (ctx.args[1] as bigint | undefined) ?? 0n, byKey, reverse, renumber })
  );
}
for (const [name, byKey, renumber] of [
  ['usort', false, true],
  ['uasort', false, false],
  ['uksort', true, false],
] as const) {
  defineFunction(`${name}(array &$array, callable $callback): true`, (ctx) => {
    const comparator = userComparator(name, ctx.args[1]);
    return sortUserArray(
      ctx,
      name,
      (a, b) => (byKey ? comparator(a[0], b[0]) : comparator(valueOf(a[1]), valueOf(b[1]))),
      renumber
    );
  });
}
defineFunction('natsort(array &$array): true', (ctx) => sortArray(ctx, 'natsort', { flags: 6n }));
defineFunction('natcasesort(array &$array): true', (ctx) => sortArray(ctx, 'natcasesort', { flags: 14n }));
defineFunction('array_multisort(&~$array, &~...$rest): bool', (ctx) => {
  const columns: { ref: Ref; order: number; flags: bigint; orderSet: boolean; modeSet: boolean }[] = [];
  for (const [index, value] of ctx.args.entries()) {
    if (value instanceof PhpArray) {
      columns.push({ ref: ctx.refs[index] ?? new Ref(value), order: 1, flags: 0n, orderSet: false, modeSet: false });
    } else if (typeof value === 'bigint') {
      setColumnFlag(columns.at(-1), value, index + 1);
    } else throwError('TypeError', `${multisortArgument(index + 1)} must be an array or a sort flag`);
  }
  const size = (columns[0].ref.v as PhpArray).size;
  if (columns.some((column) => (column.ref.v as PhpArray).size !== size)) {
    throwError('ValueError', 'Array sizes are inconsistent');
  }
  const rows = columns.map((column) => [...(column.ref.v as PhpArray).map]);
  const order = Array.from({ length: size }, (_, index) => index);
  zendSort(order, (a, b) => {
    rt().spend();
    for (const [index, column] of columns.entries()) {
      const comparator = sortComparator(column.flags);
      const result = comparator(rows[index][a][1], rows[index][b][1]) * column.order;
      if (result !== 0) return result;
    }
    return a - b;
  });
  for (const [index, column] of columns.entries()) {
    column.ref.v = rebuild(
      order.map((position) => rows[index][position]),
      true,
      writableArrayRef(column.ref)
    );
  }
  return true;
});

function setColumnFlag(
  column: { order: number; flags: bigint; orderSet: boolean; modeSet: boolean } | undefined,
  value: bigint,
  position: number
): void {
  const mode = value & ~8n;
  if (mode < 0n || mode > 6n) throwError('ValueError', `${multisortArgument(position)} must be a valid sort flag`);
  const order = mode === 3n || mode === 4n;
  if (!column || (order ? column.orderSet : column.modeSet))
    throwError(
      'TypeError',
      `${multisortArgument(position)} must be an array or a sort flag that has not already been specified`
    );
  if (order) {
    column.orderSet = true;
    column.order = value === 3n ? -1 : 1;
  } else {
    column.modeSet = true;
    column.flags = value;
  }
}

function multisortArgument(position: number): string {
  return `array_multisort(): Argument #${position}${position === 1 ? ' ($array)' : ''}`;
}

// The internal pointer -----------------------------------------------------------------------------------------------

defineFunction('current(array|object $array): mixed', ({ args }) =>
  withPointer(args[0], 'current', (array) => {
    const key = array.currentKey();
    return key === undefined ? false : (array.get(key) as Value);
  })
);
defineAlias('pos', 'current');
defineFunction('key(array|object $array): int|string|null', ({ args }) =>
  withPointer(args[0], 'key', (array) => array.currentKey() ?? null)
);
defineFunction('next(array|object &$array): mixed', (ctx) =>
  withPointer(pointerValue(ctx), 'next', (array) => {
    const key = array.currentKey();
    if (key === undefined) return false;
    array.pointer = array.keyAfter(key);
    return array.pointer === undefined ? false : (array.get(array.pointer) as Value);
  })
);
defineFunction('prev(array|object &$array): mixed', (ctx) =>
  withPointer(pointerValue(ctx), 'prev', (array) => {
    const key = array.currentKey();
    if (key === undefined) return false;
    array.pointer = array.keyBefore(key);
    return array.pointer === undefined ? false : (array.get(array.pointer) as Value);
  })
);
defineFunction('reset(array|object &$array): mixed', (ctx) =>
  withPointer(pointerValue(ctx), 'reset', (array) => {
    array.pointer = null;
    const key = array.currentKey();
    return key === undefined ? false : (array.get(key) as Value);
  })
);
defineFunction('end(array|object &$array): mixed', (ctx) =>
  withPointer(pointerValue(ctx), 'end', (array) => {
    const last = array.lastKey();
    array.pointer = last;
    return last === undefined ? false : (array.get(last) as Value);
  })
);

function pointerValue(ctx: NativeContext): Value {
  return ctx.refs[0]?.v instanceof PhpArray ? writableArray(ctx, 0) : (ctx.refs[0]?.v ?? ctx.args[0]);
}

/** Runs a pointer function on an array, or deprecatedly on an object's property table with the object's pointer. */
function withPointer(value: Value, name: string, action: (array: PhpArray) => Value): Value {
  if (value instanceof PhpArray) return action(value);
  if (!(value instanceof PhpObject))
    throwError('TypeError', `${name}(): Argument #1 ($array) must be of type array, ${valueName(value)} given`);
  deprecated(`${name}(): Calling ${name}() on an object is deprecated`);
  const table = new PhpArray();
  for (const [key, slot] of value.props) {
    if (slot !== UNINIT) table.setSlot(key, copyValueSlot(slot));
  }
  table.pointer = value.props.pointer;
  const result = action(table);
  value.props.pointer = table.currentKey() as string | undefined;
  if (name !== 'key' || typeof result !== 'string') return result;
  const decl = declForKey(value.cls, result);
  return decl?.visibility === 'protected' ? `\0*\0${decl.name}` : result;
}

function compareSetValues(a: Entry, b: Entry): number {
  rt().spend();
  return compareBytes(toStr(deref(a.slot)), toStr(deref(b.slot)));
}
