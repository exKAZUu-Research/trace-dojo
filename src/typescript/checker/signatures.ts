// code-gauge-allow-file fileNcss 435 -- Keeps signature resolution and the TypeScript grammar of parameters and accessors together.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { erasedStatementTypes } from '../erasedSyntax';
import type { Checker } from './checker';
import type { Scope, Sym } from './scopes';
import {
  argumentParameters,
  hasToken,
  isClassConstructor,
  isConstructorName,
  isParameterProperty,
  isThisParameter,
  named,
  patternIdentifiers,
} from './syntax';
import {
  anyType,
  newTypeId,
  type Parameter,
  type Signature,
  type Type,
  type TypeParameter,
  undefinedType,
  unionOf,
  unknownType,
} from './types';

/** The declarations that may be a get or set accessor: in a class, an interface, or an object type. */
const accessorDeclarationTypes = new Set(['method_definition', 'method_signature', 'abstract_method_signature']);
const constructSignatureTypes = new Set(['construct_signature', 'constructor_type']);
const typeNameDeclarationParents = new Set(['type_parameter', 'mapped_type_clause', 'infer_type']);
/** The declarations whose return type, without an annotation or a body, is implicitly `any`. */
const bodilessSignatureTypes = [
  'function_signature',
  'method_signature',
  'abstract_method_signature',
  'call_signature',
  'construct_signature',
];

/** Resolves the signatures and type parameters that function-like and generic declarations declare. */
export class Signatures {
  private readonly signatureCache = new Map<number, Signature>();
  /** The constraint nodes being resolved, by node. */
  private readonly resolvingConstraints = new Set<number>();
  /** The default nodes being resolved, and those found to refer to themselves while they resolve, by node. */
  private readonly resolvingDefaults = new Set<number>();
  private readonly circularDefaults = new Set<number>();

  constructor(private readonly c: Checker) {}

  // code-gauge-allow functionCognitiveComplexity 16 -- Builds lazy annotation or body signatures and caches only context-free complete signatures.
  signatureOf(node: TreeNode, contextual?: Signature, inferPredicate = true): Signature {
    if (!contextual && inferPredicate) {
      const cached = this.signatureCache.get(node.id);
      if (cached) return cached;
    }
    this.checkParameterGrammar(node);
    const typeParameters = this.functionTypeParameters(node, contextual);
    const { parameters, thisType } = this.declaredParameters(node, contextual);
    const returnNode = returnTypeNode(node);
    let returnType: Type | undefined;
    const signature: Signature = {
      typeParameters,
      parameters: this.expandRestTuple(parameters),
      thisType,
      predicate: returnNode ? this.predicateOf(node, returnNode, parameters) : undefined,
      declaration: node,
      isAbstract: node.type === 'constructor_type' && node.children.some((child) => child?.type === 'abstract'),
      returnType: () => {
        if (returnType) return returnType;
        if (returnNode) returnType = this.c.typeNodes.annotationType(returnNode) ?? anyType;
        else if (node.childForFieldName('body')) returnType = this.c.functions.inferredReturnType(node, signature);
        else returnType = this.pairedSetterType(node) ?? anyType;
        return returnType;
      },
    };
    if (inferPredicate && !returnNode && node.childForFieldName('body') && !isClassConstructor(node))
      this.c.functions.addInferredPredicate(node, signature);
    if (!contextual && inferPredicate && this.c.silent === 0) this.signatureCache.set(node.id, signature);
    return signature;
  }

  /**
   * Reports a required parameter after one marked `?`, which callers could not omit, a parameter marked `?` that also
   * has a default value, a default value where no implementation could evaluate it, a misplaced parameter property, and
   * a misplaced `this` parameter. All are grammar errors that hold however the signature is resolved.
   */
  private checkParameterGrammar(node: TreeNode): void {
    this.checkStrictParameterList(node);
    this.checkAccessorGrammar(node);
    const hasBody = node.childForFieldName('body') !== null;
    let optional = false;
    let listError = false;
    for (const [index, parameterNode] of parameterNodes(node).entries()) {
      if (isParameterProperty(parameterNode)) this.checkParameterPropertyGrammar(node, parameterNode);
      if (isThisParameter(parameterNode)) this.checkThisParameterGrammar(node, parameterNode, index);
      const hasDefault = parameterNode.childForFieldName('value') !== null;
      if (hasDefault && !hasBody)
        this.c.errorWhileResolving(parameterNode, '引数の既定値は、関数やコンストラクタの実装にしか書けません。');
      listError ||= this.checkParameterListGrammar(parameterNode, hasDefault, optional);
      if (parameterNode.type === 'optional_parameter') optional = true;
    }
  }

