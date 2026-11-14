// code-gauge-allow-file fileNcss 456 -- Visits the Go type shapes for canonical identity and diagnostic spelling.
import type { Span } from './ast';
import type { CalleeSummary } from './entities';
import type { StackBuffers } from './runtime';

export type BasicKind =
  | 'bool'
  | 'string'
  | IntegerKind
  | 'float32'
  | 'float64'
  | 'complex64'
  | 'complex128'
  | 'untypedBool'
  | 'untypedInt'
  | 'untypedRune'
  | 'untypedFloat'
  | 'untypedComplex'
  | 'untypedString'
  | 'untypedNil'
  | 'invalid';

export type IntegerKind =
  | 'int'
  | 'int8'
  | 'int16'
  | 'int32'
  | 'int64'
  | 'uint'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'uint64'
  | 'uintptr';

export interface BasicType {
  kind: 'basic';
  basic: BasicKind;
  /** The name Go's compiler uses in messages, which differs for the aliases `byte` and `rune`. */
  name: string;
}

export interface Field {
  name: string;
  type: Type;
  embedded: boolean;
  /** The field's tag, which encoding/json reads and which is part of the struct type's identity. */
  tag?: string;
}

export interface StructType {
  kind: 'struct';
  fields: Field[];
}

export interface PointerType {
  kind: 'pointer';
  element: Type;
}

export interface SliceType {
  kind: 'slice';
  element: Type;
}

export interface ArrayType {
  kind: 'array';
  element: Type;
  length: number;
}

export interface MapType {
  kind: 'map';
  key: Type;
  value: Type;
}

/** A channel type: `chan T`, the send-only `chan<- T`, or the receive-only `<-chan T`. */
export interface ChanType {
  kind: 'chan';
  dir: 'both' | 'send' | 'receive';
  element: Type;
}

export interface FuncType {
  kind: 'func';
  params: Type[];
  results: Type[];
  /** Whether the last parameter takes the rest of the arguments, as a slice of its element type. */
  variadic: boolean;
}

export interface InterfaceMethod {
  name: string;
  type: FuncType;
}

/** The types a constraint allows, beyond its methods: `comparable`, or a union of terms such as `~int | ~string`. */
export interface TypeSet {
  comparable?: boolean;
  terms?: { tilde: boolean; type: Type }[];
}

export interface InterfaceType {
  kind: 'interface';
  /** Sorted by name, as Go lists them. */
  methods: InterfaceMethod[];
  typeSet?: TypeSet;
}

/** The library's named interfaces, such as `cmp.Ordered`, which diagnostics name as Go does. */
export const CONSTRAINT_NAMES = new WeakMap<InterfaceType, NamedType>();

export interface TupleType {
  kind: 'tuple';
  types: Type[];
}

export interface TypeParamType {
  kind: 'typeParam';
  name: string;
  constraint: InterfaceType;
  /** The named type the constraint was written as, which diagnostics name as Go does. */
  constraintName?: NamedType;
  id: number;
}

/** A method of a named type, which the compiler links to its code. */
export interface Method {
  name: string;
  pointerReceiver: boolean;
  type: FuncType;
  /** The function that runs the method, receiving the receiver first. */
  code?: MethodCode;
  span?: Span;
  /** The method's own type parameters, which Go 1.27 allows; such a method satisfies no interface. */
  typeParams?: TypeParamType[];
  /** The code of the method for its own type arguments, for a method with type parameters. */
  instantiate?: (args: Type[]) => MethodCode;
}

/** The runtime half of a method, filled in once the method's body compiles. */
export interface MethodCode {
  call?: (
    receiver: unknown,
    args: unknown[],
    callRow?: number,
    deferredFor?: unknown,
    stackBuffers?: StackBuffers
  ) => unknown;
  /** What calls learn from the body of a method the program declares. */
  summary?: CalleeSummary;
  /** Runs the method as `call` does, yielding when its goroutine blocks; absent when it never blocks. */
  resume?: (
    receiver: unknown,
    args: unknown[],
    callRow?: number,
    deferredFor?: unknown,
    stackBuffers?: StackBuffers
  ) => Generator<{ reason: string }, unknown, unknown>;
}

