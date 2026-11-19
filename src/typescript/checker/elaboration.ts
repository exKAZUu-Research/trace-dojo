import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { spreadLength, tupleArgumentContexts, tupleTypeAt } from './callArity';
import type { Checker } from './checker';
import { printedPropertyName } from './print';
import { arrayPatternElements, named, propertyNameText, skipParentheses } from './syntax';
import { booleanType, isAnyLike, type ObjectType, type Type, undefinedType, unionOf } from './types';

/**
 * Reports an assignment that does not fit at the members of the literal that spells its value, as TypeScript
 * elaborates it: the properties of an object literal, the elements of an array literal, and the expression an arrow
 * function returns. It also formats relation diagnostics when the whole expression or type is rejected.
 */
export class Elaboration {
  constructor(private readonly c: Checker) {}

  /** Reports the members of a literal `expression` that do not fit `target`, returning whether it reported any. */
  report(expression: TreeNode, source: Type, target: Type): boolean {
    const node = skipParentheses(expression);
    if (isAnyLike(target) || target.kind === 'intrinsic' || target.kind === 'literal') return false;
    switch (node.type) {
      case 'object': {
        return this.reportProperties(node, source, target);
      }
      case 'array': {
        return this.reportElements(node, source, target);
      }
      case 'arrow_function': {
        return this.reportArrowReturn(node, source, target);
      }
      default: {
        return false;
      }
    }
  }

  typeRelationMessage(
    source: Type,
    target: Type,
    context: 'assignment' | 'argument' | 'constraint' = 'assignment'
  ): string {
    const types = this.c.typesForMessage(source, target);
    const actual = this.c.print(types.source);
    const expected = this.c.print(types.target);
    const head =
      context === 'constraint'
        ? `型 '${actual}' は制約 '${expected}' を満たしていません。`
        : context === 'argument'
          ? `型 '${actual}' の引数を型 '${expected}' のパラメーターに渡すことはできません。`
          : assignmentMessage(actual, expected);
    return head + this.assignmentDetails(source, types.target);
  }

  private assignmentDetails(source: Type, target: Type): string {
    if (source.kind !== 'union' || source === booleanType) {
      const tuple = this.tupleMismatch(source, target);
      return tuple ? `\n  ${tuple}` : this.missingMembers(source, target);
    }
    this.c.budget.spend(source.types.length);
    const failing = source.types.find((member) => !this.c.relations.isAssignable(member, target));
    if (!failing) return '';
    const types = this.c.typesForMessage(failing, target);
    const detail =
      this.tupleMismatch(failing, types.target) ||
      this.missingMembers(failing, types.target) ||
      assignmentMessage(this.c.print(types.source), this.c.print(types.target));
    return `\n  ${detail}`;
  }

  private tupleMismatch(source: Type, target: Type): string {
    if (source.kind !== 'object' || !source.tuple || target.kind !== 'object' || !target.tuple) return '';
    const sourceElements = source.tuple.elements;
    if (sourceElements.some((element) => element.rest)) return '';
    const positions = tupleArgumentContexts(
      this.c,
      target,
      sourceElements.map(() => 1)
    );
    for (const [index, element] of sourceElements.entries()) {
      const position = positions[index];
      if (!position) continue;
      const expected = target.tuple.elements[index]?.optional ? unionOf([position, undefinedType]) : position;
      const actual = this.c.relations.tupleElementTargetType(element);
      if (this.c.relations.isAssignable(actual, expected)) continue;
      const types = this.c.typesForMessage(actual, expected);
      return assignmentMessage(this.c.print(types.source), this.c.print(types.target));
    }
    return '';
  }

  private missingMembers(source: Type, target: Type): string {
    if (source.kind !== 'object' || target.kind !== 'object' || this.c.isArrayOrTuple(target)) return '';
    const sourceStructure = this.c.structureOf(source);
    const missing = [...target.resolve().properties]
      .filter(
        ([key, property]) =>
          !property.optional && !sourceStructure.properties.has(key) && !this.c.propertyOf(source, key)
      )
      .map(([, property]) => property);
    const sourceNames = new Set([...sourceStructure.properties.values()].map((property) => property.name));
    const otherPrivateName = missing.find((property) => property.isPrivateName && sourceNames.has(property.name));
    if (otherPrivateName)
      return `型 '${this.c.print(source)}' のプロパティ '${otherPrivateName.name}' は、型 '${this.c.print(target)}' の中からは使えない別のメンバーです。`;
    if (missing.length === 1) return `プロパティ '${printedPropertyName(missing[0].name)}' がありません。`;
    if (missing.length > 1)
      return `プロパティ ${missing
        .slice(0, 4)
        .map((property) => `'${printedPropertyName(property.name)}'`)
        .join(', ')} がありません。`;
    return '';
  }

