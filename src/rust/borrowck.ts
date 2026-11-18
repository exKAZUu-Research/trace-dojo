import type { Annotations, FnContext, LocalVar } from './annotations';
import type { Block, Condition, Expr, FnItem, FormatArgs, Pattern, Span, Stmt } from './ast';
import { normalize } from './infer';
import { compileError } from './items';
import type { TraitSolver } from './traits';
import { resolve, shallow, substitute as substituteType, type Type } from './types';

/** Whether a variable holds a value at a point: certainly, certainly not (never assigned or moved), or maybe. */
interface VarState {
  init: 'yes' | 'no' | 'maybe';
  /** Where the value moved out, for messages, when it did. */
  movedAt: Span | undefined;
  /** Moved-out parts (`x.f`), whose variable can no longer be used as a whole. */
  partial: Set<string>;
}

type State = Map<LocalVar, VarState>;

/** A borrow that a variable holds, which conflicts with uses of the borrowed place while the variable lives. */
interface Loan {
  root: LocalVar;
  path: string;
  mutable: boolean;
  holder: LocalVar;
  span: Span;
}

/** A place rooted in a variable: `x`, `x.f`, `x.0.g`; indexes and derefs end the path. */
interface PlacePath {
  root: LocalVar;
  path: string;
  /** Whether the place goes through a reference or an index, from which nothing moves out. */
  indirect: boolean;
}

const BOTTOM: State = new Map();

function position(span: Span): number {
  return span.row * 100_000 + span.col;
}

/**
 * Checks ownership as rustc's borrow checker does for learning programs: uses of moved or uninitialized variables,
 * moves out of borrowed places, assignments to immutable variables, and conflicts of borrows that variables hold.
 */
export class BorrowChecker {
  private loans: Loan[] = [];
  /** The positions where each variable is used, to tell whether a loan it holds is still live. */
  private readonly uses = new Map<LocalVar, number[]>();
  /** The bodies of loops, by their extent, for liveness across iterations. */
  private readonly loopRanges: { start: number; end: number }[] = [];
  private loopStack: { label: string | undefined; breaks: State[]; continues: State[] }[] = [];

  constructor(
    private readonly annotations: Annotations,
    private readonly solver: TraitSolver
  ) {}

