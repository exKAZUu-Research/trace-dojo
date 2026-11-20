import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { ExecutionBudget } from '../../interpreter/limits';
import type { Checker, Mapper } from './checker';
import { keyedIndexes } from './indexInfos';
import {
  type ConditionalType,
  isAnyLike,
  isIntrinsic,
  type MappedInfo,
  newTypeId,
  type ObjectType,
  permissiveAnyType,
  type Type,
  type TypeParameter,
} from './types';

const distributionDependencies = new WeakMap<ConditionalType, boolean>();

/**
 * Whether a conditional type with this check or extends type waits for its type arguments, as TypeScript's
 * `isGenericType` decides: a type variable, an indexed access, a conditional type, a generic mapped type, or a union or
 * intersection holding one does; a type that holds type parameters only as type arguments or elements, as `T[][]`
 * does, does not.
 */
export function isGenericObjectOrIndexType(type: Type, except: readonly TypeParameter[] = []): boolean {
  switch (type.kind) {
    case 'typeParameter': {
      if (type.substitution)
        return (
          isGenericObjectOrIndexType(type.substitution.base, except) ||
          isGenericObjectOrIndexType(type.substitution.constraint, except)
        );
      return !except.some((parameter) => parameter.id === type.id);
    }
    case 'indexedAccess':
    case 'conditional':
    case 'keyof': {
      return true;
    }
    case 'templateLiteral':
    case 'stringMapping': {
      return typeParametersIn(type, except).length > 0;
    }
    case 'union':
    case 'intersection': {
      return type.types.some((member) => isGenericObjectOrIndexType(member, except));
    }
    case 'object': {
      return type.objectKind === 'mapped';
    }
    default: {
      return false;
    }
  }
}

/**
 * The branch a conditional type whose check type is not generic takes, as TypeScript decides it: the false one when no
 * type arguments could make the check type extend the extends type, the true one when every type argument would, and
 * neither, so that the type is deferred, otherwise.
 */
export function conditionalBranch(
  c: Checker,
  checkType: Type,
  extendsType: Type
): 'true' | 'false' | 'both' | undefined {
  // Every type extends `any` and `unknown`, `any` included; it extends any other type ambiguously.
  if (isAnyLike(extendsType) || isIntrinsic(extendsType, 'unknown')) return 'true';
  if (isAnyLike(checkType)) return 'both';
  const parameters = [...typeParametersIn(checkType, [], c.budget), ...typeParametersIn(extendsType, [], c.budget)];
  if (parameters.length === 0) return c.relations.isAssignable(checkType, extendsType) ? 'true' : 'false';
  const isAssignableWith = (map: (parameter: TypeParameter) => Type): boolean => {
    const mapper: Mapper = new Map(parameters.map((parameter) => [parameter.id, map(parameter)]));
    return c.relations.isAssignable(c.instantiate(checkType, mapper), c.instantiate(extendsType, mapper));
  };
  // The permissive probe must allow even `never` in positions a type variable can fill.
  if (!isAssignableWith(() => permissiveAnyType)) return 'false';
  // A type parameter without its constraint, so that `T[] extends string[]` with `T extends string` is deferred.
  if (isAssignableWith((parameter) => ({ ...parameter, id: newTypeId(), constraint: undefined }))) return 'true';
  return undefined;
}

export function conditionalDependsOnDistribution(c: Checker, root: ConditionalType): boolean {
  if (!root.distributive) return false;
  const cached = distributionDependencies.get(root);
  if (cached !== undefined) return cached;
  const dependent = checkConditionalDistributionDependency(c, root);
  distributionDependencies.set(root, dependent);
  return dependent;
}

function checkConditionalDistributionDependency(c: Checker, root: ConditionalType): boolean {
  const { checkType, declaration } = root;
  if (declaration && checkType.kind === 'typeParameter') {
    const depends = conditionalReferencesParameter(c, declaration, checkType);
    if (depends !== undefined) return depends;
  }
  return [root.trueType, root.falseType].some((branch) =>
    typeParametersIn(branch, [], c.budget).some((parameter) => parameter.id === checkType.id)
  );
}

function conditionalReferencesParameter(
  c: Checker,
  declaration: TreeNode,
  parameter: TypeParameter
): boolean | undefined {
  const symbol = c.scopeOf(declaration).lookupType(parameter.name);
  const scope =
    symbol?.typeKind === 'typeParameter' && c.signatures.typeParameterOfSymbol(symbol).id === parameter.id
      ? symbol.scope.node
      : undefined;
  let unresolved = false;
  for (const node of conditionalReferenceNodes(declaration)) {
    c.budget.spend();
    const refers =
      node.type === 'type_query' ? queryCapturesScope(c, node, scope) : referencesTypeParameter(c, node, parameter);
    if (refers) return true;
    if (refers === undefined) unresolved = true;
  }
  return unresolved ? undefined : false;
}

function* conditionalReferenceNodes(declaration: TreeNode): IterableIterator<TreeNode> {
  for (const field of ['right', 'consequence', 'alternative']) {
    const branch = declaration.childForFieldName(field);
    if (!branch) continue;
    yield branch;
    yield* branch.descendantsOfType(['type_identifier', 'this_type', 'type_query']);
  }
}

function queryCapturesScope(c: Checker, query: TreeNode, scope: TreeNode | undefined): boolean | undefined {
  if (!scope) return undefined;
  let name = query.namedChild(0);
  while (name?.type === 'member_expression') name = name.childForFieldName('object');
  if (name?.type !== 'identifier') return undefined;
  const value = c.scopeOf(name).lookupValue(name.text, c.budget);
  return value?.valueDeclarations.some(
    (declaration) =>
      declaration.tree === scope.tree &&
      declaration.startIndex >= scope.startIndex &&
      declaration.endIndex <= scope.endIndex
  );
}

