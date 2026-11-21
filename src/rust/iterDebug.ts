import { type DebugPart, list, rangeText, structText, tupleText, type WriteChunk } from './debugText';
import { normalize } from './infer';
import { callableSignature, ref, shallow, type Type } from './types';
import { DONE, type IterValue, type RangeValue, type Value } from './values';

/** Writes `{:?}` of a value of a type at a nesting depth. */
export type DebugValue = (value: Value, type: Type, indent: number | undefined, write?: WriteChunk) => string;

/** The iterators whose remaining elements std writes in a tuple struct of that name (`Iter([1, 2])`). */
const LEAF_NAMES: Record<string, string> = {
  SliceIterShape: 'Iter',
  SliceIterMutShape: 'IterMut',
  VecIntoIterShape: 'IntoIter',
  ArrayIntoIterShape: 'IntoIter',
  VecDrainShape: 'Drain',
  BinaryHeapIterShape: 'Iter',
  BinaryHeapIntoIterShape: 'IntoIter',
  VecDequeIntoIterShape: 'IntoIter',
  CharsShape: 'Chars',
};

/** Adapters that std writes as a struct of the iterator they adapt (`Map { iter: .. }`). */
const ADAPTER_NAMES: Record<string, string> = {
  MapShape: 'Map',
  FilterShape: 'Filter',
  RevShape: 'Rev',
  EnumerateShape: 'Enumerate',
  TakeShape: 'Take',
  SkipShape: 'Skip',
  PeekableShape: 'Peekable',
  StepByShape: 'StepBy',
  CopiedShape: 'Copied',
  ClonedShape: 'Cloned',
  FuseShape: 'Fuse',
  ChainShape: 'Chain',
};

/** The maps' and sets' iterators, which std writes as a list of their remaining elements. */
const COLLECTION =
  /^(?:(?:HashMap|BTreeMap|HashSet|BTreeSet)(?:Iter|IterMut|Keys|Values|ValuesMut|IntoIter|IntoKeys|IntoValues|Drain)|BTreeMapRange)Shape$/;

/** The iterators whose natives say how `{:?}` writes them, with the state std shows. */
const DESCRIBED = new Set([
  'CharIndicesShape',
  'WindowsShape',
  'SliceSplitShape',
  'SliceSplitNShape',
  'ChunkByShape',
  'ChunksShape',
  'RChunksShape',
  'ChunksExactShape',
  'RChunksExactShape',
  'OptionIterShape',
  'RepeatShape',
  'RepeatWithShape',
  'EscapeDefaultShape',
  'RepeatNShape',
  'OnceShape',
  'EmptyShape',
  'FromFnShape',
  'SuccessorsShape',
  'SetOpShape',
  'VecDequeIterShape',
  'VecDequeIterMutShape',
  'VecDequeIntoIterShape',
  'VecDequeDrainShape',
  'StringDrainShape',
  'BTreeSetRangeShape',
  'BinaryHeapDrainShape',
  'LinesShape',
  'SplitWhitespaceShape',
]);

/** Adapters whose natives say how `{:?}` writes them, when what they adapt has `{:?}`. */
const DESCRIBED_ADAPTERS = new Set([
  'FilterMapShape',
  'InspectShape',
  'MapWhileShape',
  'TakeWhileShape',
  'SkipWhileShape',
  'ScanShape',
  'CycleShape',
  'FlattenShape',
  'FlatMapShape',
]);

/** Sets how `{:?}` writes an iterator, as std's `Debug` impl of its type does. */
export function described(
  iter: IterValue,
  describe: (show: DebugValue, item: Type, target: IterValue) => DebugPart
): IterValue {
  iter.debug = (show, item) => describe(show, item, iter);
  const { fork } = iter;
  if (fork) {
    iter.fork = () => {
      const copy = fork();
      return copy.debug ? copy : described(copy, describe);
    };
  }
  return iter;
}

/** A struct of an iterator's fields (`Windows { v: [1, 2], size: 2 }`). */
export function fieldsPart(name: string, fields: [string, DebugPart][]): DebugPart {
  return (indent, write) => structText(name, fields, indent, false, write);
}

/** A tuple struct of parts (`Drain([1, 2])`). */
export function tuplePart(name: string, parts: DebugPart[]): DebugPart {
  return (indent, write) => tupleText(name, parts, indent, write);
}

