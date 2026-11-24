import { defineNatives, type NativeCall, type NativeMethod } from '../natives';
import { PendingException } from '../numeric';
// code-gauge-allow-file fileNcss -- The nativesSorted module keeps one stage of the C# interpreter together.
import { valuesEqual } from '../objects';
import type { NativeState } from '../runtime';
import type { Type } from '../types';
import { CsObject, CsStruct, type Value } from '../values';
import { collectionModifiedAfterStart, type EnumerableState, iterate, LibraryEnumerator } from './iteration';
import { type Comparison, comparisonOf, equalityOf, ListState, pairCollectionNatives } from './nativesCollections';
import {
  bufferedElements,
  copyToArray,
  dictionaryKeyText,
  evaluatorOf,
  fail,
  failNegative,
  failNull,
  failOutOfRange,
  libraryType,
  newArray,
  refOf,
  stepMeter,
  textOf,
  typeArgument,
} from './support';

function setNative(receiver: Value, state: unknown): Value {
  (receiver as CsObject).native = state;
  return undefined;
}

function enumeratorOf(call: NativeCall, elementType: Type, source: Iterable<Value>, holds: Value[]): CsObject {
  const enumerator = new CsObject(libraryType(call, 'System.Linq.Internal.Enumerator', [elementType]), []);
  enumerator.native = new LibraryEnumerator(source[Symbol.iterator](), holds);
  return enumerator;
}

// ---- Sorted collections ----

/**
 * The entries of a `SortedDictionary`, `SortedList`, or `SortedSet`, kept in the order of their comparer, which
 * finds a key by binary search as .NET's tree finds it by descending.
 */
class SortedState implements EnumerableState {
  keys: Value[] = [];
  values: Value[] = [];
  version = 0;

  constructor(
    readonly compare: Comparison,
    readonly keyType: Type,
    readonly valueType: Type | undefined,
    readonly pairOf: ((key: Value, value: Value) => Value) | undefined,
    readonly keyText: (key: Value) => string
  ) {}

  /** The type of a set's elements, which it holds unboxed; a dictionary's pairs carry their own type. */
  get elementType(): Type | undefined {
    return this.valueType ? undefined : this.keyType;
  }

  /** Whether a dictionary holds a pair: its key found by the dictionary's comparer, its value by default equality. */
  containsPair(pair: CsStruct, call: NativeCall): boolean {
    const { index, isFound } = this.position(pair.fields[0]);
    return isFound && valuesEqual(evaluatorOf(call), this.values[index], pair.fields[1], call.frame);
  }

  position(key: Value): { index: number; isFound: boolean } {
    let low = 0;
    let high = this.keys.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const order = this.compare(this.keys[middle], key);
      if (order === 0) return { index: middle, isFound: true };
      if (order < 0) low = middle + 1;
      else high = middle;
    }
    return { index: low, isFound: false };
  }

  /** Charges entries the collection newly keeps, as Runtime.retainSlots does. */
  retain: (baseSlots: number, values: Value[]) => void = () => {};
  /** Charges replacing a kept value, as Runtime.chargeStore does. */
  store: (previous: Value, next: Value) => void = () => {};

  insert(key: Value, value: Value, replace: boolean): boolean {
    const { index, isFound } = this.position(key);
    if (isFound) {
      if (!replace) return false;
      this.store(this.values[index], value);
      this.values[index] = value;
      this.version++;
      return true;
    }
    this.retain(1, [key, value]);
    this.keys.splice(index, 0, key);
    this.values.splice(index, 0, value);
    this.version++;
    return true;
  }

  remove(key: Value): boolean {
    const { index, isFound } = this.position(key);
    if (!isFound) return false;
    this.keys.splice(index, 1);
    this.values.splice(index, 1);
    this.version++;
    return true;
  }

  *enumerate(): Generator<Value> {
    const version = this.version;
    for (let index = 0; index < this.keys.length; index++) {
      if (this.version !== version) throw collectionModifiedAfterStart();
      yield this.pairOf ? this.pairOf(this.keys[index], this.values[index]) : this.keys[index];
    }
    if (this.version !== version) throw collectionModifiedAfterStart();
  }

  references(): Value[] {
    return [...this.keys, ...this.values];
  }

  display(): { kind: 'array' | 'object'; items: [string, Value, Type][] } {
    const valueType = this.valueType;
    if (!valueType) return { kind: 'array', items: this.keys.map((key, index) => [String(index), key, this.keyType]) };
    return { kind: 'object', items: this.keys.map((key, index) => [this.keyText(key), this.values[index], valueType]) };
  }
}

