// code-gauge-allow-file fileNcss 579 -- Types array and object literals with their spreads, members, and widening, which share one literal state.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { applicableIndex, isSamePattern } from './indexInfos';
import { arrayLiteralLength, arrayPatternElements, hasToken, isNumericName, named, propertyNameText } from './syntax';
import {
  anonymousObject,
  anyType,
  emptyStructure,
  errorType,
  filterType,
  type IndexInfo,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  isPropertyKeyLiteral,
  isSymbolName,
  literalType,
  mapType,
  neverType,
  newTypeId,
  numberType,
  type ObjectType,
  type Property,
  regularOf,
  stringType,
  type Structure,
  symbolType,
  type Type,
  type TypeParameter,
  undefinedType,
  unionOf,
  unknownType,
} from './types';

type MemberKind = 'property' | 'get' | 'set';
type IndexKey = 'stringIndex' | 'numberIndex' | 'symbolIndex';
type Indexes = Pick<Structure, IndexKey | 'patternIndexes'>;

/** An object literal being checked, with the members checked so far. */
interface ObjectLiteral {
  contextual: Type | undefined;
  isConstContext: boolean;
  properties: Map<string, Property>;
  /**
   * The members written since the last spread, which give the literal an index signature for each key kind that a
   * computed key of no literal type has: the names of those with a name, and the key kinds and types of the others.
   */
  writtenNames: Set<string>;
  computedMembers: { key: IndexKey; type: Type }[];
  /** Whether members are written since the last spread, which TypeScript spreads as one object literal. */
  hasPendingMembers?: boolean;
  /** Spreads of type parameters, which the literal's type intersects. */
  genericSpreads: Type[];
  /**
   * After a spread of a union, the properties each of its alternatives gives the literal, which `properties` (the
   * members written since) then override.
   */
  alternatives?: Map<string, Property>[];
  /**
   * Once the literal spreads, the index signatures of each alternative (or of the literal without union spreads),
   * which TypeScript keeps only where every spread part has them.
   */
  spreadIndexes?: Indexes[];
  /** How many alternatives TypeScript counts its union spreads to make, which may be more than `alternatives`. */
  complexity?: number;
  /** Whether its spreads made more alternatives than TypeScript represents, which makes the literal an error. */
  isTooComplex?: boolean;
  /** Whether it spreads a value of type `any` or one that cannot be spread, which makes the literal's type `any`. */
  spreadsAny?: boolean;
  /**
   * The kinds of member seen so far under each name, and whether an accessor conflict has stopped TypeScript from
   * checking the rest of the literal's names.
   */
  seenKeys: Map<string, Set<MemberKind>>;
  stopsKeyCheck?: boolean;
  object: ObjectType;
  /** What `this` is in the literal's methods. */
  receiver: Type;
  declarations: Map<string, Property>;
}

/** Checks array and object literals and widens the types of their values. */
export class LiteralChecker {
  private readonly arrayLiterals = new Set<number>();
  private readonly tupleLiterals = new Set<number>();
  /** The node of each object literal type, whose members alone TypeScript checks for excess properties. */
  private readonly objectLiteralNodes = new Map<number, TreeNode>();
  /** The contextual type of each object literal checked, by node, which the `this` of a literal inside it may need. */
  private readonly objectLiteralContexts = new Map<number, Type | undefined>();

  constructor(private readonly c: Checker) {}

  arrayLiteral(node: TreeNode, contextual?: Type): Type {
    const elements = arrayElements(node);
    const isConstContext = this.isConstContext(node);
    const types: { type: Type; spread: boolean }[] = elements.map((element, index) => {
      // A hole, as in `[, 1]`, reads as `undefined`.
      if (!element) return { type: undefinedType, spread: false };
      if (element.type === 'spread_element') {
        const spread = this.c.expressions.check(named(element)[0]);
        return { type: spread, spread: true };
      }
      const contexts = contextual ? this.arrayElementContexts(contextual, index, elements.length) : [];
      const context = contexts.length > 0 ? unionOf(contexts) : undefined;
      const type = this.c.expressions.check(element, context);
      const literalContext = contexts.find((candidate) => this.expectsLiteral(candidate, type)) ?? context;
      return { type: isConstContext ? type : this.widenForMutableLocation(type, literalContext), spread: false };
    });
    if (isConstContext || this.isInTupleContext(node, contextual)) {
      return this.tupleOfElements(node, elements, types, isConstContext);
    }
    const elementTypes = types.map(({ type, spread }, index) =>
      spread ? this.spreadElementType(elements[index] as TreeNode, type) : type
    );
    const array = {
      ...this.c.arrayType(elementTypes.length === 0 ? neverType : unionOf(elementTypes, true)),
      id: newTypeId(),
    };
    this.arrayLiterals.add(array.id);
    return array;
  }

  /** The tuple an array literal is where a tuple or `as const` expects it, with what its spreads spread. */
  private tupleOfElements(
    node: TreeNode,
    elements: (TreeNode | undefined)[],
    types: { type: Type; spread: boolean }[],
    isConstContext: boolean
  ): Type {
    const tupleElements = types.flatMap(({ type, spread }, index) => {
      if (!spread) return [{ type: isConstContext ? regularOf(type) : type, optional: false, rest: false }];
      if (type.kind === 'object' && type.objectKind === 'tuple') return type.tuple?.elements ?? [];
      return [
        {
          type: this.c.arrayType(this.spreadElementType(elements[index] as TreeNode, type)),
          optional: false,
          rest: true,
        },
      ];
    });
    const tuple = { ...this.c.tupleType(tupleElements, isConstContext), id: newTypeId() };
    this.tupleLiterals.add(tuple.id);
    return tuple;
  }

