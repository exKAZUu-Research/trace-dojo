import type { Expression, Span } from '../ast';
import { activeUnionIndex, unionTagValue } from '../bufferMemory';
import { type AnyFloat } from '../floats';
import { checkFormat, FormatError, type FormatOutput, type Options, printValue } from '../fmt';
import type { Frame } from '../runtime';
import { type NativeCall, runtime, type SemaApi, type TExpr } from '../semaBase';
import {
  ANYERROR,
  BOOL,
  CONST_U8_SLICE,
  errorSetOf,
  errorUnionOf,
  sliceOf,
  type StructType,
  type Type,
  typeName,
  VOID,
} from '../types';
import { ErrorValue, NULL, Pointer, type Slice, type Value, type ZStruct, type ZUnion } from '../values';
import { approximatelyEqual } from './math';
import { expectArgs, fnMember, type Member, nativeStruct } from './native';
import { typeInfo } from './print';
import { valuesEqual } from './valueEquality';

/**
 * `std.testing`, whose checks a program may call outside a test as Zig's library allows. A failure prints Zig's report
 * to standard error, which colors nothing because it is not a terminal, and returns Zig's error.
 */
export function testingNamespace(): StructType {
  testing ??= nativeStruct('testing', MEMBERS);
  return testing;
}

let testing: StructType | undefined;

/** What a failed check prints and the error it returns. */
interface Failure {
  readonly text: number[];
  readonly error: string;
}

type Check = (expected: Value, actual: Value, frame: Frame) => Failure | undefined;

const MEMBERS: Record<string, () => Member> = {
  expect: fnMember('std.testing.expect', (sema, call) => {
    const [okArg] = expectArgs(sema, call, 1, 'std.testing.expect');
    const ok = sema.coerce(sema.compile(okArg, BOOL), BOOL, okArg);
    return failing(call.span, ['TestUnexpectedResult'], [ok], ([value]) =>
      value === true ? undefined : { text: [], error: 'TestUnexpectedResult' }
    );
  }),
  expectEqual: fnMember('std.testing.expectEqual', (sema, call) => {
    const [expectedArg, actualArg] = expectArgs(sema, call, 2, 'std.testing.expectEqual');
    const [expected, actual] = peerOperands(sema, [expectedArg, actualArg], call.span);
    const check = equalityCheck(sema, expected.type, call.span);
    return failing(call.span, ['TestExpectedEqual'], [expected, actual], ([e, a], frame) => check(e, a, frame));
  }),
  expectEqualSlices: fnMember('std.testing.expectEqualSlices', (sema, call) => {
    const [typeArg, expectedArg, actualArg] = expectArgs(sema, call, 3, 'std.testing.expectEqualSlices');
    const element = sema.compileType(typeArg);
    const slice = sliceOf(element, true);
    const operands = [expectedArg, actualArg].map((arg) => sema.coerce(sema.compile(arg, slice), slice, arg));
    const compare = slicesCheck(sema, element, call.span);
    return failing(call.span, ['TestExpectedEqual'], operands, ([e, a], frame) => compare(e, a, frame));
  }),
  expectEqualStrings: fnMember('std.testing.expectEqualStrings', (sema, call) => {
    const operands = stringOperands(sema, call, 'std.testing.expectEqualStrings');
    return failing(call.span, ['TestExpectedEqual'], operands, ([e, a], frame) =>
      stringsFailure(bytesOf(e, frame), bytesOf(a, frame))
    );
  }),
  expectStringStartsWith: fnMember('std.testing.expectStringStartsWith', (sema, call) => {
    const operands = stringOperands(sema, call, 'std.testing.expectStringStartsWith');
    return failing(call.span, ['TestExpectedStartsWith'], operands, ([a, prefix], frame) =>
      affixFailure(bytesOf(a, frame), bytesOf(prefix, frame), 'start')
    );
  }),
  expectStringEndsWith: fnMember('std.testing.expectStringEndsWith', (sema, call) => {
    const operands = stringOperands(sema, call, 'std.testing.expectStringEndsWith');
    return failing(call.span, ['TestExpectedEndsWith'], operands, ([a, suffix], frame) =>
      affixFailure(bytesOf(a, frame), bytesOf(suffix, frame), 'end')
    );
  }),
  expectError: fnMember('std.testing.expectError', (sema, call) => {
    const [expectedArg, actualArg] = expectArgs(sema, call, 2, 'std.testing.expectError');
    const expected = sema.coerce(sema.compile(expectedArg, ANYERROR), ANYERROR, expectedArg);
    const actual = sema.compile(actualArg);
    if (actual.type.kind !== 'error_union')
      return sema.error(actualArg, `expectError にはエラー共用体を渡してください（${typeName(actual.type)} 型です）。`);
    const format = formatter(sema, call.span);
    const payload = actual.type.payload;
    return failing(call.span, ['TestExpectedError', 'TestUnexpectedError'], [expected, actual], ([e, a]) => {
      const name = (e as ErrorValue).name;
      if (!(a instanceof ErrorValue))
        return {
          text: [...utf8(`expected error.${name}, found `), ...format('any', a, payload), 10],
          error: 'TestExpectedError',
        };
      if (a.name === name) return;
      return { text: utf8(`expected error.${name}, found error.${a.name}\n`), error: 'TestUnexpectedError' };
    });
  }),
  expectApproxEqAbs: approximateCheck('std.testing.expectApproxEqAbs', 'absolute', 'TestExpectedApproxEqAbs'),
  expectApproxEqRel: approximateCheck('std.testing.expectApproxEqRel', 'relative', 'TestExpectedApproxEqRel'),
};

