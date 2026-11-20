// code-gauge-allow-file fileNcss 414 -- Defines Rust types, their substitutions and their shared structural operations.
import type { ConstItem, FnItem, Span } from './ast';
import type { Module } from './items';

export type IntName = 'i8' | 'i16' | 'i32' | 'i64' | 'i128' | 'isize' | 'u8' | 'u16' | 'u32' | 'u64' | 'u128' | 'usize';
export type FloatName = 'f32' | 'f64';

export type Type =
  | { kind: 'int'; name: IntName }
  | { kind: 'float'; name: FloatName }
  | { kind: 'bool' }
  | { kind: 'char' }
  | { kind: 'str' }
  | { kind: 'never' }
  | { kind: 'tuple'; elems: Type[] }
  | { kind: 'array'; elem: Type; len: number }
  | { kind: 'slice'; elem: Type }
  /** `lifetime`: the name a declared signature gives the reference's lifetime (`'a`), which only the borrow checker reads. */
  | { kind: 'ref'; mutable: boolean; target: Type; lifetime?: string }
  /** `lifetimes`: the lifetime arguments a declared signature writes (`Parser<'a>`), which only the borrow checker reads. */
  | { kind: 'adt'; def: AdtDef; args: Type[]; lifetimes?: string[] }
  | { kind: 'param'; param: TypeParam }
  | { kind: 'var'; v: TypeVar }
  | { kind: 'fn'; params: Type[]; ret: Type; item?: FnDef | VariantDef }
  | { kind: 'closure'; closure: ClosureType }
  | { kind: 'dyn'; trait: TraitRef; objectLifetime?: 'static' | 'reference' }
  | { kind: 'opaque'; opaque: OpaqueType };

export interface TypeVar {
  id: number;
  binding: Type | undefined;
  /** An integer or float literal's variable, which only a type of that kind may bind and which has a default. */
  literal: 'int' | 'float' | undefined;
}

export interface TypeParam {
  name: string;
  id: number;
  bounds: TraitRef[];
  defaultType?: Type;
  /** Whether this is the `Self` of a trait, which stands for the implementing type. */
  isSelf?: boolean;
}

export interface ClosureType {
  id: number;
  params: Type[];
  ret: Type;
  /** The closure trait the closure implements: `FnOnce` when it moves a capture out, `FnMut` when it mutates one. */
  kind: 'Fn' | 'FnMut' | 'FnOnce';
  /** Where an `FnOnce` closure first moves a capture out, which rustc reports when it needs `Fn` or `FnMut`. */
  movedAt?: { name: string; span: Span };
  /** Where the closure is written, which rustc reports when it implements too weak a closure trait. */
  span?: Span;
  /** How the closure captures each variable, which decides whether it is `Copy` and `Clone`. */
  captures?: { type: Type; mode: 'ref' | 'mut' | 'value' }[];
  layoutCaptures?: Type[];
}

/** A return type `impl Trait`, which callers see only through its bounds. */
export interface OpaqueType {
  id: number;
  args: Type[];
  bounds: TraitRef[];
  hidden: Type | undefined;
  method?: FnDef;
}

export interface FieldDef {
  name: string;
  type: Type;
  visibleWithin: Module | undefined;
  span: Span;
}

export interface VariantDef {
  name: string;
  index: number;
  shape: 'named' | 'tuple' | 'unit';
  fields: FieldDef[];
  discriminant: bigint;
}