function sortedOf(value: Value): SortedState {
  if (value === undefined)
    fail('System.NullReferenceException', 'Object reference not set to an instance of an object.');
  return (value as CsObject).native as SortedState;
}

function newSorted(call: NativeCall, comparer: Value, keyType: Type, valueType: Type | undefined): SortedState {
  const pairType = valueType
    ? libraryType(call, 'System.Collections.Generic.KeyValuePair', [keyType, valueType])
    : undefined;
  const state = new SortedState(
    comparisonOf(call, comparer),
    keyType,
    valueType,
    pairType ? (key, value) => new CsStruct(pairType, [key, value]) : undefined,
    (key) => dictionaryKeyText(call, key, keyType)
  );
  state.retain = (baseSlots, values) => call.frame.runtime.retainSlots(baseSlots, values);
  state.store = (previous, next) => call.frame.runtime.chargeStore(previous, next);
  return state;
}

/** An empty sorted state ordered as another is, for looking up a sequence's elements by the set's own comparer. */
function lookupWithComparer(state: SortedState): SortedState {
  return new SortedState(state.compare, state.keyType, undefined, undefined, state.keyText);
}

function keyNotFound(call: NativeCall, key: Value): never {
  throw new PendingException(
    'System.Collections.Generic.KeyNotFoundException',
    `The given key '${textOf(call, key, typeArgument(call, 0))}' was not present in the dictionary.`
  );
}

