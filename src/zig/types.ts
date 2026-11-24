import type { Container, FunctionDeclaration, Span, VariableDeclaration } from './ast';
import { constantText } from './constantText';
import { spendMemory } from './memoryAccounting';
import { scalarValueKey, type Value } from './values';
import { WeakValueMap } from './weakValueMap';

/** Zig's types. Types that Zig compares by structure are interned, so that `===` tells whether two are the same. */
export type Type =
  | IntType
  | FloatType
  | SimpleType
  | ArrayType
  | PointerType
  | OptionalType
  | ErrorSetType
  | ErrorUnionType
  | StructType
  | EnumType
  | UnionType
  | FnType;

export interface IntType {
  readonly kind: 'int';
  readonly signed: boolean;
  readonly bits: number;
  readonly name: string;
}

export interface FloatType {
  readonly kind: 'float';
  readonly bits: 16 | 32 | 64 | 80 | 128;
}

export interface SimpleType {
  readonly kind:
    | 'comptime_int'
    | 'comptime_float'
    | 'bool'
    | 'void'
    | 'noreturn'
    | 'type'
    | 'null'
    | 'undefined'
    | 'enum_literal'
    | 'anyopaque'
    | 'anytype';
}

export class Sentinel {
  constructor(readonly value: Value) {}
}

export interface ArrayType {
  readonly kind: 'array';
  readonly length: bigint;
  readonly child: Type;
  readonly sentinel?: Sentinel;
  /** Whether the type is `@Vector(n, T)`, whose operators work on each element, rather than `[n]T`. */
  readonly isVector?: boolean;
}

export interface PointerType {
  readonly kind: 'pointer';
  /** `one` for `*T`, `many` for `[*]T`, `slice` for `[]T`, and `c` for `[*c]T`. */
  readonly size: 'one' | 'many' | 'slice' | 'c';
  readonly child: Type;
  readonly isConst: boolean;
  readonly sentinel?: Sentinel;
  readonly isVolatile?: boolean;
  readonly allowZero?: boolean;
  /** The alignment that `align(n)` gives, when it differs from the child type's own. */
  readonly alignment?: number;
}

export interface PointerAttributes {
  isConst: boolean;
  isVolatile?: boolean;
  allowZero?: boolean;
  alignment?: number;
  sentinel?: Value | Sentinel;
}

export interface OptionalType {
  readonly kind: 'optional';
  readonly child: Type;
}

export interface ErrorSetType {
  readonly kind: 'error_set';
  /** The names of the errors, or undefined for `anyerror`; an inferred set fills them in when its function is analyzed. */
  names: Set<string> | undefined;
  /** The declaration's name, for messages and `@typeName`. */
  readonly name?: string;
  /** The function whose errors this set is, for an inferred error set (`!T`). */
  readonly inferredFrom?: string;
  resolved?: boolean;
}

export interface ErrorUnionType {
  readonly kind: 'error_union';
  readonly errorSet: ErrorSetType;
  readonly payload: Type;
}

export interface StructField {
  name: string;
  type: Type;
  /** The default value, compiled when the struct is first used. */
  defaultValue?: Value;
  hasDefault: boolean;
  /** Whether a tuple's field holds a value known at compile time, which the tuple's type carries. */
  comptimeValue?: { value: Value };
  /** The alignment that `align(n)` gives the field. */
  alignment?: number;
}

/** What struct, enum, and union types share: their declarations, which the compiler analyzes on demand. */
export interface Namespace {
  readonly internal?: boolean;
  readonly name: string;
  readonly decls: Map<string, Decl>;
  readonly parent?: Namespace;
  /** The container's syntax, for user-defined types. */
  readonly syntax?: Container;
  /** The compiler's scope where the container was declared, whose names its declarations see. */
  readonly scope?: unknown;
}

export interface StructType {
  readonly kind: 'struct';
  readonly isTuple: boolean;
  readonly namespace: Namespace;
  readonly layout: 'auto' | 'extern' | 'packed';
  /** Filled when the struct is first used, since fields may refer to types declared later. */
  fields: StructField[] | undefined;
  /** A struct that the grader implements natively, such as `Turtle` or `std.ArrayList(T)`. */
  native?: NativeStruct;
}

export interface NativeStruct {
  readonly defaultValue?: () => Value;
  readonly byteSize?: number;
  readonly byteAlignment?: number;
  readonly storageSlots?: number;
  readonly kind: string;
  /** The type arguments of a generic native type. */
  readonly args: readonly Type[];
}

