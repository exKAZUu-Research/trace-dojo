import { misplacedAtomicMessage } from '../interpreter/traceAnnotations';
import { assignFailure, represent } from './assignability';
import type { ConstDeclaration, File, FunctionDeclaration, Span, TypeDeclaration, TypeSpec, VarSpec } from './ast';
import type { TraceSettings } from './compilerBase';
import type { ConstEntity, FunctionContext, GenericFunc, TypeEntity, VarEntity } from './entities';
import { mapKeyOf } from './equality';
import { containsTypeParam, substitute } from './generics';
import { currentRuntime } from './native';
import { lookupPackage } from './packages/index';
import type { FunctionInfo, LocalInfo } from './runtime';
import { Scope } from './scope';
import { STANDARD_PACKAGES } from './standardPackages';
import { declareValue, StatementCompiler } from './statementCompiler';
import {
  BASIC,
  describeType,
  type FuncType,
  funcType,
  type InterfaceMethod,
  isComparable,
  isUntyped,
  type Method,
  missingMethod,
  type NamedType,
  type Type,
  typeIdentityKey,
  type TypeParamType,
  underlying,
} from './types';
import { GoFunc, type Value, writeInPlace } from './values';

export interface CompiledProgram {
  main: FunctionInfo;
  /** Runs the package-level variables' initializers in Go's initialization order. */
  initializer: FunctionInfo;
  globals: { name: string; type: Type; slot: number }[];
  globalZeros: (() => Value)[];
}

interface FunctionDeclarationState {
  declaration: FunctionDeclaration;
  entity: { info?: FunctionInfo; references?: Set<unknown> };
}

/** Compiles a file of package main, reporting every error Go's compiler would report before running it. */
export class ProgramCompiler extends StatementCompiler {
  private readonly globals: VarEntity[] = [];
  private readonly globalZeros: (() => Value)[] = [];
  private readonly initContext = this.newFunctionContext('init', undefined, () => {});
  private readonly initializers: {
    spec: VarSpec;
    variables: VarEntity[];
    run: (frame: never) => void;
    references: Set<unknown>;
    done: boolean;
  }[] = [];
  /** Code that must compile once every declaration is known: function bodies and instances of generic code. */
  private readonly pendingBodies: (() => void)[] = [];
  private readonly pendingGenericChecks: (() => void)[] = [];
  private readonly typeStates = new Map<TypeEntity, { spec: TypeSpec; resolved: boolean }>();
  private readonly namedRhs = new Map<NamedType, Type>();
  private readonly newlyResolvedTypes: TypeEntity[] = [];
  private useTypeDepth = 0;
  private totalGenericInstances = 0;
  private readonly methodSpecs = new Map<string, FunctionDeclaration[]>();
  private readonly functionReferences = new Map<unknown, Set<unknown>>();
  private readonly claimedAtomicRows = new Set<number>();

  constructor(
    private readonly file: File,
    trace: TraceSettings | undefined
  ) {
    super(trace);
  }

  compile(): CompiledProgram {
    const { file } = this;
    if (file.packageName !== 'main') {
      this.error(
        file.packageSpan,
        `package ${file.packageName} ではなく package main にしてください（実行できるのは main パッケージだけです）。`
      );
    }
    this.declareImports();
    this.collectDeclarations();
    for (const [entity] of this.typeStates) this.useType(entity);
    this.attachMethods();
    for (const entity of this.instances.keys()) this.completeInstances(entity);
    for (const resolve of this.pendingSignatures) resolve();
    for (const entity of this.packageScope.entities.values()) if (entity.kind === 'const') entity.pending?.();
    while (this.pendingGenericChecks.length > 0) (this.pendingGenericChecks.shift() as () => void)();
    for (const initializer of this.globals) initializer.pending?.();
    this.runPending();
    this.checkImportsUsed();
    this.checkAtomicAnnotations();
    const main = this.mainFunction();
    this.throwIfErrors();
    return {
      main: main as FunctionInfo,
      initializer: this.initializerFunction(),
      globals: this.globals
        .filter((variable) => variable.name !== '_')
        .map(({ name, type, slot }) => ({ name, type, slot })),
      globalZeros: this.globalZeros,
    };
  }

  private runPending(): void {
    while (this.pendingBodies.length > 0) (this.pendingBodies.shift() as () => void)();
  }

  // Imports -------------------------------------------------------------------------------------------------------

