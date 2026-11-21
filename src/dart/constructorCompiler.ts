// code-gauge-allow-file fileNcss 439 -- Constructor types, initializer ordering, and delegation share the same declarations.
import { AssignmentCompiler } from './assignmentCompiler';
import type {
  Arguments as ArgumentsSyntax,
  Block,
  ClassDeclaration,
  ConstructorDeclaration,
  Expression,
  FormalParameter,
  FormalParameters,
  Span,
} from './ast';
import type { CompiledFunction, FunctionSpec } from './callCompiler';
import { type ClassInfo, type ConstructorImpl, type ConstructorInfo, type FieldMember } from './classes';
import { at, type Compiled, type Eval, typeName } from './compilerBase';
import { Frame, type TypeEnv } from './runtime';
import { LocalScope } from './scope';
import type { Exec } from './statementCompiler';
import {
  type DartType,
  DYNAMIC,
  type FunctionType,
  functionType,
  isNullable,
  isSubtype,
  substitute,
  VOID,
} from './types';
import { type Callable, type Cell, type DartObject } from './values';

export const EMPTY_ENV: TypeEnv = new Map();

/** Constructors: their parameters, initializer lists, delegation, and the checks that every field is initialized. */
export abstract class ConstructorCompiler extends AssignmentCompiler {
  private readonly constructorRedirects = new Map<ConstructorInfo, { target: ConstructorInfo; span: Span }>();

  /** The bodies compiled once every declaration of the library is declared. */
  protected readonly deferredBodies: (() => void)[] = [];

  protected abstract native(key: string): Callable | ConstructorImpl;

  /** Runs once, before the first statements of the next function body compile, to compile a constructor's initializers. */
  protected compileStatementsHook: (() => void) | undefined;

