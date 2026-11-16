import { PANIC, panic } from '../arith';
import { BigFloat, parseFloatLiteral, toNumber } from '../floats';
import { runtime } from '../semaBase';
import {
  CONST_U8_SLICE,
  errorSetOf,
  errorUnionOf,
  fitsInt,
  type IntType,
  intType,
  sliceOf,
  type StructType,
  type Type,
  typeName,
  U8,
  U64,
} from '../types';
import { ErrorValue, Slice, type Value } from '../values';
import { allocating, allocatorArg, computed, constSlice, elements, generic, mutableSlice, newSlice } from './common';
import { allocatorState, ERROR_OUT_OF_MEMORY, reserveNativeAllocation } from './heap';
import { compileArgs, expectArgs, fnMember, type Member, nativeStruct } from './native';
import { compilePrint, PrintWriteError } from './print';
import type { WriterState } from './writer';

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
function parseInt(bytes: number[], base: number, type: IntType): Value {
  if (bytes.length === 0) return INVALID_CHARACTER;
  let negative = false;
  let digits = bytes;
  if (bytes[0] === 0x2b) digits = bytes.slice(1);
  else if (bytes[0] === 0x2d) {
    negative = true;
    digits = bytes.slice(1);
  }
  if (digits.length === 0) return INVALID_CHARACTER;
  let radix = base;
  if (base === 0) {
    radix = 10;
    if (digits.length > 2 && digits[0] === 0x30) {
      const prefix = digits[1] | 0x20;
      if (prefix === 0x62) radix = 2;
      else if (prefix === 0x6f) radix = 8;
      else if (prefix === 0x78) radix = 16;
      if (radix !== 10) digits = digits.slice(2);
    }
  }
  if (digits.length === 0 || digits[0] === 0x5f || digits.at(-1) === 0x5f) return INVALID_CHARACTER;
  const accumulate = intType(type.signed, Math.max(8, type.bits));
  let value = 0n;
  let first = true;
  for (const c of digits) {
    if (c === 0x5f) continue;
    const digit = charToDigit(c, radix);
    if (digit === undefined) return INVALID_CHARACTER;
    if (value !== 0n) {
      value *= BigInt(radix);
      if (!fitsInt(value, accumulate)) return OVERFLOW;
    } else if (negative && first) {
      value = -BigInt(digit);
      if (!fitsInt(value, accumulate)) return OVERFLOW;
      first = false;
      continue;
    }
    first = false;
    value = negative ? value - BigInt(digit) : value + BigInt(digit);
    if (!fitsInt(value, accumulate)) return OVERFLOW;
  }
  return fitsInt(value, type) ? value : OVERFLOW;
}

/** `std.fmt.parseFloat`: decimal or hexadecimal digits with `_`, `inf`, or `nan`, rounded to the type. */
// code-gauge-allow functionCognitiveComplexity 16 -- Transcribes the corresponding function of Zig's standard library or compiler step by step.
function parseFloat(bytes: number[], type: Extract<Type, { kind: 'float' }>): Value {
  const text = String.fromCodePoint(...bytes);
  const match = /^([+-]?)(.*)$/s.exec(text) as RegExpExecArray;
  const negative = match[1] === '-';
  const body = match[2];
  let value: BigFloat;
  if (/^inf(inity)?$/i.test(body)) value = new BigFloat(negative, 'inf', 0n, 0);
  else if (/^nan$/i.test(body)) value = new BigFloat(false, 'nan', 0n, 0);
  else if (
    /^(\d(_?\d)*)?(\.(\d(_?\d)*)?)?([eE][+-]?\d(_?\d)*)?$/.test(body) &&
    /\d/.test(body.split(/[eE]/)[0]) &&
    !body.startsWith('_')
  ) {
    const parsed = parseFloatLiteral(
      body.startsWith('.') ? `0${body}` : body.endsWith('.') ? `${body}0` : body,
      type.bits
    );
    value = negative ? new BigFloat(true, parsed.kind, parsed.mantissa, parsed.exponent) : parsed;
  } else if (/^0[xX][\da-fA-F](_?[\da-fA-F])*(\.([\da-fA-F](_?[\da-fA-F])*)?)?([pP][+-]?\d+)?$/.test(body)) {
    const parsed = parseFloatLiteral(body.toLowerCase(), type.bits);
    value = negative ? new BigFloat(true, parsed.kind, parsed.mantissa, parsed.exponent) : parsed;
  } else {
    return INVALID_CHARACTER;
  }
  return type.bits <= 64 ? toNumber(value, type.bits as 16 | 32 | 64) : value;
}

function bytesOf(value: Value): number[] {
  return elements(value).map((byte) => Number(byte as bigint));
}