  private checkAccessorGrammar(node: TreeNode): void {
    if (!accessorDeclarationTypes.has(node.type)) return;
    const getter = hasToken(node, 'get');
    if (!getter && !hasToken(node, 'set')) return;
    const name = node.childForFieldName('name') ?? node;
    const typeParameters = node.childForFieldName('type_parameters');
    if (typeParameters) {
      this.c.errorWhileResolving(typeParameters, 'アクセサーには型引数を書けません。');
      return;
    }
    const returnNode = returnTypeNode(node);
    if (!getter && returnNode) {
      this.c.errorWhileResolving(returnNode, 'set アクセサーには戻り値の型を書けません。');
      return;
    }
    const parameters = argumentParameters(parameterNodes(node));
    if (getter ? parameters.length > 0 : parameters.length !== 1) {
      this.c.errorWhileResolving(
        name,
        getter ? 'get アクセサーには引数を書けません。' : 'set アクセサーには引数が1つ必要です。'
      );
      return;
    }
    const parameter = parameters[0];
    if (!parameter) return;
    const message = this.setterParameterError(parameter);
    if (message) this.c.errorWhileResolving(parameter, message);
  }

  private setterParameterError(parameter: TreeNode): string | undefined {
    const hasDefault = parameter.childForFieldName('value') !== null;
    if (parameter.type === 'optional_parameter')
      return hasDefault ? undefined : 'set アクセサーの引数に ? は付けられません。';
    if (hasDefault) return 'set アクセサーの引数には既定値を書けません。';
    return patternOf(parameter).type === 'rest_pattern' ? 'set アクセサーには残余引数を書けません。' : undefined;
  }

  private checkStrictParameterList(node: TreeNode): void {
    const body = node.childForFieldName('body');
    if (body?.type !== 'statement_block') return;
    const directive = this.strictDirective(body) ?? this.strictDirective(body, true);
    if (!directive) return;
    const invalid = parameterNodes(node).filter(
      (parameter) =>
        !isThisParameter(parameter) &&
        (parameter.childForFieldName('value') !== null || patternOf(parameter).type !== 'identifier')
    );
    if (invalid.length === 0) return;
    for (const parameter of invalid)
      this.c.errorWhileResolving(
        parameter,
        "'use strict' 指令と一緒に、既定値・残余引数・分割代入の引数は使えません。"
      );
    this.c.errorWhileResolving(directive, "単純でない引数リストを持つ関数では、'use strict' 指令は使えません。");
  }

  private strictDirective(body: TreeNode, eraseTypes = false): TreeNode | undefined {
    for (const statement of named(body)) {
      if (eraseTypes && erasedStatementTypes.has(statement.type)) continue;
      const expression = statement.type === 'expression_statement' ? named(statement)[0] : undefined;
      if (expression?.type !== 'string') return undefined;
      if (expression.text === '"use strict"' || expression.text === "'use strict'") return expression;
    }
    return undefined;
  }

  /** Reports a parameter's error in the list's grammar, of which tsc reports only the first; true if it reports one. */
  private checkParameterListGrammar(parameterNode: TreeNode, hasDefault: boolean, afterOptional: boolean): boolean {
    let message: string | undefined;
    if (parameterNode.type === 'optional_parameter') {
      if (hasDefault) message = '既定値のある引数には ? を付けられません。';
    } else if (afterOptional && patternOf(parameterNode).type !== 'rest_pattern' && !hasDefault) {
      message = '省略できる引数の後に、省略できない引数は書けません。';
    }
    if (message) this.c.errorWhileResolving(parameterNode, message);
    return message !== undefined;
  }

