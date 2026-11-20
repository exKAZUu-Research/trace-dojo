// code-gauge-allow-file fileNcss 401 -- Shares member and element resolution across reads, writes, and optional chains.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import {
  legacyRegExpStaticsFeature,
  unavailableRegExpStatics,
  unavailableWellKnownSymbols,
} from '../../javascript/unavailableMembers';
import { assertedExpression, assertionTypes, isErasedTypeSyntax } from '../erasedSyntax';
import { unsupportedMessage } from '../unsupported';
import type { Checker } from './checker';
import type { State } from './flow';
import { applicableIndex } from './indexInfos';
import { nonNullableType, nullishConstraint } from './nullishConstraints';
import { defaultedTarget } from './patterns';
import { printedPropertyName } from './print';
import { spellingSuggestion } from './spelling';
import { assignmentKind, chainObject, isOptionalChain, skipParentheses } from './syntax';
import { tupleElementBeyond } from './tupleIndexes';
import {
  errorType,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  isPropertyKeyLiteral,
  literalType,
  neverType,
  numberType,
  type Property,
  propertyAccessType,
  regularOf,
  stringType,
  symbolType,
  type Type,
  undefinedType,
  unionOf,
  type UnionType,
} from './types';

/** The nodes of an element access, where its errors are reported. */
interface IndexAccess {
  node: TreeNode;
  objectNode: TreeNode;
  indexNode: TreeNode;
  write?: boolean;
}

interface IndexAccessOptions {
  readsField?: boolean;
  write?: boolean;
}

interface CheckedAccess {
  type: Type;
  receiver?: Type;
  index?: Type;
}

interface PropertyAccessOptions {
  write?: boolean;
  receiver?: Type;
}

/** Checks property and element accesses. */
export class MemberChecker {
  /**
   * The types of the accesses and calls of optional chains without the `undefined` that stopping early adds, which
   * the rest of the chain continues from.
   */
  private readonly continuedTypes = new Map<number, Type>();

  /** For each optional chain being checked, its end and the flow states where its `?.` links stop it. */
  private readonly chainFrames: { end: TreeNode; stops: State[] }[] = [];

  constructor(private readonly c: Checker) {}

  /** Checks a link of a chain, which joins where the chain's `?.` links stop it when it is the chain's end. */
  chainLink<T>(node: TreeNode, check: () => T): T {
    this.continuedTypes.delete(node.id);
    if (this.chainFrames.at(-1)?.end.id === node.id) return check();
    const start = this.c.flow.current;
    const { result, stops } = this.stoppingChain(node, check);
    if (stops.length > 0) this.c.flow.rejoin(start, stops);
    return result;
  }

  /** Checks `condition` on `node`, which is false where `node`'s optional chain stops early. */
  chainCondition<T extends { whenFalse: State }>(node: TreeNode, condition: () => T): T {
    const start = this.c.flow.current;
    const { result, stops } = this.stoppingChain(node, condition);
    if (stops.length === 0) return result;
    this.c.flow.rejoin(start, stops);
    return { ...result, whenFalse: this.c.flow.merge([result.whenFalse, ...stops]) };
  }

  /**
   * Runs `run`, which checks `node`, returning rather than joining the flow states where `node`'s optional chain stops
   * early, since a condition or `??` testing the chain routes them to its own false or right-operand path as tsc does.
   */
  stoppingChain<T>(node: TreeNode, run: () => T): { result: T; stops: State[] } {
    if (chainEnd(node).id !== node.id || !isOptionalChain(node)) return { result: run(), stops: [] };
    const frame = { end: node, stops: [] as State[] };
    this.chainFrames.push(frame);
    try {
      return { result: run(), stops: frame.stops };
    } finally {
      this.chainFrames.pop();
    }
  }

  /**
   * Continues an optional chain past the `?.` after `object` only where `object` is neither `null` nor `undefined`,
   * which the rest of the chain, its indices and arguments included, runs in.
   */
  continueChain(object: TreeNode): void {
    const frame = this.chainFrames.at(-1);
    if (frame?.end.id !== chainEnd(object).id) return;
    const { whenTrue, whenFalse } = this.c.conditions.presence(object);
    frame.stops.push(whenFalse);
    this.c.flow.current = whenTrue;
  }

