import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { SourceDiagnostic } from '../../interpreter/diagnostics';
import { Binder } from './binder';
import { ClassChecker } from './classes';
import { ExpressionChecker } from './expressions';
import { Flow } from './flow';
import { libraryScope, libraryTree, markUnsupported } from './library';
import { Printer } from './print';
import { Relations } from './relations';
import type { Scope, Sym } from './scopes';
import { StatementChecker } from './statements';
import { named, numberValue, propertyNameText, stringValue } from './syntax';
import {
  anonymousObject,
  anyType,
  bigintType,
  booleanType,
  type ConditionalType,
  emptyStructure,
  errorType,
  falseType,
  functionType,
  type IndexInfo,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  literalType,
  type MappedInfo,
  neverType,
  newTypeId,
  nonPrimitiveType,
  nullType,
  numberType,
  type ObjectType,
  type Parameter,
  type Property,
  regularOf,
  type Signature,
  simpleProperty,
  stringType,
  type Structure,
  symbolType,
  trueType,
  type TupleElement,
  type Type,
  type TypeParameter,
  undefinedType,
  unionOf,
  unknownType,
  voidType,
} from './types';

export type Mapper = Map<number, Type>;

interface Diagnostic extends SourceDiagnostic {
  index: number;
}

const predefinedTypes: Record<string, Type> = {
  any: anyType,
  unknown: unknownType,
  never: neverType,
  void: voidType,
  undefined: undefinedType,
  null: nullType,
  string: stringType,
  number: numberType,
  boolean: booleanType,
  bigint: bigintType,
  symbol: symbolType,
  object: nonPrimitiveType,
};

const stringMappings = new Set(['Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize']);

/** Type-checks a program as `tsc --strict` does, collecting the errors it reports. */
export class Checker {
  readonly diagnostics: Diagnostic[] = [];
  /** While positive, errors are not reported, as when inferring a function's return type ahead of checking it. */
  silent = 0;
  readonly binder: Binder;
  readonly libraryBinder: Binder;
  readonly relations = new Relations(this);
  readonly printer = new Printer(this);
  readonly expressions = new ExpressionChecker(this);
  readonly statements = new StatementChecker(this);
  readonly classes = new ClassChecker(this);
  readonly flow = new Flow(this);
  private readonly typeNodeCache = new Map<number, Type>();
  private readonly referenceCache = new Map<string, ObjectType>();
  private readonly instantiationCache = new Map<string, Type>();
  private readonly mappedParameters = new Map<number, TypeParameter>();
  private readonly inferParameters = new Map<number, Map<string, TypeParameter>>();
  private readonly signatureCache = new Map<number, Signature>();
  /** The members of class instance types with `this` standing for the instance type, by type. */
  private readonly thisStructures = new Map<number, Structure>();

  constructor(readonly root: TreeNode) {
    this.libraryBinder = new Binder(libraryTree.rootNode, libraryScope());
    markUnsupported(this.libraryBinder.moduleScope);
    this.binder = new Binder(root, this.libraryBinder.moduleScope);
    for (const identifier of this.binder.assignedIdentifiers) {
      const symbol = this.binder.scopeOf(identifier).lookupValue(identifier.text);
      if (symbol) symbol.isReassigned = true;
    }
  }

