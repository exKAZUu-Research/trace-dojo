// code-gauge-allow-file fileNcss 676 -- Type inference, argument binding, and call dispatch share this compiler phase.
import type {
  Arguments as ArgumentsSyntax,
  Expression,
  FormalParameter,
  FormalParameters,
  FunctionBody,
  Span,
  TypeSyntax,
} from './ast';
import type { ClassInfo, ConstructorInfo, Member, MethodMember, SetterMember } from './classes';
import { at, type Compiled, type Eval, typeName } from './compilerBase';
import type { ExtensionInfo, TopLevelFunction, TypeAlias } from './environment';
import { SHORTED } from './expressionCompiler';
import { OperatorCompiler } from './operatorCompiler';
import type { Frame, Runtime, TypeEnv } from './runtime';
import type { FunctionContext } from './scope';
import {
  INFERENCE_HOLE,
  inferExtensionReceiver,
  inferFromContext,
  inferFromSubtype,
  isInferenceHole,
} from './typeInference';
import {
  boundOf,
  coreTypes,
  type DartType,
  DYNAMIC,
  type FunctionType,
  functionType,
  instantiateFunction,
  instantiateToBounds,
  type InterfaceType,
  interfaceType,
  isNullable,
  isPotentiallyNullable,
  isSubtype,
  isTop,
  mentionsTypeParams,
  NEVER,
  nonNullable,
  NULL,
  numericClassOf,
  resolveBound,
  substitute,
  type TypeParam,
  typeParamType,
  upperBound,
  VOID,
} from './types';
import { type Arguments, type Callable, type Cell, DartClosure, type Value } from './values';

/** A call whose arguments are checked against a function type: how to evaluate them and what the call gives. */
export interface BoundCall {
  returnType: DartType;
  argumentsAreConst: boolean;
  /** Evaluates the arguments in source order. */
  args: (frame: Frame) => Arguments;
  typeArgs: (frame: Frame) => DartType[];
  /** The type arguments inferred or written for the function's own type parameters. */
  staticTypeArgs: DartType[];
}

/** A function or method body to compile, with what its context gives it. */
export interface FunctionSpec {
  name: string;
  span: Span;
  headerEndRow: number;
  parameters: FormalParameters;
  /** The parameters' types, resolved by the caller (and inferred from a context for closures). */
  positionalTypes: DartType[];
  namedTypes: Map<string, DartType>;
  defaults?: Map<FormalParameter, Compiled>;
  parameterMember?: MethodMember | SetterMember;
  bodyless?: boolean;
  /** Undefined to infer the return type from the body, as closures do. */
  returnType: DartType | undefined;
  /** For closures, the return type the context expects, which return expressions are checked against. */
  contextReturnType: DartType | undefined;
  body: FunctionBody;
  typeParams: TypeParam[];
  kind: FunctionContext['kind'];
  showsThis: boolean;
}

interface AliasConstructor {
  template: InterfaceType;
  parameters: TypeParam[];
  nullableResult: boolean;
}

type ConstructorTypes = DartType[] | AliasConstructor | undefined;

interface CallArgument {
  argument: Expression;
  index: number;
  name?: string;
  parameterType: DartType | undefined;
}

export interface CompiledFunction {
  fn: FunctionContext;
  returnType: DartType;
  /** Runs the body in a frame whose parameters are bound. */
  run: (frame: Frame) => Value;
  /** Binds the arguments to the parameters, applying defaults and runtime checks. */
  bind: (frame: Frame, args: Arguments) => void;
  /** Whether the body or a closure inside it reads the type parameters at runtime. */
  usesTypeEnv: boolean;
}

export abstract class CallCompiler extends OperatorCompiler {
  abstract compileFunction(spec: FunctionSpec): CompiledFunction;
  abstract instantiate(
    runtime: Runtime,
    cls: ClassInfo,
    constructor: ConstructorInfo,
    typeArgs: readonly DartType[],
    args: Arguments,
    callRow: number | undefined
  ): Value;
  abstract constructObject(
    cls: ClassInfo,
    constructor: ConstructorInfo,
    typeArgs: (frame: Frame) => DartType[],
    args: (frame: Frame) => Arguments,
    span: Span,
    isConst: boolean
  ): Eval;

  // Calls

  compileCall(expression: Extract<Expression, { kind: 'call' }>, context: DartType | undefined): Compiled {
    const { callee, arguments: args, typeArguments } = expression;
    if (callee.kind === 'dotShorthand' && !callee.arguments) {
      return this.compileDotShorthand({ ...callee, arguments: args }, context);
    }
    if (callee.kind === 'identifier') {
      const compiled = this.compileNamedCall(expression, callee, context);
      if (compiled) return compiled;
    }
    if (callee.kind === 'member') return this.compileMemberCall(expression, callee, context);
    const target = this.compileChainPart(callee, undefined);
    return this.compileValueCall(target, args, typeArguments, expression, context);
  }

  protected compileInstantiation(expression: Extract<Expression, { kind: 'instantiation' }>): Compiled {
    const target = this.staticTarget(expression);
    if (target?.kind === 'class' && target.typeArgs) {
      const alias = target.alias?.aliased;
      return this.typeLiteralValue(
        interfaceType(target.cls, target.typeArgs, alias?.kind === 'interface' && alias.nullable)
      );
    }
    const alias = this.instantiatedAliasLiteral(expression);
    if (alias) return this.typeLiteralValue(alias);
    const value = this.compileExpression(expression.target);
    const signature = resolveBound(value.type);
    if (signature.kind !== 'function' || signature.typeParams.length === 0 || isPotentiallyNullable(value.type))
      return this.error(expression, `${typeName(value.type)} 型の値には型引数を付けられません。`);
    const args = this.explicitTypeArguments(signature.typeParams, expression.typeArguments, expression);
    return this.instantiateFunctionValue(value, instantiateFunction(signature, args), args);
  }

  private instantiatedAliasLiteral(expression: Extract<Expression, { kind: 'instantiation' }>): DartType | undefined {
    const { target, typeArguments } = expression;
    if (target.kind === 'identifier') {
      const resolution = this.resolveName(target.name, target);
      if (resolution?.kind !== 'declaration' || resolution.declaration.kind !== 'alias') return;
      return this.resolveType({
        ...at(expression),
        kind: 'named',
        name: target.name,
        prefix: undefined,
        args: typeArguments,
        nullable: false,
      });
    }
    if (target.kind !== 'member' || target.nullAware) return;
    const receiver = this.staticTarget(target.object);
    if (receiver?.kind !== 'prefix' || this.library.lookupPrefixed(receiver.prefix, target.name)?.kind !== 'alias')
      return;
    return this.resolveType({
      ...at(expression),
      kind: 'named',
      name: target.name,
      prefix: receiver.prefix,
      args: typeArguments,
      nullable: false,
    });
  }