  private reportProperties(node: TreeNode, source: Type, target: Type): boolean {
    let reported = false;
    for (const member of named(node)) {
      const key = memberKey(member);
      const name = key ? propertyNameText(key) : undefined;
      if (!key || name === undefined) continue;
      const targetType = this.targetMemberType(target, name);
      const sourceType = this.c.propertyOf(source, name)?.type();
      if (!targetType || !sourceType || this.c.relations.isAssignable(sourceType, targetType)) continue;
      reported = true;
      const value = member.type === 'pair' ? member.childForFieldName('value') : undefined;
      if (!value || !this.report(value, sourceType, targetType))
        this.c.expressions.reportNotAssignable(key, sourceType, targetType);
    }
    return reported;
  }

  private reportElements(node: TreeNode, source: Type, target: Type): boolean {
    const targets = arrayTargets(this.c, target);
    if (targets.length === 0) return false;
    const tupleTargets = targets.filter((member) => member.tuple);
    const tupleSource = source.kind === 'object' && source.tuple ? source : undefined;
    let reported = false;
    for (const { element, index } of arrayPatternElements(node)) {
      if (element.type === 'spread_element' && tupleTargets.length > 0) {
        if (spreadLength(this.c, element) === undefined) return reported;
        continue;
      }
      if (tupleTargets.some((member) => !this.c.propertyOf(member, String(index)))) continue;
      const expected = targetElementType(this.c, target, index);
      const actual = this.mismatchedArrayElement(element, tupleSource, index, expected);
      if (!actual) continue;
      reported = true;
      this.c.expressions.reportNotAssignable(element, actual, expected);
    }
    return reported;
  }

  private mismatchedArrayElement(
    element: TreeNode,
    tuple: ObjectType | undefined,
    index: number,
    target: Type
  ): Type | undefined {
    // tsc elaborates at syntax positions only when the constructed tuple itself mismatches there.
    const tupleElement = tuple ? this.c.propertyOf(tuple, String(index))?.type() : undefined;
    if (tuple && (!tupleElement || this.c.relations.isAssignable(tupleElement, target))) return undefined;
    const spread = element.type === 'spread_element' ? named(element)[0] : undefined;
    const source = this.c.silently(() =>
      spread
        ? this.c.patterns.iteratedType(spread, this.c.expressions.check(spread))
        : this.c.expressions.check(element, target)
    );
    return this.c.relations.isAssignable(source, target) ? tupleElement : source;
  }

  /** An arrow function whose expression body returns what its target's signatures do not is reported at the body. */
  private reportArrowReturn(node: TreeNode, source: Type, target: Type): boolean {
    const body = node.childForFieldName('body');
    const parameters = node.childForFieldName('parameters');
    if (!body || body.type === 'statement_block') return false;
    if (parameters && named(parameters).some((parameter) => parameter.childForFieldName('type'))) return false;
    const sourceSignatures = this.c.signaturesOf(source, 'call');
    const targetSignatures = this.c.signaturesOf(target, 'call');
    if (sourceSignatures.length !== 1 || targetSignatures.length === 0) return false;
    const sourceReturn = sourceSignatures[0].returnType();
    const targetReturn = unionOf(targetSignatures.map((signature) => signature.returnType()));
    if (this.c.relations.isAssignable(sourceReturn, targetReturn)) return false;
    this.c.expressions.reportNotAssignable(body, sourceReturn, targetReturn);
    return true;
  }

  /** The type a target gives a property of an object literal assigned to it, with `undefined` when it is optional. */
  private targetMemberType(target: Type, name: string): Type | undefined {
    const type = this.c.literals.contextualPropertyType(target, name);
    const optional = (target.kind === 'union' ? target.types : [target]).some(
      (member) =>
        (member.kind === 'object' || member.kind === 'intersection') && this.c.propertyOf(member, name)?.optional
    );
    return type && optional ? unionOf([type, undefinedType]) : type;
  }
}

/** The node naming a property, a shorthand property, or a method of an object literal. */
function memberKey(member: TreeNode): TreeNode | undefined {
  if (member.type === 'shorthand_property_identifier') return member;
  if (member.type === 'pair') return member.childForFieldName('key') ?? undefined;
  if (member.type === 'method_definition') return member.childForFieldName('name') ?? undefined;
  return undefined;
}

/** The arrays, tuples and objects with numeric indexes among the target's constituents. */
export function arrayTargets(c: Checker, target: Type): ObjectType[] {
  if (target.kind === 'union') return target.types.flatMap((member) => arrayTargets(c, member));
  if (target.kind === 'intersection') {
    const groups = target.types.map((member) => arrayTargets(c, member)).filter((members) => members.length > 0);
    return groups.length === 1 ? groups[0] : [];
  }
  return target.kind === 'object' && (c.isArrayOrTuple(target) || c.structureOf(target).numberIndex !== undefined)
    ? [target]
    : [];
}

export function targetElementType(c: Checker, target: Type, index: number): Type {
  return unionOf(
    arrayTargets(c, target).map((array) => {
      const elements = array.tuple?.elements;
      return elements
        ? (tupleTypeAt(c, elements, index) ?? c.elementTypeOf(array))
        : (c.structureOf(array).numberIndex?.type ?? c.elementTypeOf(array));
    })
  );
}

function assignmentMessage(source: string, target: string): string {
  return `型 '${source}' を型 '${target}' に代入することはできません。`;
}
