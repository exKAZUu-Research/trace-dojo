// code-gauge-allow-file fileNcss 671 -- Follows the borrow checking rules case by case.
import { CompileError } from '../interpreter/diagnostics';
import type { ExecutionBudget } from '../interpreter/limits';
import type { Annotations, FnContext, LocalVar } from './annotations';
import type { Block, Condition, Expr, FnItem, FormatArgs, Pattern, Span, Stmt } from './ast';
import { forEachDirect, patternBindingParts, patternBindings } from './astWalk';
import {
  checkConstDrop,
  ConstLint,
  intersectKnown,
  type Known,
  knownField,
  sameKnown,
  writeKnownField,
} from './constLint';
import { normalize } from './infer';
import { compileError } from './items';
import { LoanBuilder } from './loanBuilder';
import { captureStoragePlaces } from './loanCaptures';
import type { LoanError } from './loanGraph';
import { typeAfter } from './regions';
import type { TraitSolver } from './traits';
import { resolve, shallow, substitute as substituteType, type Type } from './types';

/** Whether a variable holds a value at a point: certainly, certainly not (never assigned or moved), or maybe. */
interface VarState {
  init: 'yes' | 'no' | 'maybe';
  /** Where the value moved out, for messages, when it did. */
  movedAt: Span | undefined;
  known?: Known;
  /** Moved-out parts (`x.f`), whose variable can no longer be used as a whole. */
  partial: Set<string>;
}

type State = Map<LocalVar, VarState>;

/** A place rooted in a variable: `x`, `x.f`, `x.0.g`; indexes and derefs end the path. */
interface PlacePath {
  root: LocalVar;
  path: string;
  /** Whether the place goes through a reference or an index, from which nothing moves out. */
  indirect: boolean;
}

const BOTTOM: State = new Map();

/**
 * Checks ownership as rustc's borrow checker does: uses of moved or uninitialized variables, moves out of borrowed
 * places, and assignments to immutable variables here, and the conflicts of borrows with a {@link LoanBuilder}.
 */
export class BorrowChecker {
  private loopStack: { label: string | undefined; breaks: State[]; continues: State[] }[] = [];
  /** The captures that the closure being checked moves out, which it owns. */
  private ownedCaptures: readonly LocalVar[] = [];

  constructor(
    private readonly annotations: Annotations,
    private readonly solver: TraitSolver,
    private readonly budget: ExecutionBudget,
    private readonly constContext = false
  ) {}

  checkConst(expr: Expr, context: FnContext): void {
    this.expr(
      expr,
      new Map(context.locals.map((local) => [local, { init: 'no', movedAt: undefined, partial: new Set() }])),
      'move'
    );
  }

  checkFn(item: FnItem, context: FnContext, ret: Type): void {
    if (!item.body) return;
    const moveError = this.checkMoves(item, item.body, context);
    const loanErrors: LoanError[] = [];
    const fn = {
      params: item.params.map((param) => param.pattern),
      body: item.body,
      ret,
      end: { row: item.endRow, col: 0 },
    };
    LoanBuilder.checkFn(this.annotations, this.solver, context, fn, { errors: loanErrors, budget: this.budget });
    // rustc reports the errors in the order of their positions.
    const [first] = loanErrors.toSorted((a, b) => a.span.row - b.span.row || a.span.col - b.span.col);
    if (first && (!moveError || first.span.row < moveError.diagnostics[0].row)) compileError(first.span, first.message);
    if (moveError) throw moveError;
  }

