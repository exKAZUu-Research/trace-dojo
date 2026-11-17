import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { isGenericObjectOrIndexType } from './genericTypes';
import { named } from './syntax';
import {
  type ConditionalType,
  type IndexedAccessType,
  isPropertyKeyLiteral,
  type Type,
  type TypeParameter,
} from './types';

/** What following a base constraint has gone through: type parameters, and the declared conditional types. */
interface Path {
  parameters: readonly number[];
  conditionals: readonly ConditionalType[];
}

/** Which type parameters have circular constraints, as TypeScript's `!hasNonCircularBaseConstraint` tells. */
export class CircularConstraints {
  /** Whether each type parameter's constraint is circular, or `undefined` while that is being found. */
  private readonly known = new Map<number, boolean | undefined>();

  constructor(private readonly c: Checker) {}

  /**
   * Whether following the base constraint of a type parameter, as TypeScript's `computeBaseConstraint` does through
   * type parameters, indexed accesses, conditional types, unions, and intersections, leads back to it.
   */
  has(parameter: TypeParameter): boolean {
    if (this.known.has(parameter.id)) return this.known.get(parameter.id) ?? false;
    this.known.set(parameter.id, undefined);
    const circular = this.leadsBack(parameter.constraint?.(), { parameters: [parameter.id], conditionals: [] });
    this.known.set(parameter.id, circular);
    return circular;
  }

  /** Whether `type` leads to the first of the type parameters `path` has followed. */
  private leadsBack(type: Type | undefined, path: Path): boolean {
    this.c.budget.spend();
    switch (type?.kind) {
      case 'typeParameter': {
        if (path.parameters.includes(type.id)) return type.id === path.parameters[0];
        return this.leadsBack(type.constraint?.(), { ...path, parameters: [...path.parameters, type.id] });
      }
      case 'indexedAccess': {
        const selected = this.selectedTypes(type);
        if (selected) return selected.some((member) => this.leadsBack(member, path));
        return this.leadsBack(type.objectType, path) || this.leadsBack(type.indexType, path);
      }
      case 'conditional': {
        return this.conditionalLeadsBack(type, path);
      }
      case 'union':
      case 'intersection': {
        return type.types.some((member) => this.leadsBack(member, path));
      }
      default: {
        return false;
      }
    }
  }

  /**
   * The property types that an indexed access with literal keys on an object type that is not generic selects, as
   * TypeScript's `getIndexedAccessType` gives them rather than a deferred indexed access.
   */
  private selectedTypes({ objectType, indexType }: IndexedAccessType): Type[] | undefined {
    if (isGenericObjectOrIndexType(objectType)) return undefined;
    const types: Type[] = [];
    for (const key of indexType.kind === 'union' ? indexType.types : [indexType]) {
      if (!isPropertyKeyLiteral(key) || typeof key.value === 'symbol') return undefined;
      const property = this.c.propertyOf(objectType, String(key.value));
      if (!property) return undefined;
      types.push(property.type());
    }
    return types;
  }

  /**
   * Whether a conditional type's constraint leads back, as TypeScript's `getConstraintFromConditionalType` gives it: a
   * distributive one through its check type's constraint, and every one through its branches. As TypeScript's
   * `getImmediateBaseConstraint` does, it stops once a conditional type is ten deep and repeats a declared one, or is
   * fifty deep.
   */
  private conditionalLeadsBack(type: ConditionalType, path: Path): boolean {
    const declared = type.root ?? type;
    const depth = path.conditionals.length;
    if (depth >= 50 || (depth >= 10 && path.conditionals.includes(declared))) return false;
    const next = { ...path, conditionals: [...path.conditionals, declared] };
    return (
      (type.distributive && this.leadsBack(type.checkType, next)) ||
      this.leadsBack(type.trueType, next) ||
      this.leadsBack(type.falseType, next)
    );
  }
}

/**
 * Reports each type parameter whose constraint leads back to itself, as TypeScript's `checkTypeParameter` does. It
 * runs once every constraint has resolved, since a constraint that needs itself while resolving sees none.
 */
export function checkCircularConstraints(c: Checker, root: TreeNode): void {
  const circularConstraints = new CircularConstraints(c);
  for (const node of root.descendantsOfType('type_parameter')) {
    const wrapper = node.childForFieldName('constraint');
    const name = node.childForFieldName('name')?.text;
    const symbol = name ? c.scopeOf(node).lookupType(name) : undefined;
    if (!wrapper || symbol?.typeDeclarations[0]?.id !== node.id) continue;
    if (circularConstraints.has(c.signatures.typeParameterOfSymbol(symbol)))
      c.error(named(wrapper)[0], `型パラメーター '${name}' の制約が循環しています。`);
  }
}
