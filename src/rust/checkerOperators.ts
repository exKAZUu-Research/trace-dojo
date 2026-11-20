import type { Expr, Span } from './ast';
import type { Checker } from './checker';
import { isPlaceExpr, requireMutablePlace } from './checkerPlaces';
import { collectionKeyTraits } from './collectionBounds';
import { normalize } from './infer';
import { compileError } from './items';
import { BOOL, freshVar, intType, ref, REF_STR, resolve, shallow, type Type, typeToString, UNIT } from './types';

/**
 * Gives each pending operator its result type once its operands' types are known: rustc waits while the left one is
 * a type variable or an untyped number, which finally takes its default type (`i32`, `f64`), or the right one is a
 * type variable. Whether any was settled.
 */
export function settleBinaries(c: Checker, final: boolean): boolean {
  const pending = c.pendingBinaries;
  c.pendingBinaries = [];
  let settled = false;
  for (const binary of pending) {
    const left = normalize(shallow(final ? resolve(binary.leftType, true) : binary.leftType));
    const right = normalize(shallow(binary.rightType));
    // An untyped number on the right takes the left's type, as the one impl for it does.
    const rightUnknown = numericOperand(right);
    if (!final && (numericOperand(left).kind === 'var' || (rightUnknown.kind === 'var' && !rightUnknown.v.literal))) {
      c.pendingBinaries.push(binary);
      continue;
    }
    settled = true;
    settleBinary(c, binary, left, right);
  }
  return settled;
}

function settleBinary(
  c: Checker,
  { expr, leftType, rightType, result }: Checker['pendingBinaries'][number],
  left: Type,
  right: Type
): void {
  const l = numericOperand(left);
  const r = numericOperand(right);
  if (l.kind === 'var' || (r.kind === 'var' && !r.v.literal)) {
    c.requireKnownTypes();
    compileError(expr.opSpan, `型が決まりません（${typeToString(resolve(leftType))} の型を書いてください）。`);
  }
  let output: Type;
  const bitwise = expr.op === '&' || expr.op === '|' || expr.op === '^';
  if (expr.op === '+' && l.kind === 'adt' && l.def.builtin === 'String' && isStrLike(r)) output = l;
  else if (bitwise && l.kind === 'bool' && c.unifier.tryUnify(l, r)) output = l;
  else if (isArithmeticOperand(l) && !(bitwise && l.kind === 'float') && c.unifier.tryUnify(l, r)) output = l;
  else badOperands(expr, leftType, rightType);
  if (!c.unifier.tryUnify(result, output)) {
    compileError(
      expr.opSpan,
      `${typeToString(resolve(left))} ${expr.op} ${typeToString(resolve(right))} の結果は ${typeToString(resolve(output))} ですが、${typeToString(resolve(result))} が必要です。`
    );
  }
}

// code-gauge-allow functionCognitiveComplexity 21 -- Follows the type checking rules of rustc case by case.
export function checkUnary(c: Checker, expr: Extract<Expr, { kind: 'unary' }>, expected: Type | undefined): Type {
  if (expr.op === '*') {
    const type = normalize(shallow(c.settled(c.expr(expr.operand, undefined))));
    if (type.kind === 'ref') return type.target;
    if (type.kind === 'adt' && type.def.builtin === 'Box') return type.args[0];
    if (type.kind === 'var') compileError(expr.span, '型が決まらないので、* で参照をたどれません。');
    compileError(expr.span, `${typeToString(resolve(type))} は参照ではないので、* でたどれません。`);
  }
  if (expr.op === '-' && expr.operand.kind === 'int') c.negatedLiterals.add(expr.operand);
  const operandType = c.expr(expr.operand, expected);
  const t = numericOperand(operandType);
  if (expr.op === '!') {
    if (t.kind === 'bool' || t.kind === 'int' || (t.kind === 'var' && t.v.literal === 'int')) return t;
    compileError(expr.span, `${typeToString(resolve(operandType))} に ! は使えません。`);
  }
  if (t.kind === 'int' && t.name.startsWith('u')) {
    compileError(expr.span, `符号のない整数（${t.name}）に - は使えません。`);
  }
  if (t.kind === 'int' || t.kind === 'float' || (t.kind === 'var' && t.v.literal)) return t;
  if (t.kind === 'var') c.unknownLocal(expr.operand);
  return compileError(expr.span, `${typeToString(resolve(operandType))} に - は使えません。`);
}

/**
 * The number an operand of an operator stands for: std implements the operators for numbers and for shared
 * references to them, one level deep (`&i32 + i32`), but not for `&&i32` or `&mut i32`, which stay as they are.
 */
