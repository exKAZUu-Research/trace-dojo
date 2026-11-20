// code-gauge-allow-file fileNcss 600 -- Resolves related type operators sharing generic parameters and type construction.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker, Mapper } from './checker';
import { conditionalBranch, isGenericObjectOrIndexType, mappedOptionality } from './genericTypes';
import { IndexedAccessKeys } from './indexedAccessKeys';
import { addIndexInfo, applicableIndex, isNumericStringKey, isPatternKey } from './indexInfos';
import { applyModifier, mappedArrayOrTuple, type WithMappedSource } from './mappedArrays';
import { printedPropertyName } from './print';
import { named, templateFragmentText } from './syntax';
import { literalCombinations, mapText, placeholderTemplate, splicedSpans, type StringMapping } from './templateSpans';
import {
  constrainedTuple,
  hasVariadicRest,
  numericTupleIndex,
  tupleElementBeyond,
  variadicTupleIndex,
} from './tupleIndexes';
import {
  anonymousObject,
  anyType,
  bigintType,
  booleanType,
  type ConditionalType,
  createMapper,
  emptyStructure,
  errorType,
  type IndexedAccessType,
  type IndexInfo,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  isPropertyKeyLiteral,
  isTemplateOrStringMapping,
  literalType,
  type MappedInfo,
  neverType,
  newTypeId,
  nullType,
  numberType,
  type ObjectType,
  permissiveAnyType,
  type Property,
  propertyAccessType,
  stringType,
  type Structure,
  symbolType,
  type Type,
  typeMembers,
  type TypeParameter,
  undefinedType,
  unionOf,
  unknownType,
} from './types';

const propertyKeys = unionOf([stringType, numberType, symbolType]);
/** The types TypeScript's `templateConstraintType` allows in a template literal type's placeholder. */
const templatePlaceholders = unionOf([stringType, numberType, bigintType, booleanType, nullType, undefinedType]);
/** The type parameter `S extends string` that the declarations of `Uppercase<S>` and its kin take. */
const stringMappingParameter: TypeParameter = {
  kind: 'typeParameter',
  id: newTypeId(),
  name: 'S',
  constraint: () => stringType,
};

interface InferGroup {
  parameter: TypeParameter;
  declarations: TreeNode[];
}

interface ConditionalInstantiation {
  type: ConditionalType;
  outer: Mapper;
  mapper: Mapper;
  checkType: Type;
  extendsType: Type;
  inferTypeParameters: TypeParameter[];
}

/** Resolves the type operators: `keyof`, indexed access, conditional, mapped, and template literal types. */
export class TypeOperators {
  private readonly indexedAccessKeys: IndexedAccessKeys;
  private readonly deferredAccesses = new WeakMap<Type, WeakMap<Type, IndexedAccessType>>();
  private readonly constrainedTuples = new WeakMap<ObjectType, Type>();
  private readonly mappedParameters = new Map<number, TypeParameter>();
  /** The keys and name types of a mapped type that a name type maps to each name, by the structure being built. */
  private readonly mappedKeys = new WeakMap<Structure, Map<string, { keys: Type[]; nameTypes: Type[] }>>();
  private readonly inferGroups = new Map<number, Map<string, InferGroup>>();
  private readonly resolvingInferConstraints = new Set<number>();

  constructor(private readonly c: Checker) {
    this.indexedAccessKeys = new IndexedAccessKeys(c);
  }

  /** The type parameter of a mapped type or an `infer` that `name` refers to at `node`, if any. */
  mappedOrInferParameter(node: TreeNode, name: string, lexicalScope?: TreeNode): TypeParameter | undefined {
    let child: TreeNode = node;
    for (let current = node.parent; current && current.id !== lexicalScope?.id; current = current.parent) {
      const parameter = this.localParameterAt(current, child, name);
      if (parameter) return parameter;
      child = current;
    }
    return undefined;
  }

  /** The type parameter named `name` that `ancestor` introduces for its descendant `child`, if any. */
  private localParameterAt(ancestor: TreeNode, child: TreeNode, name: string): TypeParameter | undefined {
    switch (ancestor.type) {
      // As TypeScript's `resolveName`, the `infer` declarations of a conditional type are visible in its true branch
      // and each in its own constraint, but not elsewhere in its extends type.
      case 'conditional_type': {
        return this.fieldNameOf(ancestor, child) === 'consequence'
          ? this.inferGroupsOf(ancestor).get(name)?.parameter
          : undefined;
      }
      case 'infer_type': {
        const [declared, constraint] = named(ancestor);
        return declared.text === name && child.id === constraint?.id
          ? this.inferParameterFor(ancestor, name)
          : undefined;
      }
      case 'index_signature': {
        const clause = ancestor.namedChildren.find((member) => member?.type === 'mapped_type_clause');
        return clause &&
          clause.childForFieldName('name')?.text === name &&
          child.id !== clause.childForFieldName('type')?.id
          ? this.mappedParameterOf(clause)
          : undefined;
      }
      case 'mapped_type_clause': {
        return ancestor.childForFieldName('name')?.text === name && this.fieldNameOf(ancestor, child) === 'alias'
          ? this.mappedParameterOf(ancestor)
          : undefined;
      }
      default: {
        return undefined;
      }
    }
  }

