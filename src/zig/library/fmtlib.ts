import { PANIC, panic } from '../arith';
import { BigFloat, parseFloatLiteral, toNumber } from '../floats';
import { spendIntegerOperation, spendIntegerWidth } from '../integerWork';
import { MemoryFault } from '../memoryFault';
import { runtime } from '../semaBase';
import {
  CONST_U8_SLICE,
  errorSetOf,
  errorUnionOf,
  fnType,
  type IntType,
  intType,
  maxInt,
  minInt,
  sliceOf,
  type StructType,
  type Type,
  typeName,
  U8,
  USIZE,
} from '../types';
import { createUtf8Decoder } from '../utf8';
import { ErrorValue, isUndefinedMemory, Slice, type Value } from '../values';
import { allocatingWriter, freeWriter, ownWriterSlice } from './allocatingWriter';
import { allocating, allocatorArg, computed, constSlice, generic, mutableSlice, nativeBudget } from './common';
import { allocatorState, ERROR_OUT_OF_MEMORY, nativeEnum } from './heap';
import { compileArgs, expectArgs, fnMember, type Member, nativeCall, nativeStruct, typeMember } from './native';
import { compilePrint } from './print';
import { discardedBytes, discardingWriter, type WriterState, WriterWriteError } from './writer';

const CASE = nativeEnum('fmt.Case', ['lower', 'upper']);
const PARSE_INT_ERRORS = errorSetOf(['Overflow', 'InvalidCharacter']);
const INVALID_CHARACTER = ErrorValue.of('InvalidCharacter');
const OVERFLOW = ErrorValue.of('Overflow');

function charToDigit(c: number, base: number): number | undefined {
  let value: number;
  if (c >= 0x30 && c <= 0x39) value = c - 0x30;
  else if (c >= 0x41 && c <= 0x5a) value = c - 0x41 + 10;
  else if (c >= 0x61 && c <= 0x7a) value = c - 0x61 + 10;
  else return undefined;
  return value >= base ? undefined : value;
}

/** `std.fmt.parseInt`, transcribed: the sign, a base prefix when the base is 0, digits with `_` between them. */
function parseInt(bytes: Slice, base: number, type: IntType, spend: (cost?: number) => void, unsigned = false): Value {
  const read = (index: number): number => {
    spend();
    return Number(bytes.get(index) as bigint);
  };
  if (bytes.length === 0) return INVALID_CHARACTER;
  let negative = false;
  let start = 0;
  const first = read(0);
  if (first === 0x2b || first === 0x2d) {
    if (unsigned) return INVALID_CHARACTER;
    negative = first === 0x2d;
    start++;
  }
  if (start === bytes.length) return INVALID_CHARACTER;
  let radix = base;
  if (base === 0) {
    radix = 10;
    if (bytes.length - start > 2 && read(start) === 0x30) {
      const prefix = read(start + 1) | 0x20;
      if (prefix === 0x62) radix = 2;
      else if (prefix === 0x6f) radix = 8;
      else if (prefix === 0x78) radix = 16;
      if (radix !== 10) start += 2;
    }
  }
  if (read(start) === 0x5f || read(bytes.length - 1) === 0x5f) return INVALID_CHARACTER;
  const accumulate = intType(type.signed, Math.max(8, type.bits));
  spendIntegerWidth(accumulate.bits * (type.signed ? 4 : 2), spend);
  const minimum = minInt(accumulate),
    maximum = maxInt(accumulate);
  const targetMinimum = minInt(type),
    targetMaximum = maxInt(type);
  const fits = (value: bigint, min = minimum, max = maximum): boolean => {
    spendIntegerOperation(value, min, 'read', spend);
    spendIntegerOperation(value, max, 'read', spend);
    return value >= min && value <= max;
  };
  const radixValue = BigInt(radix);
  let value = 0n;
  for (let index = start; index < bytes.length; index++) {
    const c = read(index);
    if (c === 0x5f) continue;
    const digit = charToDigit(c, radix);
    if (digit === undefined) return INVALID_CHARACTER;
    if (value !== 0n) {
      spendIntegerOperation(value, radixValue, 'multiply', spend);
      value *= radixValue;
      if (!fits(value)) return OVERFLOW;
    } else if (negative) {
      value = -BigInt(digit);
      if (!fits(value)) return OVERFLOW;
      continue;
    }
    spendIntegerOperation(value, BigInt(digit), 'add', spend);
    value = negative ? value - BigInt(digit) : value + BigInt(digit);
    if (!fits(value)) return OVERFLOW;
  }
  return fits(value, targetMinimum, targetMaximum) ? value : OVERFLOW;
}

