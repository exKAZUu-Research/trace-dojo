// code-gauge-allow-file fileNcss 729 -- Holds type construction, bounded instantiation, structure lookup, and diagnostics shared by checker components.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { type SourceDiagnostic, sourceDiagnostic } from '../../interpreter/diagnostics';
import { ExecutionBudget, ExecutionLimitError, LIMITS } from '../../interpreter/limits';
import { AssignmentChecker } from './assignments';
import { Binder } from './binder';
import { CircularConstraints } from './circularConstraints';
import { ClassDeclarationChecker } from './classDeclarations';
import { ClassChecker } from './classes';
import { ConditionChecker } from './conditions';
import { checkDuplicateDeclarations, checkParameterRedeclarations } from './declarations';
import { ExpressionChecker } from './expressions';
import { Flow } from './flow';
import { FunctionChecker } from './functions';
import { isGenericObjectOrIndexType } from './genericTypes';
import { mergedPatternIndexes } from './indexInfos';
import { TypeInference } from './inference';
import { libraryScope, libraryTree, localeOptionsTree, markUnsupported } from './library';
import { LiteralChecker } from './literals';
import { MemberChecker } from './members';
import { intersectConstructSignatures } from './mixinConstructors';
import { OperatorChecker } from './operators';
import { OverloadContexts } from './overloadContexts';
import { BindingPatterns } from './patterns';
import { Printer } from './print';
import { ReducedTypes } from './reducedTypes';
import { Relations } from './relations';
import type { Scope } from './scopes';
import { Signatures } from './signatures';
import { StatementChecker } from './statements';
import { bigIntPropertyNames } from './syntax';
import { tupleType } from './tupleTypes';
import { TypeNodes } from './typeNodes';
import { TypeOperators } from './typeOperators';
import {
  anonymousObject,
  anyType,
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
  type MappedInfo,
  type Mapper,
  newTypeId,
  numberType,
  type ObjectType,
  primitiveOfLiteral,
  type Property,
  propertyAccessType,
  regularOf,
  type Signature,
  startTypeCaches,
  stringType,
  type Structure,
  symbolType,
  thisParameterOf,
  type TupleElement,
  type Type,
  typeCacheKey,
  typeMapperCacheKey,
  typeMembers,
  type TypeParameter,
  undefinedType,
  unionOf,
  type UnionType,
  unknownType,
  withAlias,
} from './types';
import { couldContainTypeVariables } from './typeVariables';
import { unionProperty, unionStructure } from './unionMembers';

export type { Mapper } from './types';

/** A union alias, whose type is undefined while it resolves. */
export interface UnionAlias {
  id: number;
  type: () => Type | undefined;
}

interface Diagnostic extends SourceDiagnostic {
  index: number;
}

const nonNullishDiagnosticIntrinsics = new Set(['string', 'number', 'bigint', 'symbol', 'object']);

export class Checker {
  readonly diagnostics: Diagnostic[] = [];
  /** While positive, speculative errors are suppressed, as when inferring a function's return type. */
  silent = 0;
  readonly binder: Binder;
  readonly libraryBinder: Binder;
  readonly localeOptionsBinder: Binder;
  readonly reducedTypes = new ReducedTypes(this);
  readonly relations = new Relations(this);
  readonly printer = new Printer(this);
  readonly expressions = new ExpressionChecker(this);
  readonly functions = new FunctionChecker(this);
  readonly literals = new LiteralChecker(this);
  readonly patterns = new BindingPatterns(this);
  readonly members = new MemberChecker(this);
  readonly assignments = new AssignmentChecker(this);
  readonly operators = new OperatorChecker(this);
  readonly overloadContexts = new OverloadContexts(this);
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
  /** The unions that stand for a union alias, with the mapper that instantiates the alias's type into them. */
  private readonly aliasUnions = new Map<UnionType, { alias: UnionAlias; mapper: Mapper }>();
  private readonly deferredAliasUnionCache = new Map<string, UnionType>();
  private readonly thisStructures = new Map<string, Structure>();
  private readonly writtenTypeNodes: TreeNode[] = [];
  private typeDemand: TreeNode | undefined;

  /**
   * The operations and the time checking may take, as running a program may: a program can make checking slow, and
   * the server checks it in its own process.
   */
  constructor(
    readonly root: TreeNode,
    readonly budget = new ExecutionBudget()
  ) {
    startTypeCaches();
    this.libraryBinder = new Binder(libraryTree.rootNode, libraryScope(), { deferLibraryTypes: true });
    this.localeOptionsBinder = new Binder(localeOptionsTree.rootNode, this.libraryBinder.moduleScope);
    markUnsupported(this.libraryBinder.moduleScope);
    this.binder = new Binder(root, this.libraryBinder.globalScope, {
      rootScope: this.libraryBinder.moduleScope,
      budget,
    });
  }

