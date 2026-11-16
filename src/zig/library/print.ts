import type { Expression, Span } from '../ast';
import { byteValues } from '../builtins';
import { checkFormat, FormatError, type Options, parseFormat, printValue, type Segment, type TypeInfo } from '../fmt';
import type { Frame } from '../runtime';
import type { SemaApi } from '../semaBase';
import { CONST_U8_SLICE, pointerTo, type StructField, type Type, typeName } from '../types';
import { Pointer, type Value, type ZStruct } from '../values';
import { handle } from './native';
import { WRITER } from './writer';

/** Compiles `print(format, args)`: checks the format against the arguments and returns code giving the bytes. */
export function compilePrint(
  sema: SemaApi,
  formatArg: Expression,
  argsArg: Expression,
  span: Span
): (frame: Frame) => number[] {
  const format = sema.compile(formatArg, CONST_U8_SLICE);
  if (!format.known)
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
    } catch (error) {
      if (error instanceof FormatError) return sema.error(span, `書式に誤りがあります: ${error.message}`);
      throw error;
    }
  }
  const evaluate = args.eval;
  return (frame) =>
    formatBytesOf(segments, fields, evaluate(frame) as ZStruct, info, (arg, value) =>
      (formatMethods.get(arg) as FormatMethod)(frame, value)
    );
}

type FormatMethod = (frame: Frame, value: Value) => number[];

/** `{f}`: calls the value's `format(self, *std.Io.Writer)` method with a writer that collects the bytes. */
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
  return (frame, value) => {
    // A writer without a file or buffer to fill keeps every byte, as writeTo in std.ts handles it.
    const state = { fd: undefined, buffered: [] as number[], capacity: Number.POSITIVE_INFINITY };
    const writer = new Pointer({ slots: [handle('writer', state)] }, 0);
    fn.call(frame, [byPointer ? new Pointer({ slots: [value] }, 0) : value, writer]);
    return state.buffered;
  };
}

export function typeInfo(sema: SemaApi, span: Span): TypeInfo {
  return {
    structFields: (type) => sema.structFields(type, span),
    enumFields: (type) => sema.enumFields(type),
    unionFields: (type) => sema.unionFields(type),
  };
}

function formatBytesOf(
  segments: readonly Segment[],
  fields: readonly StructField[],
  args: ZStruct,
  info: TypeInfo,
  formatWithMethod: (arg: number, value: Value) => number[]
): number[] {
  const out: number[] = [];
  const argValue = (index: number): Value => fields[index].comptimeValue ?? args.slots[index];
  for (const segment of segments) {
    if (segment.kind === 'literal') {
      out.push(...segment.bytes);
      continue;
    }
    const options: Options = { fill: segment.fill, alignment: segment.alignment };
    if (segment.width.kind === 'number') options.width = segment.width.value;
    else if (segment.width.kind === 'arg') options.width = Number(argValue(segment.width.index) as bigint);
    if (segment.precision.kind === 'number') options.precision = segment.precision.value;
    else if (segment.precision.kind === 'arg') options.precision = Number(argValue(segment.precision.index) as bigint);
    if (segment.spec === 'f') out.push(...formatWithMethod(segment.arg, argValue(segment.arg)));
    else printValue(out, segment.spec, options, argValue(segment.arg), fields[segment.arg].type as Type, info);
  }
  return out;
}

/** Decodes bytes written to a stream as UTF-8, as a terminal shows them. */
export function decodeOutput(bytes: readonly number[]): string {
  return new TextDecoder().decode(new Uint8Array(bytes));
}
