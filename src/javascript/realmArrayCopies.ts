import type { RealmBuilder } from './realm';
import { arrayMethod, buildArray, relativeIndex, sortComparison, toInteger } from './realmArrays';
import type { Value } from './values';

/**
 * Defines the methods that change a copy of the array instead of the array (`toSorted`, `toReversed`, `toSpliced`, and
 * `with`) and `copyWithin`, each following its algorithm in the ECMAScript specification. The copies read absent
 * elements as undefined.
 */
export function defineArrayCopies(builder: RealmBuilder): void {
  defineReorderedCopies(builder);
  defineSplices(builder);
}

// code-gauge-allow functionCognitiveComplexity 21 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function defineReorderedCopies(builder: RealmBuilder): void {
  arrayMethod(builder, 'toReversed', 0, ({ runtime }, ops) => {
    const { length } = ops;
    runtime.scan(length);
    return buildArray(runtime, (result) => {
      for (let index = 0; index < length; index++) result.set(index, ops.get(length - index - 1));
    });
  });
  arrayMethod(builder, 'toSorted', 1, (call, ops) => {
    const compare = sortComparison(call);
    const { runtime } = call;
    const { length } = ops;
    return buildArray(runtime, (result) => {
      for (let index = 0; index < length; index++) result.set(index, ops.get(index));
      runtime.scan(length * Math.ceil(Math.log2(length + 1)));
      // The host's sort places undefined last without calling the comparison, as SortCompare does.
      const sorted = (result.array.elements as Value[]).toSorted(compare);
      for (const [index, value] of sorted.entries()) result.set(index, value);
    });
  });
  arrayMethod(builder, 'with', 2, ({ runtime, args }, ops) => {
    const { length } = ops;
    const relative = toInteger(runtime, args[0]);
    const actual = relative >= 0 ? relative : length + relative;
    if (actual >= length || actual < 0) runtime.throwError('RangeError', `Invalid index : ${String(relative)}`);
    runtime.scan(length);
    return buildArray(runtime, (result) => {
      for (let index = 0; index < length; index++) result.set(index, index === actual ? args[1] : ops.get(index));
    });
  });
}

// code-gauge-allow functionCognitiveComplexity 19 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
// code-gauge-allow functionNcss 38 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function defineSplices(builder: RealmBuilder): void {
  arrayMethod(builder, 'toSpliced', 2, ({ runtime, args }, ops) => {
    const { length } = ops;
    const start = relativeIndex(runtime, args[0], length, 0);
    const items = args.slice(2);
    let skipCount = 0;
    if (args.length === 1) skipCount = length - start;
    else if (args.length > 1) skipCount = Math.min(Math.max(toInteger(runtime, args[1]), 0), length - start);
    const newLength = length + items.length - skipCount;
    if (newLength > Number.MAX_SAFE_INTEGER) runtime.throwError('TypeError', 'Invalid array length');
    runtime.scan(newLength);
    return buildArray(runtime, (result) => {
      let next = 0;
      for (let index = 0; index < start; index++) result.set(next++, ops.get(index));
      for (const item of items) result.set(next++, item);
      for (let index = start + skipCount; index < length; index++) result.set(next++, ops.get(index));
    });
  });
  arrayMethod(builder, 'copyWithin', 2, ({ runtime, args }, ops) => {
    const { length } = ops;
    let to = relativeIndex(runtime, args[0], length, 0);
    let from = relativeIndex(runtime, args[1], length, 0);
    const final = relativeIndex(runtime, args[2], length, length);
    let count = Math.min(final - from, length - to);
    runtime.scan(Math.max(count, 0));
    let direction = 1;
    if (from < to && to < from + count) {
      direction = -1;
      from += count - 1;
      to += count - 1;
    }
    for (; count > 0; count--, from += direction, to += direction) ops.move(from, to);
    return ops.array;
  });
}
