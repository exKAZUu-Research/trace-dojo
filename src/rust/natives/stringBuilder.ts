import { stringByteLength, stringCapacity, StringGrowth } from '../capacity';
import { normalize } from '../infer';
import { shallow, type Type } from '../types';
import { DONE, type IterValue, type StringValue, textOf, type Value } from '../values';
import { checkVecCapacity } from './capacityNatives';
import { iteratorLowerBound, nextForFold, nextOf } from './iterators';
import type { NativeContext } from './support';

export function collectString(ctx: NativeContext, iter: IterValue, item: Type, shape?: Type): Value {
  const t = normalize(shallow(item));
  const first = t.kind === 'adt' && t.def.builtin === 'String' ? nextOf(iter) : '';
  return first === DONE ? '' : extendString(ctx, first, iter, item, shape);
}

export function extendString(
  ctx: NativeContext,
  initial: Value,
  iter: IterValue,
  item: Type,
  shape?: Type
): StringValue {
  let text = textOf(initial);
  const bytes = stringByteLength(initial);
  const growth = new StringGrowth(stringCapacity(initial), bytes);
  const t = normalize(shallow(item));
  if (shape && (t.kind === 'char' || (t.kind === 'ref' && shallow(t.target).kind === 'char'))) {
    const lower = iteratorLowerBound(iter, shape);
    checkVecCapacity(ctx, bytes, lower, 1);
    growth.reserve(Number(lower));
  }
  for (;;) {
    ctx.runtime.spend();
    const value = nextForFold(iter);
    if (value === DONE) return growth.finish(text);
    const piece = textOf(value);
    growth.write(piece, stringByteLength(value));
    text = appendText(ctx, text, piece);
  }
}

export function appendText(ctx: NativeContext, text: string, piece: string): string {
  ctx.runtime.allocateString(text.length + piece.length, piece.length);
  return text + piece;
}
