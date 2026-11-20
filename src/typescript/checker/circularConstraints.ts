import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { isGenericObjectOrIndexType } from './genericTypes';
import { applicableIndex } from './indexInfos';
import { named } from './syntax';
import { tupleElementBeyond } from './tupleIndexes';
import {
  type ConditionalType,
  emptyObjectType,
  type IndexedAccessType,
  isIntrinsic,
  isPatternLiteralType,
  isPrimitive,
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

  constructor(
    private readonly c: Checker,
    private readonly declarations?: ReadonlyMap<TypeParameter, TreeNode>
  ) {}

  /**
   * Whether following the base constraint of a type parameter, as TypeScript's `computeBaseConstraint` does through
   * type parameters, indexed accesses, conditional types, unions, and intersections, leads back to it.
   */
  has(parameter: TypeParameter): boolean {
    if (this.known.has(parameter.id)) return this.known.get(parameter.id) ?? false;
    this.known.set(parameter.id, undefined);
    const circular = this.parameterLeadsBack(parameter, { parameters: [parameter.id], conditionals: [] });
    this.known.set(parameter.id, circular);
    return circular;
  }

  /** Whether `type` leads to the first of the type parameters `path` has followed. */
  private leadsBack(type: Type | undefined, path: Path): boolean {
    this.c.budget.spend();
    switch (type?.kind) {
      case 'typeParameter': {
        if (path.parameters.includes(type.id)) return type.id === path.parameters[0];
        return this.parameterLeadsBack(type, { ...path, parameters: [...path.parameters, type.id] });
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
      case 'intersection':
      case 'templateLiteral': {
        return type.types.some((member) => this.leadsBack(member, path));
      }
      case 'stringMapping': {
        return this.leadsBack(type.type, path);
      }
      default: {
        return false;
      }
    }
  }

  private parameterLeadsBack(parameter: TypeParameter, path: Path): boolean {
    if (this.leadsBack(parameter.constraint?.(), path)) return true;
    const declaration = this.declarations?.get(parameter);
    return !!declaration && this.eagerIntersectionLeadsBack(declaration, path);
  }

  private eagerIntersectionLeadsBack(declaration: TreeNode, path: Path): boolean {
    const pending = [declaration];
    const visited = new Set<Type>();
    for (let node = pending.pop(); node; node = pending.pop()) {
      this.c.budget.spend();
      // The checker resolves a chain of unparenthesized intersections as one expression.
      const evaluatesIntersection = node.type === 'intersection_type' && node.parent?.type !== 'intersection_type';
      if (
        (evaluatesIntersection || node.type === 'generic_type') &&
        this.eagerTypeLeadsBack(this.c.typeNodes.typeFromNode(node), path, visited)
      )
        return true;
      const children =
        node.type === 'conditional_type'
          ? this.c.typeOperators.conditionalConstraintNodes(node)
          : eagerBoundSyntax.has(node.type)
            ? named(node)
            : [];
      for (const child of children) pending.push(child);
    }
    return false;
  }

  private eagerTypeLeadsBack(root: Type, path: Path, visited: Set<Type>): boolean {
    const pending = [root];
    for (let type = pending.pop(); type; type = pending.pop()) {
      this.c.budget.spend();
      if (visited.has(type)) continue;
      visited.add(type);
      if (type.kind === 'intersection' && type.types.length === 2) {
        const [left, right] = type.types;
        const dependency = intersectionConstraintOperand(left, right) ?? intersectionConstraintOperand(right, left);
        if (dependency && this.leadsBack(dependency, path)) return true;
      }
      const children = eagerTypeChildren(type);
      this.c.budget.spend(children.length);
      for (const child of children) pending.push(child);
    }
    return false;
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

/** Checks cycles before comparing repeated infer declarations, which share a bound only when it is non-circular. */
export function checkConstraintDeclarations(c: Checker, root: TreeNode): void {
  const inferred = root.descendantsOfType('infer_type');
  const declarations = constraintDeclarations(c, root, inferred);
  const circularConstraints = new CircularConstraints(c, declarations);
  for (const [parameter, constraint] of declarations) {
    if (circularConstraints.has(parameter))
      c.error(constraint, `型パラメーター '${parameter.name}' の制約が循環しています。`);
  }
  for (const node of inferred) {
    const name = named(node)[0];
    const parameter = name && c.typeOperators.inferParameterFor(node, name.text);
    if (parameter && !circularConstraints.has(parameter)) c.typeOperators.checkInferConstraints(node);
  }
}

function constraintDeclarations(
  c: Checker,
  root: TreeNode,
  inferred: readonly TreeNode[]
): Map<TypeParameter, TreeNode> {
  const declarations = new Map<TypeParameter, TreeNode>();
  for (const node of root.descendantsOfType('type_parameter')) {
    const wrapper = node.childForFieldName('constraint');
    const name = node.childForFieldName('name')?.text;
    const symbol = name ? c.scopeOf(node).lookupType(name) : undefined;
    if (!wrapper || symbol?.typeDeclarations[0]?.id !== node.id) continue;
    declarations.set(c.signatures.typeParameterOfSymbol(symbol), named(wrapper)[0]);
  }
  for (const node of inferred) {
    const [name, constraint] = named(node);
    if (!constraint) continue;
    const parameter = c.typeOperators.inferParameterFor(node, name.text);
    if (parameter && !declarations.has(parameter)) declarations.set(parameter, constraint);
  }
  return declarations;
}

const eagerBoundSyntax = new Set([
  'array_type',
  'generic_type',
  'intersection_type',
  'optional_parameter',
  'optional_type',
  'parenthesized_type',
  'readonly_type',
  'required_parameter',
  'rest_type',
  'template_literal_type',
  'template_type',
  'tuple_type',
  'type_annotation',
  'type_arguments',
  'union_type',
]);

function intersectionConstraintOperand(variable: Type, bound: Type): Type | undefined {
  if (variable.noInfer || (variable.kind !== 'typeParameter' && variable.kind !== 'indexedAccess')) return undefined;
  if (variable.kind === 'typeParameter' && variable.substitution) return undefined;
  return isPrimitive(bound) ||
    bound.kind === 'literal' ||
    isIntrinsic(bound, 'object') ||
    bound.id === emptyObjectType.id ||
    isPatternLiteralType(bound)
    ? variable
    : undefined;
}

function eagerTypeChildren(type: Type): readonly Type[] {
  switch (type.kind) {
    case 'intersection':
    case 'union':
    case 'templateLiteral': {
      return type.types;
    }
    case 'stringMapping': {
      return [type.type];
    }
    case 'object': {
      return type.tuple?.elements.map((element) => element.type) ?? type.typeArguments ?? type.aliasArguments ?? [];
    }
    default: {
      return [];
    }
  }
}
