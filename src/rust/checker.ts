// code-gauge-allow-file fileNcss 591 -- The checker core: bodies, obligations, scopes, coercions, and statements.
import { CompileError } from '../interpreter/diagnostics';
import { Annotations, type Coercion, type FnContext, type LocalVar, type PathRes } from './annotations';
import type { Block, Expr, FnItem, Pattern, Span, Stmt, TypeAst } from './ast';
import { BorrowChecker } from './borrowck';
import { exprInner } from './checkerExpr';
import { settleBinaries } from './checkerOperators';
import { checkPattern } from './checkerPatterns';
import { ConstLint } from './constLint';
import { isIrrefutable, lowerPattern } from './exhaustiveness';
import { deepNormalize, isPseudo, normalize, Unifier } from './infer';
import { compileError, ItemCollector, lowerType, Module, type Program, resolveImports, type TypeScope } from './items';
import { intoIterItem, intoIterShape } from './iterTypes';
import { allSupertraits, autoderefSteps, derefOnce } from './methods';
import { TraitSolver } from './traits';
import {
  type AdtDef,
  childTypes,
  type FloatName,
  type FnDef,
  freshVar,
  hasParams,
  hasVars,
  type ImplDef,
  intMax,
  intMin,
  type IntName,
  isSigned,
  isUnit,
  NEVER,
  ref,
  resolve,
  sameType,
  shallow,
  type Subst,
  substitute,
  substituteTraitRef,
  type TraitDef,
  type TraitRef,
  traitRefToString,
  type Type,
  type TypeParam,
  typeToString,
  UNIT,
} from './types';

export interface Obligation {
  type: Type;
  ref: TraitRef;
  span: Span;
}

export interface LoopContext {
  label: string | undefined;
  /** The type `break` values give a `loop`, or undefined for `while` and `for`, whose breaks carry no value. */
  breakType: Type | undefined;
  context: FnContext;
}

export interface BodyContext {
  fn: FnContext;
  retType: Type;
  loops: LoopContext[];
  scopes: Map<string, LocalVar>[];
  /** Whether the body is a closure's, whose `return` returns from the closure. */
  isClosure: boolean;
  module: Module;
  typeParams: Map<string, TypeParam>;
  selfType: Type | undefined;
  /** The trait the body's impl implements or its trait declares, which is in scope in it as rustc puts it. */
  currentTrait?: TraitDef;
}

let nextLocalId = 0;

/** Checks the types of every function body, recording what the compiler needs in {@link Annotations}. */
export class Checker {
  readonly annotations = new Annotations();
  readonly unifier = new Unifier();
  readonly solver: TraitSolver;
  private obligations: Obligation[] = [];
  /** The errors `?` converts whose type waits on a parse's target (`ParseError<F>`), to settle once it is known. */
  pendingTryErrors: { from: Type; to: Type; span: Span }[] = [];
  /** Arithmetic whose left operand's type is not known yet, with the variable its result's type is. */
  pendingBinaries: {
    expr: Extract<Expr, { kind: 'binary' }>;
    leftType: Type;
    rightType: Type;
    result: Type;
  }[] = [];
  /** Bodies of functions declared in blocks, checked after the function around them. */
  private readonly nestedFns: FnDef[] = [];
  /** The context of each checked function, which the compiler reads. */
  readonly fnContexts = new Map<FnDef, FnContext>();
  /** For each instantiated type parameter of a call, the bounds that closures passed for it take their signature from. */
  readonly varBounds = new Map<unknown, TraitRef[]>();
  body!: BodyContext;
  deferredChecks: (() => void)[] = [];
  /** The number literals of the body, which rustc's `overflowing_literals` lint checks against their types. */
  literals: Extract<Expr, { kind: 'int' | 'float' }>[] = [];
  /** The integer literals that `-` negates, whose range reaches one further below zero. */
  readonly negatedLiterals = new Set<Expr>();
  orBindings: Map<string, LocalVar> | undefined;
  /** Moves out of a reference by `&` patterns, which rustc's borrow checker reports in order with its other errors. */
  patternMoves: { span: Span; message: string }[] = [];

  constructor(
    readonly program: Program,
    readonly atomicRows: ReadonlySet<number>
  ) {
    this.solver = new TraitSolver(program, this.unifier);
  }

  checkProgram(): void {
    this.checkDerivedFields();
    this.checkImplCoherence();
    for (const impl of this.program.impls) this.checkImplSignatures(impl);
    for (const fn of this.program.pendingFns.splice(0)) this.checkFn(fn);
    while (this.nestedFns.length > 0) this.checkFn(this.nestedFns.shift()!);
    this.checkConstsAndMain();
  }

  /** A derived trait needs every field's type to implement it, as the impl that `#[derive]` writes uses each field. */
  private checkDerivedFields(): void {
    for (const def of this.program.adts) {
      if ((def.module as Module | undefined)?.isStd) continue;
      for (const name of def.derives) this.checkDerivedTrait(def, name);
    }
  }

