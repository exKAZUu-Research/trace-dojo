// code-gauge-allow-file fileNcss 427 -- Resolves related type operators sharing generic parameters and type construction.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker, Mapper } from './checker';
import { conditionalBranch, isGenericObjectOrIndexType, mappedOptionality } from './genericTypes';
import { IndexedAccessKeys } from './indexedAccessKeys';
import { applicableIndex, isPatternKey } from './indexInfos';
import { applyModifier, mappedArrayOrTuple, type WithMappedSource } from './mappedArrays';
import { printedPropertyName } from './print';
import { named, templateFragmentText } from './syntax';
import { literalCombinations, mapText, placeholderTemplate, splicedSpans, type StringMapping } from './templateSpans';
import { tupleElementBeyond } from './tupleIndexes';
import {
  anonymousObject,
  anyType,
  bigintType,
  booleanType,
  type ConditionalType,
  emptyStructure,
  errorType,
  type IndexInfo,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  isPropertyKeyLiteral,
  literalType,
  type MappedInfo,
  neverType,
  newTypeId,
  nullType,
  numberType,
  type ObjectType,
  type Property,
  stringType,
  type Structure,
  symbolType,
  type Type,
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

/** Resolves the type operators: `keyof`, indexed access, conditional, mapped, and template literal types. */
export class TypeOperators {
  private readonly indexedAccessKeys: IndexedAccessKeys;
  private readonly mappedParameters = new Map<number, TypeParameter>();
  /** The keys and name types of a mapped type that a name type maps to each name, by the structure being built. */
  private readonly mappedKeys = new WeakMap<Structure, Map<string, { keys: Type[]; nameTypes: Type[] }>>();
  private readonly inferParameters = new Map<number, Map<string, TypeParameter>>();

  constructor(private readonly c: Checker) {
    this.indexedAccessKeys = new IndexedAccessKeys(c);
  }

  /** The type parameter of a mapped type or an `infer` that `name` refers to at `node`, if any. */
  mappedOrInferParameter(node: TreeNode, name: string): TypeParameter | undefined {
    let child: TreeNode = node;
    for (let current = node.parent; current; current = current.parent) {
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
          ? this.inferParametersOf(ancestor).get(name)
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

  private inferParametersOf(conditional: TreeNode): Map<string, TypeParameter> {
    let parameters = this.inferParameters.get(conditional.id);
    if (parameters) return parameters;
    parameters = new Map();
    this.inferParameters.set(conditional.id, parameters);
    const extendsNode = conditional.childForFieldName('right');
    if (extendsNode) this.collectInferParameters(conditional, extendsNode, parameters);
    return parameters;
  }

  private collectInferParameters(conditional: TreeNode, node: TreeNode, parameters: Map<string, TypeParameter>): void {
    if (node.type === 'conditional_type' && node.id !== conditional.id) {
      // A nested conditional type's own `infer`s in its extends type belong to it.
      for (const fieldName of ['left', 'consequence', 'alternative']) {
        const child = node.childForFieldName(fieldName);
        if (child) this.collectInferParameters(conditional, child, parameters);
      }
      return;
    }
    if (node.type === 'infer_type') this.addInferParameter(node, parameters);
    for (const child of named(node)) this.collectInferParameters(conditional, child, parameters);
  }

  private addInferParameter(node: TreeNode, parameters: Map<string, TypeParameter>): void {
    const name = named(node)[0];
    if (!name || parameters.has(name.text)) return;
    const constraintNode = named(node)[1];
    parameters.set(name.text, {
      kind: 'typeParameter',
      id: newTypeId(),
      name: name.text,
      constraint: constraintNode
        ? () => this.c.typeNodes.typeFromNode(constraintNode)
        : this.impliedInferConstraint(node),
    });
  }

  /** The constraint TypeScript implies for an unconstrained `infer` from where it is written. */
  private impliedInferConstraint(node: TreeNode): (() => Type) | undefined {
    if (node.parent?.type === 'template_type') return () => stringType;
    const holder = node.parent?.type === 'type_annotation' ? node.parent.parent : node.parent;
    // A rest parameter writes its name as `pattern`, a named tuple member as `name`.
    const isRest =
      holder?.type === 'rest_type' ||
      (holder?.type === 'required_parameter' &&
        (holder.childForFieldName('pattern') ?? holder.childForFieldName('name'))?.type === 'rest_pattern');
    return isRest ? () => this.c.arrayType(unknownType) : undefined;
  }

  /** The type parameter that the `infer` declaration `node` declares in the conditional type whose extends type holds it. */
  inferParameterFor(node: TreeNode, name: string): TypeParameter | undefined {
    let child = node;
    for (let current = node.parent; current; current = current.parent) {
      if (current.type === 'conditional_type' && current.childForFieldName('right')?.id === child.id)
        return this.inferParametersOf(current).get(name);
      child = current;
    }
    return undefined;
  }

  private mappedParameterOf(clause: TreeNode): TypeParameter {
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
    const constraintNode = clause.childForFieldName('type');
    const aliasNode = clause.childForFieldName('alias');
    const typeNode = signature.childForFieldName('type');
    const constraint = constraintNode ? this.c.typeNodes.typeFromNode(constraintNode) : neverType;
    const nameType = aliasNode ? this.c.typeNodes.typeFromNode(aliasNode) : undefined;
    // As TypeScript's `checkMappedType`, a name type, or else the keys, must be property keys.
    const keysNode = aliasNode ?? constraintNode;
    if (keysNode) this.reportUnlessAssignable(keysNode, nameType ?? constraint, propertyKeys);
    const checker = this.c;
    return this.mappedType({
      typeParameter: this.mappedParameterOf(clause),
      source: this.homomorphicSource(constraintNode, constraint),
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
    if (withSource && source && (source.kind === 'intrinsic' || source.kind === 'literal') && !isAnyLike(source))
      return source;
    if (this.c.relations.isGeneric(info.constraint)) {
      return {
        kind: 'object',
        id: newTypeId(),
        objectKind: 'mapped',
        mapped: info,
        resolve: () => emptyStructure(),
      };
    }
    if (source && source.kind === 'object' && this.c.isArrayOrTuple(source) && !info.nameType) {
      return mappedArrayOrTuple(this.c, info, source, withSource);
    }
    return anonymousObject(() => this.mappedStructure(info), {
      mappedKeys: info.nameType ? undefined : info.constraint,
    });
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
    const indexInfo = (): IndexInfo => ({
      type: this.c.instantiate(info.template, mapper),
      readonly: info.readonlyModifier === '+',
    });
    // A key of `any` maps every string key, as TypeScript gives `{ [K in any]: T }` a string index signature.
    if (isIntrinsic(nameMember, 'string') || isAnyLike(nameMember)) structure.stringIndex = indexInfo();
    else if (isIntrinsic(nameMember, 'number')) structure.numberIndex = indexInfo();
    else if (isIntrinsic(nameMember, 'symbol')) structure.symbolIndex = indexInfo();
    else if (isPatternKey(nameMember))
      structure.patternIndexes = [...(structure.patternIndexes ?? []), { ...indexInfo(), keyType: nameMember }];
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
    if (this.c.relations.isGeneric(type)) return { kind: 'keyof', id: newTypeId(), type };
    if (isAnyLike(type) || isIntrinsic(type, 'never')) return unionOf([stringType, numberType, symbolType]);
    if (type.kind === 'union')
      return intersectionOf(
        type.types.map((member) => this.keyofType(member)),
        this.c.budget
      );
    if (type.kind === 'intersection') return unionOf(type.types.map((member) => this.keyofType(member)));
    if (type.kind !== 'object') {
      if (type.kind === 'intrinsic' && ['unknown', 'null', 'undefined', 'void', 'object'].includes(type.name))
        return neverType;
      return this.keyofType(this.c.apparentType(type));
    }
    // TypeScript's `getIndexTypeForMappedType` gives a mapped type's constraint, as `string` for `Record<string, T>`.
    return type.mappedKeys ?? this.memberKeys(type.resolve());
  }

  private memberKeys(structure: Structure): Type {
    const keys = indexKeys(structure);
    // keyof lists the public members only.
    for (const [name, property] of structure.properties) {
      if (name.startsWith('__@') || name.startsWith('#') || property.visibility !== 'public') continue;
      keys.push(this.propertyKeyType(property));
    }
    return unionOf(keys);
  }

  /** The key type naming a property, as TypeScript's `getLiteralTypeFromProperty` gives it. */
  propertyKeyType(property: Property): Type {
    if (property.nameType) return property.nameType;
    const name = property.declaration?.childForFieldName('name') ?? property.declaration?.childForFieldName('key');
    if (name?.type === 'computed_property_name') {
      const key = this.c.silently(() => this.c.expressions.check(named(name)[0]));
      if (isPropertyKeyLiteral(key)) return key;
    }
    return this.isNumericKey(property) ? literalType(Number(property.name)) : literalType(property.name);
  }

  /**
   * Whether a property is named by a number, as `0: T`, `[1]: T`, or `[n]: T` for a constant `n` of a number literal
   * type, which `keyof` gives as a number.
   */
  isNumericKey(property: Property): boolean {
    if (property.nameType)
      return (property.nameType.kind === 'union' ? property.nameType.types : [property.nameType]).some(
        (member) => member.kind === 'literal' && typeof member.value === 'number'
      );
    const declaration = property.declaration;
    const name = declaration?.childForFieldName('name') ?? declaration?.childForFieldName('key');
    if (name?.type !== 'computed_property_name') return name?.type === 'number';
    let numeric = false;
    this.c.flow.from(this.c.flow.current, () => {
      const type = this.c.silently(() => this.c.expressions.check(named(name)[0]));
      numeric = type.kind === 'literal' && typeof type.value === 'number';
    });
    return numeric;
  }

  /** `object[index]`, reporting a missing property at `node` when given. */
  indexedAccess(object: Type, index: Type, node?: TreeNode): Type {
    // A mapped type indexed by its own keys, `{ [P in K]: X }[K]`, is its template for those keys.
    if (object.kind === 'object' && object.objectKind === 'mapped' && object.mapped && !object.mapped.nameType) {
      if (this.isMappedKey(index, object.mapped.constraint)) return this.substituteIndexedMapped(object.mapped, index);
      if (node) {
        this.c.error(node, `型 '${this.c.print(index)}' は型 '${this.c.print(object)}' のインデックスに使えません。`);
        return errorType;
      }
    }
    if (this.c.relations.isGeneric(object) || this.c.relations.isGeneric(index)) {
      return (
        this.c.relations.stringIndexReadByGenericKey(object, index) ?? {
          kind: 'indexedAccess',
          id: newTypeId(),
          objectType: object,
          indexType: index,
        }
      );
    }
    if (index.kind === 'union') return unionOf(index.types.map((member) => this.indexedAccess(object, member, node)));
    if (isAnyLike(object)) return anyType;
    if (object.kind === 'union') return unionOf(object.types.map((member) => this.indexedAccess(member, index, node)));
    if (isPropertyKeyLiteral(index)) return this.propertyAccess(object, index.value, node);
    const applicable =
      applicableIndex(this.c, this.c.structureOf(object), index) ?? this.unreportedStringIndex(object, index, node);
    if (applicable) return applicable.type;
    if (node)
      this.c.error(node, `型 '${this.c.print(index)}' は型 '${this.c.print(object)}' のインデックスに使えません。`);
    return errorType;
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

  /**
   * As TypeScript's `substituteIndexedMappedType`, a mapped type's template for `index`, with `undefined` when the
   * mapped type, or the one whose modifiers it keeps, adds `?`.
   */
  private substituteIndexedMapped(mapped: MappedInfo, index: Type): Type {
    const type = this.c.instantiate(mapped.template, new Map([[mapped.typeParameter.id, index]]));
    const optional = mapped.optionalModifier === '+' || mappedOptionality(mapped.source) > 0;
    return optional ? unionOf([type, undefinedType]) : type;
  }

  private propertyAccess(object: Type, key: string | number | symbol, node: TreeNode | undefined): Type {
    const name = String(key);
    const property = this.c.propertyOf(object, name);
    if (property) return property.optional ? unionOf([property.type(), undefinedType]) : property.type();
    const element = tupleElementBeyond(this.c, object, name, node);
    if (element) return element;
    const structure = this.c.structureOf(object);
    const applicable =
      typeof key === 'symbol'
        ? (structure.symbolIndex ?? this.unreportedStringIndex(object, literalType(key), node))
        : applicableIndex(this.c, structure, literalType(key));
    if (applicable) return applicable.type;
    if (node)
      this.c.error(node, `プロパティ '${printedPropertyName(name)}' は型 '${this.c.print(object)}' にありません。`);
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
      checkType,
      extendsType: this.c.typeNodes.typeFromNode(extendsNode),
      get trueType() {
        return checker.typeNodes.typeFromNode(trueNode);
      },
      get falseType() {
        return checker.typeNodes.typeFromNode(falseNode);
      },
      inferTypeParameters: [...this.inferParametersOf(node).values()],
      distributive: checkType.kind === 'typeParameter',
    };
    return this.resolveConditional(conditional, new Map());
  }

  /** The mapper that applies `first` and then `second`. */
  private compose(first: Mapper, second: Mapper): Mapper {
    const composed: Mapper = new Map();
    for (const [id, type] of first) composed.set(id, this.c.instantiate(type, second));
    for (const [id, type] of second) if (!composed.has(id)) composed.set(id, type);
    return composed;
  }

  resolveConditional(type: ConditionalType, outer: Mapper): Type {
    // An instantiated copy resolves from its declaration, so that it still distributes over its check type parameter.
    if (type.root && type.mapper) return this.resolveConditional(type.root, this.compose(type.mapper, outer));
    const checkType = this.c.instantiate(type.checkType, outer);
    if (type.distributive && checkType.kind === 'union') {
      return unionOf(
        checkType.types.map((member) =>
          this.resolveConditional(type, new Map([...outer, [(type.checkType as TypeParameter).id, member]]))
        )
      );
    }
    if (type.distributive && isIntrinsic(checkType, 'never')) return neverType;
    // The `infer` type parameters belong to this conditional type, so each instantiation gets its own.
    const mapper: Mapper = new Map(outer);
    const inferTypeParameters = type.inferTypeParameters.map((parameter): TypeParameter => ({
      ...parameter,
      id: newTypeId(),
    }));
    for (const [index, parameter] of type.inferTypeParameters.entries())
      mapper.set(parameter.id, inferTypeParameters[index]);
    const extendsType = this.c.instantiate(type.extendsType, mapper);
    const deferred = { type, outer, mapper, checkType, extendsType, inferTypeParameters };
    if (isGenericObjectOrIndexType(checkType) || isGenericObjectOrIndexType(extendsType, inferTypeParameters))
      return this.deferredConditional(deferred);
    const inferred = this.inferredMapper(mapper, inferTypeParameters, checkType, extendsType);
    const falseType = (): Type => this.c.instantiate(type.falseType, outer);
    if (!inferred) return falseType();
    const trueType = (): Type => this.c.instantiate(this.c.instantiate(type.trueType, mapper), inferred);
    const branch = conditionalBranch(this.c, checkType, this.c.instantiate(extendsType, inferred));
    if (branch === undefined) return this.deferredConditional(deferred);
    if (branch === 'false') return falseType();
    return branch === 'true' ? trueType() : unionOf([trueType(), falseType()]);
  }

  /**
   * The mapper that also gives the `infer` type parameters what the check type infers for them, or undefined when a
   * literal fails to match a template literal, which takes the false branch.
   */
  private inferredMapper(
    mapper: Mapper,
    inferTypeParameters: TypeParameter[],
    checkType: Type,
    extendsType: Type
  ): Mapper | undefined {
    const inferred = new Map(mapper);
    if (inferTypeParameters.length === 0) return inferred;
    const inferences = this.c.inference.inferFromTypes(inferTypeParameters, checkType, extendsType, mapper);
    if (
      extendsType.kind === 'templateLiteral' &&
      checkType.kind === 'literal' &&
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
  }: {
    type: ConditionalType;
    outer: Mapper;
    mapper: Mapper;
    checkType: Type;
    extendsType: Type;
    inferTypeParameters: TypeParameter[];
  }): Type {
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
    // Each union expands into one literal per member, up to the size TypeScript represents.
    const size = types.reduce((product, type) => product * (type.kind === 'union' ? type.types.length : 1), 1);
    if (size >= 100_000) {
      if (node) this.c.error(node, 'この式の型は、表せないほど複雑な共用体型になります。');
      return errorType;
    }
    if (types.some((type) => isIntrinsic(type, 'never'))) return neverType;
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
    this.c.typeNodes.interfaceBases.afterResolving(() =>
      this.c.typeNodes.checkTypeArgumentConstraints(node, [stringMappingParameter], [argument])
    );
    return this.stringMapping(mapping, argument);
  }

  /** `Uppercase<T>` and its kin, which TypeScript pushes into a template literal's texts and placeholders. */
  stringMapping(mapping: StringMapping, type: Type): Type {
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
