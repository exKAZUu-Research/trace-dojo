import type { Position } from './ast';
import type { NestedTypeFound, TypeContext } from './binderBase';
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
  substitute,
  substitutionOf,
  type Type,
  type TypeSymbol,
} from './types';

export interface MethodCandidate {
  method: MethodSymbol;
  /** The constructed type that declares the method, whose type arguments its signature takes. */
  owner: NamedType;
  /**
   * For a static member of an extension block, the type that the member is accessed through (`List<int>.Create()`),
   * which must convert to the block's receiver type and which infers the block's type arguments.
   */
  staticReceiver?: Type;
}

export type MemberLookup =
  | { kind: 'field'; field: FieldSymbol; owner: NamedType }
  | { kind: 'property'; property: PropertySymbol; owner: NamedType }
  | { kind: 'methods'; candidates: MethodCandidate[] }
  | { kind: 'type'; symbol: TypeSymbol; outerArgs: Type[] };

/** Finds members by name in types and their bases, honoring hiding, overriding, and accessibility. */
export class LookupBinder extends DeclarationBinder {
  /**
   * Reports a static abstract or virtual member of an interface named through the interface (CS8926), which only a
   * type parameter's type argument implements; returns whether it did.
   */
  protected reportConstrainedAccess(
    found:
      | { kind: 'methods'; candidates: { method: MethodSymbol }[] }
      | { kind: 'field'; field: FieldSymbol }
      | { kind: 'property'; property: PropertySymbol },
    position: Position
  ): boolean {
    const constrainedOnly =
      found.kind === 'methods'
        ? found.candidates.every((candidate) => isConstrained(candidate.method))
        : isConstrained(found.kind === 'field' ? found.field : found.property);
    if (constrainedOnly)
      this.error(
        position,
        'CS8926',
        '静的な仮想または抽象インターフェイス メンバーには、型パラメーターでのみアクセスできます。'
      );
    return constrainedOnly;
  }

