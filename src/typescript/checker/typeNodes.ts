import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker, Mapper } from './checker';
import type { Sym } from './scopes';
import { named, numberValue, propertyNameText, stringValue } from './syntax';
import {
  anonymousObject,
  anyType,
  bigintType,
  booleanType,
  emptyStructure,
  errorType,
  falseType,
  functionType,
  type IndexInfo,
  intersectionOf,
  isIntrinsic,
  literalType,
  neverType,
  newTypeId,
  nonPrimitiveType,
  nullType,
  numberType,
  type ObjectType,
  type Signature,
  stringType,
  type Structure,
  symbolType,
  trueType,
  type TupleElement,
  type Type,
  type TypeParameter,
  undefinedType,
  unionOf,
  unknownType,
  voidType,
} from './types';

const predefinedTypes: Record<string, Type> = {
  any: anyType,
  unknown: unknownType,
  never: neverType,
  void: voidType,
  undefined: undefinedType,
  null: nullType,
  string: stringType,
  number: numberType,
  boolean: booleanType,
  bigint: bigintType,
  symbol: symbolType,
  object: nonPrimitiveType,
};

const stringMappings = new Set(['Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize']);

/** Resolves the types the program writes: annotations, type references, and type declarations. */
export class TypeNodes {
  private readonly typeNodeCache = new Map<number, Type>();
  /** The type each kind of type syntax denotes; the others are `any`. */
  private readonly typeSyntaxes = new Map<string, (node: TreeNode) => Type>([
    ['predefined_type', (node) => predefinedTypes[node.text] ?? (node.text === 'unique symbol' ? symbolType : anyType)],
    ['type_identifier', (node) => this.typeReference(node, node, [])],
    ['identifier', (node) => this.typeReference(node, node, [])],
    ['generic_type', (node) => this.genericType(node)],
    ['parenthesized_type', (node) => this.typeFromNode(named(node)[0])],
    ['literal_type', (node) => this.literalTypeOf(named(node)[0])],
    ['union_type', (node) => unionOf(named(node).map((member) => this.typeFromNode(member)))],
    [
      'intersection_type',
      (node) =>
        intersectionOf(
          named(node).map((member) => this.typeFromNode(member)),
          this.c.budget
        ),
    ],
    ['array_type', (node) => this.c.arrayType(this.typeFromNode(named(node)[0]))],
    ['readonly_type', (node) => this.readonlyType(node)],
    ['tuple_type', (node) => this.c.tupleType(named(node).map((element) => this.tupleElement(element)))],
    ['function_type', (node) => this.functionTypeFromNode(node)],
    ['constructor_type', (node) => this.functionTypeFromNode(node)],
    ['object_type', (node) => this.objectTypeLiteral(node)],
    ['type_query', (node) => this.c.expressions.typeOfQuery(named(node)[0])],
    ['index_type_query', (node) => this.c.typeOperators.keyofType(this.typeFromNode(named(node)[0]))],
    ['lookup_type', (node) => this.lookupType(node)],
    ['conditional_type', (node) => this.c.typeOperators.conditionalTypeFromNode(node)],
    ['infer_type', (node) => this.c.typeOperators.inferParameterFor(node, named(node)[0].text) ?? anyType],
    ['template_literal_type', (node) => this.c.typeOperators.templateLiteralFromNode(node)],
    ['this_type', (node) => this.c.classes.thisTypeAt(node)],
    ['type_predicate', () => booleanType],
    ['type_annotation', (node) => this.annotationType(node) ?? anyType],
  ]);

  constructor(private readonly c: Checker) {}

  /** How many array, tuple, and type argument nodes enclose the type node being resolved. */
  private deferredDepth = 0;

  typeFromNode(node: TreeNode): Type {
    const cached = this.typeNodeCache.get(node.id);
    if (cached) return cached;
    const defers = deferringTypeNodes.has(node.type);
    if (defers) this.deferredDepth++;
    try {
      const type = this.computeTypeFromNode(node);
      this.typeNodeCache.set(node.id, type);
      return type;
    } finally {
      if (defers) this.deferredDepth--;
    }
  }

  /** The type of a `type_annotation` or of the type node a field holds. */
  annotationType(node: TreeNode | null | undefined): Type | undefined {
    if (!node) return undefined;
    if (
      node.type === 'type_annotation' ||
      node.type === 'omitting_type_annotation' ||
      node.type === 'adding_type_annotation' ||
      node.type === 'opting_type_annotation'
    ) {
      const inner = named(node)[0];
      return inner ? this.typeFromNode(inner) : undefined;
    }
    if (node.type === 'type_predicate_annotation') return booleanType;
    return this.typeFromNode(node);
  }

