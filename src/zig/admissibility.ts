import type { Expression } from './ast';
import type { SemaApi } from './semaBase';
import { USIZE } from './types';

/** An alignment, as `align(n)` on a variable, a field, a function, or a pointer type writes it; Zig's Sema checks it the same way wherever it stands. */
export function alignmentOperand(sema: SemaApi, expression: Expression): number {
  const value = sema.knownValue(sema.coerce(sema.compile(expression, USIZE), USIZE, expression), '整列') as bigint;
  if (value < 1n) sema.error(expression, '整列の値は 1 以上にしてください。');
  if ((value & (value - 1n)) !== 0n) sema.error(expression, `整列の値 ${value} は、2 のべき乗ではありません。`);
  // Zig holds an alignment in a u29, whose largest power of two is 1 << 28.
  if (value >= 1n << 29n) sema.error(expression, `整列の値 ${value} が大きすぎます（2^28 までです）。`);
  return Number(value);
}
