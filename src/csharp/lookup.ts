import type { TypeContext } from './binderBase';
import { DeclarationBinder } from './declarations';
import {
  type ArrayType,
  baseTypeOf,
  FieldSymbol,
  interfacesOf,
  MethodSymbol,
  type NamedType,
  PropertySymbol,
  sameType,
  type Type,
  type TypeSymbol,
} from './types';

export interface MethodCandidate {
  method: MethodSymbol;
  /** The constructed type that declares the method, whose type arguments its signature takes. */
  owner: NamedType;
}

export type MemberLookup =
  | { kind: 'field'; field: FieldSymbol; owner: NamedType }
  | { kind: 'property'; property: PropertySymbol; owner: NamedType }
  | { kind: 'methods'; candidates: MethodCandidate[] }
  | { kind: 'type'; symbol: TypeSymbol; outerArgs: Type[] };

/** Finds members by name in types and their bases, honoring hiding, overriding, and accessibility. */
export class LookupBinder extends DeclarationBinder {
  /** The constructed types to search for a type's members: the type and its bases, or an interface's bases. */
  protected searchChain(type: Type): NamedType[] {
    if (type.kind === 'array') return this.chainOf(this.wellKnown.array);
    if (type.kind === 'typeParameter') {
      const chain: NamedType[] = [];
      for (const constraint of type.symbol.constraintTypes) {
        for (const member of this.searchChain(constraint))
          if (!chain.some((existing) => sameType(existing, member))) chain.push(member);
      }
      const fallback = type.symbol.hasValueConstraint ? this.wellKnown.valueType : this.objectType;
      for (const member of this.chainOf(fallback))
        if (!chain.some((existing) => sameType(existing, member))) chain.push(member);
      return chain;
    }
    if (type.kind !== 'named') return [];
    if (type.symbol.kind === 'interface') {
      const chain: NamedType[] = [];
      const add = (face: NamedType): void => {
        if (chain.some((existing) => sameType(existing, face))) return;
        chain.push(face);
        for (const parent of interfacesOf(face)) add(parent);
      };
      add(type);
      chain.push(this.objectType);
      return chain;
    }
    return this.chainOf(type);
  }

  private chainOf(type: NamedType): NamedType[] {
    const chain: NamedType[] = [];
    for (let current: NamedType | undefined = type; current; current = baseTypeOf(current)) chain.push(current);
    return chain;
  }

  /**
   * Looks a member up by name as C# does: the most derived non-method member hides everything below it, and methods
   * gather from every level except those that override or are hidden by a method of the same signature.
   */
  lookupMember(
    type: Type,
    name: string,
    context: TypeContext,
    arity = 0,
    /** Whether the member is being called, which leaves out members that are not invocable (C# spec §12.5). */
    isInvoked = false
  ): { found: MemberLookup | undefined; inaccessible: FieldSymbol | PropertySymbol | MethodSymbol | undefined } {
    const candidates: MethodCandidate[] = [];
    let inaccessible: FieldSymbol | PropertySymbol | MethodSymbol | undefined;
    // A tuple's element names stand for its `Item1`, `Item2`, ... fields.
    const element = type.kind === 'named' ? (type.tupleNames?.indexOf(name) ?? -1) : -1;
    if (element >= 0) return this.lookupMember(type, `Item${element + 1}`, context, arity, isInvoked);
    for (const owner of this.searchChain(type)) {
      const symbol = owner.symbol;
      const field = symbol.fields.find((candidate) => candidate.name === name && !candidate.property);
      const property = symbol.properties.find((candidate) => candidate.name === name && !candidate.isIndexer);
      const nested = symbol.nestedTypes.find(
        (candidate) => candidate.name === name && candidate.typeParameters.length === arity
      );
      const found = field ?? property;
      const member = found && isInvoked && !isInvocable(found.type) ? undefined : found;
      if (member) {
        if (this.isAccessible(member.access, symbol, context, type)) {
          if (candidates.length > 0) break;
          return member instanceof FieldSymbol
            ? { found: { kind: 'field', field: member, owner }, inaccessible }
            : { found: { kind: 'property', property: member, owner }, inaccessible };
        }
        inaccessible ??= member;
      }
      if (nested && candidates.length === 0)
        return { found: { kind: 'type', symbol: nested, outerArgs: owner.args }, inaccessible };
      for (const method of symbol.methods) {
        if (method.name !== name || method.kind === 'operator' || method.property) continue;
        if (method.isOverride) continue;
        if (!this.isAccessible(method.access, symbol, context, type)) {
          inaccessible ??= method;
          continue;
        }
        if (candidates.some((existing) => this.sameParameters(existing.method, method, existing.owner, owner)))
          continue;
        candidates.push({ method, owner });
      }
    }
    if (candidates.length > 0) return { found: { kind: 'methods', candidates }, inaccessible };
    return { found: undefined, inaccessible };
  }