/** A check that runs when the program reaches it, printing and returning its failure. */
function failing(
  span: Span,
  errors: readonly string[],
  operands: readonly TExpr[],
  check: (values: Value[], frame: Frame) => Failure | undefined
): TExpr {
  const evaluators = operands.map((operand) => operand.eval);
  return runtime(
    errorUnionOf(errorSetOf(errors), VOID),
    (frame) => {
      const failure = check(
        evaluators.map((evaluate) => evaluate(frame)),
        frame
      );
      if (!failure) return;
      if (failure.text.length > 0) frame.runtime.writeOutput(2, failure.text);
      return ErrorValue.of(failure.error);
    },
    span
  );
}

/** Both operands of `expectEqual` and the like, coerced to their peer type as `@TypeOf(expected, actual)` gives. */
function peerOperands(sema: SemaApi, args: readonly Expression[], span: Span): TExpr[] {
  const compiled = args.map((arg) => sema.compile(arg));
  const type = sema.peerType(compiled, span);
  return compiled.map((operand, index) => sema.coerce(operand, type, args[index]));
}

function stringOperands(sema: SemaApi, call: NativeCall, name: string): TExpr[] {
  return expectArgs(sema, call, 2, name).map((arg) =>
    sema.coerce(sema.compile(arg, CONST_U8_SLICE), CONST_U8_SLICE, arg)
  );
}

/** How `expectEqual` compares two values of a type, as its switch over `@typeInfo` does in Zig's library. */
// code-gauge-allow functionNcss -- One case per kind of type, as Zig's expectEqualInner has.
// code-gauge-allow functionCognitiveComplexity -- One case per kind of type, as Zig's expectEqualInner has.
function equalityCheck(sema: SemaApi, type: Type, span: Span): Check {
  const format = formatter(sema, span);
  const differ = (spec: string, payloadType = type): Check => {
    checkFormatOf(sema, spec, payloadType, span);
    return (e, a, frame) =>
      valuesEqual(payloadType, e, a, (cost) => frame.runtime.spend(cost))
        ? undefined
        : {
            text: [
              ...utf8('expected '),
              ...format(spec, e, payloadType),
              ...utf8(', found '),
              ...format(spec, a, payloadType),
              10,
            ],
            error: 'TestExpectedEqual',
          };
  };
  switch (type.kind) {
    case 'void':
    case 'null':
    case 'undefined': {
      return () => {};
    }
    case 'type': {
      return (e, a) =>
        e === a
          ? undefined
          : {
              text: utf8(`expected type ${typeName(e as Type)}, found type ${typeName(a as Type)}\n`),
              error: 'TestExpectedEqual',
            };
    }
    case 'bool':
    case 'int':
    case 'float':
    case 'comptime_int':
    case 'comptime_float':
    case 'enum_literal':
    case 'enum':
    case 'error_set': {
      return differ('any');
    }
    case 'pointer': {
      return type.size === 'slice' ? sliceIdentityCheck(sema, type, span) : differ('*');
    }
    case 'array': {
      const compare = slicesCheck(sema, type.child, span);
      return (e, a, frame) => compare(e, a, frame);
    }
    case 'struct': {
      const fields = sema.structFields(type, span).map((field, index) => ({
        index,
        check: field.comptimeValue ? undefined : equalityCheck(sema, field.type, span),
      }));
      return (e, a, frame) => {
        for (const { index, check } of fields) {
          const failure = check?.((e as ZStruct).slots[index], (a as ZStruct).slots[index], frame);
          if (failure) return failure;
        }
        return;
      };
    }
    case 'union': {
      return unionCheck(sema, type, span);
    }
    case 'optional': {
      return optionalCheck(sema, type.child, span);
    }
    case 'error_union': {
      return errorUnionCheck(sema, type, span);
    }
    default: {
      return sema.error(span, `${typeName(type)} 型の値は、std.testing.expectEqual で比べられません。`);
    }
  }
}

