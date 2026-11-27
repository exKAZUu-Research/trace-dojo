// code-gauge-allow-file fileNcss -- Keeps type data, cache keys, and canonical type constructors together.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { ExecutionBudget } from '../../interpreter/limits';
import type { Checker } from './checker';

/** A TypeScript type, as the checker represents it. */
export type Type = (
  | IntrinsicType
  | LiteralType
  | UnionType
  | IntersectionType
  | ObjectType
  | TypeParameter
  | IndexedAccessType
  | KeyofType
  | ConditionalType
  | TemplateLiteralType
  | StringMappingType
) & { noInfer?: boolean };

export type Mapper = Map<number, Type> & { preserveLiterals?: true };

export function createMapper(entries: Iterable<readonly [number, Type]>, preserveLiterals?: true): Mapper {
  return Object.assign(new Map(entries), { preserveLiterals });
}

let nextTypeId = 1;

export function newTypeId(): number {
  return nextTypeId++;
}

export type IntrinsicName =
  | 'any'
  | 'unknown'
  | 'never'
  | 'void'
  | 'undefined'
  | 'null'
  | 'string'
  | 'number'
  | 'bigint'
  | 'symbol'
  | 'object';

export interface IntrinsicType {
  kind: 'intrinsic';
  id: number;
  name: IntrinsicName;
}

export type LiteralValue = string | number | bigint | boolean | symbol;
type LiteralKind = 'string' | 'number' | 'bigint' | 'boolean' | 'symbol';

export interface EnumMemberInfo {
  enumId: number;
  enumName: string;
  name: string;
  computed: boolean;
  members: () => ReadonlyMap<string, { value: string | number | undefined; computed: boolean }>;
  base: () => Type;
}

export interface LiteralType {
  kind: 'literal';
  id: number;
  /** A JS symbol for a unique symbol type, whose `String` names the property it keys. */
  value: LiteralValue;
  /** Whether an expression produced it, which lets a mutable location widen it to its primitive. */
  fresh: boolean;
  /** The other of the fresh and regular types of the same value. */
  counterpart: LiteralType;
  /** For an enum member's type, the enum and the member, and the enum's type, to which the member's type widens. */
  enumMember?: EnumMemberInfo;
}

export interface UnionType {
  kind: 'union';
  id: number;
  types: Type[];
  /**
   * For a union whose members are instantiated when first read, as for an alias that holds an instantiation of itself,
   * the type arguments the alias's type parameters get.
   */
  aliasMapper?: Map<number, Type>;
  /** For an enum's type, the union of its members' types, the enum's name. */
  enumName?: string;
}

export interface IntersectionType {
  kind: 'intersection';
  id: number;
  types: Type[];
}

export interface Property {
  name: string;
  type: () => Type;
  writeType?: () => Type;
  optional: boolean;
  exactOptionalType?: true;
  readonly: boolean;
  isMethod: boolean;
  /** For a class member, its visibility and the class that declares it. */
  visibility: 'public' | 'private' | 'protected';
  writeVisibility?: Property['visibility'];
  declaringClass?: ClassInfo;
  /** A `#name` field, which only the declaring class sees. */
  isPrivateName?: boolean;
  declaration?: TreeNode;
  /** The checked key type of a member, captured where it is declared or produced by a mapped type. */
  nameType?: Type;
  /** Whether the property is a get accessor without a setter. */
  getterOnly?: boolean;
  setterOnly?: boolean;
  isAbstract?: boolean;
}

export interface Parameter {
  name: string;
  type: Type;
  /** Inferred default source for the declaration's pattern, with object-literal freshness intact. */
  bindingType?: Type;
  optional: boolean;
  rest: boolean;
}

