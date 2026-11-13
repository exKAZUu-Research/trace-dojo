/** The integer types, by rank and then signedness; `long long` has the size of `long`, as on arm64 macOS. */
export type IntName =
  | 'bool'
  | 'char'
  | 'schar'
  | 'uchar'
  | 'short'
  | 'ushort'
  | 'int'
  | 'uint'
  | 'long'
  | 'ulong'
  | 'llong'
  | 'ullong';
export type FloatName = 'float' | 'double' | 'ldouble';

interface Qualified {
  isConst?: boolean;
  isVolatile?: boolean;
}

export type CType =
  | ({ kind: 'void' } & Qualified)
  | ({ kind: 'int'; name: IntName; enumInfo?: EnumInfo } & Qualified)
  | ({ kind: 'float'; name: FloatName } & Qualified)
  | ({ kind: 'pointer'; to: CType } & Qualified)
  /** An array, whose length is undefined while it is incomplete (`int a[]` before its initializer). */
  | ({ kind: 'array'; of: CType; length?: number } & Qualified)
  /** A function type, whose parameters are undefined when declared with `()`. */
  | { kind: 'function'; ret: CType; params?: CType[]; variadic: boolean }
  | ({ kind: 'record'; info: RecordInfo } & Qualified);

export type IntType = Extract<CType, { kind: 'int' }>;
export type FloatType = Extract<CType, { kind: 'float' }>;
export type PointerType = Extract<CType, { kind: 'pointer' }>;
export type ArrayType = Extract<CType, { kind: 'array' }>;
export type FunctionType = Extract<CType, { kind: 'function' }>;
export type RecordType = Extract<CType, { kind: 'record' }>;

export interface Field {
  name?: string;
  type: CType;
  /** The byte offset of the member, or of the storage unit holding a bit-field. */
  offset: number;
  bitOffset?: number;
  bitWidth?: number;
  /** Whether the member is an unnamed struct or union, whose own members are members of this one (C11). */
  isAnonymous?: boolean;
}

let nextRecordId = 0;

/** A struct or union, which stays incomplete until its member list is seen. */
export class RecordInfo {
  readonly id = nextRecordId++;
  fields?: Field[];
  size = 0;
  align = 1;
  /** The opaque Turtle type, which only the interpreter's functions create. */
  isTurtle = false;

  constructor(
    readonly kind: 'struct' | 'union',
    readonly tag: string | undefined
  ) {}

  get isComplete(): boolean {
    return this.fields !== undefined;
  }

  /** A member by name, including the members of unnamed struct and union members, at its offset in this one. */
  field(name: string): Field | undefined {
    for (const member of this.fields ?? []) {
      if (member.name === name) return member;
      if (member.isAnonymous && member.type.kind === 'record') {
        const inner = member.type.info.field(name);
        if (inner) return { ...inner, offset: member.offset + inner.offset };
      }
    }
    return undefined;
  }

  /** The names of the members, including those of unnamed members, to check that no name is declared twice. */
  memberNames(): string[] {
    return (this.fields ?? []).flatMap((member) => {
      if (member.isAnonymous && member.type.kind === 'record') return member.type.info.memberNames();
      return member.name === undefined ? [] : [member.name];
    });
  }
}

export interface EnumInfo {
  tag?: string;
  /** The enumerators in declaration order, which the trace shows by name. */
  constants: Map<string, number>;
  isComplete: boolean;
}

interface IntProperties {
  size: number;
  signed: boolean;
  rank: number;
  min: bigint;
  max: bigint;
}

function range(bits: number, signed: boolean): { min: bigint; max: bigint } {
  return signed
    ? { min: -(1n << BigInt(bits - 1)), max: (1n << BigInt(bits - 1)) - 1n }
    : { min: 0n, max: (1n << BigInt(bits)) - 1n };
}