// code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
function sortedDictionaryNatives(prefix: string): Record<string, NativeMethod> {
  const natives: Record<string, NativeMethod> = {
    [`${prefix}..ctor()`]: (call, receiver) =>
      setNative(receiver, newSorted(call, undefined, typeArgument(call, 0), typeArgument(call, 1))),
    [`${prefix}..ctor(IComparer<TKey>?)`]: (call, receiver, [comparer]) =>
      setNative(receiver, newSorted(call, comparer as Value, typeArgument(call, 0), typeArgument(call, 1))),
    [`${prefix}..ctor(IDictionary<TKey, TValue>)`]: (call, receiver, [source]) => {
      const state = newSorted(call, undefined, typeArgument(call, 0), typeArgument(call, 1));
      for (const pair of iterate(call, source as Value, 'dictionary'))
        state.insert((pair as CsStruct).fields[0], (pair as CsStruct).fields[1], false);
      return setNative(receiver, state);
    },
    [`${prefix}.get_Count`]: (_call, receiver) => sortedOf(receiver).keys.length,
    [`${prefix}.get_IsReadOnly`]: () => false,
    [`${prefix}.get_Item`]: (call, receiver, [key]) => {
      if (key === undefined) failNull('key');
      const state = sortedOf(receiver);
      const { index, isFound } = state.position(key as Value);
      if (!isFound) keyNotFound(call, key as Value);
      return state.values[index];
    },
    [`${prefix}.set_Item`]: (_call, receiver, [key, value]) => {
      if (key === undefined) failNull('key');
      sortedOf(receiver).insert(key as Value, value as Value, true);
      return;
    },
    [`${prefix}.Contains`]: (call, receiver, [pair]) => sortedOf(receiver).containsPair(pair as CsStruct, call),
    // The views share the dictionary's arrays, so a saved Keys or Values shows later changes, as .NET's views do.
    [`${prefix}.get_Keys`]: (call, receiver) => {
      const state = sortedOf(receiver);
      const view = liveView(call, state, state.keys, state.keyType);
      // Its keys are found by the dictionary's comparer, as ContainsKey and IndexOfKey find them.
      (view.native as ListState).indexOfKey = (key) => {
        const { index, isFound } = state.position(key);
        return isFound ? index : -1;
      };
      return view;
    },
    [`${prefix}.get_Values`]: (call, receiver) => {
      const state = sortedOf(receiver);
      return liveView(call, state, state.values, state.valueType as Type);
    },
    [`${prefix}.Add`]: (call, receiver, [key, value]) => {
      if (key === undefined) failNull('key');
      const state = sortedOf(receiver);
      if (state.insert(key as Value, value as Value, false)) return;
      // SortedDictionary's tree reports the pair it failed to add, and SortedList the key as the parameter.
      if (prefix.includes('SortedDictionary')) {
        const pairType = libraryType(call, 'System.Collections.Generic.KeyValuePair', [
          state.keyType,
          state.valueType as Type,
        ]);
        const pair = (state.pairOf as (key: Value, value: Value) => Value)(key as Value, value as Value);
        fail(
          'System.ArgumentException',
          `An item with the same key has already been added. Key: ${textOf(call, pair, pairType)}`
        );
      }
      fail(
        'System.ArgumentException',
        `An item with the same key has already been added. Key: ${textOf(call, key as Value, typeArgument(call, 0))}`,
        'key'
      );
    },
    [`${prefix}.Clear`]: (_call, receiver) => {
      const state = sortedOf(receiver);
      // The arrays are emptied in place, since the Keys and Values views share them.
      state.keys.length = 0;
      state.values.length = 0;
      state.version++;
      return;
    },
    [`${prefix}.ContainsKey`]: (_call, receiver, [key]) => sortedOf(receiver).position(key as Value).isFound,
    [`${prefix}.ContainsValue`]: (call, receiver, [value]) => {
      const equality = equalityOf(call, undefined, call.owner?.args[1]);
      return sortedOf(receiver).values.some((item) =>
        item === undefined ? value === undefined : value !== undefined && equality.equals(item, value as Value)
      );
    },
    [`${prefix}.GetEnumerator`]: (call, receiver) => {
      const state = sortedOf(receiver);
      return enumeratorOf(
        call,
        libraryType(call, 'System.Collections.Generic.KeyValuePair', [state.keyType, state.valueType as Type]),
        state.enumerate(),
        [receiver]
      );
    },
    [`${prefix}.IndexOfKey`]: (_call, receiver, [key]) => {
      const { index, isFound } = sortedOf(receiver).position(key as Value);
      return isFound ? index : -1;
    },
    [`${prefix}.Remove`]: (_call, receiver, [key]) => sortedOf(receiver).remove(key as Value),
    [`${prefix}.RemoveAt`]: (call, receiver, [index]) => {
      const state = sortedOf(receiver);
      if ((index as number) < 0 || (index as number) >= state.keys.length)
        failOutOfRange(
          call,
          'index',
          'Index was out of range. Must be non-negative and less than the size of the collection.'
        );
      state.keys.splice(index as number, 1);
      state.values.splice(index as number, 1);
      state.version++;
      return;
    },
    [`${prefix}.TryAdd`]: (_call, receiver, [key, value]) =>
      sortedOf(receiver).insert(key as Value, value as Value, false),
    [`${prefix}.TryGetValue`]: (call, receiver, [key, value]) => {
      const state = sortedOf(receiver);
      const { index, isFound } = state.position(key as Value);
      refOf(value).set(isFound ? state.values[index] : evaluatorOf(call).defaultOf(state.valueType as Type));
      return isFound;
    },
  };
  return { ...natives, ...pairCollectionNatives(prefix, natives[`${prefix}.Add`], sortedOf) };
}
defineNatives(sortedDictionaryNatives('System.Collections.Generic.SortedDictionary`2'));
defineNatives(sortedDictionaryNatives('System.Collections.Generic.SortedList`2'));

const SORTED_SET = 'System.Collections.Generic.SortedSet`1';

const sortedSetFromCollection: NativeMethod = (call, receiver, [source, comparer]) => {
  if (source === undefined) failNull('collection');
  const state = newSorted(call, comparer as Value, typeArgument(call), undefined);
  for (const item of iterate(call, source as Value, 'collection')) state.insert(item, undefined, false);
  return setNative(receiver, state);
};

function setElements(call: NativeCall, other: Value): Value[] {
  if (other === undefined) failNull('other');
  return bufferedElements(call, iterate(call, other, 'other'));
}

