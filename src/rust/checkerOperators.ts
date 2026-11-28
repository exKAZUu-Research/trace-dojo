import type { PathRes } from './annotations';
import { projectionOf } from './assocTypes';
import type { Expr, Span } from './ast';
import type { Checker } from './checker';
import { isPlaceExpr, requireMutablePlace } from './checkerPlaces';
import { collectionKeyTraits } from './collectionBounds';
import { normalize } from './infer';
import { compileError } from './items';
import { derefOnce } from './methods';
import {
  BOOL,
  F32,
  F64,
  freshVar,
  INT_NAMES,
  intType,
  ref,
  REF_STR,
  resolve,
  shallow,
  type Type,
  typeToString,
  UNIT,
} from './types';

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
  const output =
    setOperation(c, expr, left, right) ?? overloadedOutput(c, expr, left, right) ?? settledOutput(c, expr, l, r);
  if (!output) badOperands(expr, leftType, rightType);
  if (!c.unifier.tryUnify(result, output)) {
    compileError(
      expr.opSpan,
      `${typeToString(resolve(left))} ${expr.op} ${typeToString(resolve(right))} の結果は ${typeToString(resolve(output))} ですが、${typeToString(resolve(result))} が必要です。`
    );
  }
}

/** The result of an operator whose left side turned out to be a type an operator trait's impl takes (a struct). */
function overloadedOutput(
  c: Checker,
  expr: Extract<Expr, { kind: 'binary' }>,
  left: Type,
  right: Type
): Type | undefined {
  const traits = BINARY_TRAITS[expr.op];
  if (!traits || !isOverloadable(numericOperand(left)) || isSetOperand(left, expr.op)) return undefined;
  return overloadedOperator(c, expr, traits[0], traits[1], left, [right], expr.opSpan, expr.op);
}

/** The result type of an operator on numbers, booleans, or strings whose types are known, if std implements it. */
function settledOutput(c: Checker, expr: Extract<Expr, { kind: 'binary' }>, l: Type, r: Type): Type | undefined {
  const bitwise = expr.op === '&' || expr.op === '|' || expr.op === '^';
  if (expr.op === '<<' || expr.op === '>>') return isIntegral(l) && isIntegral(r) ? l : undefined;
  if (expr.op === '+' && l.kind === 'adt' && l.def.builtin === 'String' && isStrLike(r)) return l;
  if (bitwise && l.kind === 'bool' && c.unifier.tryUnify(l, r)) return l;
  return isArithmeticOperand(l) && !(bitwise && l.kind === 'float') && c.unifier.tryUnify(l, r) ? l : undefined;
}

export const BINARY_TRAITS: Record<string, [string, string]> = {
  '+': ['Add', 'add'],
  '-': ['Sub', 'sub'],
  '*': ['Mul', 'mul'],
  '/': ['Div', 'div'],
  '%': ['Rem', 'rem'],
  '&': ['BitAnd', 'bitand'],
  '|': ['BitOr', 'bitor'],
  '^': ['BitXor', 'bitxor'],
  '<<': ['Shl', 'shl'],
  '>>': ['Shr', 'shr'],
};

/** Whether an operand's type is one whose operators an impl of an operator trait gives, not the language. */
export function isOverloadable(type: Type): boolean {
  const t = normalize(shallow(type));
  if (t.kind === 'ref') return isOverloadable(t.target);
  if (t.kind === 'adt') return t.def.builtin !== 'String';
  return t.kind === 'param' || t.kind === 'opaque' || t.kind === 'tuple' || t.kind === 'array' || t.kind === 'dyn';
}

/**
 * An operator that an impl of its trait gives (`impl Add for Point`): it calls the trait's method, and its result is
 * the impl's `Output`.
 */
// code-gauge-allow functionParameterCount -- Takes both operands, their types and spans, which every operator check needs.
export function overloadedOperator(
  c: Checker,
  expr: Expr,
  traitName: string,
  method: string,
  self: Type,
  args: Type[],
  span: Span,
  describe: string
): Type {
  const trait = c.program.traitDef(traitName);
  const ref = { trait, args };
  if (c.solver.implements(self, ref) === 'no') {
    compileError(
      span,
      `${typeToString(resolve(self))} に演算子 ${describe} は使えません（${traitName} が実装されていません）。`
    );
  }
  c.require(self, ref, span);
  c.annotations.operators.set(expr, { fn: trait.methods.get(method)!, typeArgs: [self, ...args] });
  return trait.assocTypes.has('Output') ? projectionOf(trait, 'Output', self, args) : UNIT;
}