  /** Reports a `this` parameter after another parameter, or of a function that has no `this` of its own to type. */
  private checkThisParameterGrammar(node: TreeNode, parameterNode: TreeNode, index: number): void {
    if (index > 0) this.c.errorWhileResolving(parameterNode, "'this' 引数は、最初の引数にしてください。");
    if (isClassConstructor(node) || constructSignatureTypes.has(node.type))
      this.c.errorWhileResolving(parameterNode, "コンストラクタには 'this' 引数を書けません。");
    if (node.type === 'arrow_function')
      this.c.errorWhileResolving(parameterNode, "アロー関数には 'this' 引数を書けません。");
    if (accessorDeclarationTypes.has(node.type) && (hasToken(node, 'get') || hasToken(node, 'set')))
      this.c.errorWhileResolving(parameterNode, "get アクセサーや set アクセサーには 'this' 引数を書けません。");
  }

  /** Reports a parameter property declared by a binding pattern, or outside a constructor's implementation. */
  private checkParameterPropertyGrammar(node: TreeNode, parameterNode: TreeNode): void {
    if (patternOf(parameterNode).type !== 'identifier')
      this.c.errorWhileResolving(parameterNode, '分割代入のパターンでは、引数プロパティを宣言できません。');
    if (!isClassConstructor(node) || node.childForFieldName('body') === null)
      this.c.errorWhileResolving(parameterNode, '引数プロパティは、コンストラクタの実装でしか宣言できません。');
  }

  /** A function's type parameters, which one its contextual signature types takes from that signature. */
  private functionTypeParameters(node: TreeNode, contextual: Signature | undefined): TypeParameter[] {
    return contextual && isContextSensitiveFunction(node) ? contextual.typeParameters : this.typeParametersOf(node);
  }

  private declaredParameters(
    node: TreeNode,
    contextual: Signature | undefined
  ): { parameters: Parameter[]; thisType: Type | undefined } {
    const nodes = parameterNodes(node);
    const argumentNodes = argumentParameters(nodes);
    const thisNode = argumentNodes.length < nodes.length ? nodes[0] : undefined;
    const parameters: Parameter[] = [];
    const lastDefault = argumentNodes.findLastIndex(
      (parameter) =>
        parameter.childForFieldName('value') !== null ||
        !!parameter.childForFieldName('pattern')?.descendantsOfType(['assignment_pattern', 'object_assignment_pattern'])
          .length
    );
    const collect = (): void => {
      for (const [index, parameterNode] of argumentNodes.entries()) {
        const { parameter, initializer } = this.declaredParameter(node, parameterNode, contextual, index);
        parameters.push(parameter);
        if (index >= lastDefault) continue;
        const possibleOmission = parameter.optional && !parameterNode.childForFieldName('value');
        const type = possibleOmission ? unionOf([parameter.type, undefinedType]) : parameter.type;
        this.c.silently(() => this.c.functions.recordParameterInitialization(parameterNode, type, initializer));
      }
    };
    if (lastDefault !== -1) this.c.functions.withInitializerFlow(node, 'parameters', collect);
    else collect();
    return {
      parameters: withRequiredPrefix(parameters),
      thisType: thisNode && this.c.typeNodes.annotationType(thisNode.childForFieldName('type')),
    };
  }

  private declaredParameter(
    node: TreeNode,
    parameterNode: TreeNode,
    contextual: Signature | undefined,
    index: number
  ): { parameter: Parameter; initializer?: Type } {
    const pattern = parameterNode.childForFieldName('pattern') ?? parameterNode;
    const annotation = this.c.typeNodes.annotationType(parameterNode.childForFieldName('type'));
    const rest = pattern.type === 'rest_pattern';
    if (rest && annotation) this.checkRestParameterType(parameterNode, pattern, annotation);
    const value = parameterNode.childForFieldName('value');
    const contextualParameter = contextual ? this.contextualParameterType(contextual, index, rest) : undefined;
    const immediateArgumentCount = contextual?.immediateArgumentCount;
    const omitted = immediateArgumentCount !== undefined && index >= immediateArgumentCount;
    const expected = annotation ?? contextualParameter;
    const initializer = value
      ? this.c.silently(() =>
          this.c.functions.parameterInitializerType(value, expected ?? this.c.patterns.impliedType(pattern))
        )
      : undefined;
    const type =
      expected ??
      (immediateArgumentCount !== undefined && !value ? undefinedType : undefined) ??
      this.setterParameterType(node) ??
      (initializer
        ? this.c.literals.widenDeclared(initializer, false)
        : this.c.expressions.implicitParameterType(parameterNode, pattern, rest));
    return {
      initializer,
      parameter: {
        name: rest
          ? (named(pattern)[0]?.text ?? 'args')
          : ['identifier', 'this'].includes(pattern.type)
            ? pattern.text
            : `__${index}`,
        type,
        optional: parameterNode.type === 'optional_parameter' || value !== null || (omitted && !annotation && !rest),
        rest,
      },
    };
  }

