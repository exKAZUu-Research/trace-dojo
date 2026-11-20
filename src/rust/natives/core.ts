import { TURTLE_METHOD_NAMES, type TurtleState } from '../../interpreter/turtleWorld';
import { madeString, sizeTable } from '../capacity';
import { DEFAULT_SPEC } from '../fmt';
import { normalize } from '../infer';
import { castValue, cloneValue, compareValues, valuesEqual } from '../ops';
import { FmtFailure, ProcessExit, RustPanic } from '../runtime';
import { intMax, type IntName, shallow, substitute as substituteType, type Type } from '../types';
import {
  DynValue,
  EnumValue,
  type FormatterValue,
  MapValue,
  type RangeValue,
  SetValue,
  sliceItems,
  StructValue,
  type TurtleValue,
  UNIT_VALUE,
  type Value,
} from '../values';
import { collectInto } from './iterators';
import { sizeOf } from './layout';
import {
  call,
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
// code-gauge-allow functionNcss 57 -- One branch per type with a built-in default value.
export function defaultValue(ctx: NativeContext, type: Type): Value {
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
      return t.elems.map((elem) => defaultValue(ctx, elem));
    }
    case 'array': {
      ctx.runtime.allocate(t.len);
      return Array.from({ length: t.len }, () => defaultValue(ctx, t.elem));
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
          sizeTable(map.entries, sizeOf({ kind: 'tuple', elems: t.args }));
          return map;
        }
        case 'HashSet':
        case 'BTreeSet': {
          const set = new SetValue(t.def.builtin === 'BTreeSet');
          sizeTable(set.entries, sizeOf(t.args[0]));
          return set;
        }
        case 'Option': {
          return none(ctx);
        }
        case 'Box': {
          return defaultValue(ctx, t.args[0]);
        }
        default: {
          break;
        }
      }
      const trait = ctx.interp.program.traitDef('Default');
      const impl = ctx.interp.program.impls.find(
        (candidate) =>
          candidate.trait?.trait === trait &&
          candidate.methods.has('default') &&
          (shallow(candidate.selfType) as { def?: unknown }).def === t.def
      );
      if (impl) {
        return ctx.interp.callFn(
          impl.methods.get('default')!,
          impl.params.map((_, index) => t.args[index]),
          [],
          undefined,
          ctx.span,
          ctx.frame
        );
      }
      const subst = new Map(t.def.params.map((param, index) => [param, t.args[index]]));
      const defFields = t.def.variants[0].fields;
      ctx.runtime.allocate(defFields.length);
      const fields = defFields.map((field) => {
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

define({
  'Clone::clone': ([self], ctx) => cloneValue(selfType(ctx), deref(self)),
  'ToOwned::to_owned': ([self], ctx) => cloneValue(selfType(ctx), deref(self)),
  'ToString::to_string': ([self], ctx) => {
    try {
      const text = ctx.interp.formatter.display(self, selfType(ctx), DEFAULT_SPEC);
      const type = normalize(shallow(selfType(ctx)));
      return type.kind === 'int' ? madeString(text, intTextCapacity(type.name, text)) : text;
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
    formatter.text += ctx.interp.formatter.display(self, selfType(ctx), { ...DEFAULT_SPEC, ...formatter.spec });
    return ok(ctx, UNIT_VALUE);
  },
  'Debug::fmt': ([self, f], ctx) => {
    const formatter = deref(f) as FormatterValue;
    formatter.text += ctx.interp.formatter.debug(
      self,
      selfType(ctx),
      { ...DEFAULT_SPEC, ...formatter.spec },
      formatter.spec.alternate ? 0 : undefined
    );
    return ok(ctx, UNIT_VALUE);
  },
  'PartialEq::eq': ([self, other], ctx) => valuesEqual(selfType(ctx), self, other),
  'PartialEq::ne': ([self, other], ctx) => !valuesEqual(selfType(ctx), self, other),
  'PartialOrd::partial_cmp': ([self, other], ctx) => {
    const order = compareValues(selfType(ctx), self, other);
    return order === undefined ? none(ctx) : some(ctx, ordering(ctx, order));
  },
  'PartialOrd::lt': ([self, other], ctx) =>
    (compareValues(selfType(ctx), self, other) ?? 0) < 0 && compareValues(selfType(ctx), self, other) !== undefined,
  'PartialOrd::le': ([self, other], ctx) => {
    const order = compareValues(selfType(ctx), self, other);
    return order !== undefined && order <= 0;
  },
  'PartialOrd::gt': ([self, other], ctx) => {
    const order = compareValues(selfType(ctx), self, other);
    return order !== undefined && order > 0;
  },
  'PartialOrd::ge': ([self, other], ctx) => {
    const order = compareValues(selfType(ctx), self, other);
    return order !== undefined && order >= 0;
  },
  'Ord::cmp': ([self, other], ctx) => ordering(ctx, compareValues(selfType(ctx), self, other) ?? 0),
  'Ord::max': ([self, other], ctx) => ((compareValues(selfType(ctx), self, other) ?? 0) > 0 ? self : other),
  'Ord::min': ([self, other], ctx) => ((compareValues(selfType(ctx), self, other) ?? 0) <= 0 ? self : other),
  'Ord::clamp': ([self, min, max], ctx) => {
    const type = selfType(ctx);
    if ((compareValues(type, min, max) ?? 0) > 0) {
      // Integers report their bounds; other types assert.
      const isInt = normalize(shallow(type)).kind === 'int';
      panic(ctx, isInt ? `min > max. min = ${min as bigint}, max = ${max as bigint}` : 'assertion failed: min <= max');
    }
    if ((compareValues(type, self, min) ?? 0) < 0) return min;
    if ((compareValues(type, self, max) ?? 0) > 0) return max;
    return self;
  },
  'Default::default': (_args, ctx) => defaultValue(ctx, selfType(ctx)),
  'From::from': ([value], ctx) => convert(ctx, value, ctx.typeArgs[1], selfType(ctx)),
  'Into::into': ([value], ctx) => ctx.interp.convertFrom(value, selfType(ctx), ctx.typeArgs[1], ctx.frame),
  'std::cmp::max': ([a, b], ctx) => ((compareValues(ctx.typeArgs[0], a, b) ?? 0) > 0 ? a : b),
  'std::cmp::min': ([a, b], ctx) => ((compareValues(ctx.typeArgs[0], a, b) ?? 0) <= 0 ? a : b),
  'std::cmp::max_by_key': ([a, b, f], ctx) => {
    const order = compareValues(ctx.typeArgs[2], call(ctx, f, [a]), call(ctx, f, [b])) ?? 0;
    return order > 0 ? a : b;
  },
  'std::cmp::min_by_key': ([a, b, f], ctx) => {
    const order = compareValues(ctx.typeArgs[2], call(ctx, f, [a]), call(ctx, f, [b])) ?? 0;
    return order <= 0 ? a : b;
  },
  // A `String` is its `str`, and a `Vec` its slice, so the reference they lend is the value.
  // A `Box<[T]>` is its elements and a `Box<str>` its text, as a `Vec<T>` and a `String` are.
  'Box<[_]>::into_vec': ([self]) => deref(self),
  'Box<str>::into_string': ([self]) => deref(self),
  'AsRef::as_ref': ([self], ctx) => {
    const value = deref(self);
    // A string as `[u8]` is its UTF-8 bytes.
    const isBytes = normalize(shallow(ctx.typeArgs[1])).kind === 'slice' && typeof value === 'string';
    return isBytes ? Array.from(new TextEncoder().encode(value), BigInt) : value;
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
    (deref(self) as FormatterValue).text += deref(text) as string;
    return ok(ctx, UNIT_VALUE);
  },
  'Formatter::pad': ([self, text], ctx) => {
    const formatter = deref(self) as FormatterValue;
    formatter.text += ctx.interp.formatter.display(
      deref(text),
      { kind: 'str' },
      { ...DEFAULT_SPEC, ...formatter.spec }
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
    return !((compareValues(ctx.typeArgs[0], range.start, range.end) ?? 1) < 0);
  },
  'RangeInclusive<_>::is_empty': ([self], ctx) => {
    const range = deref(self) as RangeValue;
    return range.exhausted || !((compareValues(ctx.typeArgs[0], range.start, range.end) ?? 1) <= 0);
  },
});

function rangeContains(ctx: NativeContext, range: RangeValue, item: Value): boolean {
  const type = ctx.typeArgs[0];
  const value = deref(item);
  if (range.start !== undefined && (compareValues(type, range.start, value) ?? 1) > 0) return false;
  if (range.end === undefined) return true;
  const order = compareValues(type, value, range.end);
  if (order === undefined) return false;
  return range.inclusive ? order <= 0 : order < 0;
}

/** `T::from(value)` for the conversions of the standard library. */
export function convert(ctx: NativeContext, value: Value, from: Type, to: Type): Value {
  const source = normalize(shallow(from));
  const target = normalize(shallow(to));
  if (target.kind === 'float' && source.kind === 'bool') return deref(value) ? 1 : 0;
  if (target.kind === 'int' || target.kind === 'float' || target.kind === 'char')
    return castValue(deref(value), source, target);
  if (target.kind === 'adt') {
    switch (target.def.builtin) {
      case 'String': {
        return deref(value) as string;
      }
      case 'Vec': {
        const isText = typeof deref(value) === 'string';
        return isText
          ? Array.from(new TextEncoder().encode(deref(value) as string), BigInt)
          : [...sliceItems(deref(value))];
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

/** `Box<T>::from(value)`: a trait object of the value, or the value itself, which a box holds as it is. */
function boxValue(ctx: NativeContext, value: Value, source: Type, inner: Type): Value {
  if (inner.kind === 'dyn') {
    if (source.kind === 'ref' || (source.kind === 'adt' && source.def.builtin === 'String')) {
      return new DynValue(ctx.interp.program.builtinType('String'), deref(value) as string);
    }
    return new DynValue(source, value);
  }
  // A `Box<[T]>` owns a copy of the elements; a `Box<str>` is its text.
  if (inner.kind === 'slice') return [...sliceItems(deref(value))];
  if (inner.kind === 'str') return deref(value) as string;
  return value;
}

export { EnumValue, RustPanic };
