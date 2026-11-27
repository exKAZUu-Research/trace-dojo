import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { memberName } from './declarations';
import { hasToken, isConstructorName, named } from './syntax';
import { errorType, permissiveAnyType } from './types';

const invalidTypeMemberModifiers = new Set(['override_modifier', 'accessibility_modifier', 'static']);

/** Reports class-only member modifiers (`override`, accessibility, `static`) written on interface or object-type members. */
export function checkTypeMemberModifiers(c: Checker, root: TreeNode): void {
  for (const body of root.descendantsOfType(['interface_body', 'object_type'])) {
    c.budget.spend();
    for (const member of named(body)) reportInvalidTypeMemberModifiers(c, member);
  }
}

function reportInvalidTypeMemberModifiers(c: Checker, member: TreeNode): void {
  const nameId = member.childForFieldName('name')?.id;
  for (const child of member.children) {
    if (child && child.id !== nameId && invalidTypeMemberModifiers.has(child.type)) {
      c.error(child, `'${child.text}' 修飾子は型メンバーでは使用できません。`);
    }
  }
}

/** A member marked `override`, including a parameter property, must override a member of the base class. */
export function checkOverrideModifiers(c: Checker, node: TreeNode, members: TreeNode[]): void {
  const ctor = c.classes.constructorNode(node);
  const parameters = named(ctor?.childForFieldName('parameters') ?? ctor ?? node).filter(
    (parameter) => ctor !== undefined && parameter.type !== 'comment'
  );
  const hasBase = c.classes.extendsClause(node) !== undefined && !c.classes.extendsNull(node);
  const className = node.childForFieldName('name')?.text ?? '(Anonymous class)';
  for (const member of [...members, ...parameters]) {
    checkOverrideMember(c, node, member, hasBase, className);
  }
}

function checkOverrideMember(c: Checker, node: TreeNode, member: TreeNode, hasBase: boolean, className: string): void {
  const modifier = named(member).find((child) => child.type === 'override_modifier');
  if (!modifier) return;
  if (isConstructorDeclaration(member)) {
    c.error(modifier, "'override' 修飾子は、コンストラクターの宣言には付けられません。");
    return;
  }
  if (!hasBase) {
    c.error(
      member,
      `このメンバーには 'override' 修飾子を付けられません。クラス '${className}' は、ほかのクラスを継承していません。`
    );
    return;
  }
  const name = memberName(c, member);
  const nameNode = member.childForFieldName('name') ?? member.childForFieldName('pattern');
  if (name === undefined && nameNode?.type === 'computed_property_name') {
    c.error(member, "名前が動的であるため、このメンバーに 'override' 修飾子を指定することはできません。");
    return;
  }
  const base = hasToken(member, 'static') ? c.classes.baseStaticType(node) : c.classes.baseInstanceType(node);
  if (name === undefined || !base || base === errorType || base === permissiveAnyType || c.propertyOf(base, name))
    return;
  c.error(
    member,
    `このメンバーには 'override' 修飾子を付けられません。基底クラス '${c.print(c.classes.baseInstanceType(node) ?? base)}' で宣言されていません。`
  );
}

function isConstructorDeclaration(member: TreeNode): boolean {
  return (
    (member.type === 'method_definition' || member.type === 'method_signature') &&
    isConstructorName(member.childForFieldName('name'))
  );
}
