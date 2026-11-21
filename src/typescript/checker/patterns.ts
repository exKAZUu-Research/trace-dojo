import assert from 'node:assert/strict';

import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { functionLikeTypes } from './binder';
import {
  defaultedTarget,
  impliedPatternType,
  inferredPatternParameterType,
  padParameterInitializer,
} from './bindingPatternTypes';
import type { Checker } from './checker';
import { isDefinitelyFalsy, isSpreadableProperty, spreadCopy } from './literals';
import type { Sym } from './scopes';
import { arrayPatternElements, isImmediatelyInvoked, named, numberValue, propertyNameText } from './syntax';
import { tupleElementReadType, tupleSliceReadType } from './tupleIndexes';
import {
  anonymousObject,
  anyType,
  emptyStructure,
  errorType,
  isAnyLike,
  isIntrinsic,
  isPropertyKeyLiteral,
  literalType,
  mapType,
  neverType,
  type ObjectType,
  propertyAccessType,
  regularOf,
  stringType,
  type Type,
  typeMembers,
  undefinedType,
  unionOf,
  type UnionType,
} from './types';

export { defaultedTarget } from './bindingPatternTypes';

interface BindingOptions {
  annotated?: boolean;
  isConst?: boolean;
  literalSource?: TreeNode;
  parameter?: boolean;
}

type Bind = (identifier: TreeNode, type: Type, assigned?: Type) => void;