  /** A call of a name: a method of this, a static member, a function, a constructor, or an extension override. */
  private compileNamedCall(
    expression: Extract<Expression, { kind: 'call' }>,
    callee: Extract<Expression, { kind: 'identifier' }>,
    context: DartType | undefined
  ): Compiled | undefined {
    const { arguments: args, typeArguments } = expression;
    const resolution = this.resolveName(callee.name, callee);
    if (!resolution) return this.undefinedName(callee, callee.name);
    switch (resolution.kind) {
      case 'thisMember':
      case 'extensionMember': {
        this.requireThis(callee, callee.name);
        return this.compileMethodCall(
          this.thisReceiver(callee),
          callee.name,
          args,
          typeArguments,
          expression,
          context,
          false
        );
      }
      case 'staticMember': {
        return this.compileStaticCall(resolution.member, args, typeArguments, expression, context);
      }
      case 'declaration': {
        const { declaration } = resolution;
        if (declaration.kind === 'function')
          return this.compileFunctionCall(declaration.fn, args, typeArguments, expression, context);
        if (declaration.kind === 'extension')
          return this.compileExtensionOverride(declaration.ext, args, typeArguments, expression);
        if (declaration.kind === 'class') {
          return this.compileConstructorCall(
            declaration.cls,
            undefined,
            this.classTypeArguments(declaration.cls, typeArguments, callee),
            args,
            undefined,
            expression,
            context,
            false
          );
        }
        if (declaration.kind === 'alias') {
          const { cls, types } = this.aliasConstructor(declaration.alias, typeArguments, callee);
          return this.compileConstructorCall(cls, undefined, types, args, undefined, expression, context, false);
        }
        break;
      }
      case 'prefix': {
        return this.error(callee, `ライブラリの接頭辞 ${callee.name} は、それだけでは呼び出せません。`);
      }
      default: {
        break;
      }
    }
    return undefined;
  }

  /** A call `a.b(...)`: a static member, a named constructor, a prefixed declaration, or a method. */
  // code-gauge-allow functionCognitiveComplexity 24 -- Static, prefixed, extension and instance calls use distinct dispatch rules.
  // code-gauge-allow functionNcss 32 -- Static, prefixed, extension and instance calls use distinct dispatch rules.
  private compileMemberCall(
    expression: Extract<Expression, { kind: 'call' }>,
    callee: Extract<Expression, { kind: 'member' }>,
    context: DartType | undefined
  ): Compiled {
    const { arguments: args, typeArguments } = expression;
    const target = this.staticTarget(callee.object);
    if (target?.kind === 'class') {
      const member = target.cls.staticMembers.get(callee.name);
      if (member) return this.compileStaticCall(member, args, typeArguments, expression, context);
      const name = callee.name === 'new' ? undefined : callee.name;
      if (target.cls.constructors.has(name ?? '') || target.typeArgs) {
        const types =
          target.typeArgs ??
          (target.alias ? this.aliasConstructor(target.alias, undefined, callee, true).types : undefined);
        return this.compileConstructorCall(target.cls, name, types, args, typeArguments, expression, context, false);
      }
      return this.error(
        callee,
        `クラス ${target.cls.name} に ${callee.name} という static なメソッドやコンストラクタはありません。`
      );
    }
    if (target?.kind === 'prefix') {
      const declaration = this.library.lookupPrefixed(target.prefix, callee.name);
      if (declaration?.kind === 'function')
        return this.compileFunctionCall(declaration.fn, args, typeArguments, expression, context);
      if (declaration?.kind === 'class') {
        return this.compileConstructorCall(
          declaration.cls,
          undefined,
          this.classTypeArguments(declaration.cls, typeArguments, callee),
          args,
          undefined,
          expression,
          context,
          false
        );
      }
      if (declaration?.kind === 'alias') {
        const { cls, types } = this.aliasConstructor(declaration.alias, typeArguments, callee);
        return this.compileConstructorCall(cls, undefined, types, args, undefined, expression, context, false);
      }
      if (!declaration) return this.undefinedName(callee, callee.name, target.prefix);
    }
    if (target?.kind === 'extension') {
      const member = target.ext.staticMembers.get(callee.name);
      if (member) return this.compileStaticCall(member, args, typeArguments, expression, context);
      return this.error(callee, `拡張 ${target.ext.name ?? ''} に static なメソッド ${callee.name} はありません。`);
    }
    if (callee.object.kind === 'super') {
      return this.compileMethodCall(
        this.superReceiver(callee.object),
        callee.name,
        args,
        typeArguments,
        expression,
        context,
        false
      );
    }
    const receiver = this.compileChainPart(callee.object, undefined);
    return this.compileMethodCall(receiver, callee.name, args, typeArguments, expression, context, callee.nullAware);
  }

  /** `E(x)`, which applies the extension E to x explicitly. */
  private compileExtensionOverride(
    ext: ExtensionInfo,
    args: ArgumentsSyntax,
    typeArguments: TypeSyntax[] | undefined,
    span: Span
  ): Compiled {
    if (args.positional.length !== 1 || args.named.length > 0)
      this.error(span, `拡張 ${ext.name ?? ''} を明示して使うときは、値を 1 つだけ書いてください。`);
    const argument = args.positional[0];
    const instantiate = (types: readonly DartType[]): DartType =>
      substitute(ext.onType, new Map(ext.typeParams.map((parameter, index) => [parameter, types[index]])));
    const written = typeArguments && this.explicitTypeArguments(ext.typeParams, typeArguments, span);
    const context = written ? instantiate(written) : ext.typeParams.length === 0 ? ext.onType : undefined;
    const value = this.compileExpression(argument, context);
    const typeArgs =
      written ??
      (value.type.kind === 'dynamic'
        ? instantiateToBounds(ext.typeParams)
        : inferExtensionReceiver(value.type, ext.onType, ext.typeParams));
    if (!written) this.checkBounds(ext.typeParams, typeArgs, span);
    const onType = context ?? instantiate(typeArgs);
    const checked = this.coerce(
      value,
      onType,
      argument,
      (from, to) => `${from} 型の値には、${to} 型の拡張 ${ext.name ?? ''} は使えません。`
    );
    return { ...checked, type: onType, extensionOverride: { ext, typeArgs }, variable: undefined };
  }

