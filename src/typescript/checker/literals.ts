import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { hasToken, isNumericName, named, propertyNameText } from './syntax';
import {
  anonymousObject,
  anyType,
  emptyStructure,
  errorType,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  mapType,
  neverType,
  newTypeId,
  type ObjectType,
  type Property,
  regularOf,
  type Type,
  type TypeParameter,
  undefinedType,
  unionOf,
  unknownType,
} from './types';

type MemberKind = 'property' | 'get' | 'set';

/** An object literal being checked, with the members checked so far. */
interface ObjectLiteral {
  contextual: Type | undefined;
  isConstContext: boolean;
  properties: Map<string, Property>;
  stringIndex?: Type;
  /** Spreads of type parameters, which the literal's type intersects. */
  genericSpreads: Type[];
  /**
   * After a spread of a union, the properties each of its alternatives gives the literal, which `properties` (the
   * members written since) then override.
   */
  alternatives?: Map<string, Property>[];
  /** Whether its spreads made more alternatives than TypeScript represents, which makes the literal an error. */
  isTooComplex?: boolean;
  /**
   * The kinds of member seen so far under each name, and whether an accessor conflict has stopped TypeScript from
   * checking the rest of the literal's names.
   */
  seenKeys: Map<string, Set<MemberKind>>;
  stopsKeyCheck?: boolean;
  object: ObjectType;
  receiver: ObjectType;
  declarations: Map<string, Property>;
}

/** Checks array and object literals and widens the types of their values. */
export class LiteralChecker {
  private readonly arrayLiterals = new Set<number>();

  constructor(private readonly c: Checker) {}

  hasLiteralConstituent(type: Type, primitive: 'string' | 'number' | 'boolean'): boolean {
    const members = type.kind === 'union' ? type.types : [type];
    return members.some(
      (member) =>
        (member.kind === 'literal' && typeof member.value === primitive) ||
        member.kind === 'templateLiteral' ||
        (member.kind === 'typeParameter' && primitive === 'string')
    );
  }

  // code-gauge-allow functionCognitiveComplexity 24 -- Builds a tuple or an array type from elements and spreads as TypeScript does.
  arrayLiteral(node: TreeNode, contextual?: Type): Type {
    const elements = named(node);
    const tupleContext = contextual ? this.tupleContext(contextual) : undefined;
    const isConstContext = this.isConstContext(node);
    const elementContext = contextual ? this.elementContext(contextual) : undefined;
    const types: { type: Type; spread: boolean }[] = elements.map((element, index) => {
      if (element.type === 'spread_element') {
        const spread = this.c.expressions.check(named(element)[0]);
        return { type: spread, spread: true };
      }
      const context = tupleContext ? (this.tupleElementContext(tupleContext, index) ?? elementContext) : elementContext;
      const type = this.c.expressions.check(element, context);
      return { type: isConstContext ? type : this.widenForMutableLocation(type, context), spread: false };
    });
    if (tupleContext || isConstContext || isSpreadIntoCall(node)) {
      const tupleElements = types.flatMap(({ type, spread }, index) => {
        if (!spread) return [{ type: isConstContext ? regularOf(type) : type, optional: false, rest: false }];
        if (type.kind === 'object' && type.objectKind === 'tuple') return type.tuple?.elements ?? [];
        return [
          {
            type: this.c.arrayType(this.c.silently(() => this.c.patterns.iteratedType(elements[index], type))),
            optional: false,
            rest: true,
          },
        ];
      });
      return this.c.tupleType(tupleElements, isConstContext);
    }
    const elementTypes = types.map(({ type, spread }, index) =>
      spread ? this.c.patterns.iteratedType(named(elements[index])[0], type) : type
    );
    const array = {
      ...this.c.arrayType(elementTypes.length === 0 ? neverType : unionOf(elementTypes, true)),
      id: newTypeId(),
    };
    this.arrayLiterals.add(array.id);
    return array;
  }

  isArrayLiteral(type: Type): boolean {
    return this.arrayLiterals.has(type.id);
  }

  private tupleContext(contextual: Type): ObjectType | undefined {
    const members = contextual.kind === 'union' ? contextual.types : [contextual];
    return members.find((member): member is ObjectType => member.kind === 'object' && member.objectKind === 'tuple');
  }

