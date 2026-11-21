import assert from 'node:assert/strict';

import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { isDefinitelyFalsy, isSpreadableProperty, spreadCopy } from './literals';
import { arrayPatternElements, named, numberValue, propertyNameText } from './syntax';
import { tupleElementReadType, tupleSliceReadType } from './tupleIndexes';
import {
  anonymousObject,
  anyType,
  emptyStructure,
  errorType,
  freshObjectLiteral,
  isAnyLike,
  isIntrinsic,
  isPropertyKeyLiteral,
  literalType,
  neverType,
  type ObjectType,
  propertyAccessType,
  simpleProperty,
  stringType,
  type TupleElement,
  type Type,
  undefinedType,
  unionOf,
  type UnionType,
} from './types';

interface BindingOptions {
  annotated?: boolean;
  isConst?: boolean;
  literalSource?: TreeNode;
}

type Bind = (identifier: TreeNode, type: Type, assigned?: Type) => void;

/** Gives the names a binding pattern declares the types of what it destructures. */
export class BindingPatterns {
  readonly correlatedSources = new Map<number, Type>();
  private readonly selectedKeys = new Map<number, string[] | undefined>();
  constructor(private readonly c: Checker) {}

  /** The type a binding pattern gives the name `name` when it destructures a value of `type`. */
  patternType(pattern: TreeNode, type: Type, name: string, options: BindingOptions = {}): Type {
    return this.c.flow.probe(() => {
      let result: Type = anyType;
      this.bindPattern(
        pattern,
        type,
        (identifier, identifierType) => {
          if (identifier.text === name) result = identifierType;
        },
        options
      );
      return result;
    });
  }

  /**
   * Destructures a value of `type` with a binding pattern, calling `bind` with each name and its type. `annotated` tells
   * whether the declaration the pattern belongs to has a type annotation, which its defaults must then conform to.
   */
  bindPattern(pattern: TreeNode, type: Type, bind: Bind, options: BindingOptions = {}, assigned?: Type): void {
    switch (pattern.type) {
      case 'identifier':
      case 'shorthand_property_identifier_pattern': {
        bind(pattern, type, assigned);
        return;
      }
      case 'assignment_pattern':
      case 'object_assignment_pattern': {
        this.bindDefault(pattern, type, bind, options, assigned);
        return;
      }
      case 'object_pattern': {
        this.bindObjectPattern(
          pattern,
          options.literalSource ? this.c.literals.inlineBindingType(type, options.literalSource) : type,
          bind,
          options
        );
        return;
      }
      case 'array_pattern': {
        this.bindArrayPattern(pattern, type, bind, options);
        return;
      }
      default: {
        return;
      }
    }
  }

  private bindDefault(pattern: TreeNode, type: Type, bind: Bind, options: BindingOptions, assigned?: Type): void {
    const left = pattern.childForFieldName('left') as TreeNode;
    const right = pattern.childForFieldName('right') as TreeNode;
    const implied = this.impliedBindingType(left, options.isConst);
    const defaultType = this.initializerType(right, implied ?? (options.annotated ? type : undefined));
    this.checkInitializer(left, right, defaultType);
    const withoutUndefined = this.c.relations.removeUndefined(type);
    if (options.annotated && !isIntrinsic(withoutUndefined, 'never')) {
      const declared = this.defaultMayBeUndefined(defaultType) ? type : withoutUndefined;
      this.c.expressions.checkAssignable(right, defaultType, declared);
      this.bindPattern(left, declared, bind, options);
      return;
    }
    const combined = unionOf([withoutUndefined, defaultType], true);
    const declared = options.isConst || implied ? combined : this.c.widen(combined);
    this.bindPattern(left, declared, bind, options, assigned === errorType ? undefined : combined);
  }

  initializerType(value: TreeNode, contextual?: Type): Type {
    const skipped = this.c.flow.current;
    let type: Type = anyType;
    const initialized = this.c.flow.from(skipped, () => {
      type = this.c.expressions.check(value, contextual);
    });
    this.c.flow.current = this.c.flow.merge([skipped, initialized]);
    return type;
  }

