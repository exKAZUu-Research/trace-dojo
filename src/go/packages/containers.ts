import type { Entity } from '../entities';
import { addMethod, currentRuntime, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { nilPointerPanic } from '../runtimeErrors';
import { ANY, BASIC, type NamedType, pointerTo } from '../types';
import { Cell, GoStruct, Pointer, type Value } from '../values';
import { BOOL, callFunction, callMethod, INT, spendFor } from './support';

// container/heap: transcribed from Go's heap.go ---------------------------------------------------------------------

const HEAP_INTERFACE = namedType('heap', 'Interface', {
  kind: 'interface',
  methods: [
    { name: 'Len', type: fn([], [INT]) },
    { name: 'Less', type: fn([INT, INT], [BOOL]) },
    { name: 'Pop', type: fn([], [ANY]) },
    { name: 'Push', type: fn([ANY], []) },
    { name: 'Swap', type: fn([INT, INT], []) },
  ],
});

const len = (h: Value): number => Number(callMethod(h, 'Len') as bigint);
const lessAt = (h: Value, i: number, j: number): boolean => callMethod(h, 'Less', [BigInt(i), BigInt(j)]) === true;
const swapAt = (h: Value, i: number, j: number): void => void callMethod(h, 'Swap', [BigInt(i), BigInt(j)]);

function up(h: Value, start: number): void {
  let j = start;
  for (;;) {
    const i = Math.trunc((j - 1) / 2);
    if (i === j || !lessAt(h, j, i)) break;
    swapAt(h, i, j);
    j = i;
  }
}

function down(h: Value, i0: number, n: number): boolean {
  let i = i0;
  for (;;) {
    const j1 = 2 * i + 1;
    if (j1 >= n || j1 < 0) break;
    let j = j1;
    const j2 = j1 + 1;
    if (j2 < n && lessAt(h, j2, j1)) j = j2;
    if (!lessAt(h, j, i)) break;
    swapAt(h, i, j);
    i = j;
  }
  return i > i0;
}

const heapMembers: Record<string, Entity> = {
  Interface: typeEntity(HEAP_INTERFACE),
  Init: nativeFunction('Init', fn([HEAP_INTERFACE], []), ([h]) => {
    const n = len(h);
    for (let i = Math.trunc(n / 2) - 1; i >= 0; i--) down(h, i, n);
    return;
  }),
  Push: nativeFunction('Push', fn([HEAP_INTERFACE, ANY], []), ([h, x]) => {
    callMethod(h, 'Push', [x]);
    up(h, len(h) - 1);
    return;
  }),
  Pop: nativeFunction('Pop', fn([HEAP_INTERFACE], [ANY]), ([h]) => {
    const n = len(h) - 1;
    swapAt(h, 0, n);
    down(h, 0, n);
    return callMethod(h, 'Pop') as Value;
  }),
  Remove: nativeFunction('Remove', fn([HEAP_INTERFACE, INT], [ANY]), ([h, index]) => {
    const i = Number(index as bigint);
    const n = len(h) - 1;
    if (n !== i) {
      swapAt(h, i, n);
      if (!down(h, i, n)) up(h, i);
    }
    return callMethod(h, 'Pop') as Value;
  }),
  Fix: nativeFunction('Fix', fn([HEAP_INTERFACE, INT], []), ([h, index]) => {
    const i = Number(index as bigint);
    if (!down(h, i, len(h))) up(h, i);
    return;
  }),
};

export const HEAP_PACKAGE = definePackage('container/heap', heapMembers);

// container/list: transcribed from Go's list.go, with Element and List as Go structs -----------------------------

const ELEMENT: NamedType = namedType('list', 'Element', { kind: 'struct', fields: [] });
const LIST: NamedType = namedType('list', 'List', { kind: 'struct', fields: [] });
const ELEMENT_POINTER = pointerTo(ELEMENT);
const LIST_POINTER = pointerTo(LIST);
ELEMENT.underlying = {
  kind: 'struct',
  fields: [
    { name: 'next', type: ELEMENT_POINTER, embedded: false },
    { name: 'prev', type: ELEMENT_POINTER, embedded: false },
    { name: 'list', type: LIST_POINTER, embedded: false },
    { name: 'Value', type: ANY, embedded: false },
  ],
};
LIST.underlying = {
  kind: 'struct',
  fields: [
    { name: 'root', type: ELEMENT, embedded: false },
    { name: 'len', type: BASIC.int, embedded: false },
  ],
};

const NEXT = 0;
const PREV = 1;
const OWNER = 2;
const VALUE = 3;
const ELEMENT_FIELD_COUNT = 4;

function element(pointer: Value): GoStruct {
  if (!(pointer instanceof Pointer)) nilPointerPanic();
  return pointer.load() as GoStruct;
}

function rootOf(list: Pointer): Pointer {
  return new Pointer((list.load() as GoStruct).fields, 0);
}

function same(a: Value, b: Value): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (a as Pointer).equals(b as Pointer);
}

