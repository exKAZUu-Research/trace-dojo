import type { Arguments as ArgumentsSyntax, Expression, FormalParameters, FunctionBody, Span, TypeSyntax } from './ast';
import type { ClassInfo, ConstructorInfo, Member } from './classes';
import {
  at,
  type Compiled,
  type Eval,
  inferFromContext,
  inferFromSubtype,
  instantiateToBounds,
  type ResolvedMember,
  typeName,
} from './compilerBase';
import type { TopLevelFunction } from './environment';
import { ExpressionCompiler, INFERENCE_HOLE, isInferenceHole, SHORTED } from './expressionCompiler';
import type { Frame, Runtime, TypeEnv } from './runtime';
import type { FunctionContext } from './scope';
import {
  boundOf,
  coreTypes,
  type DartType,
  DYNAMIC,
  type FunctionType,
  functionType,
  instantiateFunction,
  type InterfaceType,
  interfaceType,
  isNullable,
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
  /** Undefined to infer the return type from the body, as closures do. */
  returnType: DartType | undefined;
  /** For closures, the return type the context expects, which return expressions are checked against. */
  contextReturnType: DartType | undefined;
  body: FunctionBody;
  typeParams: TypeParam[];
  kind: FunctionContext['kind'];
  showsThis: boolean;
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

export abstract class CallCompiler extends ExpressionCompiler {
  abstract compileFunction(spec: FunctionSpec): CompiledFunction;
  abstract constructObject(
    cls: ClassInfo,
    constructor: ConstructorInfo,
    typeArgs: (frame: Frame) => DartType[],
    args: (frame: Frame) => Arguments,
    span: Span,
    isConst: boolean
  ): Eval;

  // Calls

  // code-gauge-allow functionCognitiveComplexity 40 -- One case per kind of callee.
  compileCall(expression: Extract<Expression, { kind: 'call' }>, context: DartType | undefined): Compiled {
    const { callee, arguments: args, typeArguments } = expression;
    if (callee.kind === 'identifier') {
      const resolution = this.resolveName(callee.name);
      if (!resolution) return this.undefinedName(callee, callee.name);
      switch (resolution.kind) {
        case 'thisMember':
        case 'extensionMember': {
          this.requireThis(callee, callee.name);
          return this.compileMethodCall(
            this.thisReceiver(callee),
            callee,
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
          if (declaration.kind === 'alias' && declaration.alias.aliased?.kind === 'interface') {
            const aliased = declaration.alias.aliased;
            const typeArgs = declaration.alias.typeParams.length === 0 ? [...aliased.args] : undefined;
            return this.compileConstructorCall(
              aliased.cls,
              undefined,
              typeArgs,
              args,
              typeArguments,
              expression,
              context,
              false
            );
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
    }
    if (callee.kind === 'member') {
      const target = this.staticTarget(callee.object);
      if (target?.kind === 'class') {
        const member = target.cls.staticMembers.get(callee.name);
        if (member) return this.compileStaticCall(member, args, typeArguments, expression, context);
        if (target.cls.constructors.has(callee.name) || target.typeArgs) {
          return this.compileConstructorCall(
            target.cls,
            callee.name,
            target.typeArgs,
            args,
            typeArguments,
            expression,
            context,
            false
          );
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
        if (!declaration) return this.error(callee, `${target.prefix}.${callee.name} は定義されていません。`);
      }
      if (target?.kind === 'extension') {
        const member = target.ext.staticMembers.get(callee.name);
        if (member) return this.compileStaticCall(member, args, typeArguments, expression, context);
        return this.error(callee, `拡張 ${target.ext.name ?? ''} に static なメソッド ${callee.name} はありません。`);
      }
      if (callee.object.kind === 'super') {
        return this.compileMethodCall(
          this.superReceiver(callee.object),
          callee.object,
          callee.name,
          args,
          typeArguments,
          expression,
          context,
          false
        );
      }
      const receiver = this.compileChainPart(callee.object, undefined);
      return this.compileMethodCall(
        receiver,
        callee.object,
        callee.name,
        args,
        typeArguments,
        expression,
        context,
        callee.nullAware
      );
    }
    const target = this.compileChainPart(callee, undefined);
    return this.compileValueCall(target, args, typeArguments, expression, context);
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
      return this.dynamicCall(target, undefined, args, span);
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
        completes: !isNeverType(bound.returnType),
      };
    }
    return this.compileMethodCall(
      target,
      { ...at(span), kind: 'this' },
      'call',
      args,
      typeArguments,
      span,
      context,
      false
    );
  }

  /** Calls a member found through a receiver's static type, dispatching on the receiver's class at runtime. */
  // code-gauge-allow functionCognitiveComplexity 40 -- Methods, getters, extensions, records, and dynamic receivers.
  compileMethodCall(
    receiver: Compiled,
    receiverSyntax: Expression,
    name: string,
    args: ArgumentsSyntax,
    typeArguments: TypeSyntax[] | undefined,
    span: Span,
    context: DartType | undefined,
    nullAware: boolean
  ): Compiled {
    void receiverSyntax;
    const receiverType = receiver.type;
    if (receiverType.kind === 'void') this.error(span, 'void の値のメンバーは使えません。');
    if (receiverType.kind === 'dynamic' || (receiverType.kind === 'never' && !receiverType.nullable)) {
      return this.dynamicCall(receiver, name, args, span, nullAware);
    }
    const lookupType = nullAware ? nonNullable(receiverType) : receiverType;
    const resolved = this.lookupMember(lookupType, name, false);
    if (!resolved) {
      const shown = name === '[]' ? '[]' : name;
      return this.error(span, `${typeName(nonNullable(receiverType))} 型には ${shown} というメソッドがありません。`);
    }
    if (
      !nullAware &&
      isNullable(receiverType) &&
      resolved.member.owner !== coreTypes.object &&
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
    const bound = this.bindArguments(signature, args, typeArguments, span, context, resolved);
    const receiverRun = receiver.run;
    const row = this.callRow(span);
    const isSuper = (receiver as { isSuper?: boolean }).isSuper === true;
    const specialType = this.specialNumericReturn(receiverType, name, args);
    const returnType = specialType ?? bound.returnType;
    const completes = !isNeverType(bound.returnType);
    if (resolved.extension) {
      const extensionMember = resolved.member;
      const extensionArgs = resolved.extension.typeArgs;
      const extensionTypeArgs = this.runtimeTypes(extensionArgs);
      return {
        type: returnType,
        run: (frame) => {
          const value = receiverRun(frame);
          if (value === SHORTED || (nullAware && value === undefined)) return SHORTED;
          frame.temporaries.push(value);
          let evaluated: Arguments;
          try {
            evaluated = bound.args(frame);
          } finally {
            frame.temporaries.pop();
          }
          return (extensionMember.impl as Callable)(
            frame.runtime,
            value,
            evaluated,
            [...extensionTypeArgs(frame), ...bound.typeArgs(frame)],
            row
          );
        },
        isConst: false,
        completes,
      };
    }
    if (isSuper) {
      const { classAt } = this.superclassOf(span);
      return {
        type: returnType,
        run: (frame) => {
          const member = classAt(frame).implementation(name);
          if (member?.kind !== 'method')
            return frame.runtime.noSuchMethod(frame.receiver, name, 'method', { positional: [], named: undefined });
          const evaluated = bound.args(frame);
          return (member.impl as Callable)(frame.runtime, frame.receiver, evaluated, bound.typeArgs(frame), row);
        },
        isConst: false,
        completes,
      };
    }
    let cachedClass: ClassInfo | undefined;
    let cachedMember: Member | undefined;
    const constFold = this.foldConstantCall(receiver, name, args);
    return {
      type: returnType,
      run: (frame) => {
        const value = receiverRun(frame);
        if (value === SHORTED || (nullAware && value === undefined)) return SHORTED;
        frame.temporaries.push(value);
        let evaluated: Arguments;
        try {
          evaluated = bound.args(frame);
        } finally {
          frame.temporaries.pop();
        }
        const { runtime } = frame;
        const cls = runtime.classOf(value);
        if (cls !== cachedClass) {
          cachedClass = cls;
          cachedMember = cls.implementation(name);
        }
        const member = cachedMember;
        if (name === 'call' && value instanceof DartClosure)
          return value.call(runtime, value.receiver, evaluated, bound.typeArgs(frame), row);
        if (member?.kind === 'method')
          return (member.impl as Callable)(runtime, value, evaluated, bound.typeArgs(frame), row);
        if (member)
          return runtime.callValue(runtime.readMember(value, member, row), evaluated, bound.typeArgs(frame), row);
        return runtime.noSuchMethod(value, name, 'method', evaluated);
      },
      isConst: constFold !== undefined,
      constValue: constFold,
      completes,
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

  /** A call of a method on a constant that Dart folds, such as `'abc'.length` (only getters fold in Dart). */
  private foldConstantCall(receiver: Compiled, name: string, args: ArgumentsSyntax): { value: Value } | undefined {
    void receiver;
    void name;
    void args;
    return undefined;
  }

  private dynamicCall(
    receiver: Compiled,
    name: string | undefined,
    args: ArgumentsSyntax,
    span: Span,
    nullAware = false
  ): Compiled {
    const positional = args.positional.map((argument) => this.compileExpression(argument));
    const named = args.named.map((argument) => ({
      name: argument.name,
      compiled: this.compileExpression(argument.value),
    }));
    for (const compiled of [...positional, ...named.map((argument) => argument.compiled)]) {
      if (compiled.type.kind === 'void') this.error(span, 'void の値は引数に渡せません。');
    }
    const evaluate = this.argumentEvaluator(
      args,
      positional.map((compiled) => compiled.run),
      named.map((argument) => ({ name: argument.name, run: argument.compiled.run })),
      true
    );
    const receiverRun = receiver.run;
    const row = this.callRow(span);
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
        if (name === undefined) return frame.runtime.callValue(value, evaluated, [], row);
        return frame.runtime.invoke(value, name, evaluated, [], row);
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
    const bound = this.bindArguments(member.type, args, typeArguments, span, context);
    const row = this.callRow(span);
    const method = member;
    return {
      type: bound.returnType,
      run: (frame) =>
        (method.impl as Callable)(frame.runtime, undefined, bound.args(frame), bound.typeArgs(frame), row),
      isConst: false,
      completes: !isNeverType(bound.returnType),
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
      isConst: identical && args.positional.every((argument) => this.isConstantSyntax(argument)),
      completes: !isNeverType(bound.returnType),
    };
  }

  /** Whether an expression would compile to a constant, used where only the syntax is at hand. */
  protected isConstantSyntax(expression: Expression): boolean {
    return ['int', 'double', 'string', 'bool', 'null'].includes(expression.kind);
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
    let declaration =
      typeSyntax.prefix === undefined
        ? this.library.lookup(typeSyntax.name)
        : this.library.lookupPrefixed(typeSyntax.prefix, typeSyntax.name);
    if (typeSyntax.ambiguousPrefix && !this.library.hasPrefix(typeSyntax.prefix ?? '')) {
      declaration = this.library.lookup(typeSyntax.name);
    } else if (typeSyntax.ambiguousPrefix && typeSyntax.prefix && this.library.hasPrefix(typeSyntax.prefix)) {
      declaration = this.library.lookupPrefixed(typeSyntax.prefix, constructorName ?? '');
      constructorName = undefined;
    }
    let cls: ClassInfo | undefined;
    let aliasArgs: DartType[] | undefined;
    if (declaration?.kind === 'class') cls = declaration.cls;
    else if (declaration?.kind === 'alias' && declaration.alias.aliased?.kind === 'interface') {
      cls = declaration.alias.aliased.cls;
      if (declaration.alias.typeParams.length === 0) aliasArgs = [...declaration.alias.aliased.args];
    }
    if (!cls) return this.error(expression, `クラス ${typeSyntax.name} が見つかりません。`);
    const typeArgs =
      typeSyntax.args.length > 0 ? this.typeArgumentsFor(cls.typeParams, typeSyntax, cls.name) : aliasArgs;
    return this.compileConstructorCall(
      cls,
      constructorName,
      typeArgs,
      expression.arguments,
      undefined,
      expression,
      context,
      expression.isConst
    );
  }

  /**
   * Calls a constructor of a class, inferring the class's type arguments from the context and the arguments when they
   * are not written.
   */
  // code-gauge-allow functionCognitiveComplexity 30 -- Checks of what may be constructed.
  compileConstructorCall(
    cls: ClassInfo,
    name: string | undefined,
    typeArgs: DartType[] | undefined,
    args: ArgumentsSyntax,
    methodTypeArguments: TypeSyntax[] | undefined,
    span: Span,
    context: DartType | undefined,
    isConstSyntax: boolean
  ): Compiled {
    if (methodTypeArguments) this.error(span, 'コンストラクタには、型引数をこの位置には書けません。');
    const constructor = cls.constructors.get(name ?? '');
    if (!constructor) {
      if (cls.kind === 'enum') return this.error(span, '列挙型のオブジェクトは作れません。');
      if (name) return this.error(span, `クラス ${cls.name} に ${name} というコンストラクタはありません。`);
      return this.error(span, `クラス ${cls.name} には、名前のないコンストラクタがありません。`);
    }
    if (constructor.kind === 'generative' && cls.isAbstract) {
      this.error(span, `抽象クラス ${cls.name} のオブジェクトは作れません。`);
    }
    if (cls.kind === 'mixin') this.error(span, `mixin ${cls.name} のオブジェクトは作れません。`);
    const isConst = isConstSyntax || (this.inConstContext && constructor.isConst);
    if (isConstSyntax && !constructor.isConst) {
      this.error(span, `${cls.name}${name ? `.${name}` : ''} は const のコンストラクタではありません。`);
    }
    // The constructor's parameters use the class's type parameters, which the call instantiates.
    const generic: FunctionType = { ...constructor.type, typeParams: typeArgs ? [] : cls.typeParams };
    const signature = typeArgs
      ? (substitute(
          { ...constructor.type, typeParams: [] },
          new Map(cls.typeParams.map((param, index) => [param, typeArgs[index]]))
        ) as FunctionType)
      : generic;
    const bound = this.withConstContext(isConst, () => this.bindArguments(signature, args, undefined, span, context));
    if (isConst && !this.argumentsAreConst)
      this.error(span, 'const のコンストラクタ呼び出しの引数は、定数でなければなりません。');
    const resolvedArgs = typeArgs ?? bound.staticTypeArgs;
    const type = interfaceType(cls, resolvedArgs);
    const runtimeArgs = this.runtimeTypes(resolvedArgs);
    const run = this.constructObject(cls, constructor, runtimeArgs, bound.args, span, isConst);
    return { type, run, isConst, creates: true };
  }

  /** Whether every argument of the call just bound was a constant expression. */
  protected argumentsAreConst = true;

  /** Evaluates a list of types at runtime, replacing type parameters in scope. */
  protected runtimeTypes(types: readonly DartType[]): (frame: Frame) => DartType[] {
    if (types.length === 0) return () => [];
    const resolvers = types.map((type) => this.runtimeType(type));
    if (!types.some((type) => mentionsTypeParams(type))) {
      const fixed = [...types];
      return () => fixed;
    }
    return (frame) => resolvers.map((resolve) => resolve(frame));
  }

  // Arguments

  /**
   * Checks a call's arguments against a function type and infers the function's own type arguments when they are
   * not written: first from the context of the call, then from the arguments that are not function literals, and then
   * from function literals, whose parameters take the types inferred so far.
   */
  // code-gauge-allow functionCognitiveComplexity 50 -- The steps of Dart's type inference for a call.
  bindArguments(
    type: FunctionType,
    args: ArgumentsSyntax,
    typeArguments: TypeSyntax[] | undefined,
    span: Span,
    context: DartType | undefined,
    resolved?: ResolvedMember
  ): BoundCall {
    void resolved;
    this.checkArity(type, args, span);
    let signature = type;
    let staticTypeArgs: DartType[] = [];
    const params = new Set(type.typeParams);
    const compiledPositional: (Compiled | undefined)[] = Array.from({ length: args.positional.length });
    const compiledNamed: (Compiled | undefined)[] = Array.from({ length: args.named.length });
    let allConst = true;
    if (type.typeParams.length > 0 && typeArguments) {
      if (typeArguments.length !== type.typeParams.length) {
        this.error(span, `型引数は ${type.typeParams.length} 個ですが、${typeArguments.length} 個書かれています。`);
      }
      staticTypeArgs = typeArguments.map((argument) => this.resolveType(argument));
      this.checkBounds(type.typeParams, staticTypeArgs, span);
      signature = instantiateFunction(type, staticTypeArgs);
    } else if (type.typeParams.length > 0) {
      const fromContext = new Map<TypeParam, DartType>();
      if (context && !isInferenceHole(context) && !isTop(context)) {
        inferFromContext(context, type.returnType, params, fromContext);
      }
      const solution = new Map<TypeParam, DartType>();
      // Arguments other than function literals see only what the context gave; function literals, compiled after
      // them, also see what those arguments gave.
      let closurePass = false;
      const contextFor = (parameterType: DartType): DartType => {
        const map = new Map<TypeParam, DartType>();
        for (const param of type.typeParams) {
          map.set(param, (closurePass ? solution.get(param) : undefined) ?? fromContext.get(param) ?? INFERENCE_HOLE);
        }
        return substitute(parameterType, map);
      };
      for (const pass of [false, true]) {
        closurePass = pass;
        for (const [index, argument] of args.positional.entries()) {
          if (isClosure(argument) !== pass) continue;
          const parameterType = type.positional[index] ?? DYNAMIC;
          const compiled = this.compileExpression(argument, contextFor(parameterType));
          compiledPositional[index] = compiled;
          inferFromSubtype(compiled.type, parameterType, params, solution, upperBound);
        }
        for (const [index, argument] of args.named.entries()) {
          if (isClosure(argument.value) !== pass) continue;
          const parameterType = type.named.find((named) => named.name === argument.name)?.type ?? DYNAMIC;
          const compiled = this.compileExpression(argument.value, contextFor(parameterType));
          compiledNamed[index] = compiled;
          inferFromSubtype(compiled.type, parameterType, params, solution, upperBound);
        }
      }
      const defaults = instantiateToBounds(type.typeParams);
      // The context wins over the arguments when they fit it, as `List<num> l = List.filled(3, 0)` makes a List<num>.
      staticTypeArgs = type.typeParams.map((param, index) => {
        const fromArguments = solution.get(param);
        const contextual = fromContext.get(param);
        if (
          contextual &&
          !isInferenceHole(contextual) &&
          (!fromArguments || isSubtype(fromArguments, contextual)) &&
          !mentionsTypeParams(contextual, params)
        ) {
          return contextual;
        }
        if (fromArguments && !isInferenceHole(fromArguments)) return fromArguments;
        if (contextual && !isInferenceHole(contextual)) return contextual;
        return defaults[index];
      });
      // A solution outside its bound moves up to the nearest supertype within it (an F-bounded `T extends
      // Comparable<T>` takes num for ints), and otherwise to the bound, which then fails the argument check.
      staticTypeArgs = staticTypeArgs.map((argument, index) => {
        const param = type.typeParams[index];
        if (!param.bound) return argument;
        const boundFor = (candidate: DartType): DartType =>
          substitute(
            param.bound as DartType,
            new Map(type.typeParams.map((other, at) => [other, at === index ? candidate : staticTypeArgs[at]]))
          );
        if (isSubtype(argument, boundFor(argument))) return argument;
        if (argument.kind === 'interface') {
          for (const supertype of supertypesOf(argument))
            if (isSubtype(supertype, boundFor(supertype))) return supertype;
        }
        return boundFor(argument);
      });
      signature = instantiateFunction(type, staticTypeArgs);
    }
    const positionalRuns: Eval[] = [];
    for (const [index, argument] of args.positional.entries()) {
      const parameterType = signature.positional[index] ?? DYNAMIC;
      const compiled = compiledPositional[index] ?? this.compileExpression(argument, parameterType);
      this.argumentTypes.set(argument, compiled.type);
      if (compiled.type.kind === 'void' && parameterType.kind !== 'void' && parameterType.kind !== 'dynamic') {
        this.error(argument, 'void の値は引数に渡せません。');
      }
      allConst &&= compiled.isConst;
      positionalRuns.push(
        this.coerce(compiled, parameterType, argument, (from, to) => `${from} 型の値は、${to} 型の引数に渡せません。`)
          .run
      );
    }
    const namedRuns: { name: string; run: Eval }[] = [];
    for (const [index, argument] of args.named.entries()) {
      const parameterType = signature.named.find((named) => named.name === argument.name)?.type ?? DYNAMIC;
      const compiled = compiledNamed[index] ?? this.compileExpression(argument.value, parameterType);
      allConst &&= compiled.isConst;
      namedRuns.push({
        name: argument.name,
        run: this.coerce(
          compiled,
          parameterType,
          argument.value,
          (from, to) => `${from} 型の値は、${to} 型の引数 ${argument.name} に渡せません。`
        ).run,
      });
    }
    this.argumentsAreConst = allConst;
    const typeArgsAtRuntime = this.runtimeTypes(staticTypeArgs);
    return {
      returnType: signature.returnType,
      args: this.argumentEvaluator(args, positionalRuns, namedRuns, false),
      typeArgs: typeArgsAtRuntime,
      staticTypeArgs,
    };
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
      if (seen.has(argument.name)) this.error(argument, `名前付き引数 ${argument.name} が重複しています。`);
      seen.add(argument.name);
      if (!type.named.some((named) => named.name === argument.name)) {
        this.error(argument, `名前付き引数 ${argument.name} はありません。`);
      }
    }
    for (const named of type.named) {
      if (named.isRequired && !seen.has(named.name)) {
        this.error(span, `名前付き引数 ${named.name} は必須ですが、渡されていません。`);
      }
    }
  }

  /** Evaluates arguments in source order, keeping those evaluated so far reachable while the rest evaluate. */
  protected argumentEvaluator(
    args: ArgumentsSyntax,
    positional: Eval[],
    named: { name: string; run: Eval }[],
    isDynamic: boolean
  ): (frame: Frame) => Arguments {
    if (args.order.length === 0) return () => ({ positional: [], named: undefined, isDynamic });
    if (named.length === 0) {
      if (positional.length === 1) {
        const [run] = positional;
        return (frame) => ({ positional: [run(frame)], named: undefined, isDynamic });
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
        return { positional: values, named: undefined, isDynamic };
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
      return { positional: values, named: namedValues, isDynamic };
    };
  }

  // Closures

  // code-gauge-allow functionCognitiveComplexity 30 -- Inference of a function literal's types from its context.
  compileFunctionExpression(
    expression: Extract<Expression, { kind: 'function' }>,
    context: DartType | undefined
  ): Compiled {
    const contextType = context ? resolveBound(context) : undefined;
    const contextFunction =
      contextType?.kind === 'function' && expression.typeParameters.length === 0 ? contextType : undefined;
    const typeParams = this.declareTypeParams(expression.typeParameters);
    return this.withTypeParams(typeParams, () => {
      const { parameters } = expression;
      const positionalTypes = parameters.positional.map((parameter, index) => {
        if (parameter.type) return this.resolveType(parameter.type);
        const fromContext = contextFunction?.positional[index];
        return fromContext && !isInferenceHole(fromContext) ? fromContext : DYNAMIC;
      });
      const namedTypes = new Map(
        parameters.named.map((parameter) => {
          if (parameter.type) return [parameter.name, this.resolveType(parameter.type)];
          const fromContext = contextFunction?.named.find((named) => named.name === parameter.name)?.type;
          return [parameter.name, fromContext && !isInferenceHole(fromContext) ? fromContext : DYNAMIC];
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
          name: parameter.name,
          type: namedTypes.get(parameter.name) ?? DYNAMIC,
          isRequired: parameter.isRequired,
        })),
        typeParams,
      });
      return { type, run: this.closureCreator(compiled, type), isConst: false };
    });
  }

  /** Creates a closure at runtime, capturing the cells of the variables its body uses. */
  protected closureCreator(compiled: CompiledFunction, type: FunctionType): Eval {
    const { fn } = compiled;
    const parent = this.fn;
    const sources = fn.captures.map((variable) => {
      if (variable.owner === parent) return { local: variable.slot, captured: -1 };
      return { local: -1, captured: parent.captures.indexOf(variable) };
    });
    const resolveType = this.runtimeType(type);
    const ownParams = type.typeParams;
    return (frame) => {
      const captured: Cell[] = sources.map(({ local, captured: index }) =>
        local >= 0 ? (frame.locals[local] as Cell) : frame.captured[index]
      );
      const outerEnv = frame.typeEnv;
      const receiver = frame.receiver;
      const callable: Callable = (runtime, _receiver, args, typeArgs, callRow) => {
        let typeEnv = outerEnv;
        if (ownParams.length > 0) {
          const env = new Map(outerEnv);
          for (const [index, param] of ownParams.entries()) env.set(param, typeArgs[index] ?? DYNAMIC);
          typeEnv = env;
        }
        return this.runFunction(compiled, runtime, receiver, captured, typeEnv, args, callRow ?? runtime.userCallRow);
      };
      return new DartClosure(
        coreTypes.function,
        resolveType(frame) as FunctionType,
        callable,
        undefined,
        captured,
        { name: undefined, origin: undefined },
        undefined
      );
    };
  }

  /** Runs a compiled function in a new frame. */
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
      compiled.bind(frame, args);
      return compiled.run(frame);
    } finally {
      runtime.exit(frame);
    }
  }

  // Tear-offs and shorthands

  compileConstructorTearoff(type: TypeSyntax, name: string | undefined, span: Span): Compiled {
    if (type.kind !== 'named') return this.error(span, 'クラスの名前を書いてください。');
    const declaration = type.prefix
      ? this.library.lookupPrefixed(type.prefix, type.name)
      : this.library.lookup(type.name);
    if (declaration?.kind !== 'class') return this.error(span, `クラス ${type.name} が見つかりません。`);
    const { cls } = declaration;
    const constructor = cls.constructors.get(name ?? '');
    if (!constructor)
      return this.error(span, `クラス ${cls.name} に ${name ?? '名前のない'} コンストラクタはありません。`);
    if (constructor.kind === 'generative' && cls.isAbstract)
      this.error(span, `抽象クラス ${cls.name} のコンストラクタは取り出せません。`);
    const typeArgs = type.args.length > 0 ? this.typeArgumentsFor(cls.typeParams, type, cls.name) : undefined;
    const signature: FunctionType = typeArgs
      ? (substitute(
          { ...constructor.type, typeParams: [] },
          new Map(cls.typeParams.map((param, index) => [param, typeArgs[index]]))
        ) as FunctionType)
      : { ...constructor.type, typeParams: cls.typeParams };
    const fixedArgs = typeArgs ? this.runtimeTypes(typeArgs) : undefined;
    return {
      type: signature,
      run: (frame) => {
        const resolvedFixed = fixedArgs?.(frame);
        const callable: Callable = (runtime, _receiver, args, callTypeArgs, callRow) => {
          const construct = this.constructObject(
            cls,
            constructor,
            () => resolvedFixed ?? [...callTypeArgs],
            () => args,
            span,
            false
          );
          return construct(new FrameClass(runtime, frame.info, 0, undefined, [], frame.typeEnv, callRow));
        };
        return new DartClosure(
          coreTypes.function,
          signature,
          callable,
          undefined,
          [],
          { name: cls.name, origin: undefined },
          constructor
        );
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

function isClosure(expression: Expression): boolean {
  return expression.kind === 'function';
}

function isNeverType(type: DartType): boolean {
  return type.kind === 'never' && !type.nullable;
}

import { Frame as FrameClass } from './runtime';

export { boundOf, NEVER, NULL, typeParamType, VOID };