  /**
   * Whether a default value of a type may be `undefined`, which keeps `undefined` in what an annotated pattern or a
   * parameter defaults: a generic type may by its constraint, while `any`, `unknown`, and `void` may not, as
   * TypeScript 7 decides.
   */
  defaultMayBeUndefined(type: Type, path = new Set<Type>(), answers = new Map<Type, boolean>()): boolean {
    // Only a type on the path being followed is a cycle; one that operands share keeps the answer found for it.
    const known = answers.get(type);
    if (known !== undefined) return known;
    if (path.has(type)) return false;
    this.c.budget.spend();
    path.add(type);
    try {
      const next = (member: Type): boolean => this.defaultMayBeUndefined(member, path, answers);
      let answer: boolean;
      if (type.kind === 'union') answer = type.types.some(next);
      else if (type.kind === 'intersection') answer = type.types.every(next);
      else {
        const constraint = this.c.baseConstraint(type);
        answer = constraint === type ? isIntrinsic(type, 'undefined') : next(constraint);
      }
      answers.set(type, answer);
      return answer;
    } finally {
      path.delete(type);
    }
  }

  /**
   * Checks an initializer, which no annotation types, against the type its pattern implies, reporting the properties of
   * its object literals that the pattern does not take apart, as TypeScript does.
   */
  checkInitializer(pattern: TreeNode, value: TreeNode, valueType: Type): void {
    const shape = this.impliedType(pattern, () => anyType);
    if (shape) this.c.expressions.checkExcessProperties(value, valueType, shape);
  }

  /**
   * The type a binding or assignment pattern implies for the value it takes apart, which an initializer or a right side
   * takes as its contextual type. `leafType` gives the type of an element that is not a pattern, with or without default.
   */
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

  impliedBindingType(pattern: TreeNode, isConst = false): Type | undefined {
    return this.impliedType(pattern, (element) => this.bindingLeafType(element, isConst));
  }

  parameterInitializerType(pattern: TreeNode, value: Type, implied: Type | undefined): Type {
    if (!implied) return value;
    if (isTuple(value) && isTuple(implied)) return this.padParameterTuple(value, implied);
    if (pattern.type !== 'object_pattern' || value.kind !== 'object' || !value.fresh) return value;
    const structure = this.c.structureOf(value);
    const properties = new Map(structure.properties);
    for (const [name, property] of this.c.structureOf(implied).properties) {
      if (property.optional) properties.set(name, { ...(properties.get(name) ?? property), optional: true });
    }
    return freshObjectLiteral(anonymousObject(() => ({ ...structure, properties }), { isLiteral: true }));
  }

