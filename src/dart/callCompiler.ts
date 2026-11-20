// code-gauge-allow-file fileNcss 650 -- One compiler phase per file; splitting it further would scatter the cases of one construct.
import type {
  Arguments as ArgumentsSyntax,
  Expression,
  FormalParameter,
  FormalParameters,
  FunctionBody,
  Span,
  TypeSyntax,
} from './ast';
import type { ClassInfo, ConstructorInfo, Member } from './classes';
import { at, type Compiled, type Eval, type ResolvedMember, typeName } from './compilerBase';
import type { ExtensionInfo, TopLevelFunction, TypeAlias } from './environment';
import { INFERENCE_HOLE, isInferenceHole, SHORTED } from './expressionCompiler';
import { OperatorCompiler } from './operatorCompiler';
import type { Frame, Runtime, TypeEnv } from './runtime';
import type { FunctionContext } from './scope';
import { inferFromContext, inferFromSubtype } from './typeInference';
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
  defaults?: Map<FormalParameter, Compiled>;
  isSetter?: boolean;
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

  /** `E(x)`, which applies the extension E to x explicitly. */
  private compileExtensionOverride(
    ext: ExtensionInfo,
    args: ArgumentsSyntax,
    typeArguments: TypeSyntax[] | undefined,
    span: Span
  ): Compiled {
    if (args.positional.length !== 1 || args.named.length > 0)
      this.error(span, `拡張 ${ext.name ?? ''} を明示して使うときは、値を 1 つだけ書いてください。`);
    const value = this.compileExpression(args.positional[0], ext.typeParams.length === 0 ? ext.onType : undefined);
    const typeArgs = typeArguments
      ? typeArguments.map((argument) => this.resolveType(argument))
      : this.matchExtension(ext, value.type);
    if (!typeArgs) return this.error(span, `${typeName(value.type)} 型の値には、拡張 ${ext.name ?? ''} は使えません。`);
    return { ...value, extensionOverride: { ext, typeArgs }, variable: undefined };
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
  // code-gauge-allow functionNcss 35 -- Methods, getters, extensions, records, and dynamic receivers.
  // code-gauge-allow functionParameterCount 8 -- Methods, getters, extensions, records, and dynamic receivers.
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
      return this.dynamicCall(receiver, name, args, span, nullAware, typeArguments);
    }
    const lookupType = nullAware ? nonNullable(receiverType) : receiverType;
    const resolved = this.memberFor(receiver, lookupType, name, span);
    if (!resolved) {
      this.checkUnavailableIoMember(lookupType, name, span);
      return this.error(span, `${typeName(nonNullable(receiverType))} 型には ${name} というメソッドがありません。`);
    }
    if (!nullAware && isNullable(receiverType) && !this.acceptsNull(resolved) && receiverType.kind !== 'null') {
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
      const run = extensionMethodCall(
        receiverRun,
        resolved.member,
        this.runtimeTypes(resolved.extension.typeArgs),
        bound,
        nullAware,
        row
      );
      return { type: returnType, run, isConst: false, completes };
    }
    if (isSuper) {
      this.requireSuperImplementation(name, span);
      const run = superMethodCall(this.superclassOf(span).classAt, name, bound, row);
      return { type: returnType, run, isConst: false, completes };
    }
    const constFold = this.foldConstantCall(receiver, name, args);
    return {
      type: returnType,
      run: virtualMethodCall(receiverRun, name, bound, nullAware, row),
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
    nullAware = false,
    typeArguments: TypeSyntax[] = []
  ): Compiled {
    const typeArgs = typeArguments.map((argument) => this.runtimeType(this.resolveType(argument)));
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
        const types = typeArgs.map((resolve) => resolve(frame));
        if (name === undefined) return frame.runtime.callValue(value, evaluated, types, row);
        return frame.runtime.invoke(value, name, evaluated, types, row);
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
    const declaration = prefix === undefined ? this.library.lookup(name) : this.library.lookupPrefixed(prefix, name);
    const writtenTypes = typeSyntax.args.length > 0 ? typeSyntax.args : undefined;
    const target =
      declaration?.kind === 'alias'
        ? this.aliasConstructor(declaration.alias, writtenTypes, expression, expression.isSelectorCall)
        : declaration?.kind === 'class'
          ? { cls: declaration.cls, types: this.classTypeArguments(declaration.cls, writtenTypes, expression) }
          : undefined;
    if (!target) return this.error(expression, 'クラス ' + name + ' が見つかりません。');
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
    if (isConst && !this.argumentsAreConst)
      this.error(span, 'const のコンストラクタ呼び出しの引数は、定数でなければなりません。');
    const resolvedArgs = constructorArguments(typeArgs, bound.staticTypeArgs);
    const nullable = typeArgs !== undefined && !Array.isArray(typeArgs) && typeArgs.nullableResult;
    const type = interfaceType(cls, resolvedArgs, nullable);
    const runtimeArgs = this.runtimeTypes(resolvedArgs);
    const run = this.constructObject(cls, constructor, runtimeArgs, bound.args, span, isConst);
    return { type, run, isConst, creates: true };
  }

  /** Whether every argument of the call just bound was a constant expression. */
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

  protected argumentsAreConst = true;

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
    context: DartType | undefined,
    resolved?: ResolvedMember
  ): BoundCall {
    void resolved;
    this.checkArity(type, args, span);
    const compiled: CompiledArguments = {
      positional: Array.from({ length: args.positional.length }),
      named: Array.from({ length: args.named.length }),
    };
    let staticTypeArgs: DartType[] = [];
    let signature = type;
    if (typeArguments) staticTypeArgs = this.explicitTypeArguments(type, typeArguments, span);
    if (type.typeParams.length > 0) {
      if (!typeArguments) staticTypeArgs = this.inferTypeArguments(type, args, context, compiled);
      signature = instantiateFunction(type, staticTypeArgs);
    }
    const { positionalRuns, namedRuns } = this.compileArgumentRuns(signature, args, compiled);
    return {
      returnType: signature.returnType,
      args: this.argumentEvaluator(args, positionalRuns, namedRuns, false),
      typeArgs: this.runtimeTypes(staticTypeArgs),
      staticTypeArgs,
    };
  }

  private explicitTypeArguments(type: FunctionType, typeArguments: TypeSyntax[], span: Span): DartType[] {
    if (typeArguments.length !== type.typeParams.length) {
      this.error(span, `型引数は ${type.typeParams.length} 個ですが、${typeArguments.length} 個書かれています。`);
    }
    const typeArgs = typeArguments.map((argument) => this.resolveType(argument));
    this.checkBounds(type.typeParams, typeArgs, span);
    return typeArgs;
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
    compiled: CompiledArguments
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
    for (const closurePass of [false, true]) {
      const infer = (argument: Expression, parameterType: DartType): Compiled => {
        const result = this.compileExpression(argument, argumentContext(parameterType, closurePass));
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
        return result;
      };
      for (const [index, argument] of args.positional.entries()) {
        if (isClosure(argument) === closurePass)
          compiled.positional[index] = infer(argument, type.positional[index] ?? DYNAMIC);
      }
      for (const [index, argument] of args.named.entries()) {
        if (isClosure(argument.value) !== closurePass) continue;
        const parameterType = type.named.find((named) => named.name === argument.name)?.type ?? DYNAMIC;
        compiled.named[index] = infer(argument.value, parameterType);
      }
    }
    for (const { result, parameterType } of tearOffs) {
      const instantiated = this.instantiateGeneric(result, argumentContext(parameterType, true), true);
      if (instantiated) inferFromSubtype(instantiated.type, parameterType, params, solution, upperBound, upper);
    }
    return fitToBounds(type, chooseTypeArguments(type, params, solution, upper, fromContext));
  }

  private compileArgumentRuns(
    signature: FunctionType,
    args: ArgumentsSyntax,
    compiled: CompiledArguments
  ): { positionalRuns: Eval[]; namedRuns: { name: string; run: Eval }[] } {
    let allConst = true;
    const positionalRuns: Eval[] = [];
    for (const [index, argument] of args.positional.entries()) {
      const parameterType = signature.positional[index] ?? DYNAMIC;
      const value = compiled.positional[index] ?? this.compileExpression(argument, parameterType);
      this.argumentTypes.set(argument, value.type);
      if (value.type.kind === 'void' && parameterType.kind !== 'void' && parameterType.kind !== 'dynamic') {
        this.error(argument, 'void の値は引数に渡せません。');
      }
      allConst &&= value.isConst;
      positionalRuns.push(
        this.coerce(value, parameterType, argument, (from, to) => `${from} 型の値は、${to} 型の引数に渡せません。`).run
      );
    }
    const namedRuns: { name: string; run: Eval }[] = [];
    for (const [index, argument] of args.named.entries()) {
      const parameterType = signature.named.find((named) => named.name === argument.name)?.type ?? DYNAMIC;
      const value = compiled.named[index] ?? this.compileExpression(argument.value, parameterType);
      allConst &&= value.isConst;
      namedRuns.push({
        name: argument.name,
        run: this.coerce(
          value,
          parameterType,
          argument.value,
          (from, to) => `${from} 型の値は、${to} 型の引数 ${argument.name} に渡せません。`
        ).run,
      });
    }
    this.argumentsAreConst = allConst;
    return { positionalRuns, namedRuns };
  }

  private checkArity(type: FunctionType, args: ArgumentsSyntax, span: Span): void {
    const count = args.positional.length;
    if (count < type.requiredCount) {
      this.error(span, `位置で渡す引数が足りません。${type.requiredCount} 個必要ですが、${count} 個です。`);
    }
    if (count > type.positional.length) {
      this.error(span, `位置で渡す引数が多すぎます。${type.positional.length} 個までですが、${count} 個です。`);
    }
    const seen = new Set(args.named.map((argument) => argument.name));
    for (const argument of args.named) {
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
  // code-gauge-allow functionNcss 35 -- One case per form of the construct, which reads best together.
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

  // code-gauge-allow functionCognitiveComplexity 20 -- Inference of a function literal's types from its context.
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
    const { qualifiedName } = fn;
    return (frame) => {
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
    const writtenTypes = type.args.length > 0 ? type.args : undefined;
    const target =
      declaration?.kind === 'alias'
        ? this.aliasConstructor(declaration.alias, writtenTypes, span)
        : declaration?.kind === 'class'
          ? { cls: declaration.cls, types: this.classTypeArguments(declaration.cls, writtenTypes, span) }
          : undefined;
    if (!target) return this.error(span, 'クラス ' + type.name + ' が見つかりません。');
    const { cls, types: typeArgs } = target;
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

function isClosure(expression: Expression): boolean {
  return expression.kind === 'function';
}

function isNeverType(type: DartType): boolean {
  return type.kind === 'never' && !type.nullable;
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

/** `super.m(...)`, which runs the superclass's implementation on this. */
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

function superMethodCall(
  classAt: (frame: Frame) => ClassInfo,
  name: string,
  bound: BoundCall,
  row: number | undefined
): Eval {
  return (frame) => {
    const member = classAt(frame).implementation(name);
    if (member?.kind !== 'method')
      return frame.runtime.noSuchMethod(frame.receiver, name, 'method', { positional: [], named: undefined });
    const evaluated = bound.args(frame);
    return (member.impl as Callable)(frame.runtime, frame.receiver, evaluated, bound.typeArgs(frame), row);
  };
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
      cachedMember = cls.implementation(name);
    }
    const member = cachedMember;
    if (name === 'call' && value instanceof DartClosure)
      return value.call(runtime, value.receiver, evaluated, bound.typeArgs(frame), row);
    if (member?.kind === 'method')
      return (member.impl as Callable)(runtime, value, evaluated, bound.typeArgs(frame), row);
    if (member) return runtime.callGetterValue(value, member, evaluated, bound.typeArgs(frame), row);
    return runtime.noSuchMethod(value, name, 'method', evaluated);
  };
}

/** The arguments compiled while inferring type arguments, which are not compiled again. */
interface CompiledArguments {
  positional: (Compiled | undefined)[];
  named: (Compiled | undefined)[];
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