  /** Reports a rest parameter bound to a name whose annotated type is not an array; a binding pattern reports its own error. */
  private checkRestParameterType(parameterNode: TreeNode, pattern: TreeNode, type: Type): void {
    if (named(pattern)[0]?.type !== 'identifier') return;
    if (!this.c.relations.isAssignable(type, this.c.globalType('ReadonlyArray', [anyType])))
      this.c.errorWhileResolving(parameterNode, '残余引数の型は配列型にしてください。');
  }

  private predicateOf(node: TreeNode, returnNode: TreeNode, parameters: Parameter[]): Signature['predicate'] {
    // A function type spells its predicate without the annotation's colon.
    if (returnNode.type !== 'type_predicate_annotation' && returnNode.type !== 'type_predicate') return undefined;
    const predicateNode = returnNode.type === 'type_predicate' ? returnNode : named(returnNode)[0];
    const nameNode = predicateNode?.childForFieldName('name');
    const typeNode = predicateNode?.childForFieldName('type');
    if (!nameNode || !typeNode) return undefined;
    const type = this.c.typeNodes.typeFromNode(typeNode);
    if (nameNode.text === 'this') return { index: -1, type };
    const index = parameters.findIndex((parameter) => parameter.name === nameNode.text);
    const parameter = parameters.at(index);
    if (!parameter || index === -1) {
      this.reportMissingPredicateParameter(node, nameNode);
      return undefined;
    }
    if (parameter.rest) this.c.error(nameNode, '型述語では、残余引数を参照できません。');
    else if (!this.c.isLibrary(typeNode) && !this.c.relations.isAssignable(type, parameter.type))
      this.c.error(typeNode, '型述語の型は、その引数の型に代入できる型にしてください。');
    return { index, type };
  }

  /** Reports a type predicate naming no parameter: a name in a parameter's binding pattern, or no name at all. */
  private reportMissingPredicateParameter(node: TreeNode, nameNode: TreeNode): void {
    const inPattern = parameterNodes(node).some((parameterNode) => {
      const pattern = patternOf(parameterNode);
      return (
        pattern.type !== 'identifier' &&
        patternIdentifiers(pattern).some((identifier) => identifier.text === nameNode.text)
      );
    });
    this.c.error(
      nameNode,
      inPattern
        ? `型述語では、分割代入のパターンの要素 ${nameNode.text} を参照できません。`
        : `引数 ${nameNode.text} が見つかりません。`
    );
  }

  /** A setter's parameter without an annotation has the type its getter of the same property returns. */
  private setterParameterType(node: TreeNode): Type | undefined {
    if (!accessorDeclarationTypes.has(node.type) || !hasToken(node, 'set')) return undefined;
    const getter = this.pairedAccessor(node, 'get');
    return getter ? this.signatureOf(getter).returnType() : undefined;
  }

  /** The accessor of the other kind for the same property, declared beside an accessor. */
  private pairedAccessor(node: TreeNode, kind: 'get' | 'set'): TreeNode | undefined {
    const name = this.accessorName(node);
    return node.parent
      ? named(node.parent).find(
          (member) =>
            accessorDeclarationTypes.has(member.type) &&
            hasToken(member, kind) &&
            hasToken(member, 'static') === hasToken(node, 'static') &&
            this.accessorName(member) === name
        )
      : undefined;
  }

