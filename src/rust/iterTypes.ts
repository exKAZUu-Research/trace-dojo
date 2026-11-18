import { normalize } from './infer';
import type { Program } from './items';
import { CHAR, ref, shallow, type Type } from './types';

/** The shapes of the iterators that `IntoIterator` makes of a collection: by shared reference, by `&mut`, by value. */
const COLLECTION_SHAPES: Record<string, [string, string | undefined, string]> = {
  Vec: ['SliceIterShape', 'SliceIterMutShape', 'VecIntoIterShape'],
  VecDeque: ['VecDequeIterShape', 'VecDequeIterMutShape', 'VecDequeIntoIterShape'],
  BinaryHeap: ['BinaryHeapIterShape', undefined, 'BinaryHeapIntoIterShape'],
  HashSet: ['HashSetIterShape', undefined, 'HashSetIntoIterShape'],
  BTreeSet: ['BTreeSetIterShape', undefined, 'BTreeSetIntoIterShape'],
  HashMap: ['HashMapIterShape', 'HashMapIterMutShape', 'HashMapIntoIterShape'],
  BTreeMap: ['BTreeMapIterShape', 'BTreeMapIterMutShape', 'BTreeMapIntoIterShape'],
  Option: ['OptionIterShape', 'OptionIterShape', 'OptionIterShape'],
  Result: ['OptionIterShape', 'OptionIterShape', 'OptionIterShape'],
};

const RANGE_SHAPES: Record<string, string> = {
  Range: 'RangeShape',
  RangeInclusive: 'RangeInclusiveShape',
  RangeFrom: 'RangeFromShape',
};

/** The element type a `for` loop over a value of this type binds, as `IntoIterator` gives it. */
// code-gauge-allow functionNcss 49 -- Follows std's `IntoIterator` impls case by case.
export function intoIterItem(type: Type): Type | undefined {
  const t = normalize(shallow(type));
  if (t.kind === 'array') return t.elem;
  if (t.kind === 'ref') {
    const target = normalize(shallow(t.target));
    if (target.kind === 'array' || target.kind === 'slice') return ref(target.elem, t.mutable);
    if (target.kind !== 'adt') return undefined;
    switch (target.def.builtin) {
      case 'Vec':
      case 'VecDeque':
      case 'HashSet':
      case 'BTreeSet':
      case 'BinaryHeap': {
        const builtin = target.def.builtin;
        return ref(target.args[0], t.mutable && builtin !== 'HashSet' && builtin !== 'BTreeSet');
      }
      case 'HashMap':
      case 'BTreeMap': {
        return { kind: 'tuple', elems: [ref(target.args[0]), ref(target.args[1], t.mutable)] };
      }
      case 'Option': {
        return ref(target.args[0], t.mutable);
      }
      case 'Iter': {
        return t.mutable ? target.args[0] : undefined;
      }
      default: {
        return undefined;
      }
    }
  }
  if (t.kind !== 'adt') return undefined;
  switch (t.def.builtin) {
    case 'CaseIter': {
      return CHAR;
    }
    case 'HashMap':
    case 'BTreeMap': {
      return { kind: 'tuple', elems: t.args };
    }
    case 'Vec':
    case 'VecDeque':
    case 'HashSet':
    case 'BTreeSet':
    case 'BinaryHeap':
    case 'Iter':
    case 'Option':
    case 'Result':
    case 'Range':
    case 'RangeInclusive':
    case 'RangeFrom': {
      return t.args[0];
    }
    default: {
      return undefined;
    }
  }
}

/** The shape of the iterator that `IntoIterator` makes of a value of this type. */
// code-gauge-allow functionCognitiveComplexity 25 -- Follows std's `IntoIterator` impls case by case.
export function intoIterShape(program: Program, type: Type): Type | undefined {
  const t = normalize(shallow(type));
  if (t.kind === 'array') return program.shapeType('ArrayIntoIterShape');
  if (t.kind === 'ref') {
    const target = normalize(shallow(t.target));
    if (target.kind === 'array' || target.kind === 'slice') {
      return program.shapeType(t.mutable ? 'SliceIterMutShape' : 'SliceIterShape');
    }
    if (target.kind !== 'adt') return undefined;
    if (target.def.builtin === 'Iter') return t.mutable ? program.shapeType('ByRefShape', [target.args[1]]) : undefined;
    const shapes = COLLECTION_SHAPES[target.def.builtin as string];
    const name = shapes && (t.mutable ? shapes[1] : shapes[0]);
    return name ? program.shapeType(name) : undefined;
  }
  if (t.kind !== 'adt') return undefined;
  if (t.def.builtin === 'Iter') return t.args[1];
  if (t.def.builtin === 'CaseIter') return program.shapeType('CaseMappingShape');
  const range = RANGE_SHAPES[t.def.builtin as string];
  if (range) return program.shapeType(range, [t.args[0]]);
  const shapes = COLLECTION_SHAPES[t.def.builtin as string];
  return shapes ? program.shapeType(shapes[2]) : undefined;
}