export interface Signature {
  typeParameters: TypeParameter[];
  parameters: Parameter[];
  immediateArgumentCount?: number;
  checkImmediateBody?: () => void;
  thisType?: Type;
  returnType: () => Type;
  /**
   * A type predicate `x is T`, by the index of the parameter it narrows (-1 for `this`), or an assertion: `asserts x is
   * T`, or `asserts x`, which narrows `x` to where it is truthy, and whose type is then `unknown`.
   */
  predicate?: { index: number; type: Type; asserts?: 'type' | 'truthy' };
  declaration?: TreeNode;
  /** Whether it constructs an abstract class. */
  isAbstract?: boolean;
  /** How many arguments a call needs when its parameters do not tell, as a union's signature whose rest covers some. */
  minimumArguments?: number;
  /** The required count before expanding a rest tuple or checking whether trailing parameters accept void. */
  declaredMinimumArguments?: number;
}

export interface IndexInfo {
  type: Type;
  readonly: boolean;
  /** For the reverse mapping of a numeric enum object, which `E[0]` reads but `keyof typeof E` does not list. */
  isEnumReverseMapping?: boolean;
}

/** An index signature with the key type it is declared for, as `` [k: `a${string}`]: T `` is for `` `a${string}` ``. */
export interface KeyedIndexInfo extends IndexInfo {
  keyType: Type;
}

export interface Structure {
  properties: Map<string, Property>;
  callSignatures: Signature[];
  constructSignatures: Signature[];
  stringIndex?: IndexInfo;
  numberIndex?: IndexInfo;
  symbolIndex?: IndexInfo;
  /** The index signatures for template literal or string mapping patterns, one for each pattern. */
  patternIndexes?: KeyedIndexInfo[];
}

/** The information about a class that its instances' private and protected members and its checks need. */
export interface ClassInfo {
  name: string;
  declaration: TreeNode;
  instanceType: ObjectType;
  staticType: ObjectType;
  isAbstract: boolean;
}

export interface ObjectType {
  kind: 'object';
  id: number;
  /** What kind of object type it is, which decides how it prints and compares. */
  objectKind: 'anonymous' | 'interface' | 'reference' | 'tuple' | 'mapped';
  /** The name of an interface, class, or alias it was declared as. */
  name?: string;
  typeParameters?: TypeParameter[];
  typeArguments?: Type[];
  /** For a reference, the generic interface it instantiates. */
  target?: ObjectType;
  resolveReference?: () => ObjectType;
  resolve: () => Structure;
  /** An object literal that may not have properties its target lacks. */
  fresh?: boolean;
  /** The object literal type this fresh one was made from. */
  regular?: ObjectType;
  /** The class whose instances this type describes, or whose constructor it is. */
  classInfo?: ClassInfo;
  isClassStatic?: boolean;
  tuple?: TupleInfo;
  mapped?: MappedInfo;
  isResolvedMappedType?: true;
  mappedOptional?: true;
  /** For an object a mapped type without `as` resolved to, its constraint, which `keyof` gives instead of its members. */
  mappedKeys?: () => Type;
  /** For a function or object literal whose type was inferred from an expression. */
  isLiteral?: boolean;
  /** For an object literal typed by one alternative of a union it spreads, which TypeScript leaves unnormalized. */
  isUnionSpread?: boolean;
  hasSpread?: boolean;
  /** For the type of a value other than a class, such as an enum object, the name `typeof` prints it with. */
  valueName?: string;
  /** The alias the type was written with, for printing. */
  aliasName?: string;
  aliasArguments?: Type[];
  aliasId?: number;
  /** Whether it is a function type, printed as `(x: T) => U`. */
  isFunction?: boolean;
  /** Whether it is the instance type of a class or interface with a `this` type. */
  thisType?: TypeParameter;
  /**
   * For an instantiated anonymous type, or an interface or class instantiated for its outer type parameters, the declared
   * one, which every instantiation shares as its recursion identity.
   */
  origin?: ObjectType;
  /** For an instantiated type with an `origin`, the type arguments of `origin`'s type parameters and of outer ones. */
  mapper?: Map<number, Type>;
  /** Whether it was written outside every declaration of type parameters, so that no type parameter occurs in it. */
  nonGeneric?: boolean;
  /**
   * For an interface or class declared inside generic declarations, their type parameters it sees, which TypeScript's
   * `getOuterTypeParameters` gives and instantiating it maps.
   */
  outerTypeParameters?: TypeParameter[];
  /**
   * For a reference to a generic alias that holds itself, whose members are instantiated when first read, the type
   * arguments the alias's type parameters get.
   */
  aliasMapper?: Map<number, Type>;
}

