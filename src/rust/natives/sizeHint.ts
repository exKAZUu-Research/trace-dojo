import { normalize } from '../infer';
import { intoIterShape } from '../iterTypes';
import { shallow, type Type } from '../types';
import { DynValue, type Value } from '../values';
import { deref, type NativeContext } from './support';

export const UNBOUNDED_SHAPES = new Set(['RangeFromShape', 'RepeatShape', 'RepeatWithShape']);

/** The shape of the iterator `size_hint` is asked of, through `&mut` and the value a `dyn Iterator` holds. */
export function sizeHintShape(
  ctx: NativeContext,
  value: Value,
  type: Type
): Extract<Type, { kind: 'adt' }> | undefined {
  const shape = normalize(shallow(intoIterShape(ctx.interp.program, type) ?? type));
  if (shape.kind !== 'adt') return undefined;
  if (shape.def.name === 'ByRefShape') return sizeHintShapeOf(shape.args[0]);
  if (shape.def.name !== 'DynIteratorShape') return shape;
  const held = deref(value);
  return held instanceof DynValue ? sizeHintShape(ctx, deref(held.value), held.type) : undefined;
}

function sizeHintShapeOf(type: Type): Extract<Type, { kind: 'adt' }> | undefined {
  const shape = normalize(shallow(type));
  if (shape.kind !== 'adt') return undefined;
  return shape.def.name === 'ByRefShape' ? sizeHintShapeOf(shape.args[0]) : shape;
}

export function reachesUnbounded(shape: Type): boolean {
  const t = normalize(shallow(shape));
  if (t.kind !== 'adt') return false;
  return UNBOUNDED_SHAPES.has(t.def.name) || t.args.some((arg) => reachesUnbounded(arg));
}