  /** The type arguments written after a class's name in a constructor call (`Box<int>(1)`), if any. */
  private classTypeArguments(
    cls: ClassInfo,
    typeArguments: TypeSyntax[] | undefined,
    span: Span
  ): DartType[] | undefined {
    if (!typeArguments) return undefined;
    return this.typeArgumentsFor(
      cls.typeParams,
      { ...at(span), kind: 'named', prefix: undefined, name: cls.name, args: typeArguments, nullable: false },
      cls.name
    );
  }

  /** Calls the value of an expression: a function, or an object with a `call` method. */
  private compileValueCall(
    target: Compiled,
    args: ArgumentsSyntax,
    typeArguments: TypeSyntax[] | undefined,
    span: Span,
    context: DartType | undefined
  ): Compiled {
    const base = resolveBound(target.type);
    if (base.kind === 'dynamic' || (base.kind === 'interface' && base.cls === coreTypes.function && !base.nullable)) {
      return this.dynamicCall(target, undefined, args, span, false, typeArguments ?? []);
    }
    if (isNullable(base)) {
      this.error(span, `${typeName(target.type)} 型の値は null かもしれないので、直接は呼び出せません。`);
    }
    if (base.kind === 'function') {
      const bound = this.bindArguments(base, args, typeArguments, span, context);
      const run = target.run;
      return {
        type: bound.returnType,
        run: (frame) => {
          const fn = run(frame);
          if (fn === SHORTED) return SHORTED;
          frame.temporaries.push(fn);
          let evaluated: Arguments;
          try {
            evaluated = bound.args(frame);
          } finally {
            frame.temporaries.pop();
          }
          return frame.runtime.callValue(fn, evaluated, bound.typeArgs(frame), this.callRow(span));
        },
        isConst: false,
      };
    }
    return this.compileMethodCall(target, 'call', args, typeArguments, span, context, false);
  }

  /** Calls a member found through a receiver's static type, dispatching on the receiver's class at runtime. */
  // code-gauge-allow functionNcss 35 -- Methods, getters, extensions, records, and dynamic receivers.
  // code-gauge-allow functionParameterCount 7 -- Methods, getters, extensions, records, and dynamic receivers.
  compileMethodCall(
    receiver: Compiled,
    name: string,
    args: ArgumentsSyntax,
    typeArguments: TypeSyntax[] | undefined,
    span: Span,
    context: DartType | undefined,
    nullAware: boolean
  ): Compiled {
    const receiverType = receiver.type;
    if (receiverType.kind === 'void') this.error(span, 'void の値のメンバーは使えません。');
    this.skipOnNull(receiver, nullAware);
    if (this.dynamicDispatchType(receiver)) {
      return this.dynamicCall(receiver, name, args, span, nullAware, typeArguments);
    }
    const lookupType = nullAware ? nonNullable(receiverType) : receiverType;
    const resolved = this.memberFor(receiver, lookupType, name, span);
    if (!resolved) {
      this.checkUnavailableIoMember(lookupType, name, span);
      return this.error(span, `${typeName(nonNullable(receiverType))} 型には ${name} というメソッドがありません。`);
    }
    if (
      !nullAware &&
      isPotentiallyNullable(receiverType) &&
      !this.acceptsNull(resolved) &&
      receiverType.kind !== 'null'
    ) {
      const what = name === '[]' ? '添字 [ ]' : `${name}()`;
      this.error(
        span,
        `${typeName(receiverType)} 型の値は null かもしれないので、${what} を直接は使えません。?. を使うか、null でないことを確かめてください。`
      );
    }
    if (resolved.member.kind !== 'method') {
      // A getter or field whose value is called.
      const value = this.readMember(receiver, resolved, name, span, nullAware);
      return this.compileValueCall(value, args, typeArguments, span, context);
    }
    const signature = resolved.type as FunctionType;
    const bound = this.bindArguments(signature, args, typeArguments, span, context);
    const receiverRun = receiver.run;
    const row = this.callRow(span);
    const specialType = this.specialNumericReturn(receiverType, name, args);
    const returnType = specialType ?? bound.returnType;
    if (resolved.extension) {
      const run = extensionMethodCall(
        receiverRun,
        resolved.member,
        this.runtimeTypes(resolved.extension.typeArgs),
        bound,
        nullAware,
        row
      );
      return { type: returnType, run, isConst: false };
    }
    if (receiver.isSuper) {
      const call = this.superMethodTarget(name, span, row);
      const run: Eval = (frame) => call(frame, bound.args(frame), bound.typeArgs(frame));
      return { type: returnType, run, isConst: false };
    }
    return {
      type: returnType,
      run: virtualMethodCall(receiverRun, this.runtimeMemberName(name), bound, nullAware, row),
      isConst: false,
    };
  }

  protected superMethodTarget(
    name: string,
    span: Span,
    row: number | undefined
  ): (frame: Frame, args: Arguments, typeArgs?: readonly DartType[]) => Value {
    this.requireSuperImplementation(name, span);
    const { classAt } = this.superclassOf(span);
    const key = this.runtimeMemberName(name);
    return (frame, args, typeArgs = []) => {
      const { runtime, receiver } = frame;
      const member = runtime.instanceMember(classAt(frame), key);
      if (member?.kind !== 'method') return runtime.noSuchMethod(receiver, key, 'method', args, typeArgs);
      return (member.impl as Callable)(runtime, receiver, args, typeArgs, row);
    };
  }

  /**
   * The result type that Dart's special rules give `remainder` and `clamp` on ints and doubles (int with int
   * arguments, double with a double receiver or argument), where the methods' signatures say num.
   */
  private specialNumericReturn(receiverType: DartType, name: string, args: ArgumentsSyntax): DartType | undefined {
    if (name !== 'remainder' && name !== 'clamp') return undefined;
    const receiver = numericClassOf(receiverType);
    if (!receiver || receiver === 'num') return undefined;
    const argumentTypes = args.positional.map((argument) => numericClassOf(this.peekType(argument)));
    if (receiver === 'double' && name === 'remainder') return interfaceType(coreTypes.double);
    if (argumentTypes.every((type) => type === receiver))
      return interfaceType(receiver === 'int' ? coreTypes.int : coreTypes.double);
    if (name === 'remainder' && argumentTypes.every((type) => type === 'double'))
      return interfaceType(coreTypes.double);
    return undefined;
  }

  /** The static type of an argument already compiled by the call, read from the types it recorded. */
  private peekType(argument: Expression): DartType {
    return this.argumentTypes.get(argument) ?? DYNAMIC;
  }

  /** The static types of the arguments the last bound call compiled, by their syntax. */
  protected readonly argumentTypes = new WeakMap<Expression, DartType>();

