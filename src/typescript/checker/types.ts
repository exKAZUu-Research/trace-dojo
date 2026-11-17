import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { ExecutionBudget } from '../../interpreter/limits';

/** A TypeScript type, as the checker represents it. */
export type Type =
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
  | StringMappingType;

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

export interface LiteralType {
  kind: 'literal';
  id: number;
  value: string | number | bigint | boolean;
  /** Whether an expression produced it, which lets a mutable location widen it to its primitive. */
  fresh: boolean;
  /** The other of the fresh and regular types of the same value. */
  counterpart: LiteralType;
}

export interface UnionType {
  kind: 'union';
  id: number;
  types: Type[];
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
  readonly: boolean;
  isMethod: boolean;
  /** For a class member, its visibility and the class that declares it. */
  visibility: 'public' | 'private' | 'protected';
  declaringClass?: ClassInfo;
  /** A `#name` field, which only the declaring class sees. */
  isPrivateName?: boolean;
  declaration?: TreeNode;
  /** For a property a mapped type made, the literal types that name it, which `keyof` gives. */
  nameType?: Type;
  /** Whether the property is a get accessor without a setter. */
  getterOnly?: boolean;
  isAbstract?: boolean;
}

export interface Parameter {
  name: string;
  type: Type;
  optional: boolean;
  rest: boolean;
}

export interface Signature {
  typeParameters: TypeParameter[];
  parameters: Parameter[];
  thisType?: Type;
  returnType: () => Type;
  /** A type predicate `x is T`, by the index of the parameter it narrows (-1 for `this`). */
  predicate?: { index: number; type: Type };
  declaration?: TreeNode;
  /** Whether it comes from a method, whose parameters compare bivariantly. */
  isMethod?: boolean;
  /** Whether it constructs an abstract class. */
  isAbstract?: boolean;
}

export interface IndexInfo {
  type: Type;
  readonly: boolean;
}

export interface Structure {
  properties: Map<string, Property>;
  callSignatures: Signature[];
  constructSignatures: Signature[];
  stringIndex?: IndexInfo;
  numberIndex?: IndexInfo;
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
  /** For a function or object literal whose type was inferred from an expression. */
  isLiteral?: boolean;
  /** For an object literal typed by one alternative of a union it spreads, which TypeScript leaves unnormalized. */
  isUnionSpread?: boolean;
  /** The alias the type was written with, for printing. */
  aliasName?: string;
  aliasArguments?: Type[];
  /** Whether it is a function type, printed as `(x: T) => U`. */
  isFunction?: boolean;
  /** Whether it is the instance type of a class or interface with a `this` type. */
  thisType?: TypeParameter;
  /** For an instantiated anonymous type, the declared one, which every instantiation shares as its recursion identity. */
  origin?: ObjectType;
  /** For an instantiated anonymous type, the type arguments of `origin`'s type parameters and of outer ones. */
  mapper?: Map<number, Type>;
}

export interface TupleElement {
  type: Type;
  optional: boolean;
  rest: boolean;
  name?: string;
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
}