export interface TupleElement {
  type: Type;
  optional: boolean;
  rest: boolean;
  name?: string;
  labelId?: number;
}

export interface TupleInfo {
  elements: TupleElement[];
  readonly: boolean;
}

export interface MappedInfo {
  typeParameter: TypeParameter;
  constraint: Type;
  nameType?: Type;
  template: Type;
  readonlyModifier?: '+' | '-';
  optionalModifier?: '+' | '-';
  /** For a homomorphic mapped type, `{ [K in keyof T]: ... }`, the type `T` whose modifiers it keeps. */
  source?: Type;
  homomorphic?: true;
}

export interface TypeParameter {
  kind: 'typeParameter';
  id: number;
  name: string;
  isConst?: boolean;
  constraint?: () => Type | undefined;
  default?: () => Type | undefined;
  /** A conditional true-branch occurrence keeps its original parameter as the assignment target. */
  substitution?: { base: TypeParameter; constraint: Type };
  /** A `this` type, whose constraint is the class or interface it belongs to. */
  isThisType?: boolean;
  /** The variance its `in` and `out` annotations declare, which relates instantiations by their type arguments. */
  variance?: 'in' | 'out' | 'in out';
}

export function thisParameter(type: ObjectType): TypeParameter {
  return { kind: 'typeParameter', id: newTypeId(), name: 'this', isThisType: true, constraint: () => type };
}

export function thisParameterOf(type: ObjectType): TypeParameter | undefined {
  return type.thisType ?? type.target?.thisType;
}

export interface IndexedAccessType {
  kind: 'indexedAccess';
  id: number;
  objectType: Type;
  indexType: Type;
}

export interface KeyofType {
  kind: 'keyof';
  id: number;
  type: Type;
}

export interface ConditionalType {
  kind: 'conditional';
  id: number;
  declaration?: TreeNode;
  checkType: Type;
  extendsType: Type;
  trueType: Type;
  falseType: Type;
  /** The `infer` type parameters the extends type declares. */
  inferTypeParameters: TypeParameter[];
  outerTypeParameters: TypeParameter[];
  /** Whether it distributes over a union its check type, a naked type parameter, receives. */
  distributive: boolean;
  /** For a conditional type instantiated while still generic, the declared one and the type arguments it got. */
  root?: ConditionalType;
  mapper?: Map<number, Type>;
  aliasName?: string;
  aliasArguments?: Type[];
}

export interface TemplateLiteralType {
  kind: 'templateLiteral';
  id: number;
  texts: string[];
  types: Type[];
}

export interface StringMappingType {
  kind: 'stringMapping';
  id: number;
  mapping: 'Uppercase' | 'Lowercase' | 'Capitalize' | 'Uncapitalize';
  type: Type;
}

function intrinsic(name: IntrinsicName): IntrinsicType {
  return { kind: 'intrinsic', id: newTypeId(), name };
}

export const anyType = intrinsic('any');
export const permissiveAnyType = intrinsic('any');
export const unknownType = intrinsic('unknown');
export const neverType = intrinsic('never');
export const voidType = intrinsic('void');
export const undefinedType = intrinsic('undefined');
export const nullType = intrinsic('null');
export const stringType = intrinsic('string');
export const numberType = intrinsic('number');
export const bigintType = intrinsic('bigint');
export const symbolType = intrinsic('symbol');
export const nonPrimitiveType = intrinsic('object');
/** The type of an expression that already caused an error, which compares with anything to avoid more errors. */
export const errorType: IntrinsicType = { kind: 'intrinsic', id: newTypeId(), name: 'any' };

let literalTypes = new Map<string, LiteralType>();

/** The regular (non-widening) literal type of a value. */
export function literalType(value: LiteralValue): LiteralType {
  const key = `${typeof value}:${typeof value === 'number' && Object.is(value, -0) ? '0' : String(value)}`;
  let type = literalTypes.get(key);
  if (!type) {
    const regular = { kind: 'literal', id: newTypeId(), value, fresh: false } as LiteralType;
    const fresh = { kind: 'literal', id: newTypeId(), value, fresh: true, counterpart: regular } as LiteralType;
    regular.counterpart = fresh;
    type = regular;
    literalTypes.set(key, type);
  }
  return type;
}

