import type { Checker, Mapper } from './checker';
import type { Sym } from './scopes';
import {
  anonymousObject,
  emptyStructure,
  errorType,
  newTypeId,
  type ObjectType,
  type Type,
  typeMapperCacheKey,
  type TypeParameter,
} from './types';

/** The members a deferred alias reference reads from the instantiation it stands for, which it makes when first read. */
const forwardedMembers: {
  [K in Exclude<keyof ObjectType, 'kind' | 'id' | 'aliasName' | 'aliasArguments' | 'aliasId' | 'aliasMapper'>]-?: true;
} = {
  objectKind: true,
  name: true,
  typeParameters: true,
  typeArguments: true,
  target: true,
  resolveReference: true,
  resolve: true,
  fresh: true,
  regular: true,
  classInfo: true,
  isClassStatic: true,
  tuple: true,
  mapped: true,
  isResolvedMappedType: true,
  mappedOptional: true,
  mappedKeys: true,
  isLiteral: true,
  isUnionSpread: true,
  isFunction: true,
  thisType: true,
  origin: true,
  mapper: true,
  nonGeneric: true,
  outerTypeParameters: true,
};

/**
 * The aliases that are not unions and refer to themselves inside an array, a tuple, or an interface's type arguments, as
 * `type Tree = Tree[]` does. TypeScript defers those references, so the alias stands for a type holding itself, but
 * reading the deferred reference's elements while the alias resolves, as `type G = G[]["length"]` does, is circular.
 * A generic one, as `type Tree<T> = [T, Tree<T>[]]`, is instantiated by deferred references that instantiate the alias
 * when first read, as TypeScript's deferred type references do, so that instantiating it ends.
 */
export class RecursiveAliases {
  /** The type each resolving alias's references stand for until it resolves. */
  private readonly pendingTypes = new Map<Sym, ObjectType>();
  private readonly circular = new Set<Sym>();
  /** The generic alias and its type arguments that a declared type or a deferred reference stands for. */
  private readonly genericReferences = new Map<Type, { symbol: Sym; mapper: Mapper }>();
  private readonly referenceCache = new Map<string, ObjectType>();

  constructor(private readonly c: Checker) {}

  /** Whether `type` is the type a deferred reference to the resolving alias `symbol` stands for. */
  isPendingType(symbol: Sym, type: Type): boolean {
    return this.pendingTypes.get(symbol) === type;
  }

  /** A generic alias that holds itself, or a deferred reference to one, instantiated by `mapper`, if `type` is one. */
  instantiateReference(type: Type, mapper: Mapper): ObjectType | undefined {
    const reference = this.genericReferences.get(type);
    if (!reference) return undefined;
    const instantiated: Mapper = new Map(
      [...reference.mapper].map(([id, argument]) => [id, this.c.instantiate(argument, mapper)])
    );
    return this.reference(reference.symbol, instantiated);
  }

  /**
   * The generic alias `symbol` applied to the type arguments that `mapper` gives its type parameters and those of the
   * declarations around it, which instantiates the alias when first read.
   */
  reference(symbol: Sym, argumentsMapper: Mapper): ObjectType {
    const { own, all } = this.typeParametersOf(symbol);
    const mapper: Mapper = new Map(
      all.map((parameter) => [parameter.id, argumentsMapper.get(parameter.id) ?? parameter])
    );
    const key = `${symbol.id}[${typeMapperCacheKey(mapper)}]`;
    const cached = this.referenceCache.get(key);
    if (cached) return cached;
    this.c.budget.spend();
    let target: ObjectType | undefined;
    const reference = {
      kind: 'object',
      id: newTypeId(),
      aliasName: symbol.name,
      aliasId: symbol.id,
      aliasArguments: own.map((parameter) => mapper.get(parameter.id) ?? parameter),
      aliasMapper: mapper,
    } as ObjectType;
    for (const member of Object.keys(forwardedMembers)) {
      Object.defineProperty(reference, member, {
        get: () => (target ??= this.instantiateAlias(symbol, mapper))[member as keyof ObjectType],
        enumerable: true,
      });
    }
    this.referenceCache.set(key, reference);
    this.genericReferences.set(reference, { symbol, mapper });
    return reference;
  }

