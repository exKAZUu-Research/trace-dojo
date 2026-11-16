import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { FlowState, type State } from './flow';
import type { Sym } from './scopes';
import { hasToken, named } from './syntax';
import {
  anyType,
  functionType,
  isAnyLike,
  isIntrinsic,
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
}

/** Checks function expressions and bodies, inferring the types they return. */
export class FunctionChecker {
  /** The functions whose bodies are being checked, innermost last. */
  readonly contexts: FunctionContext[] = [];
  /** The narrowed types of variables when each function being checked was created. */
  readonly capturedTypes: Map<string, Type>[] = [];
  /** Parameter types of functions checked with a contextual signature, by symbol. */
  readonly parameterTypes = new Map<number, Type>();
  private readonly inferring = new Set<number>();
  private readonly inferredReturns = new Map<number, Type>();

  constructor(private readonly c: Checker) {}

  /** The contextual signature a function expression gets from its contextual type. */
  contextualSignature(contextual: Type | undefined): Signature | undefined {
    if (!contextual) return undefined;
    const members = (contextual.kind === 'union' ? contextual.types : [contextual]).filter(
      (member) => !isIntrinsic(member, 'undefined') && !isIntrinsic(member, 'null')
    );
    const signatures = members.flatMap((member) =>
      member.kind === 'object' || member.kind === 'intersection' || member.kind === 'typeParameter'
        ? this.c.signaturesOf(member, 'call')
        : []
    );
    if (signatures.length !== 1) return undefined;
    return signatures[0];
  }

