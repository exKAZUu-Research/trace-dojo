import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { unsupportedMessage } from '../unsupported';
import type { Checker } from './checker';
import { isNumericName, skipParentheses } from './syntax';
import {
  anyType,
  errorType,
  isAnyLike,
  isIntrinsic,
  numberType,
  type Property,
  regularOf,
  stringType,
  type Type,
  undefinedType,
  unionOf,
  type UnionType,
} from './types';

const wellKnownSymbols = new Set([
  'iterator',
  'asyncIterator',
  'hasInstance',
  'isConcatSpreadable',
  'match',
  'matchAll',
  'replace',
  'search',
  'species',
  'split',
  'toPrimitive',
  'toStringTag',
  'unscopables',
]);

/** The nodes of an element access, where its errors are reported. */
interface IndexAccess {
  node: TreeNode;
  objectNode: TreeNode;
  indexNode: TreeNode;
}

/** Checks property and element accesses. */
export class MemberChecker {
  /**
   * The types of the accesses and calls of optional chains without the `undefined` that stopping early adds, which
   * the rest of the chain continues from.
   */
  private readonly continuedTypes = new Map<number, Type>();

  constructor(private readonly c: Checker) {}

  /** Records what an optional chain continues from after `node`, returning `node`'s own type with `undefined`. */
  chainResult(node: TreeNode, continued: Type): Type {
    this.continuedTypes.set(node.id, continued);
    return unionOf([continued, undefinedType]);
  }

  /** The type of an object that continues an optional chain, which is never what stopping the chain gave. */
  private continuedObjectType(objectNode: TreeNode, checked: Type): Type | undefined {
    if (objectNode.type === 'parenthesized_expression' || !this.isInOptionalChain(objectNode)) return undefined;
    return this.continuedTypes.get(objectNode.id) ?? checked;
  }

  memberAccess(node: TreeNode): Type {
    const objectNode = node.childForFieldName('object') as TreeNode;
    const propertyNode = node.childForFieldName('property') as TreeNode;
    const optional = node.childForFieldName('optional_chain') !== null;
    const name = propertyNode.text;
    if (objectNode.type === 'super') return this.c.classes.superProperty(node, propertyNode);
    let objectType = this.c.expressions.check(objectNode);
    const key = this.c.flow.referenceKey(node);
    const continued = this.continuedObjectType(objectNode, objectType);
    if (optional) {
      if (isAnyLike(objectType)) return anyType;
      const nonNull = this.c.relations.removeNullish(continued ?? objectType);
      const propertyType = this.propertyAccess(node, objectNode, propertyNode, nonNull, name);
      return this.c.relations.isNullable(objectType) || continued ? this.chainResult(node, propertyType) : propertyType;
    }
    if (continued) {
      const propertyType = this.propertyAccess(
        node,
        objectNode,
        propertyNode,
        this.checkNonNullable(objectNode, continued),
        name
      );
      return this.chainResult(node, propertyType);
    }
    objectType = this.checkNonNullable(objectNode, objectType);
    const propertyType = this.propertyAccess(node, objectNode, propertyNode, objectType, name);
    if (key) {
      const entry = this.c.flow.entry(key);
      if (entry && !this.c.expressions.isAssignmentTarget(node)) return entry.type;
    }
    return propertyType;
  }

  /** For `a?.b` called as `a?.b()`, the type of `b` itself, which the call reaches only when `a` is not nullish. */
  chainedCalleeType(callee: TreeNode): Type | undefined {
    if (callee.type !== 'member_expression' || !this.isInOptionalChain(callee)) return undefined;
    const objectNode = callee.childForFieldName('object') as TreeNode;
    const propertyNode = callee.childForFieldName('property') as TreeNode;
    const checked = this.c.expressions.check(objectNode);
    if (isAnyLike(checked)) return anyType;
    const objectType = this.continuedObjectType(objectNode, checked) ?? checked;
    const nonNull = callee.childForFieldName('optional_chain')
      ? this.c.relations.removeNullish(objectType)
      : this.checkNonNullable(objectNode, objectType);
    return this.propertyAccess(callee, objectNode, propertyNode, nonNull, propertyNode.text);
  }

  private isInOptionalChain(node: TreeNode): boolean {
    let current = skipParentheses(node);
    while (
      current.type === 'member_expression' ||
      current.type === 'call_expression' ||
      current.type === 'subscript_expression'
    ) {
      if (current.childForFieldName('optional_chain')) return true;
      current = current.childForFieldName(current.type === 'call_expression' ? 'function' : 'object') as TreeNode;
    }
    return false;
  }

