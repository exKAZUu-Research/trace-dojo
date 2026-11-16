import type { Expression, Span } from '../ast';
import { byteValues } from '../builtins';
import { checkFormat, FormatError, type Options, parseFormat, printValue, type Segment, type TypeInfo } from '../fmt';
import { type Frame, withHeldValues, ZigPanic } from '../runtime';
import { copyForFrame, type SemaApi } from '../semaBase';
import { CONST_U8_SLICE, pointerTo, type StructField, type Type, typeName } from '../types';
import { compileTimeReadable, ErrorValue, Pointer, type Value, type ZStruct } from '../values';
import { bufferedBytes, bufferingWriter, WRITER, type WriterState, writerState, writerValue, writeTo } from './writer';

export type CompiledPrint = (frame: Frame, destination?: WriterState) => number[];

// code-gauge-allow functionCognitiveComplexity 21 -- Checks the complete format against its argument types.
// code-gauge-allow functionNcss 39 -- Keeps format checking and the resulting formatter together.
export function compilePrint(sema: SemaApi, formatArg: Expression, argsArg: Expression, span: Span): CompiledPrint {
  const format = sema.compile(formatArg, CONST_U8_SLICE);
  if (!format.known || !compileTimeReadable(format.value))
    sema.error(
      formatArg,
      '書式の文字列は、コンパイルのときに決まっていなければなりません（文字列のリテラルを書いてください）。'
    );
  const formatBytes = byteValues(format.value).map(Number);
  const args = sema.compile(argsArg);
  const type = args.type;
  if (type.kind !== 'struct') {
    return sema.error(argsArg, `書式の引数は .{ ... } で渡してください（${typeName(type)} 型です）。`);
  }
  const fields = sema.structFields(type, argsArg);
  const names = fields.map((field) => field.name);
  let segments: Segment[];
  try {
    segments = parseFormat(formatBytes, names);
  } catch (error) {
    if (error instanceof FormatError) return sema.error(span, `書式の文字列に誤りがあります: ${error.message}`);
    throw error;
  }
  const info = typeInfo(sema, span);
  const formatMethods = new Map<number, FormatMethod>();
  for (const segment of segments) {
    if (segment.kind !== 'placeholder') continue;
    const hasOptions = segment.width.kind !== 'none' || segment.precision.kind !== 'none';
    try {
      if (segment.spec === 'f') formatMethods.set(segment.arg, formatMethod(sema, fields[segment.arg].type, span));
      else checkFormat(segment.spec, fields[segment.arg].type, info, hasOptions);
      checkKnownArguments(segment, fields);
    } catch (error) {
      if (error instanceof FormatError) return sema.error(span, `書式に誤りがあります: ${error.message}`);
      throw error;
    }
  }
  const evaluate = args.eval;
  return (frame, suppliedDestination) => {
    const destination = suppliedDestination ?? bufferingWriter();
    const args = copyForFrame(frame, evaluate(frame), type) as ZStruct;
    return withHeldValues(frame, [args], () => {
      appendSegments(frame, destination, segments, fields, args, info, (arg, value) =>
        (formatMethods.get(arg) as FormatMethod)(frame, value, destination)
      );
      return suppliedDestination ? [] : bufferedBytes(destination);
    });
  };
}

export function printInto(frame: Frame, destination: WriterState, print: CompiledPrint): Value {
  try {
    print(frame, destination);
    return undefined;
  } catch (error) {
    if (error instanceof PrintWriteError) return error.value;
    throw error;
  }
}

type FormatMethod = (frame: Frame, value: Value, destination: WriterState) => void;