  private computeTypeFromNode(node: TreeNode): Type {
    return this.typeSyntaxes.get(node.type)?.(node) ?? anyType;
  }

  private genericType(node: TreeNode): Type {
    const name = node.childForFieldName('name') as TreeNode;
    const argumentsNode = node.childForFieldName('type_arguments');
    const typeArguments = argumentsNode ? named(argumentsNode).map((argument) => this.typeFromNode(argument)) : [];
    return this.typeReference(node, name, typeArguments);
  }

  private readonlyType(node: TreeNode): Type {
    const inner = this.typeFromNode(named(node)[0]);
    if (this.c.isArrayType(inner)) return this.c.arrayType(this.c.elementTypeOf(inner as ObjectType), true);
    if (inner.kind === 'object' && inner.objectKind === 'tuple')
      return this.c.tupleType(inner.tuple?.elements ?? [], true);
    return inner;
  }

  private functionTypeFromNode(node: TreeNode): Type {
    const signature = this.c.signatures.signatureOf(node);
    if (node.type === 'function_type') return functionType(signature);
    return anonymousObject(() => ({ ...emptyStructure(), constructSignatures: [signature] }), { isFunction: true });
  }

  private lookupType(node: TreeNode): Type {
    const [object, index] = named(node);
    const objectType = this.typeFromNode(object);
    const indexType = this.typeFromNode(index);
    if (objectType.kind === 'typeParameter' && indexType.kind === 'literal') {
      // A type parameter can be indexed only by the keys its constraint has.
      const constraint = this.c.constraintOf(objectType);
      const name = String(indexType.value);
      if (
        !this.narrowedByConditional(node, object.text) &&
        (!constraint || (!this.c.propertyOf(constraint, name) && !this.c.structureOf(constraint).stringIndex))
      ) {
        this.c.error(index, `型 '${this.c.print(indexType)}' は型 '${objectType.name}' のインデックスに使えません。`);
        return errorType;
      }
    }
    return this.c.typeOperators.indexedAccess(objectType, indexType, index);
  }

  /** Whether a type node is in the true branch of a conditional type that checks `name`, which constrains it more. */
  private narrowedByConditional(node: TreeNode, name: string): boolean {
    let child = node;
    for (let current = node.parent; current; current = current.parent) {
      if (
        current.type === 'conditional_type' &&
        current.childForFieldName('left')?.text === name &&
        current.childForFieldName('consequence')?.id === child.id
      ) {
        return true;
      }
      child = current;
    }
    return false;
  }

  private literalTypeOf(node: TreeNode): Type {
    switch (node.type) {
      case 'string': {
        return literalType(stringValue(node));
      }
      case 'number': {
        return literalType(numberValue(node.text));
      }
      case 'true': {
        return trueType;
      }
      case 'false': {
        return falseType;
      }
      case 'null': {
        return nullType;
      }
      case 'undefined': {
        return undefinedType;
      }
      case 'unary_expression': {
        const value = numberValue(named(node)[0].text);
        return literalType(typeof value === 'bigint' ? -value : -value);
      }
      default: {
        return anyType;
      }
    }
  }

  private tupleElement(node: TreeNode): TupleElement {
    switch (node.type) {
      case 'optional_type': {
        return { type: this.typeFromNode(named(node)[0]), optional: true, rest: false };
      }
      case 'rest_type': {
        return { type: this.typeFromNode(named(node)[0]), optional: false, rest: true };
      }
      case 'required_parameter':
      case 'optional_parameter': {
        const nameNode = node.childForFieldName('name') ?? node.childForFieldName('pattern');
        const rest = nameNode?.type === 'rest_pattern';
        return {
          type: this.annotationType(node.childForFieldName('type')) ?? anyType,
          optional: node.type === 'optional_parameter',
          rest,
          name: rest ? named(nameNode as TreeNode)[0]?.text : nameNode?.text,
        };
      }
      default: {
        return { type: this.typeFromNode(node), optional: false, rest: false };
      }
    }
  }

