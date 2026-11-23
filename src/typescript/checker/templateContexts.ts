import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import {
  bigintType,
  booleanType,
  isIntrinsic,
  nullType,
  numberType,
  stringType,
  type Type,
  undefinedType,
  unionOf,
} from './types';

/** TypeScript's `templateConstraintType`: the types a template expression keeps as placeholders. */
export const templatePlaceholderConstraint = unionOf([
  stringType,
  numberType,
  bigintType,
  booleanType,
  nullType,
  undefinedType,
]);

/** TypeScript's `isTemplateLiteralContext`: a template parenthesized or used as an element access's index. */
export function isTemplateLiteralContext(node: TreeNode): boolean {
  const parent = node.parent;
  if (parent?.type === 'parenthesized_expression') return isTemplateLiteralContext(parent);
  return parent?.type === 'subscript_expression' && parent.childForFieldName('index')?.id === node.id;
}

/**
 * TypeScript's `isTemplateLiteralContextualType`: a string literal, a template literal type, or a generic type whose
 * constraint could be a string.
 */
export function isTemplateLiteralContextualType(c: Checker, type: Type): boolean {
  return (type.kind === 'union' ? type.types : [type]).some(
    (member) =>
      (member.kind === 'literal' && typeof member.value === 'string') ||
      member.kind === 'templateLiteral' ||
      (nonPrimitiveInstantiableKinds.has(member.kind) && maybeStringLike(c, c.baseConstraint(member)))
  );
}

const nonPrimitiveInstantiableKinds = new Set<Type['kind']>(['typeParameter', 'indexedAccess', 'conditional']);

function maybeStringLike(c: Checker, type: Type): boolean {
  if (type.kind === 'union' || type.kind === 'intersection')
    return type.types.some((member) => maybeStringLike(c, member));
  if (nonPrimitiveInstantiableKinds.has(type.kind) || type.kind === 'keyof') {
    const constraint = c.baseConstraint(type);
    return constraint !== type && maybeStringLike(c, constraint);
  }
  return (
    isIntrinsic(type, 'string') ||
    (type.kind === 'literal' && typeof type.value === 'string') ||
    type.kind === 'templateLiteral' ||
    type.kind === 'stringMapping'
  );
}
