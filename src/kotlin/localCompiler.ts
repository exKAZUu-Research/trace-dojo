// code-gauge-allow-file fileNcss -- the file holds one layer of the compiler, whose parts share its state.
import { AnnotationCompiler } from './annotationCompiler';
import { annotationSite } from './annotationSites';
import type { ClassDecl, Expression, FunctionDecl, LambdaExpression, Statement } from './ast';
import type { Candidate } from './callCompiler';
import {
  coerce,
  type Compiled,
  convertRepr,
  type Eval,
  FunctionContext,
  ReceiverSymbol,
  reprOf,
  Scope,
  typeMismatchMessage,
} from './compilerBase';
import type { ClassEntry } from './declarationCompiler';
import { returnRepr, runtimeClassOf } from './dispatch';
import { lambdaValue } from './lambdaValue';
import { type ClassReference, classReference } from './natives/reflection';
import { mentionsReified, runtimeType } from './reified';
import { type Frame, type LocalEnv, localEnvOf, MISSING, type Suspension } from './runtime';
import type { Exec } from './statementCompiler';
import {
  type ClassSymbol,
  FunctionSymbol,
  type ParameterSymbol,
  type PropertySymbol,
  type VariableSymbol,
} from './symbols';
import { isSameType, isSubtype } from './typeRelations';
import {
  type ClassType,
  type FunctionType,
  hasOpenVariables,
  isNonNullClass,
  isNullable,
  type KType,
  NOTHING,
  resolved,
  substitute,
  type Substitution,
} from './types';
import { type KObject, UNIT, type Value } from './values';

/** What is written before `::`, as the compiler reads it. */
type ReferenceTarget = { kind: 'free' } | { kind: 'unbound'; type: KType } | { kind: 'bound'; receiver: Compiled };

/** The signature of what a reference names, which gives the reference its type without an expected one. */
interface ReferencedSignature {
  kind: 'function' | 'property';
  params: KType[];
  returnType: KType;
  isMutable: boolean;
}

const REFERENCE_PARAMETER = '\0reference';
const BOUND_RECEIVER = '\0boundReceiver';

/**
 * Compiles what refers to code as a value: callable references, anonymous functions, and the declarations of
 * function bodies.
 */
export abstract class LocalCompiler extends AnnotationCompiler {
  // Callable references.