  /** The type a name refers to in a type position, applied to type arguments. */
  // code-gauge-allow functionNcss 31 -- Resolves a type name and checks its type arguments as TypeScript does.
  // code-gauge-allow functionCognitiveComplexity 19 -- Resolves a type name and checks its type arguments as TypeScript does.
  private typeReference(node: TreeNode, nameNode: TreeNode, typeArguments: Type[]): Type {
    const name = nameNode.text;
    const local = this.c.typeOperators.mappedOrInferParameter(nameNode, name);
    if (local) return local;
    if (
      stringMappings.has(name) &&
      typeArguments.length === 1 &&
      !this.c.scopeOf(nameNode).lookupType(name)?.typeDeclarations.length
    )
      return this.c.typeOperators.stringMapping(name as 'Uppercase', typeArguments[0]);
    const symbol = this.c.scopeOf(nameNode).lookupType(name);
    if (!symbol) {
      if (stringMappings.has(name) && typeArguments.length === 1)
        return this.c.typeOperators.stringMapping(name as 'Uppercase', typeArguments[0]);
      const value = this.c.scopeOf(nameNode).lookupValue(name);
      this.c.error(
        nameNode,
        value
          ? `${name} は値であり、型としては使えません。型を表すには typeof ${name} と書いてください。`
          : `型 ${name} が見つかりません。`
      );
      return errorType;
    }
    const declared = this.declaredTypeOf(symbol);
    const parameters = this.c.signatures.typeParametersOfSymbol(symbol);
    if (parameters.length === 0) {
      if (typeArguments.length > 0) this.c.error(node, `型 ${name} は型引数をとりません。`);
      return declared;
    }
    const required = parameters.filter((parameter) => !parameter.default).length;
    if (
      (typeArguments.length < required || typeArguments.length > parameters.length) &&
      !(typeArguments.length === 0 && this.insideOwnDeclaration(node, symbol))
    ) {
      this.c.error(
        node,
        required === parameters.length
          ? `ジェネリック型 ${name} には型引数が ${required} 個必要です。`
          : `ジェネリック型 ${name} には型引数が ${required} 個から ${parameters.length} 個必要です。`
      );
      return errorType;
    }
    const filled = this.c.fillTypeArguments(parameters, typeArguments);
    this.checkTypeArgumentConstraints(node, parameters, filled);
    if (symbol.typeKind === 'alias') {
      const mapper: Mapper = new Map(parameters.map((parameter, index) => [parameter.id, filled[index]]));
      const instantiated = this.c.instantiate(declared, mapper);
      return instantiated;
    }
    return this.c.reference(declared as ObjectType, filled);
  }

  checkTypeArgumentConstraints(node: TreeNode, parameters: TypeParameter[], typeArguments: Type[]): void {
    const mapper: Mapper = new Map(parameters.map((parameter, index) => [parameter.id, typeArguments[index]]));
    for (const [index, parameter] of parameters.entries()) {
      const constraint = parameter.constraint?.();
      if (!constraint) continue;
      const argument = typeArguments[index];
      const instantiated = this.c.instantiate(constraint, mapper);
      if (!this.c.relations.isAssignable(argument, instantiated)) {
        this.c.error(
          node,
          `型 '${this.c.print(argument)}' は制約 '${this.c.print(instantiated)}' を満たしていません。`
        );
      }
    }
  }

  private insideOwnDeclaration(node: TreeNode, symbol: Sym): boolean {
    for (let current: TreeNode | null = node; current; current = current.parent) {
      if (symbol.typeDeclarations.some((declaration) => declaration.id === current?.id)) return true;
    }
    return false;
  }

  private objectTypeLiteral(node: TreeNode): Type {
    const members = named(node);
    const mappedSignature = members.find(
      (member) =>
        member.type === 'index_signature' && member.namedChildren.some((child) => child?.type === 'mapped_type_clause')
    );
    if (mappedSignature) return this.c.typeOperators.mappedTypeFromNode(mappedSignature);
    return anonymousObject(() => this.membersStructure(members), { isLiteral: false });
  }

