import type { Expr, FormatArgs, FormatPiece, MacroCall, Span } from './ast';
import { claimStrings, stringCapacity, StringGrowth } from './capacity';
import type { Compiler, Eval } from './compiler';
import { evaluateValues, stringish } from './compilerCommon';
import type { WriteChunk } from './debugText';
import type { Spec } from './fmt';
import { normalize } from './infer';
import type { Program } from './items';
import { cloneValue, valuesEqual } from './ops';
import { FmtFailure, type Frame, RustPanic } from './runtime';
import { runtimeType } from './runtimeTypes';
import { outputStream, resolve, shallow } from './types';
import { utf8Length } from './utf8';
import { EnumValue, type FormatterValue, isPlace, type Place, StructValue, UNIT_VALUE, type Value } from './values';

type FormatEval = (frame: Frame, write?: WriteChunk) => string;

type Macro<K extends MacroCall['kind']> = Extract<MacroCall, { kind: K }>;

/** Where std panics when an impl's error reaches `println!` (its `io::Write`) and `format!`. */
const IO_WRITE_FAILURE = {
  message: 'a formatting trait implementation returned an error when the underlying stream did not',
  location: 'core/src/io/write.rs:411:17',
};
const FORMAT_FAILURE = {
  message: 'a formatting trait implementation returned an error when the underlying stream did not: Error',
  location: 'alloc/src/fmt.rs:657:14',
};

const MACROS: { [K in MacroCall['kind']]: (c: Compiler, macro: Macro<K>, span: Span) => Eval } = {
  print: printMacro,
  format: formatMacro,
  write: writeMacro,
  panic: panicMacro,
  assert: assertMacro,
  assertEq: assertEqMacro,
  vec: vecMacro,
  vecRepeat: vecRepeatMacro,
  matches: (c, macro) => {
    const value = c.read(macro.value);
    const matcher = c.compileMatcher(macro.pattern);
    return (frame) => matcher(frame, value(frame), undefined);
  },
  dbg: dbgMacro,
};

export function compileMacro(c: Compiler, expr: Expr, macro: MacroCall): Eval {
  return (MACROS[macro.kind] as (c: Compiler, macro: MacroCall, span: Span) => Eval)(c, macro, expr.span);
}

function formatMacro(c: Compiler, macro: Macro<'format'>): Eval {
  const pieces = foldFormatPieces(macro.format);
  const format = compileFormat(c, macro.format, pieces);
  const literalSize = pieces.reduce((length, piece) => length + (typeof piece === 'string' ? utf8Length(piece) : 0), 0);
  const placeholders = pieces.some((piece) => typeof piece !== 'string');
  const estimate = !placeholders
    ? literalSize
    : typeof pieces[0] !== 'string' && literalSize < 16
      ? 0
      : literalSize * 2;
  return (frame) => {
    const growth = new StringGrowth(estimate);
    const text = formatOrPanic(format, frame, FORMAT_FAILURE, (chunk) => growth.write(chunk));
    return growth.finish(text);
  };
}

function printMacro(c: Compiler, macro: Macro<'print'>): Eval {
  const format = macro.format ? compileFormat(c, macro.format) : () => '';
  const newline = macro.newline ? '\n' : '';
  const stream = macro.stream;
  return (frame) => {
    const text = formatOrPanic(format, frame, IO_WRITE_FAILURE) + newline;
    frame.runtime.write(stream, text);
    return UNIT_VALUE;
  };
}

function writeMacro(c: Compiler, macro: Macro<'write'>): Eval {
  const target = c.read(macro.target);
  const format = macro.format ? compileFormat(c, macro.format) : () => '';
  const newline = macro.newline ? '\n' : '';
  const targetType = normalize(shallow(macro.target.ty!));
  const inner = targetType.kind === 'ref' ? normalize(shallow(targetType.target)) : targetType;
  if (inner.kind === 'adt' && inner.def.builtin === 'String') {
    const throughRef = targetType.kind === 'ref' && macro.target.kind !== 'ref';
    return writeString(c, macro.target, target, throughRef, format, newline);
  }
  const stream = outputStream(inner);
  if (stream) return writeStream(c, macro, target, format, stream, newline);
  const { program } = c;
  return (frame) => {
    let formatter = target(frame);
    while (isPlace(formatter)) formatter = formatter.get();
    const value = formatter as FormatterValue;
    const { text, failed } = formatPartly(format, frame, value.writeChunk);
    const written = text + (failed ? '' : newline);
    frame.runtime.allocateString(value.text.length + written.length, written.length);
    if (!failed && newline) value.writeChunk?.(newline);
    value.text += written;
    return writeResult(program, failed);
  };
}