  /** The property an accessor declares, as `value`, `"value"`, and `["value"]` declare the same one. */
  private accessorName(node: TreeNode): string | undefined {
    const nameNode = node.childForFieldName('name');
    return nameNode ? (this.c.typeNodes.memberName(nameNode) ?? nameNode.text) : undefined;
  }

  /** Parameters whose rest parameter of a tuple type, `...args: [string, number]`, becomes the parameters it lists. */
  expandRestTuple(parameters: Parameter[]): Parameter[] {
    const last = parameters.at(-1);
    if (!last?.rest || last.type.kind !== 'object' || last.type.objectKind !== 'tuple') return parameters;
    const elements = last.type.tuple?.elements ?? [];
    // A tuple with elements after a rest one, as `[...T, number]`, stays one rest parameter, as TypeScript keeps it.
    if (elements.slice(0, -1).some((element) => element.rest)) return parameters;
    return [
      ...parameters.slice(0, -1),
      ...elements.map((element, index) => ({
        name: element.name ?? `${last.name}_${index}`,
        type: element.rest ? element.type : element.type,
        optional: element.optional,
        rest: element.rest,
      })),
    ];
  }

  pairedSetterType(node: TreeNode): Type | undefined {
    const setter = accessorDeclarationTypes.has(node.type) && hasToken(node, 'get') && this.pairedAccessor(node, 'set');
    return setter && firstArgumentParameter(setter)?.childForFieldName('type')
      ? this.signatureOf(setter).parameters[0]?.type
      : undefined;
  }

  /**
   * Reports the declarations in a program whose return type is implicitly `any`, used or not, as tsc checks every
   * signature: a getter paired with a setter is not, as the setter's parameter types the property.
   */
  checkImplicitReturnTypes(root: TreeNode): void {
    for (const node of root.descendantsOfType(bodilessSignatureTypes)) {
      this.checkAccessorGrammar(node);
      if (returnTypeNode(node) || node.childForFieldName('body')) continue;
      const name = node.childForFieldName('name');
      if (accessorDeclarationTypes.has(node.type) && (hasToken(node, 'get') || hasToken(node, 'set'))) {
        this.checkImplicitAccessorType(node);
      } else if (node.parent?.type !== 'class_body' || !isConstructorName(name)) {
        this.c.error(name ?? node, `${signatureSubject(node)} の戻り値の型が暗黙に any になります。`);
      }
    }
  }

  /**
   * Reports a getter without a return type whose property no setter's parameter annotation types, at the setter if
   * there is one, as tsc does; a setter's own parameter reports itself.
   */
  private checkImplicitAccessorType(node: TreeNode): void {
    if (hasToken(node, 'set')) return;
    const name = node.childForFieldName('name')?.text ?? '';
    const setter = this.pairedAccessor(node, 'set');
    if (!setter) {
      this.c.error(node.childForFieldName('name') ?? node, `${name} の戻り値の型が暗黙に any になります。`);
    } else if (!firstArgumentParameter(setter)?.childForFieldName('type')) {
      this.c.error(setter.childForFieldName('name') ?? setter, `プロパティ ${name} の型が暗黙に any になります。`);
    }
  }

  contextualParameterType(signature: Signature, index: number, rest: boolean): Type | undefined {
    const { parameters } = signature;
    if (rest) {
      const remaining = parameters.slice(index);
      if (remaining.length === 1 && remaining[0].rest) return remaining[0].type;
      return this.c.tupleType(
        remaining.map((parameter) => ({ type: parameter.type, optional: parameter.optional, rest: parameter.rest }))
      );
    }
    if (index < parameters.length) {
      const parameter = parameters[index];
      if (parameter.rest) return this.c.restElementType(parameter.type);
      // An optional parameter of the context may be left out, which the function then sees as `undefined`.
      return parameter.optional ? unionOf([parameter.type, undefinedType]) : parameter.type;
    }
    const last = parameters.at(-1);
    if (last?.rest) return this.c.restElementType(last.type);
    return undefined;
  }