export function freshLiteralType(value: LiteralValue): LiteralType {
  return literalType(value).counterpart;
}

export const trueType = literalType(true);
export const falseType = literalType(false);
/** The key `unionOf` gives `true | false`, whose members it sorts. */
const booleanUnionKey = [falseType.id, trueType.id].toSorted((a, b) => a - b).join('|');
export const booleanType: UnionType = { kind: 'union', id: newTypeId(), types: [falseType, trueType] };

/**
 * A unique symbol type, `typeof name`, which a `const` that `Symbol()` initializes has. As a fresh literal, it widens
 * to `symbol` in a mutable location.
 */
export function uniqueSymbolType(name: string, fresh = true): LiteralType {
  const symbol = Symbol(`${name}@${newTypeId()}`);
  return fresh ? freshLiteralType(symbol) : literalType(symbol);
}

/** The name of the declaration of the unique symbol a property name stands for, if it stands for one. */
export function uniqueSymbolName(propertyName: string): string | undefined {
  return /^Symbol\((.*)@\d+\)$/.exec(propertyName)?.[1];
}

/** Whether a type is a literal that names a property: a string, a number, or a unique symbol. */
export function isPropertyKeyLiteral(type: Type): type is LiteralType & { value: string | number | symbol } {
  return (
    type.kind === 'literal' && !type.enumMember?.computed && ['string', 'number', 'symbol'].includes(typeof type.value)
  );
}

const literalPrimitives: Record<LiteralKind, Type> = {
  boolean: booleanType,
  string: stringType,
  number: numberType,
  bigint: bigintType,
  symbol: symbolType,
};

/** The primitive type of a literal's value. */
export function primitiveOfLiteral(type: LiteralType): Type {
  return literalPrimitives[typeof type.value as LiteralKind];
}

/** The type a literal widens to: an enum member's enum, or else the primitive of its value. */
export function widenedLiteralType(type: LiteralType): Type {
  return type.enumMember ? type.enumMember.base() : primitiveOfLiteral(type);
}

export function baseTypeOfLiteral(type: Type): Type {
  if (isTemplateOrStringMapping(type)) return stringType;
  return type.kind === 'literal' && typeof type.value !== 'symbol' ? widenedLiteralType(type) : type;
}

export function isIntrinsic(type: Type, name: IntrinsicName): boolean {
  return type.kind === 'intrinsic' && type.name === name;
}

export function isAnyLike(type: Type): boolean {
  return type.kind === 'intrinsic' && type.name === 'any';
}

/**
 * The declared type of an alias, printed by the alias's name, unless it is another alias applied to this alias's own
 * type parameters, as `type A<T> = Partial<T>` is, which TypeScript keeps printing by the other alias.
 */
export function aliasedDeclaredType(type: Type, name: string, typeParameters: TypeParameter[], aliasId: number): Type {
  if (type.kind !== 'object' && type.kind !== 'conditional') return type;
  const arguments_ = type.aliasArguments ?? [];
  const renames =
    type.aliasName !== undefined &&
    arguments_.length === typeParameters.length &&
    arguments_.every((argument, index) => argument === typeParameters[index]);
  if (type.kind === 'object')
    return withAlias(type, renames ? (type.aliasName ?? name) : name, typeParameters, aliasId);
  if (renames) return type;
  // A copy would read the branches, which a conditional type declared by an alias resolves lazily; it is its own.
  type.aliasName = name;
  type.aliasArguments = typeParameters;
  return type;
}

/** An anonymous or mapped object type printed as an alias applied to type arguments; any other type as it is. */
export function withAlias<T extends Type>(type: T, name: string, typeArguments: Type[], aliasId?: number): T {
  if (type.kind !== 'object' || (type.objectKind !== 'anonymous' && type.objectKind !== 'mapped')) return type;
  if (typeArguments.length > 0 && type.nonGeneric) {
    return {
      ...type,
      id: newTypeId(),
      nonGeneric: false,
      origin: type.origin ?? type,
      aliasName: name,
      aliasArguments: typeArguments,
      aliasId,
    };
  }
  return { ...type, aliasName: name, aliasArguments: typeArguments, aliasId };
}