  checkFn(item: FnItem, context: FnContext): void {
    if (!item.body) return;
    this.collectUses(item.body);
    const state: State = new Map();
    for (const local of context.locals) {
      // Parameters hold their arguments from the start; other variables are declared by their `let`.
      state.set(local, { init: 'no', movedAt: undefined, partial: new Set() });
    }
    for (const local of context.locals) if (local.isSelf) state.set(local, initState());
    for (const param of item.params) for (const local of this.bindingsOf(param.pattern)) state.set(local, initState());
    this.block(item.body, state);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Liveness

  private collectUses(block: Block): void {
    const visitExpr = (expr: Expr): void => {
      if (expr.kind === 'path') {
        const res = this.annotations.paths.get(expr);
        if (res?.kind === 'local' || res?.kind === 'capture') {
          const list = this.uses.get(res.local) ?? [];
          list.push(position(expr.span));
          this.uses.set(res.local, list);
        }
      }
      if (expr.kind === 'loop' || expr.kind === 'while' || expr.kind === 'for') {
        this.loopRanges.push({ start: position(expr.span), end: expr.body.endRow * 100_000 + 99_999 });
      }
      if (expr.kind === 'closure') {
        const info = this.annotations.closures.get(expr);
        for (const local of info?.context.captures ?? []) {
          const list = this.uses.get(local) ?? [];
          list.push(position(expr.span));
          this.uses.set(local, list);
        }
      }
      if (
        expr.kind === 'macro' &&
        (expr.macro.kind === 'print' || expr.macro.kind === 'format' || expr.macro.kind === 'panic')
      ) {
        const format = expr.macro.kind === 'format' ? expr.macro.format : expr.macro.format;
        for (const arg of format?.args ?? []) visitExpr(arg);
        return;
      }
      walkChildren(expr, visitExpr);
    };
    walkBlock(block, visitExpr);
  }

  /** Whether a loan's holder is used after `at`, in program order or in a later iteration of a loop around both. */
  private isLive(loan: Loan, at: number): boolean {
    const uses = this.uses.get(loan.holder) ?? [];
    const declared = position(loan.holder.span);
    for (const use of uses) {
      if (use > at) return true;
      for (const range of this.loopRanges) {
        if (range.start > declared && range.start <= at && at <= range.end && range.start <= use && use <= range.end) {
          return true;
        }
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Statements

  private block(block: Block, state: State): State {
    let current = state;
    for (const stmt of block.stmts) current = this.stmt(stmt, current);
    if (block.tail) current = this.expr(block.tail, current, 'move');
    // The variables of the block go out of scope with the borrows they hold.
    const declared = new Set(block.stmts.flatMap((stmt) => (stmt.kind === 'let' ? this.bindingsOf(stmt.pattern) : [])));
    if (declared.size > 0) this.loans = this.loans.filter((loan) => !declared.has(loan.holder));
    return current;
  }

  private stmt(stmt: Stmt, state: State): State {
    switch (stmt.kind) {
      case 'let': {
        let current = state;
        if (stmt.init) {
          current = this.expr(stmt.init, current, 'move');
          if (stmt.else) {
            const elseState = this.block(stmt.else, current);
            void elseState;
          }
          for (const local of this.bindingsOf(stmt.pattern)) {
            current = setVar(current, local, initState());
            this.loans = this.loans.filter((loan) => loan.holder !== local);
            this.addLoans(local, stmt.init);
          }
        }
        return current;
      }
      case 'expr': {
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
  // code-gauge-allow functionCognitiveComplexity 60 -- One case per kind of expression.
  private expr(expr: Expr, state: State, mode: 'move' | 'read' | 'mut'): State {
    if (state === BOTTOM) return BOTTOM;
    switch (expr.kind) {
      case 'path': {
        return this.usePlace(expr, state, mode);
      }
      case 'field':
      case 'index': {
        const place = this.placeOf(expr);
        if (!place) {
          const inner = this.expr(expr.kind === 'field' ? expr.operand : expr.operand, state, 'read');
          return expr.kind === 'index' ? this.expr(expr.index, inner, 'move') : inner;
        }
        let current = expr.kind === 'index' ? this.expr(expr.index, state, 'move') : state;
        current = this.usePlaceAt(place, expr, current, mode);
        return current;
      }
      case 'unary': {
        if (expr.op === '*') {
          const current = this.expr(expr.operand, state, 'read');
          // Moving out of a Box is allowed; out of a reference it is not.
          if (mode === 'move' && !this.isCopy(expr.ty) && isReference(expr.operand.ty)) this.cannotMoveOut(expr, '');
          return current;
        }
        return this.expr(expr.operand, state, 'move');
      }
      case 'ref': {
        return this.expr(expr.operand, state, expr.mutable ? 'mut' : 'read');
      }
      case 'binary': {
        const isComparison = ['==', '!=', '<', '<=', '>', '>='].includes(expr.op);
        if (expr.op === '&&' || expr.op === '||') {
          const left = this.expr(expr.left, state, 'move');
          const right = this.expr(expr.right, left, 'move');
          return join(left, right);
        }
        const left = this.expr(expr.left, state, isComparison ? 'read' : 'move');
        return this.expr(expr.right, left, isComparison ? 'read' : 'move');
      }
      case 'assign': {
        return this.assign(expr.target, this.expr(expr.value, state, 'move'), expr.span, expr.value);
      }
      case 'compoundAssign': {
        const value = this.expr(expr.value, state, 'move');
        const read = this.expr(expr.target, value, 'read');
        return this.assign(expr.target, read, expr.span, undefined);
      }
      case 'cast':
      case 'try': {
        return this.expr(expr.operand, state, 'move');
      }
      case 'call': {
        let current =
          expr.callee.kind === 'path' ? this.expr(expr.callee, state, 'read') : this.expr(expr.callee, state, 'read');
        for (const arg of expr.args) current = this.expr(arg, current, 'move');
        return current;
      }
      case 'methodCall': {
        return this.methodCall(expr, state);
      }
      case 'struct': {
        return this.structExpr(expr, state);
      }
      case 'range':
      case 'tuple':
      case 'array':
      case 'arrayRepeat': {
        let current = state;
        forEachDirect(expr, (child) => {
          current = this.expr(child, current, 'move');
        });
        return current;
      }
      case 'block': {
        return this.block(expr, state);
      }
      case 'if': {
        const afterCond = this.condition(expr.cond, state);
        const consequent = this.block(expr.consequent, afterCond);
        const alternative = expr.else ? this.expr(expr.else, afterCond, 'move') : afterCond;
        return join(consequent, alternative);
      }
      case 'match': {
        const afterScrutinee = this.expr(expr.scrutinee, state, 'read');
        let result: State = BOTTOM;
        for (const arm of expr.arms) {
          let armState = this.bindPattern(arm.pattern, expr.scrutinee, afterScrutinee);
          armState = this.expr(arm.body, armState, 'move');
          result = join(result, armState);
        }
        return expr.arms.length === 0 ? afterScrutinee : result;
      }
      case 'loop': {
        return this.loop(expr.label, state, (s) => this.block(expr.body, s), false);
      }
      case 'while': {
        return this.loop(
          expr.label,
          state,
          (s) => {
            const afterCond = this.condition(expr.cond, s);
            return this.block(expr.body, afterCond);
          },
          true
        );
      }
      case 'for': {
        return this.forLoop(expr, state);
      }
      case 'break': {
        const current = expr.value ? this.expr(expr.value, state, 'move') : state;
        const loop = this.findLoop(expr.label);
        loop?.breaks.push(current);
        return BOTTOM;
      }
      case 'continue': {
        this.findLoop(expr.label)?.continues.push(state);
        return BOTTOM;
      }
      case 'return': {
        if (expr.value) this.expr(expr.value, state, 'move');
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

  /** A struct expression with `..base` moves the base's fields it does not give, which are not `Copy`. */
  private structExpr(expr: Extract<Expr, { kind: 'struct' }>, state: State): State {
    let current = state;
    for (const field of expr.fields) current = this.expr(field.value, current, 'move');
    if (!expr.base) return current;
    const place = this.placeOf(expr.base);
    const res = this.annotations.paths.get(expr);
    if (!place || res?.kind !== 'ctor') return this.expr(expr.base, current, 'move');
    current = this.expr(expr.base, current, 'read');
    const given = new Set(expr.fields.map((field) => field.name));
    const subst = new Map(res.def.params.map((param, index) => [param, res.typeArgs[index]]));
    for (const field of res.def.variants[res.variant].fields) {
      if (given.has(field.name)) continue;
      const type = substituteType(field.type, subst);
      if (this.isCopy(type)) continue;
      if (place.indirect) this.cannotMoveOut(expr.base, '');
      current = this.markMoved(current, { ...place, path: `${place.path}.${field.name}` }, expr.base.span, true);
    }
    return current;
  }

  private condition(cond: Condition, state: State): State {
    if (cond.kind === 'expr') return this.expr(cond.expr, state, 'move');
    const afterValue = this.expr(cond.value, state, 'read');
    return this.bindPattern(cond.pattern, cond.value, afterValue);
  }

  /** Binds a pattern's variables, moving the parts of a place they bind by value. */
  private bindPattern(pattern: Pattern, scrutinee: Expr, state: State): State {
    let current = state;
    const locals = this.bindingsOf(pattern);
    const movesNonCopy = locals.some((local) => local.mode === 'move' && !this.isCopy(local.type));
    if (movesNonCopy && pattern.kind !== 'binding') {
      const place = this.placeOf(scrutinee);
      if (place?.indirect) this.cannotMoveOut(scrutinee, '');
      if (place) current = this.markMoved(current, place, scrutinee.span, true);
    } else if (movesNonCopy && pattern.kind === 'binding') {
      current = this.expr(scrutinee, current, 'move');
    }
    for (const local of locals) current = setVar(current, local, initState());
    return current;
  }

  private methodCall(expr: Extract<Expr, { kind: 'methodCall' }>, state: State): State {
    const method = this.annotations.methods.get(expr);
    let current = state;
    if (method) {
      const { receiver } = method;
      const throughRef = receiver.derefs.some((step) => step === 'ref' || step === 'mutRef');
      if (receiver.autoref === 'mut') current = this.expr(expr.receiver, current, throughRef ? 'read' : 'mut');
      else if (receiver.autoref === 'ref' || throughRef || receiver.rangeToIter)
        current = this.expr(expr.receiver, current, 'read');
      else if (method.fn.selfMode === 'value') current = this.expr(expr.receiver, current, 'move');
      else current = this.expr(expr.receiver, current, 'read');
    } else {
      current = this.expr(expr.receiver, current, 'read');
    }
    for (const arg of expr.args) current = this.expr(arg, current, 'move');
    return current;
  }

  private loop(label: string | undefined, state: State, body: (state: State) => State, exits: boolean): State {
    // The body runs again after itself: check it once from the entry, then from the join with its end.
    this.loopStack.push({ label, breaks: [], continues: [] });
    let head = state;
    for (let pass = 0; pass < 2; pass++) {
      const frame = this.loopStack.at(-1)!;
      frame.breaks = [];
      frame.continues = [];
      head = joinAll([body(head), ...frame.continues], state);
    }
    const frame = this.loopStack.pop()!;
    return joinAll(frame.breaks, exits ? head : BOTTOM);
  }

  private forLoop(expr: Extract<Expr, { kind: 'for' }>, state: State): State {
    const afterIterable = this.expr(expr.iterable, state, 'move');
    // A loop over a borrow of a variable holds the borrow while it runs.
    const borrowed = this.borrowedPlace(expr.iterable);
    const loop: Loan[] = [];
    if (borrowed) {
      const holder = {
        name: '{for}',
        mutable: false,
        type: { kind: 'tuple', elems: [] },
        slot: -1,
        span: expr.span,
        owner: undefined as never,
        mode: 'move',
        id: -1,
      } as LocalVar;
      this.uses.set(holder, [expr.body.endRow * 100_000 + 99_998]);
      loop.push({ ...borrowed, holder, span: expr.iterable.span });
      this.loans.push(...loop);
    }
    try {
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
    } finally {
      this.loans = this.loans.filter((loan) => !loop.includes(loan));
    }
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
      this.checkUsable(local, varState, expr.span, 'read');
      if (info.context.isMove && !this.isCopy(local.type) && local.mode === 'move') {
        current = setVar(current, local, { init: 'no', movedAt: expr.span, partial: new Set() });
      }
    }
    return current;
  }

  /** Checks a closure's body on its own, where its parameters and captured variables hold values. */
  private checkClosureBody(expr: Extract<Expr, { kind: 'closure' }>, context: FnContext): void {
    const checker = new BorrowChecker(this.annotations, this.solver);
    const body: Block =
      expr.body.kind === 'block'
        ? expr.body
        : { kind: 'block', stmts: [], tail: expr.body, span: expr.span, endRow: expr.span.row, items: [] };
    checker.collectUses(body);
    let state: State = new Map();
    for (const local of context.locals) state.set(local, { init: 'no', movedAt: undefined, partial: new Set() });
    for (const param of expr.params)
      for (const local of checker.bindingsOf(param.pattern)) state = setVar(state, local, initState());
    checker.block(body, state);
  }

  private macro(expr: Extract<Expr, { kind: 'macro' }>, state: State): State {
    const { macro } = expr;
    const format = (f: FormatArgs | undefined, s: State): State => {
      let current = s;
      for (const arg of f?.args ?? []) current = this.expr(arg, current, 'read');
      return current;
    };
    switch (macro.kind) {
      case 'print':
      case 'format': {
        return format(macro.format, state);
      }
      case 'panic': {
        format(macro.format, state);
        return BOTTOM;
      }
      case 'write': {
        return format(macro.format, this.expr(macro.target, state, 'read'));
      }
      case 'assert': {
        return format(macro.format, this.expr(macro.cond, state, 'move'));
      }
      case 'assertEq': {
        return format(macro.format, this.expr(macro.right, this.expr(macro.left, state, 'read'), 'read'));
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
        return this.expr(macro.value, state, 'read');
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

  private usePlaceAt(place: PlacePath, expr: Expr, state: State, mode: 'move' | 'read' | 'mut'): State {
    const varState = state.get(place.root);
    if (varState) this.checkUsable(place.root, varState, expr.span, mode, place.path);
    this.checkLoans(place, expr.span, mode);
    if (mode !== 'move' || this.isCopy(expr.ty)) return state;
    if (place.indirect) {
      this.cannotMoveOut(expr, '');
    }
    if (place.root.mode !== 'move') return state;
    return this.markMoved(state, place, expr.span, false);
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
  private checkUsable(local: LocalVar, varState: VarState, span: Span, mode: 'move' | 'read' | 'mut', path = ''): void {
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
      if (path === '' || path === moved || path.startsWith(`${moved}.`) || moved.startsWith(`${path}.`)) {
        compileError(
          span,
          `変数 ${local.name} の一部（${local.name}${moved}）は ${varState.movedAt ? `${varState.movedAt.row + 1} 行目で` : ''}ムーブされたので、${local.name} を使えません。`
        );
      }
    }
  }

  /** Rejects a use of a place that a live loan of another variable conflicts with. */
  private checkLoans(place: PlacePath, span: Span, mode: 'move' | 'read' | 'mut'): void {
    const at = position(span);
    for (const loan of this.loans) {
      if (loan.root !== place.root || !overlaps(loan.path, place.path)) continue;
      if (!loan.mutable && mode === 'read') continue;
      if (!this.isLive(loan, at)) continue;
      const name = place.root.name;
      if (loan.mutable) {
        compileError(
          span,
          `${name} は ${loan.span.row + 1} 行目で &mut で借りられていて、その参照がまだ使われるので、${mode === 'mut' ? 'もう一度 &mut で借りられません' : '使えません'}。`
        );
      }
      compileError(
        span,
        mode === 'move'
          ? `${name} は ${loan.span.row + 1} 行目で借りられていて、その参照がまだ使われるので、ムーブできません。`
          : `${name} は ${loan.span.row + 1} 行目で & で借りられていて、その参照がまだ使われるので、書き換えられません。`
      );
    }
  }

  /** Assigns a place; `value` is the assigned expression of a plain assignment (`=`), or undefined for `+=` and kin. */
  private assign(target: Expr, state: State, span: Span, value: Expr | undefined): State {
    const whole = value !== undefined;
    const place = this.placeOf(target);
    if (!place) {
      const res = target.kind === 'path' ? this.annotations.paths.get(target) : undefined;
      if (res?.kind === 'discard') return state;
      return this.expr(target, state, 'read');
    }
    this.checkLoansForAssign(place, span);
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
      this.loans = this.loans.filter((loan) => loan.holder !== local);
      this.addLoans(local, value);
      return setVar(state, local, initState());
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
      if (varState.partial.has(place.path)) {
        const partial = new Set(varState.partial);
        partial.delete(place.path);
        return setVar(state, place.root, { ...varState, partial });
      }
    } else if (varState) {
      this.checkUsable(place.root, varState, span, 'read');
    }
    return state;
  }

  private checkLoansForAssign(place: PlacePath, span: Span): void {
    const at = position(span);
    for (const loan of this.loans) {
      if (loan.root !== place.root || !overlaps(loan.path, place.path)) continue;
      if (!this.isLive(loan, at)) continue;
      compileError(
        span,
        `${place.root.name} は ${loan.span.row + 1} 行目で借りられていて、その参照がまだ使われるので、代入できません。`
      );
    }
  }

  /** The place an expression denotes, rooted in a variable of the function, or undefined for other expressions. */
  private placeOf(expr: Expr): PlacePath | undefined {
    switch (expr.kind) {
      case 'path': {
        const res = this.annotations.paths.get(expr);
        if (res?.kind !== 'local' && res?.kind !== 'capture') return undefined;
        const indirect = res.local.mode !== 'move' || isReference(res.local.type);
        return { root: res.local, path: '', indirect: res.kind === 'capture' || (indirect && false) };
      }
      case 'field': {
        const base = this.placeOf(expr.operand);
        if (!base) return undefined;
        const field = this.annotations.fields.get(expr);
        const throughRef = field?.derefs.some((step) => step === 'ref' || step === 'mutRef') ?? false;
        const derefsBox = field?.derefs.includes('own') ?? false;
        void derefsBox;
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
  // Loans

  /** Records the borrows that the value stored in `holder` keeps, when its type holds references. */
  private addLoans(holder: LocalVar, init: Expr | undefined): void {
    if (!init || !containsReference(holder.type)) return;
    for (const loan of this.borrowsOf(init)) this.loans.push({ ...loan, holder });
  }

  /** The places an expression's value borrows from: `&x`, a method that returns a borrow of its receiver, or a holder. */
  // code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of borrowing expression.
  private borrowsOf(expr: Expr): Omit<Loan, 'holder'>[] {
    switch (expr.kind) {
      case 'ref': {
        const place = this.placeOf(expr.operand);
        if (!place) return this.borrowsOf(expr.operand);
        if (place.root.mode !== 'move' || isReference(place.root.type)) return this.inheritedLoans(place.root);
        return [{ root: place.root, path: place.path, mutable: expr.mutable, span: expr.span }];
      }
      case 'methodCall': {
        const method = this.annotations.methods.get(expr);
        // A result borrows from the receiver only when the signature's result has a reference of its own, not one
        // that a type argument brings (`Vec<&str>::pop` returns no borrow of the vector).
        if (!containsReference(expr.ty) || (method && !containsReference(method.fn.ret))) return [];
        if (!method || method.fn.selfMode === 'value') {
          return method?.fn.selfMode === 'value' ? this.borrowsOf(expr.receiver) : [];
        }
        const place = this.placeOf(expr.receiver);
        if (!place) return this.borrowsOf(expr.receiver);
        const throughRef = method.receiver.derefs.some((step) => step === 'ref' || step === 'mutRef');
        if (throughRef || place.root.mode !== 'move' || isReference(place.root.type))
          return this.inheritedLoans(place.root);
        return [{ root: place.root, path: place.path, mutable: method.receiver.autoref === 'mut', span: expr.span }];
      }
      case 'call': {
        if (!containsReference(expr.ty)) return [];
        const res = expr.callee.kind === 'path' ? this.annotations.paths.get(expr.callee) : undefined;
        if (res?.kind === 'fn' && !containsReference(res.fn.ret)) return [];
        if (res?.kind === 'ctor') return expr.args.flatMap((arg) => this.borrowsOf(arg));
        return expr.args.flatMap((arg) => this.borrowsOf(arg));
      }
      case 'path': {
        const res = this.annotations.paths.get(expr);
        if (res?.kind === 'local') return this.inheritedLoans(res.local);
        return [];
      }
      case 'closure': {
        const info = this.annotations.closures.get(expr);
        if (!info || info.context.isMove) return [];
        const mutable = info.context.closureKind !== 'Fn';
        return info.context.captures
          .filter((local) => local.mode === 'move' && !isReference(local.type))
          .map((local) => ({ root: local, path: '', mutable, span: expr.span }));
      }
      case 'field':
      case 'index': {
        const place = this.placeOf(expr);
        if (place) return this.inheritedLoans(place.root);
        return [];
      }
      default: {
        return [];
      }
    }
  }

  private inheritedLoans(holder: LocalVar): Omit<Loan, 'holder'>[] {
    return this.loans.filter((loan) => loan.holder === holder).map(({ holder: _, ...loan }) => loan);
  }

  /** The place a `for` loop's iterable borrows while the loop runs. */
  private borrowedPlace(iterable: Expr): Omit<Loan, 'holder' | 'span'> | undefined {
    const [loan] = this.borrowsOf(iterable);
    return loan;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Helpers

  private bindingsOf(pattern: Pattern): LocalVar[] {
    const locals: LocalVar[] = [];
    const visit = (p: Pattern): void => {
      const local = this.annotations.bindings.get(p);
      if (local && !locals.includes(local)) locals.push(local);
      switch (p.kind) {
        case 'binding': {
          if (p.sub) visit(p.sub);
          break;
        }
        case 'tuple':
        case 'tupleStruct': {
          for (const elem of p.elems) visit(elem);
          break;
        }
        case 'struct': {
          for (const field of p.fields) visit(field.pattern);
          break;
        }
        case 'ref': {
          visit(p.pattern);
          break;
        }
        case 'or': {
          for (const alternative of p.alternatives) visit(alternative);
          break;
        }
        default: {
          break;
        }
      }
    };
    visit(pattern);
    return locals;
  }

  private isCopy(type: Type | undefined): boolean {
    if (!type) return true;
    return this.solver.isCopy(resolve(type, true));
  }
}

function initState(): VarState {
  return { init: 'yes', movedAt: undefined, partial: new Set() };
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
    result.set(local, { init, movedAt: x.movedAt ?? y.movedAt, partial: new Set([...x.partial, ...y.partial]) });
  }
  for (const [local, y] of b) if (!a.has(local)) result.set(local, y);
  return result;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

function isReference(type: Type | undefined): boolean {
  if (!type) return false;
  return normalize(shallow(type)).kind === 'ref';
}

/** Whether a type holds a reference, so that a variable of it keeps a borrow alive. */
function containsReference(type: Type | undefined): boolean {
  if (!type) return false;
  const t = normalize(shallow(type));
  switch (t.kind) {
    case 'ref': {
      return true;
    }
    case 'tuple': {
      return t.elems.some(containsReference);
    }
    case 'array':
    case 'slice': {
      return containsReference(t.elem);
    }
    case 'adt': {
      return t.args.some(containsReference) || t.def.builtin === 'Entry';
    }
    case 'closure': {
      return true;
    }
    default: {
      return false;
    }
  }
}

function walkBlock(block: Block, visit: (expr: Expr) => void): void {
  for (const stmt of block.stmts) {
    if (stmt.kind === 'let') {
      if (stmt.init) visit(stmt.init);
      if (stmt.else) walkBlock(stmt.else, visit);
    } else if (stmt.kind === 'expr') visit(stmt.expr);
  }
  if (block.tail) visit(block.tail);
}

function walkChildren(expr: Expr, visit: (expr: Expr) => void): void {
  forEachDirect(expr, visit);
}

/** Calls `visit` on the expressions directly inside an expression, in evaluation order. */
// code-gauge-allow functionCognitiveComplexity 40 -- One case per kind of expression.
export function forEachDirect(expr: Expr, visit: (expr: Expr) => void): void {
  switch (expr.kind) {
    case 'unary':
    case 'ref':
    case 'cast':
    case 'try':
    case 'field': {
      visit(expr.operand);
      return;
    }
    case 'binary': {
      visit(expr.left);
      visit(expr.right);
      return;
    }
    case 'assign':
    case 'compoundAssign': {
      visit(expr.value);
      visit(expr.target);
      return;
    }
    case 'call': {
      visit(expr.callee);
      for (const arg of expr.args) visit(arg);
      return;
    }
    case 'methodCall': {
      visit(expr.receiver);
      for (const arg of expr.args) visit(arg);
      return;
    }
    case 'index': {
      visit(expr.operand);
      visit(expr.index);
      return;
    }
    case 'range': {
      if (expr.start) visit(expr.start);
      if (expr.end) visit(expr.end);
      return;
    }
    case 'tuple':
    case 'array': {
      for (const elem of expr.elems) visit(elem);
      return;
    }
    case 'arrayRepeat': {
      visit(expr.value);
      visit(expr.count);
      return;
    }
    case 'struct': {
      for (const field of expr.fields) visit(field.value);
      if (expr.base) visit(expr.base);
      return;
    }
    case 'block': {
      walkBlock(expr, visit);
      return;
    }
    case 'if': {
      visit(expr.cond.kind === 'expr' ? expr.cond.expr : expr.cond.value);
      walkBlock(expr.consequent, visit);
      if (expr.else) visit(expr.else);
      return;
    }
    case 'match': {
      visit(expr.scrutinee);
      for (const arm of expr.arms) visit(arm.body);
      return;
    }
    case 'loop': {
      walkBlock(expr.body, visit);
      return;
    }
    case 'while': {
      visit(expr.cond.kind === 'expr' ? expr.cond.expr : expr.cond.value);
      walkBlock(expr.body, visit);
      return;
    }
    case 'for': {
      visit(expr.iterable);
      walkBlock(expr.body, visit);
      return;
    }
    case 'break':
    case 'return': {
      if (expr.value) visit(expr.value);
      return;
    }
    case 'closure': {
      visit(expr.body);
      return;
    }
    case 'macro': {
      const { macro } = expr;
      const format = (f: FormatArgs | undefined): void => {
        for (const arg of f?.args ?? []) visit(arg);
      };
      switch (macro.kind) {
        case 'print':
        case 'panic':
        case 'format': {
          format(macro.format);
          return;
        }
        case 'write': {
          visit(macro.target);
          format(macro.format);
          return;
        }
        case 'assert': {
          visit(macro.cond);
          format(macro.format);
          return;
        }
        case 'assertEq': {
          visit(macro.left);
          visit(macro.right);
          format(macro.format);
          return;
        }
        case 'vec': {
          for (const elem of macro.elems) visit(elem);
          return;
        }
        case 'vecRepeat': {
          visit(macro.value);
          visit(macro.count);
          return;
        }
        case 'matches': {
          visit(macro.value);
          return;
        }
        case 'dbg': {
          for (const arg of macro.args) visit(arg);
          return;
        }
      }
      return;
    }
    default: {
      return;
    }
  }
}