  private declareImports(): void {
    for (const spec of this.file.imports) {
      const pkg = lookupPackage(spec.path);
      if (!pkg) {
        if (STANDARD_PACKAGES.has(spec.path)) this.unsupported(spec, `パッケージ ${spec.path}`);
        else if (/^[^/]*\./.test(spec.path)) this.unsupported(spec, `標準ライブラリ以外のパッケージ（${spec.path}）`);
        else this.error(spec, `パッケージ ${spec.path} は標準ライブラリにありません。`);
        continue;
      }
      const name = spec.alias ?? pkg.name;
      if (name === '_') continue;
      if (this.fileScope.entities.has(name)) {
        this.error(spec, `パッケージの名前 ${name} が2回 import されています。`);
        continue;
      }
      this.fileScope.entities.set(name, { kind: 'package', name, package: pkg, span: spec, used: false });
    }
  }

  private checkImportsUsed(): void {
    for (const entity of this.fileScope.entities.values()) {
      if (entity.kind === 'package' && !entity.used) {
        this.error(entity.span, `パッケージ "${entity.package.path}" を import していますが、使っていません。`);
      }
    }
  }

  // Declarations --------------------------------------------------------------------------------------------------

  private declarePackageName(name: string, entity: Parameters<StatementCompiler['declare']>[1], span: Span): void {
    if (name === '_') return;
    if (this.fileScope.entities.has(name)) {
      this.error(span, `${name} は import したパッケージの名前と同じなので、宣言できません。`);
      return;
    }
    if (this.packageScope.entities.has(name)) {
      this.error(span, `${name} はこのパッケージですでに宣言されています。`);
      return;
    }
    this.packageScope.entities.set(name, entity);
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of top-level declaration.
  private collectDeclarations(): void {
    for (const declaration of this.file.declarations) {
      switch (declaration.kind) {
        case 'type': {
          for (const spec of declaration.specs) this.declareTypeSpec(spec, this.packageScope);
          break;
        }
        case 'func': {
          if (declaration.receiver) {
            const list = this.methodSpecs.get(declaration.receiver.typeName) ?? [];
            list.push(declaration);
            this.methodSpecs.set(declaration.receiver.typeName, list);
          } else {
            this.declareFunction(declaration);
          }
          break;
        }
        case 'var': {
          for (const spec of declaration.specs) this.declareGlobal(spec);
          break;
        }
        case 'const': {
          this.declarePackageConstants(declaration);
          break;
        }
      }
    }
  }

  /** Declares a type, whose underlying type resolves when first used, so that declarations may refer to later ones. */
  private declareTypeSpec(spec: TypeSpec, scope: Scope): TypeEntity {
    const shell: NamedType = {
      kind: 'named',
      name: spec.name,
      pkg: 'main',
      underlying: BASIC.invalid,
      methods: [],
      span: spec,
    };
    const entity: TypeEntity = { kind: 'type', name: spec.name, type: shell, span: spec };
    if (spec.typeParameters.length > 0) {
      const cache = new Map<string, NamedType>();
      this.instances.set(entity, cache);
      entity.generic = {
        typeParams: [],
        instantiate: (args, span) => this.instantiateGeneric(entity, shell, args, cache, span),
      };
    }
    if (scope === this.packageScope) this.declarePackageName(spec.name, entity, spec);
    else this.declare(spec.name, entity, spec);
    this.typeStates.set(entity, { spec, resolved: false });
    return entity;
  }

  protected useType(entity: TypeEntity): void {
    const state = this.typeStates.get(entity);
    if (!state || state.resolved) return;
    state.resolved = true;
    const shell = entity.type as NamedType;
    const outerScope = this.scope;
    const outerFn = this.fn;
    this.scope = new Scope(entity.generic ? this.scopeOfType(entity) : this.scope);
    this.useTypeDepth++;
    this.newlyResolvedTypes.push(entity);
    try {
      if (entity.generic) {
        entity.generic.typeParams = this.declareTypeParameters(state.spec.typeParameters);
        shell.typeParams = entity.generic.typeParams;
      }
      this.resolvingTypes.add(shell);
      const rawType = this.resolveType(state.spec.type, true);
      this.namedRhs.set(shell, rawType);
      const underlyingType = underlying(rawType);
      this.resolvingTypes.delete(shell);
      shell.underlying = underlyingType.kind === 'named' ? underlying(underlyingType) : underlyingType;
      if (entity.generic) this.completeInstances(entity);
      if (underlyingType.kind === 'interface' && underlyingType.typeSet) {
        this.error(state.spec, '型の集合を持つインターフェースは、型の制約にしか使えません。');
      }
    } finally {
      this.scope = outerScope;
      this.fn = outerFn;
      this.useTypeDepth--;
      if (this.useTypeDepth === 0) this.finishResolvedTypes();
    }
  }

  private finishResolvedTypes(): void {
    const batch = this.newlyResolvedTypes.splice(0);
    const cyclic = new Set<TypeEntity>();
    for (const entity of batch) {
      const shell = entity.type as NamedType;
      if (this.reachesDirectly(shell)) cyclic.add(entity);
    }
    for (const entity of cyclic) {
      const shell = entity.type as NamedType;
      const state = this.typeStates.get(entity);
      shell.underlying = BASIC.invalid;
      this.namedRhs.delete(shell);
      for (const instance of this.instances.get(entity)?.values() ?? []) instance.underlying = BASIC.invalid;
      this.error(shell.span ?? state?.spec ?? { row: 0, column: 0 }, `型 ${shell.name} が自分自身を直接含んでいます。`);
    }
    for (const entity of batch) {
      if (cyclic.has(entity)) continue;
      const shell = entity.type as NamedType;
      let target = this.namedRhs.get(shell);
      if (target?.kind === 'named') {
        const seen = new Set<Type>([shell]);
        while (target?.kind === 'named' && !seen.has(target) && this.namedRhs.has(target)) {
          seen.add(target);
          target = this.namedRhs.get(target);
        }
        if (target) {
          const under = underlying(target);
          shell.underlying = under.kind === 'named' ? underlying(under) : under;
        }
      }
      if (entity.generic) this.completeInstances(entity);
    }
    for (const { key, span } of this.deferredMapKeys.splice(0)) {
      if (key !== BASIC.invalid && !(key.kind === 'named' && key.underlying === BASIC.invalid) && !isComparable(key)) {
        this.error(span, `${describeType(key)} は比較できない型なので、map のキーには使えません。`);
      }
    }
  }

  private reachesDirectly(start: NamedType): boolean {
    const seen = new Set<Type>();
    const stack: Type[] = [];
    const pushDirect = (type: Type | undefined): void => {
      if (type && type !== BASIC.invalid) stack.push(type);
    };
    pushDirect(this.namedRhs.get(start));
    pushDirect(start.underlying);
    while (stack.length > 0) {
      const current = stack.pop() as Type;
      if (
        current === start ||
        (current.kind === 'named' &&
          current.origin === start &&
          current.typeArgs?.every((arg, index) => arg === start.typeParams?.[index]))
      ) {
        return true;
      }
      if (seen.has(current)) continue;
      seen.add(current);
      if (current.kind === 'named') {
        pushDirect(this.namedRhs.get(current));
        pushDirect(current.underlying);
      } else if (current.kind === 'struct') {
        for (const field of current.fields) pushDirect(field.type);
      } else if (current.kind === 'array') {
        pushDirect(current.element);
      }
    }
    return false;
  }

  private countGenericInstance(span: Span): void {
    if (++this.totalGenericInstances > 1024) {
      this.error(span, 'ジェネリックのインスタンスが多すぎます。');
      this.throwIfErrors();
    }
  }

  private scopeOfType(entity: TypeEntity): Scope {
    return this.typeStates.has(entity) && this.packageScope.entities.get(entity.name) === entity
      ? this.fileScope
      : this.scope;
  }

  /** Instantiates a generic type with type arguments, once per distinct list of arguments. */
  private instantiateGeneric(
    entity: TypeEntity,
    shell: NamedType,
    args: Type[],
    cache: Map<string, NamedType>,
    span?: Span
  ): NamedType {
    this.useType(entity);
    const key = args.map((arg) => typeIdentityKey(arg)).join(',');
    const cached = cache.get(key);
    if (cached) return cached;
    if (!args.some((arg) => containsTypeParam(arg))) {
      this.countGenericInstance(span ?? shell.span ?? { row: 0, column: 0 });
    }
    const instance: NamedType = {
      kind: 'named',
      name: shell.name,
      pkg: 'main',
      underlying: BASIC.invalid,
      methods: [],
      typeArgs: args,
      origin: shell,
      span: shell.span,
    };
    cache.set(key, instance);
    if (!this.hasGenericCycle) this.completeInstance(entity, instance);
    return instance;
  }

  /**
   * Fills in an instance of a generic type from its declaration: its underlying type, once the declaration resolves,
   * and the methods declared so far. A type that refers to itself, as `next *List[T]` does, is instantiated before its
   * declaration completes, so this runs again when the declaration and its methods are complete.
   */
  private completeInstance(entity: TypeEntity, instance: NamedType): void {
    const shell = entity.type as NamedType;
    const args = instance.typeArgs ?? [];
    const params = entity.generic?.typeParams ?? [];
    const mapping = new Map(params.map((param, index) => [param.id, args[index]]));
    const instantiate = (named: NamedType, namedArgs: Type[]): NamedType => this.instantiateNamed(named, namedArgs);
    if (
      instance.underlying === BASIC.invalid &&
      !this.resolvingTypes.has(shell) &&
      shell.underlying !== BASIC.invalid
    ) {
      instance.underlying = substitute(shell.underlying, mapping, instantiate);
    }
    for (const method of shell.methods) {
      if (instance.methods.some((existing) => existing.name === method.name)) continue;
      const type = substitute(method.type, mapping, instantiate) as FuncType;
      const instanceMethod: Method = {
        name: method.name,
        pointerReceiver: method.pointerReceiver,
        type,
        code: {},
        span: method.span,
      };
      instance.methods.push(instanceMethod);
      const declaration = this.genericMethodDeclarations.get(method);
      if (declaration?.body && !this.hasGenericCycle && !args.some((arg) => containsTypeParam(arg))) {
        this.pendingBodies.push(() => {
          if (!this.hasGenericCycle) this.compileMethod(declaration, instance, instanceMethod, args);
        });
      }
    }
  }

  /** Completes the instances of a generic type created while its declaration or its methods were incomplete. */
  private completeInstances(entity: TypeEntity): void {
    if (this.hasGenericCycle) return;
    for (const instance of this.instances.get(entity)?.values() ?? []) this.completeInstance(entity, instance);
  }

  private readonly instances = new Map<TypeEntity, Map<string, NamedType>>();

  protected instantiateNamed(named: NamedType, args: Type[]): NamedType {
    const entity = [...this.typeStates.keys()].find((candidate) => candidate.type === named);
    if (!entity?.generic || this.hasGenericCycle) return named;
    const span = named.span ?? { row: 0, column: 0 };
    if (!this.recordGenericInstantiation(entity.generic.typeParams, args, span)) return named;
    return entity.generic.instantiate(args, span);
  }

  private readonly genericMethodDeclarations = new Map<Method, FunctionDeclaration>();

  // code-gauge-allow functionCognitiveComplexity 25 -- Methods of named types, generic or not, with Go's checks.
  private attachMethods(): void {
    for (const [typeName, declarations] of this.methodSpecs) {
      const entity = this.packageScope.entities.get(typeName);
      if (entity?.kind !== 'type' || !this.typeStates.has(entity)) {
        const message =
          entity?.kind === 'type' || this.packageScope.lookup(typeName)?.kind === 'type'
            ? `${typeName} はこのパッケージで宣言した型ではないので、メソッドを付けられません。`
            : `${typeName} は宣言されていません。`;
        for (const declaration of declarations) this.error(declaration.receiver as Span, message);
        continue;
      }
      const shell = entity.type as NamedType;
      if (underlying(shell).kind === 'pointer' || underlying(shell).kind === 'interface') {
        for (const declaration of declarations) {
          this.error(
            declaration.receiver as Span,
            `${typeName} はポインタかインターフェースの型なので、メソッドを付けられません。`
          );
        }
        continue;
      }
      for (const declaration of declarations) {
        const receiver = declaration.receiver as NonNullable<FunctionDeclaration['receiver']>;
        const generic = entity.generic;
        if (generic && receiver.typeArguments.length !== generic.typeParams.length) {
          this.error(receiver, `レシーバの型 ${typeName} には型引数を ${generic.typeParams.length} 個書いてください。`);
          continue;
        }
        if (!generic && receiver.typeArguments.length > 0) {
          this.error(receiver, `${typeName} は型引数を持たない型です。`);
          continue;
        }
        if (shell.methods.some((method) => method.name === declaration.name)) {
          this.error(declaration.nameSpan, `メソッド ${typeName}.${declaration.name} が2回宣言されています。`);
          continue;
        }
        if (
          underlying(shell).kind === 'struct' &&
          (underlying(shell) as { fields: { name: string }[] }).fields.some((field) => field.name === declaration.name)
        ) {
          this.error(
            declaration.nameSpan,
            `${typeName} にはフィールド ${declaration.name} があるので、同じ名前のメソッドは宣言できません。`
          );
          continue;
        }
        const type = this.withTypeArguments(
          generic?.typeParams ?? [],
          receiver.typeArguments,
          undefined,
          () => this.resolveSignature(declaration.signature).type
        );
        const method: Method = {
          name: declaration.name,
          pointerReceiver: receiver.pointer,
          type,
          code: {},
          span: declaration,
        };
        shell.methods.push(method);
        if (!declaration.body) {
          this.error(declaration, `メソッド ${declaration.name} に本体がありません。`);
          continue;
        }
        if (generic) {
          this.genericMethodDeclarations.set(method, declaration);
          // The generic method's body is checked once with its type parameters.
          this.pendingGenericChecks.push(() => this.compileMethod(declaration, shell, method, undefined));
        } else {
          this.pendingBodies.push(() => this.compileMethod(declaration, shell, method, undefined));
        }
      }
    }
  }

  /** Runs `compile` in a scope where the receiver's type parameter names stand for the given types. */
  private withTypeArguments<T>(
    params: readonly TypeParamType[],
    names: string[],
    args: Type[] | undefined,
    compile: () => T
  ): T {
    const outer = this.scope;
    this.scope = new Scope(this.fileScope);
    try {
      for (const [index, name] of names.entries()) {
        if (name === '_') continue;
        this.scope.entities.set(name, { kind: 'type', name, type: args ? args[index] : params[index] });
      }
      return compile();
    } finally {
      this.scope = outer;
    }
  }

  private compileMethod(
    declaration: FunctionDeclaration,
    owner: NamedType,
    method: Method,
    args: Type[] | undefined
  ): void {
    const receiver = declaration.receiver as NonNullable<FunctionDeclaration['receiver']>;
    const isInstance = args !== undefined;
    const origin = owner.origin ?? owner;
    const params = origin.typeParams ?? [];
    const outerReporting = this.reporting;
    const outerFn = this.fn;
    if (isInstance) this.reporting = false;
    try {
      this.withTypeArguments(params, receiver.typeArguments, args, () => {
        const receiverBase: Type = params.length > 0 ? this.instantiateNamed(origin, args ?? params) : owner;
        const receiverType: Type = receiver.pointer ? { kind: 'pointer', element: receiverBase } : receiverBase;
        const type = this.resolveSignature(declaration.signature).type;
        this.fn = undefined;
        const fn = this.functionBody(
          `${owner.name}.${declaration.name}`,
          declaration.signature,
          type,
          declaration.body as NonNullable<FunctionDeclaration['body']>,
          { name: receiver.name, type: receiverType, span: receiver },
          this.isAtomic(declaration)
        );
        this.functionReferences.set(method, fn.references);
        if (params.length > 0 && !isInstance) return;
        const { info } = fn;
        (method.code as { call?: unknown }).call = (
          receiverValue: Value,
          argValues: Value[],
          callRow?: number,
          deferredFor?: unknown
        ) => currentRuntime().call(info, [], [receiverValue, ...argValues], callRow, deferredFor as never);
      });
    } finally {
      this.reporting = outerReporting;
      this.fn = outerFn;
    }
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- Functions, generic or not, and the checks of main and init.
  private declareFunction(declaration: FunctionDeclaration): void {
    const { name } = declaration;
    if (name === 'init') {
      this.unsupported(declaration, 'init 関数');
      return;
    }
    if (!declaration.body) {
      this.error(declaration, `関数 ${name} に本体がありません。`);
      return;
    }
    if (declaration.typeParameters.length > 0) {
      this.declareGenericFunction(declaration);
      return;
    }
    const state: FunctionDeclarationState['entity'] = {};
    let type: FuncType = funcType([], []);
    let value: GoFunc | undefined;
    const call = (args: Value[], callRow?: number, deferredFor?: unknown): Value | Value[] =>
      currentRuntime().call(state.info as FunctionInfo, [], args, callRow, deferredFor as never);
    const entity = {
      kind: 'func' as const,
      name,
      type,
      span: declaration,
      declaration,
      value: () => (value ??= new GoFunc(call)),
      direct: (args: Value[], callRow: number | undefined) => call(args, callRow),
    };
    this.declarePackageName(name, entity, declaration.nameSpan);
    this.pendingSignatures.push(() => {
      type = this.withScopeOf(this.fileScope, () => this.resolveSignature(declaration.signature).type);
      entity.type = type;
    });
    this.pendingBodies.push(() => {
      this.fn = undefined;
      const fn = this.withScopeOf(this.fileScope, () =>
        this.functionBody(
          name,
          declaration.signature,
          entity.type,
          declaration.body as NonNullable<FunctionDeclaration['body']>,
          undefined,
          this.isAtomic(declaration)
        )
      );
      state.info = fn.info;
      this.functionReferences.set(entity, fn.references);
    });
    if (name === 'main') this.mainEntity = { entity, state, declaration };
  }

  private readonly pendingSignatures: (() => void)[] = [];
  private mainEntity:
    | { entity: { type: FuncType }; state: { info?: FunctionInfo }; declaration: FunctionDeclaration }
    | undefined;

  private withScopeOf<T>(scope: Scope, run: () => T): T {
    const outer = this.scope;
    this.scope = new Scope(scope);
    try {
      return run();
    } finally {
      this.scope = outer;
    }
  }

  private declareGenericFunction(declaration: FunctionDeclaration): void {
    const { name } = declaration;
    const cache = new Map<string, GoFunc>();
    const generic: GenericFunc = {
      typeParams: [],
      type: funcType([], []),
      instantiate: (args) => {
        const key = args.map((arg) => typeIdentityKey(arg)).join(',');
        const cached = cache.get(key);
        if (cached) return cached;
        if (this.hasGenericCycle) return new GoFunc(() => {});
        this.countGenericInstance(declaration);
        const state: { info?: FunctionInfo } = {};
        const instance = new GoFunc((argValues, callRow, deferredFor) =>
          currentRuntime().call(state.info as FunctionInfo, [], argValues, callRow, deferredFor as never)
        );
        cache.set(key, instance);
        this.pendingBodies.push(() => {
          if (this.hasGenericCycle) return;
          const outerReporting = this.reporting;
          const outerFn = this.fn;
          this.reporting = false;
          try {
            this.withTypeArguments(
              generic.typeParams,
              declaration.typeParameters.map((param) => param.name),
              args,
              () => {
                const type = this.resolveSignature(declaration.signature).type;
                this.fn = undefined;
                state.info = this.functionBody(
                  name,
                  declaration.signature,
                  type,
                  declaration.body as NonNullable<FunctionDeclaration['body']>,
                  undefined,
                  this.isAtomic(declaration)
                ).info;
              }
            );
          } finally {
            this.reporting = outerReporting;
            this.fn = outerFn;
          }
        });
        return instance;
      },
    };
    const entity = {
      kind: 'func' as const,
      name,
      type: generic.type,
      span: declaration,
      declaration,
      generic,
      value: () => new GoFunc(() => {}),
    };
    this.declarePackageName(name, entity, declaration.nameSpan);
    this.pendingSignatures.push(() => {
      this.withScopeOf(this.fileScope, () => {
        generic.typeParams = this.declareTypeParameters(declaration.typeParameters);
        generic.type = this.resolveSignature(declaration.signature).type;
        entity.type = generic.type;
      });
    });
    this.pendingGenericChecks.push(() => {
      this.fn = undefined;
      this.withTypeArguments(
        generic.typeParams,
        declaration.typeParameters.map((param) => param.name),
        undefined,
        () => {
          const fn = this.functionBody(
            name,
            declaration.signature,
            generic.type,
            declaration.body as NonNullable<FunctionDeclaration['body']>,
            undefined,
            false
          );
          this.functionReferences.set(entity, fn.references);
        }
      );
    });
  }

  private isAtomic(declaration: FunctionDeclaration): boolean {
    if (!this.trace) return false;
    for (let row = declaration.row; row <= declaration.headerEndRow; row++) {
      if (this.trace.atomicRows.has(row)) {
        this.claimedAtomicRows.add(row);
        return true;
      }
    }
    return false;
  }

  private checkAtomicAnnotations(): void {
    if (!this.trace) return;
    for (const row of this.trace.atomicRows) {
      if (!this.claimedAtomicRows.has(row)) this.error({ row, column: 0 }, misplacedAtomicMessage);
    }
  }

  private mainFunction(): FunctionInfo | undefined {
    if (!this.mainEntity) {
      this.error({ row: 0, column: 0 }, 'main 関数がありません（func main() { ... } を書いてください）。');
      return undefined;
    }
    const { entity, state, declaration } = this.mainEntity;
    if (entity.type.params.length > 0 || entity.type.results.length > 0) {
      this.error(declaration.nameSpan, 'main 関数には引数も結果も書けません。');
    }
    return state.info;
  }

  // Package-level variables ----------------------------------------------------------------------------------------

  private declareGlobal(spec: VarSpec): void {
    const variables = spec.names.map((name): VarEntity => {
      const slot = this.globals.length;
      const variable: VarEntity = {
        kind: 'var',
        name: name.name,
        type: BASIC.invalid,
        span: name,
        used: true,
        boxed: true,
        owner: undefined,
        slot,
      };
      this.globals.push(variable);
      this.globalZeros.push(() => {});
      this.declarePackageName(name.name, variable, name);
      return variable;
    });
    let resolving = false;
    let resolved = false;
    const resolve = (): void => {
      if (resolved) return;
      if (resolving) {
        this.error(spec, `${spec.names[0].name} の初期化が自分自身に依存しています（初期化の循環）。`);
        for (const variable of variables) variable.pending = undefined;
        return;
      }
      resolving = true;
      this.compileGlobal(spec, variables);
      resolved = true;
      for (const variable of variables) variable.pending = undefined;
    };
    for (const variable of variables) variable.pending = resolve;
  }

  private compileGlobal(spec: VarSpec, variables: VarEntity[]): void {
    const outerScope = this.scope;
    const outerFn = this.fn;
    const outerReferences = this.initContext.references;
    this.scope = new Scope(this.fileScope);
    this.fn = this.initContext;
    const references = new Set<unknown>();
    this.initContext.references = references;
    try {
      const declaredType = spec.type ? this.resolveType(spec.type) : undefined;
      if (declaredType) for (const variable of variables) variable.type = declaredType;
      if (spec.values.length === 0) {
        for (const variable of variables) this.globalZeros[variable.slot] = this.zeroOf(variable.type);
        return;
      }
      const types: Type[] = [];
      const values = this.rightSide(spec, spec.values, variables.length, () => declaredType, types);
      for (const [index, variable] of variables.entries()) {
        if (!declaredType) variable.type = types[index] ?? BASIC.invalid;
        if (isUntyped(variable.type))
          this.error(variable.span, `${variable.name} の型を決められません（nil には型がありません）。`);
        this.globalZeros[variable.slot] = this.zeroOf(variable.type);
      }
      if (!values) return;
      const isConstant = spec.values.every((value) => this.isConstantExpression(value));
      const row = this.trace && !isConstant ? spec.row : undefined;
      const createsObjects = spec.values.every((value) => this.createsObject(value));
      const run = (frame: Parameters<(typeof values)[0]>[0]): void => {
        const evaluate = (): void => {
          const evaluated = values.map((value) => value(frame));
          for (const [index, variable] of variables.entries()) {
            const cell = frame.runtime.globals[variable.slot];
            cell.v = writeInPlace(cell.v, evaluated[index]);
          }
        };
        if (row === undefined) evaluate();
        else frame.runtime.steps.runStatement(row, createsObjects, evaluate);
      };
      this.initializers.push({ spec, variables, run: run as never, references, done: false });
    } finally {
      this.scope = outerScope;
      this.fn = outerFn;
      this.initContext.references = outerReferences;
    }
  }

  private isConstantExpression(expression: VarSpec['values'][number]): boolean {
    const saved = this.reporting;
    this.reporting = false;
    try {
      const operand = this.withScopeOf(this.fileScope, () => this.expression(expression));
      return operand.mode === 'constant';
    } finally {
      this.reporting = saved;
    }
  }

  /** The initializers in Go's order: the earliest declared one whose dependencies are initialized, repeatedly. */
  private initializerFunction(): FunctionInfo {
    const order = this.initializationOrder();
    const info = this.initContext.info;
    info.body = (frame) => {
      for (const initializer of order) initializer.run(frame as never);
      return;
    };
    return info;
  }

  private initializationOrder(): ProgramCompiler['initializers'] {
    this.initializers.sort((a, b) => a.spec.row - b.spec.row || a.spec.column - b.spec.column);
    const dependencies = new Map(
      this.initializers.map((initializer) => [initializer, this.variablesReachedFrom(initializer.references)])
    );
    const owner = new Map<VarEntity, (typeof this.initializers)[number]>();
    for (const initializer of this.initializers)
      for (const variable of initializer.variables) owner.set(variable, initializer);
    const order: ProgramCompiler['initializers'] = [];
    const initialized = new Set<VarEntity>(this.globals.filter((variable) => !owner.has(variable)));
    const pending = [...this.initializers];
    while (pending.length > 0) {
      const ready = pending.findIndex((initializer) =>
        [...(dependencies.get(initializer) as Set<VarEntity>)].every((variable) => initialized.has(variable))
      );
      if (ready === -1) {
        this.error(pending[0].spec, `${pending[0].variables[0].name} の初期化が循環しています。`);
        this.throwIfErrors();
      }
      const [next] = pending.splice(ready, 1);
      order.push(next);
      for (const variable of next.variables) initialized.add(variable);
    }
    return order;
  }

  /** The package-level variables an initializer reaches, through the functions and methods it refers to. */
  private variablesReachedFrom(references: Set<unknown>): Set<VarEntity> {
    const variables = new Set<VarEntity>();
    const seen = new Set<unknown>();
    const stack = [...references];
    while (stack.length > 0) {
      const item = stack.pop();
      if (seen.has(item)) continue;
      seen.add(item);
      if ((item as VarEntity).kind === 'var' && !(item as VarEntity).owner) variables.add(item as VarEntity);
      const inner = this.functionReferences.get(item);
      if (inner) {
        for (const next of inner) stack.push(next);
      }
    }
    return variables;
  }

  // Local declarations --------------------------------------------------------------------------------------------

  /** Declares package-level constants, whose values compute when first used, as they may refer to later ones. */
  private declarePackageConstants(declaration: ConstDeclaration): void {
    for (const spec of declaration.specs) {
      const entities = spec.names.map((name): ConstEntity => ({
        kind: 'const',
        name: name.name,
        type: BASIC.invalid,
        value: { kind: 'int', value: 0n },
        span: name,
        used: true,
      }));
      let state: 'pending' | 'resolving' | 'done' = 'pending';
      const resolve = (): void => {
        if (state === 'done') return;
        if (state === 'resolving') {
          this.error(spec, `定数 ${spec.names[0].name} の値が自分自身に依存しています。`);
          return;
        }
        state = 'resolving';
        const outerFn = this.fn;
        this.fn = undefined;
        try {
          this.withScopeOf(this.fileScope, () => this.constantSpec(spec, entities));
        } finally {
          this.fn = outerFn;
          state = 'done';
          for (const entity of entities) entity.pending = undefined;
        }
      };
      for (const [index, entity] of entities.entries()) {
        entity.pending = resolve;
        this.declarePackageName(spec.names[index].name, entity, spec.names[index]);
      }
    }
  }

  protected constDeclaration(declaration: ConstDeclaration): void {
    for (const spec of declaration.specs) {
      const entities = spec.names.map((name): ConstEntity => ({
        kind: 'const',
        name: name.name,
        type: BASIC.invalid,
        value: { kind: 'int', value: 0n },
        span: name,
        used: false,
      }));
      this.constantSpec(spec, entities);
      // A constant's scope begins after its spec, so the values above see the outer names.
      for (const [index, entity] of entities.entries()) this.declare(spec.names[index].name, entity, spec.names[index]);
    }
  }

  /** Computes the values of a constant spec, checking them against its type. */
  private constantSpec(spec: ConstDeclaration['specs'][number], entities: ConstEntity[]): void {
    if (spec.values.length !== spec.names.length) {
      this.error(spec, spec.values.length < spec.names.length ? '定数の値が足りません。' : '定数の値が多すぎます。');
      for (const value of spec.values) this.expression(value);
      return;
    }
    const declaredType = spec.type ? this.resolveType(spec.type) : undefined;
    for (const [index, entity] of entities.entries()) {
      const operand = this.value(spec.values[index]);
      if (this.isInvalid(operand)) continue;
      if (operand.mode !== 'constant' || !operand.constant) {
        this.error(spec.values[index], `${entity.name} の値には定数の式を書いてください。`);
        continue;
      }
      if (!declaredType) {
        entity.type = operand.type;
        entity.value = operand.constant;
        continue;
      }
      if (declaredType === BASIC.invalid) continue;
      if (!isUntyped(operand.type) && assignFailure(operand.type, declaredType)) {
        this.error(
          operand.span,
          `${describeType(operand.type)} 型の定数は、${describeType(declaredType)} 型の定数には使えません。`
        );
        continue;
      }
      const representation = represent(operand.constant, declaredType);
      if ('error' in representation) {
        this.reportRepresentation(operand, declaredType, representation.error, '定数');
        continue;
      }
      entity.type = declaredType;
      entity.value = representation.constant;
    }
  }

  protected localTypeDeclaration(declaration: TypeDeclaration): void {
    for (const spec of declaration.specs) {
      if (spec.typeParameters.length > 0) {
        this.unsupported(spec, '関数の中で宣言する、型引数を持つ型');
        continue;
      }
      const entity = this.declareTypeSpec(spec, this.scope);
      this.useType(entity);
    }
  }

  // Hooks of the base compilers -------------------------------------------------------------------------------------

  protected missingMethodOf(type: Type, method: InterfaceMethod): string | undefined {
    const missing = missingMethod(type, { kind: 'interface', methods: [method] });
    if (!missing) return undefined;
    if (missing.pointerOnly) return `メソッド ${method.name} はポインタのレシーバを持ちます`;
    return `メソッド ${method.name} がありません`;
  }

  protected mapKeyFunction(type: Type): (key: Value) => unknown {
    return mapKeyOf(type);
  }
}

/** Compiles a parsed file, throwing a `CompileError` with Go's compile errors. */
export function compileProgram(file: File, trace?: TraceSettings): CompiledProgram {
  const compiler = new ProgramCompiler(file, trace);
  return compiler.compile();
}

export { declareValue };
export type { LocalInfo, FunctionContext };