export interface NamedType {
  kind: 'named';
  name: string;
  /** The package path, or '' for predeclared types such as `error`. */
  pkg: string;
  underlying: Type;
  methods: Method[];
  typeArgs?: Type[];
  /** The generic type this one instantiates. */
  origin?: NamedType;
  typeParams?: TypeParamType[];
  span?: Span;
  /** Methods of a library type that this environment does not provide, which are rejected rather than undefined. */
  unsupported?: ReadonlySet<string>;
  /** Instantiates a generic library type, which the program's generic code may instantiate with its own types. */
  instantiateLibrary?: (args: Type[]) => NamedType;
}

export type Type =
  | BasicType
  | NamedType
  | PointerType
  | SliceType
  | ArrayType
  | MapType
  | ChanType
  | StructType
  | FuncType
  | InterfaceType
  | TupleType
  | TypeParamType;

function basic(kind: BasicKind, name: string = kind): BasicType {
  return { kind: 'basic', basic: kind, name };
}

export const BASIC = {
  bool: basic('bool'),
  string: basic('string'),
  int: basic('int'),
  int8: basic('int8'),
  int16: basic('int16'),
  int32: basic('int32'),
  int64: basic('int64'),
  uint: basic('uint'),
  uint8: basic('uint8'),
  uint16: basic('uint16'),
  uint32: basic('uint32'),
  uint64: basic('uint64'),
  uintptr: basic('uintptr'),
  float32: basic('float32'),
  float64: basic('float64'),
  complex64: basic('complex64'),
  complex128: basic('complex128'),
  untypedBool: basic('untypedBool', 'untyped bool'),
  untypedInt: basic('untypedInt', 'untyped int'),
  untypedRune: basic('untypedRune', 'untyped rune'),
  untypedFloat: basic('untypedFloat', 'untyped float'),
  untypedComplex: basic('untypedComplex', 'untyped complex'),
  untypedString: basic('untypedString', 'untyped string'),
  untypedNil: basic('untypedNil', 'untyped nil'),
  invalid: basic('invalid', 'invalid type'),
} as const;

/** The type of operands that are not values: builtins, packages, methods, and calls without results. */
export const NO_VALUE: BasicType = { kind: 'basic', basic: 'invalid', name: 'no value' };

export const BYTE = BASIC.uint8;
export const RUNE = BASIC.int32;

export const EMPTY_INTERFACE: InterfaceType = { kind: 'interface', methods: [] };
export const COMPARABLE: InterfaceType = { kind: 'interface', methods: [], typeSet: { comparable: true } };

export const ERROR_TYPE: NamedType = {
  kind: 'named',
  name: 'error',
  pkg: '',
  underlying: {
    kind: 'interface',
    methods: [{ name: 'Error', type: { kind: 'func', params: [], results: [BASIC.string], variadic: false } }],
  },
  methods: [],
};

/** `any`, an alias of the empty interface, which is identical to `interface{}`. */
export const ANY: InterfaceType = EMPTY_INTERFACE;

export function funcType(params: Type[], results: Type[], variadic = false): FuncType {
  return { kind: 'func', params, results, variadic };
}

export function pointerTo(element: Type): PointerType {
  return { kind: 'pointer', element };
}

export function sliceOf(element: Type): SliceType {
  return { kind: 'slice', element };
}

/** The type that a named type, an alias, or a type parameter stands for structurally. */
export function underlying(type: Type): Type {
  if (type.kind === 'named') return type.underlying;
  return type;
}

/**
 * The single underlying type of a type parameter's type set, which the operations on its values follow (the core type
 * of the specification), or the underlying type of any other type.
 */
export function coreType(type: Type): Type | undefined {
  if (type.kind !== 'typeParam') return underlying(type);
  const terms = type.constraint.typeSet?.terms;
  if (!terms || terms.length === 0) return;
  const first = underlying(terms[0].type);
  return terms.every((term) => identical(underlying(term.type), first)) ? first : undefined;
}