  protected checkConstructorRedirects(): void {
    const checked = new Set<ConstructorInfo>();
    for (const root of this.constructorRedirects.keys()) {
      const path = new Set<ConstructorInfo>();
      let constructor: ConstructorInfo | undefined = root;
      while (constructor && !checked.has(constructor)) {
        const edge = this.constructorRedirects.get(constructor);
        if (!edge) break;
        if (path.has(constructor)) this.error(edge.span, 'コンストラクタのリダイレクトが循環しています。');
        path.add(constructor);
        constructor = edge.target;
      }
      for (const visited of path) checked.add(visited);
    }
    this.constructorRedirects.clear();
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Validate declaration names and class modifiers before registering the signature.
  protected declareConstructor(cls: ClassInfo, declaration: ConstructorDeclaration): void {
    if (declaration.name === '\0primaryBody') return;
    if (declaration.className !== undefined && declaration.className !== cls.name) {
      this.error(declaration, `コンストラクタの名前は、クラスの名前 ${cls.name} で始めてください。`);
    }
    const name = declaration.name ?? '';
    if (cls.constructors.has(name))
      this.error(declaration, `コンストラクタ ${cls.name}${name ? `.${name}` : ''} は、既に宣言されています。`);
    if (name && (cls.staticMembers.has(name) || cls.members.has(name)))
      this.error(declaration, `${name} という名前は、既に宣言されています。`);
    if (cls.kind === 'mixin') this.error(declaration, 'mixin にはコンストラクタを書けません。');
    if (cls.kind === 'mixinClass' && declaration.constructorKind === 'generative' && !isTrivialConstructor(declaration))
      this.error(declaration, 'mixin class の生成コンストラクタには、引数、初期化子、本体を書けません。');
    // An enum's generative constructors are constant whether or not they say so.
    const isConst = declaration.isConst || (cls.kind === 'enum' && declaration.constructorKind === 'generative');
    const nativeKey = `${cls.name}.${name || 'new'}`;
    const resolve = this.memoizeTypeInference(nativeKey, declaration, () =>
      this.inDeclarationScope(cls, undefined, () =>
        this.withIsolatedTypes(() =>
          this.withTypeParams(cls.typeParams, () => this.constructorSignature(cls, declaration))
        )
      )
    );
    const constructor: ConstructorInfo = {
      name,
      owner: cls,
      get type() {
        return resolve().type;
      },
      kind: declaration.constructorKind,
      isConst,
      row: declaration.row,
      impl: declaration.isExternal ? (this.native(nativeKey) as ConstructorImpl) : undefined,
    };
    cls.constructors.set(name, constructor);
    if (!declaration.isExternal) {
      this.deferredBodies.push(() => {
        const { positionalTypes, namedTypes } = resolve();
        this.compileConstructor(cls, constructor, declaration, positionalTypes, namedTypes);
      });
    }
  }

  protected memoizeTypeInference<T>(name: string, span: Span, infer: () => T): () => T {
    let inferred: T | undefined;
    let inferring = false;
    return () => {
      if (inferring) {
        this.error(span, `${name} の型は、自分の初期値に依存しているので推論できません。型を書いてください。`);
      }
      if (inferred !== undefined) return inferred;
      inferring = true;
      try {
        inferred = infer();
        return inferred;
      } finally {
        inferring = false;
      }
    };
  }

  private constructorSignature(
    cls: ClassInfo,
    declaration: ConstructorDeclaration
  ): { type: FunctionType; positionalTypes: DartType[]; namedTypes: Map<string, DartType> } {
    const { parameters } = declaration;
    const { positionalTypes, namedTypes } = this.constructorParameterTypes(cls, parameters);
    const type = functionType(positionalTypes, cls.thisType, {
      requiredCount: parameters.requiredCount,
      named: parameters.named.map((parameter) => ({
        name: parameter.argumentName,
        type: namedTypes.get(parameter.argumentName) ?? DYNAMIC,
        isRequired: parameter.isRequired,
      })),
    });
    return { type, positionalTypes, namedTypes };
  }

  /** The types of a constructor's parameters: declared, the field's for `this.x`, or the superclass's for `super.x`. */
  private constructorParameterTypes(
    cls: ClassInfo,
    parameters: FormalParameters
  ): { positionalTypes: DartType[]; namedTypes: Map<string, DartType> } {
    const typeOf = (parameter: FormalParameter, argument: number | string): DartType => {
      if (cls.kind === 'extensionType' && parameter.binding === 'super')
        return this.error(parameter, '拡張型のコンストラクタには super の仮引数を書けません。');
      if (parameter.type) return this.resolveType(parameter.type);
      if (parameter.binding === 'this') {
        const field = cls.fields.find((candidate) => candidate.name === parameter.name);
        if (!field)
          return this.error(
            parameter,
            `this.${parameter.name} の ${parameter.name} は、このクラスのフィールドではありません。`
          );
        return field.type;
      }
      if (parameter.binding === 'super') return this.superParameterType(cls, parameter, argument);
      return DYNAMIC;
    };
    const positionalTypes = parameters.positional.map((parameter, index) => typeOf(parameter, index));
    const namedTypes = new Map(
      parameters.named.map((parameter) => [parameter.argumentName, typeOf(parameter, parameter.argumentName)])
    );
    return { positionalTypes, namedTypes };
  }

  private superParameterType(cls: ClassInfo, parameter: FormalParameter, argument: number | string): DartType {
    const superclass = cls.superclass;
    const declaration = cls.declaration?.members.find(
      (member): member is ConstructorDeclaration =>
        member.kind === 'constructor' &&
        [...member.parameters.positional, ...member.parameters.named].includes(parameter)
    );
    const superCall = declaration?.initializers.find((initializer) => initializer.kind === 'super');
    const superName = superCall?.kind === 'super' ? (superCall.name ?? '') : '';
    const target = superclass?.cls.constructors.get(superName);
    if (!superclass || !target) return DYNAMIC;
    const map = new Map(superclass.cls.typeParams.map((param, index) => [param, superclass.args[index] ?? DYNAMIC]));
    const signature = substitute(target.type, map) as FunctionType;
    if (typeof argument === 'string') return signature.named.find((named) => named.name === argument)?.type ?? DYNAMIC;
    const superPositional =
      declaration?.parameters.positional.filter((candidate) => candidate.binding === 'super') ?? [];
    const superIndex = superPositional.indexOf(parameter);
    return signature.positional[superIndex] ?? DYNAMIC;
  }

  protected declarePrimaryConstructor(cls: ClassInfo, declaration: ClassDeclaration): void {
    const primary = declaration.primaryConstructor as NonNullable<ClassDeclaration['primaryConstructor']>;
    const name = primary.name ?? '';
    if (cls.kind === 'extensionType') {
      const representation = cls.representationType as DartType;
      cls.constructors.set(name, {
        name,
        owner: cls,
        type: functionType([representation], cls.thisType),
        kind: 'generative',
        isConst: primary.isConst,
        row: primary.row,
        impl: (_runtime, instance, args) => {
          (instance as DartObject).fields[0] = args.positional[0];
        },
      });
      return;
    }
    const parameters: FormalParameters = {
      ...primary.parameters,
      positional: primary.parameters.positional.map((parameter) =>
        isFieldParameter(parameter) ? { ...parameter, binding: 'this' as const } : parameter
      ),
      named: primary.parameters.named.map((parameter) =>
        isFieldParameter(parameter) ? { ...parameter, binding: 'this' as const } : parameter
      ),
    };
    const bodyDeclaration = declaration.members.find(
      (member): member is ConstructorDeclaration => member.kind === 'constructor' && member.name === '\0primaryBody'
    );
    const constructorDeclaration: ConstructorDeclaration = {
      ...primary,
      kind: 'constructor',
      constructorKind: 'generative',
      className: cls.name,
      name: primary.name,
      isConst: primary.isConst,
      isExternal: false,
      parameters,
      initializers: bodyDeclaration?.initializers ?? [],
      body: bodyDeclaration?.body,
      redirectTarget: undefined,
      annotations: [],
      headerEndRow: primary.row,
    };
    this.declareConstructor(cls, constructorDeclaration);
  }

  protected declareDefaultConstructor(cls: ClassInfo, declaration: ClassDeclaration): void {
    const constructorDeclaration: ConstructorDeclaration = {
      row: declaration.row,
      column: declaration.column,
      start: declaration.start,
      end: declaration.end,
      kind: 'constructor',
      constructorKind: 'generative',
      className: cls.name,
      name: undefined,
      isConst: cls.kind === 'enum',
      isExternal: false,
      parameters: {
        ...spanOnly(declaration),
        positional: [],
        requiredCount: 0,
        named: [],
      },
      initializers: [],
      body: undefined,
      redirectTarget: undefined,
      annotations: [],
      headerEndRow: declaration.row,
    };
    this.declareConstructor(cls, constructorDeclaration);
  }

  private compileConstructor(
    cls: ClassInfo,
    constructor: ConstructorInfo,
    declaration: ConstructorDeclaration,
    positionalTypes: DartType[],
    namedTypes: Map<string, DartType>
  ): void {
    const savedClass = this.currentClass;
    this.currentClass = cls;
    try {
      this.withTypeParams(cls.typeParams, () => {
        if (declaration.constructorKind === 'redirectingFactory') {
          this.compileRedirectingFactory(cls, constructor, declaration);
          return;
        }
        if (declaration.constructorKind === 'factory') {
          this.compileFactory(cls, constructor, declaration, positionalTypes, namedTypes);
          return;
        }
        this.compileGenerative(cls, constructor, declaration, positionalTypes, namedTypes);
      });
    } finally {
      this.currentClass = savedClass;
    }
  }

  // code-gauge-allow duplicateLines 24 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  private compileFactory(
    cls: ClassInfo,
    constructor: ConstructorInfo,
    declaration: ConstructorDeclaration,
    positionalTypes: DartType[],
    namedTypes: Map<string, DartType>
  ): void {
    if (!declaration.body) return this.error(declaration, 'ファクトリコンストラクタには本体が必要です。');
    const compiled = this.compileFunction({
      name: cls.name + (constructor.name ? `.${constructor.name}` : ''),
      span: declaration,
      headerEndRow: declaration.headerEndRow,
      parameters: declaration.parameters,
      positionalTypes,
      namedTypes,
      returnType: cls.thisType,
      contextReturnType: undefined,
      body: declaration.body,
      typeParams: [],
      kind: {
        returnType: cls.thisType,
        isGenerator: false,
        thisClass: cls,
        thisType: cls.thisType,
        hasThis: false,
        extensionOn: undefined,
        isInitializer: false,
        isConstructor: false,
      },
      showsThis: false,
      isClosure: false,
    } as FunctionSpec & { isClosure: boolean });
    const params = cls.typeParams;
    constructor.impl = (runtime, _instance, args, typeArgs, callRow) =>
      this.runFunction(
        compiled,
        runtime,
        undefined,
        [],
        new Map(params.map((param, index) => [param, typeArgs[index] ?? DYNAMIC])),
        args,
        callRow
      );
  }