  protected compileReference(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'reference' }>,
    expected: KType | undefined
  ): Compiled {
    const { row, name } = expression;
    if (name === 'class') return this.compileClassReference(scope, context, expression);
    const referenceScope = new Scope(scope, context);
    const target = this.referenceTarget(referenceScope, context, expression);
    const expectedFunction = this.expectedFunctionType(expected);
    if (expectedFunction) {
      const fitted = this.fitReferenceParameters(target, expectedFunction);
      const isProperty = !this.namesFunction(referenceScope, target, name, row);
      // A property's reference takes only the receiver it is unbound from, as `String::length` is `(String) -> Int`.
      if (isProperty && fitted.params.length !== (target.kind === 'unbound' ? 1 : 0)) {
        const actual = this.compileReference(scope, context, expression, undefined).type;
        return this.error(row, typeMismatchMessage(expected as KType, actual));
      }
      const lambda = referenceLambda(target, name, fitted.params.length, row, isProperty);
      return this.withBoundReceiver(
        target,
        this.compileLambda(referenceScope, context, lambda, fitted, false, false, true)
      );
    }
    const signature = this.referencedSignature(referenceScope, target, name, row);
    const params = target.kind === 'unbound' ? [target.type, ...signature.params] : signature.params;
    const getter = this.compileLambda(
      referenceScope,
      context,
      referenceLambda(target, name, params.length, row, signature.kind === 'property'),
      { kind: 'function', receiver: undefined, params, returnType: signature.returnType, nullable: false },
      false,
      false,
      true
    );
    if (signature.kind === 'function') {
      return this.withBoundReceiver(
        target,
        this.referenceObject(
          `FunctionReference${params.length}`,
          `KFunction${params.length}`,
          [...params, signature.returnType],
          [getter],
          name,
          row
        )
      );
    }
    const receiverTypes = target.kind === 'unbound' ? [target.type] : [];
    const setter = signature.isMutable
      ? this.compileLambda(
          referenceScope,
          context,
          referenceSetterLambda(target, name, row),
          {
            kind: 'function',
            receiver: undefined,
            params: [...receiverTypes, signature.returnType],
            returnType: this.unitType,
            nullable: false,
          },
          false,
          false,
          true
        )
      : undefined;
    const arity = receiverTypes.length;
    const kind = `${signature.isMutable ? 'Mutable' : ''}PropertyReference${arity}`;
    const typeName = `K${signature.isMutable ? 'Mutable' : ''}Property${arity}`;
    return this.withBoundReceiver(
      target,
      this.referenceObject(
        kind,
        typeName,
        [...receiverTypes, signature.returnType],
        setter ? [getter, setter] : [getter],
        name,
        row
      )
    );
  }

  /** A reference's expected type as a function type: a function type, or a `FunctionN` interface. */
  private expectedFunctionType(expected: KType | undefined): FunctionType | undefined {
    const actual = expected && resolved(expected);
    if (actual?.kind === 'function') return actual;
    if (actual?.kind !== 'class') return undefined;
    const arity = this.core.functionInterfaces.indexOf(actual.cls);
    if (arity === -1) return undefined;
    const types = actual.args.map((argument) => (argument.variance === 'star' ? this.anyNullableType : argument.type));
    return {
      kind: 'function',
      receiver: undefined,
      params: types.slice(0, -1),
      returnType: types.at(-1) as KType,
      nullable: actual.nullable,
    };
  }

  private get anyNullableType(): KType {
    return { ...this.core.any.type, nullable: true };
  }

  /**
   * The parameters the reference's lambda takes: the expected ones, where an unbound reference's receiver is the type
   * written before `::` unless the expected type already fixes it.
   */
  private fitReferenceParameters(target: ReferenceTarget, expected: FunctionType): FunctionType {
    const params = expected.receiver ? [expected.receiver, ...expected.params] : expected.params;
    if (target.kind !== 'unbound' || params.length === 0) return { ...expected, receiver: undefined, params };
    const [first, ...rest] = params;
    return { ...expected, receiver: undefined, params: [hasOpenVariables(first) ? target.type : first, ...rest] };
  }

  private referenceTarget(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'reference' }>
  ): ReferenceTarget {
    const { receiver } = expression;
    if (!receiver) return { kind: 'free' };
    if (receiver.kind === 'type') return { kind: 'unbound', type: this.resolveType(scope, receiver.type, true) };
    const qualifier = this.compileQualifier(scope, receiver.expression);
    if (qualifier?.kind === 'class') return { kind: 'unbound', type: this.starredClassType(qualifier.cls) };
    const compiled = this.compileExpression(scope, context, receiver.expression);
    const variable = this.newVariable(scope, context, BOUND_RECEIVER, compiled.type, false, expression.row, false);
    this.flow.assigned.add(variable);
    const { write } = this.variableAccess(context, variable);
    const value = coerce(compiled, 'ref');
    return {
      kind: 'bound',
      receiver: { ...compiled, eval: (frame) => (write(frame, value(frame)), undefined) },
    };
  }

  /** A class written without its type arguments, as `List` of `List::size`, whose arguments are stars. */
  private starredClassType(cls: ClassSymbol): ClassType {
    return { kind: 'class', cls, args: cls.typeParameters.map(() => ({ variance: 'star' })), nullable: false };
  }

  /** Evaluates a bound reference's receiver once, when the reference is created, before the reference itself. */
  private withBoundReceiver(target: ReferenceTarget, reference: Compiled): Compiled {
    if (target.kind !== 'bound') return reference;
    const store = target.receiver.eval;
    const create = reference.eval;
    return {
      ...reference,
      eval: (frame) => {
        store(frame);
        return create(frame);
      },
    };
  }

  /** Creates a `KFunctionN` or `KPropertyN` reference object around the lambdas that read and write the target. */
  private referenceObject(
    implementation: string,
    typeName: string,
    typeArgs: KType[],
    accessors: Compiled[],
    name: string,
    row: number
  ): Compiled {
    const cls = this.findQualifiedClass(['kotlin', 'reflect', typeName]);
    const implementationClass = this.findQualifiedClass(['kotlin', 'reflect', implementation]);
    const constructor = implementationClass?.constructors[0];
    if (!cls || !constructor) return this.unavailable(row, `${typeName} の参照`);
    const evaluators = accessors.map((accessor) => accessor.eval);
    return {
      type: { kind: 'class', cls, args: typeArgs.map((type) => ({ variance: 'inv', type })), nullable: false },
      repr: 'ref',
      eval: (frame) => {
        const values = evaluators.map((evaluate) => evaluate(frame));
        return (constructor.invoke as NonNullable<FunctionSymbol['invoke']>)(
          frame,
          undefined,
          [name, ...values],
          undefined
        );
      },
    };
  }

  /** Whether a reference names a function or a constructor, rather than a property. */
  private namesFunction(scope: Scope, target: ReferenceTarget, name: string, row: number): boolean {
    if (target.kind === 'free') return this.freeFunctions(scope, name, row).length > 0;
    const receiverType = target.kind === 'unbound' ? target.type : target.receiver.type;
    return this.receiverFunctions(receiverType, name).length > 0;
  }

  /** What a reference names without an expected function type: one function, or a property. */
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private referencedSignature(scope: Scope, target: ReferenceTarget, name: string, row: number): ReferencedSignature {
    const receiverType =
      target.kind === 'free' ? undefined : target.kind === 'unbound' ? target.type : target.receiver.type;
    const functions = receiverType ? this.receiverFunctions(receiverType, name) : this.freeFunctions(scope, name, row);
    if (functions.length > 1)
      this.error(row, `${name} は多重定義されているので、参照の型を書いて、どれを使うかを決めてください。`);
    const [candidate] = functions;
    if (candidate) {
      const { symbol, substitution } = candidate;
      if (symbol.typeParameters.length > 0 && !candidate.symbol.isConstructor)
        this.error(row, `型引数を持つ関数 ${name} の参照には、型を書いてください。`);
      const returnType = symbol.isConstructor
        ? this.constructedType(symbol, row)
        : substitute(this.ensureReturnType(symbol, row), substitution);
      return {
        kind: 'function',
        params: symbol.params.map((param) => substitute(param.type, substitution)),
        returnType,
        isMutable: false,
      };
    }
    const property = receiverType ? this.findProperty(receiverType, name, row) : this.freeProperty(scope, name);
    if (!property) {
      if (!receiverType && this.findVariable(scope, name)) this.error(row, 'ローカル変数は :: で参照できません。');
      return this.error(row, `${name} が見つかりません。`);
    }
    const { symbol, substitution } = property;
    return {
      kind: 'property',
      params: [],
      returnType: substitute(this.ensurePropertyType(symbol, row), substitution),
      isMutable: symbol.isVar && symbol.setterVisibility !== 'private',
    };
  }

  /** The type a constructor creates, which a reference to a generic class's constructor cannot infer. */
  private constructedType(symbol: FunctionSymbol, row: number): KType {
    const cls = symbol.owner as ClassSymbol;
    if (cls.typeParameters.length > 0)
      this.error(row, `型引数を持つクラス ${cls.name} のコンストラクタの参照には、型を書いてください。`);
    return cls.type;
  }

  private receiverFunctions(receiverType: KType, name: string): Candidate[] {
    const members = this.memberCandidates(receiverType, name);
    if (members.length > 0) return uniqueRoots(members);
    return this.extensionCandidateLevels(receiverType, name).find((level) => level.length > 0) ?? [];
  }

  private freeFunctions(scope: Scope, name: string, row: number): Candidate[] {
    const local = this.localFunctions(scope, name);
    if (local.length > 0)
      return local.map((symbol) => ({ symbol, kind: 'function', substitution: new Map(), receiverType: undefined }));
    for (const receiver of this.receiversOf(scope)) {
      const members = this.memberCandidates(this.receiverTypeOf(receiver), name);
      if (members.length > 0) return uniqueRoots(members);
    }
    const level = this.topLevelFunctions(name).find((functions) =>
      functions.some((symbol) => !symbol.extensionReceiver)
    );
    if (level) {
      return level
        .filter((symbol) => !symbol.extensionReceiver)
        .map((symbol) => ({ symbol, kind: 'function', substitution: new Map(), receiverType: undefined }));
    }
    const cls = this.findClass(scope, name);
    return cls ? this.constructorCandidates(cls, row) : [];
  }

  private freeProperty(scope: Scope, name: string): { symbol: PropertySymbol; substitution: Substitution } | undefined {
    for (const receiver of this.receiversOf(scope)) {
      const member = this.membersOf<PropertySymbol>(this.receiverTypeOf(receiver), name, 'property')[0];
      if (member) return { symbol: member.symbol, substitution: new Map() };
    }
    const symbol = this.topLevelPlainProperty(name);
    return symbol && { symbol, substitution: new Map() };
  }

  // code-gauge-allow functionNcss -- the parts of the construct this function compiles follow one another, and splitting them would only rename them.
  protected compileIsInitialized(
    scope: Scope,
    context: FunctionContext,
    reference: Extract<Expression, { kind: 'reference' }>
  ): Compiled {
    const { receiver, name, row } = reference;
    let property: PropertySymbol | undefined;
    let receiverEval: Eval | undefined;
    if (!receiver) {
      for (const candidate of this.receiversOf(scope)) {
        const member = this.membersOf<PropertySymbol>(this.receiverTypeOf(candidate), name, 'property')[0];
        if (!member) continue;
        property = member.symbol;
        receiverEval = this.receiverAccess(context, candidate);
        break;
      }
      property ??= this.topLevelPlainProperty(name);
      if (!property && this.findVariable(scope, name)) this.error(row, 'ローカル変数は :: で参照できません。');
    } else if (receiver.kind === 'expression') {
      const compiled = this.compileExpression(scope, context, receiver.expression);
      property = this.findProperty(compiled.type, name, row)?.symbol;
      receiverEval = coerce(compiled, 'ref');
    }
    if (!property) return this.error(row, `${name} が見つかりません。`);
    if (!property.isLateinit) this.error(row, 'isInitialized は、lateinit のプロパティにだけ使えます。');
    const symbol = property;
    const readReceiver = receiverEval;
    return {
      type: this.booleanType,
      repr: 'ref',
      eval: (frame) => {
        const slot = symbol.slot as number;
        if (!readReceiver) return frame.runtime.globals[slot] !== undefined;
        return (readReceiver(frame) as KObject).fields[slot] !== undefined;
      },
    };
  }

  /** `X::class` and `value::class`, which tell a class's names. */
  private compileClassReference(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'reference' }>
  ): Compiled {
    const { receiver, row } = expression;
    const kClass = this.findQualifiedClass(['kotlin', 'reflect', 'KClass']) as ClassSymbol;
    const typed = (type: KType, variance: 'inv' | 'out'): KType => ({
      kind: 'class',
      cls: kClass,
      args: [{ variance, type }],
      nullable: false,
    });
    if (!receiver) return this.error(row, '::class の前に、クラスか値を書いてください。');
    const qualifier = receiver.kind === 'expression' ? this.compileQualifier(scope, receiver.expression) : undefined;
    const simpleName =
      receiver.kind === 'expression' &&
      receiver.expression.kind === 'name' &&
      !this.findVariable(scope, receiver.expression.name)
        ? receiver.expression.name
        : undefined;
    if (simpleName === 'Nothing' && !this.findClass(scope, simpleName) && !this.findTypeParameter(scope, simpleName)) {
      const value = classReference({ nothing: true });
      return { type: typed(NOTHING, 'inv'), repr: 'ref', eval: () => value };
    }
    const typeParameter = simpleName === undefined ? undefined : this.findTypeParameter(scope, simpleName);
    if (receiver.kind === 'type' || qualifier?.kind === 'class' || typeParameter) {
      const type: KType = typeParameter
        ? { kind: 'param', param: typeParameter, nullable: false }
        : receiver.kind === 'type'
          ? resolved(this.resolveType(scope, receiver.type, true))
          : this.starredClassType((qualifier as { cls: ClassSymbol }).cls);
      if (type.kind === 'param' && !type.param.isReified)
        this.error(row, `型引数 ${type.param.name} は reified ではないので、::class を使えません。`);
      if (type.nullable) this.error(row, '::class の前には、null かもしれない型を書けません。');
      if (type.kind === 'nothing') {
        const value = classReference({ nothing: true });
        return { type: typed(type, 'inv'), repr: 'ref', eval: () => value };
      }
      if (type.kind === 'param' && mentionsReified(type)) {
        return {
          type: typed(type, 'inv'),
          repr: 'ref',
          eval: (frame) => {
            const actual = resolved(runtimeType(type, frame));
            return actual.kind === 'class' ? classReference({ cls: actual.cls }) : classReference({ nothing: true });
          },
        };
      }
      if (type.kind !== 'class')
        return this.error(row, `${receiver.kind === 'type' ? '型引数' : '関数の型'} には ::class を使えません。`);
      const value = classReference({ cls: type.cls } satisfies ClassReference);
      return { type: typed(type, 'inv'), repr: 'ref', eval: () => value };
    }
    const compiled = this.compileExpression(scope, context, receiver.expression);
    if (resolved(compiled.type).nullable) this.error(row, 'null かもしれない値には ::class を使えません。');
    const value = coerce(compiled, 'ref');
    return {
      type: typed(compiled.type, 'out'),
      repr: 'ref',
      eval: (frame) => classReference({ cls: runtimeClassOf(value(frame)) }),
    };
  }

  // Anonymous functions.

  protected compileAnonymousFunction(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'anonymousFunction' }>,
    expected: KType | undefined
  ): Compiled {
    return this.compileFunctionValue(scope, context, expression.decl, this.expectedFunctionType(expected));
  }

  /**
   * Compiles an anonymous function, or a local function's body, as a function value that captures the variables it
   * reads, as a lambda does, but whose `return` leaves the function itself.
   */
  protected compileFunctionValue(
    scope: Scope,
    context: FunctionContext,
    decl: FunctionDecl,
    expected: FunctionType | undefined
  ): Compiled {
    const { functionContext, functionScope, receiverType, params } = this.functionValueHeader(
      scope,
      context,
      decl,
      expected
    );
    const declared = decl.returnType ? this.resolveType(functionScope, decl.returnType) : undefined;
    const expectedReturn =
      expected && !hasOpenVariables(expected.returnType) ? resolved(expected.returnType) : undefined;
    const outerFlow = this.flow;
    this.flow = outerFlow.copy();
    if (decl.body)
      this.forgetAssignedIn(scope, decl.body.kind === 'block' ? decl.body.block.statements : decl.body.expression);
    const variables = params.map((param) => {
      const variable = this.newParameter(functionScope, functionContext, param.name, param.type, param.row);
      this.flow.assigned.add(variable);
      return variable;
    });
    let body: Eval;
    let returnType: KType;
    try {
      ({ body, returnType } = this.compileFunctionValueBody(
        functionScope,
        functionContext,
        decl,
        declared ?? (decl.body?.kind === 'block' ? this.unitType : expectedReturn),
        declared !== undefined || decl.body?.kind === 'block'
      ));
    } finally {
      this.flow = outerFlow;
    }
    const hasReceiver = receiverType !== undefined;
    const type: FunctionType = {
      kind: 'function',
      receiver: receiverType,
      params: params.map((param) => param.type),
      returnType,
      nullable: false,
    };
    const evaluate = lambdaValue({
      captureBuilder: this.captureBuilder(context, functionContext),
      info: functionContext.info,
      arity: params.length + (hasReceiver ? 1 : 0),
      hasReceiver,
      receiverIsUnboxed: hasReceiver && reprOf(this.core, receiverType) !== 'ref',
      paramReprs: variables.map((variable) => reprOf(this.core, variable.type)),
      nonNullParameters: [receiverType, ...variables.map((variable) => variable.type)]
        .filter((each) => each !== undefined)
        .map((each) => !isNullable(resolved(each))),
      resultEval: body,
      functionClass: this.core.function,
    });
    return { type, repr: 'ref', eval: evaluate };
  }

  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private functionValueHeader(
    scope: Scope,
    context: FunctionContext,
    decl: FunctionDecl,
    expected: FunctionType | undefined
  ): {
    functionContext: FunctionContext;
    functionScope: Scope;
    receiverType: KType | undefined;
    params: { name: string; type: KType; row: number }[];
  } {
    const functionContext = new FunctionContext(
      context,
      false,
      decl.name || 'anonymous',
      context.info.isLibrary,
      undefined
    );
    Object.defineProperty(functionContext, 'returnTarget', { value: functionContext });
    functionContext.label = decl.name || undefined;
    const functionScope = new Scope(scope, functionContext);
    const receiverType = decl.receiver ? this.resolveType(functionScope, decl.receiver) : expected?.receiver;
    if (receiverType)
      functionScope.receiver = new ReceiverSymbol(receiverType, functionContext, undefined, decl.name || undefined);
    const expectedParams = expected?.params;
    if (expectedParams && expectedParams.length !== decl.params.length)
      this.error(decl.row, `この関数には引数が ${expectedParams.length} 個要ります。`);
    this.rejectDuplicateNames(decl.params);
    const params = decl.params.map((param, index) => {
      const written = param.type ? this.resolveType(functionScope, param.type) : undefined;
      const fromExpected = expectedParams?.[index];
      if (!written && !fromExpected) this.error(param.row, `引数 ${param.name} の型を書いてください。`);
      if (written && fromExpected && !isSubtype(fromExpected, written))
        this.error(param.row, typeMismatchMessage(written, fromExpected));
      if (param.defaultValue) this.error(param.row, '無名関数の引数には、デフォルト値を書けません。');
      return { name: param.name, type: written ?? (fromExpected as KType), row: param.row };
    });
    return { functionContext, functionScope, receiverType, params };
  }

  /** A function value's body, which returns its result as a reference, as function values do. */
  private compileFunctionValueBody(
    scope: Scope,
    context: FunctionContext,
    decl: FunctionDecl,
    returnType: KType | undefined,
    isDeclared: boolean
  ): { body: Eval; returnType: KType } {
    const body = decl.body;
    if (!body) return this.error(decl.row, '関数に本体を書いてください。');
    context.returnRepr = 'ref';
    if (body.kind === 'block') {
      const type = returnType ?? this.unitType;
      context.returnType = type;
      const compiled = this.compileStatementsValue(scope, context, body.block.statements, undefined, true, false);
      if (!isNonNullClass(type, this.core.unit) && !this.flow.isDead)
        this.error(body.block.endRow, '関数の最後に return を書いてください。');
      const evaluate = compiled.eval;
      return { body: (frame) => (evaluate(frame), UNIT), returnType: type };
    }
    if (isDeclared) context.returnType = returnType;
    const compiled = this.compileExpression(scope, context, body.expression, returnType);
    const type = returnType && isDeclared ? returnType : this.inferredValueType(compiled);
    const misfit = context.returnedTypes.find((returned) => !isSubtype(returned, type));
    if (misfit) this.error(body.expression.row, typeMismatchMessage(type, misfit));
    for (const settle of context.inferredReturns) settle('ref');
    context.returnType = type;
    return {
      body: convertRepr(this.expectType(compiled, type, body.expression.row), reprOf(this.core, type), 'ref'),
      returnType: type,
    };
  }

  private inferredValueType(compiled: Compiled): KType {
    const type = resolved(compiled.type);
    if (compiled.integerLiteral) return this.primitiveType(this.primitiveOf(type) ?? 'Int');
    return type;
  }

  // Local functions.

  /**
   * Declares a local function, which calls find from the scope it is declared in. Running the declaration captures
   * what the function reads, in a slot of the frame declaring it, which a call finds by following the frames that
   * created the caller's frame.
   */
  // code-gauge-allow functionNcss -- the parts of the construct this function compiles follow one another, and splitting them would only rename them.
  protected compileLocalFunction(scope: Scope, context: FunctionContext, decl: FunctionDecl): Exec {
    this.validateAnnotations(scope, decl.modifiers, annotationSite(['FUNCTION'], decl.receiver ? ['receiver'] : []));
    this.rejectLocalModifiers(decl.modifiers.keywords, decl.row, 'ローカル関数');
    // kotlinc does not inline functions declared in function bodies, though it does their classes' members.
    if (decl.modifiers.keywords.has('inline')) this.error(decl.row, 'ローカル関数には inline 修飾子を付けられません。');
    const symbol = new FunctionSymbol(decl.name);
    symbol.isSuspend = decl.modifiers.keywords.has('suspend');
    symbol.row = decl.row;
    symbol.isLibrary = context.info.isLibrary;
    symbol.isInline = false;
    symbol.isInfix = decl.modifiers.keywords.has('infix');
    symbol.isOperator = decl.modifiers.keywords.has('operator');
    const functionContext = new FunctionContext(context, false, decl.name, context.info.isLibrary, undefined);
    Object.defineProperty(functionContext, 'returnTarget', { value: functionContext });
    functionContext.label = decl.name;
    const functionScope = new Scope(scope, functionContext);
    symbol.typeParameters = this.declareTypeParameters(functionScope, decl.typeParameters);
    if (decl.receiver) {
      symbol.extensionReceiver = this.resolveType(functionScope, decl.receiver);
      functionScope.receiver = new ReceiverSymbol(symbol.extensionReceiver, functionContext, undefined, decl.name);
    }
    symbol.params = decl.params.map((param) => this.localParameter(functionScope, param));
    this.rejectDuplicateNames(decl.params);
    if (decl.returnType) symbol.returnType = this.resolveType(functionScope, decl.returnType);
    else if (decl.body?.kind !== 'expression') symbol.returnType = this.unitType;
    if (!decl.body) this.error(decl.row, `関数 ${decl.name} に本体を書いてください。`);
    const existing = scope.functions.get(decl.name) ?? [];
    this.checkLocalOverload(existing, symbol, decl.row);
    scope.functions.set(decl.name, [...existing, symbol]);
    const envVariable = this.newVariable(
      scope,
      context,
      `\0localFunction:${decl.name}:${decl.row}`,
      this.anyNullableType,
      false,
      decl.row,
      false
    );
    const envSlot = envVariable.slot;
    symbol.localEnv = envVariable;
    const outerFlow = this.flow;
    this.flow = outerFlow.copy();
    this.forgetAssignedIn(
      scope,
      decl.body?.kind === 'block' ? decl.body.block.statements : (decl.body?.expression as Expression)
    );
    let run: Eval | undefined;
    let suspendRun: ((frame: Frame) => Suspension) | undefined;
    try {
      if (symbol.isSuspend) suspendRun = this.compileLocalSuspendBody(functionScope, functionContext, decl, symbol);
      else run = this.compileLocalFunctionBody(functionScope, functionContext, decl, symbol);
    } finally {
      this.flow = outerFlow;
    }
    const build = this.captureBuilder(context, functionContext);
    symbol.defaultsInfo = functionContext.info;
    bindLocalFunction(
      symbol,
      { declaringInfo: context.info, info: functionContext.info, envVariable },
      run,
      suspendRun
    );
    return storeLocalEnv(envSlot, build);
  }

  // code-gauge-allow functionNcss -- the parts of the construct this function compiles follow one another, and splitting them would only rename them.
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  // code-gauge-allow duplicateLines -- the copies compile the same Kotlin construct in different contexts, whose differences sit between the shared lines.
  private compileLocalFunctionBody(
    scope: Scope,
    context: FunctionContext,
    decl: FunctionDecl,
    symbol: FunctionSymbol
  ): Eval {
    const variables = symbol.params.map((param, index) => {
      const variable = this.newParameter(
        scope,
        context,
        param.name,
        param.isVararg ? this.varargType(param.type) : param.type,
        decl.params[index].row
      );
      this.flow.assigned.add(variable);
      return variable;
    });
    const defaults = this.compileParameterDefaults(decl.params, symbol.params, variables, scope, context);
    const body = decl.body as NonNullable<FunctionDecl['body']>;
    let evaluate: Eval;
    if (body.kind === 'expression') {
      if (symbol.returnType) {
        context.returnType = symbol.returnType;
        context.returnRepr = returnRepr(symbol);
      }
      const compiled = this.compileExpression(scope, context, body.expression, symbol.returnType);
      symbol.returnType ??= this.inferredValueType(compiled);
      const returnType = symbol.returnType;
      const misfit = context.returnedTypes.find((type) => !isSubtype(type, returnType));
      if (misfit) this.error(body.expression.row, typeMismatchMessage(returnType, misfit));
      for (const settle of context.inferredReturns) settle(returnRepr(symbol));
      context.returnType = returnType;
      evaluate = convertRepr(
        this.expectType(compiled, returnType, body.expression.row),
        reprOf(this.core, returnType),
        returnRepr(symbol)
      );
    } else {
      const returnType = symbol.returnType as KType;
      context.returnType = returnType;
      context.returnRepr = returnRepr(symbol);
      const compiled = this.compileStatementsValue(scope, context, body.block.statements, undefined, true, false);
      if (!isNonNullClass(returnType, this.core.unit) && !this.flow.isDead)
        this.error(body.block.endRow, `関数 ${symbol.name} の最後に return を書いてください。`);
      const statements = compiled.eval;
      evaluate = (frame) => (statements(frame), UNIT);
    }
    if (!defaults.some((each) => each !== undefined)) return evaluate;
    return (frame) => {
      for (const [index, fill] of defaults.entries()) {
        if (fill && frame.locals[index] === MISSING) frame.locals[index] = fill(frame);
      }
      return evaluate(frame);
    };
  }

  private localParameter(scope: Scope, param: FunctionDecl['params'][number]): ParameterSymbol {
    this.validateAnnotations(scope, param.modifiers, annotationSite(['VALUE_PARAMETER']));
    if (!param.type) this.error(param.row, `引数 ${param.name} の型を書いてください。`);
    return {
      name: param.name,
      type: this.resolveType(scope, param.type),
      hasDefault: param.defaultValue !== undefined,
      isVararg: param.modifiers.keywords.has('vararg'),
      blocksNonlocalControl: false,
    };
  }

  private checkLocalOverload(existing: FunctionSymbol[], symbol: FunctionSymbol, row: number): void {
    for (const other of existing) {
      if (other.params.length !== symbol.params.length) continue;
      const same = other.params.every((param, index) => isSameType(param.type, symbol.params[index].type));
      const sameReceiver =
        (other.extensionReceiver === undefined) === (symbol.extensionReceiver === undefined) &&
        (!other.extensionReceiver ||
          !symbol.extensionReceiver ||
          isSameType(other.extensionReceiver, symbol.extensionReceiver));
      if (same && sameReceiver) this.error(row, `同じ引数の型の関数 ${symbol.name} が2回宣言されています。`);
    }
  }

  protected compileLocalClass(scope: Scope, context: FunctionContext, decl: ClassDecl): Exec {
    if (decl.classKind === 'object') this.error(decl.row, '関数の中には、名前のある object を宣言できません。');
    if (decl.classKind === 'enum') this.error(decl.row, '関数の中には、enum class を宣言できません。');
    const misplaced = [...decl.modifiers.keywords].find((keyword) => LOCAL_CLASS_FORBIDDEN_MODIFIERS.has(keyword));
    if (misplaced) this.error(decl.row, `ローカルクラスには ${misplaced} 修飾子を付けられません。`);
    if (scope.classes.has(decl.name)) this.error(decl.row, `クラス ${decl.name} が2回宣言されています。`);
    return this.compileClassHere(scope, context, decl, false).store;
  }

  /** `object : Base(), I { ... }`, which declares an anonymous class and creates its one instance. */
  protected compileObjectExpression(
    scope: Scope,
    context: FunctionContext,
    expression: Extract<Expression, { kind: 'object' }>
  ): Compiled {
    const { entry, store } = this.compileClassHere(scope, context, expression.decl, true);
    const ctor = entry.constructorSymbol as FunctionSymbol;
    const { row } = expression;
    return {
      type: entry.symbol.type,
      repr: 'ref',
      eval: (frame) => {
        store(frame);
        return (ctor.invoke as NonNullable<FunctionSymbol['invoke']>)(frame, undefined, [], row);
      },
      isCreation: true,
    };
  }

  /**
   * Declares and compiles a class where a function body or an object expression declares it. Running `store` captures
   * what the class's members read, in a slot of the frame running the declaration, from which instances take it.
   */
  private compileClassHere(
    scope: Scope,
    context: FunctionContext,
    decl: ClassDecl,
    isAnonymous: boolean
  ): { entry: ClassEntry; store: Exec } {
    const captureContext = new FunctionContext(context, false, decl.name, context.info.isLibrary, undefined);
    const envVariable = this.newVariable(
      scope,
      context,
      `\0localClass:${decl.name}:${decl.row}`,
      this.anyNullableType,
      false,
      decl.row,
      false
    );
    const local = { context: captureContext, declaringInfo: context.info, envVariable };
    const entries = this.declareClassInScope(decl, scope, isAnonymous, (declared) => {
      for (const each of declared) {
        if (each !== declared[0] && !each.symbol.isInner)
          this.error(each.decl.row, 'ローカルクラスの中には、inner でないクラスを宣言できません。');
        this.localClasses.set(each.symbol, local);
        each.symbol.localEnv = envVariable;
      }
    });
    this.compileClassesInScope(entries);
    const build = this.captureBuilder(context, captureContext);
    return { entry: entries[0], store: storeLocalEnv(envVariable.slot, build) };
  }

  protected abstract compileLocalSuspendBody(
    scope: Scope,
    context: FunctionContext,
    decl: FunctionDecl,
    symbol: FunctionSymbol
  ): (frame: Frame) => Suspension;

  /** Rejects the modifiers that a declaration in a function body cannot have. */
  protected rejectLocalModifiers(keywords: ReadonlySet<string>, row: number, what: string): void {
    const misplaced = [...keywords].find((keyword) => LOCAL_FORBIDDEN_MODIFIERS.has(keyword));
    if (misplaced) this.error(row, `${what}には ${misplaced} 修飾子を付けられません。`);
  }
}

