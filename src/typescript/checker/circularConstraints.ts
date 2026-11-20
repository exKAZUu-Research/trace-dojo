import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { isGenericObjectOrIndexType } from './genericTypes';
import { applicableIndex } from './indexInfos';
import { named } from './syntax';
import { tupleElementBeyond } from './tupleIndexes';
import {
  type ConditionalType,
  type IndexedAccessType,
  isPropertyKeyLiteral,
  type Type,
  type TypeParameter,
  unionOf,
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
        const selected = this.selectedType(type);
        if (selected) return this.leadsBack(selected, path);
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
   * The type that an indexed access on an object type that is not generic, once an indexed access it reads selects
   * its own, selects through properties and index signatures for each member of the object and the key, as
   * TypeScript's `getIndexedAccessType` gives it rather than a deferred indexed access: `T[][number]` selects `T`.
   */
  private selectedType({ objectType, indexType }: IndexedAccessType): Type | undefined {
    const object = objectType.kind === 'indexedAccess' ? (this.selectedType(objectType) ?? objectType) : objectType;
    if (isGenericObjectOrIndexType(object)) return undefined;
    const types: Type[] = [];
    for (const member of object.kind === 'union' ? object.types : [object]) {
      for (const key of indexType.kind === 'union' ? indexType.types : [indexType]) {
        const type = this.elementType(member, key);
        if (!type) return undefined;
        types.push(type);
      }
    }
    return unionOf(types);
  }

  /**
   * The type of the property a key names, else of the tuple elements past its fixed ones, else of the index signature
   * that applies to the key.
   */
  private elementType(objectType: Type, key: Type): Type | undefined {
    const apparent = this.c.apparentType(objectType);
    if (!isPropertyKeyLiteral(key) || typeof key.value === 'symbol')
      return applicableIndex(this.c, this.c.structureOf(apparent), key)?.type;
    const name = String(key.value);
    return (
      this.c.propertyOf(apparent, name)?.type() ??
      tupleElementBeyond(this.c, apparent, name, undefined) ??
      applicableIndex(this.c, this.c.structureOf(apparent), key)?.type
    );
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
  const declarations = new Map<TypeParameter, TreeNode>();
  for (const node of root.descendantsOfType('type_parameter')) {
    const wrapper = node.childForFieldName('constraint');
    const name = node.childForFieldName('name')?.text;
    const symbol = name ? c.scopeOf(node).lookupType(name) : undefined;
    if (!wrapper || symbol?.typeDeclarations[0]?.id !== node.id) continue;
    declarations.set(c.signatures.typeParameterOfSymbol(symbol), named(wrapper)[0]);
  }
  for (const node of root.descendantsOfType('infer_type')) {
    const [name, constraint] = named(node);
    if (!constraint) continue;
    const parameter = c.typeOperators.inferParameterFor(node, name.text);
    if (parameter && !declarations.has(parameter)) declarations.set(parameter, constraint);
  }
  const circularConstraints = new CircularConstraints(c);
  for (const [parameter, constraint] of declarations) {
    if (circularConstraints.has(parameter))
      c.error(constraint, `型パラメーター '${parameter.name}' の制約が循環しています。`);
  }
}
