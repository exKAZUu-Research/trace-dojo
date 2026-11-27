import type { Span } from './ast';
// code-gauge-allow-file fileNcss -- Keeps type-directed arithmetic, comparison, and copying with their shared runtime hooks.
import { floatNumber } from './floatBits';
import { bigintToF32 } from './floatFormat';
import { normalize } from './infer';
import { RustPanic } from './runtime';
import { type AdtDef, intMax, intMin, type IntName, shallow, type Type } from './types';
import {
  BorrowGuard,
  CellBox,
  type ChannelEnd,
  DONE,
  type DurationValue,
  EnumValue,
  FnValue,
  isPlace,
  type IterValue,
  MapValue,
  NaNValue,
  RangeValue,
  SetValue,
  SharedBox,
  sliceItems,
  StructValue,
  textOf,
  type Value,
  WeakRef,
} from './values';

/** Hooks into the program's own impls, which the type-directed operations call for user types, and into its run. */
export interface UserImpls {
  /** Counts the elements a clone makes against the run's limit. */
  allocate(count: number): void;
  spend(count: number): void;
  copyScalarStorage(source: object, copy: object): void;
  withRoots<T>(values: Value[], use: () => T): T;
  eq?(method: 'eq' | 'ne', type: Type, a: Value, b: Value, rhs: Type): boolean | undefined;
  order?(method: OrderMethod, type: Type, a: Value, b: Value, rhs: Type): boolean | undefined;
  cmp?(type: Type, a: Value, b: Value, partial: boolean, rhs?: Type): { order: number | undefined } | undefined;
  clone?(type: Type, value: Value): { value: Value } | undefined;
  /** Substitutes a generic type's parameters with its arguments in a field's type. */
  fieldTypes(def: AdtDef, args: Type[], variant: number): Type[];
}

let hooks: UserImpls | undefined;

export function setUserImpls(implementations: UserImpls): () => void {
  const previous = hooks;
  hooks = implementations;
  return () => {
    hooks = previous;
  };
}

export function allocateCollectionSnapshot(size: number): void {
  hooks?.allocate(size);
  spendCollectionWork(size);
}

export function spendCollectionWork(count: number): void {
  hooks?.spend(count);
}

function fieldTypes(def: AdtDef, args: Type[], variant: number): Type[] {
  return hooks?.fieldTypes(def, args, variant) ?? def.variants[variant].fields.map((field) => field.type);
}

// ---------------------------------------------------------------------------------------------------------------------
// Integers

const OP_NAMES: Record<string, string> = {
  '+': 'add',
  '-': 'subtract',
  '*': 'multiply',
  '/': 'divide',
  '%': 'calculate the remainder',
  '<<': 'shift left',
  '>>': 'shift right',
  neg: 'negate',
};

export function overflow(op: string, span: Span): never {
  throw new RustPanic(`attempt to ${OP_NAMES[op]} with overflow`, span);
}

/** An arithmetic operation on integers of a type, panicking on overflow as a debug build does. */
// code-gauge-allow functionCognitiveComplexity -- One case per kind of type.
// code-gauge-allow functionNcss -- One case per kind of type.
export function intArith(op: string, name: IntName, a: bigint, b: bigint, span: Span): bigint {
  let result: bigint;
  switch (op) {
    case '+': {
      result = a + b;
      break;
    }
    case '-': {
      result = a - b;
      break;
    }
    case '*': {
      result = a * b;
      break;
    }
    case '/': {
      if (b === 0n) throw new RustPanic('attempt to divide by zero', span);
      if (a === intMin(name) && b === -1n && name.startsWith('i')) overflow('/', span);
      result = a / b;
      break;
    }
    case '%': {
      if (b === 0n) {
        throw new RustPanic('attempt to calculate the remainder with a divisor of zero', span);
      }
      if (a === intMin(name) && b === -1n && name.startsWith('i')) overflow('%', span);
      result = a % b;
      break;
    }
    case '&': {
      return wrap(name, a & b);
    }
    case '|': {
      return wrap(name, a | b);
    }
    case '^': {
      return wrap(name, a ^ b);
    }
    case '<<':
    case '>>': {
      const bits = BigInt(bitsOf(name));
      if (b < 0n || b >= bits) overflow(op, span);
      return op === '<<' ? wrap(name, a << b) : a >> b;
    }
    default: {
      throw new Error(`Unknown operator ${op}`);
    }
  }
  if (result < intMin(name) || result > intMax(name)) overflow(op, span);
  return result;
}

