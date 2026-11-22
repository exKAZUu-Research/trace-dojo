import { type Annotations, type FnContext, type LocalVar } from './annotations';
import type { Expr, MacroCall, Pattern, Span } from './ast';
import { forEachDirect, patternBindingParts } from './astWalk';
import type { Checker } from './checker';
import { checkParamPatterns } from './checkerPatterns';
import { compileError } from './items';
import { type CaptureMode, captureProjections, projectedBindings } from './loanCaptures';
import { receiverReborrow } from './receiverReborrow';
import { typeAfter } from './regions';
import type { TraitSolver } from './traits';
import {
  callableSignature,
  type ClosureType,
  freshVar,
  newClosureType,
  resolve,
  settleClosure,
  shallow,
  type Type,
  UNIT,
} from './types';

export function checkClosure(c: Checker, expr: Extract<Expr, { kind: 'closure' }>, expected: Type | undefined): Type {
  const expectedSig = expected && closureSignature(c, expected);
  const parentBody = c.body;
  const fn: FnContext = {
    name: '{closure}',
    locals: [],
    slotCount: 0,
    captures: [],
    parent: parentBody.fn,
    isClosure: true,
    isAtomic: false,
    isMove: expr.isMove,
    closureKind: 'Fn',
  };
  const retType = expr.ret ? c.lowerType(expr.ret) : (expectedSig?.ret ?? freshVar());
  if (expectedSig && expectedSig.params.length !== expr.params.length) {
    compileError(expr.span, `クロージャの引数の数が合いません（${expectedSig.params.length} 個が必要です）。`);
  }
  const paramTypes = expr.params.map((param, index) =>
    param.type ? c.lowerType(param.type) : (expectedSig?.params[index] ?? freshVar())
  );
  if (expectedSig) {
    for (const [index, type] of paramTypes.entries())
      c.unifyOrError(expr.params[index].span, expectedSig.params[index], type);
  }
  const closureType = newClosureType(paramTypes, retType);
  c.body = {
    ...parentBody,
    fn,
    retType,
    loops: parentBody.loops,
    scopes: [...parentBody.scopes, new Map()],
    isClosure: true,
  };
  try {
    checkParamPatterns(
      c,
      expr.params.map((param) => param.pattern),
      paramTypes
    );
    c.coerceExpr(expr.body, retType);
  } finally {
    c.body = parentBody;
  }
  analyzeCaptures(c, fn, expr, (closureType as Type & { kind: 'closure' }).closure);
  c.annotations.closures.set(expr, {
    context: fn,
    params: expr.params.flatMap((param) =>
      c.annotations.bindings.get(param.pattern) ? [c.annotations.bindings.get(param.pattern)!] : []
    ),
  });
  return closureType;
}

/** Decides how a closure captures and which closure trait it implements, again later while a type it needs is unknown. */
function analyzeCaptures(
  c: Checker,
  fn: FnContext,
  expr: Extract<Expr, { kind: 'closure' }>,
  closure: ClosureType
): void {
  closure.span = expr.span;
  const analyze = (): boolean => {
    const { isSettled, ...captureInfo } = closureKindOf(fn, expr.body, c.annotations, c.solver);
    fn.closureKind = captureInfo.kind;
    Object.assign(closure, captureInfo);
    return isSettled;
  };
  if (analyze()) return;
  closure.unsettled = [];
  c.unsettledClosures.push({ closure, analyze });
}

/** Repeats the capture analysis of closures that waited for a type, and returns whether one became final. */
export function settleClosures(c: Checker, final: boolean): boolean {
  const waiting = c.unsettledClosures;
  c.unsettledClosures = [];
  for (const entry of waiting) {
    if (entry.analyze() || final) settleClosure(entry.closure);
    else c.unsettledClosures.push(entry);
  }
  return c.unsettledClosures.length < waiting.length;
}

export function closureSignature(c: Checker, type: Type): { params: Type[]; ret: Type } | undefined {
  const t = shallow(type);
  if (t.kind === 'var') return c.varBounds.get(t.v)?.find((bound) => bound.fnSig)?.fnSig;
  return callableSignature(t);
}

/**
 * The closure trait a closure implements, from how its body uses the variables it captures: `FnOnce` when it moves
 * one out (its value is used rather than borrowed), `FnMut` when it mutates one. Records the captures it moves, and
 * how it captures each (by reference, by `&mut`, by value), which decides whether it is `Copy` and `Clone`.
 */
