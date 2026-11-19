import { normalize } from './infer';
import type { Answer } from './traits';
import { shallow, type Type } from './types';

/** What an iterator's shape gives: taking from the back (`DoubleEndedIterator`) and its length (`ExactSizeIterator`). */
type Capability = 'back' | 'exact';

/** The capabilities of std's iterators that take no other iterator. */
const LEAF_SHAPES: Record<string, Capability[]> = {
  SliceIterShape: ['back', 'exact'],
  SliceIterMutShape: ['back', 'exact'],
  VecIntoIterShape: ['back', 'exact'],
  ArrayIntoIterShape: ['back', 'exact'],
  VecDrainShape: ['back', 'exact'],
  BinaryHeapDrainShape: ['back', 'exact'],
  StringDrainShape: ['back'],
  WindowsShape: ['back', 'exact'],
  ChunksShape: ['back', 'exact'],
  RChunksShape: ['back', 'exact'],
  ChunksExactShape: ['back', 'exact'],
  CharsShape: ['back'],
  BytesShape: ['back', 'exact'],
  CharIndicesShape: ['back'],
  SplitWhitespaceShape: ['back'],
  LinesShape: ['back'],
  SplitNShape: [],
  OptionIterShape: ['back', 'exact'],
  SetOpShape: [],
  CaseMappingShape: ['back', 'exact'],
  RepeatShape: ['back'],
  RepeatNShape: ['back', 'exact'],
  OnceShape: ['back', 'exact'],
  EmptyShape: ['back', 'exact'],
  FromFnShape: [],
  SuccessorsShape: [],
  MapWhileShape: [],
  TakeWhileShape: [],
  SkipWhileShape: [],
  ScanShape: [],
  CycleShape: [],
  RangeFromShape: [],
};

/** Adapters that have what the iterator they adapt has. */
const SAME_AS_INNER = new Set([
  'MapShape',
  'FuseShape',
  'InspectShape',
  'CopiedShape',
  'ClonedShape',
  'ByRefShape',
  'PeekableShape',
  'RevShape',
]);

/** Adapters that know their length when the inner one does, and take from the back when it does both. */
const COUNTING = new Set(['EnumerateShape', 'TakeShape', 'SkipShape', 'StepByShape']);

const RANGE_EXACT: Record<string, ReadonlySet<string>> = {
  RangeShape: new Set(['u8', 'u16', 'u32', 'usize', 'i8', 'i16', 'i32', 'isize']),
  RangeInclusiveShape: new Set(['u8', 'u16', 'i8', 'i16']),
};

/** Whether an iterator (an `IterImpl`, a `&mut` one, or a shape) has a capability, as std's impls decide. */
// code-gauge-allow functionCognitiveComplexity 24 -- Follows std's impls of the iterator traits case by case.
export function iteratorCapability(type: Type, capability: Capability): Answer {
  const t = normalize(shallow(type));
  if (t.kind === 'var') return 'unknown';
  if (t.kind === 'ref') return t.mutable ? iteratorCapability(t.target, capability) : 'no';
  if (t.kind !== 'adt') return 'no';
  if (t.def.builtin === 'Iter') return iteratorCapability(t.args[1], capability);
  const name = t.def.name;
  const leaf = LEAF_SHAPES[name];
  if (leaf) return leaf.includes(capability) ? 'yes' : 'no';
  if (name.startsWith('HashMap') || name.startsWith('HashSet')) return capability === 'exact' ? 'yes' : 'no';
  if (/^(?:BTreeMap|BTreeSet|VecDeque|BinaryHeap)/.test(name)) {
    return capability === 'back' || !name.endsWith('RangeShape') ? 'yes' : 'no';
  }
  if (name === 'RangeShape' || name === 'RangeInclusiveShape') {
    return capability === 'back' ? 'yes' : rangeExact(name, t.args[0]);
  }
  if (name === 'SplitShape') return capability === 'back' ? doubleEndedSearcher(t.args[0]) : 'no';
  return adapterCapability(name, t.args, capability);
}

/** The capabilities of an adapter, from those of the iterators it adapts. */
function adapterCapability(name: string, args: Type[], capability: Capability): Answer {
  const inner = (index: number, cap: Capability = capability): Answer => iteratorCapability(args[index], cap);
  if (SAME_AS_INNER.has(name)) return inner(0);
  if (COUNTING.has(name)) return capability === 'exact' ? inner(0) : both(inner(0, 'back'), inner(0, 'exact'));
  switch (name) {
    case 'FilterShape':
    case 'FilterMapShape': {
      return capability === 'back' ? inner(0) : 'no';
    }
    case 'FlatMapShape':
    case 'FlattenShape':
    case 'ChainShape': {
      return capability === 'back' ? both(inner(0), inner(1)) : 'no';
    }
    case 'ZipShape': {
      const exact = both(inner(0, 'exact'), inner(1, 'exact'));
      return capability === 'exact' ? exact : both(exact, both(inner(0, 'back'), inner(1, 'back')));
    }
    default: {
      return 'no';
    }
  }
}

/** Whether a range of integers of a type knows its length, which std gives only to narrow ones. */
function rangeExact(name: string, idx: Type): Answer {
  const t = normalize(shallow(idx));
  // An integer literal of no other type is an `i32`.
  if (t.kind === 'var') return t.v.literal === 'int' ? (RANGE_EXACT[name].has('i32') ? 'yes' : 'no') : 'unknown';
  return t.kind === 'int' && RANGE_EXACT[name].has(t.name) ? 'yes' : 'no';
}

function both(a: Answer, b: Answer): Answer {
  if (a === 'no' || b === 'no') return 'no';
  return a === 'unknown' || b === 'unknown' ? 'unknown' : 'yes';
}

/** Whether a pattern also searches from the back (`char`, a closure, chars), which `&str` patterns do not. */
export function doubleEndedSearcher(type: Type): Answer {
  const t = normalize(shallow(type));
  if (t.kind === 'var') return 'unknown';
  if (t.kind === 'char' || t.kind === 'closure' || t.kind === 'fn') return 'yes';
  if (isChars(t)) return 'yes';
  return t.kind === 'ref' && isChars(t.target) ? 'yes' : 'no';
}

function isChars(type: Type): boolean {
  const t = normalize(shallow(type));
  return (t.kind === 'array' || t.kind === 'slice') && normalize(shallow(t.elem)).kind === 'char';
}
