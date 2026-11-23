import { changeString, keepVecCapacity, reserveVec } from '../capacity';
import { normalize } from '../infer';
import { cloneValue } from '../ops';
import { shallow, substitute, type Type } from '../types';
import {
  AccessorPlace,
  ElementPlace,
  type EnumValue,
  type Place,
  sliceGet,
  sliceLength,
  sliceSet,
  type Value,
} from '../values';
import { checkVecCapacity } from './capacityNatives';
import { resetDequeHead } from './dequeHead';
import { sizeOf } from './layout';
import { deref, type NativeContext } from './support';

export function cloneInto(ctx: NativeContext, type: Type, target: Place, source: Value): void {
  const { interp, span, frame } = ctx;
  const method = interp.program.traitDef('Clone').methods.get('clone_from')!;
  interp.callFn(method, [type], [target, source], undefined, span, frame);
}

export function cloneFromDefault(ctx: NativeContext, type: Type, target: Place, source: Value): void {
  const t = normalize(shallow(type));
  const value = deref(source);
  if (t.kind === 'array') {
    cloneSliceInto(ctx, t.elem, deref(target), value);
    return;
  }
  if (t.kind === 'adt' && cloneBuiltin(ctx, t, target, value)) return;
  target.set(cloneValue(t, value));
}

function cloneBuiltin(ctx: NativeContext, type: Extract<Type, { kind: 'adt' }>, target: Place, value: Value): boolean {
  const [inner] = type.args;
  switch (type.def.builtin) {
    case 'String': {
      changeString(target, () => target.set(value));
      return true;
    }
    case 'Vec':
    case 'BinaryHeap': {
      cloneVecInto(ctx, inner, deref(target) as Value[], value as Value[]);
      return true;
    }
    case 'VecDeque': {
      const items = deref(target) as Value[];
      keepVecCapacity(items, items.length);
      items.length = 0;
      resetDequeHead(items);
      cloneVecInto(ctx, inner, items, value as Value[]);
      return true;
    }
    case 'Box': {
      cloneBoxInto(ctx, inner, target, value);
      return true;
    }
    case 'Option':
    case 'Result': {
      return cloneEnumInto(ctx, type, deref(target) as EnumValue, value as EnumValue);
    }
    default: {
      return false;
    }
  }
}

function cloneBoxInto(ctx: NativeContext, inner: Type, target: Place, source: Value): void {
  const content = normalize(shallow(inner));
  const previous = deref(target);
  if (content.kind !== 'slice') cloneInto(ctx, inner, target, source);
  else if (sliceLength(previous) === sliceLength(source)) cloneSliceInto(ctx, content.elem, previous, source);
  else target.set(cloneValue(content, source));
}

function cloneEnumInto(
  ctx: NativeContext,
  type: Extract<Type, { kind: 'adt' }>,
  target: EnumValue,
  source: EnumValue
): boolean {
  if (target.variant !== source.variant) return false;
  const subst = new Map(type.def.params.map((param, index) => [param, type.args[index]]));
  for (const [index, field] of type.def.variants[source.variant].fields.entries()) {
    cloneInto(ctx, substitute(field.type, subst), new ElementPlace(target.fields, index), source.fields[index]);
  }
  return true;
}

function cloneSliceInto(ctx: NativeContext, elem: Type, target: Value, source: Value): void {
  const length = sliceLength(source);
  for (let index = 0; index < length; index++) {
    ctx.runtime.spend();
    const place = new AccessorPlace(
      () => sliceGet(target, index),
      (item) => sliceSet(target, index, item)
    );
    cloneInto(ctx, elem, place, sliceGet(source, index));
  }
}

function cloneVecInto(ctx: NativeContext, elem: Type, target: Value[], source: Value[]): void {
  keepVecCapacity(target, target.length);
  target.length = Math.min(target.length, source.length);
  for (const [index] of target.entries()) cloneInto(ctx, elem, new ElementPlace(target, index), source[index]);
  const extra = source.length - target.length;
  const size = sizeOf(elem);
  checkVecCapacity(ctx, target.length, BigInt(extra), size);
  reserveVec(target, target.length, extra, size);
  ctx.runtime.allocate(extra);
  for (let index = target.length; index < source.length; index++) {
    ctx.runtime.spend();
    target.push(cloneValue(elem, source[index]));
  }
}
