// code-gauge-allow-file fileNcss -- The checker core owns body, entry point, and type obligations.
import { CompileError } from '../interpreter/diagnostics';
import type { ExecutionBudget } from '../interpreter/limits';
import { misplacedAtomicMessage } from '../interpreter/traceAnnotations';
import { AdtStorage } from './adtStorage';
import { Annotations, type Coercion, type FnContext, type LocalVar, type PathRes } from './annotations';
import type { Block, Expr, FnItem, Pattern, Span, Stmt, TypeAst } from './ast';
import { forEachResult } from './astWalk';
import { BorrowChecker } from './borrowck';
import { wrapSelf } from './checkerCalls';
import { settleClosures } from './checkerClosures';
import { exprInner } from './checkerExpr';
import { settleBinaries } from './checkerOperators';
import { checkParamPatterns, checkPattern, requireRefMutSource } from './checkerPatterns';
import { checkConstOperations, ConstLint } from './constLint';
import { checkCopyDestructors } from './copyDestructors';
import { neverCompletes } from './divergence';
import { requireSizedSource } from './dynSource';
import { isIrrefutable, lowerPattern } from './exhaustiveness';
import { deepNormalize, isPseudo, normalize, Unifier } from './infer';
import { checkInherentItems } from './inherentItems';
import { compileError, ItemCollector, lowerType, Module, type Program, resolveImports, type TypeScope } from './items';
import { dynIteratorTarget, intoIterItem, intoIterShape } from './iterTypes';
import { checkElidedReturnLifetime, checkFieldLifetimes } from './lifetimeElision';
import { autoderefSteps, derefOnce } from './methods';
import { orderHint } from './orderingDiagnostics';
import { TraitSolver } from './traits';
import {
  type AdtDef,
  childTypes,
  type ClosureType,
  type ConstDef,
  defaultTraitArguments,
  type FloatName,
  type FnDef,
  freshDivergingVar,
  freshVar,
  hasParams,
  hasVars,
  type ImplDef,
  intMax,
  intMin,
  type IntName,
  isSigned,
  isUnit,
  mapChildren,
  NEVER,
  newTypeParam,
  type OpaqueType,
  resolve,
  resolveTraitRef,
  sameType,
  shallow,
  type Subst,
  substitute,
  substituteTraitRef,
  supertraitsOf,
  type TraitDef,
  type TraitRef,
  traitRefToString,
  type Type,
  type TypeParam,
  typeToString,
  UNIT,
} from './types';
import { checkParamsUsed } from './unusedParams';

export interface Obligation {
  type: Type;
  ref: TraitRef;
  span: Span;
}

export interface LoopContext {
  label: string | undefined;
  /** A labeled block, which only a labeled `break` leaves. */
  isBlock?: boolean;
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
  coverage: CoverageCheck[];
  /** The trait the body's impl implements or its trait declares, which is in scope in it as rustc puts it. */
  currentTrait?: TraitDef;
  /** How many `unsafe` blocks (or an `unsafe fn`'s body) the code being checked is in. */
  unsafeDepth: number;
  /** While checking the left side of an assignment, whose union field the assignment writes without reading it. */
  writingUnionField?: boolean;
  /** Whether the path being checked is the place of `&raw const` or `&raw mut`, which reads nothing. */
  rawBorrowing?: boolean;
}

interface CoverageCheck {
  run: () => void;
  constantPattern?: Pattern;
}

/** Checks the types of every function body, recording what the compiler needs in {@link Annotations}. */
/** The cells an `Rc`, `Arc` or `Box` of a trait object may hold it in. */
const CELLS = new Set(['RefCell', 'Mutex', 'RwLock']);

export class Checker {
  private readonly adtStorage: AdtStorage;
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
  readonly fnContexts = new Map<FnDef | ConstDef, FnContext>();
  /** For each instantiated type parameter of a call, the bounds that closures passed for it take their signature from. */
  readonly varBounds = new Map<unknown, TraitRef[]>();
  body!: BodyContext;
  deferredChecks: (() => void)[] = [];
  /** The `where` bounds of the function whose body is being checked, which its parameters carry meanwhile. */
  private readonly bodyBounds = new Set<TraitRef>();
  /** The argument being checked for an iterator parameter of a std function, which takes any `IntoIterator`. */
  iterableArgument: Expr | undefined;
  /** Closures whose capture analysis waits for a type, each with the analysis, which returns whether it is final. */
  unsettledClosures: { closure: ClosureType; analyze: () => boolean }[] = [];
  readonly fallbackChecks: (() => void)[] = [];
  readonly coverageChecks = new Map<FnDef | ConstDef, CoverageCheck[]>();
  /** The number literals of the body, which rustc's `overflowing_literals` lint checks against their types. */
  literals: Extract<Expr, { kind: 'int' | 'float' }>[] = [];
  /** The integer literals that `-` negates, whose range reaches one further below zero. */
  readonly negatedLiterals = new Set<Expr>();
  orBindings: Map<string, LocalVar> | undefined;
  /** Moves out of a reference by `&` patterns, which rustc's borrow checker reports in order with its other errors. */
  patternMoves: { span: Span; message: string }[] = [];

  /** The rows of the `// atomic` annotations that mark a function, which each of them must. */
  private readonly claimedAtomicRows = new Set<number>();

  constructor(
    readonly program: Program,
    readonly atomicRows: ReadonlySet<number>,
    readonly budget: ExecutionBudget
  ) {
    this.solver = new TraitSolver(program, this.unifier);
    this.adtStorage = new AdtStorage(budget);
  }