  /** Records what an optional chain continues from after `node`, returning `node`'s own type with `undefined`. */
  chainResult(node: TreeNode, continued: Type): Type {
    this.continuedTypes.set(node.id, continued);
    return unionOf([continued, undefinedType]);
  }

  /** The type of an object that continues an optional chain, which is never what stopping the chain gave. */
  continuedObjectType(objectNode: TreeNode, checked: Type): Type | undefined {
    const continued = this.continuedTypes.get(objectNode.id);
    return continued && unionOf([continued, undefinedType]) === checked ? continued : undefined;
  }

  checkAccess(node: TreeNode): CheckedAccess {
    return this.chainLink(node, () => this.evaluateAccess(node));
  }

  private evaluateAccess(node: TreeNode): CheckedAccess {
    const objectNode = node.childForFieldName('object') as TreeNode;
    if (node.type === 'subscript_expression') return this.elementAccess(node, objectNode);
    const propertyNode = node.childForFieldName('property') as TreeNode;
    const name = propertyNode.text;
    const { type: receiver, shortCircuits } = this.readReceiver(node, objectNode);
    const declared = this.propertyAccess(node, objectNode, propertyNode, receiver, name);
    const type = this.narrowedReference(node, declared);
    return this.checkedAccess(node, type, receiver, shortCircuits);
  }

  private checkedAccess(
    node: TreeNode,
    type: Type,
    receiver: Type,
    shortCircuits: boolean,
    index?: Type
  ): CheckedAccess {
    return { type: shortCircuits ? this.chainResult(node, type) : type, receiver, index };
  }

  private readReceiver(node: TreeNode, object: TreeNode): { type: Type; shortCircuits: boolean } {
    if (object.type === 'super') return { type: this.c.classes.superType(node), shortCircuits: false };
    const checked = this.c.expressions.check(object);
    const optional = node.childForFieldName('optional_chain') !== null;
    if (optional) this.continueChain(object);
    const continued = this.continuedObjectType(object, checked);
    const receiver = continued ?? checked;
    const type = optional ? nonNullableType(this.c, receiver) : this.checkNonNullable(object, receiver);
    return {
      type,
      shortCircuits: continued !== undefined || (optional && type !== receiver),
    };
  }

  private narrowedReference(node: TreeNode, declared: Type | (() => Type)): Type {
    const key = this.c.flow.referenceKey(node);
    const entry = key ? this.c.flow.entry(key) : undefined;
    if (entry && !this.c.expressions.isAssignmentTarget(node))
      return flowReferenceType(this.c, node, entry.type, declared);
    return typeof declared === 'function' ? declared() : declared;
  }

  /** Reports an object that may be `null`, `undefined`, or `unknown` where a member is used, returning the rest. */
  // code-gauge-allow functionCognitiveComplexity 21 -- Reports each nullish case with the message TypeScript gives it.
  checkNonNullable(node: TreeNode, type: Type): Type {
    if (isIntrinsic(type, 'unknown')) {
      this.c.error(
        node,
        this.isEntityName(node) ? `'${node.text}' の型は 'unknown' です。` : "オブジェクトの型は 'unknown' です。"
      );
      return errorType;
    }
    if (isAnyLike(type)) return type;
    const bound = nullishConstraint(this.c, type);
    const members = bound.kind === 'union' ? bound.types : [bound];
    const hasNull = members.some((member) => isIntrinsic(member, 'null'));
    const hasUndefined = members.some((member) => isIntrinsic(member, 'undefined'));
    // TypeScript reports a member of `void` as missing on the type, which the member's own check does.
    if (!hasNull && !hasUndefined) return type;
    // `void` stays, as in TypeScript, whose operators then reject it.
    const rest = nonNullableType(this.c, type, true);
    const literal = skipParentheses(node).type;
    if (isIntrinsic(rest, 'never') && (literal === 'null' || literal === 'undefined')) {
      this.c.error(node, `値 '${hasNull ? 'null' : 'undefined'}' はここでは使えません。`);
      return errorType;
    }
    const what = hasNull && hasUndefined ? "'null' か 'undefined'" : hasNull ? "'null'" : "'undefined'";
    this.c.error(
      node,
      this.isEntityName(node)
        ? `'${node.text}' は ${what} の可能性があります。`
        : `オブジェクトは ${what} の可能性があります。`
    );
    // Nothing is left to use when the value can only be `null` or `undefined`.
    return isIntrinsic(rest, 'never') ? errorType : rest;
  }