  check(): SourceDiagnostic[] {
    for (const name of bigIntPropertyNames(this.root))
      this.error(name, 'bigint リテラルはプロパティ名として使えません。');
    this.classes.checkThisTypePlacements(this.root);
    checkDuplicateDeclarations(this, this.binder.allScopes);
    this.signatures.checkTypeParameterDeclarations(this.binder.allScopes);
    this.signatures.checkImplicitReturnTypes(this.root);
    this.statements.checkProgram(this.root);
    this.typeNodes.checkWrittenTypeNames(this.root);
    this.typeNodes.checkPendingArgumentConstraints();
    checkParameterRedeclarations(this, this.binder.allScopes);
    const seen = new Set<string>();
    return this.diagnostics
      .toSorted((a, b) => a.index - b.index)
      .filter((diagnostic) => {
        const key = `${diagnostic.index}:${diagnostic.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ row, index, message }) => sourceDiagnostic(row, index, message));
  }

  error(node: TreeNode, message: string): void {
    if (this.isLibrary(node) || (this.silent > 0 && !this.writtenTypeAt(node))) return;
    this.diagnostics.push({ row: node.startPosition.row, index: node.startIndex, message });
  }

  /** The user source requesting a type, including when a deferred member or signature first resolves. */
  withTypeDemand<T>(node: TreeNode, run: () => T): T {
    if (this.isLibrary(node)) return run();
    const outer = this.typeDemand;
    this.typeDemand = node;
    try {
      return run();
    } finally {
      this.typeDemand = outer;
    }
  }

  reportTypeComplexity(node?: TreeNode): void {
    const site = node && !this.isLibrary(node) ? node : this.typeDemand;
    this.errorWhileResolving(site ?? this.root, 'この式の型は、表せないほど複雑な共用体型になります。');
  }

  checkTypeSyntax<T>(node: TreeNode, run: () => T): T {
    return this.withTypeDemand(node, () => {
      if (this.silent === 0 || this.isLibrary(node)) return run();
      this.writtenTypeNodes.push(node);
      try {
        return run();
      } finally {
        this.writtenTypeNodes.pop();
      }
    });
  }

  private writtenTypeAt(node: TreeNode): boolean {
    // Resolving an annotation can infer types from other declarations whose diagnostics still need normal checking.
    return this.writtenTypeNodes.some(
      (type) => type.tree === node.tree && type.startIndex <= node.startIndex && node.endIndex <= type.endIndex
    );
  }

  /** Reports an error found while resolving a type on demand, which no check that triggered it may hide. */
  errorWhileResolving(node: TreeNode, message: string): void {
    const { silent } = this;
    this.silent = 0;
    try {
      this.error(node, message);
    } finally {
      this.silent = silent;
    }
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
    if (node.tree === localeOptionsTree) return this.localeOptionsBinder.scopeOf(node);
    return node.tree === libraryTree ? this.libraryBinder.scopeOf(node) : this.binder.scopeOf(node);
  }

  isGlobalUndefined(node: TreeNode): boolean {
    return (
      node.text === 'undefined' &&
      this.scopeOf(node).lookupValue('undefined') === this.libraryBinder.globalScope.values.get('undefined')
    );
  }

  ownScope(node: TreeNode): Scope | undefined {
    if (node.tree === localeOptionsTree) return this.localeOptionsBinder.ownScope(node);
    return node.tree === libraryTree ? this.libraryBinder.ownScope(node) : this.binder.ownScope(node);
  }

  bindDeferredLibraryType(node: TreeNode): void {
    if (node.tree === libraryTree && this.libraryBinder.bindDeferredType(node))
      this.budget.spend(Math.ceil((node.endIndex - node.startIndex) / 32));
  }

  isLibrary(node: TreeNode): boolean {
    return node.tree === libraryTree || node.tree === localeOptionsTree;
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
    return type.kind === 'object' && type.objectKind === 'reference' && this.isLibraryType(type, 'Array');
  }

  isReadonlyArrayType(type: Type): boolean {
    return type.kind === 'object' && type.objectKind === 'reference' && this.isLibraryType(type, 'ReadonlyArray');
  }

  isLibraryType(type: Type, name: string): boolean {
    if (type.kind !== 'object') return false;
    const declared = type.objectKind === 'reference' ? type.target : type;
    return declared?.name === name && declared === this.globalType(name);
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
    if (type.objectKind === 'tuple') {
      return unionOf(
        (type.tuple?.elements ?? []).map((element) => {
          if (element.rest) return this.restElementType(element.type);
          return element.optional ? unionOf([element.type, undefinedType]) : element.type;
        })
      );
    }
    return type.typeArguments?.[0] ?? anyType;
  }

  // References and instantiation ---------------------------------------------------------------------------------

  /** A generic interface or class applied to type arguments. */
  reference(target: ObjectType, typeArguments: Type[], preserveLiterals?: true): ObjectType {
    const parameters = target.typeParameters ?? [];
    const filled = this.fillTypeArguments(parameters, typeArguments);
    if (filled.every((argument, index) => argument === parameters[index])) return target;
    const key = `${target.id}${preserveLiterals ? '+' : ''}<${filled.map(typeCacheKey).join(',')}>`;
    let reference = this.referenceCache.get(key);
    if (!reference) {
      reference = this.referenceObject(target, () => filled, preserveLiterals);
      this.referenceCache.set(key, reference);
    }
    return reference;
  }

  deferredReference(
    target: ObjectType,
    resolveArguments: () => Type[],
    options: {
      outerTypeParameters?: TypeParameter[];
      preserveLiterals?: true;
      reportCircular?: () => void;
      checkArguments?: (types: Type[]) => void;
    }
  ): ObjectType {
    let typeArguments: Type[] | undefined;
    let resolving = false;
    const argumentsOf = (): Type[] => {
      if (typeArguments) return typeArguments;
      if (resolving) {
        options.reportCircular?.();
        return (typeArguments = (target.typeParameters ?? []).map(() => errorType));
      }
      resolving = true;
      try {
        const resolved = resolveArguments();
        if (typeArguments) return typeArguments;
        typeArguments = resolved;
        options.checkArguments?.(resolved);
        return resolved;
      } finally {
        resolving = false;
      }
    };
    let canonical: ObjectType | undefined;
    const resolveReference = (): ObjectType =>
      (canonical ??= this.reference(target, argumentsOf(), options.preserveLiterals));
    const reference = this.referenceObject(target, argumentsOf, options.preserveLiterals);
    reference.resolveReference = resolveReference;
    reference.outerTypeParameters = options.outerTypeParameters;
    return reference;
  }

  private referenceObject(target: ObjectType, argumentsOf: () => Type[], preserveLiterals?: true): ObjectType {
    let structure: Structure | undefined;
    return {
      kind: 'object',
      id: newTypeId(),
      objectKind: 'reference',
      name: target.name,
      target,
      get typeArguments() {
        return argumentsOf();
      },
      classInfo: target.classInfo,
      resolve: () => {
        if (structure) return structure;
        const arguments_ = argumentsOf();
        const mapper = createMapper(
          (target.typeParameters ?? []).map((parameter, i) => [parameter.id, arguments_[i]]),
          preserveLiterals
        );
        return (structure ??= this.instantiateStructure(target.resolve(), mapper));
      },
    };
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
  private readonly substitutions = new Map<string, TypeParameter>();

  instantiateContextual(type: Type, mapper: Mapper): Type {
    return this.instantiate(type, createMapper(mapper, true));
  }

  instantiate(type: Type, mapper: Mapper): Type {
    if (mapper.size === 0 || !couldContainTypeVariables(type)) return type;
    this.budget.spend();
    if (this.instantiationDepth >= LIMITS.maxCallDepth) throw new ExecutionLimitError('operations');
    this.instantiationDepth++;
    try {
      const instantiated = this.instantiateType(type, mapper);
      return type.noInfer ? { ...instantiated, noInfer: true } : instantiated;
    } finally {
      this.instantiationDepth--;
    }
  }

  private instantiateType(type: Type, mapper: Mapper): Type {
    switch (type.kind) {
      case 'typeParameter': {
        const argument = mapper.get(type.id);
        if (argument) return argument;
        const substitution = type.substitution;
        return substitution
          ? this.substitutionOf(
              this.instantiate(substitution.base, mapper),
              this.instantiate(substitution.constraint, mapper)
            )
          : type;
      }
      case 'union': {
        return this.instantiateUnion(type, mapper);
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

  substitutionOf(base: Type, constraint: Type): Type {
    if (isAnyLike(base) || isAnyLike(constraint) || isIntrinsic(constraint, 'unknown') || base === constraint)
      return base;
    if (base.kind !== 'typeParameter') return intersectionOf([base, constraint], this.budget);
    if (base.substitution)
      return this.substitutionOf(
        base.substitution.base,
        intersectionOf([base.substitution.constraint, constraint], this.budget)
      );
    const key = `${typeCacheKey(base)}/${typeCacheKey(constraint)}`;
    let narrowed = this.substitutions.get(key);
    if (!narrowed) {
      const bound = intersectionOf([base, constraint], this.budget);
      narrowed = {
        ...base,
        id: newTypeId(),
        substitution: { base, constraint },
        constraint: () => bound,
      };
      this.substitutions.set(key, narrowed);
    }
    return narrowed;
  }

  private instantiateUnion(type: UnionType, mapper: Mapper): Type {
    const alias = this.aliasUnions.get(type);
    if (alias) return this.deferredAliasUnion(alias.alias, this.composeMappers(alias.mapper, mapper));
    return unionOf(
      type.types.map((member) => this.instantiate(member, mapper)),
      true,
      mapper.preserveLiterals
    );
  }

  /**
   * The union a union alias instantiated by `mapper` is, whose members are instantiated when first read, as TypeScript
   * defers type references: `type Nested<T> = T | Nested<T>[]` holds itself, and `type G<T> = T | G<T[]>[]` holds ever
   * deeper instantiations of itself.
   */
  deferredAliasUnion(alias: UnionAlias, mapper: Mapper): UnionType {
    const key = `${alias.id}[${typeMapperCacheKey(mapper)}]`;
    const cached = this.deferredAliasUnionCache.get(key);
    if (cached) return cached;
    let types: Type[] | undefined;
    const instantiate = (): Type[] | undefined => {
      const declared = alias.type();
      if (!declared) return undefined;
      const instantiated = this.instantiate(declared, mapper);
      return instantiated.kind === 'union' ? instantiated.types : [instantiated];
    };
    const union: UnionType = {
      kind: 'union',
      id: newTypeId(),
      aliasMapper: mapper,
      get types() {
        return (types ??= instantiate()) ?? [];
      },
    };
    this.aliasUnions.set(union, { alias, mapper });
    this.deferredAliasUnionCache.set(key, union);
    return union;
  }

  /** Lets a union that stands for an alias inside the alias's own declaration instantiate as the alias does. */
  registerAliasUnion(union: UnionType, alias: UnionAlias): void {
    this.aliasUnions.set(union, { alias, mapper: new Map() });
  }

  private instantiateObject(type: ObjectType, mapper: Mapper): Type {
    return (
      this.typeNodes.recursiveAliases.instantiateReference(type, mapper) ?? this.instantiateAliasedObject(type, mapper)
    );
  }

  /** An object type instantiated by `mapper`, without deferring it if it is a generic alias that holds itself. */
  instantiateAliasedObject(type: ObjectType, mapper: Mapper): Type {
    switch (type.objectKind) {
      case 'reference': {
        return this.instantiateReference(type, mapper);
      }
      case 'tuple': {
        const tuple = type.tuple as NonNullable<ObjectType['tuple']>;
        return this.tupleType(
          tuple.elements.map((element) => ({ ...element, type: this.instantiate(element.type, mapper) })),
          tuple.readonly
        );
      }
      case 'mapped': {
        return this.instantiateMapped(type, mapper);
      }
      case 'interface': {
        // A generic interface or class stands for itself applied to its own type parameters.
        const target = this.instantiateOuterTypeParameters(type, mapper);
        const parameters = type.typeParameters ?? [];
        if (!parameters.some((parameter) => mapper.has(parameter.id))) return target;
        return this.reference(
          target,
          parameters.map((parameter) => mapper.get(parameter.id) ?? parameter),
          mapper.preserveLiterals
        );
      }
      default: {
        break;
      }
    }
    const key = `${type.id}[${typeMapperCacheKey(mapper)}]`;
    const cached = this.instantiationCache.get(key);
    if (cached) return cached;
    const instantiated = anonymousObject(() => this.instantiateStructure(type.resolve(), mapper), {
      isFunction: type.isFunction,
      isLiteral: type.isLiteral,
      classInfo: type.classInfo,
      isClassStatic: type.isClassStatic,
      isResolvedMappedType: type.isResolvedMappedType,
      mappedOptional: type.mappedOptional,
      mappedKeys: type.mappedKeys,
      name: type.name,
      aliasName: type.aliasName,
      aliasId: type.aliasId,
      aliasArguments: type.aliasArguments?.map((argument) => this.instantiate(argument, mapper)),
      origin: type.origin ?? type,
      mapper: type.mapper ? this.composeMappers(type.mapper, mapper) : mapper,
    });
    this.instantiationCache.set(key, instantiated);
    return instantiated;
  }

  private instantiateReference(type: ObjectType, mapper: Mapper): Type {
    if (type.resolveReference) return this.instantiateDeferredReference(type, mapper);
    const target = this.instantiateOuterTypeParameters(type.target as ObjectType, mapper);
    return this.reference(
      target,
      (type.typeArguments ?? []).map((argument) => this.instantiate(argument, mapper)),
      mapper.preserveLiterals
    );
  }

  private instantiateDeferredReference(type: ObjectType, mapper: Mapper): Type {
    const original = type.origin ?? type;
    const parameters = original.outerTypeParameters ?? [];
    const substitutions = createMapper(
      parameters.map((parameter) => [
        parameter.id,
        this.instantiate(type.mapper?.get(parameter.id) ?? parameter, mapper),
      ]),
      mapper.preserveLiterals
    );
    if (parameters.every((parameter) => substitutions.get(parameter.id) === parameter)) return original;
    const key = `${original.id}[${typeMapperCacheKey(substitutions)}]`;
    const cached = this.instantiationCache.get(key);
    if (cached) return cached;
    const target = this.instantiateOuterTypeParameters(original.target as ObjectType, substitutions);
    const reference = this.deferredReference(
      target,
      () => (original.typeArguments ?? []).map((argument) => this.instantiate(argument, substitutions)),
      { outerTypeParameters: original.outerTypeParameters, preserveLiterals: mapper.preserveLiterals }
    );
    reference.origin = original;
    reference.mapper = substitutions;
    this.instantiationCache.set(key, reference);
    return reference;
  }

  private instantiateMapped(type: ObjectType, mapper: Mapper): Type {
    const mapped = type.mapped as MappedInfo;
    let constraint: Type | undefined;
    const getConstraint = (): Type => (constraint ??= this.instantiate(mapped.constraint, mapper));
    const typeParameter: TypeParameter = {
      ...mapped.typeParameter,
      id: newTypeId(),
      constraint: getConstraint,
    };
    const localMapper = createMapper([...mapper, [mapped.typeParameter.id, typeParameter]], mapper.preserveLiterals);
    const getTemplate = (): Type => this.instantiate(mapped.template, localMapper);
    const sourceVariable = mapped.homomorphic && mapped.source?.kind === 'typeParameter' ? mapped.source : undefined;
    const withSource =
      sourceVariable &&
      ((source: Type): Type =>
        this.instantiate(type, createMapper([...mapper, [sourceVariable.id, source]], mapper.preserveLiterals)));
    const instantiated = this.typeOperators.mappedType(
      {
        typeParameter,
        readonlyModifier: mapped.readonlyModifier,
        optionalModifier: mapped.optionalModifier,
        homomorphic: mapped.homomorphic,
        get constraint() {
          return getConstraint();
        },
        nameType: mapped.nameType && this.instantiate(mapped.nameType, localMapper),
        source: mapped.source && this.instantiate(mapped.source, mapper),
        get template() {
          return getTemplate();
        },
      },
      withSource
    );
    return type.aliasName
      ? withAlias(
          instantiated,
          type.aliasName,
          (type.aliasArguments ?? []).map((argument) => this.instantiate(argument, mapper)),
          type.aliasId
        )
      : instantiated;
  }

  /**
   * An interface or class declared inside generic declarations with their type parameters mapped, as TypeScript gives a
   * reference to it its outer type arguments. Instantiations with the same outer type arguments are one type.
   */
  private instantiateOuterTypeParameters(type: ObjectType, mapper: Mapper): ObjectType {
    const outer = type.outerTypeParameters;
    if (!outer) return type;
    const origin = type.origin ?? type;
    const argumentOf = (parameter: TypeParameter): Type => type.mapper?.get(parameter.id) ?? parameter;
    const outerMapper = createMapper(
      outer.map((parameter) => [parameter.id, this.instantiate(argumentOf(parameter), mapper)]),
      mapper.preserveLiterals
    );
    if (outer.every((parameter) => outerMapper.get(parameter.id) === argumentOf(parameter))) return type;
    if (outer.every((parameter) => outerMapper.get(parameter.id) === parameter)) return origin;
    const key = `${origin.id}[${typeMapperCacheKey(outerMapper)}]`;
    const cached = this.instantiationCache.get(key);
    if (cached) return cached as ObjectType;
    let structure: Structure | undefined;
    const instantiated: ObjectType = {
      ...origin,
      id: newTypeId(),
      origin,
      mapper: outerMapper,
      resolve: () => (structure ??= this.instantiateStructure(origin.resolve(), outerMapper)),
    };
    this.instantiationCache.set(key, instantiated);
    return instantiated;
  }

  /** The mapper that applies `first`, then `second`. */
  private composeMappers(first: Mapper, second: Mapper): Mapper {
    const composed = createMapper(second, second.preserveLiterals);
    for (const [id, type] of first) composed.set(id, this.instantiate(type, second));
    return composed;
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
      symbolIndex: index(structure.symbolIndex),
      patternIndexes: structure.patternIndexes?.map((info) => ({
        type: this.instantiate(info.type, mapper),
        readonly: info.readonly,
        keyType: this.instantiate(info.keyType, mapper),
      })),
    };
  }

  instantiateSignature(signature: Signature, outer: Mapper): Signature {
    let returnType: Type | undefined;
    let mapper = outer;
    let typeParameters = signature.typeParameters;
    // The signature's own type parameters get fresh copies whose constraints see the outer type arguments.
    if (typeParameters.length > 0 && outer.size > 0 && !typeParameters.some((parameter) => outer.has(parameter.id))) {
      mapper = createMapper(outer, outer.preserveLiterals);
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
        signature.parameters.map((parameter) => {
          const instantiate = (): Type => this.instantiate(parameter.type, mapper);
          let instantiated: Type | undefined;
          return {
            name: parameter.name,
            optional: parameter.optional,
            rest: parameter.rest,
            get type() {
              return (instantiated ??= instantiate());
            },
          };
        })
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

  tupleType(elements: TupleElement[], readonly = false): Type {
    return tupleType(this, elements, readonly);
  }

  restElementType(type: Type): Type {
    if (type.kind === 'union') return unionOf(type.types.map((member) => this.restElementType(member)));
    if (type.kind === 'object' && this.isArrayOrTuple(type)) return this.elementTypeOf(type);
    if (this.relations.isGenericRestType(type)) return this.typeOperators.indexedAccess(type, numberType);
    return anyType;
  }

  // Structures ---------------------------------------------------------------------------------------------------

  /** The members of a type, with those of the interface its primitives box to. */
  structureOf(type: Type, receiver?: Type): Structure {
    const apparent = this.apparentType(type);
    if (apparent.kind === 'object') {
      return this.objectStructure(apparent, receiver ?? (type.kind === 'typeParameter' ? type : apparent));
    }
    if (apparent.kind === 'intersection') return this.intersectionStructure(apparent.types, receiver ?? type);
    if (apparent.kind === 'union') return unionStructure(this, apparent.types);
    return emptyStructure();
  }

  private objectStructure(type: ObjectType, receiver: Type): Structure {
    const parameter = thisParameterOf(type);
    if (!parameter || parameter === receiver) return type.resolve();
    const key = `${typeCacheKey(type)}:${typeCacheKey(receiver)}`;
    let structure = this.thisStructures.get(key);
    if (!structure) {
      structure = this.instantiateStructure(type.resolve(), new Map([[parameter.id, receiver]]));
      this.thisStructures.set(key, structure);
    }
    return structure;
  }

  /** Applies a class's or interface's polymorphic `this` when comparing heritage declarations. */
  typeWithThisArgument(type: Type, receiver: Type): Type {
    if (type.kind === 'intersection') {
      const members = type.types.map((member) => this.typeWithThisArgument(member, receiver));
      return members.some((member, index) => member !== type.types[index])
        ? intersectionOf(members, this.budget)
        : type;
    }
    if (type.kind !== 'object' || !thisParameterOf(type)) return type;
    const key = `this:${typeCacheKey(type)}:${typeCacheKey(receiver)}`;
    let applied = this.instantiationCache.get(key);
    if (!applied) {
      applied = anonymousObject(() => this.structureOf(type, receiver), {
        name: type.name,
        origin: type.origin ?? type,
        classInfo: type.classInfo,
      });
      this.instantiationCache.set(key, applied);
    }
    return applied;
  }

  /** The type whose members a value of `type` has: its boxing interface for a primitive, its constraint for a type parameter. */
  // code-gauge-allow functionNcss 38 -- One case per kind of type that boxes to an interface.
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
        return typeof type.value === 'boolean'
          ? this.globalType('Boolean')
          : this.apparentType(primitiveOfLiteral(type));
      }
      case 'templateLiteral':
      case 'stringMapping': {
        return this.globalType('String');
      }
      case 'typeParameter': {
        const constraint = this.constraintOf(type);
        return constraint ? this.apparentType(constraint) : unknownType;
      }
      case 'indexedAccess':
      case 'keyof':
      case 'conditional': {
        const constraint = this.baseConstraint(type);
        return constraint === type ? unknownType : this.apparentType(constraint);
      }
      case 'union': {
        if (type === booleanType) return this.globalType('Boolean');
        const reduced = this.reducedTypes.of(type);
        return reduced === type ? type : this.apparentType(reduced);
      }
      case 'intersection': {
        return this.reducedTypes.of(type);
      }
      default: {
        return type;
      }
    }
  }

  private readonly circularConstraints = new CircularConstraints(this);
  private readonly conditionalConstraintsInProgress = new Set<number>();
  private readonly indexedConstraintsInProgress = new Set<IndexedAccessType>();

  /** As TypeScript's `getConstraintOfTypeParameter`, none for a circular constraint. */
  constraintOf(parameter: TypeParameter): Type | undefined {
    return this.circularConstraints.has(parameter) ? undefined : parameter.constraint?.();
  }

  /** The type a generic type stands for at most, which its members come from. */
  baseConstraint(type: Type): Type {
    this.budget.spend();
    switch (type.kind) {
      case 'typeParameter': {
        return this.constraintOf(type) ?? unknownType;
      }
      case 'indexedAccess': {
        if (this.indexedConstraintsInProgress.has(type)) return type;
        this.indexedConstraintsInProgress.add(type);
        try {
          return this.indexedAccessConstraint(type);
        } finally {
          this.indexedConstraintsInProgress.delete(type);
        }
      }
      case 'keyof': {
        return unionOf([stringType, numberType, symbolType]);
      }
      case 'conditional': {
        return this.conditionalConstraint(type);
      }
      default: {
        return type;
      }
    }
  }

  private indexedAccessConstraint(type: IndexedAccessType): Type {
    const mapped = this.typeOperators.mappedIndexConstraint(type);
    if (mapped !== undefined) return mapped;
    const index = this.indexedOperandConstraint(type.indexType);
    if (!index) return type;
    const tuple = this.silently(() => this.typeOperators.variadicIndexConstraint(type, index));
    if (tuple !== undefined) return tuple;
    const projected = this.silently(() => this.projectedIndexedConstraint(type.objectType, index));
    if (projected !== undefined) return projected;
    const object = this.indexedOperandConstraint(type.objectType);
    if (!object || (object === type.objectType && index === type.indexType)) return type;
    const bound = this.silently(() => this.typeOperators.indexedAccess(object, index));
    return bound === errorType ? type : bound;
  }

  private projectedIndexedConstraint(object: Type, index: Type): Type | undefined {
    if (!isGenericObjectOrIndexType(object)) return undefined;
    if (index.kind === 'union') return unionOf(index.types.map((key) => this.indexedProjection(object, key)));
    if (isGenericObjectOrIndexType(index)) return undefined;
    if (object.kind === 'union') return unionOf(object.types.map((member) => this.indexedProjection(member, index)));
    if (object.kind !== 'intersection') return undefined;
    // The compiler keeps keyof and indexing deferred for generic intersections with an empty object.
    if (
      object.types.some(
        (member) =>
          member.kind === 'object' && member.objectKind === 'anonymous' && this.relations.isEmptyObjectType(member)
      )
    )
      return undefined;
    return intersectionOf(
      object.types.map((member) => this.indexedProjection(member, index)),
      this.budget
    );
  }

  private indexedProjection(object: Type, index: Type): Type {
    const access = this.typeOperators.indexedAccess(object, index);
    return access === errorType ? unknownType : this.baseConstraint(access);
  }

  private indexedOperandConstraint(type: Type): Type | undefined {
    while (type.kind === 'typeParameter') {
      this.budget.spend();
      const constraint = this.constraintOf(type);
      if (!constraint) return undefined;
      type = constraint;
    }
    const bound = this.baseConstraint(type);
    if (bound.kind !== 'union' && bound.kind !== 'intersection') return bound;
    const constraints = bound.types
      .map((member) => this.indexedOperandConstraint(member))
      .filter((member) => member !== undefined);
    if (bound.kind === 'union') return constraints.length === bound.types.length ? unionOf(constraints) : undefined;
    return constraints.length > 0 ? intersectionOf(constraints, this.budget) : undefined;
  }

  private conditionalConstraint(type: ConditionalType): Type {
    const { id } = type.root ?? type;
    if (this.conditionalConstraintsInProgress.has(id)) return unknownType;
    this.conditionalConstraintsInProgress.add(id);
    try {
      const knownBranch = this.conditionalBranchFromBounds(type);
      if (knownBranch) return this.baseConstraint(knownBranch);
      // The true branch sees its check type narrowed to the extends type.
      const trueType = type.trueType;
      const trueConstraint =
        trueType === type.checkType
          ? intersectionOf([this.baseConstraint(type.checkType), type.extendsType], this.budget)
          : this.baseConstraint(trueType);
      return unionOf([trueConstraint, this.baseConstraint(type.falseType)]);
    } finally {
      this.conditionalConstraintsInProgress.delete(id);
    }
  }

  private conditionalBranchFromBounds(type: ConditionalType): Type | undefined {
    const { checkType, extendsType } = type;
    if (!type.distributive || checkType.kind !== 'typeParameter' || this.relations.isGeneric(extendsType))
      return undefined;
    let bound = this.constraintOf(checkType);
    while (bound?.kind === 'typeParameter') {
      this.budget.spend();
      bound = this.constraintOf(bound);
    }
    if (!bound || isIntrinsic(bound, 'never')) return undefined;
    const constraint = isIntrinsic(bound, 'any') ? unknownType : bound;
    if (this.relations.isAssignable(constraint, extendsType)) return type.trueType;
    if (isIntrinsic(extendsType, 'never')) return type.falseType;
    const overlaps = typeMembers(extendsType).some((member) => this.relations.isAssignable(member, constraint));
    return overlaps ? undefined : type.falseType;
  }

  private intersectionStructure(types: Type[], receiver: Type): Structure {
    const structures = types.map((member) => this.structureOf(member, receiver));
    const properties = new Map<string, Property>();
    for (const structure of structures) {
      for (const [name, property] of structure.properties) {
        const existing = properties.get(name);
        if (!existing) {
          properties.set(name, property);
          continue;
        }
        properties.set(name, this.intersectedProperty(existing, property));
      }
    }
    return {
      properties,
      callSignatures: structures.flatMap((structure) => structure.callSignatures),
      constructSignatures: intersectConstructSignatures(
        this,
        structures.map((structure) => structure.constructSignatures)
      ),
      stringIndex: this.intersectedIndex(structures.map((structure) => structure.stringIndex)),
      numberIndex: this.intersectedIndex(structures.map((structure) => structure.numberIndex)),
      symbolIndex: this.intersectedIndex(structures.map((structure) => structure.symbolIndex)),
      patternIndexes: mergedPatternIndexes(
        this,
        structures.map((structure) => structure.patternIndexes),
        true
      ),
    };
  }

  /** A property two members of an intersection both have, writable if either one is. */
  private intersectedProperty(existing: Property, property: Property): Property {
    const hasWriteType = existing.writeType !== undefined || property.writeType !== undefined;
    return {
      ...existing,
      optional: existing.optional && property.optional,
      exactOptionalType: true,
      readonly: existing.readonly && property.readonly,
      getterOnly: existing.getterOnly === true && property.getterOnly === true,
      type: () => intersectionOf([propertyAccessType(existing), propertyAccessType(property)], this.budget),
      writeType: hasWriteType
        ? () =>
            intersectionOf([propertyAccessType(existing, 'write'), propertyAccessType(property, 'write')], this.budget)
        : undefined,
    };
  }

  /** The index signature an intersection has, of the intersection of its members' value types. */
  private intersectedIndex(indexes: (IndexInfo | undefined)[]): IndexInfo | undefined {
    const present = indexes.filter((index) => index !== undefined);
    if (present.length <= 1) return present[0];
    return {
      type: intersectionOf(
        present.map((index) => index.type),
        this.budget
      ),
      readonly: present.every((index) => index.readonly),
    };
  }

  /**
   * A property of a type, including those `Object` gives every object and those `CallableFunction` or
   * `NewableFunction` give every function or class, as under `strictBindCallApply`.
   */
  propertyOf(type: Type, name: string, receiver?: Type): Property | undefined {
    const mapped = type.kind === 'object' ? this.typeOperators.mappedPropertyOf(type, name) : undefined;
    if (mapped) return mapped;
    const structure = this.structureOf(type, receiver);
    const own = structure.properties.get(name);
    if (own) return own;
    const apparent = this.apparentType(type);
    if (apparent.kind === 'union') return unionProperty(this, apparent.types, name);
    if (apparent.kind !== 'object' && apparent.kind !== 'intersection') return undefined;
    const functionInterface =
      structure.callSignatures.length > 0
        ? 'CallableFunction'
        : structure.constructSignatures.length > 0
          ? 'NewableFunction'
          : undefined;
    const functionProperty = functionInterface
      ? this.globalType(functionInterface).resolve().properties.get(name)
      : undefined;
    return functionProperty ?? this.globalType('Object').resolve().properties.get(name);
  }

  signaturesOf(type: Type, kind: 'call' | 'construct'): Signature[] {
    const structure = this.structureOf(type);
    return kind === 'call' ? structure.callSignatures : structure.constructSignatures;
  }

  overloadedFunction(signatures: Signature[]): ObjectType {
    return anonymousObject(() => ({ ...emptyStructure(), callSignatures: signatures }), { isFunction: true });
  }

  /** The members of a type with those of its bases that it does not redeclare. */
  mergeBases(own: Structure, bases: Type[], receiver?: Type): Structure {
    const properties = new Map(own.properties);
    let { stringIndex, numberIndex, symbolIndex } = own;
    const callSignatures = [...own.callSignatures];
    const constructSignatures = [...own.constructSignatures];
    const patternIndexLists = [own.patternIndexes];
    for (const base of bases) {
      if (base.kind !== 'object' && base.kind !== 'intersection' && base.kind !== 'typeParameter') continue;
      const baseStructure = this.structureOf(base, receiver);
      patternIndexLists.push(baseStructure.patternIndexes);
      for (const [name, property] of baseStructure.properties)
        if (!properties.has(name)) properties.set(name, property);
      stringIndex ??= baseStructure.stringIndex;
      numberIndex ??= baseStructure.numberIndex;
      symbolIndex ??= baseStructure.symbolIndex;
      // An interface has the signatures of every base after its own, as TypeScript appends them.
      callSignatures.push(...baseStructure.callSignatures);
      constructSignatures.push(...baseStructure.constructSignatures);
    }
    const patternIndexes = mergedPatternIndexes(this, patternIndexLists);
    return { properties, callSignatures, constructSignatures, stringIndex, numberIndex, symbolIndex, patternIndexes };
  }

  // Helpers ------------------------------------------------------------------------------------------------------

  /** The type a literal has once a mutable location widens it. */
  widenLiteral(type: Type): Type {
    if (type.kind === 'literal' && type.fresh) return primitiveOfLiteral(type);
    if (type.kind === 'union' && type.types.some((member) => member.kind === 'literal' && member.fresh)) {
      return unionOf(type.types.map((member) => this.widenLiteral(member)));
    }
    return regularOf(type);
  }

  typesForMessage(source: Type, target: Type): { source: Type; target: Type } {
    const regular = regularOf(source);
    let shownTarget = target;
    if (target.kind === 'union' && this.usesSingleDiagnosticTarget(regular)) {
      this.budget.spend(target.types.length);
      const nonNullish = target.types.filter(
        (member) => !isIntrinsic(member, 'null') && !isIntrinsic(member, 'undefined')
      );
      if (nonNullish.length === 1) shownTarget = nonNullish[0];
    }
    return { source: this.widenLiteralForMessage(regular, shownTarget), target: shownTarget };
  }

  private usesSingleDiagnosticTarget(type: Type): boolean {
    this.budget.spend();
    return (
      type === booleanType ||
      type.kind === 'object' ||
      type.kind === 'literal' ||
      type.kind === 'templateLiteral' ||
      type.kind === 'stringMapping' ||
      (type.kind === 'intrinsic' && nonNullishDiagnosticIntrinsics.has(type.name))
    );
  }

  widenLiteralForMessage(source: Type, target: Type): Type {
    const regular = regularOf(source);
    if (!isLiteralType(regular) || this.couldHaveTopLevelSingletonTypes(target)) return regular;
    return regular.kind === 'union' ? unionOf(regular.types.map(baseTypeOfUnit)) : baseTypeOfUnit(regular);
  }

  /** TypeScript's `typeCouldHaveTopLevelSingletonTypes`, which treats `boolean` itself as holding no literal. */
  private couldHaveTopLevelSingletonTypes(type: Type): boolean {
    if (type === booleanType) return false;
    if (type.kind === 'union' || type.kind === 'intersection')
      return type.types.some((member) => this.couldHaveTopLevelSingletonTypes(member));
    if (instantiableKinds.has(type.kind)) {
      const constraint = this.baseConstraint(type);
      return constraint !== type && this.couldHaveTopLevelSingletonTypes(constraint);
    }
    return isUnitType(type) || type.kind === 'templateLiteral';
  }

  /** The type of a variable initialized with `type`: literals widened, `null` and `undefined` kept. */
  widen(type: Type): Type {
    const widened = this.widenLiteral(type);
    if (widened.kind === 'object' && widened.fresh && widened.regular) return widened.regular;
    return widened;
  }
}

export function checkTypeScript(root: TreeNode, budget: ExecutionBudget): SourceDiagnostic[] {
  return new Checker(root, budget).check();
}

export { regularOf };

const instantiableKinds = new Set<Type['kind']>([
  'typeParameter',
  'indexedAccess',
  'keyof',
  'conditional',
  'stringMapping',
]);

/** TypeScript's `isUnitType`: a literal, `null`, or `undefined`. */
function isUnitType(type: Type): boolean {
  return type.kind === 'literal' || isIntrinsic(type, 'null') || isIntrinsic(type, 'undefined');
}

/** TypeScript's `isLiteralType`: a unit type or a union of them, `boolean` included. */
function isLiteralType(type: Type): boolean {
  return type.kind === 'union' ? type.types.every((member) => isUnitType(member)) : isUnitType(type);
}

/** The primitive of a literal other than a unique symbol, which TypeScript's `getBaseTypeOfLiteralType` keeps. */
function baseTypeOfUnit(type: Type): Type {
  return type.kind === 'literal' && typeof type.value !== 'symbol' ? primitiveOfLiteral(type) : type;
}