  /** The constructed types to search for a type's members: the type and its bases, or an interface's bases. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
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
  // code-gauge-allow functionCognitiveComplexity -- Each level of the search chain shares the candidates and the inaccessible members found so far.
  lookupMember(
    type: Type,
    name: string,
    context: TypeContext,
    arity = 0,
    /** Whether the member is being called, which leaves out members that are not invocable (C# spec §12.5). */
    isInvoked = false,
    /** The type of the instance the access goes through, for protected access: `base` goes through the class's own. */
    through: Type = type
  ): { found: MemberLookup | undefined; inaccessible: FieldSymbol | PropertySymbol | MethodSymbol | undefined } {
    const candidates: MethodCandidate[] = [];
    let inaccessible: FieldSymbol | PropertySymbol | MethodSymbol | undefined;
    // An inaccessible nested type is left out of the lookup, as C#'s name lookup leaves it out, unless nothing else is found.
    let inaccessibleType: (NestedTypeFound & { kind: 'type' }) | undefined;
    // A tuple's element names stand for its `Item1`, `Item2`, ... fields.
    const element = type.kind === 'named' ? (type.tupleNames?.indexOf(name) ?? -1) : -1;
    if (element >= 0 && name !== `Item${element + 1}`)
      return this.lookupMember(type, `Item${element + 1}`, context, arity, isInvoked, through);
    for (const owner of this.searchChain(type)) {
      const symbol = owner.symbol;
      const member = memberNamed(owner, name, isInvoked);
      const isAccessibleMember = member !== undefined && this.isAccessible(member.access, symbol, context, through);
      if (isAccessibleMember && candidates.length > 0) break;
      if (isAccessibleMember) return { found: memberLookupOf(member, owner), inaccessible };
      inaccessible ??= member;
      if (candidates.length === 0) {
        const nestedLookup = this.findNestedType(owner, name, arity, context, false);
        if (nestedLookup.nested) return { found: { kind: 'type', ...nestedLookup.nested }, inaccessible };
        if (nestedLookup.inaccessible) inaccessibleType ??= { kind: 'type', ...nestedLookup.inaccessible };
      }
      const inaccessibleMethod = this.gatherMethods(owner, name, context, through, candidates);
      inaccessible ??= inaccessibleMethod;
    }
    if (candidates.length > 0) return { found: { kind: 'methods', candidates }, inaccessible };
    return { found: inaccessibleType, inaccessible };
  }

  /**
   * Adds the accessible methods of a name that one level of the search chain declares, except overrides and those whose
   * signature a more derived level already gave; returns the first inaccessible one.
   */
  private gatherMethods(
    owner: NamedType,
    name: string,
    context: TypeContext,
    type: Type,
    candidates: MethodCandidate[]
  ): MethodSymbol | undefined {
    let inaccessible: MethodSymbol | undefined;
    for (const method of owner.symbol.methods) {
      if (method.name !== name || method.kind === 'operator' || method.property || method.isOverride) continue;
      // Explicit interface implementations and event accessors have no name that code can call them by.
      if (method.explicitInterface || method.isEventAccessor) continue;
      // The library's private members stand for .NET's explicit interface implementations, which no name finds.
      if (method.access === 'private' && owner.symbol.isLibrary) continue;
      if (!this.isAccessible(method.access, owner.symbol, context, type)) {
        inaccessible ??= method;
        continue;
      }
      if (candidates.some((existing) => this.sameParameters(existing.method, method, existing.owner, owner))) continue;
      candidates.push({ method, owner });
    }
    return inaccessible;
  }

  /** The indexers of a type, from the most derived level that declares any. */
  lookupIndexers(type: Type, context: TypeContext): { property: PropertySymbol; owner: NamedType }[] {
    if (type.kind === 'array') return [];
    for (const owner of this.searchChain(type)) {
      const indexers = owner.symbol.properties.filter(
        (property) =>
          property.isIndexer &&
          !property.isOverride &&
          !property.explicitInterface &&
          this.isAccessible(property.access, owner.symbol, context, type)
      );
      if (indexers.length > 0) return indexers.map((property) => ({ property, owner }));
    }
    return [];
  }

  /** The user-defined operators of a type and its bases, or else those that extension blocks for the type declare. */
  lookupOperators(type: Type, name: string): MethodCandidate[] {
    const result: MethodCandidate[] = [];
    if (type.kind !== 'named' && type.kind !== 'typeParameter') return result;
    for (const owner of this.searchChain(type)) {
      for (const method of owner.symbol.methods)
        if (method.kind === 'operator' && method.name === name) result.push({ method, owner });
    }
    if (result.length > 0 || type.kind !== 'named') return result;
    return this.extensionOperators(name, (method) => extendsType(method, method.staticExtensionOf, type));
  }

  /** The operators of a name that the extension blocks in scope of the code being bound declare. */
  private extensionOperators(name: string, matches: (method: MethodSymbol) => boolean): MethodCandidate[] {
    return this.lookupExtensionMembers(
      this.operatorScope,
      (method) => method.kind === 'operator' && method.name === name && matches(method)
    );
  }

  /** Whether the binder binds a `dynamic` operation as it runs, where the runtime binder finds no extension methods. */
  protected isLateBinding = false;

  /**
   * Where the code being bound is written, whose namespaces in scope offer extension operators; operators bind without
   * a context of their own, so binding a statement or an expression sets it with {@link withOperatorScope}.
   */
  private operatorScope: TypeContext = { namespace: [], usings: [], type: undefined, methodTypeParameters: [] };

  protected withOperatorScope<T>(scope: TypeContext, bind: () => T): T {
    const enclosing = this.operatorScope;
    this.operatorScope = scope;
    try {
      return bind();
    } finally {
      this.operatorScope = enclosing;
    }
  }

  /** The extension methods by name that the namespaces in scope declare in their static classes. */
  lookupExtensionMethods(name: string, context: TypeContext): MethodCandidate[] {
    // An extension property's getter is found by the property's name only.
    return this.lookupExtensionMembers(
      context,
      (method) => method.isExtension && method.name === name && !method.extensionProperty
    );
  }

  /** The instance compound assignment and `++`/`--` operators that extension blocks for a type declare. */
  lookupExtensionAssignmentOperators(type: Type, name: string): MethodCandidate[] {
    return this.extensionOperators(name, (method) => extendsType(method, method.extensionAssignmentOf, type));
  }

  /** The getters of the extension properties of a name that the extension blocks in scope declare. */
  lookupExtensionProperties(name: string, context: TypeContext): MethodCandidate[] {
    return this.lookupExtensionMembers(
      context,
      (method) => method.extensionProperty === name && method.name === `get_${name}`
    );
  }

  /**
   * The static members of extension blocks by name that a type may be accessed through: methods, or with `property`,
   * property getters. Overload resolution checks the type against each block's receiver type, as Roslyn does.
   */
  lookupStaticExtensions(type: Type, name: string, isProperty: boolean, context: TypeContext): MethodCandidate[] {
    return this.lookupExtensionMembers(
      context,
      (method) =>
        method.staticExtensionOf !== undefined &&
        (isProperty
          ? method.extensionProperty === name && method.name === `get_${name}`
          : method.name === name && !method.extensionProperty)
    ).map((candidate) => ({ ...candidate, staticReceiver: type }));
  }

  /** The methods of the static classes in scope that satisfy a test, as extension methods are found. */
  private lookupExtensionMembers(context: TypeContext, matches: (method: MethodSymbol) => boolean): MethodCandidate[] {
    if (this.isLateBinding) return [];
    const namespaces = [...this.enclosingNamespaces(context), ...context.usings].flat();
    const classes = [
      ...namespaces.flatMap((namespace) => [...namespace.types.values()].flat().filter((symbol) => symbol.isStatic)),
      ...(context.staticUsings ?? []).map((type) => type.symbol),
    ];
    const result = classes.flatMap((symbol) =>
      symbol.methods.filter(matches).map((method) => ({ method, owner: symbol.declaredType }))
    );
    return result.filter(
      (candidate, index) => result.findIndex((other) => other.method === candidate.method) === index
    );
  }

  protected override canUseNestedType(nested: TypeSymbol, context: TypeContext): boolean {
    return !nested.containing || this.isAccessible(nested.access, nested.containing, context);
  }

  /** Whether code in the context may use a member with the access of its declaring type. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  isAccessible(access: string, declaringType: TypeSymbol, context: TypeContext, through?: Type): boolean {
    // The library's internal members are what `dynamic` binds to as it runs, which no code names.
    if (access === 'internal' && declaringType.isLibrary) return this.isLateBinding;
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

/** The field or property of a name that a type declares, leaving out one that a call cannot invoke. */
function memberNamed(owner: NamedType, name: string, isInvoked: boolean): FieldSymbol | PropertySymbol | undefined {
  const { symbol } = owner;
  const found =
    symbol.fields.find(
      (candidate) => candidate.name === name && !candidate.property && !candidate.eventAccessors?.add.explicitInterface
    ) ??
    symbol.properties.find(
      (candidate) => candidate.name === name && !candidate.isIndexer && !candidate.explicitInterface
    );
  // A member's type in its owner's type arguments, as `Func<int, int>` for KeyValuePair's `Value`, tells if it can be called.
  return found && isInvoked && !isInvocable(substitute(found.type, substitutionOf(owner))) ? undefined : found;
}

function memberLookupOf(member: FieldSymbol | PropertySymbol, owner: NamedType): MemberLookup {
  return member instanceof FieldSymbol
    ? { kind: 'field', field: member, owner }
    : { kind: 'property', property: member, owner };
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

/**
 * Whether an extension block's member extends a type: the block's type exactly, or for a generic block, a type of the
 * same definition, whose type arguments the call infers.
 */
function extendsType(method: MethodSymbol, extended: Type | undefined, type: Type): boolean {
  if (!extended) return false;
  if (method.typeParameters.length === 0) return sameType(extended, type);
  return extended.kind === 'named' && type.kind === 'named' && extended.symbol === type.symbol;
}

/** Whether a member is an interface's static abstract or virtual member, which a type parameter's argument implements. */
export function isConstrained(member: MethodSymbol | PropertySymbol | FieldSymbol): boolean {
  if (member instanceof FieldSymbol) return false;
  return member.isStatic && member.owner.kind === 'interface' && (member.isAbstract || member.isVirtual);
}
