import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker, Mapper } from './checker';
import { isNumericName, named, templateFragmentText } from './syntax';
import {
  anonymousObject,
  anyType,
  type ConditionalType,
  emptyStructure,
  errorType,
  type IndexInfo,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  literalType,
  type MappedInfo,
  neverType,
  newTypeId,
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

/** Resolves the type operators: `keyof`, indexed access, conditional, mapped, and template literal types. */
export class TypeOperators {
  private readonly mappedParameters = new Map<number, TypeParameter>();
  /** The keys and name types of a mapped type that a name type maps to each name, by the structure being built. */
  private readonly mappedKeys = new WeakMap<Structure, Map<string, { keys: Type[]; nameTypes: Type[] }>>();
  private readonly inferParameters = new Map<number, Map<string, TypeParameter>>();

  constructor(private readonly c: Checker) {}

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
      case 'conditional_type': {
        const fieldName = this.fieldNameOf(ancestor, child);
        return fieldName === 'consequence' || fieldName === 'right'
          ? this.inferParametersOf(ancestor).get(name)
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

  inferParameterFor(node: TreeNode, name: string): TypeParameter | undefined {
    for (let current = node.parent; current; current = current.parent) {
      if (current.type === 'conditional_type') {
        const parameter = this.inferParametersOf(current).get(name);
        if (parameter) return parameter;
      }
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
    const parameter = this.mappedParameterOf(clause);
    const constraintNode = clause.childForFieldName('type');
    const aliasNode = clause.childForFieldName('alias');
    const typeNode = signature.childForFieldName('type');
    const tokens = signature.children.filter((child) => child !== null && !child.isNamed).map((child) => child?.type);
    const readonlyIndex = tokens.indexOf('readonly');
    const readonlyModifier = readonlyIndex === -1 ? undefined : tokens[readonlyIndex - 1] === '-' ? '-' : '+';
    let optionalModifier: '+' | '-' | undefined;
    if (typeNode?.type === 'omitting_type_annotation') optionalModifier = '-';
    else if (typeNode?.type === 'adding_type_annotation' || typeNode?.type === 'opting_type_annotation')
      optionalModifier = '+';
    const constraint = constraintNode ? this.c.typeNodes.typeFromNode(constraintNode) : neverType;
    let source: Type | undefined;
    if (constraintNode?.type === 'index_type_query') source = this.c.typeNodes.typeFromNode(named(constraintNode)[0]);
    else if (constraint.kind === 'typeParameter') {
      const outer = constraint.constraint?.();
      if (outer?.kind === 'keyof') source = outer.type;
    }
    const checker = this.c;
    return this.mappedType({
      typeParameter: parameter,
      source,
      constraint,
      nameType: aliasNode ? this.c.typeNodes.typeFromNode(aliasNode) : undefined,
      get template() {
        return checker.typeNodes.annotationType(typeNode) ?? anyType;
      },
      readonlyModifier,
      optionalModifier,
    });
  }

  /** A mapped type, resolved to an object type once its keys are known. */
  mappedType(info: MappedInfo): Type {
    if (this.c.relations.isGeneric(info.constraint)) {
      return {
        kind: 'object',
        id: newTypeId(),
        objectKind: 'mapped',
        mapped: info,
        resolve: () => emptyStructure(),
      };
    }
    const { source } = info;
    if (source && source.kind === 'object' && this.c.isArrayOrTuple(source) && !info.nameType) {
      return this.mappedArrayOrTuple(info, source);
    }
    return anonymousObject(() => this.mappedStructure(info));
  }

  /** A homomorphic mapped type over an array or a tuple, which maps its elements. */
  private mappedArrayOrTuple(info: MappedInfo, source: ObjectType): Type {
    if (source.objectKind === 'tuple') {
      return this.c.tupleType(
        (source.tuple?.elements ?? []).map((element, index) => ({
          ...element,
          type: this.c.instantiate(info.template, new Map([[info.typeParameter.id, literalType(String(index))]])),
          optional: applyModifier(info.optionalModifier, element.optional),
        })),
        applyModifier(info.readonlyModifier, source.tuple?.readonly ?? false)
      );
    }
    const element = this.c.instantiate(info.template, new Map([[info.typeParameter.id, numberType]]));
    return this.c.arrayType(element, applyModifier(info.readonlyModifier, this.c.isReadonlyArrayType(source)));
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
        if (info.optionalModifier === '-') mappedType = this.c.relations.removeUndefined(mappedType);
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

  // code-gauge-allow functionCognitiveComplexity 17 -- Follows TypeScript's keys of each kind of type.
  keyofType(type: Type): Type {
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
    const structure = type.resolve();
    const keys: Type[] = [];
    if (structure.stringIndex) keys.push(stringType, numberType);
    else if (structure.numberIndex) keys.push(numberType);
    // keyof lists the public members only.
    for (const [name, property] of structure.properties) {
      if (name.startsWith('__@') || name.startsWith('#') || property.visibility !== 'public') continue;
      keys.push(property.nameType ?? (this.isNumericKey(property) ? literalType(Number(name)) : literalType(name)));
    }
    return unionOf(keys);
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
  // code-gauge-allow functionCognitiveComplexity 22 -- Follows TypeScript's rules for each kind of index type.
  indexedAccess(object: Type, index: Type, node?: TreeNode): Type {
    // A mapped type indexed by its own keys, `{ [P in K]: X }[K]`, is its template for those keys.
    if (object.kind === 'object' && object.objectKind === 'mapped' && object.mapped && !object.mapped.nameType) {
      const { constraint, typeParameter, template } = object.mapped;
      if (this.c.relations.isAssignable(index, constraint))
        return this.c.instantiate(template, new Map([[typeParameter.id, index]]));
    }
    if (this.c.relations.isGeneric(object) || this.c.relations.isGeneric(index)) {
      return { kind: 'indexedAccess', id: newTypeId(), objectType: object, indexType: index };
    }
    if (index.kind === 'union') return unionOf(index.types.map((member) => this.indexedAccess(object, member, node)));
    if (isAnyLike(object)) return anyType;
    if (object.kind === 'union') return unionOf(object.types.map((member) => this.indexedAccess(member, index, node)));
    if (index.kind === 'literal' && (typeof index.value === 'string' || typeof index.value === 'number')) {
      return this.propertyAccess(object, index.value, node);
    }
    const structure = this.c.structureOf(object);
    if (isIntrinsic(index, 'number') || (index.kind === 'literal' && typeof index.value === 'number')) {
      if (structure.numberIndex) return structure.numberIndex.type;
      if (structure.stringIndex) return structure.stringIndex.type;
    }
    if (isIntrinsic(index, 'string') && structure.stringIndex) return structure.stringIndex.type;
    if (node)
      this.c.error(node, `型 '${this.c.print(index)}' は型 '${this.c.print(object)}' のインデックスに使えません。`);
    return errorType;
  }

  private propertyAccess(object: Type, key: string | number, node: TreeNode | undefined): Type {
    const name = String(key);
    const property = this.c.propertyOf(object, name);
    if (property) return property.optional ? unionOf([property.type(), undefinedType]) : property.type();
    const structure = this.c.structureOf(object);
    const numeric = typeof key === 'number' || isNumericName(name);
    if (numeric && structure.numberIndex) return structure.numberIndex.type;
    if (structure.stringIndex) return structure.stringIndex.type;
    if (node) this.c.error(node, `プロパティ '${name}' は型 '${this.c.print(object)}' にありません。`);
    return errorType;
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

  // code-gauge-allow functionCognitiveComplexity 17 -- Resolves distribution, deferred branches, infer parameters, and failed template-literal inference as one conditional-type operation.
  // code-gauge-allow functionNcss 31 -- Keeps conditional inference and lazy branch substitution together.
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
    if (this.c.relations.isGeneric(checkType) || this.c.relations.isGeneric(extendsType, inferTypeParameters)) {
      if (outer.size === 0) return type;
      const checker = this.c;
      return {
        kind: 'conditional',
        distributive: type.distributive,
        aliasName: type.aliasName,
        aliasArguments: type.aliasArguments,
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
    const inferred = new Map(mapper);
    if (inferTypeParameters.length > 0) {
      const inferences = this.c.inference.inferFromTypes(inferTypeParameters, checkType, extendsType);
      if (
        extendsType.kind === 'templateLiteral' &&
        checkType.kind === 'literal' &&
        inferTypeParameters.some((parameter) => !inferences.has(parameter.id))
      )
        return this.c.instantiate(type.falseType, outer);
      for (const parameter of inferTypeParameters) {
        inferred.set(parameter.id, inferences.get(parameter.id) ?? parameter.constraint?.() ?? unknownType);
      }
    }
    const extendsInstantiated = this.c.instantiate(extendsType, inferred);
    return this.resolvedBranch(
      checkType,
      extendsInstantiated,
      () => this.c.instantiate(this.c.instantiate(type.trueType, mapper), inferred),
      () => this.c.instantiate(type.falseType, outer)
    );
  }

  /** The branch a conditional type takes once neither its check type nor its extends type is generic. */
  private resolvedBranch(checkType: Type, extendsType: Type, trueType: () => Type, falseType: () => Type): Type {
    // Every type extends `any` and `unknown`, `any` included; it extends any other type ambiguously.
    if (isAnyLike(extendsType) || isIntrinsic(extendsType, 'unknown')) return trueType();
    if (isAnyLike(checkType)) return unionOf([trueType(), falseType()]);
    return this.c.relations.isAssignable(checkType, extendsType) ? trueType() : falseType();
  }

  templateLiteralFromNode(node: TreeNode): Type {
    const texts: string[] = [''];
    const types: Type[] = [];
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === 'template_type') {
        types.push(this.c.typeNodes.typeFromNode(named(child)[0]));
        texts.push('');
      } else {
        texts[texts.length - 1] += templateFragmentText(child);
      }
    }
    return this.templateLiteral(texts, types, node);
  }

  templateLiteral(texts: string[], types: Type[], node?: TreeNode): Type {
    if (types.some((type) => this.c.relations.isGeneric(type)))
      return { kind: 'templateLiteral', id: newTypeId(), texts, types };
    // Each union expands into one literal per member, up to the size TypeScript represents.
    const size = types.reduce((product, type) => product * (type.kind === 'union' ? type.types.length : 1), 1);
    if (size >= 100_000) {
      if (node) this.c.error(node, 'この式の型は、表せないほど複雑な共用体型になります。');
      return errorType;
    }
    const combinations = this.literalCombinations(texts, types);
    if (combinations === 'never') return neverType;
    if (combinations) return unionOf(combinations.map((text) => literalType(text)));
    if (types.length === 1 && isIntrinsic(types[0], 'string') && texts.every((text) => text === '')) return stringType;
    return { kind: 'templateLiteral', id: newTypeId(), texts, types };
  }

  /**
   * The strings a template spells when each placeholder is a literal or a union of them, `never` when one is `never`,
   * or `undefined` when one is not a literal.
   */
  private literalCombinations(texts: string[], types: Type[]): string[] | 'never' | undefined {
    let combinations: string[] = [texts[0]];
    for (const [index, type] of types.entries()) {
      const members = type.kind === 'union' ? type.types : [type];
      if (members.some((member) => isIntrinsic(member, 'never'))) return 'never';
      if (!members.every(isSpelledLiteral)) return undefined;
      this.c.budget.spend(combinations.length * members.length);
      combinations = appendEach(combinations, members, texts[index + 1]);
    }
    return combinations;
  }

  /** `Uppercase<T>` and its kin, which TypeScript pushes into a template literal's texts and placeholders. */
  stringMapping(mapping: StringMapping, type: Type): Type {
    if (type.kind === 'union') return unionOf(type.types.map((member) => this.stringMapping(mapping, member)));
    if (type.kind === 'literal' && typeof type.value === 'string') return literalType(mapText(mapping, type.value));
    if (type.kind === 'templateLiteral') {
      const { texts, types } = type;
      if (mapping === 'Uppercase' || mapping === 'Lowercase') {
        return this.templateLiteral(
          texts.map((text) => mapText(mapping, text)),
          types.map((member) => this.stringMapping(mapping, member))
        );
      }
      // Capitalizing changes only the first character, which the first text or else the first placeholder holds.
      return texts[0] === ''
        ? this.templateLiteral(texts, [this.stringMapping(mapping, types[0]), ...types.slice(1)])
        : this.templateLiteral([mapText(mapping, texts[0]), ...texts.slice(1)], types);
    }
    if (type.kind === 'stringMapping' && type.mapping === mapping) return type;
    if (isAnyLike(type)) return type;
    // A `number` or `bigint` placeholder is mapped as the template `${number}` it spells.
    const inner =
      isIntrinsic(type, 'number') || isIntrinsic(type, 'bigint') ? this.templateLiteral(['', ''], [type]) : type;
    return { kind: 'stringMapping', id: newTypeId(), mapping, type: inner };
  }
}

type StringMapping = 'Uppercase' | 'Lowercase' | 'Capitalize' | 'Uncapitalize';

function mapText(mapping: StringMapping, text: string): string {
  switch (mapping) {
    case 'Uppercase': {
      return text.toUpperCase();
    }
    case 'Lowercase': {
      return text.toLowerCase();
    }
    case 'Capitalize': {
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
    default: {
      return text.charAt(0).toLowerCase() + text.slice(1);
    }
  }
}

/** A modified property's flag: `+` sets it, `-` clears it, and no modifier keeps the source's. */
function applyModifier(modifier: '+' | '-' | undefined, inherited: boolean): boolean {
  return modifier === '+' || (modifier !== '-' && inherited);
}

/** Each prefix followed by the text of each literal, `null`, or `undefined` member and the suffix. */
function appendEach(prefixes: string[], members: Type[], suffix: string): string[] {
  return prefixes.flatMap((prefix) =>
    members.map(
      (member) =>
        prefix + (member.kind === 'literal' ? String(member.value) : (member as { name: string }).name) + suffix
    )
  );
}

/** Whether a template placeholder spells one text, as a literal, `null`, or `undefined` does. */
function isSpelledLiteral(member: Type): boolean {
  return member.kind === 'literal' || isIntrinsic(member, 'null') || isIntrinsic(member, 'undefined');
}