  private instantiateAlias(symbol: Sym, mapper: Mapper): ObjectType {
    const declared = symbol.declaredType;
    if (!declared || symbol.resolving) {
      // Reading a deferred reference while its alias resolves, as a rest element's spread does, is circular.
      this.circular.add(symbol);
      return anonymousObject(() => emptyStructure());
    }
    const instantiated = declared.kind === 'object' ? this.c.instantiateAliasedObject(declared, mapper) : declared;
    return instantiated.kind === 'object' ? instantiated : anonymousObject(() => emptyStructure());
  }

  /** The type parameters of an alias, and those with the ones of the declarations around it it sees. */
  private typeParametersOf(symbol: Sym): { own: TypeParameter[]; all: TypeParameter[] } {
    const own = this.c.signatures.typeParametersOfSymbol(symbol);
    const outer = this.c.signatures.outerTypeParametersOf(symbol.typeDeclarations[0]) ?? [];
    return { own, all: [...outer, ...own] };
  }

  /** The type a deferred reference to a resolving alias stands for. */
  pendingTypeOf(symbol: Sym): Type {
    let pending = this.pendingTypes.get(symbol);
    if (!pending) {
      pending = anonymousObject(() => emptyStructure());
      this.pendingTypes.set(symbol, pending);
    }
    return pending;
  }

  /**
   * An array, tuple, or interface reference whose elements are read only after the aliases they refer to resolve, which
   * is circular before.
   */
  deferred(type: Type): Type {
    // A deferred reference is read only when used, which its own instantiation guards.
    if (
      this.pendingTypes.size === 0 ||
      type.kind !== 'object' ||
      this.genericReferences.has(type) ||
      type.resolveReference
    )
      return type;
    const symbols = this.heldAliases(type);
    if (symbols.length === 0) return type;
    const guard = (): void => {
      for (const symbol of symbols) if (this.pendingTypes.has(symbol)) this.circular.add(symbol);
    };
    const { typeArguments, tuple } = type;
    const guarded: ObjectType = {
      ...type,
      id: newTypeId(),
      resolve: () => {
        guard();
        return type.resolve();
      },
    };
    Object.defineProperties(guarded, {
      typeArguments: {
        get: () => {
          guard();
          return typeArguments;
        },
        enumerable: true,
      },
      tuple: {
        get: () => {
          guard();
          return tuple;
        },
        enumerable: true,
      },
    });
    return guarded;
  }

  /** The alias's type once `declared` resolves it, which the references inside it, holding its pending type, become. */
  complete(symbol: Sym, declared: Type): Type {
    const pending = this.pendingTypes.get(symbol);
    if (!pending) return declared;
    this.pendingTypes.delete(symbol);
    if (this.circular.delete(symbol)) {
      this.c.error(symbol.typeDeclarations[0], `型エイリアス ${symbol.name} が自分自身を参照しています。`);
      Object.assign(pending, errorType, { id: pending.id });
      return errorType;
    }
    if (declared.kind !== 'object') return Object.assign(pending, declared, { id: pending.id });
    const { own, all } = this.typeParametersOf(symbol);
    // It prints by the alias's name, as TypeScript's deferred type references do.
    const completed = Object.assign(pending, declared, {
      id: pending.id,
      aliasName: symbol.name,
      aliasArguments: own,
    });
    if (all.length > 0) {
      completed.aliasMapper = new Map(all.map((parameter) => [parameter.id, parameter]));
      this.genericReferences.set(completed, { symbol, mapper: completed.aliasMapper });
    }
    return completed;
  }

  private heldAliases(type: ObjectType): Sym[] {
    const elements = type.tuple?.elements.map((element) => element.type) ?? type.typeArguments ?? [];
    const members = new Set(
      elements.flatMap((element) =>
        element.kind === 'union' || element.kind === 'intersection' ? element.types : [element]
      )
    );
    return [...this.pendingTypes].filter(([, pending]) => members.has(pending)).map(([symbol]) => symbol);
  }
}