export type BuiltinAdt =
  | 'String'
  | 'Vec'
  | 'HashMap'
  | 'HashSet'
  | 'BTreeMap'
  | 'BTreeSet'
  | 'VecDeque'
  | 'BinaryHeap'
  | 'Box'
  | 'Option'
  | 'Result'
  | 'Ordering'
  | 'Reverse'
  | 'Turtle'
  | 'Iter'
  | 'Range'
  | 'RangeInclusive'
  | 'RangeFrom'
  | 'RangeTo'
  | 'RangeToInclusive'
  | 'RangeFull'
  | 'CaseIter'
  | 'ControlFlow'
  | 'EscapeDefault'
  | 'ParseError'
  | 'Unsigned'
  | 'Signed'
  | 'Indexed'
  | 'TryFromError'
  | 'CharTryFromError'
  | 'TryFromCharError'
  | 'IterItem'
  | 'IterShape'
  | 'IterTarget'
  | 'IntoItem'
  | 'IntoShape'
  | 'Formatter'
  | 'FmtError'
  | 'IoError'
  | 'Stdout'
  | 'StdoutLock'
  | 'Stderr'
  | 'StderrLock'
  | 'ParseIntError'
  | 'IntErrorKind'
  | 'ParseFloatError'
  | 'ParseBoolError'
  | 'ParseCharError'
  | 'TryFromIntError'
  | 'Utf8Error'
  | 'Entry'
  | 'Infallible';

export interface AdtDef {
  name: string;
  /** The path learners know the type by, for messages (`std::collections::HashMap`). */
  path: string;
  kind: 'struct' | 'enum';
  params: TypeParam[];
  /** A struct's single variant, or an enum's variants. */
  variants: VariantDef[];
  derives: Set<string>;
  /** Where the type is declared, whose name rustc reports for errors about its derives. */
  span: Span;
  builtin?: BuiltinAdt;
  /** The lifetime parameters the type declares (`'a`), through which its values may hold borrows. */
  lifetimeParams?: string[];
  /** The module the type is declared in, whose items may read its private fields. */
  module?: unknown;
}

export interface TraitDef {
  name: string;
  path: string;
  params: TypeParam[];
  /** The trait's `Self`, which its methods' signatures refer to. */
  self: TypeParam;
  methods: Map<string, FnDef>;
  supertraits: TraitRef[];
  /** A trait of the standard library whose implementations the interpreter knows. */
  builtin?: string;
  module?: unknown;
}

export interface TraitRef {
  trait: TraitDef;
  args: Type[];
  /** The parameters and result of a closure trait (`Fn(i32) -> i32`). */
  fnSig?: { params: Type[]; ret: Type };
  /** The `Item` an `Iterator` or `IntoIterator` bound sets (`Iterator<Item = i32>`). */
  item?: Type;
}

export interface ImplDef {
  params: TypeParam[];
  trait: TraitRef | undefined;
  selfType: Type;
  methods: Map<string, FnDef>;
  consts: Map<string, ConstDef>;
  module: unknown;
  span: { row: number; col: number };
}

export interface ConstDef {
  name: string;
  type: Type;
  ast: ConstItem;
  module: Module;
  impl: ImplDef | undefined;
}

