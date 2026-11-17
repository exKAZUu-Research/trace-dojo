// code-gauge-allow-file fileNcss 417 -- Holds shared type construction, bounded instantiation, structure lookup, and type constraints used by all checker components.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { SourceDiagnostic } from '../../interpreter/diagnostics';
import { ExecutionBudget, ExecutionLimitError, LIMITS } from '../../interpreter/limits';
import { AssignmentChecker } from './assignments';
import { Binder } from './binder';
import { ClassDeclarationChecker } from './classDeclarations';
import { ClassChecker } from './classes';
import { ConditionChecker } from './conditions';
import { checkDuplicateDeclarations } from './declarations';
import { ExpressionChecker } from './expressions';
import { Flow } from './flow';
import { FunctionChecker } from './functions';
import { TypeInference } from './inference';
import { libraryScope, libraryTree, markUnsupported, nativeOverloadTree } from './library';
import { LiteralChecker } from './literals';
import { MemberChecker } from './members';
import { OperatorChecker } from './operators';
import { BindingPatterns } from './patterns';
import { Printer } from './print';
import { Relations } from './relations';
import type { Scope } from './scopes';
import { Signatures } from './signatures';
import { StatementChecker } from './statements';
import { TypeNodes } from './typeNodes';
import { TypeOperators } from './typeOperators';
import {
  anonymousObject,
  anyType,
  bigintType,
  booleanType,
  emptyStructure,
  type IndexInfo,
  intersectionOf,
  literalType,
  type MappedInfo,
  newTypeId,
  numberType,
  type ObjectType,
  type Property,
  regularOf,
  type Signature,
  simpleProperty,
  startTypeCaches,
  stringType,
  type Structure,
  symbolType,
  type TupleElement,
  type Type,
  type TypeParameter,
  unionOf,
  unknownType,
} from './types';

export type Mapper = Map<number, Type>;

interface Diagnostic extends SourceDiagnostic {
  index: number;
}

/** Type-checks a program as `tsc --strict` does, collecting the errors it reports. */
export class Checker {
  readonly diagnostics: Diagnostic[] = [];
  /** While positive, errors are not reported, as when inferring a function's return type ahead of checking it. */
  silent = 0;
  readonly binder: Binder;
  readonly libraryBinder: Binder;
  readonly nativeOverloadBinder: Binder;
  readonly relations = new Relations(this);
  readonly printer = new Printer(this);
  readonly expressions = new ExpressionChecker(this);
  readonly functions = new FunctionChecker(this);
  readonly literals = new LiteralChecker(this);
  readonly patterns = new BindingPatterns(this);
  readonly members = new MemberChecker(this);
  readonly assignments = new AssignmentChecker(this);
  readonly operators = new OperatorChecker(this);
  readonly conditions = new ConditionChecker(this);
  readonly statements = new StatementChecker(this);
  readonly classes = new ClassChecker(this);
  readonly classDeclarations = new ClassDeclarationChecker(this);
  readonly flow = new Flow(this);
  readonly typeOperators = new TypeOperators(this);
  readonly typeNodes = new TypeNodes(this);
  readonly signatures = new Signatures(this);
  readonly inference = new TypeInference(this);
  private readonly referenceCache = new Map<string, ObjectType>();
  private readonly instantiationCache = new Map<string, Type>();
  /** The members of class instance types with `this` standing for the instance type, by type. */
  private readonly thisStructures = new Map<number, Structure>();

  /**
   * The operations and the time checking may take, as running a program may: a program can make checking slow, and
   * the server checks it in its own process.
   */
  readonly budget = new ExecutionBudget();

  constructor(readonly root: TreeNode) {
    startTypeCaches();
    this.libraryBinder = new Binder(libraryTree.rootNode, libraryScope());
    markUnsupported(this.libraryBinder.moduleScope);
    this.nativeOverloadBinder = new Binder(nativeOverloadTree.rootNode, this.libraryBinder.moduleScope);
    this.binder = new Binder(root, this.libraryBinder.globalScope, this.libraryBinder.moduleScope);
    for (const identifier of this.binder.assignedIdentifiers) {
      const symbol = this.binder.scopeOf(identifier).lookupValue(identifier.text);
      if (symbol) {
        symbol.isReassigned = true;
        symbol.assignmentOffsets.push(identifier.startIndex);
      }
    }
  }

  check(): SourceDiagnostic[] {
    checkDuplicateDeclarations(this, this.binder.allScopes);
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
    if (node.tree === nativeOverloadTree) return this.nativeOverloadBinder.scopeOf(node);
    return node.tree === libraryTree ? this.libraryBinder.scopeOf(node) : this.binder.scopeOf(node);
  }

