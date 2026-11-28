import type { Block, Condition, Expr, Span } from './ast';
import { forEachDirect } from './astWalk';
import type { Checker, LoopContext } from './checker';
import { checkCall, checkMethodCall } from './checkerCalls';
import { checkClosure } from './checkerClosures';
import { checkCompoundAssign } from './checkerCompound';
import { checkMacro } from './checkerMacros';
import { checkAssign, checkBinary, checkCast, checkUnary, refExpr } from './checkerOperators';
import { pathExpr, structExpr } from './checkerPaths';
import { checkPattern, requireRefMutSource } from './checkerPatterns';
import { checkField, checkIndex } from './checkerPlaces';
import { constInteger } from './constExpressions';
import { checkConstOperations } from './constLint';
import { lowerPattern, missingPattern } from './exhaustiveness';
import { constParamOf } from './genericArgs';
import { isPseudo, normalize } from './infer';
import { compileError } from './items';
import { intoIterItem } from './iterTypes';
import { RANGE_TYPES } from './traits';
import {
  arrayOfLength,
  BOOL,
  CHAR,
  F32,
  F64,
  freshVar,
  intType,
  NEVER,
  REF_STR,
  resolve,
  shallow,
  type Type,
  typeToString,
  UNIT,
  USIZE,
} from './types';

// code-gauge-allow functionNcss -- One case per kind of expression.
export function exprInner(c: Checker, expr: Expr, expected: Type | undefined): Type {
  switch (expr.kind) {
    case 'int':
    case 'float':
    case 'bool':
    case 'char':
    case 'str': {
      return literalExpr(c, expr, expected);
    }
    case 'path': {
      return pathExpr(c, expr, expected);
    }
    case 'unary': {
      return checkUnary(c, expr, expected);
    }
    case 'binary': {
      return checkBinary(c, expr, expected);
    }
    case 'assign': {
      return checkAssign(c, expr);
    }
    case 'compoundAssign': {
      return checkCompoundAssign(c, expr);
    }
    case 'ref': {
      return refExpr(c, expr, expected);
    }
    case 'cast': {
      return checkCast(c, expr);
    }
    case 'call': {
      return checkCall(c, expr, expected);
    }
    case 'methodCall': {
      return checkMethodCall(c, expr, expected);
    }
    case 'field': {
      return checkField(c, expr);
    }
    case 'index': {
      return checkIndex(c, expr);
    }
    case 'range': {
      return checkRange(c, expr, expected);
    }
    case 'tuple': {
      return tupleExpr(c, expr, expected);
    }
    case 'array': {
      return arrayExpr(c, expr, expected);
    }
    case 'arrayRepeat': {
      return arrayRepeatExpr(c, expr, expected);
    }
    case 'struct': {
      return structExpr(c, expr, expected);
    }
    case 'block':
    case 'if':
    case 'match':
    case 'loop':
    case 'while':
    case 'for':
    case 'break':
    case 'continue':
    case 'return':
    case 'try': {
      return controlFlowExpr(c, expr, expected);
    }
    case 'closure': {
      return checkClosure(c, expr, expected);
    }
    case 'macro': {
      return checkMacro(c, expr.macro, expected);
    }
  }
}

function literalExpr(
  c: Checker,
  expr: Extract<Expr, { kind: 'int' | 'float' | 'bool' | 'char' | 'str' }>,
  expected: Type | undefined
): Type {
  switch (expr.kind) {
    case 'int': {
      return intLiteral(c, expr, expected);
    }
    case 'float': {
      return floatLiteral(c, expr, expected);
    }
    case 'bool': {
      return BOOL;
    }
    case 'char': {
      return CHAR;
    }
    case 'str': {
      return REF_STR;
    }
  }
}

/** `const { ... }`, which may use no variable from outside it (E0435) and only what constants may do. */
function constBlock(c: Checker, block: Block, expected: Type | undefined): Type {
  const outer = new Set(c.body.fn.locals);
  const type = c.checkBlock(block, expected);
  const visit = (expr: Expr): void => {
    const res = expr.kind === 'path' ? c.annotations.paths.get(expr) : undefined;
    if ((res?.kind === 'local' && outer.has(res.local)) || res?.kind === 'capture') {
      compileError(expr.span, `const ブロックの中では、外の変数 ${res.local.name} を使えません（E0435）。`);
    }
    forEachDirect(expr, visit);
  };
  visit(block);
  checkConstOperations(block, c.annotations);
  return type;
}

