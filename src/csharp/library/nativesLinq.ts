// code-gauge-allow-file fileNcss -- The nativesLinq module keeps one stage of the C# interpreter together.
import { CsDecimal } from '../decimal';
import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { arithmetic, decimalArithmetic, PendingException } from '../numeric';
import { runtimeTypeName } from '../objects';
import type { NativeState } from '../runtime';
import { type NamedType, nullableUnderlying, specialOf, type SpecialType, type Type } from '../types';
import { copyValue, CsArray, CsBox, CsObject, CsStruct, isString, stringText, type Value } from '../values';
import { isEnumerableState, iterate, LibraryEnumerator } from './iteration';
import { comparisonOf, type Equality, equalityOf, HashState, ListState, newList } from './nativesCollections';
import { stableSort } from './sort';
import {
  arrayOfBuffer,
  bufferedElements,
  evaluatorOf,
  fail,
  failNull,
  failOutOfRange,
  libraryType,
  newArray,
  refOf,
  stepMeter,
} from './support';

/** The message of LINQ's argument errors, which name no value. */
const OUT_OF_RANGE = 'Specified argument was out of the range of valid values.';
const ENUMERABLE = 'System.Linq.Enumerable';
const noElements = (): PendingException =>
  new PendingException('System.InvalidOperationException', 'Sequence contains no elements');
const noMatch = (): PendingException =>
  new PendingException('System.InvalidOperationException', 'Sequence contains no matching element');

/** A deferred query, which runs its source again each time it is enumerated. */
export class QueryState implements NativeState {
  constructor(
    readonly run: () => Iterable<Value>,
    readonly elementType: Type,
    /** The name of .NET's iterator class, which `ToString()` prints. */
    readonly displayName: string,
    readonly holds: Value[],
    /** For an ordered query, its sort keys, which `ThenBy` extends. */
    readonly ordering?: { source: Value; keys: SortKey[] }
  ) {}

  /** What .NET's iterator class implements beyond `IEnumerable<T>`, which `Select`, `Skip`, and `Take` look for. */
  shape?: QueryShape;
  /** For `Skip` and `Take`, the items skipped and taken from the source, which tell the count without enumerating. */
  bounds?: { skipped: number; taken: number | undefined };

  enumerate(): Iterable<Value> {
    return this.run();
  }

  references(): Value[] {
    return this.holds;
  }
}

/**
 * An iterator that is an `IList<T>`: `Range` and `Repeat`, which `Skip` and `Take` narrow to another such iterator,
 * or `Skip` and `Take` of a list.
 */
type QueryShape =
  | { kind: 'range'; start: number; count: number }
  | { kind: 'repeat'; element: Value; count: number }
  | { kind: 'list' };

interface SortKey {
  select: (value: Value) => Value;
  compare: (a: Value, b: Value) => number;
  descending: boolean;
}

function query(
  call: NativeCall,
  elementType: Type,
  displayName: string,
  holds: Value[],
  run: () => Iterable<Value>,
  ordering?: QueryState['ordering']
): CsObject {
  const object = new CsObject(libraryType(call, 'System.Linq.Internal.Iterator', [elementType]), []);
  object.native = new QueryState(run, elementType, displayName, holds, ordering);
  return object;
}

/** The display name of a LINQ iterator, such as `System.Linq.Enumerable+RangeIterator\`1[System.Int32]`. */
function iteratorName(name: string, types: Type[]): string {
  return `System.Linq.Enumerable+${name}\`${types.length}[${types.map(runtimeTypeName).join(',')}]`;
}

/**
 * The name of a LINQ iterator that the C# compiler generates from a `yield` method, numbered as in .NET 10's
 * System.Linq, such as `System.Linq.Enumerable+<SkipWhileIterator>d__281\`1[System.Int32]`.
 */
function generatedIterator(call: NativeCall, method: string, number: number): string {
  return iteratorName(`<${method}>d__${number}`, call.typeArgs);
}

/** Whether a sequence is an `IEnumerable<T>` of a type, which `Cast` and `OfType` return as they are. */
function isEnumerableOf(call: NativeCall, items: Value, type: Type): boolean {
  return evaluatorOf(call).isInstanceOf(items, libraryType(call, 'System.Collections.Generic.IEnumerable', [type]));
}

/** Whether a sequence is a non-generic `ICollection`, as .NET's collections other than HashSet and the iterators are. */
function isNonGenericCollection(call: NativeCall, items: Value): boolean {
  if (items instanceof CsArray) return true;
  if (!(items instanceof CsObject)) return false;
  const { native } = items;
  if (native instanceof QueryState || (native instanceof HashState && native.valueType === undefined)) return false;
  if (native !== undefined) return true;
  return evaluatorOf(call).isInstanceOf(items, libraryType(call, 'System.Collections.ICollection'));
}

/** Whether a source is an `IList<T>`, for which .NET's iterators have their own classes. */
function isList(value: Value): boolean {
  return isArrayOrList(value) || shapeOf(value) !== undefined;
}

/** Whether a source is an array or a `List<T>`, which `Where` specializes, unlike the LINQ iterators that are lists. */
function isArrayOrList(value: Value): boolean {
  return value instanceof CsArray || (value instanceof CsObject && value.native instanceof ListState);
}

function shapeOf(value: Value): QueryShape | undefined {
  return value instanceof CsObject && value.native instanceof QueryState ? value.native.shape : undefined;
}

function isEmptyArray(value: Value): boolean {
  return value instanceof CsArray && value.values.length === 0;
}

/** `Range` or `Repeat`, which an empty count makes an empty array. */
function fixedSequence(call: NativeCall, shape: Extract<QueryShape, { kind: 'range' | 'repeat' }>): Value {
  const elementType = shape.kind === 'range' ? libraryType(call, 'System.Int32') : call.typeArgs[0];
  if (shape.count <= 0) return newArray(call, elementType, []);
  const object = query(
    call,
    elementType,
    iteratorName(shape.kind === 'range' ? 'RangeIterator' : 'RepeatIterator', [elementType]),
    shape.kind === 'repeat' ? [shape.element] : [],
    function* () {
      for (let index = 0; index < shape.count; index++)
        yield shape.kind === 'range' ? shape.start + index : shape.element;
    }
  );
  (object.native as QueryState).shape = shape;
  return object;
}

/** `Skip`, which returns a LINQ iterator itself for no count, and narrows `Range` and `Repeat`. */
function skip(call: NativeCall, items: Value, count: number): Value {
  const all = source(call, items);
  if (isEmptyArray(items)) return newArray(call, call.typeArgs[0], []);
  if (count <= 0 && items instanceof CsObject && items.native instanceof QueryState) return items;
  const shape = shapeOf(items);
  if (shape?.kind === 'range')
    return fixedSequence(call, { kind: 'range', start: shape.start + count, count: shape.count - count });
  if (shape?.kind === 'repeat') return fixedSequence(call, { ...shape, count: shape.count - count });
  return skipTake(call, items, all, Math.max(count, 0), undefined);
}

/** .NET's `IListSkipTakeIterator` or `IEnumerableSkipTakeIterator` over the items from `skipped` on, `taken` of them. */
function skipTake(
  call: NativeCall,
  items: Value,
  all: Iterable<Value>,
  skipped: number,
  taken: number | undefined
): Value {
  const isListSource = isList(items);
  const object = query(
    call,
    call.typeArgs[0],
    iteratorName(isListSource ? 'IListSkipTakeIterator' : 'IEnumerableSkipTakeIterator', [call.typeArgs[0]]),
    [items],
    function* () {
      if (taken !== undefined && taken <= 0) return;
      let index = 0;
      // Stopping right after the last item taken keeps a lazy source from producing one more.
      for (const item of all) {
        if (index++ < skipped) continue;
        yield item;
        if (taken !== undefined && index >= skipped + taken) return;
      }
    }
  );
  const state = object.native as QueryState;
  if (isListSource) state.shape = { kind: 'list' };
  state.bounds = { skipped, taken };
  return object;
}