  private dynamicCall(
    receiver: Compiled,
    name: string | undefined,
    args: ArgumentsSyntax,
    span: Span,
    nullAware = false,
    typeArguments: TypeSyntax[] = []
  ): Compiled {
    const typeArgs = typeArguments.map((argument) => this.runtimeType(this.resolveType(argument)));
    const { positionalRuns, namedRuns } = this.compileArgumentRuns(undefined, args);
    const evaluate = this.argumentEvaluator(args, positionalRuns, namedRuns, true);
    const receiverRun = receiver.run;
    const row = this.callRow(span);
    const member = name === undefined ? undefined : this.runtimeMemberName(name);
    return {
      type: DYNAMIC,
      run: (frame) => {
        const value = receiverRun(frame);
        if (value === SHORTED || (nullAware && value === undefined)) return SHORTED;
        frame.temporaries.push(value);
        let evaluated: Arguments;
        try {
          evaluated = evaluate(frame);
        } finally {
          frame.temporaries.pop();
        }
        const types = typeArgs.map((resolve) => resolve(frame));
        if (member === undefined) return frame.runtime.callValue(value, evaluated, types, row);
        return frame.runtime.invoke(value, member, evaluated, types, row);
      },
      isConst: false,
    };
  }

  private compileStaticCall(
    member: Member,
    args: ArgumentsSyntax,
    typeArguments: TypeSyntax[] | undefined,
    span: Span,
    context: DartType | undefined
  ): Compiled {
    if (member.kind !== 'method') {
      const value = this.readStatic(member, span);
      return this.compileValueCall(value, args, typeArguments, span, context);
    }
    this.checkUnavailableStaticMember(member.owner, member.name, span);
    const bound = this.bindArguments(member.type, args, typeArguments, span, context);
    const row = this.callRow(span);
    const method = member;
    return {
      type: bound.returnType,
      run: (frame) =>
        (method.impl as Callable)(frame.runtime, undefined, bound.args(frame), bound.typeArgs(frame), row),
      isConst: false,
    };
  }

  private compileFunctionCall(
    fn: TopLevelFunction,
    args: ArgumentsSyntax,
    typeArguments: TypeSyntax[] | undefined,
    span: Span,
    context: DartType | undefined
  ): Compiled {
    const bound = this.bindArguments(fn.type, args, typeArguments, span, context);
    const row = this.callRow(span);
    const identical = fn.library === 'dart:core' && fn.name === 'identical';
    return {
      type: bound.returnType,
      run: (frame) => (fn.impl as Callable)(frame.runtime, undefined, bound.args(frame), bound.typeArgs(frame), row),
      isConst: identical && bound.argumentsAreConst,
    };
  }

  /** The row a call shows in a trace, or undefined in library code, whose calls traces leave out. */
  protected callRow(span: Span): number | undefined {
    return this.isLibraryCode ? undefined : span.row;
  }

  // Constructors

  compileNew(expression: Extract<Expression, { kind: 'new' }>, context: DartType | undefined): Compiled {
    const { type: typeSyntax } = expression;
    if (typeSyntax.kind !== 'named') return this.error(expression, 'クラスの名前を書いてください。');
    let { constructorName } = expression;
    let { name, prefix } = typeSyntax;
    // The grammar can interpret the same dotted name as either a named constructor or a prefixed type.
    if (
      prefix === undefined &&
      constructorName !== undefined &&
      typeSyntax.args.length === 0 &&
      this.library.hasPrefix(name)
    ) {
      prefix = name;
      name = constructorName;
      constructorName = undefined;
    } else if (
      prefix !== undefined &&
      constructorName === undefined &&
      typeSyntax.args.length === 0 &&
      !this.library.hasPrefix(prefix)
    ) {
      constructorName = name;
      name = prefix;
      prefix = undefined;
    }
    const target = this.resolveConstructorType({ ...typeSyntax, name, prefix }, expression, expression.isSelectorCall);
    return this.compileConstructorCall(
      target.cls,
      constructorName,
      target.types,
      expression.arguments,
      undefined,
      expression,
      context,
      expression.isConst
    );
  }

  private resolveConstructorType(
    { name, prefix, args }: Extract<TypeSyntax, { kind: 'named' }>,
    span: Span,
    isSelector = false
  ): { cls: ClassInfo; types: ConstructorTypes } {
    this.checkTypeNameBinding(name, prefix, span);
    if (prefix === undefined && this.findTypeParam(name, span))
      return this.error(span, `型引数 ${name} にはコンストラクタがありません。`);
    const declaration = prefix === undefined ? this.library.lookup(name) : this.library.lookupPrefixed(prefix, name);
    const writtenTypes = args.length > 0 ? args : undefined;
    if (declaration?.kind === 'alias') {
      return this.aliasConstructor(declaration.alias, writtenTypes, span, isSelector);
    }
    if (declaration?.kind === 'class') {
      return { cls: declaration.cls, types: this.classTypeArguments(declaration.cls, writtenTypes, span) };
    }
    this.checkUnavailableName(span, name, prefix);
    return this.error(span, `クラス ${name} が見つかりません。`);
  }

  /**
   * Calls a constructor of a class, inferring the class's type arguments from the context and the arguments when they
   * are not written.
   */
  // code-gauge-allow functionCognitiveComplexity 21 -- Checks of what may be constructed.
  // code-gauge-allow functionParameterCount 8 -- Checks of what may be constructed.
  compileConstructorCall(
    cls: ClassInfo,
    name: string | undefined,
    typeArgs: ConstructorTypes,
    args: ArgumentsSyntax,
    methodTypeArguments: TypeSyntax[] | undefined,
    span: Span,
    context: DartType | undefined,
    isConstSyntax: boolean
  ): Compiled {
    if (methodTypeArguments) this.error(span, 'コンストラクタには、型引数をこの位置には書けません。');
    this.checkUnavailableStaticMember(cls, name ?? '', span);
    const constructor = cls.constructors.get(name === 'new' ? '' : (name ?? ''));
    if (!constructor) {
      if (cls.kind === 'enum') return this.error(span, '列挙型のオブジェクトは作れません。');
      if (name) return this.error(span, `クラス ${cls.name} に ${name} というコンストラクタはありません。`);
      return this.error(span, `クラス ${cls.name} には、名前のないコンストラクタがありません。`);
    }
    if (cls.kind === 'enum' && constructor.kind === 'generative')
      this.error(span, '列挙型のオブジェクトは作れません。');
    if (constructor.kind === 'generative' && cls.isAbstract) {
      this.error(span, `抽象クラス ${cls.name} のオブジェクトは作れません。`);
    }
    if (cls.kind === 'mixin') this.error(span, `mixin ${cls.name} のオブジェクトは作れません。`);
    const isConst = isConstSyntax || (this.inConstContext && constructor.isConst);
    if (isConstSyntax && !constructor.isConst) {
      this.error(span, `${cls.name}${name ? `.${name}` : ''} は const のコンストラクタではありません。`);
    }
    const signature = constructorSignature(cls, constructor, typeArgs);
    const bound = this.withConstContext(isConst, () => this.bindArguments(signature, args, undefined, span, context));
    if (isConst && !bound.argumentsAreConst)
      this.error(span, 'const のコンストラクタ呼び出しの引数は、定数でなければなりません。');
    const resolvedArgs = constructorArguments(typeArgs, bound.staticTypeArgs);
    const nullable = typeArgs !== undefined && !Array.isArray(typeArgs) && typeArgs.nullableResult;
    const type = interfaceType(cls, resolvedArgs, nullable);
    const runtimeArgs = this.runtimeTypes(resolvedArgs);
    const run = this.constructObject(cls, constructor, runtimeArgs, bound.args, span, isConst);
    return { type, run, isConst, creates: true };
  }