function lengthOf(list: Pointer): bigint {
  return (list.load() as GoStruct).fields[1] as bigint;
}

function setLength(list: Pointer, value: bigint): void {
  (list.load() as GoStruct).fields[1] = value;
}

function init(list: Pointer): Pointer {
  const root = rootOf(list);
  element(root).fields[NEXT] = root;
  element(root).fields[PREV] = root;
  setLength(list, 0n);
  return list;
}

function lazyInit(list: Pointer): void {
  if (element(rootOf(list)).fields[NEXT] === undefined) init(list);
}

function insert(list: Pointer, item: Pointer, at: Pointer): Pointer {
  const e = element(item);
  e.fields[PREV] = at;
  e.fields[NEXT] = element(at).fields[NEXT];
  element(e.fields[PREV]).fields[NEXT] = item;
  element(e.fields[NEXT]).fields[PREV] = item;
  e.fields[OWNER] = list;
  setLength(list, lengthOf(list) + 1n);
  return item;
}

function insertValue(list: Pointer, value: Value, at: Pointer): Pointer {
  const runtime = currentRuntime();
  runtime.spend();
  runtime.allocate(ELEMENT_FIELD_COUNT);
  return insert(list, new Pointer(new Cell(new GoStruct([undefined, undefined, undefined, value])), 'v'), at);
}

function remove(list: Pointer, item: Pointer): void {
  const e = element(item);
  element(e.fields[PREV]).fields[NEXT] = e.fields[NEXT];
  element(e.fields[NEXT]).fields[PREV] = e.fields[PREV];
  e.fields[NEXT] = undefined;
  e.fields[PREV] = undefined;
  e.fields[OWNER] = undefined;
  setLength(list, lengthOf(list) - 1n);
}

function move(item: Pointer, at: Pointer): void {
  if (same(item, at)) return;
  const e = element(item);
  element(e.fields[PREV]).fields[NEXT] = e.fields[NEXT];
  element(e.fields[NEXT]).fields[PREV] = e.fields[PREV];
  e.fields[PREV] = at;
  e.fields[NEXT] = element(at).fields[NEXT];
  element(e.fields[PREV]).fields[NEXT] = item;
  element(e.fields[NEXT]).fields[PREV] = item;
}

const owns = (list: Pointer, item: Value): boolean => same(element(item).fields[OWNER], list);

function neighbor(item: Value, field: number): Value {
  const e = element(item);
  const next = e.fields[field];
  const owner = e.fields[OWNER] as Pointer | undefined;
  if (owner && !same(next, rootOf(owner))) return next;
  return undefined;
}

addMethod(ELEMENT, 'Next', fn([], [ELEMENT_POINTER]), (receiver) => neighbor(receiver, NEXT), true);
addMethod(ELEMENT, 'Prev', fn([], [ELEMENT_POINTER]), (receiver) => neighbor(receiver, PREV), true);

const listMethod = (
  name: string,
  params: Parameters<typeof fn>[0],
  results: Parameters<typeof fn>[1],
  impl: (list: Pointer, args: Value[]) => Value
): void => {
  addMethod(
    LIST,
    name,
    fn(params, results),
    (receiver, args) => {
      if (!(receiver instanceof Pointer)) nilPointerPanic();
      return impl(receiver, args);
    },
    true
  );
};