  typeParametersOf(node: TreeNode): TypeParameter[] {
    // The declarations of a merged interface share the first one's type parameters.
    const first = this.firstDeclarationOf(node);
    if (first && first.id !== node.id) return this.typeParametersOf(first);
    const parameterNodes = this.mergedParameterNodes(node);
    return parameterNodes.map((parameterNode) => {
      const owner = parameterNode.parent?.parent ?? node;
      const scope = this.c.ownScope(owner) ?? this.c.scopeOf(owner);
      const name = parameterNode.childForFieldName('name')?.text ?? 'T';
      const symbol = scope.types.get(name);
      return symbol ? this.typeParameterOfSymbol(symbol) : this.newTypeParameter(parameterNode);
    });
  }

  typeParameterOfSymbol(symbol: Sym): TypeParameter {
    if (symbol.typeParameter) return symbol.typeParameter;
    const declaration = symbol.typeDeclarations[0];
    const owner = declaration.parent?.parent;
    const first = owner ? this.firstDeclarationOf(owner) : undefined;
    if (owner && first && first.id !== owner.id) {
      const canonical = this.mergedParameterNodes(first).find(
        (parameter) => parameter.childForFieldName('name')?.text === symbol.name
      );
      const canonicalOwner = canonical?.parent?.parent;
      const canonicalSymbol = canonicalOwner ? this.c.ownScope(canonicalOwner)?.types.get(symbol.name) : undefined;
      const shared =
        canonicalSymbol && canonicalSymbol !== symbol ? this.typeParameterOfSymbol(canonicalSymbol) : undefined;
      if (shared) {
        symbol.typeParameter = shared;
        return shared;
      }
    }
    symbol.typeParameter = this.newTypeParameter(declaration);
    return symbol.typeParameter;
  }

  /** The declaration whose type parameters an interface declaration shares: its class's, or else the first interface's. */
  private firstDeclarationOf(node: TreeNode): TreeNode | undefined {
    if (node.type !== 'interface_declaration') return undefined;
    const name = node.childForFieldName('name')?.text;
    if (!name) return undefined;
    const declarations = this.c.scopeOf(node).lookupType(name)?.typeDeclarations;
    return declarations?.find((declaration) => declaration.type !== 'interface_declaration') ?? declarations?.[0];
  }

  private mergedDeclarations(node: TreeNode): TreeNode[] {
    if (node.type !== 'interface_declaration') return [node];
    const name = node.childForFieldName('name')?.text;
    return name ? (this.c.scopeOf(node).lookupType(name)?.typeDeclarations ?? [node]) : [node];
  }

  private mergedParameterNodes(node: TreeNode): TreeNode[] {
    const parameters = new Map<string, TreeNode>();
    for (const declaration of this.mergedDeclarations(node)) {
      const list = declaration.childForFieldName('type_parameters');
      for (const parameter of list ? named(list) : []) {
        const name = parameter.childForFieldName('name')?.text ?? '';
        if (!parameters.has(name)) parameters.set(name, parameter);
      }
    }
    return [...parameters.values()];
  }

  private newTypeParameter(node: TreeNode): TypeParameter {
    const owner = node.parent?.parent;
    const declarations = owner ? this.mergedDeclarations(owner) : [];
    const name = node.childForFieldName('name')?.text;
    const matches = declarations.flatMap((declaration) => {
      const parameters = declaration.childForFieldName('type_parameters');
      return parameters
        ? named(parameters).filter((parameter) => parameter.childForFieldName('name')?.text === name)
        : [];
    });
    const constraintNode =
      node.childForFieldName('constraint') ??
      matches.map((parameter) => parameter.childForFieldName('constraint')).find(Boolean);
    const defaultNode =
      node.childForFieldName('value') ?? matches.map((parameter) => parameter.childForFieldName('value')).find(Boolean);
    return {
      kind: 'typeParameter',
      id: newTypeId(),
      name: node.childForFieldName('name')?.text ?? 'T',
      isConst: hasToken(node, 'const'),
      constraint: constraintNode ? () => this.declaredConstraint(constraintNode) : undefined,
      default: defaultNode ? () => this.declaredDefault(defaultNode) : undefined,
    };
  }

