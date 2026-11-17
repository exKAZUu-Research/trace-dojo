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
  regularOf,
  stringType,
  type Type,
  undefinedType,
  unionOf,
} from './types';

/** Gives the names a binding pattern declares the types of what it destructures. */
export class BindingPatterns {
  constructor(private readonly c: Checker) {}

  /** The type a binding pattern gives the name `name` when it destructures a value of `type`. */
  patternType(pattern: TreeNode, type: Type, name: string): Type {
    let result: Type = anyType;
    this.bindPattern(pattern, type, (identifier, identifierType) => {
      if (identifier.text === name) result = identifierType;
    });
    return result;
  }

  /** Destructures a value of `type` with a binding pattern, calling `bind` with each name and its type. */
  bindPattern(pattern: TreeNode, type: Type, bind: (identifier: TreeNode, type: Type) => void): void {
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
        const defaultType = this.c.expressions.check(right, type);
        const withoutUndefined = this.c.relations.removeUndefined(type);
        this.bindPattern(left, this.c.widen(unionOf([withoutUndefined, regularOf(defaultType)])), bind);
        return;
      }
      case 'object_pattern': {
        this.bindObjectPattern(pattern, type, bind);
        return;
      }
      case 'array_pattern': {
        this.bindArrayPattern(pattern, type, bind);
        return;
      }
      default: {
        return;
      }
    }
  }

  private bindObjectPattern(pattern: TreeNode, type: Type, bind: (identifier: TreeNode, type: Type) => void): void {
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
          const propertyType = this.destructuredProperty(left, type, left.text, true);
          this.bindPattern(element, propertyType, bind);
          break;
        }
        case 'pair_pattern': {
          const name = this.bindPairPattern(element, type, bind);
          if (name !== undefined) used.push(name);
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

  /** Binds the value of a `key: value` pattern, returning the property name it takes unless the key is computed. */
  private bindPairPattern(
    element: TreeNode,
    type: Type,
    bind: (identifier: TreeNode, type: Type) => void
  ): string | undefined {
    const key = element.childForFieldName('key') as TreeNode;
    const value = element.childForFieldName('value') as TreeNode;
    const name = propertyNameText(key);
    if (name === undefined) {
      this.c.expressions.check(named(key)[0] ?? key);
      this.bindPattern(value, anyType, bind);
      return undefined;
    }
    const optional = value.type === 'assignment_pattern';
    this.bindPattern(value, this.destructuredProperty(key, type, name, optional), bind);
    return name;
  }

  private restObject(type: Type, omitted: string[]): Type {
    return anonymousObject(
      () => {
        const structure = emptyStructure();
        for (const [name, property] of this.c.structureOf(type).properties) {
          if (!omitted.includes(name) && !property.isMethod) structure.properties.set(name, property);
        }
        return structure;
      },
      { isLiteral: true }
    );
  }

  destructuredProperty(node: TreeNode, type: Type, name: string, hasDefault = false): Type {
    if (isAnyLike(type)) return anyType;
    if (type.kind === 'union') {
      // Each member must have the property, whose types then unite.
      const types = type.types.map((member) =>
        this.c.silently(() => this.destructuredProperty(node, member, name, hasDefault))
      );
      if (!types.includes(errorType)) return unionOf(types);
    }
    const property = this.c.propertyOf(type, name);
    if (!property) {
      const structure = this.c.structureOf(type);
      if (structure.stringIndex) return structure.stringIndex.type;
      this.c.error(node, `プロパティ '${name}' は型 '${this.c.print(type)}' にありません。`);
      return errorType;
    }
    const propertyType = property.type();
    return property.optional && !hasDefault ? unionOf([propertyType, undefinedType]) : propertyType;
  }

  private bindArrayPattern(pattern: TreeNode, type: Type, bind: (identifier: TreeNode, type: Type) => void): void {
    for (const { element, index } of arrayPatternElements(pattern)) {
      if (element.type === 'rest_pattern') {
        const target = named(element)[0];
        if (target) this.bindPattern(target, this.restOfIterable(type, index), bind);
        break;
      }
      this.bindPattern(element, this.elementAt(element, type, index), bind);
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

  restOfIterable(type: Type, from: number): Type {
    if (type.kind === 'object' && type.objectKind === 'tuple') {
      return this.c.tupleType((type.tuple?.elements ?? []).slice(from));
    }
    return this.c.arrayType(this.c.silently(() => this.iteratedType(undefined, type)));
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