  isEntityName(node: TreeNode): boolean {
    const expression = skipParentheses(node);
    if (expression.type === 'identifier' || expression.type === 'this') return true;
    if (expression.type === 'member_expression') {
      const object = expression.childForFieldName('object');
      return !!object && !expression.childForFieldName('optional_chain') && this.isEntityName(object);
    }
    return false;
  }

  /** The type of `object.name`, reporting a missing or inaccessible property. */
  propertyAccess(
    node: TreeNode,
    objectNode: TreeNode,
    propertyNode: TreeNode,
    objectType: Type,
    name: string,
    options: PropertyAccessOptions = {}
  ): Type {
    const receiver = options.receiver ?? objectType;
    objectType = this.c.reducedTypes.of(objectType);
    if (isAnyLike(objectType)) return objectType;
    const isPrivate = propertyNode.type === 'private_property_identifier';
    if (!isPrivate && objectType.kind === 'union')
      return this.unionPropertyAccess(node, objectNode, propertyNode, objectType, name, { ...options, receiver });
    const property = isPrivate
      ? this.c.classes.privateProperty(node, propertyNode, objectType)
      : this.c.propertyOf(objectType, name);
    this.c.conditions.recordPropertyDeclaration(node, property?.declaration);
    if (!property) {
      if (isPrivate) return errorType;
      const index = this.indexSignatureType(objectType, name);
      if (index) return index;
      this.reportMissingProperty(propertyNode, name, objectType);
      return errorType;
    }
    return this.checkPropertyUse(node, objectNode, propertyNode, receiver, property, options.write)
      ? propertyAccessType(property)
      : errorType;
  }

  private unionPropertyAccess(
    node: TreeNode,
    objectNode: TreeNode,
    propertyNode: TreeNode,
    objectType: UnionType,
    name: string,
    options: PropertyAccessOptions
  ): Type {
    if (objectType.types.some((member) => this.c.propertyOf(member, name))) {
      if (!objectType.types.some((member) => this.lacksProperty(member, name)))
        return unionOf(
          objectType.types.map((member) => this.propertyAccess(node, objectNode, propertyNode, member, name, options)),
          true
        );
    } else {
      const index = this.indexSignatureType(objectType, name);
      if (index) return index;
    }
    const suggestion = this.suggestProperty(objectType, name);
    this.c.error(
      propertyNode,
      `プロパティ '${name}' は型 '${this.c.print(objectType)}' にありません。${suggestion ? `'${suggestion}' のことですか？` : ''}`
    );
    return errorType;
  }

  checkPropertyUse(
    node: TreeNode,
    objectNode: TreeNode,
    propertyNode: TreeNode,
    objectType: Type,
    property: Property,
    isWrite = false
  ): boolean {
    this.c.classes.checkPropertyAccessibility(
      node,
      propertyNode,
      { node: objectNode, type: objectType },
      property,
      isWrite
    );
    this.c.classes.checkInitializedBefore(node, objectNode, property);
    if (!isWrite || assignmentKind(node) === 'compound')
      this.c.classDeclarations.checkFieldRead(node, objectNode, propertyNode, property);
    this.c.expressions.expandos.checkAssignedBefore(node, propertyNode, property);
    return this.checkPropertyAvailability(propertyNode, objectType, property);
  }

  private checkPropertyAvailability(propertyNode: TreeNode, objectType: Type, property: Property): boolean {
    for (const origin of new Set([property, ...this.propertyOrigins(objectType, property.name)])) {
      const unsupported = this.unsupportedLibraryMember(propertyNode, origin);
      if (!unsupported) continue;
      this.c.error(propertyNode, unsupportedMessage(unsupported));
      return false;
    }
    return true;
  }

  /**
   * The properties a member of a type may read at run time, of each member of a union or an intersection and of a type
   * parameter's constraint, as the property merged from them keeps the declaration of only one.
   */
  private propertyOrigins(type: Type, name: string): Property[] {
    this.c.budget.spend();
    if (type.kind === 'union' || type.kind === 'intersection')
      return type.types.flatMap((member) => this.propertyOrigins(member, name));
    if (type.kind === 'typeParameter') {
      const apparent = this.c.apparentType(type);
      return apparent === type ? [] : this.propertyOrigins(apparent, name);
    }
    const property = type.kind === 'object' ? this.c.propertyOf(type, name) : undefined;
    return property ? [property] : [];
  }

