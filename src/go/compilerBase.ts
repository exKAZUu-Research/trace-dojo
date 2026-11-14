// code-gauge-allow-file fileNcss 533 -- Resolves each Go type form together with its scope and diagnostic context.
import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import type { Expression, Span, TypeElementSyntax, TypeExpression, TypeParameter } from './ast';
import type { Entity, FunctionContext, PackageEntity, TypeEntity, VarEntity } from './entities';
import { containsTypeParam, substituteInterface } from './generics';
import type { Eval, Exec, Frame, FunctionInfo, LocalInfo, Suspending } from './runtime';
import { Scope } from './scope';
import { sizeOf, STACK_BUFFER_SIZE } from './sliceOps';
import { newSliceTracking } from './slicePass';
import { newSsaValues } from './ssaValues';
import {
  BASIC,
  COMPARABLE,
  CONSTRAINT_NAMES,
  describeType,
  effectiveTerms,
  EMPTY_INTERFACE,
  type Field,
  type FuncType,
  funcType,
  identical,
  type InterfaceMethod,
  type InterfaceType,
  isComparable,
  type NamedType,
  type Type,
  type TypeParamType,
  type TypeTerm,
  underlying,
} from './types';
import { UNIVERSE } from './universe';

export interface TraceSettings {
  /** The rows of `// atomic` annotations, which mark the function declared there. */
  atomicRows: ReadonlySet<number>;
}

let nextTypeParamId = 0;

/**
 * A computation that may block, such as a call of the program's function or a channel receive, which a statement of a
 * program that uses goroutines runs before the rest of it, keeping the result in a hidden slot. Go evaluates calls and
 * receives in the order they are written, before the other operands, which this order follows.
 */
export interface Hoist {
  slot: number;
  run: (frame: Frame) => Suspending<unknown>;
}

/** An expression and the computations that may block that it needs to run first. */
export interface Part<T = Eval> {
  value: T;
  hoists: Hoist[] | undefined;
}
const NO_SPAN: Span = { row: 0, column: 0 };

/** The shared state of compiling one file: scopes, diagnostics, and the function being compiled. */
export abstract class CompilerBase {
  protected readonly diagnostics: SourceDiagnostic[] = [];
  protected readonly packageScope = new Scope(UNIVERSE);
  /** The imports, which only the file's own code sees. */
  protected readonly fileScope = new Scope(this.packageScope);
  protected scope: Scope = this.fileScope;
  protected fn: FunctionContext | undefined;
  /** Whether errors are being reported; instances of generic code were checked once already. */
  protected reporting = true;
  /** Whether a constraint is being resolved, where interfaces with type sets may appear. */
  private inConstraint = false;
  /** The value of `iota` in the constant spec being compiled, which is undefined elsewhere. */
  protected iota: number | undefined;
  /** Whether the program uses goroutines, channels, locks, or sleeps, whose statements may block. */
  protected concurrent = false;
  /** Where the computations that may block of the expression being compiled go, when it may block. */
  protected hoists: Hoist[] | undefined;
  /** The compiled functions by their runtime information, for finding the function a frame runs. */
  protected readonly functionContexts = new Map<FunctionInfo, FunctionContext>();
  protected runtimeCallCount = 0;
  /**
   * Whether the expression being compiled is an element of a slice that Go's compiler allocates before evaluating
   * the elements, apart from the calls it hoists, which keeps it from forwarding stores to package-level variables.
   */
  protected inAllocatedSlice = false;
  protected readonly builtinPanicCalls = new WeakSet<Expression>();

  constructor(protected readonly trace: TraceSettings | undefined) {}

  protected withRuntimeCallTracking<T>(run: () => T): { result: T; hasRuntimeCall: boolean } {
    const before = this.runtimeCallCount;
    const result = run();
    return { result, hasRuntimeCall: this.runtimeCallCount > before };
  }

  // Diagnostics ---------------------------------------------------------------------------------------------------

  protected diagnosticSpan: Span | undefined;

  /** Records an error and returns the invalid type, which suppresses the errors that would follow from it. */
  protected error(span: Span, message: string): Type {
    span = this.diagnosticSpan ?? span;
    if (this.reporting && !this.diagnostics.some((d) => d.row === span.row && d.message === message)) {
      this.diagnostics.push({ row: span.row, message });
    }
    return BASIC.invalid;
  }