export const INT_PROPERTIES: Record<IntName, IntProperties> = {
  bool: { size: 1, signed: false, rank: 0, min: 0n, max: 1n },
  char: { size: 1, signed: true, rank: 1, ...range(8, true) },
  schar: { size: 1, signed: true, rank: 1, ...range(8, true) },
  uchar: { size: 1, signed: false, rank: 1, ...range(8, false) },
  short: { size: 2, signed: true, rank: 2, ...range(16, true) },
  ushort: { size: 2, signed: false, rank: 2, ...range(16, false) },
  int: { size: 4, signed: true, rank: 3, ...range(32, true) },
  uint: { size: 4, signed: false, rank: 3, ...range(32, false) },
  long: { size: 8, signed: true, rank: 4, ...range(64, true) },
  ulong: { size: 8, signed: false, rank: 4, ...range(64, false) },
  llong: { size: 8, signed: true, rank: 5, ...range(64, true) },
  ullong: { size: 8, signed: false, rank: 5, ...range(64, false) },
};

export const VOID: CType = { kind: 'void' };
export const BOOL: IntType = { kind: 'int', name: 'bool' };
export const CHAR: IntType = { kind: 'int', name: 'char' };
export const UCHAR: IntType = { kind: 'int', name: 'uchar' };
export const SHORT: IntType = { kind: 'int', name: 'short' };
export const INT: IntType = { kind: 'int', name: 'int' };
export const UINT: IntType = { kind: 'int', name: 'uint' };
export const LONG: IntType = { kind: 'int', name: 'long' };
export const ULONG: IntType = { kind: 'int', name: 'ulong' };
export const LLONG: IntType = { kind: 'int', name: 'llong' };
export const ULLONG: IntType = { kind: 'int', name: 'ullong' };
export const FLOAT: FloatType = { kind: 'float', name: 'float' };
export const DOUBLE: FloatType = { kind: 'float', name: 'double' };
export const LDOUBLE: FloatType = { kind: 'float', name: 'ldouble' };
export const SIZE_T = ULONG;
export const PTRDIFF_T = LONG;

export function pointerTo(type: CType): PointerType {
  return { kind: 'pointer', to: type };
}

export const VOID_POINTER = pointerTo(VOID);
export const CHAR_POINTER = pointerTo(CHAR);
export const CONST_CHAR_POINTER = pointerTo({ ...CHAR, isConst: true });

export function isInteger(type: CType): type is IntType {
  return type.kind === 'int';
}

export function isArithmetic(type: CType): type is IntType | FloatType {
  return type.kind === 'int' || type.kind === 'float';
}

export function isScalar(type: CType): boolean {
  return type.kind === 'int' || type.kind === 'float' || type.kind === 'pointer';
}

/** Whether values of the type are bigints: the 64-bit integers. */
export function isWide(type: CType): boolean {
  return type.kind === 'int' && INT_PROPERTIES[type.name].size === 8;
}

export function isSigned(type: IntType): boolean {
  return INT_PROPERTIES[type.name].signed;
}

export function isCharType(type: CType): boolean {
  return type.kind === 'int' && (type.name === 'char' || type.name === 'schar' || type.name === 'uchar');
}

export function isComplete(type: CType): boolean {
  switch (type.kind) {
    case 'void':
    case 'function': {
      return false;
    }
    case 'array': {
      return type.length !== undefined && isComplete(type.of);
    }
    case 'record': {
      return type.info.isComplete;
    }
    case 'int': {
      return type.enumInfo?.isComplete ?? true;
    }
    default: {
      return true;
    }
  }
}

export function sizeOf(type: CType): number {
  switch (type.kind) {
    case 'int': {
      return INT_PROPERTIES[type.name].size;
    }
    case 'float': {
      return type.name === 'float' ? 4 : 8;
    }
    case 'pointer': {
      return 8;
    }
    case 'array': {
      return (type.length ?? 0) * sizeOf(type.of);
    }
    case 'record': {
      return type.info.size;
    }
    default: {
      // clang gives void and functions the size 1 as an extension, which pointer arithmetic on void * relies on.
      return 1;
    }
  }
}

export function alignOf(type: CType): number {
  switch (type.kind) {
    case 'array': {
      return alignOf(type.of);
    }
    case 'record': {
      return type.info.align;
    }
    default: {
      return sizeOf(type);
    }
  }
}

export function unqualified<T extends CType>(type: T): T {
  if (!('isConst' in type) && !('isVolatile' in type)) return type;
  const { isConst: _isConst, isVolatile: _isVolatile, ...rest } = type as T & Qualified;
  return rest as T;
}