  /** The elements a spread adds to an array literal; `never` is an array there, as TypeScript's `isArrayLikeType` has it. */
  private spreadElementType(spread: TreeNode, type: Type): Type {
    return isIntrinsic(type, 'never') ? neverType : this.c.patterns.iteratedType(named(spread)[0], type);
  }

  isArrayLiteral(type: Type): boolean {
    return this.arrayLiterals.has(type.id);
  }

  /** Whether an array or a tuple is the type of an array literal, the only kind whose elements may be fresh. */
  isArrayOrTupleLiteral(type: Type): boolean {
    return this.arrayLiterals.has(type.id) || this.tupleLiterals.has(type.id);
  }

  /** Whether a property of an object literal type is written in the literal, rather than copied by a spread. */
  isWrittenMember(literal: ObjectType, property: Property): boolean {
    const node = this.objectLiteralNodes.get(literal.id);
    return node !== undefined && property.declaration?.parent?.id === node.id;
  }

  /** Whether an array literal is a tuple by where it is written, as TypeScript's `checkArrayLiteral` decides. */
  private isInTupleContext(node: TreeNode, contextual: Type | undefined): boolean {
    return (
      (contextual !== undefined &&
        (this.tupleContexts(contextual).length > 0 || this.isGenericHomomorphicMapped(contextual))) ||
      isSpreadIntoCall(node)
    );
  }

  private tupleContexts(contextual: Type): ObjectType[] {
    const members = contextual.kind === 'union' ? contextual.types : [contextual];
    return members.filter((member): member is ObjectType => member.kind === 'object' && member.objectKind === 'tuple');
  }

  /** Whether `contextual` has a generic homomorphic mapped type, which TypeScript takes as a tuple context. */
  private isGenericHomomorphicMapped(contextual: Type): boolean {
    return (contextual.kind === 'union' ? contextual.types : [contextual]).some(
      (member) =>
        member.kind === 'object' &&
        member.objectKind === 'mapped' &&
        member.mapped?.source !== undefined &&
        !member.mapped.nameType &&
        this.c.relations.isGeneric(member)
    );
  }

  private arrayElementContexts(contextual: Type, index: number, length: number): Type[] {
    if (contextual.kind === 'union')
      return contextual.types.flatMap((member) => this.arrayElementContexts(member, index, length));
    const context =
      contextual.kind === 'object' && contextual.objectKind === 'tuple'
        ? this.tupleElementContext(contextual, index, length)
        : this.elementContext(contextual);
    return context === undefined ? [] : [context];
  }

  private tupleElementContext(tuple: ObjectType, index: number, length: number): Type | undefined {
    const elements = tuple.tuple?.elements ?? [];
    const restIndex = elements.findIndex((member) => member.rest);
    if (restIndex === -1 || index < restIndex) return elements[index]?.type;
    const tailLength = elements.length - restIndex - 1;
    const tailStart = length - tailLength;
    if (index >= tailStart) return elements[restIndex + 1 + index - tailStart]?.type;
    return this.c.restElementType(elements[restIndex].type);
  }

  private elementContext(contextual: Type): Type | undefined {
    const members = (contextual.kind === 'union' ? contextual.types : [contextual]).filter(
      (member) => member.kind === 'object' && this.c.isArrayOrTuple(member)
    );
    if (members.length > 0) return unionOf(members.map((member) => this.c.elementTypeOf(member as ObjectType)));
    // Any other iterable, such as `Iterable<[string, T]>`, gives its elements the type it iterates.
    const iterated = (contextual.kind === 'union' ? contextual.types : [contextual])
      .filter((member) => member.kind === 'object' && this.c.propertyOf(member, '__@iterator'))
      .map((member) => this.c.silently(() => this.c.patterns.iteratedType(undefined, member)))
      .filter((type) => type !== errorType && !isAnyLike(type));
    return iterated.length > 0 ? unionOf(iterated) : undefined;
  }

  /** Whether an expression is in a `const` context, inside `as const`. */
  isConstContext(node: TreeNode): boolean {
    let current: TreeNode | null = node.parent;
    let child: TreeNode = node;
    while (current) {
      if (current.type === 'as_expression')
        return current.children.some((part) => part?.type === 'const') && named(current)[0]?.id === child.id;
      if (current.type === 'type_assertion') return named(current)[0]?.text === 'const';
      if (
        ![
          'parenthesized_expression',
          'array',
          'object',
          'pair',
          'spread_element',
          'ternary_expression',
          'template_substitution',
          'template_string',
        ].includes(current.type)
      )
        return false;
      child = current;
      current = current.parent;
    }
    return false;
  }

  objectLiteral(node: TreeNode, contextual?: Type): Type {
    const properties = new Map<string, Property>();
    const declarations = new Map<string, Property>();
    const discriminated = contextual && this.discriminatedContext(node, contextual);
    this.objectLiteralContexts.set(node.id, discriminated);
    const literal: ObjectLiteral = {
      contextual: discriminated,
      isConstContext: this.isConstContext(node),
      properties,
      declarations,
      receiver: this.receiverOf(
        node,
        discriminated,
        anonymousObject(() => ({ ...emptyStructure(), properties: declarations }))
      ),
      genericSpreads: [],
      writtenNames: new Set(),
      computedMembers: [],
      seenKeys: new Map(),
      object: anonymousObject(
        () => ({
          ...emptyStructure(),
          ...(literal.spreadIndexes?.[0] ?? this.writtenIndexes(literal)),
          properties,
        }),
        { isLiteral: true }
      ),
    };
    for (const member of named(node)) this.declareObjectMember(literal, member);
    for (const member of named(node)) this.objectMember(literal, member);
    if (literal.spreadIndexes && literal.hasPendingMembers) this.spreadWrittenIndexes(literal);
    if (contextual) this.addPatternDefaults(properties, contextual);
    const { object, genericSpreads, alternatives } = literal;
    if (literal.isTooComplex) return errorType;
    if (literal.spreadsAny) return anyType;
    if (alternatives) {
      const variants = alternatives.map((alternative, index) => {
        const variant = anonymousObject(
          () => ({
            ...emptyStructure(),
            ...literal.spreadIndexes?.[index],
            properties: new Map([...alternative, ...properties]),
          }),
          { isLiteral: true, isUnionSpread: true }
        );
        this.objectLiteralNodes.set(variant.id, node);
        return { ...variant, id: variant.id, fresh: true, regular: variant } as ObjectType;
      });
      return genericSpreads.length > 0
        ? intersectionOf([...genericSpreads, unionOf(variants, true)], this.c.budget)
        : unionOf(variants, true);
    }
    this.objectLiteralNodes.set(object.id, node);
    const fresh: ObjectType = { ...object, id: object.id, fresh: true, regular: object };
    if (genericSpreads.length > 0) return intersectionOf([...genericSpreads, object], this.c.budget);
    return fresh;
  }