export interface EnumField {
  name: string;
  value: bigint;
}

export interface EnumType {
  readonly kind: 'enum';
  readonly namespace: Namespace;
  tagType: IntType | undefined;
  fields: EnumField[] | undefined;
  exhaustive: boolean;
  /** The union that `union(enum)` declares this enum for. */
  readonly unionOf?: UnionType;
}

export interface UnionField {
  name: string;
  type: Type;
}

export interface UnionType {
  readonly kind: 'union';
  readonly namespace: Namespace;
  readonly layout: 'auto' | 'extern' | 'packed';
  /** The tag's enum of a tagged union. */
  tagType: EnumType | undefined;
  fields: UnionField[] | undefined;
}

export interface FnType {
  readonly kind: 'fn';
  readonly params: readonly Type[];
  readonly returnType: Type;
  /** `c` for `callconv(.c)`, which `export` also gives; undefined for Zig's own convention. */
  readonly callingConvention?: 'c';
}

/** A container-level declaration, which the compiler analyzes when the program first refers to it. */
export type Decl =
  | {
      kind: 'const' | 'var';
      syntax: VariableDeclaration;
      namespace: Namespace;
      state: 'unresolved' | 'resolving' | 'resolved';
      type?: Type;
      /** A constant's value, which is known at compile time. */
      value?: Value;
      /** A variable's storage, which lives as long as the program runs. */
      cell?: { slots: Value[] };
      alignment?: number;
    }
  | { kind: 'fn'; syntax: FunctionDeclaration; namespace: Namespace }
  | {
      kind: 'native';
      name: string;
      resolve: () => { type: Type; value: Value; unavailable?: string };
      /** Resolves a native name for a declaration that the compiler analyzes, such as a type the library declares in Zig. */
      resolveWith?: (sema: never, span: Span) => unknown;
    };

// Simple types --------------------------------------------------------------------------------------------------------

function simple(kind: SimpleType['kind']): SimpleType {
  return { kind };
}

export const COMPTIME_INT = simple('comptime_int');
export const COMPTIME_FLOAT = simple('comptime_float');
export const BOOL = simple('bool');
export const ANYTYPE = simple('anytype');
export const VOID = simple('void');
export const NORETURN = simple('noreturn');
export const TYPE = simple('type');
export const NULL_TYPE = simple('null');
export const UNDEFINED_TYPE = simple('undefined');
export const ENUM_LITERAL = simple('enum_literal');
export const ANYOPAQUE = simple('anyopaque');

const intTypes = new Map<string, IntType>();

export function intType(signed: boolean, bits: number, name = `${signed ? 'i' : 'u'}${bits}`): IntType {
  let type = intTypes.get(name);
  if (!type) {
    type = { kind: 'int', signed, bits, name };
    intTypes.set(name, type);
  }
  return type;
}

export const U8 = intType(false, 8);
export const U16 = intType(false, 16);
export const U21 = intType(false, 21);
export const U32 = intType(false, 32);
export const U64 = intType(false, 64);
export const I32 = intType(true, 32);
export const I64 = intType(true, 64);
export const USIZE = intType(false, 64, 'usize');
export const ISIZE = intType(true, 64, 'isize');
export const U0 = intType(false, 0);

const floatTypes = new Map<number, FloatType>();

export function floatType(bits: FloatType['bits']): FloatType {
  let type = floatTypes.get(bits);
  if (!type) {
    type = { kind: 'float', bits };
    floatTypes.set(bits, type);
  }
  return type;
}

export const F16 = floatType(16);
export const F32 = floatType(32);
export const F64 = floatType(64);
export const F80 = floatType(80);
export const F128 = floatType(128);

/** The C integer types, as on the reference toolchain's platform (64-bit macOS). */
const C_INTEGERS = new Map<string, [boolean, number]>([
  ['c_char', [true, 8]],
  ['c_short', [true, 16]],
  ['c_ushort', [false, 16]],
  ['c_int', [true, 32]],
  ['c_uint', [false, 32]],
  ['c_long', [true, 64]],
  ['c_ulong', [false, 64]],
  ['c_longlong', [true, 64]],
  ['c_ulonglong', [false, 64]],
]);

