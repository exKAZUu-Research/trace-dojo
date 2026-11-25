// code-gauge-allow-file fileNcss -- Keeps function signatures, body checking, and parameter flow together.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { awaitedType } from './awaited';
import type { Checker } from './checker';
import { contextualSignatureOf } from './contextualSignatures';
import { FlowState, type State } from './flow';
import { returnedLiteralType } from './returnLiterals';
import type { Sym } from './scopes';
import { isContextSensitiveFunction, parameterNodes } from './signatures';
import {
  argumentParameters,
  hasToken,
  isClassConstructor,
  isInlinedInvocation,
  named,
  patternIdentifiers,
  propertyNameText,
} from './syntax';
import {
  anyType,
  errorType,
  functionType,
  isAnyLike,
  isIntrinsic,
  neverType,
  type Signature,
  type Type,
  undefinedType,
  unionOf,
  unknownType,
  voidType,
} from './types';
import { checkVarianceAnnotations } from './varianceAnnotations';
import { checkWrittenType } from './writtenTypes';

/** What checking a function's body found about how it returns. */
export interface FunctionContext {
  node: TreeNode;
  returnTypes: Type[];
  /** Whether the end of the body is reachable, where the function returns `undefined`. */
  endReachable: boolean;
  declaredReturn?: Type;
  isConstructor: boolean;
  hasReturnWithValue: boolean;
  /** Whether the body has a `return;`, even an unreachable one, which adds `undefined` to returned values. */
  hasReturnWithoutValue: boolean;
  /** The flow states at its `return` statements. */
  returnStates: State[];
  contextualReturn?: Type;
  /** Whether an expression the function returns is being checked, where its own return type cannot be used. */
  inReturn?: boolean;
  /** Whether its body continues the enclosing flow, as that of a function called where it is written does. */
  inlined?: boolean;
  initializer?: boolean;
  enclosingFlow: State;
  generator?: GeneratorContext;
  /** For an async function, its return type annotation, which must be a `Promise` of what its body returns. */
  asyncAnnotation?: { type: Type; isPromise: boolean };
  isAsync: boolean;
}

/** What a generator's annotation or contextual type says it yields, returns, and receives, and what it yields. */
interface GeneratorContext {
  /** The return type annotation, which the generator's type is. */
  annotation?: Type;
  /** Whether the annotation is no iterator type, which TypeScript then checks the generator's own type against. */
  invalidAnnotation: boolean;
  yieldType?: Type;
  nextType?: Type;
  yieldTypes: Type[];
}

export interface IterationTypes {
  yieldType: Type;
  returnType: Type;
  nextType: Type;
}

/** The library types a generator's return type may be, whose type arguments are what it yields, returns, and receives. */
const generatorReturnTypes = ['Generator', 'Iterator', 'Iterable', 'IterableIterator', 'IteratorObject'];
const asyncGeneratorReturnTypes = [
  'AsyncGenerator',
  'AsyncIterator',
  'AsyncIterable',
  'AsyncIterableIterator',
  'AsyncIteratorObject',
];

/** Whether a function is a generator: `function*`, or a method written `*m()`. */
export function isGeneratorFunction(node: TreeNode): boolean {
  return node.type.startsWith('generator_function') || (node.type === 'method_definition' && hasToken(node, '*'));
}

/** The declarations that may follow an overload: another overload or its implementation. */
const overloadFollowerTypes = new Set([
  'function_signature',
  'function_declaration',
  'generator_function_declaration',
  'method_signature',
  'method_definition',
]);

/** Checks function expressions and bodies, inferring the types they return. */
export class FunctionChecker {
  /** The functions whose bodies are being checked, innermost last. */
  readonly contexts: FunctionContext[] = [];
  /** The functions without a return type annotation that their own return expressions use. */
  private readonly circular = new Set<number>();
  /** The narrowed types of variables when each function being checked was created. */
  readonly capturedTypes: Map<string, Type>[] = [];
  /** Parameter types of functions checked with a contextual signature, by symbol. */
  readonly parameterTypes = new Map<number, Type>();
  private readonly inferring = new Set<number>();
  private readonly inferredReturns = new Map<number, Type>();
  /** The flow at the `return` statements of each checked function body whose end no path reaches, by function. */
  private readonly returnFlows = new Map<number, FlowState>();

  constructor(private readonly c: Checker) {}

  /** The innermost function whose flow the checked code follows, which an inlined function body shares. */
  flowOwner(): TreeNode | undefined {
    return this.contexts.findLast((context) => !context.inlined)?.node;
  }