  protected unsupported(span: Span, what: string): Type {
    return this.error(span, `${what}は、この採点環境では使えません。`);
  }

  protected throwIfErrors(): void {
    if (this.diagnostics.length === 0) return;
    const sorted = this.diagnostics.toSorted((a, b) => a.row - b.row).slice(0, 10);
    throw new CompileError(sorted);
  }

  // Scopes --------------------------------------------------------------------------------------------------------

  protected withScope<T>(run: () => T): T {
    const outer = this.scope;
    this.scope = new Scope(outer);
    try {
      return run();
    } finally {
      this.reportUnused(this.scope);
      this.scope = outer;
    }
  }

  /** Reports the local variables of a scope that the program never read, which Go rejects. */
  protected reportUnused(scope: Scope): void {
    for (const entity of scope.entities.values()) {
      if (
        entity.kind === 'var' &&
        !entity.used &&
        !entity.quiet &&
        entity.owner &&
        entity.name !== '_' &&
        !entity.local?.isReceiver &&
        !this.isParameter(entity)
      ) {
        this.error(entity.span, `宣言した変数 ${entity.name} を使っていません。`);
      }
    }
  }

  private isParameter(entity: VarEntity): boolean {
    return (
      entity.owner?.info.params.includes(entity) === true || entity.owner?.resultVariables.includes(entity) === true
    );
  }

  protected declare(name: string, entity: Entity, span: Span): void {
    if (name === '_') return;
    const existing = this.scope.entities.get(name);
    if (existing) {
      this.error(span, `${name} はこのブロックですでに宣言されています。`);
      return;
    }
    this.scope.entities.set(name, entity);
  }

  /** Declares a local variable of the function being compiled, giving it a slot in its frame. */
  protected declareLocal(name: string, type: Type, span: Span, isReceiver = false): VarEntity {
    const fn = this.fn as FunctionContext;
    const slot = fn.info.slotCount++;
    const local: LocalInfo = { name, slot, type, isReceiver };
    if (name !== '_') fn.info.locals.push(local);
    const entity: VarEntity = { kind: 'var', name, type, span, used: false, boxed: false, owner: fn, slot, local };
    const under = underlying(type);
    if (under.kind === 'slice' && sizeOf(under.element) <= STACK_BUFFER_SIZE) {
      entity.slice = newSliceTracking(fn.loopDepth);
    }
    this.declare(name, entity, span);
    return entity;
  }

  /** A variable of the function being compiled that holds no value, which only follows where values go. */
  protected hiddenVariable(name = '', span: Span = NO_SPAN): VarEntity {
    return { kind: 'var', name, type: BASIC.invalid, span, used: true, boxed: false, owner: this.fn, slot: -1 };
  }

  // Blocking -----------------------------------------------------------------------------------------------------

  /** Compiles an expression or statement, collecting the computations that may block that it must run first. */
  protected part<T>(compile: () => T): Part<T> {
    if (!this.concurrent || !this.fn) return { value: compile(), hoists: undefined };
    const outer = this.hoists;
    const hoists: Hoist[] = [];
    this.hoists = hoists;
    try {
      const value = compile();
      return { value, hoists: hoists.length > 0 ? hoists : undefined };
    } finally {
      this.hoists = outer;
    }
  }

  /**
   * Runs a computation that may block before the statement, when the statement can block, and reads its result in its
   * place; elsewhere, runs it to its end in place.
   */
  protected suspending(run: (frame: Frame) => Suspending<unknown>, plain: Eval): Eval {
    const hoists = this.hoists;
    if (!hoists) return plain;
    const slot = this.hiddenSlot();
    hoists.push({ slot, run });
    return (frame) => frame.locals[slot] as never;
  }

  /** Allocates a slot that no name refers to, such as an unnamed result. */
  protected hiddenSlot(): number {
    return (this.fn as FunctionContext).info.slotCount++;
  }

  /** The packages imported with `.`, whose members the file's scope holds. */
  protected readonly dotImports: PackageEntity[] = [];
  protected readonly dotMembers = new Map<Entity, PackageEntity>();

