import { PANIC, panic } from '../arith';
import { Constant } from '../expressions';
import { arrayOf, BOOL, CONST_U8_SLICE, pointerTo, sliceOf, type StructType, type Type, U8 } from '../types';
import { markConstantStorage, Pointer, Slice, type Value, ZArray } from '../values';
import { allocating, elements, newSlice, OPTIONAL_USIZE, optionalIndex, ORDER, orderValue } from './common';
import { ALLOCATOR, allocatorState, ERROR_OUT_OF_MEMORY, reserveNativeAllocation } from './heap';
import { concreteFnMember, type Member, nativeStruct } from './native';
import { findSequence } from './sequenceSearch';

const isAlpha = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isUpper = (c: number): boolean => c >= 0x41 && c <= 0x5a;
const isLower = (c: number): boolean => c >= 0x61 && c <= 0x7a;
const isWhitespace = (c: number): boolean =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d;
const isPrint = (c: number): boolean => c >= 0x20 && c <= 0x7e;
const isControl = (c: number): boolean => c <= 0x1f || c === 0x7f;
const toUpper = (c: number): number => (isLower(c) ? c - 0x20 : c);
const toLower = (c: number): number => (isUpper(c) ? c + 0x20 : c);

function predicate(name: string, test: (c: number) => boolean): () => Member {
  return concreteFnMember(name, [U8], BOOL, ([value]) => test(Number(value as bigint)));
}

function mapper(name: string, map: (c: number) => number): () => Member {
  return concreteFnMember(name, [U8], U8, ([value]) => BigInt(map(Number(value as bigint))));
}

function bytes(value: Value): number[] {
  return elements(value).map((byte) => Number(byte as bigint));
}

function caseFold(a: Slice, b: Slice, spend: () => void, start = 0n, end = a.lengthValue): number {
  const length = end - start < b.lengthValue ? end - start : b.lengthValue;
  for (let index = 0n; index < length; index++) {
    spend();
    const x = toLower(Number(a.get(Number(start + index))));
    const y = toLower(Number(b.get(Number(index))));
    if (x !== y) return x < y ? -1 : 1;
  }
  return end - start < b.lengthValue ? -1 : end - start > b.lengthValue ? 1 : 0;
}

/** `upperString(output, ascii_string)`, which writes into output and returns the written part. */
function stringMapper(name: string, map: (c: number) => number): () => Member {
  return concreteFnMember(name, [sliceOf(U8, false), CONST_U8_SLICE], sliceOf(U8, false), ([out, value], frame) => {
    const source = value as Slice;
    const target = out as Slice;
    if (target.length < source.length) panic(PANIC.unreachable);
    for (let index = 0; index < source.length; index++) {
      frame.runtime.spend();
      target.set(index, BigInt(map(Number(source.get(index)))));
    }
    return new Slice(target.target, target.start, source.length);
  });
}

function allocMapper(name: string, map: (c: number) => number): () => Member {
  return concreteFnMember(
    name,
    [ALLOCATOR, CONST_U8_SLICE],
    allocating(sliceOf(U8, false)),
    ([allocator, input], frame) => {
      const complete = reserveNativeAllocation(frame, allocatorState(allocator), (input as Slice).length, U8);
      if (!complete) return ERROR_OUT_OF_MEMORY;
      frame.runtime.spend((input as Slice).length);
      const result = newSlice(bytes(input).map((byte) => BigInt(map(byte))));
      complete(result.target);
      return result;
    }
  );
}

function comparer(
  name: string,
  compute: (a: Slice, b: Slice, spend: (cost?: number) => void) => Value,
  resultType: Type = BOOL
): () => Member {
  return concreteFnMember(name, [CONST_U8_SLICE, CONST_U8_SLICE], resultType, ([x, y], frame) => {
    const spend = (cost?: number): void => frame.runtime.spend(cost);
    return compute(x as Slice, y as Slice, spend);
  });
}