  // code-gauge-allow functionNcss -- Builds an expression signature and schedules its body where its call executes.
  functionExpression(node: TreeNode, contextual?: Type): Type {
    contextual = this.c.overloadContexts.contextOf(node, contextual);
    const preview = this.c.overloadContexts.previewType(node, contextual);
    if (preview) return preview;
    const contextualSignature = isAnyLike(contextual ?? unknownType)
      ? this.anySignature()
      : contextualSignatureOf(this.c, contextual, node);
    const signature = this.c.signatures.signatureOf(node, contextualSignature, false);
    if (node.type !== 'arrow_function' && isContextSensitiveFunction(node))
      this.c.classes.registerContextualThis(node, contextualSignature?.thisType);
    // Parameters take their types from the signature, which the body sees.
    this.bindParameters(node, signature);
    const contextualReturn = contextualSignature ? contextualSignature.returnType() : undefined;
    const declaredReturn = this.declaredReturnType(node);
    const immediate = isInlinedInvocation(node);
    let returnType = declaredReturn;
    const typed: Signature = {
      ...signature,
      returnType: () => {
        if (!returnType && immediate)
          return this.c.flow.probe(() =>
            this.c.silently(() => this.checkFunctionBody(node, signature, contextualReturn, false))
          );
        returnType ??= this.checkFunctionBody(node, signature, contextualReturn, true);
        return returnType;
      },
      checkImmediateBody: immediate
        ? () => {
            const checked = this.checkFunctionLike(node, signature, contextualSignature);
            returnType = declaredReturn ?? checked;
          }
        : undefined,
    };
    if (!declaredReturn && !signature.predicate) this.addInferredPredicate(node, typed);
    const type = functionType(typed);
    const ownName = node.childForFieldName('name');
    const self = ownName ? this.c.ownScope(node)?.lookupValue(ownName.text) : undefined;
    if (self?.valueDeclaration?.id === node.id) self.valueType = type;
    if (!immediate) this.checkFunctionLike(node, signature, contextualSignature);
    return type;
  }

  addInferredPredicate(node: TreeNode, signature: Signature): void {
    let predicate: { inferred: Signature['predicate'] } | undefined;
    let resolving = false;
    Object.defineProperty(signature, 'predicate', {
      get: (): Signature['predicate'] => {
        if (resolving) return undefined;
        resolving = true;
        try {
          predicate ??= { inferred: this.inferredPredicate(node, signature) };
          return predicate.inferred;
        } finally {
          resolving = false;
        }
      },
      enumerable: true,
    });
  }

  /**
   * The type predicate TypeScript 5.5 infers for a function whose only return gives a boolean condition on a parameter,
   * as `(x) => x !== null` is `(x) => x is T`: the condition, checked after the flow up to the return, is true only
   * where the parameter is a `T`, which it is false of nowhere.
   */
  inferredPredicate(node: TreeNode, signature: Signature): Signature['predicate'] {
    const returned = this.singleReturnedExpression(node);
    if (!returned || !isBooleanLike(this.c.silently(() => signature.returnType()))) return undefined;
    // An expression body starts where the function does; a `return` follows the flow of the body before it.
    const start = returned.parent?.type === 'return_statement' ? this.returnFlows.get(node.id) : new FlowState();
    if (!start) return undefined;
    const parametersNode = node.childForFieldName('parameters');
    const names = parametersNode
      ? named(parametersNode).map((parameter) => parameter.childForFieldName('pattern') ?? parameter)
      : [node.childForFieldName('parameter')];
    for (const [index, name] of names.entries()) {
      const parameter = signature.parameters[index];
      if (name?.type !== 'identifier' || !parameter || parameter.rest) continue;
      const symbol = this.c.scopeOf(name).lookupValue(name.text);
      if (!symbol || symbol.isReassigned) continue;
      const trueType = this.refinedType(returned, start, `s${symbol.id}`, parameter.type);
      if (trueType) return { index, type: trueType };
    }
    return undefined;
  }

  /** TypeScript's `checkIfExpressionRefinesParameter`: what a reference is where `condition` is true, if only that. */
  private refinedType(condition: TreeNode, start: FlowState, key: string, declared: Type): Type | undefined {
    const trueType = this.narrowedByCondition(condition, start, key, declared, true);
    if (this.c.relations.identical(trueType, declared)) return undefined;
    const trueStart = start.clone();
    trueStart.entries.set(key, { type: trueType, assigned: true });
    const falseType = this.narrowedByCondition(condition, trueStart, key, trueType, false);
    return isIntrinsic(falseType, 'never') ? trueType : undefined;
  }

  /** The type of the reference `key` where `condition`, checked from `start`, is `assumeTrue`. */
  private narrowedByCondition(
    condition: TreeNode,
    start: FlowState,
    key: string,
    type: Type,
    assumeTrue: boolean
  ): Type {
    const outer = this.c.flow.current;
    this.c.flow.current = start.clone();
    try {
      const { whenTrue, whenFalse } = this.c.silently(() => this.c.conditions.condition(condition, false));
      const state = assumeTrue ? whenTrue : whenFalse;
      return state ? (state.entries.get(key)?.type ?? type) : neverType;
    } finally {
      this.c.flow.current = outer;
    }
  }