  /** Reports an object that may be `null`, `undefined`, or `unknown` where a member is used, returning the rest. */
  // code-gauge-allow functionCognitiveComplexity 19 -- Reports each nullish case with the message TypeScript gives it.
  checkNonNullable(node: TreeNode, type: Type): Type {
    if (isIntrinsic(type, 'unknown')) {
      this.c.error(
        node,
        this.isEntityName(node) ? `'${node.text}' の型は 'unknown' です。` : "オブジェクトの型は 'unknown' です。"
      );
      return errorType;
    }
    if (isAnyLike(type)) return type;
    const members = type.kind === 'union' ? type.types : [type];
    const hasNull = members.some((member) => isIntrinsic(member, 'null'));
    const hasUndefined = members.some((member) => isIntrinsic(member, 'undefined') || isIntrinsic(member, 'void'));
    if (!hasNull && !hasUndefined) return type;
    const rest = this.c.relations.removeNullish(type);
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
  propertyAccess(node: TreeNode, objectNode: TreeNode, propertyNode: TreeNode, objectType: Type, name: string): Type {
    if (isAnyLike(objectType)) return objectType;
    if (propertyNode.type === 'private_property_identifier')
      return this.c.classes.privateNameAccess(node, propertyNode, objectType);
    if (objectType.kind === 'union') {
      return unionOf(
        objectType.types.map((member) => this.propertyAccess(node, objectNode, propertyNode, member, name)),
        true
      );
    }
    const property = this.c.propertyOf(objectType, name);
    if (!property) {
      const index = this.indexSignatureFor(objectType, name);
      if (index) return index;
      this.reportMissingProperty(propertyNode, name, objectType);
      return errorType;
    }
    this.checkPropertyUse(node, objectNode, propertyNode, objectType, name, property);
    const type = property.type();
    return property.optional ? unionOf([type, undefinedType]) : type;
  }

  checkPropertyUse(
    node: TreeNode,
    objectNode: TreeNode,
    propertyNode: TreeNode,
    objectType: Type,
    name: string,
    property: Property
  ): void {
    this.c.classes.checkPropertyAccessibility(node, propertyNode, objectNode, objectType, property);
    this.c.classes.checkInitializedBefore(node, objectNode, property);
    this.checkPropertyAvailability(propertyNode, objectType, name, property);
  }

  checkPropertyAvailability(propertyNode: TreeNode, objectType: Type, name: string, property: Property): void {
    const unsupported = this.unsupportedMember(objectType, name) ?? this.unsupportedLibraryMember(property);
    if (unsupported) this.c.error(propertyNode, unsupportedMessage(unsupported));
  }

  /** A library member of every error or regular expression that this interpreter does not provide. */
  private unsupportedLibraryMember(property: Property): string | undefined {
    const declaration = property.declaration;
    if (!declaration || !this.c.isLibrary(declaration)) return undefined;
    const owner = declaration.parent?.parent?.childForFieldName('name')?.text;
    // A stack trace names the files and lines of the host, which differ from the program's.
    if (owner === 'Error' && property.name === 'stack') return 'Error の stack';
    if (owner === 'RegExp' && property.name === 'compile') return 'RegExp の compile';
    // Node.js shows a function's source as tsx's esbuild printed it, which this interpreter does not reproduce.
    if (owner === 'Function' && property.name === 'toString') return '関数やクラスの文字列への変換';
    return undefined;
  }

  private unsupportedMember(objectType: Type, name: string): string | undefined {
    if (objectType.kind !== 'object') return undefined;
    // The interpreter leaves out Math.random so that a program always draws the same board.
    if (objectType.name === 'Math' && name === 'random') return 'Math.random';
    // The well-known symbols replace the protocols of the language, which this interpreter does not support yet.
    if (objectType.name === 'SymbolConstructor' && wellKnownSymbols.has(name))
      return `Symbol.${name} などの well-known シンボル`;
    // Timers print how long they took, which differs on every run.
    if (objectType.name === 'Console' && ['time', 'timeEnd', 'timeLog', 'timeStamp'].includes(name))
      return `console.${name}`;
    return undefined;
  }

  private indexSignatureFor(type: Type, name: string): Type | undefined {
    const structure = this.c.structureOf(type);
    if (structure.stringIndex) return structure.stringIndex.type;
    if (isNumericName(name) && structure.numberIndex) return structure.numberIndex.type;
    return undefined;
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
    const suggestion = this.suggestProperty(type, name);
    this.c.error(
      node,
      `プロパティ '${name}' は型 '${this.c.print(type)}' にありません。${suggestion ? `'${suggestion}' のことですか？` : ''}`
    );
  }

  private suggestProperty(type: Type, name: string): string | undefined {
    const candidates = (type.kind === 'union' ? [] : [...this.c.structureOf(type).properties.keys()]).filter(
      (candidate) => !candidate.startsWith('__')
    );
    let best: string | undefined;
    let bestDistance = Math.max(2, Math.floor(name.length * 0.34));
    for (const candidate of candidates) {
      if (Math.abs(candidate.length - name.length) > bestDistance) continue;
      const distance = editDistance(candidate.toLowerCase(), name.toLowerCase());
      if (candidate.toLowerCase() === name.toLowerCase() || distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  elementAccess(node: TreeNode): Type {
    const objectNode = node.childForFieldName('object') as TreeNode;
    const indexNode = node.childForFieldName('index') as TreeNode;
    const optional = node.childForFieldName('optional_chain') !== null;
    const checked = this.c.expressions.check(objectNode);
    const indexType = this.c.expressions.check(indexNode);
    const continued = this.continuedObjectType(objectNode, checked);
    const objectType = optional
      ? this.c.relations.removeNullish(continued ?? checked)
      : this.checkNonNullable(objectNode, continued ?? checked);
    const key = this.c.flow.referenceKey(node);
    const entry = key ? this.c.flow.entry(key) : undefined;
    if (entry && !this.c.expressions.isAssignmentTarget(node)) return entry.type;
    const result = this.indexedType(node, objectNode, indexNode, objectType, indexType);
    return optional || continued ? this.chainResult(node, result) : result;
  }

  indexedType(node: TreeNode, objectNode: TreeNode, indexNode: TreeNode, objectType: Type, indexType: Type): Type {
    return this.indexedTypeAt({ node, objectNode, indexNode }, objectType, indexType);
  }

  private indexedTypeAt(access: IndexAccess, objectType: Type, indexType: Type): Type {
    if (isAnyLike(objectType)) return anyType;
    const index = regularOf(indexType);
    if (index.kind === 'typeParameter' || index.kind === 'keyof' || objectType.kind === 'typeParameter') {
      return this.c.typeOperators.indexedAccess(objectType, index);
    }
    if (index.kind === 'literal' && (typeof index.value === 'string' || typeof index.value === 'number')) {
      const type = this.literalIndexedType(access, objectType, index.value, indexType);
      if (type) return type;
    }
    if (isAnyLike(index)) {
      const structure = this.c.structureOf(objectType);
      if (structure.numberIndex) return structure.numberIndex.type;
      if (structure.stringIndex) return structure.stringIndex.type;
      return anyType;
    }
    return this.computedIndexedType(access, objectType, index, indexType);
  }

  /** The type of the element a literal index names, or `undefined` when no property has its name. */
  private literalIndexedType(
    access: IndexAccess,
    objectType: Type,
    value: string | number,
    indexType: Type
  ): Type | undefined {
    const name = String(value);
    if (objectType.kind === 'object' && objectType.objectKind === 'tuple' && typeof value === 'number') {
      const elements = objectType.tuple?.elements ?? [];
      if (value >= elements.length && !elements.some((element) => element.rest)) {
        this.c.error(
          access.indexNode,
          `長さ ${elements.length} のタプル型 '${this.c.print(objectType)}' には、インデックス ${name} の要素がありません。`
        );
        return errorType;
      }
    }
    if (objectType.kind === 'union') return this.indexedTypeOfMembers(access, objectType, indexType);
    const property = this.c.propertyOf(objectType, name);
    if (!property) return undefined;
    this.checkPropertyAvailability(access.indexNode, objectType, name, property);
    // `o["secret"]` reads a private or protected member, which TypeScript leaves as a way around its access checks.
    return property.optional ? unionOf([property.type(), undefinedType]) : property.type();
  }

  private computedIndexedType(access: IndexAccess, objectType: Type, index: Type, indexType: Type): Type {
    const isNumeric = this.c.relations.isAssignable(index, numberType);
    const isStringy = this.c.relations.isAssignable(index, stringType);
    if (
      !isNumeric &&
      !isStringy &&
      !this.c.relations.isAssignable(index, this.c.globalType('Symbol')) &&
      !isIntrinsic(index, 'symbol')
    ) {
      this.c.error(access.indexNode, `型 '${this.c.print(index)}' はインデックスに使えません。`);
      return errorType;
    }
    if (objectType.kind === 'union') return this.indexedTypeOfMembers(access, objectType, indexType);
    const structure = this.c.structureOf(objectType);
    if (isNumeric && structure.numberIndex) return structure.numberIndex.type;
    if ((isNumeric || isStringy) && structure.stringIndex) return structure.stringIndex.type;
    if (index.kind === 'union' && index.types.every((member) => member.kind === 'literal')) {
      return unionOf(index.types.map((member) => this.indexedTypeAt(access, objectType, member)));
    }
    if (objectType.kind === 'indexedAccess') return this.c.typeOperators.indexedAccess(objectType, index);
    const missing =
      index.kind === 'literal'
        ? `プロパティ '${String(index.value)}' は型 '${this.c.print(objectType)}' にありません。`
        : '';
    this.c.error(
      access.node,
      `型 '${this.c.print(index)}' の式は型 '${this.c.print(objectType)}' のインデックスに使えないため、要素の型が暗黙に any になります。${missing}`
    );
    return errorType;
  }

  private indexedTypeOfMembers(access: IndexAccess, objectType: UnionType, indexType: Type): Type {
    return unionOf(objectType.types.map((member) => this.indexedTypeAt(access, member, indexType)));
  }
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}