  checkProgram(): void {
    this.checkDeclaredTypes(0, 0, 0, 0, 0);
    this.checkDerivedTraits();
    this.checkImplCoherence();
    for (const impl of this.program.impls) this.checkImplSignatures(impl);
    const checkedConsts = this.checkConsts(0);
    for (const fn of this.program.pendingFns.splice(0)) this.checkFn(fn);
    while (this.nestedFns.length > 0) this.checkFn(this.nestedFns.shift()!);
    this.checkConsts(checkedConsts);
    this.checkMain();
    for (const row of this.atomicRows) {
      if (!this.claimedAtomicRows.has(row)) compileError({ row, col: 0 }, misplacedAtomicMessage);
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Checks each kind of declared item in its own type scope.
  private checkDeclaredTypes(
    firstAdt: number,
    firstFn: number,
    firstConst: number,
    firstImpl: number,
    firstTrait: number
  ): void {
    for (const trait of this.program.traits.slice(firstTrait)) {
      if (!trait.span || (trait.module as Module | undefined)?.isStd) continue;
      this.checkParamBounds([...trait.params, trait.self], trait.span);
    }
    for (const def of this.program.adts.slice(firstAdt)) {
      if ((def.module as Module | undefined)?.isStd) continue;
      this.checkAdtDeclaration(def);
    }
    for (const fn of this.program.fns.slice(firstFn)) {
      if ((fn.module as Module).isStd || !fn.ast) continue;
      this.checkFnDeclaration(fn, fn.ast);
    }
    for (const def of this.program.consts.slice(firstConst)) {
      if (!def.module.isStd) this.checkSizedWrittenType(def.type, def.ast.span);
    }
    for (const impl of this.program.impls.slice(firstImpl)) {
      if ((impl.module as Module).isStd) continue;
      this.checkParamBounds(impl.params, impl.span);
      this.checkWrittenType(impl.selfType, impl.span);
      for (const type of impl.trait?.args ?? []) this.checkWrittenType(type, impl.span);
    }
  }

  private checkAdtDeclaration(def: AdtDef): void {
    checkParamsUsed(def);
    this.adtStorage.check(def);
    this.checkParamBounds(def.params, def.span);
    for (const variant of def.variants) {
      for (const [index, field] of variant.fields.entries()) {
        checkFieldLifetimes(field.type, field.span, def.lifetimeParams ?? []);
        if (def.kind === 'enum' || index + 1 < variant.fields.length) {
          this.checkSizedWrittenType(field.type, field.span);
        } else this.checkWrittenType(field.type, field.span);
      }
    }
  }

  private checkFnDeclaration(fn: FnDef, ast: FnItem): void {
    this.checkParamBounds(fn.params, ast.span);
    for (const { param, bound } of fn.extraBounds ?? []) {
      this.checkTraitApplication({ kind: 'param', param }, bound, ast.span);
    }
    for (const [index, type] of fn.paramTypes.entries()) this.checkSizedWrittenType(type, ast.params[index].span);
    this.checkSizedWrittenType(fn.ret, ast.ret?.span ?? ast.span);
    checkElidedReturnLifetime(fn, ast);
  }

  private checkParamBounds(params: TypeParam[], span: Span): void {
    for (const param of params) {
      for (const bound of param.bounds) this.checkTraitApplication({ kind: 'param', param }, bound, span);
    }
  }

  private checkDerivedTraits(first = 0): void {
    for (const def of this.program.adts.slice(first)) {
      if ((def.module as Module | undefined)?.isStd) continue;
      for (const name of def.derives) this.checkDerivedTrait(def, name);
    }
  }

  /**
   * Rejects a second impl of a trait for the same type (E0119), and an impl of a standard library's trait for a type
   * the program does not declare (E0117, the orphan rule), and a type both Copy and Drop (E0184).
   */
  private checkImplCoherence(): void {
    checkInherentItems(this.program, (a, b) => this.implsOverlap(a, b));
    checkCopyDestructors(this.program);
    const impls = new Map<TraitDef, ImplDef[]>();
    for (const impl of this.program.impls) {
      const traitRef = impl.trait;
      if (!traitRef || (impl.module as Module).isStd) continue;
      const span = impl.span as Span;
      const previous = impls.get(traitRef.trait) ?? [];
      if (previous.some((other) => this.implsOverlap(impl, other)) || this.overlapsImplicitImpl(impl, traitRef.trait)) {
        compileError(
          span,
          `トレイト ${traitRef.trait.name} は、型 ${typeToString(impl.selfType)} に2回実装されています。`
        );
      }
      previous.push(impl);
      impls.set(traitRef.trait, previous);
      if ((traitRef.trait.module as Module).isStd && !validForeignImplHead([impl.selfType, ...traitRef.args])) {
        compileError(
          span,
          `標準ライブラリのトレイト ${traitRef.trait.name} は、自分で宣言した型にだけ実装できます（${typeToString(impl.selfType)} には実装できません）。`
        );
      }
    }
  }

  private overlapsImplicitImpl(impl: ImplDef, trait: TraitDef): boolean {
    const self = normalize(shallow(impl.selfType));
    if (self.kind === 'adt' && trait.builtin && self.def.derives.has(trait.builtin)) {
      const subst = this.derivedBounds(self.def, trait);
      const args = [...subst.values()];
      const derivedSelf: Type = { kind: 'adt', def: self.def, args };
      if (
        this.implsOverlap(impl, {
          selfType: derivedSelf,
          params: args.map((arg) => arg.param),
          trait: { trait, args: defaultTraitArguments(trait, [], derivedSelf) },
        })
      )
        return true;
    }
    if (trait.builtin !== 'From') return false;
    const param = newTypeParam('T');
    const source: Type = { kind: 'param', param };
    const targets = [source, this.program.builtinType('Option', [source]), this.program.builtinType('Box', [source])];
    return targets.some((selfType) =>
      this.implsOverlap(impl, {
        params: [param],
        selfType,
        trait: { trait, args: [source] },
      })
    );
  }

  private implsOverlap(a: ImplDef, b: Pick<ImplDef, 'params' | 'selfType' | 'trait'>): boolean {
    this.budget.spend();
    const aSubst: Subst = new Map(a.params.map((param) => [param, freshVar()]));
    const bSubst: Subst = new Map(b.params.map((param) => [param, freshVar()]));
    // Inherent impls have no trait, whose arguments would have to agree too.
    const aArgs = a.trait ? substituteTraitRef(a.trait, aSubst).args : [];
    const bArgs = b.trait ? substituteTraitRef(b.trait, bSubst).args : [];
    const snapshot = this.unifier.snapshot();
    try {
      return (
        this.unifier.unify(substitute(a.selfType, aSubst), substitute(b.selfType, bSubst)) &&
        aArgs.every((arg, index) => this.unifier.unify(arg, bArgs[index])) &&
        this.implBoundsCanHold(aSubst) &&
        this.implBoundsCanHold(bSubst)
      );
    } finally {
      this.unifier.rollback(snapshot);
    }
  }

  private implBoundsCanHold(subst: Subst): boolean {
    const sized = { trait: this.program.traitDef('Sized'), args: [] };
    for (const [param, type] of subst) {
      if (this.solver.implements(type, sized) === 'no') return false;
      if (param.bounds.some((bound) => this.solver.implements(type, substituteTraitRef(bound, subst)) === 'no'))
        return false;
    }
    return true;
  }

  /** Requires the methods of a trait impl to take `self`, their parameters, and return as the trait declares them. */
  // code-gauge-allow functionCognitiveComplexity -- Follows the type checking rules of rustc case by case.
  private checkImplSignatures(impl: ImplDef): void {
    const traitRef = impl.trait;
    if (!traitRef || (impl.module as Module).isStd) return;
    this.checkImplRequirements(impl, traitRef);
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
      this.checkImplMethodGenerics(fn, decl, subst, span);
      const expected = decl.paramTypes.map((type) => deepNormalize(substitute(type, subst)));
      for (const [index, param] of expected.entries()) {
        const written = deepNormalize(fn.paramTypes[index]);
        if (!sameType(param, written)) this.implSignatureMismatch(fn, trait, param, written, span);
      }
      const result = deepNormalize(substitute(decl.ret, subst));
      const written = deepNormalize(fn.ret);
      if (!this.compatibleImplResult(result, written)) this.implSignatureMismatch(fn, trait, result, written, span);
    }
  }

  private implSignatureMismatch(fn: FnDef, trait: TraitDef, expected: Type, written: Type, span: Span): never {
    return compileError(
      span,
      `メソッド ${fn.name} の型が、トレイト ${trait.name} の宣言と違います（${typeToString(expected)} が必要ですが、${typeToString(written)} です）。`
    );
  }

  private compatibleImplResult(declared: Type, actual: Type): boolean {
    const expected = shallow(declared);
    const written = shallow(actual);
    if (expected.kind === 'opaque') {
      return expected.opaque.bounds.every((bound) => this.solver.implements(written, bound) !== 'no');
    }
    if (!hasOpaque(expected)) return sameType(expected, written);
    if (
      !sameType(
        mapChildren(expected, () => UNIT),
        mapChildren(written, () => UNIT)
      )
    )
      return false;
    const children = childTypes(written);
    return childTypes(expected).every((child, index) => this.compatibleImplResult(child, children[index]));
  }

  private checkImplRequirements(impl: ImplDef, trait: TraitRef): void {
    const self = shallow(impl.selfType);
    this.checkTraitApplication(self, trait, impl.span);
    for (const bound of supertraitsOf(trait, self)) {
      if (this.solver.implements(self, bound) === 'no') {
        compileError(
          impl.span,
          `${typeToString(self)} の ${trait.trait.name} 実装には ${traitRefToString(bound)} が必要です。`
        );
      }
    }
    this.checkAssocTypeBounds(impl, trait, self);
    if (trait.trait.builtin !== 'Copy' || self.kind !== 'adt') return;
    const subst = new Map(self.def.params.map((param, index) => [param, self.args[index]]));
    for (const field of self.def.variants.flatMap((variant) => variant.fields)) {
      const type = substitute(field.type, subst);
      if (this.solver.implements(type, trait) === 'no') {
        compileError(impl.span, `フィールド ${field.name} の型 ${typeToString(type)} は Copy ではありません。`);
      }
    }
  }

  /** The types an impl gives the trait's associated types meet the bounds the trait declares for them (E0277). */
  private checkAssocTypeBounds(impl: ImplDef, trait: TraitRef, self: Type): void {
    const subst: Subst = new Map([
      ...trait.trait.params.map((param, index): [TypeParam, Type] => [param, trait.args[index]]),
      [trait.trait.self, self],
    ]);
    for (const [name, assoc] of trait.trait.assocTypes) {
      const type = impl.assocTypes.get(name);
      if (!type || assoc.params.length > 0) continue;
      for (const bound of assoc.bounds) {
        const required = substituteTraitRef(bound, subst);
        if (this.solver.implements(type, required) === 'no') {
          compileError(
            impl.span,
            `関連型 ${name} の ${typeToString(type)} に ${traitRefToString(required)} が実装されていません（E0277）。`
          );
        }
      }
    }
  }

  private checkImplMethodGenerics(fn: FnDef, decl: FnDef, subst: Subst, span: Span): void {
    const actual = fn.params.slice(fn.parentParamCount);
    const expected = decl.params.slice(decl.parentParamCount);
    if (actual.length !== expected.length || fn.ast?.generics.params.length !== decl.ast?.generics.params.length) {
      compileError(span, `メソッド ${fn.name} の型引数の数が、トレイトの宣言と違います。`);
    }
    for (const [index, param] of actual.entries()) {
      const bounds = expected[index].bounds.map((bound) => substituteTraitRef(bound, subst));
      this.checkImplMethodBounds(fn, param, bounds, param.bounds, span);
    }
    for (const { param, bound } of fn.extraBounds ?? []) {
      const bounds = [
        ...param.bounds,
        ...(decl.extraBounds ?? [])
          .filter((item) => sameType(substitute({ kind: 'param', param: item.param }, subst), { kind: 'param', param }))
          .map((item) => substituteTraitRef(item.bound, subst)),
      ];
      this.checkImplMethodBounds(fn, param, bounds, [bound], span);
    }
  }

  private checkImplMethodBounds(
    fn: FnDef,
    param: TypeParam,
    allowed: TraitRef[],
    written: TraitRef[],
    span: Span
  ): void {
    const type: Type = { kind: 'param', param };
    for (const bound of written) {
      if (bound.trait.builtin === 'Sized' || this.solver.boundsImply(allowed, bound, type)) continue;
      compileError(
        span,
        `メソッド ${fn.name} の型引数 ${param.name} には、トレイトの宣言より厳しい制約を付けられません。`
      );
    }
  }

  private checkDerivedTrait(def: AdtDef, name: string): void {
    const trait = this.program.builtinTraits.get(name);
    if (!trait) return;
    const subst = this.derivedBounds(def, trait);
    if (trait.supertraits.length > 0) this.checkDerivedSupertraits(def, trait, subst);
    for (const field of def.variants.flatMap((variant) => variant.fields)) {
      if (this.solver.implements(substitute(field.type, subst), { trait, args: [] }) !== 'no') continue;
      compileError(
        name === 'Copy' ? def.span : field.span,
        `${typeToString(field.type)} が ${name} を実装していないので、フィールド ${field.name} を持つ ${def.name} に #[derive(${name})] を付けられません。`
      );
    }
  }

  private derivedBounds(def: AdtDef, trait: TraitDef): Map<TypeParam, Type & { kind: 'param' }> {
    const subst = new Map<TypeParam, Type & { kind: 'param' }>();
    const args = def.params.map((original) => {
      const param = newTypeParam(original.name);
      const type = { kind: 'param', param } as const;
      subst.set(original, type);
      return type;
    });
    for (const [index, arg] of args.entries()) {
      arg.param.bounds.push(...def.params[index].bounds.map((bound) => substituteTraitRef(bound, subst)), {
        trait,
        args: defaultTraitArguments(trait, [], arg),
      });
    }
    return subst;
  }

  private checkDerivedSupertraits(def: AdtDef, trait: TraitDef, subst: Subst): void {
    const args = def.params.map((param) => subst.get(param)!);
    const self: Type = { kind: 'adt', def, args };
    const derived = { trait, args: defaultTraitArguments(trait, [], self) };
    for (const bound of supertraitsOf(derived, self)) {
      if (this.solver.implements(self, bound) === 'no') {
        compileError(def.span, `#[derive(${trait.name})] には、${bound.trait.name} の実装が必要です。`);
      }
    }
  }

  private checkConsts(first: number): number {
    for (let index = first; index < this.program.consts.length; index++) {
      const def = this.program.consts[index];
      const { ast, module, impl } = def;
      if (!ast.value) continue;
      this.body = this.newBody({
        name: def.name,
        module,
        retType: def.type,
        isAtomic: true,
        typeParams: new Map((impl?.params ?? def.trait?.params ?? []).map((param) => [param.name, param])),
        selfType: def.trait ? { kind: 'param', param: def.trait.self } : impl?.selfType,
        currentTrait: def.trait ?? impl?.trait?.trait,
      });
      this.fnContexts.set(def, this.body.fn);
      this.coverageChecks.set(def, this.body.coverage);
      this.coerceExpr(ast.value, def.type);
      this.finishBody(ast.span);
      checkConstOperations(ast.value, this.annotations);
      new BorrowChecker(this.annotations, this.solver, this.budget, true).checkConst(ast.value, this.body.fn);
      // rustc evaluates constants before running, so one whose value overflows or divides by zero is an error.
      new ConstLint(this.annotations).checkExpr(ast.value);
    }
    return this.program.consts.length;
  }

  private checkMain(): void {
    const main = this.program.root.values.get('main');
    if (main?.binding.kind !== 'fn') {
      compileError({ row: 0, col: 1 }, 'main 関数がありません（fn main() { ... } を書いてください）。');
    }
    const { ret, ast } = main.binding.def;
    if (!this.isTerminationType(ret)) {
      compileError(ast!.span, `main 関数の戻り値の型 ${typeToString(ret)} は Termination を実装していません。`);
    }
  }

  private isTerminationType(type: Type): boolean {
    const t = normalize(shallow(type));
    if (isUnit(t) || t.kind === 'never') return true;
    if (t.kind !== 'adt') return false;
    if (t.def.builtin === 'Infallible') return true;
    if (t.def.builtin !== 'Result') return false;
    const [success, error] = t.args;
    const debug = this.program.traitDef('Debug');
    return this.isTerminationType(success) && this.solver.implements(error, { trait: debug, args: [] }) === 'yes';
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
      coverage: [],
      currentTrait: options.currentTrait,
      unsafeDepth: 0,
    };
  }