defineNatives({
  [`${SORTED_SET}..ctor()`]: (call, receiver) =>
    setNative(receiver, newSorted(call, undefined, typeArgument(call), undefined)),
  [`${SORTED_SET}..ctor(IComparer<T>?)`]: (call, receiver, [comparer]) =>
    setNative(receiver, newSorted(call, comparer as Value, typeArgument(call), undefined)),
  [`${SORTED_SET}..ctor(IEnumerable<T>)`]: sortedSetFromCollection,
  [`${SORTED_SET}..ctor(IEnumerable<T>, IComparer<T>?)`]: sortedSetFromCollection,
  [`${SORTED_SET}.get_Count`]: (_call, receiver) => sortedOf(receiver).keys.length,
  [`${SORTED_SET}.get_IsReadOnly`]: () => false,
  [`${SORTED_SET}.get_Min`]: (call, receiver) =>
    sortedOf(receiver).keys[0] ?? evaluatorOf(call).defaultOf(typeArgument(call)),
  [`${SORTED_SET}.get_Max`]: (call, receiver) =>
    sortedOf(receiver).keys.at(-1) ?? evaluatorOf(call).defaultOf(typeArgument(call)),
  [`${SORTED_SET}.Add`]: (_call, receiver, [value]) => sortedOf(receiver).insert(value as Value, undefined, false),
  [`${SORTED_SET}.Clear`]: (_call, receiver) => {
    const state = sortedOf(receiver);
    state.keys = [];
    state.values = [];
    state.version++;
    return;
  },
  [`${SORTED_SET}.Contains`]: (_call, receiver, [value]) => sortedOf(receiver).position(value as Value).isFound,
  [`${SORTED_SET}.CopyTo`]: (call, receiver, [array, index]) => {
    copyToArray(call, sortedOf(receiver).keys, array as Value, index as number);
    return;
  },
  [`${SORTED_SET}.ExceptWith`]: (call, receiver, [other]) => {
    const state = sortedOf(receiver);
    for (const item of setElements(call, other as Value)) state.remove(item);
    return;
  },
  [`${SORTED_SET}.GetEnumerator`]: (call, receiver) =>
    enumeratorOf(call, sortedOf(receiver).keyType, sortedOf(receiver).enumerate(), [receiver]),
  [`${SORTED_SET}.GetViewBetween`]: (call, receiver, [lower, upper]) => {
    const state = sortedOf(receiver);
    if (state.compare(lower as Value, upper as Value) > 0)
      fail('System.ArgumentException', 'Must be less than or equal to upperValue.', 'lowerValue');
    // The view orders and looks up by the set's own comparer, as .NET's does.
    const view = lookupWithComparer(state);
    view.retain = (baseSlots, values) => call.frame.runtime.retainSlots(baseSlots, values);
    view.store = (previous, next) => call.frame.runtime.chargeStore(previous, next);
    const step = stepMeter(call);
    for (const key of state.keys) {
      step();
      if (state.compare(key, lower as Value) >= 0 && state.compare(key, upper as Value) <= 0)
        view.insert(key, undefined, false);
    }
    const object = new CsObject(libraryType(call, 'System.Collections.Generic.SortedSet', [state.keyType]), []);
    object.native = view;
    return object;
  },
  [`${SORTED_SET}.IntersectWith`]: (call, receiver, [other]) => {
    const state = sortedOf(receiver);
    const others = lookupWithComparer(state);
    for (const item of setElements(call, other as Value)) others.insert(item, undefined, false);
    for (const key of state.keys.filter((key) => !others.position(key).isFound)) state.remove(key);
    return;
  },
  [`${SORTED_SET}.IsSubsetOf`]: (call, receiver, [other]) => {
    const state = sortedOf(receiver);
    const others = lookupWithComparer(state);
    for (const item of setElements(call, other as Value)) others.insert(item, undefined, false);
    return state.keys.every((key) => others.position(key).isFound);
  },
  [`${SORTED_SET}.IsSupersetOf`]: (call, receiver, [other]) =>
    setElements(call, other as Value).every((item) => sortedOf(receiver).position(item).isFound),
  [`${SORTED_SET}.Overlaps`]: (call, receiver, [other]) =>
    setElements(call, other as Value).some((item) => sortedOf(receiver).position(item).isFound),
  [`${SORTED_SET}.Remove`]: (_call, receiver, [value]) => sortedOf(receiver).remove(value as Value),
  [`${SORTED_SET}.RemoveWhere`]: (call, receiver, [match]) => {
    const state = sortedOf(receiver);
    // .NET finds the matches before removing them, so the predicate sees every element.
    const matches = state.keys.filter(
      (key) => evaluatorOf(call).invokeDelegate(call.frame, match as Value, [key], call.row) as boolean
    );
    for (const key of matches) state.remove(key);
    return matches.length;
  },
  [`${SORTED_SET}.Reverse`]: (call, receiver) =>
    newArray(call, typeArgument(call), sortedOf(receiver).keys.toReversed()),
  [`${SORTED_SET}.SetEquals`]: (call, receiver, [other]) => {
    const state = sortedOf(receiver);
    const others = lookupWithComparer(state);
    for (const item of setElements(call, other as Value)) others.insert(item, undefined, false);
    return others.keys.length === state.keys.length && others.keys.every((key) => state.position(key).isFound);
  },
  [`${SORTED_SET}.SymmetricExceptWith`]: (call, receiver, [other]) => {
    const state = sortedOf(receiver);
    const others = lookupWithComparer(state);
    for (const item of setElements(call, other as Value)) others.insert(item, undefined, false);
    for (const key of others.keys) if (!state.remove(key)) state.insert(key, undefined, false);
    return;
  },
  [`${SORTED_SET}.UnionWith`]: (call, receiver, [other]) => {
    const state = sortedOf(receiver);
    for (const item of setElements(call, other as Value)) state.insert(item, undefined, false);
    return;
  },
});