  /**
   * The expression a function returns when that is all it returns, from which TypeScript infers a type predicate: an
   * arrow's expression body, or that of the only `return` of a body.
   */
  private singleReturnedExpression(node: TreeNode): TreeNode | undefined {
    const body = node.childForFieldName('body');
    if (!body) return undefined;
    if (body.type !== 'statement_block') return body;
    const returns = returnStatements(body);
    return returns.length === 1 ? named(returns[0])[0] : undefined;
  }

  private anySignature(): Signature {
    return {
      typeParameters: [],
      parameters: [{ name: 'args', type: this.c.arrayType(anyType), optional: false, rest: true }],
      returnType: () => anyType,
    };
  }

  declaredReturnType(node: TreeNode): Type | undefined {
    const returnNode = node.childForFieldName('return_type');
    return returnNode ? this.c.typeNodes.annotationType(returnNode) : this.c.signatures.pairedSetterType(node);
  }

  /** Records the types of a function's parameters for its body. */
  // code-gauge-allow functionCognitiveComplexity -- Records each form of parameter: a name, a rest parameter, or a pattern.
  bindParameters(node: TreeNode, signature: Signature): void {
    const scope = this.c.ownScope(node);
    if (!scope) return;
    const parametersNode = node.childForFieldName('parameters');
    const parameterNodes = parametersNode ? argumentParameters(named(parametersNode)) : [];
    const single = node.childForFieldName('parameter');
    if (single) parameterNodes.push(single);
    for (const [index, parameterNode] of parameterNodes.entries()) {
      const pattern = parameterNode.childForFieldName('pattern') ?? parameterNode;
      const type = this.sourceParameterType(parameterNode, pattern, signature, index);
      if (!type) continue;
      const bound = pattern.type === 'rest_pattern' ? named(pattern)[0] : pattern;
      if (
        (bound.type === 'object_pattern' || bound.type === 'array_pattern') &&
        patternIdentifiers(bound).every((identifier) => !scope.values.get(identifier.text)?.isReassigned)
      )
        this.c.patterns.correlatedSources.set(bound.id, type);
      if (pattern.type === 'identifier') {
        const symbol = scope.values.get(pattern.text);
        if (symbol) this.parameterTypes.set(symbol.id, type);
      } else {
        this.c.silently(() =>
          this.c.patterns.bindPattern(
            bound,
            type,
            (identifier, identifierType) => {
              const symbol = scope.values.get(identifier.text);
              if (symbol) this.parameterTypes.set(symbol.id, identifierType);
            },
            {
              annotated: parameterNode.childForFieldName('type') !== null,
              parameter: true,
            }
          )
        );
      }
    }
  }

  private sourceParameterType(
    node: TreeNode,
    pattern: TreeNode,
    signature: Signature,
    index: number
  ): Type | undefined {
    const parameter = signature.parameters[index];
    if (pattern.type === 'rest_pattern') {
      const annotation = this.c.typeNodes.annotationType(node.childForFieldName('type'));
      if (annotation) return annotation;
      if (parameter?.rest) return parameter.type;
      return this.c.tupleType(
        signature.parameters.slice(index).map((entry) => ({
          type: entry.type,
          optional: entry.optional,
          rest: entry.rest,
        }))
      );
    }
    if (!parameter) return undefined;
    if (node.childForFieldName('value')) {
      // A pattern destructures the default in place of `undefined`, which a parameter before a required one admits
      // for callers; a name narrows by its flow instead.
      return pattern.type === 'identifier'
        ? parameter.type
        : this.c.relations.removeUndefined(parameter.bindingType ?? parameter.type);
    }
    return parameter.optional ? unionOf([parameter.type, undefinedType]) : parameter.type;
  }

  /** The return type of a function without an annotation, from checking its body silently. */
  inferredReturnType(node: TreeNode, signature: Signature): Type {
    const cached = this.inferredReturns.get(node.id);
    if (cached) return cached;
    if (this.inferring.has(node.id)) {
      // Only a use in what the function returns makes its type circular; the error shows once the body is checked.
      if (this.contexts.some((context) => context.node.id === node.id && context.inReturn)) this.circular.add(node.id);
      return anyType;
    }
    this.inferring.add(node.id);
    try {
      this.bindParameters(node, signature);
      const type = this.c.silently(() => this.checkFunctionBody(node, signature, undefined, true));
      this.inferredReturns.set(node.id, type);
      return type;
    } finally {
      this.inferring.delete(node.id);
    }
  }

