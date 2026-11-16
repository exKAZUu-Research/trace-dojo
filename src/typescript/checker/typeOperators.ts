import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker, Mapper } from './checker';
import { named } from './syntax';
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
      constraint: constraintNode ? () => this.c.typeNodes.typeFromNode(constraintNode) : undefined,
    });
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
    return this.mappedType({
      typeParameter: parameter,
      source,
      constraint,
      nameType: aliasNode ? this.c.typeNodes.typeFromNode(aliasNode) : undefined,
      template: this.c.typeNodes.annotationType(typeNode) ?? anyType,
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
      structure.properties.set(name, this.mappedProperty(info, mapper.get(info.typeParameter.id) as Type, name));
      return;
    }
    const indexInfo = (): IndexInfo => ({
      type: this.c.instantiate(info.template, mapper),
      readonly: info.readonlyModifier === '+',
    });
    if (isIntrinsic(nameMember, 'string')) structure.stringIndex = indexInfo();
    else if (isIntrinsic(nameMember, 'number')) structure.numberIndex = indexInfo();
  }

  private mappedProperty(info: MappedInfo, key: Type, name: string): Property {
    const sourceProperty = info.source ? this.c.propertyOf(info.source, name) : undefined;
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
    };
  }

  keyofType(type: Type): Type {
    if (this.c.relations.isGeneric(type)) return { kind: 'keyof', id: newTypeId(), type };
    if (isAnyLike(type)) return unionOf([stringType, numberType, symbolType]);
    if (type.kind === 'union') return intersectionOf(type.types.map((member) => this.keyofType(member)));
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
    for (const name of structure.properties.keys()) {
      if (name.startsWith('__@') || name.startsWith('#')) continue;
      keys.push(literalType(name));
    }
    return unionOf(keys);
  }

  /** `object[index]`, reporting a missing property at `node` when given. */
  // code-gauge-allow functionCognitiveComplexity 18 -- Follows TypeScript's rules for each kind of index type.
  indexedAccess(object: Type, index: Type, node?: TreeNode): Type {
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
    const numeric = typeof key === 'number' || /^\d+$/.test(name);
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
    const conditional: ConditionalType = {
      kind: 'conditional',
      id: newTypeId(),
      checkType,
      extendsType: this.c.typeNodes.typeFromNode(extendsNode),
      trueType: this.c.typeNodes.typeFromNode(trueNode),
      falseType: this.c.typeNodes.typeFromNode(falseNode),
      inferTypeParameters: [...this.inferParametersOf(node).values()],
      distributive: checkType.kind === 'typeParameter',
    };
    return this.resolveConditional(conditional, new Map());
  }

  resolveConditional(type: ConditionalType, outer: Mapper): Type {
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
      return {
        ...type,
        id: newTypeId(),
        checkType,
        extendsType,
        trueType: this.c.instantiate(type.trueType, mapper),
        falseType: this.c.instantiate(type.falseType, outer),
        inferTypeParameters,
        distributive: type.distributive && checkType.kind === 'typeParameter',
      };
    }
    const inferred = new Map(mapper);
    if (inferTypeParameters.length > 0) {
      const inferences = this.c.inference.inferFromTypes(inferTypeParameters, checkType, extendsType);
      for (const parameter of inferTypeParameters) {
        inferred.set(parameter.id, inferences.get(parameter.id) ?? parameter.constraint?.() ?? unknownType);
      }
    }
    const extendsInstantiated = this.c.instantiate(extendsType, inferred);
    if (isAnyLike(checkType)) {
      return unionOf([
        this.c.instantiate(this.c.instantiate(type.trueType, mapper), inferred),
        this.c.instantiate(type.falseType, outer),
      ]);
    }
    if (this.c.relations.isAssignable(checkType, extendsInstantiated)) {
      return this.c.instantiate(this.c.instantiate(type.trueType, mapper), inferred);
    }
    return this.c.instantiate(type.falseType, outer);
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
        texts[texts.length - 1] += child.text;
      }
    }
    return this.templateLiteral(texts, types);
  }

  templateLiteral(texts: string[], types: Type[]): Type {
    if (types.some((type) => this.c.relations.isGeneric(type)))
      return { kind: 'templateLiteral', id: newTypeId(), texts, types };
    // Each union expands into one literal per member, as long as the result stays small.
    let combinations: string[] = [texts[0]];
    let isLiteral = true;
    for (const [index, type] of types.entries()) {
      const members = type.kind === 'union' ? type.types : [type];
      if (members.some((member) => isIntrinsic(member, 'never'))) return neverType;
      if (
        !members.every(
          (member) => member.kind === 'literal' || isIntrinsic(member, 'null') || isIntrinsic(member, 'undefined')
        )
      ) {
        isLiteral = false;
        break;
      }
      combinations = appendEach(combinations, members, texts[index + 1]);
      if (combinations.length > 10_000) return stringType;
    }
    if (isLiteral) return unionOf(combinations.map((text) => literalType(text)));
    if (types.length === 1 && isIntrinsic(types[0], 'string') && texts.every((text) => text === '')) return stringType;
    return { kind: 'templateLiteral', id: newTypeId(), texts, types };
  }

  stringMapping(mapping: 'Uppercase' | 'Lowercase' | 'Capitalize' | 'Uncapitalize', type: Type): Type {
    if (type.kind === 'union') return unionOf(type.types.map((member) => this.stringMapping(mapping, member)));
    if (type.kind === 'literal' && typeof type.value === 'string') {
      const text = type.value;
      switch (mapping) {
        case 'Uppercase': {
          return literalType(text.toUpperCase());
        }
        case 'Lowercase': {
          return literalType(text.toLowerCase());
        }
        case 'Capitalize': {
          return literalType(text.charAt(0).toUpperCase() + text.slice(1));
        }
        default: {
          return literalType(text.charAt(0).toLowerCase() + text.slice(1));
        }
      }
    }
    if (isAnyLike(type)) return type;
    return { kind: 'stringMapping', id: newTypeId(), mapping, type };
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