export function bitsOf(name: IntName): number {
  if (name === 'isize' || name === 'usize') return 64;
  return Number(name.slice(1));
}

/** Wraps an integer to a type's width, as `as` and the wrapping methods do. */
export function wrap(name: IntName, value: bigint): bigint {
  const bits = bitsOf(name);
  return name.startsWith('i') ? BigInt.asIntN(bits, value) : BigInt.asUintN(bits, value);
}

export function floatArith(op: string, a: number, b: number, f32: boolean): number {
  let result: number;
  switch (op) {
    case '+': {
      result = a + b;
      break;
    }
    case '-': {
      result = a - b;
      break;
    }
    case '*': {
      result = a * b;
      break;
    }
    case '/': {
      result = a / b;
      break;
    }
    case '%': {
      result = a % b;
      break;
    }
    default: {
      throw new Error(`Unknown operator ${op}`);
    }
  }
  return f32 ? Math.fround(result) : result;
}

/** `value as target`, with Rust's saturating float-to-int conversion and wrapping int conversions. */
export function castValue(value: Value, to: Type): Value {
  const target = normalize(shallow(to));
  if (target.kind === 'int') {
    const cast = castToInt(value, target.name);
    if (cast !== undefined) return cast;
  }
  if (target.kind === 'float') return castToFloat(value, target.name === 'f32');
  if (target.kind === 'char') return typeof value === 'bigint' ? String.fromCodePoint(Number(value)) : value;
  return value;
}

function castToFloat(value: Value, single: boolean): Value {
  if (typeof value === 'bigint') return single ? bigintToF32(value) : Number(value);
  if (value instanceof NaNValue && value.width === (single ? 32 : 64)) return value;
  const number = floatNumber(value);
  return single ? Math.fround(number) : number;
}

function castToInt(value: Value, name: IntName): Value | undefined {
  if (typeof value === 'bigint') return wrap(name, value);
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'string') return wrap(name, BigInt(value.codePointAt(0) ?? 0));
  if (typeof value === 'number' || value instanceof NaNValue) return saturatingFloatToInt(floatNumber(value), name);
  if (value instanceof EnumValue) return wrap(name, value.def.variants[value.variant].discriminant);
  return undefined;
}

function saturatingFloatToInt(value: number, name: IntName): bigint {
  if (Number.isNaN(value)) return 0n;
  const min = intMin(name);
  const max = intMax(name);
  if (value === Number.POSITIVE_INFINITY) return max;
  if (value === Number.NEGATIVE_INFINITY) return min;
  const truncated = BigInt(Math.trunc(value));
  return truncated < min ? min : truncated > max ? max : truncated;
}

// ---------------------------------------------------------------------------------------------------------------------
// Equality, ordering, hashing, cloning

/** Strips references from a type, as comparisons of references compare what they refer to. */
function derefType(type: Type): Type {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  return t;
}

function deref(value: Value): Value {
  let current = value;
  while (isPlace(current)) current = current.get();
  return current;
}

/** Whether two values are equal, as `PartialEq<Rhs>` for the type of `a` says, where `Rhs` is `a`'s type by default. */
export function valuesEqual(type: Type, a: Value, b: Value, rhs: Type = type): boolean {
  const t = derefType(type);
  const x = deref(a);
  const y = deref(b);
  const right = derefType(rhs);
  if (t.kind === 'adt' || right.kind === 'adt') {
    const user = hooks?.eq?.('eq', t, x, y, right);
    if (user !== undefined) return user;
  }
  switch (t.kind) {
    case 'float': {
      return floatNumber(x) === floatNumber(y);
    }
    case 'int':
    case 'bool':
    case 'char': {
      return x === y;
    }
    case 'str': {
      return textOf(x) === textOf(y);
    }
    case 'tuple': {
      return t.elems.every((elem, index) => valuesEqual(elem, (x as Value[])[index], (y as Value[])[index]));
    }
    case 'array':
    case 'slice': {
      return compareSequence(t.elem, x, y, right);
    }
    case 'adt': {
      return adtEqual(t, x, y, right);
    }
    case 'dyn': {
      return x === y;
    }
    default: {
      return x === y;
    }
  }
}