/** The type a primitive name such as `i32`, `usize`, or `bool` denotes, or undefined for other names. */
// code-gauge-allow functionNcss -- One case per kind of syntax node, type, or format specifier, as Zig defines them.
export function primitiveType(name: string): Type | undefined {
  const int = /^([iu])(0|[1-9]\d*)$/.exec(name);
  if (int) {
    const bits = Number(int[2]);
    return bits <= 65_535 ? intType(int[1] === 'i', bits) : undefined;
  }
  switch (name) {
    case 'usize': {
      return USIZE;
    }
    case 'isize': {
      return ISIZE;
    }
    case 'f16': {
      return F16;
    }
    case 'f32': {
      return F32;
    }
    case 'f64': {
      return F64;
    }
    case 'f80': {
      return F80;
    }
    case 'f128': {
      return F128;
    }
    case 'c_longdouble': {
      return F64;
    }
    case 'bool': {
      return BOOL;
    }
    case 'void': {
      return VOID;
    }
    case 'noreturn': {
      return NORETURN;
    }
    case 'type': {
      return TYPE;
    }
    case 'anyerror': {
      return ANYERROR;
    }
    case 'anyopaque': {
      return ANYOPAQUE;
    }
    case 'comptime_int': {
      return COMPTIME_INT;
    }
    case 'comptime_float': {
      return COMPTIME_FLOAT;
    }
    default: {
      const c = C_INTEGERS.get(name);
      return c ? intType(c[0], c[1], name) : undefined;
    }
  }
}

export const ANYERROR: ErrorSetType = { kind: 'error_set', names: undefined };

// Composite types -----------------------------------------------------------------------------------------------------

let nextTypeId = 1;
const typeIds = new WeakMap<object, number>();

/** A number that identifies a type, for interning the types built from it. */
export function typeId(type: Type): number {
  let id = typeIds.get(type);
  if (id === undefined) {
    id = nextTypeId++;
    typeIds.set(type, id);
  }
  return id;
}

const interned = new WeakValueMap<string, Type>();
const sentinelValues = new WeakValueMap<string, Sentinel>();

function intern<T extends Type>(key: string, create: () => T): T {
  let type = interned.get(key) as T | undefined;
  if (!type) {
    type = create();
    interned.set(key, type);
  }
  return type;
}

export function sameSentinel(left: Sentinel | undefined, right: Sentinel | undefined): boolean {
  return sentinelKey(left) === sentinelKey(right);
}

function sentinelKey(sentinel: Sentinel | undefined): string {
  return sentinel === undefined ? '' : `:${scalarValueKey(sentinel.value)}`;
}

export function arrayOf(length: number | bigint, child: Type, sentinel?: Value | Sentinel): ArrayType {
  const canonical = canonicalSentinel(child, sentinel);
  return intern(`array ${length} ${typeId(child)}${sentinelKey(canonical)}`, () => ({
    kind: 'array',
    length: BigInt(length),
    child,
    sentinel: canonical,
  }));
}

/** `@Vector(length, child)`, which holds its elements as an array does. */
export function vectorOf(length: number | bigint, child: Type): ArrayType {
  return intern(`vector ${length} ${typeId(child)}`, () => ({
    kind: 'array',
    length: BigInt(length),
    child,
    isVector: true,
  }));
}

export function isVectorType(type: Type): type is ArrayType {
  return type.kind === 'array' && type.isVector === true;
}

export function pointerTo(child: Type, isConst: boolean): PointerType {
  return pointerOf('one', child, { isConst });
}

export function sliceOf(child: Type, isConst: boolean, sentinel?: Value | Sentinel): PointerType {
  return pointerOf('slice', child, { isConst, sentinel });
}

/** A pointer type; pass `alignment` only when it differs from the child type's own, as Zig drops it otherwise. */
export function pointerOf(size: PointerType['size'], child: Type, attributes: PointerAttributes): PointerType {
  const canonical = size === 'one' ? undefined : canonicalSentinel(child, attributes.sentinel);
  const isVolatile = attributes.isVolatile === true;
  const allowZero = attributes.allowZero === true && size !== 'c';
  const { alignment } = attributes;
  const key = `pointer ${size} ${typeId(child)} ${attributes.isConst}${sentinelKey(canonical)} ${isVolatile} ${allowZero} ${alignment ?? ''}`;
  return intern(key, () => ({
    kind: 'pointer',
    size,
    child,
    isConst: attributes.isConst,
    ...(canonical === undefined ? {} : { sentinel: canonical }),
    ...(isVolatile ? { isVolatile } : {}),
    ...(allowZero ? { allowZero } : {}),
    ...(alignment === undefined ? {} : { alignment }),
  }));
}