/** `std.fmt.parseFloat`: decimal or hexadecimal digits with `_`, `inf`, or `nan`, rounded to the type. */
function parseFloat(bytes: Slice, type: Extract<Type, { kind: 'float' }>, spend: (cost?: number) => void): Value {
  if (bytes.lengthValue !== 0n && isUndefinedMemory(bytes)) throw new MemoryFault();
  spend(bytes.length);
  const input = Uint8Array.from({ length: bytes.length }, (_, index) => Number(bytes.get(index)));
  spend(input.length);
  const text = createUtf8Decoder().decode(input);
  const negative = text[0] === '-';
  const body = negative || text[0] === '+' ? text.slice(1) : text;
  const special = body.length <= 8 ? body.toLowerCase() : undefined;
  let value: BigFloat;
  if (special === 'inf' || special === 'infinity') value = new BigFloat(negative, 'inf', 0n, 0);
  else if (special === 'nan') value = new BigFloat(false, 'nan', 0n, 0);
  else if (isFloatNumber(body, spend)) {
    const parsed = parseFloatLiteral(body, type.bits, spend);
    value = negative ? new BigFloat(true, parsed.kind, parsed.mantissa, parsed.exponent) : parsed;
  } else return INVALID_CHARACTER;
  return type.bits <= 64 ? toNumber(value, type.bits as 16 | 32 | 64) : value;
}

// code-gauge-allow functionCognitiveComplexity 18 -- Scans both numeric radices with the same digit, separator, and exponent rules.
function isFloatNumber(text: string, spend: (cost?: number) => void): boolean {
  const hexadecimal = text.slice(0, 2).toLowerCase() === '0x';
  const base = hexadecimal ? 16 : 10;
  let position = hexadecimal ? 2 : 0;
  const scanDigits = (radix: number): number => {
    let count = 0;
    while (isDigit(text[position], radix)) {
      spend();
      count++;
      position++;
      if (text[position] === '_' && isDigit(text[position + 1], radix)) {
        spend();
        position++;
      }
    }
    return count;
  };
  let digits = scanDigits(base);
  if (text[position] === '.') {
    position++;
    digits += scanDigits(base);
  }
  if (digits === 0) return false;
  if (text[position]?.toLowerCase() === (hexadecimal ? 'p' : 'e')) {
    position++;
    if (text[position] === '+' || text[position] === '-') position++;
    if (scanDigits(10) === 0) return false;
  }
  return position === text.length;
}

function isDigit(character: string | undefined, base: number): boolean {
  if (character === undefined) return false;
  const code = character.codePointAt(0) ?? 0;
  return (code >= 48 && code <= 57) || (base === 16 && (code | 32) >= 97 && (code | 32) <= 102);
}

