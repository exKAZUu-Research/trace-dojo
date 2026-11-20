// code-gauge-allow-file fileNcss 958 -- Lowers each kind of expression to the points and regions rustc's MIR gives it.
import type { ExecutionBudget } from '../interpreter/limits';
import type { Annotations, FnContext, LocalVar, MethodRes } from './annotations';
import type { Block, Condition, Expr, FormatArgs, Pattern, Span, Stmt } from './ast';
import { patternBindings } from './astWalk';
import { normalize } from './infer';
import { capturedPlaces } from './loanCaptures';
import {
  type Access,
  type AccessKind,
  type Loan,
  type LoanError,
  LoanGraph,
  type Place,
  type Point,
  type Var,
} from './loanGraph';
import {
  derefSteps,
  dropSlots,
  elementLayout,
  fieldLayout,
  isNone,
  type Layout,
  layoutOf,
  NONE,
  type Outlives,
  outlivesAll,
  ownedDerefLayout,
  regionsOf,
  relate,
  type RVar,
  typeAfter,
} from './regions';
import { SignatureInstance } from './signatureInstance';
import type { TraitSolver } from './traits';
import { type ClosureType, type FnDef, resolve, shallow, type Type } from './types';

/** The temporary that holds a value with borrows, or undefined for a value without any. */
type Value = Var | undefined;

/**
 * Which regions of a closure's parameters its result may hold: `[param, region of the param, region of the result]`;
 * `captures` lists the regions of the result that may hold borrows of what the closure captures.
 */
interface ClosureSummary {
  edges: [number, number, number][];
  captures: number[];
  /** The closure's body, where rustc reports a result that outlives its parameters' borrows. */
  body: Span;
}

/** What the builders of a function and of the closures in it share. */
interface LoanCheck {
  budget: ExecutionBudget;
  errors: LoanError[];
}

interface Shared extends LoanCheck {
  summaries: Map<ClosureType, ClosureSummary>;
}

/** How a pattern binds variables: by value, or by a shared or a mutable reference (match ergonomics). */
type BindingMode = 'shared' | 'mut' | undefined;

/** What binding a pattern does at one point. */
interface Binding {
  accesses: Access[];
  gens: Loan[];
  defs: Var[];
  /** Relations of regions, which need the layouts of the bound variables. */
  relations: (() => void)[];
  dropSources: { into: Var; from: Place }[];
}

interface LoopFrame {
  label: string | undefined;
  head: number;
  breaks: number[];
  result: Value;
  scopeDepth: number;
}

/**
 * Lowers a function's body to a {@link LoanGraph} in the order rustc evaluates it, with a region for each reference in
 * the types of its variables, and checks it as rustc's NLL borrow checker does.
 */
export class LoanBuilder {
  private readonly graph: LoanGraph;
  private readonly layouts: Layout[] = [];
  private current: number | undefined;
  private readonly vars = new Map<LocalVar, Var>();
  private readonly locals = new Map<Var, LocalVar>();
  private readonly loops: LoopFrame[] = [];
  private readonly scopes: { locals: LocalVar[]; end: Span }[] = [];
  private readonly exits: number[] = [];
  /** For a closure's body, the captures it modifies, which the closure captures by `&mut`. */
  private readonly mutatedCaptures = new Set<LocalVar>();
  private readonly typedReferenceReads = new Set<Expr>();
  private returnVar: Var = -1;
  private staticRegion: RVar | undefined;

  private constructor(
    private readonly annotations: Annotations,
    private readonly solver: TraitSolver,
    private readonly context: FnContext,
    private readonly shared: Shared
  ) {
    this.graph = new LoanGraph(shared.budget);
  }

  /** Checks a function's body, reporting the conflicts of borrows to `errors`. */
  static checkFn(
    annotations: Annotations,
    solver: TraitSolver,
    context: FnContext,
    fn: { params: Pattern[]; body: Block; ret: Type; end: Span },
    check: LoanCheck
  ): void {
    const builder = new LoanBuilder(annotations, solver, context, { ...check, summaries: new Map() });
    const params = fn.params.map((pattern) => ({ pattern, type: pattern.ty }));
    builder.build(params, fn.body, fn.ret, fn.end);
  }

  /**
   * Builds and checks a body whose parameters (and `self`) hold their arguments at the entry, returning the variables
   * that hold the parameters.
   */
  private build(params: { pattern: Pattern; type: Type | undefined }[], body: Expr, ret: Type, end: Span): Var[] {
    this.current = this.graph.newPoint();
    this.returnVar = this.newVar('{return}', ret);
    this.makeUniversal(this.returnVar);
    const receiver = this.context.locals.filter((local) => local.isSelf);
    const defs = receiver.map((local) => this.universalLocal(local));
    const parameterLocals = [
      ...receiver,
      ...params.flatMap(({ pattern }) => patternBindings(pattern, this.annotations)),
    ];
    const destructured: [Pattern, Var][] = [];
    const paramVars = params.map(({ pattern, type }) => {
      const local = pattern.kind === 'binding' && !pattern.sub ? this.annotations.bindings.get(pattern) : undefined;
      if (local) return this.universalLocal(local);
      const v = this.newVar('{param}', type);
      this.makeUniversal(v);
      destructured.push([pattern, v]);
      return v;
    });
    this.point({ defs: [...defs, ...paramVars] });
    for (const [pattern, v] of destructured) this.bind(pattern, { root: v, proj: [] });
    this.store(this.value(body), this.returnVar);
    if (this.current !== undefined) this.exits.push(this.current);
    this.join(this.exits);
    this.endLocals(parameterLocals, end);
    this.checkStaticInputs([...defs, ...paramVars], body.span);
    this.graph.check(this.shared.errors);
    return paramVars;
  }

  private checkStaticInputs(inputs: Var[], span: Span): void {
    const root = this.staticRegion;
    if (root === undefined || inputs.length === 0) return;
    const reachable = new Set([root]);
    const edges = new Map<RVar, RVar[]>();
    this.shared.budget.spend(this.graph.outlives.length);
    for (const [sup, sub] of this.graph.outlives) {
      const destinations = edges.get(sub);
      if (destinations) destinations.push(sup);
      else edges.set(sub, [sup]);
    }
    for (const region of reachable) for (const next of edges.get(region) ?? []) reachable.add(next);
    if (
      inputs.some((input) => this.graph.varRegions[input].some((region) => region !== root && reachable.has(region)))
    ) {
      this.shared.errors.push({
        span,
        message: "引数から借りた参照を、この 'static が必要なトレイトオブジェクトには保存できません。",
      });
    }
  }

  private universalLocal(local: LocalVar): Var {
    const v = this.varOf(local);
    this.makeUniversal(v);
    return v;
  }