function numericOperand(type: Type): Type {
  const t = normalize(shallow(type));
  if (t.kind === 'ref' && !t.mutable) {
    const target = normalize(shallow(t.target));
    const isNumber = target.kind === 'int' || target.kind === 'float' || target.kind === 'bool';
    if (isNumber || (target.kind === 'var' && target.v.literal)) return target;
  }
  return t;
}

// code-gauge-allow functionCognitiveComplexity 18 -- Follows the type checking rules of rustc case by case.
export function checkBinary(c: Checker, expr: Extract<Expr, { kind: 'binary' }>, expected: Type | undefined): Type {
  const { op } = expr;
  if (op === '&&' || op === '||') {
    c.coerceExpr(expr.left, BOOL);
    c.coerceExpr(expr.right, BOOL);
    return BOOL;
  }
  if (['==', '!=', '<', '<=', '>', '>='].includes(op)) return checkComparison(c, expr);
  const isArithmetic = ['+', '-', '*', '/', '%'].includes(op);
  const leftType = c.expr(expr.left, isArithmetic || op === '&' || op === '|' || op === '^' ? expected : undefined);
  const left = numericOperand(leftType);
  // rustc picks the impl of an operator on a type not known yet (a closure's parameter) once it is known, and the
  // result's type with it, as the projection `<L as Add<R>>::Output` does.
  if (left.kind === 'var' && !left.v.literal && op !== '<<' && op !== '>>') {
    const result = freshVar();
    c.pendingBinaries.push({ expr, leftType, rightType: c.expr(expr.right, undefined), result });
    return result;
  }
  if (op === '+' && left.kind === 'adt' && left.def.builtin === 'String') {
    c.coerceExpr(expr.right, REF_STR);
    return left;
  }
  if (op === '+' && (left.kind === 'str' || (normalize(shallow(leftType)).kind === 'ref' && isStrLike(leftType)))) {
    compileError(
      expr.opSpan,
      '&str どうしは + でつなげません（String::from("...") + "..." や format! を使ってください）。'
    );
  }
  if (op === '<<' || op === '>>') {
    const rightType = numericOperand(c.expr(expr.right, undefined));
    if (!isIntegral(left) || !isIntegral(rightType)) badOperands(expr, leftType, expr.right.ty as Type);
    return left;
  }
  return arithmeticOrBitwise(c, expr, leftType, left);
}

// code-gauge-allow functionCognitiveComplexity 18 -- Follows the type checking rules of rustc case by case.
function arithmeticOrBitwise(c: Checker, expr: Extract<Expr, { kind: 'binary' }>, leftType: Type, left: Type): Type {
  const { op } = expr;
  const rightType = c.expr(expr.right, left.kind === 'var' && !left.v.literal ? undefined : left);
  const right = numericOperand(rightType);
  const set = setOperation(c, expr, leftType, rightType);
  if (set) return set;
  if ((op === '&' || op === '|' || op === '^') && left.kind === 'bool') {
    c.unifyOrError(expr.right.span, BOOL, right);
    return BOOL;
  }
  if (!isArithmeticOperand(left) || !isArithmeticOperand(right)) badOperands(expr, leftType, rightType);
  if (!c.unifier.tryUnify(left, right)) {
    compileError(
      expr.opSpan,
      `${typeToString(resolve(leftType))} と ${typeToString(resolve(rightType))} は、${op} で計算できません（型をそろえてください。as で変換できます）。`
    );
  }
  const result = shallow(left);
  if (result.kind === 'float' && (op === '&' || op === '|' || op === '^')) badOperands(expr, leftType, rightType);
  if (result.kind === 'var' && !result.v.literal) {
    c.deferredChecks.push(() => {
      const final = shallow(resolve(result, true));
      if (final.kind !== 'int' && final.kind !== 'float') badOperands(expr, leftType, rightType);
    });
  }
  return result;
}

/** `&a | &b`, `&`, `-`, and `^` of two sets by reference: their union, intersection, and differences. */
function setOperation(c: Checker, expr: Extract<Expr, { kind: 'binary' }>, left: Type, right: Type): Type | undefined {
  if (!['|', '&', '-', '^'].includes(expr.op)) return undefined;
  const l = normalize(shallow(left));
  if (l.kind !== 'ref') return undefined;
  const set = normalize(shallow(l.target));
  if (set.kind !== 'adt' || (set.def.builtin !== 'HashSet' && set.def.builtin !== 'BTreeSet')) return undefined;
  c.unifyOrError(expr.right.span, l, right);
  c.requireTrait(set.args[0], 'Clone', expr.span);
  for (const bound of collectionKeyTraits(set.def.builtin)) c.requireTrait(set.args[0], bound, expr.span);
  return set;
}