function findIgnoreCase(text: Slice, pattern: Slice, spend: () => void): number {
  const found = findSequence(foldedSequence(text), foldedSequence(pattern), 0n, (a, b) => {
    spend();
    return a === b;
  });
  return found === undefined ? -1 : Number(found);
}

const foldedSequence = (values: Slice): { length: bigint; get: (index: bigint) => number } => ({
  length: values.lengthValue,
  get: (index) => toLower(Number(values.get(Number(index)))),
});

const MEMBERS: Record<string, () => Member> = {
  isAlphabetic: predicate('std.ascii.isAlphabetic', isAlpha),
  isDigit: predicate('std.ascii.isDigit', isDigit),
  isAlphanumeric: predicate('std.ascii.isAlphanumeric', (c) => isAlpha(c) || isDigit(c)),
  isUpper: predicate('std.ascii.isUpper', isUpper),
  isLower: predicate('std.ascii.isLower', isLower),
  isWhitespace: predicate('std.ascii.isWhitespace', isWhitespace),
  isPrint: predicate('std.ascii.isPrint', isPrint),
  isGraphical: predicate('std.ascii.isGraphical', (c) => isPrint(c) && c !== 0x20),
  isControl: predicate('std.ascii.isControl', isControl),
  isAscii: predicate('std.ascii.isAscii', (c) => c < 0x80),
  isHex: predicate('std.ascii.isHex', (c) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)),
  isPunctuation: predicate('std.ascii.isPunctuation', (c) => isPrint(c) && !isAlpha(c) && !isDigit(c) && c !== 0x20),
  toUpper: mapper('std.ascii.toUpper', toUpper),
  toLower: mapper('std.ascii.toLower', toLower),
  upperString: stringMapper('std.ascii.upperString', toUpper),
  lowerString: stringMapper('std.ascii.lowerString', toLower),
  allocUpperString: allocMapper('std.ascii.allocUpperString', toUpper),
  allocLowerString: allocMapper('std.ascii.allocLowerString', toLower),
  eqlIgnoreCase: comparer(
    'std.ascii.eqlIgnoreCase',
    (a, b, spend) => a.lengthValue === b.lengthValue && caseFold(a, b, spend) === 0
  ),
  startsWithIgnoreCase: comparer(
    'std.ascii.startsWithIgnoreCase',
    (a, b, spend) => b.lengthValue <= a.lengthValue && caseFold(a, b, spend, 0n, b.lengthValue) === 0
  ),
  endsWithIgnoreCase: comparer(
    'std.ascii.endsWithIgnoreCase',
    (a, b, spend) => b.lengthValue <= a.lengthValue && caseFold(a, b, spend, a.lengthValue - b.lengthValue) === 0
  ),
  lessThanIgnoreCase: comparer('std.ascii.lessThanIgnoreCase', (a, b, spend) => caseFold(a, b, spend) < 0),
  orderIgnoreCase: comparer('std.ascii.orderIgnoreCase', (a, b, spend) => orderValue(caseFold(a, b, spend)), ORDER),
  findIgnoreCase: comparer(
    'std.ascii.findIgnoreCase',
    (a, b, spend) => optionalIndex(findIgnoreCase(a, b, spend)),
    OPTIONAL_USIZE
  ),
  lowercase: () => stringConstant('abcdefghijklmnopqrstuvwxyz'),
  uppercase: () => stringConstant('ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
  letters: () => stringConstant('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'),
  whitespace: () => stringConstant(' \t\n\r\v\f'),
};

/** A string constant such as `std.ascii.lowercase`, typed as a string literal is: `*const [n:0]u8`. */
function stringConstant(text: string): Member {
  const bytes = [...text].map((char) => BigInt(char.codePointAt(0) as number));
  const storage = new Constant(new ZArray([...bytes, 0n], 0, bytes.length, true));
  markConstantStorage(storage);
  return {
    type: pointerTo(arrayOf(bytes.length, U8, 0n), true),
    value: new Pointer(storage, 0),
  };
}

let ascii: StructType | undefined;

export function asciiNamespace(): StructType {
  ascii ??= nativeStruct('std.ascii', MEMBERS);
  return ascii;
}