/**
 * The count that `TryGetNonEnumeratedCount` finds without enumerating, as .NET's collections and the LINQ iterators
 * that know theirs give it, or undefined.
 */
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one kind of .NET iterator that knows its count.
function cheapCount(call: NativeCall, items: Value): number | undefined {
  if (items instanceof CsArray) return items.values.length;
  if (!(items instanceof CsObject) || items.native === undefined) return undefined;
  const { native } = items;
  if (!(native instanceof QueryState)) return isEnumerableState(native) ? [...native.enumerate()].length : undefined;
  if (native.shape?.kind === 'range' || native.shape?.kind === 'repeat') return native.shape.count;
  if (native.ordering) return cheapCount(call, native.ordering.source);
  const [first, second] = native.holds;
  if (native.bounds) {
    const total = cheapCount(call, first);
    if (total === undefined) return undefined;
    const rest = Math.max(0, total - native.bounds.skipped);
    return native.bounds.taken === undefined ? rest : Math.min(rest, native.bounds.taken);
  }
  const name = native.displayName;
  if (name.includes('+ReverseIterator') || name.includes('+CastICollectionIterator')) return cheapCount(call, first);
  if (name.includes('+AppendPrepend1Iterator')) {
    const count = cheapCount(call, first);
    return count === undefined ? undefined : count + 1;
  }
  if (name.includes('+Concat2Iterator')) {
    const [a, b] = [cheapCount(call, first), cheapCount(call, second)];
    return a === undefined || b === undefined ? undefined : a + b;
  }
  return undefined;
}

function delegateCall(call: NativeCall, delegate: Value, name: string): (...args: Value[]) => Value {
  if (delegate === undefined) failNull(name);
  const evaluator = evaluatorOf(call);
  return (...args) => evaluator.invokeDelegate(call.frame, delegate, args, undefined);
}

/**
 * `Join` and `GroupJoin`: each outer element with the inner elements whose key equals its own, or none for a null key,
 * which `results` turns into the query's elements.
 */
function joinQuery(
  call: NativeCall,
  [outer, inner, outerKey, innerKey, resultSelector]: Value[],
  name: string,
  results: (item: Value, group: Value[] | undefined, resultOf: (...args: Value[]) => Value) => Iterable<Value>
): Value {
  const outerKeyOf = delegateCall(call, outerKey, 'outerKeySelector');
  const innerKeyOf = delegateCall(call, innerKey, 'innerKeySelector');
  const resultOf = delegateCall(call, resultSelector, 'resultSelector');
  const outers = source(call, outer, 'outer');
  const inners = source(call, inner, 'inner');
  return query(call, call.typeArgs[3], name, [outer, inner], function* () {
    const keyType = call.typeArgs[2];
    const equality = equalityOf(call, undefined, keyType);
    // .NET reads the inner sequence only once the outer one has an element.
    let groups: { key: Value; elements: Value[] }[] | undefined;
    for (const item of outers) {
      groups ??= groupsOf(call, inners, innerKeyOf, (element) => element, undefined, keyType);
      const key = outerKeyOf(item);
      const group =
        key === undefined
          ? undefined
          : groups.find((candidate) => candidate.key !== undefined && equality.equals(candidate.key, key));
      yield* results(item, group?.elements, resultOf);
    }
  });
}

/**
 * A query of `Where`, `SkipWhile`, or `TakeWhile`, whose predicate may also take each element's index, counted from
 * the start of each enumeration.
 */
function predicateQuery(
  call: NativeCall,
  [items, predicate]: Value[],
  nameOf: (withIndex: boolean) => string,
  elements: (all: Iterable<Value>, matches: (item: Value) => boolean) => Generator<Value>
): Value {
  const test = delegateCall(call, predicate, 'predicate');
  const withIndex = (call.method.parameters[1].type as NamedType).args.length === 3;
  const all = source(call, items);
  return query(call, call.typeArgs[0], nameOf(withIndex), [items], () => {
    let index = 0;
    return elements(all, (item) => Boolean(withIndex ? test(item, index++) : test(item)));
  });
}

function source(call: NativeCall, value: Value, name = 'source'): Iterable<Value> {
  if (value === undefined) failNull(name);
  return { [Symbol.iterator]: () => iterate(call, value, name) };
}

/** The element count of a collection that knows it without enumerating, as `Count()` reads it. */
function knownCount(value: Value): number | undefined {
  if (value instanceof CsArray) return value.values.length;
  if (isString(value)) return stringText(value).length;
  if (value instanceof CsObject) {
    const native = value.native;
    if (native instanceof ListState) return native.items.length;
    if (native instanceof HashState) return native.count;
  }
  return undefined;
}

interface Accumulator {
  kind: SpecialType;
  add: (a: Value, b: Value) => Value;
  zero: Value;
}

function accumulatorOf(type: Type): Accumulator {
  const special = (specialOf(nullableUnderlying(type) ?? type) ?? 'int') as SpecialType;
  switch (special) {
    case 'long': {
      return { kind: special, zero: 0n, add: (a, b) => arithmetic('+', 'long', a as bigint, b as bigint, true) };
    }
    case 'decimal': {
      return {
        kind: special,
        zero: CsDecimal.ZERO,
        add: (a, b) => decimalArithmetic('+', a as CsDecimal, b as CsDecimal),
      };
    }
    case 'double': {
      return { kind: special, zero: 0, add: (a, b) => (a as number) + (b as number) };
    }
    case 'float': {
      return { kind: special, zero: 0, add: (a, b) => (a as number) + (b as number) };
    }
    default: {
      return { kind: 'int', zero: 0, add: (a, b) => arithmetic('+', 'int', a as number, b as number, true) };
    }
  }
}

/** The values a numeric aggregate reads: the elements, or what a selector makes of them. */
function selected(call: NativeCall, args: Value[]): Iterable<Value> {
  const items = source(call, args[0]);
  if (args.length < 2) return items;
  const select = delegateCall(call, args[1], 'selector');
  return (function* () {
    for (const item of items) yield select(item);
  })();
}

/** The type that a numeric aggregate's values have, from the method's return type or its selector's. */
function valueType(call: NativeCall): Type {
  const parameter = call.method.parameters[1]?.type ?? call.method.parameters[0].type;
  const resolved = call.frame.resolve(parameter);
  if (resolved.kind === 'named' && resolved.symbol.kind === 'delegate') return resolved.args.at(-1) as Type;
  if (resolved.kind === 'named') return resolved.args[0];
  return call.method.returnType;
}

function sum(call: NativeCall, args: Value[]): Value {
  const type = valueType(call);
  const accumulator = accumulatorOf(type);
  let total = accumulator.zero;
  const isNullable = nullableUnderlying(type) !== undefined;
  for (const value of selected(call, args)) {
    if (value === undefined && isNullable) continue;
    total = accumulator.add(total, value);
  }
  if (accumulator.kind === 'float') return Math.fround(total as number);
  return total;
}

// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
function average(call: NativeCall, args: Value[]): Value {
  const type = valueType(call);
  const special = specialOf(nullableUnderlying(type) ?? type);
  const isNullable = nullableUnderlying(type) !== undefined;
  let count = 0;
  let total: Value = special === 'decimal' ? CsDecimal.ZERO : special === 'long' || special === 'int' ? 0n : 0;
  for (const value of selected(call, args)) {
    if (value === undefined && isNullable) continue;
    count++;
    if (special === 'decimal') total = decimalArithmetic('+', total as CsDecimal, value as CsDecimal);
    else if (special === 'long' || special === 'int')
      total = arithmetic('+', 'long', total as bigint, BigInt(value as number | bigint), true);
    else total = (total as number) + (value as number);
  }
  if (count === 0) {
    if (isNullable) return undefined;
    throw noElements();
  }
  if (special === 'decimal') return decimalArithmetic('/', total as CsDecimal, CsDecimal.fromBigInt(BigInt(count)));
  if (special === 'float') return Math.fround((total as number) / count);
  return Number(total) / count;
}

/** The element type of an array or a library collection, whose value-type elements it holds unboxed. */
function elementTypeOf(items: Value): Type | undefined {
  if (items instanceof CsArray) return items.type.element;
  const native = items instanceof CsObject ? (items.native as { elementType?: Type } | undefined) : undefined;
  return native?.elementType;
}

/** `Min` and `Max`, where NaN is the least double, null elements are skipped, and an empty sequence of a non-nullable value type throws. */
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
function extremum(call: NativeCall, args: Value[], isMax: boolean): Value {
  const type =
    call.method.typeParameters.length === 2 || (call.method.typeParameters.length === 1 && args.length === 1)
      ? call.frame.resolve(call.method.returnType)
      : valueType(call);
  const compare = comparisonOf(call, undefined);
  const canBeNull = type.kind !== 'named' || !type.symbol.isValueType || nullableUnderlying(type) !== undefined;
  let best: Value;
  let found = false;
  for (const value of selected(call, args)) {
    if (value === undefined && canBeNull) continue;
    if (typeof value === 'number' && Number.isNaN(value)) {
      if (!isMax) return value;
      if (!found) {
        best = value;
        found = true;
      }
      continue;
    }
    if (
      !found ||
      (isMax ? compare(value, best) > 0 : compare(value, best) < 0) ||
      (typeof best === 'number' && Number.isNaN(best))
    )
      best = value;
    found = true;
  }
  if (!found) {
    if (canBeNull) return undefined;
    throw noElements();
  }
  return best;
}

function extremumBy(call: NativeCall, args: Value[], isMax: boolean): Value {
  const select = delegateCall(call, args[1], 'keySelector');
  const compare = comparisonOf(call, undefined);
  let best: Value;
  let bestKey: Value;
  let found = false;
  for (const item of source(call, args[0])) {
    const key = select(item);
    if (key === undefined) continue;
    if (!found || (isMax ? compare(key, bestKey) > 0 : compare(key, bestKey) < 0)) {
      best = item;
      bestKey = key;
      found = true;
    }
  }
  if (!found) {
    const elementType = call.typeArgs[0];
    if (elementType.kind !== 'named' || !elementType.symbol.isValueType || nullableUnderlying(elementType))
      return undefined;
    throw noElements();
  }
  return best;
}

// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
function first(
  call: NativeCall,
  args: Value[],
  options: { last?: boolean; single?: boolean; orDefault?: boolean }
): Value {
  const predicate =
    args.length > 1 &&
    call.method.parameters[1].type.kind === 'named' &&
    call.method.parameters[1].type.symbol.kind === 'delegate'
      ? delegateCall(call, args[1], 'predicate')
      : undefined;
  const fallbackIndex = predicate ? 2 : 1;
  const fallback = options.orDefault
    ? args.length > fallbackIndex
      ? args[fallbackIndex]
      : evaluatorOf(call).defaultOf(call.typeArgs[0])
    : undefined;
  let result: Value;
  let found = false;
  for (const item of source(call, args[0])) {
    if (predicate && !(predicate(item) as boolean)) continue;
    if (options.single && found)
      fail(
        'System.InvalidOperationException',
        predicate ? 'Sequence contains more than one matching element' : 'Sequence contains more than one element'
      );
    result = item;
    found = true;
    if (!options.last && !options.single) break;
  }
  if (found) return result;
  if (options.orDefault) return fallback;
  throw predicate ? noMatch() : noElements();
}

/** Groups elements by key in the order their keys first appear, as `GroupBy` and `ToLookup` do. */
function groupsOf(
  call: NativeCall,
  items: Iterable<Value>,
  keyOf: (value: Value) => Value,
  elementOf: (value: Value) => Value,
  comparer: Value,
  keyType: Type | undefined = call.typeArgs[1]
): { key: Value; elements: Value[] }[] {
  const equality = equalityOf(call, comparer, keyType);
  const groups: { key: Value; elements: Value[] }[] = [];
  const index = new Map<number, { key: Value; elements: Value[] }[]>();
  for (const item of items) {
    const key = keyOf(item);
    const hash = key === undefined ? 0 : equality.hash(key);
    const bucket = index.get(hash) ?? [];
    let group = bucket.find((candidate) =>
      candidate.key === undefined ? key === undefined : key !== undefined && equality.equals(candidate.key, key)
    );
    if (!group) {
      group = { key, elements: [] };
      bucket.push(group);
      index.set(hash, bucket);
      groups.push(group);
    }
    call.frame.runtime.allocateSlots(1);
    group.elements.push(elementOf(item));
  }
  return groups;
}

function grouping(
  call: NativeCall,
  keyType: Type,
  elementType: Type,
  group: { key: Value; elements: Value[] }
): CsObject {
  const object = new CsObject(libraryType(call, 'System.Linq.Internal.Grouping', [keyType, elementType]), []);
  object.native = new GroupingState(group.key, group.elements, keyType, elementType);
  return object;
}

class GroupingState implements NativeState {
  constructor(
    readonly key: Value,
    readonly elements: Value[],
    readonly keyType: Type,
    readonly elementType: Type
  ) {}

  enumerate(): Iterable<Value> {
    return this.elements;
  }

  references(): Value[] {
    return [this.key, ...this.elements];
  }

  display(): { kind: 'array'; items: [string, Value, Type][] } {
    return { kind: 'array', items: this.elements.map((item, index) => [String(index), item, this.elementType]) };
  }
}

/** A distinct set of keys, by the default equality or a comparer. */
/** A set of the values a query has seen, each one it keeps charged against the slot limit, since a lazy source may yield without end. */
function seenSet(call: NativeCall, equality: Equality): { add(value: Value): boolean; remove(value: Value): boolean } {
  const buckets = new Map<number, Value[]>();
  const indexIn = (bucket: Value[], value: Value): number =>
    bucket.findIndex((existing) =>
      existing === undefined ? value === undefined : value !== undefined && equality.equals(existing, value)
    );
  const bucketOf = (value: Value): Value[] => {
    const hash = value === undefined ? 0 : equality.hash(value);
    let bucket = buckets.get(hash);
    if (!bucket) {
      bucket = [];
      buckets.set(hash, bucket);
    }
    return bucket;
  };
  return {
    add(value) {
      const bucket = bucketOf(value);
      if (indexIn(bucket, value) >= 0) return false;
      call.frame.runtime.allocateSlots(1);
      bucket.push(value);
      return true;
    },
    remove(value) {
      // A removal looks a bucket up without creating one, so a missing value adds nothing to the set.
      const bucket = buckets.get(value === undefined ? 0 : equality.hash(value));
      if (!bucket) return false;
      const index = indexIn(bucket, value);
      if (index < 0) return false;
      bucket.splice(index, 1);
      return true;
    },
  };
}

// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
function ordered(call: NativeCall, args: Value[], descending: boolean, isThen: boolean, keyless: boolean): CsObject {
  const [sourceValue, selector, comparer] = args;
  const previous = isThen ? ((sourceValue as CsObject).native as QueryState).ordering : undefined;
  const keySelector = keyless ? (value: Value): Value => value : delegateCall(call, selector, 'keySelector');
  const key: SortKey = {
    select: keySelector,
    compare: comparisonOf(call, keyless ? (selector as Value) : (comparer as Value)),
    descending,
  };
  const keys = [...(previous?.keys ?? []), key];
  const root = previous?.source ?? sourceValue;
  const elementType = call.typeArgs[0];
  const keyType = keyless ? elementType : call.typeArgs[1];
  return query(
    call,
    elementType,
    keyless && !isThen
      ? iteratorName('ImplicitlyStableOrderedIterator', [elementType])
      : iteratorName('OrderedIterator', [elementType, keyType]),
    [root],
    () => {
      const items = bufferedElements(call, source(call, root));
      // The keys of each level, the index array, and the sorted result are buffers of the same length, charged too.
      call.frame.runtime.allocateSlots(items.length * (keys.length + 2));
      const keyed = keys.map((sortKey) => items.map((item) => sortKey.select(item)));
      const step = stepMeter(call);
      const indices = stableSort(
        items.map((_item, index) => index),
        (a, b) => {
          step();
          for (const [level, sortKey] of keys.entries()) {
            const order = sortKey.compare(keyed[level][a], keyed[level][b]);
            if (order !== 0) return sortKey.descending ? -order : order;
          }
          return 0;
        }
      );
      return indices.map((index) => items[index]);
    },
    { source: root, keys }
  );
}

function tuple(call: NativeCall, types: Type[], values: Value[]): CsStruct {
  return new CsStruct(libraryType(call, 'System.ValueTuple', types), values);
}