/** A list of values of a type (`[1, 2]`). */
export function listPart(values: Value[], type: Type, show: DebugValue): DebugPart {
  return (indent, write) =>
    list(
      '[',
      ']',
      values.map((value) => (depth, sink) => show(value, type, depth, sink)),
      indent,
      write
    );
}

/** `Some(..)` of a part, or `None`. */
export function optionPart(part: DebugPart | undefined): DebugPart {
  return part ? tuplePart('Some', [part]) : () => 'None';
}

/** A number, as a field (`size: 2`). */
export function numberPart(value: number | bigint | boolean): DebugPart {
  return () => String(value);
}

/** Whether this interpreter writes `{:?}` of iterators of a shape as std does. */
export function supportsDebug(shape: Type): boolean {
  const t = normalize(shallow(shape));
  if (t.kind !== 'adt') return false;
  const name = t.def.name;
  if (LEAF_NAMES[name] || COLLECTION.test(name) || DESCRIBED.has(name) || name === 'BytesShape') return true;
  if (name === 'SplitShape' || name === 'SplitNShape') return patternHasDebug(t.args[0]);
  if (name === 'ZipShape') return supportsDebug(t.args[0]) && supportsDebug(t.args[1]);
  if (DESCRIBED_ADAPTERS.has(name) || name === 'ByRefShape') return supportsDebug(t.args[0]);
  if (name === 'RangeShape' || name === 'RangeInclusiveShape' || name === 'RangeFromShape') return true;
  if (name === 'ChainShape') return supportsDebug(t.args[0]) && supportsDebug(t.args[1]);
  return ADAPTER_NAMES[name] !== undefined && supportsDebug(t.args[0]);
}

/**
 * The types whose `Debug` the `{:?}` of an iterator needs: those of the items that the iterators it writes hold. An
 * adapter writes the iterator it adapts, so its own items matter only where it keeps one (`Peekable`).
 */
export function debugOperands(item: Type, shape: Type): Type[] {
  const t = normalize(shallow(shape));
  if (t.kind !== 'adt') return [item];
  const name = t.def.name;
  // These write no item: a closure has no `{:?}` to ask for.
  if (name === 'FromFnShape' || name === 'RepeatWithShape') return [];
  if (name === 'ByRefShape') return debugOperands(item, t.args[0]);
  if (name === 'ZipShape') {
    const pair = normalize(shallow(item));
    const [first, second] = pair.kind === 'tuple' ? pair.elems : [item, item];
    return [...debugOperands(first, t.args[0]), ...debugOperands(second, t.args[1])];
  }
  if (!ADAPTER_NAMES[name] && !DESCRIBED_ADAPTERS.has(name)) return [item];
  return [...debugOperands(adaptedItem(name, t, item), t.args[0]), ...keptOperands(name, t, item)];
}

/** What an adapter writes besides the iterator it adapts: a second iterator, items it holds, or its state. */
function keptOperands(name: string, shape: Type & { kind: 'adt' }, item: Type): Type[] {
  if (name === 'ChainShape') return debugOperands(item, shape.args[1]);
  if (name === 'ScanShape') return [shape.args[1]];
  // `FlatMap` and `Flatten` hold the iterators of what they adapt yields, which yield their own items.
  if (name === 'FlatMapShape' || name === 'FlattenShape') return debugOperands(item, shape.args[1]);
  return name === 'PeekableShape' ? [item] : [];
}

/** Whether std's searcher for a pattern of a type has `{:?}`, which a closure's does not. */
function patternHasDebug(pattern: Type): boolean {
  const kind = normalize(shallow(pattern)).kind;
  return kind !== 'closure' && kind !== 'fn' && kind !== 'var';
}

