import { changeString, keepVecCapacity, reserveVec } from '../capacity';
import { normalize } from '../infer';
import { cloneValue } from '../ops';
import { shallow, type Type } from '../types';
import { ElementPlace, type Place, type Value } from '../values';
import { checkVecCapacity } from './capacityNatives';
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
  if (t.kind === 'adt' && t.def.builtin === 'String') {
    changeString(target, () => target.set(value));
  } else if (t.kind === 'adt' && t.def.builtin === 'Vec') {
    cloneVecInto(ctx, t.args[0], deref(target) as Value[], value as Value[]);
  } else {
    target.set(cloneValue(t, value));
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