listMethod('Init', [], [LIST_POINTER], (list) => init(list));
listMethod('Len', [], [INT], (list) => lengthOf(list));
listMethod('Front', [], [ELEMENT_POINTER], (list) =>
  lengthOf(list) === 0n ? undefined : element(rootOf(list)).fields[NEXT]
);
listMethod('Back', [], [ELEMENT_POINTER], (list) =>
  lengthOf(list) === 0n ? undefined : element(rootOf(list)).fields[PREV]
);
listMethod('Remove', [ELEMENT_POINTER], [ANY], (list, [item]) => {
  if (owns(list, item)) remove(list, item as Pointer);
  return element(item).fields[VALUE];
});
listMethod('PushFront', [ANY], [ELEMENT_POINTER], (list, [value]) => {
  lazyInit(list);
  return insertValue(list, value, rootOf(list));
});
listMethod('PushBack', [ANY], [ELEMENT_POINTER], (list, [value]) => {
  lazyInit(list);
  return insertValue(list, value, element(rootOf(list)).fields[PREV] as Pointer);
});
listMethod('InsertBefore', [ANY, ELEMENT_POINTER], [ELEMENT_POINTER], (list, [value, mark]) =>
  owns(list, mark) ? insertValue(list, value, element(mark).fields[PREV] as Pointer) : undefined
);
listMethod('InsertAfter', [ANY, ELEMENT_POINTER], [ELEMENT_POINTER], (list, [value, mark]) =>
  owns(list, mark) ? insertValue(list, value, mark as Pointer) : undefined
);
listMethod('MoveToFront', [ELEMENT_POINTER], [], (list, [item]) => {
  if (owns(list, item) && !same(element(rootOf(list)).fields[NEXT], item)) move(item as Pointer, rootOf(list));
  return;
});
listMethod('MoveToBack', [ELEMENT_POINTER], [], (list, [item]) => {
  if (owns(list, item) && !same(element(rootOf(list)).fields[PREV], item))
    move(item as Pointer, element(rootOf(list)).fields[PREV] as Pointer);
  return;
});
listMethod('MoveBefore', [ELEMENT_POINTER, ELEMENT_POINTER], [], (list, [item, mark]) => {
  if (owns(list, item) && !same(item, mark) && owns(list, mark))
    move(item as Pointer, element(mark).fields[PREV] as Pointer);
  return;
});
listMethod('MoveAfter', [ELEMENT_POINTER, ELEMENT_POINTER], [], (list, [item, mark]) => {
  if (owns(list, item) && !same(item, mark) && owns(list, mark)) move(item as Pointer, mark as Pointer);
  return;
});

listMethod('PushBackList', [LIST_POINTER], [], (list, [other]) => {
  lazyInit(list);
  const values = listValues(other as Pointer);
  for (const value of values) insertValue(list, value, element(rootOf(list)).fields[PREV] as Pointer);
  return;
});
listMethod('PushFrontList', [LIST_POINTER], [], (list, [other]) => {
  lazyInit(list);
  for (const value of listValues(other as Pointer).toReversed()) insertValue(list, value, rootOf(list));
  return;
});

/** The values of a list, read before inserting them, since a list may be inserted into itself. */
function listValues(list: Value): Value[] {
  if (!(list instanceof Pointer)) nilPointerPanic();
  spendFor(Number(lengthOf(list)));
  const values: Value[] = [];
  let item = lengthOf(list) === 0n ? undefined : element(rootOf(list)).fields[NEXT];
  for (let count = lengthOf(list); count > 0n; count--) {
    values.push(element(item).fields[VALUE]);
    item = element(item).fields[NEXT];
  }
  return values;
}

function newList(): Pointer {
  currentRuntime().allocate(ELEMENT_FIELD_COUNT + 2);
  const root = new GoStruct([undefined, undefined, undefined, undefined]);
  return init(new Pointer(new Cell(new GoStruct([root, 0n])), 'v'));
}

const listMembers: Record<string, Entity> = {
  Element: typeEntity(ELEMENT),
  List: typeEntity(LIST),
  New: nativeFunction('New', fn([], [LIST_POINTER]), () => newList()),
};

export const LIST_PACKAGE = definePackage('container/list', listMembers);

// container/ring: transcribed from Go's ring.go, with Ring as a Go struct ------------------------------------------

const RING: NamedType = namedType('ring', 'Ring', { kind: 'struct', fields: [] });
const RING_POINTER = pointerTo(RING);
RING.underlying = {
  kind: 'struct',
  fields: [
    { name: 'next', type: RING_POINTER, embedded: false },
    { name: 'prev', type: RING_POINTER, embedded: false },
    { name: 'Value', type: ANY, embedded: false },
  ],
};