export function valuesUnequal(type: Type, a: Value, b: Value, rhs: Type = type): boolean {
  const t = derefType(type);
  const right = derefType(rhs);
  const leftValue = deref(a);
  const rightValue = deref(b);
  if (t.kind === 'adt' || right.kind === 'adt') {
    const user = hooks?.eq?.('ne', t, leftValue, rightValue, right);
    if (user !== undefined) return user;
    if (t.kind === 'adt' && t.def.builtin === 'Box' && right.kind === 'adt' && right.def.builtin === 'Box') {
      return valuesUnequal(t.args[0], leftValue, rightValue, right.args[0]);
    }
  }
  if (t.kind === 'array' || t.kind === 'slice') return compareSequence(t.elem, leftValue, rightValue, right, 'ne');
  if (t.kind === 'adt' && (t.def.builtin === 'Vec' || t.def.builtin === 'VecDeque')) {
    return compareSequence(t.args[0], leftValue, rightValue, right, 'ne');
  }
  if (t.kind === 'tuple' && right.kind === 'tuple') {
    return t.elems.some((elem, index) =>
      valuesUnequal(elem, (leftValue as Value[])[index], (rightValue as Value[])[index], right.elems[index])
    );
  }
  return !valuesEqual(t, leftValue, rightValue, right);
}

// code-gauge-allow functionNcss -- One case per kind of type.
function adtEqual(t: Type & { kind: 'adt' }, x: Value, y: Value, rhs: Type): boolean {
  const { def } = t;
  switch (def.builtin) {
    case 'String': {
      return textOf(x) === textOf(y);
    }
    case 'ParseIntError':
    case 'ParseFloatError':
    case 'ParseCharError':
    case 'TryFromIntError': {
      // Errors keep their kind in a field that their declarations do not show.
      return (x as StructValue).fields[0] === (y as StructValue).fields[0];
    }
    case 'Vec':
    case 'VecDeque': {
      return compareSequence(t.args[0], x, y, rhs);
    }
    case 'Rc':
    case 'Arc':
    case 'RefCell':
    case 'Cell': {
      return valuesEqual(t.args[0], pointee(x), pointee(y));
    }
    case 'OsStr': {
      return textOf(x) === textOf(y);
    }
    case 'CStr': {
      const a = x as bigint[];
      const b = y as bigint[];
      return a.length === b.length && a.every((byte, index) => byte === b[index]);
    }
    case 'Duration': {
      return (x as DurationValue).nanos === (y as DurationValue).nanos;
    }
    case 'Box':
    case 'Reverse': {
      if (def.builtin === 'Reverse')
        return valuesEqual(t.args[0], (x as StructValue).fields[0], (y as StructValue).fields[0]);
      return valuesEqual(t.args[0], x, y);
    }
    case 'HashMap':
    case 'BTreeMap': {
      const xm = x as MapValue;
      const ym = y as MapValue;
      if (xm.entries.size !== ym.entries.size) return false;
      return mapsEqual(t.args, xm, ym);
    }
    case 'HashSet':
    case 'BTreeSet': {
      const xs = x as SetValue;
      const ys = y as SetValue;
      if (xs.entries.size !== ys.entries.size) return false;
      return setsEqual(t.args[0], xs, ys);
    }
    case 'Range':
    case 'RangeInclusive':
    case 'RangeFrom':
    case 'RangeTo':
    case 'RangeToInclusive':
    case 'RangeFull': {
      return rangesEqual(t.args[0], x as RangeValue, y as RangeValue);
    }
    default: {
      return fieldsEqual(t, x, y);
    }
  }
}