  private aliasConstructor(
    alias: TypeAlias,
    written: TypeSyntax[] | undefined,
    span: Span,
    selector = false
  ): { cls: ClassInfo; types: ConstructorTypes } {
    const template = this.resolveAlias(alias, span);
    if (template.kind !== 'interface')
      return this.error(span, alias.name + ' は、コンストラクタを持つクラスの別名ではありません。');
    const nullableResult = template.nullable && (selector || alias.typeParams.length > 0);
    const types = { template, parameters: alias.typeParams, nullableResult };
    if (!written) return { cls: template.cls, types };
    const args = written
      ? this.typeArgumentsFor(
          alias.typeParams,
          { ...at(span), kind: 'named', name: alias.name, prefix: undefined, args: written, nullable: false },
          alias.name
        )
      : [];
    return { cls: template.cls, types: constructorArguments(types, args) };
  }

  // Arguments

  /**
   * Checks a call's arguments against a function type and infers the function's own type arguments when they are
   * not written: first from the context of the call, then from the arguments that are not function literals, and then
   * from function literals, whose parameters take the types inferred so far.
   */
  bindArguments(
    type: FunctionType,
    args: ArgumentsSyntax,
    typeArguments: TypeSyntax[] | undefined,
    span: Span,
    context: DartType | undefined
  ): BoundCall {
    this.checkArity(type, args, span);
    const compiled = new Map<Expression, Compiled>();
    let staticTypeArgs: DartType[] = [];
    let signature = type;
    if (typeArguments) staticTypeArgs = this.explicitTypeArguments(type.typeParams, typeArguments, span);
    if (type.typeParams.length > 0) {
      if (!typeArguments) staticTypeArgs = this.inferTypeArguments(type, args, context, compiled);
      signature = instantiateFunction(type, staticTypeArgs);
    }
    const { positionalRuns, namedRuns, argumentsAreConst } = this.compileArgumentRuns(signature, args, compiled);
    return {
      returnType: signature.returnType,
      argumentsAreConst,
      args: this.argumentEvaluator(args, positionalRuns, namedRuns, false),
      typeArgs: this.runtimeTypes(staticTypeArgs),
      staticTypeArgs,
    };
  }

  /**
   * Infers a generic function's type arguments from the context and the arguments, compiling the arguments: those
   * other than function literals see only what the context gave; function literals, compiled after them, also see
   * what those arguments gave.
   */
  // code-gauge-allow functionCognitiveComplexity 21 -- Gather ordinary arguments, contextually typed closures, and generic tear-offs.
  // code-gauge-allow functionNcss 34 -- Gather ordinary arguments, contextually typed closures, and generic tear-offs.
  private inferTypeArguments(
    type: FunctionType,
    args: ArgumentsSyntax,
    context: DartType | undefined,
    compiled: Map<Expression, Compiled>
  ): DartType[] {
    const params = new Set(type.typeParams);
    const fromContext = new Map<TypeParam, DartType>();
    // Any context but dynamic constrains the result, Object? included: `print(id(1))` makes T Object?.
    if (context && !isInferenceHole(context) && context.kind !== 'dynamic') {
      inferFromContext(context, type.returnType, params, fromContext);
    }
    const solution = new Map<TypeParam, DartType>();
    const upper = new Map<TypeParam, DartType>();
    const tearOffs: { result: Compiled; parameterType: DartType }[] = [];
    const argumentContext = (parameterType: DartType, closurePass: boolean): DartType => {
      const map = new Map(
        type.typeParams.map((param) => [
          param,
          argumentContextFor(param, type, fromContext, solution, upper, closurePass),
        ])
      );
      return substitute(parameterType, map);
    };
    visitCallArguments(args, type, ({ argument, parameterType = DYNAMIC }, closurePass) => {
      const result = this.compileExpression(argument, argumentContext(parameterType, closurePass));
      compiled.set(argument, result);
      const formal = resolveBound(parameterType);
      const actual = resolveBound(result.type);
      if (
        formal.kind === 'function' &&
        formal.typeParams.length === 0 &&
        actual.kind === 'function' &&
        actual.typeParams.length > 0
      ) {
        tearOffs.push({ result, parameterType });
      } else {
        inferFromSubtype(result.type, parameterType, params, solution, upperBound, upper);
      }
    });
    for (const { result, parameterType } of tearOffs) {
      const instantiated = this.instantiateGeneric(result, argumentContext(parameterType, true), true);
      if (instantiated) inferFromSubtype(instantiated.type, parameterType, params, solution, upperBound, upper);
    }
    return fitToBounds(type, chooseTypeArguments(type, params, solution, upper, fromContext));
  }

  private compileArgumentRuns(
    signature: FunctionType | undefined,
    args: ArgumentsSyntax,
    compiled?: ReadonlyMap<Expression, Compiled>
  ): { positionalRuns: Eval[]; namedRuns: { name: string; run: Eval }[]; argumentsAreConst: boolean } {
    let argumentsAreConst = true;
    const positionalRuns: Eval[] = [];
    const namedRuns: { name: string; run: Eval }[] = [];
    visitCallArguments(args, signature, ({ argument, index, name, parameterType }) => {
      const value = compiled?.get(argument) ?? this.compileExpression(argument, parameterType);
      this.argumentTypes.set(argument, value.type);
      if (value.type.kind === 'void' && parameterType?.kind !== 'void' && parameterType?.kind !== 'dynamic') {
        this.error(argument, 'void の値は引数に渡せません。');
      }
      argumentsAreConst &&= value.isConst;
      const run = parameterType
        ? this.coerce(
            value,
            parameterType,
            argument,
            (from, to) => `${from} 型の値は、${to} 型の引数${name === undefined ? '' : ` ${name}`}に渡せません。`
          ).run
        : value.run;
      if (name === undefined) positionalRuns[index] = run;
      else namedRuns[index] = { name, run };
    });
    return { positionalRuns, namedRuns, argumentsAreConst };
  }