/** The regular version of a type that may be a fresh literal or a fresh object literal. */
export function regularOf(type: Type): Type {
  if (type.kind === 'literal' && type.fresh) return type.counterpart;
  if (type.kind === 'object' && type.fresh && type.regular) return type.regular;
  return type;
}

let unionCache = new Map<string, UnionType>();

/** The cached types made as the modules loaded, such as `boolean`, which every check starts from. */
let loadedTypes: { literals: Map<string, LiteralType>; unions: Map<string, UnionType> } | undefined;

/**
 * Starts the caches of literal and union types afresh for a check. A cached type can hold the types of the check that
 * made it, and through them the whole check, which a server running program after program must not keep.
 */
export function startTypeCaches(): void {
  loadedTypes ??= { literals: new Map(literalTypes), unions: new Map(unionCache) };
  literalTypes = new Map(loadedTypes.literals);
  unionCache = new Map(loadedTypes.unions);
}

function unionSortKey(type: Type): number {
  return type.id;
}

export function typeCacheKey(type: Type | undefined): number | string | undefined {
  return type?.noInfer ? `${type.id}!` : type?.id;
}

export function freshTypeCacheKey(type: Type): string {
  return `${typeCacheKey(type)}${type.kind === 'object' && type.fresh ? 'f' : ''}`;
}

export function typeMapperCacheKey(mapper: ReadonlyMap<number, Type> & Pick<Mapper, 'preserveLiterals'>): string {
  const entries = [...mapper].map(([id, type]) => `${id}=${typeCacheKey(type)}`).join(',');
  return mapper.preserveLiterals ? `+${entries}` : entries;
}

/** Flattens and canonicalizes unions, retaining covered literal alternatives in contextual types. */
// code-gauge-allow functionCognitiveComplexity -- Flattens, deduplicates, and reduces members as TypeScript's unions do.
export function unionOf(types: Type[], keepFresh = false, preserveLiterals = false): Type {
  const flat = flattenedMembers(types, 'union', keepFresh).filter((type) => !isIntrinsic(type, 'never'));
  if (flat.includes(permissiveAnyType)) return permissiveAnyType;
  if (flat.some((type) => type === anyType || type === errorType)) return flat.find((type) => isAnyLike(type)) as Type;
  if (flat.some((type) => isIntrinsic(type, 'unknown'))) return unknownType;
  const primitives = new Set<IntrinsicName>(flat.filter((type) => type.kind === 'intrinsic').map((type) => type.name));
  const reduced = preserveLiterals
    ? flat
    : flat.filter((type) => {
        if (type.kind === 'literal') {
          const primitive = typeof type.value === 'boolean' ? undefined : (typeof type.value as IntrinsicName);
          return !primitive || !primitives.has(primitive);
        }
        if (type.kind === 'templateLiteral' || type.kind === 'stringMapping') return !primitives.has('string');
        return true;
      });
  if (reduced.length === 0) return neverType;
  if (reduced.length === 1) return reduced[0];
  reduced.sort((a, b) => unionSortKey(a) - unionSortKey(b));
  const key = reduced.map(freshTypeCacheKey).join('|');
  let union = unionCache.get(key);
  if (!union) {
    if (key === booleanUnionKey) return booleanType;
    union = { kind: 'union', id: newTypeId(), types: reduced };
    unionCache.set(key, union);
  }
  return union;
}

export function writtenIntersectionOf(types: Type[], c: Checker): Type {
  if (types.length === 2) {
    const [left, right] = types;
    const member = left === emptyObjectType ? right : right === emptyObjectType ? left : undefined;
    if (member && preservesEmptyObjectIntersection(member)) {
      c.budget.spend(types.length);
      return newIntersectionType(types, c);
    }
  }
  return intersectionOf(types, c);
}

