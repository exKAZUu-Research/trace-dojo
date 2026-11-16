import { PANIC, panic } from '../arith';
import { Constant } from '../expressions';
import { runtime } from '../semaBase';
import { arrayOf, BOOL, CONST_U8_SLICE, pointerTo, sliceOf, type StructType, type Type, U8 } from '../types';
import { Pointer, type Slice, type Value, ZArray } from '../values';
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
import { ERROR_OUT_OF_MEMORY } from './heap';
import { compileArgs, expectArgs, fnMember, type Member, nativeStruct } from './native';

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

function caseFold(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const x = toLower(a[index]);
    const y = toLower(b[index]);
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
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
    const evaluate = input.eval;
    return runtime(
      allocating(sliceOf(U8, false)),
      (frame) => {
        allocator.eval(frame);
        const source = bytes(evaluate(frame));
        if (!frame.runtime.canAllocate(source.length)) return ERROR_OUT_OF_MEMORY;
        frame.runtime.allocate(source.length);
        return newSlice(source.map((byte) => BigInt(map(byte))));
      },
      call.span
    );
  });
}

function comparer(name: string, compute: (a: number[], b: number[]) => Value, resultType: Type = BOOL): () => Member {
  return fnMember(name, (sema, call) => {
    const [aArg, bArg] = expectArgs(sema, call, 2, name);
    const a = constSlice(sema, aArg, U8);
    const b = constSlice(sema, bArg, U8);
    return computed(resultType, [a, b], call.span, ([x, y]) => compute(bytes(x), bytes(y)));
  });
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
  eqlIgnoreCase: comparer('std.ascii.eqlIgnoreCase', (a, b) => a.length === b.length && caseFold(a, b) === 0),
  startsWithIgnoreCase: comparer(
    'std.ascii.startsWithIgnoreCase',
    (a, b) => b.length <= a.length && caseFold(a.slice(0, b.length), b) === 0
  ),
  endsWithIgnoreCase: comparer(
    'std.ascii.endsWithIgnoreCase',
    (a, b) => b.length <= a.length && caseFold(a.slice(a.length - b.length), b) === 0
  ),
  lessThanIgnoreCase: comparer('std.ascii.lessThanIgnoreCase', (a, b) => caseFold(a, b) < 0),
  orderIgnoreCase: comparer('std.ascii.orderIgnoreCase', (a, b) => orderValue(caseFold(a, b)), ORDER),
  findIgnoreCase: comparer(
    'std.ascii.findIgnoreCase',
    (a, b) => {
      for (let index = 0; index + b.length <= a.length; index++)
        if (caseFold(a.slice(index, index + b.length), b) === 0) return optionalIndex(index);
      return optionalIndex(-1);
    },
    OPTIONAL_USIZE
  ),
  lowercase: () => stringConstant('abcdefghijklmnopqrstuvwxyz'),
  uppercase: () => stringConstant('ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
  letters: () => stringConstant('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'),
  whitespace: () => ({
    type: CONST_U8_SLICE,
    value: newSlice([0x20n, 0x09n, 0x0an, 0x0dn, 0x0bn, 0x0cn]),
  }),
};

/** A string constant such as `std.ascii.lowercase`, typed as a string literal is: `*const [n:0]u8`. */
function stringConstant(text: string): Member {
  const bytes = [...text].map((char) => BigInt(char.codePointAt(0) as number));
  return {
    type: pointerTo(arrayOf(bytes.length, U8, 0n), true),
    value: new Pointer(new Constant(new ZArray([...bytes, 0n], 0, bytes.length)), 0),
  };
}

let ascii: StructType | undefined;

export function asciiNamespace(): StructType {
  ascii ??= nativeStruct('std.ascii', MEMBERS);
  return ascii;
}
