import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import type { Expression, Span, TypeExpression, TypeParameter } from './ast';
import type { Entity, FunctionContext, PackageEntity, TypeEntity, VarEntity } from './entities';
import { substituteInterface } from './generics';
import type { Eval, Exec, Frame, FunctionInfo, LocalInfo, Suspending } from './runtime';
import { Scope } from './scope';
import {
  BASIC,
  COMPARABLE,
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
  /** Whether the program uses goroutines, channels, locks, or sleeps, whose statements may block. */
  protected concurrent = false;
  /** Where the computations that may block of the expression being compiled go, when it may block. */
  protected hoists: Hoist[] | undefined;

  constructor(protected readonly trace: TraceSettings | undefined) {}

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
    this.declare(name, entity, span);
    return entity;
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

  /** Compiles code that runs where it cannot block, such as a deferred call, whose calls run to their end. */
  protected withoutHoists<T>(compile: () => T): T {
    const outer = this.hoists;
    this.hoists = undefined;
    try {
      return compile();
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
    entity.escapes = true;
    const existing = fn.captures.get(entity);
    if (existing !== undefined) return existing;
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
    return {
      info,
      parent,
      captures: new Map(),
      results: [],
      resultVariables: [],
      hasNamedResults: false,
      references: new Set(),
      productOrders: new Map(),
      loopDepth: 0,
      breakDepth: 0,
      recordsSteps: this.trace !== undefined,
    };
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
        if (key !== BASIC.invalid && !this.isComparableKey(key)) {
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

  private isComparableKey(type: Type): boolean {
    // A named type still being declared is checked when it is complete.
    if (type.kind === 'named' && type.underlying === BASIC.invalid) return true;
    return isComparable(type);
  }

  /** Types whose declarations are being resolved, for detecting `type T struct { t T }`. */
  protected readonly resolvingTypes = new Set<NamedType>();

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
      return entity.generic.instantiate(args, syntax);
    }
    if (syntax.typeArguments.length > 0) return this.error(syntax, `${syntax.name} は型引数を持たない型です。`);
    const type = entity.type;
    if (direct && type.kind === 'named' && this.resolvingTypes.has(type)) {
      return this.error(type.span ?? syntax, `型 ${type.name} が自分自身を直接含んでいます。`);
    }
    return type;
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
        const under = type.kind === 'pointer' ? type.element : type;
        if (field.type.kind === 'pointer' && under.kind === 'named' && underlying(under).kind === 'pointer') {
          this.error(field, '埋め込むフィールドに、ポインタの型へのポインタは使えません。');
        }
      }
      if (name !== '_' && names.has(name)) this.error(field, `フィールド ${name} が2回宣言されています。`);
      names.add(name);
      fields.push({ name, type, embedded: field.name === undefined });
    }
    return { kind: 'struct', fields };
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
  return describeType(constraint);
}