function closureKindOf(
  fn: FnContext,
  body: Expr,
  annotations: Annotations,
  solver: TraitSolver
): Pick<ClosureType, 'kind' | 'movedAt' | 'captures'> & { isSettled: boolean } {
  const uses = new CaptureUses(new Set(fn.captures), annotations, solver);
  uses.visit(body, true);
  fn.movedCaptures = [...uses.moved];
  const modeOf = (place: Expr, binding?: LocalVar): CaptureMode => (fn.isMove ? 'value' : uses.modeOf(place, binding));
  fn.projectedCaptures = new Map(
    fn.captures.map((local) => {
      const fallback = fn.isMove || uses.moved.has(local) ? 'value' : uses.mutated.has(local) ? 'mut' : 'ref';
      return [local, captureProjections(annotations, body, local, modeOf, fallback)];
    })
  );
  const captures = [...fn.projectedCaptures.values()].flat();
  const kind = uses.moved.size > 0 ? 'FnOnce' : uses.mutated.size > 0 ? 'FnMut' : 'Fn';
  return { kind, movedAt: uses.firstMove, captures, isSettled: !uses.dependsOnInference };
}

/** How a closure's body uses the variables it captures: those it moves out and those it modifies. */
class CaptureUses {
  readonly moved = new Set<LocalVar>();
  readonly mutated = new Set<LocalVar>();
  readonly modes = new Map<Expr, CaptureMode>();
  firstMove: { name: string; span: Span } | undefined;
  /** Whether a type not inferred yet, or a closure whose own analysis waits for one, can still turn a use into a move. */
  dependsOnInference = false;

  constructor(
    private readonly captured: ReadonlySet<LocalVar>,
    private readonly annotations: Annotations,
    private readonly solver: TraitSolver
  ) {}

  modeOf(place: Expr, binding?: LocalVar): CaptureMode {
    if (!binding) return this.modes.get(place) ?? 'ref';
    if (binding.mode === 'refMut') return 'mut';
    return binding.mode === 'move' && !this.isCopy(binding.type) ? 'value' : 'ref';
  }

  /** Visits an expression, whose value the closure moves when `consumed`. */
  visit(expr: Expr | undefined, consumed: boolean): void {
    if (!expr) return;
    const mutation = mutatedPlace(expr, this.annotations);
    if (mutation) this.mutate(mutation);
    const reference = this.annotations.reborrows.get(expr);
    if (reference !== undefined) {
      consumed = false;
      if (reference) this.mutate(expr);
    }
    if (expr.kind === 'call') this.visitCall(expr);
    if (consumed && expr.kind !== 'index' && !this.isCopy(expr.ty ?? UNIT)) this.move(expr, expr.span);
    const consumes = consumedChildren(
      expr,
      this.annotations,
      (pattern) => bindsByValue(pattern, this.annotations, this.isCopy),
      this.isCopy
    );
    forEachDirect(
      expr,
      (child) => this.visit(child, consumes(child, consumed)),
      (pattern, source) => {
        if (!this.capturedLocal(source)) return false;
        const parts = projectedBindings(pattern, this.annotations);
        if (!parts) return false;
        const moves = parts.some(({ local, throughRef }) => !throughRef && !this.isCopy(local.type));
        this.visit(source, moves);
        return true;
      }
    );
  }

  /** Calling a captured `FnOnce` closure moves it. */
  private visitCall(expr: Extract<Expr, { kind: 'call' }>): void {
    const callee = resolve(expr.callee.ty ?? UNIT);
    if (callee.kind === 'closure' && callee.closure.unsettled) this.dependsOnInference = true;
    if (this.annotations.callKinds.get(expr) === 'FnOnce') this.move(expr.callee, expr.span);
  }

  private mutate(place: Expr): void {
    const local = this.capturedLocal(place);
    if (!local) return;
    this.mutated.add(local);
    if (this.modes.get(place) !== 'value') this.modes.set(place, 'mut');
  }

  private move(expr: Expr, span: Span): void {
    const local = this.capturedLocal(expr);
    if (!local) return;
    this.moved.add(local);
    this.modes.set(expr, 'value');
    this.firstMove ??= { name: local.name, span };
  }

  /** The captured variable a place expression (`v`, `p.a`, `*r`, `v[0]`) is rooted in. */
  private readonly capturedLocal = (expr: Expr): LocalVar | undefined => {
    let current = expr;
    while (current.kind === 'field' || current.kind === 'index' || (current.kind === 'unary' && current.op === '*')) {
      current = current.operand;
    }
    if (current.kind !== 'path') return undefined;
    const res = this.annotations.paths.get(current);
    return res?.kind === 'capture' && this.captured.has(res.local) ? res.local : undefined;
  };

  private readonly isCopy = (type: Type): boolean => {
    // Defaulting number literals' types here would fix them too early; the solver knows they are `Copy` anyway.
    const t = resolve(type);
    if (t.kind !== 'var' || t.v.literal) return this.solver.isCopy(t);
    this.dependsOnInference = true;
    return true;
  };
}

