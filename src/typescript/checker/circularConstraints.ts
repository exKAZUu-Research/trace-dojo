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
  const reaches = new WrittenReaches(c);
  for (const parameter of root.descendantsOfType('type_parameter')) {
    const constraint = wrappedTypeNode(parameter, 'constraint');
    if (constraint && reaches.constraintLeadsBack(parameter))
      c.error(constraint, `型パラメーター '${parameter.childForFieldName('name')?.text}' の制約が循環しています。`);
  }
}

/** The type written in a field of a type parameter, such as its constraint or default. */
function wrappedTypeNode(parameter: TreeNode, field: 'constraint' | 'value'): TreeNode | undefined {
  const wrapper = parameter.childForFieldName(field);
  return wrapper ? named(wrapper)[0] : undefined;
}

/** The type parameters, by declaration id, that the base constraints of written types lead to. */
type Reach = Map<number, TreeNode>;

/**
 * Finds the type parameters a written type stands for transparently: through unions, intersections, indexed accesses,
 * conditional types, and type aliases, which TypeScript resolves to their values with their parameters replaced.
 */
class WrittenReaches {
  /** The reach of each written type, by node id, in terms of the type parameters in scope where it is written. */
  private readonly known = new Map<number, Reach>();

  constructor(private readonly c: Checker) {}

  /** Whether following the constraint of a type parameter through the type parameters it reaches leads back to it. */
  constraintLeadsBack(parameter: TreeNode): boolean {
    const visited = new Set<number>();
    const pending = [parameter];
    while (pending.length > 0) {
      const constraint = wrappedTypeNode(pending.pop() as TreeNode, 'constraint');
      if (!constraint) continue;
      for (const [id, reached] of this.of(constraint)) {
        if (id === parameter.id) return true;
        if (visited.has(id)) continue;
        visited.add(id);
        pending.push(reached);
      }
    }
    return false;
  }

  private of(node: TreeNode): Reach {
    const existing = this.known.get(node.id);
    if (existing) return existing;
    // A type alias whose value needs itself is reported as circular on its own, so its cycle reaches nothing.
    this.known.set(node.id, new Map());
    const reach = this.compute(node);
    this.known.set(node.id, reach);
    return reach;
  }

  private compute(node: TreeNode): Reach {
    this.c.budget.spend();
    if (followedSyntaxes.has(node.type)) return this.ofAll(named(node));
    if (node.type === 'conditional_type') {
      // A conditional type distributing over a type parameter is constrained by that parameter's constraint.
      const check = node.childForFieldName('left');
      const branches = [node.childForFieldName('consequence'), node.childForFieldName('alternative')];
      return this.ofAll([check?.type === 'type_identifier' ? check : undefined, ...branches]);
    }
    const name = node.type === 'generic_type' ? node.childForFieldName('name') : node;
    if (name?.type !== 'type_identifier') return new Map();
    const declaration = this.c.scopeOf(name).lookupType(name.text)?.typeDeclarations[0];
    if (declaration?.type === 'type_parameter') return new Map([[declaration.id, declaration]]);
    return declaration?.type === 'type_alias_declaration' ? this.ofAlias(node, declaration) : new Map();
  }

  private ofAll(nodes: (TreeNode | null | undefined)[]): Reach {
    const reach: Reach = new Map();
    for (const node of nodes) if (node) for (const [id, reached] of this.of(node)) reach.set(id, reached);
    return reach;
  }

  /** The reach of a type alias application: its value's, with the alias's parameters replaced by their arguments. */
  private ofAlias(node: TreeNode, alias: TreeNode): Reach {
    const value = alias.childForFieldName('value');
    if (!value) return new Map();
    const argumentsNode = node.type === 'generic_type' ? node.childForFieldName('type_arguments') : undefined;
    const typeArguments = argumentsNode ? named(argumentsNode) : [];
    const parametersNode = alias.childForFieldName('type_parameters');
    const replacements = new Map<number, Reach>();
    for (const [index, parameter] of (parametersNode ? named(parametersNode) : []).entries())
      replacements.set(parameter.id, this.ofArgument(typeArguments.at(index), parameter, replacements));
    return replaced(this.of(value), replacements);
  }

  /** The reach of the argument of a type alias parameter, or of its default, written where the earlier ones apply. */
  private ofArgument(argument: TreeNode | undefined, parameter: TreeNode, replacements: Map<number, Reach>): Reach {
    if (argument) return this.of(argument);
    const fallback = wrappedTypeNode(parameter, 'value');
    return fallback ? replaced(this.of(fallback), replacements) : new Map();
  }
}

/** A reach with the type parameters that `replacements` has replaced by what they reach. */
function replaced(reach: Reach, replacements: Map<number, Reach>): Reach {
  const result: Reach = new Map();
  for (const [id, reached] of reach)
    for (const [replacedId, replacedNode] of replacements.get(id) ?? [[id, reached] as const])
      result.set(replacedId, replacedNode);
  return result;
}