const VALUE_OF_RING = 2;

const newRingPointer = (): Pointer => new Pointer(new Cell(new GoStruct([undefined, undefined, undefined])), 'v');
const ringOf = (pointer: Value): GoStruct => {
  if (!(pointer instanceof Pointer)) nilPointerPanic();
  return pointer.load() as GoStruct;
};

/** Go's (*Ring).init: a ring of one element links to itself. */
function initRing(r: Pointer): Pointer {
  ringOf(r).fields[NEXT] = r;
  ringOf(r).fields[PREV] = r;
  return r;
}

function ringNext(r: Pointer): Pointer {
  if (ringOf(r).fields[NEXT] === undefined) return initRing(r);
  return ringOf(r).fields[NEXT] as Pointer;
}

function ringPrev(r: Pointer): Pointer {
  if (ringOf(r).fields[NEXT] === undefined) return initRing(r);
  return ringOf(r).fields[PREV] as Pointer;
}

function ringMove(r: Pointer, steps: number): Pointer {
  if (ringOf(r).fields[NEXT] === undefined) return initRing(r);
  let current = r;
  if (steps < 0) for (let n = steps; n < 0; n++) current = ringOf(current).fields[PREV] as Pointer;
  else for (let n = steps; n > 0; n--) current = ringOf(current).fields[NEXT] as Pointer;
  return current;
}

function ringLink(r: Pointer, s: Value): Pointer {
  const n = ringNext(r);
  if (s instanceof Pointer) {
    const p = ringPrev(s);
    ringOf(r).fields[NEXT] = s;
    ringOf(s).fields[PREV] = r;
    ringOf(n).fields[PREV] = p;
    ringOf(p).fields[NEXT] = n;
  }
  return n;
}

function ringLength(r: Value): number {
  if (!(r instanceof Pointer)) return 0;
  let count = 1;
  for (let p = ringNext(r); !p.equals(r); p = ringOf(p).fields[NEXT] as Pointer) count++;
  return count;
}

addMethod(RING, 'Next', fn([], [RING_POINTER]), (r) => ringNext(r as Pointer), true);
addMethod(RING, 'Prev', fn([], [RING_POINTER]), (r) => ringPrev(r as Pointer), true);
addMethod(RING, 'Move', fn([INT], [RING_POINTER]), (r, [n]) => ringMove(r as Pointer, Number(n as bigint)), true);
addMethod(RING, 'Link', fn([RING_POINTER], [RING_POINTER]), (r, [s]) => ringLink(r as Pointer, s), true);
addMethod(
  RING,
  'Unlink',
  fn([INT], [RING_POINTER]),
  (r, [count]) => {
    const n = Number(count as bigint);
    if (n <= 0) return;
    return ringLink(r as Pointer, ringMove(r as Pointer, n + 1));
  },
  true
);
addMethod(RING, 'Len', fn([], [INT]), (r) => BigInt(ringLength(r)), true);
addMethod(
  RING,
  'Do',
  fn([fn([ANY], [])], []),
  (r, [visit]) => {
    if (!(r instanceof Pointer)) return;
    callFunction(visit, [ringOf(r).fields[VALUE_OF_RING]]);
    for (let p = ringNext(r); !p.equals(r); p = ringOf(p).fields[NEXT] as Pointer) {
      callFunction(visit, [ringOf(p).fields[VALUE_OF_RING]]);
    }
    return;
  },
  true
);

const ringMembers: Record<string, Entity> = {
  Ring: typeEntity(RING),
  New: nativeFunction('New', fn([INT], [RING_POINTER]), ([count]) => {
    const n = Number(count as bigint);
    if (n <= 0) return;
    const r = initRing(newRingPointer());
    let p = r;
    for (let index = 1; index < n; index++) {
      const next = newRingPointer();
      ringOf(next).fields[PREV] = p;
      ringOf(p).fields[NEXT] = next;
      p = next;
    }
    ringOf(p).fields[NEXT] = r;
    ringOf(r).fields[PREV] = p;
    return r;
  }),
};

export const RING_PACKAGE = definePackage('container/ring', ringMembers);