function controlFlowExpr(
  c: Checker,
  expr: Extract<
    Expr,
    { kind: 'block' | 'if' | 'match' | 'loop' | 'while' | 'for' | 'break' | 'continue' | 'return' | 'try' }
  >,
  expected: Type | undefined
): Type {
  switch (expr.kind) {
    case 'block': {
      if (expr.isConst) return constBlock(c, expr, expected);
      if (!expr.isUnsafe) return c.checkBlock(expr, expected);
      c.body.unsafeDepth++;
      try {
        return c.checkBlock(expr, expected);
      } finally {
        c.body.unsafeDepth--;
      }
    }
    case 'if': {
      return ifExpr(c, expr, expected);
    }
    case 'match': {
      return matchExpr(c, expr, expected);
    }
    case 'loop': {
      return loopExpr(c, expr);
    }
    case 'while': {
      return whileExpr(c, expr);
    }
    case 'for': {
      return forExpr(c, expr);
    }
    case 'break': {
      return breakExpr(c, expr);
    }
    case 'continue': {
      findLoop(c, expr.label, expr.span, 'continue');
      return NEVER;
    }
    case 'return': {
      return returnExpr(c, expr);
    }
    case 'try': {
      return tryExpr(c, expr);
    }
  }
}

function intLiteral(c: Checker, expr: Extract<Expr, { kind: 'int' }>, expected: Type | undefined): Type {
  c.literals.push(expr);
  if (expr.suffix) return intType(expr.suffix as never);
  const type = freshVar('int');
  if (expected) {
    const e = normalize(shallow(expected));
    if (e.kind === 'int' || (e.kind === 'var' && e.v.literal !== 'float')) c.unifier.tryUnify(type, e);
  }
  return type;
}

function floatLiteral(c: Checker, expr: Extract<Expr, { kind: 'float' }>, expected: Type | undefined): Type {
  c.literals.push(expr);
  if (expr.suffix) return expr.suffix === 'f32' ? F32 : F64;
  const type = freshVar('float');
  if (expected) {
    const e = shallow(expected);
    if (e.kind === 'float' || (e.kind === 'var' && e.v.literal !== 'int')) c.unifier.tryUnify(type, e);
  }
  return type;
}

function tupleExpr(c: Checker, expr: Extract<Expr, { kind: 'tuple' }>, expected: Type | undefined): Type {
  const e = expected ? shallow(expected) : undefined;
  const elems = expr.elems.map((elem, index) => {
    const want = e?.kind === 'tuple' && e.elems.length === expr.elems.length ? e.elems[index] : undefined;
    if (want) {
      c.coerceAtReferenceSite(elem, want);
      return want;
    }
    return c.expr(elem, undefined);
  });
  return { kind: 'tuple', elems };
}

function arrayExpr(c: Checker, expr: Extract<Expr, { kind: 'array' }>, expected: Type | undefined): Type {
  const e = expected ? shallow(expected) : undefined;
  const elem = e?.kind === 'array' || e?.kind === 'slice' ? e.elem : freshVar();
  checkElements(c, expr.elems, elem);
  return { kind: 'array', elem, len: expr.elems.length };
}

function arrayRepeatExpr(c: Checker, expr: Extract<Expr, { kind: 'arrayRepeat' }>, expected: Type | undefined): Type {
  const e = expected ? shallow(expected) : undefined;
  const elem = e?.kind === 'array' ? e.elem : freshVar();
  c.coerceExpr(expr.value, elem);
  const lengthParam = constParamOf(expr.count, { params: c.body.typeParams });
  if (lengthParam) {
    c.coerceExpr(expr.count, USIZE);
    c.deferredChecks.push(() => requireRepeatable(c, expr, elem));
    return arrayOfLength(elem, { kind: 'param', param: lengthParam });
  }
  const len = constUsize(c, expr.count);
  if (len === 0 && c.annotations.paths.get(expr.value)?.kind === 'const') {
    c.annotations.unevaluatedRepeatOperands.add(expr.value);
  }
  c.deferredChecks.push(() => {
    if (len !== 1 && len !== 0) requireRepeatable(c, expr, elem);
  });
  return { kind: 'array', elem, len };
}

