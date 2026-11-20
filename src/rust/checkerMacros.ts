import type { FormatArgs, MacroCall, Span } from './ast';
import type { Checker } from './checker';
import { checkElements } from './checkerExpr';
import { checkComparisonOperands } from './checkerOperators';
import { traitInScope } from './checkerPaths';
import { checkPattern } from './checkerPatterns';
import { requireMutablePlace } from './checkerPlaces';
import { normalize } from './infer';
import { compileError, resolveTypePath } from './items';
import { BOOL, freshVar, NEVER, outputStream, resolve, shallow, type Type, typeToString, UNIT, USIZE } from './types';

// code-gauge-allow functionNcss 34 -- One case per kind of macro.
export function checkMacro(c: Checker, macro: MacroCall, expected: Type | undefined): Type {
  switch (macro.kind) {
    case 'print': {
      if (macro.format) formatArgs(c, macro.format);
      return UNIT;
    }
    case 'format': {
      formatArgs(c, macro.format);
      return c.program.builtinType('String');
    }
    case 'write': {
      return writeMacro(c, macro);
    }
    case 'panic': {
      if (macro.format) formatArgs(c, macro.format);
      return NEVER;
    }
    case 'assert': {
      c.coerceExpr(macro.cond, BOOL);
      if (macro.format) formatArgs(c, macro.format);
      return UNIT;
    }
    case 'assertEq': {
      return assertEqMacro(c, macro);
    }
    case 'vec': {
      const elem = vecElem(expected);
      checkElements(c, macro.elems, elem);
      return c.program.builtinType('Vec', [elem]);
    }
    case 'vecRepeat': {
      return vecRepeatMacro(c, macro, expected);
    }
    case 'matches': {
      const type = c.expr(macro.value, undefined);
      c.withScope(() => checkPattern(c, macro.pattern, type, 'move'));
      return BOOL;
    }
    case 'dbg': {
      return dbgMacro(c, macro);
    }
  }
}

function writeMacro(c: Checker, macro: Extract<MacroCall, { kind: 'write' }>): Type {
  const target = normalize(shallow(c.expr(macro.target, undefined)));
  const inner = target.kind === 'ref' ? normalize(shallow(target.target)) : target;
  const isFormatter = inner.kind === 'adt' && inner.def.builtin === 'Formatter';
  const isString = inner.kind === 'adt' && inner.def.builtin === 'String';
  const stream = outputStream(inner);
  if (!isFormatter && !isString && !stream) {
    compileError(
      macro.target.span,
      `write! の書き込み先は、fmt::Formatter、String、標準出力、標準エラー出力のいずれかにしてください（${typeToString(resolve(target))} です）。`
    );
  }
  if (isString || stream) checkWriterTrait(c, macro.target, stream ? 'io' : 'fmt');
  const derefs = target.kind === 'ref' ? ([target.mutable ? 'mutRef' : 'ref'] as const) : [];
  requireMutablePlace(c, macro.target, 'write! で書き込む', derefs);
  if (macro.format) formatArgs(c, macro.format);
  return c.program.builtinType('Result', [UNIT, c.program.builtinType(stream ? 'IoError' : 'FmtError')]);
}

function checkWriterTrait(
  c: Checker,
  target: Extract<MacroCall, { kind: 'write' }>['target'],
  module: 'io' | 'fmt'
): void {
  const write = resolveTypePath([module, 'Write'], c.program.std, target.span);
  if (write.kind !== 'trait' || !traitInScope(c, write.def)) {
    compileError(target.span, `write! で書き込むには、use std::${module}::Write; を書いてください。`);
  }
}

function assertEqMacro(c: Checker, macro: Extract<MacroCall, { kind: 'assertEq' }>): Type {
  const [left, right] = checkComparisonOperands(
    c,
    macro.left,
    macro.right,
    macro.equal ? '==' : '!=',
    macro.right.span
  );
  c.requireTrait(left, 'Debug', macro.left.span);
  c.requireTrait(right, 'Debug', macro.right.span);
  if (macro.format) formatArgs(c, macro.format);
  return UNIT;
}

function vecRepeatMacro(
  c: Checker,
  macro: Extract<MacroCall, { kind: 'vecRepeat' }>,
  expected: Type | undefined
): Type {
  const elem = vecElem(expected);
  c.coerceExpr(macro.value, elem);
  c.coerceExpr(macro.count, USIZE);
  c.requireTrait(elem, 'Clone', macro.value.span);
  return c.program.builtinType('Vec', [elem]);
}

function vecElem(expected: Type | undefined): Type {
  const e = expected ? normalize(shallow(expected)) : undefined;
  return e?.kind === 'adt' && e.def.builtin === 'Vec' ? e.args[0] : freshVar();
}

function dbgMacro(c: Checker, macro: Extract<MacroCall, { kind: 'dbg' }>): Type {
  const types = macro.args.map((arg) => {
    const type = c.expr(arg, undefined);
    c.requireTrait(type, 'Debug', arg.span);
    return type;
  });
  if (types.length === 1) return types[0];
  return { kind: 'tuple', elems: types };
}

function formatArgs(c: Checker, format: FormatArgs): void {
  for (const piece of format.pieces) {
    if (typeof piece === 'string') continue;
    const arg = format.args[piece.arg];
    const type = arg.ty ?? c.expr(arg, undefined);
    const trait = {
      display: 'Display',
      debug: 'Debug',
      lowerHex: 'LowerHex',
      upperHex: 'UpperHex',
      octal: 'Octal',
      binary: 'Binary',
      lowerExp: 'LowerExp',
      upperExp: 'UpperExp',
    }[piece.trait];
    if (trait === 'Display' || trait === 'Debug') c.requireTrait(type, trait, arg.span);
    else requireFormatTrait(c, type, trait, arg.span);
    for (const count of [piece.width, piece.precision]) {
      if (count?.kind === 'arg') {
        const countArg = format.args[count.arg];
        const countType = countArg.ty ?? c.expr(countArg, USIZE);
        c.unifyOrError(countArg.span, USIZE, countType);
      }
    }
  }
  for (const arg of format.args) if (!arg.ty) c.expr(arg, undefined);
}

function requireFormatTrait(c: Checker, type: Type, trait: string, span: Span): void {
  c.deferredChecks.push(() => {
    let t = normalize(shallow(resolve(type, true)));
    while (t.kind === 'ref') t = normalize(shallow(t.target));
    const ok = trait.endsWith('Exp') ? t.kind === 'int' || t.kind === 'float' : t.kind === 'int';
    if (!ok)
      compileError(
        span,
        `${typeToString(resolve(type))} は {:${{ LowerHex: 'x', UpperHex: 'X', Octal: 'o', Binary: 'b', LowerExp: 'e', UpperExp: 'E' }[trait]}} で表示できません。`
      );
  });
}