export function withQualifiers<T extends CType>(type: T, isConst: boolean, isVolatile: boolean): T {
  if (type.kind === 'function') return type;
  // Qualifying an array type qualifies its elements.
  if (type.kind === 'array') return { ...type, of: withQualifiers(type.of, isConst, isVolatile) } as T;
  if (!isConst && !isVolatile) return type;
  return { ...type, ...(isConst ? { isConst: true } : {}), ...(isVolatile ? { isVolatile: true } : {}) };
}

export function isConstQualified(type: CType): boolean {
  if (type.kind === 'array') return isConstQualified(type.of);
  return 'isConst' in type && type.isConst === true;
}

/** Whether a struct or union has a const member, which makes it unassignable as a whole. */
export function hasConstMember(type: CType): boolean {
  if (type.kind !== 'record') return false;
  return (type.info.fields ?? []).some((field) => isConstQualified(field.type) || hasConstMember(field.type));
}

/** The type an integer promotes to: `int` for every type narrower than `int`, as `int` holds all their values. */
export function promote(type: IntType): IntType {
  const properties = INT_PROPERTIES[type.name];
  if (properties.rank < 3) return INT;
  return unqualified({ kind: 'int', name: type.name });
}

/** C's usual arithmetic conversions, which give two operands one common type. */
export function commonType(left: IntType | FloatType, right: IntType | FloatType): IntType | FloatType {
  if (left.kind === 'float' || right.kind === 'float') {
    if (left.name === 'ldouble' || right.name === 'ldouble') return LDOUBLE;
    if (left.name === 'double' || right.name === 'double') return DOUBLE;
    return FLOAT;
  }
  const a = promote(left);
  const b = promote(right);
  if (a.name === b.name) return a;
  const pa = INT_PROPERTIES[a.name];
  const pb = INT_PROPERTIES[b.name];
  if (pa.signed === pb.signed) return pa.rank >= pb.rank ? a : b;
  const [unsigned, signed] = pa.signed ? [b, a] : [a, b];
  const pu = INT_PROPERTIES[unsigned.name];
  const ps = INT_PROPERTIES[signed.name];
  if (pu.rank >= ps.rank) return unsigned;
  if (ps.size > pu.size) return signed;
  return { kind: 'int', name: unsignedOf(signed.name) };
}

function unsignedOf(name: IntName): IntName {
  const map: Partial<Record<IntName, IntName>> = {
    char: 'uchar',
    schar: 'uchar',
    short: 'ushort',
    int: 'uint',
    long: 'ulong',
    llong: 'ullong',
  };
  return map[name] ?? name;
}

/** Whether two types are compatible, as C requires of redeclarations and of the targets of assigned pointers. */
export function compatible(a: CType, b: CType, ignoreQualifiers = false): boolean {
  const qualifiersDiffer =
    isConstQualified(a) !== isConstQualified(b) || qualifierOf(a, 'isVolatile') !== qualifierOf(b, 'isVolatile');
  if (!ignoreQualifiers && qualifiersDiffer && a.kind !== 'array' && b.kind !== 'array') return false;
  if (a.kind === 'int' && b.kind === 'int') {
    // An enum type is compatible with its underlying integer type.
    if (a.enumInfo && b.enumInfo) return a.enumInfo === b.enumInfo;
    return a.name === b.name;
  }
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'void': {
      return true;
    }
    case 'float': {
      return a.name === (b as FloatType).name;
    }
    case 'pointer': {
      return compatible(a.to, (b as PointerType).to);
    }
    case 'array': {
      const other = b as ArrayType;
      if (a.length !== undefined && other.length !== undefined && a.length !== other.length) return false;
      return compatible(a.of, other.of, ignoreQualifiers);
    }
    case 'record': {
      return a.info === (b as RecordType).info;
    }
    case 'function': {
      const other = b as FunctionType;
      if (!compatible(a.ret, other.ret)) return false;
      if (!a.params || !other.params) return true;
      if (a.variadic !== other.variadic || a.params.length !== other.params.length) return false;
      return a.params.every((param, index) =>
        compatible(unqualified(param), unqualified((other.params as CType[])[index]))
      );
    }
  }
  return false;
}