export function isBasic(type: Type, ...kinds: BasicKind[]): boolean {
  const under = underlying(type);
  return under.kind === 'basic' && kinds.includes(under.basic);
}

const INTEGER_KINDS = new Set<BasicKind>([
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uintptr',
  'untypedInt',
  'untypedRune',
]);
const UNSIGNED_KINDS = new Set<BasicKind>(['uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr']);
const FLOAT_KINDS = new Set<BasicKind>(['float32', 'float64', 'untypedFloat']);
const COMPLEX_KINDS = new Set<BasicKind>(['complex64', 'complex128', 'untypedComplex']);

/** Whether every type a type parameter allows satisfies the predicate, or the type itself does. */
function allTerms(type: Type, predicate: (basicKind: BasicKind) => boolean): boolean {
  if (type.kind === 'typeParam') {
    const terms = type.constraint.typeSet?.terms;
    return terms !== undefined && terms.length > 0 && terms.every((term) => allTerms(term.type, predicate));
  }
  const under = underlying(type);
  return under.kind === 'basic' && predicate(under.basic);
}

export const isInteger = (type: Type): boolean => allTerms(type, (kind) => INTEGER_KINDS.has(kind));
export const isUnsigned = (type: Type): boolean => allTerms(type, (kind) => UNSIGNED_KINDS.has(kind));
export const isFloat = (type: Type): boolean => allTerms(type, (kind) => FLOAT_KINDS.has(kind));
export const isComplex = (type: Type): boolean => allTerms(type, (kind) => COMPLEX_KINDS.has(kind));
export const isNumeric = (type: Type): boolean =>
  allTerms(type, (kind) => INTEGER_KINDS.has(kind) || FLOAT_KINDS.has(kind) || COMPLEX_KINDS.has(kind));
export const isString = (type: Type): boolean =>
  allTerms(type, (kind) => kind === 'string' || kind === 'untypedString');
export const isBoolean = (type: Type): boolean => allTerms(type, (kind) => kind === 'bool' || kind === 'untypedBool');
export const isOrdered = (type: Type): boolean =>
  allTerms(
    type,
    (kind) => INTEGER_KINDS.has(kind) || FLOAT_KINDS.has(kind) || kind === 'string' || kind === 'untypedString'
  );

export function isUntyped(type: Type): boolean {
  return type.kind === 'basic' && type.basic.startsWith('untyped');
}

export function isInterface(type: Type): boolean {
  return type.kind !== 'typeParam' && underlying(type).kind === 'interface';
}

/** The type an untyped constant takes where no other type is required. */
export function defaultType(type: Type): Type {
  if (type.kind !== 'basic') return type;
  switch (type.basic) {
    case 'untypedBool': {
      return BASIC.bool;
    }
    case 'untypedInt': {
      return BASIC.int;
    }
    case 'untypedRune': {
      return RUNE;
    }
    case 'untypedFloat': {
      return BASIC.float64;
    }
    case 'untypedComplex': {
      return BASIC.complex128;
    }
    case 'untypedString': {
      return BASIC.string;
    }
    default: {
      return type;
    }
  }
}

/** The bit size and signedness of an integer kind, as `int` and `uint` are 64-bit here as on Go's usual platforms. */
export function integerBits(kind: BasicKind): { bits: number; signed: boolean } {
  switch (kind) {
    case 'int8': {
      return { bits: 8, signed: true };
    }
    case 'int16': {
      return { bits: 16, signed: true };
    }
    case 'int32':
    case 'untypedRune': {
      return { bits: 32, signed: true };
    }
    case 'uint8': {
      return { bits: 8, signed: false };
    }
    case 'uint16': {
      return { bits: 16, signed: false };
    }
    case 'uint32': {
      return { bits: 32, signed: false };
    }
    case 'uint':
    case 'uint64':
    case 'uintptr': {
      return { bits: 64, signed: false };
    }
    default: {
      return { bits: 64, signed: true };
    }
  }
}

// Identity --------------------------------------------------------------------------------------------------------------