const linq: Record<string, NativeMethod> = {
  [`${ENUMERABLE}.Aggregate`]: (call, _receiver, args) => {
    const items = source(call, args[0] as Value);
    if (args.length === 2) {
      const combine = delegateCall(call, args[1] as Value, 'func');
      let accumulator: Value;
      let found = false;
      for (const item of items) {
        accumulator = found ? combine(accumulator, item) : item;
        found = true;
      }
      if (!found) throw noElements();
      return accumulator;
    }
    const combine = delegateCall(call, args[2] as Value, 'func');
    let accumulator = args[1] as Value;
    for (const item of items) accumulator = combine(accumulator, item);
    return args.length > 3 ? delegateCall(call, args[3] as Value, 'resultSelector')(accumulator) : accumulator;
  },
  [`${ENUMERABLE}.All`]: (call, _receiver, [items, predicate]) => {
    const test = delegateCall(call, predicate as Value, 'predicate');
    for (const item of source(call, items as Value)) if (!(test(item) as boolean)) return false;
    return true;
  },
  [`${ENUMERABLE}.Any`]: (call, _receiver, args) => {
    const test = args.length > 1 ? delegateCall(call, args[1] as Value, 'predicate') : undefined;
    for (const item of source(call, args[0] as Value)) if (!test || (test(item) as boolean)) return true;
    return false;
  },
  [`${ENUMERABLE}.Append`]: (call, _receiver, [items, element]) => {
    const all = source(call, items as Value);
    return query(
      call,
      call.typeArgs[0],
      iteratorName('AppendPrepend1Iterator', [call.typeArgs[0]]),
      [items as Value, element as Value],
      function* () {
        yield* all;
        yield element as Value;
      }
    );
  },
  [`${ENUMERABLE}.Prepend`]: (call, _receiver, [items, element]) => {
    const all = source(call, items as Value);
    return query(
      call,
      call.typeArgs[0],
      iteratorName('AppendPrepend1Iterator', [call.typeArgs[0]]),
      [items as Value, element as Value],
      function* () {
        yield element as Value;
        yield* all;
      }
    );
  },
  [`${ENUMERABLE}.AsEnumerable`]: (_call, _receiver, [items]) => items as Value,
  [`${ENUMERABLE}.Average`]: (call, _receiver, args) => average(call, args as Value[]),
  [`${ENUMERABLE}.Cast`]: (call, _receiver, [items]) => {
    const target = call.typeArgs[0];
    const evaluator = evaluatorOf(call);
    const all = source(call, items as Value);
    if (isEnumerableOf(call, items as Value, target)) return items as Value;
    // The elements of a collection of a value type come unboxed, which Cast sees in their boxes.
    const elementType = elementTypeOf(items as Value);
    const name = isNonGenericCollection(call, items as Value)
      ? iteratorName('CastICollectionIterator', [target])
      : `System.Linq.Enumerable+<CastIterator>d__36\`1[${runtimeTypeName(target)}]`;
    return query(call, target, name, [items as Value], function* () {
      for (const item of all) {
        const boxed =
          elementType && typeof item !== 'object' && typeof item !== 'string' ? new CsBox(elementType, item) : item;
        yield evaluator.convertValue(
          boxed,
          target.kind === 'named' && target.symbol.isValueType ? 'unboxing' : 'referenceCheck',
          libraryType(call, 'System.Object'),
          target
        );
      }
    });
  },
  [`${ENUMERABLE}.OfType`]: (call, _receiver, [items]) => {
    const target = call.typeArgs[0];
    const evaluator = evaluatorOf(call);
    const all = source(call, items as Value);
    // A sequence of a value type has no nulls to drop, so .NET returns it as it is.
    const isValueType = target.kind === 'named' && target.symbol.isValueType && !nullableUnderlying(target);
    if (isValueType && isEnumerableOf(call, items as Value, target)) return items as Value;
    const isValueTypeOrNullable = target.kind === 'named' && target.symbol.isValueType;
    return query(call, target, iteratorName('OfTypeIterator', [target]), [items as Value], function* () {
      for (const item of all)
        if (item !== undefined && evaluator.isInstanceOf(item, target))
          yield item instanceof CsBox && isValueTypeOrNullable ? copyValue(item.value) : item;
    });
  },
  [`${ENUMERABLE}.Chunk`]: (call, _receiver, [items, size]) => {
    if ((size as number) < 1) failOutOfRange(call, 'size', OUT_OF_RANGE);
    const elementType = call.typeArgs[0];
    const all = source(call, items as Value);
    return query(
      call,
      { kind: 'array', element: elementType, rank: 1 },
      `System.Linq.Enumerable+${items instanceof CsArray ? '<ArrayChunkIterator>d__39' : '<EnumerableChunkIterator>d__40'}\`1[${runtimeTypeName(elementType)}]`,
      [items as Value],
      function* () {
        let chunk: Value[] = [];
        for (const item of all) {
          chunk.push(item);
          if (chunk.length === size) {
            yield newArray(call, elementType, chunk);
            chunk = [];
          }
        }
        if (chunk.length > 0) yield newArray(call, elementType, chunk);
      }
    );
  },
  [`${ENUMERABLE}.Concat`]: (call, _receiver, [first, second]) => {
    const a = source(call, first as Value, 'first');
    const b = source(call, second as Value, 'second');
    return query(
      call,
      call.typeArgs[0],
      iteratorName('Concat2Iterator', [call.typeArgs[0]]),
      [first as Value, second as Value],
      function* () {
        yield* a;
        yield* b;
      }
    );
  },
  [`${ENUMERABLE}.Contains`]: (call, _receiver, [items, value, comparer]) => {
    const equality = equalityOf(call, (comparer as Value | undefined) ?? undefined);
    for (const item of source(call, items as Value))
      if (item === undefined ? value === undefined : value !== undefined && equality.equals(item, value as Value))
        return true;
    return false;
  },
  [`${ENUMERABLE}.Count`]: (call, _receiver, args) => {
    if (args.length === 1) {
      const count = knownCount(args[0] as Value);
      if (count !== undefined) return count;
      return countOf(source(call, args[0] as Value));
    }
    const test = delegateCall(call, args[1] as Value, 'predicate');
    let total = 0;
    for (const item of source(call, args[0] as Value)) if (test(item) as boolean) total++;
    return total;
  },
  [`${ENUMERABLE}.LongCount`]: (call, _receiver, [items]) => {
    return BigInt(countOf(source(call, items as Value)));
  },
  [`${ENUMERABLE}.CountBy`]: (call, _receiver, [items, selector, comparer]) => {
    const keyOf = delegateCall(call, selector as Value, 'keySelector');
    const pairType = libraryType(call, 'System.Collections.Generic.KeyValuePair', [
      call.typeArgs[1],
      libraryType(call, 'System.Int32'),
    ]);
    const all = source(call, items as Value);
    return query(call, pairType, generatedIterator(call, 'CountByIterator', 53), [items as Value], () =>
      groupsOf(call, all, keyOf, (item) => item, (comparer as Value | undefined) ?? undefined).map(
        (group) => new CsStruct(pairType, [group.key, group.elements.length])
      )
    );
  },
  [`${ENUMERABLE}.DefaultIfEmpty`]: (call, _receiver, args) => {
    const all = source(call, args[0] as Value);
    const fallback = args.length > 1 ? (args[1] as Value) : evaluatorOf(call).defaultOf(call.typeArgs[0]);
    return query(
      call,
      call.typeArgs[0],
      iteratorName('DefaultIfEmptyIterator', [call.typeArgs[0]]),
      [args[0] as Value],
      function* () {
        let any = false;
        for (const item of all) {
          any = true;
          yield item;
        }
        if (!any) yield fallback;
      }
    );
  },
  [`${ENUMERABLE}.Distinct`]: (call, _receiver, [items, comparer]) => {
    const all = source(call, items as Value);
    return query(
      call,
      call.typeArgs[0],
      iteratorName('DistinctIterator', [call.typeArgs[0]]),
      [items as Value],
      function* () {
        const seen = seenSet(call, equalityOf(call, (comparer as Value | undefined) ?? undefined));
        for (const item of all) if (seen.add(item)) yield item;
      }
    );
  },
  [`${ENUMERABLE}.DistinctBy`]: (call, _receiver, [items, selector]) => {
    const keyOf = delegateCall(call, selector as Value, 'keySelector');
    const all = source(call, items as Value);
    return query(
      call,
      call.typeArgs[0],
      generatedIterator(call, 'DistinctByIterator', 67),
      [items as Value],
      function* () {
        const seen = seenSet(call, equalityOf(call, undefined, call.typeArgs[1]));
        for (const item of all) if (seen.add(keyOf(item))) yield item;
      }
    );
  },
  [`${ENUMERABLE}.ElementAt`]: (call, _receiver, [items, index]) => {
    let position = 0;
    if ((index as number) >= 0) for (const item of source(call, items as Value)) if (position++ === index) return item;
    // An array or a list fails in its indexer; other sequences in ElementAt itself.
    return failOutOfRange(
      call,
      'index',
      isArrayOrList(items as Value)
        ? 'Index was out of range. Must be non-negative and less than the size of the collection.'
        : 'Specified argument was out of the range of valid values.'
    );
  },
  [`${ENUMERABLE}.ElementAtOrDefault`]: (call, _receiver, [items, index]) => {
    let position = 0;
    if ((index as number) >= 0) for (const item of source(call, items as Value)) if (position++ === index) return item;
    return evaluatorOf(call).defaultOf(call.typeArgs[0]);
  },
  [`${ENUMERABLE}.Empty`]: (call) => newArray(call, call.typeArgs[0], []),
  [`${ENUMERABLE}.Except`]: (call, _receiver, [first, second]) =>
    setOperation(call, first as Value, second as Value, 'Except'),
  [`${ENUMERABLE}.Intersect`]: (call, _receiver, [first, second]) =>
    setOperation(call, first as Value, second as Value, 'Intersect'),
  [`${ENUMERABLE}.Union`]: (call, _receiver, [first, second]) =>
    setOperation(call, first as Value, second as Value, 'Union'),
  [`${ENUMERABLE}.ExceptBy`]: (call, _receiver, [first, second, selector]) =>
    setOperationBy(call, first as Value, second as Value, selector as Value, 'Except'),
  [`${ENUMERABLE}.IntersectBy`]: (call, _receiver, [first, second, selector]) =>
    setOperationBy(call, first as Value, second as Value, selector as Value, 'Intersect'),
  [`${ENUMERABLE}.UnionBy`]: (call, _receiver, [first, second, selector]) => {
    const keyOf = delegateCall(call, selector as Value, 'keySelector');
    const a = source(call, first as Value, 'first');
    const b = source(call, second as Value, 'second');
    return query(
      call,
      call.typeArgs[0],
      generatedIterator(call, 'UnionByIterator', 344),
      [first as Value, second as Value],
      function* () {
        const seen = seenSet(call, equalityOf(call, undefined, call.typeArgs[1]));
        for (const item of a) if (seen.add(keyOf(item))) yield item;
        for (const item of b) if (seen.add(keyOf(item))) yield item;
      }
    );
  },
  [`${ENUMERABLE}.First`]: (call, _receiver, args) => first(call, args as Value[], {}),
  [`${ENUMERABLE}.FirstOrDefault`]: (call, _receiver, args) => first(call, args as Value[], { orDefault: true }),
  [`${ENUMERABLE}.Last`]: (call, _receiver, args) => first(call, args as Value[], { last: true }),
  [`${ENUMERABLE}.LastOrDefault`]: (call, _receiver, args) =>
    first(call, args as Value[], { last: true, orDefault: true }),
  [`${ENUMERABLE}.Single`]: (call, _receiver, args) => first(call, args as Value[], { single: true }),
  [`${ENUMERABLE}.SingleOrDefault`]: (call, _receiver, args) =>
    first(call, args as Value[], { single: true, orDefault: true }),
  [`${ENUMERABLE}.GroupBy`]: (call, _receiver, args) => {
    const [items, keySelector, third] = args as Value[];
    const keyOf = delegateCall(call, keySelector, 'keySelector');
    const all = source(call, items);
    const [sourceType, keyType] = call.typeArgs;
    const thirdType = call.method.parameters[2]?.type;
    const isResult = thirdType !== undefined && thirdType.kind === 'named' && thirdType.args.length === 3;
    if (isResult) {
      const resultOf = delegateCall(call, third, 'resultSelector');
      return query(
        call,
        call.typeArgs[2],
        iteratorName('GroupByResultIterator', [sourceType, keyType, call.typeArgs[2]]),
        [items],
        () =>
          groupsOf(call, all, keyOf, (item) => item, undefined).map((group) =>
            resultOf(group.key, newArray(call, sourceType, group.elements))
          )
      );
    }
    const elementOf = third === undefined ? (item: Value): Value => item : delegateCall(call, third, 'elementSelector');
    const elementType = third === undefined ? sourceType : call.typeArgs[2];
    const groupType = libraryType(call, 'System.Linq.IGrouping', [keyType, elementType]);
    return query(
      call,
      groupType,
      third === undefined
        ? iteratorName('GroupByIterator', [sourceType, keyType])
        : iteratorName('GroupByIterator', [sourceType, keyType, elementType]),
      [items],
      () => groupsOf(call, all, keyOf, elementOf, undefined).map((group) => grouping(call, keyType, elementType, group))
    );
  },
  [`${ENUMERABLE}.ToLookup`]: (call, _receiver, args) => {
    const [items, keySelector, elementSelector] = args as Value[];
    const keyOf = delegateCall(call, keySelector, 'keySelector');
    const elementOf =
      elementSelector === undefined
        ? (item: Value): Value => item
        : delegateCall(call, elementSelector, 'elementSelector');
    const [, keyType] = call.typeArgs;
    const elementType = elementSelector === undefined ? call.typeArgs[0] : call.typeArgs[2];
    const groups = groupsOf(call, source(call, items), keyOf, elementOf, undefined);
    const lookup = new CsObject(libraryType(call, 'System.Linq.Internal.Lookup', [keyType, elementType]), []);
    lookup.native = new LookupState(
      groups.map((group) => grouping(call, keyType, elementType, group)),
      groups,
      keyType,
      elementType
    );
    return lookup;
  },
  [`${ENUMERABLE}.GroupJoin`]: (call, _receiver, args) =>
    joinQuery(call, args as Value[], generatedIterator(call, 'GroupJoinIterator', 113), (item, group, resultOf) => [
      resultOf(item, newArray(call, call.typeArgs[1], group ?? [])),
    ]),
  [`${ENUMERABLE}.Join`]: (call, _receiver, args) =>
    joinQuery(call, args as Value[], generatedIterator(call, 'JoinIterator', 126), (item, group, resultOf) =>
      (group ?? []).map((match) => resultOf(item, match))
    ),
  [`${ENUMERABLE}.Index`]: (call, _receiver, [items]) => {
    const all = source(call, items as Value);
    const types = [libraryType(call, 'System.Int32'), call.typeArgs[0]];
    return query(
      call,
      tupleTypeOf(call, types),
      generatedIterator(call, 'IndexIterator', 115),
      [items as Value],
      function* () {
        let index = 0;
        for (const item of all) yield tuple(call, types, [index++, item]);
      }
    );
  },
  [`${ENUMERABLE}.Max`]: (call, _receiver, args) => extremum(call, args as Value[], true),
  [`${ENUMERABLE}.Min`]: (call, _receiver, args) => extremum(call, args as Value[], false),
  [`${ENUMERABLE}.MaxBy`]: (call, _receiver, args) => extremumBy(call, args as Value[], true),
  [`${ENUMERABLE}.MinBy`]: (call, _receiver, args) => extremumBy(call, args as Value[], false),
  [`${ENUMERABLE}.Order`]: (call, _receiver, args) => ordered(call, args as Value[], false, false, true),
  [`${ENUMERABLE}.OrderDescending`]: (call, _receiver, args) => ordered(call, args as Value[], true, false, true),
  [`${ENUMERABLE}.OrderBy`]: (call, _receiver, args) => ordered(call, args as Value[], false, false, false),
  [`${ENUMERABLE}.OrderByDescending`]: (call, _receiver, args) => ordered(call, args as Value[], true, false, false),
  [`${ENUMERABLE}.ThenBy`]: (call, _receiver, args) => ordered(call, args as Value[], false, true, false),
  [`${ENUMERABLE}.ThenByDescending`]: (call, _receiver, args) => ordered(call, args as Value[], true, true, false),
  [`${ENUMERABLE}.Range`]: (call, _receiver, [start, count]) => {
    if ((count as number) < 0 || (start as number) + (count as number) - 1 > 2_147_483_647)
      failOutOfRange(call, 'count', OUT_OF_RANGE);
    return fixedSequence(call, { kind: 'range', start: start as number, count: count as number });
  },
  [`${ENUMERABLE}.Repeat`]: (call, _receiver, [element, count]) => {
    if ((count as number) < 0) failOutOfRange(call, 'count', OUT_OF_RANGE);
    return fixedSequence(call, { kind: 'repeat', element: element as Value, count: count as number });
  },
  [`${ENUMERABLE}.Reverse`]: (call, _receiver, [items]) => {
    const all = source(call, items as Value);
    return query(call, call.typeArgs[0], iteratorName('ReverseIterator', [call.typeArgs[0]]), [items as Value], () =>
      // oxlint-disable-next-line unicorn/no-array-reverse -- The charged buffer is reversed in place, so no uncharged copy is made.
      bufferedElements(call, all).reverse()
    );
  },
  [`${ENUMERABLE}.Select`]: (call, _receiver, [items, selector]) => {
    const select = delegateCall(call, selector as Value, 'selector');
    const withIndex = (call.method.parameters[1].type as NamedType).args.length === 3;
    const all = source(call, items as Value);
    const name = withIndex
      ? `<SelectIterator>d__251`
      : isList(items as Value)
        ? 'SizeOptIListSelectIterator'
        : 'IEnumerableSelectIterator';
    return query(
      call,
      call.typeArgs[1],
      withIndex
        ? `System.Linq.Enumerable+${name}\`2[${call.typeArgs.map(runtimeTypeName).join(',')}]`
        : iteratorName(name, call.typeArgs),
      [items as Value],
      function* () {
        let index = 0;
        for (const item of all) yield withIndex ? select(item, index++) : select(item);
      }
    );
  },
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  [`${ENUMERABLE}.SelectMany`]: (call, _receiver, args) => {
    const [items, collectionSelector, resultSelector] = args as Value[];
    const collect = delegateCall(call, collectionSelector, 'selector');
    const resultOf = resultSelector === undefined ? undefined : delegateCall(call, resultSelector, 'resultSelector');
    const withIndex = (call.method.parameters[1].type as NamedType).args.length === 3;
    const all = source(call, items);
    const resultType = resultSelector === undefined ? call.typeArgs[1] : call.typeArgs[2];
    const typeArgs = call.typeArgs.map(runtimeTypeName).join(',');
    const name = resultOf
      ? `<SelectManyIterator>d__266\`3[${typeArgs}]`
      : withIndex
        ? `<SelectManyIterator>d__262\`2[${typeArgs}]`
        : `SelectManySingleSelectorIterator\`2[${typeArgs}]`;
    return query(call, resultType, `System.Linq.Enumerable+${name}`, [items], function* () {
      let index = 0;
      for (const item of all) {
        const inners = withIndex ? collect(item, index++) : collect(item);
        for (const inner of iterate(call, inners)) yield resultOf ? resultOf(item, inner) : inner;
      }
    });
  },
  [`${ENUMERABLE}.SequenceEqual`]: (call, _receiver, [first, second]) => {
    const equality = equalityOf(call, undefined);
    const a = bufferedElements(call, source(call, first as Value, 'first'));
    const b = bufferedElements(call, source(call, second as Value, 'second'));
    return (
      a.length === b.length &&
      a.every((item, index) =>
        item === undefined ? b[index] === undefined : b[index] !== undefined && equality.equals(item, b[index])
      )
    );
  },
  [`${ENUMERABLE}.Skip`]: (call, _receiver, [items, count]) => skip(call, items as Value, count as number),
  [`${ENUMERABLE}.SkipLast`]: (call, _receiver, [items, count]) => {
    const all = source(call, items as Value);
    if ((count as number) <= 0) return skip(call, items as Value, 0);
    return query(
      call,
      call.typeArgs[0],
      generatedIterator(call, 'TakeRangeFromEndIterator', 316),
      [items as Value],
      () => {
        const buffered = bufferedElements(call, all);
        buffered.length = Math.max(0, buffered.length - Math.max(0, count as number));
        return buffered;
      }
    );
  },
  [`${ENUMERABLE}.SkipWhile`]: (call, _receiver, args) =>
    predicateQuery(
      call,
      args as Value[],
      (withIndex) => generatedIterator(call, 'SkipWhileIterator', withIndex ? 283 : 281),
      function* (all, matches) {
        let skipping = true;
        for (const item of all) {
          if (skipping && matches(item)) continue;
          skipping = false;
          yield item;
        }
      }
    ),
  [`${ENUMERABLE}.Sum`]: (call, _receiver, args) => sum(call, args as Value[]),
  [`${ENUMERABLE}.Take`]: (call, _receiver, [items, count]) => {
    const all = source(call, items as Value);
    const shape = shapeOf(items as Value);
    if ((count as number) <= 0 || isEmptyArray(items as Value)) return newArray(call, call.typeArgs[0], []);
    if (shape?.kind === 'range' || shape?.kind === 'repeat')
      return fixedSequence(call, { ...shape, count: Math.min(shape.count, count as number) });
    return skipTake(call, items as Value, all, 0, count as number);
  },
  [`${ENUMERABLE}.TakeLast`]: (call, _receiver, [items, count]) => {
    const all = source(call, items as Value);
    if ((count as number) <= 0) return newArray(call, call.typeArgs[0], []);
    return query(
      call,
      call.typeArgs[0],
      generatedIterator(call, 'TakeRangeFromEndIterator', 316),
      [items as Value],
      () => {
        const buffered = bufferedElements(call, all);
        if ((count as number) <= 0) return [];
        buffered.splice(0, Math.max(0, buffered.length - (count as number)));
        return buffered;
      }
    );
  },
  [`${ENUMERABLE}.TakeWhile`]: (call, _receiver, args) =>
    predicateQuery(
      call,
      args as Value[],
      (withIndex) => generatedIterator(call, 'TakeWhileIterator', withIndex ? 320 : 318),
      function* (all, matches) {
        for (const item of all) {
          if (!matches(item)) return;
          yield item;
        }
      }
    ),
  [`${ENUMERABLE}.ToArray`]: (call, _receiver, [items]) => {
    return arrayOfBuffer(call.typeArgs[0], bufferedElements(call, source(call, items as Value)));
  },
  [`${ENUMERABLE}.ToList`]: (call, _receiver, [items]) =>
    newList(call, call.typeArgs[0], bufferedElements(call, source(call, items as Value)), true),
  [`${ENUMERABLE}.ToHashSet`]: (call, _receiver, [items]) => {
    const set = new CsObject(libraryType(call, 'System.Collections.Generic.HashSet', [call.typeArgs[0]]), []);
    const state = new HashState(equalityOf(call, undefined), call.typeArgs[0], undefined, undefined);
    state.allocate = (count) => call.frame.runtime.allocateSlots(count);
    for (const item of source(call, items as Value)) state.insert(item, undefined, false);
    set.native = state;
    return set;
  },
  [`${ENUMERABLE}.ToDictionary`]: (call, _receiver, args) => {
    const [items, keySelector, elementSelector] = args as Value[];
    const isPairs = call.method.parameters.length === 1;
    const keyType = isPairs ? call.typeArgs[0] : call.typeArgs[1];
    const valueType = isPairs ? call.typeArgs[1] : elementSelector === undefined ? call.typeArgs[0] : call.typeArgs[2];
    const keyOf = isPairs
      ? (pair: Value): Value => (pair as CsStruct).fields[0]
      : delegateCall(call, keySelector, 'keySelector');
    const valueOf = isPairs
      ? (pair: Value): Value => (pair as CsStruct).fields[1]
      : elementSelector === undefined
        ? (item: Value): Value => item
        : delegateCall(call, elementSelector, 'elementSelector');
    const dictionary = new CsObject(
      libraryType(call, 'System.Collections.Generic.Dictionary', [keyType, valueType]),
      []
    );
    const state = new HashState(equalityOf(call, undefined, keyType), keyType, valueType, undefined);
    state.allocate = (count) => call.frame.runtime.allocateSlots(count);
    const pairType = libraryType(call, 'System.Collections.Generic.KeyValuePair', [keyType, valueType]);
    state.pairOf = (key, value) => new CsStruct(pairType, [key, value]);
    for (const item of source(call, items)) {
      const key = keyOf(item);
      if (key === undefined) failNull('key');
      if (!state.insert(key, valueOf(item), false))
        fail(
          'System.ArgumentException',
          `An item with the same key has already been added. Key: ${evaluatorOf(call).stringOf(key, keyType, call.frame)}`
        );
    }
    dictionary.native = state;
    return dictionary;
  },
  [`${ENUMERABLE}.Where`]: (call, _receiver, args) =>
    predicateQuery(
      call,
      args as Value[],
      (withIndex) =>
        withIndex
          ? generatedIterator(call, 'WhereIterator', 350)
          : iteratorName(isArrayOrList(args[0] as Value) ? 'SizeOptIListWhereIterator' : 'IEnumerableWhereIterator', [
              call.typeArgs[0],
            ]),
      function* (all, matches) {
        for (const item of all) if (matches(item)) yield item;
      }
    ),
  [`${ENUMERABLE}.Zip(IEnumerable<TFirst>, IEnumerable<TSecond>, IEnumerable<TThird>)`]: (call, _receiver, args) => {
    const [first, second, third] = args as Value[];
    const sources = [source(call, first, 'first'), source(call, second, 'second'), source(call, third, 'third')];
    const types = call.typeArgs;
    return query(
      call,
      tupleTypeOf(call, types),
      generatedIterator(call, 'ZipIterator', 363),
      [first, second, third],
      function* () {
        const iterators = sources.map((items) => items[Symbol.iterator]());
        for (;;) {
          const values: Value[] = [];
          for (const iterator of iterators) {
            const next = iterator.next();
            if (next.done) return;
            values.push(next.value);
          }
          yield tuple(call, types, values);
        }
      }
    );
  },
  [`${ENUMERABLE}.AggregateBy`]: (call, _receiver, [items, keySelector, seed, func, comparer]) => {
    const keyOf = delegateCall(call, keySelector as Value, 'keySelector');
    const accumulate = delegateCall(call, func as Value, 'func');
    const hasSeedSelector = (call.method.parameters[2].type as NamedType).symbol.kind === 'delegate';
    const seedOf = hasSeedSelector ? delegateCall(call, seed as Value, 'seedSelector') : () => seed as Value;
    const [, keyType, accumulateType] = call.typeArgs;
    const pairType = libraryType(call, 'System.Collections.Generic.KeyValuePair', [keyType, accumulateType]);
    const all = source(call, items as Value);
    return query(
      call,
      pairType,
      generatedIterator(call, 'AggregateByIterator', hasSeedSelector ? 51 : 50),
      [items as Value],
      () =>
        groupsOf(call, all, keyOf, (item) => item, (comparer as Value | undefined) ?? undefined).map((group) => {
          let accumulated = seedOf(group.key);
          for (const element of group.elements) accumulated = accumulate(accumulated, element);
          return new CsStruct(pairType, [group.key, accumulated]);
        })
    );
  },
  [`${ENUMERABLE}.TryGetNonEnumeratedCount`]: (call, _receiver, [items, count]) => {
    if (items === undefined) failNull('source');
    const found = cheapCount(call, items as Value);
    refOf(count).set(found ?? 0);
    return found !== undefined;
  },
  [`${ENUMERABLE}.Zip`]: (call, _receiver, args) => {
    const [first, second, resultSelector] = args as Value[];
    const a = source(call, first, 'first');
    const b = source(call, second, 'second');
    const resultOf = resultSelector === undefined ? undefined : delegateCall(call, resultSelector, 'resultSelector');
    const types = [call.typeArgs[0], call.typeArgs[1]];
    const elementType = resultOf ? call.typeArgs[2] : tupleTypeOf(call, types);
    return query(
      call,
      elementType,
      `System.Linq.Enumerable+<ZipIterator>d__${resultOf ? 362 : 361}\`${resultOf ? 3 : 2}[${call.typeArgs.map(runtimeTypeName).join(',')}]`,
      [first, second],
      function* () {
        const left = a[Symbol.iterator]();
        const right = b[Symbol.iterator]();
        for (;;) {
          const x = left.next();
          if (x.done) return;
          const y = right.next();
          if (y.done) return;
          yield resultOf ? resultOf(x.value, y.value) : tuple(call, types, [x.value, y.value]);
        }
      }
    );
  },
};
defineNatives(linq);

