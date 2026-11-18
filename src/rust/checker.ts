import { Annotations, type FnContext, type LocalVar, type PathRes, type ReceiverAdjust } from './annotations';
import type {
  Block,
  Condition,
  Expr,
  FnItem,
  FormatArgs,
  MacroCall,
  PathAst,
  Pattern,
  Span,
  Stmt,
  TypeAst,
} from './ast';
import { isIrrefutable, lowerPattern, missingPattern } from './exhaustiveness';
import { deepNormalize, normalize, Unifier } from './infer';
import {
  compileError,
  ItemCollector,
  lookupType,
  lookupValue,
  lowerType,
  Module,
  type Program,
  resolveTypePath,
  type TypeBinding,
  type TypeScope,
  type ValueBinding,
} from './items';
import { allSupertraits, autoderefSteps, boundsOf, derefOnce, lookupAssociated, lookupMethod } from './methods';
import { closureKindAtLeast, RANGE_TYPES, TraitSolver } from './traits';
import {
  adt,
  type AdtDef,
  BOOL,
  CHAR,
  F32,
  F64,
  type FnDef,
  freshVar,
  hasParams,
  hasVars,
  intType,
  isUnit,
  NEVER,
  newClosureType,
  ref,
  REF_STR,
  resolve,
  shallow,
  STR,
  type Subst,
  substitute,
  substituteTraitRef,
  type TraitRef,
  traitRefToString,
  type Type,
  type TypeParam,
  typeToString,
  UNIT,
  USIZE,
} from './types';

interface Obligation {
  type: Type;
  ref: TraitRef;
  span: Span;
}

interface LoopContext {
  label: string | undefined;
  /** The type `break` values give a `loop`, or undefined for `while` and `for`, whose breaks carry no value. */
  breakType: Type | undefined;
  context: FnContext;
}

interface BodyContext {
  fn: FnContext;
  retType: Type;
  loops: LoopContext[];
  scopes: Map<string, LocalVar>[];
  /** Whether the body is a closure's, whose `return` returns from the closure. */
  isClosure: boolean;
  module: Module;
  typeParams: Map<string, TypeParam>;
  selfType: Type | undefined;
}

let nextLocalId = 0;

/** Checks the types of every function body, recording what the compiler needs in {@link Annotations}. */
export class Checker {
  readonly annotations = new Annotations();
  readonly unifier = new Unifier();
  readonly solver: TraitSolver;
  private obligations: Obligation[] = [];
  /** Bodies of functions declared in blocks, checked after the function around them. */
  private readonly nestedFns: FnDef[] = [];
  /** The context of each checked function, which the compiler reads. */
  readonly fnContexts = new Map<FnDef, FnContext>();
  /** For each instantiated type parameter of a call, the bounds that closures passed for it take their signature from. */
  private readonly varBounds = new Map<unknown, TraitRef[]>();
  private body!: BodyContext;
  private deferredChecks: (() => void)[] = [];

  constructor(
    readonly program: Program,
    readonly atomicRows: ReadonlySet<number>
  ) {
    this.solver = new TraitSolver(program, this.unifier);
  }