  private fieldNameOf(parent: TreeNode, child: TreeNode): string | undefined {
    for (let index = 0; index < parent.childCount; index++) {
      if (parent.child(index)?.id === child.id) return parent.fieldNameForChild(index) ?? undefined;
    }
    return undefined;
  }

  private inferGroupsOf(conditional: TreeNode): Map<string, InferGroup> {
    let groups = this.inferGroups.get(conditional.id);
    if (groups) return groups;
    groups = new Map();
    this.inferGroups.set(conditional.id, groups);
    const extendsNode = conditional.childForFieldName('right');
    if (extendsNode) this.collectInferDeclarations(extendsNode, groups);
    return groups;
  }

  private collectInferDeclarations(node: TreeNode, groups: Map<string, InferGroup>): void {
    this.c.budget.spend();
    if (node.type === 'conditional_type') {
      // A nested conditional type's own extends clause introduces a separate scope.
      for (const fieldName of ['left', 'consequence', 'alternative']) {
        const child = node.childForFieldName(fieldName);
        if (child) this.collectInferDeclarations(child, groups);
      }
      return;
    }
    if (node.type === 'infer_type') this.addInferDeclaration(node, groups);
    for (const child of named(node)) this.collectInferDeclarations(child, groups);
  }

  private addInferDeclaration(node: TreeNode, groups: Map<string, InferGroup>): void {
    const name = named(node)[0]?.text;
    if (!name) return;
    const existing = groups.get(name);
    if (existing) {
      existing.declarations.push(node);
      return;
    }
    const declarations = [node];
    const parameter: TypeParameter = {
      kind: 'typeParameter',
      id: newTypeId(),
      name,
      constraint: () => this.inferConstraint(parameter, declarations),
    };
    groups.set(name, { parameter, declarations });
  }

  checkInferConstraints(node: TreeNode): void {
    const name = named(node)[0]?.text;
    if (!name) return;
    const group = this.inferGroupFor(node, name);
    if (!group || group.declarations.length < 2 || group.declarations[0].id !== node.id) return;
    const constraints = group.declarations.flatMap((declaration) => named(declaration).slice(1, 2));
    if (constraints.length === 0) return;
    const expected = this.c.constraintOf(group.parameter);
    if (
      !expected ||
      !constraints.some(
        (constraint) => !this.c.relations.identical(this.c.typeNodes.typeFromNode(constraint), expected)
      )
    )
      return;
    for (const declaration of group.declarations) {
      this.c.error(named(declaration)[0], `'${name}' の宣言にはすべて同じ制約を指定してください。`);
    }
  }

  private inferConstraint(parameter: TypeParameter, declarations: TreeNode[]): Type | undefined {
    if (this.resolvingInferConstraints.has(parameter.id)) return undefined;
    this.resolvingInferConstraints.add(parameter.id);
    try {
      const explicit = declarations.map((node) => named(node)[1]).find((node) => node !== undefined);
      if (explicit) {
        const type = this.c.typeNodes.typeFromNode(explicit);
        return isAnyLike(type) && type !== errorType ? unknownType : type;
      }
      const implied = declarations.flatMap((node) => this.impliedInferConstraint(node, parameter) ?? []);
      return implied.length > 0 ? intersectionOf(implied, this.c) : undefined;
    } finally {
      this.resolvingInferConstraints.delete(parameter.id);
    }
  }

  private impliedInferConstraint(node: TreeNode, parameter: TypeParameter): Type | undefined {
    let current = node;
    while (current.parent?.type === 'parenthesized_type') current = current.parent;
    const { parent } = current;
    if (parent?.type === 'template_type') return stringType;
    if (parent?.type === 'mapped_type_clause') return propertyKeys;
    const holder = parent?.type === 'type_annotation' ? parent.parent : parent;
    const isRest =
      holder?.type === 'rest_type' ||
      (holder?.type === 'required_parameter' &&
        (holder.childForFieldName('pattern') ?? holder.childForFieldName('name'))?.type === 'rest_pattern');
    if (isRest) return this.c.arrayType(unknownType);
    return this.c.typeNodes.inferConstraintFromReference(current, parameter);
  }

  inferParameterFor(node: TreeNode, name: string): TypeParameter | undefined {
    return this.inferGroupFor(node, name)?.parameter;
  }

  private inferGroupFor(node: TreeNode, name: string): InferGroup | undefined {
    let child = node;
    for (let current = node.parent; current; current = current.parent) {
      if (current.type === 'conditional_type' && current.childForFieldName('right')?.id === child.id)
        return this.inferGroupsOf(current).get(name);
      child = current;
    }
    return undefined;
  }

  mappedParameterOf(clause: TreeNode): TypeParameter {
    let parameter = this.mappedParameters.get(clause.id);
    if (!parameter) {
      const constraintNode = clause.childForFieldName('type');
      parameter = {
        kind: 'typeParameter',
        id: newTypeId(),
        name: clause.childForFieldName('name')?.text ?? 'K',
        constraint: constraintNode ? () => this.c.typeNodes.typeFromNode(constraintNode) : undefined,
      };
      this.mappedParameters.set(clause.id, parameter);
    }
    return parameter;
  }

