// code-gauge-allow-file fileNcss 632 -- Shares Rust constant propagation between diagnostics and pattern coverage.

import type { ExecutionBudget } from '../interpreter/limits';
import type { Annotations, LocalVar, PathRes } from './annotations';
import type { Block, Condition, Expr, MacroCall, MatchArm, Pattern, Stmt } from './ast';
import { forEachDirect, patternBindings } from './astWalk';
import { constInteger } from './constExpressions';
import { type PropagationMode, propagationModes } from './constPropagation';
import { FLOAT_LIMITS } from './floatLimits';
import { normalize } from './infer';
import { compileError } from './items';
import { castValue, floatArith, wrap } from './ops';
import {
  type ConstDef,
  integerConst,
  intMax,
  intMin,
  type IntName,
  resolve,
  shallow,
  substitute,
  type Type,
} from './types';

/** A constant: a number, a bool, a char, or a tuple or struct of constants keyed by field (`0`, `x`). */
export type Known = bigint | number | boolean | string | Aggregate;
type IntegerOperation = Pick<Extract<Expr, { kind: 'binary' }>, 'op' | 'span'>;

interface Aggregate {
  ctor?: string;
  fields: Map<string, Known | undefined>;
  repeat?: { length: number; item: Known | undefined };
}

export function checkConstOperations(expr: Expr, annotations: Annotations): void {
  if (expr.kind === 'closure') return;
  if (!isConstOperation(expr, annotations)) {
    compileError(expr.span, 'この操作は定数の初期値に使えません。');
  }
  forEachDirect(expr, (child) => checkConstOperations(child, annotations));
}

function isConstOperation(expr: Expr, annotations: Annotations): boolean {
  switch (expr.kind) {
    case 'call': {
      const target = annotations.paths.get(expr.callee);
      return target?.kind === 'ctor' || (target?.kind === 'fn' && target.fn.ast?.isConst === true);
    }
    case 'methodCall': {
      return annotations.methods.get(expr)?.fn.ast?.isConst === true;
    }
    case 'macro': {
      const { macro } = expr;
      if (macro.kind === 'matches' || (macro.kind === 'vec' && macro.elems.length === 0)) return true;
      return (macro.kind === 'assert' || macro.kind === 'panic') && (macro.format?.args.length ?? 0) === 0;
    }
    case 'for':
    case 'try': {
      return false;
    }
    case 'index': {
      return !annotations.indexes.get(expr)?.overloaded;
    }
    case 'binary':
    case 'compoundAssign': {
      const lhs = expr.kind === 'binary' ? expr.left : expr.target;
      const type = checkedType(lhs.ty);
      return !type || ['int', 'float', 'bool', 'char', 'var', 'never'].includes(type.kind);
    }
    default: {
      return true;
    }
  }
}

/**
 * Rejects operations that rustc's deny-by-default lints find always panic, by propagating constants through
 * literals, `const` items, aggregates, and variables as rustc's `KnownPanicsLint` does: arithmetic that overflows
 * (`arithmetic_overflow`), division by zero and indexes of arrays out of bounds (`unconditional_panic`). Like rustc,
 * which lints the reachable code of the function after propagating constants, it skips what a known condition never
 * reaches.
 */
export class ConstLint {
  private readonly known = new Map<LocalVar, Known>();
  private modes = new Map<LocalVar, PropagationMode>();
  /** Whether the code checked last never finishes normally (`return`, `break`), so what follows is unreachable. */
  private diverged = false;

  constructor(
    private readonly annotations: Annotations,
    private readonly evaluating = new Set<ConstDef>(),
    private readonly patternEvaluation = false
  ) {}

  static valueOf(expr: Expr, annotations: Annotations, locals: Iterable<[LocalVar, Known]>): Known | undefined {
    const evaluator = new ConstLint(annotations, new Set(), true);
    for (const [local, value] of locals) evaluator.known.set(local, value);
    return evaluator.expr(expr);
  }

  static bindingsOf(
    pattern: Pattern,
    value: Known | undefined,
    annotations: Annotations
  ): ReadonlyMap<LocalVar, Known> {
    const evaluator = new ConstLint(annotations, new Set(), true);
    evaluator.bind(pattern, value);
    return evaluator.known;
  }