/** The checks Zig makes on known arguments: a width or precision is an integer, and `{c}`/`{u}` fit `u8`/`u21`. */
function checkKnownArguments(segment: Extract<Segment, { kind: 'placeholder' }>, fields: readonly StructField[]): void {
  for (const option of [segment.width, segment.precision]) {
    if (option.kind !== 'arg') continue;
    const type = fields[option.index].type;
    if (type.kind !== 'int' && type.kind !== 'comptime_int') {
      throw new FormatError(`expected type '?usize', found '${typeName(type)}'`);
    }
  }
  const value = fields[segment.arg].comptimeValue;
  const limit = segment.spec === 'c' ? 0xffn : segment.spec === 'u' ? 0x1f_ff_ffn : undefined;
  if (limit !== undefined && typeof value === 'bigint' && (value < 0n || value > limit)) {
    throw new FormatError(`type '${segment.spec === 'c' ? 'u8' : 'u21'}' cannot represent integer value '${value}'`);
  }
}

function formatMethod(sema: SemaApi, type: Type, span: Span): FormatMethod {
  const invalid = new FormatError(`invalid format string 'f' for type '${typeName(type)}'`);
  if (type.kind !== 'struct' && type.kind !== 'union' && type.kind !== 'enum') throw invalid;
  const decl = sema.findDecl(type, 'format');
  if (!decl) throw invalid;
  const fn = sema.functionOf(sema.resolveDecl(decl, span), span);
  const [selfType, writerType] = fn.params;
  if (fn.params.length !== 2 || writerType !== pointerTo(WRITER, false)) {
    throw new FormatError(`format には (self: ${typeName(type)}, w: *std.Io.Writer) を受け取らせてください`);
  }
  const byPointer = selfType.kind === 'pointer';
  return (frame, value, state) => {
    const header = writerValue(state);
    const writer = new Pointer({ slots: [header] }, 0);
    try {
      const result = fn.call(frame, [byPointer ? new Pointer({ slots: [value] }, 0) : value, writer]);
      if (result instanceof ErrorValue) throw new PrintWriteError(result);
    } finally {
      Object.assign(state, writerState(header));
    }
  };
}

export function typeInfo(sema: SemaApi, span: Span): TypeInfo {
  return {
    structFields: (type) => sema.structFields(type, span),
    enumFields: (type) => sema.enumFields(type),
    unionFields: (type) => sema.unionFields(type),
  };
}

export class PrintWriteError extends Error {
  constructor(readonly value: ErrorValue) {
    super(value.name);
    this.name = 'PrintWriteError';
  }
}

// code-gauge-allow functionCognitiveComplexity 19 -- Expands parsed segments and writes partial output before a formatting panic.
// code-gauge-allow functionParameterCount 7 -- The formatter shares one writer, its frame, and the parsed argument context.
function appendSegments(
  frame: Frame,
  destination: WriterState,
  segments: readonly Segment[],
  fields: readonly StructField[],
  args: ZStruct,
  info: TypeInfo,
  formatWithMethod: (arg: number, value: Value) => void
): void {
  const argValue = (index: number): Value => fields[index].comptimeValue ?? args.slots[index];
  for (const segment of segments) {
    if (segment.kind === 'literal') {
      writeFormatted(frame, destination, segment.bytes);
      continue;
    }
    const options: Options = { fill: segment.fill, alignment: segment.alignment };
    if (segment.width.kind === 'number') options.width = segment.width.value;
    else if (segment.width.kind === 'arg') options.width = Number(argValue(segment.width.index) as bigint);
    if (segment.precision.kind === 'number') options.precision = segment.precision.value;
    else if (segment.precision.kind === 'arg') options.precision = Number(argValue(segment.precision.index) as bigint);
    if (segment.spec === 'f') {
      formatWithMethod(segment.arg, argValue(segment.arg));
    } else {
      const bytes: number[] = [];
      try {
        printValue(bytes, segment.spec, options, argValue(segment.arg), fields[segment.arg].type as Type, info);
      } catch (error) {
        if (error instanceof ZigPanic) writeFormatted(frame, destination, bytes);
        throw error;
      }
      writeFormatted(frame, destination, bytes);
    }
  }
}

function writeFormatted(frame: Frame, destination: WriterState, bytes: readonly number[]): void {
  const result = writeTo(frame, destination, bytes);
  if (result instanceof ErrorValue) throw new PrintWriteError(result);
}