  /** A member the library declares that this interpreter does not provide, named by the interface declaring it. */
  private unsupportedLibraryMember(propertyNode: TreeNode, property: Property): string | undefined {
    const declaration = property.declaration;
    if (!declaration || !this.c.isLibrary(declaration)) return undefined;
    const owner = declaration.parent?.parent?.childForFieldName('name')?.text;
    const { name } = property;
    // The well-known symbols replace the protocols of the language, which this interpreter does not support yet.
    if (owner === 'SymbolConstructor' && unavailableWellKnownSymbols.has(name) && !this.isTypeOnlyUse(propertyNode))
      return `Symbol.${name} などの well-known シンボル`;
    // A stack trace names the files and lines of the host, which differ from the program's.
    if (owner === 'Error' && name === 'stack') return 'Error の stack';
    if (owner === 'ArrayConstructor' && name === 'fromAsync') return 'Array.fromAsync';
    if (owner === 'RegExpConstructor' && unavailableRegExpStatics.has(name)) return legacyRegExpStaticsFeature;
    // Node.js shows a function's source as tsx's esbuild printed it, which this interpreter does not reproduce.
    if (owner === 'Function' && name === 'toString' && !this.isNeverCalled(propertyNode))
      return '関数やクラスの文字列への変換';
    return undefined;
  }

  private isNeverCalled(property: TreeNode): boolean {
    const read = property.parent;
    if (isOnlyCompared(read)) return true;
    if (this.isTypeOnlyUse(property)) return true;
    const binding = propertyBinding(property) ?? initializerBinding(read);
    return !!binding && this.isOnlyComparedBinding(binding);
  }

  private isTypeOnlyUse(property: TreeNode): boolean {
    for (let ancestor = property.parent; ancestor; ancestor = ancestor.parent) {
      this.c.budget.spend();
      if (isErasedTypeSyntax(ancestor.type)) return true;
    }
    return false;
  }

  private isOnlyComparedBinding(binding: TreeNode): boolean {
    const name = binding.text;
    const symbol = this.c.binder.lookupValue(binding, name);
    if (!symbol) return false;
    const declarations = new Set(symbol.valueEntries.map((entry) => entry.name.id));
    if (!declarations.has(binding.id)) return false;
    // Redeclaring a simple parameter can expose the value through `arguments` in a non-strict function.
    if (declarations.size > 1 && symbol.valueKind === 'parameter') return false;
    const scope = symbol.scope.kind === 'module' ? this.c.root : (symbol.scope.node ?? this.c.root);
    const visitsOnlyComparisons = (node: TreeNode): boolean => {
      this.c.budget.spend();
      if (isErasedTypeSyntax(node.type)) return true;
      if (assertionTypes.has(node.type)) {
        const expression = assertedExpression(node);
        return !expression || visitsOnlyComparisons(expression);
      }
      if (
        !declarations.has(node.id) &&
        isValueName(node, name) &&
        !isOnlyCompared(node) &&
        this.c.binder.lookupValue(node, name) === symbol
      )
        return false;
      return node.namedChildren.every((child) => child === null || visitsOnlyComparisons(child));
    };
    return visitsOnlyComparisons(scope);
  }

  indexSignatureType(type: Type, name: string): Type | undefined {
    return applicableIndex(this.c, this.c.structureOf(type), literalType(name))?.type;
  }

  private lacksProperty(member: Type, name: string): boolean {
    return (
      !isAnyLike(member) &&
      member.kind !== 'union' &&
      !this.c.propertyOf(member, name) &&
      !this.indexSignatureType(member, name)
    );
  }