  /**
   * Checks every type parameter `scopes` declare, as TypeScript's `checkTypeParameter` does whether or not a use
   * instantiates it: its constraint and default resolve, and its default satisfies its constraint.
   */
  checkTypeParameterDeclarations(scopes: Scope[]): void {
    for (const scope of scopes) {
      for (const symbol of scope.types.values()) {
        const declaration = symbol.typeDeclarations[0];
        if (symbol.typeKind === 'typeParameter' && declaration?.type === 'type_parameter')
          this.checkTypeParameterDeclaration(declaration, this.typeParameterOfSymbol(symbol));
      }
    }
  }

  private checkTypeParameterDeclaration(declaration: TreeNode, parameter: TypeParameter): void {
    this.checkTypeParameterOrder(declaration);
    const owner = declaration.parent?.parent;
    if (
      hasToken(declaration, 'const') &&
      (owner?.type === 'interface_declaration' || owner?.type === 'type_alias_declaration')
    )
      this.c.error(declaration, "'const' 修飾子は関数、メソッド、クラスの型パラメーターにのみ指定できます。");
    const constraintNode = declaration.childForFieldName('constraint');
    if (constraintNode) this.c.typeNodes.typeFromNode(named(constraintNode)[0]);
    const defaultNode = declaration.childForFieldName('value');
    if (!defaultNode) return;
    const defaultTypeNode = named(defaultNode)[0];
    // The written type resolves first, as in tsc, so that of two defaults that refer to each other, the one this
    // declaration's default refers to is the one found circular.
    this.c.typeNodes.typeFromNode(defaultTypeNode);
    const defaultType = this.declaredDefault(defaultNode);
    if (this.circularDefaults.has(defaultNode.id)) {
      this.c.error(defaultTypeNode, `型パラメーター '${parameter.name}' の既定値が循環しています。`);
      return;
    }
    const constraint = parameter.constraint?.();
    if (!constraint) return;
    // Only the parameter itself stands for its default; the constraint may still refer to the other parameters.
    const instantiated = this.c.instantiate(constraint, new Map([[parameter.id, defaultType]]));
    if (!this.c.relations.isAssignable(defaultType, instantiated))
      this.c.error(
        defaultTypeNode,
        this.c.expressions.elaboration.typeRelationMessage(defaultType, instantiated, 'constraint')
      );
  }

  /**
   * Reports a type parameter without a default after one with a default, and a default that refers to its own or a later
   * type parameter of its list, which callers could not have given yet.
   */
  private checkTypeParameterOrder(declaration: TreeNode): void {
    const list = declaration.parent ? named(declaration.parent) : [declaration];
    const index = list.findIndex((sibling) => sibling.id === declaration.id);
    const defaultNode = declaration.childForFieldName('value');
    if (!defaultNode) {
      if (list.slice(0, index).some((sibling) => sibling.childForFieldName('value')))
        this.c.error(declaration, '既定値のある型パラメーターの後に、既定値のない型パラメーターは書けません。');
      return;
    }
    const undeclared = new Set(list.slice(index).map((sibling) => sibling.id));
    for (const reference of typeReferencesIn(defaultNode)) {
      const symbol = this.c.scopeOf(reference).lookupType(reference.text);
      if (symbol?.typeDeclarations.some((typeDeclaration) => undeclared.has(typeDeclaration.id)))
        this.c.error(reference, '型パラメーターの既定値では、それより前に宣言された型パラメーターしか参照できません。');
    }
  }

  /**
   * A type parameter's default, which reads as `unknown` where it is needed while it resolves, as in
   * `type Tree<T = Tree> = T`, whose `Tree` takes the default of `T`; the declaration then reports it as circular.
   */
  private declaredDefault(defaultNode: TreeNode): Type {
    if (this.resolvingDefaults.has(defaultNode.id)) {
      this.circularDefaults.add(defaultNode.id);
      return unknownType;
    }
    this.resolvingDefaults.add(defaultNode.id);
    try {
      return this.c.typeNodes.typeFromNode(named(defaultNode)[0]);
    } finally {
      this.resolvingDefaults.delete(defaultNode.id);
    }
  }