const MEMBERS: Record<string, () => Member> = {
  parseInt: generic('std.fmt.parseInt', 3, (sema, call, type, [bufferArg, baseArg]) => {
    if (type.kind !== 'int')
      return sema.error(call.span, `std.fmt.parseInt には整数の型を渡してください（${typeName(type)} です）。`);
    const buffer = constSlice(sema, bufferArg, U8);
    const [base] = compileArgs(sema, [baseArg], [U8]);
    return computed(errorUnionOf(PARSE_INT_ERRORS, type), [buffer, base], call.span, ([text, radix]) =>
      parseInt(bytesOf(text), Number(radix as bigint), type)
    );
  }),
  parseUnsigned: generic('std.fmt.parseUnsigned', 3, (sema, call, type, [bufferArg, baseArg]) => {
    if (type.kind !== 'int' || type.signed)
      return sema.error(call.span, 'std.fmt.parseUnsigned には符号なしの整数の型を渡してください。');
    const buffer = constSlice(sema, bufferArg, U8);
    const [base] = compileArgs(sema, [baseArg], [U8]);
    return computed(errorUnionOf(PARSE_INT_ERRORS, type), [buffer, base], call.span, ([text, radix]) => {
      const bytes = bytesOf(text);
      if (bytes[0] === 0x2b || bytes[0] === 0x2d) return INVALID_CHARACTER;
      return parseInt(bytes, Number(radix as bigint), type);
    });
  }),
  parseFloat: generic('std.fmt.parseFloat', 2, (sema, call, type, [bufferArg]) => {
    if (type.kind !== 'float')
      return sema.error(
        call.span,
        `std.fmt.parseFloat には浮動小数点数の型を渡してください（${typeName(type)} です）。`
      );
    const buffer = constSlice(sema, bufferArg, U8);
    return computed(errorUnionOf(errorSetOf(['InvalidCharacter']), type), [buffer], call.span, ([text]) =>
      parseFloat(bytesOf(text), type)
    );
  }),
  charToDigit: fnMember('std.fmt.charToDigit', (sema, call) => {
    const [c, base] = compileArgs(sema, expectArgs(sema, call, 2, 'std.fmt.charToDigit'), [U8, U8]);
    return computed(errorUnionOf(errorSetOf(['InvalidCharacter']), U8), [c, base], call.span, ([value, radix]) => {
      const digit = charToDigit(Number(value as bigint), Number(radix as bigint));
      return digit === undefined ? INVALID_CHARACTER : BigInt(digit);
    });
  }),
  bufPrint: fnMember('std.fmt.bufPrint', (sema, call) => {
    const [bufferArg, format, args] = expectArgs(sema, call, 3, 'std.fmt.bufPrint');
    const buffer = mutableSlice(sema, bufferArg, U8);
    const print = compilePrint(sema, format, args, call.span);
    const evaluate = buffer.eval;
    return runtime(
      errorUnionOf(errorSetOf(['NoSpaceLeft']), sliceOf(U8, false)),
      (frame) => {
        const target = evaluate(frame) as Slice;
        const state: WriterState = { fd: undefined, buffer: target, end: 0, capacity: target.length };
        try {
          print(frame, state);
        } catch (error) {
          if (error instanceof PrintWriteError) return ErrorValue.of('NoSpaceLeft');
          throw error;
        }
        return new Slice(target.target, target.start, state.end);
      },
      call.span
    );
  }),
  allocPrint: fnMember('std.fmt.allocPrint', (sema, call) => {
    const [allocatorArgument, format, args] = expectArgs(sema, call, 3, 'std.fmt.allocPrint');
    const evaluateAllocator = allocatorArg(sema, allocatorArgument).eval;
    const print = compilePrint(sema, format, args, call.span);
    return runtime(
      allocating(sliceOf(U8, false)),
      (frame) => {
        const allocator = allocatorState(evaluateAllocator(frame));
        let bytes: number[];
        try {
          bytes = print(frame);
        } catch (error) {
          if (error instanceof PrintWriteError) return ERROR_OUT_OF_MEMORY;
          throw error;
        }
        frame.runtime.spend();
        const complete = reserveNativeAllocation(frame, allocator, bytes.length, U8);
        if (!complete) return ERROR_OUT_OF_MEMORY;
        const slice = newSlice(bytes.map(BigInt));
        complete(slice.target);
        return slice;
      },
      call.span
    );
  }),
  count: fnMember('std.fmt.count', (sema, call) => {
    const [format, args] = expectArgs(sema, call, 2, 'std.fmt.count');
    const print = compilePrint(sema, format, args, call.span);
    return runtime(
      U64,
      (frame) => {
        try {
          return BigInt(print(frame).length);
        } catch (error) {
          if (error instanceof PrintWriteError) panic(PANIC.unreachable);
          throw error;
        }
      },
      call.span
    );
  }),
  digitToChar: fnMember('std.fmt.digitToChar', (sema, call) => {
    const [digitArg, caseArg] = expectArgs(sema, call, 2, 'std.fmt.digitToChar');
    const [digit] = compileArgs(sema, [digitArg], [U8]);
    const upper = sema.knownValue(sema.compile(caseArg), '大文字・小文字') as unknown as {
      name: string;
    };
    const offset = upper?.name === 'upper' ? 0x41 : 0x61;
    return computed(U8, [digit], call.span, ([value]) => {
      const d = Number(value as bigint);
      return BigInt(d < 10 ? d + 0x30 : d + offset - 10);
    });
  }),
};

let fmt: StructType | undefined;

export function fmtNamespace(): StructType {
  fmt ??= nativeStruct('std.fmt', MEMBERS);
  return fmt;
}

export { CONST_U8_SLICE };