/** Whether a pattern takes a part of what it matches by value that is not `Copy`, which moves it. */
function bindsByValue(pattern: Pattern, annotations: Annotations, isCopy: (type: Type) => boolean): boolean {
  return patternBindingParts(pattern, annotations).some((part) => !part.throughRef && !isCopy(part.local.type));
}

/**
 * The place an expression modifies, which the closure must borrow uniquely: an assignment to it or
 * through it, `&mut` of it, a method taking `&mut self` on it or through a `&mut` it holds, `write!` to it, or a call
 * of an `FnMut` closure it holds.
 */
function mutatedPlace(expr: Expr, annotations: Annotations): Expr | undefined {
  switch (expr.kind) {
    case 'assign':
    case 'compoundAssign': {
      return expr.target;
    }
    case 'ref': {
      return expr.mutable ? expr.operand : undefined;
    }
    case 'methodCall': {
      const method = annotations.methods.get(expr);
      const throughMut =
        (method?.fn.selfMode === 'mutRef' && method.receiver.autoref === 'none') ||
        (method !== undefined && receiverReborrow(method, expr.receiver.ty) !== undefined);
      return method?.receiver.autoref === 'mut' || throughMut ? expr.receiver : undefined;
    }
    case 'call': {
      return annotations.callKinds.get(expr) === 'FnMut' ? expr.callee : undefined;
    }
    case 'macro': {
      if (expr.macro.kind !== 'write') return undefined;
      const { target } = expr.macro;
      return target.kind === 'ref' ? target.operand : target;
    }
    default: {
      return undefined;
    }
  }
}

/** Which children of an expression it uses by value (moves), given whether the expression's own value is moved. */
// code-gauge-allow functionCognitiveComplexity 28 -- One case per kind of expression.
// code-gauge-allow functionNcss 36 -- Rust expressions pass ownership to different positions depending on their syntax.
function consumedChildren(
  expr: Expr,
  annotations: Annotations,
  movesByPattern: (pattern: Pattern) => boolean,
  isCopy: (type: Type) => boolean
): (child: Expr, consumed: boolean) => boolean {
  switch (expr.kind) {
    case 'ref':
    case 'field':
    case 'index':
    case 'closure': {
      return () => false;
    }
    case 'macro': {
      return consumedMacroChildren(expr.macro, movesByPattern);
    }
    case 'match': {
      // A scrutinee moves when a pattern takes a part of it by value.
      const moves = expr.arms.some((arm) => movesByPattern(arm.pattern));
      return (child, consumed) => (child === expr.scrutinee ? moves : consumed);
    }
    case 'while': {
      const moves = expr.cond.kind === 'let' && movesByPattern(expr.cond.pattern);
      return (child) => (child === (expr.cond.kind === 'expr' ? expr.cond.expr : expr.cond.value) ? moves : true);
    }
    case 'unary': {
      return () => expr.op !== '*';
    }
    case 'binary': {
      return () => !['==', '!=', '<', '<=', '>', '>='].includes(expr.op);
    }
    case 'methodCall': {
      const method = annotations.methods.get(expr);
      const byValue =
        method?.fn.selfMode === 'value' &&
        method.receiver.autoref === 'none' &&
        receiverReborrow(method, expr.receiver.ty) === undefined &&
        !isCopy(typeAfter(expr.receiver.ty, method.receiver.derefs) ?? UNIT);
      return (child) => child !== expr.receiver || byValue;
    }
    case 'call': {
      return (child) => child !== expr.callee;
    }
    case 'assign':
    case 'compoundAssign': {
      return (child) => child === expr.value;
    }
    case 'if': {
      const cond = expr.cond.kind === 'expr' ? expr.cond.expr : expr.cond.value;
      const moves = expr.cond.kind === 'let' && movesByPattern(expr.cond.pattern);
      return (child, consumed) =>
        child === cond ? moves : child === expr.consequent.tail || child === expr.else ? consumed : true;
    }
    case 'block': {
      return (child, consumed) => (child === expr.tail ? consumed : true);
    }
    default: {
      return () => true;
    }
  }
}

function consumedMacroChildren(
  macro: MacroCall,
  movesByPattern: (pattern: Pattern) => boolean
): (child: Expr) => boolean {
  switch (macro.kind) {
    case 'vec':
    case 'dbg': {
      return () => true;
    }
    case 'vecRepeat': {
      return (child) => child === macro.value;
    }
    case 'matches': {
      return () => movesByPattern(macro.pattern);
    }
    default: {
      return () => false;
    }
  }
}