  check(): SourceDiagnostic[] {
    this.statements.checkProgram(this.root);
    const seen = new Set<string>();
    return this.diagnostics
      .toSorted((a, b) => a.index - b.index)
      .filter((diagnostic) => {
        const key = `${diagnostic.index}:${diagnostic.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ row, message }) => ({ row, message }));
  }

  error(node: TreeNode, message: string): void {
    if (this.silent > 0 || this.isLibrary(node)) return;
    this.diagnostics.push({ row: node.startPosition.row, index: node.startIndex, message });
  }

  silently<T>(run: () => T): T {
    this.silent++;
    try {
      return run();
    } finally {
      this.silent--;
    }
  }

  scopeOf(node: TreeNode): Scope {
    return node.tree === libraryTree ? this.libraryBinder.scopeOf(node) : this.binder.scopeOf(node);
  }

  ownScope(node: TreeNode): Scope | undefined {
    return node.tree === libraryTree ? this.libraryBinder.ownScope(node) : this.binder.ownScope(node);
  }

  isLibrary(node: TreeNode): boolean {
    return node.tree === libraryTree;
  }

  print(type: Type): string {
    return this.printer.print(type);
  }

  // Library types -----------------------------------------------------------------------------------------------

  globalType(name: string, typeArguments: Type[] = []): ObjectType {
    const symbol = this.libraryBinder.moduleScope.lookupType(name);
    if (!symbol) throw new Error(`The library declares no type ${name}`);
    const declared = this.declaredTypeOf(symbol) as ObjectType;
    if (typeArguments.length === 0 || !declared.typeParameters) return declared;
    return this.reference(declared, typeArguments);
  }

  globalValue(name: string): Type {
    const symbol = this.libraryBinder.moduleScope.lookupValue(name);
    if (!symbol) throw new Error(`The library declares no value ${name}`);
    return this.expressions.valueTypeOf(symbol);
  }

  arrayType(element: Type, readonly = false): ObjectType {
    return this.globalType(readonly ? 'ReadonlyArray' : 'Array', [element]);
  }

  isArrayType(type: Type): boolean {
    return type.kind === 'object' && type.objectKind === 'reference' && type.target?.name === 'Array';
  }

  isReadonlyArrayType(type: Type): boolean {
    return type.kind === 'object' && type.objectKind === 'reference' && type.target?.name === 'ReadonlyArray';
  }

  isArrayOrTuple(type: Type): boolean {
    return (
      this.isArrayType(type) ||
      this.isReadonlyArrayType(type) ||
      (type.kind === 'object' && type.objectKind === 'tuple')
    );
  }

  /** The element type of an array, a read-only array, or a tuple. */
  elementTypeOf(type: ObjectType): Type {
    if (type.objectKind === 'tuple') return unionOf((type.tuple?.elements ?? []).map((element) => element.type));
    return type.typeArguments?.[0] ?? anyType;
  }

  // References and instantiation ---------------------------------------------------------------------------------

  /** A generic interface or class applied to type arguments. */
  reference(target: ObjectType, typeArguments: Type[]): ObjectType {
    const parameters = target.typeParameters ?? [];
    const filled = parameters.map(
      (parameter, index) => typeArguments[index] ?? this.defaultOf(parameter, typeArguments)
    );
    if (filled.every((argument, index) => argument === parameters[index])) return target;
    const key = `${target.id}<${filled.map((type) => type.id).join(',')}>`;
    let reference = this.referenceCache.get(key);
    if (!reference) {
      const mapper: Mapper = new Map(parameters.map((parameter, index) => [parameter.id, filled[index]]));
      let structure: Structure | undefined;
      reference = {
        kind: 'object',
        id: newTypeId(),
        objectKind: 'reference',
        name: target.name,
        target,
        typeArguments: filled,
        classInfo: target.classInfo,
        resolve: () => {
          structure ??= this.instantiateStructure(target.resolve(), mapper);
          return structure;
        },
      };
      this.referenceCache.set(key, reference);
    }
    return reference;
  }

  private defaultOf(parameter: TypeParameter, typeArguments: Type[]): Type {
    return parameter.default?.() ?? (typeArguments.length === 0 ? unknownType : unknownType);
  }

  instantiate(type: Type, mapper: Mapper): Type {
    if (mapper.size === 0) return type;
    switch (type.kind) {
      case 'typeParameter': {
        return mapper.get(type.id) ?? type;
      }
      case 'union': {
        return unionOf(
          type.types.map((member) => this.instantiate(member, mapper)),
          true
        );
      }
      case 'intersection': {
        return intersectionOf(type.types.map((member) => this.instantiate(member, mapper)));
      }
      case 'object': {
        return this.instantiateObject(type, mapper);
      }
      case 'indexedAccess': {
        return this.indexedAccess(this.instantiate(type.objectType, mapper), this.instantiate(type.indexType, mapper));
      }
      case 'keyof': {
        return this.keyofType(this.instantiate(type.type, mapper));
      }
      case 'conditional': {
        return this.instantiateConditional(type, mapper);
      }
      case 'templateLiteral': {
        return this.templateLiteral(
          type.texts,
          type.types.map((member) => this.instantiate(member, mapper))
        );
      }
      case 'stringMapping': {
        return this.stringMapping(type.mapping, this.instantiate(type.type, mapper));
      }
      default: {
        return type;
      }
    }
  }

  private mapperKey(mapper: Mapper): string {
    return [...mapper].map(([id, type]) => `${id}=${type.id}`).join(',');
  }

  private instantiateObject(type: ObjectType, mapper: Mapper): Type {
    switch (type.objectKind) {
      case 'reference': {
        return this.reference(
          type.target as ObjectType,
          (type.typeArguments ?? []).map((argument) => this.instantiate(argument, mapper))
        );
      }
      case 'tuple': {
        const tuple = type.tuple as NonNullable<ObjectType['tuple']>;
        return this.tupleType(
          tuple.elements.map((element) => ({ ...element, type: this.instantiate(element.type, mapper) })),
          tuple.readonly
        );
      }
      case 'mapped': {
        const mapped = type.mapped as MappedInfo;
        return this.mappedType({
          ...mapped,
          constraint: this.instantiate(mapped.constraint, mapper),
          nameType: mapped.nameType && this.instantiate(mapped.nameType, mapper),
          source: mapped.source && this.instantiate(mapped.source, mapper),
          template: this.instantiate(mapped.template, mapper),
        });
      }
      case 'interface': {
        // A generic interface or class stands for itself applied to its own type parameters.
        const parameters = type.typeParameters ?? [];
        if (!parameters.some((parameter) => mapper.has(parameter.id))) return type;
        return this.reference(
          type,
          parameters.map((parameter) => mapper.get(parameter.id) ?? parameter)
        );
      }
      default: {
        break;
      }
    }
    const key = `${type.id}[${this.mapperKey(mapper)}]`;
    const cached = this.instantiationCache.get(key);
    if (cached) return cached;
    const instantiated = anonymousObject(() => this.instantiateStructure(type.resolve(), mapper), {
      isFunction: type.isFunction,
      isLiteral: type.isLiteral,
      classInfo: type.classInfo,
      isClassStatic: type.isClassStatic,
      name: type.name,
      aliasName: type.aliasName,
      aliasArguments: type.aliasArguments?.map((argument) => this.instantiate(argument, mapper)),
    });
    this.instantiationCache.set(key, instantiated);
    return instantiated;
  }

  instantiateStructure(structure: Structure, mapper: Mapper): Structure {
    const properties = new Map<string, Property>();
    for (const [name, property] of structure.properties) {
      let type: Type | undefined;
      properties.set(name, {
        ...property,
        type: () => {
          type ??= this.instantiate(property.type(), mapper);
          return type;
        },
      });
    }
    const index = (info: IndexInfo | undefined): IndexInfo | undefined =>
      info && { ...info, type: this.instantiate(info.type, mapper) };
    return {
      properties,
      callSignatures: structure.callSignatures.map((signature) => this.instantiateSignature(signature, mapper)),
      constructSignatures: structure.constructSignatures.map((signature) =>
        this.instantiateSignature(signature, mapper)
      ),
      stringIndex: index(structure.stringIndex),
      numberIndex: index(structure.numberIndex),
    };
  }

  instantiateSignature(signature: Signature, outer: Mapper): Signature {
    let returnType: Type | undefined;
    let mapper = outer;
    let typeParameters = signature.typeParameters;
    // The signature's own type parameters get fresh copies whose constraints see the outer type arguments.
    if (typeParameters.length > 0 && outer.size > 0 && !typeParameters.some((parameter) => outer.has(parameter.id))) {
      mapper = new Map(outer);
      const fresh = typeParameters.map((parameter): TypeParameter => ({ ...parameter, id: newTypeId() }));
      for (const [index, parameter] of typeParameters.entries()) mapper.set(parameter.id, fresh[index]);
      for (const [index, parameter] of typeParameters.entries()) {
        const { constraint, default: defaultType } = parameter;
        const inner = mapper;
        fresh[index].constraint =
          constraint &&
          (() => {
            const type = constraint();
            return type && this.instantiate(type, inner);
          });
        fresh[index].default =
          defaultType &&
          (() => {
            const type = defaultType();
            return type && this.instantiate(type, inner);
          });
      }
      typeParameters = fresh;
    }
    return {
      ...signature,
      typeParameters,
      parameters: this.expandRestTuple(
        signature.parameters.map((parameter) => ({ ...parameter, type: this.instantiate(parameter.type, mapper) }))
      ),
      thisType: signature.thisType && this.instantiate(signature.thisType, mapper),
      returnType: () => {
        returnType ??= this.instantiate(signature.returnType(), mapper);
        return returnType;
      },
      predicate: signature.predicate && {
        ...signature.predicate,
        type: this.instantiate(signature.predicate.type, mapper),
      },
    };
  }

  tupleType(elements: TupleElement[], readonly = false): ObjectType {
    // A rest element of a tuple type spreads into the tuple.
    const flat: TupleElement[] = [];
    for (const element of elements) {
      if (element.rest && element.type.kind === 'object' && element.type.objectKind === 'tuple') {
        flat.push(...(element.type.tuple?.elements ?? []));
      } else {
        flat.push(element);
      }
    }
    let structure: Structure | undefined;
    const tuple: ObjectType = {
      kind: 'object',
      id: newTypeId(),
      objectKind: 'tuple',
      tuple: { elements: flat, readonly },
      resolve: () => {
        if (structure) return structure;
        const element = unionOf(flat.map((member) => (member.rest ? this.restElementType(member.type) : member.type)));
        const base = this.arrayType(element, readonly).resolve();
        const properties = new Map(base.properties);
        for (const [index, member] of flat.entries()) {
          if (member.rest) break;
          properties.set(
            String(index),
            simpleProperty(String(index), member.type, { optional: member.optional, readonly })
          );
        }
        const fixedLength = flat.every((member) => !member.rest && !member.optional);
        properties.set(
          'length',
          simpleProperty('length', fixedLength ? literalType(flat.length) : numberType, { readonly: true })
        );
        structure = { ...base, properties };
        return structure;
      },
    };
    return tuple;
  }

  restElementType(type: Type): Type {
    if (type.kind === 'object' && this.isArrayOrTuple(type)) return this.elementTypeOf(type);
    return anyType;
  }

  // Structures ---------------------------------------------------------------------------------------------------

  /** The members of a type, with those of the interface its primitives box to. */
  structureOf(type: Type): Structure {
    const apparent = this.apparentType(type);
    if (apparent.kind === 'object') {
      const thisType = apparent.thisType ?? apparent.target?.thisType;
      if (!thisType) return apparent.resolve();
      let structure = this.thisStructures.get(apparent.id);
      if (!structure) {
        structure = this.instantiateStructure(apparent.resolve(), new Map([[thisType.id, apparent]]));
        this.thisStructures.set(apparent.id, structure);
      }
      return structure;
    }
    if (apparent.kind === 'intersection') return this.intersectionStructure(apparent.types);
    return emptyStructure();
  }

  /** The type whose members a value of `type` has: its boxing interface for a primitive, its constraint for a type parameter. */
  apparentType(type: Type): Type {
    switch (type.kind) {
      case 'intrinsic': {
        switch (type.name) {
          case 'string': {
            return this.globalType('String');
          }
          case 'number': {
            return this.globalType('Number');
          }
          case 'bigint': {
            return this.globalType('BigInt');
          }
          case 'symbol': {
            return this.globalType('Symbol');
          }
          case 'object': {
            return this.globalType('Object');
          }
          default: {
            return type;
          }
        }
      }
      case 'literal': {
        if (typeof type.value === 'string') return this.globalType('String');
        if (typeof type.value === 'number') return this.globalType('Number');
        if (typeof type.value === 'bigint') return this.globalType('BigInt');
        return this.globalType('Boolean');
      }
      case 'templateLiteral':
      case 'stringMapping': {
        return this.globalType('String');
      }
      case 'typeParameter': {
        const constraint = this.constraintOf(type);
        return constraint ? this.apparentType(constraint) : this.globalType('Object');
      }
      case 'indexedAccess':
      case 'keyof':
      case 'conditional': {
        const constraint = this.baseConstraint(type);
        return constraint === type ? unknownType : this.apparentType(constraint);
      }
      case 'union': {
        if (type === booleanType) return this.globalType('Boolean');
        return type;
      }
      default: {
        return type;
      }
    }
  }

  constraintOf(parameter: TypeParameter): Type | undefined {
    return parameter.constraint?.();
  }

  /** The type a generic type stands for at most, which its members come from. */
  baseConstraint(type: Type): Type {
    switch (type.kind) {
      case 'typeParameter': {
        return this.constraintOf(type) ?? unknownType;
      }
      case 'indexedAccess': {
        const object = this.baseConstraint(type.objectType);
        const index = this.baseConstraint(type.indexType);
        if (object === type.objectType && index === type.indexType) return type;
        return this.silently(() => this.indexedAccess(object, index));
      }
      case 'keyof': {
        return unionOf([stringType, numberType, symbolType]);
      }
      case 'conditional': {
        return unionOf([this.baseConstraint(type.trueType), this.baseConstraint(type.falseType)]);
      }
      default: {
        return type;
      }
    }
  }

  private intersectionStructure(types: Type[]): Structure {
    const structures = types.map((member) => this.structureOf(member));
    const properties = new Map<string, Property>();
    for (const structure of structures) {
      for (const [name, property] of structure.properties) {
        const existing = properties.get(name);
        if (!existing) {
          properties.set(name, property);
          continue;
        }
        properties.set(name, {
          ...existing,
          optional: existing.optional && property.optional,
          readonly: existing.readonly && property.readonly,
          type: () => intersectionOf([existing.type(), property.type()]),
        });
      }
    }
    return {
      properties,
      callSignatures: structures.flatMap((structure) => structure.callSignatures),
      constructSignatures: structures.flatMap((structure) => structure.constructSignatures),
      stringIndex: structures.find((structure) => structure.stringIndex)?.stringIndex,
      numberIndex: structures.find((structure) => structure.numberIndex)?.numberIndex,
    };
  }

  /** A property of a type, including those `Object` and `Function` give every object and function. */
  propertyOf(type: Type, name: string): Property | undefined {
    const structure = this.structureOf(type);
    const own = structure.properties.get(name);
    if (own) return own;
    const apparent = this.apparentType(type);
    if (apparent.kind !== 'object' && apparent.kind !== 'intersection') return undefined;
    if (structure.callSignatures.length > 0 || structure.constructSignatures.length > 0) {
      const functionProperty = this.globalType('Function').resolve().properties.get(name);
      if (functionProperty) return functionProperty;
    }
    return this.globalType('Object').resolve().properties.get(name);
  }

  signaturesOf(type: Type, kind: 'call' | 'construct'): Signature[] {
    const structure = this.structureOf(type);
    return kind === 'call' ? structure.callSignatures : structure.constructSignatures;
  }

  // Types written in the program --------------------------------------------------------------------------------

  typeFromNode(node: TreeNode): Type {
    const cached = this.typeNodeCache.get(node.id);
    if (cached) return cached;
    const type = this.computeTypeFromNode(node);
    this.typeNodeCache.set(node.id, type);
    return type;
  }

  /** The type of a `type_annotation` or of the type node a field holds. */
  annotationType(node: TreeNode | null | undefined): Type | undefined {
    if (!node) return undefined;
    if (
      node.type === 'type_annotation' ||
      node.type === 'omitting_type_annotation' ||
      node.type === 'adding_type_annotation' ||
      node.type === 'opting_type_annotation'
    ) {
      const inner = named(node)[0];
      return inner ? this.typeFromNode(inner) : undefined;
    }
    if (node.type === 'type_predicate_annotation') return booleanType;
    return this.typeFromNode(node);
  }

  // code-gauge-allow functionCognitiveComplexity 60 -- One case per kind of type syntax.
  private computeTypeFromNode(node: TreeNode): Type {
    switch (node.type) {
      case 'predefined_type': {
        return predefinedTypes[node.text] ?? (node.text === 'unique symbol' ? symbolType : anyType);
      }
      case 'type_identifier':
      case 'identifier': {
        return this.typeReference(node, node, []);
      }
      case 'generic_type': {
        const name = node.childForFieldName('name') as TreeNode;
        const argumentsNode = node.childForFieldName('type_arguments');
        const typeArguments = argumentsNode ? named(argumentsNode).map((argument) => this.typeFromNode(argument)) : [];
        return this.typeReference(node, name, typeArguments);
      }
      case 'parenthesized_type': {
        return this.typeFromNode(named(node)[0]);
      }
      case 'literal_type': {
        return this.literalTypeOf(named(node)[0]);
      }
      case 'union_type': {
        return unionOf(named(node).map((member) => this.typeFromNode(member)));
      }
      case 'intersection_type': {
        return intersectionOf(named(node).map((member) => this.typeFromNode(member)));
      }
      case 'array_type': {
        return this.arrayType(this.typeFromNode(named(node)[0]));
      }
      case 'readonly_type': {
        const inner = this.typeFromNode(named(node)[0]);
        if (this.isArrayType(inner)) return this.arrayType(this.elementTypeOf(inner as ObjectType), true);
        if (inner.kind === 'object' && inner.objectKind === 'tuple')
          return this.tupleType(inner.tuple?.elements ?? [], true);
        return inner;
      }
      case 'tuple_type': {
        return this.tupleType(named(node).map((element) => this.tupleElement(element)));
      }
      case 'function_type':
      case 'constructor_type': {
        const signature = this.signatureOf(node);
        if (node.type === 'function_type') return functionType(signature);
        return anonymousObject(() => ({ ...emptyStructure(), constructSignatures: [signature] }), { isFunction: true });
      }
      case 'object_type': {
        return this.objectTypeLiteral(node);
      }
      case 'type_query': {
        return this.expressions.typeOfQuery(named(node)[0]);
      }
      case 'index_type_query': {
        return this.keyofType(this.typeFromNode(named(node)[0]));
      }
      case 'lookup_type': {
        const [object, index] = named(node);
        const objectType = this.typeFromNode(object);
        const indexType = this.typeFromNode(index);
        if (objectType.kind === 'typeParameter' && indexType.kind === 'literal') {
          // A type parameter can be indexed only by the keys its constraint has.
          const constraint = this.constraintOf(objectType);
          const name = String(indexType.value);
          if (
            !this.narrowedByConditional(node, object.text) &&
            (!constraint || (!this.propertyOf(constraint, name) && !this.structureOf(constraint).stringIndex))
          ) {
            this.error(index, `型 '${this.print(indexType)}' は型 '${objectType.name}' のインデックスに使えません。`);
            return errorType;
          }
        }
        return this.indexedAccess(objectType, indexType, index);
      }
      case 'conditional_type': {
        return this.conditionalTypeFromNode(node);
      }
      case 'infer_type': {
        const name = named(node)[0];
        return this.inferParameterFor(node, name.text) ?? anyType;
      }
      case 'template_literal_type': {
        const texts: string[] = [''];
        const types: Type[] = [];
        for (const child of node.namedChildren) {
          if (!child) continue;
          if (child.type === 'template_type') {
            types.push(this.typeFromNode(named(child)[0]));
            texts.push('');
          } else {
            texts[texts.length - 1] += child.text;
          }
        }
        return this.templateLiteral(texts, types);
      }
      case 'this_type': {
        return this.classes.thisTypeAt(node);
      }
      case 'type_predicate': {
        return booleanType;
      }
      case 'type_annotation': {
        return this.annotationType(node) ?? anyType;
      }
      default: {
        return anyType;
      }
    }
  }

  /** Whether a type node is in the true branch of a conditional type that checks `name`, which constrains it more. */
  private narrowedByConditional(node: TreeNode, name: string): boolean {
    let child = node;
    for (let current = node.parent; current; current = current.parent) {
      if (
        current.type === 'conditional_type' &&
        current.childForFieldName('left')?.text === name &&
        current.childForFieldName('consequence')?.id === child.id
      ) {
        return true;
      }
      child = current;
    }
    return false;
  }

  private literalTypeOf(node: TreeNode): Type {
    switch (node.type) {
      case 'string': {
        return literalType(stringValue(node));
      }
      case 'number': {
        return literalType(numberValue(node.text));
      }
      case 'true': {
        return trueType;
      }
      case 'false': {
        return falseType;
      }
      case 'null': {
        return nullType;
      }
      case 'undefined': {
        return undefinedType;
      }
      case 'unary_expression': {
        const value = numberValue(named(node)[0].text);
        return literalType(typeof value === 'bigint' ? -value : -value);
      }
      default: {
        return anyType;
      }
    }
  }

  private tupleElement(node: TreeNode): TupleElement {
    switch (node.type) {
      case 'optional_type': {
        return { type: this.typeFromNode(named(node)[0]), optional: true, rest: false };
      }
      case 'rest_type': {
        return { type: this.typeFromNode(named(node)[0]), optional: false, rest: true };
      }
      case 'required_parameter':
      case 'optional_parameter': {
        const nameNode = node.childForFieldName('name') ?? node.childForFieldName('pattern');
        const rest = nameNode?.type === 'rest_pattern';
        return {
          type: this.annotationType(node.childForFieldName('type')) ?? anyType,
          optional: node.type === 'optional_parameter',
          rest,
          name: rest ? named(nameNode as TreeNode)[0]?.text : nameNode?.text,
        };
      }
      default: {
        return { type: this.typeFromNode(node), optional: false, rest: false };
      }
    }
  }

  /** The type a name refers to in a type position, applied to type arguments. */
  private typeReference(node: TreeNode, nameNode: TreeNode, typeArguments: Type[]): Type {
    const name = nameNode.text;
    const local = this.mappedOrInferParameter(nameNode, name);
    if (local) return local;
    if (
      stringMappings.has(name) &&
      typeArguments.length === 1 &&
      !this.scopeOf(nameNode).lookupType(name)?.typeDeclarations.length
    )
      return this.stringMapping(name as 'Uppercase', typeArguments[0]);
    const symbol = this.scopeOf(nameNode).lookupType(name);
    if (!symbol) {
      if (stringMappings.has(name) && typeArguments.length === 1)
        return this.stringMapping(name as 'Uppercase', typeArguments[0]);
      const value = this.scopeOf(nameNode).lookupValue(name);
      this.error(
        nameNode,
        value
          ? `${name} は値であり、型としては使えません。型を表すには typeof ${name} と書いてください。`
          : `型 ${name} が見つかりません。`
      );
      return errorType;
    }
    const declared = this.declaredTypeOf(symbol);
    const parameters = this.typeParametersOfSymbol(symbol);
    if (parameters.length === 0) {
      if (typeArguments.length > 0) this.error(node, `型 ${name} は型引数をとりません。`);
      return declared;
    }
    const required = parameters.filter((parameter) => !parameter.default).length;
    if (
      (typeArguments.length < required || typeArguments.length > parameters.length) &&
      !(typeArguments.length === 0 && this.insideOwnDeclaration(node, symbol))
    ) {
      this.error(
        node,
        required === parameters.length
          ? `ジェネリック型 ${name} には型引数が ${required} 個必要です。`
          : `ジェネリック型 ${name} には型引数が ${required} 個から ${parameters.length} 個必要です。`
      );
      return errorType;
    }
    const filled = parameters.map((parameter, index) => typeArguments[index] ?? parameter.default?.() ?? unknownType);
    this.checkTypeArgumentConstraints(node, parameters, filled);
    if (symbol.typeKind === 'alias') {
      const mapper: Mapper = new Map(parameters.map((parameter, index) => [parameter.id, filled[index]]));
      const instantiated = this.instantiate(declared, mapper);
      return instantiated;
    }
    return this.reference(declared as ObjectType, filled);
  }

  checkTypeArgumentConstraints(node: TreeNode, parameters: TypeParameter[], typeArguments: Type[]): void {
    const mapper: Mapper = new Map(parameters.map((parameter, index) => [parameter.id, typeArguments[index]]));
    for (const [index, parameter] of parameters.entries()) {
      const constraint = parameter.constraint?.();
      if (!constraint) continue;
      const argument = typeArguments[index];
      const instantiated = this.instantiate(constraint, mapper);
      if (!this.relations.isAssignable(argument, instantiated)) {
        this.error(node, `型 '${this.print(argument)}' は制約 '${this.print(instantiated)}' を満たしていません。`);
      }
    }
  }

  private insideOwnDeclaration(node: TreeNode, symbol: Sym): boolean {
    for (let current: TreeNode | null = node; current; current = current.parent) {
      if (symbol.typeDeclarations.some((declaration) => declaration.id === current?.id)) return true;
    }
    return false;
  }

  /** The type parameter of a mapped type or an `infer` that `name` refers to at `node`, if any. */
  private mappedOrInferParameter(node: TreeNode, name: string): TypeParameter | undefined {
    let child: TreeNode = node;
    for (let current = node.parent; current; current = current.parent) {
      if (current.type === 'conditional_type') {
        const fieldName = this.fieldNameOf(current, child);
        if (fieldName === 'consequence' || fieldName === 'right') {
          const parameter = this.inferParametersOf(current).get(name);
          if (parameter) return parameter;
        }
      }
      if (current.type === 'index_signature') {
        const clause = current.namedChildren.find((member) => member?.type === 'mapped_type_clause');
        if (
          clause &&
          clause.childForFieldName('name')?.text === name &&
          child.id !== clause.childForFieldName('type')?.id
        ) {
          return this.mappedParameterOf(clause);
        }
      }
      if (current.type === 'mapped_type_clause' && current.childForFieldName('name')?.text === name) {
        const fieldName = this.fieldNameOf(current, child);
        if (fieldName === 'alias') return this.mappedParameterOf(current);
      }
      child = current;
    }
    return undefined;
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
    if (extendsNode) {
      const visit = (node: TreeNode): void => {
        if (node.type === 'conditional_type' && node.id !== conditional.id) {
          // A nested conditional type's own `infer`s in its extends type belong to it.
          for (const fieldName of ['left', 'consequence', 'alternative']) {
            const child = node.childForFieldName(fieldName);
            if (child) visit(child);
          }
          return;
        }
        if (node.type === 'infer_type') {
          const name = named(node)[0];
          if (name && !parameters?.has(name.text)) {
            const constraintNode = named(node)[1];
            parameters?.set(name.text, {
              kind: 'typeParameter',
              id: newTypeId(),
              name: name.text,
              constraint: constraintNode ? () => this.typeFromNode(constraintNode) : undefined,
            });
          }
        }
        for (const child of named(node)) visit(child);
      };
      visit(extendsNode);
    }
    return parameters;
  }

  private inferParameterFor(node: TreeNode, name: string): TypeParameter | undefined {
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
        constraint: constraintNode ? () => this.typeFromNode(constraintNode) : undefined,
      };
      this.mappedParameters.set(clause.id, parameter);
    }
    return parameter;
  }

  private objectTypeLiteral(node: TreeNode): Type {
    const members = named(node);
    const mappedSignature = members.find(
      (member) =>
        member.type === 'index_signature' && member.namedChildren.some((child) => child?.type === 'mapped_type_clause')
    );
    if (mappedSignature) return this.mappedTypeFromNode(mappedSignature);
    return anonymousObject(() => this.membersStructure(members), { isLiteral: false });
  }

  private mappedTypeFromNode(signature: TreeNode): Type {
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
    const constraint = constraintNode ? this.typeFromNode(constraintNode) : neverType;
    let source: Type | undefined;
    if (constraintNode?.type === 'index_type_query') source = this.typeFromNode(named(constraintNode)[0]);
    else if (constraint.kind === 'typeParameter') {
      const outer = constraint.constraint?.();
      if (outer?.kind === 'keyof') source = outer.type;
    }
    return this.mappedType({
      typeParameter: parameter,
      source,
      constraint,
      nameType: aliasNode ? this.typeFromNode(aliasNode) : undefined,
      template: this.annotationType(typeNode) ?? anyType,
      readonlyModifier,
      optionalModifier,
    });
  }

  /** A mapped type, resolved to an object type once its keys are known. */
  mappedType(info: MappedInfo): Type {
    const { constraint } = info;
    if (this.relations.isGeneric(constraint)) {
      return {
        kind: 'object',
        id: newTypeId(),
        objectKind: 'mapped',
        mapped: info,
        resolve: () => emptyStructure(),
      };
    }
    // A homomorphic mapped type over an array or a tuple maps its elements.
    const { source } = info;
    if (source && source.kind === 'object' && this.isArrayOrTuple(source) && !info.nameType) {
      if (source.objectKind === 'tuple') {
        return this.tupleType(
          (source.tuple?.elements ?? []).map((element, index) => ({
            ...element,
            type: this.instantiate(info.template, new Map([[info.typeParameter.id, literalType(String(index))]])),
            optional: info.optionalModifier === '-' ? false : info.optionalModifier === '+' || element.optional,
          })),
          info.readonlyModifier === '+' || (info.readonlyModifier !== '-' && (source.tuple?.readonly ?? false))
        );
      }
      const element = this.instantiate(info.template, new Map([[info.typeParameter.id, numberType]]));
      return this.arrayType(
        element,
        info.readonlyModifier === '+' || (info.readonlyModifier !== '-' && this.isReadonlyArrayType(source))
      );
    }
    return anonymousObject(() => {
      const structure = emptyStructure();
      const keys = constraint.kind === 'union' ? constraint.types : [constraint];
      for (const key of keys) {
        const mapper: Mapper = new Map([[info.typeParameter.id, key]]);
        const nameType = info.nameType ? this.instantiate(info.nameType, mapper) : key;
        for (const nameMember of nameType.kind === 'union' ? nameType.types : [nameType]) {
          if (nameMember.kind === 'literal' && typeof nameMember.value !== 'boolean') {
            const name = String(nameMember.value);
            const sourceProperty = source ? this.propertyOf(source, name) : undefined;
            const optional =
              info.optionalModifier === '+' || (info.optionalModifier !== '-' && (sourceProperty?.optional ?? false));
            const readonly =
              info.readonlyModifier === '+' || (info.readonlyModifier !== '-' && (sourceProperty?.readonly ?? false));
            let type: Type | undefined;
            structure.properties.set(name, {
              name,
              type: () => {
                if (type) return type;
                let mappedType = this.instantiate(info.template, new Map([[info.typeParameter.id, key]]));
                if (info.optionalModifier === '-') mappedType = this.relations.removeUndefined(mappedType);
                type = mappedType;
                return type;
              },
              optional,
              readonly,
              isMethod: false,
              visibility: 'public',
            });
          } else if (isIntrinsic(nameMember, 'string')) {
            structure.stringIndex = {
              type: this.instantiate(info.template, mapper),
              readonly: info.readonlyModifier === '+',
            };
          } else if (isIntrinsic(nameMember, 'number')) {
            structure.numberIndex = {
              type: this.instantiate(info.template, mapper),
              readonly: info.readonlyModifier === '+',
            };
          }
        }
      }
      return structure;
    });
  }

  /** The members of an interface body or an object type literal. */
  membersStructure(members: TreeNode[]): Structure {
    const structure = emptyStructure();
    const methods = new Map<string, Signature[]>();
    for (const member of members) {
      switch (member.type) {
        case 'property_signature': {
          const nameNode = member.childForFieldName('name') as TreeNode;
          const name = propertyNameText(nameNode);
          if (name === undefined) break;
          const typeNode = member.childForFieldName('type');
          structure.properties.set(name, {
            name,
            type: () => this.annotationType(typeNode) ?? this.implicitAnyMember(member, nameNode),
            optional: member.children.some((child) => child?.type === '?'),
            readonly: member.children.some((child) => child?.type === 'readonly'),
            isMethod: false,
            visibility: 'public',
            declaration: member,
          });
          break;
        }
        case 'method_signature': {
          const nameNode = member.childForFieldName('name') as TreeNode;
          const name = propertyNameText(nameNode);
          if (name === undefined) break;
          const signatures = methods.get(name) ?? [];
          signatures.push({ ...this.signatureOf(member), isMethod: true });
          methods.set(name, signatures);
          if (!structure.properties.has(name) || methods.get(name)?.length === 1) {
            structure.properties.set(name, {
              name,
              type: () => this.overloadedFunction(signatures),
              optional: member.children.some((child) => child?.type === '?'),
              readonly: false,
              isMethod: true,
              visibility: 'public',
              declaration: member,
            });
          }
          break;
        }
        case 'call_signature': {
          structure.callSignatures.push(this.signatureOf(member));
          break;
        }
        case 'construct_signature': {
          structure.constructSignatures.push(this.signatureOf(member));
          break;
        }
        case 'index_signature': {
          const indexType = member.childForFieldName('index_type');
          const info: IndexInfo = {
            type: this.annotationType(member.childForFieldName('type')) ?? anyType,
            readonly: member.children.some((child) => child?.type === 'readonly'),
          };
          const keyType = indexType ? this.typeFromNode(indexType) : stringType;
          if (isIntrinsic(keyType, 'number')) structure.numberIndex = info;
          else structure.stringIndex = info;
          break;
        }
        default: {
          break;
        }
      }
    }
    return structure;
  }

  private implicitAnyMember(member: TreeNode, nameNode: TreeNode): Type {
    if (!this.isLibrary(member)) this.error(nameNode, `メンバー ${nameNode.text} の型が暗黙に any になります。`);
    return anyType;
  }

  overloadedFunction(signatures: Signature[]): ObjectType {
    return anonymousObject(() => ({ ...emptyStructure(), callSignatures: signatures }), { isFunction: true });
  }

  /** The signature a function-like node declares, from its annotations alone. */
  signatureOf(node: TreeNode, contextual?: Signature): Signature {
    if (!contextual) {
      const cached = this.signatureCache.get(node.id);
      if (cached) return cached;
    }
    const typeParameters = this.typeParametersOf(node);
    const parameters: Parameter[] = [];
    let thisType: Type | undefined;
    const parametersNode = node.childForFieldName('parameters');
    const parameterNodes = parametersNode ? named(parametersNode) : [];
    const single = node.childForFieldName('parameter');
    if (single) parameterNodes.push(single);
    let index = 0;
    for (const parameterNode of parameterNodes) {
      const pattern = parameterNode.childForFieldName('pattern') ?? parameterNode;
      const annotation = this.annotationType(parameterNode.childForFieldName('type'));
      if (pattern.type === 'this') {
        thisType = annotation;
        continue;
      }
      const rest = pattern.type === 'rest_pattern';
      const contextualParameter = contextual ? this.contextualParameterType(contextual, index, rest) : undefined;
      const value = parameterNode.childForFieldName('value');
      const type =
        annotation ??
        contextualParameter ??
        this.setterParameterType(node) ??
        (value
          ? this.expressions.widenedTypeOfInitializer(value)
          : this.expressions.implicitParameterType(parameterNode, pattern, rest));
      parameters.push({
        name: rest ? (named(pattern)[0]?.text ?? 'args') : pattern.type === 'identifier' ? pattern.text : `__${index}`,
        type,
        optional: parameterNode.type === 'optional_parameter' || value !== null,
        rest,
      });
      index++;
    }
    const returnNode =
      node.childForFieldName('return_type') ??
      (['construct_signature', 'constructor_type'].includes(node.type) ? node.childForFieldName('type') : undefined);
    let predicate: Signature['predicate'];
    if (returnNode?.type === 'type_predicate_annotation') {
      const predicateNode = named(returnNode)[0];
      const name = predicateNode?.childForFieldName('name')?.text;
      const typeNode = predicateNode?.childForFieldName('type');
      if (name && typeNode) {
        predicate = {
          index: name === 'this' ? -1 : parameters.findIndex((parameter) => parameter.name === name),
          type: this.typeFromNode(typeNode),
        };
      }
    }
    let returnType: Type | undefined;
    const signature: Signature = {
      typeParameters,
      parameters: this.expandRestTuple(parameters),
      thisType,
      predicate,
      declaration: node,
      isAbstract: node.type === 'constructor_type' && node.children.some((child) => child?.type === 'abstract'),
      returnType: () => {
        if (returnType) return returnType;
        if (returnNode) returnType = this.annotationType(returnNode) ?? anyType;
        else if (node.childForFieldName('body')) returnType = this.expressions.inferredReturnType(node, signature);
        else returnType = this.implicitReturnType(node);
        return returnType;
      },
    };
    if (!contextual) this.signatureCache.set(node.id, signature);
    return signature;
  }

  /** A setter's parameter without an annotation has the type its getter returns. */
  private setterParameterType(node: TreeNode): Type | undefined {
    if (node.type !== 'method_definition' || !node.children.some((child) => child?.type === 'set')) return undefined;
    const name = node.childForFieldName('name')?.text;
    const getter = node.parent
      ? named(node.parent).find(
          (member) =>
            member.type === 'method_definition' &&
            member.childForFieldName('name')?.text === name &&
            member.children.some((child) => child?.type === 'get')
        )
      : undefined;
    return getter ? this.signatureOf(getter).returnType() : undefined;
  }

  /** Parameters whose rest parameter of a tuple type, `...args: [string, number]`, becomes the parameters it lists. */
  expandRestTuple(parameters: Parameter[]): Parameter[] {
    const last = parameters.at(-1);
    if (!last?.rest || last.type.kind !== 'object' || last.type.objectKind !== 'tuple') return parameters;
    const elements = last.type.tuple?.elements ?? [];
    return [
      ...parameters.slice(0, -1),
      ...elements.map((element, index) => ({
        name: element.name ?? `${last.name}_${index}`,
        type: element.rest ? element.type : element.type,
        optional: element.optional,
        rest: element.rest,
      })),
    ];
  }

  private implicitReturnType(node: TreeNode): Type {
    if (!this.isLibrary(node) && !['method_definition'].includes(node.type)) {
      const name = node.childForFieldName('name');
      this.error(name ?? node, `${name ? name.text : 'この宣言'} の戻り値の型が暗黙に any になります。`);
    }
    return anyType;
  }

  private contextualParameterType(signature: Signature, index: number, rest: boolean): Type | undefined {
    const { parameters } = signature;
    if (rest) {
      const remaining = parameters.slice(index);
      if (remaining.length === 1 && remaining[0].rest) return remaining[0].type;
      return this.tupleType(
        remaining.map((parameter) => ({ type: parameter.type, optional: parameter.optional, rest: parameter.rest }))
      );
    }
    if (index < parameters.length) {
      const parameter = parameters[index];
      if (parameter.rest) return this.restElementType(parameter.type);
      return parameter.type;
    }
    const last = parameters.at(-1);
    if (last?.rest) return this.restElementType(last.type);
    return undefined;
  }

  typeParametersOf(node: TreeNode): TypeParameter[] {
    // The declarations of a merged interface share the first one's type parameters.
    const first = this.firstDeclarationOf(node);
    if (first && first.id !== node.id) return this.typeParametersOf(first);
    const parametersNode = node.childForFieldName('type_parameters');
    if (!parametersNode) return [];
    const scope = this.ownScope(node) ?? this.scopeOf(node);
    return named(parametersNode).map((parameterNode) => {
      const name = parameterNode.childForFieldName('name')?.text ?? 'T';
      const symbol = scope.types.get(name);
      return symbol ? this.typeParameterOfSymbol(symbol) : this.newTypeParameter(parameterNode);
    });
  }

  private typeParameterOfSymbol(symbol: Sym): TypeParameter {
    if (symbol.typeParameter) return symbol.typeParameter;
    const declaration = symbol.typeDeclarations[0];
    const owner = declaration.parent?.parent;
    const first = owner ? this.firstDeclarationOf(owner) : undefined;
    if (owner && first && first.id !== owner.id) {
      const index = named(declaration.parent as TreeNode).findIndex((parameter) => parameter.id === declaration.id);
      const shared = this.typeParametersOf(first)[index];
      if (shared) {
        symbol.typeParameter = shared;
        return shared;
      }
    }
    symbol.typeParameter = this.newTypeParameter(declaration);
    return symbol.typeParameter;
  }

  /** The first declaration of the interface a declaration merges into, if it is one. */
  private firstDeclarationOf(node: TreeNode): TreeNode | undefined {
    if (node.type !== 'interface_declaration') return undefined;
    const name = node.childForFieldName('name')?.text;
    if (!name) return undefined;
    return this.scopeOf(node).lookupType(name)?.typeDeclarations[0];
  }

  private newTypeParameter(node: TreeNode): TypeParameter {
    const constraintNode = node.childForFieldName('constraint');
    const defaultNode = node.childForFieldName('value');
    return {
      kind: 'typeParameter',
      id: newTypeId(),
      name: node.childForFieldName('name')?.text ?? 'T',
      constraint: constraintNode ? () => this.typeFromNode(named(constraintNode)[0]) : undefined,
      default: defaultNode ? () => this.typeFromNode(named(defaultNode)[0]) : undefined,
    };
  }

  typeParametersOfSymbol(symbol: Sym): TypeParameter[] {
    if (symbol.typeKind === 'typeParameter') return [];
    const declaration = symbol.typeDeclarations[0];
    if (!declaration) return [];
    return this.typeParametersOf(declaration);
  }

  /** The type a type name stands for: an interface, a class's instance type, an alias, or a type parameter. */
  declaredTypeOf(symbol: Sym): Type {
    if (symbol.declaredType) return symbol.declaredType;
    switch (symbol.typeKind) {
      case 'typeParameter': {
        symbol.declaredType = this.typeParameterOfSymbol(symbol);
        break;
      }
      case 'interface': {
        symbol.declaredType = this.interfaceType(symbol);
        break;
      }
      case 'class': {
        symbol.declaredType = this.classes.classInfoOf(symbol).instanceType;
        break;
      }
      case 'alias': {
        if (symbol.resolving) {
          this.error(symbol.typeDeclarations[0], `型エイリアス ${symbol.name} が自分自身を参照しています。`);
          return errorType;
        }
        symbol.resolving = true;
        const value = symbol.typeDeclarations[0].childForFieldName('value');
        let type = value ? this.typeFromNode(value) : anyType;
        symbol.resolving = false;
        if (type.kind === 'object' && type.objectKind === 'anonymous' && !type.aliasName) {
          type = { ...type, aliasName: symbol.name, aliasArguments: this.typeParametersOfSymbol(symbol) };
        }
        symbol.declaredType ??= type;
        break;
      }
      default: {
        symbol.declaredType = anyType;
      }
    }
    return symbol.declaredType;
  }

  private interfaceType(symbol: Sym): ObjectType {
    let structure: Structure | undefined;
    const typeParameters = this.typeParametersOfSymbol(symbol);
    const type: ObjectType = {
      kind: 'object',
      id: newTypeId(),
      objectKind: 'interface',
      name: symbol.name,
      typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
      resolve: () => {
        if (structure) return structure;
        structure = emptyStructure();
        const own = this.membersStructure(
          symbol.typeDeclarations.flatMap((declaration) => {
            const body = declaration.childForFieldName('body');
            return body ? named(body) : [];
          })
        );
        const bases = symbol.typeDeclarations.flatMap((declaration) => {
          const clause = declaration.namedChildren.find((child) => child?.type === 'extends_type_clause');
          return clause ? named(clause).map((base) => this.typeFromNode(base)) : [];
        });
        structure = this.mergeBases(own, bases);
        return structure;
      },
    };
    return type;
  }

  /** The members of a type with those of its bases that it does not redeclare. */
  mergeBases(own: Structure, bases: Type[]): Structure {
    const properties = new Map(own.properties);
    let { stringIndex, numberIndex } = own;
    const callSignatures = [...own.callSignatures];
    const constructSignatures = [...own.constructSignatures];
    for (const base of bases) {
      if (base.kind !== 'object' && base.kind !== 'intersection') continue;
      const baseStructure = this.structureOf(base);
      for (const [name, property] of baseStructure.properties)
        if (!properties.has(name)) properties.set(name, property);
      stringIndex ??= baseStructure.stringIndex;
      numberIndex ??= baseStructure.numberIndex;
      if (callSignatures.length === 0) callSignatures.push(...baseStructure.callSignatures);
      if (constructSignatures.length === 0) constructSignatures.push(...baseStructure.constructSignatures);
    }
    return { properties, callSignatures, constructSignatures, stringIndex, numberIndex };
  }

  // Type operators -----------------------------------------------------------------------------------------------

  keyofType(type: Type): Type {
    if (this.relations.isGeneric(type)) return { kind: 'keyof', id: newTypeId(), type };
    if (isAnyLike(type)) return unionOf([stringType, numberType, symbolType]);
    if (type.kind === 'union') return intersectionOf(type.types.map((member) => this.keyofType(member)));
    if (type.kind === 'intersection') return unionOf(type.types.map((member) => this.keyofType(member)));
    if (type.kind !== 'object') {
      if (type.kind === 'intrinsic' && ['unknown', 'null', 'undefined', 'void', 'object'].includes(type.name))
        return neverType;
      return this.keyofType(this.apparentType(type));
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
  indexedAccess(object: Type, index: Type, node?: TreeNode): Type {
    if (this.relations.isGeneric(object) || this.relations.isGeneric(index)) {
      return { kind: 'indexedAccess', id: newTypeId(), objectType: object, indexType: index };
    }
    if (index.kind === 'union') return unionOf(index.types.map((member) => this.indexedAccess(object, member, node)));
    if (isAnyLike(object)) return anyType;
    if (object.kind === 'union') return unionOf(object.types.map((member) => this.indexedAccess(member, index, node)));
    if (index.kind === 'literal' && (typeof index.value === 'string' || typeof index.value === 'number')) {
      const name = String(index.value);
      const property = this.propertyOf(object, name);
      if (property) return property.optional ? unionOf([property.type(), undefinedType]) : property.type();
      const structure = this.structureOf(object);
      const numeric = typeof index.value === 'number' || /^\d+$/.test(name);
      if (numeric && structure.numberIndex) return structure.numberIndex.type;
      if (structure.stringIndex) return structure.stringIndex.type;
      if (node) this.error(node, `プロパティ '${name}' は型 '${this.print(object)}' にありません。`);
      return errorType;
    }
    const structure = this.structureOf(object);
    if (isIntrinsic(index, 'number') || (index.kind === 'literal' && typeof index.value === 'number')) {
      if (structure.numberIndex) return structure.numberIndex.type;
      if (structure.stringIndex) return structure.stringIndex.type;
    }
    if (isIntrinsic(index, 'string') && structure.stringIndex) return structure.stringIndex.type;
    if (node) this.error(node, `型 '${this.print(index)}' は型 '${this.print(object)}' のインデックスに使えません。`);
    return errorType;
  }

  private conditionalTypeFromNode(node: TreeNode): Type {
    const check = node.childForFieldName('left') as TreeNode;
    const extendsNode = node.childForFieldName('right') as TreeNode;
    const trueNode = node.childForFieldName('consequence') as TreeNode;
    const falseNode = node.childForFieldName('alternative') as TreeNode;
    const checkType = this.typeFromNode(check);
    const conditional: ConditionalType = {
      kind: 'conditional',
      id: newTypeId(),
      checkType,
      extendsType: this.typeFromNode(extendsNode),
      trueType: this.typeFromNode(trueNode),
      falseType: this.typeFromNode(falseNode),
      inferTypeParameters: [...this.inferParametersOf(node).values()],
      distributive: checkType.kind === 'typeParameter',
    };
    return this.resolveConditional(conditional, new Map());
  }

  private instantiateConditional(type: ConditionalType, mapper: Mapper): Type {
    return this.resolveConditional(type, mapper);
  }

  private resolveConditional(type: ConditionalType, mapper: Mapper): Type {
    const checkType = this.instantiate(type.checkType, mapper);
    if (type.distributive && checkType.kind === 'union') {
      return unionOf(
        checkType.types.map((member) => {
          const memberMapper: Mapper = new Map([...mapper, [(type.checkType as TypeParameter).id, member]]);
          return this.resolveConditional(type, memberMapper);
        })
      );
    }
    if (type.distributive && isIntrinsic(checkType, 'never')) return neverType;
    const extendsType = this.instantiate(type.extendsType, mapper);
    if (this.relations.isGeneric(checkType) || this.relations.isGeneric(extendsType, type.inferTypeParameters)) {
      if (mapper.size === 0) return type;
      return {
        ...type,
        id: newTypeId(),
        checkType,
        extendsType,
        trueType: this.instantiate(type.trueType, mapper),
        falseType: this.instantiate(type.falseType, mapper),
        distributive: type.distributive && checkType.kind === 'typeParameter',
      };
    }
    const inferred = new Map(mapper);
    if (type.inferTypeParameters.length > 0) {
      const inferences = this.expressions.calls.inferFromTypes(type.inferTypeParameters, checkType, extendsType);
      for (const parameter of type.inferTypeParameters) {
        inferred.set(parameter.id, inferences.get(parameter.id) ?? parameter.constraint?.() ?? unknownType);
      }
    }
    const extendsInstantiated = this.instantiate(type.extendsType, inferred);
    if (isAnyLike(checkType)) {
      return unionOf([this.instantiate(type.trueType, inferred), this.instantiate(type.falseType, mapper)]);
    }
    if (this.relations.isAssignable(checkType, extendsInstantiated)) return this.instantiate(type.trueType, inferred);
    return this.instantiate(type.falseType, mapper);
  }

  templateLiteral(texts: string[], types: Type[]): Type {
    if (types.some((type) => this.relations.isGeneric(type)))
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
      const next: string[] = [];
      for (const prefix of combinations) {
        for (const member of members) {
          const text = member.kind === 'literal' ? String(member.value) : (member as { name: string }).name;
          next.push(prefix + text + texts[index + 1]);
        }
      }
      combinations = next;
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

  // Helpers ------------------------------------------------------------------------------------------------------

  /** The type a literal has once a mutable location widens it. */
  widenLiteral(type: Type): Type {
    if (type.kind === 'literal' && type.fresh) {
      if (typeof type.value === 'boolean') return booleanType;
      return typeof type.value === 'string' ? stringType : typeof type.value === 'number' ? numberType : bigintType;
    }
    if (type.kind === 'union' && type.types.some((member) => member.kind === 'literal' && member.fresh)) {
      return unionOf(type.types.map((member) => this.widenLiteral(member)));
    }
    return regularOf(type);
  }

  /** The source type an assignability message shows: literals widened unless the target lists literals. */
  widenLiteralForMessage(source: Type, target: Type): Type {
    const targetMembers = target.kind === 'union' ? target.types : [target];
    if (targetMembers.some((member) => member.kind === 'literal' || member.kind === 'templateLiteral'))
      return regularOf(source);
    return this.widenLiteral(source);
  }

  /** The type of a variable initialized with `type`: literals widened, `null` and `undefined` kept. */
  widen(type: Type): Type {
    const widened = this.widenLiteral(type);
    if (widened.kind === 'object' && widened.fresh && widened.regular) return widened.regular;
    return widened;
  }
}

export function checkTypeScript(root: TreeNode): SourceDiagnostic[] {
  return new Checker(root).check();
}

export { regularOf };