function rangesEqual(elem: Type, x: RangeValue, y: RangeValue): boolean {
  const bound = (a: Value | undefined, b: Value | undefined): boolean =>
    a === undefined || b === undefined ? a === b : valuesEqual(elem, a, b);
  return bound(x.start, y.start) && bound(x.end, y.end) && x.exhausted === y.exhausted;
}

/** Whether two values of a struct or an enum have equal fields, as `#[derive(PartialEq)]` compares them. */
function fieldsEqual(t: Type & { kind: 'adt' }, x: Value, y: Value): boolean {
  if (x instanceof StructValue && y instanceof StructValue) {
    const types = fieldTypes(t.def, t.args, 0);
    return types.every((type, index) => valuesEqual(type, x.fields[index], y.fields[index]));
  }
  if (x instanceof EnumValue && y instanceof EnumValue) {
    if (x.variant !== y.variant) return false;
    const types = fieldTypes(t.def, t.args, x.variant);
    return types.every((type, index) => valuesEqual(type, x.fields[index], y.fields[index]));
  }
  return x === y;
}

function compareSequence(elem: Type, left: Value, right: Value, rhs: Type, method: 'eq' | 'ne' = 'eq'): boolean {
  const xs = sliceItems(left);
  const ys = sliceItems(right);
  const unequal = method === 'ne';
  if (xs.length !== ys.length) return unequal;
  const other = rhs.kind === 'array' || rhs.kind === 'slice' ? rhs.elem : rhs.kind === 'adt' ? rhs.args[0] : elem;
  const compare = unequal ? valuesUnequal : valuesEqual;
  for (const [index, item] of xs.entries()) {
    if (compare(elem, item, ys[index], other) === unequal) return unequal;
  }
  return !unequal;
}

function mapsEqual([keyType, valueType]: Type[], left: MapValue, right: MapValue): boolean {
  const items = [...left.entries.values()];
  if (left.sorted) {
    const counterparts = [...right.entries.values()];
    return items.every(([key, value], index) => {
      const [otherKey, otherValue] = counterparts[index];
      return valuesEqual(keyType, key, otherKey) && valuesEqual(valueType, value, otherValue);
    });
  }
  return items.every(([key, value]) => {
    const other = right.entries.get(right.entries.key(keyType, key));
    return other !== undefined && valuesEqual(valueType, value, other[1]);
  });
}

function setsEqual(type: Type, left: SetValue, right: SetValue): boolean {
  const items = [...left.entries.values()];
  if (left.sorted) {
    const other = [...right.entries.values()];
    return items.every((item, index) => valuesEqual(type, item, other[index]));
  }
  return items.every((item) => right.entries.has(right.entries.key(type, item)));
}

export type OrderMethod = 'lt' | 'le' | 'gt' | 'ge';

const orderTests: Record<OrderMethod, (order: number) => boolean> = {
  lt: (order) => order < 0,
  le: (order) => order <= 0,
  gt: (order) => order > 0,
  ge: (order) => order >= 0,
};

export function testPartialOrder(method: OrderMethod, type: Type, a: Value, b: Value, rhs = type): boolean {
  const t = derefType(type);
  const right = derefType(rhs);
  if (t.kind === 'adt' || right.kind === 'adt') {
    const user = hooks?.order?.(method, t, deref(a), deref(b), right);
    if (user !== undefined) return user;
  }
  if (t.kind === 'adt' && t.def.builtin === 'Reverse' && right.kind === 'adt' && right.def.builtin === 'Reverse') {
    const x = deref(a) as StructValue;
    const y = deref(b) as StructValue;
    return testPartialOrder(method, right.args[0], y.fields[0], x.fields[0], t.args[0]);
  }
  const order = comparePartialValues(t, a, b, rhs);
  return order !== undefined && orderTests[method](order);
}