export interface FnDef {
  name: string;
  /** The type parameters of the function, after those of its impl or trait, which calls bind in this order. */
  params: TypeParam[];
  /** How many of `params` belong to the impl or trait. */
  parentParamCount: number;
  selfMode: 'value' | 'ref' | 'mutRef' | undefined;
  paramTypes: Type[];
  ret: Type;
  ast: FnItem | undefined;
  impl: ImplDef | undefined;
  trait: TraitDef | undefined;
  /** The module the function is declared in. */
  module: unknown;
  /** Filled by the compiler. */
  compiled?: unknown;
  /** Whether the function's self type is the `Self` of the declaring trait (a default method). */
  isDefault?: boolean;
  /** For a function of the standard library without a body, the key of its native implementation. */
  nativeKey?: string;
  /** Bounds that a method's `where` clause puts on its impl's or trait's type parameters. */
  extraBounds?: { param: TypeParam; bound: TraitRef }[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Constructors

const intTypes = new Map<string, Type>();
export function intType(name: IntName): Type {
  let type = intTypes.get(name);
  if (!type) {
    type = { kind: 'int', name };
    intTypes.set(name, type);
  }
  return type;
}

export const INT_NAMES: IntName[] = [
  'i8',
  'i16',
  'i32',
  'i64',
  'i128',
  'isize',
  'u8',
  'u16',
  'u32',
  'u64',
  'u128',
  'usize',
];
export const I32 = intType('i32');
export const USIZE = intType('usize');
export const U8 = intType('u8');
export const U32 = intType('u32');
export const I64 = intType('i64');
export const F64: Type = { kind: 'float', name: 'f64' };
export const F32: Type = { kind: 'float', name: 'f32' };
export const BOOL: Type = { kind: 'bool' };
export const CHAR: Type = { kind: 'char' };
export const STR: Type = { kind: 'str' };
export const UNIT: Type = { kind: 'tuple', elems: [] };
export const NEVER: Type = { kind: 'never' };
export const REF_STR: Type = { kind: 'ref', mutable: false, target: STR };

export function ref(target: Type, mutable = false): Type {
  return { kind: 'ref', mutable, target };
}

export function adt(def: AdtDef, args: Type[] = []): Type {
  return { kind: 'adt', def, args };
}

let nextVarId = 0;
export function freshVar(literal?: 'int' | 'float'): Type {
  return { kind: 'var', v: { id: nextVarId++, binding: undefined, literal } };
}

let nextParamId = 0;
export function newTypeParam(name: string, isSelf = false): TypeParam {
  return { name, id: nextParamId++, bounds: [], isSelf };
}

let nextClosureId = 0;
export function newClosureType(params: Type[], ret: Type): Type {
  return { kind: 'closure', closure: { id: nextClosureId++, params, ret, kind: 'Fn' } };
}

let nextOpaqueId = 0;
export function newOpaque(args: Type[]): OpaqueType {
  return { id: nextOpaqueId++, args, bounds: [], hidden: undefined };
}

// ---------------------------------------------------------------------------------------------------------------------
// Inference

/** Follows the bindings of type variables at the top of a type. */
export function shallow(type: Type): Type {
  let current = type;
  while (current.kind === 'var' && current.v.binding) current = current.v.binding;
  return current;
}

/** A type with each type directly inside it replaced by `f`'s result; closures and opaque types stay as they are. */
export function mapChildren(t: Type, f: (child: Type) => Type): Type {
  switch (t.kind) {
    case 'tuple': {
      return { kind: 'tuple', elems: t.elems.map(f) };
    }
    case 'array': {
      return { kind: 'array', elem: f(t.elem), len: t.len };
    }
    case 'slice': {
      return { kind: 'slice', elem: f(t.elem) };
    }
    case 'ref': {
      return { kind: 'ref', mutable: t.mutable, target: f(t.target) };
    }
    case 'adt': {
      return t.args.length === 0 ? t : { kind: 'adt', def: t.def, args: t.args.map(f) };
    }
    case 'fn': {
      return { ...t, params: t.params.map(f), ret: f(t.ret) };
    }
    case 'dyn': {
      return { ...t, trait: mapTraitRef(t.trait, f) };
    }
    default: {
      return t;
    }
  }
}

function mapTraitRef(ref: TraitRef, f: (type: Type) => Type): TraitRef {
  return {
    trait: ref.trait,
    args: ref.args.map(f),
    fnSig: ref.fnSig && { params: ref.fnSig.params.map(f), ret: f(ref.fnSig.ret) },
    item: ref.item && f(ref.item),
  };
}

/** The types directly inside a type, including a closure's signature and an opaque type's captured arguments. */
export function childTypes(t: Type): Type[] {
  switch (t.kind) {
    case 'tuple': {
      return t.elems;
    }
    case 'array':
    case 'slice': {
      return [t.elem];
    }
    case 'ref': {
      return [t.target];
    }
    case 'adt': {
      return t.args;
    }
    case 'fn': {
      return [...t.params, t.ret];
    }
    case 'closure': {
      return [
        ...t.closure.params,
        t.closure.ret,
        ...(t.closure.captures?.map(({ type }) => type) ?? []),
        ...(t.closure.layoutCaptures ?? []),
      ];
    }
    case 'dyn': {
      return [...t.trait.args, ...(t.trait.fnSig?.params ?? [])];
    }
    case 'opaque': {
      return t.opaque.args;
    }
    default: {
      return [];
    }
  }
}

/** Replaces every bound type variable in a type, and unbound literal variables with their defaults when asked. */
export function resolve(type: Type, defaults = false): Type {
  const t = shallow(type);
  if (t.kind === 'var') {
    if (defaults && t.v.literal) {
      t.v.binding = t.v.literal === 'int' ? I32 : F64;
      return t.v.binding;
    }
    return t;
  }
  if (t.kind === 'closure') {
    const { closure } = t;
    closure.params = closure.params.map((p) => resolve(p, defaults));
    closure.ret = resolve(closure.ret, defaults);
    return t;
  }
  if (t.kind === 'opaque') {
    for (const arg of t.opaque.args) resolve(arg, defaults);
    return t;
  }
  return mapChildren(t, (child) => resolve(child, defaults));
}

export function resolveTraitRef(ref: TraitRef, defaults = false): TraitRef {
  return mapTraitRef(ref, (type) => resolve(type, defaults));
}

/** Whether a type still has an unbound variable after resolving. */
export function hasVars(type: Type): boolean {
  const t = shallow(type);
  if (t.kind === 'var') return true;
  return childTypes(t).some(hasVars);
}

export type Subst = Map<TypeParam, Type>;

/** Replaces type parameters with the types `subst` binds them to. */
export function substitute(type: Type, subst: Subst): Type {
  if (subst.size === 0) return type;
  const t = shallow(type);
  if (t.kind === 'param') return subst.get(t.param) ?? t;
  if (t.kind === 'closure') {
    const { closure } = t;
    return {
      kind: 'closure',
      closure: {
        ...closure,
        params: closure.params.map((param) => substitute(param, subst)),
        ret: substitute(closure.ret, subst),
        captures: closure.captures?.map((capture) => ({ ...capture, type: substitute(capture.type, subst) })),
        layoutCaptures: closure.layoutCaptures?.map((type) => substitute(type, subst)),
      },
    };
  }
  if (t.kind === 'opaque') {
    const opaque = t.opaque;
    const args = opaque.args.map((arg) => substitute(arg, subst));
    if (sameTypeList(args, opaque.args)) return t;
    return {
      kind: 'opaque',
      opaque: {
        id: opaque.id,
        args,
        method: opaque.method,
        get bounds() {
          return opaque.bounds.map((bound) => substituteTraitRef(bound, subst));
        },
        get hidden() {
          const hidden = opaque.hidden;
          return hidden && substitute(hidden, subst);
        },
      },
    };
  }
  return mapChildren(t, (child) => substitute(child, subst));
}

export function substituteTraitRef(ref: TraitRef, subst: Subst): TraitRef {
  if (subst.size === 0) return ref;
  return mapTraitRef(ref, (type) => substitute(type, subst));
}

export function defaultTraitArguments(trait: TraitDef, written: Type[], self?: Type): Type[] {
  const args = [...written];
  const subst = new Map<TypeParam, Type>();
  if (self) subst.set(trait.self, self);
  for (const [index, param] of trait.params.entries()) {
    if (index >= args.length) {
      if (!param.defaultType) break;
      const type = substitute(param.defaultType, subst);
      if (!self && type.kind === 'param' && type.param === trait.self) break;
      args.push(type);
    }
    subst.set(param, args[index]);
  }
  return args;
}

export function supertraitsOf(ref: TraitRef, self?: Type): TraitRef[] {
  const subst = new Map(ref.trait.params.map((param, index) => [param, ref.args[index]]));
  if (self) subst.set(ref.trait.self, self);
  return ref.trait.supertraits.map((bound) => {
    const parent = substituteTraitRef(bound, subst);
    return ref.item && parent.trait.builtin === 'Iterator' ? { ...parent, item: ref.item } : parent;
  });
}

export function allSupertraits(bounds: TraitRef[], self?: Type): TraitRef[] {
  const queue = bounds.map((bound) => ({ bound, ancestors: [] as TraitDef[] }));
  const result: TraitRef[] = [];
  for (const { bound, ancestors } of queue) {
    if (ancestors.includes(bound.trait) || result.some((other) => sameTraitRef(bound, other))) continue;
    result.push(bound);
    const next = [...ancestors, bound.trait];
    for (const parent of supertraitsOf(bound, self)) queue.push({ bound: parent, ancestors: next });
  }
  return result;
}

function sameTraitRef(a: TraitRef, b: TraitRef): boolean {
  if (a.trait !== b.trait || !sameTypeList(a.args, b.args)) return false;
  if (a.fnSig && b.fnSig) {
    if (!sameTypeList(a.fnSig.params, b.fnSig.params) || !sameType(a.fnSig.ret, b.fnSig.ret)) return false;
  } else if (a.fnSig || b.fnSig) return false;
  return a.item && b.item ? sameType(a.item, b.item) : a.item === b.item;
}

function sameTypeList(a: Type[], b: Type[]): boolean {
  return a.length === b.length && a.every((type, i) => sameType(type, b[i]));
}

export function hasParams(type: Type): boolean {
  const t = shallow(type);
  if (t.kind === 'param') return true;
  return childTypes(t).some(hasParams);
}

/** Whether two resolved types are the same type. */
// code-gauge-allow functionNcss 41 -- One case per kind of type.
export function sameType(a: Type, b: Type): boolean {
  const x = shallow(a);
  const y = shallow(b);
  if (x === y) return true;
  if (x.kind !== y.kind) return false;
  switch (x.kind) {
    case 'int':
    case 'float': {
      return x.name === (y as typeof x).name;
    }
    case 'tuple': {
      const other = y as typeof x;
      return x.elems.length === other.elems.length && x.elems.every((elem, i) => sameType(elem, other.elems[i]));
    }
    case 'array': {
      const other = y as typeof x;
      return x.len === other.len && sameType(x.elem, other.elem);
    }
    case 'slice': {
      return sameType(x.elem, (y as typeof x).elem);
    }
    case 'ref': {
      const other = y as typeof x;
      return x.mutable === other.mutable && sameType(x.target, other.target);
    }
    case 'adt': {
      const other = y as typeof x;
      return x.def === other.def && x.args.every((arg, i) => sameType(arg, other.args[i]));
    }
    case 'param': {
      return x.param === (y as typeof x).param;
    }
    case 'var': {
      return x.v === (y as typeof x).v;
    }
    case 'fn': {
      const other = y as typeof x;
      return (
        x.params.length === other.params.length &&
        x.params.every((p, i) => sameType(p, other.params[i])) &&
        sameType(x.ret, other.ret)
      );
    }
    case 'closure': {
      return x.closure.id === (y as typeof x).closure.id;
    }
    case 'dyn': {
      return sameTraitRef(x.trait, (y as typeof x).trait);
    }
    case 'opaque': {
      const other = (y as typeof x).opaque;
      return x.opaque.id === other.id && sameTypeList(x.opaque.args, other.args);
    }
    default: {
      return true;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Printing

/** A type as rustc writes it in messages, with `{integer}` and `_` for variables. */
// code-gauge-allow functionCognitiveComplexity 21 -- One case per kind of type.
// code-gauge-allow functionNcss 42 -- One case per kind of type.
export function typeToString(type: Type): string {
  const t = shallow(type);
  switch (t.kind) {
    case 'int':
    case 'float': {
      return t.name;
    }
    case 'bool':
    case 'char':
    case 'str': {
      return t.kind;
    }
    case 'never': {
      return '!';
    }
    case 'tuple': {
      if (t.elems.length === 1) return `(${typeToString(t.elems[0])},)`;
      return `(${t.elems.map(typeToString).join(', ')})`;
    }
    case 'array': {
      return `[${typeToString(t.elem)}; ${t.len}]`;
    }
    case 'slice': {
      return `[${typeToString(t.elem)}]`;
    }
    case 'ref': {
      return `&${t.mutable ? 'mut ' : ''}${typeToString(t.target)}`;
    }
    case 'adt': {
      if (t.def.builtin === 'Iter') {
        // An iterator is the std type its shape stands for.
        const shape = shallow(t.args[1]);
        return shape.kind === 'adt' ? typeToString(shape) : `impl Iterator<Item = ${typeToString(t.args[0])}>`;
      }
      const name = isIteratorShape(t.def) ? shapeName(t.def.name) : t.def.name;
      if (t.args.length === 0) return name;
      return `${name}<${t.args.map(typeToString).join(', ')}>`;
    }
    case 'param': {
      return t.param.name;
    }
    case 'var': {
      return t.v.literal === 'int' ? '{integer}' : t.v.literal === 'float' ? '{float}' : '_';
    }
    case 'fn': {
      return `fn(${t.params.map(typeToString).join(', ')})${isUnit(t.ret) ? '' : ` -> ${typeToString(t.ret)}`}`;
    }
    case 'closure': {
      return 'クロージャ';
    }
    case 'dyn': {
      return `dyn ${traitRefToString(t.trait)}`;
    }
    case 'opaque': {
      return `impl ${t.opaque.bounds.map(traitRefToString).join(' + ')}`;
    }
  }
}

export function traitRefToString(ref: TraitRef): string {
  if (ref.fnSig) {
    const ret = isUnit(ref.fnSig.ret) ? '' : ` -> ${typeToString(ref.fnSig.ret)}`;
    return `${ref.trait.name}(${ref.fnSig.params.map(typeToString).join(', ')})${ret}`;
  }
  if (ref.args.length === 0) return ref.trait.name;
  return `${ref.trait.name}<${ref.args.map(typeToString).join(', ')}>`;
}

export function isUnit(type: Type): boolean {
  const t = shallow(type);
  return t.kind === 'tuple' && t.elems.length === 0;
}

export function outputStream(type: Type): 'stdout' | 'stderr' | undefined {
  const t = shallow(type);
  if (t.kind === 'ref') return outputStream(t.target);
  if (t.kind !== 'adt') return undefined;
  switch (t.def.builtin) {
    case 'Stdout':
    case 'StdoutLock': {
      return 'stdout';
    }
    case 'Stderr':
    case 'StderrLock': {
      return 'stderr';
    }
    default: {
      return undefined;
    }
  }
}

export function isBuiltin(type: Type, name: BuiltinAdt): boolean {
  const t = shallow(type);
  return t.kind === 'adt' && t.def.builtin === name;
}

export function isSigned(name: IntName): boolean {
  return name.startsWith('i');
}

export function intBits(name: IntName): number {
  if (name === 'isize' || name === 'usize') return 64;
  return Number(name.slice(1));
}

export function intMin(name: IntName): bigint {
  return isSigned(name) ? -(1n << BigInt(intBits(name) - 1)) : 0n;
}

export function intMax(name: IntName): bigint {
  const bits = BigInt(intBits(name));
  return isSigned(name) ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
}

/** Strips references, as `{:?}` and method calls look through them. */
export function stripRefs(type: Type): Type {
  let t = shallow(type);
  while (t.kind === 'ref') t = shallow(t.target);
  return t;
}

/** Whether a type is the shape of an iterator (`std::iter::shape`), which stands for an iterator type of std. */
export function isIteratorShape(def: AdtDef): boolean {
  return def.name.endsWith('Shape') && (def.module as { name?: string } | undefined)?.name === 'shape';
}

/** The name of the iterator type of std that a shape stands for. */
function shapeName(name: string): string {
  const renamed: Record<string, string> = {
    SliceIterShape: 'Iter',
    SliceIterMutShape: 'IterMut',
    VecIntoIterShape: 'IntoIter',
    ArrayIntoIterShape: 'IntoIter',
    VecDrainShape: 'Drain',
    StringDrainShape: 'Drain',
    OptionIterShape: 'Iter',
  };
  if (renamed[name]) return renamed[name];
  const collection = /^(?:HashMap|BTreeMap|HashSet|BTreeSet|VecDeque|BinaryHeap)(\w+)Shape$/.exec(name);
  return collection ? collection[1] : name.replace(/Shape$/, '');
}