function preservesEmptyObjectIntersection(type: Type): boolean {
  return (
    isIntrinsic(type, 'string') ||
    isIntrinsic(type, 'number') ||
    isIntrinsic(type, 'bigint') ||
    (type.kind === 'templateLiteral' && isPatternLiteralType(type))
  );
}

export function intersectionOf(types: Type[], c: Checker): Type {
  const { budget } = c;
  budget.spend(types.length);
  const flat = flattenedMembers(types, 'intersection', true, budget);
  if (flat.some((type) => isIntrinsic(type, 'never'))) return neverType;
  if (hasDisjointIntersectionDomains(flat)) return neverType;
  const compatible = intersectStringPatterns(flat, c);
  if (!compatible) return neverType;
  if (compatible.includes(permissiveAnyType)) return permissiveAnyType;
  if (compatible.some((type) => isAnyLike(type))) return anyType;
  const members = compatible.filter((type) => !isIntrinsic(type, 'unknown'));
  if (members.length === 0) return unknownType;
  // A union distributes, as `(A | B) & C` is `(A & C) | (B & C)`.
  const unionIndex = members.findIndex((type) => type.kind === 'union');
  const union = members[unionIndex];
  if (union?.kind === 'union') return distributeIntersection(members, union, unionIndex, c);
  const reduced = reducedIntersectionMembers(members);
  if (reduced.length === 1) return reduced[0];
  return newIntersectionType(reduced, c);
}

function newIntersectionType(types: Type[], c: Checker): IntersectionType {
  if (types.length === 2) {
    const [left, right] = types;
    const dependency = intersectionConstraintOperand(left, right) ?? intersectionConstraintOperand(right, left);
    if (dependency) c.typeNodes.eagerConstraints.record(dependency);
  }
  return { kind: 'intersection', id: newTypeId(), types };
}

function intersectionConstraintOperand(variable: Type, bound: Type): Type | undefined {
  if (variable.noInfer || (variable.kind !== 'typeParameter' && variable.kind !== 'indexedAccess')) return undefined;
  if (variable.kind === 'typeParameter' && variable.substitution) return undefined;
  return isPrimitive(bound) ||
    bound.kind === 'literal' ||
    isIntrinsic(bound, 'object') ||
    isEmptyObject(bound) ||
    isPatternLiteralType(bound)
    ? variable
    : undefined;
}

function distributeIntersection(
  members: Type[],
  union: Extract<Type, { kind: 'union' }>,
  unionIndex: number,
  c: Checker
): Type {
  const alternatives = union.noInfer ? union.types.map((type) => preventInference(type, c.budget)) : union.types;
  return unionOf(
    alternatives.map((alternative) =>
      intersectionOf(
        members.map((type, index) => (index === unionIndex ? alternative : type)),
        c
      )
    )
  );
}

function intersectStringPatterns(types: Type[], c: Checker): Type[] | undefined {
  if (!types.some(isTemplateOrStringMapping)) return types;
  const unit = types.find((type) => type.kind === 'literal' && typeof type.value === 'string');
  if (!unit) return types;
  const compatible: Type[] = [];
  for (const type of types) {
    if (isTemplateOrStringMapping(type) && !type.noInfer) {
      if (c.relations.isRelated(unit, type, 'strictSubtype')) continue;
      if (isPatternLiteralType(type)) return undefined;
    }
    compatible.push(type);
  }
  return compatible;
}

function reducedIntersectionMembers(members: Type[]): Type[] {
  const hasNonNullableMember = members.some(nonNullableIntersectionMember);
  const narrowDomains = new Set(members.map(narrowIntersectionDomain));
  const hasUndefined = members.some((type) => isIntrinsic(type, 'undefined'));
  return members.filter(
    (type) =>
      (type.kind !== 'intrinsic' || !narrowDomains.has(type.name)) &&
      (!isIntrinsic(type, 'void') || !hasUndefined) &&
      (!isEmptyObject(type) || !hasNonNullableMember)
  );
}

function narrowIntersectionDomain(type: Type): string | undefined {
  if (type.kind === 'literal') return typeof type.value;
  return isTemplateOrStringMapping(type) && !type.noInfer ? 'string' : undefined;
}