export interface TypeParameter {
  kind: 'typeParameter';
  id: number;
  name: string;
  constraint?: () => Type | undefined;
  default?: () => Type | undefined;
  /** A `this` type, whose constraint is the class or interface it belongs to. */
  isThisType?: boolean;
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
  checkType: Type;
  extendsType: Type;
  trueType: Type;
  falseType: Type;
  /** The `infer` type parameters the extends type declares. */
  inferTypeParameters: TypeParameter[];
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
export function literalType(value: string | number | bigint | boolean): LiteralType {
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

export function freshLiteralType(value: string | number | bigint | boolean): LiteralType {
  return literalType(value).counterpart;
}

export const trueType = literalType(true);
export const falseType = literalType(false);
export const booleanType: UnionType = { kind: 'union', id: newTypeId(), types: [falseType, trueType] };

export function isIntrinsic(type: Type, name: IntrinsicName): boolean {
  return type.kind === 'intrinsic' && type.name === name;
}

export function isAnyLike(type: Type): boolean {
  return type.kind === 'intrinsic' && type.name === 'any';
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

/** The union of types, flattened, without duplicates, with literals absorbed by their primitives. */
// code-gauge-allow functionNcss 42 -- Flattens, deduplicates, and reduces members as TypeScript's unions do.
// code-gauge-allow functionCognitiveComplexity 30 -- Flattens, deduplicates, and reduces members as TypeScript's unions do.
export function unionOf(types: Type[], keepFresh = false): Type {
  const flat: Type[] = [];
  const seen = new Set<number>();
  const add = (type: Type): void => {
    if (type.kind === 'union') {
      for (const member of type.types) add(member);
      return;
    }
    const member = keepFresh ? type : regularOf(type);
    if (member.kind === 'intrinsic' && member.name === 'never') return;
    if (seen.has(member.id)) return;
    seen.add(member.id);
    flat.push(member);
  };
  for (const type of types) add(type);
  if (flat.some((type) => type === anyType || type === errorType)) return flat.find((type) => isAnyLike(type)) as Type;
  if (flat.some((type) => isIntrinsic(type, 'unknown'))) return unknownType;
  const primitives = new Set<IntrinsicName>(flat.filter((type) => type.kind === 'intrinsic').map((type) => type.name));
  const reduced = flat.filter((type) => {
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
  const key = reduced.map((type) => type.id).join('|');
  let union = unionCache.get(key);
  if (!union) {
    if (key === booleanType.types.map((type) => type.id).join('|')) return booleanType;
    union = { kind: 'union', id: newTypeId(), types: reduced };
    unionCache.set(key, union);
  }
  return union;
}

// code-gauge-allow functionNcss 35 -- Flattens and reduces members as TypeScript's intersections do.
// code-gauge-allow functionCognitiveComplexity 28 -- Flattens and reduces members as TypeScript's intersections do.
export function intersectionOf(types: Type[], budget: ExecutionBudget): Type {
  budget.spend(types.length);
  const flat: Type[] = [];
  const add = (type: Type): void => {
    if (type.kind === 'intersection') {
      for (const member of type.types) add(member);
      return;
    }
    if (!flat.some((existing) => existing.id === type.id)) flat.push(type);
  };
  for (const type of types) add(type);
  if (flat.some((type) => isIntrinsic(type, 'never'))) return neverType;
  if (flat.some((type) => isAnyLike(type))) return anyType;
  const members = flat.filter((type) => !isIntrinsic(type, 'unknown'));
  if (members.length === 0) return unknownType;
  // A union distributes, as `(A | B) & C` is `(A & C) | (B & C)`.
  const unionIndex = members.findIndex((type) => type.kind === 'union');
  if (unionIndex !== -1) {
    const union = members[unionIndex] as UnionType;
    return unionOf(
      union.types.map((member) =>
        intersectionOf(
          members.map((type, index) => (index === unionIndex ? member : type)),
          budget
        )
      )
    );
  }
  // Two different primitives or literals have nothing in common.
  const units = members.filter((type) => type.kind === 'literal' || isPrimitive(type));
  for (const unit of units) {
    for (const other of units) {
      if (unit !== other && !primitiveOverlaps(unit, other)) return neverType;
    }
  }
  const literal = units.find((type) => type.kind === 'literal');
  if (literal && units.length === members.length) return literal;
  // TypeScript drops `void` beside its subtype `undefined`.
  const reduced = members.filter(
    (type) => !isIntrinsic(type, 'void') || !units.some((unit) => isIntrinsic(unit, 'undefined'))
  );
  if (reduced.length === 1) return reduced[0];
  return { kind: 'intersection', id: newTypeId(), types: reduced };
}

function isPrimitive(type: Type): boolean {
  return (
    type.kind === 'intrinsic' &&
    ['string', 'number', 'bigint', 'symbol', 'undefined', 'null', 'void'].includes(type.name)
  );
}

function primitiveOverlaps(a: Type, b: Type): boolean {
  if (a.kind === 'literal' && b.kind === 'literal') return a.value === b.value;
  return primitiveDomain(a) === primitiveDomain(b);
}

function primitiveDomain(type: Type): string {
  if (type.kind === 'literal') return typeof type.value;
  if (type.kind !== 'intrinsic') return '';
  // `void` holds only `undefined`, so the two overlap as TypeScript's `VoidLike` domain.
  return type.name === 'void' ? 'undefined' : type.name;
}

export function typeMembers(type: Type): Type[] {
  return type.kind === 'union' ? type.types : [type];
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

export function functionType(signature: Signature): ObjectType {
  return anonymousObject(() => ({ ...emptyStructure(), callSignatures: [signature] }), { isFunction: true });
}

/** Whether a type is a literal or a union of literals, which a widening location widens. */
export function isFreshLiteral(type: Type): boolean {
  return type.kind === 'literal' && type.fresh;
}