  private compileRedirectingFactory(
    cls: ClassInfo,
    constructor: ConstructorInfo,
    declaration: ConstructorDeclaration
  ): void {
    let target = declaration.redirectTarget as NonNullable<ConstructorDeclaration['redirectTarget']>;
    // `= B.named` reads like a type with the library prefix B unless B is a class.
    const syntax = target.type;
    if (syntax.kind === 'named' && syntax.prefix && target.name === undefined && this.isClassName(syntax.prefix)) {
      target = { type: { ...syntax, prefix: undefined, name: syntax.prefix }, name: syntax.name };
    }
    const type = this.resolveType(target.type, { allowRaw: true });
    if (type.kind !== 'interface') return this.error(declaration, 'リダイレクト先には、クラスを書いてください。');
    this.checkUnavailableStaticMember(type.cls, target.name ?? '', declaration);
    const targetConstructor = type.cls.constructors.get(target.name ?? '');
    if (!targetConstructor)
      return this.error(
        declaration,
        `${type.cls.name} に${target.name ? ` ${target.name} という` : '名前のない'}コンストラクタがありません。`
      );
    if (targetConstructor.kind === 'generative' && type.cls.isAbstract)
      this.error(declaration, `抽象クラス ${type.cls.name} の生成コンストラクタにはリダイレクトできません。`);
    if (constructor.isConst) this.requireConstConstructor(targetConstructor, declaration);
    if (
      !isSubtype(substitute(type, new Map()), cls.thisType) &&
      !(type.args.length === 0 && type.cls.isSubclassOf(cls))
    ) {
      this.error(declaration, `${type.cls.name} は ${cls.name} のサブタイプではないので、リダイレクト先にできません。`);
    }
    const targetTypes = new Map(
      type.cls.typeParams.map((parameter, index) => [parameter, type.args[index] ?? DYNAMIC])
    );
    const signature = substitute(targetConstructor.type, targetTypes);
    if (!isSubtype(signature, constructor.type)) {
      this.error(
        declaration,
        `リダイレクト先の型 ${typeName(signature)} は factory の型 ${typeName(constructor.type)} に合いません。`
      );
    }
    this.constructorRedirects.set(constructor, { target: targetConstructor, span: declaration });
    const targetArgs = type.args;
    const params = cls.typeParams;
    constructor.impl = (runtime, _instance, args, typeArgs, callRow) => {
      const env = new Map(params.map((param, index) => [param, typeArgs[index] ?? DYNAMIC]));
      const resolvedArgs = targetArgs.length > 0 ? targetArgs.map((arg) => substitute(arg, env)) : [...typeArgs];
      return this.instantiate(runtime, type.cls, targetConstructor, resolvedArgs, args, callRow);
    };
  }