  check(block: Block): void {
    this.modes = propagationModes(block, this.annotations);
    this.block(block);
  }

  checkExpr(expr: Expr): void {
    this.expr(expr);
  }

  private setKnown(local: LocalVar, value: Known | undefined): void {
    const mode = this.modes.get(local) ?? 'full';
    if (value === undefined || mode === 'none' || local.mode !== 'move') this.known.delete(local);
    else this.known.set(local, value);
  }

  /** Ends a basic block: a call, a checked operation, or a branch, after which rustc forgets reassigned variables. */
  private endBlock(): void {
    for (const local of this.known.keys()) if (this.modes.get(local) === 'block') this.known.delete(local);
  }

  private block(block: Block): Known | undefined {
    for (const stmt of block.stmts) {
      if (this.diverged) return undefined;
      this.stmt(stmt);
    }
    return block.tail && !this.diverged ? this.expr(block.tail) : undefined;
  }

  private stmt(stmt: Stmt): void {
    if (stmt.kind === 'let') {
      if (!stmt.init) return;
      const value = this.expr(stmt.init);
      if (!stmt.else) {
        this.bind(stmt.pattern, value);
        return;
      }
      const otherwise = stmt.else;
      const matches = this.bindMatched(stmt.pattern, value);
      if (matches !== true) {
        const diverges = this.branch(() => this.block(otherwise));
        if (matches === false) this.diverged = diverges;
      }
    } else if (stmt.kind === 'expr') {
      this.expr(stmt.expr);
    }
  }

  /** Records the constants that a pattern binds. */
  // code-gauge-allow functionCognitiveComplexity 23 -- Binding mode determines whether the analyzed value is propagated.
  private bind(pattern: Pattern, value: Known | undefined): void {
    if (pattern.kind === 'binding') {
      const local = this.annotations.bindings.get(pattern);
      if (local) this.setKnown(local, value);
      if (this.patternEvaluation && pattern.sub) this.bind(pattern.sub, value);
    } else if (pattern.kind === 'tuple' || pattern.kind === 'tupleStruct') {
      for (const [index, elem] of pattern.elems.entries()) {
        this.bind(elem, knownField(value, String(index)));
      }
    } else if (this.patternEvaluation && pattern.kind === 'struct') {
      for (const { name, pattern: field } of pattern.fields) this.bind(field, knownField(value, name));
    } else if (this.patternEvaluation && pattern.kind === 'ref') {
      this.bind(pattern.pattern, value);
    } else if (this.patternEvaluation && pattern.kind === 'or') {
      const matched = pattern.alternatives.find((alt) => this.matchesPattern(alt, value) === true);
      if (matched) this.bind(matched, value);
    } else {
      for (const local of patternBindings(pattern, this.annotations)) this.setKnown(local, undefined);
    }
  }

  /**
   * Checks code that may not run, which leaves what follows reachable. Its end ends a basic block, so the values it
   * gave to variables that other code assigns too do not reach what follows.
   */
  private branch(check: () => void): boolean {
    check();
    this.endBlock();
    const diverged = this.diverged;
    this.diverged = false;
    return diverged;
  }

  /** Checks an expression's operations, returning its value when it is a constant. */
  // code-gauge-allow functionNcss 35 -- Constant propagation follows each expression kind using its checked type.
  private expr(expr: Expr): Known | undefined {
    switch (expr.kind) {
      case 'int': {
        return intTypeOf(expr.ty) ? expr.value : undefined;
      }
      case 'bool':
      case 'char': {
        return expr.value;
      }
      case 'float': {
        const type = expr.ty && normalize(shallow(resolve(expr.ty, true)));
        return type?.kind === 'float' && type.name === 'f32' ? expr.f32 : expr.value;
      }
      case 'path': {
        return this.path(expr);
      }
      case 'unary': {
        return this.unary(expr);
      }
      case 'binary': {
        return this.binaryExpr(expr);
      }
      case 'cast': {
        return this.cast(expr);
      }
      case 'index': {
        return this.index(expr);
      }
      case 'tuple':
      case 'array': {
        return this.tupleOrArray(expr);
      }
      case 'arrayRepeat': {
        const item = this.annotations.unevaluatedRepeatOperands.has(expr.value) ? undefined : this.expr(expr.value);
        this.expr(expr.count);
        const type = checkedType(expr.ty);
        return this.patternEvaluation && type?.kind === 'array'
          ? { fields: new Map(), repeat: { length: type.len, item } }
          : undefined;
      }
      case 'call':
      case 'methodCall':
      case 'macro':
      case 'try': {
        return this.call(expr);
      }
      default: {
        return this.compoundExpr(expr);
      }
    }
  }