  private isAtomic(item: FnItem): boolean {
    const claimed = this.claimedAtomicRows.size;
    for (let row = item.span.row; row <= item.headerEndRow; row++) {
      if (this.atomicRows.has(row)) this.claimedAtomicRows.add(row);
    }
    return this.claimedAtomicRows.size > claimed;
  }

  checkFn(def: FnDef): void {
    const item = def.ast;
    if (!item?.body) return;
    const bounds = def.extraBounds ?? [];
    for (const { param, bound } of bounds) {
      param.bounds.push(bound);
      this.bodyBounds.add(bound);
    }
    try {
      this.checkFnBody(def, item, item.body);
    } finally {
      for (const { param, bound } of bounds) {
        param.bounds.pop();
        this.bodyBounds.delete(bound);
      }
    }
  }

  // code-gauge-allow functionNcss -- Sets up each part of a function body check in the order rustc does.
  private checkFnBody(def: FnDef, item: FnItem, body: Block): void {
    const module = def.module as Module;
    const typeParams = new Map(def.params.map((param) => [param.name, param]));
    const selfType: Type | undefined = def.trait ? { kind: 'param', param: def.trait.self } : def.impl?.selfType;
    const resultTypes: [OpaqueType, Type][] = [];
    const returnType = hasOpaque(def.ret) ? openOpaqueResults(def.ret, resultTypes) : def.ret;
    // The body sees what an `impl Trait` result is bound by, as a closure returned for `impl Fn(..)` takes its signature.
    for (const [opaque, hidden] of resultTypes) this.recordTypeBounds(hidden, opaque.bounds);
    this.body = this.newBody({
      name: def.name,
      module,
      retType: returnType,
      isAtomic: this.isAtomic(item),
      typeParams,
      selfType,
      currentTrait: def.trait ?? def.impl?.trait?.trait,
    });
    this.fnContexts.set(def, this.body.fn);
    this.coverageChecks.set(def, this.body.coverage);
    // In edition 2024 an `unsafe fn`'s body may still do unsafe operations, with a warning.
    if (item.isUnsafe) this.body.unsafeDepth = 1;
    if (item.selfParam && selfType) {
      const mode = item.selfParam.mode;
      const value = wrapSelf(this.program, item.selfParam.wrapper, selfType);
      const type: Type =
        mode === 'value'
          ? value
          : { kind: 'ref', mutable: mode === 'mutRef', target: selfType, lifetime: item.selfParam.lifetime };
      const local = this.declareLocal('self', type, item.selfParam.mutable, item.selfParam.span);
      local.isSelf = true;
    }
    checkParamPatterns(
      this,
      item.params.map((param) => param.pattern),
      def.paramTypes
    );
    const bodyType = this.checkBlock(body, this.body.retType);
    if (body.tail) {
      this.coerceReturned(body.tail, bodyType, this.body.retType);
      this.markReborrows(body.tail, def.ret);
    }
    this.coerceTail(body, bodyType, this.body.retType, item);
    for (const [opaque, type] of resultTypes) {
      opaque.hidden = type;
      for (const bound of opaque.bounds) {
        this.obligations.push({ type, ref: bound, span: item.span });
      }
    }
    this.finishBody(item.span);
    this.requireKnownTypes();
    // A `const fn` may run while the program compiles, so its body may do only what constants may.
    if (item.isConst) checkConstOperations(body, this.annotations);
    this.checkBorrows(() =>
      new BorrowChecker(this.annotations, this.solver, this.budget).checkFn(
        item,
        this.body.fn,
        this.body.retType,
        def.impl?.lifetimeBounds
      )
    );
    new ConstLint(this.annotations).check(body);
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
        this.requireTrait(type, 'Sized', local.span);
      }
    }
  }

  /** Solves the remaining obligations, applies the default types of literals, and requires every type to be known. */
  private finishBody(span: Span): void {
    this.solveObligations(false);
    for (const check of this.deferredChecks.splice(0)) check();
    this.solveObligations(true);
    for (const check of this.fallbackChecks.splice(0)) check();
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

  private solveObligations(final: boolean): void {
    this.settleTryErrors(final);
    let progress = true;
    while (progress) {
      progress = this.settleInferred();
      const pending = this.obligations;
      this.obligations = [];
      for (const obligation of pending) {
        const answer = this.solver.implements(obligation.type, obligation.ref);
        if (answer === 'no') this.unsatisfied(obligation);
        if (answer === 'unknown') this.obligations.push(obligation);
        else progress = true;
      }
    }
    if (final) this.solveRemainingObligations();
  }

  private solveRemainingObligations(): void {
    settleBinaries(this, true);
    // Literal variables take their defaults, which may settle what remains.
    for (const { type, ref: trait } of this.obligations) {
      resolve(type, true);
      resolveTraitRef(trait, true);
    }
    settleClosures(this, true);
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

  /** Settles what waited for a type that inference has supplied since, and returns whether anything was settled. */
  private settleInferred(): boolean {
    const settledClosures = settleClosures(this, false);
    return settleBinaries(this, false) || settledClosures;
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
      const remedy =
        obligation.ref.trait.name === 'Fn'
          ? '境界を FnMut に変えるか、変数を書き換えないクロージャにしてください。'
          : '共有参照にせず、そのまま渡してください。';
      compileError(closure.closure.span, `このクロージャは取り込んだ変数を書き換えるので FnMut です。${remedy}`);
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
      Ord: `${type} は Ord ではありません。${orderHint(obligation.type, this.solver)}`,
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

  typeScope(): TypeScope {
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

  coerceAtReferenceSite(expr: Expr, target: Type): void {
    const written = normalize(shallow(target));
    this.coerceExpr(expr, target);
    if (written.kind === 'ref') this.markReborrows(expr, written);
  }

  markReborrows(expr: Expr, target: Type): void {
    const type = normalize(shallow(target));
    if (type.kind !== 'ref') return;
    forEachResult(expr, (result) => {
      if (normalize(shallow(result.ty ?? UNIT)).kind === 'ref') this.annotations.reborrows.set(result, type.mutable);
    });
  }

  /**
   * Records a coercion of an expression's value. A block's value is its tail's, and an `if`'s or a `match`'s are its
   * branches', which rustc coerces each where it ends.
   */
  private setCoercion(expr: Expr, coercion: Coercion): void {
    forEachResult(expr, (result) => {
      if (shallow(result.ty ?? UNIT).kind === 'never') return;
      this.coercionLog?.push([result, this.annotations.coercions.get(result)]);
      this.annotations.coercions.set(result, coercion);
    });
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
  // code-gauge-allow functionCognitiveComplexity -- Prior expressions can coerce toward a later common type.
  mergeTypes(
    values: [Expr, Type | ((expected: Type | undefined) => Type)][],
    mismatch: (expr: Expr, merged: Type, type: Type) => never
  ): Type | undefined {
    let merged: Type | undefined;
    const previous: [Expr, Type][] = [];
    for (const [expr, candidate] of values) {
      const type = typeof candidate === 'function' ? candidate(merged) : candidate;
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
      const previousType = shallow(merged);
      const currentType = shallow(type);
      if (previousType.kind === 'fn' && currentType.kind === 'fn' && previousType.item !== currentType.item) {
        merged = { ...previousType, item: undefined };
      }
      previous.push([expr, type]);
    }
    return merged;
  }

  coerce(expr: Expr, actual: Type, target: Type): void {
    const a = normalize(shallow(actual));
    const t = normalize(shallow(target));
    if (a.kind === 'never') return;
    if (this.unifier.tryUnify(a, t)) return;
    if (a.kind === 'ref' && t.kind === 'ref' && (!t.mutable || a.mutable) && this.coerceRef(expr, a, t)) return;
    if (this.coerceBox(expr, a, t)) return;
    if (expr === this.iterableArgument && t.kind === 'adt' && t.def.builtin === 'Iter') {
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
    if (this.coercePointer(expr, a, t)) return;
    if (t.kind === 'fn' && this.coerceToFnPointer(a, t)) return;
    this.mismatch(expr.span, target, actual);
  }

  /** A safe function pointer to an `unsafe` one, and a closure that captures nothing to a function pointer. */
  private coerceToFnPointer(a: Type, t: Type & { kind: 'fn' }): boolean {
    if (a.kind === 'fn') return t.isUnsafe === true && this.unifier.tryUnify({ ...a, isUnsafe: true }, t);
    return (
      a.kind === 'closure' &&
      (a.closure.captures ?? []).length === 0 &&
      this.unifier.tryUnify({ kind: 'tuple', elems: a.closure.params }, { kind: 'tuple', elems: t.params }) &&
      this.unifier.tryUnify(a.closure.ret, t.ret)
    );
  }

  /** `Box<[T; N]>` → `Box<[T]>` and `Box<T>` → `Box<dyn Trait>`, also inside a `Pin`; false when none applies. */
  private coerceBox(expr: Expr, a: Type, t: Type): boolean {
    if (a.kind !== 'adt' || t.kind !== 'adt' || a.def.builtin !== t.def.builtin) return false;
    if (a.def.builtin === 'Pin') {
      this.coerce(expr, a.args[0], t.args[0]);
      return true;
    }
    const shared = a.def.builtin === 'Rc' || a.def.builtin === 'Arc';
    if (a.def.builtin !== 'Box' && !shared) return false;
    let target = shallow(t.args[0]);
    let array = normalize(shallow(a.args[0]));
    if (!shared && target.kind === 'slice' && array.kind === 'array' && this.unifier.tryUnify(array.elem, target.elem))
      return true;
    // A `RefCell` or `Mutex` in between unsizes too (`Rc<RefCell<dyn Trait>>`).
    const cell =
      target.kind === 'adt' && array.kind === 'adt' && target.def === array.def && CELLS.has(target.def.builtin ?? '');
    if (cell) {
      target = shallow((target as Type & { kind: 'adt' }).args[0]);
      array = normalize(shallow((array as Type & { kind: 'adt' }).args[0]));
    }
    if (target.kind !== 'dyn') return false;
    this.requireDyn(array, target, expr.span);
    if (array.kind !== 'dyn') {
      this.setCoercion(expr, {
        kind: 'dyn',
        type: array,
        mutable: false,
        trait: target.trait,
        shared,
        throughCell: cell,
      });
    }
    return true;
  }

  /** `&T` → `*const T`, `&mut T` → `*mut T`, and `*mut T` → `*const T`; false when none applies. */
  private coercePointer(expr: Expr, a: Type, t: Type): boolean {
    if (t.kind !== 'adt' || (t.def.builtin !== 'ConstPtr' && t.def.builtin !== 'MutPtr')) return false;
    if (a.kind === 'ref' && (t.def.builtin === 'ConstPtr' || a.mutable) && this.unifier.tryUnify(a.target, t.args[0])) {
      this.setCoercion(expr, { kind: 'rawPtr' });
      return true;
    }
    // `&[T; N]` → `*const [T]`, unsizing as a reference does.
    const array = a.kind === 'ref' ? normalize(shallow(a.target)) : undefined;
    const slice = normalize(shallow(t.args[0]));
    if (
      a.kind === 'ref' &&
      (t.def.builtin === 'ConstPtr' || a.mutable) &&
      array?.kind === 'array' &&
      slice.kind === 'slice' &&
      this.unifier.tryUnify(array.elem, slice.elem)
    ) {
      this.setCoercion(expr, { kind: 'rawPtr' });
      return true;
    }
    const mutToConst = a.kind === 'adt' && a.def.builtin === 'MutPtr' && t.def.builtin === 'ConstPtr';
    return mutToConst && this.unifier.tryUnify(a.args[0], t.args[0]);
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
          toStr: target.kind === 'str',
        });
      }
      return true;
    }
    if (target.kind !== 'dyn') return false;
    this.requireDyn(a.target, target, expr.span);
    if (shallow(a.target).kind !== 'dyn') {
      this.setCoercion(expr, { kind: 'dyn', type: a.target, mutable: t.mutable, trait: target.trait });
    } else if (a.mutable && !t.mutable) {
      this.setCoercion(expr, { kind: 'deref', derefs: [], fromMut: true, toStr: false });
    }
    return true;
  }

  private checkSizedWrittenType(type: Type, span: Span): void {
    this.checkWrittenType(type, span);
    this.requireTrait(type, 'Sized', span);
  }

  private checkTraitApplication(self: Type, ref: TraitRef, span: Span): void {
    const { trait, args } = ref;
    const parameters = new Map<TypeParam, Type>([[trait.self, self]]);
    for (const [index, param] of trait.params.entries()) parameters.set(param, args[index]);
    const implicitSized = !(trait.module as Module | undefined)?.isStd && !!trait.span;
    for (const [index, param] of trait.params.entries()) {
      const arg = args[index];
      this.checkWrittenType(arg, span);
      if (implicitSized && !param.maybeUnsized) this.requireTrait(arg, 'Sized', span);
      for (const bound of param.bounds) this.require(arg, substituteTraitRef(bound, parameters), span);
    }
  }

  /**
   * Rejects what rustc rejects in a written type: a trait object of a trait that methods returning `Self` or taking
   * type parameters make not dyn compatible (E0038), and an unsized type (`dyn T`, `str`) as a type argument (E0277).
   */
  private checkWrittenType(type: Type, span: Span): void {
    const t = shallow(type);
    if (t.kind === 'dyn') {
      checkDynCompatible(t.trait.trait, span);
      if (dynIteratorTarget(t) && !intoIterItem(t)) compileError(span, 'dyn Iterator には Item の型を書いてください。');
    }
    if (t.kind === 'opaque') {
      for (const bound of t.opaque.bounds) this.checkTraitApplication(t, bound, span);
    }
    if (t.kind === 'array' || t.kind === 'slice') this.requireTrait(t.elem, 'Sized', span);
    if (t.kind === 'adt') this.checkAdtWrittenType(t, span);
    for (const child of childTypes(t)) if (child.kind !== 'closure') this.checkWrittenType(child, span);
  }

  private checkAdtWrittenType(t: Extract<Type, { kind: 'adt' }>, span: Span): void {
    for (const [arg, bound] of adtArgumentBounds(t.def, t.args)) {
      if (this.solver.implements(arg, bound) === 'no') {
        compileError(span, `${typeToString(arg)} にトレイト ${bound.trait.name} が実装されていません。`);
      }
    }
    const unsizedArgs = [
      'Box',
      'Rc',
      'Arc',
      'Weak',
      'Mutex',
      'RwLock',
      'RefCell',
      'Ref',
      'RefMut',
      'Cell',
      'ConstPtr',
      'MutPtr',
    ];
    if (!unsizedArgs.includes(t.def.builtin ?? '')) {
      for (const [index, arg] of t.args.entries()) {
        if (t.def.params[index]?.maybeUnsized) continue;
        const a = shallow(arg);
        if (a.kind === 'dyn' || a.kind === 'str' || a.kind === 'slice') {
          compileError(
            span,
            `${typeToString(a)} は大きさが決まらないので、${t.def.name} の型引数にできません（Box<…> に入れてください）。`
          );
        }
      }
    }
  }

  private requireDyn(type: Type, target: Extract<Type, { kind: 'dyn' }>, span: Span): void {
    requireSizedSource(this, type, span);
    for (const trait of target.autoTraits ?? []) this.require(type, { trait, args: [] }, span);
    this.require(type, target.trait, span);
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
    const firstAdt = this.program.adts.length;
    const firstFn = this.program.fns.length;
    const firstConst = this.program.consts.length;
    const firstImpl = this.program.impls.length;
    const firstTrait = this.program.traits.length;
    collector.collectItems(block.items, module);
    collector.finish();
    resolveImports(module);
    this.checkDeclaredTypes(firstAdt, firstFn, firstConst, firstImpl, firstTrait);
    this.checkDerivedTraits(firstAdt);
    if (this.program.impls.length > firstImpl) this.checkImplCoherence();
    for (const impl of this.program.impls.slice(firstImpl)) this.checkImplSignatures(impl);
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
        return neverCompletes(stmt.expr);
      }
      case 'empty': {
        return false;
      }
    }
  }

  private deferredUnitStatement(_expr: Expr, _type: Type): void {
    // A statement's value is dropped, so its type may stay unknown only if nothing else needs it.
  }

  // code-gauge-allow functionCognitiveComplexity -- Keeps initializer, let-else and binding checks in declaration order.
  private checkLet(stmt: Extract<Stmt, { kind: 'let' }>): boolean {
    const declared = stmt.type ? this.lowerType(stmt.type) : undefined;
    let type = declared ?? freshVar();
    let diverges = false;
    if (stmt.init) {
      if (declared) this.coerceAtReferenceSite(stmt.init, declared);
      else type = this.expr(stmt.init, undefined);
      // An initializer that never finishes makes what follows unreachable, whatever type the binding declares.
      diverges = neverCompletes(stmt.init);
      if (diverges && !declared) type = freshDivergingVar();
    }
    if (stmt.else) {
      if (!stmt.init) compileError(stmt.span, 'let ... else には、初期値が要ります。');
      const elseType = this.checkBlock(stmt.else, undefined);
      if (shallow(elseType).kind !== 'never') {
        compileError(stmt.else.span, 'let ... else の else のブロックは、return や break などで抜けてください。');
      }
    }
    checkPattern(this, stmt.pattern, type, 'move');
    if (stmt.init) requireRefMutSource(this, stmt.pattern, stmt.init);
    if (stmt.init && this.annotations.paths.get(stmt.init)?.kind === 'fn') {
      this.annotations.functionInitializers.set(stmt.init, this.annotations.bindings.get(stmt.pattern));
    }
    if (!stmt.else) this.requireIrrefutable(stmt.pattern, type, 'let');
    return diverges;
  }

  /** Requires the code to be in an `unsafe` block for an operation that may break memory safety (E0133). */
  requireUnsafe(span: Span, what: string): void {
    if (this.body.unsafeDepth === 0) {
      compileError(span, `${what}は、unsafe ブロックの中でだけできます（E0133）。`);
    }
  }

  requireIrrefutable(pattern: Pattern, type: Type, where: 'let' | 'fn' | 'for'): void {
    if (pattern.kind === 'binding' && !this.annotations.paths.has(pattern)) return;
    if (pattern.kind === 'wild') return;
    this.deferCoverage(() => {
      const lowered = lowerPattern(pattern, this.annotations);
      if (!isIrrefutable(lowered, resolve(type, true), this.budget)) {
        const name = where === 'let' ? 'let' : where === 'for' ? 'for' : '関数の引数';
        compileError(
          pattern.span,
          `${name} のパターンは、すべての値に合うものにしてください（合わない値があるなら if let か match を使います）。`
        );
      }
    });
  }

  deferCoverage(run: () => void, constantPattern?: Pattern): void {
    this.body.coverage.push({ run, constantPattern });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Expressions

  /** Checks an expression, whose type `expected` may guide (the type of a literal, a closure's parameters). */
  expr(expr: Expr, expected: Type | undefined): Type {
    this.budget.spend();
    const type = exprInner(this, expr, expected);
    expr.ty = type;
    return type;
  }

  /** The signature of a function with its type parameters bound, recording each parameter's bounds as obligations. */
  instantiate(fn: FnDef, typeArgs: Type[], span?: Span): { params: Type[]; ret: Type; subst: Subst } {
    const subst: Subst = new Map(fn.params.map((param, index) => [param, typeArgs[index] ?? freshVar()]));
    for (const param of fn.params) {
      const arg = subst.get(param) as Type;
      // A bound of the method being checked holds of its own parameter there, not of each use of the parameter.
      const declared = param.bounds.filter((bound) => !this.bodyBounds.has(bound));
      const bounds = declared.map((bound) => substituteTraitRef(bound, subst));
      this.recordTypeBounds(arg, bounds);
      if (span) {
        for (const bound of bounds) {
          this.obligations.push({ type: arg, ref: bound, span });
        }
        if (!(fn.module as Module).isStd && !param.isSelf && !param.maybeUnsized) this.requireTrait(arg, 'Sized', span);
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

  requireAdtArguments(def: AdtDef, args: Type[], span: Span): void {
    if (!(def.module as Module | undefined)?.isStd) {
      for (const [index, arg] of args.entries())
        if (!def.params[index]?.maybeUnsized) this.requireTrait(arg, 'Sized', span);
    }
    for (const [arg, bound] of adtArgumentBounds(def, args)) {
      this.recordTypeBounds(arg, [bound]);
      this.require(arg, bound, span);
    }
  }

  private recordTypeBounds(type: Type, bounds: TraitRef[]): void {
    const t = shallow(type);
    if (t.kind !== 'var' || bounds.length === 0) return;
    const current = this.varBounds.get(t.v) ?? [];
    this.varBounds.set(t.v, [...current, ...bounds]);
  }
}

export { hasParams, deepNormalize, derefOnce };

function* adtArgumentBounds(def: AdtDef, args: Type[]): Iterable<[Type, TraitRef]> {
  const subst = new Map(def.params.map((param, index) => [param, args[index]]));
  for (const [index, param] of def.params.entries()) {
    for (const bound of param.bounds) yield [args[index], substituteTraitRef(bound, subst)];
  }
}

function checkFloatLiteral(literal: Extract<Expr, { kind: 'float' }>, name: FloatName): void {
  const value = name === 'f32' ? literal.f32 : literal.value;
  if (!Number.isFinite(value)) compileError(literal.span, `小数のリテラルが ${name} の範囲を超えています。`);
}

function checkIntLiteral(literal: Extract<Expr, { kind: 'int' }>, name: IntName, negated: boolean): void {
  const limit = negated && isSigned(name) ? -intMin(name) : intMax(name);
  // A pattern's literal holds its sign, so its value may be below the type's minimum.
  if (literal.value <= limit && literal.value >= intMin(name)) return;
  compileError(
    literal.span,
    `リテラル ${negated ? '-' : ''}${literal.value} は ${name} の範囲（${intMin(name)}〜${intMax(name)}）を超えています。`
  );
}

function openOpaqueResults(type: Type, results: [OpaqueType, Type][]): Type {
  const t = shallow(type);
  if (t.kind !== 'opaque') return mapChildren(t, (child) => openOpaqueResults(child, results));
  const hidden = freshVar();
  results.push([t.opaque, hidden]);
  return hidden;
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

/** A foreign-trait head needs a local type before its first uncovered parameter. */
function validForeignImplHead(types: Type[]): boolean {
  for (const type of types) {
    const root = fundamentalTarget(type);
    if (root.kind === 'param') return false;
    if (root.kind === 'adt' && !(root.def.module as Module | undefined)?.isStd) return true;
    if (root.kind === 'dyn' && !(root.trait.trait.module as Module).isStd) return true;
  }
  return false;
}

function fundamentalTarget(type: Type): Type {
  const t = normalize(shallow(type));
  if (t.kind === 'ref') return fundamentalTarget(t.target);
  if (t.kind === 'adt' && t.def.builtin === 'Box') return fundamentalTarget(t.args[0]);
  return t;
}

const NON_DYN_BUILTIN_TRAITS = new Set(['Into', 'TryInto', 'Hash', 'FromIterator', 'Extend', 'Sum', 'Product']);

// code-gauge-allow functionCognitiveComplexity -- Object safety depends on the trait hierarchy and every dispatchable method.
function checkDynCompatible(trait: TraitDef, span: Span, checked = new Set<TraitDef>()): void {
  if (checked.has(trait)) return;
  checked.add(trait);
  if (trait.builtin === 'Sized') compileError(span, 'Sized を必要とするトレイトは、dyn にできません。');
  if (trait.builtin && NON_DYN_BUILTIN_TRAITS.has(trait.builtin)) {
    compileError(span, `トレイト ${trait.name} は dyn ${trait.name} にできません。`);
  }
  for (const bound of trait.supertraits) {
    if (bound.args.some((arg) => mentionsParam(arg, trait.self))) {
      compileError(span, `トレイト ${trait.name} は、上位トレイトの型引数に Self を使うので dyn にできません。`);
    }
    checkDynCompatible(bound.trait, span, checked);
  }
  for (const fn of trait.methods.values()) {
    if (fn.extraBounds?.some(({ param, bound }) => param === trait.self && bound.trait.builtin === 'Sized')) continue;
    const returnsSelf = mentionsParam(fn.ret, trait.self);
    const takesSelf = fn.paramTypes.some((param) => mentionsParam(param, trait.self));
    const generic = fn.params.length > fn.parentParamCount;
    if (returnsSelf || takesSelf || generic || !fn.selfMode) {
      compileError(
        span,
        `トレイト ${trait.name} はメソッド ${fn.name} が${returnsSelf || takesSelf ? ' Self を使う' : generic ? '型引数を取る' : ' self を取らない'}ので、dyn ${trait.name} にできません。`
      );
    }
  }
}

function mentionsParam(type: Type, param: TypeParam): boolean {
  const t = shallow(type);
  if (t.kind === 'param') return t.param === param;
  // `Self::Item` is the associated type a `dyn Trait<Item = T>` names, which methods may use.
  if (t.kind === 'adt' && t.def.projection) return t.args.slice(1).some((arg) => mentionsParam(arg, param));
  return childTypes(t).some((child) => mentionsParam(child, param));
}