  private isClassName(name: string): boolean {
    const resolution = this.resolveName(name);
    return resolution?.kind === 'declaration' && resolution.declaration.kind === 'class';
  }

  // code-gauge-allow functionNcss 38 -- The steps of a generative constructor: checks, its frame, initializers, and body, in order.
  private compileGenerative(
    cls: ClassInfo,
    constructor: ConstructorInfo,
    declaration: ConstructorDeclaration,
    positionalTypes: DartType[],
    namedTypes: Map<string, DartType>
  ): void {
    this.checkConstConstructor(cls, constructor, declaration);
    const redirect = declaration.initializers.find((initializer) => initializer.kind === 'this');
    if (redirect && (declaration.initializers.length > 1 || declaration.body)) {
      this.error(redirect, 'this(...) にリダイレクトするコンストラクタには、ほかの初期化子や本体は書けません。');
    }
    const parameters = declaration.parameters;
    const defaults = this.inheritedDefaults(cls, declaration);
    const spec: FunctionSpec & { isClosure: boolean } = {
      name: cls.name + (constructor.name ? `.${constructor.name}` : ''),
      span: declaration,
      headerEndRow: declaration.headerEndRow,
      parameters,
      positionalTypes,
      namedTypes,
      defaults,
      returnType: VOID,
      contextReturnType: undefined,
      body: declaration.body ?? {
        ...spanOnly(declaration),
        kind: 'block',
        block: { ...spanOnly(declaration), kind: 'block', statements: [] },
        modifier: 'sync',
      },
      typeParams: [],
      kind: {
        returnType: VOID,
        isGenerator: false,
        thisClass: cls,
        thisType: cls.thisType,
        hasThis: true,
        extensionOn: undefined,
        isInitializer: false,
        isConstructor: true,
      },
      showsThis: !this.isLibraryCode,
      isClosure: false,
    };
    if (declaration.body?.kind === 'expression')
      this.error(declaration.body, 'コンストラクタには => の本体は書けません。');
    // The initializers compile in the constructor's own context, before its body, with `this` unavailable.
    let prologue: ((frame: Frame) => void) | undefined;
    let initializerSlots: number[] = [];
    const initializedFields = new Set<string>();
    const compiled = this.compileFunctionWithPrologue(spec, () => {
      const previous = this.potentialConstInitializer;
      this.potentialConstInitializer = constructor.isConst && !this.isLibraryCode;
      try {
        prologue = this.compileConstructorPrologue(cls, declaration, initializedFields);
      } finally {
        this.potentialConstInitializer = previous;
      }
      initializerSlots = this.endInitializerScope(parameters);
    });
    constructor.defaults = {
      positional: parameters.positional.map((parameter) => defaults.get(parameter)),
      named: new Map(parameters.named.map((parameter) => [parameter.argumentName, defaults.get(parameter)])),
    };
    this.checkFieldsInitialized(cls, declaration, initializedFields, redirect !== undefined);
    const params = cls.typeParams;
    const info = compiled.fn.info;
    constructor.impl = (runtime, instance, args, typeArgs, callRow) => {
      const typeEnv: TypeEnv =
        params.length === 0 ? EMPTY_ENV : new Map(params.map((param, index) => [param, typeArgs[index] ?? DYNAMIC]));
      const frame = new Frame(runtime, info, compiled.fn.slotCount, instance, [], typeEnv, callRow);
      runtime.enter(frame);
      try {
        compiled.bind(frame, args);
        prologue?.(frame);
        for (const slot of initializerSlots) frame.locals[slot] = undefined;
        if (cls.kind === 'extensionType') frame.receiver = (instance as DartObject).fields[0];
        compiled.run(frame);
      } finally {
        runtime.exit(frame);
      }
      return;
    };
  }

