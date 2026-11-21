import { collectionKeyAnswer, collectionKeyTraits } from './collectionBounds';
import { normalize } from './infer';
import type { Answer, TraitSolver } from './traits';
import { F32, F64, INT_NAMES, intType, shallow, type Type } from './types';

type AdtType = Type & { kind: 'adt' };

/** The conversions `From` provides in the standard library that learning programs use. */
// code-gauge-allow functionCognitiveComplexity 16 -- Each conversion family has different representation and range constraints.
export function conversionExists(solver: TraitSolver, source: Type, target: Type): Answer {
  const t = normalize(shallow(target));
  if (t.kind === 'adt') {
    if (t.def.builtin === 'VecDeque' || collectionKeyTraits(t.def.builtin).length > 0) {
      return collectionFrom(solver, source, t);
    }
    const clone = borrowedSequenceClone(solver, source, t);
    if (clone !== undefined) return clone;
    return adtConversionExists(solver, source, t) ? 'yes' : 'no';
  }
  if (t.kind === 'int') return intFrom(source, t.name) ? 'yes' : 'no';
  if (t.kind === 'float') return floatFrom(source, t.name) ? 'yes' : 'no';
  return t.kind === 'char' && source.kind === 'int' && source.name === 'u8' ? 'yes' : 'no';
}

export function inferNumericSource(solver: TraitSolver, source: Type & { kind: 'var' }, target: Type): Answer {
  const t = normalize(shallow(target));
  if (t.kind !== 'char' && t.kind !== 'int' && t.kind !== 'float') return 'unknown';
  const candidates =
    source.v.literal === 'int' ? INT_NAMES.map(intType) : source.v.literal === 'float' ? [F32, F64] : [];
  const matching = candidates.filter((candidate) => conversionExists(solver, candidate, t) === 'yes');
  return matching.length === 1 && solver.unifier.tryUnify(source, matching[0]) ? 'yes' : 'unknown';
}

function borrowedSequenceClone(solver: TraitSolver, source: Type, target: AdtType): Answer | undefined {
  if (source.kind !== 'ref') return undefined;
  const inner = normalize(shallow(source.target));
  const arg = target.args[0];
  if (target.def.builtin === 'Vec' && (inner.kind === 'slice' || inner.kind === 'array')) {
    return cloneSequenceElements(solver, inner.elem, arg);
  }
  if (target.def.builtin !== 'Box' || inner.kind !== 'slice') return undefined;
  const boxed = normalize(shallow(arg));
  return boxed.kind === 'slice' ? cloneSequenceElements(solver, inner.elem, boxed.elem) : undefined;
}

function cloneSequenceElements(solver: TraitSolver, elem: Type, expected: Type): Answer {
  if (!solver.unifier.tryUnify(elem, expected)) return 'no';
  return solver.implements(elem, { trait: solver.program.traitDef('Clone'), args: [] });
}

function adtConversionExists(solver: TraitSolver, source: Type, t: AdtType): boolean {
  switch (t.def.builtin) {
    case 'String': {
      return stringFrom(source);
    }
    case 'Vec': {
      return vecFrom(solver, source, t.args[0]);
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
function collectionFrom(solver: TraitSolver, source: Type, t: AdtType): Answer {
  const builtin = t.def.builtin as string;
  const fromVec = builtin === 'VecDeque' || builtin === 'BinaryHeap';
  const isVec = source.kind === 'adt' && source.def.builtin === 'Vec';
  if (source.kind !== 'array' && !(fromVec && isVec)) return 'no';
  const elem = source.kind === 'array' ? source.elem : source.args[0];
  const want: Type = builtin.endsWith('Map') ? { kind: 'tuple', elems: t.args } : t.args[0];
  return solver.unifier.tryUnify(elem, want) ? collectionKeyAnswer(solver, t) : 'no';
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
    (target.kind === 'slice' || target.kind === 'array') && s.kind !== 'ref'
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

interface ArrayConversion {
  array: Type & { kind: 'array' };
  elem: Type;
  mode: 'move' | 'copy' | 'borrow';
}

export function arrayTryFrom(source: Type, target: Type): ArrayConversion | undefined {
  const from = normalize(shallow(source));
  const to = normalize(shallow(target));
  const array = to.kind === 'ref' ? normalize(shallow(to.target)) : to;
  if (array.kind !== 'array') return;
  if (from.kind === 'adt' && from.def.builtin === 'Vec' && to.kind === 'array')
    return { array, elem: from.args[0], mode: 'move' };
  if (from.kind !== 'ref') return;
  const slice = normalize(shallow(from.target));
  if (slice.kind !== 'slice') return;
  if (to.kind === 'ref' && to.mutable !== from.mutable) return;
  return { array, elem: slice.elem, mode: to.kind === 'ref' ? 'borrow' : 'copy' };
}

export function intoConversion(solver: TraitSolver, source: Type, target: Type): Answer {
  return solver.implements(source, { trait: solver.program.traitDef('Into'), args: [target] });
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