  /**
   * What `this` is in an object literal's methods, as TypeScript's `getContextualThisParameterType` decides: the `T` of a
   * `ThisType<T>` in the contextual type of the literal or of an object literal it is a property value of, else the
   * contextual type without `null` and `undefined`, else the literal itself.
   */
  private receiverOf(node: TreeNode, contextual: Type | undefined, literal: Type): Type {
    const marked = this.thisTypeMarkerOf(node, contextual);
    if (marked) return marked;
    const context = contextual && this.c.relations.removeNullish(contextual);
    // A contextual type parameter not yet inferred stands for the literal, as the instantiated signature TypeScript
    // checks the argument against last gives it.
    return context && !this.c.relations.isGeneric(context) ? this.c.widen(context) : literal;
  }

  /** TypeScript's `getThisTypeOfObjectLiteral`. */
  private thisTypeMarkerOf(node: TreeNode, contextual: Type | undefined): Type | undefined {
    let current = node;
    let context = contextual;
    for (;;) {
      const marked = context && this.thisTypeArgument(context);
      if (marked) return marked;
      const pair = current.parent;
      const outer = pair?.parent;
      if (pair?.type !== 'pair' || pair.childForFieldName('value')?.id !== current.id || outer?.type !== 'object')
        return undefined;
      current = outer;
      context = this.objectLiteralContexts.get(outer.id);
    }
  }

  /** The `T` of the `ThisType<T>` a type is or intersects, or of each union member's. */
  private thisTypeArgument(type: Type): Type | undefined {
    if (type.kind === 'union') {
      const types = type.types.map((member) => this.thisTypeArgument(member)).filter((member) => member !== undefined);
      return types.length > 0 ? unionOf(types) : undefined;
    }
    if (type.kind === 'intersection')
      return type.types.map((member) => this.thisTypeArgument(member)).find((member) => member !== undefined);
    const marker = this.c.globalType('ThisType');
    return type.kind === 'object' && type.target === marker ? type.typeArguments?.[0] : undefined;
  }

