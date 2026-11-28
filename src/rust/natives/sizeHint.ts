import { normalize } from '../infer';
import { intoIterShape } from '../iterTypes';
import { shallow, type Type } from '../types';
import { DynValue, isPlace, IterValue, type Value } from '../values';
import { deref, type NativeContext } from './support';

export const UNBOUNDED_SHAPES = new Set(['RangeFromShape', 'RepeatShape', 'RepeatWithShape']);

/** The shape of the iterator `size_hint` is asked of, through `&mut` and the value a `dyn Iterator` holds. */
export function sizeHintShape(
  ctx: NativeContext,
  value: Value,
  type: Type
): Extract<Type, { kind: 'adt' }> | undefined {
  let shape = normalize(shallow(intoIterShape(ctx.interp.program, type) ?? type));
  while (shape.kind === 'adt' && shape.def.name === 'ByRefShape') shape = normalize(shallow(shape.args[0]));
  if (shape.kind !== 'adt') return undefined;
  if (shape.def.name !== 'DynIteratorShape') return shape;
  let held = deref(value);
  while (isPlace(held)) held = deref(held.get());
  return held instanceof DynValue ? sizeHintShape(ctx, deref(held.value), held.type) : undefined;
}

/**
 * Whether the shape's count of what it has left is not its own: an adapter takes it from its source's, which an
 * unbounded source, a `cycle`, or a `dyn Iterator` inside it does not give.
 */
export function hidesCount(shape: Type): boolean {
  const t = normalize(shallow(shape));
  if (t.kind !== 'adt') return false;
  return COUNT_HIDING_SHAPES.has(t.def.name) || t.args.some((arg) => hidesCount(arg));
}

const COUNT_HIDING_SHAPES = new Set([...UNBOUNDED_SHAPES, 'CycleShape', 'DynIteratorShape', 'IntoShape']);

/** Whether an iterator and every iterator it draws from know how many they have left, which an adapter's count adds up. */
export function countsWhatIsLeft(iter: IterValue): boolean {
  if (!iter.remaining) return false;
  const drawnFrom = [...iter.roots, ...Object.values(iter.adapterState ?? {})];
  return drawnFrom.every((root) => !(root instanceof IterValue) || countsWhatIsLeft(root));
}