  /**
   * Checks a function's body, returning the type it returns. The body starts from a fresh flow, but that of a function
   * called where it is written continues the enclosing flow, which goes on from where the body ends, as in tsc.
   *
   * @param isolated Whether to check without the enclosing flow, as when inferring the return type ahead.
   */
  checkFunctionBody(node: TreeNode, signature: Signature, contextualReturn: Type | undefined, isolated: boolean): Type {
    if (this.reentersBody(node)) return anyType;
    const body = node.childForFieldName('body');
    const context = this.newContext(node, contextualReturn, this.declaredReturnType(node));
    this.bindParameters(node, signature);
    this.contexts.push(context);
    this.capturedTypes.push(this.capture());
    const outer = this.c.flow.current;
    const inlined = !isolated && isInlinedInvocation(node);
    context.inlined = inlined;
    this.c.flow.current = inlined ? outer?.clone() : this.c.classes.initialFlow(node);
    this.c.statements.declareHoistedVariables(this.c.ownScope(node));
    this.narrowDefaultedParameters(node);
    try {
      if (!body) return anyType;
      this.checkBody(body, context);
      this.recordReturnFlow(context);
      this.checkBodyReturns(context);
      if (this.circular.has(node.id) && this.c.silent === 0) this.reportCircularReturn(node);
      if (context.isConstructor && node.parent?.parent) {
        this.c.classDeclarations.checkPropertyInitialization(
          node.parent.parent,
          node,
          this.c.flow.current,
          context.returnStates
        );
      }
      return this.returnTypeOf(context);
    } finally {
      this.c.flow.current = inlined ? this.c.flow.merge([this.c.flow.current, ...context.returnStates]) : outer;
      this.contexts.pop();
      this.capturedTypes.pop();
    }
  }

  private checkBodyReturns(context: FunctionContext): void {
    const { node, declaredReturn, generator, asyncAnnotation } = context;
    if (generator?.invalidAnnotation && generator.annotation) {
      const own = this.c.globalType(context.isAsync ? 'AsyncGenerator' : 'Generator', [anyType, anyType, unknownType]);
      this.c.expressions.reportNotAssignable(node.childForFieldName('return_type') ?? node, own, generator.annotation);
    }
    if (asyncAnnotation && !asyncAnnotation.isPromise)
      this.c.error(
        node.childForFieldName('return_type') ?? node,
        `async 関数やメソッドの戻り値の型は、グローバルな Promise<T> 型でなければいけません。'Promise<${this.c.print(asyncAnnotation.type)}>' と書くつもりでしたか？`
      );
    if (declaredReturn) this.checkMissingReturn(node, context, declaredReturn);
    if (hasToken(node, 'get') && context.endReachable && !context.returnStates.some((state) => state && !state.dead))
      this.c.error(node.childForFieldName('name') ?? node, 'get アクセサーは値を返さなければいけません。');
  }

  markCircularReturn(): void {
    const context = this.contexts.at(-1);
    if (context?.inReturn && !context.declaredReturn) this.circular.add(context.node.id);
  }

  private reportCircularReturn(node: TreeNode): void {
    const name = node.childForFieldName('name');
    this.c.error(
      name ?? node,
      `${name?.text ?? 'この関数'} は、戻り値の式で自分自身を参照しているため、戻り値の型が暗黙に any になります。戻り値の型を書いてください。`
    );
  }

  private recordReturnFlow(context: FunctionContext): void {
    if (context.endReachable) {
      this.returnFlows.delete(context.node.id);
      return;
    }
    // A loop checks its body again, which gives a `return` in it a state for each pass; a silent check of a loop that
    // reuses the exits of an earlier one sees no `return`, so the earlier check's flow stays.
    const state = this.c.flow.merge(context.returnStates);
    if (state) this.returnFlows.set(context.node.id, state);
  }

  /** A parameter named by an identifier starts without `undefined` when its default value cannot be `undefined`. */
  private narrowDefaultedParameters(node: TreeNode): void {
    const parametersNode = node.childForFieldName('parameters');
    const scope = this.c.ownScope(node);
    if (!parametersNode || !scope) return;
    for (const parameterNode of named(parametersNode)) {
      const pattern = parameterNode.childForFieldName('pattern');
      const value = parameterNode.childForFieldName('value');
      const symbol = pattern?.type === 'identifier' ? scope.values.get(pattern.text) : undefined;
      if (!value || !symbol) continue;
      const declared = this.c.expressions.valueTypeOf(symbol);
      if (!mayBeUndefined(declared)) continue;
      if (
        this.c.patterns.defaultMayBeUndefined(this.c.silently(() => this.c.patterns.initializerType(value, declared)))
      )
        continue;
      this.c.flow.set(`s${symbol.id}`, { type: this.c.relations.removeUndefined(declared), assigned: true });
    }
  }

  private reentersBody(node: TreeNode): boolean {
    const activeIndex = this.contexts.findIndex((context) => !context.initializer && context.node.id === node.id);
    if (activeIndex === -1) return false;
    const recursive = this.contexts.slice(activeIndex);
    if (recursive.some((context) => context.inReturn))
      for (const context of recursive) this.circular.add(context.node.id);
    return true;
  }

  private checkBody(body: TreeNode, context: FunctionContext): void {
    if (body.type === 'statement_block') {
      this.c.statements.checkBlockStatements(named(body));
      context.endReachable = this.c.flow.isReachable && !this.c.flow.current?.dead;
      return;
    }
    const { declaredReturn } = context;
    context.inReturn = true;
    const checked = this.c.expressions.check(body, declaredReturn ?? context.contextualReturn);
    const expressionType = context.isAsync ? awaitedType(this.c, checked) : checked;
    context.inReturn = false;
    if (declaredReturn) this.c.expressions.checkReturnValue(body, expressionType, declaredReturn);
    context.returnTypes.push(expressionType);
    context.endReachable = false;
    context.hasReturnWithValue = true;
  }