/** The same kind of pointer with other attributes, such as `@constCast`'s result. */
export function withPointerAttributes(type: PointerType, changes: Partial<PointerAttributes>): PointerType {
  return pointerOf(type.size, type.child, {
    isConst: type.isConst,
    isVolatile: type.isVolatile,
    allowZero: type.allowZero,
    alignment: type.alignment,
    sentinel: type.sentinel,
    ...changes,
  });
}

function canonicalSentinel(type: Type, sentinel: Value | Sentinel): Sentinel | undefined {
  if (sentinel === undefined) return;
  const value = sentinel instanceof Sentinel ? sentinel.value : sentinel;
  const key = `${typeId(type)} ${scalarValueKey(value)}`;
  const existing = sentinelValues.get(key);
  if (existing) return existing;
  const canonical = new Sentinel(value);
  sentinelValues.set(key, canonical);
  return canonical;
}

export function optionalOf(child: Type): OptionalType {
  return intern(`optional ${typeId(child)}`, () => ({ kind: 'optional', child }));
}

export function errorUnionOf(errorSet: ErrorSetType, payload: Type): ErrorUnionType {
  return intern(`error_union ${typeId(errorSet)} ${typeId(payload)}`, () => ({
    kind: 'error_union',
    errorSet,
    payload,
  }));
}

export function fnType(params: readonly Type[], returnType: Type, callingConvention?: 'c'): FnType {
  const key = `fn ${params.map((param) => typeId(param)).join(',')} ${typeId(returnType)} ${callingConvention ?? ''}`;
  return intern(key, () => ({
    kind: 'fn',
    params,
    returnType,
    ...(callingConvention ? { callingConvention } : {}),
  }));
}

/** An error set of the given names; sets of the same names are the same type, as Zig resolves them alike. */
export function errorSetOf(names: Iterable<string>): ErrorSetType {
  const sorted = [...new Set(names)].toSorted();
  return intern(`error_set ${JSON.stringify(sorted)}`, () => ({
    kind: 'error_set',
    names: new Set(sorted),
  }));
}

export const STRING_LITERAL_CHILD = U8;
export const CONST_U8_SLICE = sliceOf(U8, true);

// Queries -------------------------------------------------------------------------------------------------------------

export function isInt(type: Type): type is IntType {
  return type.kind === 'int';
}

export function isNumeric(type: Type): boolean {
  return type.kind === 'int' || type.kind === 'float' || type.kind === 'comptime_int' || type.kind === 'comptime_float';
}

export function isIntegral(type: Type): boolean {
  return type.kind === 'int' || type.kind === 'comptime_int';
}

export function isFloating(type: Type): boolean {
  return type.kind === 'float' || type.kind === 'comptime_float';
}

export function isScalarType(type: Type): boolean {
  return (
    type.kind === 'int' ||
    type.kind === 'comptime_int' ||
    type.kind === 'float' ||
    type.kind === 'comptime_float' ||
    type.kind === 'bool' ||
    type.kind === 'enum' ||
    type.kind === 'error_set'
  );
}

/** Whether values of a type exist only at compile time. */
// code-gauge-allow duplicateLines -- Comptime classification and by-value cycle detection traverse similar graphs with different leaf and field predicates.
export function isComptimeOnly(type: Type, seen = new Set<Type>()): boolean {
  if (seen.has(type)) return false;
  spendMemory();
  seen.add(type);
  switch (type.kind) {
    case 'comptime_int':
    case 'comptime_float':
    case 'type':
    case 'null':
    case 'undefined':
    case 'enum_literal':
    case 'fn': {
      return true;
    }
    case 'array':
    case 'optional': {
      return isComptimeOnly(type.child, seen);
    }
    case 'error_union': {
      return isComptimeOnly(type.payload, seen);
    }
    case 'union': {
      return (type.fields ?? []).some((field) => isComptimeOnly(field.type, seen));
    }
    case 'struct': {
      return (type.fields ?? []).some((field) => field.comptimeValue === undefined && isComptimeOnly(field.type, seen));
    }
    default: {
      return false;
    }
  }
}

interface IntegerBounds {
  minimum: bigint;
  maximum: bigint;
}

const integerBounds = new WeakValueMap<IntType, IntegerBounds>();

