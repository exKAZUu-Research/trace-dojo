import { PANIC, panic } from '../arith';
import { Constant } from '../expressions';
import { arrayOf, BOOL, CONST_U8_SLICE, pointerTo, sliceOf, type StructType, type Type, U8 } from '../types';
import { isUndefinedMemory, markConstantStorage, Pointer, Slice, storageLocation, type Value, ZArray } from '../values';
import { allocating, OPTIONAL_USIZE, optionalIndex, ORDER, orderValue } from './common';
import { ALLOCATOR, allocatorState, ERROR_OUT_OF_MEMORY, reserveNativeAllocation } from './heap';
import { concreteFnMember, type Member, nativeStruct } from './native';
import { findSequence, type SearchSequence } from './sequenceSearch';

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

function caseFold(a: FoldedBytes, b: FoldedBytes, spend: () => void, start = 0n, end = a.length): number {
  const available = end - start;
  if (a.sameWindow(b, start, available)) return 0;
  const length = available < b.length ? available : b.length;
  for (let index = 0n; index < length; index++) {
    spend();
    const x = a.get(start + index);
    const y = b.get(index);
    if (x !== y) return x < y ? -1 : 1;
  }
  return available < b.length ? -1 : available > b.length ? 1 : 0;
}

/** `upperString(output, ascii_string)`, which writes into output and returns the written part. */
function stringMapper(name: string, map: (c: number) => number): () => Member {
  return concreteFnMember(name, [sliceOf(U8, false), CONST_U8_SLICE], sliceOf(U8, false), ([out, value], frame) => {
    const source = value as Slice;
    const target = out as Slice;
    if (target.length < source.length) panic(PANIC.unreachable);
    for (let index = 0; index < source.length; index++) {
      frame.runtime.spend(2);
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
      const source = input as Slice;
      frame.runtime.spend(source.length * 2);
      const storage = new ZArray(
        Array.from({ length: source.length }, (_, index) => BigInt(map(Number(source.get(index)))))
      );
      const result = new Slice(storage, 0, source.length);
      complete(result.target);
      return result;
    }
  );
}

function comparer(
  name: string,
  compute: (a: FoldedBytes, b: FoldedBytes, spend: () => void) => Value,
  resultType: Type = BOOL
): () => Member {
  return concreteFnMember(name, [CONST_U8_SLICE, CONST_U8_SLICE], resultType, ([x, y], frame) => {
    const spend = (): void => frame.runtime.spend();
    return compute(new FoldedBytes(x as Slice, spend), new FoldedBytes(y as Slice, spend), spend);
  });
}

function findIgnoreCase(text: SearchSequence<number>, pattern: SearchSequence<number>, spend: () => void): number {
  const found = findSequence(text, pattern, 0n, (a, b) => {
    spend();
    return a === b;
  });
  return found === undefined ? -1 : Number(found);
}

class FoldedBytes implements SearchSequence<number> {
  readonly length: bigint;

  constructor(
    private readonly slice: Slice,
    private readonly spend: () => void
  ) {
    this.length = slice.lengthValue;
  }

  get(index: bigint): number {
    this.spend();
    return toLower(Number(this.slice.get(Number(index))));
  }

  sameRange(other: SearchSequence<number>): boolean {
    return other instanceof FoldedBytes && this.sameWindow(other, 0n, this.length);
  }

  sameWindow(other: FoldedBytes, start: bigint, length: bigint): boolean {
    if (length !== other.length) return false;
    if (length === 0n) return true;
    const left = this.location(start, length);
    const right = other.location(0n, length);
    return left !== undefined && left.storage === right?.storage && left.index === right.index;
  }

  private location(start: bigint, length: bigint): ReturnType<typeof storageLocation> | undefined {
    const index = this.slice.start + Number(start);
    const slots = this.slice.target.slots;
    if (this.slice.undefinedHeader || index < 0 || index + Number(length) > slots.length) return undefined;
    if (isUndefinedMemory(this.slice)) return undefined;
    return storageLocation(slots, index);
  }
}

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
    (a, b, spend) => a.length === b.length && caseFold(a, b, spend) === 0
  ),
  startsWithIgnoreCase: comparer(
    'std.ascii.startsWithIgnoreCase',
    (a, b, spend) => b.length <= a.length && caseFold(a, b, spend, 0n, b.length) === 0
  ),
  endsWithIgnoreCase: comparer(
    'std.ascii.endsWithIgnoreCase',
    (a, b, spend) => b.length <= a.length && caseFold(a, b, spend, a.length - b.length) === 0
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
  whitespace: () => ({ type: arrayOf(6, U8), value: new ZArray([32n, 9n, 10n, 13n, 11n, 12n]) }),
};

/** A string constant such as `std.ascii.lowercase`, typed as a string literal is: `*const [n:0]u8`. */
function stringConstant(text: string): Member {
  const bytes = [...text].map((char) => BigInt(char.codePointAt(0) as number));
  const storage = new Constant(new ZArray([...bytes, 0n], 0, bytes.length, true));
  const type = arrayOf(bytes.length, U8, 0n);
  markConstantStorage(storage, type);
  return {
    type: pointerTo(type, true),
    value: new Pointer(storage, 0),
  };
}

let ascii: StructType | undefined;

export function asciiNamespace(): StructType {
  ascii ??= nativeStruct('std.ascii', MEMBERS);
  return ascii;
}
