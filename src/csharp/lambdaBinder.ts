import type { SourceDiagnostic } from '../interpreter/diagnostics';
import { AnonymousDelegates, hasDefault } from './anonymousDelegates';
import type { Block, Expression, LambdaParameter } from './ast';
import type { BoundBlock, BoundExpression, LambdaInfo } from './bound';
import type { ArgumentInfo } from './callBinder';
import type { BindContext } from './convertBinder';
import { FlowAnalyzer } from './flow';
import { MemberBinder, type NonValue } from './memberBinder';
import { paramsCollectionOf } from './paramsCollections';
import { TRANSPARENT_PREFIX } from './queries';
import { FunctionScope, LocalScope } from './scopes';
import { markSuspends } from './suspension';
import {
  type AsyncShape,
  displayType,
  ERROR_TYPE,
  LocalSymbol,
  MethodSymbol,
  type NamedType,
  namedType,
  type ParameterSymbol,
  refKeyword,
  sameType,
  substitute,
  type Type,
  typeKey,
  VOID_TYPE,
} from './types';

type Unbound = Extract<BoundExpression, { kind: 'unbound' }>;
type LambdaExpression = Extract<Expression, { kind: 'lambda' }>;

/** Binds lambdas to delegate types, and infers what they and method groups give the overload resolution. */
export abstract class LambdaBinder extends MemberBinder {
  /** Binds a block that forms a function's body, such as a lambda's. */
  protected abstract bindFunctionBlock(block: Block, context: BindContext): BoundBlock;

  protected abstract bestCommonType(expressions: BoundExpression[]): Type | undefined;

  /** Whether the expression being bound may be a `throw` expression, as `??` and `?:` operands and lambda bodies may. */
  protected allowsThrowExpression = false;

  /**
   * How many lambda bindings that only try a delegate type enclose the code being bound, whose diagnostics are thrown
   * away, so the local functions declared there report none of their own either.
   */
  protected trialLambdaDepth = 0;

  private readonly lambdaCache = new Map<
    Expression,
    Map<string, { result: BoundExpression | undefined; diagnostics: SourceDiagnostic[]; returnType: Type | undefined }>
  >();

  /** Binds a parameter's default value, which must be a constant, `default`, or `new S()` of a value type. */
  protected abstract bindParameterDefault(parameter: ParameterSymbol, type: Type, scope?: BindContext): BoundExpression;

  private readonly anonymousDelegates = new AnonymousDelegates(() => this.wellKnown.multicastDelegate);

  protected naturalTypeOf(expression: Unbound): Type | undefined {
    const node = expression.node;
    if (expression.methodGroup)
      return this.naturalTypeOfGroup(expression.methodGroup as Extract<NonValue, { kind: 'methodGroup' }>);
    if (node.kind === 'lambda') {
      if (node.omitsParameters || node.parameters.some((parameter) => !parameter.type)) return undefined;
      const context = expression.context as BindContext;
      const parameters = node.parameters.map((parameter) => this.lambdaParameterSymbol(parameter, context));
      const parameterTypes = parameters.map((parameter) => parameter.type);
      // `ref int () => ref x` returns by reference, which only a delegate type of the compiler's does.
      const byRef = { returnsByRef: undefined as 'ref' | 'readonly' | undefined };
      const declaredReturn = node.returnType
        ? this.resolveReturnType(node.returnType, context.fn.typeContext, byRef)
        : undefined;
      const returnType =
        declaredReturn ?? this.bindLambda(node, context, undefined, parameterTypes, undefined, false).returnType;
      if (!returnType) return undefined;
      const isScoped = node.parameters.some((parameter) => parameter.isScoped);
      return this.delegateTypeOf(parameters, returnType, isScoped, byRef.returnsByRef);
    }
    return undefined;
  }

  /** A lambda's explicitly typed parameter as a delegate's, with its default value bound without reporting errors. */
  private lambdaParameterSymbol(parameter: LambdaParameter, context: BindContext): ParameterSymbol {
    const symbol: ParameterSymbol = {
      name: parameter.name,
      type: this.resolveType(parameter.type as NonNullable<LambdaParameter['type']>, context.fn.typeContext),
      refKind: parameter.modifier,
      ...(parameter.isRefReadonly ? { isRefReadonly: true } : {}),
      isParams: parameter.isParams === true,
      position: parameter,
    };
    if (parameter.defaultValue) {
      symbol.defaultSyntax = parameter.defaultValue;
      symbol.defaultContext = context.fn.typeContext;
      this.quietly(() => this.bindParameterDefault(symbol, symbol.type, context));
    }
    return symbol;
  }