  protected lookup(name: string, span?: Span): Entity | undefined {
    const entity = this.scope.lookup(name);
    if (!entity) {
      const unavailable = this.dotImports.find((pkg) => pkg.package.unsupported?.has(name));
      if (unavailable) {
        unavailable.used = true;
        this.unsupported(span ?? unavailable.span, `${unavailable.package.path}.${name}`);
        return { kind: 'type', name, type: BASIC.invalid };
      }
    }
    const dotPackage = entity && this.dotMembers.get(entity);
    if (dotPackage) dotPackage.used = true;
    if (entity?.kind === 'var' && entity.owner && this.fn && entity.owner !== this.fn) this.capture(entity, this.fn);
    if (entity?.kind === 'package') entity.used = true;
    return entity;
  }

  /** The index of a captured variable in a function's cells, capturing it through every enclosing closure. */
  protected capture(entity: VarEntity, fn: FunctionContext): number {
    entity.boxed = true;
    entity.captured = true;
    const existing = fn.captures.get(entity);
    if (existing !== undefined) return existing;
    // Go's slice optimization pass gives up on a variable that a closure refers to.
    entity.slice?.uses.push({});
    if (fn.parent && fn.parent !== entity.owner) this.capture(entity, fn.parent);
    const index = fn.captures.size;
    fn.captures.set(entity, index);
    fn.info.captures.push({ name: entity.name, type: entity.type });
    return index;
  }

  protected newFunctionContext(name: string, parent: FunctionContext | undefined, body: Exec): FunctionContext {
    const info: FunctionInfo = {
      name,
      slotCount: 0,
      locals: [],
      captures: [],
      isAtomic: false,
      body,
      resultSlots: [],
      params: [],
    };
    const fn: FunctionContext = {
      info,
      parent,
      captures: new Map(),
      params: [],
      results: [],
      resultVariables: [],
      hasNamedResults: false,
      inlineCost: 0,
      callees: [],
      returnedValues: [],
      onComplete: [],
      closureCalls: new Map(),
      notInlinable: false,
      references: new Set(),
      products: new Map(),
      sumsOfProducts: [],
      ssa: newSsaValues(),
      loopDepth: 0,
      breakDepth: 0,
      recordsSteps: this.trace !== undefined,
    };
    this.functionContexts.set(info, fn);
    return fn;
  }

  // Types ---------------------------------------------------------------------------------------------------------

  protected abstract constantExpression(expression: Expression): { value: bigint | undefined; type: Type };

  /**
   * Resolves type syntax. `direct` tells whether the type is stored directly in the type being declared, where a
   * reference to that type makes it infinitely large. `constraint` tells whether the syntax stands where Go allows an
   * interface with a type set: as a type parameter's constraint, or as the whole type of a type declaration.
   */
  resolveType(syntax: TypeExpression, direct = false, constraint = false): Type {
    const type = this.resolveTypeSyntax(syntax, direct);
    const under = underlying(type);
    if (!constraint && under.kind === 'interface' && under.typeSet) {
      return this.error(
        syntax,
        `${describeType(type)} 型は、型の制約にしか使えません（型の集合を持つインターフェースです）。`
      );
    }
    return type;
  }