function badOperands(expr: Extract<Expr, { kind: 'binary' }>, left: Type, right: Type): never {
  const l = resolve(left);
  const r = resolve(right);
  const lt = normalize(shallow(l));
  if (lt.kind === 'adt' || lt.kind === 'param' || lt.kind === 'tuple') {
    compileError(
      expr.opSpan,
      `${typeToString(l)} に演算子 ${expr.op} は使えません（演算子の多重定義は、この採点環境では使えません）。`
    );
  }
  compileError(expr.opSpan, `${typeToString(l)} と ${typeToString(r)} は、${expr.op} で計算できません。`);
}

function checkComparison(c: Checker, expr: Extract<Expr, { kind: 'binary' }>): Type {
  checkComparisonOperands(c, expr.left, expr.right, expr.op, expr.opSpan);
  return BOOL;
}

export function checkComparisonOperands(c: Checker, left: Expr, right: Expr, op: string, span: Span): [Type, Type] {
  const leftType = c.expr(left, undefined);
  const l = normalize(shallow(leftType));
  // A sequence compares with sequences of other element types (`Vec<String> == [&str; 1]`), so it guides nothing.
  const guides = !(l.kind === 'var' && !l.v.literal) && !isSequence(l);
  const rightType = c.expr(right, guides ? leftType : undefined);
  const r = normalize(shallow(rightType));
  const isEquality = op === '==' || op === '!=';
  const trait = { trait: c.program.traitDef(isEquality ? 'PartialEq' : 'PartialOrd'), args: [rightType] };
  const answer = c.solver.implements(l, trait);
  if (answer === 'yes') return [leftType, rightType];
  if (answer === 'unknown') {
    c.require(l, trait, span);
    return [leftType, rightType];
  }
  if (!c.unifier.tryUnify(leftType, rightType)) {
    const lt = typeToString(resolve(leftType));
    const rt = typeToString(resolve(rightType));
    const lr = l.kind === 'ref' ? normalize(shallow(l.target)) : l;
    const rr = r.kind === 'ref' ? normalize(shallow(r.target)) : r;
    if (c.unifier.tryUnify(lr, rr)) {
      compileError(
        span,
        `${lt} と ${rt} は ${op} で比べられません（* で参照をたどるか、& を付けて、型をそろえてください）。`
      );
    }
    compileError(span, `${lt} と ${rt} は ${op} で比べられません（型をそろえてください）。`);
  }
  c.require(leftType, trait, span);
  return [leftType, rightType];
}

export function checkAssign(c: Checker, expr: Extract<Expr, { kind: 'assign' }>): Type {
  const { target } = expr;
  if (target.kind === 'path' && target.path.segments.length === 1 && target.path.segments[0].name === '_') {
    c.annotations.paths.set(target, { kind: 'discard' });
    c.expr(expr.value, undefined);
    return UNIT;
  }
  const targetType = c.expr(target, undefined);
  if (!isPlaceExpr(c, target)) compileError(target.span, '代入の左辺には、変数やフィールドなどを書いてください。');
  c.coerceAtReferenceSite(expr.value, targetType);
  requireMutablePlace(c, target, '代入する');
  return UNIT;
}