  private endInitializerScope(parameters: FormalParameters): number[] {
    const scope = this.fn.scopes[0].names;
    const slots: number[] = [];
    for (const parameter of [...parameters.positional, ...parameters.named]) {
      if (parameter.binding === 'plain') continue;
      const variable = scope.get(parameter.name);
      if (variable) slots.push(variable.slot);
      scope.delete(parameter.name);
    }
    return slots;
  }

  private checkConstConstructor(
    cls: ClassInfo,
    constructor: ConstructorInfo,
    declaration: ConstructorDeclaration
  ): void {
    if (!constructor.isConst || this.isLibraryCode) return;
    if (declaration.body) this.error(declaration.body, 'const のコンストラクタには、本体を書けません。');
    const invalidField = cls.fields.find((field) => !field.isFinal || field.isLate);
    if (invalidField)
      this.error(declaration, `フィールド ${invalidField.name} は、late ではない final にしてください。`);
  }

  private inheritedDefaults(cls: ClassInfo, declaration: ConstructorDeclaration): Map<FormalParameter, Compiled> {
    const defaults = new Map<FormalParameter, Compiled>();
    const superCall = declaration.initializers.find((initializer) => initializer.kind === 'super');
    const parent = cls.superclass?.cls.constructors.get(superCall?.name ?? '')?.defaults;
    if (!parent) return defaults;
    const positional = declaration.parameters.positional.filter((parameter) => parameter.binding === 'super');
    for (const [index, parameter] of positional.entries()) {
      const inherited = parent.positional[index];
      if (inherited && declaration.parameters.positional.indexOf(parameter) >= declaration.parameters.requiredCount)
        defaults.set(parameter, inherited);
    }
    for (const parameter of declaration.parameters.named) {
      if (parameter.binding !== 'super' || parameter.isRequired) continue;
      const inherited = parent.named.get(parameter.argumentName);
      if (inherited) defaults.set(parameter, inherited);
    }
    return defaults;
  }

  /**
   * Compiles a function whose parameters are in scope for `prologue`, as a constructor's initializer list is, before
   * its body.
   */
  private compileFunctionWithPrologue(
    spec: FunctionSpec & { isClosure: boolean },
    prologue: () => void
  ): CompiledFunction {
    this.compileStatementsHook = prologue;
    try {
      return this.compileFunction(spec);
    } finally {
      this.compileStatementsHook = undefined;
    }
  }