// ---- LinkedList ----

interface LinkNode {
  value: Value;
  previous: LinkNode | undefined;
  next: LinkNode | undefined;
  list: LinkedState | undefined;
  /** The `LinkedListNode` object that the program sees. */
  object: CsObject;
}

class LinkedState implements EnumerableState {
  first: LinkNode | undefined;
  last: LinkNode | undefined;
  count = 0;
  version = 0;

  constructor(
    readonly elementType: Type,
    /** The `LinkedList` object, which its nodes' `List` returns. */
    readonly owner: CsObject
  ) {}

  *nodes(): Generator<LinkNode> {
    const version = this.version;
    for (let node = this.first; node; node = node.next) {
      if (this.version !== version) throw collectionModifiedAfterStart();
      yield node;
    }
    if (this.version !== version) throw collectionModifiedAfterStart();
  }

  *enumerate(): Generator<Value> {
    for (const node of this.nodes()) yield node.value;
  }

  link(node: LinkNode, before: LinkNode | undefined): void {
    node.list = this;
    if (before) {
      node.next = before;
      node.previous = before.previous;
      if (before.previous) before.previous.next = node;
      else this.first = node;
      before.previous = node;
    } else {
      node.previous = this.last;
      node.next = undefined;
      if (this.last) this.last.next = node;
      else this.first = node;
      this.last = node;
    }
    this.count++;
    this.version++;
  }

  unlink(node: LinkNode): void {
    if (node.previous) node.previous.next = node.next;
    else this.first = node.next;
    if (node.next) node.next.previous = node.previous;
    else this.last = node.previous;
    node.previous = undefined;
    node.next = undefined;
    node.list = undefined;
    this.count--;
    this.version++;
  }

  references(): Value[] {
    return [...this.enumerate()];
  }

  display(): { kind: 'array'; items: [string, Value, Type][] } {
    return {
      kind: 'array',
      items: [...this.enumerate()].map((item, index) => [String(index), item, this.elementType]),
    };
  }
}

class LinkNodeState implements NativeState {
  constructor(readonly node: LinkNode) {}

  references(): Value[] {
    return [this.node.value, this.node.next?.object, this.node.previous?.object];
  }
}

function linkedOf(value: Value): LinkedState {
  if (value === undefined)
    fail('System.NullReferenceException', 'Object reference not set to an instance of an object.');
  return (value as CsObject).native as LinkedState;
}

function nodeOf(value: Value, name = 'node'): LinkNode {
  if (value === undefined) failNull(name);
  return ((value as CsObject).native as LinkNodeState).node;
}