// code-gauge-allow functionNcss 40 -- Visits the Go type shapes for canonical identity and diagnostic spelling.
export function identical(a: Type, b: Type, ignoreTags = false): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'basic': {
      return a.basic === (b as BasicType).basic;
    }
    case 'named': {
      const other = b as NamedType;
      if (!a.origin || a.origin !== other.origin) return false;
      return (a.typeArgs ?? []).every((arg, index) => identical(arg, (other.typeArgs ?? [])[index]));
    }
    case 'pointer':
    case 'slice': {
      return identical(a.element, (b as PointerType | SliceType).element, ignoreTags);
    }
    case 'array': {
      const other = b as ArrayType;
      return a.length === other.length && identical(a.element, other.element, ignoreTags);
    }
    case 'map': {
      const other = b as MapType;
      return identical(a.key, other.key, ignoreTags) && identical(a.value, other.value, ignoreTags);
    }
    case 'chan': {
      const other = b as ChanType;
      return a.dir === other.dir && identical(a.element, other.element, ignoreTags);
    }
    case 'struct': {
      const other = b as StructType;
      return (
        a.fields.length === other.fields.length &&
        a.fields.every((field, index) => {
          const otherField = other.fields[index];
          return (
            field.name === otherField.name &&
            field.embedded === otherField.embedded &&
            (ignoreTags || (field.tag ?? '') === (otherField.tag ?? '')) &&
            identical(field.type, otherField.type, ignoreTags)
          );
        })
      );
    }
    case 'func': {
      const other = b as FuncType;
      return (
        a.variadic === other.variadic &&
        identicalLists(a.params, other.params, ignoreTags) &&
        identicalLists(a.results, other.results, ignoreTags)
      );
    }
    case 'interface': {
      const other = b as InterfaceType;
      return (
        a.methods.length === other.methods.length &&
        a.methods.every(
          (method, index) =>
            method.name === other.methods[index].name && identical(method.type, other.methods[index].type, ignoreTags)
        ) &&
        Boolean(a.typeSet?.comparable) === Boolean(other.typeSet?.comparable) &&
        identicalTerms(a.typeSet?.terms, other.typeSet?.terms)
      );
    }
    case 'tuple': {
      return identicalLists(a.types, (b as TupleType).types, ignoreTags);
    }
    case 'typeParam': {
      return a.id === (b as TypeParamType).id;
    }
  }
}

function identicalLists(a: Type[], b: Type[], ignoreTags = false): boolean {
  return a.length === b.length && a.every((type, index) => identical(type, b[index], ignoreTags));
}

function identicalTerms(a: TypeSet['terms'], b: TypeSet['terms']): boolean {
  if (!a || !b) return a === b;
  return (
    a.length === b.length &&
    a.every((term, index) => term.tilde === b[index].tilde && identical(term.type, b[index].type))
  );
}

const namedTypeIds = new WeakMap<NamedType, number>();
let nextNamedTypeId = 0;