// code-gauge-allow functionCognitiveComplexity 28 -- Follows the type checking rules of rustc case by case.
export function checkCompoundAssign(c: Checker, expr: Extract<Expr, { kind: 'compoundAssign' }>): Type {
  const targetType = c.expr(expr.target, undefined);
  if (!isPlaceExpr(c, expr.target))
    compileError(expr.target.span, '代入の左辺には、変数やフィールドなどを書いてください。');
  const t = normalize(shallow(targetType));
  if (expr.op === '+' && t.kind === 'adt' && t.def.builtin === 'String') {
    c.coerceExpr(expr.value, REF_STR);
  } else if (expr.op === '<<' || expr.op === '>>') {
    const r = numericOperand(c.expr(expr.value, undefined));
    if (!isIntegral(t) || !isIntegral(r))
      compileError(expr.span, `${typeToString(resolve(targetType))} に ${expr.op}= は使えません。`);
  } else {
    const valueType = c.expr(expr.value, t.kind === 'var' && !t.v.literal ? undefined : t);
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
  requireMutablePlace(c, expr.target, '書き換える');
  return UNIT;
}

export function refExpr(c: Checker, expr: Extract<Expr, { kind: 'ref' }>, expected: Type | undefined): Type {
  const e = expected ? normalize(shallow(expected)) : undefined;
  let inner = e?.kind === 'ref' ? e.target : undefined;
  // An array literal takes its elements' type from the slice it is borrowed as (`&[&dyn Shape]`).
  const slicing = expr.operand.kind === 'index' || expr.operand.kind === 'array';
  if (inner && shallow(inner).kind === 'slice' && !slicing) inner = undefined;
  if (inner && shallow(inner).kind === 'str') inner = undefined;
  if (inner) {
    const target = shallow(inner);
    if (target.kind === 'dyn' && !target.trait.fnSig) inner = undefined;
  }
  const type = c.expr(expr.operand, inner);
  if (expr.mutable) requireMutablePlace(c, expr.operand, '&mut で借りる');
  return ref(type, expr.mutable);
}

export function checkCast(c: Checker, expr: Extract<Expr, { kind: 'cast' }>): Type {
  const target = c.lowerType(expr.type);
  const sourceType = c.expr(expr.operand, castExpectation(expr.operand, target));
  const t = normalize(shallow(target));
  if (t.kind === 'var' && !t.v.literal) {
    c.deferredChecks.push(() => validateCast(c, expr, sourceType, target));
    return target;
  }
  return validateCast(c, expr, sourceType, target);
}

// code-gauge-allow functionCognitiveComplexity 20 -- Follows the type checking rules of rustc case by case.
function validateCast(c: Checker, expr: Extract<Expr, { kind: 'cast' }>, sourceType: Type, target: Type): Type {
  const s = normalize(shallow(sourceType));
  const t = normalize(shallow(target));
  const ok = (): Type => target;
  if (t.kind === 'var' && !t.v.literal) compileError(expr.span, '型が決まらないので、as で変換できません。');
  if (s.kind === 'var' && s.v.literal === 'int' && t.kind === 'int') {
    return ok();
  }
  if (isNumber(s) && isNumber(t)) return ok();
  if ((s.kind === 'bool' || s.kind === 'char') && t.kind === 'int') return ok();
  if (s.kind === 'int' && s.name === 'u8' && t.kind === 'char') return ok();
  if (s.kind === 'var' && s.v.literal === 'int' && t.kind === 'char') {
    c.unifier.unify(s, intType('u8'));
    return ok();
  }
  if (
    s.kind === 'adt' &&
    s.def.kind === 'enum' &&
    t.kind === 'int' &&
    s.def.variants.every((v) => v.shape === 'unit')
  ) {
    return ok();
  }
  if (c.unifier.tryUnify(s, t)) return ok();
  // `as` also applies the coercions (`Box::new(1) as Box<dyn Display>`).
  if (s.kind !== 'var' && c.tryCoerce(expr.operand, sourceType, target)) return ok();
  if (s.kind === 'var') compileError(expr.span, '型が決まらないので、as で変換できません。');
  if (t.kind === 'char') {
    compileError(
      expr.span,
      `${typeToString(resolve(sourceType))} は as で char に変換できません（u8 だけが変換できます。char::from_u32 を使ってください）。`
    );
  }
  return compileError(
    expr.span,
    `${typeToString(resolve(sourceType))} は as で ${typeToString(target)} に変換できません。`
  );
}

function isArithmeticOperand(t: Type): boolean {
  return t.kind === 'int' || t.kind === 'float' || t.kind === 'var';
}

function isNumber(t: Type): boolean {
  return t.kind === 'int' || t.kind === 'float' || (t.kind === 'var' && t.v.literal !== undefined);
}

/** Whether the type is a sequence that compares with other sequence types, under any number of references. */
function isSequence(type: Type): boolean {
  const t = stripAll(type);
  return (
    t.kind === 'array' ||
    t.kind === 'slice' ||
    (t.kind === 'adt' && (t.def.builtin === 'Vec' || t.def.builtin === 'VecDeque'))
  );
}

function stripAll(type: Type): Type {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  return t;
}

function isStrLike(type: Type): boolean {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  return t.kind === 'str';
}

function isIntegral(type: Type): boolean {
  const t = normalize(shallow(type));
  return t.kind === 'int' || (t.kind === 'var' && t.v.literal === 'int');
}

/**
 * The type an integer literal cast with `as` takes, as rustc types it: the target integer type, or `u8` for `char`
 * (`300 as u8` overflows, and `-1 as u8` negates an unsigned integer).
 */
function castExpectation(operand: Expr, target: Type): Type | undefined {
  const literal = operand.kind === 'unary' && operand.op === '-' ? operand.operand : operand;
  if (literal.kind !== 'int') return undefined;
  const t = normalize(shallow(target));
  if (t.kind === 'int') return t;
  if (t.kind === 'char') return intType('u8');
  return undefined;
}