  ownScope(node: TreeNode): Scope | undefined {
    if (node.tree === nativeOverloadTree) return this.nativeOverloadBinder.ownScope(node);
    return node.tree === libraryTree ? this.libraryBinder.ownScope(node) : this.binder.ownScope(node);
  }

  isLibrary(node: TreeNode): boolean {
    return node.tree === libraryTree || node.tree === nativeOverloadTree;
  }

  nativeOverload(node: TreeNode): TreeNode {
    if (node.tree !== libraryTree) return node;
    const name = node.childForFieldName('name')?.text;
    if (!name) return node;
    const originals =
      this.libraryBinder.moduleScope
        .lookupValue(name)
        ?.valueDeclarations.filter(
          (declaration) => declaration.tree === libraryTree && declaration.type === 'function_signature'
        ) ?? [];
    const index = originals.findIndex((declaration) => declaration.id === node.id);
    return (
      this.nativeOverloadBinder.moduleScope.values
        .get(name)
        ?.valueDeclarations.filter((declaration) => declaration.type === 'function_signature')[index] ?? node
    );
  }

  print(type: Type): string {
    return this.printer.print(type);
  }

  // Library types -----------------------------------------------------------------------------------------------

  globalType(name: string, typeArguments: Type[] = []): ObjectType {
    const symbol = this.libraryBinder.moduleScope.lookupType(name);
    if (!symbol) throw new Error(`The library declares no type ${name}`);
    const declared = this.typeNodes.declaredTypeOf(symbol) as ObjectType;
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
    const filled = this.fillTypeArguments(parameters, typeArguments);
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

  fillTypeArguments(parameters: TypeParameter[], typeArguments: Type[]): Type[] {
    const mapper: Mapper = new Map();
    return parameters.map((parameter, index) => {
      const argument = typeArguments[index] ?? this.instantiate(parameter.default?.() ?? unknownType, mapper);
      mapper.set(parameter.id, argument);
      return argument;
    });
  }

  private instantiationDepth = 0;

  instantiate(type: Type, mapper: Mapper): Type {
    if (mapper.size === 0) return type;
    this.budget.spend();
    if (this.instantiationDepth >= LIMITS.maxCallDepth) throw new ExecutionLimitError('operations');
    this.instantiationDepth++;
    try {
      return this.instantiateType(type, mapper);
    } finally {
      this.instantiationDepth--;
    }
  }

  private instantiateType(type: Type, mapper: Mapper): Type {
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
        return intersectionOf(
          type.types.map((member) => this.instantiate(member, mapper)),
          this.budget
        );
      }
      case 'object': {
        return this.instantiateObject(type, mapper);
      }
      case 'indexedAccess': {
        return this.typeOperators.indexedAccess(
          this.instantiate(type.objectType, mapper),
          this.instantiate(type.indexType, mapper)
        );
      }
      case 'keyof': {
        return this.typeOperators.keyofType(this.instantiate(type.type, mapper));
      }
      case 'conditional': {
        return this.typeOperators.resolveConditional(type, mapper);
      }
      case 'templateLiteral': {
        return this.typeOperators.templateLiteral(
          type.texts,
          type.types.map((member) => this.instantiate(member, mapper))
        );
      }
      case 'stringMapping': {
        return this.typeOperators.stringMapping(type.mapping, this.instantiate(type.type, mapper));
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
        const getTemplate = (): Type => this.instantiate(mapped.template, mapper);
        return this.typeOperators.mappedType({
          typeParameter: mapped.typeParameter,
          readonlyModifier: mapped.readonlyModifier,
          optionalModifier: mapped.optionalModifier,
          constraint: this.instantiate(mapped.constraint, mapper),
          nameType: mapped.nameType && this.instantiate(mapped.nameType, mapper),
          source: mapped.source && this.instantiate(mapped.source, mapper),
          get template() {
            return getTemplate();
          },
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
      let writeType: Type | undefined;
      properties.set(name, {
        ...property,
        writeType:
          property.writeType &&
          (() => (writeType ??= this.instantiate(property.writeType?.() ?? property.type(), mapper))),
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
      parameters: this.signatures.expandRestTuple(
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

  // code-gauge-allow functionCognitiveComplexity 18 -- Flattens rest elements and builds the tuple's members in one lazy structure.
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
  // code-gauge-allow functionNcss 41 -- One case per kind of type that boxes to an interface.
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
        return this.silently(() => this.typeOperators.indexedAccess(object, index));
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
          type: () => intersectionOf([existing.type(), property.type()], this.budget),
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

  overloadedFunction(signatures: Signature[]): ObjectType {
    return anonymousObject(() => ({ ...emptyStructure(), callSignatures: signatures }), { isFunction: true });
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
