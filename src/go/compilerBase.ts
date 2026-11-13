import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import type { Expression, Span, TypeExpression, TypeParameter } from './ast';
import { type Entity, type FunctionContext, type PackageEntity, type TypeEntity, type VarEntity } from './entities';
import { substituteInterface } from './generics';
import type { Exec, FunctionInfo, LocalInfo } from './runtime';
import { Scope } from './scope';
import { sizeOf, STACK_BUFFER_SIZE } from './sliceOps';
import { newSliceTracking } from './slicePass';
import {
  BASIC,
  COMPARABLE,
  CONSTRAINT_NAMES,
  describeType,
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
  underlying,
} from './types';
import { UNIVERSE } from './universe';

export interface TraceSettings {
  /** The rows of `// atomic` annotations, which mark the function declared there. */
  atomicRows: ReadonlySet<number>;
}

let nextTypeParamId = 0;

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
  /** The compiled functions by their runtime information, for finding the function a frame runs. */
  protected readonly functionContexts = new Map<FunctionInfo, FunctionContext>();
  protected runtimeCallCount = 0;
  protected readonly builtinPanicCalls = new WeakSet<Expression>();

  constructor(protected readonly trace: TraceSettings | undefined) {}

  protected withRuntimeCallTracking<T>(run: () => T): { result: T; hasRuntimeCall: boolean } {
    const before = this.runtimeCallCount;
    const result = run();
    return { result, hasRuntimeCall: this.runtimeCallCount > before };
  }

  // Diagnostics ---------------------------------------------------------------------------------------------------

  /** Records an error and returns the invalid type, which suppresses the errors that would follow from it. */
  protected error(span: Span, message: string): Type {
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

  /** Allocates a slot that no name refers to, such as an unnamed result. */
  protected hiddenSlot(): number {
    return (this.fn as FunctionContext).info.slotCount++;
  }

  /** Looks up a name, marking variables of enclosing functions as captured by the function being compiled. */
  protected lookup(name: string): Entity | undefined {
    const entity = this.scope.lookup(name);
    if (entity?.kind === 'var' && entity.owner && this.fn && entity.owner !== this.fn) this.capture(entity, this.fn);
    if (entity?.kind === 'package') entity.used = true;
    return entity;
  }

  /** The index of a captured variable in a function's cells, capturing it through every enclosing closure. */
  protected capture(entity: VarEntity, fn: FunctionContext): number {
    entity.boxed = true;
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
      notInlinable: false,
      references: new Set(),
      products: new Map(),
      sumsOfProducts: [],
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
   * reference to that type makes it infinitely large.
   */
  // code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of type syntax.
  resolveType(syntax: TypeExpression, direct = false): Type {
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
        if (syntax.length === undefined) return BASIC.invalid;
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
    // A named type still being declared is checked once its declaration completes.
    if (type.kind === 'named' && type.underlying === BASIC.invalid) {
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

  private resolveNamedType(syntax: Extract<TypeExpression, { kind: 'name' }>, direct: boolean): Type {
    let entity: Entity | undefined;
    if (syntax.package) {
      const pkg = this.lookup(syntax.package);
      if (pkg?.kind !== 'package') return this.error(syntax, `${syntax.package} は宣言されていません。`);
      entity = this.packageMember(pkg, syntax.name, syntax);
      if (!entity) return BASIC.invalid;
    } else {
      entity = this.lookup(syntax.name);
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
    void direct;
    return entity.type;
  }

  /** Completes a type entity whose declaration has not been resolved yet. */
  protected abstract useType(entity: TypeEntity): void;

  protected packageMember(pkg: PackageEntity, name: string, span: Span): Entity | undefined {
    pkg.used = true;
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
      fields.push({ name, type, embedded: field.name === undefined });
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

  private resolveInterface(syntax: Extract<TypeExpression, { kind: 'interface' }>): InterfaceType {
    if (syntax.methods.length === 0) return EMPTY_INTERFACE;
    const methods: InterfaceMethod[] = [];
    for (const method of syntax.methods) {
      if (methods.some((other) => other.name === method.name)) {
        this.error(method, `メソッド ${method.name} が2回宣言されています。`);
        continue;
      }
      methods.push({ name: method.name, type: this.resolveSignature(method.signature).type });
    }
    methods.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { kind: 'interface', methods };
  }

  protected resolveSignature(signature: {
    parameters: { name?: string; type: TypeExpression }[];
    results: { name?: string; type: TypeExpression }[];
  }): {
    type: FuncType;
  } {
    const params = signature.parameters.map((parameter) => this.resolveType(parameter.type));
    const results = signature.results.map((result) => this.resolveType(result.type));
    return { type: funcType(params, results) };
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
    for (const [index, parameter] of parameters.entries()) {
      const constraint = this.resolveType(parameter.constraint);
      const under = underlying(constraint);
      if (constraint === BASIC.invalid) continue;
      if (under.kind !== 'interface') {
        this.error(
          parameter.constraint,
          `${describeType(constraint)} は型の制約には使えません（インターフェースを書いてください）。`
        );
        continue;
      }
      if (constraint.kind === 'named') CONSTRAINT_NAMES.set(under, constraint);
      declared[index].constraint = under;
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
          `${describeType(args[index])} は ${param.name} の制約 ${describeConstraint(param.constraint)} を満たしていません（${failure}）。`
        );
        return false;
      }
    }
    return true;
  }

  /** Why a type does not satisfy a constraint, or undefined when it does. */
  protected unsatisfied(type: Type, constraint: InterfaceType): string | undefined {
    const set = constraint.typeSet;
    if (set?.comparable && !isComparable(type)) return '比較できない型です';
    if (set?.terms) {
      const matches = set.terms.some((term) =>
        term.tilde ? identical(underlying(type), underlying(term.type)) : identical(type, term.type)
      );
      if (!matches && type.kind !== 'typeParam') return '使える型の一覧にありません';
      if (type.kind === 'typeParam') {
        const own = type.constraint.typeSet?.terms;
        const covered = own?.every((ownTerm) =>
          set.terms?.some((term) =>
            term.tilde ? identical(underlying(ownTerm.type), underlying(term.type)) : identical(ownTerm.type, term.type)
          )
        );
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

function describeConstraint(constraint: InterfaceType): string {
  if (constraint === COMPARABLE || (constraint.typeSet?.comparable && constraint.methods.length === 0))
    return 'comparable';
  if (constraint === EMPTY_INTERFACE) return 'any';
  const named = CONSTRAINT_NAMES.get(constraint);
  if (named) return named.pkg && named.pkg !== 'main' ? `${named.pkg.split('/').at(-1)}.${named.name}` : named.name;
  const terms = constraint.typeSet?.terms;
  if (terms && constraint.methods.length === 0) {
    return terms.map((term) => `${term.tilde ? '~' : ''}${describeType(term.type)}`).join(' | ');
  }
  return describeType(constraint);
}

// code-gauge-allow functionCognitiveComplexity 25 -- Traverses all composite type constructors.
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