/** A canonical key that agrees with Go's `identical(a, b)` for every type, including local named types. */
// code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of type, matching identical.
// code-gauge-allow functionNcss 41 -- Visits the Go type shapes for canonical identity and diagnostic spelling.
export function typeIdentityKey(type: Type, seen = new Set<Type>()): string {
  switch (type.kind) {
    case 'basic': {
      return `b:${type.basic}`;
    }
    case 'named': {
      const base = type.origin ?? type;
      const id = namedTypeId(base);
      if (!type.origin || !type.typeArgs) return `n:${id}`;
      if (seen.has(type)) return `n:${id}[...]`;
      seen.add(type);
      const args = type.typeArgs.map((arg) => typeIdentityKey(arg, seen)).join(',');
      seen.delete(type);
      return `n:${id}[${args}]`;
    }
    case 'chan': {
      return `chan:${type.dir}(${typeIdentityKey(type.element, seen)})`;
    }
    case 'pointer': {
      return `*${typeIdentityKey(type.element, seen)}`;
    }
    case 'slice': {
      return `[]${typeIdentityKey(type.element, seen)}`;
    }
    case 'array': {
      return `[${type.length}]${typeIdentityKey(type.element, seen)}`;
    }
    case 'map': {
      return `map[${typeIdentityKey(type.key, seen)}]${typeIdentityKey(type.value, seen)}`;
    }
    case 'struct': {
      const fields = type.fields
        .map(
          (field) =>
            `${field.embedded ? '^' : ''}${JSON.stringify(field.name)}:${JSON.stringify(field.tag ?? '')}:${typeIdentityKey(field.type, seen)}`
        )
        .join(';');
      return `struct{${fields}}`;
    }
    case 'func': {
      const params = type.params.map((param) => typeIdentityKey(param, seen)).join(',');
      const results = type.results.map((result) => typeIdentityKey(result, seen)).join(',');
      return `func(${type.variadic ? '...' : ''};${params})(${results})`;
    }
    case 'interface': {
      const methods = type.methods.map((method) => `${method.name}:${typeIdentityKey(method.type, seen)}`).join(';');
      const comparable = type.typeSet?.comparable ? 'c' : '';
      const terms = (type.typeSet?.terms ?? [])
        .map((term) => `${term.tilde ? '~' : ''}${typeIdentityKey(term.type, seen)}`)
        .join('|');
      return `interface{${methods}|${comparable}|${terms}}`;
    }
    case 'tuple': {
      return `tuple(${type.types.map((element) => typeIdentityKey(element, seen)).join(',')})`;
    }
    case 'typeParam': {
      return `tp:${type.id}`;
    }
  }
}

function namedTypeId(type: NamedType): number {
  let id = namedTypeIds.get(type);
  if (id === undefined) {
    id = nextNamedTypeId++;
    namedTypeIds.set(type, id);
  }
  return id;
}

// Names -----------------------------------------------------------------------------------------------------------------

/**
 * The name `%T` and `%v` print, as reflection names types: `main.Vertex`, `[]int`, `map[string]int`,
 * `struct { X int }`.
 */
// code-gauge-allow functionNcss 48 -- Visits the Go type shapes for canonical identity and diagnostic spelling.
// code-gauge-allow functionCognitiveComplexity 23 -- Formats each Go type constructor while delegating interface and function signatures.
export function typeString(type: Type, qualify = true): string {
  switch (type.kind) {
    case 'basic': {
      if (type.basic === 'untypedNil') return 'nil';
      return type.basic === 'uint8' || type.basic === 'int32' ? type.basic : type.name;
    }
    case 'named': {
      const base = type.pkg && qualify ? `${type.pkg.split('/').at(-1)}.${type.name}` : type.name;
      if (!type.typeArgs) return base;
      return `${base}[${type.typeArgs.map((arg) => typeString(arg, qualify)).join(',')}]`;
    }
    case 'pointer': {
      return `*${typeString(type.element, qualify)}`;
    }
    case 'slice': {
      return `[]${typeString(type.element, qualify)}`;
    }
    case 'array': {
      return `[${type.length}]${typeString(type.element, qualify)}`;
    }
    case 'map': {
      return `map[${typeString(type.key, qualify)}]${typeString(type.value, qualify)}`;
    }
    case 'chan': {
      const element = typeString(type.element, qualify);
      if (type.dir === 'send') return `chan<- ${element}`;
      if (type.dir === 'receive') return `<-chan ${element}`;
      // `chan (<-chan T)` keeps the inner direction apart from the outer channel.
      return type.element.kind === 'chan' && type.element.dir === 'receive' ? `chan (${element})` : `chan ${element}`;
    }
    case 'struct': {
      if (type.fields.length === 0) return 'struct {}';
      const fields = type.fields.map((field) =>
        field.embedded ? typeString(field.type, qualify) : `${field.name} ${typeString(field.type, qualify)}`
      );
      return `struct { ${fields.join('; ')} }`;
    }
    case 'func': {
      return `func${signatureString(type, qualify)}`;
    }
    case 'interface': {
      return interfaceString(type, qualify);
    }
    case 'tuple': {
      return `(${type.types.map((element) => typeString(element, qualify)).join(', ')})`;
    }
    case 'typeParam': {
      return type.name;
    }
  }
}