  private checkArity(type: FunctionType, args: ArgumentsSyntax, span: Span): void {
    const count = args.positional.length;
    if (count < type.requiredCount) {
      this.error(span, `位置で渡す引数が足りません。${type.requiredCount} 個必要ですが、${count} 個です。`);
    }
    if (count > type.positional.length) {
      this.error(span, `位置で渡す引数が多すぎます。${type.positional.length} 個までですが、${count} 個です。`);
    }
    const seen = new Set<string>();
    for (const argument of args.named) {
      const { name } = argument;
      if (seen.has(name)) this.error(argument, `名前付き引数 ${name} が重複しています。`);
      seen.add(name);
      if (!type.named.some((named) => named.name === name)) {
        this.error(argument, `名前付き引数 ${name} はありません。`);
      }
    }
    for (const named of type.named) {
      if (named.isRequired && !seen.has(named.name)) {
        this.error(span, `名前付き引数 ${named.name} は必須ですが、渡されていません。`);
      }
    }
  }

  /** Evaluates arguments in source order, keeping those evaluated so far reachable while the rest evaluate. */
  // code-gauge-allow functionNcss 36 -- One case per form of the construct, which reads best together.
  protected argumentEvaluator(
    args: ArgumentsSyntax,
    positional: Eval[],
    named: { name: string; run: Eval }[],
    isDynamic: boolean
  ): (frame: Frame) => Arguments {
    const invocation = isDynamic ? 'dynamic' : undefined;
    if (args.order.length === 0) return () => ({ positional: [], named: undefined, invocation });
    if (named.length === 0) {
      if (positional.length === 1) {
        const [run] = positional;
        return (frame) => ({ positional: [run(frame)], named: undefined, invocation });
      }
      return (frame) => {
        const values: Value[] = [];
        const mark = frame.temporaries.length;
        try {
          for (const run of positional) {
            const value = run(frame);
            values.push(value);
            frame.temporaries.push(value);
          }
        } finally {
          frame.temporaries.length = mark;
        }
        return { positional: values, named: undefined, invocation };
      };
    }
    const { order } = args;
    return (frame) => {
      const values: Value[] = Array.from({ length: positional.length });
      const namedValues = new Map<string, Value>();
      const mark = frame.temporaries.length;
      try {
        for (const entry of order) {
          if (entry.kind === 'positional') {
            const value = positional[entry.index](frame);
            values[entry.index] = value;
            frame.temporaries.push(value);
          } else {
            const { name, run } = named[entry.index];
            const value = run(frame);
            namedValues.set(name, value);
            frame.temporaries.push(value);
          }
        }
      } finally {
        frame.temporaries.length = mark;
      }
      return { positional: values, named: namedValues, invocation };
    };
  }

  // Closures

  // code-gauge-allow functionCognitiveComplexity 20 -- Inference of a function literal's types from its context.
  compileFunctionExpression(
    expression: Extract<Expression, { kind: 'function' }>,
    context: DartType | undefined
  ): Compiled {
    this.checkTypeParameterAnnotations(expression.typeParameters);
    const contextType = context ? resolveBound(context) : undefined;
    const typeParams = this.declareTypeParams(expression.typeParameters);
    const contextFunction =
      contextType?.kind === 'function' && contextType.typeParams.length === typeParams.length
        ? instantiateFunction(
            contextType,
            typeParams.map((parameter) => typeParamType(parameter))
          )
        : undefined;
    return this.withTypeParams(typeParams, () => {
      const { parameters } = expression;
      const positionalTypes = parameters.positional.map((parameter, index) => {
        if (parameter.type) return this.resolveType(parameter.type);
        const fromContext = contextFunction?.positional[index];
        return fromContext && !isInferenceHole(fromContext) ? fromContext : DYNAMIC;
      });
      const namedTypes = new Map(
        parameters.named.map((parameter) => {
          if (parameter.type) return [parameter.argumentName, this.resolveType(parameter.type)];
          const fromContext = contextFunction?.named.find((named) => named.name === parameter.argumentName)?.type;
          return [parameter.argumentName, fromContext && !isInferenceHole(fromContext) ? fromContext : DYNAMIC];
        })
      );
      const contextReturn = contextFunction?.returnType;
      const compiled = this.compileFunction({
        name: '<anonymous closure>',
        span: expression,
        headerEndRow: expression.body.row,
        parameters,
        positionalTypes,
        namedTypes,
        returnType: undefined,
        contextReturnType: contextReturn && !isInferenceHole(contextReturn) ? contextReturn : undefined,
        body: expression.body,
        typeParams,
        kind: {
          returnType: undefined,
          isGenerator: expression.body.modifier === 'sync*',
          thisClass: this.fn.kind.thisClass,
          thisType: this.fn.kind.thisType,
          hasThis: this.fn.kind.hasThis,
          extensionOn: this.fn.kind.extensionOn,
          isInitializer: this.fn.kind.isInitializer,
          isConstructor: false,
        },
        showsThis: false,
      });
      const type = functionType(positionalTypes, compiled.returnType, {
        requiredCount: parameters.requiredCount,
        named: parameters.named.map((parameter) => ({
          name: parameter.argumentName,
          type: namedTypes.get(parameter.argumentName) ?? DYNAMIC,
          isRequired: parameter.isRequired,
        })),
        typeParams,
      });
      return { type, run: this.closureCreator(compiled, type), isConst: false };
    });
  }

  /** Creates a closure at runtime, capturing the cells of the variables its body uses. */
  protected closureCreator(compiled: CompiledFunction, type: FunctionType): (frame: Frame) => DartClosure {
    const { fn } = compiled;
    const parent = this.fn;
    const sources = fn.captures.map((variable) => {
      if (variable.owner === parent) return { local: variable.slot, captured: -1 };
      return { local: -1, captured: parent.captures.indexOf(variable) };
    });
    const resolveType = this.runtimeType(type);
    const ownParams = type.typeParams;
    const { qualifiedName } = fn;
    return (frame) => {
      frame.runtime.allocate(sources.length + 1);
      const captured: Cell[] = sources.map(({ local, captured: index }) =>
        local >= 0 ? (frame.locals[local] as Cell) : frame.captured[index]
      );
      const outerEnv = frame.typeEnv;
      const receiver = frame.receiver;
      const callable: Callable = (runtime, boundReceiver, args, typeArgs, callRow) => {
        let typeEnv = outerEnv;
        if (ownParams.length > 0) {
          const env = new Map(outerEnv);
          for (const [index, param] of ownParams.entries()) env.set(param, typeArgs[index] ?? DYNAMIC);
          typeEnv = env;
        }
        return this.runFunction(
          compiled,
          runtime,
          boundReceiver,
          captured,
          typeEnv,
          args,
          callRow ?? runtime.userCallRow
        );
      };
      return new DartClosure(
        coreTypes.function,
        resolveType(frame) as FunctionType,
        callable,
        receiver,
        captured,
        { name: undefined, origin: undefined, qualifiedName },
        undefined
      );
    };
  }

