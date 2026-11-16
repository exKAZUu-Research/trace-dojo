import type { Expression, Span } from '../ast';
import { byteValues } from '../builtins';
import { checkFormat, FormatError, type Options, parseFormat, printValue, type Segment, type TypeInfo } from '../fmt';
import type { Frame } from '../runtime';
import type { SemaApi } from '../semaBase';
import { CONST_U8_SLICE, type StructField, type Type, typeName } from '../types';
import type { Value, ZStruct } from '../values';

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
  for (const segment of segments) {
    if (segment.kind !== 'placeholder') continue;
    const hasOptions = segment.width.kind !== 'none' || segment.precision.kind !== 'none';
    try {
      checkFormat(segment.spec, fields[segment.arg].type, info, hasOptions);
    } catch (error) {
      if (error instanceof FormatError) return sema.error(span, `書式に誤りがあります: ${error.message}`);
      throw error;
    }
  }
  const evaluate = args.eval;
  return (frame) => formatBytesOf(segments, fields, evaluate(frame) as ZStruct, info);
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
  info: TypeInfo
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
    printValue(out, segment.spec, options, argValue(segment.arg), fields[segment.arg].type as Type, info);
  }
  return out;
}

/** Decodes bytes written to a stream as UTF-8, as a terminal shows them. */
export function decodeOutput(bytes: readonly number[]): string {
  return new TextDecoder().decode(new Uint8Array(bytes));
}