function tupleTypeOf(call: NativeCall, types: Type[]): Type {
  return libraryType(call, 'System.ValueTuple', types);
}

// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
function setOperation(
  call: NativeCall,
  first: Value,
  second: Value,
  operation: 'Except' | 'Intersect' | 'Union'
): CsObject {
  const a = source(call, first, 'first');
  const b = source(call, second, 'second');
  return query(call, call.typeArgs[0], setIteratorName(call, operation), [first, second], function* () {
    const equality = equalityOf(call, undefined);
    const seen = seenSet(call, equality);
    if (operation === 'Union') {
      for (const item of a) if (seen.add(item)) yield item;
      for (const item of b) if (seen.add(item)) yield item;
      return;
    }
    // As .NET's iterators do, Except yields what it can add to the second's set, and Intersect what it can remove.
    const others = seenSet(call, equality);
    for (const item of b) others.add(item);
    for (const item of a) if (operation === 'Except' ? others.add(item) : others.remove(item)) yield item;
  });
}

function setIteratorName(call: NativeCall, operation: 'Except' | 'Intersect' | 'Union'): string {
  if (operation === 'Union') return iteratorName('UnionIterator2', call.typeArgs);
  return generatedIterator(call, `${operation}Iterator`, operation === 'Except' ? 88 : 121);
}

