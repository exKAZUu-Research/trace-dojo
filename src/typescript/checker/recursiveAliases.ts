import type { Checker } from './checker';
import type { Sym } from './scopes';
import { anonymousObject, emptyStructure, errorType, newTypeId, type ObjectType, type Type } from './types';

/**
 * The aliases that are not unions and refer to themselves inside an array, a tuple, or an interface's type arguments, as
 * `type Tree = Tree[]` does. TypeScript defers those references, so the alias stands for a type holding itself, but
 * reading the deferred reference's elements while the alias resolves, as `type G = G[]["length"]` does, is circular.
 */
export class RecursiveAliases {
  /** The type each resolving alias's references stand for until it resolves. */
  private readonly pendingTypes = new Map<Sym, ObjectType>();
  private readonly circular = new Set<Sym>();

  constructor(private readonly c: Checker) {}

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
    if (this.pendingTypes.size === 0 || type.kind !== 'object') return type;
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
    // It prints by the alias's name, as TypeScript's deferred type references do.
    const alias = declared.kind === 'object' ? { aliasName: symbol.name, aliasArguments: [] } : {};
    return Object.assign(pending, declared, { id: pending.id, ...alias });
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