  // code-gauge-allow functionNcss 36 -- Resolves each Go type form together with its scope and diagnostic context.
  private resolveTypeSyntax(syntax: TypeExpression, direct: boolean): Type {
    switch (syntax.kind) {
      case 'name': {
        return this.resolveNamedType(syntax, direct);
      }
      case 'pointer': {
        return { kind: 'pointer', element: this.resolveType(syntax.element) };
      }
      case 'slice': {
        return { kind: 'slice', element: this.resolveType(syntax.element) };
      }
      case 'array': {
        const element = this.resolveType(syntax.element, direct);
        if (syntax.length === undefined)
          return this.error(syntax, '[...] で長さを省けるのは、配列の複合リテラルの型だけです。');
        const { value, type } = this.constantExpression(syntax.length);
        if (type === BASIC.invalid) return BASIC.invalid;
        if (value === undefined) return this.error(syntax.length, '配列の長さには、整数の定数を書いてください。');
        if (value < 0n) return this.error(syntax.length, '配列の長さに負の数は使えません。');
        if (value > 1_000_000n) return this.error(syntax.length, '配列が大きすぎます。');
        return { kind: 'array', element, length: Number(value) };
      }
      case 'map': {
        const key = this.resolveType(syntax.key);
        const value = this.resolveType(syntax.value);
        if (key !== BASIC.invalid && !this.isComparableKey(key, syntax.key)) {
          this.error(syntax.key, `${describeType(key)} は比較できない型なので、map のキーには使えません。`);
        }
        return { kind: 'map', key, value };
      }
      case 'chan': {
        return { kind: 'chan', dir: syntax.dir, element: this.resolveType(syntax.element) };
      }
      case 'func': {
        return this.resolveSignature(syntax.signature).type;
      }
      case 'struct': {
        return this.resolveStruct(syntax, direct);
      }
      case 'interface': {
        return this.resolveInterface(syntax);
      }
    }
  }

  private isComparableKey(type: Type, span?: Span): boolean {
    // A named type still being declared is checked when it is complete.
    if (type.kind === 'named' && type.underlying === BASIC.invalid) {
      if (span) this.deferredMapKeys.push({ key: type, span });
      return true;
    }
    // A constraint may use a type parameter whose own constraint comes later in the list.
    if (this.inConstraint && containsTypeParam(type)) {
      if (span) this.deferredMapKeys.push({ key: type, span });
      return true;
    }
    return isComparable(type);
  }

  protected readonly deferredMapKeys: { key: Type; span: Span }[] = [];

  /** Types whose declarations are currently resolving, so generic instances wait until `underlying` is ready. */
  protected readonly resolvingTypes = new Set<NamedType>();
  /**
   * The graph that Go's type checker builds to find instantiation cycles: a vertex per type parameter, and an edge from
   * each type parameter mentioned in a type argument to the parameter it instantiates, weighing 1 when the argument
   * wraps it in a bigger type. Vertices and edges keep the order in which Go's checker creates them, which decides where
   * it reports a cycle.
   */
  private readonly instantiationVertices = new Map<number, number>();
  private readonly instantiationVertexParams: TypeParamType[] = [];
  private readonly instantiationEdges: { source: number; target: number; weight: number }[] = [];
  protected readonly typeParamSpans = new Map<number, Span>();
  protected hasGenericCycle = false;

  protected recordGenericInstantiation(params: TypeParamType[], args: Type[]): boolean {
    if (this.hasGenericCycle) return false;
    for (const [index, param] of params.entries()) {
      const arg = args[index];
      // Library type parameters belong to other packages, so their instantiations cannot form a cycle.
      if (!arg || param.id < 0) continue;
      const mentioned: TypeParamType[] = [];
      collectTypeParams(arg, mentioned);
      for (const source of mentioned) {
        const sourceVertex = this.instantiationVertex(source);
        const target = this.instantiationVertex(param);
        this.instantiationEdges.push({ source: sourceVertex, target, weight: arg === source ? 0 : 1 });
      }
    }
    const cycleAt = this.findInstantiationCycle();
    if (cycleAt === undefined) return true;
    this.hasGenericCycle = true;
    const param = this.instantiationVertexParams[cycleAt];
    this.error(
      this.typeParamSpans.get(param.id) ?? { row: 0, column: 0 },
      `型パラメータ ${param.name} のインスタンス化が循環しています（インスタンス化のたびに型引数が大きくなり、終わりません）。`
    );
    return false;
  }

  private instantiationVertex(param: TypeParamType): number {
    let vertex = this.instantiationVertices.get(param.id);
    if (vertex === undefined) {
      vertex = this.instantiationVertexParams.push(param) - 1;
      this.instantiationVertices.set(param.id, vertex);
    }
    return vertex;
  }