function newNode(call: NativeCall, elementType: Type, value: Value): LinkNode {
  call.frame.runtime.retainSlots(1, [value]);
  const object = new CsObject(libraryType(call, 'System.Collections.Generic.LinkedListNode', [elementType]), []);
  const node: LinkNode = { value, previous: undefined, next: undefined, list: undefined, object };
  object.native = new LinkNodeState(node);
  return node;
}

function checkNode(state: LinkedState, node: LinkNode): void {
  if (node.list !== state)
    fail('System.InvalidOperationException', 'The LinkedList node does not belong to current LinkedList.');
}

const LINKED = 'System.Collections.Generic.LinkedList`1';
const NODE = 'System.Collections.Generic.LinkedListNode`1';

defineNatives({
  [`${LINKED}..ctor()`]: (call, receiver) =>
    setNative(receiver, new LinkedState(typeArgument(call), receiver as CsObject)),
  [`${LINKED}..ctor(IEnumerable<T>)`]: (call, receiver, [source]) => {
    const state = new LinkedState(typeArgument(call), receiver as CsObject);
    for (const item of iterate(call, source as Value, 'collection'))
      state.link(newNode(call, state.elementType, item), undefined);
    return setNative(receiver, state);
  },
  [`${LINKED}.get_Count`]: (_call, receiver) => linkedOf(receiver).count,
  [`${LINKED}.get_IsReadOnly`]: () => false,
  [`${LINKED}.get_First`]: (_call, receiver) => linkedOf(receiver).first?.object,
  [`${LINKED}.get_Last`]: (_call, receiver) => linkedOf(receiver).last?.object,
  [`${LINKED}.Add`]: (call, receiver, [value]) => {
    const state = linkedOf(receiver);
    state.link(newNode(call, state.elementType, value as Value), undefined);
    return;
  },
  [`${LINKED}.AddFirst`]: (call, receiver, [value]) => {
    const state = linkedOf(receiver);
    const node = newNode(call, state.elementType, value as Value);
    state.link(node, state.first);
    return node.object;
  },
  [`${LINKED}.AddLast`]: (call, receiver, [value]) => {
    const state = linkedOf(receiver);
    const node = newNode(call, state.elementType, value as Value);
    state.link(node, undefined);
    return node.object;
  },
  [`${LINKED}.AddAfter`]: (call, receiver, [after, value]) => {
    const state = linkedOf(receiver);
    const anchor = nodeOf(after as Value);
    checkNode(state, anchor);
    const node = newNode(call, state.elementType, value as Value);
    state.link(node, anchor.next);
    return node.object;
  },
  [`${LINKED}.AddBefore`]: (call, receiver, [before, value]) => {
    const state = linkedOf(receiver);
    const anchor = nodeOf(before as Value);
    checkNode(state, anchor);
    const node = newNode(call, state.elementType, value as Value);
    state.link(node, anchor);
    return node.object;
  },
  [`${LINKED}.Clear`]: (_call, receiver) => {
    const state = linkedOf(receiver);
    // Each node leaves detached, as a removal leaves it, so a node the program keeps reaches no other.
    for (let node = state.first; node;) {
      const next: LinkNode | undefined = node.next;
      node.list = undefined;
      node.previous = undefined;
      node.next = undefined;
      node = next;
    }
    state.first = undefined;
    state.last = undefined;
    state.count = 0;
    state.version++;
    return;
  },
  [`${LINKED}.Contains`]: (call, receiver, [value]) =>
    findNode(call, linkedOf(receiver), value as Value, false) !== undefined,
  [`${LINKED}.CopyTo`]: (call, receiver, [array, index]) => {
    copyToArray(call, [...linkedOf(receiver).enumerate()], array as Value, index as number);
    return;
  },
  [`${LINKED}.Find`]: (call, receiver, [value]) => findNode(call, linkedOf(receiver), value as Value, false)?.object,
  [`${LINKED}.FindLast`]: (call, receiver, [value]) => findNode(call, linkedOf(receiver), value as Value, true)?.object,
  [`${LINKED}.GetEnumerator`]: (call, receiver) =>
    enumeratorOf(call, typeArgument(call), linkedOf(receiver).enumerate(), [receiver]),
  [`${LINKED}.Remove(T)`]: (call, receiver, [value]) => {
    const state = linkedOf(receiver);
    const node = findNode(call, state, value as Value, false);
    if (!node) return false;
    state.unlink(node);
    return true;
  },
  [`${LINKED}.Remove(LinkedListNode<T>)`]: (_call, receiver, [value]) => {
    const state = linkedOf(receiver);
    const node = nodeOf(value as Value);
    checkNode(state, node);
    state.unlink(node);
    return;
  },
  [`${LINKED}.RemoveFirst`]: (_call, receiver) => {
    const state = linkedOf(receiver);
    if (!state.first) fail('System.InvalidOperationException', 'The LinkedList is empty.');
    state.unlink(state.first);
    return;
  },
  [`${LINKED}.RemoveLast`]: (_call, receiver) => {
    const state = linkedOf(receiver);
    if (!state.last) fail('System.InvalidOperationException', 'The LinkedList is empty.');
    state.unlink(state.last);
    return;
  },
  [`${NODE}..ctor`]: (call, receiver, [value]) => {
    call.frame.runtime.retainSlots(1, [value as Value]);
    const node: LinkNode = {
      value: value as Value,
      previous: undefined,
      next: undefined,
      list: undefined,
      object: receiver as CsObject,
    };
    return setNative(receiver, new LinkNodeState(node));
  },
  [`${NODE}.get_List`]: (_call, receiver) => nodeOf(receiver).list?.owner,
  [`${NODE}.get_Next`]: (_call, receiver) => nodeOf(receiver).next?.object,
  [`${NODE}.get_Previous`]: (_call, receiver) => nodeOf(receiver).previous?.object,
  [`${NODE}.get_Value`]: (_call, receiver) => nodeOf(receiver).value,
  [`${NODE}.set_Value`]: (call, receiver, [value]) => {
    const node = nodeOf(receiver);
    call.frame.runtime.chargeStore(node.value, value as Value);
    node.value = value as Value;
    return;
  },
});