  /** Runs a compiled function in a new frame. */
  // code-gauge-allow functionParameterCount 7 -- The parameters are the parts a caller already holds; grouping them would only rename them.
  runFunction(
    compiled: CompiledFunction,
    runtime: Runtime,
    receiver: Value,
    captured: readonly Cell[],
    typeEnv: TypeEnv,
    args: Arguments,
    callRow: number | undefined
  ): Value {
    const frame = new FrameClass(
      runtime,
      compiled.fn.info,
      compiled.fn.slotCount,
      receiver,
      captured,
      typeEnv,
      callRow
    );
    runtime.enter(frame);
    try {
      runtime.spend();
      compiled.bind(frame, args);
      return compiled.run(frame);
    } finally {
      runtime.exit(frame);
    }
  }

  // Tear-offs and shorthands

  compileConstructorTearoff(type: TypeSyntax, name: string | undefined, span: Span): Compiled {
    if (type.kind !== 'named') return this.error(span, 'クラスの名前を書いてください。');
    const { cls, types: typeArgs } = this.resolveConstructorType(type, span);
    this.checkUnavailableStaticMember(cls, name ?? '', span);
    const constructor = cls.constructors.get(name === 'new' ? '' : (name ?? ''));
    if (!constructor)
      return this.error(span, `クラス ${cls.name} に ${name ?? '名前のない'} コンストラクタはありません。`);
    if (cls.kind === 'enum' && constructor.kind === 'generative')
      this.error(span, '列挙型のコンストラクタは取り出せません。');
    if (constructor.kind === 'generative' && cls.isAbstract)
      this.error(span, `抽象クラス ${cls.name} のコンストラクタは取り出せません。`);
    const signature = constructorSignature(cls, constructor, typeArgs);
    const fixedArgs = Array.isArray(typeArgs) ? this.runtimeTypes(typeArgs) : undefined;
    const resolveSignature = this.runtimeType(signature);
    return {
      type: signature,
      run: (frame) => {
        const reified = resolveSignature(frame) as FunctionType;
        return frame.runtime.constructorTearOff(constructor, reified, () => {
          const resolvedFixed = fixedArgs?.(frame);
          const callable: Callable = (runtime, _receiver, args, callTypeArgs, callRow) =>
            this.instantiate(
              runtime,
              cls,
              constructor,
              resolvedFixed ?? constructorArguments(typeArgs, callTypeArgs),
              args,
              callRow
            );
          return new DartClosure(
            coreTypes.function,
            reified,
            callable,
            undefined,
            [],
            { name: cls.name, origin: undefined },
            undefined
          );
        });
      },
      isConst: true,
    };
  }

  compileDotShorthand(
    expression: Extract<Expression, { kind: 'dotShorthand' }>,
    context: DartType | undefined
  ): Compiled {
    const base = context ? resolveBound(nonNullable(context)) : undefined;
    if (base?.kind !== 'interface')
      return this.error(expression, '. で始まる書き方は、型が決まっている所でしか使えません。');
    const { cls } = base;
    const { name, arguments: args } = expression;
    const typeArgs = base.args.length > 0 ? [...base.args] : undefined;
    if (args) {
      const member = cls.staticMembers.get(name);
      if (member) return this.compileStaticCall(member, args, undefined, expression, context);
      return this.compileConstructorCall(
        cls,
        name === 'new' ? undefined : name,
        typeArgs,
        args,
        undefined,
        expression,
        context,
        expression.isConst
      );
    }
    const member = cls.staticMembers.get(name);
    if (!member) return this.error(expression, `クラス ${cls.name} に static なメンバー ${name} がありません。`);
    return this.readStatic(member, expression);
  }
}

/** The supertypes of an interface type, nearest first along the superclass chain, then the interfaces. */
function supertypesOf(type: InterfaceType): InterfaceType[] {
  const result: InterfaceType[] = [];
  const queue: InterfaceType[] = [type];
  while (queue.length > 0) {
    const current = queue.shift() as InterfaceType;
    const map = new Map(current.cls.typeParams.map((param, index) => [param, current.args[index] ?? DYNAMIC]));
    for (const supertype of current.cls.directSupertypes) {
      const substituted = substitute(supertype, map) as InterfaceType;
      if (!result.some((other) => other.cls === substituted.cls)) {
        result.push(substituted);
        queue.push(substituted);
      }
    }
  }
  return result;
}

import { Frame as FrameClass } from './runtime';

export { boundOf, NEVER, NULL, typeParamType, VOID };

/** Evaluates a call's arguments while its receiver is kept where garbage collection sees it. */
function argumentsFor(frame: Frame, receiver: Value, bound: BoundCall): Arguments {
  frame.temporaries.push(receiver);
  try {
    return bound.args(frame);
  } finally {
    frame.temporaries.pop();
  }
}

function extensionMethodCall(
  receiverRun: Eval,
  member: Member,
  extensionTypeArgs: (frame: Frame) => DartType[],
  bound: BoundCall,
  nullAware: boolean,
  row: number | undefined
): Eval {
  return (frame) => {
    const value = receiverRun(frame);
    if (value === SHORTED || (nullAware && value === undefined)) return SHORTED;
    const evaluated = argumentsFor(frame, value, bound);
    return (member.impl as Callable)(
      frame.runtime,
      value,
      evaluated,
      [...extensionTypeArgs(frame), ...bound.typeArgs(frame)],
      row
    );
  };
}

function constructorSignature(cls: ClassInfo, constructor: ConstructorInfo, typeArgs: ConstructorTypes): FunctionType {
  if (!typeArgs) return { ...constructor.type, typeParams: cls.typeParams };
  const classArgs = Array.isArray(typeArgs) ? typeArgs : typeArgs.template.args;
  const substitution = new Map(cls.typeParams.map((param, index) => [param, classArgs[index]]));
  const instantiated = substitute({ ...constructor.type, typeParams: [] }, substitution) as FunctionType;
  return { ...instantiated, typeParams: Array.isArray(typeArgs) ? [] : typeArgs.parameters };
}