  private compoundExpr(expr: Expr): Known | undefined {
    switch (expr.kind) {
      case 'ref': {
        const operand = this.expr(expr.operand);
        return this.patternEvaluation ? operand : undefined;
      }
      case 'if': {
        if (this.patternEvaluation) return this.constantBranch(expr);
        this.ifExpr(expr);
        return undefined;
      }
      case 'match': {
        const scrutinee = this.expr(expr.scrutinee);
        if (this.patternEvaluation) return this.constantMatch(scrutinee, expr.arms);
        this.match(scrutinee, expr.arms);
        return undefined;
      }
      case 'struct': {
        return this.struct(expr);
      }
      case 'field': {
        const operand = this.expr(expr.operand);
        return knownField(operand, expr.name);
      }
      case 'block': {
        return this.block(expr);
      }
      default: {
        this.controlFlow(expr);
        return undefined;
      }
    }
  }

  // code-gauge-allow functionNcss 42 -- One case per kind of expression.
  private controlFlow(expr: Expr): void {
    switch (expr.kind) {
      case 'assign': {
        const value = this.expr(expr.value);
        if (expr.target.kind !== 'path') this.expr(expr.target);
        this.assign(expr.target, value);
        return;
      }
      case 'compoundAssign': {
        this.compoundAssignment(expr);
        return;
      }
      case 'return':
      case 'break':
      case 'continue': {
        if (expr.kind !== 'continue' && expr.value) this.expr(expr.value);
        this.diverged = true;
        return;
      }
      case 'while':
      case 'loop':
      case 'for': {
        if (expr.kind === 'for') this.expr(expr.iterable);
        this.endBlock();
        if (expr.kind === 'while') {
          const condition = this.condition(expr.cond);
          this.endBlock();
          if (condition === false) return;
        }
        this.branch(() => this.block(expr.body));
        return;
      }
      case 'closure': {
        this.closure(expr);
        return;
      }
      default: {
        forEachDirect(expr, (child) => {
          this.expr(child);
        });
      }
    }
  }

  private path(expr: Extract<Expr, { kind: 'path' }>): Known | undefined {
    const res = this.annotations.paths.get(expr);
    if (res?.kind === 'local') return this.known.get(res.local);
    if (res?.kind === 'const') return this.constant(res.def);
    if (res?.kind === 'builtinConst') return integerConst(res.name) ?? floatLimit(res.name);
    if (res?.kind === 'ctor' && (this.patternEvaluation || res.def.kind === 'enum')) return this.construct(res, []);
    return undefined;
  }

  private constant(def: ConstDef): Known | undefined {
    const { ast, module } = def;
    if (!ast.value || this.evaluating.has(def) || this.evaluating.size >= 64) return undefined;
    if (!this.patternEvaluation && intTypeOf(def.type)) {
      return constInteger(
        ast.value,
        {
          module,
          params: new Map(def.impl?.params.map((param) => [param.name, param])),
          selfType: def.impl?.selfType,
        },
        def.type
      );
    }
    this.evaluating.add(def);
    const result = new ConstLint(this.annotations, this.evaluating, this.patternEvaluation).expr(ast.value);
    this.evaluating.delete(def);
    return result;
  }

  private construct(
    res: Extract<PathRes, { kind: 'ctor' }>,
    fields: Iterable<readonly [string, Known | undefined]>
  ): Aggregate {
    if (!this.patternEvaluation && res.def.kind === 'enum') return aggregate([], `v${res.variant}`);
    const map = new Map(fields);
    const variant = res.def.variants[res.variant];
    return aggregate(
      variant.fields.map(({ name }) => [name, map.get(name)]),
      `v${res.variant}`
    );
  }

