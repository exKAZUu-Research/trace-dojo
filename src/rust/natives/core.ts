import { TURTLE_METHOD_NAMES, type TurtleState } from '../../interpreter/turtleWorld';
import { exactCapacity, madeString, sizeTable, StringGrowth } from '../capacity';
import { DEFAULT_SPEC } from '../fmt';
import { normalize } from '../infer';
import {
  castValue,
  cloneValue,
  comparePartialValues,
  compareValues,
  testPartialOrder,
  valuesEqual,
  valuesUnequal,
} from '../ops';
import { FmtFailure, ProcessExit, RustPanic } from '../runtime';
import { intMax, type IntName, resolve, sameType, shallow, substitute as substituteType, type Type } from '../types';
import { utf8Bytes, utf8Reader } from '../utf8';
import {
  DynValue,
  EnumValue,
  type FormatterValue,
  MapValue,
  type RangeValue,
  SetValue,
  sliceItems,
  StringValue,
  StructValue,
  textOf,
  type TurtleValue,
  UNIT_VALUE,
  type Value,
} from '../values';
import { intoStringBytes } from './capacityNatives';
import { cloneFromDefault } from './cloning';
import { collectInto } from './iterators';
import { sizeOf } from './layout';
import {
  call,
  callForEach,
  define,
  deref,
  libraryPanic,
  type NativeContext,
  none,
  ok,
  option,
  ordering,
  panic,
  placeOf,
  some,
} from './support';

// ---------------------------------------------------------------------------------------------------------------------
// Turtle

function turtleOf(self: Value): TurtleState {
  return (deref(self) as TurtleValue).state;
}