  /**
   * The natural delegate type of parameters and a return type: `Func` or `Action`, or else a delegate type the compiler
   * makes, for parameters passed by reference, `params` parameters, default values, and `scoped` parameters.
   */
  private delegateTypeOf(
    parameters: ParameterSymbol[],
    returnType: Type,
    isScoped: boolean,
    returnsByRef?: 'ref' | 'readonly'
  ): NamedType | undefined {
    const plain = parameters.every((parameter) => !parameter.refKind && !parameter.isParams && !hasDefault(parameter));
    if (plain && !isScoped && !returnsByRef)
      return this.functionTypeOf(
        parameters.map((parameter) => parameter.type),
        returnType
      );
    return this.anonymousDelegates.typeOf(parameters, returnType, isScoped, returnsByRef);
  }

  /** The natural type of a method group of one method, whose type arguments, if any, it must not need inferred. */
  private naturalTypeOfGroup(group: Extract<NonValue, { kind: 'methodGroup' }>): Type | undefined {
    if (group.candidates.length !== 1) return undefined;
    const [candidate] = group.candidates;
    const { method } = candidate;
    // A static member of a generic extension block takes the block's type arguments from the type it is accessed
    // through (`List<int>.Create`).
    const typeArgs =
      method.typeParameters.length === 0
        ? []
        : candidate.staticReceiver && !group.typeArgs
          ? this.inferTypeArguments(candidate, [], [], false)
          : undefined;
    if (!typeArgs) return undefined;
    const substitution = this.callSubstitution(candidate, typeArgs);
    const parameters = method.parameters.map((parameter) => ({
      ...parameter,
      type: substitute(parameter.type, substitution),
    }));
    return this.delegateTypeOf(parameters, substitute(method.returnType, substitution), false, method.returnsByRef);
  }

  /** The `Func` or `Action` type of parameter and return types, the natural type of lambdas and method groups. */
  protected functionTypeOf(parameterTypes: Type[], returnType: Type): NamedType | undefined {
    const isAction = returnType.kind === 'void';
    const arity = parameterTypes.length + (isAction ? 0 : 1);
    if (parameterTypes.length > 6) return undefined;
    const symbol = this.library.typeNamed(`System.${isAction ? 'Action' : 'Func'}`, arity);
    return namedType(symbol, isAction ? parameterTypes : [...parameterTypes, returnType]);
  }

  protected inferReturnType(expression: Unbound, parameterTypes: Type[]): Type | undefined {
    if (expression.methodGroup) {
      const group = expression.methodGroup as Extract<NonValue, { kind: 'methodGroup' }>;
      const args: ArgumentInfo[] = parameterTypes.map((type) => ({
        expression: { kind: 'default', type, row: expression.row },
        name: undefined,
        refKind: undefined,
        row: expression.row,
        target: undefined,
      }));
      const saved = this.diagnostics.length;
      const resolved = this.resolveCall(group.candidates, args, group.typeArgs, expression.row, {
        name: group.name,
        kind: 'method',
      });
      this.diagnostics.length = saved;
      if (!resolved) return undefined;
      return substitute(
        resolved.candidate.method.returnType,
        this.callSubstitution(resolved.candidate, resolved.typeArgs)
      );
    }
    const node = expression.node;
    if (node.kind !== 'lambda') return undefined;
    const lambda = node.omitsParameters ? withParameters(node, parameterTypes.length, []) : node;
    if (lambda.parameters.length !== parameterTypes.length) return undefined;
    return this.bindLambda(lambda, expression.context as BindContext, undefined, parameterTypes, undefined, false)
      .returnType;
  }

  protected lambdaParameterTypes(expression: Unbound): Type[] | undefined {
    const node = expression.node;
    if (node.kind !== 'lambda' || node.parameters.length === 0 || node.parameters.some((parameter) => !parameter.type))
      return undefined;
    const context = expression.context as BindContext;
    return node.parameters.map((parameter) =>
      this.resolveType(parameter.type as NonNullable<LambdaParameter['type']>, context.fn.typeContext)
    );
  }

