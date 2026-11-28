import { normalize } from './infer';
import type { Module, Program } from './items';
import {
  adt,
  allSupertraits,
  CHAR,
  type ImplDef,
  ref,
  sameType,
  shallow,
  substitute,
  type TraitRef,
  type Type,
  type TypeParam,
} from './types';

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
// code-gauge-allow functionNcss -- Follows std's `IntoIterator` impls case by case.
export function intoIterItem(type: Type): Type | undefined {
  const t = normalize(shallow(type));
  const dynamic = dynIteratorTarget(t);
  if (dynamic) return iterationBound(dynamic)?.item;
  if (t.kind === 'param' || t.kind === 'opaque') {
    const bound = iterationBound(t);
    return bound && (bound.item ?? adt((bound.trait.module as Module).program.adtDef('IntoItem'), [t]));
  }
  if (t.kind === 'array') return t.elem;
  if (t.kind === 'ref') return borrowedIterItem(t);
  if (t.kind !== 'adt') return undefined;
  if (!t.def.builtin) return userIteratorItem(t);
  switch (t.def.builtin) {
    case 'CaseIter': {
      return CHAR;
    }
    case 'EscapeDefault':
    case 'EscapeUnicode': {
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
    case 'Receiver': {
      return t.args[0];
    }
    case 'Range':
    case 'RangeInclusive':
    case 'RangeFrom': {
      // A range iterates by `Step`, which integers and `char`s have and floats do not.
      const idx = normalize(shallow(t.args[0]));
      const steps = idx.kind === 'int' || idx.kind === 'char' || (idx.kind === 'var' && idx.v.literal !== 'float');
      return steps ? t.args[0] : undefined;
    }
    default: {
      return undefined;
    }
  }
}

function borrowedIterItem(type: Extract<Type, { kind: 'ref' }>): Type | undefined {
  const target = normalize(shallow(type.target));
  // Only `&Receiver` iterates (`for x in &rx`); a `&mut` of one is no iterator.
  if (target.kind === 'adt' && target.def.builtin === 'Receiver' && !type.mutable) return target.args[0];
  // `impl Iterator for &mut I` of std makes a `&mut` of the program's iterator one too.
  if (type.mutable && target.kind === 'adt' && !target.def.builtin) return userIteratorItem(target);
  if (target.kind === 'array' || target.kind === 'slice') return ref(target.elem, type.mutable);
  if (target.kind !== 'adt') return undefined;
  // A range is an iterator, so a `&mut` of one is too.
  if (type.mutable && RANGE_SHAPES[target.def.builtin as string]) return target.args[0];
  switch (target.def.builtin) {
    case 'Vec':
    case 'VecDeque': {
      return ref(target.args[0], type.mutable);
    }
    case 'HashSet':
    case 'BTreeSet':
    case 'BinaryHeap': {
      // Sets and heaps do not let their elements change in place, so `&mut` of them is no iterable.
      return type.mutable ? undefined : ref(target.args[0]);
    }
    case 'HashMap':
    case 'BTreeMap': {
      return { kind: 'tuple', elems: [ref(target.args[0]), ref(target.args[1], type.mutable)] };
    }
    case 'Option':
    case 'Result': {
      return ref(target.args[0], type.mutable);
    }
    case 'Iter': {
      return type.mutable ? target.args[0] : undefined;
    }
    default: {
      return undefined;
    }
  }
}

/** The shape of the iterator that `IntoIterator` makes of a value of this type. */
// code-gauge-allow functionCognitiveComplexity -- One case per kind of iterable type.
// code-gauge-allow functionNcss -- One case per kind of iterable type.
export function intoIterShape(program: Program, type: Type): Type | undefined {
  const t = normalize(shallow(type));
  const dynamic = dynIteratorTarget(t);
  if (dynamic) return program.shapeType('DynIteratorShape', [dynamic]);
  if (t.kind === 'param' || t.kind === 'opaque') return iterationBound(t) && adt(program.adtDef('IntoShape'), [t]);
  if (t.kind === 'array') return program.shapeType('ArrayIntoIterShape', [t.elem]);
  if (isUserIterator(t)) return program.shapeType('UserIterShape', [t]);
  const receiver = t.kind === 'ref' ? normalize(shallow(t.target)) : t;
  if (receiver.kind === 'adt' && receiver.def.builtin === 'Receiver') return program.shapeType('ReceiverShape');
  if (t.kind === 'ref') return borrowedIterShape(program, t.target, t.mutable);
  if (t.kind !== 'adt') return undefined;
  if (t.def.builtin === 'Iter') return t.args[1];
  if (t.def.builtin === 'CaseIter') return program.shapeType('CaseMappingShape');
  if (t.def.builtin === 'EscapeDefault' || t.def.builtin === 'EscapeUnicode')
    return program.shapeType('EscapeDefaultShape');
  const range = RANGE_SHAPES[t.def.builtin as string];
  if (range) return program.shapeType(range, [t.args[0]]);
  const shapes = COLLECTION_SHAPES[t.def.builtin as string];
  if (!shapes) return;
  const name = shapes[2];
  const args = ['Vec', 'VecDeque', 'BinaryHeap', 'Option', 'Result'].includes(t.def.builtin as string)
    ? [t.args[0]]
    : [];
  return program.shapeType(name, args);
}

function borrowedIterShape(program: Program, type: Type, mutable: boolean): Type | undefined {
  const target = normalize(shallow(type));
  if (target.kind === 'array' || target.kind === 'slice') {
    return program.shapeType(mutable ? 'SliceIterMutShape' : 'SliceIterShape');
  }
  if (target.kind !== 'adt') return undefined;
  if (target.def.builtin === 'Iter') return mutable ? program.shapeType('ByRefShape', [target.args[1]]) : undefined;
  const range = RANGE_SHAPES[target.def.builtin as string];
  if (range) return mutable ? program.shapeType('ByRefShape', [program.shapeType(range, [target.args[0]])]) : undefined;
  const name = COLLECTION_SHAPES[target.def.builtin as string]?.[mutable ? 1 : 0];
  if (!name) return;
  return program.shapeType(name, name === 'OptionIterShape' ? [ref(target.args[0], mutable)] : []);
}

/** The `Iterator` impl the program writes for a type of its own, with the impl's parameters bound for the type. */
export function userIteratorImpl(type: Type): { impl: ImplDef; subst: Map<TypeParam, Type> } | undefined {
  const t = normalize(shallow(type));
  if (t.kind !== 'adt' || t.def.builtin) return undefined;
  const program = (t.def.module as Module | undefined)?.program;
  for (const impl of program?.impls ?? []) {
    if (impl.trait?.trait.builtin !== 'Iterator') continue;
    const self = normalize(shallow(impl.selfType));
    if (self.kind !== 'adt' || self.def !== t.def) continue;
    const subst = new Map<TypeParam, Type>();
    const matches = self.args.every((arg, index) => {
      const a = shallow(arg);
      if (a.kind !== 'param') return sameType(a, t.args[index]);
      subst.set(a.param, t.args[index]);
      return true;
    });
    if (matches) return { impl, subst };
  }
  return undefined;
}

function userIteratorItem(type: Type): Type | undefined {
  const found = userIteratorImpl(type);
  const item = found?.impl.assocTypes.get('Item');
  return found && item && substitute(item, found.subst);
}

/** Whether a type is one of the program's iterators, or a `&mut` of one. */
export function isUserIterator(type: Type): boolean {
  const t = normalize(shallow(type));
  if (t.kind === 'ref') return t.mutable && userIteratorImpl(t.target) !== undefined;
  return userIteratorImpl(t) !== undefined;
}

/** The `Iterator` or `IntoIterator` bound of a type parameter or an opaque type, by which it iterates. */
export function iterationBound(type: Type): TraitRef | undefined {
  const bounds =
    type.kind === 'param'
      ? type.param.bounds
      : type.kind === 'opaque'
        ? type.opaque.bounds
        : type.kind === 'dyn'
          ? [type.trait]
          : undefined;
  if (!bounds) return;
  const inherited = allSupertraits(bounds, type);
  return (
    inherited.find((bound) => bound.trait.builtin === 'Iterator') ??
    inherited.find((bound) => bound.trait.builtin === 'IntoIterator')
  );
}

export function dynIteratorTarget(type: Type): Extract<Type, { kind: 'dyn' }> | undefined {
  let t = normalize(shallow(type));
  while ((t.kind === 'ref' && t.mutable) || (t.kind === 'adt' && t.def.builtin === 'Box')) {
    t = normalize(shallow(t.kind === 'ref' ? t.target : t.args[0]));
  }
  return t.kind === 'dyn' && iterationBound(t)?.trait.builtin === 'Iterator' ? t : undefined;
}