function constructorArguments(typeArgs: ConstructorTypes, inferred: readonly DartType[]): DartType[] {
  if (!typeArgs) return [...inferred];
  if (Array.isArray(typeArgs)) return typeArgs;
  const substitution = new Map(typeArgs.parameters.map((param, index) => [param, inferred[index] ?? DYNAMIC]));
  return typeArgs.template.args.map((arg) => substitute(arg, substitution));
}

/** A call dispatched on the receiver's class, caching the implementation for the last class seen. */
function virtualMethodCall(
  receiverRun: Eval,
  name: string,
  bound: BoundCall,
  nullAware: boolean,
  row: number | undefined
): Eval {
  let cachedClass: ClassInfo | undefined;
  let cachedMember: Member | undefined;
  return (frame) => {
    const value = receiverRun(frame);
    if (value === SHORTED || (nullAware && value === undefined)) return SHORTED;
    const evaluated = argumentsFor(frame, value, bound);
    const { runtime } = frame;
    const cls = runtime.classOf(value);
    if (cls !== cachedClass) {
      cachedClass = cls;
      cachedMember = runtime.instanceMember(cls, name);
    }
    const member = cachedMember;
    if (name === 'call' && value instanceof DartClosure)
      return value.call(runtime, value.receiver, evaluated, bound.typeArgs(frame), row);
    if (member?.kind === 'method')
      return (member.impl as Callable)(runtime, value, evaluated, bound.typeArgs(frame), row);
    if (member) return runtime.callGetterValue(value, member, evaluated, bound.typeArgs(frame), row);
    return runtime.noSuchMethod(value, name, 'method', evaluated, bound.typeArgs(frame));
  };
}

function visitCallArguments(
  args: ArgumentsSyntax,
  signature: FunctionType | undefined,
  visit: (argument: CallArgument, closurePass: boolean) => void
): void {
  const closures: CallArgument[] = [];
  for (const entry of args.order) {
    const argument = callArgument(args, entry, signature);
    if (isClosureArgument(argument.argument)) closures.push(argument);
    else visit(argument, false);
  }
  // Dart checks a function literal's body with the flow and type constraints from the other arguments.
  for (const closure of closures) visit(closure, true);
}

function isClosureArgument(expression: Expression): boolean {
  while (expression.kind === 'parenthesized') expression = expression.expression;
  return expression.kind === 'function';
}

function callArgument(
  args: ArgumentsSyntax,
  entry: ArgumentsSyntax['order'][number],
  signature: FunctionType | undefined
): CallArgument {
  const { index } = entry;
  if (entry.kind === 'positional')
    return { argument: args.positional[index], index, parameterType: signature?.positional[index] };
  const { value, name } = args.named[index];
  return {
    argument: value,
    index,
    name,
    parameterType: signature?.named.find((parameter) => parameter.name === name)?.type,
  };
}

/**
 * What a type parameter stands for in an argument's context. A closure's parameters take the context's type over what
 * the other arguments gave, as Dart solves the context first: `num n = ap(1, (a) => a + 1)` types `a` as num. Other
 * arguments see only a context that says more than Object?, as `[3, 9]` in `print(maxOf([3, 9]))` stays a List<int>.
 * A context beyond the bound is clamped to it, as `print(pick([1], (x) => x.isEven))` types x as num.
 */
function argumentContextFor(
  param: TypeParam,
  type: FunctionType,
  fromContext: ReadonlyMap<TypeParam, DartType>,
  solution: ReadonlyMap<TypeParam, DartType>,
  upper: ReadonlyMap<TypeParam, DartType>,
  closurePass: boolean
): DartType {
  const params = new Set(type.typeParams);
  const contextual = fromContext.get(param);
  const usable =
    contextual &&
    !mentionsTypeParams(contextual, params) &&
    withinBound(param, contextual, type.typeParams) &&
    (closurePass || !isTop(contextual))
      ? contextual
      : undefined;
  if (usable) return usable;
  if (!closurePass) return INFERENCE_HOLE;
  if (contextual && param.bound && !mentionsTypeParams(param.bound, params)) return param.bound;
  return solution.get(param) ?? upper.get(param) ?? INFERENCE_HOLE;
}

/** Whether a type argument satisfies its parameter's bound, with the parameter itself in place of F-bounded uses. */
function withinBound(param: TypeParam, argument: DartType, typeParams: readonly TypeParam[]): boolean {
  const { bound } = param;
  if (!bound) return true;
  const map = new Map(typeParams.map((other) => [other, other === param ? argument : DYNAMIC] as const));
  return isSubtype(argument, substitute(bound, map));
}

function chooseTypeArguments(
  type: FunctionType,
  params: ReadonlySet<TypeParam>,
  solution: ReadonlyMap<TypeParam, DartType>,
  upper: ReadonlyMap<TypeParam, DartType>,
  fromContext: ReadonlyMap<TypeParam, DartType>
): DartType[] {
  const defaults = instantiateToBounds(type.typeParams);
  return type.typeParams.map((param, index) => {
    const fromArguments = solution.get(param);
    const contextual = fromContext.get(param);
    const limit = upper.get(param);
    if (
      contextual &&
      !isInferenceHole(contextual) &&
      (!fromArguments || isSubtype(fromArguments, contextual)) &&
      (!limit || isSubtype(contextual, limit)) &&
      !mentionsTypeParams(contextual, params) &&
      withinBound(param, contextual, type.typeParams)
    ) {
      return contextual;
    }
    if (fromArguments && !isInferenceHole(fromArguments)) return fromArguments;
    if (limit && !isInferenceHole(limit)) return limit;
    if (contextual && !isInferenceHole(contextual)) return contextual;
    return defaults[index];
  });
}

/**
 * A solution outside its bound moves up to the nearest supertype within it (an F-bounded `T extends Comparable<T>`
 * takes num for ints), and otherwise to the bound, which then fails the argument check.
 */
// code-gauge-allow functionCognitiveComplexity 17 -- Each branch is one of the cases Dart distinguishes for this construct.
function fitToBounds(type: FunctionType, typeArgs: DartType[]): DartType[] {
  return typeArgs.map((argument, index) => {
    const param = type.typeParams[index];
    if (!param.bound) return argument;
    const boundFor = (candidate: DartType): DartType =>
      substitute(
        param.bound as DartType,
        new Map(type.typeParams.map((other, at) => [other, at === index ? candidate : typeArgs[at]]))
      );
    if (isSubtype(argument, boundFor(argument))) return argument;
    if (argument.kind === 'interface') {
      for (const supertype of supertypesOf(argument)) if (isSubtype(supertype, boundFor(supertype))) return supertype;
    }
    return boundFor(argument);
  });
}