/** The modifiers kotlinc rejects on a class declared in a function body. */
const LOCAL_CLASS_FORBIDDEN_MODIFIERS = new Set([
  'private',
  'protected',
  'internal',
  'public',
  'inner',
  'companion',
  'annotation',
  'value',
  'const',
  'lateinit',
  'override',
]);

/** The modifiers kotlinc rejects on a function or class declared in a function body. */
const LOCAL_FORBIDDEN_MODIFIERS = new Set([
  'private',
  'protected',
  'internal',
  'public',
  'open',
  'abstract',
  'override',
  'final',
  'const',
  'lateinit',
  'inner',
  'companion',
]);

/**
 * Runs the declaration of a local function or class: it stores what it makes before building what the code captures,
 * so that the code, which captures it to call itself, sees it.
 */
function storeLocalEnv(slot: number, build: (frame: Frame) => unknown[]): Exec {
  return (frame) => {
    const env: LocalEnv = { captured: [], declaring: frame };
    frame.locals[slot] = env as unknown as Value;
    env.captured = build(frame);
  };
}

/** A local function's calls, which run its body with what its declaration captured in the frame that ran it. */
function bindLocalFunction(
  symbol: FunctionSymbol,
  {
    declaringInfo,
    info,
    envVariable,
  }: { declaringInfo: Frame['info']; info: Frame['info']; envVariable: VariableSymbol },
  run: Eval | undefined,
  suspendRun: ((frame: Frame) => Suspension) | undefined
): void {
  const declared = (caller: Frame): { declaring: Frame; env: unknown[] } => {
    const { captured, declaring } = localEnvOf(caller, envVariable, declaringInfo, envVariable.slot);
    return { declaring, env: captured };
  };
  if (suspendRun) {
    symbol.invokeSuspend = (caller, receiver, args, callRow) => {
      const { declaring, env } = declared(caller);
      return caller.runtime.callSuspend(info, caller, env, receiver, args, callRow, suspendRun, declaring);
    };
    return;
  }
  const body = run as Eval;
  symbol.invoke = (caller, receiver, args, callRow) => {
    const { declaring, env } = declared(caller);
    return caller.runtime.call(info, caller, env, receiver, args, callRow, body, declaring);
  };
}