function optionalCheck(sema: SemaApi, child: Type, span: Span): Check {
  const format = formatter(sema, span);
  const payload = equalityCheck(sema, child, span);
  checkFormatOf(sema, 'any', child, span);
  return (e, a, frame) => {
    if (e !== NULL && a !== NULL) return payload(e, a, frame);
    if (e === NULL && a === NULL) return;
    return e === NULL
      ? { text: [...utf8('expected null, found '), ...format('any', a, child), 10], error: 'TestExpectedEqual' }
      : {
          text: [...utf8('expected '), ...format('any', e, child), ...utf8(', found null\n')],
          error: 'TestExpectedEqual',
        };
  };
}

function errorUnionCheck(sema: SemaApi, type: Extract<Type, { kind: 'error_union' }>, span: Span): Check {
  const format = formatter(sema, span);
  const payload = equalityCheck(sema, type.payload, span);
  const errors = equalityCheck(sema, type.errorSet, span);
  checkFormatOf(sema, 'any', type.payload, span);
  return (e, a, frame) => {
    const eError = e instanceof ErrorValue;
    const aError = a instanceof ErrorValue;
    if (!eError && !aError) return payload(e, a, frame);
    if (eError && aError) return errors(e, a, frame);
    const [left, right] = eError
      ? [utf8(`error.${(e as ErrorValue).name}`), format('any', a, type.payload)]
      : [format('any', e, type.payload), utf8(`error.${(a as ErrorValue).name}`)];
    return { text: [...utf8('expected '), ...left, ...utf8(', found '), ...right, 10], error: 'TestExpectedEqual' };
  };
}

/** A slice compares by where it points and its length, as Zig's expectEqual does, not by its elements. */
function sliceIdentityCheck(sema: SemaApi, type: Extract<Type, { kind: 'pointer' }>, span: Span): Check {
  const format = formatter(sema, span);
  const many: Type = { ...type, size: 'many' };
  return (e, a) => {
    const expected = e as Slice;
    const actual = a as Slice;
    if (expected.target !== actual.target || expected.start !== actual.start) {
      return {
        text: [
          ...utf8('expected slice ptr '),
          ...format('*', slicePointer(expected), many),
          ...utf8(', found '),
          ...format('*', slicePointer(actual), many),
          10,
        ],
        error: 'TestExpectedEqual',
      };
    }
    if (expected.lengthValue === actual.lengthValue) return;
    return {
      text: utf8(`expected slice len ${expected.lengthValue}, found ${actual.lengthValue}\n`),
      error: 'TestExpectedEqual',
    };
  };
}

function slicePointer(slice: Slice): Value {
  return new Pointer(slice.target, slice.start);
}

/** A tagged union compares its tags and then the active payloads; Zig compares other unions by their bits. */
function unionCheck(sema: SemaApi, type: Extract<Type, { kind: 'union' }>, span: Span): Check {
  const tagType = type.tagType;
  if (type.layout !== 'auto' || !tagType)
    return sema.error(span, `${typeName(type)} 型の値は、std.testing.expectEqual で比べられません。`);
  const fields = sema.unionFields(type);
  const tags = sema.enumFields(tagType);
  const tagCheck = equalityCheck(sema, tagType, span);
  const payloads = fields.map((field) => equalityCheck(sema, field.type, span));
  return (e, a, frame) => {
    const expected = e as ZUnion;
    const actual = a as ZUnion;
    const failure = tagCheck(unionTagValue(expected, tags), unionTagValue(actual, tags), frame);
    return failure ?? payloads[activeUnionIndex(expected)](expected.slots[0], actual.slots[0], frame);
  };
}

/** `expectEqualSlices`: the elements compare as `std.meta.eql` does, and a difference prints both windows. */
function slicesCheck(sema: SemaApi, element: Type, span: Span): Check {
  const format = formatter(sema, span);
  checkFormatOf(sema, 'any', element, span);
  return (e, a, frame) => {
    const expected = elementsOf(e);
    const actual = elementsOf(a);
    const shortest = Math.min(expected.length, actual.length);
    let index = 0;
    while (
      index < shortest &&
      valuesEqual(element, expected[index], actual[index], (cost) => frame.runtime.spend(cost))
    )
      index++;
    if (index === shortest && expected.length === actual.length) return;
    return { text: slicesReport(element, expected, actual, index, format), error: 'TestExpectedEqual' };
  };
}