  mappedTypeFromNode(signature: TreeNode): Type {
    const clause = signature.namedChildren.find((child) => child?.type === 'mapped_type_clause') as TreeNode;
    const typeParameter = this.mappedParameterOf(clause);
    this.c.typeNodes.eagerConstraints.record(typeParameter);
    const constraintNode = clause.childForFieldName('type');
    const aliasNode = clause.childForFieldName('alias');
    const typeNode = signature.childForFieldName('type');
    const constraint = constraintNode ? this.c.typeNodes.typeFromNode(constraintNode) : neverType;
    const nameType = aliasNode ? this.c.typeNodes.typeFromNode(aliasNode) : undefined;
    // As TypeScript's `checkMappedType`, a name type, or else the keys, must be property keys.
    const keysNode = aliasNode ?? constraintNode;
    if (keysNode) this.reportUnlessAssignable(keysNode, nameType ?? constraint, propertyKeys);
    const checker = this.c;
    const source = this.homomorphicSource(constraintNode, constraint);
    return this.mappedType({
      typeParameter,
      source,
      homomorphic: constraint.kind === 'keyof' && source?.kind === 'typeParameter' ? true : undefined,
      constraint,
      nameType,
      get template() {
        return checker.typeNodes.annotationType(typeNode) ?? anyType;
      },
      ...mappedModifiers(signature, typeNode),
    });
  }

  /** The type whose keys a mapped type maps: `T` for keys `keyof T` or a type parameter constrained to them. */
  private homomorphicSource(constraintNode: TreeNode | null, constraint: Type): Type | undefined {
    if (constraintNode?.type === 'index_type_query') return this.c.typeNodes.typeFromNode(named(constraintNode)[0]);
    if (constraint.kind !== 'typeParameter') return undefined;
    const outer = constraint.constraint?.();
    return outer?.kind === 'keyof' ? outer.type : undefined;
  }

  /**
   * Reports a type written at `node` that is not assignable to `target`, once the types being resolved are complete, and
   * even while a check that resolves it on demand is silent, as TypeScript checks every type node.
   */
  private reportUnlessAssignable(node: TreeNode, type: Type, target: Type): void {
    this.c.typeNodes.interfaceBases.afterResolving(() => {
      if (this.c.relations.isAssignable(type, target)) return;
      this.c.errorWhileResolving(node, this.c.expressions.elaboration.typeRelationMessage(type, target));
    });
  }

  /**
   * A mapped type, resolved to an object type once its keys are known. `withSource` instantiates the generic mapped type
   * that `info` instantiates, with another type for its source.
   */
  mappedType(info: MappedInfo, withSource?: WithMappedSource): Type {
    const { source } = info;
    if (withSource && source?.kind === 'union') return unionOf(source.types.map(withSource));
    if (
      withSource &&
      source &&
      (source.kind === 'intrinsic' || source.kind === 'literal' || isTemplateOrStringMapping(source)) &&
      !isAnyLike(source) &&
      !isIntrinsic(source, 'unknown')
    )
      return source;
    if (!this.hasDeferredMappedKeys(info) && this.c.relations.isGeneric(info.constraint)) {
      return {
        kind: 'object',
        id: newTypeId(),
        objectKind: 'mapped',
        mapped: info,
        resolve: () => emptyStructure(),
      };
    }
    if (info.homomorphic && source?.kind === 'object' && this.c.isArrayOrTuple(source) && !info.nameType) {
      return mappedArrayOrTuple(this.c, info, source, withSource);
    }
    return anonymousObject(() => this.mappedStructure(info), {
      isResolvedMappedType: true,
      mappedOptional: info.optionalModifier === '+' ? true : undefined,
      mappedKeys: info.nameType ? undefined : () => info.constraint,
    });
  }

  private hasDeferredMappedKeys(info: MappedInfo): boolean {
    const { source } = info;
    return !!(
      info.homomorphic &&
      source?.kind === 'object' &&
      source.resolveReference &&
      !this.c.isArrayOrTuple(source)
    );
  }

  private mappedStructure(info: MappedInfo): Structure {
    const structure = emptyStructure();
    const { constraint } = info;
    for (const key of constraint.kind === 'union' ? constraint.types : [constraint]) {
      this.c.budget.spend();
      const mapper: Mapper = new Map([[info.typeParameter.id, key]]);
      const nameType = info.nameType ? this.c.instantiate(info.nameType, mapper) : key;
      for (const nameMember of nameType.kind === 'union' ? nameType.types : [nameType]) {
        this.addMappedMember(structure, info, mapper, nameMember);
      }
    }
    return structure;
  }

  private addMappedMember(structure: Structure, info: MappedInfo, mapper: Mapper, nameMember: Type): void {
    if (nameMember.kind === 'literal' && typeof nameMember.value !== 'boolean') {
      const name = String(nameMember.value);
      const key = mapper.get(info.typeParameter.id) as Type;
      let names = this.mappedKeys.get(structure);
      if (!names) this.mappedKeys.set(structure, (names = new Map()));
      // Keys that a name type maps to one name share it, as TypeScript maps the union of those keys.
      const collided = structure.properties.has(name) ? names.get(name) : undefined;
      const keys = [...(collided?.keys ?? []), key];
      const nameTypes = [...(collided?.nameTypes ?? []), nameMember];
      names.set(name, { keys, nameTypes });
      structure.properties.set(name, this.mappedProperty(info, keys, name, unionOf(nameTypes)));
      return;
    }
    const key = isAnyLike(nameMember) ? stringType : nameMember;
    if (key !== stringType && key !== numberType && key !== symbolType && !isPatternKey(key)) return;
    const source =
      !info.readonlyModifier && info.source ? applicableIndex(this.c, this.c.structureOf(info.source), key) : undefined;
    const type = this.c.instantiate(info.template, mapper);
    addIndexInfo(
      structure,
      key,
      {
        type: info.optionalModifier === '+' ? unionOf([type, undefinedType]) : type,
        readonly: applyModifier(info.readonlyModifier, source?.readonly ?? false),
      },
      true
    );
  }