  /** Checks the moves and initialization of variables, returning the first error. */
  private checkMoves(item: FnItem, body: Block, context: FnContext): CompileError | undefined {
    const state: State = new Map();
    for (const local of context.locals) {
      // Parameters hold their arguments from the start; other variables are declared by their `let`.
      state.set(local, { init: 'no', movedAt: undefined, partial: new Set() });
    }
    for (const local of context.locals) if (local.isSelf) state.set(local, initState());
    for (const param of item.params) for (const local of this.bindingsOf(param.pattern)) state.set(local, initState());
    try {
      this.block(body, state);
      return undefined;
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      return error;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Statements

  private block(block: Block, state: State): State {
    let current = state;
    for (const stmt of block.stmts) current = this.stmt(stmt, current);
    if (block.tail) current = this.expr(block.tail, current, 'move');
    if (this.constContext && current !== BOTTOM) this.checkScopeDrops(block, current);
    return current;
  }

  private checkScopeDrops(block: Block, state: State): void {
    for (const stmt of block.stmts) {
      if (stmt.kind !== 'let') continue;
      for (const local of this.bindingsOf(stmt.pattern)) {
        const current = state.get(local);
        if (!current || current.init === 'no') continue;
        checkConstDrop(local.type, current.known, current.partial, local.span, this.budget);
      }
    }
  }

  /** A declaration without a value, which a loop may reach again: it makes new variables, which hold nothing yet. */
  private declareEmpty(pattern: Pattern, state: State): State {
    let declared = state;
    for (const local of this.bindingsOf(pattern)) {
      declared = setVar(declared, local, { init: 'no', movedAt: undefined, partial: new Set() });
    }
    return declared;
  }

  private stmt(stmt: Stmt, state: State): State {
    this.budget.spend();
    switch (stmt.kind) {
      case 'let': {
        if (!stmt.init) return this.declareEmpty(stmt.pattern, state);
        const { pattern, init } = stmt;
        if (pattern.kind === 'binding' && !pattern.sub) {
          const known = this.constantValue(init, state);
          let current = this.expr(init, state, 'move');
          for (const local of this.bindingsOf(pattern)) current = setVar(current, local, initState(known));
          return current;
        }
        const afterValue = this.patternSource(init, state);
        // The `else` of `let ... else` runs when the pattern does not match, which moves nothing.
        if (stmt.else) this.block(stmt.else, afterValue);
        return this.bindPattern(pattern, init, afterValue);
      }
      case 'expr': {
        if (this.constContext) this.checkTemporaryDrop(stmt.expr, state);
        return this.expr(stmt.expr, state, 'move');
      }
      case 'empty': {
        return state;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Expressions

  /**
   * Checks an expression. `mode` tells what happens to its value when it is a place: moved (or copied), read without
   * moving (borrowed as `&`), or borrowed mutably.
   */
  private expr(expr: Expr, state: State, mode: 'move' | 'read' | 'mut'): State {
    this.budget.spend();
    if (state === BOTTOM) return BOTTOM;
    if (mode === 'move' && this.annotations.reborrows.has(expr) && isMutReference(expr.ty)) mode = 'read';
    if (this.constContext && mode !== 'move' && !this.placeOf(expr)) this.checkTemporaryDrop(expr, state);
    return this.exprInner(expr, state, mode);
  }

  // code-gauge-allow functionNcss 57 -- Each expression kind defines how evaluation changes move state.
  private exprInner(expr: Expr, state: State, mode: 'move' | 'read' | 'mut'): State {
    switch (expr.kind) {
      case 'path': {
        return this.usePlace(expr, state, mode);
      }
      case 'field':
      case 'index': {
        return this.projection(expr, state, mode);
      }
      case 'unary': {
        return this.unary(expr, state, mode);
      }
      case 'ref': {
        return this.expr(expr.operand, state, expr.mutable ? 'mut' : 'read');
      }
      case 'binary': {
        return this.binary(expr, state);
      }
      case 'assign':
      case 'compoundAssign': {
        return this.assignment(expr, state);
      }
      case 'cast':
      case 'try': {
        return this.expr(expr.operand, state, 'move');
      }
      case 'call': {
        return this.call(expr, state);
      }
      case 'methodCall': {
        return this.methodCall(expr, state);
      }
      case 'struct': {
        return this.structExpr(expr, state);
      }
      case 'range':
      case 'tuple':
      case 'array': {
        let current = state;
        forEachDirect(expr, (child) => {
          current = this.expr(child, current, 'move');
        });
        return current;
      }
      case 'arrayRepeat': {
        return this.arrayRepeat(expr, state);
      }
      case 'block': {
        return this.block(expr, state);
      }
      case 'if': {
        const { matched, otherwise } = this.condition(expr.cond, state);
        return join(
          this.block(expr.consequent, matched),
          expr.else ? this.expr(expr.else, otherwise, 'move') : otherwise
        );
      }
      case 'match': {
        return this.match(expr, state);
      }
      case 'loop':
      case 'while':
      case 'for': {
        return this.loopExpr(expr, state);
      }
      case 'break':
      case 'continue':
      case 'return': {
        this.jump(expr, state);
        return BOTTOM;
      }
      case 'closure': {
        return this.closure(expr, state);
      }
      case 'macro': {
        return this.macro(expr, state);
      }
      default: {
        return state;
      }
    }
  }

  private checkTemporaryDrop(expr: Expr, state: State): void {
    checkConstDrop(expr.ty, this.constantValue(expr, state), new Set(), expr.span, this.budget);
  }

  private arrayRepeat(expr: Extract<Expr, { kind: 'arrayRepeat' }>, state: State): State {
    if (this.annotations.unevaluatedRepeatOperands.has(expr.value)) return this.expr(expr.count, state, 'move');
    const type = shallow(expr.ty!);
    if (this.constContext && type.kind === 'array' && type.len === 0) this.checkTemporaryDrop(expr.value, state);
    const afterValue = this.expr(expr.value, state, 'move');
    return this.expr(expr.count, afterValue, 'move');
  }

  private constantValue(expr: Expr, state: State): Known | undefined {
    if (!this.constContext) return undefined;
    const values = [...state].flatMap(([local, info]): [LocalVar, Known][] =>
      info.init === 'yes' && info.known !== undefined ? [[local, info.known]] : []
    );
    return ConstLint.valueOf(expr, this.annotations, values);
  }

  private unary(expr: Extract<Expr, { kind: 'unary' }>, state: State, mode: 'move' | 'read' | 'mut'): State {
    if (expr.op !== '*') return this.expr(expr.operand, state, 'move');
    // Moving out of a Box moves the Box; out of a reference it is not allowed.
    const movesOut = mode === 'move' && !this.isCopy(expr.ty);
    if (movesOut && isReference(expr.operand.ty)) this.cannotMoveOut(expr, '');
    return this.expr(expr.operand, state, movesOut ? 'move' : 'read');
  }

  private match(expr: Extract<Expr, { kind: 'match' }>, state: State): State {
    const afterScrutinee = this.patternSource(expr.scrutinee, state);
    let result: State = BOTTOM;
    for (const arm of expr.arms) {
      const armState = this.bindPattern(arm.pattern, expr.scrutinee, afterScrutinee);
      result = join(result, this.expr(arm.body, armState, 'move'));
    }
    return expr.arms.length === 0 ? afterScrutinee : result;
  }

  private loopExpr(expr: Extract<Expr, { kind: 'loop' | 'while' | 'for' }>, state: State): State {
    if (expr.kind === 'for') return this.forLoop(expr, state);
    if (expr.kind === 'loop') return this.loop(expr.label, state, (s) => this.block(expr.body, s), false);
    const body = (s: State): State => {
      const { matched, otherwise } = this.condition(expr.cond, s);
      this.loopStack.at(-1)?.breaks.push(otherwise);
      return this.block(expr.body, matched);
    };
    return this.loop(expr.label, state, body, false);
  }

  private projection(
    expr: Extract<Expr, { kind: 'field' | 'index' }>,
    state: State,
    mode: 'move' | 'read' | 'mut'
  ): State {
    const place = this.placeOf(expr);
    if (!place) {
      const inner = this.expr(expr.operand, state, 'read');
      return expr.kind === 'index' ? this.expr(expr.index, inner, 'move') : inner;
    }
    return this.usePlaceAt(place, expr, this.placeIndexes(expr, state), mode);
  }

  private binary(expr: Extract<Expr, { kind: 'binary' }>, state: State): State {
    if (expr.op === '&&' || expr.op === '||') {
      const left = this.expr(expr.left, state, 'move');
      const right = this.expr(expr.right, left, 'move');
      return join(left, right);
    }
    // Comparisons take their operands by reference.
    const mode = ['==', '!=', '<', '<=', '>', '>='].includes(expr.op) ? 'read' : 'move';
    return this.expr(expr.right, this.expr(expr.left, state, mode), mode);
  }

  private assignment(expr: Extract<Expr, { kind: 'assign' | 'compoundAssign' }>, state: State): State {
    const value = this.expr(expr.value, state, 'move');
    if (expr.kind === 'assign')
      return this.assign(
        expr.target,
        this.placeIndexes(expr.target, value),
        expr.span,
        expr.value,
        this.constantValue(expr.value, state)
      );
    const read = this.expr(expr.target, value, 'read');
    // A target that is no variable's place (`*map.entry(k).or_insert(0)`) is evaluated once, by the read.
    return this.placeOf(expr.target) ? this.assign(expr.target, read, expr.span, undefined) : read;
  }

  private call(expr: Extract<Expr, { kind: 'call' }>, state: State): State {
    // Calling an `FnOnce` closure consumes it.
    const consumes = this.annotations.callKinds.get(expr) === 'FnOnce';
    let current = this.expr(expr.callee, state, consumes ? 'move' : 'read');
    const res = expr.callee.kind === 'path' ? this.annotations.paths.get(expr.callee) : undefined;
    const fn = res?.kind === 'fn' ? res.fn : undefined;
    for (const arg of expr.args) current = this.expr(arg, current, 'move');
    return fn && diverges(fn.ret) ? BOTTOM : current;
  }

  /** `break` and `continue` go on at their loop with the state they leave; `return` leaves the function. */
  private jump(expr: Extract<Expr, { kind: 'break' | 'continue' | 'return' }>, state: State): void {
    if (expr.kind === 'continue') {
      this.findLoop(expr.label)?.continues.push(state);
      return;
    }
    const current = expr.value ? this.expr(expr.value, state, 'move') : state;
    if (expr.kind === 'break') this.findLoop(expr.label)?.breaks.push(current);
  }

  /** A struct expression with `..base` moves the base's fields it does not give, which are not `Copy`. */
  private structExpr(expr: Extract<Expr, { kind: 'struct' }>, state: State): State {
    let current = state;
    for (const field of expr.fields) current = this.expr(field.value, current, 'move');
    if (!expr.base) return current;
    const place = this.placeOf(expr.base);
    const res = this.annotations.paths.get(expr);
    if (!place || res?.kind !== 'ctor') return this.expr(expr.base, current, 'move');
    current = this.patternSource(expr.base, current);
    const given = new Set(expr.fields.map((field) => field.name));
    const subst = new Map(res.def.params.map((param, index) => [param, res.typeArgs[index]]));
    for (const field of res.def.variants[res.variant].fields) {
      if (given.has(field.name)) continue;
      const path = `${place.path}.${field.name}`;
      const varState = current.get(place.root);
      if (varState) this.checkUsable(place.root, varState, expr.base.span, 'read', path);
      const type = substituteType(field.type, subst);
      if (this.isCopy(type)) continue;
      if (place.indirect) this.cannotMoveOut(expr.base, '');
      current = this.markMoved(current, { ...place, path }, expr.base.span, true);
    }
    return current;
  }

  /** The states where a condition holds, after its pattern binds, and where it does not, which moves nothing. */
  private condition(cond: Condition, state: State): { matched: State; otherwise: State } {
    if (cond.kind === 'expr') {
      const after = this.expr(cond.expr, state, 'move');
      return { matched: after, otherwise: after };
    }
    const afterValue = this.patternSource(cond.value, state);
    return { matched: this.bindPattern(cond.pattern, cond.value, afterValue), otherwise: afterValue };
  }

  private patternSource(scrutinee: Expr, state: State): State {
    const place = this.placeOf(scrutinee);
    if (!place) return this.expr(scrutinee, state, this.constContext ? 'move' : 'read');
    if (place.indirect) return this.expr(scrutinee, state, 'read');
    return this.placeIndexes(scrutinee, state);
  }

  /** Binds a pattern's variables, moving the parts of a place they bind by value. */
  // code-gauge-allow functionCognitiveComplexity 18 -- Pattern matching coordinates reads, partial moves and new bindings.
  private bindPattern(pattern: Pattern, scrutinee: Expr, state: State): State {
    const place = this.placeOf(scrutinee);
    if (pattern.kind === 'wild') {
      if (this.constContext && !place) this.checkTemporaryDrop(scrutinee, state);
      return state;
    }
    let current = state;
    const moved = this.movedParts(pattern);
    const known = this.constantValue(scrutinee, state);
    const bindings = this.constContext ? ConstLint.bindingsOf(pattern, known, this.annotations) : undefined;
    if (this.constContext && !place) checkConstDrop(scrutinee.ty, known, new Set(moved), scrutinee.span, this.budget);
    if (place?.indirect && moved.length > 0 && !this.ownsCapture(scrutinee)) this.cannotMoveOut(scrutinee, '');
    if (place && !place.indirect) {
      const varState = state.get(place.root);
      if (varState) {
        this.checkUsable(place.root, varState, scrutinee.span, 'read', place.path, false);
        patternReads(pattern, place.path, (path, descendants) =>
          this.checkUsable(place.root, varState, scrutinee.span, 'read', path, descendants)
        );
      }
    }
    if (place && place.root.mode === 'move') {
      for (const path of moved) {
        current = this.markMoved(current, { ...place, path: `${place.path}${path}` }, scrutinee.span, false);
      }
    }
    for (const local of this.bindingsOf(pattern)) current = setVar(current, local, initState(bindings?.get(local)));
    return current;
  }

  /** The parts of the matched value that a pattern's bindings take by value and that are not `Copy`. */
  private movedParts(pattern: Pattern): string[] {
    return patternBindingParts(pattern, this.annotations)
      .filter((part) => !part.throughRef && !this.isCopy(part.local.type))
      .map((part) => part.path);
  }

  private methodCall(expr: Extract<Expr, { kind: 'methodCall' }>, state: State): State {
    const method = this.annotations.methods.get(expr);
    let current = state;
    if (method) {
      const { receiver } = method;
      const throughRef = receiver.derefs.some((step) => step === 'ref' || step === 'mutRef');
      if (receiver.autoref === 'mut' || (method.fn.selfMode === 'mutRef' && isMutReference(expr.receiver.ty))) {
        current = this.expr(expr.receiver, current, 'mut');
      } else {
        const adjusted = typeAfter(expr.receiver.ty, receiver.derefs);
        const moves =
          receiver.autoref === 'none' && method.fn.selfMode === 'value' && !throughRef && !this.isCopy(adjusted);
        current = this.expr(expr.receiver, current, moves ? 'move' : 'read');
      }
    } else {
      current = this.expr(expr.receiver, current, 'read');
    }
    for (const arg of expr.args) current = this.expr(arg, current, 'move');
    return method && diverges(method.fn.ret) ? BOTTOM : current;
  }

  private loop(label: string | undefined, state: State, body: (state: State) => State, exits: boolean): State {
    // The body runs again after itself: check it once from the entry, then from the join with its end.
    this.loopStack.push({ label, breaks: [], continues: [] });
    let head = state;
    for (let pass = 0; pass < 2; pass++) {
      const frame = this.loopStack.at(-1)!;
      frame.breaks = [];
      frame.continues = [];
      const next = joinAll([body(head), ...frame.continues], state);
      if (sameState(head, next)) break;
      head = next;
    }
    const frame = this.loopStack.pop()!;
    return joinAll(frame.breaks, exits ? head : BOTTOM);
  }

  private forLoop(expr: Extract<Expr, { kind: 'for' }>, state: State): State {
    const afterIterable = this.expr(expr.iterable, state, 'move');
    return this.loop(
      expr.label,
      afterIterable,
      (s) => {
        let current = s;
        for (const local of this.bindingsOf(expr.pattern)) current = setVar(current, local, initState());
        return this.block(expr.body, current);
      },
      true
    );
  }

  private findLoop(label: string | undefined): { breaks: State[]; continues: State[] } | undefined {
    for (let index = this.loopStack.length - 1; index >= 0; index--) {
      const loop = this.loopStack[index];
      if (label === undefined || loop.label === label) return loop;
    }
    return undefined;
  }

  private closure(expr: Extract<Expr, { kind: 'closure' }>, state: State): State {
    const info = this.annotations.closures.get(expr);
    if (!info) return state;
    this.checkClosureBody(expr, info.context);
    let current = state;
    for (const local of info.context.captures) {
      const varState = current.get(local);
      if (!varState) continue;
      const captures = captureStoragePlaces(info.context.projectedCaptures?.get(local) ?? [], local.type);
      for (const { proj, type, mode } of captures) {
        const path = proj.length === 0 ? '' : `.${proj.join('.')}`;
        this.checkUsable(local, varState, expr.span, 'read', path);
        if (mode === 'value' && local.mode === 'move' && !this.isCopy(type)) {
          current = this.markMoved(current, { root: local, path, indirect: false }, expr.span, false);
        }
      }
    }
    return current;
  }

  private formatArgs(format: FormatArgs | undefined, state: State): State {
    let current = state;
    for (const arg of format?.args ?? []) current = this.expr(arg, current, 'read');
    return current;
  }

  /** Checks a closure's body on its own, where its parameters and captured variables hold values. */
  private checkClosureBody(expr: Extract<Expr, { kind: 'closure' }>, context: FnContext): void {
    const checker = new BorrowChecker(this.annotations, this.solver, this.budget);
    checker.ownedCaptures = context.movedCaptures ?? [];
    const body: Block =
      expr.body.kind === 'block'
        ? expr.body
        : { kind: 'block', stmts: [], tail: expr.body, span: expr.span, endRow: expr.span.row, items: [] };
    let state: State = new Map();
    for (const local of context.locals) state.set(local, { init: 'no', movedAt: undefined, partial: new Set() });
    for (const local of context.captures) state.set(local, initState());
    for (const param of expr.params)
      for (const local of checker.bindingsOf(param.pattern)) state = setVar(state, local, initState());
    checker.block(body, state);
  }

  /** Checks the message of an assertion, which is formatted only where the assertion fails and panics. */
  private failureMessage(format: FormatArgs | undefined, checked: State): State {
    this.formatArgs(format, checked);
    return checked;
  }

  // code-gauge-allow functionNcss 32 -- Each macro has its own order of consuming and borrowing operands.
  private macro(expr: Extract<Expr, { kind: 'macro' }>, state: State): State {
    const { macro } = expr;
    switch (macro.kind) {
      case 'print':
      case 'format': {
        return this.formatArgs(macro.format, state);
      }
      case 'panic': {
        this.formatArgs(macro.format, state);
        return BOTTOM;
      }
      case 'write': {
        return this.formatArgs(macro.format, this.expr(macro.target, state, 'read'));
      }
      case 'assert': {
        return this.failureMessage(macro.format, this.expr(macro.cond, state, 'move'));
      }
      case 'assertEq': {
        const compared = this.expr(macro.right, this.expr(macro.left, state, 'read'), 'read');
        return this.failureMessage(macro.format, compared);
      }
      case 'vec': {
        let current = state;
        for (const elem of macro.elems) current = this.expr(elem, current, 'move');
        return current;
      }
      case 'vecRepeat': {
        return this.expr(macro.count, this.expr(macro.value, state, 'move'), 'move');
      }
      case 'matches': {
        const condition = { kind: 'let' as const, pattern: macro.pattern, value: macro.value, span: expr.span };
        const { matched, otherwise } = this.condition(condition, state);
        return join(matched, otherwise);
      }
      case 'dbg': {
        let current = state;
        for (const arg of macro.args) current = this.expr(arg, current, 'move');
        return current;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Places

  private usePlace(expr: Extract<Expr, { kind: 'path' }>, state: State, mode: 'move' | 'read' | 'mut'): State {
    const place = this.placeOf(expr);
    if (!place) return state;
    return this.usePlaceAt(place, expr, state, mode);
  }

  private usePlaceAt(place: PlacePath, expr: Expr, state: State, requested: 'move' | 'read' | 'mut'): State {
    // Using a `Copy` value by value copies it, which only reads the place.
    const mode = requested === 'move' && this.isCopy(expr.ty) ? 'read' : requested;
    const varState = state.get(place.root);
    if (varState) this.checkUsable(place.root, varState, expr.span, mode, place.path);
    if (mode !== 'move' || this.isCopy(expr.ty)) return state;
    if (place.indirect && !this.ownsCapture(expr)) {
      this.cannotMoveOut(expr, '');
    }
    if (place.root.mode !== 'move') return state;
    return this.markMoved(state, place, expr.span, false);
  }

  /** Whether an expression is a capture, or a field of one, that the closure being checked owns. */
  private ownsCapture(expr: Expr): boolean {
    let current = expr;
    while (current.kind === 'field') current = current.operand;
    const res = current.kind === 'path' ? this.annotations.paths.get(current) : undefined;
    return res?.kind === 'capture' && this.ownedCaptures.includes(res.local);
  }

  private markMoved(state: State, place: PlacePath, span: Span, partialOnly: boolean): State {
    const varState = state.get(place.root);
    if (!varState) return state;
    if (place.path === '' && !partialOnly) {
      return setVar(state, place.root, { init: 'no', movedAt: span, partial: new Set() });
    }
    const partial = new Set([...varState.partial, place.path]);
    return setVar(state, place.root, { ...varState, partial, movedAt: span });
  }

  /** Requires a variable to hold a value where the program uses it. */
  // code-gauge-allow functionCognitiveComplexity 16 -- Initialization, full moves and partial moves require distinct diagnostics.
  private checkUsable(
    local: LocalVar,
    varState: VarState,
    span: Span,
    mode: 'move' | 'read' | 'mut',
    path = '',
    descendants = true
  ): void {
    if (varState.init !== 'yes') {
      if (varState.movedAt) {
        const verb = mode === 'move' ? '使えません' : '借りられません';
        compileError(
          span,
          `変数 ${local.name} の値は ${varState.movedAt.row + 1} 行目でムーブされたので、${verb}（ムーブしたくないときは .clone() で複製します）。`
        );
      }
      compileError(
        span,
        varState.init === 'maybe'
          ? `変数 ${local.name} に値が入っていないことがあるので、使えません。`
          : `変数 ${local.name} に値が入っていないので、使えません。`
      );
    }
    for (const moved of varState.partial) {
      if (path === moved || path.startsWith(`${moved}.`) || (descendants && moved.startsWith(`${path}.`))) {
        compileError(
          span,
          `変数 ${local.name} の一部（${local.name}${moved}）は ${varState.movedAt ? `${varState.movedAt.row + 1} 行目で` : ''}ムーブされたので、${local.name} を使えません。`
        );
      }
    }
  }

  private placeIndexes(target: Expr, state: State): State {
    if (target.kind === 'index') return this.expr(target.index, this.placeIndexes(target.operand, state), 'move');
    if (target.kind === 'field' || (target.kind === 'unary' && target.op === '*')) {
      return this.placeIndexes(target.operand, state);
    }
    return state;
  }

  /** Assigns a place; `value` is the assigned expression of a plain assignment (`=`), or undefined for `+=` and kin. */
  // code-gauge-allow functionCognitiveComplexity 29 -- Follows the borrow checking rules case by case.
  // code-gauge-allow functionNcss 33 -- Assignments update ownership, initialization and immutable-binding state together.
  private assign(target: Expr, state: State, span: Span, value: Expr | undefined, known?: Known): State {
    const whole = value !== undefined;
    const place = this.placeOf(target);
    if (this.constContext && value) this.checkConstAssignment(target, value, place, state, known);
    if (!place) {
      const res = target.kind === 'path' ? this.annotations.paths.get(target) : undefined;
      if (res?.kind === 'discard') return state;
      return this.expr(target, state, 'read');
    }
    const varState = state.get(place.root);
    if (place.path === '' && !place.indirect && whole) {
      const local = place.root;
      if (!local.mutable && local.mode === 'move' && varState && varState.init !== 'no') {
        compileError(
          span,
          `mut ではない変数 ${local.name} に、もう一度代入できません（let mut ${local.name} と宣言してください）。`
        );
      }
      if (!local.mutable && local.mode === 'move' && varState?.movedAt) {
        compileError(
          span,
          `mut ではない変数 ${local.name} に、もう一度代入できません（let mut ${local.name} と宣言してください）。`
        );
      }
      return setVar(state, local, initState(known));
    }
    if (varState && !place.indirect) {
      if (varState.init !== 'yes' && !varState.movedAt) {
        compileError(span, `変数 ${place.root.name} に値が入っていないので、そのフィールドに代入できません。`);
      }
      if (varState.init !== 'yes') {
        compileError(
          span,
          `変数 ${place.root.name} の値は ${varState.movedAt!.row + 1} 行目でムーブされたので、そのフィールドに代入できません。`
        );
      }
      if ([...varState.partial].some((moved) => place.path.startsWith(`${moved}.`))) {
        this.checkUsable(place.root, varState, span, 'read', place.path, false);
      }
      const partial = new Set(
        [...varState.partial].filter((moved) => moved !== place.path && !moved.startsWith(`${place.path}.`))
      );
      if (this.constContext || partial.size !== varState.partial.size) {
        const value = writeKnownField(varState.known, place.path.slice(1).split('.'), known);
        return setVar(state, place.root, { ...varState, partial, known: value });
      }
    } else if (varState) return this.assignIndirect(target, place.root, state, varState, span, known);
    return state;
  }

  private assignIndirect(
    target: Expr,
    root: LocalVar,
    state: State,
    previous: VarState,
    span: Span,
    known?: Known
  ): State {
    this.checkUsable(root, previous, span, 'read');
    if (!this.constContext || previous.known === undefined) return state;
    const updated = this.indirectWrite(target, state, previous.known, known);
    return setVar(state, root, { ...previous, known: updated });
  }

  private checkConstAssignment(
    target: Expr,
    value: Expr,
    place: PlacePath | undefined,
    state: State,
    known: Known | undefined
  ): void {
    if (this.annotations.paths.get(target)?.kind === 'discard') {
      checkConstDrop(value.ty, known, new Set(), target.span, this.budget);
      return;
    }
    if (!place || place.indirect) {
      checkConstDrop(target.ty, undefined, new Set(), target.span, this.budget);
      return;
    }
    const previous = state.get(place.root);
    if (previous && previous.init !== 'no') this.checkReplacedValue(target, place.path, previous);
  }

  private indirectWrite(target: Expr, state: State, previous: Known, assigned: Known | undefined): Known | undefined {
    const fields: string[] = [];
    let current = target;
    while (current.kind === 'index' || current.kind === 'field') {
      if (current.kind === 'field') fields.push(current.name);
      else {
        const index = this.constantValue(current.index, state);
        fields.push(typeof index === 'bigint' ? String(index) : '[]');
      }
      current = current.operand;
    }
    return current.kind === 'path' ? writeKnownField(previous, fields.toReversed(), assigned) : undefined;
  }

  private checkReplacedValue(target: Expr, path: string, state: VarState): void {
    const moves = [...state.partial];
    if (moves.some((move) => move === path || path.startsWith(`${move}.`))) return;
    let value = state.known;
    if (path) for (const field of path.slice(1).split('.')) value = knownField(value, field);
    const moved = new Set(
      moves.filter((move) => !path || move.startsWith(`${path}.`)).map((move) => move.slice(path.length))
    );
    checkConstDrop(target.ty, value, moved, target.span, this.budget);
  }

  /** The place an expression denotes, rooted in a variable of the function, or undefined for other expressions. */
  private placeOf(expr: Expr): PlacePath | undefined {
    switch (expr.kind) {
      case 'path': {
        const res = this.annotations.paths.get(expr);
        if (res?.kind !== 'local' && res?.kind !== 'capture') return undefined;
        return { root: res.local, path: '', indirect: res.kind === 'capture' };
      }
      case 'field': {
        const base = this.placeOf(expr.operand);
        if (!base) return undefined;
        const field = this.annotations.fields.get(expr);
        const throughRef = field?.derefs.some((step) => step === 'ref' || step === 'mutRef') ?? false;
        return {
          root: base.root,
          path: `${base.path}.${expr.name}`,
          indirect: base.indirect || throughRef || base.root.mode !== 'move',
        };
      }
      case 'index': {
        const base = this.placeOf(expr.operand);
        if (!base) return undefined;
        return { root: base.root, path: base.path, indirect: true };
      }
      case 'unary': {
        if (expr.op !== '*') return undefined;
        const base = this.placeOf(expr.operand);
        if (!base) return undefined;
        return { root: base.root, path: base.path, indirect: isReference(expr.operand.ty) || base.indirect };
      }
      default: {
        return undefined;
      }
    }
  }

  private cannotMoveOut(expr: Expr, what: string): never {
    const kind = expr.kind === 'index' ? '[ ] で取り出した要素' : what || '参照の先の値';
    compileError(expr.span, `${kind}はムーブできません（.clone() で複製するか、& を付けて参照にしてください）。`);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Helpers

  private bindingsOf(pattern: Pattern): LocalVar[] {
    return patternBindings(pattern, this.annotations);
  }

  private isCopy(type: Type | undefined): boolean {
    if (!type) return true;
    return this.solver.isCopy(resolve(type, true));
  }
}

function initState(known?: Known): VarState {
  return { init: 'yes', movedAt: undefined, partial: new Set(), known };
}

function setVar(state: State, local: LocalVar, varState: VarState): State {
  if (state === BOTTOM) return BOTTOM;
  return new Map([...state, [local, varState]]);
}

function joinAll(states: State[], initial: State): State {
  let result = initial;
  for (const state of states) result = join(result, state);
  return result;
}

function sameState(a: State, b: State): boolean {
  if (a === b) return true;
  if (a === BOTTOM || b === BOTTOM || a.size !== b.size) return false;
  for (const [local, left] of a) {
    const right = b.get(local);
    if (left.init !== right?.init || left.movedAt !== right.movedAt || left.partial.size !== right.partial.size) {
      return false;
    }
    if (!sameKnown(left.known, right.known)) return false;
    for (const part of left.partial) if (!right.partial.has(part)) return false;
  }
  return true;
}

function patternReads(pattern: Pattern, path: string, read: (path: string, descendants: boolean) => void): void {
  switch (pattern.kind) {
    case 'wild': {
      return;
    }
    case 'tuple':
    case 'tupleStruct': {
      read(path, false);
      for (const [index, child] of pattern.elems.entries()) patternReads(child, `${path}.${index}`, read);
      return;
    }
    case 'struct': {
      read(path, false);
      for (const { name, pattern: child } of pattern.fields) patternReads(child, `${path}.${name}`, read);
      return;
    }
    case 'or': {
      for (const child of pattern.alternatives) patternReads(child, path, read);
      return;
    }
    default: {
      read(path, true);
    }
  }
}

/** The state after either of two paths: a variable holds a value only if it does on both. */
function join(a: State, b: State): State {
  if (a === BOTTOM) return b;
  if (b === BOTTOM) return a;
  const result: State = new Map();
  for (const [local, x] of a) {
    const y = b.get(local);
    if (!y) {
      result.set(local, x);
      continue;
    }
    const init = x.init === y.init ? x.init : 'maybe';
    result.set(local, {
      init,
      movedAt: x.movedAt ?? y.movedAt,
      partial: new Set([...x.partial, ...y.partial]),
      known: intersectKnown(x.known, y.known),
    });
  }
  for (const [local, y] of b) if (!a.has(local)) result.set(local, y);
  return result;
}

function isMutReference(type: Type | undefined): boolean {
  if (!type) return false;
  const t = normalize(shallow(type));
  return t.kind === 'ref' && t.mutable;
}

function isReference(type: Type | undefined): boolean {
  if (!type) return false;
  return normalize(shallow(type)).kind === 'ref';
}

function diverges(ret: Type): boolean {
  return normalize(shallow(ret)).kind === 'never';
}