  /**
   * Rejects a second impl of a trait for the same type (E0119), and an impl of a standard library's trait for a type
   * the program does not declare (E0117, the orphan rule).
   */
  private checkImplCoherence(): void {
    const seen = new Set<string>();
    for (const impl of this.program.impls) {
      const traitRef = impl.trait;
      if (!traitRef || (impl.module as Module).isStd) continue;
      const span = impl.span as Span;
      const key = `${traitRef.trait.path}<${traitRef.args.map(typeToString).join(',')}> for ${typeToString(impl.selfType)}`;
      if (impl.params.length === 0 && seen.has(key)) {
        compileError(
          span,
          `トレイト ${traitRef.trait.name} は、型 ${typeToString(impl.selfType)} に2回実装されています。`
        );
      }
      seen.add(key);
      if ((traitRef.trait.module as Module).isStd && !isLocalType(impl.selfType)) {
        compileError(
          span,
          `標準ライブラリのトレイト ${traitRef.trait.name} は、自分で宣言した型にだけ実装できます（${typeToString(impl.selfType)} には実装できません）。`
        );
      }
    }
  }

  /** Requires the methods of a trait impl to take `self`, their parameters, and return as the trait declares them. */
  // code-gauge-allow functionCognitiveComplexity 16 -- Follows the type checking rules of rustc case by case.
  private checkImplSignatures(impl: ImplDef): void {
    const traitRef = impl.trait;
    if (!traitRef || (impl.module as Module).isStd) return;
    const { trait } = traitRef;
    for (const fn of impl.methods.values()) {
      const decl = trait.methods.get(fn.name);
      if (!decl || !fn.ast) continue;
      const span = fn.ast.span;
      if (decl.selfMode !== fn.selfMode) {
        compileError(span, `メソッド ${fn.name} の self の受け取り方が、トレイト ${trait.name} の宣言と違います。`);
      }
      if (decl.paramTypes.length !== fn.paramTypes.length) {
        compileError(
          span,
          `メソッド ${fn.name} の引数の数が、トレイト ${trait.name} の宣言と違います（${decl.paramTypes.length} 個です）。`
        );
      }
      const subst = implSubst(impl, traitRef, decl, fn);
      const pairs = [...decl.paramTypes.map((type, index) => [type, fn.paramTypes[index]]), [decl.ret, fn.ret]];
      for (const [declared, written] of pairs) {
        const expected = substitute(declared, subst);
        if (hasOpaque(expected) || hasOpaque(written) || sameType(expected, written)) continue;
        compileError(
          span,
          `メソッド ${fn.name} の型が、トレイト ${trait.name} の宣言と違います（${typeToString(expected)} が必要ですが、${typeToString(written)} です）。`
        );
      }
    }
  }

  private checkDerivedTrait(def: AdtDef, name: string): void {
    const trait = this.program.builtinTraits.get(name);
    if (!trait) return;
    for (const field of def.variants.flatMap((variant) => variant.fields)) {
      // A derive bounds the type parameters by the trait, so fields of parameter types meet it.
      if (hasParams(field.type) || this.solver.implements(field.type, { trait, args: [] }) !== 'no') continue;
      compileError(
        name === 'Copy' ? def.span : field.span,
        `${typeToString(field.type)} が ${name} を実装していないので、フィールド ${field.name} を持つ ${def.name} に #[derive(${name})] を付けられません。`
      );
    }
  }

  private checkConstsAndMain(): void {
    for (const def of this.program.consts) {
      const ast = def.ast as { value?: Expr; span: Span; name: string };
      if (!ast.value || (def as { checked?: boolean }).checked) continue;
      (def as { checked?: boolean }).checked = true;
      const module = this.program.root;
      this.body = this.newBody({ name: def.name, module, retType: def.type, isAtomic: false });
      this.coerceExpr(ast.value, def.type);
      this.finishBody(ast.span);
      // rustc evaluates constants before running, so one whose value overflows or divides by zero is an error.
      new ConstLint(this.annotations, module).checkExpr(ast.value);
    }
    const main = this.program.root.values.get('main');
    if (main?.binding.kind !== 'fn') {
      compileError({ row: 0, col: 1 }, 'main 関数がありません（fn main() { ... } を書いてください）。');
    }
  }

  private newBody(options: {
    name: string;
    module: Module;
    retType: Type;
    isAtomic: boolean;
    typeParams?: Map<string, TypeParam>;
    selfType?: Type;
    currentTrait?: TraitDef;
  }): BodyContext {
    const fn: FnContext = {
      name: options.name,
      locals: [],
      slotCount: 0,
      captures: [],
      parent: undefined,
      isClosure: false,
      isAtomic: options.isAtomic,
      isMove: false,
      closureKind: 'Fn',
    };
    return {
      fn,
      retType: options.retType,
      loops: [],
      scopes: [new Map()],
      isClosure: false,
      module: options.module,
      typeParams: options.typeParams ?? new Map(),
      selfType: options.selfType,
      currentTrait: options.currentTrait,
    };
  }