function partialFloatOrder(a: number, b: number): number | undefined {
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Compares two values of a type, as `Ord::cmp` and `PartialOrd::partial_cmp` do; NaN compares as `undefined`. */
// code-gauge-allow functionCognitiveComplexity -- One case per kind of type.
// code-gauge-allow functionNcss -- One case per kind of type.
export function compareValues(type: Type, a: Value, b: Value, partial = false, rhs = type): number | undefined {
  const t = derefType(type);
  const x = deref(a);
  const y = deref(b);
  const right = partial ? derefType(rhs) : undefined;
  if (t.kind === 'adt' || right?.kind === 'adt') {
    const user = hooks?.cmp?.(t, x, y, partial, right);
    if (user) return user.order;
  }
  switch (t.kind) {
    case 'int': {
      return x === y ? 0 : (x as bigint) < (y as bigint) ? -1 : 1;
    }
    case 'float': {
      return partialFloatOrder(floatNumber(x), floatNumber(y));
    }
    case 'bool': {
      return Number(x) - Number(y);
    }
    case 'char': {
      return Math.sign((x as string).codePointAt(0)! - (y as string).codePointAt(0)!);
    }
    case 'str': {
      return compareStrings(textOf(x), textOf(y));
    }
    case 'tuple': {
      for (const [index, elem] of t.elems.entries()) {
        const order = compareValues(elem, (x as Value[])[index], (y as Value[])[index], partial);
        if (order !== 0) return order;
      }
      return 0;
    }
    case 'array':
    case 'slice': {
      return compareSequences(t.elem, sliceItems(x), sliceItems(y), partial);
    }
    case 'adt': {
      return compareAdt(t, x, y, partial);
    }
    default: {
      return 0;
    }
  }
}

export function comparePartialValues(type: Type, a: Value, b: Value, rhs = type): number | undefined {
  return compareValues(type, a, b, true, rhs);
}

// code-gauge-allow functionNcss -- One case per kind of type.
function compareAdt(t: Type & { kind: 'adt' }, x: Value, y: Value, partial: boolean): number | undefined {
  const { def } = t;
  switch (def.builtin) {
    case 'String': {
      return compareStrings(textOf(x), textOf(y));
    }
    case 'Vec':
    case 'VecDeque': {
      return compareSequences(t.args[0], x as Value[], y as Value[], partial);
    }
    case 'Box': {
      return compareValues(t.args[0], x, y, partial);
    }
    case 'Rc':
    case 'Arc':
    case 'RefCell':
    case 'Cell': {
      return compareValues(t.args[0], pointee(x), pointee(y), partial);
    }
    case 'CStr': {
      return compareBytes(x as bigint[], y as bigint[]);
    }
    case 'OsStr': {
      return textOf(x) < textOf(y) ? -1 : textOf(x) > textOf(y) ? 1 : 0;
    }
    case 'Duration': {
      const a = (x as DurationValue).nanos;
      const b = (y as DurationValue).nanos;
      return a < b ? -1 : a > b ? 1 : 0;
    }
    case 'Reverse': {
      return compareValues(t.args[0], (y as StructValue).fields[0], (x as StructValue).fields[0], partial);
    }
    case 'BTreeSet': {
      return compareOrderedEntries(t.args[0], x as SetValue, y as SetValue, partial);
    }
    case 'BTreeMap': {
      return compareOrderedEntries({ kind: 'tuple', elems: t.args }, x as MapValue, y as MapValue, partial);
    }
    case 'Ordering': {
      return Math.sign((x as EnumValue).variant - (y as EnumValue).variant);
    }
    default: {
      return compareFields(t, x, y, partial);
    }
  }
}

/** The order of two values of a struct or an enum, as `#[derive(PartialOrd)]` compares them: variant, then fields. */
function compareFields(t: Type & { kind: 'adt' }, x: Value, y: Value, partial: boolean): number | undefined {
  const { def } = t;
  if (x instanceof EnumValue && y instanceof EnumValue && x.variant !== y.variant) {
    return def.variants[x.variant].discriminant < def.variants[y.variant].discriminant ? -1 : 1;
  }
  const bothStructs = x instanceof StructValue && y instanceof StructValue;
  const bothEnums = x instanceof EnumValue && y instanceof EnumValue;
  if (!bothStructs && !bothEnums) return 0;
  const [xs, ys] = [x as StructValue | EnumValue, y as StructValue | EnumValue];
  const types = fieldTypes(def, t.args, xs instanceof EnumValue ? xs.variant : 0);
  for (const [index, type] of types.entries()) {
    const order = compareValues(type, xs.fields[index], ys.fields[index], partial);
    if (order !== 0) return order;
  }
  return 0;
}

function compareOrderedEntries(
  type: Type,
  left: MapValue | SetValue,
  right: MapValue | SetValue,
  partial: boolean
): number | undefined {
  const a = left.entries.values();
  const b = right.entries.values();
  const length = Math.min(left.entries.size, right.entries.size);
  for (let index = 0; index < length; index++) {
    spendCollectionWork(1);
    const order = compareValues(type, a.next().value, b.next().value, partial);
    if (order !== 0) return order;
  }
  return Math.sign(left.entries.size - right.entries.size);
}

function compareSequences(elem: Type, xs: Value[], ys: Value[], partial: boolean): number | undefined {
  const length = Math.min(xs.length, ys.length);
  for (let index = 0; index < length; index++) {
    const order = compareValues(elem, xs[index], ys[index], partial);
    if (order !== 0) return order;
  }
  return Math.sign(xs.length - ys.length);
}

/** Compares strings as Rust does, by their UTF-8 bytes, which is their code points' order. */
export function compareStrings(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  let index = 0;
  // Read at a code unit, a code point includes its low surrogate, so the scan stops where a code point starts.
  while (index < length && a.codePointAt(index) === b.codePointAt(index)) index++;
  spendCollectionWork(Math.ceil(index / 64));
  if (index === length) return Math.sign(a.length - b.length);
  return a.codePointAt(index)! < b.codePointAt(index)! ? -1 : 1;
}

/** A text that equal values of a type share and unequal ones do not, which keys maps and sets. */
// code-gauge-allow functionNcss -- One case per kind of type.
export function hashKey(type: Type, value: Value): string {
  const t = derefType(type);
  const x = deref(value);
  switch (t.kind) {
    case 'bool':
    case 'int': {
      return String(x);
    }
    case 'char':
    case 'str': {
      return encodeStringKey(textOf(x));
    }
    case 'float': {
      return `f${floatNumber(x)}`;
    }
    case 'tuple': {
      return `(${t.elems.map((elem, index) => hashKey(elem, (x as Value[])[index])).join(',')})`;
    }
    case 'array':
    case 'slice': {
      return `[${sliceItems(x)
        .map((item) => hashKey(t.elem, item))
        .join(',')}]`;
    }
    case 'adt': {
      const { def } = t;
      if (def.builtin === 'String') return encodeStringKey(textOf(x));
      if (def.builtin === 'Vec' || def.builtin === 'VecDeque') {
        // A key looked up by a slice (`Borrow<[T]>`) hashes as the `Vec` it equals.
        return `[${sliceItems(x)
          .map((item) => hashKey(t.args[0], item))
          .join(',')}]`;
      }
      if (def.builtin === 'Box') return hashKey(t.args[0], x);
      if (x instanceof StructValue) {
        const types = fieldTypes(def, t.args, 0);
        return `{${types.map((type, index) => hashKey(type, x.fields[index])).join(',')}}`;
      }
      if (x instanceof EnumValue) {
        const types = fieldTypes(def, t.args, x.variant);
        return `${x.variant}{${types.map((type, index) => hashKey(type, x.fields[index])).join(',')}}`;
      }
      return String(x);
    }
    default: {
      return String(x);
    }
  }
}

function encodeStringKey(value: string): string {
  return `${value.length}:${value}`;
}

/**
 * What the program's own `clone`s have returned for the clone in progress. Only the unfinished copy holds them, so they
 * stay rooted while the later `clone`s run.
 */
let cloneResults: Value[] | undefined;

/** Runs clones that build one value, keeping what the program's own `clone`s return alive until it is built. */
export function withCloneResults<T>(build: () => T): T {
  if (cloneResults || !hooks) return build();
  const results: Value[] = [];
  cloneResults = results;
  try {
    return hooks.withRoots([results], build);
  } finally {
    cloneResults = undefined;
  }
}

/** A deep copy of a value as `Clone::clone` makes it, calling the program's own `clone` for its types. */
export function cloneValue(type: Type, value: Value): Value {
  return cloneResults || !hooks ? clonePart(type, value) : withCloneResults(() => clonePart(type, value));
}

/** The program's own `clone` of a value, whose body builds values of its own. */
function userClone(type: Type, value: Value): { value: Value } | undefined {
  const building = cloneResults;
  cloneResults = undefined;
  try {
    const user = hooks?.clone?.(type, value);
    if (user) building?.push(user.value);
    return user;
  } finally {
    cloneResults = building;
  }
}

function clonePart(type: Type, value: Value): Value {
  const t = normalize(shallow(type));
  if (t.kind === 'ref') return value;
  if (t.kind === 'adt') {
    const user = userClone(t, value);
    if (user) return user.value;
  }
  switch (t.kind) {
    case 'tuple': {
      hooks?.allocate(t.elems.length);
      return t.elems.map((elem, index) => clonePart(elem, (value as Value[])[index]));
    }
    case 'closure': {
      const fn = value as FnValue;
      return fn.duplicate?.((item, type) => clonePart(type, item)) ?? fn;
    }
    case 'array':
    case 'slice': {
      const items = sliceItems(value);
      return cloneItems(items, (item) => clonePart(t.elem, item));
    }
    case 'adt': {
      return cloneAdt(t, value);
    }
    default: {
      return value;
    }
  }
}

// code-gauge-allow functionNcss -- One case per kind of owning type.
function cloneAdt(t: Type & { kind: 'adt' }, value: Value): Value {
  const { def } = t;
  switch (def.builtin) {
    case 'String': {
      return textOf(value);
    }
    case 'Vec':
    case 'VecDeque':
    case 'BinaryHeap': {
      return cloneItems(value as Value[], (item) => clonePart(t.args[0], item));
    }
    case 'Box': {
      return clonePart(t.args[0], value);
    }
    case 'Rc':
    case 'Arc':
    case 'Weak':
    case 'RefCell':
    case 'Cell': {
      return cloneShared(t, derefAll(value));
    }
    case 'Sender': {
      const channel = derefAll(value) as ChannelEnd;
      channel.senders++;
      return channel;
    }
    case 'HashMap':
    case 'BTreeMap':
    case 'HashSet':
    case 'BTreeSet': {
      return cloneCollection(t.args, value as MapValue | SetValue);
    }
    case 'Range':
    case 'RangeInclusive':
    case 'RangeFrom':
    case 'RangeTo':
    case 'RangeToInclusive': {
      return copyRange(value as RangeValue, (item) => clonePart(t.args[0], item));
    }
    case 'Iter': {
      return cloneIterator(value as IterValue);
    }
    default: {
      return cloneFields(t, value);
    }
  }
}

/** A clone of an `Rc` or an `Arc` (one more count), of a `Weak` (one more weak count), or of a cell's value. */
function cloneShared(t: Type & { kind: 'adt' }, target: Value): Value {
  if (t.def.builtin === 'Rc' || t.def.builtin === 'Arc') {
    const box = target as SharedBox;
    box.strong++;
    return box;
  }
  if (t.def.builtin === 'Weak') {
    const { box } = target as WeakRef;
    if (box) box.weak++;
    return new WeakRef(box);
  }
  return new CellBox(clonePart(t.args[0], (target as CellBox).value));
}

/** A clone of a struct's or an enum's value, field by field, as `#[derive(Clone)]` makes it. */
function cloneFields(t: Type & { kind: 'adt' }, value: Value): Value {
  const { def } = t;
  if (value instanceof StructValue) {
    const types = fieldTypes(def, t.args, 0);
    hooks?.allocate(types.length);
    return new StructValue(
      def,
      types.map((type, index) => clonePart(type, value.fields[index]))
    );
  }
  if (value instanceof EnumValue) {
    const types = fieldTypes(def, t.args, value.variant);
    hooks?.allocate(types.length);
    return new EnumValue(
      def,
      value.variant,
      types.map((type, index) => clonePart(type, value.fields[index]))
    );
  }
  return value;
}

/** A clone of an iterator, which goes on from where the iterator is, on its own. */
export function cloneIterator(iter: IterValue): IterValue {
  if (!iter.fork) return iter;
  const copy = iter.fork();
  const type = iter.peekedType;
  if (type && iter.peeked) {
    copy.peekedType = type;
    copy.peeked = iter.peeked.map((next) => (next === DONE ? DONE : cloneValue(type, next)));
  }
  return copy;
}

/** Whether copying a value of a `Copy` type must duplicate it, as aggregates the program can mutate in place must. */
export function needsCopy(type: Type): boolean {
  const t = normalize(shallow(type));
  if (t.kind === 'tuple') return t.elems.length > 0;
  if (t.kind === 'array') return true;
  // A closure that captures by value copies what it captures.
  if (t.kind === 'closure') return t.closure.captures?.some((capture) => capture.mode === 'value') ?? false;
  if (t.kind === 'adt')
    return (
      !t.def.builtin || ['Bound', 'Option', 'RangeTo', 'RangeToInclusive', 'Result', 'Reverse'].includes(t.def.builtin)
    );
  return false;
}

/** A copy of a value of a `Copy` type, which shares nothing mutable with the original. */
export function copyValue(value: Value): Value {
  if (Array.isArray(value)) return value.length === 0 ? value : cloneItems(value, copyValue);
  if (value instanceof FnValue) return value.duplicate?.(copyValue) ?? value;
  if (value instanceof RangeValue) return copyRange(value, copyValue);
  if (value instanceof StructValue) return new StructValue(value.def, cloneItems(value.fields, copyValue));
  if (value instanceof EnumValue) {
    return value.fields.length === 0
      ? value
      : new EnumValue(value.def, value.variant, cloneItems(value.fields, copyValue));
  }
  return value;
}

function copyRange(range: RangeValue, copy: (item: Value) => Value): RangeValue {
  const { end, inclusive, exhausted } = range;
  const start = range.start === undefined ? undefined : copy(range.start);
  const finish = (): RangeValue =>
    new RangeValue(start, end === undefined ? undefined : copy(end), inclusive, exhausted);
  return hooks ? hooks.withRoots([start], finish) : finish();
}

function cloneItems(items: Value[], clone: (value: Value) => Value): Value[] {
  hooks?.allocate(items.length);
  const copy = items.map(clone);
  hooks?.copyScalarStorage(items, copy);
  return copy;
}

/** A clone of a map or a set, with its table's size, of keys (and values) of the types `args`. */
function cloneCollection(args: Type[], source: MapValue | SetValue): MapValue | SetValue {
  if (source instanceof MapValue) {
    hooks?.allocate(source.entries.size * 2);
    const copy = new MapValue(source.sorted);
    copy.entries.copyFrom(source.entries, ([key, item]) => [clonePart(args[0], key), clonePart(args[1], item)]);
    hooks?.copyScalarStorage(source, copy);
    return copy;
  }
  hooks?.allocate(source.entries.size);
  const copy = new SetValue(source.sorted);
  copy.entries.copyFrom(source.entries, (item) => clonePart(args[0], item));
  hooks?.copyScalarStorage(source, copy);
  return copy;
}

/** What an `Rc`, a cell, or a `RefCell`'s guard holds. */
function pointee(value: Value): Value {
  const target = derefAll(value);
  if (target instanceof SharedBox || target instanceof CellBox) return target.value;
  if (target instanceof BorrowGuard) return target.cell.value;
  return target;
}

function derefAll(value: Value): Value {
  let current = value;
  while (isPlace(current)) current = current.get();
  return current;
}

/** Orders byte strings as slices do: by their first differing byte, or the shorter first. */
function compareBytes(a: bigint[], b: bigint[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return Math.sign(a.length - b.length);
}