  // code-gauge-allow functionNcss -- Each check is one way that Roslyn rejects a lambda for a delegate type.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  protected bindLambdaTo(
    written: LambdaExpression,
    context: BindContext,
    target: Type,
    report: boolean
  ): BoundExpression | undefined {
    const invoke = this.delegateInvokeOf(target);
    const what = written.isAnonymousMethod ? '匿名メソッド' : 'ラムダ式';
    if (!invoke) {
      if (report && target.kind !== 'error')
        this.error(
          written,
          'CS1660',
          `${what} はデリゲート型ではないため、'${displayType(target)}' 型に変換できません`
        );
      return undefined;
    }
    if (written.omitsParameters && invoke.refKinds.includes('out')) {
      if (report)
        this.error(
          written,
          'CS1688',
          `パラメーター リストに out パラメーターが含まれるため、パラメーター リストなしの匿名メソッドをデリゲート型 '${displayType(target)}' に変換できません`
        );
      return undefined;
    }
    // A `delegate { }` without a parameter list takes the delegate's parameters under names no code can use.
    const node = written.omitsParameters
      ? (this.anonymousMethodShapes.get(written)?.get(invoke.parameterTypes.length) ??
        this.shapeAnonymousMethod(written, invoke.parameterTypes.length, invoke.refKinds))
      : written;
    if (invoke.parameterTypes.length !== node.parameters.length) {
      if (report)
        this.error(
          node,
          'CS1593',
          `デリゲート '${displayType(target)}' には引数 ${node.parameters.length} を指定できません`
        );
      return undefined;
    }
    if (this.reportRefKindMismatches(node, (target as NamedType).symbol.invoke?.parameters ?? [], report))
      return undefined;
    const mismatches = node.parameters.flatMap((parameter, index) => {
      if (!parameter.type) return [];
      const declared = this.resolveType(parameter.type, context.fn.typeContext);
      return sameType(declared, invoke.parameterTypes[index]) ? [] : [{ parameter, index, declared }];
    });
    if (mismatches.length > 0) {
      if (!report) return undefined;
      this.error(
        node,
        'CS1661',
        `パラメーター型がデリゲート パラメーター型と一致しないため、${what} を型 '${displayType(target)}' に変換することはできません`
      );
      for (const { parameter, index, declared } of mismatches)
        this.error(
          parameter,
          'CS1678',
          `パラメーター ${index + 1} は '${displayType(declared)}' 型として宣言しますが、'${displayType(invoke.parameterTypes[index])}' である必要があります`
        );
      return undefined;
    }
    return this.bindLambda(node, context, target as NamedType, invoke.parameterTypes, invoke.returnType, report).result;
  }

  /**
   * Reports each parameter declared otherwise than its delegate's by `ref`, `out`, or `in` (CS1676, CS1677), where `in`
   * and `ref readonly` agree and either may stand for `ref`; tells whether any is.
   */
  private reportRefKindMismatches(
    node: LambdaExpression,
    delegateParameters: readonly ParameterSymbol[],
    report: boolean
  ): boolean {
    let isMismatched = false;
    for (const [index, parameter] of node.parameters.entries()) {
      const expected = delegateParameters[index];
      const written = parameter.modifier;
      if (!expected || written === expected.refKind || (written === 'in' && expected.refKind === 'ref')) continue;
      isMismatched = true;
      if (!report) continue;
      if (expected.refKind)
        this.error(
          parameter,
          'CS1676',
          `パラメーター ${index + 1} はキーワード '${refKeyword(expected)}' で宣言する必要があります`
        );
      else
        this.error(
          parameter,
          'CS1677',
          `パラメーター ${index + 1} はキーワード '${refKeyword({ refKind: written, isRefReadonly: parameter.isRefReadonly })}' で宣言しないでください`
        );
    }
    return isMismatched;
  }

  /** The anonymous methods without parameter lists, with the parameters given them for each count, kept for the cache. */
  private readonly anonymousMethodShapes = new Map<LambdaExpression, Map<number, LambdaExpression>>();

  private shapeAnonymousMethod(
    node: LambdaExpression,
    count: number,
    refKinds: ('ref' | 'out' | 'in' | undefined)[]
  ): LambdaExpression {
    const shaped = withParameters(node, count, refKinds);
    const shapes = this.anonymousMethodShapes.get(node) ?? new Map<number, LambdaExpression>();
    shapes.set(count, shaped);
    this.anonymousMethodShapes.set(node, shapes);
    return shaped;
  }

  private readonly lambdasWithAttributes = new Set<LambdaExpression>();

  /** Binds the attributes collected since the last time, which the compiler provides. */
  protected abstract bindPendingAttributes(): void;

  /** What an async function's return type wraps (C# spec §15.14.1), or undefined for a type no async function returns. */
  asyncShapeOf(returnType: Type): AsyncShape | undefined {
    if (returnType.kind === 'void') return { kind: 'void', resultType: VOID_TYPE };
    if (returnType.kind !== 'named') return undefined;
    switch (returnType.symbol.fullName) {
      case 'System.Threading.Tasks.Task': {
        return { kind: 'task', resultType: VOID_TYPE };
      }
      case 'System.Threading.Tasks.Task`1': {
        return { kind: 'task', resultType: returnType.args[0] };
      }
      case 'System.Threading.Tasks.ValueTask': {
        return { kind: 'valueTask', resultType: VOID_TYPE };
      }
      case 'System.Threading.Tasks.ValueTask`1': {
        return { kind: 'valueTask', resultType: returnType.args[0] };
      }
      case 'System.Collections.Generic.IAsyncEnumerable`1': {
        return { kind: 'asyncEnumerable', resultType: returnType.args[0] };
      }
      case 'System.Collections.Generic.IAsyncEnumerator`1': {
        return { kind: 'asyncEnumerator', resultType: returnType.args[0] };
      }
      default: {
        return undefined;
      }
    }
  }

  /** The task type an async lambda returns for the type its returns give, as its natural type wraps it. */
  protected asyncReturnOf(inferred: Type): Type {
    const task = this.library.typeNamed('System.Threading.Tasks.Task', inferred.kind === 'void' ? 0 : 1);
    return inferred.kind === 'void' ? namedType(task) : namedType(task, [inferred]);
  }

  /** Binds a lambda to a delegate type, or returns undefined when it does not convert, reporting why if `report`. */
  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  protected bindLambda(
    node: LambdaExpression,
    outer: BindContext,
    delegateType: NamedType | undefined,
    parameterTypes: Type[],
    returnType: Type | undefined,
    report: boolean
  ): { result: BoundExpression | undefined; returnType: Type | undefined } {
    const key = `${parameterTypes.map(typeIdentityKey).join(',')}->${returnType ? typeIdentityKey(returnType) : '?'}`;
    const cache = this.lambdaCache.get(node) ?? new Map();
    this.lambdaCache.set(node, cache);
    const cached = cache.get(key);
    if (cached && !report) return { result: cached.result, returnType: cached.returnType };
    const savedDiagnostics = this.diagnostics.length;
    // An async lambda's body returns what its delegate's task type wraps, and one without a delegate type infers it.
    const shape = node.isAsync && returnType ? this.asyncShapeOf(returnType) : undefined;
    if (node.isAsync && returnType && !shape && returnType.kind !== 'error') {
      if (report && delegateType)
        this.error(
          node,
          'CS4010',
          `非同期の ラムダ式 をデリゲート型 '${displayType(delegateType)}' に変換できません。非同期の ラムダ式 は void、Task、または Task<T> を返しますが、いずれも '${displayType(delegateType)}' に変換することができません。`
        );
      return { result: undefined, returnType: undefined };
    }
    const bodyReturnType = shape ? shape.resultType : returnType;
    if (report) this.checkLambdaParameters(node, parameterTypes, outer);
    const context = this.lambdaContext(node, outer, parameterTypes, bodyReturnType);
    context.fn.method.returnsByRef = delegateType?.symbol.invoke?.returnsByRef;
    if (node.isAsync) {
      context.fn.method.isAsync = true;
      context.fn.method.async = shape ?? { kind: 'task', resultType: VOID_TYPE };
      if (returnType) context.fn.method.returnType = returnType;
    }
    // A lambda binds once for each delegate type it may convert to, but its attributes once.
    if (node.attributes && !this.lambdasWithAttributes.has(node)) {
      this.lambdasWithAttributes.add(node);
      this.collectAttributes(node.attributes, 'method', context.fn.method, outer.fn.typeContext, {
        method: context.fn.method,
        return: undefined,
      });
      this.bindPendingAttributes();
    }
    const method = context.fn.method;
    const bound = this.bindLambdaBodyGuarded(node, context, bodyReturnType, report);
    const { body } = bound;
    let { inferred } = bound;
    if (node.isAsync) {
      markSuspends(body);
      if (!returnType && inferred) {
        inferred = this.asyncReturnOf(inferred);
        method.returnType = inferred;
        method.async = { kind: 'task', resultType: bound.inferred as Type };
      } else if (returnType) inferred = returnType;
    }
    method.body = body;
    // A block whose end is reachable returns no value, so the lambda does not convert to a delegate that returns one
    // (C# spec §10.7.1), which makes `Task.Run(() => { ... })` take `Action` over `Func<Task>`.
    const failed =
      this.diagnostics.length > savedDiagnostics ||
      (!report && node.body.kind === 'block' && returnsValueType(bodyReturnType) && endIsReachable(method, body));
    const lambda: LambdaInfo = { method, captures: [...context.fn.captures], isStatic: node.isStatic };
    this.recordCaptureList(context.fn, (captures) => {
      lambda.captures = captures;
    });
    const converted: BoundExpression | undefined = delegateType
      ? { kind: 'lambda', lambda, type: delegateType, row: node.row }
      : undefined;
    if (!report) {
      const result = failed ? undefined : converted;
      const diagnostics = this.diagnostics.splice(savedDiagnostics);
      cache.set(key, { result, diagnostics, returnType: inferred });
      return { result, returnType: inferred };
    }
    return { result: converted, returnType: inferred };
  }

  /** Reports misplaced `params` parameters and optional parameters, and default values that are no constants. */
  private checkLambdaParameters(node: LambdaExpression, parameterTypes: Type[], outer: BindContext): void {
    let hasOptional = false;
    for (const [index, parameter] of node.parameters.entries()) {
      const type = parameterTypes[index] ?? ERROR_TYPE;
      if (parameter.isScoped) this.checkScoped(parameter, type, parameter.modifier);
      if (parameter.isParams) {
        if (index !== node.parameters.length - 1)
          this.error(
            parameter,
            'CS0231',
            'params パラメーターは、パラメーター リストの最後のパラメーターでなければなりません'
          );
        if (type.kind !== 'error' && !paramsCollectionOf(type, this.objectType))
          this.error(parameter, 'CS0225', 'params パラメーターには有効なコレクションの種類が必要です');
      } else if (parameter.defaultValue) {
        hasOptional = true;
        this.bindParameterDefault(
          {
            name: parameter.name,
            type,
            refKind: parameter.modifier,
            isParams: false,
            defaultSyntax: parameter.defaultValue,
            defaultContext: outer.fn.typeContext,
          },
          type,
          outer
        );
      } else if (hasOptional)
        this.error(parameter, 'CS1737', '省略可能なパラメーターはすべての必須パラメーターの後で指定する必要があります');
    }
  }

  /** The scope of a lambda's body, with a method for the lambda and its parameters declared. */
  private lambdaContext(
    node: LambdaExpression,
    outer: BindContext,
    parameterTypes: Type[],
    returnType: Type | undefined
  ): BindContext {
    const method = new MethodSymbol('<lambda>', outer.fn.method.owner, 'localFunction');
    method.isStatic = outer.fn.isStatic;
    (method as { isStaticLambda?: boolean }).isStaticLambda = node.isStatic;
    method.row = node.row;
    method.returnType = returnType ?? VOID_TYPE;
    method.parameters = node.parameters.map((parameter, index) => ({
      name: parameter.name,
      type: parameterTypes[index] ?? ERROR_TYPE,
      refKind: parameter.modifier,
      ...(parameter.isRefReadonly ? { isRefReadonly: true } : {}),
      isParams: parameter.isParams === true,
    }));
    const fn = new FunctionScope(
      method,
      outer.fn,
      outer.fn.typeContext,
      returnType,
      outer.fn.isStatic || node.isStatic,
      outer.fn.isStatic || node.isStatic ? undefined : outer.fn.thisType,
      'lambda'
    );
    const scope = new LocalScope(outer.scope, fn);
    const context: BindContext = { scope, fn };
    const hasDiscards = node.parameters.filter((other) => other.name === '_').length > 1;
    for (const [index, parameter] of node.parameters.entries()) {
      // Repeated `_` are discards, which still take their argument's position under a name no code can use.
      const declared = hasDiscards && parameter.name === '_' ? { ...parameter, name: `\0discard${index}` } : parameter;
      this.declareParameterLocal(declared, parameterTypes[index] ?? ERROR_TYPE, context);
    }
    return context;
  }

  /** Binds a lambda's body, counted in `trialLambdaDepth` unless `report`, restoring `allowsThrowExpression` after. */
  private bindLambdaBodyGuarded(
    node: LambdaExpression,
    context: BindContext,
    returnType: Type | undefined,
    report: boolean
  ): { body: BoundBlock; inferred: Type | undefined } {
    const savedThrow = this.allowsThrowExpression;
    if (!report) this.trialLambdaDepth++;
    try {
      return this.bindLambdaBody(node, context, returnType, report);
    } finally {
      this.allowsThrowExpression = savedThrow;
      if (!report) this.trialLambdaDepth--;
    }
  }

  private bindLambdaBody(
    node: LambdaExpression,
    context: BindContext,
    returnType: Type | undefined,
    report: boolean
  ): { body: BoundBlock; inferred: Type | undefined } {
    const { body: written } = node;
    const returnsByRef = context.fn.method.returnsByRef !== undefined && written.kind !== 'throw';
    if (written.kind === 'block' || written.kind === 'refExpression' || returnsByRef) {
      // `() => ref x` returns the variable, as the block `{ return ref x; }` does.
      const position = { row: written.row, column: written.column };
      const block: Block =
        written.kind === 'block'
          ? written
          : {
              kind: 'block',
              statements: [{ kind: 'return', value: written, ...position }],
              endRow: written.row,
              ...position,
            };
      const body = this.bindFunctionBlock(block, context);
      const { fn } = context;
      const inferred =
        returnType ??
        (fn.returnsValue
          ? (this.bestCommonType(
              fn.returnTypes.map((type) => ({ kind: 'default', type, row: node.row }) as BoundExpression)
            ) ?? ERROR_TYPE)
          : VOID_TYPE);
      return { body, inferred };
    }
    const savedThrow = this.allowsThrowExpression;
    this.allowsThrowExpression = true;
    const value = this.bindValue(written, context);
    this.allowsThrowExpression = savedThrow;
    return this.expressionLambdaBody(node, written, value, returnType, report);
  }

  /** The body of a lambda with an expression body, converted to the delegate's return type. */
  private expressionLambdaBody(
    node: LambdaExpression,
    bodyNode: Expression,
    value: BoundExpression,
    returnType: Type | undefined,
    report: boolean
  ): { body: BoundBlock; inferred: Type | undefined } {
    if (returnType === undefined) {
      const inferred = value.kind === 'throw' ? undefined : value.kind === 'unbound' ? undefined : value.type;
      return { body: this.expressionBody(value, inferred, node.row), inferred };
    }
    if (returnType.kind === 'void')
      return { body: this.voidLambdaBody(node, bodyNode, value, report), inferred: VOID_TYPE };
    const converted = value.kind === 'throw' ? value : this.convert(value, returnType, bodyNode);
    if (
      report &&
      !node.isQuery &&
      value.kind !== 'throw' &&
      value.type.kind !== 'error' &&
      !this.implicitConversionOf(value, returnType)
    ) {
      this.error(
        bodyNode,
        'CS1662',
        'デリゲート戻り値の型に暗黙的に変換できない戻り値の型がブロック内にあるため、ラムダ式 を目的のデリゲート型に変換できません'
      );
    }
    return { body: this.expressionBody(converted, returnType, node.row), inferred: returnType };
  }
  /** The body of a lambda with an expression body whose delegate returns void, which must be a statement expression. */
  private voidLambdaBody(
    node: LambdaExpression,
    bodyNode: Expression,
    value: BoundExpression,
    report: boolean
  ): BoundBlock {
    if (!this.isStatementExpression(value)) {
      if (report)
        this.error(
          bodyNode,
          'CS0201',
          '代入、呼び出し、インクリメント、デクリメント、新しいオブジェクトの式のみがステートメントとして使用できます'
        );
      else this.diagnostics.push({ row: node.row, message: 'not a statement' });
    }
    discardResult(value);
    return {
      kind: 'block',
      statements: [{ kind: 'expression', expression: value, row: bodyNode.row, step: 'none' }],
      capturedLocals: [],
      locals: [],
      row: node.row,
      step: 'none',
    };
  }

  /** Declares a lambda's parameter, which may hide an enclosing function's local of the same name (since C# 8). */
  private declareParameterLocal(parameter: LambdaParameter, type: Type, context: BindContext): void {
    const local = new LocalSymbol(parameter.name, type, parameter.row, parameter.column);
    local.isParameter = true;
    local.refKind = parameter.modifier;
    local.isScoped = parameter.isScoped === true;
    local.isTransparent = parameter.name.startsWith(TRANSPARENT_PREFIX);
    local.isHidden = local.isTransparent;
    context.fn.addLocal(local);
    context.scope.variables.set(parameter.name, local);
  }

  private expressionBody(value: BoundExpression, returnType: Type | undefined, row: number): BoundBlock {
    const statement =
      returnType?.kind === 'void'
        ? { kind: 'expression' as const, expression: value, row, step: 'none' as const }
        : { kind: 'return' as const, value, row, step: 'none' as const };
    return { kind: 'block', statements: [statement], capturedLocals: [], locals: [], row, step: 'none' };
  }

  /** Whether an expression may stand as a statement: an assignment, a call, an increment, `new`, or `await`. */
  isStatementExpression(expression: BoundExpression): boolean {
    switch (expression.kind) {
      case 'late': {
        return expression.isStatement;
      }
      case 'assign':
      case 'refAssign':
      case 'refFieldAssign':
      case 'compoundAssign':
      case 'increment':
      case 'call':
      case 'invokeDelegate':
      case 'new':
      case 'deconstructAssign':
      case 'eventAccessor':
      case 'await':
      case 'throw': {
        return true;
      }
      case 'conditionalAccess': {
        return this.isStatementExpression(expression.access);
      }
      case 'convert': {
        return expression.operand.kind === 'call' && !expression.isExplicit;
      }
      case 'sequence': {
        return this.isStatementExpression(expression.value);
      }
      case 'default': {
        return expression.failedCall === true || expression.type.kind === 'error';
      }
      default: {
        return expression.type.kind === 'error';
      }
    }
  }
}

