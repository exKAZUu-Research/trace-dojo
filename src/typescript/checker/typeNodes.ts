// code-gauge-allow-file fileNcss 534 -- Resolves every kind of type syntax a program writes, each needing its own rule.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { ExecutionLimitError, LIMITS } from '../../interpreter/limits';
import { unsupportedMessage } from '../unsupported';
import type { Checker, Mapper, UnionAlias } from './checker';
import { BROWSER_INTERFACES } from './domGlobals';
import { isGenericObjectOrIndexType } from './genericTypes';
import { IndexedAccessKeys } from './indexedAccessKeys';
import { isPatternKey, isSameKeyType } from './indexInfos';
import { InterfaceBases } from './interfaceBases';
import { withDomMembers } from './library';
import { RecursiveAliases } from './recursiveAliases';
import type { Sym } from './scopes';
import { nameSuggestionHint } from './spelling';
import { hasToken, isStandaloneTypeReference, named, numberValue, propertyNameText, stringValue } from './syntax';
import {
  aliasedDeclaredType,
  anonymousObject,
  anyType,
  bigintType,
  booleanType,
  emptyObjectType,
  emptyStructure,
  errorType,
  falseType,
  functionType,
  type IndexInfo,
  intersectionOf,
  isAnyLike,
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
  thisParameter,
  trueType,
  type TupleElement,
  type Type,
  type TypeParameter,
  undefinedType,
  unionOf,
  type UnionType,
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

const domInterfaceNames = new Set(BROWSER_INTERFACES.map((entry) => (typeof entry === 'string' ? entry : entry[0])));

type ResolvedTypeName = { symbol: Sym; parameters: TypeParameter[] } | { local: TypeParameter } | 'stringMapping';

/** Resolves the types the program writes: annotations, type references, and type declarations. */
export class TypeNodes {
  private readonly typeNodeCache = new Map<number, Type>();
  private readonly restConstraintsInValidation = new Set<number>();
  /** The type each kind of type syntax denotes; the others are `any`. */
  private readonly typeSyntaxes = new Map<string, (node: TreeNode) => Type>([
    ['predefined_type', (node) => predefinedTypes[node.text] ?? anyType],
    ['type_identifier', (node) => this.typeReference(node, node, [])],
    ['nested_type_identifier', (node) => this.qualifiedType(node)],
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
    ['tuple_type', (node) => this.tupleTypeFromNode(node)],
    ['function_type', (node) => this.functionTypeFromNode(node)],
    ['constructor_type', (node) => this.functionTypeFromNode(node)],
    ['object_type', (node) => this.objectTypeLiteral(node)],
    ['type_query', (node) => this.c.expressions.typeOfQuery(named(node)[0])],
    ['index_type_query', (node) => this.c.typeOperators.keyofType(this.typeFromNode(named(node)[0]))],
    ['lookup_type', (node) => this.lookupType(node)],
    ['conditional_type', (node) => this.c.typeOperators.conditionalTypeFromNode(node)],
    ['infer_type', (node) => this.inferType(node)],
    ['template_literal_type', (node) => this.c.typeOperators.templateLiteralFromNode(node)],
    ['this_type', (node) => this.c.classes.thisTypeAt(node)],
    ['type_predicate', () => booleanType],
    ['type_annotation', (node) => this.annotationType(node) ?? anyType],
  ]);

  private readonly indexedAccessKeys: IndexedAccessKeys;
  readonly interfaceBases: InterfaceBases;
  readonly recursiveAliases: RecursiveAliases;

  constructor(private readonly c: Checker) {
    this.indexedAccessKeys = new IndexedAccessKeys(c);
    this.interfaceBases = new InterfaceBases(c);
    this.recursiveAliases = new RecursiveAliases(c);
  }

  /** How many array, tuple, and type argument nodes enclose the type node being resolved. */
  private deferredDepth = 0;
  private resolutionDepth = 0;

  typeFromNode(node: TreeNode): Type {
    const cached = this.typeNodeCache.get(node.id);
    if (cached) return cached;
    this.c.budget.spend();
    if (this.resolutionDepth >= LIMITS.maxCallDepth) throw new ExecutionLimitError('operations');
    this.resolutionDepth++;
    const defers = deferringTypeNodes.has(node.type);
    if (defers) this.deferredDepth++;
    try {
      let type = this.c.checkTypeSyntax(node, () => this.computeTypeFromNode(node));
      // `readonly T[]` is one reference, which the outer node makes.
      if ((defers || node.type === 'generic_type') && node.parent?.type !== 'readonly_type')
        type = this.recursiveAliases.deferred(type);
      this.typeNodeCache.set(node.id, type);
      return type;
    } finally {
      if (defers) this.deferredDepth--;
      this.resolutionDepth--;
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
    const typeArguments = argumentsNode ? this.typeArgumentsOf(name, argumentsNode) : [];
    return name.type === 'nested_type_identifier'
      ? this.qualifiedType(name)
      : this.typeReference(node, name, typeArguments);
  }

  /**
   * The type arguments of a type reference. Those of an interface or a class, as `Array<Tree>`, are deferred like an
   * array's element type, but an alias's are not, as `type R = Record<string, R>` is circular.
   */
  private typeArgumentsOf(name: TreeNode, argumentsNode: TreeNode): Type[] {
    const kind = name.type === 'type_identifier' ? this.c.scopeOf(name).lookupType(name.text)?.typeKind : undefined;
    const defers = kind === 'interface' || kind === 'class';
    if (defers) this.deferredDepth++;
    try {
      return named(argumentsNode).map((argument) => this.typeFromNode(argument));
    } finally {
      if (defers) this.deferredDepth--;
    }
  }

  private readonlyType(node: TreeNode): Type {
    const operand = named(node)[0];
    if (!['array_type', 'tuple_type'].includes(operand.type))
      this.c.errorWhileResolving(node, 'readonly 型修飾子は、配列型かタプル型のリテラルにのみ使えます。');
    const inner = this.typeFromNode(operand);
    if (this.c.isArrayType(inner)) return this.c.arrayType(this.c.elementTypeOf(inner as ObjectType), true);
    if (inner.kind === 'object' && inner.objectKind === 'tuple')
      return this.c.tupleType(inner.tuple?.elements ?? [], true);
    return inner;
  }

  private functionTypeFromNode(node: TreeNode): Type {
    const signature = this.c.signatures.signatureOf(node);
    const nonGeneric = isOutsideGenericDeclarations(node);
    if (node.type === 'function_type') return { ...functionType(signature), nonGeneric };
    return anonymousObject(() => ({ ...emptyStructure(), constructSignatures: [signature] }), {
      isFunction: true,
      nonGeneric,
    });
  }

  private inferType(node: TreeNode): Type {
    this.checkInferPlacement(node);
    return this.c.typeOperators.inferParameterFor(node, named(node)[0].text) ?? anyType;
  }

  /** Reports an `infer` declaration outside the extends type of a conditional type, the only place it declares a type. */
  checkInferPlacement(node: TreeNode): void {
    for (let child = node; child.parent; child = child.parent) {
      if (child.parent.type === 'conditional_type' && child.parent.childForFieldName('right')?.id === child.id) return;
    }
    this.c.errorWhileResolving(node, 'infer による宣言は、条件型の extends 節の中にしか書けません。');
  }

  private lookupType(node: TreeNode): Type {
    const [object, index] = named(node);
    const objectType = this.typeFromNode(object);
    const indexType = this.typeFromNode(index);
    if (
      objectType.kind === 'typeParameter' &&
      this.indexedAccessKeys.isInvalid(objectType, indexType, (parameter) =>
        this.conditionalExtendsTypes(node, parameter)
      )
    ) {
      this.c.error(index, `型 '${this.c.print(indexType)}' は型 '${objectType.name}' のインデックスに使えません。`);
      return errorType;
    }
    return this.c.typeOperators.indexedAccess(objectType, indexType, index);
  }

  /**
   * Whether a rest's type parameter is an array where the rest is written: in the true branch of a conditional type that
   * checks it against an array type, as TypeScript's substitution types narrow it.
   */
  private narrowedToArray(node: TreeNode, type: Type): boolean {
    return (
      type.kind === 'typeParameter' &&
      this.conditionalExtendsTypes(node, type).some((extendsType) => this.validTupleRestType(extendsType))
    );
  }

  /**
   * The types that the conditional types whose true branch holds `node` check `parameter` against, as `X extends C` and
   * `[X] extends [C]` do; `any` and `unknown` do not narrow it.
   */
  private conditionalExtendsTypes(node: TreeNode, parameter: TypeParameter): Type[] {
    const types: Type[] = [];
    let child = node;
    for (let current = node.parent; current; current = current.parent) {
      if (current.type === 'conditional_type' && current.childForFieldName('consequence')?.id === child.id) {
        const [check, extendsNode] = unwrapUnaryTuples(
          current.childForFieldName('left') as TreeNode,
          current.childForFieldName('right') as TreeNode
        );
        const extendsType = this.typeFromNode(check).id === parameter.id ? this.typeFromNode(extendsNode) : undefined;
        if (extendsType && !isIntrinsic(extendsType, 'any') && !isIntrinsic(extendsType, 'unknown'))
          types.push(extendsType);
      }
      child = current;
    }
    return types;
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

  private tupleTypeFromNode(node: TreeNode): Type {
    let optionalSeen = false;
    let restSeen = false;
    const elements = named(node).map((element) => {
      const type = this.tupleElement(element);
      const concreteRest = type.rest && this.hasConcreteRest(type.type);
      if (concreteRest && restSeen) this.c.error(element, 'タプル型に複数の残余要素は書けません。');
      if (type.rest && !this.validTupleRestType(type.type) && !this.narrowedToArray(element, type.type))
        this.c.error(element, '残余要素の型は配列型にしてください。');
      if (type.optional && restSeen) this.c.error(element, '残余要素の後に省略可能な要素は書けません。');
      if (!type.optional && !type.rest && optionalSeen)
        this.c.error(element, '省略可能な要素の後に必須の要素は書けません。');
      optionalSeen ||= type.optional;
      restSeen ||= concreteRest;
      return type;
    });
    return this.c.tupleType(elements);
  }

  private validTupleRestType(type: Type, seen = new Set<number>()): boolean {
    if (isAnyLike(type) || isIntrinsic(type, 'never')) return true;
    if (seen.has(type.id)) return false;
    seen.add(type.id);
    try {
      if (type.kind === 'typeParameter') {
        const constraint = this.c.constraintOf(type);
        return constraint !== undefined && this.validTupleRestType(constraint, seen);
      }
      if (type.kind === 'union') return type.types.every((member) => this.validTupleRestType(member, seen));
      if (type.kind === 'intersection') return type.types.some((member) => this.validTupleRestType(member, seen));
      // A deferred generic type, such as a conditional one, is an array when its constraint is; one whose constraint
      // holds this rest again, as a recursive tuple type's does, is taken as valid.
      if (type.kind !== 'object') {
        if (this.restConstraintsInValidation.has(type.id)) return true;
        this.restConstraintsInValidation.add(type.id);
        try {
          const constraint = this.c.baseConstraint(type);
          return constraint !== type && this.validTupleRestType(constraint, seen);
        } finally {
          this.restConstraintsInValidation.delete(type.id);
        }
      }
      return (
        this.c.isArrayOrTuple(type) ||
        this.c.relations.isAssignable(type, this.c.globalType('ReadonlyArray', [anyType]))
      );
    } finally {
      seen.delete(type.id);
    }
  }

  private hasConcreteRest(type: Type): boolean {
    if (type.kind === 'union' || type.kind === 'intersection')
      return type.types.some((member) => this.hasConcreteRest(member));
    if (type.kind !== 'object') return false;
    if (type.objectKind === 'tuple')
      return (type.tuple?.elements ?? []).some((element) => element.rest && this.hasConcreteRest(element.type));
    return this.validTupleRestType(type);
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

  /** Checks names even in annotations whose types remained lazy or were resolved silently. */
  checkWrittenTypeNames(root: TreeNode): void {
    for (const node of root.descendantsOfType(['type_identifier', 'generic_type', 'nested_type_identifier'])) {
      this.c.budget.spend();
      if (node.type === 'nested_type_identifier') this.qualifiedType(node);
      else if (node.type === 'generic_type') {
        const name = node.childForFieldName('name');
        const argumentsNode = node.childForFieldName('type_arguments');
        if (name && name.type !== 'nested_type_identifier')
          this.resolveTypeName(node, name, argumentsNode ? named(argumentsNode).length : 0);
      } else if (isStandaloneTypeReference(node)) this.resolveTypeName(node, node, 0);
    }
  }

  private typeReference(node: TreeNode, nameNode: TreeNode, typeArguments: Type[]): Type {
    const reference = this.resolveTypeName(node, nameNode, typeArguments.length);
    if (!reference) return errorType;
    if (reference === 'stringMapping')
      return this.c.typeOperators.stringMappingFromNode(node, nameNode.text as 'Uppercase', typeArguments[0]);
    if ('local' in reference) return reference.local;
    const { symbol, parameters } = reference;
    const declared = this.declaredTypeOf(symbol);
    if (parameters.length === 0) return declared;
    const filled = this.c.fillTypeArguments(parameters, typeArguments);
    this.checkWrittenTypeArgumentConstraints(node, parameters, filled);
    return this.appliedType(symbol, declared, parameters, filled);
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- Checks local bindings, intrinsic types, unavailable symbols, and argument counts.
  private resolveTypeName(node: TreeNode, nameNode: TreeNode, argumentCount: number): ResolvedTypeName | undefined {
    const name = nameNode.text;
    const scope = this.c.scopeOf(nameNode);
    const symbol = scope.lookupType(name);
    const local = this.c.typeOperators.mappedOrInferParameter(nameNode, name, symbol?.scope.node);
    if (local) {
      if (argumentCount > 0) this.c.error(node, `型 ${name} は型引数をとりません。`);
      return { local };
    }
    if (stringMappings.has(name) && argumentCount === 1 && !symbol?.typeDeclarations.length) return 'stringMapping';
    if (!symbol) {
      this.c.error(
        nameNode,
        scope.lookupValue(name)
          ? `${name} は値であり、型としては使えません。型を表すには typeof ${name} と書いてください。`
          : `型 ${name} が見つかりません。${nameSuggestionHint(scope, name, 'type', this.c.budget)}`
      );
      return undefined;
    }
    if (this.reportUnusableSymbol(node, nameNode, symbol)) return undefined;
    const parameters = this.c.signatures.typeParametersOfSymbol(symbol);
    if (parameters.length === 0) {
      if (argumentCount > 0) this.c.error(node, `型 ${name} は型引数をとりません。`);
      return { symbol, parameters };
    }
    const required = parameters.filter((parameter) => !parameter.default).length;
    if (argumentCount < required || argumentCount > parameters.length) {
      this.c.error(
        node,
        required === parameters.length
          ? `ジェネリック型 ${name} には型引数が ${required} 個必要です。`
          : `ジェネリック型 ${name} には型引数が ${required} 個から ${parameters.length} 個必要です。`
      );
      return undefined;
    }
    return { symbol, parameters };
  }

  /** Reports a type the name cannot refer to here: an unsupported library type, or a class type parameter in a static member. */
  private reportUnusableSymbol(node: TreeNode, nameNode: TreeNode, symbol: Sym): boolean {
    if (symbol.unsupported) {
      this.c.error(node, unsupportedMessage(symbol.unsupported));
      return true;
    }
    if (!this.c.classes.isClassTypeParameterInStaticMember(symbol, nameNode)) return false;
    this.c.error(nameNode, '静的メンバーはクラスの型パラメーターを参照できません。');
    return true;
  }

  private appliedType(symbol: Sym, declared: Type, parameters: TypeParameter[], typeArguments: Type[]): Type {
    if (symbol.typeKind === 'alias') return this.aliasReference(symbol, declared, parameters, typeArguments);
    // An opaque DOM interface is `any`, whatever its type arguments.
    return declared.kind === 'object' ? this.c.reference(declared, typeArguments) : declared;
  }

  private aliasReference(symbol: Sym, declared: Type, parameters: TypeParameter[], typeArguments: Type[]): Type {
    // Inside its own declaration, an alias applied to its own type parameters is the alias being resolved.
    if (typeArguments.every((argument, index) => argument === parameters[index])) return declared;
    const mapper: Mapper = new Map(parameters.map((parameter, index) => [parameter.id, typeArguments[index]]));
    if (symbol.pendingUnion === declared) return this.c.deferredAliasUnion(unionAlias(symbol), mapper);
    if (this.recursiveAliases.isPendingType(symbol, declared)) return this.recursiveAliases.reference(symbol, mapper);
    return this.c.instantiate(declared, mapper);
  }

  private qualifiedType(node: TreeNode): Type {
    if (this.c.isLibrary(node)) {
      const name = node.text.startsWith('Intl.') ? node.text.slice('Intl.'.length) : undefined;
      const symbol = name ? this.c.localeOptionsBinder.moduleScope.types.get(name) : undefined;
      return symbol ? this.declaredTypeOf(symbol) : anyType;
    }
    let root = node;
    while (root.childForFieldName('module') ?? root.childForFieldName('object'))
      root = (root.childForFieldName('module') ?? root.childForFieldName('object')) as TreeNode;
    const symbol = this.c.scopeOf(root).lookupType(root.text) ?? this.c.scopeOf(root).lookupValue(root.text);
    this.c.error(
      node,
      symbol?.unsupported ? unsupportedMessage(symbol.unsupported) : `名前空間 ${root.text} が見つかりません。`
    );
    return errorType;
  }

  checkWrittenTypeArgumentConstraints(node: TreeNode, parameters: TypeParameter[], typeArguments: Type[]): void {
    this.interfaceBases.afterResolving(() =>
      this.c.checkTypeSyntax(node, () => this.checkTypeArgumentConstraints(node, parameters, typeArguments))
    );
  }

  checkTypeArgumentConstraints(node: TreeNode, parameters: TypeParameter[], typeArguments: Type[]): void {
    const mapper: Mapper = new Map(parameters.map((parameter, index) => [parameter.id, typeArguments[index]]));
    for (const [index, parameter] of parameters.entries()) {
      const constraint = parameter.constraint?.();
      if (!constraint) continue;
      const argument = typeArguments[index];
      const instantiated = this.c.instantiate(constraint, mapper);
      if (!this.c.relations.isAssignable(argument, instantiated))
        this.c.error(node, this.c.expressions.elaboration.typeRelationMessage(argument, instantiated, 'constraint'));
    }
  }

  private objectTypeLiteral(node: TreeNode): Type {
    const members = named(node);
    if (members.length === 0) return emptyObjectType;
    if (members[0] && isMappedMember(members[0])) {
      if (members[1]) this.c.errorWhileResolving(members[1], mappedTypeMembersMessage);
      return this.c.typeOperators.mappedTypeFromNode(members[0]);
    }
    return anonymousObject(() => this.membersStructure(members), {
      isLiteral: false,
      nonGeneric: isOutsideGenericDeclarations(node),
    });
  }

  /** The members of an interface body or an object type literal. */
  // code-gauge-allow functionNcss 45 -- Handles interface properties, accessor signatures, methods, calls, constructors, and index signatures.
  // code-gauge-allow functionCognitiveComplexity 24 -- Handles interface properties, accessor signatures, methods, calls, constructors, and index signatures.
  membersStructure(members: TreeNode[]): Structure {
    const structure = emptyStructure();
    const methods = new Map<string, Signature[]>();
    for (const member of members) {
      switch (member.type) {
        case 'property_signature': {
          const nameNode = member.childForFieldName('name') as TreeNode;
          const name = this.memberName(nameNode);
          const typeNode = member.childForFieldName('type');
          const type = (): Type => this.annotationType(typeNode) ?? this.implicitAnyMember(member, nameNode);
          if (name === undefined) {
            this.addComputedMemberIndex(structure, member, nameNode, type);
            break;
          }
          structure.properties.set(name, {
            name,
            type,
            nameType: this.memberKeyType(nameNode),
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
          const name = this.memberName(nameNode);
          if (name === undefined) {
            this.addComputedMemberIndex(structure, member, nameNode, () => this.computedMethodType(member));
            break;
          }
          if (hasToken(member, 'get') || hasToken(member, 'set')) {
            this.addAccessorSignature(structure, member, name);
            break;
          }
          const signatures = methods.get(name) ?? [];
          signatures.push({ ...this.c.signatures.signatureOf(member), isMethod: true });
          methods.set(name, signatures);
          if (!structure.properties.has(name) || methods.get(name)?.length === 1) {
            structure.properties.set(name, {
              name,
              nameType: this.memberKeyType(nameNode),
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
          this.addIndexSignature(structure, member);
          break;
        }
        default: {
          break;
        }
      }
    }
    return structure;
  }

  addComputedMemberIndex(structure: Structure, member: TreeNode, nameNode: TreeNode, valueType: () => Type): void {
    const keyType = this.memberKeyType(nameNode);
    if (!keyType) return;
    const constraint = this.c.baseConstraint(keyType);
    const type = valueType();
    const info = {
      type: hasToken(member, '?') ? unionOf([type, undefinedType]) : type,
      readonly: hasToken(member, 'readonly') || hasToken(member, 'get'),
    };
    for (const key of constraint.kind === 'union' ? constraint.types : [constraint])
      if (isValidIndexKeyType(key)) addIndexInfo(structure, key, info);
  }

  private memberKeyType(nameNode: TreeNode): Type | undefined {
    if (nameNode.type !== 'computed_property_name') return undefined;
    if (this.librarySymbolName(nameNode) !== undefined) return symbolType;
    return this.c.flow.probe(() => this.c.silently(() => this.c.expressions.check(named(nameNode)[0])));
  }

  private computedMethodType(member: TreeNode): Type {
    const signature = this.c.signatures.signatureOf(member);
    if (hasToken(member, 'get')) return signature.returnType();
    if (hasToken(member, 'set')) return signature.parameters[0]?.type ?? anyType;
    return this.c.overloadedFunction([{ ...signature, isMethod: true }]);
  }

  /**
   * Adds the index signature of each valid key type an index signature declares, as `[k: string | symbol]` declares
   * two, combining the value types declared for the same key type.
   */
  addIndexSignature(structure: Structure, member: TreeNode): void {
    if (isMappedMember(member)) {
      // TypeScript reads `[K in T]` after other members as a property with a computed name it rejects.
      const firstMember = member.parent ? named(member.parent)[0] : member;
      this.c.errorWhileResolving(firstMember ?? member, mappedTypeMembersMessage);
      return;
    }
    const indexType = member.childForFieldName('index_type');
    const info: IndexInfo = {
      type: this.annotationType(member.childForFieldName('type')) ?? anyType,
      readonly: member.children.some((child) => child?.type === 'readonly'),
    };
    const keyType = indexType ? this.typeFromNode(indexType) : stringType;
    const keyError = indexKeyTypeError(keyType);
    if (keyError) this.c.errorWhileResolving(member.childForFieldName('name') ?? member, keyError);
    for (const key of keyType.kind === 'union' ? keyType.types : [keyType])
      if (isValidIndexKeyType(key)) addIndexInfo(structure, key, info);
  }

  /** The name of a member, which a computed key gives by its literal type, as a constant's. */
  memberName(nameNode: TreeNode): string | undefined {
    const written = propertyNameText(nameNode);
    if (written !== undefined || nameNode.type !== 'computed_property_name') return written;
    const librarySymbol = this.librarySymbolName(nameNode);
    if (librarySymbol !== undefined) return `__@${librarySymbol}`;
    const names = this.c.silently(() => this.c.patterns.capturePropertyNames(nameNode));
    return names?.length === 1 ? names[0] : undefined;
  }

  private librarySymbolName(node: TreeNode): string | undefined {
    if (!this.c.isLibrary(node)) return undefined;
    const symbol = named(node)[0];
    if (symbol?.type === 'member_expression' && symbol.childForFieldName('object')?.text === 'Symbol')
      return symbol.childForFieldName('property')?.text;
    return undefined;
  }

  private implicitAnyMember(member: TreeNode, nameNode: TreeNode): Type {
    if (!this.c.isLibrary(member)) this.c.error(nameNode, `メンバー ${nameNode.text} の型が暗黙に any になります。`);
    return anyType;
  }

  private addAccessorSignature(structure: Structure, member: TreeNode, name: string): void {
    const getter = hasToken(member, 'get');
    const signature = this.c.signatures.signatureOf(member);
    const type = getter ? signature.returnType : () => signature.parameters[0]?.type ?? anyType;
    const previous = structure.properties.get(name);
    structure.properties.set(name, {
      name,
      nameType: this.memberKeyType(member.childForFieldName('name') as TreeNode),
      type: getter ? type : (previous?.type ?? type),
      writeType: getter ? previous?.writeType : type,
      optional: false,
      readonly: getter && !previous?.writeType,
      getterOnly: getter && !previous?.writeType,
      isMethod: false,
      visibility: 'public',
      declaration: member,
    });
  }

  /** The type a type name stands for: an interface, a class's instance type, an alias, or a type parameter. */
  declaredTypeOf(symbol: Sym): Type {
    if (symbol.declaredType) return symbol.declaredType;
    switch (symbol.typeKind) {
      case 'typeParameter': {
        symbol.declaredType = this.c.signatures.typeParameterOfSymbol(symbol);
        break;
      }
      case 'interface': {
        symbol.declaredType = this.isOpaqueDomInterface(symbol) ? anyType : this.interfaceType(symbol);
        break;
      }
      case 'class': {
        symbol.declaredType = this.c.classes.classInfoOf(symbol).instanceType;
        break;
      }
      case 'alias': {
        if (symbol.resolving) return this.aliasSelfReference(symbol);
        symbol.declaredType ??= this.aliasType(symbol);
        break;
      }
      default: {
        symbol.declaredType = anyType;
      }
    }
    return symbol.declaredType;
  }

  /** What a reference to an alias inside its own declaration stands for. */
  private aliasSelfReference(symbol: Sym): Type {
    // An array or a type argument may refer to the alias it is part of, as `type Json = … | Json[]` does.
    if (this.deferredDepth > 0) return symbol.pendingUnion ?? this.recursiveAliases.pendingTypeOf(symbol);
    this.c.error(symbol.typeDeclarations[0], `型エイリアス ${symbol.name} が自分自身を参照しています。`);
    return errorType;
  }

  /** A DOM interface the program does not merge into, whose members the library leaves out. */
  isOpaqueDomInterface(symbol: Sym): boolean {
    return (
      domInterfaceNames.has(symbol.name) &&
      symbol.typeDeclarations.every((declaration) => this.c.isLibrary(declaration))
    );
  }

  private aliasType(symbol: Sym): Type {
    const declaration = symbol.typeDeclarations[0];
    const value = declaration.childForFieldName('value');
    if (value?.text === 'intrinsic' && this.c.isLibrary(declaration)) {
      if (symbol.name === 'BuiltinIteratorReturn') return undefinedType;
      if (symbol.name === 'NoInfer') return { ...this.c.signatures.typeParametersOfSymbol(symbol)[0], noInfer: true };
    }
    symbol.resolving = true;
    const pending: UnionType | undefined =
      value?.type === 'union_type' ? { kind: 'union', id: newTypeId(), types: [] } : undefined;
    if (pending) this.c.registerAliasUnion(pending, unionAlias(symbol));
    symbol.pendingUnion = pending;
    const type = value ? this.typeFromNode(value) : anyType;
    symbol.resolving = false;
    symbol.pendingUnion = undefined;
    if (pending) pending.types = type.kind === 'union' ? type.types : [type];
    const declared = aliasedDeclaredType(
      type,
      symbol.name,
      this.c.signatures.typeParametersOfSymbol(symbol),
      symbol.id
    );
    return this.recursiveAliases.complete(symbol, declared);
  }

  interfaceType(symbol: Sym): ObjectType {
    let structure: Structure | undefined;
    const typeParameters = this.c.signatures.typeParametersOfSymbol(symbol);
    const type: ObjectType = {
      kind: 'object',
      id: newTypeId(),
      objectKind: 'interface',
      name: symbol.name,
      outerTypeParameters: this.c.signatures.outerTypeParametersOf(symbol.typeDeclarations[0]),
      typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
      resolve: () => {
        if (structure) return structure;
        const bases = this.interfaceBases.baseTypesOf(symbol);
        // Resolving its bases may resolve the interface itself, as a base's type arguments or keys may need its members.
        if (structure) return structure;
        structure = emptyStructure();
        structure = this.c.mergeBases(this.interfaceOwnMembers(symbol.typeDeclarations), bases, type.thisType);
        return structure;
      },
    };
    if (symbol.typeDeclarations.some(interfaceUsesThis)) type.thisType = thisParameter(type);
    this.interfaceBases.register(type, symbol);
    return type;
  }

  /** The members merged interface declarations declare, and the types they extend. */
  interfaceMembers(declarations: TreeNode[]): { own: Structure; bases: Type[] } {
    return {
      own: this.interfaceOwnMembers(declarations),
      bases: this.interfaceBases.basesOf(declarations),
    };
  }

  interfaceOwnMembers(merged: TreeNode[]): Structure {
    const members = merged.map((declaration) => {
      const body = withDomMembers(declaration).childForFieldName('body');
      return body ? named(body) : [];
    });
    // TypeScript merges the overloads of later declarations before those of earlier ones.
    return this.membersStructure([
      ...members.toReversed().flatMap((list) => list.filter((member) => !isIndexSignature(member))),
      ...members.flat().filter(isIndexSignature),
    ]);
  }
}

/** A derived interface can inherit a polymorphic `this` from its bases. */
function interfaceUsesThis(declaration: TreeNode): boolean {
  return (
    declaration.namedChildren.some((child) => child?.type === 'extends_type_clause') ||
    declaration.descendantsOfType('this_type').length > 0
  );
}

const mappedTypeMembersMessage = 'マップ型には、プロパティやメソッドを宣言できません。';

function addIndexInfo(structure: Structure, key: Type, info: IndexInfo): void {
  if (isIntrinsic(key, 'number')) structure.numberIndex = combinedIndexInfo(structure.numberIndex, info);
  else if (isIntrinsic(key, 'symbol')) structure.symbolIndex = combinedIndexInfo(structure.symbolIndex, info);
  else if (!isPatternKey(key)) structure.stringIndex = combinedIndexInfo(structure.stringIndex, info);
  else {
    const existing = structure.patternIndexes?.find((index) => isSameKeyType(index.keyType, key));
    structure.patternIndexes = existing
      ? structure.patternIndexes?.map((index) =>
          index === existing ? { ...index, ...combinedIndexInfo(index, info) } : index
        )
      : [...(structure.patternIndexes ?? []), { ...info, keyType: key }];
  }
}

function combinedIndexInfo(previous: IndexInfo | undefined, info: IndexInfo): IndexInfo {
  return previous ? { type: unionOf([previous.type, info.type]), readonly: previous.readonly && info.readonly } : info;
}

/** The grammar error TypeScript reports on an index signature's key type, which only valid key types escape. */
function indexKeyTypeError(keyType: Type): string | undefined {
  const keys = keyType.kind === 'union' ? keyType.types : [keyType];
  const literal = keys.some((key) => key.kind === 'literal' && typeof key.value !== 'boolean');
  if (literal || isGenericObjectOrIndexType(keyType))
    return 'インデックスシグネチャの引数の型に、リテラル型やジェネリック型は使えません。マップ型を使ってください。';
  if (!keys.every((key) => isValidIndexKeyType(key)))
    return "インデックスシグネチャの引数の型は、'string'、'number'、'symbol'、テンプレートリテラル型のいずれかでなければいけません。";
  return undefined;
}

/** As TypeScript's `isValidIndexKeyType`, whether an index signature may have a key type. */
function isValidIndexKeyType(key: Type): boolean {
  if (isIntrinsic(key, 'string') || isIntrinsic(key, 'number') || isIntrinsic(key, 'symbol') || isPatternKey(key))
    return true;
  return key.kind === 'intersection' && !isGenericObjectOrIndexType(key) && key.types.some(isValidIndexKeyType);
}

function isIndexSignature(member: TreeNode): boolean {
  return member.type === 'index_signature';
}

/** Whether a member of an object type is written as a mapped type's `[K in T]: …`. */
function isMappedMember(member: TreeNode): boolean {
  return (
    member.type === 'index_signature' && member.namedChildren.some((child) => child?.type === 'mapped_type_clause')
  );
}

/** The type nodes whose element types TypeScript resolves later, which lets an alias refer to itself inside them. */
const deferringTypeNodes = new Set(['array_type', 'tuple_type', 'readonly_type']);

/** The check and extends types of a conditional type inside the one-element tuples both are wrapped in, as `[X] extends [C]`. */
function unwrapUnaryTuples(check: TreeNode, extendsNode: TreeNode): [TreeNode, TreeNode] {
  if (
    check.type !== 'tuple_type' ||
    extendsNode.type !== 'tuple_type' ||
    named(check).length !== 1 ||
    named(extendsNode).length !== 1
  )
    return [check, extendsNode];
  return unwrapUnaryTuples(named(check)[0], named(extendsNode)[0]);
}

/** Declarations whose type parameters, `this` type, or `infer` types may occur in the type nodes they enclose. */
const typeParameterScopes = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'class',
  'interface_declaration',
  'conditional_type',
  'index_signature',
  'mapped_type_clause',
]);

/** Whether a type node lies outside every declaration that brings type parameters into scope. */
function isOutsideGenericDeclarations(node: TreeNode): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (typeParameterScopes.has(current.type) || current.childForFieldName('type_parameters')) return false;
  }
  return true;
}

function unionAlias(symbol: Sym): UnionAlias {
  return { id: symbol.id, type: () => symbol.declaredType };
}