  private newContext(node: TreeNode, contextualReturn?: Type, declaredReturn?: Type): FunctionContext {
    const isAsync = hasToken(node, 'async');
    const returns = isGeneratorFunction(node)
      ? this.generatorReturns(isAsync, contextualReturn, declaredReturn)
      : isAsync
        ? this.asyncReturns(contextualReturn, declaredReturn)
        : { declaredReturn, contextualReturn };
    return {
      ...returns,
      isAsync,
      node,
      returnTypes: [],
      endReachable: true,
      isConstructor: isClassConstructor(node),
      hasReturnWithValue: false,
      hasReturnWithoutValue: false,
      returnStates: [],
      enclosingFlow: this.c.flow.current,
    };
  }

  /** What an async function's `return` statements give: what the promise it returns fulfills with. */
  private asyncReturns(
    contextualReturn: Type | undefined,
    declaredReturn: Type | undefined
  ): Pick<FunctionContext, 'asyncAnnotation' | 'declaredReturn' | 'contextualReturn'> {
    const contextual = contextualReturn && awaitedType(this.c, contextualReturn);
    if (!declaredReturn) return { contextualReturn: contextual };
    const isPromise = isAnyLike(declaredReturn) || this.c.isLibraryType(declaredReturn, 'Promise');
    return {
      asyncAnnotation: { type: declaredReturn, isPromise },
      declaredReturn: isPromise ? awaitedType(this.c, declaredReturn) : anyType,
      contextualReturn: contextual,
    };
  }

  /** What a generator yields, returns, and receives, by its annotation or else its contextual type. */
  private generatorReturns(
    isAsync: boolean,
    contextualReturn: Type | undefined,
    declaredReturn: Type | undefined
  ): Pick<FunctionContext, 'generator' | 'declaredReturn' | 'contextualReturn'> {
    const declared = declaredReturn && this.iterationTypesOf(declaredReturn, isAsync);
    const contextualTypes =
      !declaredReturn && contextualReturn ? this.iterationTypesOf(contextualReturn, isAsync) : undefined;
    const given = declaredReturn ? (declared ?? anyIterationTypes) : contextualTypes;
    return {
      generator: {
        annotation: declaredReturn,
        invalidAnnotation: declaredReturn !== undefined && !declared,
        yieldType: given?.yieldType,
        nextType: given?.nextType,
        yieldTypes: [],
      },
      declaredReturn: declaredReturn && given?.returnType,
      contextualReturn: contextualTypes?.returnType,
    };
  }

  private capture(): Map<string, Type> {
    const outer = this.capturedTypes.at(-1);
    const captured = outer ? new Map(outer) : new Map<string, Type>();
    for (const [key, entry] of this.c.flow.current?.entries ?? []) {
      if (key.startsWith('s') && !key.includes('.') && entry.assigned) captured.set(key, entry.type);
    }
    return captured;
  }

  private returnTypeOf(context: FunctionContext): Type {
    const { generator } = context;
    if (generator?.annotation) return generator.annotation;
    if (context.asyncAnnotation) return context.asyncAnnotation.type;
    if (generator) {
      const yielded = generator.yieldTypes.length === 0 ? neverType : unionOf(generator.yieldTypes, true);
      return this.c.globalType(context.isAsync ? 'AsyncGenerator' : 'Generator', [
        this.c.widen(this.widenObjectLiteral(yielded)),
        this.inferredReturnOf(context),
        generator.nextType ?? unknownType,
      ]);
    }
    if (context.declaredReturn) return context.declaredReturn;
    if (context.isAsync) return this.c.globalType('Promise', [this.inferredReturnOf(context)]);
    return this.inferredReturnOf(context);
  }

  /** The type a function's `return` statements give, without an annotation. */
  private inferredReturnOf(context: FunctionContext): Type {
    const types = this.c.literals.normalizeObjectLiterals(
      context.returnTypes.flatMap((type) => (type.kind === 'union' ? type.types : [type]))
    );
    // A function expression or an object literal method that never returns returns `never`; a declaration `void`.
    if (
      types.length === 0 &&
      !context.hasReturnWithoutValue &&
      !context.endReachable &&
      !context.generator &&
      mayReturnNever(context.node)
    )
      return neverType;
    if (types.length === 0 || !context.hasReturnWithValue) return voidType;
    if (context.endReachable || context.hasReturnWithoutValue) types.push(undefinedType);
    const type = unionOf(
      types.map((member) => this.widenObjectLiteral(member)),
      true
    );
    // TypeScript widens only a returned unit type, and keeps fresh the literals of a union it returns.
    return type.kind === 'literal' ? returnedLiteralType(this.c, type, context.contextualReturn) : type;
  }