/** The Rust names of a Turtle method: the Japanese name, the camelCase name, and its snake_case form. */
export function turtleMethodNames(names: readonly string[]): string[] {
  const result = new Set<string>();
  for (const name of names) {
    result.add(name);
    result.add(name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`));
  }
  return [...result];
}

const turtleNatives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {};
for (const [names, sign] of [
  [TURTLE_METHOD_NAMES.forward, 1],
  [TURTLE_METHOD_NAMES.backward, -1],
] as const) {
  for (const name of turtleMethodNames(names)) {
    turtleNatives[`Turtle::${name}`] = ([self], ctx) => {
      ctx.runtime.spend();
      const error = ctx.runtime.world.move(turtleOf(self), sign);
      if (error) panic(ctx, error);
      return UNIT_VALUE;
    };
  }
}
for (const [names, quarters] of [
  [TURTLE_METHOD_NAMES.turnRight, 1],
  [TURTLE_METHOD_NAMES.turnLeft, 3],
] as const) {
  for (const name of turtleMethodNames(names)) {
    turtleNatives[`Turtle::${name}`] = ([self], ctx) => {
      ctx.runtime.spend();
      ctx.runtime.world.turn(turtleOf(self), quarters);
      return UNIT_VALUE;
    };
  }
}
for (const name of turtleMethodNames(TURTLE_METHOD_NAMES.canMoveForward)) {
  turtleNatives[`Turtle::${name}`] = ([self], ctx) => {
    ctx.runtime.collectGarbage();
    return ctx.runtime.world.canMoveForward(turtleOf(self));
  };
}
for (const name of turtleMethodNames(TURTLE_METHOD_NAMES.isFrontPainted)) {
  turtleNatives[`Turtle::${name}`] = ([self], ctx) => ctx.runtime.world.isFrontPainted(turtleOf(self));
}
for (const name of turtleMethodNames(TURTLE_METHOD_NAMES.remove)) {
  turtleNatives[`Turtle::${name}`] = ([self], ctx) => {
    ctx.runtime.world.remove(turtleOf(self));
    return UNIT_VALUE;
  };
}
define(turtleNatives);

/** The Turtle's methods in Rust's syntax, for the standard library's declarations. */
export function turtleImplSource(): string {
  const methods: string[] = [];
  for (const [key, names] of Object.entries(TURTLE_METHOD_NAMES)) {
    for (const name of turtleMethodNames(names)) {
      const returnsBool = key === 'canMoveForward' || key === 'isFrontPainted';
      methods.push(`pub fn ${name}(&${returnsBool ? '' : 'mut '}self)${returnsBool ? ' -> bool' : ''};`);
    }
  }
  return `impl Turtle {\n    pub fn new() -> Turtle;\n    ${methods.join('\n    ')}\n}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Traits implemented by the standard library for every type that has them

/**
 * The capacity `to_string` gives an integer's text: room for the most digits of a signed type (and its sign), and
 * exactly the text for an unsigned one, but 3 for `u8` and 4 for `i8`.
 */
function intTextCapacity(name: IntName, text: string): number {
  if (name === 'u8') return 3;
  if (name === 'i8') return 4;
  if (name.startsWith('u')) return text.length;
  const digits = String(intMax(name)).length;
  return text.startsWith('-') ? digits + 1 : digits;
}

function selfType(ctx: NativeContext): Type {
  return ctx.typeArgs[0];
}

/** The default value of a type, as `Default::default` gives it. */
export function defaultValue(ctx: NativeContext, type: Type): Value {
  const method = ctx.interp.program.traitDef('Default').methods.get('default')!;
  return ctx.interp.callFn(method, [type], [], undefined, ctx.span, ctx.frame);
}

// code-gauge-allow functionNcss -- One branch per type with a built-in default value.
function builtinDefaultValue(ctx: NativeContext, type: Type): Value {
  ctx.runtime.spend();
  const t = normalize(shallow(type));
  switch (t.kind) {
    case 'int': {
      return 0n;
    }
    case 'float': {
      return 0;
    }
    case 'bool': {
      return false;
    }
    case 'char': {
      return '\0';
    }
    case 'tuple': {
      ctx.runtime.allocate(t.elems.length);
      return callForEach(ctx, t.elems, (elem) => defaultValue(ctx, elem));
    }
    case 'array': {
      ctx.runtime.allocate(t.len);
      return callForEach(ctx, Array.from({ length: t.len }), () => defaultValue(ctx, t.elem));
    }
    case 'ref': {
      return normalize(shallow(t.target)).kind === 'slice' ? [] : '';
    }
    case 'adt': {
      switch (t.def.builtin) {
        case 'String': {
          return '';
        }
        case 'Vec':
        case 'VecDeque':
        case 'BinaryHeap': {
          return [];
        }
        case 'HashMap':
        case 'BTreeMap': {
          const map = new MapValue(t.def.builtin === 'BTreeMap');
          sizeTable(map.entries.table, sizeOf({ kind: 'tuple', elems: t.args }));
          return map;
        }
        case 'HashSet':
        case 'BTreeSet': {
          const set = new SetValue(t.def.builtin === 'BTreeSet');
          sizeTable(set.entries.table, sizeOf(t.args[0]));
          return set;
        }
        case 'Option': {
          return none(ctx);
        }
        case 'Box': {
          return defaultBoxValue(ctx, t.args[0]);
        }
        default: {
          break;
        }
      }
      if (t.def.kind === 'enum') return new EnumValue(t.def, t.def.defaultVariant ?? 0, []);
      const subst = new Map(t.def.params.map((param, index) => [param, t.args[index]]));
      const defFields = t.def.variants[0].fields;
      ctx.runtime.allocate(defFields.length);
      const fields = callForEach(ctx, defFields, (field) => {
        const fieldType = subst.size > 0 ? substituteType(field.type, subst) : field.type;
        return defaultValue(ctx, fieldType);
      });
      return new StructValue(t.def, fields);
    }
    default: {
      return undefined;
    }
  }
}

function defaultBoxValue(ctx: NativeContext, type: Type): Value {
  const content = normalize(shallow(type));
  if (content.kind === 'str') return '';
  if (content.kind === 'slice') return [];
  return defaultValue(ctx, content);
}

function callOrd(ctx: NativeContext, name: 'max' | 'min', args: Value[]): Value {
  const { interp, span, frame } = ctx;
  const method = interp.program.traitDef('Ord').methods.get(name)!;
  return interp.callFn(method, [ctx.typeArgs[0]], args, undefined, span, frame);
}

define({
  'Turtle::new': (args, ctx) => ctx.interp.turtleNew(args, ctx.span, ctx.frame),
  'Clone::clone': ([self], ctx) => cloneValue(selfType(ctx), deref(self)),
  'Clone::clone_from': ([self, source], ctx) => {
    cloneFromDefault(ctx, selfType(ctx), placeOf(self), source);
    return UNIT_VALUE;
  },
  'ToOwned::to_owned': ([self], ctx) => cloneValue(selfType(ctx), deref(self)),
  'ToString::to_string': ([self], ctx) => {
    try {
      return toStringValue(ctx, self);
    } catch (error) {
      if (!(error instanceof FmtFailure)) throw error;
      return libraryPanic(
        ctx,
        'a Display implementation returned an error unexpectedly: Error',
        'alloc/src/string.rs:2953:14'
      );
    }
  },
  'Display::fmt': ([self, f], ctx) => {
    const formatter = deref(f) as FormatterValue;
    formatter.text += ctx.interp.formatter.display(
      self,
      selfType(ctx),
      { ...DEFAULT_SPEC, ...formatter.spec },
      formatter.writeChunk
    );
    return ok(ctx, UNIT_VALUE);
  },
  'Debug::fmt': ([self, f], ctx) => {
    const formatter = deref(f) as FormatterValue;
    formatter.text += ctx.interp.formatter.debug(
      self,
      selfType(ctx),
      { ...DEFAULT_SPEC, ...formatter.spec },
      formatter.spec.alternate ? 0 : undefined,
      formatter.writeChunk
    );
    return ok(ctx, UNIT_VALUE);
  },
  'PartialEq::eq': ([self, other], ctx) => valuesEqual(selfType(ctx), self, other, ctx.typeArgs[1]),
  'PartialEq::ne': ([self, other], ctx) => valuesUnequal(selfType(ctx), self, other, ctx.typeArgs[1]),
  'PartialOrd::partial_cmp': ([self, other], ctx) => {
    const order = comparePartialValues(selfType(ctx), self, other, ctx.typeArgs[1]);
    return order === undefined ? none(ctx) : some(ctx, ordering(ctx, order));
  },
  'PartialOrd::lt': ([self, other], ctx) => testPartialOrder('lt', selfType(ctx), self, other, ctx.typeArgs[1]),
  'PartialOrd::le': ([self, other], ctx) => testPartialOrder('le', selfType(ctx), self, other, ctx.typeArgs[1]),
  'PartialOrd::gt': ([self, other], ctx) => testPartialOrder('gt', selfType(ctx), self, other, ctx.typeArgs[1]),
  'PartialOrd::ge': ([self, other], ctx) => testPartialOrder('ge', selfType(ctx), self, other, ctx.typeArgs[1]),
  'Ord::cmp': ([self, other], ctx) => ordering(ctx, compareValues(selfType(ctx), self, other) ?? 0),
  'Ord::max': ([self, other], ctx) => (testPartialOrder('lt', selfType(ctx), other, self) ? self : other),
  'Ord::min': ([self, other], ctx) => (testPartialOrder('lt', selfType(ctx), other, self) ? other : self),
  'Ord::clamp': ([self, min, max], ctx) => {
    const type = selfType(ctx);
    if (!testPartialOrder('le', type, min, max)) {
      // Integers report their bounds; other types assert.
      const isInt = normalize(shallow(type)).kind === 'int';
      panic(ctx, isInt ? `min > max. min = ${min as bigint}, max = ${max as bigint}` : 'assertion failed: min <= max');
    }
    if (testPartialOrder('lt', type, self, min)) return min;
    if (testPartialOrder('gt', type, self, max)) return max;
    return self;
  },
  'Default::default': (_args, ctx) => builtinDefaultValue(ctx, selfType(ctx)),
  'From::from': ([value], ctx) => convert(ctx, value, ctx.typeArgs[1], selfType(ctx)),
  'Into::into': ([value], ctx) => ctx.interp.convertFrom(value, selfType(ctx), ctx.typeArgs[1], ctx.frame),
  'std::cmp::max': (args, ctx) => callOrd(ctx, 'max', args),
  'std::cmp::min': (args, ctx) => callOrd(ctx, 'min', args),
  'std::cmp::max_by': ([a, b, f], ctx) => ((call(ctx, f, [a, b]) as EnumValue).variant === 2 ? a : b),
  'std::cmp::min_by': ([a, b, f], ctx) => ((call(ctx, f, [a, b]) as EnumValue).variant === 2 ? b : a),
  'std::cmp::max_by_key': ([a, b, f], ctx) => (secondKeyIsLess(ctx, a, b, f) ? a : b),
  'std::cmp::min_by_key': ([a, b, f], ctx) => (secondKeyIsLess(ctx, a, b, f) ? b : a),
  'Box<[_]>::into_vec': ([self]) => exactCapacity(sliceItems(deref(self))),
  'Box<str>::into_string': ([self]) => textOf(self),
  'AsRef::as_ref': ([self], ctx) => {
    const value = deref(self);
    // A string as `[u8]` borrows its UTF-8 bytes, as `str::as_bytes` does.
    const target = normalize(shallow(ctx.typeArgs[1]));
    if (target.kind === 'str') return textOf(value);
    const isBytes = target.kind === 'slice' && (typeof value === 'string' || value instanceof StringValue);
    return isBytes ? utf8Reader.bytesView(textOf(value), ctx.runtime) : value;
  },
  'std::mem::size_of': (_args, ctx) => BigInt(sizeOf(ctx.typeArgs[0])),
  'std::mem::swap': ([x, y]) => {
    const a = placeOf(x);
    const b = placeOf(y);
    const value = a.get();
    a.set(b.get());
    b.set(value);
    return UNIT_VALUE;
  },
  'std::mem::replace': ([dest, src]) => {
    const place = placeOf(dest);
    const old = place.get();
    place.set(src);
    return old;
  },
  'std::mem::take': ([dest], ctx) => {
    const place = placeOf(dest);
    const old = place.get();
    place.set(defaultValue(ctx, ctx.typeArgs[0]));
    return old;
  },
  'std::mem::drop': () => UNIT_VALUE,
  'std::convert::identity': ([x]) => x,
  'std::process::exit': ([code]) => {
    throw new ProcessExit(Number(code as bigint));
  },
  'Box<_>::new': ([x]) => x,
  'Box<_>::as_ref': ([self]) => deref(self),
  'Box<_>::as_mut': ([self]) => self,
  'Ordering::reverse': ([self], ctx) => ordering(ctx, -((self as EnumValue).variant - 1)),
  'Ordering::then': ([self, other]) => ((self as EnumValue).variant === 1 ? other : self),
  'Ordering::then_with': ([self, f], ctx) => ((self as EnumValue).variant === 1 ? call(ctx, f, []) : self),
  'Ordering::is_eq': ([self]) => (self as EnumValue).variant === 1,
  'Ordering::is_ne': ([self]) => (self as EnumValue).variant !== 1,
  'Ordering::is_lt': ([self]) => (self as EnumValue).variant === 0,
  'Ordering::is_gt': ([self]) => (self as EnumValue).variant === 2,
  'Ordering::is_le': ([self]) => (self as EnumValue).variant !== 2,
  'Ordering::is_ge': ([self]) => (self as EnumValue).variant !== 0,
  'Formatter::write_str': ([self, text], ctx) => {
    (deref(self) as FormatterValue).write(textOf(text));
    return ok(ctx, UNIT_VALUE);
  },
  'Formatter::pad': ([self, text], ctx) => {
    const formatter = deref(self) as FormatterValue;
    formatter.text += ctx.interp.formatter.display(
      deref(text),
      { kind: 'str' },
      { ...DEFAULT_SPEC, ...formatter.spec },
      formatter.writeChunk
    );
    return ok(ctx, UNIT_VALUE);
  },
  'Formatter::alternate': ([self]) => (deref(self) as FormatterValue).spec.alternate,
  'Formatter::width': ([self], ctx) => {
    const { width } = (deref(self) as FormatterValue).spec;
    return option(ctx, width === undefined ? undefined : BigInt(width), width !== undefined);
  },
  'Formatter::precision': ([self], ctx) => {
    const { precision } = (deref(self) as FormatterValue).spec;
    return option(ctx, precision === undefined ? undefined : BigInt(precision), precision !== undefined);
  },
  'Formatter::fill': ([self]) => (deref(self) as FormatterValue).spec.fill,
  'Formatter::sign_plus': ([self]) => (deref(self) as FormatterValue).spec.sign === '+',
  'bool::then': ([self, f], ctx) => ((self as boolean) ? some(ctx, call(ctx, f, [])) : none(ctx)),
  'bool::then_some': ([self, value], ctx) => ((self as boolean) ? some(ctx, value) : none(ctx)),
  'RangeInclusive<_>::start': ([self]) => (deref(self) as RangeValue).start,
  'RangeInclusive<_>::end': ([self]) => (deref(self) as RangeValue).end,
  'Range<_>::contains': ([self, item], ctx) => rangeContains(ctx, deref(self) as RangeValue, item),
  'RangeInclusive<_>::contains': ([self, item], ctx) => rangeContains(ctx, deref(self) as RangeValue, item),
  'Range<_>::is_empty': ([self], ctx) => {
    const range = deref(self) as RangeValue;
    return !testPartialOrder('lt', ctx.typeArgs[0], range.start, range.end);
  },
  'RangeInclusive<_>::is_empty': ([self], ctx) => {
    const range = deref(self) as RangeValue;
    return range.exhausted || !testPartialOrder('le', ctx.typeArgs[0], range.start, range.end);
  },
});

function secondKeyIsLess(ctx: NativeContext, a: Value, b: Value, f: Value): boolean {
  const second = call(ctx, f, [b]);
  return ctx.runtime.withRoots([second], () => {
    const first = call(ctx, f, [a]);
    return ctx.runtime.withRoots([first], () => testPartialOrder('lt', ctx.typeArgs[2], second, first));
  });
}

function toStringValue(ctx: NativeContext, self: Value): Value {
  const type = normalize(shallow(selfType(ctx)));
  const { formatter } = ctx.interp;
  if (type.kind === 'int') {
    const text = formatter.display(self, type, DEFAULT_SPEC);
    return madeString(text, intTextCapacity(type.name, text));
  }
  let base: Type = type;
  while (base.kind === 'ref') base = normalize(shallow(base.target));
  if (
    type.kind === 'bool' ||
    type.kind === 'char' ||
    base.kind === 'str' ||
    (type.kind === 'adt' && type.def.builtin === 'String')
  ) {
    return formatter.display(self, type, DEFAULT_SPEC);
  }
  const growth = new StringGrowth();
  return growth.finish(formatter.display(self, type, DEFAULT_SPEC, (chunk) => growth.write(chunk)));
}

function rangeContains(ctx: NativeContext, range: RangeValue, item: Value): boolean {
  const type = ctx.typeArgs[0];
  const value = deref(item);
  if (range.exhausted) return false;
  if (range.start !== undefined && !testPartialOrder('le', type, range.start, value)) return false;
  return range.end === undefined || testPartialOrder(range.inclusive ? 'le' : 'lt', type, value, range.end);
}

/** `T::from(value)` for the conversions of the standard library. */
// code-gauge-allow functionCognitiveComplexity -- Rust conversions select different rules for each destination type.
export function convert(ctx: NativeContext, value: Value, from: Type, to: Type): Value {
  const source = normalize(shallow(from));
  const target = normalize(shallow(to));
  // `impl<T> From<T> for T` returns the value as it is.
  if (sameType(resolve(source, true), resolve(target, true))) return value;
  if (target.kind === 'float' && source.kind === 'bool') return deref(value) ? 1 : 0;
  if (target.kind === 'int' || target.kind === 'float' || target.kind === 'char')
    return castValue(deref(value), target);
  if (target.kind === 'adt') {
    switch (target.def.builtin) {
      case 'String': {
        return source.kind === 'adt' && source.def.builtin === 'String' ? value : textOf(value);
      }
      case 'Vec': {
        return convertToVec(ctx, value, source, target.args[0]);
      }
      case 'Option': {
        return some(ctx, value);
      }
      case 'Box': {
        return boxValue(ctx, value, source, normalize(shallow(target.args[0])));
      }
      case 'HashMap':
      case 'BTreeMap':
      case 'HashSet':
      case 'BTreeSet':
      case 'VecDeque':
      case 'BinaryHeap': {
        const elem = target.def.builtin.endsWith('Map')
          ? ({ kind: 'tuple', elems: target.args } as Type)
          : target.args[0];
        return collectInto(ctx, [...(deref(value) as Value[])], target, elem);
      }
      default: {
        break;
      }
    }
  }
  return value;
}

function convertToVec(ctx: NativeContext, value: Value, source: Type, elem: Type): Value {
  if (source.kind === 'adt' && source.def.builtin === 'String') return intoStringBytes(value, ctx);
  const input = deref(value);
  if (typeof input === 'string' || input instanceof StringValue) return utf8Bytes(textOf(input), ctx.runtime);
  return ownedSequence(ctx, input, source, elem);
}

/** `Box<T>::from(value)`: a trait object of the value, or the value itself, which a box holds as it is. */
function boxValue(ctx: NativeContext, value: Value, source: Type, inner: Type): Value {
  if (inner.kind === 'dyn') {
    if (source.kind === 'ref' || (source.kind === 'adt' && source.def.builtin === 'String')) {
      return new DynValue(ctx.interp.program.builtinType('String'), textOf(value));
    }
    return new DynValue(source, value);
  }
  if (inner.kind === 'slice') return ownedSequence(ctx, deref(value), source, inner.elem);
  if (inner.kind === 'str') return textOf(value);
  return value;
}

function ownedSequence(ctx: NativeContext, input: Value, source: Type, elem: Type): Value {
  if (source.kind === 'ref') return cloneValue({ kind: 'slice', elem }, input);
  const items = sliceItems(input);
  ctx.runtime.allocate(items.length);
  return [...items];
}

export { EnumValue, RustPanic };