  /** The property that `keys` map to, which takes the modifiers of the source property the first key names. */
  private mappedProperty(info: MappedInfo, keys: Type[], name: string, nameType: Type): Property {
    const [firstKey] = keys;
    const key = unionOf(keys);
    const sourceName =
      firstKey.kind === 'literal' && typeof firstKey.value !== 'boolean' ? String(firstKey.value) : undefined;
    const sourceProperty =
      info.source && sourceName !== undefined ? this.c.propertyOf(info.source, sourceName) : undefined;
    let type: Type | undefined;
    return {
      name,
      type: () => {
        if (type) return type;
        let mappedType = this.c.instantiate(info.template, new Map([[info.typeParameter.id, key]]));
        if (info.optionalModifier === '-' && sourceProperty?.optional)
          mappedType = this.c.relations.removeUndefined(mappedType);
        type = mappedType;
        return type;
      },
      optional: applyModifier(info.optionalModifier, sourceProperty?.optional ?? false),
      readonly: applyModifier(info.readonlyModifier, sourceProperty?.readonly ?? false),
      isMethod: false,
      visibility: 'public',
      nameType,
    };
  }

  keyofType(type: Type): Type {
    // As TypeScript's `getIndexTypeForMappedType`, `keyof { [P in K]: X }` is `K`.
    if (type.kind === 'object' && type.mapped && !type.mapped.nameType) return type.mapped.constraint;
    if (isGenericObjectOrIndexType(type) || (type.kind === 'object' && hasVariadicRest(type)))
      return { kind: 'keyof', id: newTypeId(), type };
    if (isAnyLike(type) || isIntrinsic(type, 'never')) return propertyKeys;
    if (type.kind === 'union')
      return intersectionOf(
        type.types.map((member) => this.keyofType(member)),
        this.c
      );
    if (type.kind === 'intersection') return unionOf(type.types.map((member) => this.keyofType(member)));
    if (type.kind !== 'object') {
      if (type.kind === 'intrinsic' && ['unknown', 'null', 'undefined', 'void', 'object'].includes(type.name))
        return neverType;
      return this.keyofType(this.c.apparentType(type));
    }
    // TypeScript's `getIndexTypeForMappedType` gives a mapped type's constraint, as `string` for `Record<string, T>`.
    return type.mappedKeys?.() ?? this.memberKeys(type.resolve());
  }

  /** The keys available for every instantiation of the object in a deferred `keyof`. */
  guaranteedKeys(type: Type, visiting = new Set<Type>()): Type {
    this.c.budget.spend();
    if (type === errorType || visiting.has(type)) return neverType;
    visiting.add(type);
    try {
      if (type.kind === 'union')
        return intersectionOf(
          type.types.map((member) => this.guaranteedKeys(member, visiting)),
          this.c
        );
      if (type.kind === 'intersection')
        return unionOf(type.types.map((member) => this.guaranteedKeys(member, visiting)));
      if (type.kind === 'object' && type.tuple) return this.memberKeys(type.resolve());
      if (type.kind === 'object' && type.mapped) return this.guaranteedMappedKeys(type.mapped, visiting);
      const constraint = this.c.baseConstraint(type);
      if (type.kind === 'typeParameter' && isAnyLike(constraint)) return neverType;
      if (constraint !== type) return this.guaranteedKeys(constraint, visiting);
      const keys = this.keyofType(type);
      return keys.kind === 'keyof' ? this.guaranteedKeys(keys.type, visiting) : keys;
    } finally {
      visiting.delete(type);
    }
  }

  private guaranteedMappedKeys(info: MappedInfo, visiting: Set<Type>): Type {
    const lowerBound = this.lowerBoundOfKeyType(info.constraint, visiting);
    const { nameType, typeParameter } = info;
    if (!nameType) return lowerBound;
    return unionOf(
      [...typeMembers(info.constraint), ...typeMembers(lowerBound)].map((key) =>
        this.c.instantiate(nameType, new Map([[typeParameter.id, key]]))
      )
    );
  }

  private lowerBoundOfKeyType(type: Type, visiting: Set<Type>): Type {
    this.c.budget.spend();
    if (type.kind === 'keyof') return this.guaranteedKeys(type.type, visiting);
    if (type.kind === 'union') return unionOf(type.types.map((member) => this.lowerBoundOfKeyType(member, visiting)));
    if (type.kind === 'intersection')
      return intersectionOf(
        type.types.map((member) => this.lowerBoundOfKeyType(member, visiting)),
        this.c
      );
    return type;
  }

  private memberKeys(structure: Structure): Type {
    const keys = indexKeys(structure);
    // keyof lists the public members only.
    for (const property of structure.properties.values()) {
      if (property.isPrivateName || property.visibility !== 'public') continue;
      keys.push(this.propertyKeyType(property));
    }
    return unionOf(keys);
  }

