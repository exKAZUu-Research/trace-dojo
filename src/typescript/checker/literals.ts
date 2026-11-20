// code-gauge-allow-file fileNcss 746 -- Types literals and their spreads, members, and widening in the same literal context.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { ExpressionListFlow, tupleArgumentContexts } from './callArity';
import type { Checker } from './checker';
import { isGenericObjectOrIndexType } from './genericTypes';
import { applicableIndex, hasIndexSignature, isIndexKeyOf, isSamePattern, namedPropertyIndex } from './indexInfos';
import {
  arrayLiteralLength,
  arrayPatternElements,
  hasToken,
  isConstAssertion,
  named,
  numberValue,
  propertyNameText,
  skipParentheses,
} from './syntax';
import {
  accessorProperty,
  anonymousObject,
  anyType,
  emptyObjectType,
  emptyStructure,
  errorType,
  filterType,
  freshObjectLiteral,
  type IndexInfo,
  intersectionOf,
  isAnyLike,
  isFreshLiteral,
  isIntrinsic,
  isPropertyKeyLiteral,
  type LiteralType,
  literalType,
  mapType,
  neverType,
  newTypeId,
  numberType,
  type ObjectType,
  type Property,
  regularOf,
  simpleProperty,
  stringType,
  type Structure,
  symbolType,
  type Type,
  typeMembers,
  type TypeParameter,
  undefinedType,
  unionOf,
  unknownType,
} from './types';

