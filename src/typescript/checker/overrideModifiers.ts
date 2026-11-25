import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { memberName } from './declarations';
import { hasToken, named } from './syntax';
import { isAnyLike } from './types';

/** A member marked `override`, including a parameter property, must override a member of the base class. */
export function checkOverrideModifiers(c: Checker, node: TreeNode, members: TreeNode[]): void {
  const ctor = c.classes.constructorNode(node);
  const parameters = named(ctor?.childForFieldName('parameters') ?? ctor ?? node).filter(
    (parameter) => ctor !== undefined && parameter.type !== 'comment'
  );
  const hasBase = c.classes.extendsClause(node) !== undefined;
  const className = node.childForFieldName('name')?.text ?? '(Anonymous class)';
  for (const member of [...members, ...parameters]) {
    const modifier = named(member).find((child) => child.type === 'override_modifier');
    if (!modifier) continue;
    if (member.id === ctor?.id) {
      c.error(modifier, "'override' 修飾子は、コンストラクターの宣言には付けられません。");
      continue;
    }
    if (!hasBase) {
      c.error(
        member,
        `このメンバーには 'override' 修飾子を付けられません。クラス '${className}' は、ほかのクラスを継承していません。`
      );
      continue;
    }
    const name = memberName(c, member);
    const isStatic = hasToken(member, 'static');
    const base = isStatic ? c.classes.baseStaticType(node) : c.classes.baseInstanceType(node);
    if (name === undefined || !base || isAnyLike(base) || c.propertyOf(base, name)) continue;
    c.error(
      member,
      `このメンバーには 'override' 修飾子を付けられません。基底クラス '${c.print(c.classes.baseInstanceType(node) ?? base)}' で宣言されていません。`
    );
  }
}