  /** The key type naming a property, as TypeScript's `getLiteralTypeFromProperty` gives it. */
  propertyKeyType(property: Property): Type {
    if (property.nameType) return property.nameType;
    const name = property.declaration?.childForFieldName('name') ?? property.declaration?.childForFieldName('key');
    if (name?.type === 'computed_property_name') {
      const key = this.c.flow.probe(() => this.c.silently(() => this.c.expressions.check(named(name)[0])));
      if (isPropertyKeyLiteral(key) && String(key.value) === property.name) return key;
    }
    return name?.type === 'number' ? literalType(Number(property.name)) : literalType(property.name);
  }

  /**
   * Whether a property is named by a number, as `0: T`, `[1]: T`, or `[n]: T` for a constant `n` of a number literal
   * type, which `keyof` gives as a number.
   */
  isNumericKey(property: Property): boolean {
    const key = this.propertyKeyType(property);
    return (key.kind === 'union' ? key.types : [key]).some(
      (member) => member.kind === 'literal' && typeof member.value === 'number'
    );
  }

  /** `object[index]`, reporting a missing property at `node` when given. */
  indexedAccess(object: Type, index: Type, node?: TreeNode): Type {
    if (isAnyLike(object)) return object === errorType ? errorType : this.indexedAnyAccess(index, node);
    const mapped = this.indexedMappedAccess(object, index, node);
    if (mapped !== undefined) return mapped;
    const variadic = variadicTupleIndex(object, index);
    if (variadic && node && !this.isVariadicTupleKey(object, index)) {
      this.c.error(node, `型 '${this.c.print(index)}' は型 '${this.c.print(object)}' のインデックスに使えません。`);
      return errorType;
    }
    if (isGenericObjectOrIndexType(object) || isGenericObjectOrIndexType(index) || variadic)
      return this.c.relations.stringIndexByGenericKey(object, index)?.type ?? this.deferredAccess(object, index);
    if (index.kind === 'union') return unionOf(index.types.map((member) => this.indexedAccess(object, member, node)));
    if (isPropertyKeyLiteral(index)) return this.propertyAccess(object, index.value, node);
    const applicable =
      applicableIndex(this.c, this.c.structureOf(object), index) ?? this.unreportedStringIndex(object, index, node);
    if (applicable) return applicable.type;
    if (index === neverType) return neverType;
    if (node)
      this.c.error(node, `型 '${this.c.print(index)}' は型 '${this.c.print(object)}' のインデックスに使えません。`);
    return errorType;
  }

  private indexedAnyAccess(index: Type, node: TreeNode | undefined): Type {
    if (!node || isGenericObjectOrIndexType(index)) return anyType;
    let result: Type = anyType;
    for (const key of typeMembers(index)) {
      if (this.c.relations.isAssignable(key, propertyKeys)) continue;
      this.c.error(node, `型 '${this.c.print(key)}' はインデックスに使えません。`);
      result = errorType;
    }
    return result;
  }

  private indexedMappedAccess(object: Type, index: Type, node: TreeNode | undefined): Type | undefined {
    const mapped = object.kind === 'object' && object.objectKind === 'mapped' ? object.mapped : undefined;
    if (!mapped || mapped.nameType) return undefined;
    if (!this.isMappedKey(index, mapped.constraint)) {
      if (!node) return undefined;
      this.c.error(node, `型 '${this.c.print(index)}' は型 '${this.c.print(object)}' のインデックスに使えません。`);
      return errorType;
    }
    if (
      node?.type !== 'subscript_expression' &&
      mapped.optionalModifier !== '+' &&
      this.c.typeNodes.eagerConstraints.hasDeferredOperands(object)
    )
      return this.deferredAccess(object, index);
    if (
      node?.type === 'subscript_expression' ||
      (!mapped.source && !this.c.inference.mentions(mapped.template, mapped.typeParameter))
    )
      return this.substituteIndexedMapped(mapped, index);
    return this.deferredAccess(object, index);
  }

  private isVariadicTupleKey(object: ObjectType, index: Type): boolean {
    const keys = this.keyofType(object);
    return typeMembers(index).every((key) => isNumericStringKey(key) || this.c.relations.isAssignable(key, keys));
  }

  variadicIndexConstraint(access: IndexedAccessType, indexType: Type): Type | undefined {
    const { objectType } = access;
    if (objectType.kind !== 'object' || !hasVariadicRest(objectType)) return undefined;
    if (indexType.kind === 'union') return unionOf(indexType.types.map((key) => this.indexedAccess(objectType, key)));
    const numeric = numericTupleIndex(this.c, objectType, indexType);
    if (numeric) return numeric;
    const bound = this.tupleConstraint(objectType);
    if (bound === objectType && indexType === access.indexType) return undefined;
    return this.indexedAccess(bound, indexType);
  }

  tupleConstraint(type: ObjectType): Type {
    let bound = this.constrainedTuples.get(type);
    if (!bound) {
      this.constrainedTuples.set(type, type);
      bound = constrainedTuple(this.c, type);
      this.constrainedTuples.set(type, bound);
    }
    return bound;
  }

  private deferredAccess(object: Type, index: Type): IndexedAccessType {
    let indexes = this.deferredAccesses.get(object);
    if (!indexes) {
      indexes = new WeakMap();
      this.deferredAccesses.set(object, indexes);
    }
    const existing = indexes.get(index);
    if (existing) return existing;
    const access: IndexedAccessType = { kind: 'indexedAccess', id: newTypeId(), objectType: object, indexType: index };
    indexes.set(index, access);
    return access;
  }