function writeStream(
  c: Compiler,
  macro: Macro<'write'>,
  target: Eval,
  format: FormatEval,
  stream: 'stdout' | 'stderr',
  newline: string
): Eval {
  return (frame) => {
    target(frame);
    const { text, failed } = formatPartly(format, frame);
    frame.runtime.write(stream, text + (failed ? '' : newline));
    if (failed) throw new RustPanic(IO_WRITE_FAILURE.message, macro.target.span, IO_WRITE_FAILURE.location);
    return writeResult(c.program, false);
  };
}

/** `write!` to a `String`, which it reaches through the `&mut` reference it is given or as a place. */
function writeString(
  c: Compiler,
  targetExpr: Expr,
  target: Eval,
  throughRef: boolean,
  format: FormatEval,
  newline: string
): Eval {
  const place = c.place(targetExpr.kind === 'ref' ? targetExpr.operand : targetExpr);
  const { program } = c;
  return (frame) => {
    const p = throughRef ? (target(frame) as Place) : place(frame);
    const before = p.get() as string;
    const growth = new StringGrowth(stringCapacity(p), utf8Length(before));
    const { text, failed } = formatPartly(format, frame, (chunk) => growth.write(chunk));
    const suffix = failed ? '' : newline;
    growth.write(suffix);
    const written = text + suffix;
    frame.runtime.allocateString(before.length + written.length, written.length);
    growth.store(p, before + written);
    return writeResult(program, failed);
  };
}

function writeResult(program: Program, failed: boolean): Value {
  if (failed) return new EnumValue(program.adtDef('Result'), 1, [new StructValue(program.adtDef('FmtError'), [])]);
  return new EnumValue(program.adtDef('Result'), 0, [UNIT_VALUE]);
}

function panicMacro(c: Compiler, macro: Macro<'panic'>, span: Span): Eval {
  const format = macro.format ? compileFormat(c, macro.format) : undefined;
  const name = macro.name;
  return (frame) => {
    throw new RustPanic(panicMessage(name, format?.(frame)), span);
  };
}

function panicMessage(name: string, text: string | undefined): string {
  if (name === 'panic') return text ?? 'explicit panic';
  const message =
    name === 'unreachable'
      ? 'internal error: entered unreachable code'
      : name === 'todo'
        ? 'not yet implemented'
        : 'not implemented';
  return text === undefined ? message : `${message}: ${text}`;
}

function assertMacro(c: Compiler, macro: Macro<'assert'>, span: Span): Eval {
  const cond = c.value(macro.cond);
  const format = macro.format ? compileFormat(c, macro.format) : undefined;
  const source = macro.text;
  return (frame) => {
    if (!(cond(frame) as boolean)) {
      throw new RustPanic(format ? format(frame) : `assertion failed: ${source}`, span);
    }
    return UNIT_VALUE;
  };
}

function assertEqMacro(c: Compiler, macro: Macro<'assertEq'>, span: Span): Eval {
  const left = c.read(macro.left);
  const right = c.read(macro.right);
  const leftStatic = resolve(macro.left.ty!, true);
  const leftType = runtimeType(leftStatic);
  const rightType = runtimeType(macro.right.ty!);
  const eqType = runtimeType(stringish(leftStatic) ?? leftStatic);
  const format = macro.format ? compileFormat(c, macro.format) : undefined;
  const { equal } = macro;
  return (frame) => {
    const a = left(frame);
    const b = right(frame);
    if (valuesEqual(eqType(frame), a, b) !== equal) {
      const spec = debugSpec(false);
      const l = c.support.formatter.debug(a, leftType(frame), spec, undefined);
      const r = c.support.formatter.debug(b, rightType(frame), spec, undefined);
      const message = format ? `: ${format(frame)}` : '';
      throw new RustPanic(
        `assertion \`left ${equal ? '==' : '!='} right\` failed${message}\n  left: ${l}\n right: ${r}`,
        span
      );
    }
    return UNIT_VALUE;
  };
}