  private makeUniversal(v: Var): void {
    for (const region of this.graph.varRegions[v]) this.graph.universal.add(region);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Points, variables, and regions

  private readonly outlives: Outlives = (sup, sub) => {
    if (sup !== sub) this.graph.outlives.push([sup, sub]);
  };

  private readonly fresh = (): RVar => this.graph.newRegion();

  private point(fields: Partial<Omit<Point, 'succ'>>): number {
    const index = this.graph.newPoint();
    Object.assign(this.graph.points[index], fields);
    if (this.current !== undefined) this.graph.points[this.current].succ.push(index);
    this.current = index;
    for (const access of fields.accesses ?? []) {
      if (access.kind === 'write' || access.kind === 'deep') this.noteMutation(access.place);
    }
    for (const loan of fields.gens ?? []) {
      loan.point = index;
      if (loan.mutable) this.noteMutation(loan.place);
    }
    return index;
  }

  private noteMutation(place: Place): void {
    const local = this.locals.get(place.root);
    if (local && this.context.captures.includes(local)) this.mutatedCaptures.add(local);
  }

  /** Continues from any of the given points, or nowhere when none is reachable. */
  private join(preds: (number | undefined)[]): void {
    const reached = preds.filter((pred) => pred !== undefined);
    if (reached.length === 0) {
      this.current = undefined;
      return;
    }
    const index = this.graph.newPoint();
    for (const pred of reached) this.graph.points[pred].succ.push(index);
    this.current = index;
  }

  /** The region of `'static`, which contains every point. */
  private static(): RVar {
    if (this.staticRegion === undefined) {
      this.staticRegion = this.fresh();
      this.graph.universal.add(this.staticRegion);
    }
    return this.staticRegion;
  }

  private newVar(name: string, type: Type | undefined): Var {
    return this.newVarWithLayout(
      name,
      layoutOf(type, this.fresh, () => this.static())
    );
  }

  private newVarWithLayout(name: string, layout: Layout): Var {
    const v = this.graph.newVar(name);
    this.layouts[v] = layout;
    this.graph.varRegions[v] = regionsOf(layout);
    return v;
  }

  /** A temporary for a value of a type, or undefined when the type holds no borrows. */
  private temp(type: Type | undefined): Value {
    const layout = layoutOf(type, this.fresh, () => this.static());
    return isNone(layout) ? undefined : this.newVarWithLayout('{temp}', layout);
  }

  private layout(value: Value): Layout {
    return value === undefined ? NONE : this.layouts[value];
  }

  /** Moves a value into a variable (a temporary, or the result of a branch or a block). */
  private store(value: Value, into: Value): void {
    if (value === undefined && into === undefined) return;
    this.point({ uses: value === undefined ? [] : [value], defs: into === undefined ? [] : [into] });
    relate(this.outlives, this.layout(value), this.layout(into));
  }

  private varOf(local: LocalVar): Var {
    let v = this.vars.get(local);
    if (v === undefined) {
      v = this.newVar(local.name, local.type);
      const slots = dropSlots(local.type);
      if (slots.length > 0) this.graph.dropLive.set(v, slots);
      this.vars.set(local, v);
      this.locals.set(v, local);
      if (this.context.captures.includes(local)) this.makeUniversal(v);
    }
    return v;
  }

  private storageDead(local: LocalVar, end: Span): Access {
    return { place: { root: this.varOf(local), proj: [] }, kind: 'storageDead', span: end };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Places

  /** The place an expression denotes, evaluating the indexes in it, or undefined for an expression that is no place. */
  private place(expr: Expr): Place | undefined {
    switch (expr.kind) {
      case 'path': {
        const res = this.annotations.paths.get(expr);
        if (res?.kind !== 'local' && res?.kind !== 'capture') return undefined;
        return { root: this.varOf(res.local), proj: [] };
      }
      case 'field': {
        const base = this.placeOrTemp(expr.operand);
        const derefs = derefSteps(this.annotations.fields.get(expr)?.derefs);
        return { root: base.root, proj: [...base.proj, ...derefs, expr.name] };
      }
      case 'index': {
        const base = this.placeOrTemp(expr.operand);
        this.value(expr.index);
        const derefs = derefSteps(this.annotations.indexes.get(expr)?.derefs);
        return { root: base.root, proj: [...base.proj, ...derefs, '[]'] };
      }
      case 'unary': {
        if (expr.op !== '*') return undefined;
        const base = this.placeOrTemp(expr.operand);
        return { root: base.root, proj: [...base.proj, isReference(expr.operand.ty) ? '*' : '#'] };
      }
      default: {
        return undefined;
      }
    }
  }

  /** The place an expression denotes, or a temporary that holds its value. */
  private placeOrTemp(expr: Expr): Place {
    return this.place(expr) ?? this.valuePlace(this.value(expr));
  }

  private valuePlace(value: Value): Place {
    if (value !== undefined) return { root: value, proj: [] };
    const temp = this.newVarWithLayout('{temp}', NONE);
    this.point({ defs: [temp] });
    return { root: temp, proj: [] };
  }

  /** The layouts of a place and of each place it projects from, the place's own last. */
  private placeLayouts(place: Place): Layout[] {
    const layouts = [this.layouts[place.root]];
    for (const elem of place.proj) layouts.push(this.project(layouts.at(-1) as Layout, elem));
    return layouts;
  }

  private placeLayout(place: Place): Layout {
    return this.placeLayouts(place).at(-1) as Layout;
  }

  private project(layout: Layout, elem: string): Layout {
    switch (elem) {
      case '*': {
        return layout.kind === 'ref' ? layout.target : layout.kind === 'opaque' ? layout : NONE;
      }
      case '#': {
        return ownedDerefLayout(layout);
      }
      case '[]': {
        return elementLayout(layout);
      }
      default: {
        if (layout.kind === 'tuple') return layout.elems[Number(elem)] ?? NONE;
        if (layout.kind !== 'adt') return layout.kind === 'opaque' ? layout : NONE;
        const [variant, field] = fieldIndex(layout, elem);
        return fieldLayout(layout, variant, field, () => this.static());
      }
    }
  }

  /** Reads a place by value, copying or moving it. */
  private read(place: Place, type: Type | undefined, span: Span, kind: AccessKind = this.readKind(type)): Value {
    const temp = this.temp(type);
    this.point({ uses: [place.root], defs: temp === undefined ? [] : [temp], accesses: [{ place, kind, span }] });
    relate(this.outlives, this.placeLayout(place), this.layout(temp));
    return temp;
  }

  private readKind(type: Type | undefined): AccessKind {
    return this.isCopy(type) ? 'read' : 'move';
  }

  /**
   * Borrows a place of type `target` into a temporary; a two-phase borrow waits for its activation to become mutable.
   */
  private borrow(
    place: Place,
    mutable: boolean,
    span: Span,
    target: Type | undefined,
    twoPhase = false
  ): { value: Var; loan: Loan } {
    const region = this.fresh();
    const targetLayout = layoutOf(target, this.fresh);
    const temp = this.newVarWithLayout('{temp}', { kind: 'ref', region, mutable, target: targetLayout });
    const loan: Loan = { place, mutable, region, span, point: -1 };
    if (twoPhase) loan.activation = Number.POSITIVE_INFINITY;
    const kind = mutable && !twoPhase ? 'deep' : 'read';
    this.point({ uses: [place.root], defs: [temp], accesses: [{ place, kind, span }], gens: [loan] });
    this.relateBorrow(place, mutable, targetLayout, region);
    return { value: temp, loan };
  }

  /**
   * A borrow of a place for `region` refers to the place's value, whose borrows must outlive it, and keeps the
   * references it goes through valid, up to the first shared one, as rustc's reborrows do.
   */
  private relateBorrow(place: Place, mutable: boolean, target: Layout, region: RVar): void {
    const layouts = this.placeLayouts(place);
    relate(this.outlives, layouts.at(-1) as Layout, target, mutable);
    outlivesAll(this.outlives, target, region);
    for (let index = place.proj.length - 1; index >= 0; index--) {
      if (place.proj[index] !== '*') continue;
      const base = layouts[index];
      if (base.kind !== 'ref' && base.kind !== 'opaque') break;
      this.outlives(base.region, region);
      if (base.kind === 'opaque' || !base.mutable) break;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Statements

  private block(block: Block): Value {
    const locals: LocalVar[] = [];
    return this.withinScope(locals, { row: block.endRow, col: 0 }, () => {
      for (const stmt of block.stmts) {
        this.stmt(stmt);
        if (stmt.kind === 'let') locals.push(...patternBindings(stmt.pattern, this.annotations));
      }
      return block.tail ? this.value(block.tail) : undefined;
    });
  }

  private withinScope<T>(locals: LocalVar[], end: Span, body: () => T): T {
    this.scopes.push({ locals, end });
    try {
      const result = body();
      this.endScopes(this.scopes.length - 1);
      return result;
    } finally {
      this.scopes.pop();
    }
  }

  private endScopes(first: number): void {
    if (this.current === undefined) return;
    for (let index = this.scopes.length - 1; index >= first; index--) {
      const { locals, end } = this.scopes[index];
      this.endLocals(locals, end);
    }
  }

  private endLocals(locals: LocalVar[], end: Span): void {
    let pending: Access[] = [];
    for (const local of locals.toReversed()) {
      const access = this.storageDead(local, end);
      pending.push(access);
      if (this.graph.dropLive.has(access.place.root)) {
        this.point({ accesses: pending });
        pending = [];
      }
    }
    if (pending.length > 0) this.point({ accesses: pending });
  }

  private patternScope<T>(pattern: Pattern | undefined, body: Expr, visit: () => T): T {
    if (!pattern) return visit();
    const locals = patternBindings(pattern, this.annotations);
    const end = body.kind === 'block' ? { row: body.endRow, col: 0 } : body.span;
    return this.withinScope(locals, end, visit);
  }

  private stmt(stmt: Stmt): void {
    if (stmt.kind === 'expr') {
      this.value(stmt.expr);
      return;
    }
    if (stmt.kind !== 'let' || !stmt.init) return;
    const { pattern, init } = stmt;
    if (stmt.type?.kind === 'ref' && isReference(init.ty)) this.typedReferenceReads.add(init);
    // `let (a, b) = (x, y);` binds each element from its own expression.
    if (pattern.kind === 'tuple' && init.kind === 'tuple' && pattern.elems.length === init.elems.length) {
      const values = init.elems.map((elem) => this.value(elem));
      for (const [index, elem] of pattern.elems.entries()) this.bind(elem, this.valuePlace(values[index]));
      return;
    }
    const source = this.annotatedReborrow(stmt) ?? this.source(init);
    if (stmt.else) {
      const before = this.current;
      this.block(stmt.else);
      this.current = before;
    }
    this.bind(pattern, source);
  }

  /** `let r2: &mut T = r;` reborrows `*r` where a plain `let r2 = r;` would move `r`. */
  private annotatedReborrow(stmt: Extract<Stmt, { kind: 'let' }>): Place | undefined {
    if (stmt.type?.kind !== 'ref' || !stmt.type.mutable || !stmt.init || !isMutReference(stmt.init.ty))
      return undefined;
    const place = this.place(stmt.init);
    if (!place) return undefined;
    return this.valuePlace(this.borrow(project(place, '*'), true, stmt.init.span, refTarget(stmt.init.ty)).value);
  }

  /** What a pattern matching an expression matches: the place it denotes, or a temporary with its value. */
  private source(expr: Expr): Place {
    return this.place(expr) ?? this.valuePlace(this.value(expr));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Patterns

  /** Binds a pattern's variables, moving, copying, or borrowing the parts of the place they bind. */
  private bind(pattern: Pattern, source: Place): void {
    const binding: Binding = { accesses: [], gens: [], defs: [], relations: [], dropSources: [] };
    this.bindPart(binding, pattern, source, undefined);
    const kills = binding.defs.map((root): Place => ({ root, proj: [] }));
    const at = this.point({
      uses: [source.root],
      defs: binding.defs,
      accesses: binding.accesses,
      gens: binding.gens,
      kills,
    });
    for (const { into, from } of binding.dropSources) this.storeDrop(at, { root: into, proj: [] }, from);
    for (const relation of binding.relations) relation();
  }

  private storeDrop(at: number, into: Place, from: Place): void {
    for (const proj of this.graph.dropLive.get(into.root) ?? []) {
      if (!into.proj.every((part, index) => part === proj[index])) continue;
      const remainder = proj.slice(into.proj.length);
      const regions = regionsOf(this.placeLayout({ root: from.root, proj: [...from.proj, ...remainder] }));
      if (regions.length > 0) this.graph.dropStores.push({ point: at, place: { root: into.root, proj }, regions });
    }
  }

  /** Binds a part of a pattern to a place, which bindings take by reference in the binding mode `byRef`. */
  // code-gauge-allow functionNcss 33 -- One case per kind of pattern.
  private bindPart(binding: Binding, p: Pattern, place: Place, byRef: BindingMode): void {
    switch (p.kind) {
      case 'binding': {
        this.bindVariable(binding, p, place, byRef);
        if (p.sub) this.bindPart(binding, p.sub, place, byRef);
        return;
      }
      case 'tuple':
      case 'tupleStruct': {
        const [sub, mode] = matchDeref(p, place, byRef);
        const prefix = p.kind === 'tuple' ? '' : `${this.variantOf(p)}:`;
        for (const [index, elem] of p.elems.entries())
          this.bindPart(binding, elem, project(sub, `${prefix}${index}`), mode);
        return;
      }
      case 'struct': {
        const [sub, mode] = matchDeref(p, place, byRef);
        const variant = this.variantOf(p);
        for (const field of p.fields) {
          this.bindPart(binding, field.pattern, project(sub, `${variant}:${field.name}`), mode);
        }
        return;
      }
      case 'ref': {
        this.bindPart(binding, p.pattern, project(place, '*'), undefined);
        return;
      }
      case 'or': {
        for (const alternative of p.alternatives) this.bindPart(binding, alternative, place, byRef);
        return;
      }
      case 'lit':
      case 'path': {
        binding.accesses.push({ place: matchDeref(p, place, byRef)[0], kind: 'read', span: p.span });
        return;
      }
      case 'wild': {
        return;
      }
    }
  }

  /** A variable of a pattern borrows the place it binds in a binding mode by reference, and copies or moves it else. */
  private bindVariable(binding: Binding, p: Pattern, place: Place, mode: BindingMode): void {
    const local = this.annotations.bindings.get(p);
    if (!local) {
      binding.accesses.push({ place, kind: 'read', span: p.span });
      return;
    }
    const v = this.varOf(local);
    binding.defs.push(v);
    if (!mode) {
      binding.accesses.push({ place, kind: this.readKind(local.type), span: p.span });
      binding.relations.push(() => relate(this.outlives, this.placeLayout(place), this.layouts[v]));
      if (this.graph.dropLive.has(v)) binding.dropSources.push({ into: v, from: place });
      return;
    }
    const layout = this.layouts[v];
    const mutable = mode === 'mut';
    const region = layout.kind === 'ref' ? layout.region : this.fresh();
    binding.gens.push({ place, mutable, region, span: p.span, point: -1 });
    binding.accesses.push({ place, kind: mutable ? 'deep' : 'read', span: p.span });
    const target = layout.kind === 'ref' ? layout.target : NONE;
    binding.relations.push(() => this.relateBorrow(place, mutable, target, region));
  }

  private variantOf(pattern: Pattern): number {
    const res = this.annotations.paths.get(pattern);
    return res?.kind === 'ctor' ? res.variant : 0;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Expressions

  /** Evaluates an expression for its value, moving or copying the place it denotes. */
  private value(expr: Expr): Value {
    const mutable = this.annotations.referenceArguments.get(expr);
    if (mutable !== undefined && isMutReference(expr.ty)) {
      const place = this.place(expr);
      if (place) return this.borrow(project(place, '*'), mutable, expr.span, refTarget(expr.ty)).value;
    }
    return this.valueInner(expr);
  }

  // code-gauge-allow functionNcss 60 -- One case per kind of expression.
  private valueInner(expr: Expr): Value {
    switch (expr.kind) {
      case 'path':
      case 'field':
      case 'index': {
        const place = this.place(expr);
        return place ? this.read(place, expr.ty, expr.span) : undefined;
      }
      case 'unary': {
        if (expr.op === '*') return this.read(this.place(expr) as Place, expr.ty, expr.span);
        this.value(expr.operand);
        return undefined;
      }
      case 'ref': {
        const place = this.place(expr.operand);
        if (!place) return this.borrowTemporary(expr);
        return this.borrow(place, expr.mutable, expr.span, expr.operand.ty).value;
      }
      case 'binary': {
        return this.binary(expr);
      }
      case 'assign':
      case 'compoundAssign': {
        this.assign(expr);
        return undefined;
      }
      case 'cast': {
        return this.cast(expr);
      }
      case 'try': {
        return this.tryExpr(expr);
      }
      case 'call': {
        return this.call(expr);
      }
      case 'methodCall': {
        return this.methodCall(expr);
      }
      case 'struct': {
        return this.structExpr(expr);
      }
      case 'tuple':
      case 'array':
      case 'arrayRepeat':
      case 'range': {
        return this.aggregateExpr(expr);
      }
      case 'block': {
        return this.block(expr);
      }
      case 'if': {
        return this.ifExpr(expr);
      }
      case 'match': {
        return this.match(expr);
      }
      case 'loop':
      case 'while':
      case 'for': {
        return this.loopExpr(expr);
      }
      case 'break':
      case 'continue':
      case 'return': {
        this.jump(expr);
        return undefined;
      }
      case 'closure': {
        return this.closure(expr);
      }
      case 'macro': {
        return this.macro(expr);
      }
      default: {
        return undefined;
      }
    }
  }

  private cast(expr: Extract<Expr, { kind: 'cast' }>): Value {
    const operand = this.value(expr.operand);
    const result = this.temp(expr.ty);
    this.store(operand, result);
    return result;
  }

  private aggregateExpr(expr: Extract<Expr, { kind: 'tuple' | 'array' | 'arrayRepeat' | 'range' }>): Value {
    switch (expr.kind) {
      case 'tuple': {
        return this.aggregate(
          expr.elems.map((elem) => this.value(elem)),
          expr.ty,
          tupleElem
        );
      }
      case 'array': {
        return this.aggregate(
          expr.elems.map((elem) => this.value(elem)),
          expr.ty,
          elementLayout
        );
      }
      case 'arrayRepeat': {
        const value = this.annotations.unevaluatedRepeatOperands.has(expr.value) ? undefined : this.value(expr.value);
        this.value(expr.count);
        return this.aggregate([value], expr.ty, elementLayout);
      }
      case 'range': {
        const values = [expr.start, expr.end].map((bound) => (bound ? this.value(bound) : undefined));
        return this.aggregate(values, expr.ty, (layout) => (layout.kind === 'adt' ? (layout.args[0] ?? NONE) : NONE));
      }
    }
  }

  private loopExpr(expr: Extract<Expr, { kind: 'loop' | 'while' | 'for' }>): Value {
    switch (expr.kind) {
      case 'loop': {
        return this.loop(expr.label, expr.ty, () => this.block(expr.body));
      }
      case 'while': {
        const pattern = expr.cond.kind === 'let' ? expr.cond.pattern : undefined;
        return this.loop(expr.label, undefined, () => {
          this.patternScope(pattern, expr.body, () => {
            const exit = this.condition(expr.cond);
            if (exit !== undefined) this.loops.at(-1)?.breaks.push(exit);
            this.block(expr.body);
          });
        });
      }
      case 'for': {
        return this.forLoop(expr);
      }
    }
  }

  /** `break`, `continue`, and `return` go on elsewhere, after which nothing runs. */
  // code-gauge-allow functionCognitiveComplexity 18 -- Each kind of jump goes on at its own point.
  private jump(expr: Extract<Expr, { kind: 'break' | 'continue' | 'return' }>): void {
    const value = expr.kind !== 'continue' && expr.value ? this.value(expr.value) : undefined;
    if (expr.kind === 'return') {
      this.store(value, this.returnVar);
      this.endScopes(0);
      if (this.current !== undefined) this.exits.push(this.current);
    } else {
      const loop = this.findLoop(expr.label);
      if (expr.kind === 'break' && loop?.result !== undefined) this.store(value, loop.result);
      if (loop) this.endScopes(loop.scopeDepth);
      if (loop && this.current !== undefined) {
        if (expr.kind === 'break') loop.breaks.push(this.current);
        else this.graph.points[this.current].succ.push(loop.head);
      }
    }
    this.current = undefined;
  }

  /** `&expr` of a value that is no place borrows a temporary, which holds the value's borrows. */
  private borrowTemporary(expr: Extract<Expr, { kind: 'ref' }>): Value {
    const value = this.value(expr.operand);
    const temp = this.temp(expr.ty);
    const layout = this.layout(temp);
    this.point({ uses: value === undefined ? [] : [value], defs: temp === undefined ? [] : [temp] });
    const target = layout.kind === 'ref' ? layout.target : NONE;
    relate(this.outlives, this.layout(value), target);
    if (layout.kind === 'ref') outlivesAll(this.outlives, target, layout.region);
    return temp;
  }

  private tryExpr(expr: Extract<Expr, { kind: 'try' }>): Value {
    const operand = this.value(expr.operand);
    // The error leaves the function.
    const at = this.point({ uses: operand === undefined ? [] : [operand] });
    this.endScopes(0);
    if (this.current !== undefined) this.exits.push(this.current);
    this.current = at;
    const result = this.temp(expr.ty);
    if (result === undefined) return undefined;
    this.point({ uses: operand === undefined ? [] : [operand], defs: [result] });
    const layout = this.layout(operand);
    relate(this.outlives, layout.kind === 'adt' ? (layout.args[0] ?? NONE) : layout, this.layout(result));
    return result;
  }

  private binary(expr: Extract<Expr, { kind: 'binary' }>): Value {
    if (expr.op === '&&' || expr.op === '||') {
      this.value(expr.left);
      const skip = this.current;
      this.value(expr.right);
      this.join([skip, this.current]);
      return undefined;
    }
    const isComparison = ['==', '!=', '<', '<=', '>', '>='].includes(expr.op);
    const left = normalize(shallow(expr.left.ty!));
    const right = normalize(shallow(expr.right.ty!));
    const primitive = ['int', 'float', 'bool', 'char'];
    const byReference = isComparison && !(left.kind === right.kind && primitive.includes(left.kind));
    const operand = (e: Expr): Value => {
      const place = byReference ? this.place(e) : undefined;
      return place ? this.borrow(place, false, e.span, e.ty).value : this.value(e);
    };
    const values = [operand(expr.left), operand(expr.right)];
    return this.aggregate(values, expr.ty, (layout) => layout);
  }

  private assign(expr: Extract<Expr, { kind: 'assign' | 'compoundAssign' }>): void {
    if (expr.kind === 'compoundAssign') {
      this.compoundAssign(expr);
      return;
    }
    const value = this.value(expr.value);
    const values = value === undefined ? [] : [value];
    const res = expr.target.kind === 'path' ? this.annotations.paths.get(expr.target) : undefined;
    if (res?.kind === 'discard') {
      this.point({ uses: values });
      return;
    }
    const place = this.place(expr.target);
    if (!place) {
      const target = this.value(expr.target);
      this.point({ uses: target === undefined ? values : [...values, target] });
      return;
    }
    const whole = place.proj.length === 0;
    const throughRef = place.proj.includes('*');
    // `v[i] = x` on a `Vec` borrows it mutably for `IndexMut`.
    const overloaded = expr.target.kind === 'index' && this.annotations.indexes.get(expr.target)?.overloaded === true;
    const at = this.point({
      uses: whole || !(throughRef || overloaded) ? values : [...values, place.root],
      defs: whole ? [place.root] : [],
      accesses: [{ place, kind: overloaded ? 'deep' : 'write', span: expr.span }],
      kills: [place],
    });
    if (value !== undefined) this.storeDrop(at, place, { root: value, proj: [] });
    relate(this.outlives, this.layout(value), this.placeLayout(place));
  }

  private compoundAssign(expr: Extract<Expr, { kind: 'compoundAssign' }>): void {
    const value = this.value(expr.value);
    const values = value === undefined ? [] : [value];
    const place = this.place(expr.target);
    if (!place) {
      const target = this.value(expr.target);
      this.point({ uses: target === undefined ? values : [...values, target] });
      return;
    }
    this.point({ uses: [...values, place.root], accesses: [{ place, kind: 'deep', span: expr.span }] });
  }

  /** Builds a value of `type` from parts, each of which flows into the part of the layout `part` picks. */
  private aggregate(parts: Value[], type: Type | undefined, part: (layout: Layout, index: number) => Layout): Value {
    const uses = parts.filter((v) => v !== undefined);
    const temp = this.temp(type);
    if (uses.length === 0 && temp === undefined) return undefined;
    this.point({ uses, defs: temp === undefined ? [] : [temp] });
    const layout = this.layout(temp);
    for (const [index, value] of parts.entries()) relate(this.outlives, this.layout(value), part(layout, index));
    return temp;
  }

  private structExpr(expr: Extract<Expr, { kind: 'struct' }>): Value {
    const res = this.annotations.paths.get(expr);
    const values = expr.fields.map((field) => this.value(field.value));
    const variant = res?.kind === 'ctor' ? res.variant : 0;
    const fields = res?.kind === 'ctor' ? res.def.variants[variant].fields : [];
    const indexes = expr.fields.map((field) => fields.findIndex((f) => f.name === field.name));
    const fieldOf = (layout: Layout, index: number): Layout => fieldLayout(layout, variant, index, () => this.static());
    const temp = this.aggregate(values, expr.ty, (layout, index) => fieldOf(layout, indexes[index]));
    if (!expr.base) return temp;
    const base = this.place(expr.base);
    if (!base) {
      this.store(this.value(expr.base), temp);
      return temp;
    }
    const given = new Set(expr.fields.map((field) => field.name));
    const rest = fields.flatMap((field, index) => (given.has(field.name) ? [] : [index]));
    const span = expr.base.span;
    const accesses = rest.map((index): Access => ({ place: project(base, fields[index].name), kind: 'move', span }));
    this.point({ uses: [base.root], accesses });
    for (const index of rest) {
      relate(this.outlives, this.placeLayout(project(base, fields[index].name)), fieldOf(this.layout(temp), index));
    }
    return temp;
  }

  /** Evaluates a condition, returning the point from which the program goes on when it does not hold. */
  private condition(cond: Condition): number | undefined {
    if (cond.kind === 'expr') {
      this.value(cond.expr);
      return this.current;
    }
    const source = this.source(cond.value);
    // Matching reads the scrutinee.
    this.point({ uses: [source.root] });
    const otherwise = this.current;
    this.bind(cond.pattern, source);
    return otherwise;
  }

  private ifExpr(expr: Extract<Expr, { kind: 'if' }>): Value {
    const result = this.temp(expr.ty);
    const branch = (value: Value): void => {
      if (this.current !== undefined) this.store(value, result);
    };
    let otherwise: number | undefined;
    const pattern = expr.cond.kind === 'let' ? expr.cond.pattern : undefined;
    this.patternScope(pattern, expr.consequent, () => {
      otherwise = this.condition(expr.cond);
      branch(this.block(expr.consequent));
    });
    const consequent = this.current;
    this.current = otherwise;
    branch(expr.else ? this.value(expr.else) : undefined);
    this.join([consequent, this.current]);
    return result;
  }

  private match(expr: Extract<Expr, { kind: 'match' }>): Value {
    const source = this.source(expr.scrutinee);
    this.point({ uses: [source.root], accesses: [{ place: source, kind: 'read', span: expr.scrutinee.span }] });
    const start = this.current;
    const result = this.temp(expr.ty);
    const ends: (number | undefined)[] = [];
    for (const arm of expr.arms) {
      this.current = start;
      this.patternScope(arm.pattern, arm.body, () => {
        this.bind(arm.pattern, source);
        const value = this.value(arm.body);
        if (this.current !== undefined) this.store(value, result);
      });
      ends.push(this.current);
    }
    this.join(expr.arms.length === 0 ? [] : ends);
    return result;
  }

  /** A loop whose body `body` builds, which goes round again from its end. */
  private loop(label: string | undefined, type: Type | undefined, body: () => void): Value {
    const head = this.graph.newPoint();
    if (this.current !== undefined) this.graph.points[this.current].succ.push(head);
    this.current = head;
    const frame: LoopFrame = { label, head, breaks: [], result: this.temp(type), scopeDepth: this.scopes.length };
    this.loops.push(frame);
    body();
    if (this.current !== undefined) this.graph.points[this.current].succ.push(head);
    this.loops.pop();
    this.join(frame.breaks);
    return frame.result;
  }

  private forLoop(expr: Extract<Expr, { kind: 'for' }>): Value {
    const iterable = this.value(expr.iterable);
    const iterator = this.newVarWithLayout('{iter}', this.layout(iterable));
    this.store(iterable, iterator);
    const itemType = this.annotations.loops.get(expr)?.item;
    return this.loop(expr.label, undefined, () => {
      const item = this.temp(itemType);
      this.point({ uses: [iterator], defs: item === undefined ? [] : [item] });
      for (const region of regionsOf(this.layout(item))) {
        if (!this.graph.universal.has(region)) outlivesAll(this.outlives, this.layouts[iterator], region);
      }
      if (this.current !== undefined) this.loops.at(-1)?.breaks.push(this.current);
      this.patternScope(expr.pattern, expr.body, () => {
        this.bind(expr.pattern, this.valuePlace(item));
        this.block(expr.body);
      });
    });
  }

  private findLoop(label: string | undefined): LoopFrame | undefined {
    for (let index = this.loops.length - 1; index >= 0; index--) {
      const loop = this.loops[index];
      if (label === undefined || loop.label === label) return loop;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Calls

  // code-gauge-allow functionCognitiveComplexity 18 -- A call defines the result layout and relates it to its borrowed inputs.
  private call(expr: Extract<Expr, { kind: 'call' }>): Value {
    const res = expr.callee.kind === 'path' ? this.annotations.paths.get(expr.callee) : undefined;
    const fn = res?.kind === 'fn' ? res.fn : undefined;
    let callee: Value;
    if (res?.kind !== 'fn' && res?.kind !== 'ctor') {
      const place = this.place(expr.callee);
      const kind = this.annotations.callKinds.get(expr);
      const access = kind === 'FnMut' ? 'deep' : kind === 'FnOnce' ? this.readKind(expr.callee.ty) : 'read';
      callee = place ? this.read(place, expr.callee.ty, expr.callee.span, access) : this.value(expr.callee);
    }
    const args = expr.args.map((arg) => this.value(arg));
    const result = this.callPoint(expr, [callee, ...args], []);
    const results = this.layout(result);
    const inputs = args.map((arg) => this.layout(arg));
    if (res?.kind === 'fn') this.relateCall(res.fn, res.typeArgs, inputs, results);
    else if (res?.kind === 'ctor') {
      for (const [index, input] of inputs.entries()) {
        relate(
          this.outlives,
          input,
          fieldLayout(results, res.variant, index, () => this.static())
        );
      }
    } else this.applyClosure(this.layout(callee), inputs, results);
    if (fn && normalize(shallow(fn.ret)).kind === 'never') this.current = undefined;
    return result;
  }

  /** The point of a call, which uses its inputs and defines its result. */
  private callPoint(expr: Expr, inputs: Value[], accesses: Access[]): Value {
    const result = this.temp(expr.ty);
    const uses = inputs.filter((v) => v !== undefined);
    this.point({ uses, defs: result === undefined ? [] : [result], accesses });
    return result;
  }

  private methodCall(expr: Extract<Expr, { kind: 'methodCall' }>): Value {
    const method = this.annotations.methods.get(expr);
    const { receiver, activation, target } = this.receiver(expr, method);
    const args = expr.args.map((arg) => this.value(arg));
    const accesses: Access[] = [];
    if (activation) accesses.push({ place: activation.place, kind: 'deep', span: expr.span, activates: activation });
    const result = this.callPoint(expr, [receiver, ...args], accesses);
    if (target && method && this.current !== undefined)
      this.storeCollectionElement(target, method.fn, args, this.current);
    if (activation && this.current !== undefined) activation.activation = this.current;
    const inputs = [receiver, ...args].map((v) => this.layout(v));
    if (method) this.relateCall(method.fn, method.typeArgs, inputs, this.layout(result));
    else this.applyClosure(NONE, inputs, this.layout(result));
    if (method && normalize(shallow(method.fn.ret)).kind === 'never') this.current = undefined;
    return result;
  }

  private storeCollectionElement(target: Place, fn: FnDef, args: Value[], point: number): void {
    const key = fn.nativeKey;
    if (!key || !/^(Vec|VecDeque|BinaryHeap)<_>::(push|push_back|push_front|insert|extend)$/.test(key)) return;
    const argument = args[key.endsWith('::insert') ? 1 : 0];
    if (argument !== undefined) this.storeDrop(point, target, { root: argument, proj: [] });
  }

  /** A method's receiver after its adjustment: autoref borrows it, and `&mut` references are reborrowed. */
  private receiver(
    expr: Extract<Expr, { kind: 'methodCall' }>,
    method: MethodRes | undefined
  ): { receiver: Value; activation?: Loan; target?: Place } {
    const { receiver } = expr;
    const place = method && this.place(receiver);
    if (!method || !place) return { receiver: this.value(receiver) };
    const { derefs, autoref } = method.receiver;
    const target: Place = { root: place.root, proj: [...place.proj, ...derefSteps(derefs)] };
    const targetType = typeAfter(receiver.ty, derefs);
    if (autoref !== 'none') {
      // A method of the type itself borrows it in two phases; one reached through `Deref` (a slice's) does not.
      const twoPhase = autoref === 'mut' && !derefs.includes('own');
      const { value, loan } = this.borrow(target, autoref === 'mut', receiver.span, targetType, twoPhase);
      return { receiver: value, activation: twoPhase ? loan : undefined, target };
    }
    if (method.fn.selfMode === 'mutRef' && isMutReference(targetType)) {
      const { value, loan } = this.borrow(project(target, '*'), true, receiver.span, refTarget(targetType), true);
      return { receiver: value, activation: loan, target: project(target, '*') };
    }
    return { receiver: this.read(target, targetType, receiver.span) };
  }

  /**
   * Relates a call's inputs (the receiver first) and result as the callee's signature says: each lifetime and type
   * parameter stands for regions of its own, which the inputs outlive and which outlive the result.
   */
  private relateCall(fn: FnDef, typeArgs: readonly Type[], inputs: Layout[], result: Layout): void {
    const signature = new SignatureInstance(fn, typeArgs, this.fresh, this.outlives, () => this.static());
    signature.bindInputs(inputs);
    signature.bindOutput(result, inputs);
    signature.relateBounds((callee, args, ret, higherRanked) => this.applyClosure(callee, args, ret, higherRanked));
  }

  /**
   * Relates the arguments and the result of a call of a closure (or of what a type parameter or a trait object for one
   * stands for): as its summary says for a closure of this function, conservatively otherwise.
   */
  // code-gauge-allow functionCognitiveComplexity 20 -- Applies a closure's summary, or relates every region without one.
  private applyClosure(callee: Layout, args: Layout[], result: Layout, higherRanked: boolean[] = []): void {
    const closure = callee.kind === 'opaque' ? callee.closure : undefined;
    const summary = closure && this.shared.summaries.get(closure);
    if (!closure || !summary || callee.kind !== 'opaque') {
      for (const a of [...regionsOf(callee), ...args.flatMap(regionsOf)]) {
        for (const b of regionsOf(result)) this.outlives(a, b);
      }
      return;
    }
    const params = closure.params.map((type) => layoutOf(type, this.fresh, () => this.static()));
    const ret = layoutOf(closure.ret, this.fresh);
    for (const [index, arg] of args.entries()) relate(this.outlives, arg, params[index] ?? NONE);
    relate(this.outlives, ret, result);
    const retRegions = regionsOf(ret);
    for (const [param, region, retRegion] of summary.edges) {
      // A bound `F: FnMut(&T) -> K` takes every lifetime of its reference, which `K` cannot name.
      if (higherRanked[param] && region === 0) {
        this.shared.errors.push({
          span: summary.body,
          message:
            'このクロージャーは、引数の参照から借りた値を返せません（呼び出すたびに違う寿命の参照を受け取るため）。',
        });
      }
      const from = regionsOf(params[param] ?? NONE)[region];
      if (from !== undefined && retRegions[retRegion] !== undefined) this.outlives(from, retRegions[retRegion]);
    }
    for (const retRegion of summary.captures) {
      if (retRegions[retRegion] !== undefined) this.outlives(callee.region, retRegions[retRegion]);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Closures and macros

  /** A closure borrows, or moves, the places it captures when it is created, and holds them while it lives. */
  // code-gauge-allow functionNcss 44 -- Follows rustc's capture modes case by case.
  // code-gauge-allow functionCognitiveComplexity 29 -- A closure builds a loan summary from its captures and borrowed results.
  private closure(expr: Extract<Expr, { kind: 'closure' }>): Value {
    const info = this.annotations.closures.get(expr);
    const type = expr.ty && normalize(shallow(expr.ty));
    if (!info || type?.kind !== 'closure') return undefined;
    const { context } = info;
    const body = new LoanBuilder(this.annotations, this.solver, context, this.shared);
    const params = expr.params.map((param, index) => ({ pattern: param.pattern, type: type.closure.params[index] }));
    const end = expr.body.kind === 'block' ? { row: expr.body.endRow, col: 0 } : expr.body.span;
    const paramVars = body.build(params, expr.body, type.closure.ret, end);
    this.shared.summaries.set(type.closure, body.summarize(paramVars, expr.body.span));
    const temp = this.newVar('{closure}', type);
    const closureRegion = (this.layouts[temp] as Layout & { kind: 'opaque' }).region;
    const uses: Var[] = [];
    const accesses: Access[] = [];
    const gens: Loan[] = [];
    const captured: Place[] = [];
    context.reborrowedCaptures = new Set();
    for (const local of context.captures) {
      const root = this.varOf(local);
      uses.push(root);
      const projections = capturedPlaces(this.annotations, expr.body, local, body.typedReferenceReads);
      const captureType = normalize(shallow(local.type));
      const byValue = context.isMove || context.movedCaptures?.includes(local);
      const reborrow = !byValue && captureType.kind === 'ref' && projections.every(({ proj }) => proj[0] === '*');
      if (reborrow) context.reborrowedCaptures.add(local);
      for (const { proj, type: projectionType } of projections) {
        // A closure that takes a capture by value takes the reference a deref goes through.
        const cut = proj.indexOf('*');
        const place: Place = { root, proj: byValue && cut !== -1 ? proj.slice(0, cut) : proj };
        captured.push(reborrow ? { root, proj: [] } : place);
        if (byValue) {
          accesses.push({ place, kind: this.readKind(cut === -1 ? projectionType : captureType), span: expr.span });
          continue;
        }
        const mutable = body.mutatedCaptures.has(local);
        gens.push({ place, mutable, region: closureRegion, span: expr.span, point: -1 });
        accesses.push({ place, kind: mutable ? 'deep' : 'read', span: expr.span });
      }
    }
    this.point({ uses, defs: [temp], accesses, gens });
    for (const place of captured) outlivesAll(this.outlives, this.placeLayout(place), closureRegion);
    return temp;
  }

  /** Which regions of the parameters (and of the captures) the result of this closure's body may hold. */
  // code-gauge-allow functionCognitiveComplexity 23 -- Searches the outlives graph from each region of the parameters.
  private summarize(paramVars: Var[], bodySpan: Span): ClosureSummary {
    const edges = new Map<RVar, RVar[]>();
    for (const [sup, sub] of this.graph.outlives) {
      const list = edges.get(sup);
      if (list) list.push(sub);
      else edges.set(sup, [sub]);
    }
    const ret = this.graph.varRegions[this.returnVar];
    const reached = (from: RVar[]): number[] => {
      const seen = new Set(from);
      const stack = [...from];
      while (stack.length > 0) {
        for (const next of edges.get(stack.pop() as RVar) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
      return ret.flatMap((region, index) => (seen.has(region) ? [index] : []));
    };
    const summary: ClosureSummary = { edges: [], captures: [], body: bodySpan };
    for (const [param, v] of paramVars.entries()) {
      for (const [index, region] of this.graph.varRegions[v].entries()) {
        for (const retRegion of reached([region])) summary.edges.push([param, index, retRegion]);
      }
    }
    const captureRegions = this.context.captures.flatMap((local) => this.graph.varRegions[this.varOf(local)]);
    const captureLoans = this.graph.points
      .flatMap((point) => point.gens)
      .filter((loan) => {
        const local = this.locals.get(loan.place.root);
        return local !== undefined && this.context.captures.includes(local);
      })
      .map((loan) => loan.region);
    summary.captures = reached([...captureRegions, ...captureLoans]);
    return summary;
  }

  /** Formatting macros borrow each argument until they have formatted them all. */
  private formatArgs(format: FormatArgs | undefined): Var[] {
    return (format?.args ?? []).flatMap((arg) => {
      const place = this.place(arg);
      const value = place ? this.borrow(place, false, arg.span, arg.ty).value : this.value(arg);
      return value === undefined ? [] : [value];
    });
  }

  // code-gauge-allow functionNcss 41 -- One case per macro.
  private macro(expr: Extract<Expr, { kind: 'macro' }>): Value {
    const { macro } = expr;
    switch (macro.kind) {
      case 'print':
      case 'format': {
        this.point({ uses: this.formatArgs(macro.format) });
        return undefined;
      }
      case 'panic': {
        this.point({ uses: this.formatArgs(macro.format) });
        this.current = undefined;
        return undefined;
      }
      case 'write': {
        this.writeMacro(macro.target, macro.format, expr.span);
        return undefined;
      }
      case 'assert': {
        const value = this.value(macro.cond);
        const args = this.formatArgs(macro.format);
        this.point({ uses: value === undefined ? args : [value, ...args] });
        return undefined;
      }
      case 'assertEq': {
        const operands = this.formatArgs({ pieces: [], args: [macro.left, macro.right], span: expr.span });
        this.point({ uses: [...operands, ...this.formatArgs(macro.format)] });
        return undefined;
      }
      case 'vec': {
        const values = macro.elems.map((elem) => this.value(elem));
        return this.aggregate(values, expr.ty, elementLayout);
      }
      case 'vecRepeat': {
        const value = this.value(macro.value);
        this.value(macro.count);
        return this.aggregate([value], expr.ty, elementLayout);
      }
      case 'matches': {
        let unmatched: number | undefined;
        this.patternScope(macro.pattern, expr, () => {
          unmatched = this.condition({ kind: 'let', pattern: macro.pattern, value: macro.value, span: expr.span });
        });
        this.join([unmatched, this.current]);
        return undefined;
      }
      case 'dbg': {
        const values = macro.args.map((arg) => this.value(arg));
        if (values.length === 1) return values[0];
        return this.aggregate(values, expr.ty, tupleElem);
      }
    }
  }

  /** `write!(f, ..)` calls `f.write_fmt(..)`, which borrows `f` (or what it refers to) in two phases. */
  private writeMacro(targetExpr: Expr, format: FormatArgs | undefined, span: Span): void {
    const place = this.place(targetExpr);
    if (!place) {
      const value = this.value(targetExpr);
      const args = this.formatArgs(format);
      this.point({ uses: value === undefined ? args : [value, ...args] });
      return;
    }
    const throughRef = isMutReference(targetExpr.ty);
    const target = throughRef ? refTarget(targetExpr.ty) : targetExpr.ty;
    const { value, loan } = this.borrow(throughRef ? project(place, '*') : place, true, targetExpr.span, target, true);
    const args = this.formatArgs(format);
    this.point({ uses: [value, ...args], accesses: [{ place: loan.place, kind: 'deep', span, activates: loan }] });
    if (this.current !== undefined) loan.activation = this.current;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Helpers

  private isCopy(type: Type | undefined): boolean {
    if (!type) return true;
    return this.solver.isCopy(resolve(type, true));
  }
}

/**
 * A pattern that is no binding matches through the references in its type, which make its bindings bind by reference.
 * The type checker gives the parts of a value matched by reference reference types, which no place has.
 */
function matchDeref(p: Pattern, place: Place, byRef: BindingMode): [Place, BindingMode] {
  let sub = place;
  let mode = byRef;
  let wrapped = byRef !== undefined;
  let t = p.ty && normalize(shallow(p.ty));
  while (t?.kind === 'ref') {
    if (wrapped) wrapped = false;
    else {
      sub = project(sub, '*');
      mode = t.mutable && mode !== 'shared' ? 'mut' : 'shared';
    }
    t = normalize(shallow(t.target));
  }
  return [sub, mode];
}

function project(place: Place, elem: string): Place {
  return { root: place.root, proj: [...place.proj, elem] };
}

function tupleElem(layout: Layout, index: number): Layout {
  return layout.kind === 'tuple' ? (layout.elems[index] ?? NONE) : NONE;
}

/** The variant and the field a projection names in a value of a struct or an enum. */
function fieldIndex(layout: Layout & { kind: 'adt' }, elem: string): [number, number] {
  const [variantText, name] = elem.includes(':') ? elem.split(':') : ['0', elem];
  const variant = Number(variantText);
  const fields = layout.def.variants[variant]?.fields ?? [];
  const byName = fields.findIndex((field) => field.name === name);
  return [variant, byName !== -1 ? byName : Number(name)];
}

function refTarget(type: Type | undefined): Type | undefined {
  const t = type && normalize(shallow(type));
  return t?.kind === 'ref' ? t.target : undefined;
}

function isReference(type: Type | undefined): boolean {
  return type !== undefined && normalize(shallow(type)).kind === 'ref';
}

function isMutReference(type: Type | undefined): boolean {
  const t = type && normalize(shallow(type));
  return t?.kind === 'ref' && t.mutable;
}