/** The candidates that are not overridden by another one, as a class's override hides what it overrides. */
function uniqueRoots(candidates: Candidate[]): Candidate[] {
  const seen = new Set<unknown>();
  return candidates.filter(({ symbol }) => {
    if (seen.has(symbol.root)) return false;
    seen.add(symbol.root);
    return true;
  });
}

function parameterName(index: number): string {
  return `${REFERENCE_PARAMETER}${index}`;
}

/** The lambda a reference stands for, which calls or reads its target with the lambda's parameters. */
function referenceLambda(
  target: ReferenceTarget,
  name: string,
  arity: number,
  row: number,
  isProperty: boolean
): LambdaExpression {
  const names = Array.from({ length: arity }, (_, index) => parameterName(index));
  const argument = (parameter: string): Expression => ({ kind: 'name', row, name: parameter });
  const receiverName = target.kind === 'unbound' ? names[0] : target.kind === 'bound' ? BOUND_RECEIVER : undefined;
  const values = target.kind === 'unbound' ? names.slice(1) : names;
  const callee: Expression = receiverName
    ? { kind: 'member', row, receiver: argument(receiverName), name, isSafe: false }
    : { kind: 'name', row, name };
  const body: Expression = isProperty
    ? callee
    : {
        kind: 'call',
        row,
        callee,
        typeArgs: [],
        args: values.map((value) => ({ row, name: undefined, value: argument(value), isSpread: false })),
        trailingLambda: undefined,
      };
  return syntheticLambda(names, [{ kind: 'expressionStatement', row, expression: body }], row);
}

/** The lambda that assigns a mutable property's reference, as `set` of a `KMutableProperty` does. */
function referenceSetterLambda(target: ReferenceTarget, name: string, row: number): LambdaExpression {
  const arity = target.kind === 'unbound' ? 2 : 1;
  const names = Array.from({ length: arity }, (_, index) => parameterName(index));
  const receiverName = target.kind === 'unbound' ? names[0] : target.kind === 'bound' ? BOUND_RECEIVER : undefined;
  const place: Expression = receiverName
    ? { kind: 'member', row, receiver: { kind: 'name', row, name: receiverName }, name, isSafe: false }
    : { kind: 'name', row, name };
  return syntheticLambda(
    names,
    [
      {
        kind: 'assignment',
        row,
        operator: '=',
        target: place,
        value: { kind: 'name', row, name: names.at(-1) as string },
      },
    ],
    row
  );
}

function syntheticLambda(names: string[], statements: Statement[], row: number): LambdaExpression {
  return {
    kind: 'lambda',
    row,
    endRow: row,
    label: undefined,
    params: names.map((name) => ({ row, name, type: undefined })),
    statements,
  };
}