function vecMacro(c: Compiler, macro: Macro<'vec'>): Eval {
  const elems = macro.elems.map((elem) => c.value(elem));
  return (frame) => {
    frame.runtime.allocate(elems.length);
    return claimStrings(evaluateValues(frame, elems));
  };
}

function vecRepeatMacro(c: Compiler, macro: Macro<'vecRepeat'>): Eval {
  const value = c.value(macro.value);
  const count = c.value(macro.count);
  const elemType = runtimeType(macro.value.ty!);
  return (frame) => {
    const item = value(frame);
    const length = Number(count(frame) as bigint);
    frame.runtime.allocate(length);
    frame.runtime.spend(Math.ceil(length / 16));
    const type = elemType(frame);
    return Array.from({ length }, (_, index) => (index === length - 1 ? item : cloneValue(type, item)));
  };
}

function dbgMacro(c: Compiler, macro: Macro<'dbg'>, span: Span): Eval {
  const args = macro.args.map((arg, index) => ({
    value: c.value(arg),
    type: runtimeType(arg.ty!),
    text: macro.texts[index],
  }));
  return (frame) => {
    const values = args.map(({ value, type, text }) => {
      const v = value(frame);
      const shown = c.support.formatter.debug(v, type(frame), debugSpec(true), 0);
      frame.runtime.write('stderr', `[src/main.rs:${span.row + 1}:${span.col}] ${text} = ${shown}\n`);
      return v;
    });
    if (args.length === 0) {
      frame.runtime.write('stderr', `[src/main.rs:${span.row + 1}:${span.col}]\n`);
      return UNIT_VALUE;
    }
    return values.length === 1 ? values[0] : values;
  };
}

function debugSpec(alternate: boolean): Spec {
  return {
    fill: ' ',
    align: undefined,
    sign: undefined,
    alternate,
    zero: false,
    width: undefined,
    precision: undefined,
  };
}

function foldFormatPieces(format: FormatArgs): FormatPiece[] {
  const pieces: FormatPiece[] = [];
  for (const part of format.pieces) {
    const piece = typeof part === 'string' ? part : (plainPlaceholder(part, format.args[part.arg]) ?? part);
    const previous = pieces.at(-1);
    if (typeof previous === 'string' && typeof piece === 'string') pieces[pieces.length - 1] = previous + piece;
    else if (piece !== '') pieces.push(piece);
  }
  return pieces;
}

function plainPlaceholder(part: Exclude<FormatPiece, string>, arg: Expr): string | undefined {
  if (
    part.trait !== 'display' ||
    part.width ||
    part.precision ||
    part.align ||
    part.sign ||
    part.alternate ||
    part.zero
  ) {
    return undefined;
  }
  if (arg.kind === 'str' || arg.kind === 'int') return String(arg.value);
  return undefined;
}

function compileFormat(c: Compiler, format: FormatArgs, pieces = foldFormatPieces(format)): FormatEval {
  const args = format.args.map((arg) => c.read(arg));
  const types = format.args.map((arg) => runtimeType(arg.ty!));
  return (frame, write) => {
    const values = evaluateValues(frame, args);
    frame.runtime.spend();
    return frame.runtime.withRoots(values, () =>
      c.support.formatter.format(
        pieces,
        values,
        types.map((type) => type(frame)),
        write
      )
    );
  };
}

function formatOrPanic(
  format: FormatEval,
  frame: Frame,
  failure: { message: string; location: string },
  write?: WriteChunk
): string {
  try {
    return format(frame, write);
  } catch (error) {
    if (error instanceof FmtFailure) throw new RustPanic(failure.message, { row: 0, col: 0 }, failure.location);
    throw error;
  }
}

/** Formats for `write!`, which writes what the formatting wrote before an impl's error and returns the error. */
function formatPartly(format: FormatEval, frame: Frame, write?: WriteChunk): { text: string; failed: boolean } {
  try {
    return { text: format(frame, write), failed: false };
  } catch (error) {
    if (error instanceof FmtFailure) return { text: error.written, failed: true };
    throw error;
  }
}