  /**
   * A type parameter's constraint, where TypeScript reads `extends any` as `extends unknown`. A constraint that refers
   * to its own type, as `T extends Tree<any>` in `Tree`, reads as `unknown` while it resolves, for the constraints of the
   * type arguments it passes are checked as it resolves.
   */
  private declaredConstraint(constraintNode: TreeNode): Type {
    if (this.resolvingConstraints.has(constraintNode.id)) return unknownType;
    this.resolvingConstraints.add(constraintNode.id);
    try {
      const constraint = this.c.typeNodes.typeFromNode(named(constraintNode)[0]);
      return constraint === anyType ? unknownType : constraint;
    } finally {
      this.resolvingConstraints.delete(constraintNode.id);
    }
  }

  typeParametersOfSymbol(symbol: Sym): TypeParameter[] {
    if (symbol.typeKind === 'typeParameter') return [];
    const declaration = symbol.typeDeclarations[0];
    if (!declaration) return [];
    return this.typeParametersOf(declaration);
  }

  /** The type parameters of the declarations enclosing a class or interface, outermost first, if it has any. */
  outerTypeParametersOf(node: TreeNode): TypeParameter[] | undefined {
    const outer: TypeParameter[] = [];
    for (let current = node.parent; current; current = current.parent) {
      if (current.childForFieldName('type_parameters')) outer.unshift(...this.typeParametersOf(current));
    }
    return outer.length > 0 ? outer : undefined;
  }
}

/**
 * Whether a function expression or method takes its parameters' types or `this` from its contextual signature, as one
 * without type parameters does unless it annotates every parameter and, if it is not an arrow function, `this`.
 */
export function isContextSensitiveFunction(node: TreeNode): boolean {
  if (node.childForFieldName('type_parameters')) return false;
  const nodes = parameterNodes(node);
  if (nodes.some((parameterNode) => !parameterNode.childForFieldName('type'))) return true;
  return node.type !== 'arrow_function' && argumentParameters(nodes).length === nodes.length;
}

/**
 * Parameters where one with a default value, or marked `?`, before a required one is required too, as callers must pass
 * it to reach the later one; its type takes `undefined` instead, which makes the default apply.
 */
function withRequiredPrefix(parameters: Parameter[]): Parameter[] {
  const minArgumentCount = parameters.findLastIndex((parameter) => !parameter.optional && !parameter.rest) + 1;
  return parameters.map((parameter, index) =>
    index < minArgumentCount && parameter.optional
      ? { ...parameter, optional: false, type: unionOf([parameter.type, undefinedType]) }
      : parameter
  );
}

/** The names that a type node refers to, without the names it declares, as `U` in `<U>(u: U) => U` or `infer U`. */
function typeReferencesIn(node: TreeNode): TreeNode[] {
  if (node.type === 'type_identifier') return isDeclaredTypeName(node) ? [] : [node];
  return named(node).flatMap((child) => typeReferencesIn(child));
}

/** Whether a type name is the one a type parameter, mapped type key, or `infer` declares, not its constraint. */
function isDeclaredTypeName(node: TreeNode): boolean {
  const { parent } = node;
  if (!parent || !typeNameDeclarationParents.has(parent.type)) return false;
  const declared =
    parent.type === 'infer_type'
      ? parent.namedChildren.find((child) => child?.type === 'type_identifier')
      : parent.childForFieldName('name');
  return declared?.id === node.id;
}

/** The parameter declarations of a function-like node, a `this` parameter included. */
function signatureSubject(node: TreeNode): string {
  if (node.type === 'call_signature') return '呼び出しシグネチャ';
  if (node.type === 'construct_signature') return 'コンストラクトシグネチャ';
  return node.childForFieldName('name')?.text ?? '';
}

function returnTypeNode(node: TreeNode): TreeNode | undefined {
  return (
    node.childForFieldName('return_type') ??
    (constructSignatureTypes.has(node.type) ? node.childForFieldName('type') : undefined) ??
    undefined
  );
}

function firstArgumentParameter(node: TreeNode): TreeNode | undefined {
  return argumentParameters(parameterNodes(node))[0];
}

export function parameterNodes(node: TreeNode): TreeNode[] {
  const parametersNode = node.childForFieldName('parameters');
  const nodes = parametersNode ? named(parametersNode) : [];
  const single = node.childForFieldName('parameter');
  if (single) nodes.push(single);
  return nodes;
}

function patternOf(parameterNode: TreeNode): TreeNode {
  return parameterNode.childForFieldName('pattern') ?? parameterNode;
}
