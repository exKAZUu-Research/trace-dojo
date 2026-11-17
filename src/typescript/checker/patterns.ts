import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { arrayPatternElements, named, propertyNameText } from './syntax';
import {
  anonymousObject,
  anyType,
  emptyStructure,
  errorType,
  isAnyLike,
  isIntrinsic,
  literalType,
  regularOf,
  simpleProperty,
  stringType,
  type TupleElement,
  type Type,
  undefinedType,
  unionOf,
} from './types';

/** Gives the names a binding pattern declares the types of what it destructures. */
export class BindingPatterns {
  readonly correlatedSources = new Map<number, Type>();
  /** The object types `impliedType` made, whose defaulted properties an object literal they contextually type gains. */
  readonly impliedTypes = new WeakSet<Type>();
  private readonly selectedKeys = new Map<number, string[] | undefined>();
  constructor(private readonly c: Checker) {}

  /** The type a binding pattern gives the name `name` when it destructures a value of `type`. */
  patternType(pattern: TreeNode, type: Type, name: string): Type {
    let result: Type = anyType;
    this.bindPattern(pattern, type, (identifier, identifierType) => {
      if (identifier.text === name) result = identifierType;
    });
    return result;
  }

  /**
   * Destructures a value of `type` with a binding pattern, calling `bind` with each name and its type. `annotated` tells
   * whether the declaration the pattern belongs to has a type annotation, which its defaults must then conform to.
   */
  bindPattern(
    pattern: TreeNode,
    type: Type,
    bind: (identifier: TreeNode, type: Type) => void,
    annotated = false
  ): void {
    switch (pattern.type) {
      case 'identifier':
      case 'shorthand_property_identifier_pattern': {
        bind(pattern, type);
        return;
      }
      case 'assignment_pattern':
      case 'object_assignment_pattern': {
        const left = pattern.childForFieldName('left') as TreeNode;
        const right = pattern.childForFieldName('right') as TreeNode;
        const implied = this.impliedType(left);
        const defaultType = this.c.expressions.check(right, implied ?? type);
        this.checkInitializer(left, right, defaultType, implied);
        const withoutUndefined = this.c.relations.removeUndefined(type);
        if (annotated && !isIntrinsic(withoutUndefined, 'never')) {
          const declared = this.defaultMayBeUndefined(defaultType) ? type : withoutUndefined;
          this.c.expressions.checkAssignable(right, defaultType, declared);
          this.bindPattern(left, declared, bind, annotated);
          return;
        }
        this.bindPattern(left, this.c.widen(unionOf([withoutUndefined, regularOf(defaultType)])), bind, annotated);
        return;
      }
      case 'object_pattern': {
        this.bindObjectPattern(pattern, type, bind, annotated);
        return;
      }
      case 'array_pattern': {
        this.bindArrayPattern(pattern, type, bind, annotated);
        return;
      }
      default: {
        return;
      }
    }
  }

  /**
   * Whether a default value of a type may be `undefined`, which keeps `undefined` in what an annotated pattern or a
   * parameter defaults: a generic type may by its constraint, while `any`, `unknown`, and `void` may not, as
   * TypeScript 7 decides.
   */
  defaultMayBeUndefined(type: Type, path = new Set<Type>()): boolean {
    // Only a type on the path being followed is a cycle; one that two operands share is answered for each.
    if (path.has(type)) return false;
    path.add(type);
    try {
      if (type.kind === 'union') return type.types.some((member) => this.defaultMayBeUndefined(member, path));
      if (type.kind === 'intersection') return type.types.every((member) => this.defaultMayBeUndefined(member, path));
      const constraint = this.c.baseConstraint(type);
      return constraint === type ? isIntrinsic(type, 'undefined') : this.defaultMayBeUndefined(constraint, path);
    } finally {
      path.delete(type);
    }
  }

  /**
   * The type a binding or assignment pattern implies for the value it takes apart, which an initializer or a right side
   * takes as its contextual type: an object literal there gains the properties the pattern gives defaults, as
   * `const { a = 1 } = {}` does. `leafType` gives the type of an element that is not a pattern, with or without default.
   */
  /**
   * Checks an initializer, which no annotation types, against the type its pattern implies, reporting the properties of
   * its object literals that the pattern does not take apart, as TypeScript does.
   */
  checkInitializer(pattern: TreeNode, value: TreeNode, valueType: Type, implied = this.impliedType(pattern)): void {
    if (implied) this.c.expressions.checkExcessProperties(value, valueType, implied);
  }

  impliedType(pattern: TreeNode, leafType = (element: TreeNode) => this.bindingLeafType(element)): Type | undefined {
    switch (pattern.type) {
      case 'object':
      case 'object_pattern': {
        return this.impliedObjectType(pattern, leafType);
      }
      case 'array':
      case 'array_pattern': {
        return this.impliedTupleType(pattern, leafType);
      }
      default: {
        return undefined;
      }
    }
  }