function qualifierOf(type: CType, key: 'isVolatile'): boolean {
  return key in type && (type as Qualified)[key] === true;
}

/** The composite of two compatible types, which keeps what each knows (an array's length, a prototype). */
export function composite(a: CType, b: CType): CType {
  if (a.kind === 'array' && b.kind === 'array')
    return { ...a, length: a.length ?? b.length, of: composite(a.of, b.of) };
  if (a.kind === 'function' && b.kind === 'function') {
    if (!a.params) return b;
    return a;
  }
  return a;
}

/** A type as clang spells it in messages, such as `int *`, `char[4]`, or `struct point`. */
export function typeName(type: CType, inner = ''): string {
  const qualifiers = qualifierText(type);
  switch (type.kind) {
    case 'void':
    case 'int':
    case 'float':
    case 'record': {
      const base = `${qualifiers}${baseName(type)}`;
      return inner ? `${base} ${inner.trimStart()}` : base;
    }
    case 'pointer': {
      const target = type.to;
      const star = `*${qualifiers.trimEnd() ? ` ${qualifiers.trimEnd()}` : ''}${inner}`;
      if (target.kind === 'array' || target.kind === 'function') return typeName(target, `(${star})`);
      return typeName(target, star);
    }
    case 'array': {
      return typeName(type.of, `${inner}[${type.length ?? ''}]`);
    }
    case 'function': {
      const params = type.params
        ? [...type.params.map((param) => typeName(param)), ...(type.variadic ? ['...'] : [])].join(', ') || 'void'
        : '';
      return typeName(type.ret, `${inner}(${params})`);
    }
  }
}

function qualifierText(type: CType): string {
  return `${'isConst' in type && type.isConst ? 'const ' : ''}${'isVolatile' in type && type.isVolatile ? 'volatile ' : ''}`;
}

const INT_NAMES: Record<IntName, string> = {
  bool: '_Bool',
  char: 'char',
  schar: 'signed char',
  uchar: 'unsigned char',
  short: 'short',
  ushort: 'unsigned short',
  int: 'int',
  uint: 'unsigned int',
  long: 'long',
  ulong: 'unsigned long',
  llong: 'long long',
  ullong: 'unsigned long long',
};

function baseName(type: CType): string {
  switch (type.kind) {
    case 'int': {
      if (type.enumInfo) return `enum ${type.enumInfo.tag ?? '(unnamed)'}`;
      return INT_NAMES[type.name];
    }
    case 'float': {
      return type.name === 'ldouble' ? 'long double' : type.name;
    }
    case 'record': {
      if (type.info.isTurtle) return 'Turtle';
      return `${type.info.kind} ${type.info.tag ?? '(unnamed)'}`;
    }
    default: {
      return 'void';
    }
  }
}

const SOLE_BUILTIN_WORDS: [string, CType][] = [
  ['void', VOID],
  ['_Bool', BOOL],
  ['float', FLOAT],
];

/** The integer type a set of builtin type words names, such as `unsigned long int`. */
export function builtinType(words: readonly string[]): CType | undefined {
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const count = (word: string): number => counts.get(word) ?? 0;
  const known = new Set(['void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', '_Bool']);
  if ([...counts.keys()].some((word) => !known.has(word))) return undefined;
  if (count('signed') + count('unsigned') > 1 || count('short') > 1 || count('int') > 1 || count('long') > 2)
    return undefined;
  const sign = count('signed') + count('unsigned');
  const others = words.length - sign;
  for (const [word, type] of SOLE_BUILTIN_WORDS) {
    if (count(word) === 1) return others === 1 && sign === 0 ? type : undefined;
  }
  if (count('double') === 1) {
    if (sign > 0 || !hasOnly(counts, 'double', 'long') || count('long') > 1) return undefined;
    return count('long') === 1 ? LDOUBLE : DOUBLE;
  }
  return integerBuiltinType(counts, others, words.length);
}

