import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { contextualSignatureOf } from './contextualSignatures';
import { FlowState, type State } from './flow';
import type { Sym } from './scopes';
import { isContextSensitiveFunction } from './signatures';
import {
  hasToken,
  isClassConstructor,
  isImmediatelyInvoked,
  named,
  patternIdentifiers,
  propertyNameText,
} from './syntax';
import {
  anyType,
  filterType,
  functionType,
  isAnyLike,
  isIntrinsic,
  neverType,
  nullType,
  type Signature,
  type Type,
  undefinedType,
  unionOf,
  unknownType,
  voidType,
} from './types';

/** What checking a function's body found about how it returns. */
export interface FunctionContext {
  node: TreeNode;
  returnTypes: Type[];
  /** Whether the end of the body is reachable, where the function returns `undefined`. */
  endReachable: boolean;
  declaredReturn?: Type;
  /** Whether returned literals keep their types, as when the declared or contextual return type has literals. */
  keepsLiterals: boolean;
  isConstructor: boolean;
  hasReturnWithValue: boolean;
  /** Whether the body has a `return` statement, with or without a value. */
  hasReturn: boolean;
  /** The flow states at its `return` statements. */
  returnStates: State[];
  contextualReturn?: Type;
  /** Whether an expression the function returns is being checked, where its own return type cannot be used. */
  inReturn?: boolean;
  /** Whether its body continues the enclosing flow, as that of a function called where it is written does. */
  inlined?: boolean;
}

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

  constructor(private readonly c: Checker) {}

  /** The innermost function whose flow the checked code follows, which an inlined function body shares. */
  flowOwner(): TreeNode | undefined {
    return this.contexts.findLast((context) => !context.inlined)?.node;
  }

  functionExpression(node: TreeNode, contextual?: Type): Type {
    const contextualSignature = isAnyLike(contextual ?? unknownType)
      ? this.anySignature()
      : contextualSignatureOf(this.c, contextual, node);
    const signature = this.c.signatures.signatureOf(node, contextualSignature);
    if (node.type !== 'arrow_function' && isContextSensitiveFunction(node))
      this.c.classes.registerContextualThis(node, contextualSignature?.thisType);
    // Parameters take their types from the signature, which the body sees.
    this.bindParameters(node, signature);
    const contextualReturn = contextualSignature ? contextualSignature.returnType() : undefined;
    const declaredReturn = this.declaredReturnType(node);
    let returnType: Type | undefined;
    let predicate: { inferred: Signature['predicate'] } | undefined;
    const typed: Signature = {
      ...signature,
      returnType: () => {
        returnType ??= declaredReturn ?? this.checkFunctionBody(node, signature, contextualReturn, true);
        return returnType;
      },
    };
    if (!declaredReturn && !signature.predicate) {
      Object.defineProperty(typed, 'predicate', {
        get: (): Signature['predicate'] => {
          predicate ??= { inferred: this.inferredPredicate(node, typed) };
          return predicate.inferred;
        },
        enumerable: true,
      });
    }
    const type = functionType(typed);
    const ownName = node.childForFieldName('name');
    const self = ownName ? this.c.ownScope(node)?.lookupValue(ownName.text) : undefined;
    if (self?.valueDeclaration?.id === node.id) self.valueType = type;
    if (!this.c.silent) this.c.functions.deferFunctionBody(node, signature, contextualReturn);
    return type;
  }

  /**
   * The type predicate TypeScript 5.5 infers for a function that only returns a boolean condition on a parameter, as
   * `(x) => x !== null` is `(x) => x is T` when the condition is false exactly where the parameter is not a `T`.
   */
  // code-gauge-allow functionCognitiveComplexity 18 -- Follows TypeScript 5.5's conditions for inferring a type predicate.
  inferredPredicate(node: TreeNode, signature: Signature): Signature['predicate'] {
    const returned = this.singleReturnedExpression(node);
    if (!returned || !isBooleanLike(this.c.silently(() => signature.returnType()))) return undefined;
    const parametersNode = node.childForFieldName('parameters');
    const names = parametersNode
      ? named(parametersNode).map((parameter) => parameter.childForFieldName('pattern') ?? parameter)
      : [node.childForFieldName('parameter')];
    for (const [index, name] of names.entries()) {
      const parameter = signature.parameters[index];
      if (name?.type !== 'identifier' || !parameter || parameter.rest) continue;
      const symbol = this.c.scopeOf(name).lookupValue(name.text);
      if (!symbol || symbol.isReassigned) continue;
      const declared = parameter.type;
      const key = `s${symbol.id}`;
      const outer = this.c.flow.current;
      this.c.flow.current = new FlowState();
      let whenTrue: State;
      let whenFalse: State;
      try {
        ({ whenTrue, whenFalse } = this.c.silently(() => this.c.conditions.condition(returned, false)));
      } finally {
        this.c.flow.current = outer;
      }
      const trueType = whenTrue ? (whenTrue.entries.get(key)?.type ?? declared) : neverType;
      const falseType = whenFalse ? (whenFalse.entries.get(key)?.type ?? declared) : neverType;
      if (this.c.relations.identical(trueType, declared)) continue;
      const rest = filterType(declared, (member) => !this.c.relations.isAssignable(member, trueType));
      if (this.c.relations.identical(rest, falseType)) return { index, type: trueType };
    }
    return undefined;
  }

  /** The expression a function returns when that is all it does: an arrow's expression body or a lone `return`. */
  private singleReturnedExpression(node: TreeNode): TreeNode | undefined {
    const body = node.childForFieldName('body');
    if (!body) return undefined;
    if (body.type !== 'statement_block') return body;
    const statements = named(body);
    if (statements.length !== 1 || statements[0].type !== 'return_statement') return undefined;
    return named(statements[0])[0];
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
    return returnNode ? this.c.typeNodes.annotationType(returnNode) : undefined;
  }

  /** Records the types of a function's parameters for its body. */
  // code-gauge-allow functionCognitiveComplexity 27 -- Records each form of parameter: a name, a rest parameter, or a pattern.
  bindParameters(node: TreeNode, signature: Signature): void {
    const scope = this.c.ownScope(node);
    if (!scope) return;
    const parametersNode = node.childForFieldName('parameters');
    const parameterNodes = parametersNode
      ? named(parametersNode).filter(
          (parameter) => (parameter.childForFieldName('pattern') ?? parameter).type !== 'this'
        )
      : [];
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
          this.c.patterns.bindPattern(bound, type, (identifier, identifierType) => {
            const symbol = scope.values.get(identifier.text);
            if (symbol) this.parameterTypes.set(symbol.id, identifierType);
          })
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
    return parameter.optional && !node.childForFieldName('value')
      ? unionOf([parameter.type, undefinedType])
      : parameter.type;
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
    const context = this.newContext(node, contextualReturn);
    const { declaredReturn } = context;
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
      if (declaredReturn) this.checkMissingReturn(node, context, declaredReturn);
      if (this.circular.has(node.id) && this.c.silent === 0) {
        const name = node.childForFieldName('name');
        this.c.error(
          name ?? node,
          `${name?.text ?? 'この関数'} は、戻り値の式で自分自身を参照しているため、戻り値の型が暗黙に any になります。戻り値の型を書いてください。`
        );
      }
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
      if (this.c.patterns.defaultMayBeUndefined(this.c.silently(() => this.c.expressions.check(value, declared))))
        continue;
      this.c.flow.set(`s${symbol.id}`, { type: this.c.relations.removeUndefined(declared), assigned: true });
    }
  }

  private reentersBody(node: TreeNode): boolean {
    const activeIndex = this.contexts.findIndex((context) => context.node.id === node.id);
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
    const expressionType = this.c.expressions.check(body, declaredReturn ?? context.contextualReturn);
    context.inReturn = false;
    if (declaredReturn) this.c.expressions.checkReturnValue(body, expressionType, declaredReturn);
    context.returnTypes.push(expressionType);
    context.endReachable = false;
    context.hasReturnWithValue = true;
  }

  private newContext(node: TreeNode, contextualReturn: Type | undefined): FunctionContext {
    const declaredReturn = this.declaredReturnType(node);
    return {
      node,
      returnTypes: [],
      endReachable: true,
      declaredReturn,
      keepsLiterals:
        (declaredReturn ?? contextualReturn) !== undefined && this.hasLiterals(declaredReturn ?? contextualReturn),
      isConstructor: isClassConstructor(node),
      hasReturnWithValue: false,
      hasReturn: false,
      returnStates: [],
      contextualReturn,
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

  private hasLiterals(type: Type | undefined): boolean {
    if (!type) return false;
    return (type.kind === 'union' ? type.types : [type]).some(
      (member) => member.kind === 'literal' || member.kind === 'typeParameter'
    );
  }

  private returnTypeOf(context: FunctionContext): Type {
    if (context.declaredReturn) return context.declaredReturn;
    const returned = this.c.literals.normalizeObjectLiterals(
      context.returnTypes.flatMap((type) => (type.kind === 'union' ? type.types : [type]))
    );
    const types = returned.map((type) => (context.keepsLiterals ? type : this.c.widenLiteral(type)));
    // A function expression or an object literal method that never returns returns `never`; a declaration `void`.
    if (types.length === 0 && !context.hasReturn && !context.endReachable && mayReturnNever(context.node))
      return neverType;
    if (types.length === 0) return voidType;
    if (context.endReachable && context.hasReturnWithValue) types.push(undefinedType);
    if (!context.hasReturnWithValue) return voidType;
    return unionOf(types.map((type) => this.widenObjectLiteral(type)));
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
    const siblings = node.parent ? named(node.parent) : [];
    const index = siblings.findIndex((sibling) => sibling.id === node.id);
    const next = siblings[index + 1];
    const nextName = next?.childForFieldName('name');
    if (
      next &&
      ['function_signature', 'function_declaration', 'method_signature', 'method_definition'].includes(next.type)
    ) {
      if (this.matchingOverloadNames(node, next)) {
        if (hasToken(next, 'static') !== hasToken(node, 'static'))
          this.c.error(nextName ?? next, 'オーバーロードの static 修飾子は一致しなければいけません。');
        return;
      }
      if (node.type === 'method_signature' && next.type === 'method_definition') {
        this.c.error(nextName ?? next, 'オーバーロードの名前は、実装の名前と一致しなければいけません。');
        return;
      }
    }
    this.c.error(node.childForFieldName('name') ?? node, '関数の実装がないか、宣言の直後にありません。');
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
    const overloads = symbol.valueDeclarations.filter((declaration) => declaration.type === 'function_signature');
    for (const overload of overloads) {
      const overloadSignature = this.c.signatures.signatureOf(this.c.nativeOverload(overload));
      const compatible =
        overloadSignature.parameters.length >=
          signature.parameters.filter((parameter) => !parameter.optional && !parameter.rest).length &&
        overloadSignature.parameters.every((parameter, index) =>
          this.overloadParameterCompatible(parameter, signature, index)
        ) &&
        this.returnsCompatibly(overloadSignature.returnType(), signature.returnType());
      if (!compatible) {
        this.c.error(
          this.c.isLibrary(overload)
            ? (implementation.childForFieldName('name') ?? implementation)
            : (overload.childForFieldName('name') ?? overload),
          'このオーバーロードのシグネチャは、実装のシグネチャと合いません。'
        );
        // TypeScript reports only the first overload that does not fit.
        return;
      }
    }
  }

  private overloadParameterCompatible(
    parameter: Signature['parameters'][number],
    implementation: Signature,
    index: number
  ): boolean {
    const target = this.c.expressions.calls.parameterTypeAt(implementation, index);
    if (!target) return true;
    const source = parameter.optional ? unionOf([parameter.type, undefinedType]) : parameter.type;
    if (!isAnyLike(source)) {
      for (const nullish of [undefinedType, nullType]) {
        if (nullish === undefinedType && implementation.parameters[index]?.optional) continue;
        if (this.c.relations.isAssignable(nullish, source) && !this.c.relations.isAssignable(nullish, target))
          return false;
      }
    }
    return (
      this.c.relations.isAssignable(parameter.type, target) || this.c.relations.isAssignable(target, parameter.type)
    );
  }

  /** Whether an overload's return type and its implementation's are related either way, or the overload returns `void`. */
  private returnsCompatibly(overloadReturn: Type, implementationReturn: Type): boolean {
    return (
      isIntrinsic(overloadReturn, 'void') ||
      isAnyLike(implementationReturn) ||
      this.c.relations.isAssignable(implementationReturn, overloadReturn) ||
      this.c.relations.isAssignable(overloadReturn, implementationReturn)
    );
  }

  /** Checks a function's body loudly, when its expression or declaration is checked. */
  deferFunctionBody(node: TreeNode, signature: Signature, contextualReturn: Type | undefined): void {
    this.checkFunctionLike(node, signature, contextualReturn);
  }

  checkFunctionLike(node: TreeNode, signature: Signature, contextualReturn: Type | undefined): void {
    if (this.c.silent > 0) return;
    const parameters = node.childForFieldName('parameters');
    this.checkParameterInitializers(parameters ? named(parameters) : [], signature);
    if (!node.childForFieldName('body')) return;
    this.checkFunctionBody(node, signature, contextualReturn, false);
  }

  private checkParameterInitializers(parameters: TreeNode[], signature: Signature): void {
    this.c.flow.from(new FlowState(), () => {
      const sourceParameters = parameters.filter(
        (parameter) => (parameter.childForFieldName('pattern') ?? parameter).type !== 'this'
      );
      for (const [index, parameter] of sourceParameters.entries()) {
        this.checkParameterDefault(parameter);
        const pattern = parameter.childForFieldName('pattern') ?? parameter;
        const type = this.sourceParameterType(parameter, pattern, signature, index) ?? anyType;
        this.c.patterns.bindPattern(
          pattern.type === 'rest_pattern' ? named(pattern)[0] : pattern,
          type,
          (identifier, bound) => {
            const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
            if (symbol) this.c.flow.set(`s${symbol.id}`, { type: bound, assigned: true });
          },
          parameter.childForFieldName('type') !== null
        );
      }
    });
  }

  private checkParameterDefault(parameter: TreeNode): void {
    const value = parameter.childForFieldName('value');
    const annotation = this.c.typeNodes.annotationType(parameter.childForFieldName('type'));
    if (!value) return;
    const pattern = parameter.childForFieldName('pattern') ?? parameter;
    const implied = annotation ? undefined : this.c.patterns.impliedType(pattern);
    const valueType = this.c.expressions.check(value, annotation ?? implied);
    if (annotation) this.c.expressions.checkAssignable(pattern, valueType, annotation, value);
    else this.c.patterns.checkInitializer(pattern, value, valueType, implied);
  }

  /** Reports a function that may end without returning a value its declared return type requires. */
  checkMissingReturn(node: TreeNode, context: FunctionContext, declared: Type): void {
    if (!context.endReachable || context.isConstructor) return;
    if (hasToken(node, 'set') || node.childForFieldName('body')?.type !== 'statement_block') return;
    const members = declared.kind === 'union' ? declared.types : [declared];
    if (
      members.some(
        (member) =>
          isAnyLike(member) ||
          isIntrinsic(member, 'void') ||
          isIntrinsic(member, 'unknown') ||
          isIntrinsic(member, 'undefined')
      )
    )
      return;
    const returnNode = node.childForFieldName('return_type') ?? node;
    if (isIntrinsic(declared, 'never')) {
      this.c.error(returnNode, "戻り値の型が 'never' の関数は、最後まで実行されて終わってはいけません。");
      return;
    }
    if (!context.hasReturn) {
      this.c.error(
        returnNode,
        "宣言した戻り値の型が 'undefined'、'void'、'any' のどれでもない関数は、値を返さなければいけません。"
      );
      return;
    }
    this.c.error(returnNode, "関数の最後に return 文がなく、戻り値の型に 'undefined' が含まれていません。");
  }
}

function isBooleanLike(type: Type): boolean {
  return (type.kind === 'union' ? type.types : [type]).every(
    (member) => member.kind === 'literal' && typeof member.value === 'boolean'
  );
}

function mayBeUndefined(type: Type): boolean {
  return (type.kind === 'union' ? type.types : [type]).some(
    (member) => isIntrinsic(member, 'undefined') || isIntrinsic(member, 'void')
  );
}

function mayReturnNever(node: TreeNode): boolean {
  if (node.type === 'arrow_function' || node.type === 'function_expression') return true;
  return node.type === 'method_definition' && node.parent?.type === 'object';
}

/** Whether a function runs where it is written, synchronously, as tsc's binder inlines the flow of such a function. */
function isInlinedInvocation(node: TreeNode): boolean {
  return (
    (node.type === 'arrow_function' || node.type === 'function_expression') &&
    !hasToken(node, 'async') &&
    isImmediatelyInvoked(node)
  );
}