  /** What a generator's return type says it yields, returns, and receives, or undefined when it is no iterator. */
  iterationTypesOf(type: Type, isAsync = false): IterationTypes | undefined {
    if (isAnyLike(type)) return anyIterationTypes;
    const names = isAsync ? asyncGeneratorReturnTypes : generatorReturnTypes;
    const name = names.find((candidate) => this.c.isLibraryType(type, candidate));
    if (!name || type.kind !== 'object') return undefined;
    const [yieldType = unknownType, returnType = anyType, nextType = anyType] = type.typeArguments ?? [];
    return { yieldType, returnType, nextType };
  }

  /**
   * The type of what a `yield` yields from, which an unannotated generator's type is inferred from, as from what it
   * returns: a use of the generator there makes its type circular.
   */
  private yieldOperandType(operand: TreeNode, delegated: boolean, context: FunctionContext | undefined): Type {
    const generator = context?.generator;
    if (!context || generator?.annotation)
      return this.c.expressions.check(operand, delegated ? undefined : generator?.yieldType);
    const wasInReturn = context.inReturn;
    context.inReturn = true;
    try {
      return this.c.expressions.check(operand, delegated ? undefined : generator?.yieldType);
    } finally {
      context.inReturn = wasInReturn;
    }
  }

  /**
   * `yield value` or `yield* iterable` in a generator, whose value is what the generator receives from `next()`, or the
   * return value of the iterable it delegates to.
   */
  yieldExpression(node: TreeNode, contextual: Type | undefined): Type {
    const context = this.contexts.at(-1);
    const generator = context?.generator;
    const isAsync = context?.isAsync === true;
    const operand = named(node).find((child) => child.type !== 'comment');
    const delegated = hasToken(node, '*');
    const operandType = operand ? this.yieldOperandType(operand, delegated, context) : undefinedType;
    if (!generator) return anyType;
    const yielded = this.yieldedType(operand, operandType, delegated, isAsync);
    generator.yieldTypes.push(yielded);
    // A contextual yield type only types the operand: the generator is checked against it as a whole, as tsc does.
    if (generator.annotation && generator.yieldType && yielded !== errorType)
      this.c.expressions.checkAssignable(operand ?? node, yielded, generator.yieldType, operand);
    if (delegated) return this.iterationTypesOf(operandType, isAsync)?.returnType ?? anyType;
    if (generator.nextType) return generator.nextType;
    if (!isResultUnused(node) && (!contextual || isAnyLike(contextual)))
      this.c.error(
        node,
        "'yield' 式の結果が暗黙に any になります。この式を含むジェネレーターに戻り値の型の注釈がないためです。"
      );
    return anyType;
  }

  /** What a `yield` yields: its operand, or with `yield*` what that iterates, awaited in an async generator. */
  private yieldedType(operand: TreeNode | undefined, type: Type, delegated: boolean, isAsync: boolean): Type {
    if (!delegated) return isAsync ? awaitedType(this.c, type) : type;
    return isAsync ? this.c.patterns.asyncIteratedType(operand, type) : this.c.patterns.iteratedType(operand, type);
  }

  private widenObjectLiteral(type: Type): Type {
    return this.c.literals.widenDeclared(type, true);
  }

  functionDeclaration(node: TreeNode): void {
    const name = node.childForFieldName('name');
    const symbol = name ? this.c.scopeOf(node).lookupValue(name.text) : undefined;
    const signature = this.c.signatures.signatureOf(node);
    this.checkFunctionLike(node, signature, undefined);
    if (symbol) this.checkOverloads(symbol, node, signature);
  }

  checkOverloadImplementation(node: TreeNode): void {
    if (this.c.isLibrary(node)) return;
    this.checkSignatureAnnotations(node);
    const { later, next } = followingDeclarations(node);
    // An optional method needs no implementation, unless a later declaration of the method follows.
    if (hasToken(node, '?') && !later.some((sibling) => this.declaresSameMethod(node, sibling))) return;
    const nextName = next?.childForFieldName('name');
    if (next && overloadFollowerTypes.has(next.type)) {
      if (this.matchingOverloadNames(node, next)) {
        this.checkOverloadModifiers(node, next);
        return;
      }
      const implementations =
        node.type === 'function_signature'
          ? ['function_declaration', 'generator_function_declaration']
          : ['method_definition'];
      if (implementations.includes(next.type)) {
        const expected = node.childForFieldName('name')?.text;
        this.c.error(nextName ?? next, `実装の名前は '${expected}' でなければいけません。`);
        return;
      }
    }
    this.c.error(node.childForFieldName('name') ?? node, '関数の実装がないか、宣言の直後にありません。');
  }

  /** An overload and the declaration after it, which must agree on being static and on being exported. */
  private checkOverloadModifiers(node: TreeNode, next: TreeNode): void {
    if (hasToken(next, 'static') !== hasToken(node, 'static'))
      this.c.error(
        next.childForFieldName('name') ?? next,
        'オーバーロードの static 修飾子は一致しなければいけません。'
      );
    if ((node.parent?.type === 'export_statement') !== (next.parent?.type === 'export_statement'))
      this.c.error(
        node.childForFieldName('name') ?? node,
        'オーバーロードのシグネチャはすべてがエクスポート済みであるか、またはエクスポート済みでない必要があります。'
      );
  }

