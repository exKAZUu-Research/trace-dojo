import type { CallArity } from './callArity';
import type { Checker, Mapper } from './checker';
import {
  anyType,
  intersectionOf,
  type Parameter,
  type Signature,
  type Type,
  type TypeParameter,
  unionOf,
  unknownType,
} from './types';

/** How two signatures must match for a call through a union to use one for both. */
interface SignatureMatch {
  /** Whether the other may require fewer arguments and take supertypes of the parameters, not only the same ones. */
  partial: boolean;
  ignoreReturnTypes: boolean;
}

/** Combines the call signatures of a union's members into those a call through the union resolves to. */
export class UnionSignatures {
  constructor(
    private readonly c: Checker,
    private readonly arity: CallArity
  ) {}

  /**
   * The signatures a call through a union whose members have `lists` resolves to, as TypeScript's `getUnionSignatures`
   * gives: each signature every member has alike, or else, when at most one member is overloaded, its signatures each
   * combined with the other members' first.
   */
  of(lists: Signature[][]): Signature[] {
    if (lists.some((signatures) => signatures.length === 0)) return [];
    const shared = this.sharedSignatures(lists);
    const overloaded = [...lists.keys()].filter((index) => lists[index].length > 1);
    if (shared.length > 0 || overloaded.length > 1) return shared;
    return this.combineMembers(lists, overloaded[0] ?? 0);
  }

  /**
   * The call signatures of a union of the same method of different arrays, as TypeScript resolves a call through it when
   * the union has no call signatures: the method of an array of the union of their element types, read-only when any
   * of them is from `ReadonlyArray`. None when a member is not a method of `Array` or `ReadonlyArray` or they differ.
   */
  arrayMethodSignatures(members: Type[]): Signature[] {
    let name: string | undefined;
    const elements: Type[] = [];
    let readonly = false;
    for (const member of members) {
      const method = this.arrayMethodOf(member);
      if (!method || (name !== undefined && method.name !== name)) return [];
      name = method.name;
      elements.push(method.element);
      readonly ||= method.readonly;
    }
    if (name === undefined) return [];
    const property = this.c.propertyOf(this.c.arrayType(unionOf(elements), readonly), name);
    return property ? this.c.signaturesOf(property.type(), 'call') : [];
  }

  /** The method of `Array` or `ReadonlyArray` that `type` instantiates, with its element type. */
  private arrayMethodOf(type: Type): { name: string; element: Type; readonly: boolean } | undefined {
    if (type.kind !== 'object') return undefined;
    const declaration = this.c.signaturesOf(type, 'call')[0]?.declaration;
    if (declaration?.type !== 'method_signature' || !this.c.isLibrary(declaration)) return undefined;
    const name = declaration.childForFieldName('name')?.text;
    const owner = declaration.parent?.parent;
    const interfaceName = owner?.type === 'interface_declaration' ? owner.childForFieldName('name')?.text : undefined;
    if (!name || (interfaceName !== 'Array' && interfaceName !== 'ReadonlyArray')) return undefined;
    const elementParameter = (this.c.globalType(interfaceName).typeParameters as TypeParameter[])[0];
    const element = type.mapper?.get(elementParameter.id);
    return element && { name, element, readonly: interfaceName === 'ReadonlyArray' };
  }

  /** The signatures that every member list has one matching, each once. */
  private sharedSignatures(lists: Signature[][]): Signature[] {
    const result: Signature[] = [];
    const exact: SignatureMatch = { partial: false, ignoreReturnTypes: true };
    for (const [index, signatures] of lists.entries()) {
      for (const signature of signatures) {
        if (result.some((existing) => this.matches(existing, signature, exact))) continue;
        const matching = this.matchingSignatures(lists, signature, index);
        if (matching) result.push(matching.length > 1 ? this.unionSignature(signature, matching) : signature);
      }
    }
    return result;
  }