  private reportMissingProperty(node: TreeNode, name: string, type: Type): void {
    const apparent = this.c.apparentType(type);
    const classInfo = apparent.kind === 'object' ? (apparent.classInfo ?? apparent.target?.classInfo) : undefined;
    if (
      classInfo &&
      apparent.kind === 'object' &&
      !apparent.isClassStatic &&
      classInfo.staticType.resolve().properties.has(name)
    ) {
      this.c.error(
        node,
        `プロパティ '${name}' は型 '${this.c.print(type)}' にありません。静的メンバー '${classInfo.name}.${name}' のことですか？`
      );
      return;
    }
    // TypeScript names the union a generic type's apparent type is, as `string | number` for `T extends string | number`.
    const shown = apparent.kind === 'union' ? apparent : type;
    const suggestion = this.suggestProperty(shown, name);
    this.c.error(
      node,
      `プロパティ '${name}' は型 '${this.c.print(shown)}' にありません。${suggestion ? `'${suggestion}' のことですか？` : ''}`
    );
  }

  /** A property of the type, or of a primitive's wrapper, as `length` of a string, that `name` may misspell. */
  private suggestProperty(type: Type, name: string): string | undefined {
    const members = type.kind === 'union' ? type.types : [type];
    const [first, ...rest] = members.map(
      (member) => new Set(this.c.structureOf(this.c.apparentType(member)).properties.keys())
    );
    // A union's properties are those every member has.
    const candidates = [...first].filter(
      (candidate) => !candidate.startsWith('__') && rest.every((names) => names.has(candidate))
    );
    return spellingSuggestion(name, candidates, this.c.budget);
  }

  private elementAccess(node: TreeNode, objectNode: TreeNode): CheckedAccess {
    const indexNode = node.childForFieldName('index') as TreeNode;
    const { type: objectType, shortCircuits } = this.readReceiver(node, objectNode);
    const indexType = this.indexTypeOf(indexNode);
    const result = this.narrowedReference(node, () =>
      this.indexedType(node, objectNode, indexNode, objectType, indexType)
    );
    return this.checkedAccess(node, result, objectType, shortCircuits, indexType);
  }

  targetReceiverType(node: TreeNode, object: TreeNode): Type {
    return object.type === 'super'
      ? this.c.classes.superType(node)
      : this.checkNonNullable(object, this.c.expressions.check(object));
  }

  /** The type an element access's index selects by, which is `number` for a `for...in` variable over an array. */
  indexTypeOf(indexNode: TreeNode): Type {
    const type = this.c.expressions.check(indexNode);
    return this.c.statements.isForInNumericIndex(indexNode) ? numberType : type;
  }

  isReadonlyIndex(objectType: Type, indexType: Type): boolean {
    if (isAnyLike(objectType)) return false;
    if (objectType.kind === 'union') return objectType.types.some((member) => this.isReadonlyIndex(member, indexType));
    if (indexType.kind === 'union') return indexType.types.some((member) => this.isReadonlyIndex(objectType, member));
    if (indexType.kind === 'literal' && this.c.propertyOf(objectType, String(indexType.value))) return false;
    return applicableIndex(this.c, this.c.structureOf(objectType), indexType)?.readonly === true;
  }

  /**
   * Whether a generic key writes a mapped type declared `readonly`, which TypeScript's `checkIndexedAccessIndexType`
   * rejects from the mapped type's own modifier, not from the modifiers a homomorphic one keeps.
   */
  isReadonlyMappedWrite(objectType: Type, indexType: Type): boolean {
    return (
      objectType.kind === 'object' && objectType.mapped?.readonlyModifier === '+' && isGenericKey(regularOf(indexType))
    );
  }

  /**
   * Whether writing a key of a type parameter goes through an index signature of its constraint other than the number
   * index, which TypeScript forbids, as the parameter may stand for a type with a narrower property under that key.
   */
  isGenericIndexWrite(objectType: Type, key: Type): boolean {
    if (objectType.kind !== 'typeParameter' || objectType.isThisType) return false;
    if (key.kind === 'union') return key.types.some((member) => this.isGenericIndexWrite(objectType, member));
    const apparent = this.c.apparentType(objectType);
    if (apparent.kind !== 'object' && apparent.kind !== 'intersection' && apparent.kind !== 'union') return false;
    if (isPropertyKeyLiteral(key) && this.c.propertyOf(apparent, String(key.value))) return false;
    const structure = this.c.structureOf(apparent);
    const index = applicableIndex(this.c, structure, key);
    return index !== undefined && index !== structure.numberIndex;
  }