function interfaceString(type: InterfaceType, qualify: boolean): string {
  if (type.typeSet?.comparable && !type.typeSet.terms && type.methods.length === 0) return 'comparable';
  if (type.methods.length === 0 && !type.typeSet) return 'interface {}';
  const methods = type.methods.map((method) => `${method.name}${signatureString(method.type, qualify)}`);
  if (type.typeSet?.comparable) methods.push('comparable');
  if (type.typeSet?.terms)
    methods.push(
      type.typeSet.terms.map((term) => `${term.tilde ? '~' : ''}${typeString(term.type, qualify)}`).join(' | ')
    );
  return `interface { ${methods.join('; ')} }`;
}

export function signatureString(type: FuncType, qualify = true): string {
  const params = type.params.map((param, index) =>
    type.variadic && index === type.params.length - 1
      ? `...${typeString((param as SliceType).element, qualify)}`
      : typeString(param, qualify)
  );
  const results = type.results.map((result) => typeString(result, qualify));
  let resultText = '';
  if (results.length === 1) resultText = ` ${results[0]}`;
  else if (results.length > 1) resultText = ` (${results.join(', ')})`;
  return `(${params.join(', ')})${resultText}`;
}

/** The name Go's compiler uses for a type in its messages, which omits the package `main`. */
export function describeType(type: Type): string {
  if (type.kind === 'basic') return type.name;
  return typeString(type, false);
}

// Comparison --------------------------------------------------------------------------------------------------------

/** Whether `==` compares values of the type, which Go decides from the type alone. */
export function isComparable(type: Type, seen = new Set<Type>()): boolean {
  if (seen.has(type)) return true;
  if (type.kind === 'typeParam') {
    return (
      Boolean(type.constraint.typeSet?.comparable) ||
      (type.constraint.typeSet?.terms?.every((term) => isComparable(term.type)) ?? false)
    );
  }
  const under = underlying(type);
  seen.add(type);
  switch (under.kind) {
    case 'slice':
    case 'map':
    case 'func': {
      return false;
    }
    case 'struct': {
      return under.fields.every((field) => isComparable(field.type, seen));
    }
    case 'array': {
      return isComparable(under.element, seen);
    }
    default: {
      return true;
    }
  }
}

// Fields and methods ------------------------------------------------------------------------------------------------

export type Selection =
  /** `pkg` is the package of the named type declaring the field, or '' for a struct type that no type names. */
  | { kind: 'field'; path: number[]; type: Type; indirect: boolean; pkg: string }
  | { kind: 'method'; path: number[]; method: Method; receiverBase: NamedType; indirect: boolean }
  | { kind: 'interfaceMethod'; path: number[]; method: InterfaceMethod; indirect: boolean };

/** Whether a field is unexported and declared in a library package, which the program cannot refer to. */
export function isForeignUnexported(name: string, pkg: string): boolean {
  return pkg !== '' && pkg !== 'main' && !/^\p{Lu}/u.test(name);
}

export type LookupResult = Selection | { kind: 'ambiguous' } | { kind: 'notFound' };

interface EmbeddedEntry {
  type: Type;
  path: number[];
  indirect: boolean;
  multiples: boolean;
  pkg: string;
}

/**
 * Finds a field or method by name through embedded fields, as a selector does: the shallowest depth wins, and two at
 * the same depth make the name ambiguous. `path` lists the embedded fields to go through and then the field itself.
 */
