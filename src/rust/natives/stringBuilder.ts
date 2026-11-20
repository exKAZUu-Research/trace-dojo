import { stringByteLength, stringCapacity, StringGrowth } from '../capacity';
import { normalize } from '../infer';
import { iteratorCapability } from '../traits';
import { shallow, type Type } from '../types';
import { DONE, IterValue, type StringValue, textOf, type Value } from '../values';
import { checkVecCapacity } from './capacityNatives';
import { lengthOf, nextForFold, nextOf } from './iterators';
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
    const lower = lowerHint(iter, shape);
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

function lowerHint(iter: IterValue, shape: Type): bigint {
  if (iteratorCapability(shape, 'exact') === 'yes') return lengthOf(iter);
  const t = normalize(shallow(shape));
  if (t.kind !== 'adt') return 0n;
  if (t.def.name === 'CharsShape') {
    const bytes = (iter.rest?.() ?? []).reduce<number>((sum, char) => sum + stringByteLength(char), 0);
    return BigInt(Math.ceil(bytes / 4));
  }
  if (['RangeShape', 'RangeInclusiveShape'].includes(t.def.name)) return lengthOf(iter);
  const source = iter.roots[0];
  if (source instanceof IterValue && PRESERVES_LOWER_HINT.has(t.def.name)) return lowerHint(source, t.args[0]);
  return 0n;
}

const PRESERVES_LOWER_HINT = new Set([
  'MapShape',
  'InspectShape',
  'RevShape',
  'EnumerateShape',
  'CopiedShape',
  'ClonedShape',
]);