/** `[value; count]` copies its value unless the value is a constant (a `const` item or block), which is made anew. */
function requireRepeatable(c: Checker, expr: Extract<Expr, { kind: 'arrayRepeat' }>, elem: Type): void {
  if (c.solver.isCopy(resolve(elem, true))) return;
  const value = expr.value;
  const res = value.kind === 'path' ? c.annotations.paths.get(value) : undefined;
  // A `static` is one value, not a constant made anew at each use.
  const constant = (value.kind === 'block' && value.isConst) || (res?.kind === 'const' && !res.def.ast.isStatic);
  if (!constant) {
    compileError(
      expr.span,
      `[値; 個数] の値は Copy の型にしてください（${typeToString(resolve(elem))} は Copy ではありません）。`
    );
  }
}

function loopExpr(c: Checker, expr: Extract<Expr, { kind: 'loop' }>): Type {
  const breakType = freshVar();
  inLoop(c, expr.label, breakType, () => blockUnit(c, expr.body), expr.isBlock);
  return loopBroke(c, expr) ? breakType : NEVER;
}

function whileExpr(c: Checker, expr: Extract<Expr, { kind: 'while' }>): Type {
  c.withScope(() => {
    checkCondition(c, expr.cond);
    inLoop(c, expr.label, undefined, () => blockUnit(c, expr.body));
  });
  return UNIT;
}

function breakExpr(c: Checker, expr: Extract<Expr, { kind: 'break' }>): Type {
  const loop = findLoop(c, expr.label, expr.span, 'break');
  if (expr.value) {
    if (!loop.breakType)
      compileError(expr.span, 'while や for の break には値を書けません（値を返せるのは loop だけです）。');
    c.coerceExpr(expr.value, loop.breakType);
  } else if (loop.breakType) {
    c.unifyOrError(expr.span, loop.breakType, UNIT);
  }
  (loop as LoopContext & { broke?: boolean }).broke = true;
  return NEVER;
}

function returnExpr(c: Checker, expr: Extract<Expr, { kind: 'return' }>): Type {
  if (expr.value) c.coerceAtReferenceSite(expr.value, c.body.retType);
  else if (!c.unifier.tryUnify(c.body.retType, UNIT)) {
    compileError(expr.span, `return に値が要ります（${typeToString(c.body.retType)} を返してください）。`);
  }
  return NEVER;
}

/** Checks the elements of an array or a `vec!`: each coerces to `elem` when it is known, or else they merge. */
export function checkElements(c: Checker, elems: Expr[], elem: Type): void {
  if (shallow(elem).kind !== 'var') {
    for (const item of elems) c.coerceAtReferenceSite(item, elem);
    return;
  }
  const values = elems.map((item): [Expr, (expected: Type | undefined) => Type] => [
    item,
    (expected) => c.expr(item, expected),
  ]);
  const merged = c.mergeTypes(values, (item, result, type) => c.mismatch(item.span, result, type));
  if (merged) c.unifyOrError(elems[0].span, elem, merged);
}

function constUsize(c: Checker, expr: Expr): number {
  c.coerceExpr(expr, USIZE);
  const { module, typeParams, selfType } = c.body;
  const count = constInteger(expr, { module, params: typeParams, selfType });
  if (count === undefined) {
    compileError(expr.span, '[値; 個数] の個数には、整数のリテラルか定数の式を書いてください。');
  }
  return Number(count);
}

function blockUnit(c: Checker, block: Block): void {
  const type = c.checkBlock(block, UNIT);
  if (shallow(type).kind !== 'never' && !c.unifier.tryUnify(type, UNIT)) {
    compileError(block.tail?.span ?? block.span, `型が合いません（() が必要ですが、${typeToString(type)} です）。`);
  }
}

function inLoop<T>(
  c: Checker,
  label: string | undefined,
  breakType: Type | undefined,
  run: () => T,
  isBlock = false
): T {
  const loop: LoopContext = { label, breakType, context: c.body.fn, isBlock };
  c.body.loops.push(loop);
  try {
    return run();
  } finally {
    c.body.loops.pop();
    (c as { lastLoop?: LoopContext }).lastLoop = loop;
  }
}

function loopBroke(c: Checker, _expr: Expr): boolean {
  const loop = (c as { lastLoop?: LoopContext & { broke?: boolean } }).lastLoop;
  return loop?.broke ?? false;
}