  checkProgram(): void {
    for (const fn of this.program.pendingFns.splice(0)) this.checkFn(fn);
    while (this.nestedFns.length > 0) this.checkFn(this.nestedFns.shift()!);
    this.checkConstsAndMain();
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
    });
    this.fnContexts.set(def, this.body.fn);
    if (item.selfParam && selfType) {
      const mode = item.selfParam.mode;
      const type = mode === 'value' ? selfType : ref(selfType, mode === 'mutRef');
      const local = this.declareLocal('self', type, item.selfParam.mutable, item.selfParam.span);
      local.isSelf = true;
    }
    for (const [index, param] of item.params.entries()) {
      this.checkPattern(param.pattern, def.paramTypes[index], 'move');
      this.requireIrrefutable(param.pattern, def.paramTypes[index], 'fn');
    }
    const bodyType = this.checkBlock(item.body, this.body.retType);
    this.coerceTail(item.body, bodyType, this.body.retType, item);
    if (def.ret.kind === 'opaque') {
      def.ret.opaque.hidden = this.body.retType;
      for (const bound of def.ret.opaque.bounds) {
        this.obligations.push({ type: this.body.retType, ref: bound, span: item.span });
      }
    }
    this.finishBody(item.span);
    (this.body.fn as FnContext & { mainBlock?: Block }).mainBlock = item.body;
  }

  /** Checks a block's value against the function's result, reporting the mismatch at the block's last line. */
  private coerceTail(block: Block, actual: Type, expected: Type, item: FnItem): void {
    if (block.tail) return;
    const t = shallow(actual);
    if (t.kind === 'never') return;
    if (!this.unifier.tryUnify(actual, expected)) {
      const span = { row: block.endRow, col: 1 };
      const lastStmt = block.stmts.at(-1);
      if (lastStmt?.kind === 'expr' && lastStmt.semi && !isUnit(expected)) {
        compileError(
          lastStmt.span,
          `関数 ${item.name} は ${typeToString(expected)} を返すはずですが、最後の式の後に ; があるので値を返していません（; を消してください）。`
        );
      }
      compileError(span, `関数 ${item.name} は ${typeToString(expected)} を返すはずですが、値を返していません。`);
    }
  }

  /** Solves the remaining obligations, applies the default types of literals, and requires every type to be known. */
  private finishBody(span: Span): void {
    this.solveObligations(false);
    for (const check of this.deferredChecks.splice(0)) check();
    this.solveObligations(true);
    void span;
  }

  private solveObligations(final: boolean): void {
    let progress = true;
    while (progress) {
      progress = false;
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
    // Literal variables take their defaults, which may settle what remains.
    for (const obligation of this.obligations) resolve(obligation.type, true);
    const remaining = this.obligations;
    this.obligations = [];
    for (const obligation of remaining) {
      const answer = this.solver.implements(obligation.type, obligation.ref);
      if (answer === 'no') this.unsatisfied(obligation);
      if (answer === 'unknown') {
        compileError(obligation.span, `型が決まりません（${typeToString(obligation.type)} の型を書いてください）。`);
      }
    }
  }

  private unsatisfied(obligation: Obligation): never {
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

  private require(type: Type, ref: TraitRef, span: Span): void {
    const answer = this.solver.implements(type, ref);
    if (answer === 'no') this.unsatisfied({ type, ref, span });
    if (answer === 'unknown') this.obligations.push({ type, ref, span });
  }

  private requireTrait(type: Type, name: string, span: Span): void {
    this.require(type, { trait: this.program.traitDef(name), args: [] }, span);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Variables and scopes

  private declareLocal(
    name: string,
    type: Type,
    mutable: boolean,
    span: Span,
    mode: LocalVar['mode'] = 'move'
  ): LocalVar {
    const fn = this.body.fn;
    const local: LocalVar = { name, mutable, type, slot: fn.slotCount++, span, owner: fn, mode, id: nextLocalId++ };
    fn.locals.push(local);
    (this.body.scopes.at(-1) as Map<string, LocalVar>).set(name, local);
    return local;
  }

  private withScope<T>(run: () => T): T {
    this.body.scopes.push(new Map());
    try {
      return run();
    } finally {
      this.body.scopes.pop();
    }
  }

  private findLocal(name: string): LocalVar | undefined {
    for (let index = this.body.scopes.length - 1; index >= 0; index--) {
      const found = this.body.scopes[index].get(name);
      if (found) return found;
    }
    return undefined;
  }

  /** How a body reaches a variable: its own, or a capture of a closure (recorded on every closure in between). */
  private localRes(local: LocalVar): PathRes {
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
    return { module: this.body.module, params: this.body.typeParams, selfType: this.body.selfType, allowInfer: true };
  }

  lowerType(ast: TypeAst): Type {
    return lowerType(ast, this.typeScope());
  }

  private mismatch(span: Span, expected: Type, actual: Type): never {
    const e = typeToString(resolve(expected));
    const a = typeToString(resolve(actual));
    if (e === a) compileError(span, `型が合いません（${e} が必要です）。`);
    compileError(span, `型が合いません（${e} が必要ですが、${a} です）。`);
  }

  private unifyOrError(span: Span, expected: Type, actual: Type): void {
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

  // code-gauge-allow functionCognitiveComplexity 30 -- One case per coercion.
  private coerce(expr: Expr, actual: Type, target: Type): void {
    const a = normalize(shallow(actual));
    const t = normalize(shallow(target));
    if (a.kind === 'never') return;
    if (this.unifier.tryUnify(a, t)) return;
    // &T → &U through derefs, and &mut T → &T.
    if (a.kind === 'ref' && t.kind === 'ref' && (!t.mutable || a.mutable)) {
      const steps = autoderefSteps(this.program, a.target);
      for (const step of steps) {
        if (this.unifier.tryUnify(step.type, t.target)) {
          if (step.derefs.length > 0 || (a.mutable && !t.mutable)) {
            this.annotations.coercions.set(expr, {
              kind: 'deref',
              derefs: step.derefs,
              fromMut: a.mutable && !t.mutable,
            });
          }
          return;
        }
      }
      const target = shallow(t.target);
      if (target.kind === 'dyn') {
        this.requireDyn(a.target, target.trait, expr.span);
        this.annotations.coercions.set(expr, { kind: 'dyn', type: a.target, mutable: a.mutable });
        return;
      }
    }
    if (a.kind === 'adt' && a.def.builtin === 'Box' && t.kind === 'adt' && t.def.builtin === 'Box') {
      const target = shallow(t.args[0]);
      if (target.kind === 'dyn') {
        this.requireDyn(a.args[0], target.trait, expr.span);
        this.annotations.coercions.set(expr, { kind: 'dyn', type: a.args[0], mutable: false });
        return;
      }
    }
    if (t.kind === 'adt' && t.def.builtin === 'Iter') {
      const item = this.intoIterItem(a);
      if (item && this.unifier.tryUnify(item, t.args[0])) {
        this.annotations.coercions.set(expr, { kind: 'intoIter', from: a });
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

  private requireDyn(type: Type, trait: TraitRef, span: Span): void {
    const t = shallow(type);
    if (t.kind === 'dyn' && t.trait.trait === trait.trait) return;
    this.require(type, trait, span);
  }

  /** The element type a `for` loop over a value of this type binds, as `IntoIterator` gives it. */
  // code-gauge-allow functionCognitiveComplexity 25 -- One case per iterable type.
  intoIterItem(type: Type): Type | undefined {
    const t = normalize(shallow(type));
    if (t.kind === 'array') return t.elem;
    if (t.kind === 'ref') {
      const target = normalize(shallow(t.target));
      if (target.kind === 'array' || target.kind === 'slice') return ref(target.elem, t.mutable);
      if (target.kind === 'adt') {
        switch (target.def.builtin) {
          case 'Vec':
          case 'VecDeque':
          case 'HashSet':
          case 'BTreeSet':
          case 'BinaryHeap': {
            return ref(
              target.args[0],
              t.mutable && target.def.builtin !== 'HashSet' && target.def.builtin !== 'BTreeSet'
            );
          }
          case 'HashMap':
          case 'BTreeMap': {
            return { kind: 'tuple', elems: [ref(target.args[0]), ref(target.args[1], t.mutable)] };
          }
          case 'Option': {
            return ref(target.args[0], t.mutable);
          }
          case 'Iter': {
            return t.mutable ? target.args[0] : undefined;
          }
          default: {
            return undefined;
          }
        }
      }
      return undefined;
    }
    if (t.kind !== 'adt') return undefined;
    switch (t.def.builtin) {
      case 'Vec':
      case 'VecDeque':
      case 'HashSet':
      case 'BTreeSet':
      case 'BinaryHeap':
      case 'Iter':
      case 'Option':
      case 'Range':
      case 'RangeInclusive':
      case 'RangeFrom':
      case 'CaseIter': {
        if (t.def.builtin === 'CaseIter') return CHAR;
        return t.args[0];
      }
      case 'HashMap':
      case 'BTreeMap': {
        return { kind: 'tuple', elems: t.args };
      }
      case 'Result': {
        return t.args[0];
      }
      default: {
        return undefined;
      }
    }
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
      if (block.tail) {
        const type = this.expr(block.tail, expected);
        if (diverges && shallow(type).kind !== 'never') return type;
        return type;
      }
      return diverges ? NEVER : UNIT;
    });
  }

  private declareBlockItems(block: Block): void {
    const module = new Module(this.program, '{block}', this.body.module.namedModule, false, this.body.module);
    const collector = new ItemCollector(this.program);
    const pendingBefore = this.program.pendingFns.length;
    collector.collectItems(block.items, module);
    collector.finish();
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
    this.checkPattern(stmt.pattern, type, 'move');
    if (!stmt.else) this.requireIrrefutable(stmt.pattern, type, 'let');
    return diverges;
  }

  private requireIrrefutable(pattern: Pattern, type: Type, where: 'let' | 'fn' | 'for'): void {
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
  // code-gauge-allow functionCognitiveComplexity 60 -- One case per kind of expression.
  expr(expr: Expr, expected: Type | undefined): Type {
    const type = this.exprInner(expr, expected);
    expr.ty = type;
    return type;
  }

  // code-gauge-allow functionNcss 120 -- One case per kind of expression.
  private exprInner(expr: Expr, expected: Type | undefined): Type {
    switch (expr.kind) {
      case 'int': {
        if (expr.suffix) return intType(expr.suffix as never);
        const type = freshVar('int');
        if (expected) {
          const e = normalize(shallow(expected));
          if (e.kind === 'int' || (e.kind === 'var' && e.v.literal !== 'float')) this.unifier.tryUnify(type, e);
        }
        return type;
      }
      case 'float': {
        if (expr.suffix) return expr.suffix === 'f32' ? F32 : F64;
        const type = freshVar('float');
        if (expected) {
          const e = shallow(expected);
          if (e.kind === 'float' || (e.kind === 'var' && e.v.literal !== 'int')) this.unifier.tryUnify(type, e);
        }
        return type;
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
      case 'path': {
        return this.pathExpr(expr, expected);
      }
      case 'unary': {
        return this.unary(expr, expected);
      }
      case 'binary': {
        return this.binary(expr, expected);
      }
      case 'assign': {
        return this.assign(expr);
      }
      case 'compoundAssign': {
        return this.compoundAssign(expr);
      }
      case 'ref': {
        return this.refExpr(expr, expected);
      }
      case 'cast': {
        return this.cast(expr);
      }
      case 'call': {
        return this.call(expr, expected);
      }
      case 'methodCall': {
        return this.methodCall(expr, expected);
      }
      case 'field': {
        return this.field(expr);
      }
      case 'index': {
        return this.index(expr);
      }
      case 'range': {
        return this.range(expr, expected);
      }
      case 'tuple': {
        const e = expected ? shallow(expected) : undefined;
        const elems = expr.elems.map((elem, index) => {
          const want = e?.kind === 'tuple' && e.elems.length === expr.elems.length ? e.elems[index] : undefined;
          if (want) {
            this.coerceExpr(elem, want);
            return want;
          }
          return this.expr(elem, undefined);
        });
        return { kind: 'tuple', elems };
      }
      case 'array': {
        const e = expected ? shallow(expected) : undefined;
        const elem = e?.kind === 'array' || e?.kind === 'slice' ? e.elem : freshVar();
        this.elements(expr.elems, elem);
        return { kind: 'array', elem, len: expr.elems.length };
      }
      case 'arrayRepeat': {
        const e = expected ? shallow(expected) : undefined;
        const elem = e?.kind === 'array' ? e.elem : freshVar();
        this.coerceExpr(expr.value, elem);
        const len = this.constUsize(expr.count);
        this.deferredChecks.push(() => {
          if (len !== 1 && len !== 0 && !this.solver.isCopy(resolve(elem, true))) {
            const value = expr.value;
            if (value.kind !== 'path' || this.annotations.paths.get(value)?.kind !== 'const') {
              compileError(
                expr.span,
                `[値; 個数] の値は Copy の型にしてください（${typeToString(resolve(elem))} は Copy ではありません）。`
              );
            }
          }
        });
        return { kind: 'array', elem, len };
      }
      case 'struct': {
        return this.structExpr(expr, expected);
      }
      case 'block': {
        return this.checkBlock(expr, expected);
      }
      case 'if': {
        return this.ifExpr(expr, expected);
      }
      case 'match': {
        return this.matchExpr(expr, expected);
      }
      case 'loop': {
        const breakType = freshVar();
        this.inLoop(expr.label, breakType, () => this.checkBlock(expr.body, UNIT));
        return this.loopBroke(expr) ? breakType : NEVER;
      }
      case 'while': {
        this.withScope(() => {
          this.condition(expr.cond);
          this.inLoop(expr.label, undefined, () => this.blockUnit(expr.body));
        });
        return UNIT;
      }
      case 'for': {
        return this.forExpr(expr);
      }
      case 'break': {
        const loop = this.findLoop(expr.label, expr.span, 'break');
        if (expr.value) {
          if (!loop.breakType)
            compileError(expr.span, 'while や for の break には値を書けません（値を返せるのは loop だけです）。');
          this.coerceExpr(expr.value, loop.breakType);
        } else if (loop.breakType) {
          this.unifyOrError(expr.span, loop.breakType, UNIT);
        }
        (loop as LoopContext & { broke?: boolean }).broke = true;
        return NEVER;
      }
      case 'continue': {
        this.findLoop(expr.label, expr.span, 'continue');
        return NEVER;
      }
      case 'return': {
        if (expr.value) this.coerceExpr(expr.value, this.body.retType);
        else if (!this.unifier.tryUnify(this.body.retType, UNIT)) {
          compileError(expr.span, `return に値が要ります（${typeToString(this.body.retType)} を返してください）。`);
        }
        return NEVER;
      }
      case 'closure': {
        return this.closure(expr, expected);
      }
      case 'try': {
        return this.tryExpr(expr);
      }
      case 'macro': {
        return this.macro(expr, expr.macro, expected);
      }
    }
  }

  private elements(elems: Expr[], elem: Type): void {
    for (const item of elems) this.coerceExpr(item, elem);
  }

  private constUsize(expr: Expr): number {
    this.coerceExpr(expr, USIZE);
    if (expr.kind === 'int') return Number(expr.value);
    const res = expr.kind === 'path' ? this.annotations.paths.get(expr) : undefined;
    if (res?.kind === 'const') {
      const ast = res.def.ast as { value?: Expr };
      if (ast.value?.kind === 'int') return Number(ast.value.value);
    }
    return compileError(expr.span, '[値; 個数] の個数には、整数のリテラルか定数を書いてください。');
  }

  private blockUnit(block: Block): void {
    const type = this.checkBlock(block, UNIT);
    if (shallow(type).kind !== 'never' && !this.unifier.tryUnify(type, UNIT)) {
      compileError(block.tail?.span ?? block.span, `型が合いません（() が必要ですが、${typeToString(type)} です）。`);
    }
  }

  private inLoop<T>(label: string | undefined, breakType: Type | undefined, run: () => T): T {
    const loop: LoopContext = { label, breakType, context: this.body.fn };
    this.body.loops.push(loop);
    try {
      return run();
    } finally {
      this.body.loops.pop();
      (this as { lastLoop?: LoopContext }).lastLoop = loop;
    }
  }

  private loopBroke(_expr: Expr): boolean {
    const loop = (this as { lastLoop?: LoopContext & { broke?: boolean } }).lastLoop;
    return loop?.broke ?? false;
  }

  private findLoop(label: string | undefined, span: Span, keyword: string): LoopContext {
    for (let index = this.body.loops.length - 1; index >= 0; index--) {
      const loop = this.body.loops[index];
      if (loop.context !== this.body.fn) break;
      if (label === undefined || loop.label === label) {
        if (label !== undefined)
          (loop as LoopContext & { broke?: boolean }).broke =
            keyword === 'break' ? true : (loop as { broke?: boolean }).broke;
        return loop;
      }
    }
    if (label !== undefined) compileError(span, `ラベル '${label} のループが見つかりません。`);
    return compileError(span, `${keyword} は、ループの中にだけ書けます。`);
  }

  private condition(cond: Condition): void {
    if (cond.kind === 'expr') {
      this.coerceExpr(cond.expr, BOOL);
      return;
    }
    const type = this.expr(cond.value, undefined);
    this.checkPattern(cond.pattern, type, 'move');
  }

  private ifExpr(expr: Extract<Expr, { kind: 'if' }>, expected: Type | undefined): Type {
    return this.withScope(() => {
      this.condition(expr.cond);
      if (!expr.else) {
        this.blockUnit(expr.consequent);
        return UNIT;
      }
      const thenType = this.checkBlock(expr.consequent, expected);
      expr.consequent.ty = thenType;
      // The else branch runs outside the bindings of an `if let`.
      const scopes = this.body.scopes;
      const outer = scopes.slice(0, -1);
      this.body.scopes = outer;
      try {
        const elseType = this.expr(expr.else, expected ?? (shallow(thenType).kind === 'never' ? undefined : thenType));
        return this.join(expr.consequent, thenType, expr.else, elseType, expected);
      } finally {
        this.body.scopes = scopes;
      }
    });
  }

  /** The type of two branches that must agree, where a diverging branch takes the other's type. */
  private join(first: Expr, firstType: Type, second: Expr, secondType: Type, expected: Type | undefined): Type {
    if (shallow(firstType).kind === 'never') return secondType;
    if (shallow(secondType).kind === 'never') return firstType;
    const target = expected ?? firstType;
    if (expected) {
      this.coerce(first, firstType, expected);
      this.coerce(second, secondType, expected);
      return expected;
    }
    if (!this.unifier.tryUnify(firstType, secondType)) {
      const span = second.kind === 'block' ? (second.tail?.span ?? second.span) : second.span;
      compileError(
        span,
        `if と else の値の型が合いません（${typeToString(resolve(firstType))} と ${typeToString(resolve(secondType))} です）。`
      );
    }
    return target;
  }

  private matchExpr(expr: Extract<Expr, { kind: 'match' }>, expected: Type | undefined): Type {
    const scrutinee = this.expr(expr.scrutinee, undefined);
    let result: Type | undefined = expected;
    let resultSet = expected !== undefined;
    for (const arm of expr.arms) {
      this.withScope(() => {
        this.checkPattern(arm.pattern, scrutinee, 'move');
        const type = this.expr(arm.body, result);
        if (shallow(type).kind === 'never') return;
        if (!resultSet) {
          result = type;
          resultSet = true;
          return;
        }
        this.coerceArm(arm.body, type, result as Type);
      });
    }
    if (expr.arms.length === 0) {
      this.deferredChecks.push(() => this.checkExhaustive(expr, scrutinee));
      return NEVER;
    }
    this.deferredChecks.push(() => this.checkExhaustive(expr, scrutinee));
    return result ?? NEVER;
  }

  private coerceArm(body: Expr, type: Type, result: Type): void {
    if (this.unifier.tryUnify(type, result)) return;
    const span = body.kind === 'block' ? (body.tail?.span ?? body.span) : body.span;
    try {
      this.coerce(body, type, result);
    } catch {
      compileError(
        span,
        `match の腕の値の型が合いません（${typeToString(resolve(result))} と ${typeToString(resolve(type))} です）。`
      );
    }
  }

  private checkExhaustive(expr: Extract<Expr, { kind: 'match' }>, scrutinee: Type): void {
    const patterns = expr.arms.map((arm) => lowerPattern(arm.pattern, this.annotations));
    const missing = missingPattern(patterns, resolve(scrutinee, true));
    if (missing) {
      compileError(
        expr.span,
        `match の腕が足りません（${missing} に合う腕がありません。すべての場合を書くか、_ => の腕を足してください）。`
      );
    }
  }

  private forExpr(expr: Extract<Expr, { kind: 'for' }>): Type {
    const iterable = this.expr(expr.iterable, undefined);
    const resolved = normalize(shallow(iterable));
    if (resolved.kind === 'var') compileError(expr.iterable.span, '繰り返すものの型が決まりません。');
    const item = this.intoIterItem(resolved);
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
    if (resolved.kind === 'adt' && resolved.def.builtin === 'RangeFrom') {
      // An unbounded range iterates forever.
    }
    this.annotations.loops.set(expr, { item, from: iterable });
    this.withScope(() => {
      this.checkPattern(expr.pattern, item, 'move');
      this.requireIrrefutable(expr.pattern, item, 'for');
      this.inLoop(expr.label, undefined, () => this.blockUnit(expr.body));
    });
    return UNIT;
  }

  private range(expr: Extract<Expr, { kind: 'range' }>, expected: Type | undefined): Type {
    let elem: Type = freshVar();
    const e = expected ? normalize(shallow(expected)) : undefined;
    if (e?.kind === 'adt' && RANGE_TYPES.has(e.def.builtin as string) && e.args.length > 0) elem = e.args[0];
    if (expr.start) this.coerceExpr(expr.start, elem);
    if (expr.end) this.coerceExpr(expr.end, elem);
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
    if (name === 'RangeFull') return this.program.builtinType('RangeFull');
    return this.program.builtinType(name, [elem]);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Paths

  private pathExpr(expr: Extract<Expr, { kind: 'path' }>, expected: Type | undefined): Type {
    const res = this.resolveValuePath(expr.path, expr.span);
    this.annotations.paths.set(expr, res);
    return this.typeOfRes(res, expr.span, expected);
  }

  private typeOfRes(res: PathRes, span: Span, expected: Type | undefined): Type {
    switch (res.kind) {
      case 'local':
      case 'capture': {
        return res.local.type;
      }
      case 'fn': {
        const sig = this.instantiate(res.fn, res.typeArgs);
        return { kind: 'fn', params: sig.params, ret: sig.ret };
      }
      case 'ctor': {
        const variant = res.def.variants[res.variant];
        const self = adt(res.def, res.typeArgs);
        if (variant.shape === 'unit') {
          if (expected) this.unifier.tryUnify(self, expected);
          return self;
        }
        if (variant.shape === 'named') {
          compileError(
            span,
            `${variant.name} はフィールドに名前のある型なので、${variant.name} { ... } の形で作ってください。`
          );
        }
        const subst = new Map(res.def.params.map((param, index) => [param, res.typeArgs[index]]));
        return { kind: 'fn', params: variant.fields.map((field) => substitute(field.type, subst)), ret: self };
      }
      case 'const': {
        return res.def.type;
      }
      case 'builtinConst': {
        return res.type;
      }
      case 'discard': {
        return compileError(span, '_ は、代入の左辺にだけ書けます。');
      }
    }
  }

  /** The type arguments for a generic item: those written in the path, or fresh variables. */
  private typeArgsFor(params: TypeParam[], written: TypeAst[] | undefined, span: Span, what: string): Type[] {
    if (!written) return params.map(() => freshVar());
    if (written.length !== params.length) {
      compileError(span, `${what} の型引数の数が合いません（${params.length} 個です）。`);
    }
    return written.map((arg) => this.lowerType(arg));
  }

  // code-gauge-allow functionCognitiveComplexity 40 -- Follows Rust's resolution of value paths.
  resolveValuePath(path: PathAst, span: Span): PathRes {
    const segments = path.segments;
    const names = segments.map((segment) => segment.name);
    if (names.length === 1) {
      const name = names[0];
      if (name === '_') return { kind: 'discard' };
      const local = this.findLocal(name);
      if (local) return this.localRes(local);
      if (name === 'self') compileError(span, 'self は、self を引数に取るメソッドの中にだけ書けます。');
      if (name === 'Self') return this.selfCtor(span);
      const binding = lookupValue(this.body.module, name, span);
      if (!binding) {
        if (lookupType(this.body.module, name, span)) {
          compileError(span, `${name} は型の名前で、値ではありません。`);
        }
        compileError(span, `${name} が見つかりません。`);
      }
      return this.valueBindingRes(binding, segments[0].args, span, name);
    }
    // A path whose last segment names a value in a module, a variant of an enum, or an associated item of a type.
    const prefix = segments.slice(0, -1);
    const last = segments.at(-1)!;
    const owner = this.resolvePrefix(prefix, span);
    if (owner.kind === 'mod') {
      const module = owner.module;
      const binding = module.values.get(last.name) ?? lookupValueIn(module, last.name, span);
      if (!binding) {
        if (module.isStd) this.unavailableStd(names, span);
        compileError(span, `${names.join('::')} が見つかりません。`);
      }
      const entry = module.values.get(last.name);
      if (entry && !entry.isPublic && !module.isAncestorOf(this.body.module.namedModule)) {
        compileError(span, `${last.name} は非公開です（pub が付いていません）。`);
      }
      return this.valueBindingRes('binding' in binding ? binding.binding : binding, last.args, span, names.join('::'));
    }
    if (owner.kind === 'trait') {
      const fn = owner.def.methods.get(last.name);
      if (!fn) compileError(span, `トレイト ${owner.def.name} にメソッド ${last.name} がありません。`);
      const typeArgs = fn.params.map(() => freshVar());
      return { kind: 'fn', fn, typeArgs };
    }
    const selfType = owner.type;
    const t = normalize(shallow(selfType));
    if (t.kind === 'adt' && t.def.kind === 'enum') {
      const variant = t.def.variants.find((v) => v.name === last.name);
      if (variant) {
        const typeArgs = last.args ? this.typeArgsFor(t.def.params, last.args, span, t.def.name) : t.args;
        return { kind: 'ctor', def: t.def, variant: variant.index, typeArgs };
      }
    }
    const constant = this.associatedConst(t, last.name, span);
    if (constant) return constant;
    const found = lookupAssociated(this.program, this.solver, t, last.name);
    if (!found) {
      if (t.kind === 'adt' && t.def.kind === 'enum') {
        compileError(span, `${t.def.name} に列挙子 ${last.name} がありません。`);
      }
      compileError(span, `${typeToString(t)} に関連関数 ${last.name} がありません。`);
    }
    this.checkMethodVisible(found.fn, span);
    if (last.args) {
      const own = found.fn.params.slice(found.fn.parentParamCount);
      const written = this.typeArgsFor(own, last.args, span, last.name);
      found.typeArgs.splice(found.fn.parentParamCount, own.length, ...written);
    }
    return { kind: 'fn', fn: found.fn, typeArgs: found.typeArgs };
  }

  private unavailableStd(names: string[], span: Span): never {
    const [, module] = names;
    if (module === 'io' || module === 'fs') {
      compileError(span, '標準入力・ファイルの入出力は、この採点環境では使えません。');
    }
    if (module === 'thread') compileError(span, 'スレッド（std::thread）は、この採点環境では使えません。');
    if (module === 'env')
      compileError(span, '環境変数とコマンドラインの引数（std::env）は、この採点環境では使えません。');
    return compileError(span, `${names.join('::')} は、この採点環境では使えません。`);
  }

  private checkMethodVisible(fn: FnDef, span: Span): void {
    const item = fn.ast;
    if (!item || item.vis === 'pub' || fn.trait || fn.impl?.trait) return;
    const module = fn.module as Module;
    if (module.isStd) return;
    if (!module.namedModule.isAncestorOf(this.body.module.namedModule)) {
      compileError(span, `${fn.name} は非公開です（pub が付いていません）。`);
    }
  }

  private associatedConst(t: Type, name: string, span: Span): PathRes | undefined {
    if (t.kind === 'int' && ['MAX', 'MIN', 'BITS'].includes(name)) {
      return { kind: 'builtinConst', type: name === 'BITS' ? intType('u32') : t, name: `${t.name}::${name}` };
    }
    if (
      t.kind === 'float' &&
      ['MAX', 'MIN', 'INFINITY', 'NEG_INFINITY', 'NAN', 'EPSILON', 'MIN_POSITIVE'].includes(name)
    ) {
      return { kind: 'builtinConst', type: t, name: `${t.name}::${name}` };
    }
    if (t.kind === 'char' && name === 'MAX') return { kind: 'builtinConst', type: CHAR, name: 'char::MAX' };
    for (const impl of this.program.impls) {
      const constant = impl.consts.get(name);
      if (!constant) continue;
      if (this.solver.matchImpl(impl, t)) return { kind: 'const', def: constant };
    }
    void span;
    return undefined;
  }

  private selfCtor(span: Span): PathRes {
    const self = this.body.selfType ? shallow(this.body.selfType) : undefined;
    if (self?.kind !== 'adt' || self.def.kind !== 'struct' || self.def.variants[0]?.shape === 'named') {
      compileError(span, 'Self を値として使えるのは、タプル構造体とユニット構造体の impl の中だけです。');
    }
    return { kind: 'ctor', def: self.def, variant: 0, typeArgs: self.args };
  }

  private resolvePrefix(
    prefix: PathAst['segments'],
    span: Span
  ): Exclude<TypeBinding, { kind: 'adt' | 'prim' | 'alias' }> | { kind: 'type'; type: Type } {
    const names = prefix.map((segment) => segment.name);
    const last = prefix.at(-1)!;
    if (names.length === 1 && this.body.typeParams.has(names[0])) {
      return { kind: 'type', type: { kind: 'param', param: this.body.typeParams.get(names[0])! } };
    }
    if (names.length === 1 && names[0] === 'Self') {
      if (!this.body.selfType) compileError(span, 'Self は、impl やトレイトの中にだけ書けます。');
      return { kind: 'type', type: this.body.selfType };
    }
    const binding = resolveTypePath(names, this.body.module, span);
    switch (binding.kind) {
      case 'adt': {
        const args = last.args
          ? this.typeArgsFor(binding.def.params, last.args, span, binding.def.name)
          : binding.def.params.map(() => freshVar());
        return { kind: 'type', type: adt(binding.def, args) };
      }
      case 'prim': {
        return { kind: 'type', type: binding.type };
      }
      case 'alias': {
        return { kind: 'type', type: binding.resolve() };
      }
      case 'mod':
      case 'trait': {
        return binding;
      }
    }
  }

  private valueBindingRes(binding: ValueBinding, args: TypeAst[] | undefined, span: Span, name: string): PathRes {
    switch (binding.kind) {
      case 'fn': {
        const fn = binding.def;
        const own = fn.params.slice(fn.parentParamCount);
        const typeArgs = [
          ...fn.params.slice(0, fn.parentParamCount).map(() => freshVar()),
          ...this.typeArgsFor(own, args, span, name),
        ];
        return { kind: 'fn', fn, typeArgs };
      }
      case 'ctor': {
        return {
          kind: 'ctor',
          def: binding.def,
          variant: binding.variant,
          typeArgs: this.typeArgsFor(binding.def.params, args, span, name),
        };
      }
      case 'const': {
        return { kind: 'const', def: binding.def };
      }
    }
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
        this.obligations.push({ type: subst.get(param) as Type, ref: substituteTraitRef(bound, subst), span });
      }
    }
    return {
      params: fn.paramTypes.map((type) => substitute(type, subst)),
      ret: substitute(fn.ret, subst),
      subst,
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Calls

  private call(expr: Extract<Expr, { kind: 'call' }>, expected: Type | undefined): Type {
    const { callee } = expr;
    if (callee.kind === 'path') {
      const res = this.resolveValuePath(callee.path, callee.span);
      this.annotations.paths.set(callee, res);
      if (res.kind === 'fn') return this.callFn(expr, res.fn, res.typeArgs, expected);
      if (res.kind === 'ctor') return this.callCtor(expr, res, expected);
      const type = this.typeOfRes(res, callee.span, undefined);
      callee.ty = type;
      return this.callValue(expr, type, expected);
    }
    const type = this.expr(callee, undefined);
    return this.callValue(expr, type, expected);
  }

  private callFn(expr: Extract<Expr, { kind: 'call' }>, fn: FnDef, typeArgs: Type[], expected: Type | undefined): Type {
    if ((fn as { nativeKey?: string }).nativeKey === 'Turtle::new') return this.turtleNew(expr);
    const sig = this.instantiate(fn, typeArgs, expr.span);
    const params = fn.selfMode ? [this.selfParamType(fn, sig.subst), ...sig.params] : sig.params;
    if (expr.args.length !== params.length) {
      compileError(
        expr.span,
        `関数 ${fn.name} の引数の数が合いません（${params.length} 個ですが、${expr.args.length} 個あります）。`
      );
    }
    if (expected && !hasVars(sig.ret)) {
      // The result's type may decide the type arguments of the call (`let v: Vec<i32> = Vec::new()`).
    } else if (expected) {
      this.unifier.tryUnify(sig.ret, expected);
    }
    this.args(expr.args, params);
    this.callee(expr).ty = { kind: 'fn', params, ret: sig.ret };
    return sig.ret.kind === 'opaque' ? sig.ret : sig.ret;
  }

  private callee(expr: Extract<Expr, { kind: 'call' }>): Expr {
    return expr.callee;
  }

  private selfParamType(fn: FnDef, subst: Subst): Type {
    const self = fn.trait ? ({ kind: 'param', param: fn.trait.self } as Type) : (fn.impl?.selfType ?? UNIT);
    const selfType = substitute(self, subst);
    if (fn.selfMode === 'value') return selfType;
    return ref(selfType, fn.selfMode === 'mutRef');
  }

  private turtleNew(expr: Extract<Expr, { kind: 'call' }>): Type {
    const { args } = expr;
    if (args.length > 0 && args.length !== 2 && args.length !== 3) {
      compileError(
        expr.span,
        'Turtle::new には、引数を書かないか、x と y、または x と y と色（"R" など）を書いてください。'
      );
    }
    if (args.length >= 2) {
      this.coerceExpr(args[0], intType('i32'));
      this.coerceExpr(args[1], intType('i32'));
    }
    if (args.length === 3) this.coerceExpr(args[2], REF_STR);
    const turtle = this.program.builtinType('Turtle');
    expr.callee.ty = { kind: 'fn', params: args.map((arg) => arg.ty ?? UNIT), ret: turtle };
    return turtle;
  }

  private callCtor(
    expr: Extract<Expr, { kind: 'call' }>,
    res: Extract<PathRes, { kind: 'ctor' }>,
    expected: Type | undefined
  ): Type {
    const variant = res.def.variants[res.variant];
    if (variant.shape !== 'tuple') {
      if (variant.shape === 'unit')
        compileError(expr.span, `${variant.name} は引数を取りません（() を消してください）。`);
      compileError(expr.span, `${variant.name} は、${variant.name} { ... } の形で作ってください。`);
    }
    const self = adt(res.def, res.typeArgs);
    if (expected) this.unifier.tryUnify(self, expected);
    const subst = new Map(res.def.params.map((param, index) => [param, res.typeArgs[index]]));
    const params = variant.fields.map((field) => substitute(field.type, subst));
    if (expr.args.length !== params.length) {
      compileError(
        expr.span,
        `${variant.name} の引数の数が合いません（${params.length} 個ですが、${expr.args.length} 個あります）。`
      );
    }
    this.args(expr.args, params);
    expr.callee.ty = { kind: 'fn', params, ret: self };
    return self;
  }

  private args(args: Expr[], params: Type[]): void {
    // Closures are checked last, when the other arguments have told their parameters' types.
    const order = [...args.keys()].toSorted(
      (a, b) => Number(args[a].kind === 'closure') - Number(args[b].kind === 'closure')
    );
    for (const index of order) this.argument(args[index], params[index]);
  }

  private argument(arg: Expr, param: Type): void {
    if (arg.kind === 'closure') {
      const sig = this.closureSignature(param);
      if (sig) {
        const type = this.expr(arg, { kind: 'fn', params: sig.params, ret: sig.ret });
        this.coerceClosure(arg, type, param);
        return;
      }
    }
    this.coerceExpr(arg, param);
  }

  private coerceClosure(arg: Expr, type: Type, param: Type): void {
    const p = shallow(param);
    if (p.kind === 'var' || p.kind === 'param') {
      if (p.kind === 'var') this.unifier.tryUnify(p, type);
      return;
    }
    this.coerce(arg, type, param);
  }

  /** The signature a closure passed for a parameter takes: from the parameter's `Fn` bound. */
  private closureSignature(param: Type): { params: Type[]; ret: Type } | undefined {
    const p = shallow(param);
    if (p.kind === 'var') {
      const bounds = this.varBounds.get(p.v) ?? [];
      const fnBound = bounds.find((bound) => bound.fnSig);
      return fnBound?.fnSig;
    }
    if (p.kind === 'param') return p.param.bounds.find((bound) => bound.fnSig)?.fnSig;
    if (p.kind === 'fn') return { params: p.params, ret: p.ret };
    if (p.kind === 'adt' && p.def.builtin === 'Box') {
      const inner = shallow(p.args[0]);
      if (inner.kind === 'dyn' && inner.trait.fnSig) return inner.trait.fnSig;
    }
    return undefined;
  }

  /** Calls a value: a closure, a function, or a value whose type is bounded by a closure trait. */
  private callValue(expr: Extract<Expr, { kind: 'call' }>, calleeType: Type, expected: Type | undefined): Type {
    let t = normalize(shallow(calleeType));
    while (t.kind === 'ref' || (t.kind === 'adt' && t.def.builtin === 'Box')) {
      t = normalize(shallow(t.kind === 'ref' ? t.target : t.args[0]));
    }
    let params: Type[];
    let ret: Type;
    if (t.kind === 'closure') {
      params = t.closure.params;
      ret = t.closure.ret;
      this.requireCallableMut(expr, t.closure.kind);
    } else if (t.kind === 'fn') {
      params = t.params;
      ret = t.ret;
    } else {
      const bounds = boundsOf(t) ?? [];
      const sig = bounds.find((bound) => bound.fnSig);
      if (!sig?.fnSig) {
        compileError(expr.callee.span, `${typeToString(resolve(calleeType))} は関数ではないので、呼び出せません。`);
      }
      params = sig.fnSig.params;
      ret = sig.fnSig.ret;
      if (sig.trait.name === 'FnMut') this.requireCallableMut(expr, 'FnMut');
    }
    if (expr.args.length !== params.length) {
      compileError(expr.span, `引数の数が合いません（${params.length} 個ですが、${expr.args.length} 個あります）。`);
    }
    if (expected) this.unifier.tryUnify(ret, expected);
    this.args(expr.args, params);
    this.annotations.calls.set(expr, 'closure');
    return ret;
  }

  /** Calling an `FnMut` closure borrows it mutably, so its variable must be `mut`. */
  private requireCallableMut(expr: Extract<Expr, { kind: 'call' }>, kind: string): void {
    this.deferredChecks.push(() => {
      const callee = expr.callee;
      const closureType = shallow(callee.ty ?? UNIT);
      const actual = closureType.kind === 'closure' ? closureType.closure.kind : kind;
      if (actual === 'Fn') return;
      if (callee.kind !== 'path') return;
      const res = this.annotations.paths.get(callee);
      if (res?.kind === 'local' && !res.local.mutable && shallow(res.local.type).kind === 'closure') {
        compileError(
          callee.span,
          `変数 ${res.local.name} のクロージャは捕まえた変数を書き換えるので、let mut ${res.local.name} と宣言してください。`
        );
      }
    });
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Follows rustc's method call checking.
  private methodCall(expr: Extract<Expr, { kind: 'methodCall' }>, expected: Type | undefined): Type {
    const receiverType = this.expr(expr.receiver, undefined);
    const resolvedReceiver = normalize(shallow(receiverType));
    let stripped = resolvedReceiver;
    while (stripped.kind === 'ref') stripped = normalize(shallow(stripped.target));
    if (stripped.kind === 'var' && !stripped.v.literal) {
      compileError(
        expr.methodSpan,
        `型が決まらないので、メソッド ${expr.method} を呼べません（変数の型を書いてください）。`
      );
    }
    const found = lookupMethod(this.program, this.solver, receiverType, expr.method);
    // On a number whose type is not yet known, rustc finds trait methods (`1.cmp(&2)`) but no inherent ones.
    if (stripped.kind === 'var' && found && found !== 'ambiguous' && (!found.fn.trait || found.fn.impl)) {
      compileError(
        expr.methodSpan,
        `数の型が決まらないので、メソッド ${expr.method} を呼べません（5_i32 や 2.0_f64 のように、型を書いてください）。`
      );
    }
    if (found === 'ambiguous') {
      compileError(
        expr.methodSpan,
        `型が決まらないので、メソッド ${expr.method} を呼べません（変数の型を書いてください）。`
      );
    }
    if (!found) return this.noMethod(expr, receiverType);
    this.checkMethodVisible(found.fn, expr.methodSpan);
    const { fn } = found;
    if (expr.turbofish) {
      const own = fn.params.slice(fn.parentParamCount);
      const written = this.typeArgsFor(own, expr.turbofish, expr.methodSpan, expr.method);
      found.typeArgs.splice(fn.parentParamCount, own.length, ...written);
    }
    this.checkReceiverAdjust(expr, found.adjust);
    const sig = this.instantiate(fn, found.typeArgs, expr.methodSpan);
    if (expr.args.length !== sig.params.length) {
      compileError(
        expr.methodSpan,
        `メソッド ${expr.method} の引数の数が合いません（${sig.params.length} 個ですが、${expr.args.length} 個あります）。`
      );
    }
    if (expected) this.unifier.tryUnify(sig.ret, expected);
    this.args(expr.args, sig.params);
    this.annotations.methods.set(expr, { fn, typeArgs: found.typeArgs, receiver: found.adjust });
    if (fn.selfMode === 'value') this.checkMoveOutOfRef(expr, found.adjust, found.selfType);
    return sig.ret;
  }

  private noMethod(expr: Extract<Expr, { kind: 'methodCall' }>, receiverType: Type): never {
    const t = typeToString(resolve(receiverType));
    const fieldType = this.fieldTypeOf(receiverType, expr.method);
    if (fieldType) {
      compileError(
        expr.methodSpan,
        `${expr.method} はフィールドです。フィールドの関数を呼ぶには (x.${expr.method})(...) と書きます。`
      );
    }
    const hints: Record<string, string> = {
      length: '（長さは len() です）',
      size: '（長さは len() です）',
      charAt: '（文字は chars().nth(i) で取り出します）',
      equals: '（比べるには == を使います）',
      toString: '（to_string() です）',
      toUpperCase: '（to_uppercase() です）',
      push_back: '（Vec では push です）',
      add: '（Vec では push です）',
      append: '',
    };
    compileError(expr.methodSpan, `${t} にメソッド ${expr.method} がありません${hints[expr.method] ?? ''}。`);
  }

  private fieldTypeOf(type: Type, name: string): Type | undefined {
    for (const step of autoderefSteps(this.program, type)) {
      const t = shallow(step.type);
      if (t.kind === 'adt' && t.def.kind === 'struct') {
        const field = t.def.variants[0]?.fields.find((f) => f.name === name);
        if (field) return field.type;
      }
    }
    return undefined;
  }

  /** Taking `self` by value through a reference moves out of it, which only `Copy` types allow. */
  private checkMoveOutOfRef(expr: Extract<Expr, { kind: 'methodCall' }>, adjust: ReceiverAdjust, selfType: Type): void {
    if (adjust.autoref !== 'none' || adjust.rangeToIter) return;
    const throughRef = adjust.derefs.some((step) => step === 'ref' || step === 'mutRef');
    if (!throughRef) return;
    this.deferredChecks.push(() => {
      if (!this.solver.isCopy(resolve(selfType, true))) {
        compileError(
          expr.methodSpan,
          `参照の先の値は動かせないので、メソッド ${expr.method}（self を受け取る）を呼べません（.clone() で複製するか、参照のまま使えるメソッドを使ってください）。`
        );
      }
    });
  }

  /** `&mut self` methods need a mutable place: a `mut` variable, or a place reached through `&mut`. */
  private checkReceiverAdjust(expr: Extract<Expr, { kind: 'methodCall' }>, adjust: ReceiverAdjust): void {
    const needsMut =
      adjust.autoref === 'mut' || (adjust.autoref === 'none' && adjust.derefs.at(-1) === 'mutRef' && false);
    if (!needsMut) return;
    const lastRef = adjust.derefs.lastIndexOf('mutRef');
    const sharedAfter = adjust.derefs.slice(lastRef + 1).includes('ref');
    if (adjust.derefs.includes('ref') && (lastRef === -1 || sharedAfter)) {
      compileError(
        expr.receiver.span,
        `& の参照を通しては、メソッド ${expr.method}（&mut self を受け取る）を呼べません（&mut の参照にしてください）。`
      );
    }
    if (lastRef !== -1) return;
    this.requireMutablePlace(expr.receiver, `メソッド ${expr.method} で書き換える`);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Places and mutability

  /** Requires a place to be mutable: rooted in a `mut` variable or behind a `&mut` reference. */
  requireMutablePlace(place: Expr, purpose: string): void {
    const root = this.placeRoot(place);
    if (root.kind === 'temporary') return;
    if (root.kind === 'sharedRef') {
      compileError(place.span, `& の参照の先は書き換えられません（${purpose}には &mut の参照が要ります）。`);
    }
    if (root.kind === 'mutRef') return;
    const { local } = root;
    if (local.mutable) return;
    if (local.mode === 'refMut') return;
    if (local.mode === 'ref') {
      compileError(place.span, `${local.name} は参照なので、書き換えられません。`);
    }
    const isWhole = place.kind === 'path';
    if (isWhole && purpose === '代入する') {
      // Assigning a variable declared without an initializer is its initialization, which the borrow checker checks.
      return;
    }
    compileError(
      place.span,
      `変数 ${local.name} は mut ではないので、${isWhole ? '書き換えられません' : '中身を書き換えられません'}（let mut ${local.name} と宣言してください）。`
    );
  }

  /** What a place expression is rooted in, looking through fields, indexes, and derefs. */
  // code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of place.
  private placeRoot(
    place: Expr
  ): { kind: 'local'; local: LocalVar } | { kind: 'mutRef' } | { kind: 'sharedRef' } | { kind: 'temporary' } {
    switch (place.kind) {
      case 'path': {
        const res = this.annotations.paths.get(place);
        if (res?.kind === 'local' || res?.kind === 'capture') {
          const type = shallow(res.local.type);
          void type;
          return { kind: 'local', local: res.local };
        }
        return { kind: 'temporary' };
      }
      case 'field': {
        const field = this.annotations.fields.get(place);
        return this.throughDerefs(place.operand, field?.derefs ?? []);
      }
      case 'index': {
        const index = this.annotations.indexes.get(place);
        if (index?.container === 'map') return { kind: 'sharedRef' };
        return this.throughDerefs(place.operand, index?.derefs ?? []);
      }
      case 'unary': {
        if (place.op !== '*') return { kind: 'temporary' };
        const type = normalize(shallow(place.operand.ty ?? UNIT));
        if (type.kind === 'ref') return type.mutable ? { kind: 'mutRef' } : { kind: 'sharedRef' };
        return this.placeRoot(place.operand);
      }
      case 'methodCall': {
        const type = normalize(shallow(place.ty ?? UNIT));
        if (type.kind === 'ref') return type.mutable ? { kind: 'mutRef' } : { kind: 'sharedRef' };
        return { kind: 'temporary' };
      }
      default: {
        return { kind: 'temporary' };
      }
    }
  }

  private throughDerefs(operand: Expr, derefs: ('ref' | 'mutRef' | 'own')[]): ReturnType<Checker['placeRoot']> {
    const lastRef = derefs.findLastIndex((step) => step !== 'own');
    if (lastRef !== -1) {
      if (derefs.slice(0, lastRef + 1).includes('ref')) return { kind: 'sharedRef' };
      return { kind: 'mutRef' };
    }
    return this.placeRoot(operand);
  }

  private isPlaceExpr(expr: Expr): boolean {
    if (expr.kind === 'path') {
      const res = this.annotations.paths.get(expr);
      return res?.kind === 'local' || res?.kind === 'capture' || res?.kind === 'discard';
    }
    if (expr.kind === 'field' || expr.kind === 'index') return true;
    return expr.kind === 'unary' && expr.op === '*';
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Operators

  private unary(expr: Extract<Expr, { kind: 'unary' }>, expected: Type | undefined): Type {
    if (expr.op === '*') {
      const type = normalize(shallow(this.expr(expr.operand, undefined)));
      if (type.kind === 'ref') return type.target;
      if (type.kind === 'adt' && type.def.builtin === 'Box') return type.args[0];
      if (type.kind === 'var') compileError(expr.span, '型が決まらないので、* で参照をたどれません。');
      compileError(expr.span, `${typeToString(resolve(type))} は参照ではないので、* でたどれません。`);
    }
    const operandType = this.expr(expr.operand, expected);
    const t = this.numericOperand(operandType);
    if (expr.op === '!') {
      if (t.kind === 'bool' || t.kind === 'int' || (t.kind === 'var' && t.v.literal === 'int')) return t;
      compileError(expr.span, `${typeToString(resolve(operandType))} に ! は使えません。`);
    }
    if (t.kind === 'int' && t.name.startsWith('u')) {
      compileError(expr.span, `符号のない整数（${t.name}）に - は使えません。`);
    }
    if (t.kind === 'int' || t.kind === 'float' || (t.kind === 'var' && t.v.literal)) return t;
    if (t.kind === 'var') return t;
    return compileError(expr.span, `${typeToString(resolve(operandType))} に - は使えません。`);
  }

  /** The type arithmetic sees: numbers through one reference, as Rust's impls for `&i32` allow. */
  private numericOperand(type: Type): Type {
    const t = normalize(shallow(type));
    if (t.kind === 'ref') {
      const target = normalize(shallow(t.target));
      if (target.kind === 'int' || target.kind === 'float' || (target.kind === 'var' && target.v.literal))
        return target;
      if (target.kind === 'ref') return this.numericOperand(target);
    }
    return t;
  }

  // code-gauge-allow functionCognitiveComplexity 40 -- Follows Rust's impls of the operator traits.
  private binary(expr: Extract<Expr, { kind: 'binary' }>, expected: Type | undefined): Type {
    const { op } = expr;
    if (op === '&&' || op === '||') {
      this.coerceExpr(expr.left, BOOL);
      this.coerceExpr(expr.right, BOOL);
      return BOOL;
    }
    if (['==', '!=', '<', '<=', '>', '>='].includes(op)) return this.comparison(expr);
    const isArithmetic = ['+', '-', '*', '/', '%'].includes(op);
    const leftType = this.expr(
      expr.left,
      isArithmetic || op === '&' || op === '|' || op === '^' ? expected : undefined
    );
    const left = this.numericOperand(leftType);
    if (op === '+' && left.kind === 'adt' && left.def.builtin === 'String') {
      this.coerceExpr(expr.right, REF_STR);
      return left;
    }
    if (op === '+' && (left.kind === 'str' || (normalize(shallow(leftType)).kind === 'ref' && isStrLike(leftType)))) {
      compileError(
        expr.opSpan,
        '&str どうしは + でつなげません（String::from("...") + "..." や format! を使ってください）。'
      );
    }
    if (op === '<<' || op === '>>') {
      const rightType = this.numericOperand(this.expr(expr.right, undefined));
      if (!isIntegral(left) || !isIntegral(rightType)) this.badOperands(expr, leftType, expr.right.ty as Type);
      return left;
    }
    const rightType = this.expr(expr.right, left.kind === 'var' && !left.v.literal ? undefined : left);
    const right = this.numericOperand(rightType);
    if ((op === '&' || op === '|' || op === '^') && left.kind === 'bool') {
      this.unifyOrError(expr.right.span, BOOL, right);
      return BOOL;
    }
    if (!isArithmeticOperand(left) || !isArithmeticOperand(right)) this.badOperands(expr, leftType, rightType);
    if (!this.unifier.tryUnify(left, right)) {
      compileError(
        expr.opSpan,
        `${typeToString(resolve(leftType))} と ${typeToString(resolve(rightType))} は、${op} で計算できません（型をそろえてください。as で変換できます）。`
      );
    }
    const result = shallow(left);
    if (result.kind === 'float' && (op === '&' || op === '|' || op === '^'))
      this.badOperands(expr, leftType, rightType);
    if (result.kind === 'var' && !result.v.literal) {
      this.deferredChecks.push(() => {
        const final = shallow(resolve(result, true));
        if (final.kind !== 'int' && final.kind !== 'float') this.badOperands(expr, leftType, rightType);
      });
    }
    return result;
  }

  private badOperands(expr: Extract<Expr, { kind: 'binary' }>, left: Type, right: Type): never {
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

  private comparison(expr: Extract<Expr, { kind: 'binary' }>): Type {
    const leftType = this.expr(expr.left, undefined);
    const l = normalize(shallow(leftType));
    const rightType = this.expr(expr.right, l.kind === 'var' && !l.v.literal ? undefined : leftType);
    const r = normalize(shallow(rightType));
    const isEquality = expr.op === '==' || expr.op === '!=';
    // String-like types compare with each other (`String == &str`), and sequences with each other (`Vec == [T; N]`).
    if (
      isStringLike(l) &&
      isStringLike(r) &&
      stringDepth(l) !== stringDepth(r) &&
      Math.abs(stringDepth(l) - stringDepth(r)) <= 1
    ) {
      return BOOL;
    }
    if (isEquality && this.sequencesCompare(l, r)) return BOOL;
    if (!this.unifier.tryUnify(leftType, rightType)) {
      const lt = typeToString(resolve(leftType));
      const rt = typeToString(resolve(rightType));
      const lr = l.kind === 'ref' ? normalize(shallow(l.target)) : l;
      const rr = r.kind === 'ref' ? normalize(shallow(r.target)) : r;
      if (this.unifier.tryUnify(lr, rr)) {
        compileError(
          expr.opSpan,
          `${lt} と ${rt} は ${expr.op} で比べられません（* で参照をたどるか、& を付けて、型をそろえてください）。`
        );
      }
      compileError(expr.opSpan, `${lt} と ${rt} は ${expr.op} で比べられません（型をそろえてください）。`);
    }
    this.requireTrait(leftType, isEquality ? 'PartialEq' : 'PartialOrd', expr.opSpan);
    return BOOL;
  }

  /** Whether two sequence types compare with `==` though they differ: a `Vec`, an array, or a slice, by reference alike. */
  private sequencesCompare(left: Type, right: Type): boolean {
    const a = sequenceElem(left);
    const b = sequenceElem(right);
    if (!a || !b) return false;
    const aVec = normalize(shallow(stripAll(left)));
    const bVec = normalize(shallow(stripAll(right)));
    const aIsVec = aVec.kind === 'adt';
    const bIsVec = bVec.kind === 'adt';
    // `Vec<T> == &[U]` and `[T; N] == [U]` compare, as do equal depths of references.
    const depthsMatch =
      a.depth === b.depth ||
      (aIsVec && !bIsVec && b.depth === a.depth + 1) ||
      (bIsVec && !aIsVec && a.depth === b.depth + 1);
    if (!depthsMatch) return false;
    if (!this.unifier.tryUnify(a.elem, b.elem)) return false;
    this.requireTrait(a.elem, 'PartialEq', { row: 0, col: 1 });
    return true;
  }

  private assign(expr: Extract<Expr, { kind: 'assign' }>): Type {
    const { target } = expr;
    if (target.kind === 'path' && target.path.segments.length === 1 && target.path.segments[0].name === '_') {
      this.annotations.paths.set(target, { kind: 'discard' });
      this.expr(expr.value, undefined);
      return UNIT;
    }
    const targetType = this.expr(target, undefined);
    if (!this.isPlaceExpr(target)) compileError(target.span, '代入の左辺には、変数やフィールドなどを書いてください。');
    this.coerceExpr(expr.value, targetType);
    this.requireMutablePlace(target, '代入する');
    return UNIT;
  }

  private compoundAssign(expr: Extract<Expr, { kind: 'compoundAssign' }>): Type {
    const targetType = this.expr(expr.target, undefined);
    if (!this.isPlaceExpr(expr.target))
      compileError(expr.target.span, '代入の左辺には、変数やフィールドなどを書いてください。');
    const t = normalize(shallow(targetType));
    if (expr.op === '+' && t.kind === 'adt' && t.def.builtin === 'String') {
      this.coerceExpr(expr.value, REF_STR);
    } else if (expr.op === '<<' || expr.op === '>>') {
      const r = this.numericOperand(this.expr(expr.value, undefined));
      if (!isIntegral(t) || !isIntegral(r))
        compileError(expr.span, `${typeToString(resolve(targetType))} に ${expr.op}= は使えません。`);
    } else {
      const valueType = this.expr(expr.value, t.kind === 'var' && !t.v.literal ? undefined : t);
      const v = this.numericOperand(valueType);
      const numeric = t.kind === 'int' || t.kind === 'float' || t.kind === 'var';
      const boolOp = t.kind === 'bool' && ['&', '|', '^'].includes(expr.op);
      if ((!numeric && !boolOp) || !this.unifier.tryUnify(t, v)) {
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
    }
    this.requireMutablePlace(expr.target, '書き換える');
    return UNIT;
  }

  private refExpr(expr: Extract<Expr, { kind: 'ref' }>, expected: Type | undefined): Type {
    const e = expected ? normalize(shallow(expected)) : undefined;
    let inner = e?.kind === 'ref' ? e.target : undefined;
    if (inner && shallow(inner).kind === 'slice' && expr.operand.kind !== 'index') inner = undefined;
    if (inner && shallow(inner).kind === 'str') inner = undefined;
    if (inner && shallow(inner).kind === 'dyn') inner = undefined;
    const type = this.expr(expr.operand, inner);
    if (expr.mutable) this.requireMutablePlace(expr.operand, '&mut で借りる');
    return ref(type, expr.mutable);
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- Follows Rust's rules for `as`.
  private cast(expr: Extract<Expr, { kind: 'cast' }>): Type {
    const target = this.lowerType(expr.type);
    const sourceType = this.expr(expr.operand, undefined);
    const s = normalize(shallow(sourceType));
    const t = normalize(shallow(target));
    const ok = (): Type => target;
    if (s.kind === 'var' && s.v.literal === 'int' && t.kind === 'int') {
      return ok();
    }
    if (isNumber(s) && isNumber(t)) return ok();
    if ((s.kind === 'bool' || s.kind === 'char') && t.kind === 'int') return ok();
    if (s.kind === 'int' && s.name === 'u8' && t.kind === 'char') return ok();
    if (s.kind === 'var' && s.v.literal === 'int' && t.kind === 'char') {
      this.unifier.unify(s, intType('u8'));
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
    if (this.unifier.tryUnify(s, t)) return ok();
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

  // -------------------------------------------------------------------------------------------------------------------
  // Fields, indexes, structs

  private field(expr: Extract<Expr, { kind: 'field' }>): Type {
    const operandType = this.expr(expr.operand, undefined);
    for (const step of autoderefSteps(this.program, operandType)) {
      const t = normalize(shallow(step.type));
      if (t.kind === 'var')
        compileError(
          expr.span,
          `型が決まらないので、フィールド ${expr.name} を読めません（変数の型を書いてください）。`
        );
      if (t.kind === 'tuple' && /^\d+$/.test(expr.name)) {
        const index = Number(expr.name);
        if (index >= t.elems.length) compileError(expr.nameSpan, `タプルに ${index} 番目の要素はありません。`);
        this.annotations.fields.set(expr, { derefs: step.derefs, index, range: false });
        return t.elems[index];
      }
      if (t.kind === 'adt' && t.def.kind === 'struct') {
        const variant = t.def.variants[0];
        const index = variant?.fields.findIndex((field) => field.name === expr.name) ?? -1;
        if (index < 0) continue;
        const field = variant.fields[index];
        this.checkFieldVisible(t.def, field, expr.nameSpan);
        const subst = new Map(t.def.params.map((param, i) => [param, t.args[i]]));
        this.annotations.fields.set(expr, {
          derefs: step.derefs,
          index,
          range: RANGE_TYPES.has(t.def.builtin as string),
        });
        return substitute(field.type, subst);
      }
    }
    const t = typeToString(resolve(operandType));
    const method = lookupMethod(this.program, this.solver, operandType, expr.name);
    if (method && method !== 'ambiguous') {
      compileError(expr.nameSpan, `${expr.name} はメソッドなので、${expr.name}() と書いてください。`);
    }
    return compileError(expr.nameSpan, `${t} にフィールド ${expr.name} がありません。`);
  }

  private checkFieldVisible(def: AdtDef, field: { name: string; isPublic: boolean }, span: Span): void {
    if (field.isPublic) return;
    const module = def.module as Module | undefined;
    if (!module || module.isStd) {
      if (module?.isStd) compileError(span, `${def.name} のフィールド ${field.name} は非公開です。`);
      return;
    }
    if (!module.namedModule.isAncestorOf(this.body.module.namedModule)) {
      compileError(span, `${def.name} のフィールド ${field.name} は非公開です（pub が付いていません）。`);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- One case per indexable type.
  private index(expr: Extract<Expr, { kind: 'index' }>): Type {
    const operandType = this.expr(expr.operand, undefined);
    let previous: Type | undefined;
    for (const step of autoderefSteps(this.program, operandType)) {
      const t = normalize(shallow(step.type));
      const overloaded =
        previous?.kind === 'adt' && (previous.def.builtin === 'Vec' || previous.def.builtin === 'String');
      previous = t;
      if (t.kind === 'var')
        compileError(expr.span, '型が決まらないので、[ ] で要素を取り出せません（変数の型を書いてください）。');
      const isSequence = t.kind === 'slice' || t.kind === 'array';
      const isStr = t.kind === 'str';
      const isDeque = t.kind === 'adt' && t.def.builtin === 'VecDeque';
      const isMap = t.kind === 'adt' && (t.def.builtin === 'HashMap' || t.def.builtin === 'BTreeMap');
      if (!isSequence && !isStr && !isDeque && !isMap) continue;
      if (isMap) {
        const keyType = t.args[0];
        const indexType = this.expr(expr.index, ref(keyType));
        const it = normalize(shallow(indexType));
        if (it.kind !== 'ref')
          compileError(expr.index.span, `HashMap の [ ] には、キーの参照（&key）を書いてください。`);
        this.require(keyType, { trait: this.program.traitDef('Borrow'), args: [it.target] }, expr.index.span);
        this.annotations.indexes.set(expr, { container: 'map', range: false, derefs: step.derefs, overloaded: true });
        return t.args[1];
      }
      const indexType = this.expr(expr.index, USIZE);
      const it = normalize(shallow(indexType));
      if (it.kind === 'adt' && RANGE_TYPES.has(it.def.builtin as string)) {
        if (it.args[0]) this.unifyOrError(expr.index.span, USIZE, it.args[0]);
        this.annotations.indexes.set(expr, {
          container: isStr ? 'str' : 'slice',
          range: true,
          derefs: step.derefs,
          overloaded,
        });
        if (isDeque) compileError(expr.span, 'VecDeque は範囲で切り出せません。');
        return isStr ? STR : { kind: 'slice', elem: (t as { elem: Type }).elem };
      }
      if (isStr) {
        compileError(
          expr.span,
          '文字列は [i] で1文字を取り出せません（s.chars().nth(i) か、s.as_bytes()[i] を使ってください）。'
        );
      }
      if (!this.unifier.tryUnify(indexType, USIZE)) {
        compileError(
          expr.index.span,
          `添字は usize にしてください（${typeToString(resolve(indexType))} です。as usize で変換できます）。`
        );
      }
      this.annotations.indexes.set(expr, {
        container: isDeque ? 'vecDeque' : 'slice',
        range: false,
        derefs: step.derefs,
        overloaded: overloaded || isDeque,
      });
      if (isDeque) return (t as { args: Type[] }).args[0];
      return (t as { elem: Type }).elem;
    }
    return compileError(expr.span, `${typeToString(resolve(operandType))} は [ ] で要素を取り出せません。`);
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Follows Rust's checks of struct expressions.
  private structExpr(expr: Extract<Expr, { kind: 'struct' }>, expected: Type | undefined): Type {
    const { def, variant, typeArgs } = this.resolveStructPath(expr.path, expr.span);
    const self = adt(def, typeArgs);
    if (expected) this.unifier.tryUnify(self, expected);
    const subst = new Map(def.params.map((param, index) => [param, typeArgs[index]]));
    const variantDef = def.variants[variant];
    if (variantDef.shape === 'unit' && expr.fields.length > 0) {
      compileError(expr.span, `${variantDef.name} にはフィールドがありません。`);
    }
    const seen = new Set<string>();
    for (const field of expr.fields) {
      const index = variantDef.fields.findIndex((f) => f.name === field.name);
      if (index === -1) compileError(field.span, `${variantDef.name} にフィールド ${field.name} がありません。`);
      if (seen.has(field.name)) compileError(field.span, `フィールド ${field.name} が2回あります。`);
      seen.add(field.name);
      if (def.kind === 'struct') this.checkFieldVisible(def, variantDef.fields[index], field.span);
      this.coerceExpr(field.value, substitute(variantDef.fields[index].type, subst));
    }
    this.annotations.paths.set(expr, { kind: 'ctor', def, variant, typeArgs });
    if (expr.base) {
      if (def.kind === 'enum') compileError(expr.base.span, '列挙子には .. を書けません。');
      this.coerceExpr(expr.base, self);
      return self;
    }
    const missing = variantDef.fields.filter((field) => !seen.has(field.name)).map((field) => field.name);
    if (missing.length > 0) {
      compileError(expr.span, `${variantDef.name} のフィールド ${missing.join(', ')} の値が足りません。`);
    }
    return self;
  }

  private resolveStructPath(path: PathAst, span: Span): { def: AdtDef; variant: number; typeArgs: Type[] } {
    const names = path.segments.map((segment) => segment.name);
    const last = path.segments.at(-1)!;
    if (names.length === 1 && names[0] === 'Self') {
      const self = this.body.selfType ? shallow(this.body.selfType) : undefined;
      if (self?.kind !== 'adt') compileError(span, 'Self は、impl やトレイトの中にだけ書けます。');
      return { def: self.def, variant: 0, typeArgs: self.args };
    }
    if (names.length > 1) {
      try {
        const owner = this.resolvePrefix(path.segments.slice(0, -1), span);
        if (owner.kind === 'type') {
          const t = normalize(shallow(owner.type));
          if (t.kind === 'adt' && t.def.kind === 'enum') {
            const variant = t.def.variants.find((v) => v.name === last.name);
            if (!variant) compileError(span, `${t.def.name} に列挙子 ${last.name} がありません。`);
            return { def: t.def, variant: variant.index, typeArgs: t.args };
          }
        }
      } catch (error) {
        if (!(error instanceof Error) || !('diagnostics' in error)) throw error;
      }
    }
    const binding =
      names.length === 1
        ? lookupType(this.body.module, names[0], span)
        : resolveTypePath(names, this.body.module, span);
    if (binding?.kind === 'adt' && binding.def.kind === 'struct') {
      return {
        def: binding.def,
        variant: 0,
        typeArgs: this.typeArgsFor(binding.def.params, last.args, span, binding.def.name),
      };
    }
    if (binding?.kind === 'alias') {
      const type = normalize(shallow(binding.resolve()));
      if (type.kind === 'adt') return { def: type.def, variant: 0, typeArgs: type.args };
    }
    const value = names.length === 1 ? lookupValue(this.body.module, names[0], span) : undefined;
    if (value?.kind === 'ctor') {
      return { def: value.def, variant: value.variant, typeArgs: value.def.params.map(() => freshVar()) };
    }
    return compileError(span, `構造体 ${names.join('::')} が見つかりません。`);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Closures and `?`

  private closure(expr: Extract<Expr, { kind: 'closure' }>, expected: Type | undefined): Type {
    const e = expected ? shallow(expected) : undefined;
    const expectedSig = e?.kind === 'fn' ? e : undefined;
    const parentBody = this.body;
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
    const retType = expr.ret ? this.lowerType(expr.ret) : (expectedSig?.ret ?? freshVar());
    if (expectedSig && expectedSig.params.length !== expr.params.length) {
      compileError(expr.span, `クロージャの引数の数が合いません（${expectedSig.params.length} 個が必要です）。`);
    }
    const paramTypes = expr.params.map((param, index) =>
      param.type ? this.lowerType(param.type) : (expectedSig?.params[index] ?? freshVar())
    );
    if (expectedSig) {
      for (const [index, type] of paramTypes.entries())
        this.unifyOrError(expr.params[index].span, expectedSig.params[index], type);
    }
    const closureType = newClosureType(paramTypes, retType);
    this.body = {
      ...parentBody,
      fn,
      retType,
      loops: parentBody.loops,
      scopes: [...parentBody.scopes, new Map()],
      isClosure: true,
    };
    try {
      const params = expr.params.map((param, index) => {
        this.checkPattern(param.pattern, paramTypes[index], 'move');
        return param.pattern;
      });
      void params;
      this.coerceExpr(expr.body, retType);
    } finally {
      this.body = parentBody;
    }
    const kind = closureKindOf(fn, expr.body, this.annotations, this.solver);
    fn.closureKind = kind;
    (closureType as { closure: { kind: string } }).closure.kind = kind;
    this.annotations.closures.set(expr, {
      context: fn,
      params: expr.params.flatMap((param) =>
        this.annotations.bindings.get(param.pattern) ? [this.annotations.bindings.get(param.pattern)!] : []
      ),
    });
    return closureType;
  }

  private tryExpr(expr: Extract<Expr, { kind: 'try' }>): Type {
    const operand = normalize(shallow(this.expr(expr.operand, undefined)));
    const ret = normalize(shallow(this.body.retType));
    if (operand.kind !== 'adt' || (operand.def.builtin !== 'Result' && operand.def.builtin !== 'Option')) {
      compileError(expr.span, `? は Result か Option の値にだけ使えます（${typeToString(resolve(operand))} です）。`);
    }
    const where = this.body.isClosure ? 'クロージャ' : '関数';
    if (operand.def.builtin === 'Option') {
      if (ret.kind === 'var') this.unifier.unify(ret, this.program.builtinType('Option', [freshVar()]));
      const r = normalize(shallow(this.body.retType));
      if (r.kind !== 'adt' || r.def.builtin !== 'Option') {
        compileError(expr.span, `Option に ? を使うには、${where}が Option を返すようにしてください。`);
      }
      this.annotations.tries.set(expr, { kind: 'option', errorFrom: undefined, errorTo: undefined });
      return operand.args[0];
    }
    if (ret.kind === 'var') this.unifier.unify(ret, this.program.builtinType('Result', [freshVar(), operand.args[1]]));
    const r = normalize(shallow(this.body.retType));
    if (r.kind !== 'adt' || r.def.builtin !== 'Result') {
      compileError(
        expr.span,
        `Result に ? を使うには、${where}が Result を返すようにしてください（main なら fn main() -> Result<(), String> など）。`
      );
    }
    const from = operand.args[1];
    const to = r.args[1];
    if (!this.unifier.tryUnify(from, to)) {
      this.require(to, { trait: this.program.traitDef('From'), args: [from] }, expr.span);
    }
    this.annotations.tries.set(expr, { kind: 'result', errorFrom: from, errorTo: to });
    return operand.args[0];
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Macros

  // code-gauge-allow functionCognitiveComplexity 30 -- One case per macro.
  private macro(expr: Expr, macro: MacroCall, expected: Type | undefined): Type {
    switch (macro.kind) {
      case 'print': {
        if (macro.format) this.formatArgs(macro.format);
        return UNIT;
      }
      case 'format': {
        this.formatArgs(macro.format);
        return this.program.builtinType('String');
      }
      case 'write': {
        const target = normalize(shallow(this.expr(macro.target, undefined)));
        const inner = target.kind === 'ref' ? normalize(shallow(target.target)) : target;
        const isFormatter = inner.kind === 'adt' && inner.def.builtin === 'Formatter';
        const isString = inner.kind === 'adt' && inner.def.builtin === 'String';
        if (!isFormatter && !isString) {
          compileError(
            macro.target.span,
            `write! の書き込み先は、fmt::Formatter か String にしてください（${typeToString(resolve(target))} です）。`
          );
        }
        if (isString)
          this.requireMutablePlace(
            macro.target.kind === 'ref' ? macro.target.operand : macro.target,
            'write! で書き込む'
          );
        if (macro.format) this.formatArgs(macro.format);
        return this.program.builtinType('Result', [UNIT, this.program.builtinType('FmtError')]);
      }
      case 'panic': {
        if (macro.format) this.formatArgs(macro.format);
        return NEVER;
      }
      case 'assert': {
        this.coerceExpr(macro.cond, BOOL);
        if (macro.format) this.formatArgs(macro.format);
        return UNIT;
      }
      case 'assertEq': {
        const left = this.expr(macro.left, undefined);
        const right = this.expr(macro.right, left);
        if (
          !this.unifier.tryUnify(left, right) &&
          !(isStringLike(normalize(shallow(left))) && isStringLike(normalize(shallow(right)))) &&
          !this.sequencesCompare(left, right)
        ) {
          this.mismatch(macro.right.span, left, right);
        }
        this.requireTrait(left, 'PartialEq', macro.left.span);
        this.requireTrait(left, 'Debug', macro.left.span);
        if (macro.format) this.formatArgs(macro.format);
        return UNIT;
      }
      case 'vec': {
        const e = expected ? normalize(shallow(expected)) : undefined;
        const elem = e?.kind === 'adt' && e.def.builtin === 'Vec' ? e.args[0] : freshVar();
        this.elements(macro.elems, elem);
        return this.program.builtinType('Vec', [elem]);
      }
      case 'vecRepeat': {
        const e = expected ? normalize(shallow(expected)) : undefined;
        const elem = e?.kind === 'adt' && e.def.builtin === 'Vec' ? e.args[0] : freshVar();
        this.coerceExpr(macro.value, elem);
        this.coerceExpr(macro.count, USIZE);
        this.requireTrait(elem, 'Clone', macro.value.span);
        return this.program.builtinType('Vec', [elem]);
      }
      case 'matches': {
        const type = this.expr(macro.value, undefined);
        this.withScope(() => this.checkPattern(macro.pattern, type, 'move'));
        return BOOL;
      }
      case 'dbg': {
        const types = macro.args.map((arg) => {
          const type = this.expr(arg, undefined);
          this.requireTrait(type, 'Debug', arg.span);
          return type;
        });
        void expr;
        if (types.length === 1) return types[0];
        return { kind: 'tuple', elems: types };
      }
    }
  }

  private formatArgs(format: FormatArgs): void {
    for (const piece of format.pieces) {
      if (typeof piece === 'string') continue;
      const arg = format.args[piece.arg];
      const type = arg.ty ?? this.expr(arg, undefined);
      const trait = {
        display: 'Display',
        debug: 'Debug',
        lowerHex: 'LowerHex',
        upperHex: 'UpperHex',
        octal: 'Octal',
        binary: 'Binary',
        lowerExp: 'LowerExp',
        upperExp: 'UpperExp',
      }[piece.trait];
      if (trait === 'Display' || trait === 'Debug') this.requireTrait(type, trait, arg.span);
      else this.requireFormatTrait(type, trait, arg.span);
      for (const count of [piece.width, piece.precision]) {
        if (count?.kind === 'arg') {
          const countArg = format.args[count.arg];
          const countType = countArg.ty ?? this.expr(countArg, USIZE);
          this.unifyOrError(countArg.span, USIZE, countType);
        }
      }
    }
    for (const arg of format.args) if (!arg.ty) this.expr(arg, undefined);
  }

  private requireFormatTrait(type: Type, trait: string, span: Span): void {
    this.deferredChecks.push(() => {
      let t = normalize(shallow(resolve(type, true)));
      while (t.kind === 'ref') t = normalize(shallow(t.target));
      const ok = trait.endsWith('Exp') ? t.kind === 'int' || t.kind === 'float' : t.kind === 'int';
      if (!ok)
        compileError(
          span,
          `${typeToString(resolve(type))} は {:${{ LowerHex: 'x', UpperHex: 'X', Octal: 'o', Binary: 'b', LowerExp: 'e', UpperExp: 'E' }[trait]}} で表示できません。`
        );
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Patterns

  /**
   * Checks a pattern against the type of the value it matches, declaring its bindings. Matching a reference with a
   * pattern that is not a reference pattern looks through it and binds by reference, as Rust's match ergonomics do.
   */
  // code-gauge-allow functionCognitiveComplexity 40 -- One case per kind of pattern.
  checkPattern(pattern: Pattern, type: Type, mode: LocalVar['mode']): void {
    pattern.ty = type;
    let t = normalize(shallow(type));
    let bindingMode = mode;
    const derefForMatch = (): void => {
      while (t.kind === 'ref') {
        bindingMode = t.mutable && bindingMode !== 'ref' ? 'refMut' : 'ref';
        t = normalize(shallow(t.target));
      }
    };
    switch (pattern.kind) {
      case 'wild': {
        return;
      }
      case 'binding': {
        const binding = this.patternBindingRes(pattern);
        if (binding) {
          this.annotations.paths.set(pattern, binding);
          derefForMatch();
          this.checkConstPattern(pattern, binding, t);
          return;
        }
        const localType = bindingMode === 'move' ? type : ref(t, bindingMode === 'refMut');
        const existing = this.orBindings?.get(pattern.name);
        if (existing) {
          this.unifyOrError(pattern.span, existing.type, localType);
          this.annotations.bindings.set(pattern, existing);
          (this.body.scopes.at(-1) as Map<string, LocalVar>).set(pattern.name, existing);
          return;
        }
        const local = this.declareLocal(pattern.name, localType, pattern.mutable, pattern.span, bindingMode);
        if (pattern.mutable && bindingMode !== 'move') {
          compileError(pattern.span, '参照に合わせたパターンの名前には、mut を付けられません。');
        }
        this.annotations.bindings.set(pattern, local);
        if (pattern.sub) this.checkPattern(pattern.sub, type, mode);
        return;
      }
      case 'lit': {
        derefForMatch();
        const litType = this.expr(pattern.expr, t);
        if (pattern.expr.kind === 'str') {
          if (t.kind === 'adt' && t.def.builtin === 'String') {
            compileError(
              pattern.span,
              'String は文字列のリテラルのパターンと比べられません（.as_str() で &str にしてください）。'
            );
          }
          if (t.kind === 'str') {
            return;
          }
        }
        this.unifyOrError(pattern.span, t, litType);
        return;
      }
      case 'tuple': {
        derefForMatch();
        if (t.kind === 'var') {
          const elems = pattern.elems.map(() => freshVar());
          this.unifier.unify(t, { kind: 'tuple', elems });
          t = normalize(shallow(t));
        }
        if (t.kind !== 'tuple' || t.elems.length !== pattern.elems.length) {
          compileError(
            pattern.span,
            `パターンの型が合いません（${typeToString(resolve(type))} にタプルのパターンは合いません）。`
          );
        }
        for (const [index, elem] of pattern.elems.entries()) {
          this.checkPattern(
            elem,
            bindingMode === 'move' ? t.elems[index] : ref(t.elems[index], bindingMode === 'refMut'),
            bindingMode === 'move' ? mode : 'move'
          );
          this.fixBindingMode(elem, bindingMode);
        }
        return;
      }
      case 'tupleStruct':
      case 'struct':
      case 'path': {
        derefForMatch();
        this.adtPattern(pattern, t, type, bindingMode, mode);
        return;
      }
      case 'ref': {
        if (t.kind === 'var') {
          const inner = freshVar();
          this.unifier.unify(t, ref(inner, pattern.mutable));
          t = normalize(shallow(t));
        }
        if (t.kind !== 'ref')
          compileError(
            pattern.span,
            `& のパターンは、参照にだけ合います（${typeToString(resolve(type))} は参照ではありません）。`
          );
        if (pattern.mutable !== t.mutable) {
          compileError(
            pattern.span,
            `パターンの型が合いません（${typeToString(resolve(type))} に ${pattern.mutable ? '&mut' : '&'} のパターンは合いません）。`
          );
        }
        if (mode !== 'move') compileError(pattern.span, '参照に合わせたパターンの中には、& のパターンを書けません。');
        const target = t.target;
        this.checkPattern(pattern.pattern, target, 'move');
        this.deferredChecks.push(() => {
          if (
            pattern.pattern.kind === 'binding' &&
            !this.annotations.paths.has(pattern.pattern) &&
            !this.solver.isCopy(resolve(target, true))
          ) {
            compileError(
              pattern.span,
              `& のパターンで取り出すと値が動くので、${typeToString(resolve(target))} には使えません（& を外してください）。`
            );
          }
        });
        return;
      }
      case 'or': {
        const outer = this.orBindings;
        this.orBindings = new Map();
        try {
          for (const [index, alternative] of pattern.alternatives.entries()) {
            const before = new Set(this.body.fn.locals);
            this.checkPattern(alternative, type, mode);
            if (index === 0) {
              for (const local of this.body.fn.locals) if (!before.has(local)) this.orBindings.set(local.name, local);
            } else {
              const names = new Set(collectBindingNames(alternative));
              for (const name of this.orBindings.keys()) {
                if (!names.has(name))
                  compileError(alternative.span, `| のどちらのパターンにも、${name} を書いてください。`);
              }
            }
          }
        } finally {
          this.orBindings = outer;
        }
        return;
      }
    }
  }

  private orBindings: Map<string, LocalVar> | undefined;

  /** Subpatterns of a tuple matched by reference already have their types as references. */
  private fixBindingMode(_pattern: Pattern, _mode: LocalVar['mode']): void {}

  /** A single name in a pattern that names a unit variant, a unit struct, or a constant, rather than a new binding. */
  private patternBindingRes(pattern: Extract<Pattern, { kind: 'binding' }>): PathRes | undefined {
    if (pattern.sub || pattern.mutable) return undefined;
    const binding = lookupValue(this.body.module, pattern.name, pattern.span);
    if (!binding) return undefined;
    if (binding.kind === 'ctor') {
      const variant = binding.def.variants[binding.variant];
      if (variant.shape !== 'unit') {
        compileError(
          pattern.span,
          `${variant.name} はフィールドを持つので、${variant.name}(..) の形で書いてください。`
        );
      }
      return {
        kind: 'ctor',
        def: binding.def,
        variant: binding.variant,
        typeArgs: binding.def.params.map(() => freshVar()),
      };
    }
    if (binding.kind === 'const') return { kind: 'const', def: binding.def };
    return undefined;
  }

  private checkConstPattern(pattern: Pattern, res: PathRes, t: Type): void {
    if (res.kind === 'ctor') {
      this.unifyOrError(pattern.span, t, adt(res.def, res.typeArgs));
    } else if (res.kind === 'const') {
      this.unifyOrError(pattern.span, t, res.def.type);
      this.requireTrait(res.def.type, 'PartialEq', pattern.span);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of ADT pattern.
  private adtPattern(
    pattern: Extract<Pattern, { kind: 'tupleStruct' | 'struct' | 'path' }>,
    t: Type,
    original: Type,
    bindingMode: LocalVar['mode'],
    mode: LocalVar['mode']
  ): void {
    let res: PathRes;
    if (pattern.kind === 'struct') {
      const found = this.resolveStructPath(pattern.path, pattern.span);
      res = { kind: 'ctor', ...found };
    } else {
      res = this.resolveValuePath(pattern.path, pattern.span);
    }
    this.annotations.paths.set(pattern, res);
    if (pattern.kind === 'path') {
      if (res.kind === 'const') {
        this.unifyOrError(pattern.span, t, res.def.type);
        return;
      }
      if (res.kind !== 'ctor' || res.def.variants[res.variant].shape !== 'unit') {
        compileError(pattern.span, `${pattern.path.segments.map((s) => s.name).join('::')} はパターンに書けません。`);
      }
      this.unifyOrError(pattern.span, t, adt(res.def, res.typeArgs));
      return;
    }
    if (res.kind !== 'ctor') {
      compileError(
        pattern.span,
        `${pattern.path.segments.map((s) => s.name).join('::')} は列挙子や構造体ではありません。`
      );
    }
    const self = adt(res.def, res.typeArgs);
    if (!this.unifier.tryUnify(t, self)) {
      compileError(
        pattern.span,
        `パターンの型が合いません（${typeToString(resolve(original))} に ${res.def.name} のパターンは合いません）。`
      );
    }
    const variant = res.def.variants[res.variant];
    const subst = new Map(res.def.params.map((param, index) => [param, res.typeArgs[index]]));
    const fieldType = (index: number): Type => {
      const type = substitute(variant.fields[index].type, subst);
      return bindingMode === 'move' ? type : ref(type, bindingMode === 'refMut');
    };
    const subMode = bindingMode === 'move' ? mode : 'move';
    if (pattern.kind === 'tupleStruct') {
      if (variant.shape !== 'tuple')
        compileError(pattern.span, `${variant.name} は ${variant.name}(..) の形では書けません。`);
      if (pattern.elems.length !== variant.fields.length) {
        compileError(
          pattern.span,
          `${variant.name} のパターンの要素の数が合いません（${variant.fields.length} 個です）。`
        );
      }
      for (const [index, elem] of pattern.elems.entries()) this.checkPattern(elem, fieldType(index), subMode);
      return;
    }
    if (variant.shape !== 'named')
      compileError(pattern.span, `${variant.name} は ${variant.name} { .. } の形では書けません。`);
    const seen = new Set<string>();
    for (const field of pattern.fields) {
      const index = variant.fields.findIndex((f) => f.name === field.name);
      if (index === -1) compileError(field.span, `${variant.name} にフィールド ${field.name} がありません。`);
      seen.add(field.name);
      if (res.def.kind === 'struct') this.checkFieldVisible(res.def, variant.fields[index], field.span);
      this.checkPattern(field.pattern, fieldType(index), subMode);
    }
    const missing = variant.fields.filter((f) => !seen.has(f.name));
    if (missing.length > 0) {
      compileError(pattern.span, `パターンにフィールド ${missing.map((f) => f.name).join(', ')} が足りません。`);
    }
  }
}

function lookupValueIn(module: Module, name: string, span: Span): ValueBinding | undefined {
  return lookupValue(module, name, span);
}

function collectBindingNames(pattern: Pattern): string[] {
  switch (pattern.kind) {
    case 'binding': {
      return [pattern.name, ...(pattern.sub ? collectBindingNames(pattern.sub) : [])];
    }
    case 'tuple':
    case 'tupleStruct': {
      return pattern.elems.flatMap(collectBindingNames);
    }
    case 'struct': {
      return pattern.fields.flatMap((field) => collectBindingNames(field.pattern));
    }
    case 'ref': {
      return collectBindingNames(pattern.pattern);
    }
    case 'or': {
      return collectBindingNames(pattern.alternatives[0]);
    }
    default: {
      return [];
    }
  }
}

function isArithmeticOperand(t: Type): boolean {
  return t.kind === 'int' || t.kind === 'float' || t.kind === 'var';
}

function isNumber(t: Type): boolean {
  return t.kind === 'int' || t.kind === 'float' || (t.kind === 'var' && t.v.literal !== undefined);
}

/** The elements of a sequence type (an array, a slice, or a `Vec`) and the references around it. */
function sequenceElem(type: Type): { depth: number; elem: Type } | undefined {
  let t = normalize(shallow(type));
  let depth = 0;
  while (t.kind === 'ref') {
    depth++;
    t = normalize(shallow(t.target));
  }
  if (t.kind === 'array' || t.kind === 'slice') return { depth, elem: t.elem };
  if (t.kind === 'adt' && (t.def.builtin === 'Vec' || t.def.builtin === 'VecDeque')) return { depth, elem: t.args[0] };
  return undefined;
}

function stripAll(type: Type): Type {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  return t;
}

function isStringLike(type: Type): boolean {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  return t.kind === 'str' || (t.kind === 'adt' && t.def.builtin === 'String');
}

function isStrLike(type: Type): boolean {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  return t.kind === 'str';
}

/** How many references a string-like type has, counting `str` as one (`&str` and `String` compare as peers). */
function stringDepth(type: Type): number {
  let t = normalize(shallow(type));
  let depth = 0;
  while (t.kind === 'ref') {
    depth++;
    t = normalize(shallow(t.target));
  }
  return t.kind === 'str' ? depth - 1 : depth;
}

function isIntegral(type: Type): boolean {
  const t = normalize(shallow(type));
  return t.kind === 'int' || (t.kind === 'var' && t.v.literal === 'int');
}

/** The closure trait a closure implements, from how its body uses the variables it captures. */
function closureKindOf(
  fn: FnContext,
  body: Expr,
  annotations: Annotations,
  solver: TraitSolver
): 'Fn' | 'FnMut' | 'FnOnce' {
  let kind: 'Fn' | 'FnMut' | 'FnOnce' = 'Fn';
  const captured = new Set(fn.captures);
  const isCaptured = (expr: Expr): boolean => {
    let current = expr;
    while (current.kind === 'field' || current.kind === 'index') current = current.operand;
    if (current.kind !== 'path') return false;
    const res = annotations.paths.get(current);
    return res?.kind === 'capture' && captured.has(res.local);
  };
  const visit = (expr: Expr | undefined): void => {
    if (!expr) return;
    const mutates =
      ((expr.kind === 'assign' || expr.kind === 'compoundAssign') && isCaptured(expr.target)) ||
      (expr.kind === 'ref' && expr.mutable && isCaptured(expr.operand)) ||
      (expr.kind === 'methodCall' &&
        annotations.methods.get(expr)?.receiver.autoref === 'mut' &&
        isCaptured(expr.receiver)) ||
      (expr.kind === 'macro' &&
        expr.macro.kind === 'write' &&
        isCaptured(expr.macro.target.kind === 'ref' ? expr.macro.target.operand : expr.macro.target));
    if (mutates && kind === 'Fn') kind = 'FnMut';
    if (expr.kind === 'methodCall') {
      const method = annotations.methods.get(expr);
      if (
        method?.fn.selfMode === 'value' &&
        method.receiver.autoref === 'none' &&
        expr.receiver.kind === 'path' &&
        isCaptured(expr.receiver)
      ) {
        const type = resolve(expr.receiver.ty ?? UNIT, true);
        if (!solver.isCopy(type)) kind = 'FnOnce';
      }
    }
    forEachChild(expr, visit);
  };
  visit(body);
  void closureKindAtLeast;
  return kind;
}

/** Calls `visit` on each expression directly inside `expr`, without entering nested closures. */
// code-gauge-allow functionCognitiveComplexity 60 -- One case per kind of expression.
export function forEachChild(expr: Expr, visit: (child: Expr) => void): void {
  const block = (b: Block): void => {
    for (const stmt of b.stmts) {
      if (stmt.kind === 'let') {
        if (stmt.init) visit(stmt.init);
        if (stmt.else) block(stmt.else);
      } else if (stmt.kind === 'expr') visit(stmt.expr);
    }
    if (b.tail) visit(b.tail);
  };
  const condition = (cond: Condition): void => visit(cond.kind === 'expr' ? cond.expr : cond.value);
  const format = (f: FormatArgs | undefined): void => {
    for (const arg of f?.args ?? []) visit(arg);
  };
  switch (expr.kind) {
    case 'unary':
    case 'ref':
    case 'cast':
    case 'try': {
      visit(expr.operand);
      return;
    }
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
      visit(expr.target);
      visit(expr.value);
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
      block(expr);
      return;
    }
    case 'if': {
      condition(expr.cond);
      block(expr.consequent);
      if (expr.else) visit(expr.else);
      return;
    }
    case 'match': {
      visit(expr.scrutinee);
      for (const arm of expr.arms) visit(arm.body);
      return;
    }
    case 'loop': {
      block(expr.body);
      return;
    }
    case 'while': {
      condition(expr.cond);
      block(expr.body);
      return;
    }
    case 'for': {
      visit(expr.iterable);
      block(expr.body);
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
      switch (macro.kind) {
        case 'print':
        case 'panic': {
          format(macro.format);
          return;
        }
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

export { hasParams, deepNormalize, allSupertraits, derefOnce };