  /** The members of an interface body or an object type literal. */
  // code-gauge-allow functionNcss 42 -- One case per kind of interface member.
  // code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of interface member.
  membersStructure(members: TreeNode[]): Structure {
    const structure = emptyStructure();
    const methods = new Map<string, Signature[]>();
    for (const member of members) {
      switch (member.type) {
        case 'property_signature': {
          const nameNode = member.childForFieldName('name') as TreeNode;
          const name = propertyNameText(nameNode);
          if (name === undefined) break;
          const typeNode = member.childForFieldName('type');
          structure.properties.set(name, {
            name,
            type: () => this.annotationType(typeNode) ?? this.implicitAnyMember(member, nameNode),
            optional: member.children.some((child) => child?.type === '?'),
            readonly: member.children.some((child) => child?.type === 'readonly'),
            isMethod: false,
            visibility: 'public',
            declaration: member,
          });
          break;
        }
        case 'method_signature': {
          const nameNode = member.childForFieldName('name') as TreeNode;
          const name = propertyNameText(nameNode);
          if (name === undefined) break;
          const signatures = methods.get(name) ?? [];
          signatures.push({ ...this.c.signatures.signatureOf(member), isMethod: true });
          methods.set(name, signatures);
          if (!structure.properties.has(name) || methods.get(name)?.length === 1) {
            structure.properties.set(name, {
              name,
              type: () => this.c.overloadedFunction(signatures),
              optional: member.children.some((child) => child?.type === '?'),
              readonly: false,
              isMethod: true,
              visibility: 'public',
              declaration: member,
            });
          }
          break;
        }
        case 'call_signature': {
          structure.callSignatures.push(this.c.signatures.signatureOf(member));
          break;
        }
        case 'construct_signature': {
          structure.constructSignatures.push(this.c.signatures.signatureOf(member));
          break;
        }
        case 'index_signature': {
          const indexType = member.childForFieldName('index_type');
          const info: IndexInfo = {
            type: this.annotationType(member.childForFieldName('type')) ?? anyType,
            readonly: member.children.some((child) => child?.type === 'readonly'),
          };
          const keyType = indexType ? this.typeFromNode(indexType) : stringType;
          if (isIntrinsic(keyType, 'number')) structure.numberIndex = info;
          else structure.stringIndex = info;
          break;
        }
        default: {
          break;
        }
      }
    }
    return structure;
  }

  private implicitAnyMember(member: TreeNode, nameNode: TreeNode): Type {
    if (!this.c.isLibrary(member)) this.c.error(nameNode, `メンバー ${nameNode.text} の型が暗黙に any になります。`);
    return anyType;
  }

  /** The type a type name stands for: an interface, a class's instance type, an alias, or a type parameter. */
  // code-gauge-allow functionNcss 35 -- One case per kind of type declaration, with recursive aliases.
  // code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of type declaration, with recursive aliases.
  declaredTypeOf(symbol: Sym): Type {
    if (symbol.declaredType) return symbol.declaredType;
    switch (symbol.typeKind) {
      case 'typeParameter': {
        symbol.declaredType = this.c.signatures.typeParameterOfSymbol(symbol);
        break;
      }
      case 'interface': {
        symbol.declaredType = this.interfaceType(symbol);
        break;
      }
      case 'class': {
        symbol.declaredType = this.c.classes.classInfoOf(symbol).instanceType;
        break;
      }
      case 'alias': {
        if (symbol.resolving) {
          // An array or a type argument may refer to the alias it is part of, as `type Json = … | Json[]` does.
          if (symbol.pendingUnion && this.deferredDepth > 0) return symbol.pendingUnion;
          this.c.error(symbol.typeDeclarations[0], `型エイリアス ${symbol.name} が自分自身を参照しています。`);
          return errorType;
        }
        symbol.resolving = true;
        const value = symbol.typeDeclarations[0].childForFieldName('value');
        if (value?.type === 'union_type') symbol.pendingUnion = { kind: 'union', id: newTypeId(), types: [] };
        let type = value ? this.typeFromNode(value) : anyType;
        symbol.resolving = false;
        if (symbol.pendingUnion) {
          symbol.pendingUnion.types = type.kind === 'union' ? type.types : [type];
          symbol.pendingUnion = undefined;
        }
        if (type.kind === 'object' && type.objectKind === 'anonymous' && !type.aliasName) {
          type = { ...type, aliasName: symbol.name, aliasArguments: this.c.signatures.typeParametersOfSymbol(symbol) };
        }
        symbol.declaredType ??= type;
        break;
      }
      default: {
        symbol.declaredType = anyType;
      }
    }
    return symbol.declaredType;
  }

  private interfaceType(symbol: Sym): ObjectType {
    let structure: Structure | undefined;
    const typeParameters = this.c.signatures.typeParametersOfSymbol(symbol);
    const type: ObjectType = {
      kind: 'object',
      id: newTypeId(),
      objectKind: 'interface',
      name: symbol.name,
      typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
      resolve: () => {
        if (structure) return structure;
        structure = emptyStructure();
        const own = this.membersStructure(
          symbol.typeDeclarations.flatMap((declaration) => {
            const body = declaration.childForFieldName('body');
            return body ? named(body) : [];
          })
        );
        const bases = symbol.typeDeclarations.flatMap((declaration) => {
          const clause = declaration.namedChildren.find((child) => child?.type === 'extends_type_clause');
          return clause ? named(clause).map((base) => this.typeFromNode(base)) : [];
        });
        structure = this.c.mergeBases(own, bases);
        return structure;
      },
    };
    return type;
  }
}

/** The type nodes whose element types TypeScript resolves later, which lets an alias refer to itself inside them. */
const deferringTypeNodes = new Set(['array_type', 'tuple_type', 'type_arguments', 'readonly_type']);