function elementsOf(value: Value): Value[] {
  if (value instanceof Pointer) return elementsOf(value.load());
  const indexed = value as Slice;
  return Array.from({ length: indexed.length }, (_, index) => indexed.get(index));
}

// code-gauge-allow functionNcss -- Follows Zig's failEqualSlices line by line.
// code-gauge-allow functionCognitiveComplexity -- Follows Zig's failEqualSlices line by line.
function slicesReport(
  element: Type,
  expected: readonly Value[],
  actual: readonly Value[],
  diffIndex: number,
  format: Formatter
): number[] {
  const bytes = element.kind === 'int' && element.bits === 8 && !element.signed;
  const out: number[] = [];
  const write = (text: string): void => {
    out.push(...utf8(text));
  };
  write(`slices differ. first difference occurs at index ${diffIndex} (0x${hex(diffIndex)})\n`);
  const windowSize = bytes ? 16 * 16 : 16;
  let start = 0;
  if (Math.max(actual.length, expected.length) > windowSize) {
    const alignment = bytes ? 16 : 2;
    const back = diffIndex - Math.min(diffIndex, alignment);
    start = back - (back % alignment);
  }
  const section = (title: string, values: readonly Value[], other: readonly Value[]): void => {
    const window = values.slice(start, start + windowSize);
    void other;
    write(`\n${title}  len: ${values.length} (0x${hex(values.length)})\n\n`);
    if (start > 0) write(bytes ? `... truncated, start index: 0x${hex(start)} ...\n` : '... truncated ...\n');
    if (bytes) writeByteRows(window.map(Number), write);
    else
      for (const [offset, value] of window.entries()) {
        write(`[${start + offset}]: `);
        out.push(...format('any', value, element), 10);
      }
    const missing = values.length - (start + window.length);
    if (missing > 0)
      write(
        bytes
          ? `... truncated, indexes [0x${hex(start + window.length)}..] not shown, remaining bytes: 0x${hex(missing)} ...\n`
          : `... truncated, remaining items: ${missing} ...\n`
      );
  };
  section('============ expected this output: =============', expected, actual);
  section('============= instead found this: ==============', actual, expected);
  write('\n================================================\n\n');
  return out;
}

function hex(n: number): string {
  return n.toString(16).toUpperCase();
}

/** Bytes as rows of sixteen in hexadecimal, then the printable ones, as Zig's writeBytes shows them. */
function writeByteRows(bytes: readonly number[], write: (text: string) => void): void {
  for (let row = 0; row * 16 < bytes.length; row++) {
    const chunk = bytes.slice(row * 16, row * 16 + 16);
    let line = '';
    for (const [column, byte] of chunk.entries()) {
      line += `${byte.toString(16).toUpperCase().padStart(2, '0')} `;
      if (column === 7) line += ' ';
    }
    line += ' ';
    if (chunk.length < 16) line += ' '.repeat((16 - chunk.length) * 3 + (chunk.length < 8 ? 1 : 0));
    for (const byte of chunk) line += visibleByte(byte);
    write(`${line}\n`);
  }
}

function visibleByte(byte: number): string {
  if (byte >= 0x20 && byte < 0x7f) return String.fromCodePoint(byte);
  return byte === 10 ? '␊' : byte === 13 ? '␍' : byte === 9 ? '␉' : '.';
}

/** `expectEqualStrings`: both strings, then the line where they first differ. */
function stringsFailure(expected: number[], actual: number[]): Failure | undefined {
  const diff = firstDifference(actual, expected);
  if (diff === undefined) return undefined;
  const line = 1 + expected.slice(0, diff).filter((byte) => byte === 10).length;
  const text = [
    ...utf8('\n====== expected this output: =========\n'),
    ...withVisibleNewlines(expected),
    ...utf8('\n======== instead found this: =========\n'),
    ...withVisibleNewlines(actual),
    ...utf8(`\n======================================\nFirst difference occurs on line ${line}:\nexpected:\n`),
    ...indicatorLine(expected, diff),
    ...utf8('found:\n'),
    ...indicatorLine(actual, diff),
  ];
  return { text, error: 'TestExpectedEqual' };
}

function firstDifference(a: readonly number[], b: readonly number[]): number | undefined {
  const shortest = Math.min(a.length, b.length);
  for (let index = 0; index < shortest; index++) if (a[index] !== b[index]) return index;
  return a.length === b.length ? undefined : shortest;
}