function findNode(call: NativeCall, state: LinkedState, value: Value, fromEnd: boolean): LinkNode | undefined {
  const equality = equalityOf(call, undefined);
  const nodes = [...state.nodes()];
  if (fromEnd) nodes.reverse();
  return nodes.find((node) =>
    node.value === undefined ? value === undefined : value !== undefined && equality.equals(node.value, value)
  );
}

// ---- PriorityQueue ----

/** .NET's `PriorityQueue`: a quaternary min-heap, transcribed so that equal priorities leave in .NET's order. */
class HeapState implements NativeState {
  nodes: { element: Value; priority: Value }[] = [];
  version = 0;

  constructor(
    readonly compare: Comparison,
    readonly elementType: Type,
    readonly priorityType: Type
  ) {}

  enqueue(element: Value, priority: Value): void {
    const index = this.nodes.length;
    this.nodes.push({ element, priority });
    this.moveUp({ element, priority }, index);
    this.version++;
  }

  dequeue(): { element: Value; priority: Value } {
    if (this.nodes.length === 0) fail('System.InvalidOperationException', 'Queue empty.');
    const root = this.nodes[0];
    const last = this.nodes.pop() as { element: Value; priority: Value };
    if (this.nodes.length > 0) this.moveDown(last, 0);
    this.version++;
    return root;
  }

  private moveUp(node: { element: Value; priority: Value }, start: number): void {
    let index = start;
    while (index > 0) {
      const parentIndex = (index - 1) >> 2;
      const parent = this.nodes[parentIndex];
      if (this.compare(node.priority, parent.priority) < 0) {
        this.nodes[index] = parent;
        index = parentIndex;
      } else break;
    }
    this.nodes[index] = node;
  }

  moveDown(node: { element: Value; priority: Value }, start: number): void {
    let index = start;
    const size = this.nodes.length;
    for (let child = (index << 2) + 1; child < size; child = (index << 2) + 1) {
      let minChild = this.nodes[child];
      let minIndex = child;
      const upper = Math.min(child + 4, size);
      for (let next = child + 1; next < upper; next++) {
        if (this.compare(this.nodes[next].priority, minChild.priority) < 0) {
          minChild = this.nodes[next];
          minIndex = next;
        }
      }
      if (this.compare(node.priority, minChild.priority) <= 0) break;
      this.nodes[index] = minChild;
      index = minIndex;
    }
    this.nodes[index] = node;
  }

  references(): Value[] {
    return this.nodes.flatMap((node) => [node.element, node.priority]);
  }
}