export function minInt(type: IntType): bigint {
  return boundsOf(type).minimum;
}

export function maxInt(type: IntType): bigint {
  return boundsOf(type).maximum;
}

function boundsOf(type: IntType): IntegerBounds {
  let bounds = integerBounds.get(type);
  if (!bounds) {
    const limit = type.bits === 0 ? 0n : 1n << BigInt(type.bits - (type.signed ? 1 : 0));
    bounds = { minimum: type.signed ? -limit : 0n, maximum: type.bits === 0 ? 0n : limit - 1n };
    integerBounds.set(type, bounds);
  }
  return bounds;
}

export function fitsInt(value: bigint, type: IntType): boolean {
  return value >= minInt(type) && value <= maxInt(type);
}

/** Wraps an integer to a type's width, as two's complement arithmetic does. */
export function wrapInt(value: bigint, type: IntType): bigint {
  if (type.bits === 0) return 0n;
  return type.signed ? BigInt.asIntN(type.bits, value) : BigInt.asUintN(type.bits, value);
}

/** The element type that indexing a value of this type gives, through one pointer. */
export function indexableChild(type: Type): Type | undefined {
  if (type.kind === 'array') return type.child;
  if (type.kind === 'pointer') {
    if (type.size !== 'one') return type.child;
    if (type.child.kind === 'array') return type.child.child;
  }
  return undefined;
}

// Names ---------------------------------------------------------------------------------------------------------------

/** The type's name as Zig's `@typeName` writes it. */
// code-gauge-allow functionNcss -- One case per kind of syntax node, type, or format specifier, as Zig defines them.
// code-gauge-allow functionCognitiveComplexity -- One case per kind of syntax node, type, or format specifier, as Zig defines them.
export function typeName(type: Type): string {
  switch (type.kind) {
    case 'int': {
      return type.name;
    }
    case 'float': {
      return `f${type.bits}`;
    }
    case 'array': {
      if (type.isVector) return `@Vector(${type.length}, ${typeName(type.child)})`;
      const sentinel = type.sentinel === undefined ? '' : `:${constantText(type.sentinel.value, type.child, typeName)}`;
      return `[${type.length}${sentinel}]${typeName(type.child)}`;
    }
    case 'pointer': {
      const sentinel = type.sentinel === undefined ? '' : `:${constantText(type.sentinel.value, type.child, typeName)}`;
      const prefix = { one: '*', many: `[*${sentinel}]`, slice: `[${sentinel}]`, c: '[*c]' }[type.size];
      const alignment = type.alignment === undefined ? '' : `align(${type.alignment}) `;
      const qualifiers = `${type.allowZero ? 'allowzero ' : ''}${type.isConst ? 'const ' : ''}${type.isVolatile ? 'volatile ' : ''}`;
      return `${prefix}${alignment}${qualifiers}${typeName(type.child)}`;
    }
    case 'optional': {
      return `?${typeName(type.child)}`;
    }
    case 'error_set': {
      if (type.names === undefined) return 'anyerror';
      if (type.name) return type.name;
      if (type.inferredFrom)
        return `@typeInfo(@typeInfo(@TypeOf(${type.inferredFrom})).@"fn".return_type.?).error_union.error_set`;
      return `error{${[...type.names].join(',')}}`;
    }
    case 'error_union': {
      return `${typeName(type.errorSet)}!${typeName(type.payload)}`;
    }
    case 'struct': {
      if (type.isTuple) {
        if (type.fields?.length === 0) return '@TypeOf(.{})';
        const fields = (type.fields ?? []).map((field) =>
          field.comptimeValue === undefined
            ? typeName(field.type)
            : `comptime ${typeName(field.type)} = ${constantText(field.comptimeValue.value, field.type, typeName)}`
        );
        return `struct { ${fields.join(', ')} }`;
      }
      return type.namespace.name;
    }
    case 'enum':
    case 'union': {
      return type.namespace.name;
    }
    case 'fn': {
      const callingConvention = type.callingConvention ? `callconv(.${type.callingConvention}) ` : '';
      return `fn (${type.params.map((param) => typeName(param)).join(', ')}) ${callingConvention}${typeName(type.returnType)}`;
    }
    case 'enum_literal': {
      return '@EnumLiteral()';
    }
    case 'null': {
      return '@TypeOf(null)';
    }
    case 'undefined': {
      return '@TypeOf(undefined)';
    }
    default: {
      return type.kind;
    }
  }
}