const MEMBERS: Record<string, () => Member> = {
  Case: typeMember(() => CASE),
  parseInt: generic('std.fmt.parseInt', 3, (sema, call, type, [bufferArg, baseArg]) => {
    if (type.kind !== 'int')
      return sema.error(call.span, `std.fmt.parseInt には整数の型を渡してください（${typeName(type)} です）。`);
    const buffer = constSlice(sema, bufferArg, U8);
    const [base] = compileArgs(sema, [baseArg], [U8]);
    return computed(errorUnionOf(PARSE_INT_ERRORS, type), [buffer, base], call.span, ([text, radix], frame) =>
      parseInt(text as Slice, Number(radix as bigint), type, nativeBudget(sema, frame))
    );
  }),
  parseUnsigned: generic('std.fmt.parseUnsigned', 3, (sema, call, type, [bufferArg, baseArg]) => {
    if (type.kind !== 'int') return sema.error(call.span, 'std.fmt.parseUnsigned には整数の型を渡してください。');
    const buffer = constSlice(sema, bufferArg, U8);
    const [base] = compileArgs(sema, [baseArg], [U8]);
    return computed(errorUnionOf(PARSE_INT_ERRORS, type), [buffer, base], call.span, ([text, radix], frame) =>
      parseInt(text as Slice, Number(radix as bigint), type, nativeBudget(sema, frame), true)
    );
  }),
  parseFloat: generic('std.fmt.parseFloat', 2, (sema, call, type, [bufferArg]) => {
    if (type.kind !== 'float')
      return sema.error(
        call.span,
        `std.fmt.parseFloat には浮動小数点数の型を渡してください（${typeName(type)} です）。`
      );
    const buffer = constSlice(sema, bufferArg, U8);
    return computed(errorUnionOf(errorSetOf(['InvalidCharacter']), type), [buffer], call.span, ([text], frame) =>
      parseFloat(text as Slice, type, nativeBudget(sema, frame))
    );
  }),
  charToDigit: fnMember(
    'std.fmt.charToDigit',
    (sema, call) => {
      const [c, base] = compileArgs(sema, expectArgs(sema, call, 2, 'std.fmt.charToDigit'), [U8, U8]);
      return computed(errorUnionOf(errorSetOf(['InvalidCharacter']), U8), [c, base], call.span, ([value, radix]) => {
        const digit = charToDigit(Number(value as bigint), Number(radix as bigint));
        return digit === undefined ? INVALID_CHARACTER : BigInt(digit);
      });
    },
    () => ({ type: fnType([U8, U8], errorUnionOf(errorSetOf(['InvalidCharacter']), U8)) })
  ),
  bufPrint: fnMember('std.fmt.bufPrint', (sema, call) => {
    const [bufferArg, format, args] = expectArgs(sema, call, 3, 'std.fmt.bufPrint');
    const buffer = mutableSlice(sema, bufferArg, U8);
    const print = compilePrint(sema, format, args, call.span);
    return nativeCall(
      errorUnionOf(errorSetOf(['NoSpaceLeft']), sliceOf(U8, false)),
      [buffer],
      call.span,
      ([value], frame) => {
        const target = value as Slice;
        const state: WriterState = { fd: undefined, buffer: target, end: 0, capacity: target.length };
        try {
          print(frame, state);
        } catch (error) {
          if (error instanceof WriterWriteError) return ErrorValue.of('NoSpaceLeft');
          throw error;
        }
        return new Slice(target.target, target.start, state.end);
      }
    );
  }),
  allocPrint: fnMember('std.fmt.allocPrint', (sema, call) => {
    const [allocatorArgument, format, args] = expectArgs(sema, call, 3, 'std.fmt.allocPrint');
    const allocator = allocatorArg(sema, allocatorArgument);
    const print = compilePrint(sema, format, args, call.span);
    return nativeCall(allocating(sliceOf(U8, false)), [allocator], call.span, ([value], frame) => {
      const allocator = allocatorState(value);
      const prepared = print.prepare(frame);
      const writer = allocatingWriter(frame, allocator, print.formatLength);
      if (!writer) return ERROR_OUT_OF_MEMORY;
      try {
        prepared.write(writer);
        return ownWriterSlice(frame, allocator, writer);
      } catch (error) {
        if (error instanceof WriterWriteError) return ERROR_OUT_OF_MEMORY;
        throw error;
      } finally {
        freeWriter(allocator, writer);
      }
    });
  }),
  count: fnMember('std.fmt.count', (sema, call) => {
    const [format, args] = expectArgs(sema, call, 2, 'std.fmt.count');
    const print = compilePrint(sema, format, args, call.span);
    return runtime(
      USIZE,
      (frame) => {
        try {
          const writer = discardingWriter();
          print(frame, writer);
          return discardedBytes(writer);
        } catch (error) {
          if (error instanceof WriterWriteError) panic(PANIC.unreachable);
          throw error;
        }
      },
      call.span
    );
  }),
  digitToChar: fnMember(
    'std.fmt.digitToChar',
    (sema, call) => {
      const [digitArg, caseArg] = expectArgs(sema, call, 2, 'std.fmt.digitToChar');
      const [digit, letterCase] = compileArgs(sema, [digitArg, caseArg], [U8, CASE]);
      return computed(U8, [digit, letterCase], call.span, ([value, selectedCase]) => {
        const offset = selectedCase === 1n ? 0x41 : 0x61;
        const d = Number(value as bigint);
        if (d >= 36) panic(PANIC.unreachable);
        return BigInt(d < 10 ? d + 0x30 : d + offset - 10);
      });
    },
    () => ({ type: fnType([U8, CASE], U8) })
  ),
};

let fmt: StructType | undefined;

export function fmtNamespace(): StructType {
  fmt ??= nativeStruct('std.fmt', MEMBERS);
  return fmt;
}

export { CONST_U8_SLICE };
