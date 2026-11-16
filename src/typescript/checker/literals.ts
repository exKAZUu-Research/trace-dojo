import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { hasToken, named, propertyNameText } from './syntax';
import {
  anonymousObject,
  anyType,
  emptyStructure,
  intersectionOf,
  neverType,
  type ObjectType,
  type Property,
  regularOf,
  type Type,
  unionOf,
  unknownType,
} from './types';

/** An object literal being checked, with the members checked so far. */
interface ObjectLiteral {
  contextual: Type | undefined;
  isConstContext: boolean;
  properties: Map<string, Property>;
  stringIndex?: Type;
  /** Spreads of type parameters, which the literal's type intersects. */
  genericSpreads: Type[];
  /** The property names seen so far, with `get ` or `set ` before an accessor's. */
  seenKeys: Set<string>;
  object: ObjectType;
}

/** Checks array and object literals and widens the types of their values. */
export class LiteralChecker {
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
    if (tupleContext || isConstContext) {
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
    if (elementTypes.length === 0) return this.c.arrayType(neverType);
    return this.c.arrayType(unionOf(elementTypes, true));
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
    if (members.length === 0) {
      if (contextual.kind === 'typeParameter') return undefined;
      return undefined;
    }
    return unionOf(members.map((member) => this.c.elementTypeOf(member as ObjectType)));
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
    const literal: ObjectLiteral = {
      contextual,
      isConstContext: this.isConstContext(node),
      properties,
      genericSpreads: [],
      seenKeys: new Set(),
      object: anonymousObject(
        () => ({
          ...emptyStructure(),
          properties,
          stringIndex: literal.stringIndex && { type: literal.stringIndex, readonly: false },
        }),
        { isLiteral: true }
      ),
    };
    for (const member of named(node)) this.objectMember(literal, member);
    const { object, genericSpreads } = literal;
    const fresh: ObjectType = { ...object, id: object.id, fresh: true, regular: object };
    if (genericSpreads.length > 0) return intersectionOf([...genericSpreads, object]);
    return fresh;
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

  private checkDuplicateKey(literal: ObjectLiteral, keyNode: TreeNode, name: string): void {
    if (literal.seenKeys.has(name))
      this.c.error(keyNode, `オブジェクトリテラルには、同じ名前のプロパティを2つ以上書けません。`);
    literal.seenKeys.add(name);
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
    const name = propertyNameText(nameNode) ?? '';
    const isGetter = hasToken(member, 'get');
    const isSetter = hasToken(member, 'set');
    this.checkDuplicateKey(literal, nameNode, isGetter ? `get ${name}` : isSetter ? `set ${name}` : name);
    const methodType = this.c.classes.withObjectThis(literal.object, () =>
      this.c.functions.functionExpression(member, this.memberContext(literal, name))
    );
    if (isGetter || isSetter) {
      this.accessorMember(literal, member, name, methodType);
      return;
    }
    literal.properties.set(name, { ...this.literalProperty(name, methodType, false, member), isMethod: true });
  }

  private accessorMember(literal: ObjectLiteral, member: TreeNode, name: string, methodType: Type): void {
    const { properties } = literal;
    const isGetter = hasToken(member, 'get');
    const signature = this.c.signaturesOf(methodType, 'call')[0];
    const existing = properties.get(name);
    const accessorType = isGetter ? (signature?.returnType() ?? anyType) : (signature?.parameters[0]?.type ?? anyType);
    properties.set(name, {
      ...this.literalProperty(name, existing && !isGetter ? existing.type() : accessorType, false, member),
      readonly: isGetter && !existing,
      getterOnly: isGetter && !existing,
    });
    if (existing && hasToken(member, 'set')) properties.set(name, { ...existing, readonly: false, getterOnly: false });
  }

  private spreadMember(literal: ObjectLiteral, member: TreeNode): void {
    const spread = this.c.expressions.check(named(member)[0]);
    if (spread.kind === 'typeParameter') {
      literal.genericSpreads.push(spread);
      return;
    }
    for (const [name, property] of this.spreadProperties(spread)) literal.properties.set(name, property);
  }

  /** A literal's type in an array element or a property, widened unless the contextual type expects literals. */
  widenForMutableLocation(type: Type, contextual: Type | undefined): Type {
    if (contextual && this.expectsLiteral(contextual, type)) return type;
    return this.c.widenLiteral(type);
  }

  private expectsLiteral(contextual: Type, type: Type): boolean {
    const members = contextual.kind === 'union' ? contextual.types : [contextual];
    const literals = (type.kind === 'union' ? type.types : [type]).filter((member) => member.kind === 'literal');
    return members.some(
      (member) =>
        member.kind === 'typeParameter' ||
        member.kind === 'templateLiteral' ||
        member.kind === 'stringMapping' ||
        member.kind === 'keyof' ||
        member.kind === 'indexedAccess' ||
        (member.kind === 'literal' &&
          literals.some((literal) => typeof (literal as { value: unknown }).value === typeof member.value))
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
            !(this.c.relations.isAssignable(other, member) && otherIndex > index)
        )
    );
    return unionOf(kept, true);
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
      else if (/^\d+$/.test(name) && structure.numberIndex) types.push(structure.numberIndex.type);
    }
    return types.length > 0 ? unionOf(types, true) : undefined;
  }

  /** The type a variable declared with this initializer type gets. */
  // code-gauge-allow functionCognitiveComplexity 28 -- One case per kind of type that a declaration widens.
  widenDeclared(type: Type, isConst: boolean): Type {
    if (type.kind === 'literal') return isConst ? regularOf(type) : this.c.widenLiteral(type);
    if (type.kind === 'union') {
      const widened = isConst ? regularOf(type) : this.c.widenLiteral(type);
      return widened.kind === 'union'
        ? unionOf(widened.types.map((member) => this.widenDeclared(member, false)))
        : widened;
    }
    if (type.kind === 'object') {
      if (this.c.isArrayType(type)) {
        const element = this.c.elementTypeOf(type);
        const widened = this.widenDeclared(element, false);
        return widened === element ? type : this.c.arrayType(widened);
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
          { isLiteral: true }
        );
      }
    }
    return regularOf(type);
  }
}