  /** The indexers of a type, from the most derived level that declares any. */
  lookupIndexers(type: Type, context: TypeContext): { property: PropertySymbol; owner: NamedType }[] {
    if (type.kind === 'array') return [];
    for (const owner of this.searchChain(type)) {
      const indexers = owner.symbol.properties.filter(
        (property) =>
          property.isIndexer && !property.isOverride && this.isAccessible(property.access, owner.symbol, context, type)
      );
      if (indexers.length > 0) return indexers.map((property) => ({ property, owner }));
    }
    return [];
  }

  /** The user-defined operators of a type and its bases. */
  lookupOperators(type: Type, name: string): MethodCandidate[] {
    const result: MethodCandidate[] = [];
    if (type.kind !== 'named') return result;
    for (const owner of this.searchChain(type)) {
      for (const method of owner.symbol.methods)
        if (method.kind === 'operator' && method.name === name) result.push({ method, owner });
    }
    return result;
  }

  /** The extension methods by name that the namespaces in scope declare in their static classes. */
  lookupExtensionMethods(name: string, context: TypeContext): MethodCandidate[] {
    const result: MethodCandidate[] = [];
    const visit = (types: Map<string, TypeSymbol[]>): void => {
      for (const list of types.values()) {
        for (const symbol of list) {
          if (!symbol.isStatic) continue;
          for (const method of symbol.methods) {
            if (method.isExtension && method.name === name) result.push({ method, owner: symbol.declaredType });
          }
        }
      }
    };
    for (const namespaces of this.enclosingNamespaces(context)) {
      for (const namespace of namespaces) visit(namespace.types);
    }
    for (const group of context.usings) for (const namespace of group) visit(namespace.types);
    return result.filter(
      (candidate, index) => result.findIndex((other) => other.method === candidate.method) === index
    );
  }

  /** Whether code in the context may use a member with the access of its declaring type. */
  isAccessible(access: string, declaringType: TypeSymbol, context: TypeContext, through?: Type): boolean {
    if (access === 'public' || access === 'internal' || access === 'protected internal') return true;
    const within = context.type;
    if (!within) return false;
    if (access === 'private') {
      for (let type: TypeSymbol | undefined = within; type; type = type.containing)
        if (type === declaringType || this.originalDefinition(type) === declaringType) return true;
      return false;
    }
    // A protected member is accessible in derived classes, through an instance of the deriving class.
    for (let type: TypeSymbol | undefined = within; type; type = type.containing) {
      if (type === declaringType || this.derivesFrom(type, declaringType)) {
        if (
          !through ||
          through.kind !== 'named' ||
          through.symbol === type ||
          this.derivesFrom(through.symbol, type) ||
          access === 'protected internal'
        )
          return true;
        return through.symbol === declaringType && type === declaringType;
      }
    }
    return false;
  }

  private originalDefinition(type: TypeSymbol): TypeSymbol {
    return type;
  }

  derivesFrom(type: TypeSymbol, base: TypeSymbol): boolean {
    for (let current = type.baseType; current; current = current.symbol.baseType)
      if (current.symbol === base) return true;
    return false;
  }

  /** The element type that `foreach` over an array of the type gives. */
  protected arrayElement(type: ArrayType): Type {
    return type.element;
  }

  /** Whether a method is an accessor or an operator, which name lookup does not find by its name. */
  protected isSpecialMethod(method: MethodSymbol): boolean {
    return method.kind !== 'method';
  }
}

/** Whether a member of the type can be called, as a delegate can. */
function isInvocable(type: Type): boolean {
  return (
    type.kind === 'error' ||
    (type.kind === 'named' &&
      (type.symbol.kind === 'delegate' ||
        type.symbol.special === 'delegate' ||
        type.symbol.special === 'multicastDelegate'))
  );
}

export { MethodSymbol, PropertySymbol, FieldSymbol };