/**
 * A type's part of a binding cache's key: a type's name alone is not its identity, as two namespaces may each declare
 * `Item`, and its display carries the tuple element names that its identity leaves out.
 */
export function typeIdentityKey(type: Type): string {
  return `${typeKey(type)}:${displayType(type)}`;
}

/** An anonymous method without a parameter list, given parameters that no code can name. */
function withParameters(
  node: LambdaExpression,
  count: number,
  refKinds: ('ref' | 'out' | 'in' | undefined)[]
): LambdaExpression {
  const parameters = Array.from({ length: count }, (_, index) => ({
    name: `\0anonymous${index}`,
    type: undefined,
    modifier: refKinds[index],
    row: node.row,
    column: node.column,
  }));
  return { ...node, parameters };
}

/** Marks the late-bound operation whose value a statement drops, which the runtime binder lets return `void`. */
export function discardResult(expression: BoundExpression): void {
  if (expression.kind === 'late') expression.isDiscarded = true;
  else if (expression.kind === 'await') discardResult(expression.getResult);
  else if (expression.kind === 'conditionalAccess') discardResult(expression.access);
}

function returnsValueType(type: Type | undefined): boolean {
  return type !== undefined && type.kind !== 'void' && type.kind !== 'error';
}

/** Whether the end of a function's body is reachable, which the flow analysis tells without reporting anything. */
function endIsReachable(method: MethodSymbol, body: BoundBlock): boolean {
  let isReachable = false;
  new FlowAnalyzer({
    unassigned: ignore,
    unassignedField: ignore,
    notAllPathsReturn: () => (isReachable = true),
    lambdaNotAllPathsReturn: ignore,
    fallsThrough: ignore,
    outNotAssigned: ignore,
    heldAcrossSuspension: ignore,
  }).analyzeFunction(method, body, [], true, method.row);
  return isReachable;
}

function ignore(): void {}