  /** The signatures each member list has matching `signature`, or `undefined` when one has none. */
  private matchingSignatures(lists: Signature[][], signature: Signature, listIndex: number): Signature[] | undefined {
    // A generic signature must be the first member's and match exactly, return type included.
    if (signature.typeParameters.length > 0) {
      if (listIndex > 0) return undefined;
      const exact: SignatureMatch = { partial: false, ignoreReturnTypes: false };
      return lists.slice(1).every((list) => list.some((other) => this.matches(other, signature, exact)))
        ? [signature]
        : undefined;
    }
    const matching: Signature[] = [];
    for (const [index, list] of lists.entries()) {
      const match =
        index === listIndex
          ? signature
          : (list.find((other) => this.matches(other, signature, { partial: false, ignoreReturnTypes: true })) ??
            list.find((other) => this.matches(other, signature, { partial: true, ignoreReturnTypes: true })));
      if (!match) return undefined;
      if (!matching.includes(match)) matching.push(match);
    }
    return matching;
  }

  /** Whether `source` matches `target` as TypeScript's `compareSignaturesIdentical` compares them. */
  private matches(source: Signature, target: Signature, match: SignatureMatch): boolean {
    if (source === target) return true;
    if (!this.hasMatchingArity(source, target, match.partial)) return false;
    const mapper = this.typeParameterMapper(source.typeParameters, target.typeParameters, match.partial);
    if (!mapper) return false;
    const instantiated = mapper.size > 0 ? this.c.instantiateSignature(source, mapper) : source;
    const related = (a: Type, b: Type): boolean => this.related(a, b, match.partial);
    if (instantiated.thisType && target.thisType && !related(instantiated.thisType, target.thisType)) return false;
    for (let index = 0; index < target.parameters.length; index++) {
      if (!related(this.typeAt(target, index) ?? anyType, this.typeAt(instantiated, index) ?? anyType)) return false;
    }
    return match.ignoreReturnTypes || related(instantiated.returnType(), target.returnType());
  }

  private hasMatchingArity(source: Signature, target: Signature, partial: boolean): boolean {
    const [sourceMinimum, targetMinimum] = [this.arity.minimumArguments(source), this.arity.minimumArguments(target)];
    if (
      source.parameters.length === target.parameters.length &&
      sourceMinimum === targetMinimum &&
      hasRest(source) === hasRest(target)
    )
      return true;
    return partial && sourceMinimum <= targetMinimum;
  }

  /**
   * The mapper from `source`'s type parameters to `target`'s, or `undefined` when they differ in number or in their
   * constraints and defaults.
   */
  private typeParameterMapper(source: TypeParameter[], target: TypeParameter[], partial = false): Mapper | undefined {
    if (source.length !== target.length) return undefined;
    const mapper: Mapper = new Map(source.map((parameter, index) => [parameter.id, target[index]]));
    const instantiated = (type: Type | undefined): Type => (type ? this.c.instantiate(type, mapper) : unknownType);
    const same = source.every(
      (parameter, index) =>
        parameter === target[index] ||
        (this.related(instantiated(parameter.constraint?.()), target[index].constraint?.() ?? unknownType, partial) &&
          this.related(instantiated(parameter.default?.()), target[index].default?.() ?? unknownType, partial))
    );
    return same ? mapper : undefined;
  }

  /** Compares types as TypeScript does for matching signatures: identical, or for a partial match, assignable. */
  private related(source: Type, target: Type, partial: boolean): boolean {
    return partial ? this.c.relations.isAssignable(source, target) : this.c.relations.identical(source, target);
  }

  /** `signature` called for all of `matching`, which returns what any of them returns. */
  private unionSignature(signature: Signature, matching: Signature[]): Signature {
    const thisTypes = matching.flatMap((member) => (member.thisType ? [member.thisType] : []));
    const predicates = matching.map((member) => member.predicate);
    const predicateIndex = predicates[0]?.index;
    return {
      ...signature,
      thisType: thisTypes.length > 0 ? intersectionOf(thisTypes, this.c.budget) : undefined,
      returnType: () => this.c.literals.subtypeReduced(matching.map((member) => member.returnType())),
      predicate: predicates.every((predicate) => predicate && predicate.index === predicateIndex)
        ? { index: predicateIndex as number, type: unionOf(predicates.map((predicate) => predicate?.type as Type)) }
        : undefined,
    };
  }