  private unary(expr: Extract<Expr, { kind: 'unary' }>): Known | undefined {
    const operand = this.expr(expr.operand);
    if (expr.op === '!' && typeof operand === 'boolean') return !operand;
    if (expr.op === '-' && typeof operand === 'number') return -operand;
    if (expr.op !== '-' || typeof operand !== 'bigint') return undefined;
    const name = intTypeOf(expr.ty);
    if (!name) return undefined;
    const negated = this.checked(-operand, name, expr);
    this.endBlock();
    return negated;
  }

  private binaryExpr(expr: Extract<Expr, { kind: 'binary' }>): Known | undefined {
    if (['==', '!=', '<', '<=', '>', '>='].includes(expr.op)) return this.comparison(expr);
    const result = this.binary(expr);
    this.endBlock();
    return result;
  }

  private cast(expr: Extract<Expr, { kind: 'cast' }>): Known | undefined {
    const operand = this.expr(expr.operand);
    const type = checkedType(expr.ty);
    if (operand === undefined || typeof operand === 'object' || type?.kind !== 'int') return undefined;
    return castValue(operand, type) as Known;
  }

  private tupleOrArray(expr: Extract<Expr, { kind: 'tuple' | 'array' }>): Known | undefined {
    const elems = expr.elems.map((elem, index) => [String(index), this.expr(elem)] as const);
    // rustc does not follow a tuple that holds an array, whose value is no immediate.
    const holdsArray = expr.kind === 'tuple' && expr.elems.some((elem) => isArrayType(elem.ty));
    return holdsArray && !this.patternEvaluation
      ? undefined
      : aggregate(elems, expr.kind === 'tuple' ? 'tuple' : undefined);
  }

  private struct(expr: Extract<Expr, { kind: 'struct' }>): Known | undefined {
    const fields = expr.fields.map(({ name, value }) => [name, this.expr(value)] as const);
    const res = this.annotations.paths.get(expr);
    if (!expr.base) {
      if (this.patternEvaluation && res?.kind === 'ctor') return this.construct(res, fields);
      return aggregate(fields);
    }
    const base = this.expr(expr.base);
    if (this.patternEvaluation && res?.kind === 'ctor' && typeof base === 'object') {
      return this.construct(res, [...base.fields, ...fields]);
    }
    return undefined;
  }

  private closure(expr: Extract<Expr, { kind: 'closure' }>): void {
    const lint = new ConstLint(this.annotations);
    lint.modes = this.modes;
    for (const [local, value] of this.known) lint.known.set(local, value);
    if (expr.body.kind === 'block') lint.block(expr.body);
    else lint.expr(expr.body);
  }

  /** An element of an array at an index, whose bound rustc checks from the array's type. */
  private index(expr: Extract<Expr, { kind: 'index' }>): Known | undefined {
    const operand = this.expr(expr.operand);
    const index = this.expr(expr.index);
    const type = checkedType(expr.operand.ty);
    const array = type?.kind === 'ref' ? checkedType(type.target) : type;
    if (array?.kind === 'array' && typeof index === 'bigint' && index >= BigInt(array.len)) {
      compileError(
        expr.span,
        `この添字（${index}）は、長さ ${array.len} の配列の範囲外なので、実行すると必ず panic します。`
      );
    }
    this.endBlock();
    return typeof index === 'bigint' ? knownField(operand, String(index)) : undefined;
  }

  /** A call ends a basic block; a tuple struct's or a variant's constructor builds its value. */
  private call(expr: Extract<Expr, { kind: 'call' | 'methodCall' | 'macro' | 'try' }>): Known | undefined {
    const res =
      expr.kind === 'call' && expr.callee.kind === 'path' ? this.annotations.paths.get(expr.callee) : undefined;
    if (expr.kind === 'call' && res?.kind === 'ctor') {
      const fields = expr.args.map((arg, index) => [String(index), this.expr(arg)] as const);
      return this.patternEvaluation || res.def.kind === 'enum' ? this.construct(res, fields) : aggregate(fields);
    }
    const message = expr.kind === 'macro' ? assertionMessage(expr.macro) : [];
    let holds = false;
    forEachDirect(expr, (child) => {
      if (!message.includes(child)) holds = this.expr(child) === true;
    });
    // An assertion formats its message only where it fails, so what the message does decides nothing after it, and
    // a condition known to hold never reaches it.
    if (message.length > 0 && !holds) {
      this.branch(() => {
        for (const arg of message) this.expr(arg);
      });
    }
    this.endBlock();
    // What follows a call that never returns (`panic!`, `std::process::exit`) is not reachable.
    if (checkedType(expr.ty)?.kind === 'never') this.diverged = true;
    return undefined;
  }