function integerBuiltinType(counts: ReadonlyMap<string, number>, others: number, wordCount: number): CType | undefined {
  const count = (word: string): number => counts.get(word) ?? 0;
  const isUnsigned = count('unsigned') === 1;
  if (count('char') === 1) {
    if (others !== 1) return undefined;
    if (count('signed') === 1) return { kind: 'int', name: 'schar' };
    return isUnsigned ? UCHAR : CHAR;
  }
  if (count('short') === 1) {
    if (!hasOnly(counts, 'short', 'int', 'signed', 'unsigned')) return undefined;
    return isUnsigned ? { kind: 'int', name: 'ushort' } : SHORT;
  }
  if (count('long') === 2) return isUnsigned ? ULLONG : LLONG;
  if (count('long') === 1) return isUnsigned ? ULONG : LONG;
  if (wordCount === 0) return undefined;
  return isUnsigned ? UINT : INT;
}

function hasOnly(counts: ReadonlyMap<string, number>, ...allowed: string[]): boolean {
  return [...counts.keys()].every((word) => allowed.includes(word));
}

/** Lays out the members of a struct or union as clang does on arm64. */
export function layoutRecord(
  info: RecordInfo,
  members: { name?: string; type: CType; bitWidth?: number; align?: number; isAnonymous?: boolean }[]
): void {
  const fields: Field[] = [];
  let offset = 0;
  let bitPosition = 0;
  let align = 1;
  let size = 0;
  for (const member of members) {
    const memberSize = sizeOf(member.type);
    const memberAlign = Math.max(alignOf(member.type), member.align ?? 0);
    if (member.bitWidth !== undefined) {
      if (member.bitWidth === 0) {
        // A zero-width bit-field ends the current storage unit.
        bitPosition = Math.ceil(bitPosition / (memberSize * 8)) * memberSize * 8;
        continue;
      }
      if (info.kind === 'union') {
        fields.push({ name: member.name, type: member.type, offset: 0, bitOffset: 0, bitWidth: member.bitWidth });
        size = Math.max(size, memberSize);
        align = Math.max(align, memberAlign);
        continue;
      }
      const unitBits = memberSize * 8;
      let start = bitPosition;
      // A bit-field does not straddle a boundary of its own type's alignment.
      if (Math.floor(start / unitBits) !== Math.floor((start + member.bitWidth - 1) / unitBits)) {
        start = Math.ceil(start / unitBits) * unitBits;
      }
      const unitOffset = Math.floor(start / unitBits) * memberSize;
      if (member.name !== undefined) {
        fields.push({
          name: member.name,
          type: member.type,
          offset: unitOffset,
          bitOffset: start - unitOffset * 8,
          bitWidth: member.bitWidth,
        });
        align = Math.max(align, memberAlign);
      }
      bitPosition = start + member.bitWidth;
      offset = Math.ceil(bitPosition / 8);
      size = Math.max(size, offset);
      continue;
    }
    const anonymous = member.isAnonymous ? { isAnonymous: true } : {};
    if (info.kind === 'union') {
      fields.push({ name: member.name, type: member.type, offset: 0, ...anonymous });
      size = Math.max(size, memberSize);
    } else {
      offset = Math.max(offset, Math.ceil(bitPosition / 8));
      offset = Math.ceil(offset / memberAlign) * memberAlign;
      fields.push({ name: member.name, type: member.type, offset, ...anonymous });
      offset += memberSize;
      bitPosition = offset * 8;
      size = offset;
    }
    align = Math.max(align, memberAlign);
  }
  info.fields = fields;
  info.align = align;
  info.size = Math.ceil(size / align) * align;
}

/** Whether a type is an array of a character type, which a string literal may initialize. */
export function isCharArray(type: CType): type is ArrayType {
  return type.kind === 'array' && isCharType(type.of);
}

export function isVoidPointer(type: CType): boolean {
  return type.kind === 'pointer' && type.to.kind === 'void';
}

export function isNullPointerConstantType(type: CType): boolean {
  return type.kind === 'int' || isVoidPointer(type);
}

/** Arrays decay to pointers to their first elements and functions to pointers to themselves, as rvalues. */
export function decay(type: CType): CType {
  if (type.kind === 'array') return pointerTo(type.of);
  if (type.kind === 'function') return pointerTo(type);
  return unqualified(type);
}