type MemberKind = 'property' | 'get' | 'set';
type PropertyKeyType = LiteralType & { value: string | number | symbol };

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
  explicitMembers: Map<string, TreeNode>;
  computedMembers: { key: IndexKey; type: Type }[];
  /** Whether members are written since the last spread, which TypeScript spreads as one object literal. */
  hasPendingMembers?: boolean;
  /** The result of the spreads so far once a generic operand requires preserving intersection order. */
  orderedSpread?: Type;
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
  private readonly literalContexts = new Map<number, Type | undefined>();
  private readonly arrayLiterals = new Set<number>();
  private readonly tupleLiterals = new Set<number>();
  /** The node of each object literal type, whose members alone TypeScript checks for excess properties. */
  private readonly objectLiteralNodes = new Map<number, TreeNode>();
  /** The contextual type of each object literal checked, by node, which the `this` of a literal inside it may need. */
  private readonly objectLiteralContexts = new Map<number, Type | undefined>();

  constructor(private readonly c: Checker) {}

  arrayLiteral(node: TreeNode, contextual?: Type): Type {
    contextual = this.literalContext(node, contextual);
    const elements = arrayElements(node);
    const isConstContext = this.isConstContext(node, contextual);
    const lengths = contextual ? this.arrayElementLengths(elements) : [];
    const types: { type: Type; spread: boolean }[] = elements.map((element, index) => {
      // A hole, as in `[, 1]`, reads as `undefined`.
      if (!element) return { type: undefinedType, spread: false };
      if (element.type === 'spread_element') {
        const spread = this.c.expressions.check(named(element)[0]);
        return { type: spread, spread: true };
      }
      const contexts = contextual ? this.arrayElementContexts(contextual, index, lengths) : [];
      const context = contexts.length > 0 ? unionOf(contexts, true, true) : undefined;
      const type = this.c.expressions.check(element, context);
      const literalContext = contexts.find((candidate) => this.expectsLiteral(candidate, type)) ?? context;
      return { type: this.literalValueType(type, literalContext, isConstContext), spread: false };
    });
    if (isConstContext || this.isInTupleContext(node, contextual)) {
      return this.tupleOfElements(
        node,
        elements,
        types,
        isConstContext,
        isConstContext && !this.hasMutableArrayContext(contextual)
      );
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

  private arrayElementLengths(elements: (TreeNode | undefined)[]): (number | undefined)[] {
    const sequence = new ExpressionListFlow(
      this.c,
      elements.filter((element) => element !== undefined)
    );
    return elements.map((element) => (element ? sequence.length(element) : 1));
  }

  private hasMutableArrayContext(contextual: Type | undefined): boolean {
    if (!contextual) return false;
    const apparent = this.c.apparentType(contextual);
    return (apparent.kind === 'union' ? apparent.types : [apparent]).some(
      (type) =>
        (type.kind === 'object' || type.kind === 'intersection') &&
        this.c.relations.isAssignable(type, this.c.arrayType(anyType))
    );
  }

  /** The tuple an array literal is where a tuple or `as const` expects it, with what its spreads spread. */
  private tupleOfElements(
    node: TreeNode,
    elements: (TreeNode | undefined)[],
    types: { type: Type; spread: boolean }[],
    isConstContext: boolean,
    readonly = isConstContext
  ): Type {
    const tupleElements = types.flatMap(({ type, spread }, index) => {
      if (!spread) return [{ type: isConstContext ? regularOf(type) : type, optional: false, rest: false }];
      if (
        !isAnyLike(type) &&
        (this.c.isArrayOrTuple(type) || this.c.relations.isAssignable(type, this.c.arrayType(anyType, true)))
      )
        return [{ type, optional: false, rest: true }];
      return [
        {
          type: this.c.arrayType(this.spreadElementType(elements[index] as TreeNode, type)),
          optional: false,
          rest: true,
        },
      ];
    });
    return mapType(this.c.tupleType(tupleElements, readonly), (type) => {
      if (type.kind !== 'object') return type;
      const tuple = { ...type, id: newTypeId() };
      this.tupleLiterals.add(tuple.id);
      return tuple;
    });
  }

  /** The elements a spread adds to an array literal; `never` is an array there, as TypeScript's `isArrayLikeType` has it. */
  private spreadElementType(spread: TreeNode, type: Type): Type {
    if (isIntrinsic(type, 'never')) return neverType;
    const apparent = this.c.apparentType(type);
    return isAnyLike(apparent) ? apparent : this.c.patterns.iteratedType(named(spread)[0], type);
  }

  isArrayLiteral(type: Type): boolean {
    return this.arrayLiterals.has(type.id);
  }

  /** Whether an array or a tuple is the type of an array literal, the only kind whose elements may be fresh. */
  isArrayOrTupleLiteral(type: Type): boolean {
    return this.arrayLiterals.has(type.id) || this.tupleLiterals.has(type.id);
  }

  isObjectLiteralWithin(type: ObjectType, expression: TreeNode): boolean {
    const literal = this.objectLiteralNodes.get(type.id);
    return (
      literal?.tree === expression.tree &&
      literal.startIndex >= expression.startIndex &&
      literal.endIndex <= expression.endIndex
    );
  }

  isWrittenObjectLiteral(type: Type): boolean {
    return type.kind === 'object' && (!!type.fresh || this.objectLiteralNodes.has(type.id));
  }

  /** Whether a property of an object literal type is written in the literal, rather than copied by a spread. */
  isWrittenMember(literal: ObjectType, property: Property): boolean {
    const node = this.objectLiteralNodes.get(literal.id);
    return node !== undefined && property.declaration?.parent?.id === node.id;
  }

  private isInTupleContext(node: TreeNode, contextual: Type | undefined): boolean {
    return isSpreadIntoCall(node) || (contextual !== undefined && this.takesTupleContext(contextual));
  }

  private takesTupleContext(type: Type): boolean {
    if (type.kind === 'union' || type.kind === 'intersection')
      return type.types.some((member) => this.takesTupleContext(member));
    if (type.kind !== 'object') return false;
    return (
      type.objectKind === 'tuple' ||
      (type.objectKind === 'mapped' &&
        type.mapped?.source !== undefined &&
        !type.mapped.nameType &&
        this.c.relations.isGeneric(type))
    );
  }

  private arrayElementContexts(contextual: Type, index: number, lengths: (number | undefined)[]): Type[] {
    if (contextual.kind === 'union')
      return contextual.types.flatMap((member) => this.arrayElementContexts(member, index, lengths));
    if (contextual.kind === 'intersection') {
      const contexts = contextual.types
        .map((member) => this.arrayElementContexts(member, index, lengths))
        .filter((types) => types.length > 0);
      return contexts.length > 0
        ? [
            intersectionOf(
              contexts.map((types) => unionOf(types, true, true)),
              this.c.budget
            ),
          ]
        : [];
    }
    const context =
      contextual.kind === 'object' && contextual.objectKind === 'tuple'
        ? tupleArgumentContexts(this.c, contextual, lengths)[index]
        : this.elementContext(contextual);
    return context === undefined ? [] : [context];
  }

  private elementContext(contextual: Type): Type | undefined {
    if (contextual.kind !== 'object') return undefined;
    if (this.c.isArrayOrTuple(contextual)) return this.c.elementTypeOf(contextual);
    if (!this.c.propertyOf(contextual, this.c.typeNodes.librarySymbolKey('iterator'))) return undefined;
    const iterated = this.c.silently(() => this.c.patterns.iteratedType(undefined, contextual));
    return iterated === errorType || isAnyLike(iterated) ? undefined : iterated;
  }

  /** Whether a literal is checked with const inference or inside a const assertion. */
  isConstContext(node: TreeNode, contextual?: Type): boolean {
    if (this.isConstTypeVariable(contextual)) return true;
    let current: TreeNode | null = node.parent;
    let child = node;
    while (current) {
      if (this.isConstTypeVariable(this.literalContexts.get(current.id))) return true;
      if (current.type === 'as_expression' || current.type === 'type_assertion')
        return (
          isConstAssertion(current) &&
          (current.type === 'as_expression' ? named(current)[0] : named(current).at(-1))?.id === child.id
        );
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

  private isConstTypeVariable(type: Type | undefined): boolean {
    this.c.budget.spend();
    if (type?.kind === 'typeParameter') return type.isConst === true;
    return (
      (type?.kind === 'union' || type?.kind === 'intersection') &&
      type.types.some((part) => this.isConstTypeVariable(part))
    );
  }

  objectLiteral(node: TreeNode, contextual?: Type): Type {
    contextual = this.literalContext(node, contextual);
    const properties = new Map<string, Property>();
    const declarations = new Map<string, Property>();
    const discriminated = contextual && this.discriminatedContext(node, contextual);
    this.objectLiteralContexts.set(node.id, discriminated);
    const literal: ObjectLiteral = {
      contextual: discriminated,
      isConstContext: this.isConstContext(node, contextual),
      properties,
      declarations,
      receiver: this.receiverOf(
        node,
        discriminated,
        anonymousObject(() => ({ ...emptyStructure(), properties: declarations }))
      ),
      writtenNames: new Set(),
      explicitMembers: new Map(),
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
    const members = named(node);
    this.prepareObjectReceiver(literal, members);
    for (const member of members) this.objectMember(literal, member);
    if (literal.isTooComplex) return errorType;
    if (literal.spreadsAny) return anyType;
    if (literal.orderedSpread) return this.flushOrderedMembers(literal);
    if (literal.spreadIndexes && literal.hasPendingMembers) this.spreadWrittenIndexes(literal);
    return this.concreteLiteral(literal, node);
  }

  private literalContext(node: TreeNode, contextual: Type | undefined): Type | undefined {
    const context = this.c.expressions.deferredContexts.typeOf(node) ?? contextual;
    this.literalContexts.set(node.id, context);
    if (!context) return undefined;
    const members = typeMembers(context);
    if (!members.some((member) => member.kind === 'conditional')) return context;
    return unionOf(
      members.map((member) => (member.kind === 'conditional' ? this.c.baseConstraint(member) : member)),
      true,
      true
    );
  }

  private concreteLiteral(literal: ObjectLiteral, node: TreeNode): Type {
    const { object, alternatives, properties } = literal;
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
        return freshObjectLiteral(variant);
      });
      return unionOf(variants, true);
    }
    this.objectLiteralNodes.set(object.id, node);
    return freshObjectLiteral(object);
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

  private prepareObjectReceiver(literal: ObjectLiteral, members: TreeNode[]): void {
    if (
      !members.some((member) => {
        const value = member.childForFieldName('value');
        return member.type === 'method_definition' || (value && skipParentheses(value).type === 'function_expression');
      })
    )
      return;
    this.c.flow.probe(() =>
      this.c.silently(() => {
        for (const member of members) this.declareObjectMember(literal, member);
      })
    );
  }

  private declareObjectMember(literal: ObjectLiteral, member: TreeNode): void {
    if (member.type === 'spread_element') {
      for (const [name, property] of this.spreadProperties(this.spreadOperand(member, literal.contextual)))
        literal.declarations.set(name, property);
      return;
    }
    const keyNode = member.childForFieldName('name') ?? member.childForFieldName('key');
    const isMethod = member.type === 'method_definition';
    const value = member.childForFieldName('value');
    const key = keyNode ? this.memberKey(keyNode) : literalType(member.text);
    const receiverOwner = isMethod ? member : value && skipParentheses(value);
    if (receiverOwner && (isMethod || receiverOwner.type === 'function_expression'))
      this.c.classes.registerObjectThis(receiverOwner, literal.receiver);
    if (!isMethod) {
      this.declareObjectValue(literal, member, key, value);
      return;
    }
    if (!isPropertyKeyLiteral(key)) return;
    const name = String(key.value);
    const getter = hasToken(member, 'get');
    const setter = hasToken(member, 'set');
    const previous = literal.declarations.get(name);
    const before = this.c.flow.current?.clone();
    let resolved: Type | undefined;
    const resolveType = (): Type => {
      resolved ??= this.c.flow.probe(
        () => this.c.silently(() => this.declaredObjectMethod(literal, member, key)),
        before
      );
      return resolved;
    };
    const property = this.literalProperty(name, anyType, literal.isConstContext, member, key);
    literal.declarations.set(
      name,
      getter || setter
        ? accessorProperty(property, previous, getter, resolveType)
        : { ...property, isMethod: true, type: resolveType, readonly: false }
    );
  }

  private declareObjectValue(literal: ObjectLiteral, member: TreeNode, key: Type, value: TreeNode | null): void {
    if (!isPropertyKeyLiteral(key)) {
      if (value) this.c.expressions.check(value);
      return;
    }
    const name = String(key.value);
    const context = this.memberContext(literal, key);
    const type = value ? this.memberValue(literal, value, context) : this.shorthandType(literal, member, context);
    literal.declarations.set(name, this.literalProperty(name, type, literal.isConstContext, member, key));
  }

  private declaredObjectMethod(literal: ObjectLiteral, member: TreeNode, key: PropertyKeyType): Type {
    const method = this.c.classes.withObjectThis(
      literal.receiver,
      () => this.c.functions.functionExpression(member, this.memberContext(literal, key)),
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
    const keyType = this.memberKey(key);
    const name = propertyNameText(key);
    if (name !== undefined) this.checkDuplicateKey(literal, key, name);
    if (isPropertyKeyLiteral(keyType)) {
      this.namedMember(literal, member, keyType, value);
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

  private namedMember(literal: ObjectLiteral, member: TreeNode, key: PropertyKeyType, value: TreeNode): void {
    const name = String(key.value);
    const valueType = this.memberValue(literal, value, this.memberContext(literal, key));
    this.setWritten(literal, name, this.literalProperty(name, valueType, literal.isConstContext, member, key));
  }

  private setWritten(literal: ObjectLiteral, name: string, property: Property): void {
    literal.properties.set(name, property);
    literal.writtenNames.add(name);
    if (property.declaration) literal.explicitMembers.set(name, property.declaration);
  }

  private memberValue(literal: ObjectLiteral, value: TreeNode, context: Type | undefined): Type {
    const checked = this.c.expressions.check(value, context);
    return this.literalValueType(checked, context, literal.isConstContext);
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
    return types.length > 0 ? unionOf(types, true, true) : undefined;
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

  private memberContext(literal: ObjectLiteral, key: PropertyKeyType): Type | undefined {
    return literal.contextual ? this.contextualPropertyType(literal.contextual, String(key.value), key) : undefined;
  }

  private shorthandMember(literal: ObjectLiteral, member: TreeNode): void {
    const name = member.text;
    this.checkDuplicateKey(literal, member, name);
    const context = literal.contextual && this.contextualPropertyType(literal.contextual, name);
    const valueType = this.shorthandType(literal, member, context);
    this.setWritten(literal, name, this.literalProperty(name, valueType, literal.isConstContext, member));
  }

  private shorthandType(literal: ObjectLiteral, member: TreeNode, context: Type | undefined): Type {
    const type = this.c.expressions.identifier(member);
    return this.literalValueType(type, context, literal.isConstContext);
  }

  private methodMember(literal: ObjectLiteral, member: TreeNode): void {
    const nameNode = member.childForFieldName('name') as TreeNode;
    const key = this.memberKey(nameNode);
    const isGetter = hasToken(member, 'get');
    const isSetter = hasToken(member, 'set');
    const context = isPropertyKeyLiteral(key) ? this.memberContext(literal, key) : this.indexContext(literal, key);
    const methodType = this.c.classes.withObjectThis(
      literal.receiver,
      () => this.c.functions.functionExpression(member, context),
      member
    );
    // A key that is not a literal gives the object an index signature, as a computed property does.
    if (!isPropertyKeyLiteral(key)) {
      this.addComputedMember(literal, key, this.computedMethodValue(member, methodType));
      return;
    }
    const name = String(key.value);
    // TypeScript's grammar check compares only names written as literals.
    if (propertyNameText(nameNode) !== undefined)
      this.checkDuplicateKey(literal, nameNode, name, isGetter ? 'get' : isSetter ? 'set' : 'property');
    if (isGetter || isSetter) {
      this.accessorMember(literal, member, key, methodType);
      return;
    }
    this.setWritten(literal, name, { ...this.literalProperty(name, methodType, false, member, key), isMethod: true });
  }

  /** The type a method or accessor of a computed key gives the index signature: an accessor's value type. */
  private computedMethodValue(member: TreeNode, methodType: Type): Type {
    const signature = this.c.signaturesOf(methodType, 'call')[0];
    if (hasToken(member, 'get')) return signature?.returnType() ?? anyType;
    if (hasToken(member, 'set')) return signature?.parameters[0]?.type ?? anyType;
    return methodType;
  }

  private memberKey(node: TreeNode): Type {
    if (node.type === 'computed_property_name') return this.c.expressions.checkComputedPropertyName(node);
    if (node.type === 'number') return literalType(numberValue(node.text));
    const name = propertyNameText(node);
    return name === undefined ? errorType : literalType(name);
  }

  private accessorMember(literal: ObjectLiteral, member: TreeNode, key: PropertyKeyType, methodType: Type): void {
    const name = String(key.value);
    const { properties } = literal;
    literal.writtenNames.add(name);
    const isGetter = hasToken(member, 'get');
    const signature = this.c.signaturesOf(methodType, 'call')[0];
    const existing = properties.get(name);
    const accessorType = isGetter ? (signature?.returnType() ?? anyType) : (signature?.parameters[0]?.type ?? anyType);
    const property = this.literalProperty(name, accessorType, false, member, key);
    properties.set(
      name,
      accessorProperty(property, existing, isGetter, () => accessorType)
    );
  }

  private spreadOperand(member: TreeNode, contextual: Type | undefined): Type {
    // TypeScript resets SkipContextSensitive at object spread operands.
    return this.c.overloadContexts.eagerly(() => this.c.expressions.check(named(member)[0], contextual));
  }

  private spreadMember(literal: ObjectLiteral, member: TreeNode): void {
    const spread = this.spreadOperand(member, literal.contextual);
    const objectPart = filterType(spread, (type) => !isDefinitelyFalsy(type));
    const members = objectPart.kind === 'union' ? objectPart.types : [objectPart];
    const isValid = this.c.patterns.isValidSpreadType(spread);
    if (!isValid) this.c.error(member, 'スプレッド構文は、オブジェクト型にのみ使えます。');
    if (!isValid || isAnyLike(objectPart)) {
      literal.spreadsAny = true;
      return;
    }
    this.checkSpreadOverrides(literal, spread);
    if (literal.isTooComplex) return;
    if (literal.orderedSpread || isGenericSpread(spread)) {
      this.spreadInOrder(literal, member, spread);
      return;
    }
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

  private spreadInOrder(literal: ObjectLiteral, member: TreeNode, spread: Type): void {
    const left = literal.orderedSpread
      ? this.flushOrderedMembers(literal)
      : this.startOrderedSpread(literal, member.parent as TreeNode);
    const right = this.optionalSpread(literal, spread);
    if (right.kind === 'union' && !this.countSpreadVariants(literal, member, right.types.length)) return;
    literal.orderedSpread = this.mergeOrderedSpread(literal, left, right);
  }

  private startOrderedSpread(literal: ObjectLiteral, node: TreeNode): Type {
    if (literal.spreadIndexes && literal.hasPendingMembers) this.spreadWrittenIndexes(literal);
    const before =
      literal.properties.size > 0 || literal.spreadIndexes || literal.hasPendingMembers
        ? this.concreteLiteral(literal, node)
        : emptyObjectType;
    this.resetWrittenMembers(literal);
    return before;
  }

  private flushOrderedMembers(literal: ObjectLiteral): Type {
    const left = literal.orderedSpread as Type;
    if (!literal.hasPendingMembers && literal.properties.size === 0) return left;
    const right = this.spreadObjectType(literal.properties, this.writtenIndexes(literal));
    this.resetWrittenMembers(literal);
    return this.mergeOrderedSpread(literal, left, right);
  }

  private resetWrittenMembers(literal: ObjectLiteral): void {
    literal.properties = new Map();
    literal.writtenNames.clear();
    literal.computedMembers = [];
    literal.hasPendingMembers = false;
  }

  private optionalSpread(literal: ObjectLiteral, right: Type): Type {
    if (right.kind !== 'union') return right;
    const nonEmpty = right.types.filter((type) => !this.spreadsNothing(type));
    if (nonEmpty.length === 0) return emptyObjectType;
    if (nonEmpty.length > 1) return right;
    const properties = new Map<string, Property>();
    this.spreadInto(literal, properties, nonEmpty[0], true);
    if (isGenericSpread(nonEmpty[0])) {
      for (const [name, property] of this.c.structureOf(nonEmpty[0]).properties)
        if (isSpreadableProperty(property))
          properties.set(name, { ...spreadCopy(property, literal.isConstContext), optional: true });
    }
    return this.spreadObjectType(properties, this.indexesOf(nonEmpty[0], literal.isConstContext));
  }

  private mergeOrderedSpread(literal: ObjectLiteral, left: Type, right: Type): Type {
    this.c.budget.spend();
    if (left.kind === 'union')
      return unionOf(
        left.types.map((part) => this.mergeOrderedSpread(literal, part, right)),
        true
      );
    if (right.kind === 'union')
      return unionOf(
        right.types.map((part) => this.mergeOrderedSpread(literal, left, part)),
        true
      );
    if (isDefinitelyFalsy(right) || isIntrinsic(right, 'never') || isIntrinsic(right, 'object')) return left;
    if (isGenericSpread(left) || isGenericSpread(right)) return this.mergeGenericSpread(literal, left, right);
    const leftStructure = this.c.structureOf(left);
    const properties = new Map(this.spreadProperties(left, literal.isConstContext));
    this.spreadInto(literal, properties, right);
    const rightIndexes = this.indexesOf(right, literal.isConstContext);
    const indexes = this.spreadsNothing(left) ? rightIndexes : this.spreadIndexesOnto(leftStructure, rightIndexes);
    return this.spreadObjectType(properties, indexes);
  }

  private mergeGenericSpread(literal: ObjectLiteral, left: Type, right: Type): Type {
    if (this.spreadsNothing(left)) return right;
    if (left.kind === 'intersection' && right.kind === 'object' && !isGenericSpread(right)) {
      const tail = left.types.at(-1);
      if (tail?.kind === 'object' && !isGenericSpread(tail))
        return intersectionOf(
          [...left.types.slice(0, -1), this.mergeOrderedSpread(literal, tail, right)],
          this.c.budget
        );
    }
    return intersectionOf([left, right], this.c.budget);
  }

  private spreadsNothing(type: Type): boolean {
    if (
      type === emptyObjectType ||
      isDefinitelyFalsy(type) ||
      isIntrinsic(type, 'never') ||
      isIntrinsic(type, 'object')
    )
      return true;
    if (type.kind !== 'object' || isGenericSpread(type)) return false;
    const structure = this.c.structureOf(type);
    return (
      structure.properties.size === 0 &&
      structure.callSignatures.length === 0 &&
      structure.constructSignatures.length === 0 &&
      !hasIndexSignature(structure)
    );
  }

  private spreadObjectType(properties: Map<string, Property>, indexes: Indexes): ObjectType {
    return anonymousObject(() => ({ ...emptyStructure(), ...indexes, properties }), { isLiteral: true });
  }

  private checkSpreadOverrides(literal: ObjectLiteral, spread: Type): void {
    if (literal.explicitMembers.size === 0) return;
    const structures = (spread.kind === 'union' ? spread.types : [spread]).map((type) => this.c.structureOf(type));
    for (const [name, declaration] of literal.explicitMembers) {
      const overwrites = structures.every((structure) => {
        this.c.budget.spend();
        return structure.properties.get(name)?.optional === false;
      });
      if (overwrites) this.c.error(declaration, `プロパティ '${name}' は後のスプレッドによって上書きされます。`);
    }
  }

  /** Spreads a union of several objects, unless the alternatives it makes are more than TypeScript represents. */
  private spreadObjectUnion(literal: ObjectLiteral, member: TreeNode, spread: Type, parts: (Type | undefined)[]): void {
    if (this.countSpreadVariants(literal, member, typeMembers(spread).length)) this.spreadUnion(literal, parts);
  }

  private countSpreadVariants(literal: ObjectLiteral, member: TreeNode, count: number): boolean {
    // TypeScript refuses a cross product of union spreads of 100,000 alternatives or more, counting every member of
    // each union, though the members that spread nothing all leave the same alternative.
    const complexity = (literal.complexity ?? 1) * count;
    if (complexity >= 100_000) {
      this.c.error(member, 'この式の型は、表せないほど複雑な共用体型になります。');
      literal.isTooComplex = true;
      return false;
    }
    literal.complexity = complexity;
    return true;
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
    if (literal.computedMembers.length === 0) return {};
    const members = [
      ...literal.computedMembers,
      ...[...literal.writtenNames].flatMap((name) => {
        const property = literal.properties.get(name);
        if (!property) return [];
        const key = this.c.typeOperators.propertyKeyType(property);
        const index = isIndexKeyOf(this.c, key, numberType) ? 'numberIndex' : this.indexKeyOf(key);
        return index ? [{ key: index, type: property.type() }] : [];
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
      const propertyContext = this.c.propertyOf(contextual, name)?.type();
      const valueType = regularOf(
        this.c.silently(() =>
          isShorthand ? this.c.expressions.identifier(value) : this.c.expressions.check(value, propertyContext)
        )
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

  preserveContextualLiterals(type: Type, contextual: Type): Type {
    if (!typeMembers(type).some(isFreshLiteral)) return type;
    return mapType(type, (member) =>
      isFreshLiteral(member) && this.expectsLiteral(contextual, member) ? regularOf(member) : member
    );
  }

  private literalValueType(type: Type, contextual: Type | undefined, isConst: boolean): Type {
    const preservesLiteral = isConst || (contextual && this.expectsLiteral(contextual, type));
    // Regular primitive literals survive later inference widening. Nested objects still need excess-property checks.
    return mapType(type, (member) =>
      member.kind !== 'literal' ? member : preservesLiteral ? regularOf(member) : this.c.widenLiteral(member)
    );
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
    const constraint = parameter.substitution?.constraint ?? parameter.constraint?.();
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
            this.c.relations.isRelated(member, other, 'strictSubtype') &&
            !(otherIndex > index && this.c.relations.isRelated(other, member, 'strictSubtype'))
        )
    );
    return unionOf(kept, true);
  }

  literalProperty(name: string, type: Type, readonly: boolean, declaration: TreeNode, nameType?: Type): Property {
    return {
      name,
      nameType,
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
  contextualPropertyType(contextual: Type, name: string, key: Type = literalType(name)): Type | undefined {
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
      const index = namedPropertyIndex(this.c, this.c.structureOf(apparent), name, key);
      if (index) types.push(index.type);
    }
    return types.length > 0 ? unionOf(types, true, true) : undefined;
  }

  /** The type a variable declared with this initializer type gets. */
  widenDeclared(type: Type, isConst: boolean, keepFresh = false): Type {
    // A constant keeps a fresh literal type, which widens again where a mutable location takes its value.
    // Only a fresh literal widens, which `as const` and annotations make regular.
    if (type.kind === 'literal') return isConst || !type.fresh ? type : this.c.widenLiteral(type);
    if (type.kind === 'union') {
      const widened = mapType(type, (member) => this.widenDeclared(member, isConst, keepFresh));
      return widened.kind === 'union'
        ? unionOf(this.normalizeObjectLiterals(widened.types, { keepFresh }), keepFresh)
        : widened;
    }
    if (type.kind === 'object') {
      // Only an array literal holds fresh literals; another array, as one of a recursive alias, is left as it is.
      if (this.isArrayLiteral(type))
        return this.c.arrayType(this.widenDeclared(this.c.elementTypeOf(type), false, keepFresh));
      if (isObjectLiteral(type)) return this.widenObjectLiteral(type, keepFresh);
    }
    return regularOf(type);
  }

  private widenObjectLiteral(type: ObjectType, keepFresh: boolean): ObjectType {
    const source = type.regular ?? type;
    const widened = anonymousObject(
      () => {
        const structure = source.resolve();
        const properties = new Map<string, Property>();
        for (const [name, property] of structure.properties) {
          properties.set(name, {
            ...property,
            type: () => {
              const value = property.type();
              if (property.readonly && !property.getterOnly) return keepFresh ? value : regularOf(value);
              return this.widenDeclared(value, false, keepFresh);
            },
          });
        }
        return { ...structure, properties };
      },
      { isLiteral: true, isUnionSpread: type.isUnionSpread }
    );
    return keepFresh && type.fresh ? freshObjectLiteral(widened) : widened;
  }

  inlineBindingType(type: Type, expression: TreeNode): Type {
    const source = mapType(type, (member) =>
      member.kind === 'object' && this.isObjectLiteralWithin(member, expression)
        ? freshObjectLiteral(member.regular ?? member)
        : member
    );
    return source.kind === 'union'
      ? unionOf(this.normalizeObjectLiterals(source.types, { keepFresh: true, freshOnly: true }), true)
      : source;
  }

  /**
   * Gives each object literal type of a union the properties only its siblings have, as optional `undefined`, so that
   * `[{ a: 1 }, { a: 2, b: 3 }]` has elements whose `b` can be read.
   */
  normalizeObjectLiterals(types: Type[], { keepFresh = false, freshOnly = false } = {}): Type[] {
    const literals = types.filter((type) => isObjectLiteral(type) && !type.isUnionSpread && (!freshOnly || type.fresh));
    if (literals.length < 2) return types;
    const missingProperties = new Map<string, Property>();
    const structures = new Map<Type, Structure>();
    let declaredProperties = 0;
    for (const literal of literals) {
      const structure = this.c.structureOf(literal);
      structures.set(literal, structure);
      declaredProperties += structure.properties.size;
      this.c.budget.spend(structure.properties.size);
      for (const name of structure.properties.keys()) {
        if (!missingProperties.has(name))
          missingProperties.set(name, simpleProperty(name, undefinedType, { optional: true }));
      }
    }
    this.c.budget.spend(missingProperties.size * literals.length - declaredProperties);
    return types.map((type) => {
      const structure = structures.get(type);
      if (!structure || structure.properties.size === missingProperties.size) return type;
      const normalized = normalizedLiteral(structure, missingProperties);
      return keepFresh && type.kind === 'object' && type.fresh ? freshObjectLiteral(normalized) : normalized;
    });
  }
}

function normalizedLiteral(structure: Structure, missing: ReadonlyMap<string, Property>): ObjectType {
  return anonymousObject(
    () => {
      const properties = new Map(structure.properties);
      for (const [name, property] of missing) if (!properties.has(name)) properties.set(name, property);
      return { ...structure, properties };
    },
    { isLiteral: true }
  );
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

function isGenericSpread(type: Type): boolean {
  if (type.kind === 'union' || type.kind === 'intersection') return type.types.some(isGenericSpread);
  if (type.kind === 'object') {
    if (type.mapped)
      return (
        isGenericObjectOrIndexType(type.mapped.constraint) ||
        (!!type.mapped.nameType && isGenericObjectOrIndexType(type.mapped.nameType, [type.mapped.typeParameter]))
      );
    return type.tuple?.elements.some((element) => element.rest && isGenericObjectOrIndexType(element.type)) ?? false;
  }
  return type.kind === 'typeParameter' || type.kind === 'conditional' || type.kind === 'indexedAccess';
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

export function spreadCopy(property: Property, readonly: boolean): Property {
  if (!property.setterOnly && readonly === (property.readonly || property.getterOnly === true))
    return { ...property, readonly };
  return {
    ...property,
    type: property.setterOnly ? () => undefinedType : property.type,
    readonly,
    getterOnly: false,
    setterOnly: false,
    writeType: undefined,
  };
}

function isDiscriminantValue(node: TreeNode): boolean {
  if (node.type === 'parenthesized_expression') return isDiscriminantValue(named(node)[0]);
  if (node.type === 'member_expression') {
    const object = node.childForFieldName('object');
    return object !== null && isDiscriminantValue(object);
  }
  return ['string', 'number', 'template_string', 'true', 'false', 'null', 'identifier'].includes(node.type);
}