  /** Checks the branches of an `if` that its condition may take; it diverges when every branch it takes does. */
  private ifExpr(expr: Extract<Expr, { kind: 'if' }>): void {
    const cond = this.condition(expr.cond);
    this.endBlock();
    const then = cond === false ? undefined : this.branch(() => this.block(expr.consequent));
    const otherwise = cond === true || !expr.else ? undefined : this.branch(() => this.expr(expr.else!));
    if (cond === true) this.diverged = then!;
    else if (cond === false) this.diverged = otherwise ?? false;
    else this.diverged = then! && (otherwise ?? false);
  }

  private constantBranch(expr: Extract<Expr, { kind: 'if' }>): Known | undefined {
    const condition = this.condition(expr.cond);
    if (condition === true) return this.block(expr.consequent);
    if (condition === false) return expr.else ? this.expr(expr.else) : aggregate([], 'tuple');
    this.known.clear();
    return undefined;
  }

  private condition(cond: Condition): Known | undefined {
    if (cond.kind === 'expr') return this.expr(cond.expr);
    return this.bindMatched(cond.pattern, this.expr(cond.value));
  }

  private bindMatched(pattern: Pattern, value: Known | undefined): boolean | undefined {
    const matches = this.matchesPattern(pattern, value);
    this.bind(pattern, matches === true ? value : undefined);
    return matches;
  }

  private matchesPattern(pattern: Pattern, value: Known | undefined): boolean | undefined {
    return patternMatches(
      pattern,
      value,
      this.annotations,
      this.patternEvaluation ? (def) => this.constant(def) : undefined
    );
  }

  private constantMatch(scrutinee: Known | undefined, arms: MatchArm[]): Known | undefined {
    for (const arm of arms) {
      const matches = this.matchesPattern(arm.pattern, scrutinee);
      if (matches === undefined) break;
      if (!matches) continue;
      this.bind(arm.pattern, scrutinee);
      return this.expr(arm.body);
    }
    this.known.clear();
    return undefined;
  }

  /** Checks the arms a known scrutinee may reach: those before and at the first arm whose pattern surely matches. */
  private match(scrutinee: Known | undefined, arms: MatchArm[]): void {
    this.endBlock();
    let allDiverge = true;
    for (const arm of arms) {
      const matches = this.matchesPattern(arm.pattern, scrutinee);
      if (matches === false) continue;
      this.bind(arm.pattern, matches === true ? scrutinee : undefined);
      allDiverge = this.branch(() => this.expr(arm.body)) && allDiverge;
      if (matches === true) break;
    }
    this.diverged = allDiverge && arms.length > 0;
  }

  /** An assignment to a variable gives it a value, which its propagation mode may keep. */
  private assign(target: Expr, value: Known | undefined): void {
    const res = target.kind === 'path' ? this.annotations.paths.get(target) : undefined;
    if (res?.kind === 'local') this.setKnown(res.local, value);
  }

  private compoundAssignment(expr: Extract<Expr, { kind: 'compoundAssign' }>): void {
    const right = this.expr(expr.value);
    const readsAfterCheck = ['/', '%', '<<', '>>'].includes(expr.op);
    if (readsAfterCheck) this.endBlock();
    const left = this.expr(expr.target);
    const name = intTypeOf(expr.target.ty);
    const result = name && this.integerBinary(expr, name, left, right);
    this.endBlock();
    this.assign(expr.target, result);
  }

  private binary(expr: Extract<Expr, { kind: 'binary' }>): Known | undefined {
    const left = this.expr(expr.left);
    if (expr.op === '&&' || expr.op === '||') return this.logical(expr, left);
    const right = this.expr(expr.right);
    if (typeof left === 'number' && typeof right === 'number') {
      const type = expr.ty && normalize(shallow(resolve(expr.ty, true)));
      if (type?.kind === 'float') return floatArith(expr.op, left, right, type.name === 'f32');
    }
    const name = intTypeOf(expr.left.ty);
    return name && this.integerBinary(expr, name, left, right);
  }

