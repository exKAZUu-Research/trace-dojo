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
import { Frame, type Runtime, type TypeEnv } from './runtime';
import type { Exec } from './statementCompiler';
import {
  type DartType,
  DYNAMIC,
  type FunctionType,
  functionType,
  type InterfaceType,
  isNullable,
  isSubtype,
  substitute,
  VOID,
} from './types';
import { type Arguments, type Callable, type Cell, type DartObject, type Value } from './values';

export const EMPTY_ENV: TypeEnv = new Map();

/** Constructors: their parameters, initializer lists, delegation, and the checks that every field is initialized. */
export abstract class ConstructorCompiler extends AssignmentCompiler {
  /** The bodies compiled once every declaration of the library is declared. */
  protected readonly deferredBodies: (() => void)[] = [];

  abstract instantiate(
    runtime: Runtime,
    cls: ClassInfo,
    constructor: ConstructorInfo,
    typeArgs: readonly DartType[],
    args: Arguments,
    callRow: number | undefined
  ): Value;

  protected abstract native(key: string): Callable | ConstructorImpl;

  /** Runs once, before the first statements of the next function body compile, to compile a constructor's initializers. */
  protected compileStatementsHook: (() => void) | undefined;

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
    if (cls.kind === 'enum' && declaration.constructorKind === 'generative' && !declaration.isConst) {
      this.error(declaration, '列挙型のコンストラクタは const にしてください。');
    }
    const { positionalTypes, namedTypes } = this.constructorParameterTypes(cls, declaration.parameters, declaration);
    const type = functionType(positionalTypes, cls.thisType, {
      requiredCount: declaration.parameters.requiredCount,
      named: declaration.parameters.named.map((parameter) => ({
        name: parameter.name,
        type: namedTypes.get(parameter.name) ?? DYNAMIC,
        isRequired: parameter.isRequired,
      })),
    });
    const nativeKey = `${cls.name}.${name || 'new'}`;
    const constructor: ConstructorInfo = {
      name,
      owner: cls,
      type,
      kind: declaration.constructorKind,
      isConst: declaration.isConst,
      row: declaration.row,
      impl: declaration.isExternal ? (this.native(nativeKey) as ConstructorImpl) : undefined,
    };
    cls.constructors.set(name, constructor);
    if (!declaration.isExternal) {
      this.deferredBodies.push(() =>
        this.compileConstructor(cls, constructor, declaration, positionalTypes, namedTypes)
      );
    }
  }

  /** The types of a constructor's parameters: declared, the field's for `this.x`, or the superclass's for `super.x`. */
  private constructorParameterTypes(
    cls: ClassInfo,
    parameters: FormalParameters,
    span: Span
  ): { positionalTypes: DartType[]; namedTypes: Map<string, DartType> } {
    const typeOf = (parameter: FormalParameter, position: number | undefined): DartType => {
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
      if (parameter.binding === 'super') return this.superParameterType(cls, parameter, position, span);
      return DYNAMIC;
    };
    const positionalTypes = parameters.positional.map((parameter, index) => typeOf(parameter, index));
    const namedTypes = new Map(parameters.named.map((parameter) => [parameter.name, typeOf(parameter, undefined)]));
    return { positionalTypes, namedTypes };
  }

  private superParameterType(
    cls: ClassInfo,
    parameter: FormalParameter,
    position: number | undefined,
    span: Span
  ): DartType {
    void span;
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
    if (position === undefined) return signature.named.find((named) => named.name === parameter.name)?.type ?? DYNAMIC;
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
    const target = declaration.redirectTarget as NonNullable<ConstructorDeclaration['redirectTarget']>;
    const type = this.resolveType(target.type, { allowRaw: true });
    if (type.kind !== 'interface') return this.error(declaration, 'リダイレクト先には、クラスを書いてください。');
    const targetConstructor = type.cls.constructors.get(target.name ?? '');
    if (!targetConstructor)
      return this.error(
        declaration,
        `${type.cls.name} に${target.name ? ` ${target.name} という` : '名前のない'}コンストラクタがありません。`
      );
    if (
      !isSubtype(substitute(type, new Map()), cls.thisType) &&
      !(type.args.length === 0 && type.cls.isSubclassOf(cls))
    ) {
      this.error(declaration, `${type.cls.name} は ${cls.name} のサブタイプではないので、リダイレクト先にできません。`);
    }
    const targetArgs = type.args;
    const params = cls.typeParams;
    constructor.impl = (runtime, _instance, args, typeArgs, callRow) => {
      const env = new Map(params.map((param, index) => [param, typeArgs[index] ?? DYNAMIC]));
      const resolvedArgs = targetArgs.length > 0 ? targetArgs.map((arg) => substitute(arg, env)) : [...typeArgs];
      return this.instantiate(runtime, type.cls, targetConstructor, resolvedArgs, args, callRow);
    };
  }

  private compileGenerative(
    cls: ClassInfo,
    constructor: ConstructorInfo,
    declaration: ConstructorDeclaration,
    positionalTypes: DartType[],
    namedTypes: Map<string, DartType>
  ): void {
    const redirect = declaration.initializers.find((initializer) => initializer.kind === 'this');
    if (redirect && (declaration.initializers.length > 1 || declaration.body)) {
      this.error(redirect, 'this(...) にリダイレクトするコンストラクタには、ほかの初期化子や本体は書けません。');
    }
    const parameters = declaration.parameters;
    const spec: FunctionSpec & { isClosure: boolean } = {
      name: cls.name + (constructor.name ? `.${constructor.name}` : ''),
      span: declaration,
      headerEndRow: declaration.headerEndRow,
      parameters,
      positionalTypes,
      namedTypes,
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
    const initializedFields = new Set<string>();
    const compiled = this.compileFunctionWithPrologue(spec, () => {
      prologue = this.compileConstructorPrologue(cls, declaration, initializedFields);
    });
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
        if (cls.kind === 'extensionType') frame.receiver = (instance as DartObject).fields[0];
        compiled.run(frame);
      } finally {
        runtime.exit(frame);
      }
      return;
    };
  }

  /**
   * Compiles a function whose parameters are in scope for `prologue`, as a constructor's initializer list is, before
   * its body.
   */
  private compileFunctionWithPrologue(
    spec: FunctionSpec & { isClosure: boolean },
    prologue: () => void
  ): CompiledFunction {
    const original = this.compileStatements.bind(this);
    let used = false;
    this.compileStatementsHook = () => {
      if (used) return;
      used = true;
      prologue();
    };
    try {
      return this.compileFunction(spec);
    } finally {
      this.compileStatementsHook = undefined;
      void original;
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

  // code-gauge-allow duplicateLines 15 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  // code-gauge-allow functionCognitiveComplexity 17 -- The initializer list's entries and the implicit super().
  // code-gauge-allow functionNcss 43 -- The initializer list's entries and the implicit super().
  private compileConstructorPrologue(
    cls: ClassInfo,
    declaration: ConstructorDeclaration,
    initializedFields: Set<string>
  ): (frame: Frame) => void {
    const steps: ((frame: Frame) => void)[] = [];
    const redirect = declaration.initializers.find((initializer) => initializer.kind === 'this');
    if (!redirect) steps.push(...this.compileFieldInitializers(cls, initializedFields));
    steps.push(...this.compileInitializingFormals(cls, declaration, initializedFields));
    let superCall = false;
    for (const initializer of declaration.initializers) {
      switch (initializer.kind) {
        case 'field': {
          const field = cls.fields.find((candidate) => candidate.name === initializer.name);
          if (!field) return this.error(initializer, `${initializer.name} は、このクラスのフィールドではありません。`);
          if (initializedFields.has(field.name))
            this.error(initializer, `フィールド ${field.name} は、もう初期化されています。`);
          initializedFields.add(field.name);
          const value = this.coerce(
            this.compileExpression(initializer.value, field.type),
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
          this.compileCondition(initializer.condition);
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
      // Inside the initializer list and the body, the name refers to the parameter, which is final.
    }
    return steps;
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
          this.compileExpression(variable.initializer, field.type),
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
  private compileDelegation(
    cls: ClassInfo,
    declaration: ConstructorDeclaration,
    kind: 'super' | 'this',
    name: string | undefined,
    argsSyntax: ArgumentsSyntax,
    span: Span,
    isImplicit = false
  ): (frame: Frame) => void {
    const targetType = kind === 'super' ? (cls.superclass as InterfaceType) : cls.thisType;
    const target = targetType.cls.constructors.get(name ?? '');
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
          name: parameter.name,
          value: { ...spanOnly(parameter), kind: 'identifier' as const, name: parameter.name },
        })),
        ...argsSyntax.named,
      ],
      order: [],
    };
    passed.order = [
      ...passed.positional.map((_, index) => ({ kind: 'positional' as const, index })),
      ...passed.named.map((_, index) => ({ kind: 'named' as const, index })),
    ];
    const bound = this.bindArguments(signature, passed, undefined, span, undefined);
    const typeArgs = this.runtimeTypes(targetType.args);
    const row = isImplicit || this.isLibraryCode ? undefined : span.row;
    const targetClass = targetType.cls;
    return (frame) => {
      const impl = target.impl as ConstructorImpl;
      impl(frame.runtime, frame.receiver as DartObject, bound.args(frame), typeArgs(frame), row);
      void targetClass;
    };
  }

  private checkFieldsInitialized(
    cls: ClassInfo,
    declaration: ConstructorDeclaration,
    initialized: Set<string>,
    isRedirecting: boolean
  ): void {
    if (isRedirecting || this.isLibraryCode) return;
    // Dart reports a field the implicit default constructor leaves unset at the field, and others at the constructor.
    const isDefault = declaration.start === cls.declaration?.start;
    for (const field of cls.fields) {
      if (initialized.has(field.name) || field.isLate || field.hasInitializer) continue;
      const at = isDefault ? { row: field.row ?? declaration.row } : declaration;
      if (field.isFinal) this.error(at, `final のフィールド ${field.name} が、コンストラクタで初期化されていません。`);
      if (!isNullable(field.type) && field.type.kind !== 'dynamic') {
        this.error(at, `null にならないフィールド ${field.name} が、コンストラクタで初期化されていません。`);
      }
    }
  }
}

function isFieldParameter(parameter: FormalParameter): boolean {
  return (
    parameter.binding === 'plain' &&
    (parameter.isFinal || (parameter as FormalParameter & { isVar?: boolean }).isVar === true)
  );
}

function spanOnly(span: Span): Span {
  return { row: span.row, column: span.column, start: span.start, end: span.end };
}