  private tupleElementContext(tuple: ObjectType, index: number): Type | undefined {
    const elements = tuple.tuple?.elements ?? [];
    const element = elements[index];
    if (element && !element.rest) return element.type;
    const rest = elements.find((member) => member.rest);
    return rest ? this.c.restElementType(rest.type) : undefined;
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
  private isConstContext(node: TreeNode): boolean {
    let current: TreeNode | null = node.parent;
    let child: TreeNode = node;
    while (current) {
      if (current.type === 'as_expression')
        return current.children.some((part) => part?.type === 'const') && named(current)[0]?.id === child.id;
      if (current.type === 'type_assertion') return named(current)[0]?.text === 'const';
      if (
        !['parenthesized_expression', 'array', 'object', 'pair', 'spread_element', 'ternary_expression'].includes(
          current.type
        )
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
    const literal: ObjectLiteral = {
      contextual: contextual && this.discriminatedContext(node, contextual),
      isConstContext: this.isConstContext(node),
      properties,
      declarations,
      receiver: anonymousObject(() => ({ ...emptyStructure(), properties: declarations })),
      genericSpreads: [],
      seenKeys: new Map(),
      object: anonymousObject(
        () => ({
          ...emptyStructure(),
          properties,
          stringIndex: literal.stringIndex && { type: literal.stringIndex, readonly: false },
        }),
        { isLiteral: true }
      ),
    };
    for (const member of named(node)) this.declareObjectMember(literal, member);
    for (const member of named(node)) this.objectMember(literal, member);
    if (contextual) this.addPatternDefaults(properties, contextual);
    const { object, genericSpreads, alternatives } = literal;
    if (literal.isTooComplex) return errorType;
    if (alternatives) {
      const variants = alternatives.map((alternative) => {
        const variant = anonymousObject(
          () => ({
            ...emptyStructure(),
            properties: new Map([...alternative, ...properties]),
            stringIndex: literal.stringIndex && { type: literal.stringIndex, readonly: false },
          }),
          { isLiteral: true, isUnionSpread: true }
        );
        return { ...variant, id: variant.id, fresh: true, regular: variant } as ObjectType;
      });
      return genericSpreads.length > 0
        ? intersectionOf([...genericSpreads, unionOf(variants)], this.c.budget)
        : unionOf(variants);
    }
    const fresh: ObjectType = { ...object, id: object.id, fresh: true, regular: object };
    if (genericSpreads.length > 0) return intersectionOf([...genericSpreads, object], this.c.budget);
    return fresh;
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
        break;
      }
      default: {
        break;
      }
    }
  }

  private pairMember(literal: ObjectLiteral, member: TreeNode): void {
    const key = member.childForFieldName('key') as TreeNode;
    const value = member.childForFieldName('value') as TreeNode;
    const name = propertyNameText(key);
    if (key.type === 'computed_property_name' && name !== undefined) this.c.expressions.check(named(key)[0]);
    if (name === undefined) {
      this.computedMember(literal, member, key, value);
      return;
    }
    this.checkDuplicateKey(literal, key, name);
    const context = this.memberContext(literal, name);
    const checked = this.c.expressions.check(value, context);
    const valueType = literal.isConstContext ? checked : this.widenForMutableLocation(checked, context);
    literal.properties.set(name, this.literalProperty(name, valueType, literal.isConstContext, member));
  }

  private computedMember(literal: ObjectLiteral, member: TreeNode, key: TreeNode, value: TreeNode): void {
    const keyType = this.c.expressions.check(named(key)[0] ?? key);
    const valueType = this.c.expressions.checkWidened(value);
    if (keyType.kind === 'literal' && (typeof keyType.value === 'string' || typeof keyType.value === 'number')) {
      const name = String(keyType.value);
      literal.properties.set(name, this.literalProperty(name, valueType, literal.isConstContext, member));
    } else {
      literal.stringIndex = unionOf([literal.stringIndex ?? neverType, valueType]);
    }
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
    literal.properties.set(name, this.literalProperty(name, valueType, literal.isConstContext, member));
  }

  private methodMember(literal: ObjectLiteral, member: TreeNode): void {
    const nameNode = member.childForFieldName('name') as TreeNode;
    const name = this.memberName(nameNode);
    const isGetter = hasToken(member, 'get');
    const isSetter = hasToken(member, 'set');
    const methodType = this.c.classes.withObjectThis(
      literal.receiver,
      () =>
        this.c.functions.functionExpression(member, name === undefined ? undefined : this.memberContext(literal, name)),
      member
    );
    // A key that is not a literal gives the object an index signature, as a computed property does.
    if (name === undefined) {
      const valueType = isGetter ? (this.c.signaturesOf(methodType, 'call')[0]?.returnType() ?? anyType) : methodType;
      if (!isSetter) literal.stringIndex = unionOf([literal.stringIndex ?? neverType, valueType]);
      return;
    }
    // TypeScript's grammar check compares only names written as literals.
    if (propertyNameText(nameNode) !== undefined)
      this.checkDuplicateKey(literal, nameNode, name, isGetter ? 'get' : isSetter ? 'set' : 'property');
    if (isGetter || isSetter) {
      this.accessorMember(literal, member, name, methodType);
      return;
    }
    literal.properties.set(name, { ...this.literalProperty(name, methodType, false, member), isMethod: true });
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
    const keyType = this.c.expressions.check(named(nameNode)[0]);
    if (written !== undefined) return written;
    return keyType.kind === 'literal' && ['string', 'number'].includes(typeof keyType.value)
      ? String(keyType.value)
      : undefined;
  }

  private accessorMember(literal: ObjectLiteral, member: TreeNode, name: string, methodType: Type): void {
    const { properties } = literal;
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
    const objectPart = this.c.relations.removeNullish(spread);
    const members = objectPart.kind === 'union' ? objectPart.types : [objectPart];
    if (
      !members.every(
        (type) =>
          isAnyLike(type) || type.kind === 'object' || type.kind === 'intersection' || type.kind === 'typeParameter'
      )
    )
      this.c.error(operand, 'スプレッド構文は、オブジェクト型にのみ使えます。');
    if (spread.kind === 'typeParameter') {
      literal.genericSpreads.push(spread);
      return;
    }
    if (literal.isTooComplex) return;
    const objectMembers = members.filter((type) => type.kind === 'object' || type.kind === 'intersection');
    if (objectMembers.length < 2) {
      this.spreadInto(literal.properties, spread);
      return;
    }
    // Each alternative of a union spreads its own properties, as TypeScript gives the literal a union type.
    const bases = literal.alternatives ?? [new Map<string, Property>()];
    const count = bases.length * objectMembers.length;
    // TypeScript refuses a cross product of union spreads past 100,000 alternatives.
    if (count > 100_000) {
      this.c.error(member, 'この式の型は、表せないほど複雑な共用体型になります。');
      literal.isTooComplex = true;
      return;
    }
    this.c.budget.spend(count);
    literal.alternatives = bases.flatMap((base) =>
      objectMembers.map((type) => {
        const alternative = new Map([...base, ...literal.properties]);
        this.spreadInto(alternative, type);
        return alternative;
      })
    );
    literal.properties.clear();
  }

  private spreadInto(properties: Map<string, Property>, spread: Type): void {
    for (const [name, property] of this.spreadProperties(spread)) {
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
  // code-gauge-allow functionCognitiveComplexity 16 -- Follows TypeScript's discrimination of a contextual union by literal properties.
  private discriminatedContext(node: TreeNode, contextual: Type): Type {
    if (contextual.kind !== 'union') return contextual;
    let members = contextual.types;
    for (const member of named(node)) {
      if (member.type !== 'pair') continue;
      const name = propertyNameText(member.childForFieldName('key') as TreeNode);
      const value = member.childForFieldName('value') as TreeNode;
      if (name === undefined || !['string', 'number', 'true', 'false'].includes(value.type)) continue;
      if (!this.c.flow.isDiscriminant(contextual, name)) continue;
      const valueType = regularOf(this.c.silently(() => this.c.expressions.check(value)));
      const selected = members.filter((candidate) => {
        const property = candidate.kind === 'object' ? this.c.propertyOf(candidate, name) : undefined;
        return !property || this.c.relations.isAssignable(valueType, property.type());
      });
      if (selected.length > 0) members = selected;
    }
    return members.length === contextual.types.length ? contextual : unionOf(members);
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

  private spreadProperties(type: Type): Map<string, Property> {
    const result = new Map<string, Property>();
    for (const member of type.kind === 'union' ? type.types : [type]) {
      if (member.kind !== 'object' && member.kind !== 'intersection') continue;
      for (const [name, property] of this.c.structureOf(member).properties) {
        if (property.isMethod && member.kind === 'object' && member.classInfo) continue;
        result.set(name, { ...property, readonly: false });
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
      if (structure.stringIndex) types.push(structure.stringIndex.type);
      else if (isNumericName(name) && structure.numberIndex) types.push(structure.numberIndex.type);
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
      if (this.c.isArrayType(type)) {
        const element = this.c.elementTypeOf(type);
        const widened = this.widenDeclared(element, false);
        return widened === element && !this.isArrayLiteral(type) ? type : this.c.arrayType(widened);
      }
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

function isObjectLiteral(type: Type): type is ObjectType {
  return type.kind === 'object' && type.objectKind === 'anonymous' && !!type.isLiteral && !type.isFunction;
}

/** Whether an array literal is spread into a call's arguments, as in `f(...[1, 2])`, where it is typed as a tuple. */
function isSpreadIntoCall(node: TreeNode): boolean {
  let parent = node.parent;
  while (parent?.type === 'parenthesized_expression') parent = parent.parent;
  return parent?.type === 'spread_element' && parent.parent?.type === 'arguments';
}
