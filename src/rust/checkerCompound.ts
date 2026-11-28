import type { Expr } from './ast';
import type { Checker } from './checker';
import {
  BINARY_TRAITS,
  isIntegral,
  isOverloadable,
  isStrLike,
  numericOperand,
  overloadedOperator,
} from './checkerOperators';
import { isPlaceExpr, requireMutablePlace } from './checkerPlaces';
import { normalize } from './infer';
import { compileError } from './items';
import { REF_STR, resolve, shallow, type Type, typeToString, UNIT } from './types';

function overloadedCompound(
  c: Checker,
  expr: Extract<Expr, { kind: 'compoundAssign' }>,
  targetType: Type,
  valueType: Type
): void {
  const [trait, method] = BINARY_TRAITS[expr.op];
  overloadedOperator(c, expr, `${trait}Assign`, `${method}_assign`, targetType, [valueType], expr.span, `${expr.op}=`);
}

// code-gauge-allow functionCognitiveComplexity -- Follows rustc's compound assignment rules case by case.
export function checkCompoundAssign(c: Checker, expr: Extract<Expr, { kind: 'compoundAssign' }>): Type {
  const targetType = c.expr(expr.target, undefined);
  if (!isPlaceExpr(c, expr.target))
    compileError(expr.target.span, '代入の左辺には、変数やフィールドなどを書いてください。');
  const t = normalize(shallow(targetType));
  // A target not known yet (a closure's parameter) with a value a program's impl may take picks the operator once
  // the target's type is known, as `a + b` does.
  const unknown = t.kind === 'var' && !t.v.literal;
  const early = unknown ? c.expr(expr.value, undefined) : undefined;
  const value = early && numericOperand(early);
  const undecided = value?.kind === 'var' && !value.v.literal;
  if (early && (isOverloadable(value!) || isStrLike(value!) || undecided)) {
    c.deferredChecks.push(() => deferredCompound(c, expr, targetType, early));
  } else if (expr.op === '+' && t.kind === 'adt' && t.def.builtin === 'String') {
    c.coerceExpr(expr.value, REF_STR);
  } else if (isOverloadable(t)) {
    overloadedCompound(c, expr, targetType, c.expr(expr.value, undefined));
  } else if (expr.op === '<<' || expr.op === '>>') {
    const valueType = early ?? c.expr(expr.value, undefined);
    if (unknown) c.deferredChecks.push(() => checkShiftCompound(expr, targetType, valueType));
    else checkShiftCompound(expr, targetType, valueType);
  } else {
    numericCompound(c, expr, targetType, early ?? c.expr(expr.value, t));
  }
  requireMutablePlace(c, expr.target, '書き換える');
  return UNIT;
}

/** `a <<= b` and `a >>= b`: integers of any types on both sides. */
function checkShiftCompound(expr: Extract<Expr, { kind: 'compoundAssign' }>, target: Type, value: Type): void {
  if (!isIntegral(normalize(shallow(resolve(target)))) || !isIntegral(numericOperand(value)))
    compileError(expr.span, `${typeToString(resolve(target))} に ${expr.op}= は使えません。`);
}

/** `a += b` of a target known only once the program's types are: `String += &str`, an operator impl, or numbers. */
function deferredCompound(
  c: Checker,
  expr: Extract<Expr, { kind: 'compoundAssign' }>,
  target: Type,
  value: Type
): void {
  const known = normalize(shallow(resolve(target)));
  if (expr.op === '+' && known.kind === 'adt' && known.def.builtin === 'String')
    c.unifyOrError(expr.value.span, REF_STR, value);
  else if (isOverloadable(known)) overloadedCompound(c, expr, target, value);
  else {
    numericCompound(c, expr, target, value);
    if (['&', '|', '^'].includes(expr.op) && normalize(shallow(resolve(target, true))).kind === 'float') {
      compileError(expr.span, `${typeToString(resolve(target))} に ${expr.op}= は使えません。`);
    }
  }
}

/** `a += b` on numbers and `bool`: both sides of one type, and bitwise operators for integers and `bool` only. */
function numericCompound(
  c: Checker,
  expr: Extract<Expr, { kind: 'compoundAssign' }>,
  targetType: Type,
  valueType: Type
): void {
  const t = normalize(shallow(targetType));
  const v = numericOperand(valueType);
  const numeric = t.kind === 'int' || t.kind === 'float' || t.kind === 'var';
  const bitwise = ['&', '|', '^'].includes(expr.op);
  const boolOp = t.kind === 'bool' && bitwise;
  if ((!numeric && !boolOp) || !c.unifier.tryUnify(t, v)) {
    if (t.kind === 'adt' || t.kind === 'param') {
      compileError(
        expr.span,
        `${typeToString(resolve(targetType))} に演算子 ${expr.op}= は使えません（演算子の多重定義は、この採点環境では使えません）。`
      );
    }
    compileError(
      expr.span,
      `${typeToString(resolve(targetType))} に ${typeToString(resolve(valueType))} を ${expr.op}= で計算できません（型をそろえてください）。`
    );
  }
  if (bitwise) {
    c.deferredChecks.push(() => {
      if (normalize(shallow(resolve(targetType, true))).kind === 'float') {
        compileError(expr.span, `${typeToString(resolve(targetType))} に ${expr.op}= は使えません。`);
      }
    });
  }
}