function heapOf(value: Value): HeapState {
  if (value === undefined)
    fail('System.NullReferenceException', 'Object reference not set to an instance of an object.');
  return (value as CsObject).native as HeapState;
}

const PRIORITY_QUEUE = 'System.Collections.Generic.PriorityQueue`2';

defineNatives({
  [`${PRIORITY_QUEUE}..ctor()`]: (call, receiver) =>
    setNative(receiver, new HeapState(comparisonOf(call, undefined), typeArgument(call, 0), typeArgument(call, 1))),
  [`${PRIORITY_QUEUE}..ctor(int)`]: (call, receiver, [capacity]) => {
    if ((capacity as number) < 0) failNegative(call, 'initialCapacity', capacity as number);
    return setNative(
      receiver,
      new HeapState(comparisonOf(call, undefined), typeArgument(call, 0), typeArgument(call, 1))
    );
  },
  [`${PRIORITY_QUEUE}..ctor(IComparer<TPriority>?)`]: (call, receiver, [comparer]) =>
    setNative(
      receiver,
      new HeapState(comparisonOf(call, comparer as Value), typeArgument(call, 0), typeArgument(call, 1))
    ),
  [`${PRIORITY_QUEUE}.get_Count`]: (_call, receiver) => heapOf(receiver).nodes.length,
  [`${PRIORITY_QUEUE}.Clear`]: (_call, receiver) => {
    heapOf(receiver).nodes = [];
    return;
  },
  [`${PRIORITY_QUEUE}.Enqueue`]: (call, receiver, [element, priority]) => {
    call.frame.runtime.retainSlots(2, [element as Value, priority as Value]);
    heapOf(receiver).enqueue(element as Value, priority as Value);
    return;
  },
  [`${PRIORITY_QUEUE}.Dequeue`]: (_call, receiver) => heapOf(receiver).dequeue().element,
  [`${PRIORITY_QUEUE}.EnqueueDequeue`]: (_call, receiver, [element, priority]) => {
    const heap = heapOf(receiver);
    if (heap.nodes.length === 0 || heap.compare(priority as Value, heap.nodes[0].priority) <= 0)
      return element as Value;
    const root = heap.nodes[0];
    heap.moveDown({ element: element as Value, priority: priority as Value }, 0);
    return root.element;
  },
  [`${PRIORITY_QUEUE}.Peek`]: (_call, receiver) => {
    const heap = heapOf(receiver);
    if (heap.nodes.length === 0) fail('System.InvalidOperationException', 'Queue empty.');
    return heap.nodes[0].element;
  },
  [`${PRIORITY_QUEUE}.TryDequeue`]: (call, receiver, [element, priority]) => {
    const heap = heapOf(receiver);
    if (heap.nodes.length === 0) {
      refOf(element).set(evaluatorOf(call).defaultOf(heap.elementType));
      refOf(priority).set(evaluatorOf(call).defaultOf(heap.priorityType));
      return false;
    }
    const node = heap.dequeue();
    refOf(element).set(node.element);
    refOf(priority).set(node.priority);
    return true;
  },
  [`${PRIORITY_QUEUE}.TryPeek`]: (call, receiver, [element, priority]) => {
    const heap = heapOf(receiver);
    if (heap.nodes.length === 0) {
      refOf(element).set(evaluatorOf(call).defaultOf(heap.elementType));
      refOf(priority).set(evaluatorOf(call).defaultOf(heap.priorityType));
      return false;
    }
    refOf(element).set(heap.nodes[0].element);
    refOf(priority).set(heap.nodes[0].priority);
    return true;
  },
});

/** A read-only collection over a sorted dictionary's own keys or values, which changes as the dictionary does. */
function liveView(call: NativeCall, owner: SortedState, items: Value[], elementType: Type): CsObject {
  const view = new CsObject(libraryType(call, 'System.Collections.ObjectModel.ReadOnlyCollection', [elementType]), []);
  const state = new ListState(items, elementType);
  // The view's enumerators see the dictionary's changes, so changing it during foreach fails as .NET's does.
  Object.defineProperty(state, 'version', { get: () => owner.version, set: () => {} });
  state.modified = collectionModifiedAfterStart;
  view.native = state;
  return view;
}