  /**
   * Finds a cycle through an edge of positive weight as Go's checker does (monomorph in go/types/mono.go): Bellman-Ford
   * for the heaviest paths, where a path as long as the number of vertices contains a cycle, which is reported at the
   * first vertex found twice walking that path backwards.
   */
  private findInstantiationCycle(): number | undefined {
    const vertices = this.instantiationVertexParams.map(() => ({ weight: 0, previous: -1, length: 0 }));
    for (let again = true; again;) {
      again = false;
      for (const [index, edge] of this.instantiationEdges.entries()) {
        const source = vertices[edge.source];
        const target = vertices[edge.target];
        const weight = source.weight + edge.weight;
        if (weight <= target.weight) continue;
        target.previous = index;
        target.length = source.length + 1;
        if (target.length === vertices.length) {
          const seen = new Set<number>();
          let vertex = edge.target;
          while (!seen.has(vertex) && vertices[vertex].previous >= 0) {
            seen.add(vertex);
            vertex = this.instantiationEdges[vertices[vertex].previous].source;
          }
          return vertex;
        }
        target.weight = weight;
        again = true;
      }
    }
    return undefined;
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- Resolves each Go type form together with its scope and diagnostic context.
  // code-gauge-allow functionNcss 34 -- Resolves each Go type form together with its scope and diagnostic context.
  private resolveNamedType(syntax: Extract<TypeExpression, { kind: 'name' }>, direct: boolean): Type {
    let entity: Entity | undefined;
    if (syntax.package) {
      const pkg = this.lookup(syntax.package);
      if (pkg?.kind !== 'package') return this.error(syntax, `${syntax.package} は宣言されていません。`);
      entity = this.packageMember(pkg, syntax.name, syntax);
      if (!entity) return BASIC.invalid;
    } else {
      entity = this.lookup(syntax.name, syntax);
    }
    if (!entity) return this.error(syntax, `${syntax.name} は宣言されていません。`);
    if (entity.kind !== 'type') return this.error(syntax, `${syntax.name} は型ではありません。`);
    this.useType(entity);
    if (entity.generic) {
      if (syntax.typeArguments.length === 0) {
        return this.error(syntax, `型 ${syntax.name} を使うには、型引数を書いてください。`);
      }
      const args = syntax.typeArguments.map((argument) => this.resolveType(argument));
      if (args.includes(BASIC.invalid)) return BASIC.invalid;
      if (args.length !== entity.generic.typeParams.length) {
        return this.error(syntax, `型 ${syntax.name} の型引数の数が合いません。`);
      }
      if (!this.checkTypeArguments(entity.generic.typeParams, args, syntax)) return BASIC.invalid;
      if (!this.recordGenericInstantiation(entity.generic.typeParams, args)) return BASIC.invalid;
      return entity.generic.instantiate(args, syntax);
    }
    if (syntax.typeArguments.length > 0) return this.error(syntax, `${syntax.name} は型引数を持たない型です。`);
    const type = entity.type;
    void direct;
    return type;
  }

  /** Resolves a constraint, where interfaces with type sets may appear. */
  protected resolveConstraint(syntax: TypeExpression): Type {
    const outer = this.inConstraint;
    this.inConstraint = true;
    try {
      return this.resolveType(syntax, false, true);
    } finally {
      this.inConstraint = outer;
    }
  }

  /** Completes a type entity whose declaration has not been resolved yet. */
  protected abstract useType(entity: TypeEntity): void;

  protected packageMember(pkg: PackageEntity, name: string, span: Span): Entity | undefined {
    pkg.used = true;
    if (pkg.package.unavailable) return undefined;
    const member = pkg.package.members.get(name);
    if (member) return member;
    if (pkg.package.unsupported?.has(name)) {
      this.unsupported(span, `${pkg.package.path}.${name}`);
      return undefined;
    }
    const lower = name.charAt(0).toLowerCase() === name.charAt(0);
    if (lower) this.error(span, `${pkg.name}.${name} は外から使えない名前です（大文字で始まる名前だけを使えます）。`);
    else this.unsupported(span, `${pkg.package.path}.${name}`);
    return undefined;
  }

  private resolveStruct(syntax: Extract<TypeExpression, { kind: 'struct' }>, direct: boolean): Type {
    const fields: Field[] = [];
    const names = new Set<string>();
    for (const field of syntax.fields) {
      const type = this.resolveType(field.type, direct);
      let name = field.name;
      if (name === undefined) {
        const base = field.type.kind === 'pointer' ? field.type.element : field.type;
        if (base.kind !== 'name') {
          this.error(field, '埋め込むフィールドには、型の名前を書いてください。');
          continue;
        }
        name = base.name;
        this.checkEmbeddedType(field, type);
      }
      if (name !== '_' && names.has(name)) this.error(field, `フィールド ${name} が2回宣言されています。`);
      names.add(name);
      fields.push({ name, type, embedded: field.name === undefined, tag: field.tag });
    }
    return { kind: 'struct', fields };
  }

  /** Go embeds a type or a pointer to one, but neither a pointer type nor a pointer to an interface. */
  private checkEmbeddedType(field: Span, type: Type): void {
    const isPointer = type.kind === 'pointer';
    const under = underlying(isPointer ? type.element : type);
    if (under.kind === 'pointer') {
      this.error(field, '埋め込むフィールドの型には、ポインタの型を使えません。');
    } else if (under.kind === 'interface' && isPointer) {
      this.error(field, '埋め込むフィールドの型には、インターフェースへのポインタを使えません。');
    }
  }

  // code-gauge-allow functionNcss 35 -- Resolves each Go type form together with its scope and diagnostic context.
  private resolveInterface(syntax: Extract<TypeExpression, { kind: 'interface' }>): InterfaceType {
    if (syntax.methods.length === 0 && syntax.elements.length === 0) return EMPTY_INTERFACE;
    const methods: InterfaceMethod[] = [];
    const addMethod = (method: InterfaceMethod, span: Span): void => {
      const existing = methods.find((other) => other.name === method.name);
      // An interface may embed the same method twice, with identical signatures.
      if (existing && !identical(existing.type, method.type))
        this.error(span, `メソッド ${method.name} が2回宣言されています。`);
      if (!existing) methods.push(method);
    };
    for (const method of syntax.methods) {
      if (methods.some((other) => other.name === method.name)) {
        this.error(method, `メソッド ${method.name} が2回宣言されています。`);
        continue;
      }
      methods.push({ name: method.name, type: this.resolveSignature(method.signature).type });
    }
    let terms: TypeTerm[] | undefined;
    let comparable = false;
    for (const element of syntax.elements) {
      const resolved = this.resolveTypeElement(element);
      if (!resolved) continue;
      if ('embedded' in resolved) {
        for (const method of resolved.embedded.methods) addMethod(method, element);
        if (resolved.embedded.typeSet?.comparable) comparable = true;
        const embeddedTerms = resolved.embedded.typeSet?.terms;
        if (embeddedTerms) terms = terms ? intersectTerms(terms, embeddedTerms) : embeddedTerms;
        continue;
      }
      terms = terms ? intersectTerms(terms, resolved.terms) : resolved.terms;
    }
    methods.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (!terms && !comparable) return { kind: 'interface', methods };
    return { kind: 'interface', methods, typeSet: { comparable: comparable || undefined, terms } };
  }

  /** An element of an interface: an embedded interface, or a union of type terms, which may contain interfaces. */
  // code-gauge-allow functionCognitiveComplexity 21 -- Resolves each Go type form together with its scope and diagnostic context.
  private resolveTypeElement(
    element: TypeElementSyntax
  ): { embedded: InterfaceType } | { terms: TypeTerm[] } | undefined {
    const resolved = element.terms.map((term) => ({
      tilde: term.tilde,
      type: this.resolveConstraintTerm(term.type),
      syntax: term,
    }));
    if (resolved.some((term) => term.type === BASIC.invalid)) return undefined;
    if (resolved.length === 1 && !resolved[0].tilde && underlying(resolved[0].type).kind === 'interface') {
      return { embedded: underlying(resolved[0].type) as InterfaceType };
    }
    const terms: TypeTerm[] = [];
    const concrete: TypeTerm[] = [];
    let unrestricted = false;
    for (const term of resolved) {
      const under = underlying(term.type);
      if (under.kind === 'interface') {
        if (term.tilde || under.typeSet?.comparable || under.methods.length > 0) {
          this.error(
            term.syntax.type,
            `メソッドを持つインターフェース ${describeType(term.type)} は、| で並べられません。`
          );
          continue;
        }
        if (!under.typeSet?.terms) unrestricted = true;
        else terms.push(...under.typeSet.terms);
        continue;
      }
      if (term.tilde && !identical(term.type, under)) {
        this.error(
          term.syntax.type,
          `~ を付けられるのは、元の型そのものだけです（${describeType(term.type)} の元の型は ${describeType(under)} です）。`
        );
        continue;
      }
      if (concrete.some((previous) => termIncludes(previous, term) || termIncludes(term, previous)))
        this.error(term.syntax.type, '型集合の | には、重なり合う型を並べられません。');
      concrete.push(term);
      terms.push({ tilde: term.tilde, type: term.type });
    }
    return unrestricted ? { embedded: EMPTY_INTERFACE } : { terms };
  }

  private resolveConstraintTerm(syntax: TypeExpression): Type {
    const type = this.resolveConstraint(syntax);
    return type.kind === 'typeParam'
      ? this.error(syntax, '型パラメータそのものは、型集合の要素には使えません。')
      : type;
  }

  protected resolveSignature(signature: {
    parameters: ({ name?: string; type: TypeExpression; variadic?: boolean } & Partial<Span>)[];
    results: { name?: string; type: TypeExpression }[];
  }): {
    type: FuncType;
  } {
    const last = signature.parameters.length - 1;
    const params = signature.parameters.map((parameter, index): Type => {
      const type = this.resolveType(parameter.type);
      if (!parameter.variadic) return type;
      if (index !== last) this.error(parameter as Span, '... を付けられるのは最後の引数だけです。');
      return type === BASIC.invalid ? type : { kind: 'slice', element: type };
    });
    const results = signature.results.map((result) => this.resolveType(result.type));
    return { type: funcType(params, results, signature.parameters.at(-1)?.variadic === true) };
  }

  /** Creates the type parameters of a generic declaration, resolving their constraints in `scope`. */
  protected declareTypeParameters(parameters: TypeParameter[]): TypeParamType[] {
    const declared: TypeParamType[] = parameters.map((parameter) => ({
      kind: 'typeParam',
      name: parameter.name,
      constraint: EMPTY_INTERFACE,
      id: nextTypeParamId++,
    }));
    for (const [index, parameter] of parameters.entries()) {
      this.declare(parameter.name, { kind: 'type', name: parameter.name, type: declared[index] }, parameter);
      this.typeParamSpans.set(declared[index].id, parameter);
    }
    const pendingKeys = this.deferredMapKeys.length;
    for (const [index, parameter] of parameters.entries()) {
      const constraint = this.resolveConstraint(parameter.constraint);
      if (constraint.kind === 'typeParam') {
        this.error(parameter.constraint, '型パラメータそのものは、型の制約に使えません。');
        continue;
      }
      const under = underlying(constraint);
      if (constraint === BASIC.invalid) continue;
      if (constraint.kind === 'named') declared[index].constraintName = constraint;
      // A constraint that is not an interface, `[T int]`, stands for the interface of that single type.
      declared[index].constraint =
        under.kind === 'interface'
          ? under
          : { kind: 'interface', methods: [], typeSet: { terms: [{ tilde: false, type: constraint }] } };
    }
    for (const { key, span } of this.deferredMapKeys.splice(pendingKeys)) {
      if (!isComparable(key))
        this.error(span, `${describeType(key)} は比較できない型なので、map のキーには使えません。`);
    }
    return declared;
  }

  /** Checks that type arguments satisfy their constraints, reporting the first one that does not. */
  protected checkTypeArguments(params: TypeParamType[], args: Type[], span: Span): boolean {
    // A constraint may refer to the other type parameters, as `S ~[]E` does.
    const mapping = new Map(params.map((param, index) => [param.id, args[index]]));
    for (const [index, param] of params.entries()) {
      const constraint = substituteInterface(param.constraint, mapping, (named, namedArgs) =>
        this.instantiateNamed(named, namedArgs)
      );
      const failure = this.unsatisfied(args[index], constraint);
      if (failure) {
        this.error(
          span,
          `${describeType(args[index])} は ${param.name} の制約 ${describeConstraint(param)} を満たしていません（${failure}）。`
        );
        return false;
      }
    }
    return true;
  }

  /** Why a type does not satisfy a constraint, or undefined when it does. */
  // code-gauge-allow functionCognitiveComplexity 22 -- Resolves each Go type form together with its scope and diagnostic context.
  protected unsatisfied(type: Type, constraint: InterfaceType): string | undefined {
    const set = constraint.typeSet;
    if (set?.comparable && !isComparable(type)) return '比較できない型です';
    const terms = effectiveTerms(constraint);
    if (terms) {
      const matches = terms.some((term) =>
        term.tilde ? identical(underlying(type), underlying(term.type)) : identical(type, term.type)
      );
      if (!matches && type.kind !== 'typeParam') return '使える型の一覧にありません';
      if (type.kind === 'typeParam') {
        const own = effectiveTerms(type.constraint);
        const covered = own?.every((ownTerm) => terms.some((term) => termIncludes(term, ownTerm)));
        if (!covered) return '使える型の一覧にありません';
      }
    }
    for (const method of constraint.methods) {
      const missing = this.missingMethodOf(type, method);
      if (missing) return missing;
    }
    return undefined;
  }

  protected abstract missingMethodOf(type: Type, method: InterfaceMethod): string | undefined;

  protected abstract instantiateNamed(named: NamedType, args: Type[]): NamedType;
}

function describeConstraint(param: TypeParamType): string {
  const { constraint } = param;
  if (constraint === COMPARABLE || (constraint.typeSet?.comparable && constraint.methods.length === 0))
    return 'comparable';
  if (constraint === EMPTY_INTERFACE) return 'any';
  const named = param.constraintName ?? CONSTRAINT_NAMES.get(constraint);
  if (named) return named.pkg && named.pkg !== 'main' ? `${named.pkg.split('/').at(-1)}.${named.name}` : named.name;
  const terms = constraint.typeSet?.terms;
  if (terms && constraint.methods.length === 0) {
    return terms.map((term) => `${term.tilde ? '~' : ''}${describeType(term.type)}`).join(' | ');
  }
  return describeType(constraint);
}

/** Whether a term's types all belong to another term's. */
function termIncludes(outer: TypeTerm, inner: TypeTerm): boolean {
  if (outer.tilde) return identical(underlying(inner.type), outer.type);
  return !inner.tilde && identical(inner.type, outer.type);
}

/** The terms of the intersection of two unions, as an interface with several type elements has. */
function intersectTerms(a: TypeTerm[], b: TypeTerm[]): TypeTerm[] {
  const result: TypeTerm[] = [];
  for (const x of a) {
    for (const y of b) {
      if (termIncludes(y, x)) result.push(x);
      else if (termIncludes(x, y)) result.push(y);
    }
  }
  return result;
}

// code-gauge-allow functionCognitiveComplexity 25 -- Traverses all composite type constructors.
// code-gauge-allow functionNcss 43 -- Resolves each Go type form together with its scope and diagnostic context.
function collectTypeParams(type: Type, out: TypeParamType[], seen = new Set<Type>()): void {
  if (type.kind === 'typeParam') {
    out.push(type);
    return;
  }
  if (seen.has(type)) return;
  seen.add(type);
  switch (type.kind) {
    case 'named': {
      for (const arg of type.typeArgs ?? []) collectTypeParams(arg, out, seen);
      return;
    }
    case 'pointer':
    case 'slice':
    case 'array': {
      collectTypeParams(type.element, out, seen);
      return;
    }
    case 'map': {
      collectTypeParams(type.key, out, seen);
      collectTypeParams(type.value, out, seen);
      return;
    }
    case 'struct': {
      for (const field of type.fields) collectTypeParams(field.type, out, seen);
      return;
    }
    case 'func': {
      for (const param of type.params) collectTypeParams(param, out, seen);
      for (const result of type.results) collectTypeParams(result, out, seen);
      return;
    }
    case 'interface': {
      for (const method of type.methods) collectTypeParams(method.type, out, seen);
      for (const term of type.typeSet?.terms ?? []) collectTypeParams(term.type, out, seen);
      return;
    }
    case 'tuple': {
      for (const element of type.types) collectTypeParams(element, out, seen);
      return;
    }
    default: {
      return;
    }
  }
}