// code-gauge-allow functionCognitiveComplexity -- Labeled blocks and loops resolve break and continue by rustc rules.
function findLoop(c: Checker, label: string | undefined, span: Span, keyword: string): LoopContext {
  for (let index = c.body.loops.length - 1; index >= 0; index--) {
    const loop = c.body.loops[index];
    if (loop.context !== c.body.fn) break;
    if (label === undefined ? !loop.isBlock : loop.label === label) {
      if (label !== undefined)
        (loop as LoopContext & { broke?: boolean }).broke =
          keyword === 'break' ? true : (loop as { broke?: boolean }).broke;
      return loop;
    }
  }
  if (label !== undefined) compileError(span, `ラベル '${label} のループが見つかりません。`);
  return compileError(span, `${keyword} は、ループの中にだけ書けます。`);
}

function checkCondition(c: Checker, cond: Condition): void {
  if (cond.kind === 'expr') {
    c.coerceExpr(cond.expr, BOOL);
    return;
  }
  const type = c.expr(cond.value, undefined);
  checkPattern(c, cond.pattern, type, 'move');
  requireRefMutSource(c, cond.pattern, cond.value);
}

function ifExpr(c: Checker, expr: Extract<Expr, { kind: 'if' }>, expected: Type | undefined): Type {
  return c.withScope(() => {
    checkCondition(c, expr.cond);
    if (!expr.else) {
      blockUnit(c, expr.consequent);
      return UNIT;
    }
    const thenType = c.checkBlock(expr.consequent, expected);
    expr.consequent.ty = thenType;
    // The else branch runs outside the bindings of an `if let`.
    const scopes = c.body.scopes;
    const outer = scopes.slice(0, -1);
    c.body.scopes = outer;
    try {
      const elseType = c.expr(expr.else, expected);
      return joinBranches(c, expr.consequent, thenType, expr.else, elseType, expected);
    } finally {
      c.body.scopes = scopes;
    }
  });
}

/** The type of two branches that must agree, where a diverging branch takes the other's type. */
function joinBranches(
  c: Checker,
  first: Expr,
  firstType: Type,
  second: Expr,
  secondType: Type,
  expected: Type | undefined
): Type {
  if (shallow(firstType).kind === 'never') return secondType;
  if (shallow(secondType).kind === 'never') return firstType;
  if (expected) {
    c.coerce(first, firstType, expected);
    c.coerce(second, secondType, expected);
    return expected;
  }
  return c.mergeTypes(
    [
      [first, firstType],
      [second, secondType],
    ],
    (expr) => {
      const span = expr.kind === 'block' ? (expr.tail?.span ?? expr.span) : expr.span;
      return compileError(
        span,
        `if と else の値の型が合いません（${typeToString(resolve(firstType))} と ${typeToString(resolve(secondType))} です）。`
      );
    }
  ) as Type;
}

// code-gauge-allow functionCognitiveComplexity -- Checks arms, guards and exhaustiveness in order.
function matchExpr(c: Checker, expr: Extract<Expr, { kind: 'match' }>, expected: Type | undefined): Type {
  const scrutinee = c.expr(expr.scrutinee, undefined);
  const arms: [Expr, Type][] = [];
  let completes = false;
  for (const arm of expr.arms) {
    c.withScope(() => {
      checkPattern(c, arm.pattern, scrutinee, 'move');
      requireRefMutSource(c, arm.pattern, expr.scrutinee);
      for (const cond of arm.guard ?? []) checkCondition(c, cond);
      const type = c.expr(arm.body, expected);
      if (shallow(type).kind === 'never') return;
      completes = true;
      if (expected) coerceArm(c, arm.body, type, expected);
      else arms.push([arm.body, type]);
    });
  }
  c.deferCoverage(() => checkExhaustive(c, expr, scrutinee));
  if (expected) return completes ? expected : NEVER;
  const merged = c.mergeTypes(arms, (body, result, type) => {
    const span = body.kind === 'block' ? (body.tail?.span ?? body.span) : body.span;
    return compileError(
      span,
      `match の腕の値の型が合いません（${typeToString(resolve(result))} と ${typeToString(resolve(type))} です）。`
    );
  });
  return merged ?? NEVER;
}

function coerceArm(c: Checker, body: Expr, type: Type, result: Type): void {
  if (!c.tryCoerce(body, type, result)) {
    const span = body.kind === 'block' ? (body.tail?.span ?? body.span) : body.span;
    compileError(
      span,
      `match の腕の値の型が合いません（${typeToString(resolve(result))} と ${typeToString(resolve(type))} です）。`
    );
  }
}