  functionExpression(node: TreeNode, contextual?: Type): Type {
    const contextualSignature = isAnyLike(contextual ?? unknownType)
      ? this.anySignature()
      : this.contextualSignature(contextual);
    const signature = this.c.signatures.signatureOf(node, contextualSignature);
    // Parameters take their types from the signature, which the body sees.
    this.bindParameters(node, signature);
    const contextualReturn = contextualSignature ? contextualSignature.returnType() : undefined;
    const declaredReturn = this.declaredReturnType(node);
    let returnType: Type | undefined;
    const typed: Signature = {
      ...signature,
      returnType: () => {
        returnType ??= declaredReturn ?? this.checkFunctionBody(node, signature, contextualReturn, true);
        return returnType;
      },
    };
    if (!this.c.silent) this.c.functions.deferFunctionBody(node, signature, contextualReturn);
    return functionType(typed);
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
      const parameter = signature.parameters[index];
      if (!parameter) continue;
      const pattern = parameterNode.childForFieldName('pattern') ?? parameterNode;
      const type =
        parameter.optional && !parameterNode.childForFieldName('value')
          ? unionOf([parameter.type, undefinedType])
          : parameter.type;
      if (pattern.type === 'identifier') {
        const symbol = scope.values.get(pattern.text);
        if (symbol) this.parameterTypes.set(symbol.id, type);
      } else if (pattern.type === 'rest_pattern') {
        const target = named(pattern)[0];
        const symbol = target ? scope.values.get(target.text) : undefined;
        if (symbol) this.parameterTypes.set(symbol.id, type);
      } else {
        this.c.silently(() =>
          this.c.patterns.bindPattern(pattern, type, (identifier, identifierType) => {
            const symbol = scope.values.get(identifier.text);
            if (symbol) this.parameterTypes.set(symbol.id, identifierType);
          })
        );
      }
    }
  }

  /** The return type of a function without an annotation, from checking its body silently. */
  inferredReturnType(node: TreeNode, signature: Signature): Type {
    const cached = this.inferredReturns.get(node.id);
    if (cached) return cached;
    if (this.inferring.has(node.id)) {
      const name = node.childForFieldName('name');
      this.c.error(
        name ?? node,
        `${name?.text ?? 'この関数'} は、戻り値の式で自分自身を参照しているため、戻り値の型が暗黙に any になります。`
      );
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
   * Checks a function's body from a fresh flow, returning the type it returns.
   *
   * @param isolated Whether to check without the enclosing flow, as when inferring the return type ahead.
   */
  checkFunctionBody(node: TreeNode, signature: Signature, contextualReturn: Type | undefined, isolated: boolean): Type {
    void isolated;
    const body = node.childForFieldName('body');
    const context = this.newContext(node, contextualReturn);
    const { declaredReturn } = context;
    this.bindParameters(node, signature);
    this.contexts.push(context);
    this.capturedTypes.push(this.capture());
    const outer = this.c.flow.current;
    this.c.flow.current = this.c.classes.initialFlow(node);
    try {
      if (!body) return anyType;
      this.checkBody(body, context);
      if (declaredReturn) this.checkMissingReturn(node, context, declaredReturn);
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
      this.c.flow.current = outer;
      this.contexts.pop();
      this.capturedTypes.pop();
    }
  }

  private checkBody(body: TreeNode, context: FunctionContext): void {
    if (body.type === 'statement_block') {
      this.c.statements.checkBlockStatements(named(body));
      context.endReachable = this.c.flow.isReachable;
      return;
    }
    const { declaredReturn } = context;
    const expressionType = this.c.expressions.check(body, declaredReturn ?? context.contextualReturn);
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
      isConstructor: node.type === 'method_definition' && node.childForFieldName('name')?.text === 'constructor',
      hasReturnWithValue: false,
      hasReturn: false,
      returnStates: [],
      contextualReturn,
    };
  }

  /** The narrowed types of the variables visible now, which a function created here sees if nothing reassigns them. */
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
    const types = context.returnTypes.map((type) => (context.keepsLiterals ? type : this.c.widenLiteral(type)));
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

  private checkOverloads(symbol: Sym, implementation: TreeNode, signature: Signature): void {
    const overloads = symbol.valueDeclarations.filter((declaration) => declaration.type === 'function_signature');
    for (const overload of overloads) {
      const overloadSignature = this.c.signatures.signatureOf(overload);
      const compatible =
        overloadSignature.parameters.length >=
          signature.parameters.filter((parameter) => !parameter.optional && !parameter.rest).length &&
        overloadSignature.parameters.every((parameter, index) => {
          const implementationType = this.c.expressions.calls.parameterTypeAt(signature, index);
          return (
            !implementationType ||
            this.c.relations.isAssignable(parameter.type, implementationType) ||
            this.c.relations.isAssignable(implementationType, parameter.type)
          );
        });
      if (!compatible) {
        this.c.error(
          overload.childForFieldName('name') ?? overload,
          'このオーバーロードのシグネチャは、実装のシグネチャと合いません。'
        );
      }
    }
    void implementation;
  }

  /** Checks a function's body loudly, when its expression or declaration is checked. */
  deferFunctionBody(node: TreeNode, signature: Signature, contextualReturn: Type | undefined): void {
    this.checkFunctionLike(node, signature, contextualReturn);
  }

  checkFunctionLike(node: TreeNode, signature: Signature, contextualReturn: Type | undefined): void {
    if (this.c.silent > 0) return;
    const parameters = node.childForFieldName('parameters');
    this.checkParameterOrder(parameters ? named(parameters) : []);
    for (const parameter of parameters ? named(parameters) : []) {
      const value = parameter.childForFieldName('value');
      const annotation = this.c.typeNodes.annotationType(parameter.childForFieldName('type'));
      if (value) {
        const type = this.c.flow.from(new FlowState(), () => {
          const valueType = this.c.expressions.check(value, annotation);
          if (annotation)
            this.c.expressions.checkAssignable(parameter.childForFieldName('pattern') ?? value, valueType, annotation);
        });
        void type;
      }
    }
    if (!node.childForFieldName('body')) return;
    this.checkFunctionBody(node, signature, contextualReturn, false);
  }

  /** Reports a required parameter after one marked `?`, which callers could not omit. */
  private checkParameterOrder(parameters: TreeNode[]): void {
    let optional = false;
    for (const parameter of parameters) {
      const isRest = parameter.childForFieldName('pattern')?.type === 'rest_pattern';
      if (parameter.type === 'optional_parameter') optional = true;
      else if (optional && !isRest && !parameter.childForFieldName('value')) {
        this.c.error(parameter, '省略できる引数の後に、省略できない引数は書けません。');
      }
    }
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
