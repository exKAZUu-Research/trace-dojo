import type { Expr, FormatArgs, MacroCall, Span } from './ast';
import { claimStrings } from './capacity';
import type { Compiler, Eval } from './compiler';
import { stringish } from './compilerCommon';
import type { Spec } from './fmt';
import { normalize } from './infer';
import type { Program } from './items';
import { cloneValue, valuesEqual } from './ops';
import { FmtFailure, type Frame, RustPanic } from './runtime';
import { runtimeType } from './runtimeTypes';
import { resolve, shallow } from './types';
import { EnumValue, type FormatterValue, isPlace, type Place, StructValue, UNIT_VALUE, type Value } from './values';

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
  format: (c, macro) => {
    const format = compileFormat(c, macro.format);
    return (frame) => formatOrPanic(format, frame, FORMAT_FAILURE);
  },
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
  const { program } = c;
  return (frame) => {
    let formatter = target(frame);
    while (isPlace(formatter)) formatter = formatter.get();
    const { text, failed } = formatPartly(format, frame);
    const written = text + (failed ? '' : newline);
    frame.runtime.allocateString((formatter as FormatterValue).text.length + written.length, written.length);
    (formatter as FormatterValue).text += written;
    return writeResult(program, failed);
  };
}

/** `write!` to a `String`, which it reaches through the `&mut` reference it is given or as a place. */
function writeString(
  c: Compiler,
  targetExpr: Expr,
  target: Eval,
  throughRef: boolean,
  format: (frame: Frame) => string,
  newline: string
): Eval {
  const place = c.place(targetExpr.kind === 'ref' ? targetExpr.operand : targetExpr);
  const { program } = c;
  return (frame) => {
    const p = throughRef ? (target(frame) as Place) : place(frame);
    const { text, failed } = formatPartly(format, frame);
    const written = text + (failed ? '' : newline);
    frame.runtime.allocateString((p.get() as string).length + written.length, written.length);
    p.set((p.get() as string) + written);
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
    return claimStrings(elems.map((elem) => elem(frame)));
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

function compileFormat(c: Compiler, format: FormatArgs): (frame: Frame) => string {
  const args = format.args.map((arg) => c.read(arg));
  const types = format.args.map((arg) => runtimeType(arg.ty!));
  const { pieces } = format;
  return (frame) => {
    const values = args.map((arg) => arg(frame));
    frame.runtime.spend();
    return c.support.formatter.format(
      pieces,
      values,
      types.map((type) => type(frame))
    );
  };
}

function formatOrPanic(format: Eval, frame: Frame, failure: { message: string; location: string }): string {
  try {
    return format(frame) as string;
  } catch (error) {
    if (error instanceof FmtFailure) throw new RustPanic(failure.message, { row: 0, col: 0 }, failure.location);
    throw error;
  }
}

/** Formats for `write!`, which writes what the formatting wrote before an impl's error and returns the error. */
function formatPartly(format: Eval, frame: Frame): { text: string; failed: boolean } {
  try {
    return { text: format(frame) as string, failed: false };
  } catch (error) {
    if (error instanceof FmtFailure) return { text: error.written, failed: true };
    throw error;
  }
}