  mappedPropertyOf(object: ObjectType, name: string): Property | undefined {
    const info = object.objectKind === 'mapped' ? object.mapped : undefined;
    if (!info || info.nameType || !info.source) return undefined;
    const property = this.c.propertyOf(info.source, name);
    if (!property) return undefined;
    const key = this.propertyKeyType(property);
    return this.isMappedKey(key, info.constraint) ? this.mappedProperty(info, [key], name, key) : undefined;
  }

  private isMappedKey(index: Type, keys: Type): boolean {
    if (this.c.relations.isAssignable(index, keys)) return true;
    if (index.kind === 'union') return index.types.every((member) => this.isMappedKey(member, keys));
    if (keys.kind === 'union') return keys.types.some((member) => this.isMappedKey(index, member));
    if (keys.kind === 'keyof' && keys.type.kind === 'typeParameter')
      return !this.indexedAccessKeys.isInvalid(keys.type, index, () => []);
    return (
      keys.kind === 'conditional' &&
      !this.c.relations.isGeneric(keys.extendsType) &&
      isIntrinsic(keys.trueType, 'never') &&
      this.c.relations.identical(keys.checkType, keys.falseType) &&
      conditionalBranch(this.c, index, keys.extendsType) === 'false' &&
      this.isMappedKey(index, keys.checkType)
    );
  }

  mappedIndexConstraint({ objectType, indexType }: IndexedAccessType): Type | undefined {
    const mapped = objectType.kind === 'object' ? objectType.mapped : undefined;
    if (!mapped || mapped.nameType) return undefined;
    const keys = typeMembers(indexType);
    return unionOf(keys.map((key) => this.substituteIndexedMapped(mapped, key)));
  }

  /**
   * As TypeScript's `substituteIndexedMappedType`, a mapped type's template for `index`, with `undefined` when the
   * mapped type, or the one whose modifiers it keeps, adds `?`.
   */
  private substituteIndexedMapped(mapped: MappedInfo, index: Type): Type {
    const type = this.c.instantiate(mapped.template, new Map([[mapped.typeParameter.id, index]]));
    const optional = mapped.optionalModifier ? mapped.optionalModifier === '+' : mappedOptionality(mapped.source) > 0;
    return optional ? unionOf([type, undefinedType]) : type;
  }

  private propertyAccess(object: Type, key: string | number | symbol, node: TreeNode | undefined): Type {
    const name = String(key);
    const property = this.c.propertyOf(object, name);
    if (property) return propertyAccessType(property);
    const element = tupleElementBeyond(this.c, object, name, node);
    if (element) return element;
    const structure = this.c.structureOf(object);
    const applicable =
      typeof key === 'symbol'
        ? (structure.symbolIndex ?? this.unreportedStringIndex(object, literalType(key), node))
        : applicableIndex(this.c, structure, literalType(key));
    if (applicable) return applicable.type;
    if (node)
      this.c.error(
        node,
        `プロパティ '${printedPropertyName(name, literalType(key))}' は型 '${this.c.print(object)}' にありません。`
      );
    return errorType;
  }

  /**
   * The string index signature that an access with no node to report at reads for any key, a symbol included, as
   * TypeScript's `getPropertyTypeForIndexType` does when it computes the constraint of `T[keyof T]`.
   */
  private unreportedStringIndex(object: Type, index: Type, node: TreeNode | undefined): IndexInfo | undefined {
    if (node || !this.c.relations.isAssignable(index, unionOf([stringType, numberType, symbolType]))) return undefined;
    return this.c.structureOf(object).stringIndex;
  }

  conditionalTypeFromNode(node: TreeNode): Type {
    const check = node.childForFieldName('left') as TreeNode;
    const extendsNode = node.childForFieldName('right') as TreeNode;
    const trueNode = node.childForFieldName('consequence') as TreeNode;
    const falseNode = node.childForFieldName('alternative') as TreeNode;
    const checkType = this.c.typeNodes.typeFromNode(check);
    const checker = this.c;
    const conditional: ConditionalType = {
      kind: 'conditional',
      id: newTypeId(),
      declaration: node,
      checkType,
      extendsType: this.c.typeNodes.typeFromNode(extendsNode),
      get trueType() {
        return checker.typeNodes.typeFromNode(trueNode);
      },
      get falseType() {
        return checker.typeNodes.typeFromNode(falseNode);
      },
      inferTypeParameters: [...this.inferGroupsOf(node).values()].map(({ parameter }) => parameter),
      outerTypeParameters: this.typeParametersInScope(node),
      distributive: checkType.kind === 'typeParameter',
    };
    return this.resolveConditional(conditional, new Map());
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Each enclosing binding has its own scope rule.
  typeParametersInScope(node: TreeNode): TypeParameter[] {
    const parameters = this.c.signatures.outerTypeParametersOf(node) ?? [];
    const receiver = this.c.classes.thisTypeInScope(node);
    if (receiver?.kind === 'typeParameter') parameters.push(receiver);
    let child = node;
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (
        ancestor.type === 'conditional_type' &&
        ['right', 'consequence'].includes(this.fieldNameOf(ancestor, child) ?? '')
      )
        for (const { parameter } of this.inferGroupsOf(ancestor).values()) parameters.push(parameter);
      if (ancestor.type === 'index_signature') {
        const clause = named(ancestor).find((member) => member.type === 'mapped_type_clause');
        if (clause?.childForFieldName('name') && child.id !== clause.childForFieldName('type')?.id)
          parameters.push(this.mappedParameterOf(clause));
      }
      child = ancestor;
    }
    return parameters;
  }