function checkExhaustive(c: Checker, expr: Extract<Expr, { kind: 'match' }>, scrutinee: Type): void {
  // An arm with a guard may not run for a value its pattern matches, so it covers nothing.
  const patterns = expr.arms.filter((arm) => !arm.guard).map((arm) => lowerPattern(arm.pattern, c.annotations));
  const missing = missingPattern(patterns, resolve(scrutinee, true), c.budget);
  if (missing) {
    compileError(
      expr.span,
      `match の腕が足りません（${missing} に合う腕がありません。すべての場合を書くか、_ => の腕を足してください）。`
    );
  }
}

function forExpr(c: Checker, expr: Extract<Expr, { kind: 'for' }>): Type {
  const iterable = c.expr(expr.iterable, undefined);
  const resolved = normalize(shallow(iterable));
  if (resolved.kind === 'var') compileError(expr.iterable.span, '繰り返すものの型が決まりません。');
  const item = intoIterItem(resolved);
  if (!item) {
    const t = typeToString(resolve(iterable));
    if (resolved.kind === 'adt' && resolved.def.builtin === 'String') {
      compileError(
        expr.iterable.span,
        `String は for で繰り返せません（文字を繰り返すには ${'.chars()'} を使います）。`
      );
    }
    compileError(expr.iterable.span, `${t} は for で繰り返せません。`);
  }
  c.annotations.loops.set(expr, { item, from: iterable });
  c.withScope(() => {
    checkPattern(c, expr.pattern, item, 'move');
    c.requireIrrefutable(expr.pattern, item, 'for');
    inLoop(c, expr.label, undefined, () => blockUnit(c, expr.body));
  });
  return UNIT;
}

// code-gauge-allow functionCognitiveComplexity -- Follows the type checking rules of rustc case by case.
function checkRange(c: Checker, expr: Extract<Expr, { kind: 'range' }>, expected: Type | undefined): Type {
  let elem: Type = freshVar();
  const e = expected ? normalize(shallow(expected)) : undefined;
  if (e?.kind === 'adt' && RANGE_TYPES.has(e.def.builtin as string) && e.args.length > 0) elem = e.args[0];
  if (expr.start) c.coerceExpr(expr.start, elem);
  if (expr.end) c.coerceExpr(expr.end, elem);
  const name = expr.start
    ? expr.end
      ? expr.inclusive
        ? 'RangeInclusive'
        : 'Range'
      : 'RangeFrom'
    : expr.end
      ? expr.inclusive
        ? 'RangeToInclusive'
        : 'RangeTo'
      : 'RangeFull';
  if (name === 'RangeFull') return c.program.builtinType('RangeFull');
  return c.program.builtinType(name, [elem]);
}

// code-gauge-allow functionCognitiveComplexity -- Follows rustc's desugaring of `?` for `Option` and `Result`.
function tryExpr(c: Checker, expr: Extract<Expr, { kind: 'try' }>): Type {
  const operand = normalize(shallow(c.expr(expr.operand, undefined)));
  const ret = normalize(shallow(c.body.retType));
  if (operand.kind !== 'adt' || (operand.def.builtin !== 'Result' && operand.def.builtin !== 'Option')) {
    compileError(expr.span, `? は Result か Option の値にだけ使えます（${typeToString(resolve(operand))} です）。`);
  }
  const where = c.body.isClosure ? 'クロージャ' : '関数';
  if (operand.def.builtin === 'Option') {
    if (ret.kind === 'var') c.unifier.unify(ret, c.program.builtinType('Option', [freshVar()]));
    const r = normalize(shallow(c.body.retType));
    if (r.kind !== 'adt' || r.def.builtin !== 'Option') {
      compileError(expr.span, `Option に ? を使うには、${where}が Option を返すようにしてください。`);
    }
    c.annotations.tries.set(expr, { kind: 'option', errorFrom: undefined, errorTo: undefined });
    return operand.args[0];
  }
  if (ret.kind === 'var') c.unifier.unify(ret, c.program.builtinType('Result', [freshVar(), operand.args[1]]));
  const r = normalize(shallow(c.body.retType));
  if (r.kind !== 'adt' || r.def.builtin !== 'Result') {
    compileError(
      expr.span,
      `Result に ? を使うには、${where}が Result を返すようにしてください（main なら fn main() -> Result<(), String> など）。`
    );
  }
  const from = operand.args[1];
  const to = r.args[1];
  const error = normalize(shallow(from));
  if (error.kind === 'adt' && isPseudo(error.def)) c.pendingTryErrors.push({ from, to, span: expr.span });
  else c.convertTryError(from, to, expr.span);
  c.annotations.tries.set(expr, { kind: 'result', errorFrom: from, errorTo: to });
  return operand.args[0];
}