// code-gauge-allow functionNcss 56 -- Visits the Go type shapes for canonical identity and diagnostic spelling.
export function lookupFieldOrMethod(type: Type, name: string): LookupResult {
  if (name === '_') return { kind: 'notFound' };
  if (type.kind === 'named' && type.underlying.kind === 'pointer') {
    const result = lookupFieldOrMethod(type.underlying, name);
    return result.kind === 'field' || result.kind === 'ambiguous' ? result : { kind: 'notFound' };
  }
  let start = type;
  let indirect = false;
  if (start.kind === 'pointer') {
    start = start.element;
    indirect = true;
    if (start.kind === 'typeParam' || underlying(start).kind === 'interface') return { kind: 'notFound' };
  }
  let current: EmbeddedEntry[] = [{ type: start, path: [], indirect, multiples: false, pkg: '' }];
  const seen = new Set<string>();
  while (current.length > 0) {
    let found: Selection | undefined;
    const next: EmbeddedEntry[] = [];
    for (const entry of current) {
      let entryType = entry.type;
      if (entryType.kind === 'typeParam') entryType = entryType.constraint;
      if (entryType.kind === 'named') {
        const key = typeIdentityKey(entryType);
        if (seen.has(key)) continue;
        seen.add(key);
        const method = entryType.methods.find((candidate) => candidate.name === name);
        if (method) {
          if (found || entry.multiples) return { kind: 'ambiguous' };
          found = { kind: 'method', path: entry.path, method, receiverBase: entryType, indirect: entry.indirect };
          continue;
        }
      }
      const under = underlying(entryType);
      if (under.kind === 'struct') {
        const pkg = entryType.kind === 'named' ? entryType.pkg : entry.pkg;
        for (const [index, field] of under.fields.entries()) {
          if (field.name === name) {
            if (found || entry.multiples) return { kind: 'ambiguous' };
            found = { kind: 'field', path: [...entry.path, index], type: field.type, indirect: entry.indirect, pkg };
          } else if (!found && field.embedded) {
            const embedded = field.type.kind === 'pointer' ? field.type.element : field.type;
            next.push({
              type: embedded,
              path: [...entry.path, index],
              indirect: entry.indirect || field.type.kind === 'pointer',
              multiples: entry.multiples,
              pkg,
            });
          }
        }
      } else if (under.kind === 'interface') {
        const method = under.methods.find((candidate) => candidate.name === name);
        if (method) {
          if (found || entry.multiples) return { kind: 'ambiguous' };
          found = { kind: 'interfaceMethod', path: entry.path, method, indirect: entry.indirect };
        }
      }
    }
    if (found) return found;
    current = consolidateMultiples(next);
  }
  return { kind: 'notFound' };
}

function consolidateMultiples(entries: EmbeddedEntry[]): EmbeddedEntry[] {
  if (entries.length <= 1) return entries;
  const result: EmbeddedEntry[] = [];
  const byKey = new Map<string, number>();
  for (const entry of entries) {
    const key = typeIdentityKey(entry.type);
    const previous = byKey.get(key);
    if (previous === undefined) {
      byKey.set(key, result.length);
      result.push(entry);
    } else {
      result[previous].multiples = true;
    }
  }
  return result;
}

/** A method that a type's method set lacks for an interface, and why. */
export interface MissingMethod {
  name: string;
  /** The method exists, but only for the pointer type. */
  pointerOnly?: boolean;
  /** The method exists with this other signature. */
  wrongType?: FuncType;
}

/** The first method of the interface that `type` does not provide, by name order, or undefined when it implements it. */
export function missingMethod(type: Type, iface: InterfaceType): MissingMethod | undefined {
  for (const wanted of iface.methods) {
    const found = lookupFieldOrMethod(type, wanted.name);
    if (found.kind === 'interfaceMethod') {
      if (!identical(found.method.type, wanted.type)) return { name: wanted.name, wrongType: found.method.type };
      continue;
    }
    if (found.kind !== 'method' || found.method.typeParams) return { name: wanted.name };
    if (!identical(found.method.type, wanted.type)) return { name: wanted.name, wrongType: found.method.type };
    // A value's method set lacks the methods with pointer receivers, unless an embedded pointer provides them.
    if (found.method.pointerReceiver && type.kind !== 'pointer' && !found.indirect) {
      return { name: wanted.name, pointerOnly: true };
    }
  }
  return undefined;
}

export function isExported(name: string): boolean {
  const first = name.codePointAt(0) as number;
  const char = String.fromCodePoint(first);
  return char !== char.toLowerCase() && char === char.toUpperCase();
}