  // code-gauge-allow functionNcss 39 -- One case per integer operator.
  private integerBinary(
    expr: IntegerOperation,
    name: IntName,
    left: Known | undefined,
    right: Known | undefined
  ): bigint | undefined {
    if (typeof right !== 'bigint') return undefined;
    if ((expr.op === '/' || expr.op === '%') && right === 0n) {
      compileError(expr.span, '0 で割る計算なので、実行すると必ず panic します。');
    }
    if ((expr.op === '/' || expr.op === '%') && right === -1n && left === intMin(name) && left !== 0n) {
      compileError(expr.span, 'この計算は、実行すると必ずあふれます。');
    }
    if ((expr.op === '<<' || expr.op === '>>') && (right < 0n || right >= BigInt(bits(name)))) {
      compileError(expr.span, 'この計算は、実行すると必ずあふれます。');
    }
    if (typeof left !== 'bigint') return undefined;
    switch (expr.op) {
      case '+': {
        return this.checked(left + right, name, expr);
      }
      case '-': {
        return this.checked(left - right, name, expr);
      }
      case '*': {
        return this.checked(left * right, name, expr);
      }
      case '/': {
        return this.checked(left / right, name, expr);
      }
      case '%': {
        return this.checked(left % right, name, expr);
      }
      case '&': {
        return left & right;
      }
      case '|': {
        return left | right;
      }
      case '^': {
        return left ^ right;
      }
      case '<<': {
        return wrap(name, left << right);
      }
      case '>>': {
        return left >> right;
      }
      default: {
        return undefined;
      }
    }
  }

  /** `&&` and `||` evaluate their right operand only when the left one does not decide the result. */
  private logical(expr: Extract<Expr, { kind: 'binary' }>, left: Known | undefined): Known | undefined {
    const decided = expr.op === '||';
    if (left === decided) return decided;
    let right: Known | undefined;
    const evaluate = (): void => void (right = this.expr(expr.right));
    // A left operand that is not known may skip the right one.
    if (left === undefined) this.branch(evaluate);
    else evaluate();
    if (left === !decided) return typeof right === 'boolean' ? right : undefined;
    return right === decided ? decided : undefined;
  }

  // code-gauge-allow duplicateLines 21 -- Each language compares its own constants, as its operators define.
  private comparison(expr: Extract<Expr, { kind: 'binary' }>): Known | undefined {
    const left = ordinal(this.expr(expr.left));
    const right = ordinal(this.expr(expr.right));
    if (left === undefined || right === undefined) return undefined;
    switch (expr.op) {
      case '==': {
        return left === right;
      }
      case '!=': {
        return left !== right;
      }
      case '<': {
        return left < right;
      }
      case '<=': {
        return left <= right;
      }
      case '>': {
        return left > right;
      }
      default: {
        return left >= right;
      }
    }
  }

  private checked(value: bigint, name: IntName, expr: { span: Expr['span'] }): bigint {
    if (value < intMin(name) || value > intMax(name)) {
      compileError(expr.span, 'この計算は、実行すると必ずあふれます。');
    }
    return value;
  }
}

export function knownField(value: Known | undefined, name: string): Known | undefined {
  if (typeof value !== 'object') return undefined;
  if (value.fields.has(name)) return value.fields.get(name);
  const index = Number(name);
  if (value.repeat && (name === '[]' || (Number.isSafeInteger(index) && index >= 0 && index < value.repeat.length))) {
    return value.repeat.item;
  }
  return undefined;
}

export function writeKnownField(
  value: Known | undefined,
  path: string[],
  assigned: Known | undefined
): Known | undefined {
  if (path.length === 0) return assigned;
  if (typeof value !== 'object') return undefined;
  const [field, ...rest] = path;
  if (field === '[]') return writeUnknownIndex(value, rest, assigned);
  const replacement = writeKnownField(knownField(value, field), rest, assigned);
  const fields = new Map([...value.fields, [field, replacement]]);
  return { ...value, fields };
}

function writeUnknownIndex(value: Aggregate, path: string[], assigned: Known | undefined): Known {
  const possiblyUpdated = (item: Known | undefined): Known | undefined =>
    intersectKnown(item, writeKnownField(item, path, assigned));
  const fields = new Map([...value.fields].map(([index, item]) => [index, possiblyUpdated(item)]));
  const repeat = value.repeat && { ...value.repeat, item: possiblyUpdated(value.repeat.item) };
  return { ...value, fields, repeat };
}

