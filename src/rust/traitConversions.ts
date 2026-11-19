import { normalize } from './infer';
import type { TraitSolver } from './traits';
import { shallow, type Type } from './types';

type AdtType = Type & { kind: 'adt' };

/** The conversions `From` provides in the standard library that learning programs use. */
export function conversionExists(solver: TraitSolver, source: Type, target: Type): boolean {
  const t = normalize(shallow(target));
  if (t.kind === 'adt') return adtConversionExists(solver, source, t);
  if (t.kind === 'int') return intFrom(source, t.name);
  if (t.kind === 'float') return floatFrom(source, t.name);
  return t.kind === 'char' && source.kind === 'int' && source.name === 'u8';
}

function adtConversionExists(solver: TraitSolver, source: Type, t: AdtType): boolean {
  switch (t.def.builtin) {
    case 'String': {
      return stringFrom(source);
    }
    case 'Vec': {
      return vecFrom(solver, source, t.args[0]);
    }
    case 'HashMap':
    case 'BTreeMap':
    case 'HashSet':
    case 'BTreeSet':
    case 'VecDeque':
    case 'BinaryHeap': {
      return collectionFrom(solver, source, t);
    }
    case 'Option': {
      return solver.unifier.tryUnify(t.args[0], source);
    }
    case 'Box': {
      return boxFrom(solver, source, shallow(t.args[0]));
    }
    default: {
      return false;
    }
  }
}

function stringFrom(source: Type): boolean {
  if (source.kind === 'char') return true;
  if (source.kind === 'ref') {
    const inner = shallow(source.target);
    return inner.kind === 'str' || (inner.kind === 'adt' && inner.def.builtin === 'String');
  }
  return source.kind === 'adt' && source.def.builtin === 'Box' && shallow(source.args[0]).kind === 'str';
}

function vecFrom(solver: TraitSolver, source: Type, elem: Type): boolean {
  if (source.kind === 'array') return solver.unifier.tryUnify(source.elem, elem);
  if (source.kind === 'ref') {
    const inner = shallow(source.target);
    if (inner.kind === 'slice' || inner.kind === 'array') return solver.unifier.tryUnify(inner.elem, elem);
    if (inner.kind === 'str') return solver.unifier.tryUnify(elem, { kind: 'int', name: 'u8' });
  }
  if (source.kind === 'adt' && source.def.builtin === 'String') {
    return solver.unifier.tryUnify(elem, { kind: 'int', name: 'u8' });
  }
  if (source.kind === 'adt' && ['VecDeque', 'BinaryHeap'].includes(source.def.builtin as string)) {
    return solver.unifier.tryUnify(source.args[0], elem);
  }
  return false;
}

/** Maps and sets convert from arrays; `VecDeque` and `BinaryHeap` also from `Vec`s. */
function collectionFrom(solver: TraitSolver, source: Type, t: AdtType): boolean {
  const builtin = t.def.builtin as string;
  const fromVec = builtin === 'VecDeque' || builtin === 'BinaryHeap';
  const isVec = source.kind === 'adt' && source.def.builtin === 'Vec';
  if (source.kind !== 'array' && !(fromVec && isVec)) return false;
  const elem = source.kind === 'array' ? source.elem : source.args[0];
  const want: Type = builtin.endsWith('Map') ? { kind: 'tuple', elems: t.args } : t.args[0];
  return solver.unifier.tryUnify(elem, want);
}

function boxFrom(solver: TraitSolver, source: Type, inner: Type): boolean {
  if (inner.kind === 'dyn' && inner.trait.trait.builtin === 'Error') {
    if (source.kind === 'adt' && source.def.builtin === 'String') return true;
    if (source.kind === 'ref' && shallow(source.target).kind === 'str') return true;
    return solver.implements(source, { trait: solver.program.traitDef('Error'), args: [] }) === 'yes';
  }
  if (inner.kind === 'str' || inner.kind === 'slice') return boxedUnsized(solver, inner, source);
  return solver.unifier.tryUnify(inner, source);
}

/** `Box<str>` from `&str` and `String`; `Box<[T]>` from `&[T]`, `Vec<T>`, and `[T; N]`. */
function boxedUnsized(solver: TraitSolver, inner: Type & { kind: 'str' | 'slice' }, source: Type): boolean {
  const s = normalize(shallow(source));
  const target = s.kind === 'ref' ? normalize(shallow(s.target)) : s;
  if (inner.kind === 'str') return target.kind === 'str' || (target.kind === 'adt' && target.def.builtin === 'String');
  const elem =
    target.kind === 'slice' || (target.kind === 'array' && s.kind !== 'ref')
      ? target.elem
      : target.kind === 'adt' && target.def.builtin === 'Vec' && s.kind !== 'ref'
        ? target.args[0]
        : undefined;
  return elem !== undefined && solver.unifier.tryUnify(elem, inner.elem);
}

function intFrom(source: Type, target: string): boolean {
  if (source.kind === 'int') return losslessInt(source.name, target);
  if (source.kind === 'bool') return true;
  return source.kind === 'char' && (target === 'u32' || target === 'u64' || target === 'u128');
}

function floatFrom(source: Type, target: string): boolean {
  if (source.kind === 'float') return target === 'f64' || source.name === 'f32';
  if (source.kind === 'bool') return true;
  if (source.kind !== 'int') return false;
  const bits = Number(source.name.slice(1));
  return target === 'f64' ? bits <= 32 : bits <= 16;
}

/** Whether `From` converts between two primitive types, which makes `TryFrom` infallible. */
export function infallibleConversion(source: Type, target: Type): boolean {
  const s = normalize(shallow(source));
  const t = normalize(shallow(target));
  if (s.kind === 'int' && t.kind === 'int') return losslessInt(s.name, t.name);
  if (s.kind === 'char' && t.kind === 'int') return ['u32', 'u64', 'u128'].includes(t.name);
  if (s.kind === 'int' && t.kind === 'char') return s.name === 'u8';
  if (s.kind === 'bool' && t.kind === 'int') return true;
  return s.kind === t.kind && (s.kind === 'char' || s.kind === 'bool');
}

// code-gauge-allow functionCognitiveComplexity 20 -- One rule per trait or conversion of the standard library.
function losslessInt(from: string, to: string): boolean {
  if (from === to) return true;
  const fromSigned = from.startsWith('i');
  const toSigned = to.startsWith('i');
  const bits = intBitsByName;
  if (from.endsWith('size') || to.endsWith('size')) {
    if (from === 'u8' && (to === 'usize' || to === 'isize')) return true;
    if (from === 'u16' && to === 'usize') return true;
    if (from === 'i8' && to === 'isize') return true;
    if (from === 'i16' && to === 'isize') return true;
    return false;
  }
  if (fromSigned && !toSigned) return false;
  if (!fromSigned && toSigned) return bits(to) > bits(from);
  return bits(to) >= bits(from);
}

function intBitsByName(name: string): number {
  return name.endsWith('size') ? 64 : Number(name.slice(1));
}