function referencesTypeParameter(c: Checker, node: TreeNode, parameter: TypeParameter): boolean {
  if (node.type === 'this_type')
    return parameter.isThisType === true && c.classes.thisTypeInScope(node)?.id === parameter.id;
  if (node.type !== 'type_identifier' || node.text !== parameter.name) return false;
  const owner = node.parent;
  if (owner?.type === 'infer_type' && owner.namedChild(0)?.id === node.id) return false;
  if (
    owner &&
    (owner.type === 'type_parameter' || owner.type === 'mapped_type_clause') &&
    owner.childForFieldName('name')?.id === node.id
  )
    return false;
  const symbol = c.scopeOf(node).lookupType(parameter.name);
  const local = c.typeOperators.mappedOrInferParameter(node, parameter.name, symbol?.scope.node);
  if (local) return local.id === parameter.id;
  return symbol?.typeKind === 'typeParameter' && c.signatures.typeParameterOfSymbol(symbol).id === parameter.id;
}

/**
 * The type parameters, other than those in `except`, that instantiating a type reaches: those in its members, type
 * arguments, and elements, including the members of object and function types and the parts of mapped types, but not
 * the type parameters a signature or mapped type declares itself.
 */
export function typeParametersIn(
  type: Type,
  except: readonly TypeParameter[] = [],
  budget?: ExecutionBudget
): TypeParameter[] {
  const found = new Map<number, TypeParameter>();
  const declared = new Set<number>(except.map((parameter) => parameter.id));
  const seen = new Set<Type>();
  const pending = [type];
  while (pending.length > 0) {
    budget?.spend();
    const current = pending.pop() as Type;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of parameterChildren(current, declared)) pending.push(child);
    if (current.kind === 'typeParameter' && !current.substitution) found.set(current.id, current);
  }
  return [...found.values()].filter((parameter) => !declared.has(parameter.id));
}

function parameterChildren(type: Type, declared: Set<number>): readonly Type[] {
  if (type.kind === 'conditional') {
    for (const parameter of type.inferTypeParameters) declared.add(parameter.id);
    // Branches can refer to the conditional's own alias. Their lexical parameters are known without instantiating them.
    const outer = type.outerTypeParameters.map((parameter) => type.mapper?.get(parameter.id) ?? parameter);
    return [type.checkType, type.extendsType, ...outer];
  }
  const children = childTypes(type);
  return type.kind === 'object' ? [...children, ...objectMemberTypes(type, declared)] : children;
}

/** The types an anonymous or mapped object type holds, adding the type parameters it declares to `declared`. */
export function objectMemberTypes(type: ObjectType, declared?: Set<number>): Type[] {
  if (type.objectKind === 'mapped') {
    const mapped = type.mapped as MappedInfo;
    declared?.add(mapped.typeParameter.id);
    return [mapped.constraint, mapped.template, mapped.nameType, mapped.source].filter((child) => child !== undefined);
  }
  if (type.objectKind !== 'anonymous' || type.nonGeneric) return [];
  const structure = type.resolve();
  const signatures = [...structure.callSignatures, ...structure.constructSignatures];
  if (declared) {
    for (const signature of signatures) for (const parameter of signature.typeParameters) declared.add(parameter.id);
  }
  return [
    ...[...structure.properties.values()].map((property) => property.type()),
    ...signatures.flatMap((signature) => [
      ...signature.parameters.map((parameter) => parameter.type),
      signature.returnType(),
      ...(signature.thisType ? [signature.thisType] : []),
    ]),
    ...keyedIndexes(structure).flatMap((info) => [info.type, info.keyType]),
  ];
}

/** The types a type holds as members, type arguments, and elements. */
export function childTypes(type: Type): readonly Type[] {
  switch (type.kind) {
    case 'union': {
      // Reading the members of a deferred union instantiates them, as ever deeper ones for `type G<T> = T | G<T[]>[]`.
      return type.aliasMapper ? [...type.aliasMapper.values()] : type.types;
    }
    case 'intersection':
    case 'templateLiteral': {
      return type.types;
    }
    case 'object': {
      // Reading the members of a deferred alias reference instantiates them, as for a deferred union.
      if (type.aliasMapper) return [...type.aliasMapper.values()];
      if (type.resolveReference)
        return (type.outerTypeParameters ?? []).map((parameter) => type.mapper?.get(parameter.id) ?? parameter);
      if (type.objectKind === 'reference') return type.typeArguments ?? [];
      return (type.tuple?.elements ?? []).map((element) => element.type);
    }
    case 'indexedAccess': {
      return [type.objectType, type.indexType];
    }
    case 'typeParameter': {
      return type.substitution ? [type.substitution.base, type.substitution.constraint] : [];
    }
    case 'keyof':
    case 'stringMapping': {
      return [type.type];
    }
    default: {
      return [];
    }
  }
}

/** Whether a mapped type adds (1) or removes (-1) optionality, as TypeScript's `getCombinedMappedTypeOptionality` decides. */
export function mappedOptionality(type: Type | undefined): number {
  if (type?.kind === 'intersection') {
    const [first, ...rest] = type.types.map((member) => mappedOptionality(member));
    return rest.every((optionality) => optionality === first) ? (first ?? 0) : 0;
  }
  if (type?.kind !== 'object' || !type.mapped) return 0;
  const { optionalModifier, source } = type.mapped;
  if (optionalModifier) return optionalModifier === '+' ? 1 : -1;
  return mappedOptionality(source);
}
