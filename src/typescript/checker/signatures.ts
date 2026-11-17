import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { Sym } from './scopes';
import { named } from './syntax';
import {
  anyType,
  newTypeId,
  type Parameter,
  type Signature,
  type Type,
  type TypeParameter,
  undefinedType,
  unionOf,
} from './types';

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
    const typeParameters = this.typeParametersOf(node);
    const { parameters, thisType } = this.declaredParameters(node, contextual);
    const returnNode =
      node.childForFieldName('return_type') ??
      (['construct_signature', 'constructor_type'].includes(node.type) ? node.childForFieldName('type') : undefined);
    let returnType: Type | undefined;
    const signature: Signature = {
      typeParameters,
      parameters: this.expandRestTuple(parameters),
      thisType,
      predicate: returnNode ? this.predicateOf(returnNode, parameters) : undefined,
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

  private declaredParameters(
    node: TreeNode,
    contextual: Signature | undefined
  ): { parameters: Parameter[]; thisType: Type | undefined } {
    const parameters: Parameter[] = [];
    let thisType: Type | undefined;
    const parametersNode = node.childForFieldName('parameters');
    const parameterNodes = parametersNode ? named(parametersNode) : [];
    const single = node.childForFieldName('parameter');
    if (single) parameterNodes.push(single);
    for (const parameterNode of parameterNodes) {
      const pattern = parameterNode.childForFieldName('pattern') ?? parameterNode;
      if (pattern.type === 'this') thisType = this.c.typeNodes.annotationType(parameterNode.childForFieldName('type'));
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

  private predicateOf(returnNode: TreeNode, parameters: Parameter[]): Signature['predicate'] {
    // A function type spells its predicate without the annotation's colon.
    if (returnNode.type !== 'type_predicate_annotation' && returnNode.type !== 'type_predicate') return undefined;
    const predicateNode = returnNode.type === 'type_predicate' ? returnNode : named(returnNode)[0];
    const name = predicateNode?.childForFieldName('name')?.text;
    const typeNode = predicateNode?.childForFieldName('type');
    if (!name || !typeNode) return undefined;
    const index = name === 'this' ? -1 : parameters.findIndex((parameter) => parameter.name === name);
    const type = this.c.typeNodes.typeFromNode(typeNode);
    const parameter = parameters[index] as Parameter | undefined;
    if (parameter && !this.c.isLibrary(typeNode) && !this.c.relations.isAssignable(type, parameter.type)) {
      this.c.error(typeNode, '型述語の型は、その引数の型に代入できる型にしてください。');
    }
    return { index, type };
  }

  /** A setter's parameter without an annotation has the type its getter returns. */
  private setterParameterType(node: TreeNode): Type | undefined {
    if (node.type !== 'method_definition' || !node.children.some((child) => child?.type === 'set')) return undefined;
    const name = node.childForFieldName('name')?.text;
    const getter = node.parent
      ? named(node.parent).find(
          (member) =>
            member.type === 'method_definition' &&
            member.childForFieldName('name')?.text === name &&
            member.children.some((child) => child?.type === 'get')
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

  /** The first declaration of the interface a declaration merges into, if it is one. */
  private firstDeclarationOf(node: TreeNode): TreeNode | undefined {
    if (node.type !== 'interface_declaration') return undefined;
    const name = node.childForFieldName('name')?.text;
    if (!name) return undefined;
    return this.c.scopeOf(node).lookupType(name)?.typeDeclarations[0];
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
      constraint: constraintNode ? () => this.c.typeNodes.typeFromNode(named(constraintNode)[0]) : undefined,
      default: defaultNode ? () => this.c.typeNodes.typeFromNode(named(defaultNode)[0]) : undefined,
    };
  }

  typeParametersOfSymbol(symbol: Sym): TypeParameter[] {
    if (symbol.typeKind === 'typeParameter') return [];
    const declaration = symbol.typeDeclarations[0];
    if (!declaration) return [];
    return this.typeParametersOf(declaration);
  }
}