// code-gauge-allow functionCognitiveComplexity -- Follows the type checking rules of rustc case by case.
export function checkUnary(c: Checker, expr: Extract<Expr, { kind: 'unary' }>, expected: Type | undefined): Type {
  if (expr.op === '*') return checkDeref(c, expr);
  if (expr.op === '-' && expr.operand.kind === 'int') c.negatedLiterals.add(expr.operand);
  const operandType = c.expr(expr.operand, expected);
  const t = numericOperand(operandType);
  if (isOverloadable(t)) {
    const [trait, method] = expr.op === '!' ? ['Not', 'not'] : ['Neg', 'neg'];
    return overloadedOperator(c, expr, trait, method, operandType, [], expr.span, expr.op);
  }
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

/** `*x`: through a reference, a raw pointer, an owner, a `Deref` impl, or a type parameter's `Deref` bound. */
function checkDeref(c: Checker, expr: Extract<Expr, { kind: 'unary' }>): Type {
  const type = normalize(shallow(c.settled(c.expr(expr.operand, undefined))));
  if (type.kind === 'adt' && (type.def.builtin === 'ConstPtr' || type.def.builtin === 'MutPtr')) {
    return rawPointee(c, expr, type);
  }
  const deref = derefOnce(c.program, type);
  if (deref) return deref.type;
  if (type.kind === 'var') compileError(expr.span, '型が決まらないので、* で参照をたどれません。');
  return compileError(expr.span, `${typeToString(resolve(type))} は参照ではないので、* でたどれません。`);
}

/**
 * The number an operand of an operator stands for: std implements the operators for numbers and for shared
 * references to them, one level deep (`&i32 + i32`), but not for `&&i32` or `&mut i32`, which stay as they are.
 */
export function numericOperand(type: Type): Type {
  const t = normalize(shallow(type));
  if (t.kind === 'ref' && !t.mutable) {
    const target = normalize(shallow(t.target));
    const isNumber = target.kind === 'int' || target.kind === 'float' || target.kind === 'bool';
    if (isNumber || (target.kind === 'var' && target.v.literal)) return target;
  }
  return t;
}

// code-gauge-allow functionCognitiveComplexity -- One case per kind of binary operator.
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
  if (left.kind === 'var' && !left.v.literal) {
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
  if (isOverloadable(left) && !isSetOperand(leftType, op)) {
    const rightType = c.expr(expr.right, undefined);
    const [trait, method] = BINARY_TRAITS[op];
    return overloadedOperator(c, expr, trait, method, leftType, [rightType], expr.opSpan, op);
  }
  if (op === '<<' || op === '>>') return checkShift(c, expr, leftType, left);
  return arithmeticOrBitwise(c, expr, leftType, left);
}

function isSetOperand(left: Type, op: string): boolean {
  const l = normalize(shallow(left));
  if (!['|', '&', '-', '^'].includes(op) || l.kind !== 'ref') return false;
  const set = normalize(shallow(l.target));
  return set.kind === 'adt' && (set.def.builtin === 'HashSet' || set.def.builtin === 'BTreeSet');
}

/** The two sides of a shift have types of their own, so a right one not known yet is checked once it is. */
function checkShift(c: Checker, expr: Extract<Expr, { kind: 'binary' }>, leftType: Type, left: Type): Type {
  const rightType = c.expr(expr.right, undefined);
  const right = numericOperand(rightType);
  if (right.kind === 'var' && !right.v.literal) c.pendingBinaries.push({ expr, leftType, rightType, result: left });
  else if (!isIntegral(left) || !isIntegral(right)) badOperands(expr, leftType, rightType);
  return left;
}

// code-gauge-allow functionCognitiveComplexity -- Follows the type checking rules of rustc case by case.
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
  // A number with a type on the right whose impl takes it (`impl Mul<Point> for i32`).
  if (isOverloadable(right)) {
    const [trait, method] = BINARY_TRAITS[op];
    const self = left.kind === 'var' ? (literalSelf(c, left, trait, rightType) ?? resolve(left, true)) : leftType;
    return overloadedOperator(c, expr, trait, method, self, [rightType], expr.opSpan, op);
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

/**
 * The one integer type whose impl of an operator trait takes the right operand, for an integer literal on the left
 * (`3 * Duration::from_millis(7)` is a `u32`), as rustc picks it before falling back to `i32`.
 */
function literalSelf(c: Checker, left: Type & { kind: 'var' }, traitName: string, right: Type): Type | undefined {
  if (left.v.literal !== 'int' && left.v.literal !== 'float') return undefined;
  const ref = { trait: c.program.traitDef(traitName), args: [right] };
  const candidates = left.v.literal === 'int' ? INT_NAMES.map(intType) : [F32, F64];
  const [only, ...others] = candidates.filter((type) => c.solver.implements(type, ref) === 'yes');
  if (!only || others.length > 0) return undefined;
  c.unifier.tryUnify(left, only);
  return only;
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
  c.body.writingUnionField = target.kind === 'field';
  let targetType: Type;
  try {
    targetType = c.expr(target, undefined);
  } finally {
    c.body.writingUnionField = false;
  }
  if (!isPlaceExpr(c, target)) compileError(target.span, '代入の左辺には、変数やフィールドなどを書いてください。');
  c.coerceAtReferenceSite(expr.value, targetType);
  requireMutablePlace(c, target, '代入する');
  return UNIT;
}

/** What `*p` of a raw pointer reaches, which only unsafe code reads; `&raw const *p` names the place unread. */
function rawPointee(c: Checker, expr: Extract<Expr, { kind: 'unary' }>, pointer: Type & { kind: 'adt' }): Type {
  if (c.body.rawDeref !== expr) c.requireUnsafe(expr.span, '生ポインタの参照外し（*p）');
  return pointer.args[0];
}

// code-gauge-allow functionCognitiveComplexity -- References, raw references and constant promotion follow rustc case by case.
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
  c.body.rawBorrowing = expr.raw === true && expr.operand.kind === 'path';
  c.body.rawDeref = expr.raw && expr.operand.kind === 'unary' && expr.operand.op === '*' ? expr.operand : undefined;
  let type: Type;
  try {
    type = c.expr(expr.operand, inner);
  } finally {
    c.body.rawBorrowing = false;
    c.body.rawDeref = undefined;
  }
  if (expr.mutable) requireMutablePlace(c, expr.operand, '&mut で借りる');
  if (!expr.raw) rejectStaticMutBorrow(c, expr.operand, expr.span);
  if (expr.raw) {
    if (!isPlaceExpr(c, expr.operand))
      compileError(expr.operand.span, '&raw の後には、変数やフィールドなどを書いてください。');
    return c.program.builtinType(expr.mutable ? 'MutPtr' : 'ConstPtr', [type]);
  }
  return ref(type, expr.mutable);
}

/**
 * Rejects a borrow of a `static mut` or of a field of one, as rustc 2024's `static_mut_refs` does, whether written
 * (`&A`, `&T.f`) or made by a formatting macro or a method's autoref. A borrow of an element (`&mut A[0]`) borrows
 * what the index gives, which rustc accepts.
 */
export function rejectStaticMutBorrow(c: Checker, place: Expr, span: Span): void {
  let root = place;
  while (root.kind === 'field') root = root.operand;
  const res: PathRes | undefined = root.kind === 'path' ? c.annotations.paths.get(root) : undefined;
  if (res?.kind === 'const' && res.def.ast.isMutable) {
    compileError(span, 'static mut の参照は作れません（&raw const や &raw mut を使ってください）。');
  }
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

// code-gauge-allow functionCognitiveComplexity -- Follows the type checking rules of rustc case by case.
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
    c.fallbackChecks.push(() => validateCast(c, expr, resolve(sourceType, true), target));
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

export function isStrLike(type: Type): boolean {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  return t.kind === 'str';
}

export function isIntegral(type: Type): boolean {
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