  private declaresSameMethod(node: TreeNode, other: TreeNode): boolean {
    return (
      ['method_signature', 'method_definition'].includes(other.type) &&
      hasToken(other, 'static') === hasToken(node, 'static') &&
      this.matchingOverloadNames(node, other)
    );
  }

  private matchingOverloadNames(node: TreeNode, next: TreeNode): boolean {
    const name = node.childForFieldName('name');
    const nextName = next.childForFieldName('name');
    if (!name || !nextName) return false;
    const names = this.c.silently(() => this.c.patterns.propertyNames(name));
    const nextNames = this.c.silently(() => this.c.patterns.propertyNames(nextName));
    const lateBound = name.type === 'computed_property_name' && propertyNameText(name) === undefined;
    const nextLateBound = nextName.type === 'computed_property_name' && propertyNameText(nextName) === undefined;
    return names?.length === 1 && nextNames?.length === 1 && names[0] === nextNames[0] && (!lateBound || nextLateBound);
  }

  private checkOverloads(symbol: Sym, implementation: TreeNode, signature: Signature): void {
    const overloads = symbol.valueDeclarations
      .filter((declaration) => declaration.type === 'function_signature')
      .map((overload) => this.c.signatures.signatureOf(overload));
    this.checkOverloadCompatibility(signature, overloads, implementation);
  }

  checkOverloadCompatibility(signature: Signature, overloads: Signature[], implementation: TreeNode): void {
    for (const overload of overloads) {
      const declaration = overload.declaration;
      if (declaration?.id === implementation.id) continue;
      if (!this.c.relations.isImplementationCompatibleWithOverload(signature, overload)) {
        const target = declaration && !this.c.isLibrary(declaration) ? declaration : implementation;
        this.c.error(
          target.childForFieldName('name') ?? target,
          'このオーバーロードのシグネチャは、実装のシグネチャと合いません。'
        );
        // TypeScript reports only the first overload that does not fit.
        return;
      }
    }
  }

  checkFunctionLike(node: TreeNode, signature: Signature, contextual?: Signature): Type | undefined {
    if (this.c.silent > 0) return undefined;
    checkVarianceAnnotations(this.c, node);
    this.withInitializerFlow(node, 'parameters', () => {
      this.checkSignatureAnnotations(node);
      const parameters = node.childForFieldName('parameters');
      this.checkParameterInitializers(parameters ? named(parameters) : [], signature, contextual);
    });
    return node.childForFieldName('body')
      ? this.checkFunctionBody(node, signature, contextual?.returnType(), false)
      : undefined;
  }

  private checkSignatureAnnotations(node: TreeNode): void {
    for (const parameter of parameterNodes(node)) checkWrittenType(this.c, parameter.childForFieldName('type'));
    checkWrittenType(this.c, node.childForFieldName('return_type'));
  }

  withInitializerFlow<T>(node: TreeNode, kind: 'field' | 'parameters', run: () => T): T {
    const context = this.newContext(node);
    context.initializer = true;
    context.inlined = kind === 'parameters' && isInlinedInvocation(node);
    this.contexts.push(context);
    this.capturedTypes.push(kind === 'parameters' ? this.capture() : new Map());
    try {
      return this.c.flow.withState(context.inlined ? this.c.flow.current : new FlowState(), run);
    } finally {
      this.capturedTypes.pop();
      this.contexts.pop();
    }
  }

  private checkParameterInitializers(parameters: TreeNode[], signature: Signature, contextual?: Signature): void {
    const sourceParameters = argumentParameters(parameters);
    for (const [index, parameter] of sourceParameters.entries()) {
      const defaultType = this.checkParameterDefault(parameter, contextual, index);
      const pattern = parameter.childForFieldName('pattern') ?? parameter;
      const type = this.sourceParameterType(parameter, pattern, signature, index) ?? anyType;
      this.recordParameterInitialization(parameter, type, defaultType);
    }
  }

  recordParameterInitialization(parameter: TreeNode, type: Type, initializer?: Type): void {
    const pattern = parameter.childForFieldName('pattern') ?? parameter;
    const boundType =
      initializer && !this.c.patterns.defaultMayBeUndefined(initializer)
        ? this.c.relations.removeUndefined(type)
        : type;
    this.c.patterns.bindPattern(
      pattern.type === 'rest_pattern' ? named(pattern)[0] : pattern,
      boundType,
      (identifier, bound) => {
        const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
        if (symbol) this.c.flow.current?.entries.set(`s${symbol.id}`, { type: bound, assigned: true });
      },
      {
        annotated: parameter.childForFieldName('type') !== null,
        parameter: true,
      }
    );
  }