  private isAtomic(item: FnItem): boolean {
    for (let row = item.span.row; row <= item.headerEndRow; row++) if (this.atomicRows.has(row)) return true;
    return false;
  }

  checkFn(def: FnDef): void {
    const item = def.ast as FnItem;
    if (!item.body) return;
    const module = def.module as Module;
    const typeParams = new Map(def.params.map((param) => [param.name, param]));
    const selfType: Type | undefined = def.trait ? { kind: 'param', param: def.trait.self } : def.impl?.selfType;
    this.body = this.newBody({
      name: def.name,
      module,
      retType: def.ret.kind === 'opaque' ? freshVar() : def.ret,
      isAtomic: this.isAtomic(item),
      typeParams,
      selfType,
      currentTrait: def.trait ?? def.impl?.trait?.trait,
    });
    this.fnContexts.set(def, this.body.fn);
    if (item.selfParam && selfType) {
      const mode = item.selfParam.mode;
      const type = mode === 'value' ? selfType : ref(selfType, mode === 'mutRef');
      const local = this.declareLocal('self', type, item.selfParam.mutable, item.selfParam.span);
      local.isSelf = true;
    }
    for (const [index, param] of item.params.entries()) {
      checkPattern(this, param.pattern, def.paramTypes[index], 'move');
      this.requireIrrefutable(param.pattern, def.paramTypes[index], 'fn');
    }
    const bodyType = this.checkBlock(item.body, this.body.retType);
    if (item.body.tail) this.coerceReturned(item.body.tail, bodyType, this.body.retType);
    this.coerceTail(item.body, bodyType, this.body.retType, item);
    if (def.ret.kind === 'opaque') {
      def.ret.opaque.hidden = this.body.retType;
      for (const bound of def.ret.opaque.bounds) {
        this.obligations.push({ type: this.body.retType, ref: bound, span: item.span });
      }
    }
    this.finishBody(item.span);
    this.requireKnownTypes();
    this.checkBorrows(() =>
      new BorrowChecker(this.annotations, this.solver).checkFn(item, this.body.fn, this.body.retType)
    );
    new ConstLint(this.annotations, this.body.module).check(item.body);
  }

  /** Runs the borrow checker, reporting its first error or a move by a `&` pattern, whichever comes first. */
  private checkBorrows(check: () => void): void {
    const moves = this.patternMoves.splice(0).toSorted((a, b) => a.span.row - b.span.row);
    try {
      check();
    } catch (error) {
      if (!(error instanceof CompileError) || moves.length === 0) throw error;
      if (moves[0].span.row >= error.diagnostics[0].row) throw error;
    }
    if (moves.length > 0) compileError(moves[0].span, moves[0].message);
  }

  /** Coerces the value a function's body ends with to its result type. */
  private coerceReturned(tail: Expr, type: Type, retType: Type): void {
    if (shallow(type).kind === 'never') return;
    if (tail.kind === 'block' || tail.kind === 'if' || tail.kind === 'match') {
      if (!this.unifier.tryUnify(type, retType)) this.coerce(tail, type, retType);
      return;
    }
    this.coerce(tail, type, retType);
  }

  /** Checks a block's value against the function's result, reporting the mismatch at the result type. */
  private coerceTail(block: Block, actual: Type, expected: Type, item: FnItem): void {
    if (block.tail) return;
    const t = shallow(actual);
    if (t.kind === 'never') return;
    if (!this.unifier.tryUnify(actual, expected)) {
      // rustc reports the return type that the body does not give.
      const span = item.ret?.span ?? item.span;
      const lastStmt = block.stmts.at(-1);
      if (lastStmt?.kind === 'expr' && lastStmt.semi && !isUnit(expected)) {
        compileError(
          span,
          `関数 ${item.name} は ${typeToString(expected)} を返すはずですが、最後の式の後に ; があるので値を返していません（; を消してください）。`
        );
      }
      compileError(span, `関数 ${item.name} は ${typeToString(expected)} を返すはずですが、値を返していません。`);
    }
  }

  /**
   * Rejects an expression whose type is not known yet at the variable it is read from, whose type rustc asks for
   * (E0282), when its type is not known either.
   */
  unknownLocal(expr: Expr): void {
    let root = expr;
    while (root.kind === 'index' || root.kind === 'field') root = root.operand;
    const res = root.kind === 'path' ? this.annotations.paths.get(root) : undefined;
    if (res?.kind !== 'local') return;
    const type = resolve(res.local.type);
    if (hasVars(type)) {
      compileError(
        res.local.span,
        `変数 ${res.local.name} の型が決まりません（${typeToString(type)} の型を書いてください）。`
      );
    }
  }