function nonNullableIntersectionMember(type: Type): boolean {
  return (
    (type.kind === 'object' && !isEmptyObject(type)) ||
    isTemplateOrStringMapping(type) ||
    (isPrimitive(type) && !isIntrinsic(type, 'void')) ||
    type.kind === 'literal' ||
    isIntrinsic(type, 'object')
  );
}

function hasDisjointIntersectionDomains(types: Type[]): boolean {
  let domain: string | undefined;
  let mixedDomains = false;
  let reducesDomains = false;
  let unit: number | undefined;
  for (const type of types) {
    const current = primitiveDomain(type);
    if (current === undefined) continue;
    mixedDomains ||= domain !== undefined && current !== domain;
    domain = current;
    // TypeScript does not check the Boolean or null domains against other domains on their own.
    reducesDomains ||= current !== 'boolean' && current !== 'null';
    if (type.kind !== 'literal' && !isNullableUnit(type)) continue;
    const id = regularOf(type).id;
    if (unit !== undefined && unit !== id) return true;
    unit = id;
  }
  return (
    (mixedDomains && reducesDomains) ||
    (types.some((type) => type.kind === 'object' && !type.noInfer) && types.some(isNullableUnit))
  );
}

// code-gauge-allow functionCognitiveComplexity -- Flattens type members and preserves inference boundaries.
function flattenedMembers(
  types: Type[],
  kind: 'union' | 'intersection',
  keepFresh: boolean,
  budget?: ExecutionBudget
): Type[] {
  const members = new Map<number, Type>();
  const add = (type: Type, noInfer = false): void => {
    budget?.spend();
    const blocked = noInfer || type.noInfer === true;
    const opaque = kind === 'intersection' && blocked;
    if (type.kind === kind && !opaque) {
      for (const member of type.types) add(member, blocked);
      return;
    }
    const member = keepFresh ? type : regularOf(type);
    const existing = members.get(member.id);
    if (existing && (!existing.noInfer || blocked)) return;
    members.set(member.id, blocked ? { ...member, noInfer: true } : member);
  };
  for (const type of types) add(type);
  return [...members.values()];
}

export function isPrimitive(type: Type): boolean {
  return (
    type.kind === 'intrinsic' &&
    ['string', 'number', 'bigint', 'symbol', 'undefined', 'null', 'void'].includes(type.name)
  );
}

export function isTemplateOrStringMapping(type: Type): type is TemplateLiteralType | StringMappingType {
  return type.kind === 'templateLiteral' || type.kind === 'stringMapping';
}

export function preventInference(type: Type, budget: ExecutionBudget): Type {
  return canBlockInference(type, budget) ? { ...type, noInfer: true } : type;
}

function canBlockInference(type: Type, budget: ExecutionBudget): boolean {
  if (type.noInfer) return false;
  if (type.kind === 'union' || type.kind === 'intersection') {
    budget.spend(type.types.length);
    return type.types.some((member) => canBlockInference(member, budget));
  }
  if (type.kind === 'object') return !isEmptyObject(type);
  if (isTemplateOrStringMapping(type)) return !isPatternLiteralType(type);
  return (
    type.kind === 'typeParameter' ||
    type.kind === 'conditional' ||
    type.kind === 'indexedAccess' ||
    type.kind === 'keyof'
  );
}

function isEmptyObject(type: Type): boolean {
  return type.kind === 'object' && (type.origin ?? type).id === emptyObjectType.id;
}

function primitiveDomain(type: Type): string | undefined {
  if (type.kind === 'literal') return typeof type.value;
  if (type.kind === 'union') {
    const boolean =
      type.types.length > 0 &&
      type.types.every((member) => member.kind === 'literal' && typeof member.value === 'boolean');
    return boolean ? 'boolean' : undefined;
  }
  if (isTemplateOrStringMapping(type)) return type.noInfer ? undefined : 'string';
  if (type.kind !== 'intrinsic' || !(isPrimitive(type) || isIntrinsic(type, 'object'))) return undefined;
  // `void` holds only `undefined`, so the two overlap as TypeScript's `VoidLike` domain.
  return type.name === 'void' ? 'undefined' : type.name;
}