  protected override compileBlock(block: Block, clear = true): Exec {
    const hook = this.compileStatementsHook;
    if (hook) {
      this.compileStatementsHook = undefined;
      const { hasThis, isInitializer } = this.fn.kind;
      this.fn.kind.hasThis = false;
      this.fn.kind.isInitializer = true;
      try {
        hook();
      } finally {
        this.fn.kind.hasThis = hasThis;
        this.fn.kind.isInitializer = isInitializer;
      }
    }
    return super.compileBlock(block, clear);
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- The initializer list's entries and the implicit super().
  // code-gauge-allow functionNcss 45 -- The initializer list's entries and the implicit super().
  private compileConstructorPrologue(
    cls: ClassInfo,
    declaration: ConstructorDeclaration,
    initializedFields: Set<string>
  ): (frame: Frame) => void {
    const steps: ((frame: Frame) => void)[] = [];
    const redirect = declaration.initializers.find((initializer) => initializer.kind === 'this');
    if (!redirect) steps.push(...this.compileFieldInitializersWithoutParameters(cls, initializedFields));
    steps.push(...this.compileInitializingFormals(cls, declaration, initializedFields));
    const explicitFields = new Set(
      [...declaration.parameters.positional, ...declaration.parameters.named]
        .filter((parameter) => parameter.binding === 'this')
        .map((parameter) => parameter.name)
    );
    let superCall = false;
    for (const initializer of declaration.initializers) {
      switch (initializer.kind) {
        case 'field': {
          const field = cls.fields.find((candidate) => candidate.name === initializer.name);
          if (!field) return this.error(initializer, `${initializer.name} は、このクラスのフィールドではありません。`);
          if (explicitFields.has(field.name) || (field.isFinal && initializedFields.has(field.name)))
            this.error(initializer, `フィールド ${field.name} は、もう初期化されています。`);
          explicitFields.add(field.name);
          initializedFields.add(field.name);
          const value = this.coerce(
            this.compileInitializerValue(initializer.value, field.type),
            field.type,
            initializer.value,
            (from, to) => `${from} 型の値は、${to} 型のフィールド ${field.name} に代入できません。`
          );
          const { run } = value;
          const fieldSlot = field.slot;
          // Each entry of the initializer list is a step, as each assignment of a Java constructor is.
          const stepped = this.withStep(
            initializer,
            (frame) => {
              (frame.receiver as DartObject).fields[fieldSlot] = run(frame);
            },
            value.creates === true
          );
          steps.push((frame) => {
            stepped(frame);
          });
          break;
        }
        case 'assert': {
          steps.push(this.compileInitializerAssert(initializer));
          break;
        }
        case 'super':
        case 'this': {
          if (initializer !== declaration.initializers.at(-1)) {
            this.error(initializer, `${initializer.kind}(...) は、初期化子の最後に書いてください。`);
          }
          superCall = true;
          const delegation = this.compileDelegation(
            cls,
            declaration,
            initializer.kind,
            initializer.name,
            initializer.arguments,
            initializer
          );
          const stepped = this.withStep(
            initializer,
            (frame) => {
              delegation(frame);
            },
            true
          );
          steps.push((frame) => {
            stepped(frame);
          });
          break;
        }
      }
    }
    if (!superCall && cls.superclass && cls.kind !== 'extensionType') {
      steps.push(
        this.compileDelegation(
          cls,
          declaration,
          'super',
          undefined,
          { ...at(declaration), positional: [], named: [], order: [] },
          declaration,
          true
        )
      );
    }
    return (frame) => {
      for (const step of steps) step(frame);
    };
  }

  private compileInitializerValue(expression: Expression, context: DartType | undefined): Compiled {
    const compiled = this.compileExpression(expression, context);
    if (this.potentialConstInitializer && !compiled.isConst)
      this.error(expression, 'const のコンストラクタの初期化子には、定数として評価できる式を書いてください。');
    return compiled;
  }

  private compileInitializerAssert(
    initializer: Extract<ConstructorDeclaration['initializers'][number], { kind: 'assert' }>
  ): (frame: Frame) => void {
    const before = this.flow;
    const { compiled, flow } = this.compileCondition(initializer.condition);
    if (this.potentialConstInitializer && !compiled.isConst)
      this.error(
        initializer.condition,
        'const のコンストラクタの assert には、定数として評価できる条件を書いてください。'
      );
    this.flow = flow.whenFalse;
    const message = initializer.message ? this.compileInitializerValue(initializer.message, undefined).run : undefined;
    this.flow = before;
    return (frame) => {
      if (frame.runtime.checkingConstants && compiled.run(frame) !== true)
        frame.runtime.throwError('AssertionError', '', [message?.(frame)]);
    };
  }

  /** The `this.x` parameters, which store their arguments in the fields before the initializer list runs. */
  private compileInitializingFormals(
    cls: ClassInfo,
    declaration: ConstructorDeclaration,
    initializedFields: Set<string>
  ): ((frame: Frame) => void)[] {
    const steps: ((frame: Frame) => void)[] = [];
    for (const parameter of [...declaration.parameters.positional, ...declaration.parameters.named]) {
      if (parameter.binding !== 'this') continue;
      const field = cls.fields.find((candidate) => candidate.name === parameter.name);
      if (!field)
        this.error(parameter, `this.${parameter.name} の ${parameter.name} は、このクラスのフィールドではありません。`);
      if (initializedFields.has(field.name) && field.isFinal)
        this.error(parameter, `final のフィールド ${field.name} は、もう初期化されています。`);
      const variable = this.findLocal(parameter.name);
      if (!variable) continue;
      const parameterType = variable.type;
      if (!isSubtype(parameterType, field.type)) {
        this.error(
          parameter,
          `${typeName(parameterType)} 型の引数は、${typeName(field.type)} 型のフィールド ${field.name} に代入できません。`
        );
      }
      initializedFields.add(field.name);
      const { slot } = variable;
      const fieldSlot = field.slot;
      steps.push((frame) => {
        (frame.receiver as DartObject).fields[fieldSlot] = (frame.locals[slot] as Cell).v;
      });
    }
    return steps;
  }

  private compileFieldInitializersWithoutParameters(
    cls: ClassInfo,
    initializedFields: Set<string>
  ): ((frame: Frame) => void)[] {
    const scope = this.fn.scopes[0];
    this.fn.scopes[0] = new LocalScope();
    try {
      return this.compileFieldInitializers(cls, initializedFields);
    } finally {
      this.fn.scopes[0] = scope;
    }
  }

  /** The initializers of the fields a class declares, one step per declaration as Java's are. */
  private compileFieldInitializers(cls: ClassInfo, initializedFields: Set<string>): ((frame: Frame) => void)[] {
    const declaration = cls.declaration;
    if (!declaration) return [];
    const result: ((frame: Frame) => void)[] = [];
    for (const member of declaration.members) {
      if (member.kind !== 'field' || member.isStatic || member.isLate || member.isAbstract || member.isExternal)
        continue;
      const runs: { slot: number; run: Eval }[] = [];
      const initialized: Compiled[] = [];
      for (const variable of member.variables) {
        if (!variable.initializer) continue;
        const field = cls.fields.find((candidate) => candidate.name === variable.name) as FieldMember;
        initializedFields.add(field.name);
        const compiled = this.coerce(
          this.compileInitializerValue(variable.initializer, field.type),
          field.type,
          variable.initializer,
          (from, to) => `${from} 型の値は、${to} 型のフィールド ${field.name} に代入できません。`
        );
        initialized.push(compiled);
        runs.push({ slot: field.slot, run: compiled.run });
      }
      if (runs.length === 0) continue;
      const exec = (frame: Frame): undefined => {
        for (const { slot, run } of runs) (frame.receiver as DartObject).fields[slot] = run(frame);
        return undefined;
      };
      const stepped = this.withStep(
        member,
        exec,
        initialized.every((compiled) => compiled.creates === true)
      );
      result.push((frame) => {
        stepped(frame);
      });
    }
    return result;
  }

  /** The call of the superclass's constructor or of another constructor of the class, in an initializer list. */
  // code-gauge-allow functionParameterCount 7 -- The parameters are the parts a caller already holds; grouping them would only rename them.
  // code-gauge-allow functionCognitiveComplexity 27 -- Validate redirects and splice the forwarded parameters into the call order.
  // code-gauge-allow functionNcss 33 -- Delegation checks share the resolved constructor and its signature.
  private compileDelegation(
    cls: ClassInfo,
    declaration: ConstructorDeclaration,
    kind: 'super' | 'this',
    name: string | undefined,
    argsSyntax: ArgumentsSyntax,
    span: Span,
    isImplicit = false
  ): (frame: Frame) => void {
    const targetType = kind === 'super' ? cls.superclass : cls.thisType;
    if (!targetType) return this.error(span, 'このクラスにはスーパークラスがありません。');
    const target = targetType.cls.constructors.get(name ?? '');
    this.checkUnavailableStaticMember(target?.forwardedFrom ?? targetType.cls, name ?? '', span);
    if (!target) {
      if (isImplicit) {
        return this.error(
          span,
          `スーパークラス ${targetType.cls.name} には、引数のない名前のないコンストラクタがありません。super(...) を書いてください。`
        );
      }
      return this.error(
        span,
        `${targetType.cls.name} に${name ? ` ${name} という` : '名前のない'}コンストラクタがありません。`
      );
    }
    if (target.kind !== 'generative')
      this.error(
        span,
        `${targetType.cls.name}${name ? `.${name}` : ''} はファクトリコンストラクタなので、${kind}(...) では呼び出せません。`
      );
    if (kind === 'this') {
      const source = cls.constructors.get(declaration.name ?? '');
      if (source) this.constructorRedirects.set(source, { target, span });
    }
    if (declaration.isConst || cls.kind === 'enum') this.requireConstConstructor(target, span);
    const map = new Map(targetType.cls.typeParams.map((param, index) => [param, targetType.args[index] ?? DYNAMIC]));
    const signature = substitute({ ...target.type, typeParams: [] }, map) as FunctionType;
    // `super.x` parameters pass their arguments on: positional ones before the written arguments, named ones by name.
    const superPositional =
      kind === 'super' ? declaration.parameters.positional.filter((parameter) => parameter.binding === 'super') : [];
    const superNamed =
      kind === 'super' ? declaration.parameters.named.filter((parameter) => parameter.binding === 'super') : [];
    if (superPositional.length > 0 && argsSyntax.positional.length > 0) {
      this.error(span, 'super. の引数を使うときは、super(...) に位置で渡す引数を書けません。');
    }
    const passed: ArgumentsSyntax = {
      ...argsSyntax,
      positional: [
        ...superPositional.map((parameter): Expression => ({
          ...spanOnly(parameter),
          kind: 'identifier',
          name: parameter.name,
        })),
        ...argsSyntax.positional,
      ],
      named: [
        ...superNamed.map((parameter) => ({
          ...spanOnly(parameter),
          name: parameter.argumentName,
          value: { ...spanOnly(parameter), kind: 'identifier' as const, name: parameter.name },
        })),
        ...argsSyntax.named,
      ],
      order: [
        ...superPositional.map((_, index) => ({ kind: 'positional' as const, index })),
        ...superNamed.map((_, index) => ({ kind: 'named' as const, index })),
        ...argsSyntax.order.map(({ kind, index }) => ({
          kind,
          index: index + (kind === 'positional' ? superPositional.length : superNamed.length),
        })),
      ],
    };
    const bound = this.bindArguments(signature, passed, undefined, span, undefined);
    if (this.potentialConstInitializer && !bound.argumentsAreConst)
      this.error(span, `const のコンストラクタの ${kind} に渡す値は、定数として評価できなければなりません。`);
    const typeArgs = this.runtimeTypes(targetType.args);
    const row = isImplicit || this.isLibraryCode ? undefined : span.row;
    return (frame) => {
      const impl = target.impl as ConstructorImpl;
      impl(frame.runtime, frame.receiver as DartObject, bound.args(frame), typeArgs(frame), row);
    };
  }

  private requireConstConstructor(target: ConstructorInfo, span: Span): void {
    if (target.isConst) return;
    const name = target.name ? `${target.owner.name}.${target.name}` : target.owner.name;
    this.error(span, `const のコンストラクタからは、const でないコンストラクタ ${name} を呼び出せません。`);
  }

  private checkFieldsInitialized(
    cls: ClassInfo,
    declaration: ConstructorDeclaration,
    initialized: Set<string>,
    isRedirecting: boolean
  ): void {
    if (isRedirecting || this.isLibraryCode) return;
    for (const field of cls.fields) {
      if (initialized.has(field.name) || field.isLate || field.hasInitializer) continue;
      // Dart reports a field no constructor initializes at the field, and one another constructor initializes here.
      const at = this.someConstructorInitializes(cls, field.name) ? declaration : { row: field.row ?? declaration.row };
      if (field.isFinal) this.error(at, `final のフィールド ${field.name} が、コンストラクタで初期化されていません。`);
      if (!isNullable(field.type) && field.type.kind !== 'dynamic') {
        this.error(at, `null にならないフィールド ${field.name} が、コンストラクタで初期化されていません。`);
      }
    }
  }

  private someConstructorInitializes(cls: ClassInfo, name: string): boolean {
    return (cls.declaration?.members ?? []).some(
      (member) =>
        member.kind === 'constructor' &&
        member.constructorKind === 'generative' &&
        ([...member.parameters.positional, ...member.parameters.named].some(
          (parameter) => parameter.binding === 'this' && parameter.name === name
        ) ||
          member.initializers.some((initializer) => initializer.kind === 'field' && initializer.name === name))
    );
  }
}

function isTrivialConstructor({ body, initializers, parameters }: ConstructorDeclaration): boolean {
  return !body && initializers.length === 0 && parameters.positional.length === 0 && parameters.named.length === 0;
}

function isFieldParameter(parameter: FormalParameter): boolean {
  return parameter.binding === 'plain' && (parameter.isFinal || parameter.isVar === true);
}

function spanOnly(span: Span): Span {
  return { row: span.row, column: span.column, start: span.start, end: span.end };
}