  private impliedObjectType(pattern: TreeNode, leafType: (element: TreeNode) => Type): Type {
    const structure = emptyStructure();
    for (const element of named(pattern)) {
      const isPair = element.type === 'pair' || element.type === 'pair_pattern';
      const value = isPair ? (element.childForFieldName('value') as TreeNode) : element;
      const name = isPair
        ? propertyNameText(element.childForFieldName('key') as TreeNode)
        : (defaultedTarget(element) ?? element).text;
      // A rest element or a computed key takes properties the pattern does not name, which an initializer may have.
      if (name === undefined || element.type === 'spread_element' || element.type === 'rest_pattern') {
        structure.stringIndex = { type: anyType, readonly: false };
        continue;
      }
      structure.properties.set(
        name,
        simpleProperty(name, this.impliedElementType(value, leafType), { optional: !!defaultedTarget(value) })
      );
    }
    const type = anonymousObject(() => structure);
    this.impliedTypes.add(type);
    return type;
  }

  private impliedTupleType(pattern: TreeNode, leafType: (element: TreeNode) => Type): Type {
    const elements: TupleElement[] = [];
    for (const { element, index } of arrayPatternElements(pattern)) {
      while (elements.length < index) elements.push({ type: anyType, optional: false, rest: false });
      if (element.type === 'spread_element' || element.type === 'rest_pattern') {
        const rest = this.impliedElementType(named(element)[0], leafType);
        const isArray = rest.kind === 'object' && this.c.isArrayOrTuple(rest);
        elements.push({ type: isArray ? rest : this.c.arrayType(anyType), optional: false, rest: true });
        break;
      }
      elements.push({ type: this.impliedElementType(element, leafType), optional: false, rest: false });
    }
    return this.c.tupleType(elements);
  }

  private impliedElementType(element: TreeNode, leafType: (element: TreeNode) => Type): Type {
    return this.impliedType(defaultedTarget(element) ?? element, leafType) ?? leafType(element);
  }

  private bindingLeafType(element: TreeNode): Type {
    const right = defaultedTarget(element) && element.childForFieldName('right');
    return right ? this.c.silently(() => this.c.widen(this.c.expressions.check(right))) : anyType;
  }

  private bindObjectPattern(
    pattern: TreeNode,
    type: Type,
    bind: (identifier: TreeNode, type: Type) => void,
    annotated: boolean
  ): void {
    const used: string[] = [];
    for (const element of named(pattern)) {
      switch (element.type) {
        case 'shorthand_property_identifier_pattern': {
          used.push(element.text);
          bind(element, this.destructuredProperty(element, type, element.text));
          break;
        }
        case 'object_assignment_pattern': {
          const left = element.childForFieldName('left') as TreeNode;
          used.push(left.text);
          const propertyType = this.destructuredProperty(left, type, left.text);
          this.bindPattern(element, propertyType, bind, annotated);
          break;
        }
        case 'pair_pattern': {
          const key = element.childForFieldName('key') as TreeNode;
          const value = element.childForFieldName('value') as TreeNode;
          const selected = this.destructuredKey(key, type);
          this.bindPattern(value, selected.type, bind, annotated);
          used.push(...(selected.names ?? []));
          break;
        }
        case 'rest_pattern': {
          const target = named(element)[0];
          if (target) bind(target, this.restObject(type, used));
          break;
        }
        default: {
          break;
        }
      }
    }
  }

  destructuredKey(key: TreeNode, objectType: Type): { type: Type; names?: string[] } {
    const selection = this.patternKey(key);
    this.selectedKeys.set(key.id, selection.names);
    const type = selection.names
      ? unionOf(selection.names.map((name) => this.destructuredProperty(key, objectType, name)))
      : this.c.members.indexedType(key, key, selection.node, objectType, selection.type);
    return { type, names: selection.names };
  }

  propertyNames(key: TreeNode): string[] | undefined {
    return this.selectedKeys.has(key.id) ? this.selectedKeys.get(key.id) : this.capturePropertyNames(key);
  }

  capturePropertyNames(key: TreeNode): string[] | undefined {
    let names: string[] | undefined;
    this.c.flow.from(this.c.flow.current, () => {
      names = this.patternKey(key).names;
    });
    this.selectedKeys.set(key.id, names);
    return names;
  }

  private patternKey(key: TreeNode): { node: TreeNode; type: Type; names?: string[] } {
    if (key.type !== 'computed_property_name') {
      const name = propertyNameText(key);
      return {
        node: key,
        type: name === undefined ? anyType : literalType(name),
        names: name === undefined ? undefined : [name],
      };
    }
    const node = named(key)[0];
    const type = this.c.expressions.check(node);
    const constraint = this.c.baseConstraint(type);
    const members = constraint.kind === 'union' ? constraint.types : [constraint];
    const names: string[] = [];
    for (const member of members) {
      if (member.kind !== 'literal' || !['string', 'number'].includes(typeof member.value)) return { node, type };
      names.push(String(member.value));
    }
    return { node, type, names };
  }