export function intersectKnown(a: Known | undefined, b: Known | undefined): Known | undefined {
  if (Object.is(a, b)) return a;
  if (typeof a !== 'object' || typeof b !== 'object' || a.ctor !== b.ctor) return undefined;
  const fields = new Set([...a.fields.keys(), ...b.fields.keys()]);
  const repeat =
    a.repeat && b.repeat && a.repeat.length === b.repeat.length
      ? { length: a.repeat.length, item: intersectKnown(a.repeat.item, b.repeat.item) }
      : undefined;
  return {
    ctor: a.ctor,
    fields: new Map([...fields].map((name) => [name, intersectKnown(knownField(a, name), knownField(b, name))])),
    repeat,
  };
}

export function sameKnown(a: Known | undefined, b: Known | undefined): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a.ctor !== b.ctor || a.fields.size !== b.fields.size)
    return false;
  if (a.repeat?.length !== b.repeat?.length || !sameKnown(a.repeat?.item, b.repeat?.item)) return false;
  return [...a.fields].every(([name, value]) => b.fields.has(name) && sameKnown(value, b.fields.get(name)));
}

const RUNTIME_DROP_TYPES = new Set([
  'String',
  'Vec',
  'Box',
  'VecDeque',
  'BinaryHeap',
  'HashMap',
  'HashSet',
  'BTreeMap',
  'BTreeSet',
]);

export function constantNeedsDrop(def: ConstDef, annotations: Annotations, budget: ExecutionBudget): boolean {
  const moved = new Set<string>();
  if (!needsConstDrop(def.type, undefined, moved, '', 0, budget)) return false;
  const value = def.ast.value && ConstLint.valueOf(def.ast.value, annotations, []);
  return needsConstDrop(def.type, value, moved, '', 0, budget);
}

export function checkConstDrop(
  type: Type | undefined,
  value: Known | undefined,
  moved: ReadonlySet<string>,
  span: Expr['span'],
  budget: ExecutionBudget
): void {
  if (type && needsConstDrop(type, value, moved, '', 0, budget)) {
    compileError(span, 'この値の破棄は定数の初期化中にはできません。');
  }
}

// code-gauge-allow functionCognitiveComplexity 20 -- Destruction depends on active variants and partial moves at each projection.
function needsConstDrop(
  type: Type,
  value: Known | undefined,
  moved: ReadonlySet<string>,
  path: string,
  depth: number,
  budget: ExecutionBudget
): boolean {
  budget.spend();
  if (depth >= 64 || moved.has(path)) return false;
  const t = normalize(shallow(type));
  const fieldNeedsDrop = (name: string, field: Type): boolean =>
    needsConstDrop(field, knownField(value, name), moved, `${path}.${name}`, depth + 1, budget);
  if (t.kind === 'tuple') return t.elems.some((elem, index) => fieldNeedsDrop(String(index), elem));
  if (t.kind === 'array') {
    if (t.len === 0) return false;
    if (typeof value !== 'object') return fieldNeedsDrop('[]', t.elem);
    for (const name of value.fields.keys()) if (fieldNeedsDrop(name, t.elem)) return true;
    return value.fields.size < t.len && fieldNeedsDrop('[]', t.elem);
  }
  if (t.kind !== 'adt') return false;
  if (t.def.builtin && RUNTIME_DROP_TYPES.has(t.def.builtin)) return true;
  const tag = typeof value === 'object' ? value.ctor : undefined;
  const subst = new Map(t.def.params.map((param, index) => [param, t.args[index]]));
  return t.def.variants.some(
    (variant, index) =>
      (!tag || tag === `v${index}`) &&
      variant.fields.some((field) => fieldNeedsDrop(field.name, substitute(field.type, subst)))
  );
}

function ordinal(value: Known | undefined): number | bigint | undefined {
  if (typeof value === 'number' || typeof value === 'bigint') return value;
  if (typeof value === 'string') return value.codePointAt(0);
  return typeof value === 'boolean' ? Number(value) : undefined;
}

function intTypeOf(type: Type | undefined): IntName | undefined {
  const checked = checkedType(type);
  return checked?.kind === 'int' ? checked.name : undefined;
}