  /** The mapper that applies `first` and then `second`. */
  private compose(first: Mapper, second: Mapper): Mapper {
    const composed = createMapper([], second.preserveLiterals);
    for (const [id, type] of first) composed.set(id, this.c.instantiate(type, second));
    for (const [id, type] of second) if (!composed.has(id)) composed.set(id, type);
    return composed;
  }

  resolveConditional(type: ConditionalType, outer: Mapper, forConstraint = false): Type {
    // An instantiated copy resolves from its declaration, so that it still distributes over its check type parameter.
    if (type.root && type.mapper)
      return this.resolveConditional(type.root, this.compose(type.mapper, outer), forConstraint);
    const checkType = this.c.instantiate(type.checkType, outer);
    if (type.distributive && checkType.kind === 'union') {
      return unionOf(
        checkType.types.map((member) =>
          this.resolveConditional(
            type,
            createMapper([...outer, [(type.checkType as TypeParameter).id, member]], outer.preserveLiterals),
            forConstraint
          )
        ),
        false,
        outer.preserveLiterals
      );
    }
    if (type.distributive && isIntrinsic(checkType, 'never')) return neverType;
    // The `infer` type parameters belong to this conditional type, so each instantiation gets its own.
    const mapper = createMapper(outer, outer.preserveLiterals);
    const inferTypeParameters = type.inferTypeParameters.map((parameter): TypeParameter => ({
      ...parameter,
      id: newTypeId(),
    }));
    for (const [index, parameter] of type.inferTypeParameters.entries())
      mapper.set(parameter.id, inferTypeParameters[index]);
    const extendsType = this.c.instantiate(type.extendsType, mapper);
    if (checkType === permissiveAnyType || extendsType === permissiveAnyType) return permissiveAnyType;
    return this.resolveConditionalBranch(
      { type, outer, mapper, checkType, extendsType, inferTypeParameters },
      forConstraint
    );
  }

  private resolveConditionalBranch(deferred: ConditionalInstantiation, forConstraint: boolean): Type {
    const { type, outer, mapper, checkType, extendsType, inferTypeParameters } = deferred;
    if (isGenericObjectOrIndexType(checkType) || isGenericObjectOrIndexType(extendsType, inferTypeParameters))
      return this.deferredConditional(deferred);
    const inferred = this.inferredMapper(deferred, forConstraint);
    const falseType = (): Type => this.c.instantiate(type.falseType, outer);
    if (!inferred) return forConstraint ? this.deferredConditional(deferred) : falseType();
    const trueType = (): Type => this.c.instantiate(this.c.instantiate(type.trueType, mapper), inferred);
    const inferredExtends = this.c.instantiate(extendsType, inferred);
    const branch = conditionalBranch(this.c, checkType, inferredExtends);
    if (branch === undefined || (forConstraint && this.isInconclusiveConstraint(branch, checkType, inferredExtends)))
      return this.deferredConditional(deferred);
    if (branch === 'false') return falseType();
    return branch === 'true' ? trueType() : unionOf([trueType(), falseType()], false, outer.preserveLiterals);
  }

  private isInconclusiveConstraint(branch: 'true' | 'false' | 'both', bound: Type, extendsType: Type): boolean {
    return (
      branch === 'both' ||
      extendsType === errorType ||
      (branch === 'false' &&
        !isIntrinsic(extendsType, 'never') &&
        typeMembers(extendsType).some((member) => this.c.relations.isAssignable(member, bound)))
    );
  }

  /**
   * The mapper that also gives the `infer` type parameters what the check type infers for them, or undefined when a
   * literal fails to match a template literal, which takes the false branch.
   */
  private inferredMapper(
    { mapper, inferTypeParameters, checkType, extendsType }: ConditionalInstantiation,
    forConstraint: boolean
  ): Mapper | undefined {
    const inferred = createMapper(mapper, mapper.preserveLiterals);
    if (inferTypeParameters.length === 0) return inferred;
    const inferences = this.c.inference.inferFromTypes(inferTypeParameters, checkType, extendsType, mapper);
    if (
      extendsType.kind === 'templateLiteral' &&
      (forConstraint || checkType.kind === 'literal') &&
      inferTypeParameters.some((parameter) => !inferences.has(parameter.id))
    )
      return undefined;
    for (const [id, type] of this.c.inference.completeInference(inferTypeParameters, inferences, mapper)) {
      inferred.set(id, type);
    }
    return inferred;
  }

  private deferredConditional({
    type,
    outer,
    mapper,
    checkType,
    extendsType,
    inferTypeParameters,
  }: ConditionalInstantiation): Type {
    if (outer.size === 0) return type;
    const checker = this.c;
    return {
      kind: 'conditional',
      distributive: type.distributive,
      aliasName: type.aliasName,
      aliasArguments: type.aliasArguments?.map((argument) => checker.instantiate(argument, outer)),
      id: newTypeId(),
      checkType,
      extendsType,
      get trueType() {
        return checker.instantiate(type.trueType, mapper);
      },
      get falseType() {
        return checker.instantiate(type.falseType, outer);
      },
      inferTypeParameters,
      outerTypeParameters: type.outerTypeParameters,
      root: type,
      mapper: outer,
    };
  }

