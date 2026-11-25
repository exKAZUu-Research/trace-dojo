import type { SourceDiagnostic } from '../interpreter/diagnostics';
import type { Block, Expression, LambdaParameter } from './ast';
import type { BoundBlock, BoundExpression, LambdaInfo } from './bound';
import type { ArgumentInfo } from './callBinder';
import type { BindContext } from './convertBinder';
import { MemberBinder, type NonValue } from './memberBinder';
import { TRANSPARENT_PREFIX } from './queries';
import { FunctionScope, LocalScope } from './scopes';
import {
  displayType,
  ERROR_TYPE,
  LocalSymbol,
  MethodSymbol,
  type NamedType,
  namedType,
  sameType,
  substitute,
  substitutionOf,
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

  protected naturalTypeOf(expression: Unbound): Type | undefined {
    const node = expression.node;
    if (expression.methodGroup) {
      const group = expression.methodGroup as Extract<NonValue, { kind: 'methodGroup' }>;
      if (group.candidates.length !== 1 || group.candidates[0].method.typeParameters.length > 0) return undefined;
      const method = group.candidates[0].method;
      const substitution = substitutionOf(group.candidates[0].owner);
      return this.functionTypeOf(
        method.parameters.map((parameter) => substitute(parameter.type, substitution)),
        substitute(method.returnType, substitution)
      );
    }
    if (node.kind === 'lambda') {
      if (node.omitsParameters || node.parameters.some((parameter) => !parameter.type)) return undefined;
      const context = expression.context as BindContext;
      const parameterTypes = node.parameters.map((parameter) =>
        this.resolveType(parameter.type as NonNullable<LambdaParameter['type']>, context.fn.typeContext)
      );
      const declaredReturn = node.returnType ? this.resolveType(node.returnType, context.fn.typeContext) : undefined;
      const returnType =
        declaredReturn ?? this.bindLambda(node, context, undefined, parameterTypes, undefined, false).returnType;
      if (!returnType) return undefined;
      return this.functionTypeOf(parameterTypes, returnType);
    }
    return undefined;
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

  /** Binds a lambda to a delegate type, or returns undefined when it does not convert, reporting why if `report`. */
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
    const context = this.lambdaContext(node, outer, parameterTypes, returnType);
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
    const { body, inferred } = this.bindLambdaBodyGuarded(node, context, returnType, report);
    method.body = body;
    const failed = this.diagnostics.length > savedDiagnostics;
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
      isParams: false,
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
    if (node.body.kind === 'block') {
      const body = this.bindFunctionBlock(node.body, context);
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
    const value = this.bindValue(node.body, context);
    this.allowsThrowExpression = savedThrow;
    return this.expressionLambdaBody(node, node.body, value, returnType, report);
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
      case 'assign':
      case 'compoundAssign':
      case 'increment':
      case 'call':
      case 'invokeDelegate':
      case 'new':
      case 'deconstructAssign':
      case 'eventAccessor':
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