  indexedType(
    node: TreeNode,
    objectNode: TreeNode,
    indexNode: TreeNode,
    objectType: Type,
    indexType: Type,
    { readsField = true, write }: IndexAccessOptions = {}
  ): Type {
    const type = this.indexedTypeAt({ node, objectNode, indexNode, write }, objectType, indexType);
    if (readsField && objectNode.type === 'this' && isPropertyKeyLiteral(indexType)) {
      const property = this.c.propertyOf(objectType, String(indexType.value));
      if (property) this.c.classDeclarations.checkFieldRead(node, objectNode, indexNode, property);
    }
    return type;
  }

  private indexedTypeAt(access: IndexAccess, objectType: Type, indexType: Type): Type {
    if (indexType === errorType || objectType === errorType) return errorType;
    const index = regularOf(indexType);
    if (isAnyLike(objectType)) return this.c.typeOperators.indexedAccess(objectType, index, access.indexNode);
    // As TypeScript's `getPropertyTypeForIndexType`, any key reads `never` from `never`.
    if (
      isIntrinsic(objectType, 'never') &&
      this.c.relations.isAssignable(index, unionOf([stringType, numberType, symbolType]))
    )
      return neverType;
    if (isGenericKey(index))
      return this.checkedGenericIndex(
        access,
        objectType,
        this.c.typeOperators.indexedAccess(objectType, index, access.node)
      );
    if (objectType.kind === 'object' && objectType.objectKind === 'mapped' && !objectType.mapped?.nameType)
      return this.c.typeOperators.indexedAccess(objectType, index, access.node);
    // A key that is not generic reads the object a type parameter stands for through its constraint.
    if (objectType.kind === 'typeParameter')
      return this.indexedTypeAt(access, this.c.apparentType(objectType), indexType);
    if (isPropertyKeyLiteral(index)) {
      const type = this.literalIndexedType(access, objectType, index.value);
      if (type) return type;
    }
    return this.computedIndexedType(access, objectType, index);
  }

  /**
   * A deferred access of an object by a generic key, reporting a key that is not one of the object's keys as TypeScript's
   * `checkIndexedAccessIndexType` does, as `K extends string | number` is not for a `Record<string, T>`. The check
   * applies to an object that is not generic, whose `keyof` is known.
   */
  private checkedGenericIndex(access: IndexAccess, objectType: Type, type: Type): Type {
    if (type.kind !== 'indexedAccess' || this.c.relations.isGeneric(objectType)) return type;
    const keys = this.c.typeOperators.keyofType(objectType);
    const numberIndexed = this.c.structureOf(objectType).numberIndex !== undefined;
    const index = type.indexType;
    const valid = (index.kind === 'union' ? index.types : [index]).every(
      (member) =>
        this.c.relations.isAssignable(member, keys) ||
        (numberIndexed && this.c.relations.isAssignable(member, numberType))
    );
    if (valid) return type;
    this.c.error(
      access.node,
      `型 '${this.c.print(index)}' は型 '${this.c.print(objectType)}' のインデックスに使えません。`
    );
    return errorType;
  }

  /** The type of the element a literal index names, or `undefined` when no property has its name. */
  private literalIndexedType(access: IndexAccess, objectType: Type, value: string | number | symbol): Type | undefined {
    const name = String(value);
    objectType = this.c.reducedTypes.of(objectType);
    const property = this.c.propertyOf(objectType, name);
    // A unique symbol matches the symbol index signature only.
    if (!property)
      return typeof value === 'symbol'
        ? this.c.structureOf(objectType).symbolIndex?.type
        : (tupleElementBeyond(this.c, objectType, name, access.indexNode) ??
            applicableIndex(this.c, this.c.structureOf(objectType), literalType(value))?.type);
    if (!this.checkPropertyAvailability(access.indexNode, objectType, property)) return errorType;
    this.c.expressions.expandos.checkAssignedBefore(access.node, access.indexNode, property);
    // `o["secret"]` reads a private or protected member, which TypeScript leaves as a way around its access checks.
    return propertyAccessType(property, access.write ? 'write' : 'read');
  }