  templateLiteralFromNode(node: TreeNode): Type {
    const texts: string[] = [''];
    const types: Type[] = [];
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === 'template_type') {
        const placeholder = this.c.typeNodes.typeFromNode(named(child)[0]);
        // As TypeScript's `checkTemplateLiteralType`, each placeholder must be a type a template can spell.
        this.reportUnlessAssignable(named(child)[0], placeholder, templatePlaceholders);
        types.push(placeholder);
        texts.push('');
      } else {
        texts[texts.length - 1] += templateFragmentText(child);
      }
    }
    return this.templateLiteral(texts, types, node);
  }

  templateLiteral(spelledTexts: string[], spelledTypes: Type[], node?: TreeNode): Type {
    const { texts, types } = splicedSpans(spelledTexts, spelledTypes, this.c.budget);
    if (types.some((type) => isIntrinsic(type, 'never'))) return neverType;
    // Each union expands into one literal per member, up to the size TypeScript represents.
    const size = types.reduce((product, type) => product * (type.kind === 'union' ? type.types.length : 1), 1);
    if (size >= 100_000) {
      this.c.reportTypeComplexity(node);
      return errorType;
    }
    const combinations = literalCombinations(texts, types, this.c.budget);
    if (combinations) return unionOf(combinations.map((text) => literalType(text)));
    const union = types.find((type) => type.kind === 'union');
    if (union?.kind === 'union')
      return unionOf(
        union.types.map((member) => this.templateLiteral(texts, types.with(types.indexOf(union), member)))
      );
    if (types.some((type) => this.c.relations.isGeneric(type)))
      return { kind: 'templateLiteral', id: newTypeId(), texts, types };
    return placeholderTemplate(texts, types);
  }

  /** `Uppercase<T>` and its kin written at `node`, whose argument must be a string as their declarations constrain it. */
  stringMappingFromNode(node: TreeNode, mapping: StringMapping, argument: Type): Type {
    this.c.typeNodes.checkWrittenTypeArgumentConstraints(node, [stringMappingParameter], [argument]);
    return this.stringMapping(mapping, argument);
  }

  /** `Uppercase<T>` and its kin, which TypeScript pushes into a template literal's texts and placeholders. */
  stringMapping(mapping: StringMapping, type: Type): Type {
    if (isIntrinsic(type, 'never')) return type;
    if (type.kind === 'union') return unionOf(type.types.map((member) => this.stringMapping(mapping, member)));
    if (type.kind === 'literal' && typeof type.value === 'string')
      return literalType(mapText(this.c.budget, mapping, type.value));
    if (type.kind === 'templateLiteral') {
      const { texts, types } = type;
      if (mapping === 'Uppercase' || mapping === 'Lowercase') {
        return this.templateLiteral(
          texts.map((text) => mapText(this.c.budget, mapping, text)),
          types.map((member) => this.stringMapping(mapping, member))
        );
      }
      // Capitalizing changes only the first character, which the first text or else the first placeholder holds.
      return texts[0] === ''
        ? this.templateLiteral(texts, [this.stringMapping(mapping, types[0]), ...types.slice(1)])
        : this.templateLiteral([mapText(this.c.budget, mapping, texts[0]), ...texts.slice(1)], types);
    }
    if (type.kind === 'stringMapping' && type.mapping === mapping) return type;
    if (isAnyLike(type)) return type;
    // A `number` or `bigint` placeholder is mapped as the template `${number}` it spells.
    const inner =
      isIntrinsic(type, 'number') || isIntrinsic(type, 'bigint') ? this.templateLiteral(['', ''], [type]) : type;
    return { kind: 'stringMapping', id: newTypeId(), mapping, type: inner };
  }
}

/** The `readonly` and `?` modifiers that a mapped type's signature adds (`+`) or removes (`-`). */
function mappedModifiers(
  signature: TreeNode,
  typeNode: TreeNode | null
): Pick<MappedInfo, 'readonlyModifier' | 'optionalModifier'> {
  const tokens = signature.children.filter((child) => child !== null && !child.isNamed).map((child) => child?.type);
  const readonlyIndex = tokens.indexOf('readonly');
  const readonlyModifier = readonlyIndex === -1 ? undefined : tokens[readonlyIndex - 1] === '-' ? '-' : '+';
  if (typeNode?.type === 'omitting_type_annotation') return { readonlyModifier, optionalModifier: '-' };
  const adds = typeNode?.type === 'adding_type_annotation' || typeNode?.type === 'opting_type_annotation';
  return { readonlyModifier, optionalModifier: adds ? '+' : undefined };
}

/** The key types that the index signatures of a structure give its `keyof`, where a string index takes numbers too. */
function indexKeys(structure: Structure): Type[] {
  const keys: Type[] = [];
  if (structure.stringIndex) keys.push(stringType, numberType);
  else if (structure.numberIndex) keys.push(numberType);
  if (structure.symbolIndex) keys.push(symbolType);
  keys.push(...(structure.patternIndexes ?? []).map((info) => info.keyType));
  return keys;
}
