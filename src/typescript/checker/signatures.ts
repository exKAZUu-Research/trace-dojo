import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { Sym } from './scopes';
import { hasToken, named, patternIdentifiers } from './syntax';
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

/** Resolves the signatures and type parameters that function-like and generic declarations declare. */
export class Signatures {
  private readonly signatureCache = new Map<number, Signature>();

  constructor(private readonly c: Checker) {}

  /** The signature a function-like node declares, from its annotations alone. */
  signatureOf(node: TreeNode, contextual?: Signature): Signature {
    if (!contextual) {
      const cached = this.signatureCache.get(node.id);
      if (cached) return cached;
    }
    this.checkParameterGrammar(node);
    const typeParameters = this.functionTypeParameters(node, contextual);
    const { parameters, thisType } = this.declaredParameters(node, contextual);
    const returnNode =
      node.childForFieldName('return_type') ??
      (['construct_signature', 'constructor_type'].includes(node.type) ? node.childForFieldName('type') : undefined);
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
        else returnType = this.implicitReturnType(node);
        return returnType;
      },
    };
    if (!contextual && this.c.silent === 0) this.signatureCache.set(node.id, signature);
    return signature;
  }

  /**
   * Reports a required parameter after one marked `?`, which callers could not omit, and a default value where no
   * implementation could evaluate it. Both are grammar errors that hold however the signature is resolved.
   */
  private checkParameterGrammar(node: TreeNode): void {
    const hasBody = node.childForFieldName('body') !== null;
    let optional = false;
    for (const parameterNode of parameterNodes(node)) {
      const hasDefault = parameterNode.childForFieldName('value') !== null;
      if (hasDefault && !hasBody)
        this.c.errorWhileResolving(parameterNode, '引数の既定値は、関数やコンストラクタの実装にしか書けません。');
      if (parameterNode.type === 'optional_parameter') optional = true;
      else if (optional && patternOf(parameterNode).type !== 'rest_pattern' && !hasDefault)
        this.c.errorWhileResolving(parameterNode, '省略できる引数の後に、省略できない引数は書けません。');
    }
  }

  /** A function's type parameters, which one its contextual signature types takes from that signature. */
  private functionTypeParameters(node: TreeNode, contextual: Signature | undefined): TypeParameter[] {
    return contextual && isContextSensitiveFunction(node) ? contextual.typeParameters : this.typeParametersOf(node);
  }

  private declaredParameters(
    node: TreeNode,
    contextual: Signature | undefined
  ): { parameters: Parameter[]; thisType: Type | undefined } {
    const parameters: Parameter[] = [];
    let thisType: Type | undefined;
    for (const parameterNode of parameterNodes(node)) {
      if (patternOf(parameterNode).type === 'this')
        thisType = this.c.typeNodes.annotationType(parameterNode.childForFieldName('type'));
      else parameters.push(this.declaredParameter(node, parameterNode, contextual, parameters.length));
    }
    return { parameters, thisType };
  }

  private declaredParameter(
    node: TreeNode,
    parameterNode: TreeNode,
    contextual: Signature | undefined,
    index: number
  ): Parameter {
    const pattern = parameterNode.childForFieldName('pattern') ?? parameterNode;
    const annotation = this.c.typeNodes.annotationType(parameterNode.childForFieldName('type'));
    const rest = pattern.type === 'rest_pattern';
    const contextualParameter = contextual ? this.contextualParameterType(contextual, index, rest) : undefined;
    const value = parameterNode.childForFieldName('value');
    const type =
      annotation ??
      contextualParameter ??
      this.setterParameterType(node) ??
      (value
        ? this.c.silently(() =>
            this.c.literals.widenDeclared(this.c.expressions.check(value, this.c.patterns.impliedType(pattern)), false)
          )
        : this.c.expressions.implicitParameterType(parameterNode, pattern, rest));
    return {
      name: rest ? (named(pattern)[0]?.text ?? 'args') : pattern.type === 'identifier' ? pattern.text : `__${index}`,
      type,
      optional: parameterNode.type === 'optional_parameter' || value !== null,
      rest,
    };
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

  /** A setter's parameter without an annotation has the type its getter returns. */
  private setterParameterType(node: TreeNode): Type | undefined {
    if (!accessorDeclarationTypes.has(node.type) || !hasToken(node, 'set')) return undefined;
    const name = node.childForFieldName('name')?.text;
    const getter = node.parent
      ? named(node.parent).find(
          (member) =>
            accessorDeclarationTypes.has(member.type) &&
            member.childForFieldName('name')?.text === name &&
            hasToken(member, 'get') &&
            hasToken(member, 'static') === hasToken(node, 'static')
        )
      : undefined;
    return getter ? this.signatureOf(getter).returnType() : undefined;
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

  private implicitReturnType(node: TreeNode): Type {
    if (!this.c.isLibrary(node) && !['method_definition'].includes(node.type)) {
      const name = node.childForFieldName('name');
      this.c.error(name ?? node, `${name ? name.text : 'この宣言'} の戻り値の型が暗黙に any になります。`);
    }
    return anyType;
  }

  private contextualParameterType(signature: Signature, index: number, rest: boolean): Type | undefined {
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
      constraint: constraintNode ? () => this.declaredConstraint(constraintNode) : undefined,
      default: defaultNode ? () => this.c.typeNodes.typeFromNode(named(defaultNode)[0]) : undefined,
    };
  }

  /** A type parameter's constraint, where TypeScript reads `extends any` as `extends unknown`. */
  private declaredConstraint(constraintNode: TreeNode): Type {
    const constraint = this.c.typeNodes.typeFromNode(named(constraintNode)[0]);
    return constraint === anyType ? unknownType : constraint;
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
  return node.type !== 'arrow_function' && (nodes.length === 0 || patternOf(nodes[0]).type !== 'this');
}

/** The parameter declarations of a function-like node, a `this` parameter included. */
function parameterNodes(node: TreeNode): TreeNode[] {
  const parametersNode = node.childForFieldName('parameters');
  const nodes = parametersNode ? named(parametersNode) : [];
  const single = node.childForFieldName('parameter');
  if (single) nodes.push(single);
  return nodes;
}

function patternOf(parameterNode: TreeNode): TreeNode {
  return parameterNode.childForFieldName('pattern') ?? parameterNode;
}