  private padParameterTuple(value: ObjectType, implied: ObjectType): Type {
    const tuple = value.tuple;
    if (!tuple || tuple.elements.some((element) => element.rest)) return value;
    const extra = (implied.tuple?.elements ?? []).slice(tuple.elements.length).filter((element) => !element.rest);
    return extra.length > 0
      ? this.c.tupleType(
          [...tuple.elements, ...extra.map((element) => ({ ...element, optional: true }))],
          tuple.readonly
        )
      : value;
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
    return anonymousObject(() => structure);
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

  private bindingLeafType(element: TreeNode, isConst = false): Type {
    const right = defaultedTarget(element) && element.childForFieldName('right');
    if (!right) return anyType;
    return this.c.flow.probe(() =>
      this.c.silently(() => (isConst ? this.c.expressions.check(right) : this.c.expressions.checkWidened(right)))
    );
  }

  private bindObjectPattern(pattern: TreeNode, type: Type, bind: Bind, options: BindingOptions): void {
    if (isEmptyPattern(pattern)) this.checkEmptyObjectSource(pattern, type);
    const used: Type[] = [];
    for (const element of named(pattern)) {
      switch (element.type) {
        case 'shorthand_property_identifier_pattern': {
          used.push(literalType(element.text));
          bind(element, this.destructuredProperty(element, type, element.text));
          break;
        }
        case 'object_assignment_pattern': {
          const left = element.childForFieldName('left') as TreeNode;
          used.push(literalType(left.text));
          const propertyType = this.destructuredProperty(left, type, left.text, true);
          this.bindPattern(
            element,
            propertyType,
            bind,
            options,
            this.defaultPropertySource(type, propertyType, [left.text])
          );
          break;
        }
        case 'pair_pattern': {
          const key = element.childForFieldName('key') as TreeNode;
          const value = element.childForFieldName('value') as TreeNode;
          const selected = this.destructuredKey(key, type, defaultedTarget(value) !== undefined);
          this.bindPattern(
            value,
            selected.type,
            bind,
            options,
            this.defaultPropertySource(type, selected.type, selected.names)
          );
          used.push(selected.keyType);
          break;
        }
        case 'rest_pattern': {
          const target = named(element)[0];
          if (target) bind(target, this.declaredRestObject(target, type, used));
          break;
        }
        default: {
          break;
        }
      }
    }
  }

  private defaultPropertySource(object: Type, property: Type, names?: string[]): Type | undefined {
    if (!isIntrinsic(property, 'undefined')) return undefined;
    const name = names?.length === 1 ? names[0] : undefined;
    if (name !== undefined && (this.c.propertyOf(object, name) || this.c.members.indexSignatureType(object, name)))
      return undefined;
    // TypeScript uses the declared binding type when the source lacks the property entirely.
    return errorType;
  }

  destructuredKey(
    key: TreeNode,
    objectType: Type,
    allowMissing: boolean,
    computedType?: Type
  ): { type: Type; keyType: Type; names?: string[] } {
    const selection = this.patternKey(key, computedType);
    this.selectedKeys.set(key.id, selection.names);
    const namedTypes = selection.names?.map((name) => this.destructuredProperty(key, objectType, name, allowMissing));
    const type =
      namedTypes && !this.c.relations.isGeneric(selection.type)
        ? unionOf(namedTypes, true)
        : this.c.members.indexedType(key, key, selection.node, objectType, selection.type);
    return { type, keyType: selection.type, names: selection.names };
  }

  propertyNames(key: TreeNode): string[] | undefined {
    return this.selectedKeys.has(key.id) ? this.selectedKeys.get(key.id) : this.capturePropertyNames(key);
  }

  capturePropertyNames(key: TreeNode): string[] | undefined {
    const selection = this.capturePropertyKey(key);
    return selection.names;
  }

  capturePropertyKey(key: TreeNode): { type: Type; names?: string[] } {
    const selection = this.c.flow.probe(() => this.patternKey(key));
    this.selectedKeys.set(key.id, selection.names);
    return selection;
  }

  private patternKey(key: TreeNode, computedType?: Type): { node: TreeNode; type: Type; names?: string[] } {
    if (key.type !== 'computed_property_name') {
      const name = propertyNameText(key);
      return {
        node: key,
        type: name === undefined ? anyType : literalType(key.type === 'number' ? numberValue(key.text) : name),
        names: name === undefined ? undefined : [name],
      };
    }
    const node = named(key)[0];
    const type = computedType ?? this.c.expressions.check(node);
    const constraint = this.c.baseConstraint(type);
    const members = constraint.kind === 'union' ? constraint.types : [constraint];
    const names: string[] = [];
    for (const member of members) {
      if (!isPropertyKeyLiteral(member)) return { node, type };
      names.push(String(member.value));
    }
    return { node, type, names };
  }

  /**
   * Reports a value that an object pattern without elements cannot take apart, which no property access checks: as
   * TypeScript does, a value that may be `null`, `undefined`, or `void`, or one of type `unknown`.
   */
  private checkEmptyObjectSource(pattern: TreeNode, type: Type): void {
    const rest = this.c.members.checkNonNullable(pattern, type);
    if (isIntrinsic(rest, 'void')) this.c.error(pattern, "オブジェクトは 'undefined' の可能性があります。");
  }

  /** The type of a declaration's object rest element, which TypeScript makes only from a value that may be an object. */
  private declaredRestObject(target: TreeNode, type: Type, omitted: Type[]): Type {
    if (!this.isValidSpreadType(type)) {
      this.c.error(target, '残余要素の型は、オブジェクト型からしか作れません。');
      return errorType;
    }
    return this.restObject(type, omitted);
  }

  /**
   * As TypeScript's `isValidSpreadType`: whether a type is an object, or a type parameter that may be one, once its
   * falsy members are left out.
   */
  isValidSpreadType(type: Type): boolean {
    const members = (type.kind === 'union' ? type.types : [type])
      .flatMap((member) => {
        // An unconstrained type parameter may be an object, unlike `unknown`, which its base constraint is.
        const constraint =
          member.kind === 'typeParameter' && !this.c.constraintOf(member) ? member : this.c.baseConstraint(member);
        return constraint.kind === 'union' ? constraint.types : [constraint];
      })
      .filter((member) => !isDefinitelyFalsy(member));
    if (members.length !== 1) return members.length > 0 && members.every((member) => this.isValidSpreadType(member));
    const [member] = members;
    if (member.kind === 'intersection') return member.types.every((part) => this.isValidSpreadType(part));
    return (
      isAnyLike(member) ||
      isIntrinsic(member, 'object') ||
      !['intrinsic', 'literal', 'templateLiteral', 'stringMapping', 'keyof'].includes(member.kind)
    );
  }

  restObject(type: Type, omitted: Type[]): Type {
    const object = this.c.relations.removeNullish(type);
    if (object.kind === 'union') return unionOf(object.types.map((member) => this.restObject(member, omitted)));
    if (this.c.relations.isGeneric(object) || omitted.some((key) => this.c.relations.isGeneric(key)))
      return this.genericRestObject(object, omitted);
    return anonymousObject(() => {
      const structure = emptyStructure();
      const source = this.c.structureOf(object);
      structure.stringIndex = source.stringIndex;
      structure.numberIndex = source.numberIndex;
      structure.symbolIndex = source.symbolIndex;
      structure.patternIndexes = source.patternIndexes;
      for (const [name, property] of source.properties) {
        const selected = omitted.some((key) =>
          this.c.relations.isAssignable(this.c.typeOperators.propertyKeyType(property), key)
        );
        if (!selected && isSpreadableProperty(property)) structure.properties.set(name, spreadCopy(property, false));
      }
      return structure;
    });
  }

  private genericRestObject(source: Type, omitted: Type[]): Type {
    const unspreadable = [...this.c.structureOf(source).properties.values()]
      .filter((property) => !isSpreadableProperty(property))
      .map((property) => this.c.typeOperators.propertyKeyType(property));
    const excluded = unionOf([...omitted, ...unspreadable]);
    if (isIntrinsic(excluded, 'never')) return source;
    const omit = this.c.libraryBinder.moduleScope.lookupType('Omit');
    assert.ok(omit);
    const parameters = this.c.signatures.typeParametersOfSymbol(omit);
    const arguments_ = [source, excluded];
    return this.c.instantiate(
      this.c.typeNodes.declaredTypeOf(omit),
      new Map(parameters.map((parameter, index) => [parameter.id, arguments_[index]]))
    );
  }

  destructuredProperty(node: TreeNode, type: Type, name: string, allowMissing = false): Type {
    if (isAnyLike(type)) return anyType;
    // As an element access does, any property of `never` is `never`.
    if (isIntrinsic(type, 'never')) return neverType;
    const united = type.kind === 'union' ? this.unionDestructuredProperty(node, type, name, allowMissing) : undefined;
    if (united) return united;
    const property = this.c.propertyOf(type, name);
    if (!property) {
      const indexType = this.c.members.indexSignatureType(type, name);
      if (indexType) return indexType;
      if (allowMissing && type.kind === 'object' && type.fresh) return undefinedType;
      this.c.error(node, `プロパティ '${name}' は型 '${this.c.print(type)}' にありません。`);
      return errorType;
    }
    this.c.members.checkPropertyUse(node, node, node, type, property);
    return propertyAccessType(property, 'read', true);
  }

  /** The union of a property's types when each member of a union has it, or `undefined` when one lacks it. */
  private unionDestructuredProperty(
    node: TreeNode,
    type: UnionType,
    name: string,
    allowMissing: boolean
  ): Type | undefined {
    const types = type.types.map((member) =>
      this.c.silently(() => this.destructuredProperty(node, member, name, allowMissing))
    );
    if (types.includes(errorType)) return undefined;
    for (const member of type.types) {
      const property = this.c.propertyOf(member, name);
      if (property) this.c.members.checkPropertyUse(node, node, node, type, property);
    }
    return unionOf(types, true);
  }

  private bindArrayPattern(pattern: TreeNode, type: Type, bind: Bind, options: BindingOptions): void {
    if (isEmptyPattern(pattern)) this.iteratedType(pattern, type);
    for (const { element, index } of arrayPatternElements(pattern)) {
      if (element.type === 'rest_pattern') {
        const target = named(element)[0];
        if (target) this.bindPattern(target, this.restOfIterable(pattern, type, index, true), bind, options);
        break;
      }
      this.bindPattern(element, this.elementAt(element, type, index), bind, options);
    }
  }

  elementAt(node: TreeNode, type: Type, index: number): Type {
    type = this.arrayPatternSource(type);
    if (isAnyLike(type)) return anyType;
    if (isTuple(type)) return this.tupleElementAt(node, type, index);
    if (type.kind === 'union' && type.types.some(isTuple)) return this.unionElementAt(node, type, index);
    return this.iteratedType(node, type);
  }

  /**
   * As TypeScript's indexed access of a union: each member's element at the position, where a tuple too short gives
   * `undefined` among tuples and its elements among arrays. A position no tuple of a union of tuples reaches is missing.
   */
  private unionElementAt(node: TreeNode, type: UnionType, index: number): Type {
    const reaches = (member: ObjectType): boolean =>
      (member.tuple?.elements ?? []).some((element, position) => element.rest || position === index);
    const allTuples = type.types.every(isTuple);
    if (allTuples && !type.types.some((member) => reaches(member as ObjectType))) {
      if (defaultedTarget(node)) return undefinedType;
      this.c.error(node, `プロパティ '${index}' は型 '${this.c.print(type)}' にありません。`);
      return errorType;
    }
    return unionOf(
      type.types.map((member) => {
        if (!isTuple(member) || reaches(member)) return this.elementAt(node, member, index);
        return allTuples ? undefinedType : this.iteratedType(node, member);
      }),
      true
    );
  }

  private tupleElementAt(node: TreeNode, type: ObjectType, index: number): Type {
    const elements = type.tuple?.elements ?? [];
    const restIndex = elements.findIndex((member) => member.rest);
    // At or past a rest element, any of the rest's values or the elements after it may take the position.
    if (restIndex !== -1 && index >= restIndex) return tupleSliceReadType(this.c, elements, restIndex);
    const element = elements[index];
    if (element) return tupleElementReadType(this.c, element);
    // An element with a default, as in `const [a = 1] = []`, takes the default where the tuple ends.
    if (defaultedTarget(node)) return undefinedType;
    this.c.error(
      node,
      `長さ ${elements.length} のタプル型 '${this.c.print(type)}' には、インデックス ${index} の要素がありません。`
    );
    return errorType;
  }

  restOfIterable(pattern: TreeNode, type: Type, from: number, binding = false): Type {
    const source = binding ? this.arrayPatternSource(type) : type;
    if (source.kind === 'union' && source.types.every(isTuple))
      return unionOf(source.types.map((member) => this.sliceTuple(member, from)));
    return isTuple(source) ? this.sliceTuple(source, from) : this.c.arrayType(this.iteratedType(pattern, type));
  }

  private sliceTuple(type: ObjectType, from: number): Type {
    const elements = type.tuple?.elements ?? [];
    const restIndex = elements.findIndex((member) => member.rest);
    if (restIndex !== -1 && from > restIndex) return this.c.arrayType(tupleSliceReadType(this.c, elements, restIndex));
    return this.c.tupleType(elements.slice(from));
  }

  private arrayPatternSource(type: Type): Type {
    if (type.kind === 'union') return unionOf(type.types.map((member) => this.arrayPatternSource(member)));
    if (type.kind !== 'typeParameter') return type;
    const constraint = this.c.constraintOf(type);
    return constraint ? this.arrayPatternSource(constraint) : type;
  }

  /** The type of the elements a `for...of` loop or a spread takes from a value. */
  iteratedType(node: TreeNode | undefined, type: Type): Type {
    if (isAnyLike(type)) return anyType;
    if (type.kind === 'union')
      return unionOf(
        type.types.map((member) => this.iteratedType(node, member)),
        true
      );
    if (type.kind === 'object' && this.c.isArrayOrTuple(type)) return this.c.elementTypeOf(type);
    const bound = this.iterableConstraint(type);
    if (bound) return this.iteratedType(node, bound);
    if (
      isIntrinsic(type, 'string') ||
      (type.kind === 'literal' && typeof type.value === 'string') ||
      type.kind === 'templateLiteral'
    )
      return stringType;
    const iterator = this.c.propertyOf(type, this.c.typeNodes.librarySymbolKey('iterator'));
    const iteratorType = iterator && this.c.signaturesOf(iterator.type(), 'call')[0]?.returnType();
    if (iteratorType?.kind === 'object' && iteratorType.typeArguments?.[0]) return iteratorType.typeArguments[0];
    if (type.kind === 'typeParameter') {
      const constraint = this.c.constraintOf(type);
      if (constraint) return this.iteratedType(node, constraint);
    }
    if (node)
      this.c.error(node, `型 '${this.c.print(type)}' には、反復処理に使う [Symbol.iterator]() メソッドがありません。`);
    return errorType;
  }

  private iterableConstraint(type: Type): Type | undefined {
    if (type.kind !== 'conditional' && type.kind !== 'indexedAccess') return undefined;
    const bound = this.c.apparentType(type);
    return bound.kind === 'union' || (bound.kind === 'object' && this.c.isArrayOrTuple(bound)) ? bound : undefined;
  }
}

/** The target of an element with a default, as `a` in `a = 1`. */
export function defaultedTarget(element: TreeNode): TreeNode | undefined {
  return ['assignment_expression', 'assignment_pattern', 'object_assignment_pattern'].includes(element.type)
    ? (element.childForFieldName('left') ?? undefined)
    : undefined;
}

function isTuple(type: Type): type is ObjectType {
  return type.kind === 'object' && type.objectKind === 'tuple';
}

/** Whether a binding or assignment pattern takes nothing apart, as `{}` or `[, ]`, so that no element checks its source. */
export function isEmptyPattern(pattern: TreeNode): boolean {
  return named(pattern).every((element) => element.type === 'comment');
}