  /**
   * The signatures of the member at `masterIndex`, each combined with the first signature of every other member, or
   * none when generic signatures among them declare different type parameters.
   */
  private combineMembers(lists: Signature[][], masterIndex: number): Signature[] {
    let results = lists[masterIndex];
    for (const [index, signatures] of lists.entries()) {
      if (index === masterIndex) continue;
      const [signature] = signatures;
      if (
        signature.typeParameters.length > 0 &&
        results.some(
          (result) =>
            result.typeParameters.length > 0 &&
            !this.typeParameterMapper(signature.typeParameters, result.typeParameters)
        )
      )
        return [];
      results = results.map((result) => this.combineSignatures(result, signature));
    }
    return results;
  }

  /**
   * The signature that calls both `left` and `right`, as TypeScript combines them: the longer parameter list, each
   * parameter the type both accept at its position, a rest when either has one, and either return type. `right`'s type
   * parameters become `left`'s when both have some.
   */
  private combineSignatures(left: Signature, rightSignature: Signature): Signature {
    const mapper =
      left.typeParameters.length > 0 && rightSignature.typeParameters.length > 0
        ? this.typeParameterMapper(rightSignature.typeParameters, left.typeParameters)
        : undefined;
    const right = mapper ? this.c.instantiateSignature(rightSignature, mapper) : rightSignature;
    const both = (index: number): Type =>
      this.intersectParameters([this.typeAt(left, index) ?? unknownType, this.typeAt(right, index) ?? unknownType]);
    const longest = left.parameters.length >= right.parameters.length ? left : right;
    const eitherRest = hasRest(left) || hasRest(right);
    const extraRest = eitherRest && !hasRest(longest);
    const minimum = Math.max(this.arity.minimumArguments(left), this.arity.minimumArguments(right));
    const parameters: Parameter[] = longest.parameters.map((parameter, index) => {
      const isRest = eitherRest && !extraRest && index === longest.parameters.length - 1;
      return {
        ...parameter,
        rest: isRest,
        optional: !isRest && index >= minimum,
        type: isRest ? this.c.arrayType(both(index)) : both(index),
      };
    });
    if (extraRest) {
      const index = longest.parameters.length;
      parameters.push({ name: 'args', rest: true, optional: false, type: this.c.arrayType(both(index)) });
    }
    const thisTypes = [left.thisType, right.thisType].filter((type) => type !== undefined);
    return {
      typeParameters: left.typeParameters.length > 0 ? left.typeParameters : right.typeParameters,
      parameters,
      thisType: thisTypes.length > 0 ? intersectionOf(thisTypes, this.c.budget) : undefined,
      returnType: () => this.c.literals.subtypeReduced([left.returnType(), right.returnType()]),
    };
  }

  /** The type a signature takes an argument at `index` as, or `undefined` past its parameters. */
  private typeAt(signature: Signature, index: number): Type | undefined {
    const { parameters } = signature;
    if (hasRest(signature) && index >= parameters.length - 1)
      return this.c.restElementType((parameters.at(-1) as Parameter).type);
    return parameters[index]?.type;
  }

  private intersectParameters(types: Type[]): Type {
    let result = types[0];
    for (const type of types.slice(1)) {
      if (this.c.relations.isAssignable(type, result)) result = type;
      else if (!this.c.relations.isAssignable(result, type)) result = intersectionOf([result, type], this.c.budget);
    }
    return result;
  }
}

function hasRest(signature: Signature): boolean {
  return signature.parameters.at(-1)?.rest === true;
}
