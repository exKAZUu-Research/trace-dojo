import { concatStrings } from '../capacity';
import { floatNumber, negateFloat } from '../floatBits';
import { normalize } from '../infer';
import { floatArith, intArith, overflow, wrap } from '../ops';
import { type IntName, shallow, type Type, typeToString } from '../types';
import {
  ElementPlace,
  isPlace,
  MapValue,
  type Place,
  sliceBase,
  sliceLength,
  SliceView,
  textOf,
  UNIT_VALUE,
  type Value,
} from '../values';
import { define, deref, type NativeContext, panic } from './support';

/** The methods of the operator traits for numbers, `bool`, and `String`, which generic code and calls like `a.add(b)` reach. */
const BINARY: Record<string, string> = {
  Add: '+',
  Sub: '-',
  Mul: '*',
  Div: '/',
  Rem: '%',
  BitAnd: '&',
  BitOr: '|',
  BitXor: '^',
  Shl: '<<',
  Shr: '>>',
};

/** The number type of an operand, through a reference. */
function operandType(type: Type): Type {
  const t = normalize(shallow(type));
  return t.kind === 'ref' ? normalize(shallow(t.target)) : t;
}

function apply(op: string, type: Type, left: Value, right: Value, ctx: NativeContext): Value {
  const a = deref(left);
  const b = deref(right);
  if (type.kind === 'adt') {
    const addition = textOf(b);
    ctx.runtime.allocateString(textOf(a).length + addition.length, addition.length);
    return concatStrings(a, addition);
  }
  if (type.kind === 'bool') {
    if (op === '&') return (a as boolean) && (b as boolean);
    return op === '|' ? (a as boolean) || (b as boolean) : a !== b;
  }
  if (type.kind === 'float') return floatArith(op, floatNumber(a), floatNumber(b), type.name === 'f32');
  if (type.kind !== 'int') throw new Error('An operator trait on an unexpected type');
  return intArith(op, type.name, a as bigint, b as bigint, ctx.span);
}

const natives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  'Neg::neg': ([value], ctx) => {
    const type = operandType(ctx.typeArgs[0]);
    const operand = deref(value);
    if (type.kind === 'float') return negateFloat(operand);
    const name = (type as { name: IntName }).name;
    const negated = -(operand as bigint);
    if (negated !== wrap(name, negated)) overflow('neg', ctx.span);
    return negated;
  },
  'Not::not': ([value], ctx) => {
    const type = operandType(ctx.typeArgs[0]);
    const operand = deref(value);
    if (type.kind === 'bool') return !operand;
    const name = (type as { name: string }).name;
    const bits = name === 'isize' || name === 'usize' ? 64 : Number(name.slice(1));
    return name.startsWith('u') ? BigInt.asUintN(bits, ~(operand as bigint)) : ~(operand as bigint);
  },
};
for (const [trait, op] of Object.entries(BINARY)) {
  const method = trait.toLowerCase();
  natives[`${trait}::${method}`] = ([left, right], ctx) => apply(op, operandType(ctx.typeArgs[0]), left, right, ctx);
  natives[`${trait}Assign::${method}_assign`] = ([target, right], ctx) => {
    const place = target as Place;
    if (!isPlace(place)) throw new Error('An assignment operator without a place');
    place.set(apply(op, operandType(ctx.typeArgs[0]), place.get(), right, ctx));
    return UNIT_VALUE;
  };
}
define(natives);

/** `Index::index` and `IndexMut::index_mut` of the sequences std implements them for, which generic code reaches. */
function indexedPlace(self: Value, index: Value, ctx: NativeContext): Place {
  const container = deref(self);
  if (container instanceof MapValue) {
    // `Index<&K>` of a map, whose key type is the index's target.
    const entry = container.entries.get(container.entries.key(operandType(ctx.typeArgs[1]), deref(index)));
    if (!entry) panic(ctx, 'no entry found for key');
    return new ElementPlace(entry, 1);
  }
  if (!Array.isArray(container) && !(container instanceof SliceView)) {
    return panic(
      ctx,
      `${typeToString(operandType(ctx.typeArgs[0]))} の添字（Index の境界を通したもの）は、この採点環境では使えません。`
    );
  }
  const length = sliceLength(container);
  const position = deref(index) as bigint;
  if (position >= length) panic(ctx, `index out of bounds: the len is ${length} but the index is ${position}`);
  const { base, start } = sliceBase(container);
  return new ElementPlace(base, start + Number(position));
}

define({
  'Index::index': ([self, index], ctx) => indexedPlace(self, index, ctx).get(),
  'IndexMut::index_mut': ([self, index], ctx) => indexedPlace(self, index, ctx),
});
