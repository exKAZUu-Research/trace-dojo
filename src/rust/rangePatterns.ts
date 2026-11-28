import type { Pattern } from './ast';
import type { Checker } from './checker';
import { constScalarValue } from './constExpressions';
import { endValue } from './exhaustiveness';
import { compileError } from './items';

/** A range pattern runs forwards: `a..=b` with `a <= b` (E0030), and `a..b` with `a < b` (E0579). */
export function checkRangeOrder(c: Checker, pattern: Extract<Pattern, { kind: 'range' }>): void {
  if (!pattern.start || !pattern.end) return;
  const lo = rangeEnd(c, pattern.start);
  const hi = rangeEnd(c, pattern.end);
  if (lo === undefined || hi === undefined || (pattern.inclusive ? lo <= hi : lo < hi)) return;
  compileError(
    pattern.span,
    pattern.inclusive
      ? '範囲のパターンの始まりは、終わり以下にしてください（E0030）。'
      : '終わりを含まない範囲のパターンの始まりは、終わりより小さくしてください（E0579）。'
  );
}

/** The value an end of a range pattern stands for: an integer, a code point, or a float. */
function rangeEnd(c: Checker, end: Pattern): bigint | number | undefined {
  if (end.kind === 'lit' && end.expr.kind === 'float') return end.expr.value;
  if (end.kind === 'lit' && end.expr.kind === 'unary' && end.expr.op === '-' && end.expr.operand.kind === 'float') {
    return -end.expr.operand.value;
  }
  // A constant's value (`LO..=HI`) is known before the program runs, as rustc checks it.
  if (end.kind === 'path' && end.ty) {
    const value = constScalarValue({ kind: 'path', path: end.path, span: end.span }, c.typeScope(), end.ty);
    if (typeof value === 'bigint') return value;
    if (typeof value === 'string') return BigInt(value.codePointAt(0) ?? 0);
  }
  return endValue(end, c.annotations);
}
