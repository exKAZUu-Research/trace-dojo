import { PANIC, panic } from '../arith';
import { Constant } from '../expressions';
import { arrayOf, BOOL, pointerTo, sliceOf, type StructType, type Type, U8 } from '../types';
import { markConstantStorage, Pointer, type Slice, type Value, ZArray } from '../values';
import {
  allocating,
  allocatorArg,
  computed,
  constSlice,
  elements,
  mutableSlice,
  newSlice,
  OPTIONAL_USIZE,
  optionalIndex,
  ORDER,
  orderValue,
} from './common';
import { allocatorState, ERROR_OUT_OF_MEMORY, reserveNativeAllocation } from './heap';
import { compileArgs, expectArgs, fnMember, type Member, nativeCall, nativeStruct } from './native';

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
  return fnMember(name, (sema, call) => {
    const [c] = compileArgs(sema, expectArgs(sema, call, 1, name), [U8]);
    return computed(BOOL, [c], call.span, ([value]) => test(Number(value as bigint)));
  });
}

function mapper(name: string, map: (c: number) => number): () => Member {
  return fnMember(name, (sema, call) => {
    const [c] = compileArgs(sema, expectArgs(sema, call, 1, name), [U8]);
    return computed(U8, [c], call.span, ([value]) => BigInt(map(Number(value as bigint))));
  });
}

function bytes(value: Value): number[] {
  return elements(value).map((byte) => Number(byte as bigint));
}

function caseFold(a: number[], b: number[], spend: () => void, start = 0, end = a.length): number {
  const length = Math.min(end - start, b.length);
  for (let index = 0; index < length; index++) {
    spend();
    const x = toLower(a[start + index]);
    const y = toLower(b[index]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return end - start - b.length;
}

/** `upperString(output, ascii_string)`, which writes into output and returns the written part. */
function stringMapper(name: string, map: (c: number) => number): () => Member {
  return fnMember(name, (sema, call) => {
    const [outArg, inArg] = expectArgs(sema, call, 2, name);
    const output = mutableSlice(sema, outArg, U8);
    const input = constSlice(sema, inArg, U8);
    return computed(sliceOf(U8, false), [output, input], call.span, ([out, value]) => {
      const source = bytes(value);
      const target = out as Slice;
      // `std.debug.assert(output.len >= ascii_string.len)`.
      if (target.length < source.length) panic(PANIC.unreachable);
      for (const [index, byte] of source.entries()) target.set(index, BigInt(map(byte)));
      return new (target.constructor as typeof Slice)(target.target, target.start, source.length);
    });
  });
}

function allocMapper(name: string, map: (c: number) => number): () => Member {
  return fnMember(name, (sema, call) => {
    const [allocatorArgument, inArg] = expectArgs(sema, call, 2, name);
    const allocator = allocatorArg(sema, allocatorArgument);
    const input = constSlice(sema, inArg, U8);
    return nativeCall(allocating(sliceOf(U8, false)), [allocator, input], call.span, ([allocator, input], frame) => {
      const complete = reserveNativeAllocation(frame, allocatorState(allocator), (input as Slice).length, U8);
      if (!complete) return ERROR_OUT_OF_MEMORY;
      const result = newSlice(bytes(input).map((byte) => BigInt(map(byte))));
      complete(result.target);
      return result;
    });
  });
}

function comparer(
  name: string,
  compute: (a: number[], b: number[], spend: (cost?: number) => void) => Value,
  resultType: Type = BOOL
): () => Member {
  return fnMember(name, (sema, call) => {
    const [aArg, bArg] = expectArgs(sema, call, 2, name);
    const a = constSlice(sema, aArg, U8);
    const b = constSlice(sema, bArg, U8);
    return computed(resultType, [a, b], call.span, ([x, y], frame) => {
      const spend = (cost = 1): void => {
        if (frame) frame.runtime.spend(cost);
        else sema.spendCompilation(cost);
      };
      const left = bytes(x);
      const right = bytes(y);
      spend(left.length + right.length);
      return compute(left, right, spend);
    });
  });
}

function findIgnoreCase(text: number[], pattern: number[], spend: () => void): number {
  if (pattern.length === 0) return 0;
  const prefix = new Uint32Array(pattern.length);
  let matched = 0;
  for (let index = 1; index < pattern.length;) {
    spend();
    if (toLower(pattern[index]) === toLower(pattern[matched])) prefix[index++] = ++matched;
    else if (matched > 0) matched = prefix[matched - 1];
    else index++;
  }
  matched = 0;
  for (let index = 0; index < text.length;) {
    spend();
    if (toLower(text[index]) === toLower(pattern[matched])) {
      index++;
      if (++matched === pattern.length) return index - matched;
    } else if (matched > 0) matched = prefix[matched - 1];
    else index++;
  }
  return -1;
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
    (a, b, spend) => b.length <= a.length && caseFold(a, b, spend, 0, b.length) === 0
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