/** The arguments of an assertion's message. */
function assertionMessage(macro: MacroCall): Expr[] {
  return (macro.kind === 'assert' || macro.kind === 'assertEq' ? macro.format?.args : undefined) ?? [];
}

function checkedType(type: Type | undefined): Type | undefined {
  return type && normalize(shallow(resolve(type, true)));
}

function isArrayType(type: Type | undefined): boolean {
  return type !== undefined && normalize(shallow(type)).kind === 'array';
}

function bits(name: IntName): number {
  return name === 'isize' || name === 'usize' ? 64 : Number(name.slice(1));
}

/** The value of an integer type's associated constant (`i32::MAX`), which rustc's lints know. */
function floatLimit(name: string): number | undefined {
  const [ty, key] = name.split('::');
  return ty === 'f32' || ty === 'f64' ? FLOAT_LIMITS[key]?.[ty] : undefined;
}

function aggregate(fields: Iterable<readonly [string, Known | undefined]>, ctor?: string): Aggregate {
  return { fields: new Map(fields), ctor };
}

/** Whether a pattern matches a constant: surely, surely not, or unknown. */
// code-gauge-allow functionNcss 37 -- Each Rust pattern has distinct rules for deciding whether it can match.
// code-gauge-allow functionCognitiveComplexity 22 -- Each Rust pattern has distinct rules for deciding whether it can match.
function patternMatches(
  pattern: Pattern,
  value: Known | undefined,
  annotations: Annotations,
  constant: ((def: ConstDef) => Known | undefined) | undefined
): boolean | undefined {
  const constructor = annotations.paths.get(pattern);
  if (constructor?.kind === 'ctor') {
    if (typeof value !== 'object' || !value.ctor) return undefined;
    if (value.ctor !== `v${constructor.variant}`) return false;
  } else if (constructor?.kind === 'const') return knownEqual(value, constant?.(constructor.def));
  switch (pattern.kind) {
    case 'path':
    case 'wild': {
      return pattern.kind === 'wild' || constructor?.kind === 'ctor' ? true : undefined;
    }
    case 'binding': {
      return pattern.sub ? patternMatches(pattern.sub, value, annotations, constant) : true;
    }
    case 'lit': {
      const literal = pattern.expr;
      if (value === undefined || !('value' in literal) || typeof literal.value === 'object') return undefined;
      return literal.value === value;
    }
    case 'tuple':
    case 'tupleStruct': {
      if (typeof value !== 'object') return undefined;
      return allKnownMatches(
        pattern.elems.map((child, index) =>
          patternMatches(child, knownField(value, String(index)), annotations, constant)
        )
      );
    }
    case 'struct': {
      return allKnownMatches(
        pattern.fields.map(({ name, pattern: child }) =>
          patternMatches(child, knownField(value, name), annotations, constant)
        )
      );
    }
    case 'ref': {
      return patternMatches(pattern.pattern, value, annotations, constant);
    }
    case 'or': {
      const results = pattern.alternatives.map((alternative) =>
        patternMatches(alternative, value, annotations, constant)
      );
      if (results.includes(true)) return true;
      return results.every((result) => result === false) ? false : undefined;
    }
    default: {
      return undefined;
    }
  }
}

function allKnownMatches(results: (boolean | undefined)[]): boolean | undefined {
  if (results.includes(false)) return false;
  return results.every((result) => result === true) ? true : undefined;
}

function knownEqual(left: Known | undefined, right: Known | undefined): boolean | undefined {
  if (left === undefined || right === undefined) return undefined;
  if (typeof left !== 'object' || typeof right !== 'object') return left === right;
  if (left.repeat || right.repeat) {
    if (!left.repeat || !right.repeat) return undefined;
    if (left.repeat.length !== right.repeat.length) return false;
    const names = new Set([...left.fields.keys(), ...right.fields.keys()]);
    return allKnownMatches([
      knownEqual(left.repeat.item, right.repeat.item),
      ...[...names].map((name) => knownEqual(knownField(left, name), knownField(right, name))),
    ]);
  }
  if (left.ctor !== right.ctor || left.fields.size !== right.fields.size) return false;
  return allKnownMatches([...left.fields].map(([name, value]) => knownEqual(value, right.fields.get(name))));
}