/** `expectStringStartsWith` and `expectStringEndsWith`. */
function affixFailure(actual: number[], affix: number[], end: 'start' | 'end'): Failure | undefined {
  const part =
    end === 'start'
      ? actual.slice(0, Math.min(actual.length, affix.length))
      : actual.length >= affix.length
        ? actual.slice(actual.length - affix.length)
        : actual;
  if (part.length === affix.length && part.every((byte, index) => byte === affix[index])) return undefined;
  const verb =
    end === 'start'
      ? ['to start with: =========', 'instead started with: ===========']
      : ['to end with: =========', 'instead ended with: ==========='];
  return {
    text: [
      ...utf8(`\n====== expected ${verb[0]}\n`),
      ...withVisibleNewlines(affix),
      ...utf8(`\n====== ${verb[1]}\n`),
      ...withVisibleNewlines(part),
      ...utf8('\n========= full output: ==============\n'),
      ...withVisibleNewlines(actual),
      ...utf8('\n======================================\n'),
    ],
    error: end === 'start' ? 'TestExpectedStartsWith' : 'TestExpectedEndsWith',
  };
}

/** Zig's failPrintWithVisibleNewlines: each line, then the rest ended by ␃. */
function withVisibleNewlines(source: readonly number[]): number[] {
  const out: number[] = [];
  let start = 0;
  for (let index = source.indexOf(10); index !== -1; index = source.indexOf(10, start)) {
    out.push(...visibleLine(source.slice(start, index)));
    start = index + 1;
  }
  out.push(...source.slice(start), ...utf8('␃\n'));
  return out;
}

/** Zig's failPrintLine: a line that ends in a space or a tab gets ⏎. */
function visibleLine(line: readonly number[]): number[] {
  const last = line.at(-1);
  return last === 32 || last === 9 ? [...line, ...utf8('⏎\n')] : [...line, 10];
}

/** Zig's failPrintIndicatorLine: the line holding the index, and a caret under it. */
function indicatorLine(source: readonly number[], index: number): number[] {
  const begin = source.lastIndexOf(10, index - 1) + 1;
  const found = source.indexOf(10, index);
  const end = found === -1 ? source.length : found;
  const caret =
    index >= source.length ? '^ (end of string)\n' : `^ ('\\x${source[index].toString(16).padStart(2, '0')}')\n`;
  return [...visibleLine(source.slice(begin, end)), ...utf8(' '.repeat(index - begin)), ...utf8(caret)];
}

function approximateCheck(name: string, mode: 'absolute' | 'relative', error: string): () => Member {
  return fnMember(name, (sema, call) => {
    const args = expectArgs(sema, call, 3, name);
    const operands = peerOperands(sema, args, call.span);
    const type = operands[0].type;
    if (type.kind === 'comptime_float')
      return sema.error(call.span, 'comptime_float の値どうしは、おおよそでは比べられません。');
    if (type.kind !== 'float') return sema.error(call.span, `${name} には浮動小数点数を渡してください。`);
    const format = formatter(sema, call.span);
    return failing(call.span, [error], operands, ([e, a, tolerance]) =>
      approximatelyEqual(e as AnyFloat, a as AnyFloat, tolerance as AnyFloat, type.bits, mode === 'relative')
        ? undefined
        : {
            text: [
              ...utf8('actual '),
              ...format('', a, type),
              ...utf8(`, not within ${mode} tolerance `),
              ...format('', tolerance, type),
              ...utf8(' of expected '),
              ...format('', e, type),
              10,
            ],
            error,
          }
    );
  });
}

type Formatter = (spec: string, value: Value, type: Type) => number[];

const PLAIN: Options = { fill: 32, alignment: 'right' };

/** Prints a value as `std.debug.print` prints it with the specifier. */
function formatter(sema: SemaApi, span: Span): Formatter {
  const info = typeInfo(sema, span);
  return (spec, value, type) => {
    const out = new BytesOutput();
    printValue(out, spec, PLAIN, value, type, info);
    return out.bytes;
  };
}

function checkFormatOf(sema: SemaApi, spec: string, type: Type, span: Span): void {
  try {
    checkFormat(spec, type, typeInfo(sema, span), false);
  } catch (error) {
    if (error instanceof FormatError) sema.error(span, `書式に誤りがあります: ${error.message}`);
    throw error;
  }
}

class BytesOutput implements FormatOutput {
  readonly bytes: number[] = [];
  get length(): number {
    return this.bytes.length;
  }
  push(...bytes: number[]): number {
    this.bytes.push(...bytes);
    return this.bytes.length;
  }
}

function bytesOf(value: Value, frame: Frame): number[] {
  return [...(value as Slice).readBytes((cost) => frame.runtime.spend(cost))];
}

function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}