  private checkParameterDefault(
    parameter: TreeNode,
    contextual: Signature | undefined,
    index: number
  ): Type | undefined {
    const value = parameter.childForFieldName('value');
    if (!value) return undefined;
    const annotation = this.c.typeNodes.annotationType(parameter.childForFieldName('type'));
    const expected = annotation ?? (contextual && this.c.signatures.contextualParameterType(contextual, index, false));
    const pattern = parameter.childForFieldName('pattern') ?? parameter;
    const implied = expected ? undefined : this.c.patterns.impliedBindingType(pattern, false, true);
    const valueType = this.c.patterns.initializerType(value, expected ?? implied);
    const initial = annotation
      ? valueType
      : this.c.patterns.parameterInitializerType(pattern, valueType, expected === undefined);
    if (expected) this.c.expressions.checkAssignable(pattern, initial, expected, value);
    return initial;
  }

  /**
   * Reports a function that may end without returning a value its declared return type requires, as TypeScript's
   * `checkAllCodePathsInNonVoidFunctionReturnOrThrow`: only a type with `void`, or `any` or `undefined` itself, lets a
   * body have no `return`, while a type `undefined` is assignable to lets some paths end without one.
   */
  checkMissingReturn(node: TreeNode, context: FunctionContext, declared: Type): void {
    if (!context.endReachable || context.isConstructor) return;
    if (hasToken(node, 'set') || node.childForFieldName('body')?.type !== 'statement_block') return;
    const members = declared.kind === 'union' ? declared.types : [declared];
    if (
      isAnyLike(declared) ||
      isIntrinsic(declared, 'undefined') ||
      members.some((member) => isIntrinsic(member, 'void'))
    )
      return;
    const returnNode = node.childForFieldName('return_type') ?? node;
    if (isIntrinsic(declared, 'never')) {
      this.c.error(returnNode, "戻り値の型が 'never' の関数は、最後まで実行されて終わってはいけません。");
      return;
    }
    if (!context.hasReturnWithValue && !context.hasReturnWithoutValue) {
      this.c.error(
        returnNode,
        "宣言した戻り値の型が 'undefined'、'void'、'any' のどれでもない関数は、値を返さなければいけません。"
      );
      return;
    }
    if (this.c.relations.isAssignable(undefinedType, declared)) return;
    this.c.error(returnNode, "関数の最後に return 文がなく、戻り値の型に 'undefined' が含まれていません。");
  }
}

const anyIterationTypes: IterationTypes = { yieldType: anyType, returnType: anyType, nextType: anyType };

/** Whether nothing uses the value of an expression, as TypeScript's `expressionResultIsUnused` decides. */
function isResultUnused(node: TreeNode): boolean {
  let current = node;
  while (current.parent?.type === 'parenthesized_expression') current = current.parent;
  const parent = current.parent;
  if (!parent) return true;
  switch (parent.type) {
    case 'expression_statement': {
      return true;
    }
    case 'sequence_expression': {
      return named(parent).at(-1)?.id !== current.id || isResultUnused(parent);
    }
    case 'unary_expression': {
      return parent.childForFieldName('operator')?.text === 'void';
    }
    case 'for_statement': {
      return parent.childForFieldName('condition')?.id !== current.id;
    }
    default: {
      return false;
    }
  }
}

function isBooleanLike(type: Type): boolean {
  return (type.kind === 'union' ? type.types : [type]).every(
    (member) => member.kind === 'literal' && typeof member.value === 'boolean'
  );
}

/** The `return` statements of a function body, without those of the functions and classes in it. */
function returnStatements(node: TreeNode): TreeNode[] {
  if (node.type === 'return_statement') return [node];
  return named(node).flatMap((child) => (ownsReturns.has(child.type) ? [] : returnStatements(child)));
}

const ownsReturns = new Set([
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'generator_function',
  'arrow_function',
  'method_definition',
  'class_declaration',
  'class',
  'class_static_block',
]);

function mayBeUndefined(type: Type): boolean {
  return (type.kind === 'union' ? type.types : [type]).some(
    (member) => isIntrinsic(member, 'undefined') || isIntrinsic(member, 'void')
  );
}

function mayReturnNever(node: TreeNode): boolean {
  if (node.type === 'arrow_function' || node.type === 'function_expression' || node.type === 'generator_function')
    return true;
  return node.type === 'method_definition' && node.parent?.type === 'object';
}

/**
 * The declarations after a signature in its block, and the one right after it, which may implement it; an exported
 * signature and its implementation are the declarations of neighbouring export statements.
 */
function followingDeclarations(node: TreeNode): { later: TreeNode[]; next: TreeNode | undefined } {
  const item = node.parent?.type === 'export_statement' ? node.parent : node;
  const siblings = item.parent ? named(item.parent) : [];
  const later = siblings.slice(siblings.findIndex((sibling) => sibling.id === item.id) + 1);
  const next =
    later[0]?.type === 'export_statement' ? (later[0].childForFieldName('declaration') ?? later[0]) : later[0];
  return { later, next };
}
