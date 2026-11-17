import type { Expression, Span } from '../ast';
import { byteValues } from '../builtins';
import { enumLookup } from '../enumLookup';
import {
  checkFormat,
  FormatError,
  type FormatTemplate,
  type Options,
  parseFormat,
  parseFormatTemplate,
  printValue,
  type Segment,
  type TypeInfo,
} from '../fmt';
import { type Frame, withHeldValues, ZigPanic } from '../runtime';
import { copyForFrame, known, runtime, type SemaApi } from '../semaBase';
import {
  arrayOf,
  CONST_U8_SLICE,
  errorSetOf,
  errorUnionOf,
  optionalOf,
  pointerTo,
  type StructField,
  type Type,
  typeName,
  U8,
  U64,
  USIZE,
  VOID,
} from '../types';
import {
  compileTimeReadable,
  ErrorValue,
  NULL,
  Pointer,
  type Slice,
  Some,
  storageLocation,
  type Value,
  type ZStruct,
} from '../values';
import {
  bufferedBytes,
  bufferingWriter,
  CountingFormatOutput,
  isDiscardingWriter,
  writeCounted,
  WRITER,
  writerPointer,
  type WriterState,
  writeTo,
} from './writer';

export interface PreparedPrint {
  args: ZStruct;
  write: (destination?: WriterState) => number[];
}

export interface CompiledPrint {
  (frame: Frame, destination?: WriterState): number[];
  prepare: (frame: Frame) => PreparedPrint;
  formatLength: number;
}

const templates = new WeakMap<SemaApi, WeakMap<object, Map<string, FormatTemplate>>>();

// code-gauge-allow functionCognitiveComplexity 22 -- Checks the complete format against its argument types.
// code-gauge-allow functionNcss 42 -- Keeps format checking and the resulting formatter together.
export function compilePrint(sema: SemaApi, formatArg: Expression, argsArg: Expression, span: Span): CompiledPrint {
  const format = sema.coerce(sema.compile(formatArg, CONST_U8_SLICE), CONST_U8_SLICE, formatArg);
  if (!format.known || !compileTimeReadable(format.value))
    sema.error(
      formatArg,
      '書式の文字列は、コンパイルのときに決まっていなければなりません（文字列のリテラルを書いてください）。'
    );
  const args = sema.compile(argsArg);
  const type = args.type;
  if (type.kind !== 'struct') {
    return sema.error(argsArg, `書式の引数は .{ ... } で渡してください（${typeName(type)} 型です）。`);
  }
  const fields = sema.structFields(type, argsArg);
  const names = fields.map((field) => field.name);
  let segments: Segment[];
  let template: FormatTemplate;
  try {
    template = templateOf(sema, format.value as Slice, formatArg);
    segments = parseFormat(template, names, (cost) => sema.spendCompilation(cost));
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
      checkKnownArguments(sema, segment, fields, span);
    } catch (error) {
      if (error instanceof FormatError) return sema.error(span, `書式に誤りがあります: ${error.message}`);
      throw error;
    }
  }
  const evaluate = args.eval;
  const prepare = (frame: Frame): PreparedPrint => {
    const args = copyForFrame(frame, evaluate(frame), type) as ZStruct;
    return {
      args,
      write: (suppliedDestination) => {
        const destination = suppliedDestination ?? bufferingWriter();
        return withHeldValues(frame, [args], () => {
          appendSegments(frame, destination, segments, fields, args, info, (arg, value) =>
            (formatMethods.get(arg) as FormatMethod)(frame, value, destination)
          );
          return suppliedDestination ? [] : bufferedBytes(frame, destination);
        });
      },
    };
  };
  return Object.assign((frame: Frame, destination?: WriterState) => prepare(frame).write(destination), {
    prepare,
    formatLength: template.length,
  });
}