  /** Requires every variable's type to be known once inference is done, as rustc does (E0282). */
  requireKnownTypes(): void {
    const contexts = [this.body.fn, ...[...this.annotations.closures.values()].map((info) => info.context)];
    for (const context of contexts) {
      for (const local of context.locals) {
        const type = resolve(local.type, true);
        if (hasVars(type)) {
          compileError(
            local.span,
            `変数 ${local.name} の型が決まりません（${typeToString(type)} の型を書いてください）。`
          );
        }
      }
    }
  }

  /** Solves the remaining obligations, applies the default types of literals, and requires every type to be known. */
  private finishBody(span: Span): void {
    this.solveObligations(false);
    for (const check of this.deferredChecks.splice(0)) check();
    this.solveObligations(true);
    this.checkLiteralRanges();
    void span;
  }

  /** Rejects number literals out of their types' ranges, as rustc's deny-by-default `overflowing_literals` lint does. */
  private checkLiteralRanges(): void {
    for (const literal of this.literals.splice(0)) {
      const type = normalize(shallow(resolve(literal.ty!, true)));
      if (literal.kind === 'float' && type.kind === 'float') checkFloatLiteral(literal, type.name);
      if (literal.kind === 'int' && type.kind === 'int') {
        checkIntLiteral(literal, type.name, this.negatedLiterals.has(literal));
      }
    }
    this.negatedLiterals.clear();
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Follows the type checking rules of rustc case by case.
  private solveObligations(final: boolean): void {
    this.settleTryErrors(final);
    let progress = true;
    while (progress) {
      progress = settleBinaries(this, false);
      const pending = this.obligations;
      this.obligations = [];
      for (const obligation of pending) {
        const answer = this.solver.implements(obligation.type, obligation.ref);
        if (answer === 'no') this.unsatisfied(obligation);
        if (answer === 'unknown') this.obligations.push(obligation);
        else progress = true;
      }
    }
    if (!final) return;
    settleBinaries(this, true);
    // Literal variables take their defaults, which may settle what remains.
    for (const obligation of this.obligations) resolve(obligation.type, true);
    const remaining = this.obligations;
    this.obligations = [];
    for (const obligation of remaining) {
      const answer = this.solver.implements(obligation.type, obligation.ref);
      if (answer === 'no') this.unsatisfied(obligation);
      if (answer === 'unknown') {
        // rustc reports the variable whose type is not known, where one is.
        this.requireKnownTypes();
        compileError(obligation.span, `型が決まりません（${typeToString(obligation.type)} の型を書いてください）。`);
      }
    }
  }

  private settleTryErrors(final: boolean): void {
    const pending = this.pendingTryErrors;
    this.pendingTryErrors = [];
    for (const error of pending) {
      const from = normalize(shallow(error.from));
      if (!final && from.kind === 'adt' && isPseudo(from.def)) this.pendingTryErrors.push(error);
      else this.convertTryError(error.from, error.to, error.span);
    }
  }

  /** Requires `?` to convert an error to the function's, by `From` unless it is the same type. */
  convertTryError(from: Type, to: Type, span: Span): void {
    if (!this.unifier.tryUnify(from, to))
      this.require(to, { trait: this.program.traitDef('From'), args: [from] }, span);
  }

  private unsatisfied(obligation: Obligation): never {
    let closure = normalize(shallow(obligation.type));
    const throughRef = closure.kind === 'ref' && !closure.mutable;
    if (closure.kind === 'ref') closure = normalize(shallow(closure.target));
    // rustc reports a closure that implements too weak a closure trait where the closure is written.
    const needsFn = obligation.ref.trait.name === 'Fn' || (throughRef && obligation.ref.fnSig !== undefined);
    if (closure.kind === 'closure' && closure.closure.kind === 'FnMut' && needsFn && closure.closure.span) {
      compileError(
        closure.closure.span,
        'Fn のクロージャが要りますが、このクロージャは取り込んだ変数を書き換えるので FnMut です（参照ではなく、そのまま渡してください）。'
      );
    }
    if (closure.kind === 'closure' && closure.closure.movedAt) {
      const { name, span } = closure.closure.movedAt;
      compileError(
        span,
        `${obligation.ref.trait.name} のクロージャの中では、取り込んだ変数 ${name} をムーブできません（.clone() で複製してください）。`
      );
    }
    const type = typeToString(resolve(obligation.type));
    const trait = traitRefToString(obligation.ref);
    const name = obligation.ref.trait.name;
    const hints: Record<string, string> = {
      Display: `${type} は {} で表示できません（{:?} を使うか、Display を実装してください）。`,
      Debug: `${type} は {:?} で表示できません（#[derive(Debug)] を付けてください）。`,
      Copy: `${type} は Copy ではありません。`,
      Clone: `${type} は Clone ではありません（#[derive(Clone)] を付けてください）。`,
      PartialEq: `${type} どうしは比べられません（#[derive(PartialEq)] を付けてください）。`,
      PartialOrd: `${type} どうしは大小を比べられません（#[derive(PartialOrd)] を付けてください）。`,
      Ord: `${type} は Ord ではありません（f64 などの小数は sort や max に使えません）。`,
    };
    compileError(obligation.span, hints[name] ?? `${type} にトレイト ${trait} が実装されていません。`);
  }

  /**
   * A type with what the pending obligations settle about it, as rustc solves them before it needs to know a type
   * (`let v: Vec<_> = it.collect(); v[0].len()`).
   */
  settled(type: Type): Type {
    if (this.obligations.length > 0 && hasVars(resolve(type))) this.solveObligations(false);
    return type;
  }

  require(type: Type, ref: TraitRef, span: Span): void {
    const answer = this.solver.implements(type, ref);
    if (answer === 'no') this.unsatisfied({ type, ref, span });
    if (answer === 'unknown') this.obligations.push({ type, ref, span });
  }

  requireTrait(type: Type, name: string, span: Span): void {
    this.require(type, { trait: this.program.traitDef(name), args: [] }, span);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Variables and scopes

  declareLocal(name: string, type: Type, mutable: boolean, span: Span, mode: LocalVar['mode'] = 'move'): LocalVar {
    const fn = this.body.fn;
    const local: LocalVar = {
      name,
      mutable,
      type,
      slot: fn.slotCount++,
      span,
      owner: fn,
      mode,
      id: nextLocalId++,
    };
    fn.locals.push(local);
    (this.body.scopes.at(-1) as Map<string, LocalVar>).set(name, local);
    return local;
  }

  withScope<T>(run: () => T): T {
    const body = this.body;
    const module = body.module;
    body.scopes.push(new Map());
    try {
      return run();
    } finally {
      body.scopes.pop();
      body.module = module;
    }
  }

  findLocal(name: string): LocalVar | undefined {
    for (let index = this.body.scopes.length - 1; index >= 0; index--) {
      const found = this.body.scopes[index].get(name);
      if (found) return found;
    }
    return undefined;
  }

  /** How a body reaches a variable: its own, or a capture of a closure (recorded on every closure in between). */
  localRes(local: LocalVar): PathRes {
    if (local.owner === this.body.fn) return { kind: 'local', local };
    let index = -1;
    const chain: FnContext[] = [];
    for (let fn: FnContext | undefined = this.body.fn; fn && fn !== local.owner; fn = fn.parent) chain.push(fn);
    for (const fn of chain.toReversed()) {
      index = fn.captures.indexOf(local);
      if (index < 0) {
        fn.captures.push(local);
        index = fn.captures.length - 1;
      }
    }
    index = this.body.fn.captures.indexOf(local);
    return { kind: 'capture', local, index };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Types

  private typeScope(): TypeScope {
    return {
      module: this.body.module,
      params: this.body.typeParams,
      selfType: this.body.selfType,
      allowInfer: true,
    };
  }

  lowerType(ast: TypeAst): Type {
    const type = lowerType(ast, this.typeScope());
    this.checkWrittenType(type, ast.span);
    return type;
  }

  mismatch(span: Span, expected: Type, actual: Type): never {
    const e = typeToString(resolve(expected));
    const a = typeToString(resolve(actual));
    if (e === a) compileError(span, `型が合いません（${e} が必要です）。`);
    compileError(span, `型が合いません（${e} が必要ですが、${a} です）。`);
  }

  unifyOrError(span: Span, expected: Type, actual: Type): void {
    if (!this.unifier.tryUnify(expected, actual)) this.mismatch(span, expected, actual);
  }

  /**
   * Checks an expression where a value of `target` is required, applying the coercions Rust applies there: deref
   * coercions of references, unsizing to trait objects, and collections to iterators.
   */
  coerceExpr(expr: Expr, target: Type): void {
    const actual = this.expr(expr, target);
    this.coerce(expr, actual, target);
  }

  /**
   * Records a coercion of an expression's value. A block's value is its tail's, and an `if`'s or a `match`'s are its
   * branches', which rustc coerces each where it ends.
   */
  private setCoercion(expr: Expr, coercion: Coercion): void {
    if (expr.kind === 'block') {
      if (expr.tail) this.setCoercion(expr.tail, coercion);
      return;
    }
    if (expr.kind === 'if' && expr.else) {
      this.setCoercion(expr.consequent, coercion);
      this.setCoercion(expr.else, coercion);
      return;
    }
    if (expr.kind === 'match') {
      for (const arm of expr.arms) this.setCoercion(arm.body, coercion);
      return;
    }
    if (shallow(expr.ty ?? UNIT).kind === 'never') return;
    this.coercionLog?.push([expr, this.annotations.coercions.get(expr)]);
    this.annotations.coercions.set(expr, coercion);
  }

  /** The coercions recorded during a {@link tryCoerce}, with what each expression had before, to undo them. */
  private coercionLog: [Expr, Coercion | undefined][] | undefined;

  /** Coerces like {@link coerce}, telling whether it could, and undoing what it did when it could not. */
  tryCoerce(expr: Expr, actual: Type, target: Type): boolean {
    return this.attempt(() => this.coerce(expr, actual, target));
  }

  /** Runs a check, undoing its bindings and coercions when it fails. */
  private attempt(check: () => void): boolean {
    const snapshot = this.unifier.snapshot();
    const outer = this.coercionLog;
    const log: [Expr, Coercion | undefined][] = [];
    this.coercionLog = log;
    try {
      check();
      outer?.push(...log);
      return true;
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      this.unifier.rollback(snapshot);
      for (const [expr, previous] of log.toReversed()) {
        if (previous) this.annotations.coercions.set(expr, previous);
        else this.annotations.coercions.delete(expr);
      }
      return false;
    } finally {
      this.coercionLog = outer;
    }
  }

  /**
   * The type that values which must agree (branches, arms, elements) take, as rustc's `CoerceMany` merges them: each
   * value coerces to the type so far, or else the values so far all coerce to its type (`&String` and `&str` give
   * `&str` in either order). `mismatch` reports a value that fits neither way.
   */
  mergeTypes(values: [Expr, Type][], mismatch: (expr: Expr, merged: Type, type: Type) => never): Type | undefined {
    let merged: Type | undefined;
    const previous: [Expr, Type][] = [];
    for (const [expr, type] of values) {
      if (shallow(type).kind === 'never') continue;
      if (merged !== undefined && !this.tryCoerce(expr, type, merged)) {
        const target = type;
        const lub = this.attempt(() => {
          for (const [prevExpr, prevType] of previous) this.coerce(prevExpr, prevType, target);
        });
        if (!lub) mismatch(expr, merged, type);
        merged = type;
      }
      merged ??= type;
      previous.push([expr, type]);
    }
    return merged;
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- Follows the type checking rules of rustc case by case.
  coerce(expr: Expr, actual: Type, target: Type): void {
    const a = normalize(shallow(actual));
    const t = normalize(shallow(target));
    if (a.kind === 'never') return;
    if (this.unifier.tryUnify(a, t)) return;
    if (a.kind === 'ref' && t.kind === 'ref' && (!t.mutable || a.mutable) && this.coerceRef(expr, a, t)) return;
    if (a.kind === 'adt' && a.def.builtin === 'Box' && t.kind === 'adt' && t.def.builtin === 'Box') {
      const target = shallow(t.args[0]);
      // `Box<[T; N]>` unsizes to `Box<[T]>`, which holds the same elements.
      const array = normalize(shallow(a.args[0]));
      if (target.kind === 'slice' && array.kind === 'array' && this.unifier.tryUnify(array.elem, target.elem)) return;
      if (target.kind === 'dyn') {
        this.requireDyn(a.args[0], target.trait, expr.span);
        this.setCoercion(expr, { kind: 'dyn', type: a.args[0], mutable: false });
        return;
      }
    }
    if (t.kind === 'adt' && t.def.builtin === 'Iter') {
      const item = intoIterItem(a);
      const shape = intoIterShape(this.program, a);
      if (
        item &&
        shape &&
        this.unifier.tryUnify({ kind: 'tuple', elems: [item, shape] }, { kind: 'tuple', elems: t.args })
      ) {
        this.setCoercion(expr, { kind: 'intoIter', from: a });
        return;
      }
    }
    if (
      a.kind === 'closure' &&
      t.kind === 'fn' &&
      this.unifier.tryUnify({ kind: 'tuple', elems: a.closure.params }, { kind: 'tuple', elems: t.params }) &&
      this.unifier.tryUnify(a.closure.ret, t.ret)
    ) {
      return;
    }
    this.mismatch(expr.span, target, actual);
  }

  /** `&T` → `&U` through derefs, `&mut T` → `&T`, and `&T` → `&dyn Trait`; false when none applies. */
  private coerceRef(expr: Expr, a: Type & { kind: 'ref' }, t: Type & { kind: 'ref' }): boolean {
    // rustc coerces to a trait object by unsizing alone, without deref (`&Box<dyn S>` is no `&dyn S`).
    const target = shallow(t.target);
    const steps = autoderefSteps(this.program, a.target).slice(0, target.kind === 'dyn' ? 1 : undefined);
    for (const step of steps) {
      if (!this.unifier.tryUnify(step.type, t.target)) continue;
      if (step.derefs.length > 0 || (a.mutable && !t.mutable)) {
        this.setCoercion(expr, {
          kind: 'deref',
          derefs: step.derefs,
          fromMut: a.mutable && !t.mutable,
        });
      }
      return true;
    }
    if (target.kind !== 'dyn') return false;
    this.requireDyn(a.target, target.trait, expr.span);
    this.setCoercion(expr, { kind: 'dyn', type: a.target, mutable: a.mutable });
    return true;
  }

  /**
   * Rejects what rustc rejects in a written type: a trait object of a trait that methods returning `Self` or taking
   * type parameters make not dyn compatible (E0038), and an unsized type (`dyn T`, `str`) as a type argument (E0277).
   */
  private checkWrittenType(type: Type, span: Span): void {
    const t = shallow(type);
    if (t.kind === 'dyn') checkDynCompatible(t.trait.trait, span);
    if (t.kind === 'adt' && t.def.builtin !== 'Box') {
      for (const arg of t.args) {
        const a = shallow(arg);
        if (a.kind === 'dyn' || a.kind === 'str' || a.kind === 'slice') {
          compileError(
            span,
            `${typeToString(a)} は大きさが決まらないので、${t.def.name} の型引数にできません（Box<…> に入れてください）。`
          );
        }
      }
    }
    for (const child of childTypes(t)) if (child.kind !== 'closure') this.checkWrittenType(child, span);
  }

  private requireDyn(type: Type, trait: TraitRef, span: Span): void {
    const t = shallow(type);
    if (t.kind === 'dyn' && t.trait.trait === trait.trait) return;
    this.require(type, trait, span);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Statements

  checkBlock(block: Block, expected: Type | undefined): Type {
    return this.withScope(() => {
      if (block.items.length > 0) this.declareBlockItems(block);
      let diverges = false;
      for (const stmt of block.stmts) {
        if (this.checkStmt(stmt)) diverges = true;
      }
      if (block.tail) return this.expr(block.tail, expected);
      return diverges ? NEVER : UNIT;
    });
  }

  private declareBlockItems(block: Block): void {
    const module = new Module(this.program, '{block}', this.body.module.namedModule, false, this.body.module);
    const collector = new ItemCollector(this.program);
    const pendingBefore = this.program.pendingFns.length;
    collector.collectItems(block.items, module);
    collector.finish();
    resolveImports(module);
    this.nestedFns.push(...this.program.pendingFns.splice(pendingBefore));
    this.body.module = module;
  }

  /** Checks a statement, telling whether it diverges (its expression's type is `!`). */
  private checkStmt(stmt: Stmt): boolean {
    switch (stmt.kind) {
      case 'let': {
        return this.checkLet(stmt);
      }
      case 'expr': {
        const type = this.expr(stmt.expr, stmt.semi ? undefined : UNIT);
        const t = shallow(type);
        if (!stmt.semi && t.kind !== 'never' && !this.unifier.tryUnify(type, UNIT)) {
          compileError(
            stmt.span,
            `型が合いません（() が必要ですが、${typeToString(type)} です。文の終わりに ; を書いてください）。`
          );
        }
        if (stmt.semi && t.kind === 'var' && !t.v.literal) this.deferredUnitStatement(stmt.expr, type);
        return t.kind === 'never';
      }
      case 'empty': {
        return false;
      }
    }
  }

  private deferredUnitStatement(_expr: Expr, _type: Type): void {
    // A statement's value is dropped, so its type may stay unknown only if nothing else needs it.
  }

  private checkLet(stmt: Extract<Stmt, { kind: 'let' }>): boolean {
    const declared = stmt.type ? this.lowerType(stmt.type) : undefined;
    let type = declared ?? freshVar();
    let diverges = false;
    if (stmt.init) {
      if (declared) this.coerceExpr(stmt.init, declared);
      else type = this.expr(stmt.init, undefined);
      diverges = shallow(type).kind === 'never' && !declared;
      if (shallow(type).kind === 'never') type = declared ?? freshVar();
    }
    if (stmt.else) {
      if (!stmt.init) compileError(stmt.span, 'let ... else には、初期値が要ります。');
      const elseType = this.checkBlock(stmt.else, undefined);
      if (shallow(elseType).kind !== 'never') {
        compileError(stmt.else.span, 'let ... else の else のブロックは、return や break などで抜けてください。');
      }
    }
    checkPattern(this, stmt.pattern, type, 'move');
    if (!stmt.else) this.requireIrrefutable(stmt.pattern, type, 'let');
    return diverges;
  }

  requireIrrefutable(pattern: Pattern, type: Type, where: 'let' | 'fn' | 'for'): void {
    if (pattern.kind === 'binding' && !this.annotations.paths.has(pattern)) return;
    if (pattern.kind === 'wild') return;
    this.deferredChecks.push(() => {
      const lowered = lowerPattern(pattern, this.annotations);
      if (!isIrrefutable(lowered, resolve(type, true))) {
        const name = where === 'let' ? 'let' : where === 'for' ? 'for' : '関数の引数';
        compileError(
          pattern.span,
          `${name} のパターンは、すべての値に合うものにしてください（合わない値があるなら if let か match を使います）。`
        );
      }
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Expressions

  /** Checks an expression, whose type `expected` may guide (the type of a literal, a closure's parameters). */
  expr(expr: Expr, expected: Type | undefined): Type {
    const type = exprInner(this, expr, expected);
    expr.ty = type;
    return type;
  }

  /** The signature of a function with its type parameters bound, recording each parameter's bounds as obligations. */
  instantiate(fn: FnDef, typeArgs: Type[], span?: Span): { params: Type[]; ret: Type; subst: Subst } {
    const subst: Subst = new Map(fn.params.map((param, index) => [param, typeArgs[index] ?? freshVar()]));
    for (const param of fn.params) {
      const arg = subst.get(param) as Type;
      const bounds = param.bounds.map((bound) => substituteTraitRef(bound, subst));
      const argType = shallow(arg);
      if (argType.kind === 'var') {
        const existing = this.varBounds.get(argType.v) ?? [];
        this.varBounds.set(argType.v, [...existing, ...bounds]);
      }
      if (span) {
        for (const bound of bounds) {
          this.obligations.push({ type: arg, ref: bound, span });
        }
      }
    }
    if (span) {
      for (const { param, bound } of fn.extraBounds ?? []) {
        this.obligations.push({
          type: subst.get(param) as Type,
          ref: substituteTraitRef(bound, subst),
          span,
        });
      }
    }
    return {
      params: fn.paramTypes.map((type) => substitute(type, subst)),
      ret: substitute(fn.ret, subst),
      subst,
    };
  }
}

export { hasParams, deepNormalize, allSupertraits, derefOnce };

function checkFloatLiteral(literal: Extract<Expr, { kind: 'float' }>, name: FloatName): void {
  const value = name === 'f32' ? literal.f32 : literal.value;
  if (!Number.isFinite(value)) compileError(literal.span, `小数のリテラルが ${name} の範囲を超えています。`);
}

function checkIntLiteral(literal: Extract<Expr, { kind: 'int' }>, name: IntName, negated: boolean): void {
  const limit = negated && isSigned(name) ? -intMin(name) : intMax(name);
  if (literal.value <= limit) return;
  compileError(
    literal.span,
    `リテラル ${negated ? '-' : ''}${literal.value} は ${name} の範囲（${intMin(name)}〜${intMax(name)}）を超えています。`
  );
}

function hasOpaque(type: Type): boolean {
  const t = shallow(type);
  return t.kind === 'opaque' || childTypes(t).some(hasOpaque);
}

/** What a trait's method signature reads as in an impl: its `Self`, the trait's and the method's own type parameters. */
function implSubst(impl: ImplDef, traitRef: TraitRef, decl: FnDef, fn: FnDef): Map<TypeParam, Type> {
  const { trait } = traitRef;
  const subst = new Map<TypeParam, Type>([[trait.self, impl.selfType]]);
  for (const [index, param] of trait.params.entries()) subst.set(param, traitRef.args[index]);
  const own = fn.params.slice(fn.parentParamCount);
  for (const [index, param] of decl.params.slice(decl.parentParamCount).entries()) {
    if (own[index]) subst.set(param, { kind: 'param', param: own[index] });
  }
  return subst;
}

/** Whether an impl's self type is one the program declares, which the orphan rule lets it implement std's traits for. */
function isLocalType(type: Type): boolean {
  const t = shallow(type);
  if (t.kind === 'ref') return isLocalType(t.target);
  if (t.kind === 'param') return true;
  return t.kind === 'adt' && !(t.def.module as Module | undefined)?.isStd;
}

/** A trait of the program can be a trait object unless a method returns `Self` or takes type parameters. */
function checkDynCompatible(trait: TraitDef, span: Span): void {
  if ((trait.module as Module | undefined)?.isStd) return;
  for (const fn of trait.methods.values()) {
    if (fn.extraBounds?.some(({ param }) => param === trait.self)) continue;
    const returnsSelf = mentionsParam(fn.ret, trait.self);
    const generic = fn.params.length > fn.parentParamCount;
    if (returnsSelf || generic || !fn.selfMode) {
      compileError(
        span,
        `トレイト ${trait.name} はメソッド ${fn.name} が${returnsSelf ? ' Self を返す' : generic ? '型引数を取る' : ' self を取らない'}ので、dyn ${trait.name} にできません。`
      );
    }
  }
}

function mentionsParam(type: Type, param: TypeParam): boolean {
  const t = shallow(type);
  if (t.kind === 'param') return t.param === param;
  return childTypes(t).some((child) => mentionsParam(child, param));
}