function setOperationBy(
  call: NativeCall,
  first: Value,
  second: Value,
  selector: Value,
  operation: 'Except' | 'Intersect'
): CsObject {
  const keyOf = delegateCall(call, selector, 'keySelector');
  const a = source(call, first, 'first');
  const b = source(call, second, 'second');
  return query(
    call,
    call.typeArgs[0],
    generatedIterator(call, `${operation}ByIterator`, operation === 'Except' ? 89 : 122),
    [first, second],
    function* () {
      const equality = equalityOf(call, undefined, call.typeArgs[1]);
      const keys = seenSet(call, equality);
      for (const key of b) keys.add(key);
      for (const item of a) {
        const key = keyOf(item);
        if (operation === 'Except' ? keys.add(key) : keys.remove(key)) yield item;
      }
    }
  );
}

/** The index of a lookup's group of a key, where a null key has its own group. */
function groupIndexOf(call: NativeCall, state: LookupState, key: Value): number {
  const equality = equalityOf(call, undefined);
  return state.groups.findIndex((group) =>
    group.key === undefined ? key === undefined : key !== undefined && equality.equals(group.key, key)
  );
}

class LookupState implements NativeState {
  constructor(
    readonly groupings: CsObject[],
    readonly groups: { key: Value; elements: Value[] }[],
    readonly keyType: Type,
    readonly elementType: Type
  ) {}