  /** Gives an object literal a binding pattern takes apart the properties the pattern has defaults for. */
  private addPatternDefaults(properties: Map<string, Property>, contextual: Type): void {
    for (const member of contextual.kind === 'union' ? contextual.types : [contextual]) {
      if (!this.c.patterns.impliedTypes.has(member)) continue;
      for (const [name, property] of this.c.structureOf(member).properties) {
        if (property.optional && !properties.has(name)) properties.set(name, property);
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- Builds the complete receiver shape from named members, accessor pairs, and spreads before checking their bodies.
  private declareObjectMember(literal: ObjectLiteral, member: TreeNode): void {
    if (member.type === 'spread_element') {
      this.c.flow.from(this.c.flow.current, () =>
        this.c.silently(() => {
          for (const [name, property] of this.spreadProperties(this.c.expressions.check(named(member)[0])))
            literal.declarations.set(name, property);
        })
      );
      return;
    }
    const key = member.childForFieldName('name') ?? member.childForFieldName('key');
    const name = key
      ? this.declaredMemberName(key)
      : member.type === 'shorthand_property_identifier'
        ? member.text
        : undefined;
    if (name === undefined) return;
    const value = member.type === 'method_definition' ? member : member.childForFieldName('value');
    if (value && ['method_definition', 'function_expression'].includes(value.type))
      this.c.classes.registerObjectThis(value, literal.receiver);
    const getter = member.type === 'method_definition' && hasToken(member, 'get');
    const setter = member.type === 'method_definition' && hasToken(member, 'set');
    const previous = literal.declarations.get(name);
    let resolved: Type | undefined;
    const resolveType = (): Type => {
      resolved ??= this.c.silently(() => this.declaredMemberType(literal, member, name, value));
      return resolved;
    };
    literal.declarations.set(name, {
      ...this.literalProperty(name, anyType, literal.isConstContext, member),
      isMethod: member.type === 'method_definition' && !hasToken(member, 'get') && !hasToken(member, 'set'),
      type: setter ? (previous?.type ?? resolveType) : resolveType,
      writeType: setter ? resolveType : previous?.writeType,
      readonly: getter ? !previous?.writeType : false,
      getterOnly: getter ? !previous?.writeType : false,
    });
  }

  private declaredMemberType(literal: ObjectLiteral, member: TreeNode, name: string, value: TreeNode | null): Type {
    if (member.type !== 'method_definition')
      return value ? this.c.expressions.checkWidened(value) : this.c.expressions.identifier(member);
    const method = this.c.classes.withObjectThis(
      literal.receiver,
      () => this.c.functions.functionExpression(member, this.memberContext(literal, name)),
      member
    );
    const signature = this.c.signaturesOf(method, 'call')[0];
    if (hasToken(member, 'get')) return signature?.returnType() ?? anyType;
    if (hasToken(member, 'set')) return signature?.parameters[0]?.type ?? anyType;
    return method;
  }

  private objectMember(literal: ObjectLiteral, member: TreeNode): void {
    switch (member.type) {
      case 'pair': {
        this.pairMember(literal, member);
        break;
      }
      case 'shorthand_property_identifier': {
        this.shorthandMember(literal, member);
        break;
      }
      case 'method_definition': {
        this.methodMember(literal, member);
        break;
      }
      case 'spread_element': {
        this.spreadMember(literal, member);
        return;
      }
      default: {
        return;
      }
    }
    literal.hasPendingMembers = true;
  }

  private pairMember(literal: ObjectLiteral, member: TreeNode): void {
    const key = member.childForFieldName('key') as TreeNode;
    const value = member.childForFieldName('value') as TreeNode;
    const name = propertyNameText(key);
    if (key.type === 'computed_property_name' && name !== undefined) this.c.expressions.checkComputedPropertyName(key);
    if (name === undefined) {
      this.computedMember(literal, member, key, value);
      return;
    }
    this.checkDuplicateKey(literal, key, name);
    this.namedMember(literal, member, name, value);
  }

  private computedMember(literal: ObjectLiteral, member: TreeNode, key: TreeNode, value: TreeNode): void {
    const keyType = this.c.expressions.checkComputedPropertyName(key);
    if (isPropertyKeyLiteral(keyType)) {
      // A key of one literal names a property, whose value is typed as a written property's is.
      this.namedMember(literal, member, String(keyType.value), value);
      return;
    }
    const valueType = this.memberValue(literal, value, this.indexContext(literal, keyType));
    this.addComputedMember(literal, keyType, valueType);
  }

  /** Records a member whose key is not one literal, which TypeScript leaves out of the literal's named properties. */
  private addComputedMember(literal: ObjectLiteral, keyType: Type, type: Type): void {
    const key = this.indexKeyOf(keyType);
    if (key) literal.computedMembers.push({ key, type });
  }

  /** The index signature a computed key of a type gives the literal: none for a type that cannot be a key. */
  private indexKeyOf(keyType: Type): IndexKey | undefined {
    const { relations } = this.c;
    if (relations.isAssignable(keyType, numberType)) return 'numberIndex';
    if (relations.isAssignable(keyType, symbolType)) return 'symbolIndex';
    return relations.isAssignable(keyType, unionOf([stringType, numberType, symbolType])) ? 'stringIndex' : undefined;
  }

  private namedMember(literal: ObjectLiteral, member: TreeNode, name: string, value: TreeNode): void {
    const valueType = this.memberValue(literal, value, this.memberContext(literal, name));
    this.setWritten(literal, name, this.literalProperty(name, valueType, literal.isConstContext, member));
  }

  private setWritten(literal: ObjectLiteral, name: string, property: Property): void {
    literal.properties.set(name, property);
    literal.writtenNames.add(name);
  }

  private memberValue(literal: ObjectLiteral, value: TreeNode, context: Type | undefined): Type {
    const checked = this.c.expressions.check(value, context);
    return literal.isConstContext ? checked : this.widenForMutableLocation(checked, context);
  }

  /**
   * The type the contextual type's index signatures give a member whose computed key is not one literal: those that
   * apply to the key.
   */
  private indexContext(literal: ObjectLiteral, keyType: Type): Type | undefined {
    if (!literal.contextual) return undefined;
    const contextMembers = literal.contextual.kind === 'union' ? literal.contextual.types : [literal.contextual];
    const types = contextMembers.flatMap((member) => {
      if (member.kind !== 'object' && member.kind !== 'intersection') return [];
      const index = applicableIndex(this.c, this.c.structureOf(member), keyType);
      return index ? [index.type] : [];
    });
    return types.length > 0 ? unionOf(types, true) : undefined;
  }

  /** Reports a name declared again in an object literal, as TypeScript's grammar check of object literals does. */
  private checkDuplicateKey(
    literal: ObjectLiteral,
    keyNode: TreeNode,
    name: string,
    kind: MemberKind = 'property'
  ): void {
    if (literal.stopsKeyCheck) return;
    const seen = literal.seenKeys.get(name);
    if (!seen) {
      literal.seenKeys.set(name, new Set([kind]));
      return;
    }
    if (kind === 'property' && seen.has('property')) {
      this.c.error(keyNode, `オブジェクトリテラルには、同じ名前のプロパティを2つ以上書けません。`);
      return;
    }
    if (kind !== 'property' && !seen.has('property') && !seen.has(kind)) {
      seen.add(kind);
      return;
    }
    literal.stopsKeyCheck = true;
    this.c.error(
      keyNode,
      kind !== 'property' && !seen.has('property')
        ? `オブジェクトリテラルには、同じ名前の get アクセサーや set アクセサーを2つ以上書けません。`
        : `オブジェクトリテラルには、同じ名前のプロパティとアクセサーを両方は書けません。`
    );
  }

  private memberContext(literal: ObjectLiteral, name: string): Type | undefined {
    return literal.contextual ? this.contextualPropertyType(literal.contextual, name) : undefined;
  }

  private shorthandMember(literal: ObjectLiteral, member: TreeNode): void {
    const name = member.text;
    this.checkDuplicateKey(literal, member, name);
    const type = this.c.expressions.identifier(member);
    const valueType = literal.isConstContext
      ? type
      : this.widenForMutableLocation(type, this.memberContext(literal, name));
    this.setWritten(literal, name, this.literalProperty(name, valueType, literal.isConstContext, member));
  }

  private methodMember(literal: ObjectLiteral, member: TreeNode): void {
    const nameNode = member.childForFieldName('name') as TreeNode;
    const name = this.memberName(nameNode);
    const isGetter = hasToken(member, 'get');
    const isSetter = hasToken(member, 'set');
    const keyType = name === undefined ? this.c.expressions.check(named(nameNode)[0] ?? nameNode) : undefined;
    const context = keyType ? this.indexContext(literal, keyType) : this.memberContext(literal, name as string);
    const methodType = this.c.classes.withObjectThis(
      literal.receiver,
      () => this.c.functions.functionExpression(member, context),
      member
    );
    // A key that is not a literal gives the object an index signature, as a computed property does.
    if (keyType) {
      this.addComputedMember(literal, keyType, this.computedMethodValue(member, methodType));
      return;
    }
    if (name === undefined) return;
    // TypeScript's grammar check compares only names written as literals.
    if (propertyNameText(nameNode) !== undefined)
      this.checkDuplicateKey(literal, nameNode, name, isGetter ? 'get' : isSetter ? 'set' : 'property');
    if (isGetter || isSetter) {
      this.accessorMember(literal, member, name, methodType);
      return;
    }
    this.setWritten(literal, name, { ...this.literalProperty(name, methodType, false, member), isMethod: true });
  }

  /** The type a method or accessor of a computed key gives the index signature: an accessor's value type. */
  private computedMethodValue(member: TreeNode, methodType: Type): Type {
    const signature = this.c.signaturesOf(methodType, 'call')[0];
    if (hasToken(member, 'get')) return signature?.returnType() ?? anyType;
    if (hasToken(member, 'set')) return signature?.parameters[0]?.type ?? anyType;
    return methodType;
  }

  /** The name of a member, read ahead of the check of the member itself without reporting or narrowing anything. */
  private declaredMemberName(key: TreeNode): string | undefined {
    let name: string | undefined;
    this.c.flow.from(this.c.flow.current, () => {
      name = this.c.silently(() => this.memberName(key));
    });
    return name;
  }

  /** The name of a member, which a computed key gives by its literal type. */
  private memberName(nameNode: TreeNode): string | undefined {
    const written = propertyNameText(nameNode);
    if (nameNode.type !== 'computed_property_name') return written;
    const keyType = this.c.expressions.checkComputedPropertyName(nameNode);
    if (written !== undefined) return written;
    return isPropertyKeyLiteral(keyType) ? String(keyType.value) : undefined;
  }

  private accessorMember(literal: ObjectLiteral, member: TreeNode, name: string, methodType: Type): void {
    const { properties } = literal;
    literal.writtenNames.add(name);
    const isGetter = hasToken(member, 'get');
    const signature = this.c.signaturesOf(methodType, 'call')[0];
    const existing = properties.get(name);
    const accessorType = isGetter ? (signature?.returnType() ?? anyType) : (signature?.parameters[0]?.type ?? anyType);
    properties.set(name, {
      ...this.literalProperty(name, existing && !isGetter ? existing.type() : accessorType, false, member),
      writeType: isGetter ? existing?.writeType : () => accessorType,
      readonly: isGetter && !existing,
      getterOnly: isGetter && !existing,
    });
    if (existing && hasToken(member, 'set'))
      properties.set(name, { ...existing, writeType: () => accessorType, readonly: false, getterOnly: false });
  }

  private spreadMember(literal: ObjectLiteral, member: TreeNode): void {
    const operand = named(member)[0];
    const spread = this.c.expressions.check(operand);
    const objectPart = filterType(spread, (type) => !isDefinitelyFalsy(type));
    const members = objectPart.kind === 'union' ? objectPart.types : [objectPart];
    const isValid = this.c.patterns.isValidSpreadType(spread);
    if (!isValid) this.c.error(member, 'スプレッド構文は、オブジェクト型にのみ使えます。');
    if (!isValid || isAnyLike(objectPart)) {
      literal.spreadsAny = true;
      return;
    }
    if (spread.kind === 'typeParameter') {
      literal.genericSpreads.push(spread);
      return;
    }
    if (literal.isTooComplex) return;
    if (literal.hasPendingMembers) this.spreadWrittenIndexes(literal);
    const objectMembers = members.filter((type) => type.kind === 'object' || type.kind === 'intersection');
    // A spread of `null`, `undefined`, or a falsy primitive adds nothing, which leaves the properties of an object it
    // may be optional.
    const mayBeNullish = (spread.kind === 'union' ? spread.types : [spread]).some(isDefinitelyFalsy);
    if (objectMembers.length < 2) {
      if (objectMembers.length === 1)
        this.addSpreadIndexes(literal, this.indexesOf(objectPart, literal.isConstContext));
      this.spreadSingle(literal, objectPart, mayBeNullish);
      return;
    }
    this.spreadObjectUnion(literal, member, spread, [...objectMembers, ...(mayBeNullish ? [undefined] : [])]);
  }

  /** Spreads a union of several objects, unless the alternatives it makes are more than TypeScript represents. */
  private spreadObjectUnion(literal: ObjectLiteral, member: TreeNode, spread: Type, parts: (Type | undefined)[]): void {
    // TypeScript refuses a cross product of union spreads of 100,000 alternatives or more, counting every member of
    // each union, though the members that spread nothing all leave the same alternative.
    const complexity = (literal.complexity ?? 1) * (spread.kind === 'union' ? spread.types.length : 1);
    if (complexity >= 100_000) {
      this.c.error(member, 'この式の型は、表せないほど複雑な共用体型になります。');
      literal.isTooComplex = true;
      return;
    }
    literal.complexity = complexity;
    this.spreadUnion(literal, parts);
  }

  /** Spreads each of `parts`, a union's objects and `undefined` when it may be nullish, into its own alternative. */
  private spreadUnion(literal: ObjectLiteral, parts: (Type | undefined)[]): void {
    // Each alternative of a union spreads its own properties, as TypeScript gives the literal a union type.
    const bases = literal.alternatives ?? [new Map<string, Property>()];
    this.c.budget.spend(bases.length * parts.length);
    const baseIndexes = literal.spreadIndexes;
    literal.spreadIndexes = bases.flatMap((_, index) =>
      parts.map((type) => this.spreadIndexesOnto(baseIndexes?.[index], this.indexesOf(type, literal.isConstContext)))
    );
    literal.alternatives = bases.flatMap((base) =>
      parts.map((type) => {
        const alternative = new Map([...base, ...literal.properties]);
        if (type) this.spreadInto(literal, alternative, type);
        return alternative;
      })
    );
    literal.properties.clear();
  }

  /** Spreads the members written since the last spread as the one object literal TypeScript makes of them. */
  private spreadWrittenIndexes(literal: ObjectLiteral): void {
    this.addSpreadIndexes(literal, this.writtenIndexes(literal));
    literal.writtenNames.clear();
    literal.computedMembers = [];
    literal.hasPendingMembers = false;
  }

  /**
   * The index signatures of the members written since the last spread: one for each key kind a computed member has,
   * typed by every member whose key it applies to, as a string index applies to every key but a symbol.
   */
  private writtenIndexes(literal: ObjectLiteral): Indexes {
    const members = [
      ...literal.computedMembers,
      ...[...literal.writtenNames].flatMap((name) => {
        const property = literal.properties.get(name);
        return property ? [{ key: indexKeyOfName(name), type: property.type() }] : [];
      }),
    ];
    const indexes: Indexes = {};
    for (const { key } of literal.computedMembers) {
      const types = members
        .filter((member) => (key === 'stringIndex' ? member.key !== 'symbolIndex' : member.key === key))
        .map((member) => member.type);
      indexes[key] = { type: unionOf(types, true), readonly: literal.isConstContext };
    }
    return indexes;
  }

  private addSpreadIndexes(literal: ObjectLiteral, indexes: Indexes): void {
    literal.spreadIndexes = literal.spreadIndexes?.map((left) => this.spreadIndexesOnto(left, indexes)) ?? [indexes];
  }

  /**
   * The index signatures of a spread onto an object with `left`'s (none before the first spread): TypeScript keeps
   * the spread's own for the first, and afterwards each signature both sides have for the same key type.
   */
  private spreadIndexesOnto(left: Indexes | undefined, right: Indexes): Indexes {
    if (!left) return right;
    const combine = (key: IndexKey): IndexInfo | undefined => {
      const [leftIndex, rightIndex] = [left[key], right[key]];
      return leftIndex && rightIndex ? unitedIndex(leftIndex, rightIndex) : undefined;
    };
    return {
      stringIndex: combine('stringIndex'),
      numberIndex: combine('numberIndex'),
      symbolIndex: combine('symbolIndex'),
      patternIndexes: left.patternIndexes?.flatMap((leftIndex) => {
        const rightIndex = right.patternIndexes?.find((index) =>
          isSamePattern(this.c, index.keyType, leftIndex.keyType)
        );
        return rightIndex ? [{ ...unitedIndex(leftIndex, rightIndex), keyType: leftIndex.keyType }] : [];
      }),
    };
  }

  /** The index signatures a spread copies, which are writable in the copy unless it is in a `const` context. */
  private indexesOf(type: Type | undefined, readonly: boolean): Indexes {
    if (type?.kind !== 'object' && type?.kind !== 'intersection') return {};
    const { stringIndex, numberIndex, symbolIndex, patternIndexes } = this.c.structureOf(type);
    return {
      stringIndex: stringIndex && { ...stringIndex, readonly },
      numberIndex: numberIndex && { ...numberIndex, readonly },
      symbolIndex: symbolIndex && { ...symbolIndex, readonly },
      patternIndexes: patternIndexes?.map((index) => ({ ...index, readonly })),
    };
  }

  /**
   * Spreads a value that is not a union of objects; after a union spread, into each alternative, whose properties its
   * optional ones may leave.
   */
  private spreadSingle(literal: ObjectLiteral, spread: Type, optional = false): void {
    if (!literal.alternatives) {
      this.spreadInto(literal, literal.properties, spread, optional);
      return;
    }
    for (const alternative of literal.alternatives) {
      for (const [name, property] of literal.properties) alternative.set(name, property);
      this.spreadInto(literal, alternative, spread, optional);
    }
    literal.properties.clear();
  }

  private spreadInto(literal: ObjectLiteral, properties: Map<string, Property>, spread: Type, optional = false): void {
    for (const [name, spreadProperty] of this.spreadProperties(spread, literal.isConstContext)) {
      const property = optional ? { ...spreadProperty, optional: true } : spreadProperty;
      const existing = properties.get(name);
      // An optional property spread over one already there may be missing, which leaves the earlier value.
      properties.set(
        name,
        existing && property.optional
          ? {
              ...property,
              optional: existing.optional,
              type: () => unionOf([existing.type(), this.c.relations.removeUndefined(property.type())]),
            }
          : property
      );
    }
  }

  /**
   * The members of a contextual union that the literal's discriminant properties select, as `{ type: "say", … }`
   * selects the member whose `type` is `"say"`; the whole union when none or no member is selected.
   */
  // code-gauge-allow functionCognitiveComplexity 17 -- Follows TypeScript's discrimination of a contextual union by literal properties.
  private discriminatedContext(node: TreeNode, contextual: Type): Type {
    if (contextual.kind !== 'union') return contextual;
    let members = contextual.types;
    for (const member of named(node)) {
      const property = this.discriminantProperty(member);
      if (!property || !this.c.flow.isDiscriminant(contextual, property.name)) continue;
      const { name, value, isShorthand } = property;
      const valueType = regularOf(
        this.c.silently(() => (isShorthand ? this.c.expressions.identifier(value) : this.c.expressions.check(value)))
      );
      const valueTypes = valueType.kind === 'union' ? valueType.types : [valueType];
      const selected = members.filter((candidate) => {
        const property = candidate.kind === 'object' ? this.c.propertyOf(candidate, name) : undefined;
        return !property || valueTypes.some((value) => this.c.relations.isAssignable(value, property.type()));
      });
      if (selected.length > 0) members = selected;
    }
    return members.length === contextual.types.length ? contextual : unionOf(members);
  }

  private discriminantProperty(member: TreeNode): { name: string; value: TreeNode; isShorthand: boolean } | undefined {
    const isShorthand = member.type === 'shorthand_property_identifier';
    if (!isShorthand && member.type !== 'pair') return undefined;
    const key = isShorthand ? member : member.childForFieldName('key');
    const value = isShorthand ? member : member.childForFieldName('value');
    if (!key || !value || (!isShorthand && !isDiscriminantValue(value))) return undefined;
    const name = propertyNameText(key);
    return name === undefined ? undefined : { name, value, isShorthand };
  }

  /** A literal's type in an array element or a property, widened unless the contextual type expects literals. */
  widenForMutableLocation(type: Type, contextual: Type | undefined): Type {
    // A nested object literal stays fresh, so that its own properties are checked against the target too.
    if (type.kind === 'object' || (contextual && this.expectsLiteral(contextual, type))) return type;
    return this.c.widenLiteral(type);
  }

  private expectsLiteral(contextual: Type, type: Type): boolean {
    const members = contextual.kind === 'union' ? contextual.types : [contextual];
    const literals = (type.kind === 'union' ? type.types : [type]).filter((member) => member.kind === 'literal');
    return members.some(
      (member) =>
        (member.kind === 'typeParameter' && this.hasPrimitiveConstraint(member)) ||
        member.kind === 'templateLiteral' ||
        member.kind === 'stringMapping' ||
        member.kind === 'keyof' ||
        member.kind === 'indexedAccess' ||
        (member.kind === 'literal' &&
          literals.some((literal) => typeof (literal as { value: unknown }).value === typeof member.value))
    );
  }

  /** Whether a type parameter is constrained to primitives, which keeps the literals inferred for it. */
  hasPrimitiveConstraint(parameter: TypeParameter): boolean {
    const constraint = parameter.constraint?.();
    if (!constraint) return false;
    return (constraint.kind === 'union' ? constraint.types : [constraint]).some(
      (member) =>
        member.kind === 'literal' ||
        member.kind === 'keyof' ||
        member.kind === 'templateLiteral' ||
        member.kind === 'stringMapping' ||
        (member.kind === 'intrinsic' && ['string', 'number', 'bigint', 'boolean', 'symbol'].includes(member.name)) ||
        (member.kind === 'union' && member.types.every((part) => part.kind === 'literal'))
    );
  }

  /** The union of types without those that another of them already includes, as TypeScript's subtype reduction. */
  subtypeReduced(types: Type[]): Type {
    const union = unionOf(types, true);
    if (union.kind !== 'union') return union;
    const kept = union.types.filter(
      (member, index) =>
        !union.types.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.kind === 'object' &&
            member.kind === 'object' &&
            this.c.relations.isAssignable(member, other) &&
            !this.hasPropertiesBeyondLiteral(member, other) &&
            !(this.c.relations.isAssignable(other, member) && otherIndex > index)
        )
    );
    return unionOf(kept, true);
  }

  /** Whether a type has a property an object literal type lacks, which keeps it from being the literal's subtype. */
  private hasPropertiesBeyondLiteral(type: Type, literal: Type): boolean {
    if (literal.kind !== 'object' || !literal.isLiteral) return false;
    const literalProperties = this.c.structureOf(literal).properties;
    return [...this.c.structureOf(type).properties.values()].some(
      (property) => !literalProperties.has(property.name) && !isIntrinsic(property.type(), 'undefined')
    );
  }

  literalProperty(name: string, type: Type, readonly: boolean, declaration: TreeNode): Property {
    return {
      name,
      type: () => type,
      optional: false,
      readonly,
      isMethod: false,
      visibility: 'public',
      declaration,
    };
  }

  private spreadProperties(type: Type, readonly = false): Map<string, Property> {
    const result = new Map<string, Property>();
    for (const member of type.kind === 'union' ? type.types : [type]) {
      if (member.kind !== 'object' && member.kind !== 'intersection') continue;
      for (const [name, property] of this.c.structureOf(member).properties) {
        if (!isSpreadableProperty(property) || (property.isMethod && member.kind === 'object' && member.classInfo))
          continue;
        result.set(name, spreadCopy(property, readonly));
      }
    }
    return result;
  }

  /** The type the contextual type gives a property of an object literal. */
  contextualPropertyType(contextual: Type, name: string): Type | undefined {
    const members = (contextual.kind === 'union' ? contextual.types : [contextual]).filter(
      (member) => member.kind === 'object' || member.kind === 'intersection' || member.kind === 'typeParameter'
    );
    const types: Type[] = [];
    for (const member of members) {
      const apparent = member.kind === 'typeParameter' ? (this.c.constraintOf(member) ?? unknownType) : member;
      const property = this.c.propertyOf(apparent, name);
      if (property) {
        types.push(property.type());
        continue;
      }
      const structure = this.c.structureOf(apparent);
      const index = isSymbolName(name) ? structure.symbolIndex : applicableIndex(this.c, structure, literalType(name));
      if (index) types.push(index.type);
    }
    return types.length > 0 ? unionOf(types, true) : undefined;
  }

  /** The type a variable declared with this initializer type gets. */
  // code-gauge-allow functionCognitiveComplexity 30 -- Widens each type form and clears array-literal inference provenance when storing a declaration.
  widenDeclared(type: Type, isConst: boolean): Type {
    // A constant keeps a fresh literal type, which widens again where a mutable location takes its value.
    // Only a fresh literal widens, which `as const` and annotations make regular.
    if (type.kind === 'literal') return isConst || !type.fresh ? type : this.c.widenLiteral(type);
    if (type.kind === 'union') {
      const widened = isConst ? type : mapType(type, (member) => this.widenDeclared(member, false));
      return widened.kind === 'union'
        ? unionOf(this.normalizeObjectLiterals(widened.types.map((member) => this.widenDeclared(member, isConst))))
        : widened;
    }
    if (type.kind === 'object') {
      // Only an array literal holds fresh literals; another array, as one of a recursive alias, is left as it is.
      if (this.isArrayLiteral(type)) return this.c.arrayType(this.widenDeclared(this.c.elementTypeOf(type), false));
      if (type.objectKind === 'anonymous' && type.isLiteral && !type.isFunction) {
        const source = type.regular ?? type;
        return anonymousObject(
          () => {
            const structure = source.resolve();
            const properties = new Map<string, Property>();
            for (const [name, property] of structure.properties) {
              properties.set(name, {
                ...property,
                type: () =>
                  property.readonly && !property.getterOnly
                    ? regularOf(property.type())
                    : this.widenDeclared(property.type(), false),
              });
            }
            return { ...structure, properties };
          },
          { isLiteral: true, isUnionSpread: type.isUnionSpread }
        );
      }
    }
    return regularOf(type);
  }

  /**
   * Gives each object literal type of a union the properties only its siblings have, as optional `undefined`, so that
   * `[{ a: 1 }, { a: 2, b: 3 }]` has elements whose `b` can be read.
   */
  normalizeObjectLiterals(types: Type[]): Type[] {
    const literals = types.filter((type) => isObjectLiteral(type) && !type.isUnionSpread);
    if (literals.length < 2) return types;
    const names = new Set(literals.flatMap((literal) => [...this.c.structureOf(literal).properties.keys()]));
    return types.map((type) => {
      if (!isObjectLiteral(type) || type.isUnionSpread) return type;
      const missing = [...names].filter((name) => !this.c.structureOf(type).properties.has(name));
      if (missing.length === 0) return type;
      return anonymousObject(
        () => {
          const structure = type.resolve();
          const properties = new Map(structure.properties);
          for (const name of missing) {
            properties.set(name, {
              name,
              type: () => undefinedType,
              optional: true,
              readonly: false,
              isMethod: false,
              visibility: 'public',
            });
          }
          return { ...structure, properties };
        },
        { isLiteral: true }
      );
    });
  }
}

/** Whether a spread's member is never truthy, which TypeScript accepts in a spread that adds nothing for it. */
export function isDefinitelyFalsy(type: Type): boolean {
  return (
    isIntrinsic(type, 'undefined') ||
    isIntrinsic(type, 'null') ||
    isIntrinsic(type, 'void') ||
    (type.kind === 'literal' && !type.value)
  );
}

/**
 * Whether a spread or rest copies a property: a class's methods and accessors stay on its prototype, and its private
 * names and private or protected members stay out of the copy's type.
 */
export function isSpreadableProperty(property: Property): boolean {
  const { declaration } = property;
  return (
    !property.isPrivateName &&
    property.visibility === 'public' &&
    !(
      declaration?.parent?.type === 'class_body' &&
      ['method_definition', 'method_signature', 'abstract_method_signature'].includes(declaration.type)
    )
  );
}

/** The index signature of a spread onto an object with another for the same key type. */
function unitedIndex(left: IndexInfo, right: IndexInfo): IndexInfo {
  return { type: unionOf([left.type, right.type]), readonly: left.readonly || right.readonly };
}

function indexKeyOfName(name: string): IndexKey {
  if (isSymbolName(name)) return 'symbolIndex';
  return isNumericName(name) ? 'numberIndex' : 'stringIndex';
}

function isObjectLiteral(type: Type): type is ObjectType {
  return type.kind === 'object' && type.objectKind === 'anonymous' && !!type.isLiteral && !type.isFunction;
}

/** Whether an array literal is spread into a call's arguments, as in `f(...[1, 2])`, where it is typed as a tuple. */
function isSpreadIntoCall(node: TreeNode): boolean {
  let parent = node.parent;
  while (parent?.type === 'parenthesized_expression') parent = parent.parent;
  return parent?.type === 'spread_element' && parent.parent?.type === 'arguments';
}

/** The elements of an array literal in their positions, with `undefined` for a hole a comma leaves. */
function arrayElements(node: TreeNode): (TreeNode | undefined)[] {
  const elements: (TreeNode | undefined)[] = Array.from({ length: arrayLiteralLength(node) });
  const positioned = arrayPatternElements(node);
  for (const { element, index } of positioned) elements[index] = element;
  return elements;
}

/**
 * The property a spread gives an object: as tsc does, the property itself, with an accessor pair's write type, when the
 * spread keeps its readonly-ness, and otherwise a data property holding its value.
 */
function spreadCopy(property: Property, readonly: boolean): Property {
  const keeps = readonly === (property.readonly || property.getterOnly === true);
  return keeps ? { ...property, readonly } : { ...property, readonly, getterOnly: false, writeType: undefined };
}

function isDiscriminantValue(node: TreeNode): boolean {
  if (node.type === 'parenthesized_expression') return isDiscriminantValue(named(node)[0]);
  if (node.type === 'member_expression') {
    const object = node.childForFieldName('object');
    return object !== null && isDiscriminantValue(object);
  }
  return ['string', 'number', 'template_string', 'true', 'false', 'null', 'identifier'].includes(node.type);
}
