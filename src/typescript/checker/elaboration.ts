import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { named, propertyNameText, skipParentheses } from './syntax';
import { isAnyLike, type ObjectType, type Type, undefinedType, unionOf } from './types';

/**
 * Reports an assignment that does not fit at the members of the literal that spells its value, as TypeScript
 * elaborates it: the properties of an object literal, the elements of an array literal, and the expression an arrow
 * function returns.
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
        return this.reportElements(node, target);
      }
      case 'arrow_function': {
        return this.reportArrowReturn(node, source, target);
      }
      default: {
        return false;
      }
    }
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

  private reportElements(node: TreeNode, target: Type): boolean {
    const targets = arrayTargets(this.c, target);
    if (targets.length === 0) return false;
    let reported = false;
    for (const [index, element] of named(node).entries()) {
      const spread = element.type === 'spread_element' ? named(element)[0] : undefined;
      // A spread moves the elements after it to positions a tuple cannot tell.
      if (spread && targets.some((member) => member.tuple)) return reported;
      const targetType = targetElementType(this.c, targets, index);
      const sourceType = this.c.silently(() =>
        spread
          ? this.c.patterns.iteratedType(spread, this.c.expressions.check(spread))
          : this.c.expressions.check(element, targetType)
      );
      if (this.c.relations.isAssignable(sourceType, targetType)) continue;
      reported = true;
      this.c.expressions.reportNotAssignable(element, sourceType, targetType);
    }
    return reported;
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

/** The arrays and tuples among a target's members. */
export function arrayTargets(c: Checker, target: Type): ObjectType[] {
  return (target.kind === 'union' ? target.types : [target]).filter(
    (member): member is ObjectType =>
      member.kind === 'object' && (c.isArrayOrTuple(member) || c.structureOf(member).numberIndex !== undefined)
  );
}

/** The type the arrays and tuples of a target give the element at `index`. */
export function targetElementType(c: Checker, targets: ObjectType[], index: number): Type {
  return unionOf(
    targets.map((member) => {
      const elements = member.tuple?.elements;
      return elements?.[index] && !elements[index].rest
        ? c.relations.tupleElementTargetType(elements[index])
        : c.isArrayOrTuple(member)
          ? c.elementTypeOf(member)
          : (c.structureOf(member).numberIndex?.type ?? c.elementTypeOf(member));
    })
  );
}