/** `{:?}` of an iterator of `item`s of a shape, as std's `Debug` impls of its iterator types write it. */
// code-gauge-allow functionCognitiveComplexity 24 -- One case per iterator type of std.
// code-gauge-allow functionNcss 56 -- One case per iterator type of std.
export function iteratorDebug(
  iter: IterValue,
  item: Type,
  shape: Type,
  debug: DebugValue,
  indent: number | undefined,
  write?: WriteChunk
): string {
  const t = normalize(shallow(shape)) as Type & { kind: 'adt' };
  const name = t.def.name;
  if (iter.debug) return iter.debug(debug, item)(indent, write);
  if (name === 'ByRefShape') return iteratorDebug(iter, item, t.args[0], debug, indent, write);
  const rest: DebugPart = (inner, sink) => listPart(iter.rest?.() ?? [], item, debug)(inner, sink);
  if (LEAF_NAMES[name]) return tupleText(LEAF_NAMES[name], [rest], indent, write);
  if (COLLECTION.test(name)) return rest(indent, write);
  // A `BTreeSet` is a `BTreeMap` of its elements to a zero-sized value, which its `Range` shows.
  if (name === 'BTreeSetRangeShape') {
    const entries = (iter.rest?.() ?? []).map((value) =>
      tuplePart('', [(depth, sink) => debug(value, item, depth, sink), () => 'SetValZST'])
    );
    return structText('Range', [['iter', (inner, sink) => list('[', ']', entries, inner, sink)]], indent, false, write);
  }
  if (name === 'BinaryHeapDrainShape')
    return structText('Drain', [['iter', tuplePart('Drain', [rest])]], indent, false, write);
  if (name === 'BytesShape') {
    const copied = fieldsPart('Copied', [['it', tuplePart('Iter', [rest])]]);
    return tupleText('Bytes', [copied], indent, write);
  }
  if (name === 'RangeShape' || name === 'RangeInclusiveShape' || name === 'RangeFromShape') {
    return rangeText(iter.roots[0] as RangeValue, (value) => debug(value, item, indent, write), write);
  }
  const source = iter.roots[0] as IterValue;
  const state = iter.roots[1] as Record<string, unknown>;
  const innerItem = adaptedItem(name, t, item);
  const inner: DebugPart = (depth, sink) => iteratorDebug(source, innerItem, t.args[0], debug, depth, sink);
  const fields: [string, DebugPart][] = [];
  switch (name) {
    case 'CopiedShape':
    case 'ClonedShape': {
      fields.push(['it', inner]);
      break;
    }
    case 'FuseShape': {
      // std's iterators are fused, so `Fuse` keeps the iterator after it ends.
      fields.push(['iter', tuplePart('Some', [inner])]);
      break;
    }
    case 'ChainShape': {
      const second = state.second as IterValue;
      const b: DebugPart = (depth, sink) => iteratorDebug(second, item, t.args[1], debug, depth, sink);
      fields.push(['a', state.firstDone ? () => 'None' : tuplePart('Some', [inner])]);
      fields.push(['b', tuplePart('Some', [b])]);
      break;
    }
    default: {
      fields.push(['iter', inner]);
    }
  }
  if (name === 'EnumerateShape') fields.push(['count', number(state.index)]);
  if (name === 'TakeShape') fields.push(['n', number(state.left)]);
  if (name === 'SkipShape') fields.push(['n', number(state.toSkip)]);
  if (name === 'StepByShape') {
    fields.push(['step_minus_one', number((state.step as bigint) - 1n)], ['first_take', number(state.first)]);
  }
  if (name === 'PeekableShape') fields.push(['peeked', peekedPart(source, item, debug)]);
  return structText(ADAPTER_NAMES[name], fields, indent, false, write);
}

function number(value: unknown): DebugPart {
  return () => String(value);
}

/** Where the items of the iterator an adapter adapts are found: a parameter of the closure the adapter calls. */
const CALLBACK_INPUTS: Record<string, { shapeArg: number; param: number }> = {
  MapShape: { shapeArg: 1, param: 0 },
  FilterMapShape: { shapeArg: 1, param: 0 },
  MapWhileShape: { shapeArg: 1, param: 0 },
  FlatMapShape: { shapeArg: 2, param: 0 },
  ScanShape: { shapeArg: 2, param: 1 },
};

/** The items of the iterator an adapter adapts. */
function adaptedItem(name: string, shape: Type & { kind: 'adt' }, item: Type): Type {
  const t = normalize(shallow(item));
  const callback = CALLBACK_INPUTS[name];
  if (callback) return callableSignature(shape.args[callback.shapeArg])?.params[callback.param] ?? item;
  if (name === 'EnumerateShape' && t.kind === 'tuple') return t.elems[1];
  if (name === 'CopiedShape' || name === 'ClonedShape') return ref(item);
  return item;
}

/** `Peekable`'s `peeked`: `None` before `peek`, then `Some` of what it saw. */
function peekedPart(source: IterValue, item: Type, debug: DebugValue): DebugPart {
  const [peeked] = source.peeked ?? [];
  if (source.peeked === undefined || source.peeked.length === 0) return () => 'None';
  if (peeked === DONE) return tuplePart('Some', [() => 'None']);
  return tuplePart('Some', [tuplePart('Some', [(depth, sink) => debug(peeked, item, depth, sink)])]);
}