  restObject(type: Type, omitted: string[]): Type {
    if (type.kind === 'union') return unionOf(type.types.map((member) => this.restObject(member, omitted)));
    return anonymousObject(
      () => {
        const structure = emptyStructure();
        const source = this.c.structureOf(type);
        structure.stringIndex = source.stringIndex;
        structure.numberIndex = source.numberIndex;
        for (const [name, property] of source.properties) {
          if (!omitted.includes(name) && !(property.isMethod && property.declaringClass))
            structure.properties.set(name, property);
        }
        return structure;
      },
      { isLiteral: true }
    );
  }

  destructuredProperty(node: TreeNode, type: Type, name: string): Type {
    if (isAnyLike(type)) return anyType;
    if (type.kind === 'union') {
      // Each member must have the property, whose types then unite.
      const types = type.types.map((member) => this.c.silently(() => this.destructuredProperty(node, member, name)));
      if (!types.includes(errorType)) {
        for (const member of type.types) {
          const property = this.c.propertyOf(member, name);
          if (property) this.c.members.checkPropertyUse(node, node, node, member, name, property);
        }
        return unionOf(types);
      }
    }
    const property = this.c.propertyOf(type, name);
    if (!property) {
      const indexType = this.c.members.indexSignatureType(type, name);
      if (indexType) return indexType;
      this.c.error(node, `プロパティ '${name}' は型 '${this.c.print(type)}' にありません。`);
      return errorType;
    }
    this.c.members.checkPropertyUse(node, node, node, type, name, property);
    const propertyType = property.type();
    return property.optional ? unionOf([propertyType, undefinedType]) : propertyType;
  }

  private bindArrayPattern(
    pattern: TreeNode,
    type: Type,
    bind: (identifier: TreeNode, type: Type) => void,
    annotated: boolean
  ): void {
    for (const { element, index } of arrayPatternElements(pattern)) {
      if (element.type === 'rest_pattern') {
        const target = named(element)[0];
        if (target) this.bindPattern(target, this.restOfIterable(pattern, type, index), bind, annotated);
        break;
      }
      this.bindPattern(element, this.elementAt(element, type, index), bind, annotated);
    }
  }

  elementAt(node: TreeNode, type: Type, index: number): Type {
    if (isAnyLike(type)) return anyType;
    if (type.kind === 'object' && type.objectKind === 'tuple') {
      const elements = type.tuple?.elements ?? [];
      const element = elements[index];
      if (!element) {
        const rest = elements.find((member) => member.rest);
        if (rest) return unionOf([this.c.restElementType(rest.type), undefinedType]);
        // An element with a default, as in `const [a = 1] = []`, takes the default where the tuple ends.
        if (node.type === 'assignment_pattern') return undefinedType;
        this.c.error(
          node,
          `長さ ${elements.length} のタプル型 '${this.c.print(type)}' には、インデックス ${index} の要素がありません。`
        );
        return errorType;
      }
      if (element.rest) return this.c.restElementType(element.type);
      return element.optional ? unionOf([element.type, undefinedType]) : element.type;
    }
    return this.iteratedType(node, type);
  }

  restOfIterable(pattern: TreeNode, type: Type, from: number): Type {
    if (type.kind === 'object' && type.objectKind === 'tuple') {
      return this.c.tupleType((type.tuple?.elements ?? []).slice(from));
    }
    return this.c.arrayType(this.iteratedType(pattern, type));
  }

  /** The type of the elements a `for...of` loop or a spread takes from a value. */
  iteratedType(node: TreeNode | undefined, type: Type): Type {
    if (isAnyLike(type)) return anyType;
    if (type.kind === 'union') return unionOf(type.types.map((member) => this.iteratedType(node, member)));
    if (type.kind === 'object' && this.c.isArrayOrTuple(type)) return this.c.elementTypeOf(type);
    if (
      isIntrinsic(type, 'string') ||
      (type.kind === 'literal' && typeof type.value === 'string') ||
      type.kind === 'templateLiteral'
    )
      return stringType;
    const iterator = this.c.propertyOf(type, '__@iterator');
    if (iterator) {
      const signature = this.c.signaturesOf(iterator.type(), 'call')[0];
      const iteratorType = signature?.returnType();
      if (iteratorType?.kind === 'object' && iteratorType.typeArguments?.[0]) return iteratorType.typeArguments[0];
    }
    if (type.kind === 'typeParameter') {
      const constraint = this.c.constraintOf(type);
      if (constraint) return this.iteratedType(node, constraint);
    }
    if (node)
      this.c.error(node, `型 '${this.c.print(type)}' には、反復処理に使う [Symbol.iterator]() メソッドがありません。`);
    return errorType;
  }
}

/** The target of an element with a default, as `a` in `a = 1`. */
export function defaultedTarget(element: TreeNode): TreeNode | undefined {
  return ['assignment_expression', 'assignment_pattern', 'object_assignment_pattern'].includes(element.type)
    ? (element.childForFieldName('left') ?? undefined)
    : undefined;
}