function templateOf(sema: SemaApi, value: Slice, span: Span): FormatTemplate {
  let storage = templates.get(sema);
  if (!storage) {
    storage = new WeakMap();
    templates.set(sema, storage);
  }
  const location = storageLocation(value.target.slots, value.start);
  let views = storage.get(location.storage);
  if (!views) {
    views = new Map();
    storage.set(location.storage, views);
  }
  const key = `${location.index}:${value.lengthValue}`;
  let template = views.get(key);
  if (!template) {
    sema.reserveStorage(arrayOf(value.lengthValue, U8), span);
    sema.spendCompilation(Math.ceil(value.length / 64));
    template = parseFormatTemplate(byteValues(value).map(Number), (cost) => sema.spendCompilation(cost));
    views.set(key, template);
  }
  return template;
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

function checkKnownArguments(
  sema: SemaApi,
  segment: Extract<Segment, { kind: 'placeholder' }>,
  fields: readonly StructField[],
  span: Span
): void {
  for (const option of [segment.width, segment.precision]) {
    if (option.kind !== 'arg') continue;
    checkFieldCoercion(sema, fields[option.index], optionalOf(USIZE), span);
  }
  if (segment.spec === 'B' || segment.spec === 'Bi') checkFieldCoercion(sema, fields[segment.arg], U64, span, true);
  const value = fields[segment.arg].comptimeValue?.value;
  const limit = segment.spec === 'c' ? 0xffn : segment.spec === 'u' ? 0x1f_ff_ffn : undefined;
  if (limit !== undefined && typeof value === 'bigint' && (value < 0n || value > limit)) {
    throw new FormatError(`type '${segment.spec === 'c' ? 'u8' : 'u21'}' cannot represent integer value '${value}'`);
  }
}

function checkFieldCoercion(sema: SemaApi, field: StructField, target: Type, span: Span, parameter = false): void {
  const source =
    field.comptimeValue && (!parameter || field.type.kind === 'comptime_int')
      ? known(field.type, field.comptimeValue.value, span)
      : runtime(field.type, () => {}, span);
  sema.coerce(source, target, span);
}

function formatOption(value: Value): number | undefined {
  return value === NULL ? undefined : Number((value instanceof Some ? value.value : value) as bigint);
}

function formatMethod(sema: SemaApi, type: Type, span: Span): FormatMethod {
  const invalid = new FormatError(`invalid format string 'f' for type '${typeName(type)}'`);
  if (type.kind !== 'struct' && type.kind !== 'union' && type.kind !== 'enum') throw invalid;
  const decl = sema.findDecl(type, 'format');
  if (!decl || (decl.kind !== 'native' && !decl.syntax.isPub)) throw invalid;
  const fn = sema.functionOf(sema.resolveDecl(decl, span), span);
  const [selfType, writerType] = fn.params;
  if (
    fn.params.length !== 2 ||
    writerType !== pointerTo(WRITER, false) ||
    (selfType !== type && selfType !== pointerTo(type, true))
  ) {
    throw new FormatError(`format には (self: ${typeName(type)}, w: *std.Io.Writer) を受け取らせてください`);
  }
  sema.coerce(
    runtime(fn.returnType, () => {}, span),
    errorUnionOf(errorSetOf(['WriteFailed']), VOID),
    span
  );
  const byPointer = selfType.kind === 'pointer';
  return (frame, value, state) => {
    const writer = writerPointer(state);
    const result = fn.call(frame, [byPointer ? new Pointer({ slots: [value] }, 0) : value, writer]);
    if (result instanceof ErrorValue) throw new PrintWriteError(result);
  };
}

export function typeInfo(sema: SemaApi, span: Span): TypeInfo {
  return {
    structFields: (type) => sema.structFields(type, span),
    enumFields: (type) => enumLookup(sema.enumFields(type), () => sema.spendCompilation()).byValue,
    unionFields: (type) => sema.unionFields(type),
  };
}

export class PrintWriteError extends Error {
  constructor(readonly value: ErrorValue) {
    super(value.name);
    this.name = 'PrintWriteError';
  }
}

// code-gauge-allow functionCognitiveComplexity 24 -- Expands parsed segments and writes partial output before a formatting panic.
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
  const argValue = (index: number): Value =>
    fields[index].comptimeValue ? fields[index].comptimeValue.value : args.slots[index];
  for (const segment of segments) {
    if (segment.kind === 'literal') {
      writeFormatted(frame, destination, segment.bytes);
      continue;
    }
    const options: Options = { fill: segment.fill, alignment: segment.alignment };
    if (segment.width.kind === 'number') options.width = segment.width.value;
    else if (segment.width.kind === 'arg') options.width = formatOption(argValue(segment.width.index));
    if (segment.precision.kind === 'number') options.precision = segment.precision.value;
    else if (segment.precision.kind === 'arg') options.precision = formatOption(argValue(segment.precision.index));
    if (segment.spec === 'f') {
      formatWithMethod(segment.arg, argValue(segment.arg));
    } else {
      const bytes: number[] | CountingFormatOutput = isDiscardingWriter(destination)
        ? new CountingFormatOutput(frame)
        : [];
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

function writeFormatted(frame: Frame, destination: WriterState, bytes: readonly number[] | CountingFormatOutput): void {
  if (bytes instanceof CountingFormatOutput) {
    writeCounted(frame, destination, bytes);
    return;
  }
  const result = writeTo(frame, destination, bytes);
  if (result instanceof ErrorValue) throw new PrintWriteError(result);
}