export function typeMembers(type: Type): Type[] {
  return type.kind === 'union' ? type.types : [type];
}

export function isDiscriminantLiteral(type: Type): boolean {
  if (type.kind === 'union') return type.types.every(isDiscriminantUnit);
  return isDiscriminantUnit(type) || isPatternLiteralType(type);
}

function isDiscriminantUnit(type: Type): boolean {
  return type.kind === 'literal' || isNullableUnit(type);
}

function isNullableUnit(type: Type): boolean {
  return isIntrinsic(type, 'null') || isIntrinsic(type, 'undefined');
}

function isPatternLiteralType(type: Type): boolean {
  if (type.kind === 'templateLiteral') return type.types.every(isPatternLiteralPlaceholder);
  return type.kind === 'stringMapping' && isPatternLiteralPlaceholder(type.type);
}

function isPatternLiteralPlaceholder(type: Type): boolean {
  if (type.kind === 'intersection') {
    const placeholders = type.types.filter((member) => member.kind !== 'object');
    return (
      placeholders.length > 0 &&
      placeholders.every((member) => isDiscriminantUnit(member) || isPatternLiteralPlaceholder(member))
    );
  }
  return (
    isAnyLike(type) ||
    isIntrinsic(type, 'string') ||
    isIntrinsic(type, 'number') ||
    isIntrinsic(type, 'bigint') ||
    isPatternLiteralType(type)
  );
}

export function filterType(type: Type, keep: (member: Type) => boolean): Type {
  if (type.kind !== 'union') return keep(type) ? type : neverType;
  return unionOf(type.types.filter(keep), true);
}

export function mapType(type: Type, map: (member: Type) => Type): Type {
  if (type.kind !== 'union') return map(type);
  return unionOf(type.types.map(map), true);
}

export function emptyStructure(): Structure {
  return { properties: new Map(), callSignatures: [], constructSignatures: [] };
}

export function anonymousObject(resolve: () => Structure, extra: Partial<ObjectType> = {}): ObjectType {
  let structure: Structure | undefined;
  return {
    kind: 'object',
    id: newTypeId(),
    objectKind: 'anonymous',
    resolve: () => {
      structure ??= resolve();
      return structure;
    },
    ...extra,
  };
}

export function freshObjectLiteral(regular: ObjectType): ObjectType {
  return { ...regular, fresh: true, regular };
}

/** `{}`, which every value but `null` and `undefined` is assignable to. */
export const emptyObjectType = anonymousObject(emptyStructure, { nonGeneric: true });
// TypeScript distinguishes non-null unknown from a written {} for the in operator.
export const narrowedUnknownObjectType = anonymousObject(emptyStructure, { nonGeneric: true });

export function accessorProperty(
  property: Property,
  previous: Property | undefined,
  getter: boolean,
  accessorType: () => Type
): Property {
  const writeType = getter ? previous?.writeType : accessorType;
  return {
    ...(getter ? property : (previous ?? property)),
    type: getter ? accessorType : (previous?.type ?? accessorType),
    writeType,
    readonly: writeType === undefined,
    getterOnly: getter && writeType === undefined,
    setterOnly: !getter && (!previous || previous.setterOnly === true),
  };
}

export function simpleProperty(name: string, type: Type, options: Partial<Property> = {}): Property {
  return {
    name,
    type: () => type,
    optional: false,
    readonly: false,
    isMethod: false,
    visibility: 'public',
    ...options,
  };
}

export function propertyAccessType(property: Property, access: 'read' | 'write' = 'read', keepFresh = false): Type {
  const type = (access === 'write' ? (property.writeType ?? property.type) : property.type)();
  return property.optional && !property.exactOptionalType ? unionOf([type, undefinedType], keepFresh) : type;
}

export function functionType(signature: Signature): ObjectType {
  return anonymousObject(() => ({ ...emptyStructure(), callSignatures: [signature] }), { isFunction: true });
}

/** Whether a type is a literal or a union of literals, which a widening location widens. */
export function isFreshLiteral(type: Type): boolean {
  return type.kind === 'literal' && type.fresh;
}