  enumerate(): Iterable<Value> {
    return this.groupings;
  }

  references(): Value[] {
    return this.groupings;
  }
}

defineNatives({
  'System.Linq.Internal.Iterator`1.GetEnumerator': (call, receiver) => {
    const state = (receiver as CsObject).native as QueryState;
    const enumerator = new CsObject(libraryType(call, 'System.Linq.Internal.Enumerator', [state.elementType]), []);
    enumerator.native = new LibraryEnumerator(state.run()[Symbol.iterator](), [receiver]);
    return enumerator;
  },
  'System.Linq.Internal.Enumerator`1.MoveNext': (_call, receiver) =>
    ((receiver as CsObject).native as LibraryEnumerator).next(),
  'System.Linq.Internal.Enumerator`1.get_Current': (call, receiver) =>
    ((receiver as CsObject).native as LibraryEnumerator).currentValue(call),
  'System.Linq.Internal.Enumerator`1.Reset': () =>
    fail('System.NotSupportedException', 'Specified method is not supported.'),
  'System.Linq.Internal.Enumerator`1.Dispose': () => {},
  'System.Linq.Internal.Grouping`2.get_Key': (_call, receiver) => ((receiver as CsObject).native as GroupingState).key,
  'System.Linq.Internal.Grouping`2.GetEnumerator': (call, receiver) => {
    const state = (receiver as CsObject).native as GroupingState;
    const enumerator = new CsObject(libraryType(call, 'System.Linq.Internal.Enumerator', [state.elementType]), []);
    enumerator.native = new LibraryEnumerator(state.elements[Symbol.iterator](), [receiver]);
    return enumerator;
  },
  'System.Linq.Internal.Lookup`2.get_Count': (_call, receiver) =>
    ((receiver as CsObject).native as LookupState).groupings.length,
  'System.Linq.Internal.Lookup`2.get_Item': (call, receiver, [key]) => {
    const state = (receiver as CsObject).native as LookupState;
    const index = groupIndexOf(call, state, key as Value);
    if (index === -1) return newArray(call, state.elementType, []);
    return state.groupings[index];
  },
  'System.Linq.Internal.Lookup`2.Contains': (call, receiver, [key]) =>
    groupIndexOf(call, (receiver as CsObject).native as LookupState, key as Value) !== -1,
  'System.Linq.Internal.Lookup`2.GetEnumerator': (call, receiver) => {
    const state = (receiver as CsObject).native as LookupState;
    const enumerator = new CsObject(
      libraryType(call, 'System.Linq.Internal.Enumerator', [
        libraryType(call, 'System.Linq.IGrouping', [state.keyType, state.elementType]),
      ]),
      []
    );
    enumerator.native = new LibraryEnumerator(state.groupings[Symbol.iterator](), [receiver]);
    return enumerator;
  },
});

/** The name `ToString()` prints for a LINQ object, which .NET's own iterator classes give. */
export function linqDisplayName(native: unknown): string | undefined {
  if (native instanceof QueryState) return native.displayName;
  if (native instanceof GroupingState)
    return `System.Linq.Grouping\`2[${runtimeTypeName(native.keyType)},${runtimeTypeName(native.elementType)}]`;
  if (native instanceof LookupState)
    return `System.Linq.CollectionLookup\`2[${runtimeTypeName(native.keyType)},${runtimeTypeName(native.elementType)}]`;
  return undefined;
}

export { accumulatorOf, CsArray, CsStruct };

/** The number of elements an enumeration yields. */
function countOf(items: Iterable<Value>): number {
  let total = 0;
  const iterator = items[Symbol.iterator]();
  while (!iterator.next().done) total++;
  return total;
}
