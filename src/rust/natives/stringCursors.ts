import { fieldsPart, listPart, numberPart, tuplePart } from '../iterDebug';
import { CHAR } from '../types';
import { utf8Length } from '../utf8';
import { DONE, IterValue, type Next, type Value } from '../values';

const encoder = new TextEncoder();

export function finalScalarStart(text: string, end = text.length): number {
  const previous = text.codePointAt(end - 2) ?? 0;
  return end - (previous > 0xff_ff ? 2 : 1);
}

export function charCursor(
  text: string,
  indexed = false,
  front = 0,
  back = text.length,
  frontOffset = 0,
  backOffset?: number
): IterValue {
  const next = (): Next => {
    if (front >= back) return DONE;
    const char = String.fromCodePoint(text.codePointAt(front)!);
    front += char.length;
    if (!indexed) return char;
    const offset = frontOffset;
    frontOffset += utf8Length(char);
    return [BigInt(offset), char];
  };
  const nextBack = (): Next => {
    if (front >= back) return DONE;
    const start = finalScalarStart(text, back);
    const char = text.slice(start, back);
    if (indexed) backOffset = (backOffset ?? frontOffset + utf8Length(text.slice(front, back))) - utf8Length(char);
    back = start;
    return backOffset === undefined ? char : [BigInt(backOffset), char];
  };
  const iter = new IterValue(next, nextBack);
  iter.fork = () => charCursor(text, indexed, front, back, frontOffset, backOffset);
  iter.rest = () => remaining(iter.fork!());
  iter.remainingTextBytes = () => utf8Length(text.slice(front, back));
  if (indexed) {
    iter.debug = (show) =>
      fieldsPart('CharIndices', [
        ['front_offset', numberPart(frontOffset)],
        [
          'iter',
          tuplePart('Chars', [
            listPart(
              (iter.rest!() as [bigint, string][]).map(([, char]) => char),
              CHAR,
              show
            ),
          ]),
        ],
      ]);
  }
  return iter;
}

interface ByteCursorState {
  front: number[];
  back: number[];
  remaining?: number;
}

export function byteCursor(text: string): IterValue {
  return utf8Cursor(charCursor(text), { front: [], back: [] });
}

function utf8Cursor(chars: IterValue, state: ByteCursorState): IterValue {
  const step = (reverse: boolean): Next => {
    const byte = takeByte(chars, state, reverse);
    if (byte !== DONE && state.remaining !== undefined) state.remaining--;
    return byte;
  };
  const length = (): number =>
    (state.remaining ??= chars.remainingTextBytes!() + state.front.length + state.back.length);
  const iter = new IterValue(
    () => step(false),
    () => step(true),
    length
  );
  iter.fork = () => utf8Cursor(chars.fork!(), { ...state, front: [...state.front], back: [...state.back] });
  iter.rest = () => remaining(iter.fork!());
  return iter;
}

// code-gauge-allow functionCognitiveComplexity -- The two directions take from opposite pending byte buffers.
function takeByte(chars: IterValue, state: ByteCursorState, reverse: boolean): Next {
  const local = reverse ? state.back : state.front;
  if (local.length === 0) {
    const item = reverse ? chars.nextBack!() : chars.next();
    if (item === DONE) {
      const opposite = reverse ? state.front : state.back;
      const byte = reverse ? opposite.pop() : opposite.shift();
      return byte === undefined ? DONE : BigInt(byte);
    }
    for (const byte of encoder.encode(item as string)) local.push(byte);
  }
  return BigInt((reverse ? local.pop() : local.shift())!);
}

function remaining(iter: IterValue): Value[] {
  const items: Value[] = [];
  for (let value = iter.next(); value !== DONE; value = iter.next()) items.push(value);
  return items;
}
