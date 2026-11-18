// code-gauge-allow-file fileNcss 424 -- One case per kind of type.
import type { Span } from './ast';
import { bigintToF32 } from './floatFormat';
import { normalize } from './infer';
import { RustPanic } from './runtime';
import { type AdtDef, intMax, intMin, type IntName, shallow, type Type } from './types';
import {
  DONE,
  EnumValue,
  FnValue,
  isPlace,
  type IterValue,
  MapValue,
  RangeValue,
  SetValue,
  sliceItems,
  StructValue,
  type Value,
} from './values';

/** Hooks into the program's own impls, which the type-directed operations call for user types. */
export interface UserImpls {
  eq?(type: Type, a: Value, b: Value): boolean | undefined;
  cmp?(type: Type, a: Value, b: Value): number | undefined;
  clone?(type: Type, value: Value): { value: Value } | undefined;
  /** Substitutes a generic type's parameters with its arguments in a field's type. */
  fieldTypes(def: AdtDef, args: Type[], variant: number): Type[];
}

let hooks: UserImpls | undefined;

export function setUserImpls(implementations: UserImpls): void {
  hooks = implementations;
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
// code-gauge-allow functionCognitiveComplexity 18 -- One case per kind of type.
// code-gauge-allow functionNcss 43 -- One case per kind of type.
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
export function castValue(value: Value, from: Type, to: Type): Value {
  const source = normalize(shallow(from));
  const target = normalize(shallow(to));
  if (target.kind === 'int') {
    if (typeof value === 'bigint') return wrap(target.name, value);
    if (typeof value === 'boolean') return value ? 1n : 0n;
    if (typeof value === 'string') return wrap(target.name, BigInt(value.codePointAt(0) ?? 0));
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return 0n;
      const min = intMin(target.name);
      const max = intMax(target.name);
      if (value === Number.POSITIVE_INFINITY) return max;
      if (value === Number.NEGATIVE_INFINITY) return min;
      const truncated = BigInt(Math.trunc(value));
      return truncated < min ? min : truncated > max ? max : truncated;
    }
    if (value instanceof EnumValue) return wrap(target.name, value.def.variants[value.variant].discriminant);
  }
  if (target.kind === 'float') {
    if (typeof value === 'bigint') return target.name === 'f32' ? bigintToF32(value) : Number(value);
    return target.name === 'f32' ? Math.fround(value as number) : (value as number);
  }
  if (target.kind === 'char') return String.fromCodePoint(Number(value as bigint));
  void source;
  return value;
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

export function valuesEqual(type: Type, a: Value, b: Value): boolean {
  const t = derefType(type);
  const x = deref(a);
  const y = deref(b);
  if (t.kind === 'adt') {
    const user = hooks?.eq?.(t, x, y);
    if (user !== undefined) return user;
  }
  switch (t.kind) {
    case 'int':
    case 'float':
    case 'bool':
    case 'char':
    case 'str': {
      return x === y;
    }
    case 'tuple': {
      return t.elems.every((elem, index) => valuesEqual(elem, (x as Value[])[index], (y as Value[])[index]));
    }
    case 'array':
    case 'slice': {
      const xs = sliceItems(x);
      const ys = sliceItems(y);
      return xs.length === ys.length && xs.every((item, index) => valuesEqual(t.elem, item, ys[index]));
    }
    case 'adt': {
      return adtEqual(t, x, y);
    }
    case 'dyn': {
      return x === y;
    }
    default: {
      return x === y;
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 23 -- One case per kind of type.
// code-gauge-allow functionNcss 51 -- One case per kind of type.
function adtEqual(t: Type & { kind: 'adt' }, x: Value, y: Value): boolean {
  const { def } = t;
  switch (def.builtin) {
    case 'String': {
      return x === y;
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
      const xs = sliceItems(x);
      const ys = sliceItems(y);
      return xs.length === ys.length && xs.every((item, index) => valuesEqual(t.args[0], item, ys[index]));
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
      for (const [hash, [, value]] of xm.entries) {
        const other = ym.entries.get(hash);
        if (!other || !valuesEqual(t.args[1], value, other[1])) return false;
      }
      return true;
    }
    case 'HashSet':
    case 'BTreeSet': {
      const xs = x as SetValue;
      const ys = y as SetValue;
      return xs.entries.size === ys.entries.size && [...xs.entries.keys()].every((hash) => ys.entries.has(hash));
    }
    case 'Range':
    case 'RangeInclusive': {
      const xr = x as RangeValue;
      const yr = y as RangeValue;
      return (
        valuesEqual(t.args[0], xr.start, yr.start) &&
        valuesEqual(t.args[0], xr.end, yr.end) &&
        xr.exhausted === yr.exhausted
      );
    }
    default: {
      if (x instanceof StructValue && y instanceof StructValue) {
        const types = fieldTypes(def, t.args, 0);
        return types.every((type, index) => valuesEqual(type, x.fields[index], y.fields[index]));
      }
      if (x instanceof EnumValue && y instanceof EnumValue) {
        if (x.variant !== y.variant) return false;
        const types = fieldTypes(def, t.args, x.variant);
        return types.every((type, index) => valuesEqual(type, x.fields[index], y.fields[index]));
      }
      return x === y;
    }
  }
}

/** Compares two values of a type, as `Ord::cmp` and `PartialOrd::partial_cmp` do; NaN compares as `undefined`. */
// code-gauge-allow functionCognitiveComplexity 22 -- One case per kind of type.
// code-gauge-allow functionNcss 34 -- One case per kind of type.
export function compareValues(type: Type, a: Value, b: Value): number | undefined {
  const t = derefType(type);
  const x = deref(a);
  const y = deref(b);
  if (t.kind === 'adt') {
    const user = hooks?.cmp?.(t, x, y);
    if (user !== undefined) return user;
  }
  switch (t.kind) {
    case 'int': {
      return x === y ? 0 : (x as bigint) < (y as bigint) ? -1 : 1;
    }
    case 'float': {
      if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
      return x === y ? 0 : (x as number) < (y as number) ? -1 : 1;
    }
    case 'bool': {
      return Number(x) - Number(y);
    }
    case 'char': {
      return Math.sign((x as string).codePointAt(0)! - (y as string).codePointAt(0)!);
    }
    case 'str': {
      return compareStrings(x as string, y as string);
    }
    case 'tuple': {
      for (const [index, elem] of t.elems.entries()) {
        const order = compareValues(elem, (x as Value[])[index], (y as Value[])[index]);
        if (order !== 0) return order;
      }
      return 0;
    }
    case 'array':
    case 'slice': {
      return compareSequences(t.elem, sliceItems(x), sliceItems(y));
    }
    case 'adt': {
      return compareAdt(t, x, y);
    }
    default: {
      return 0;
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of type.
// code-gauge-allow functionNcss 37 -- One case per kind of type.
function compareAdt(t: Type & { kind: 'adt' }, x: Value, y: Value): number | undefined {
  const { def } = t;
  switch (def.builtin) {
    case 'String': {
      return compareStrings(x as string, y as string);
    }
    case 'Vec':
    case 'VecDeque': {
      return compareSequences(t.args[0], x as Value[], y as Value[]);
    }
    case 'Box': {
      return compareValues(t.args[0], x, y);
    }
    case 'Reverse': {
      const order = compareValues(t.args[0], (x as StructValue).fields[0], (y as StructValue).fields[0]);
      return order === undefined ? undefined : -order;
    }
    case 'BTreeSet': {
      return compareSequences(t.args[0], [...(x as SetValue).entries.values()], [...(y as SetValue).entries.values()]);
    }
    case 'Ordering': {
      return Math.sign((x as EnumValue).variant - (y as EnumValue).variant);
    }
    default: {
      if (x instanceof StructValue && y instanceof StructValue) {
        const types = fieldTypes(def, t.args, 0);
        for (const [index, type] of types.entries()) {
          const order = compareValues(type, x.fields[index], y.fields[index]);
          if (order !== 0) return order;
        }
        return 0;
      }
      if (x instanceof EnumValue && y instanceof EnumValue) {
        if (x.variant !== y.variant) {
          const dx = def.variants[x.variant].discriminant;
          const dy = def.variants[y.variant].discriminant;
          return dx < dy ? -1 : 1;
        }
        const types = fieldTypes(def, t.args, x.variant);
        for (const [index, type] of types.entries()) {
          const order = compareValues(type, x.fields[index], y.fields[index]);
          if (order !== 0) return order;
        }
        return 0;
      }
      return 0;
    }
  }
}

function compareSequences(elem: Type, xs: Value[], ys: Value[]): number | undefined {
  const length = Math.min(xs.length, ys.length);
  for (let index = 0; index < length; index++) {
    const order = compareValues(elem, xs[index], ys[index]);
    if (order !== 0) return order;
  }
  return Math.sign(xs.length - ys.length);
}

/** Compares strings as Rust does, by their UTF-8 bytes, which is their code points' order. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  const xs = [...a];
  const ys = [...b];
  const length = Math.min(xs.length, ys.length);
  for (let index = 0; index < length; index++) {
    const x = xs[index].codePointAt(0)!;
    const y = ys[index].codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return Math.sign(xs.length - ys.length);
}

/** A text that equal values of a type share and unequal ones do not, which keys maps and sets. */
// code-gauge-allow functionNcss 34 -- One case per kind of type.
export function hashKey(type: Type, value: Value): string {
  const t = derefType(type);
  const x = deref(value);
  switch (t.kind) {
    case 'int': {
      return String(x);
    }
    case 'bool':
    case 'char':
    case 'str': {
      return `${t.kind[0]}${String(x)}`;
    }
    case 'float': {
      return `f${String(x)}`;
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
      if (def.builtin === 'String') return `s${x as string}`;
      if (def.builtin === 'Vec' || def.builtin === 'VecDeque') {
        return `[${(x as Value[]).map((item) => hashKey(t.args[0], item)).join(',')}]`;
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

/** A deep copy of a value as `Clone::clone` makes it, calling the program's own `clone` for its types. */
// code-gauge-allow functionCognitiveComplexity 23 -- One case per kind of type.
// code-gauge-allow functionNcss 59 -- One case per kind of value.
export function cloneValue(type: Type, value: Value): Value {
  const t = normalize(shallow(type));
  if (t.kind === 'ref') return value;
  if (t.kind === 'adt') {
    const user = hooks?.clone?.(t, value);
    if (user) return user.value;
  }
  switch (t.kind) {
    case 'tuple': {
      return t.elems.map((elem, index) => cloneValue(elem, (value as Value[])[index]));
    }
    case 'closure': {
      return cloneClosure(t.closure.captures ?? [], value as FnValue);
    }
    case 'array': {
      return (value as Value[]).map((item) => cloneValue(t.elem, item));
    }
    case 'adt': {
      const { def } = t;
      switch (def.builtin) {
        case 'Vec':
        case 'VecDeque':
        case 'BinaryHeap': {
          return (value as Value[]).map((item) => cloneValue(t.args[0], item));
        }
        case 'Box': {
          return cloneValue(t.args[0], value);
        }
        case 'HashMap':
        case 'BTreeMap': {
          const source = value as MapValue;
          const copy = new MapValue(source.sorted);
          for (const [hash, [key, item]] of source.entries) {
            copy.entries.set(hash, [cloneValue(t.args[0], key), cloneValue(t.args[1], item)]);
          }
          return copy;
        }
        case 'HashSet':
        case 'BTreeSet': {
          const source = value as SetValue;
          const copy = new SetValue(source.sorted);
          for (const [hash, item] of source.entries) copy.entries.set(hash, cloneValue(t.args[0], item));
          return copy;
        }
        case 'Range':
        case 'RangeInclusive':
        case 'RangeFrom':
        case 'RangeTo':
        case 'RangeToInclusive': {
          const range = value as RangeValue;
          return new RangeValue(range.start, range.end, range.inclusive, range.exhausted);
        }
        case 'Iter': {
          return cloneIterator(t.args[0], value as IterValue);
        }
        default: {
          if (value instanceof StructValue) {
            const types = fieldTypes(def, t.args, 0);
            return new StructValue(
              def,
              types.map((type, index) => cloneValue(type, value.fields[index]))
            );
          }
          if (value instanceof EnumValue) {
            const types = fieldTypes(def, t.args, value.variant);
            return new EnumValue(
              def,
              value.variant,
              types.map((type, index) => cloneValue(type, value.fields[index]))
            );
          }
          return value;
        }
      }
    }
    default: {
      return value;
    }
  }
}

/** A clone of a closure, which clones what it captures by value. */
function cloneClosure(captures: { type: Type }[], fn: FnValue): FnValue {
  return fn.duplicate?.((item, index) => cloneValue(captures[index].type, item)) ?? fn;
}

/** A clone of an iterator, which goes on from where the iterator is, on its own. */
function cloneIterator(item: Type, iter: IterValue): IterValue {
  const cloneItem = (value: Value): Value => cloneValue(item, value);
  const copy = iter.fork?.(cloneItem) ?? iter;
  if (iter.peeked) copy.peeked = iter.peeked.map((next) => (next === DONE ? DONE : cloneItem(next)));
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
    return !t.def.builtin || t.def.builtin === 'Option' || t.def.builtin === 'Result' || t.def.builtin === 'Reverse';
  return false;
}

/** A copy of a value of a `Copy` type, which shares nothing mutable with the original. */
export function copyValue(value: Value): Value {
  if (Array.isArray(value)) return value.length === 0 ? value : value.map(copyValue);
  if (value instanceof FnValue) return value.duplicate?.(copyValue) ?? value;
  if (value instanceof StructValue) return new StructValue(value.def, value.fields.map(copyValue));
  if (value instanceof EnumValue) {
    return value.fields.length === 0 ? value : new EnumValue(value.def, value.variant, value.fields.map(copyValue));
  }
  return value;
}
