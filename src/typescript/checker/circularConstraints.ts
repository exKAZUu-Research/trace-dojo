import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { ExecutionBudget } from '../../interpreter/limits';
import type { Checker } from './checker';
import { named } from './syntax';
import type { Type, TypeParameter } from './types';

/** The type syntaxes whose parts a base constraint follows, as TypeScript's `computeBaseConstraint` does. */
const followedSyntaxes = new Set(['parenthesized_type', 'union_type', 'intersection_type', 'lookup_type']);

/** Which type parameters have circular constraints, as TypeScript's `!hasNonCircularBaseConstraint` tells. */
export class CircularConstraints {
  /** Whether each type parameter's constraint is circular, or `undefined` while that is being found. */
  private readonly known = new Map<number, boolean | undefined>();

  constructor(private readonly budget: ExecutionBudget) {}

  /**
   * Whether following the constraint of a type parameter through type parameters, indexed accesses, unions, and
   * intersections leads back to it.
   */
  has(parameter: TypeParameter): boolean {
    if (this.known.has(parameter.id)) return this.known.get(parameter.id) ?? false;
    this.known.set(parameter.id, undefined);
    const circular = this.leadsBack(parameter.constraint?.(), [parameter.id]);
    this.known.set(parameter.id, circular);
    return circular;
  }

  /** Whether `type` leads to the first of `visiting`, the type parameters followed so far. */
  private leadsBack(type: Type | undefined, visiting: number[]): boolean {
    this.budget.spend();
    switch (type?.kind) {
      case 'typeParameter': {
        if (visiting.includes(type.id)) return type.id === visiting[0];
        return this.leadsBack(type.constraint?.(), [...visiting, type.id]);
      }
      case 'indexedAccess': {
        return this.leadsBack(type.objectType, visiting) || this.leadsBack(type.indexType, visiting);
      }
      case 'union':
      case 'intersection': {
        return type.types.some((member) => this.leadsBack(member, visiting));
      }
      default: {
        return false;
      }
    }
  }
}

/**
 * Reports each type parameter whose constraint leads back to itself, as TypeScript's `checkTypeParameter` does. It
 * follows the written constraints, since resolving a self-referencing constraint may need that constraint.
 */
export function checkCircularConstraints(c: Checker, root: TreeNode): void {
  for (const parameter of root.descendantsOfType('type_parameter')) {
    const constraint = constraintTypeNode(parameter);
    if (constraint && writtenConstraintLeadsBack(c, constraint, [parameter.id]))
      c.error(constraint, `型パラメーター '${parameter.childForFieldName('name')?.text}' の制約が循環しています。`);
  }
}

function constraintTypeNode(parameter: TreeNode): TreeNode | undefined {
  const constraint = parameter.childForFieldName('constraint');
  return constraint ? named(constraint)[0] : undefined;
}

/** Whether a constraint written as `node` leads to the first of `visiting`, the type parameters followed so far. */
function writtenConstraintLeadsBack(c: Checker, node: TreeNode, visiting: number[]): boolean {
  c.budget.spend();
  if (followedSyntaxes.has(node.type))
    return named(node).some((child) => writtenConstraintLeadsBack(c, child, visiting));
  if (node.type !== 'type_identifier') return false;
  const declaration = c.scopeOf(node).lookupType(node.text)?.typeDeclarations[0];
  if (declaration?.type !== 'type_parameter') return false;
  if (visiting.includes(declaration.id)) return declaration.id === visiting[0];
  const constraint = constraintTypeNode(declaration);
  return constraint !== undefined && writtenConstraintLeadsBack(c, constraint, [...visiting, declaration.id]);
}