/** Gives the names a binding pattern declares the types of what it destructures. */
export class BindingPatterns {
  readonly correlatedSources = new Map<number, Type>();
  readonly initializerContexts = new WeakSet<Type>();
  private readonly selectedKeys = new Map<number, string[] | undefined>();
  private readonly inferredParameters = new Set<number>();
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
          options,
          assigned
        );
        return;
      }
      case 'array_pattern': {
        this.bindArrayPattern(pattern, type, bind, options, assigned);
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
    const contextual = options.annotated ? type : this.impliedBindingType(left, options.isConst, options.parameter);
    const initialDefault = this.initializerType(right, contextual, true);
    const defaultType = options.parameter ? padParameterInitializer(this.c, left, initialDefault) : initialDefault;
    const withoutUndefined = this.c.relations.removeUndefined(type);
    const initial =
      assigned === errorType
        ? errorType
        : unionOf([this.c.relations.removeUndefined(assigned ?? type), initialDefault], true);
    if (options.annotated && !isIntrinsic(withoutUndefined, 'never')) {
      const declared = this.defaultMayBeUndefined(defaultType) ? type : withoutUndefined;
      this.c.expressions.checkAssignable(right, defaultType, declared);
      this.bindPattern(left, declared, bind, options, initial);
      return;
    }
    const declaredDefault = mapType(defaultType, (member) => {
      const regular = regularOf(member);
      return member.kind === 'literal' && typeMembers(withoutUndefined).includes(regular) ? regular : member;
    });
    const combined = unionOf([withoutUndefined, declaredDefault], true);
    const declared =
      options.isConst || left.type === 'object_pattern' || left.type === 'array_pattern'
        ? combined
        : this.c.widen(combined);
    this.bindPattern(left, declared, bind, options, initial);
  }

  initializerType(value: TreeNode, contextual?: Type, bindingDefault = false): Type {
    const skipped = this.c.flow.current;
    let type: Type = anyType;
    const initialized = this.c.flow.from(skipped, () => {
      type = bindingDefault
        ? this.c.expressions.checkAssignedValue(value, contextual)
        : this.c.expressions.check(value, contextual);
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
   * The type a binding or assignment pattern implies for the value it takes apart, which an initializer or a right side
   * takes as its contextual type. `leafType` gives the type of an element that is not a pattern, with or without default.
   */
  impliedType(pattern: TreeNode, leafType: (element: TreeNode) => Type): Type | undefined {
    return impliedPatternType(this.c, pattern, leafType);
  }

  inferredParameterType(parameter: TreeNode, pattern: TreeNode): Type {
    if (this.c.silent === 0) this.inferredParameters.add(parameter.id);
    return inferredPatternParameterType(this.c, pattern);
  }

  reportImplicitAny(element: TreeNode): void {
    this.c.error(element, `分割代入の要素 ${element.text} の型が暗黙に any になります。型を書いてください。`);
  }

  checkParameterDefaultRead(reference: TreeNode, symbol: Sym): void {
    const parameter = symbol.valueDeclaration;
    if (!parameter || !this.inferredParameters.has(parameter.id) || reference.startIndex >= parameter.endIndex) return;
    let child = reference;
    for (let parent = reference.parent; parent && parent.id !== parameter.id; child = parent, parent = parent.parent) {
      if (
        parent.startIndex < parameter.startIndex ||
        (functionLikeTypes.has(parent.type) && !isImmediatelyInvoked(parent))
      )
        return;
      if (!defaultedTarget(parent) || parent.childForFieldName('right')?.id !== child.id) continue;
      const declaration = symbol.valueEntries[0]?.name;
      if (declaration)
        this.c.error(
          declaration,
          `変数 ${symbol.name} は型注釈がなく、初期値で参照されるため、型が暗黙に any になります。`
        );
      return;
    }
  }

  impliedBindingType(pattern: TreeNode, isConst = false, parameter = false): Type | undefined {
    return impliedPatternType(this.c, pattern, () => anyType, { isConst, parameter });
  }

  parameterInitializerType(pattern: TreeNode, value: Type): Type {
    return padParameterInitializer(this.c, pattern, value);
  }

  private bindObjectPattern(pattern: TreeNode, type: Type, bind: Bind, options: BindingOptions, assigned?: Type): void {
    if (isEmptyPattern(pattern)) this.checkEmptyObjectSource(pattern, type);
    const used: Type[] = [];
    for (const element of named(pattern)) {
      switch (element.type) {
        case 'shorthand_property_identifier_pattern': {
          used.push(literalType(element.text));
          bind(
            element,
            this.destructuredProperty(element, type, element.text),
            assigned && this.flowProperty(assigned, element.text)
          );
          break;
        }
        case 'object_assignment_pattern': {
          const left = element.childForFieldName('left') as TreeNode;
          used.push(literalType(left.text));
          const propertyType = this.destructuredProperty(left, type, left.text, true);
          this.bindPattern(element, propertyType, bind, options, this.flowProperty(assigned ?? type, left.text));
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
            this.selectedFlowProperty(assigned, type, selected.keyType, defaultedTarget(value) !== undefined)
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

  private selectedFlowProperty(
    assigned: Type | undefined,
    type: Type,
    key: Type,
    defaulted: boolean
  ): Type | undefined {
    if (!assigned && !defaulted) return undefined;
    return isPropertyKeyLiteral(key) ? this.flowProperty(assigned ?? type, String(key.value)) : errorType;
  }

  private flowProperty(object: Type, name: string): Type {
    if (isAnyLike(object)) return object;
    const property = this.c.propertyOf(object, name);
    if (property) return propertyAccessType(property, 'read', true);
    // TypeScript uses the declared binding type when the source lacks the property entirely.
    return this.c.members.indexSignatureType(object, name) ?? errorType;
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
    const properties = type.types.map((member) => this.c.propertyOf(member, name));
    const hasProperty = properties.some(Boolean);
    const emptyLiteral =
      allowMissing &&
      type.types.every(
        (member) => member.kind === 'object' && member.fresh && this.c.relations.isEmptyObjectType(member)
      );
    const types = type.types.map((member) => {
      const mayOmit = emptyLiteral || (hasProperty && member.kind === 'object' && !member.hasSpread);
      return this.c.silently(() => this.destructuredProperty(node, member, name, mayOmit));
    });
    if (types.includes(errorType)) return undefined;
    for (const property of properties) {
      if (property) this.c.members.checkPropertyUse(node, node, node, type, property);
    }
    return unionOf(types, true);
  }

  private bindArrayPattern(pattern: TreeNode, type: Type, bind: Bind, options: BindingOptions, assigned?: Type): void {
    if (isEmptyPattern(pattern)) this.iteratedType(pattern, type);
    for (const { element, index } of arrayPatternElements(pattern)) {
      if (element.type === 'rest_pattern') {
        const target = named(element)[0];
        if (target) this.bindPattern(target, this.restOfIterable(pattern, type, index, true), bind, options);
        break;
      }
      const initial = assigned && this.c.silently(() => this.elementAt(element, assigned, index));
      this.bindPattern(element, this.elementAt(element, type, index), bind, options, initial);
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

function isTuple(type: Type): type is ObjectType {
  return type.kind === 'object' && type.objectKind === 'tuple';
}

/** Whether a binding or assignment pattern takes nothing apart, as `{}` or `[, ]`, so that no element checks its source. */
export function isEmptyPattern(pattern: TreeNode): boolean {
  return named(pattern).every((element) => element.type === 'comment');
}
