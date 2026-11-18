import { TURTLE_METHOD_NAMES, type TurtleState } from '../../interpreter/turtleWorld';
import { DEFAULT_SPEC } from '../fmt';
import { normalize } from '../infer';
import { fieldTypes } from '../interpreter';
import { castValue, cloneValue, compareValues, valuesEqual } from '../ops';
import { FmtFailure, ProcessExit, RustPanic } from '../runtime';
import { shallow, substitute as substituteType, type Type } from '../types';
import {
  DynValue,
  EnumValue,
  type FormatterValue,
  MapValue,
  type RangeValue,
  SetValue,
  StructValue,
  type TurtleValue,
  UNIT_VALUE,
  type Value,
} from '../values';
import { collectInto } from './iterators';
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
 * A type's size and alignment as rustc lays it out on a 64-bit target: primitives, pointers (references, `Box`), `String`
 * and `Vec` (three words), arrays, and tuples and structs, whose fields rustc reorders so that only the end pads.
 * `Option` of a reference or a `Box` uses the null pointer, and other enums are a tag before their largest variant.
 */
function layoutOf(ctx: NativeContext, type: Type): { size: number; align: number } {
  const t = normalize(shallow(type));
  switch (t.kind) {
    case 'int': {
      return scalar(t.name === 'isize' || t.name === 'usize' ? 8 : Number(t.name.slice(1)) / 8);
    }
    case 'float': {
      return scalar(t.name === 'f32' ? 4 : 8);
    }
    case 'bool': {
      return scalar(1);
    }
    case 'char': {
      return scalar(4);
    }
    case 'ref': {
      const target = normalize(shallow(t.target));
      return { size: target.kind === 'str' || target.kind === 'slice' || target.kind === 'dyn' ? 16 : 8, align: 8 };
    }
    case 'array': {
      const elem = layoutOf(ctx, t.elem);
      return { size: elem.size * t.len, align: elem.align };
    }
    case 'tuple': {
      return aggregateLayout(t.elems.map((elem) => layoutOf(ctx, elem)));
    }
    case 'adt': {
      return adtLayout(ctx, t);
    }
    default: {
      return scalar(0);
    }
  }
}

function scalar(size: number): { size: number; align: number } {
  return { size, align: size || 1 };
}

function adtLayout(ctx: NativeContext, t: Type & { kind: 'adt' }): { size: number; align: number } {
  const builtin = t.def.builtin as string | undefined;
  if (builtin === 'String' || builtin === 'Vec') return { size: 24, align: 8 };
  if (builtin === 'Box') return layoutOf(ctx, { kind: 'ref', mutable: false, target: t.args[0] });
  const variants = t.def.variants.map((variant, index) =>
    aggregateLayout(fieldTypes(t.def, t.args, index).map((field) => layoutOf(ctx, field)))
  );
  if (t.def.kind === 'struct') return variants[0] ?? { size: 0, align: 1 };
  if (builtin === 'Option') {
    const inner = normalize(shallow(t.args[0]));
    const pointer = inner.kind === 'ref' || (inner.kind === 'adt' && inner.def.builtin === 'Box');
    if (pointer) return layoutOf(ctx, inner);
  }
  if (variants.every((variant) => variant.size === 0)) return { size: variants.length > 1 ? 1 : 0, align: 1 };
  const align = Math.max(1, ...variants.map((variant) => variant.align));
  const largest = Math.max(...variants.map((variant) => variant.size));
  return { size: Math.ceil((align + largest) / align) * align, align };
}

function aggregateLayout(fields: { size: number; align: number }[]): { size: number; align: number } {
  const align = Math.max(1, ...fields.map((field) => field.align));
  const size = fields.reduce((sum, field) => sum + field.size, 0);
  return { size: Math.ceil(size / align) * align, align };
}

function selfType(ctx: NativeContext): Type {
  return ctx.typeArgs[0];
}

/** The default value of a type, as `Default::default` gives it. */
// code-gauge-allow functionNcss 48 -- One native per method of the standard library.
export function defaultValue(ctx: NativeContext, type: Type): Value {
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
      return t.elems.map((elem) => defaultValue(ctx, elem));
    }
    case 'array': {
      return Array.from({ length: t.len }, () => defaultValue(ctx, t.elem));
    }
    case 'ref': {
      return '';
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
          return new MapValue(t.def.builtin === 'BTreeMap');
        }
        case 'HashSet':
        case 'BTreeSet': {
          return new SetValue(t.def.builtin === 'BTreeSet');
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
      const fields = t.def.variants[0].fields.map((field) => {
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
  'ToString::to_string': ([self], ctx) => {
    try {
      return ctx.interp.formatter.display(self, selfType(ctx), DEFAULT_SPEC);
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
  'AsRef::as_ref': ([self]) => deref(self),
  'std::mem::size_of': (_args, ctx) => BigInt(layoutOf(ctx, ctx.typeArgs[0]).size),
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
// code-gauge-allow functionCognitiveComplexity 28 -- One native per method of the standard library.
// code-gauge-allow functionNcss 36 -- One native per method of the standard library.
export function convert(ctx: NativeContext, value: Value, from: Type, to: Type): Value {
  const source = normalize(shallow(from));
  const target = normalize(shallow(to));
  if (target.kind === 'int' || target.kind === 'float' || target.kind === 'char')
    return castValue(deref(value), source, target);
  if (target.kind === 'adt') {
    switch (target.def.builtin) {
      case 'String': {
        return deref(value) as string;
      }
      case 'Vec': {
        if (source.kind === 'adt' && source.def.builtin === 'String') {
          return Array.from(new TextEncoder().encode(value as string), BigInt);
        }
        if (source.kind === 'ref' && shallow(source.target).kind === 'str') {
          return Array.from(new TextEncoder().encode(deref(value) as string), BigInt);
        }
        const items = deref(value);
        return Array.isArray(items)
          ? [...items]
          : (items as { base: Value[]; start: number; end: number }).base.slice(
              (items as { start: number }).start,
              (items as { end: number }).end
            );
      }
      case 'Option': {
        return some(ctx, value);
      }
      case 'Box': {
        const inner = normalize(shallow(target.args[0]));
        if (inner.kind === 'dyn') {
          if (source.kind === 'ref' || (source.kind === 'adt' && source.def.builtin === 'String')) {
            return new DynValue(ctx.interp.program.builtinType('String'), deref(value) as string);
          }
          return new DynValue(source, value);
        }
        return value;
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

export { EnumValue, RustPanic };
