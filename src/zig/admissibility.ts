import type { Expression, Span } from './ast';
import type { SemaApi, TExpr } from './semaBase';
import { isVectorType, type Type, typeName, USIZE, vectorOf } from './types';

/**
 * The rules for each kind of operand that Zig's Sema checks the same way wherever the operand stands: an alignment, an
 * operand a vector builtin takes, a `@shuffle` mask element, and the operand of a field access. Every operation
 * consults the rule for its operand here rather than writing its own.
 */

/** An alignment, as `align(n)` on a variable, a field, a function, or a pointer type writes it. */
export function alignmentOperand(sema: SemaApi, expression: Expression): number {
  const value = sema.knownValue(sema.coerce(sema.compile(expression, USIZE), USIZE, expression), '整列') as bigint;
  if (value < 1n) sema.error(expression, '整列の値は 1 以上にしてください。');
  if ((value & (value - 1n)) !== 0n) sema.error(expression, `整列の値 ${value} は、2 のべき乗ではありません。`);
  if (value > 1n << 32n) sema.error(expression, `整列の値 ${value} が大きすぎます。`);
  return Number(value);
}

/** An operand that a vector builtin takes as a vector of `element`s, which an array of them also gives. */
export function vectorOperand(sema: SemaApi, value: TExpr, element: Type, span: Span, what: string): TExpr {
  const type = value.type;
  if (type.kind !== 'array')
    return sema.error(
      span,
      `${what}には ${typeName(element)} のベクトルか配列を渡してください（${typeName(type)} 型です）。`
    );
  return sema.coerce(value, vectorOf(type.length, element), span);
}

/** A `@shuffle` mask element, which must select an element of its operand; an undefined operand has none. */
export function checkMaskElement(sema: SemaApi, element: bigint, length: bigint, position: number, span: Span): void {
  const index = element >= 0n ? element : ~element;
  if (index >= length) sema.error(span, `@shuffle のマスクの ${position} 番目 ${element} は、ベクトルの範囲の外です。`);
}

/** The operand of a field access, which a vector, or a pointer to one, does not have. */
export function checkFieldOperand(sema: SemaApi, type: Type, span: Span): void {
  const vector = isVectorType(type) || (type.kind === 'pointer' && type.size === 'one' && isVectorType(type.child));
  if (vector) sema.error(span, `${typeName(type)} 型は、フィールドを参照できません。`);
}