  private computedIndexedType(access: IndexAccess, objectType: Type, index: Type): Type {
    // A key may mix kinds, as `0 | "a"`, so long as each member is a string, a number, or a symbol.
    const keyTypes = unionOf([stringType, numberType, symbolType, this.c.globalType('Symbol')]);
    if (!this.c.relations.isAssignable(index, keyTypes)) {
      this.c.error(access.indexNode, `型 '${this.c.print(index)}' はインデックスに使えません。`);
      return errorType;
    }
    if (access.write && index.kind === 'union') {
      const types = index.types.map((member) => this.indexedTypeAt(access, objectType, member));
      return types.includes(errorType) ? errorType : intersectionOf(types, this.c.budget);
    }
    const structure = this.c.structureOf(objectType);
    const applicable = applicableIndex(this.c, structure, index);
    if (applicable) return applicable.type;
    if (index === neverType) return neverType;
    if (
      index.kind === 'union' &&
      index.types.every((member) => member.kind === 'literal' || applicableIndex(this.c, structure, member))
    ) {
      return unionOf(index.types.map((member) => this.indexedTypeAt(access, objectType, member)));
    }
    if (objectType.kind === 'indexedAccess') return this.c.typeOperators.indexedAccess(objectType, index);
    const missing =
      index.kind === 'literal'
        ? `プロパティ '${printedPropertyName(String(index.value), index)}' は型 '${this.c.print(objectType)}' にありません。`
        : '';
    this.c.error(
      access.node,
      `型 '${this.c.print(index)}' の式は型 '${this.c.print(objectType)}' のインデックスに使えないため、要素の型が暗黙に any になります。${missing}`
    );
    return errorType;
  }
}

function isGenericKey(index: Type): boolean {
  return ['typeParameter', 'keyof', 'conditional', 'indexedAccess'].includes(index.kind);
}

/**
 * Whether a member read's value is only examined or discarded, as the operand of `typeof`, `void`, or an equality, so
 * that it can never be called afterwards.
 */
function isOnlyCompared(read: TreeNode | null): boolean {
  const parent = read && outermostRuntimeExpression(read).parent;
  if (parent?.type === 'unary_expression')
    return ['typeof', 'void'].includes(parent.childForFieldName('operator')?.text ?? '');
  return (
    parent?.type === 'binary_expression' &&
    ['===', '!==', '==', '!='].includes(parent.childForFieldName('operator')?.text ?? '')
  );
}

function outermostRuntimeExpression(node: TreeNode): TreeNode {
  let expression = node;
  for (let parent = expression.parent; parent; parent = parent.parent) {
    if (
      parent.type !== 'parenthesized_expression' &&
      (!assertionTypes.has(parent.type) || assertedExpression(parent)?.id !== expression.id)
    )
      break;
    expression = parent;
  }
  return expression;
}

function isValueName(node: TreeNode, name: string): boolean {
  return (
    ['identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern'].includes(node.type) &&
    node.text === name
  );
}

function propertyBinding(property: TreeNode): TreeNode | undefined {
  const entry = property.parent;
  if (property.type === 'shorthand_property_identifier_pattern') return property;
  if (entry?.type !== 'pair_pattern' || entry.childForFieldName('key')?.id !== property.id) return undefined;
  const value = entry.childForFieldName('value');
  const name = value && (defaultedTarget(value) ?? value);
  return name?.type === 'identifier' ? name : undefined;
}

function initializerBinding(read: TreeNode | null): TreeNode | undefined {
  if (!read) return undefined;
  const initializer = outermostRuntimeExpression(read);
  const declarator = initializer.parent;
  if (declarator?.type !== 'variable_declarator' || declarator.childForFieldName('value')?.id !== initializer.id)
    return undefined;
  const name = declarator.childForFieldName('name');
  return name?.type === 'identifier' ? name : undefined;
}

/** The outermost link of the chain a link belongs to, as `a?.b.c()` for `a?.b`. */
function chainEnd(node: TreeNode): TreeNode {
  let current = node;
  while (current.parent && chainObject(current.parent)?.id === current.id) current = current.parent;
  return current;
}

/**
 * The type the flow gives a reference, except that `x!` where the flow leaves `x` only `null` or `undefined` takes the
 * declared type, as TypeScript gives it, as after a callback assigned it.
 */
function flowReferenceType(c: Checker, node: TreeNode, flowType: Type, declared: Type | (() => Type)): Type {
  if (
    node.parent?.type !== 'non_null_expression' ||
    isIntrinsic(flowType, 'never') ||
    !isIntrinsic(c.relations.removeNullish(flowType), 'never')
  )
    return flowType;
  return typeof declared === 'function' ? declared() : declared;
}
