import type { Entity } from '../entities';
import { equalityOf, mapKeyOf } from '../equality';
import { addBlockingMethod, addMethod, currentRuntime, definePackage, fn, namedType, typeEntity } from '../native';
import { GoFatal, GoPanic, type Suspending } from '../runtime';
import { nilPointerPanic } from '../runtimeErrors';
import { type Goroutine, scheduler } from '../scheduler';
import { ANY, BASIC, type FuncType, pointerTo } from '../types';
import { Cell, GoFunc, GoStruct, Iface, type NativeState, Pointer, type Value } from '../values';
import { BOOL, INT } from './support';

/**
 * The state of a sync type, kept outside Go's view of its fields. Copying the struct copies the state, as copying a
 * WaitGroup or a Mutex in Go copies its counter or lock, while the goroutines waiting on it stay with the original.
 */
interface CloneableState<T> {
  clone(): T;
  roots?(): unknown[];
}

function nativeState<T extends CloneableState<T>>(key: string, state: T): NativeState {
  return { [key]: state, clone: () => nativeState(key, state.clone()), roots: () => state.roots?.() ?? [] };
}

function stateOf<T extends CloneableState<T>>(receiver: Value, key: string, make: () => T): T {
  const struct = (receiver as Pointer | undefined)?.load() as GoStruct | undefined;
  if (!struct) nilPointerPanic();
  if (!struct.native || !(key in struct.native)) struct.native = nativeState(key, make());
  return struct.native[key] as T;
}

/** Calls a function value from a library function that may block, such as `sync.Once.Do`. */
function* callFunction(value: Value, args: Value[]): Suspending<Value | Value[]> {
  if (!(value instanceof GoFunc)) nilPointerPanic();
  return value.resume ? yield* value.resume(args) : value.call(args);
}

function stringPanic(message: string): never {
  throw new GoPanic(new Iface(BASIC.string, message));
}

const NO_ARGS: FuncType = fn([], []);

// WaitGroup -----------------------------------------------------------------------------------------------------------

class WaitGroupState {
  counter = 0;
  waiters: Goroutine[] = [];

  clone(): WaitGroupState {
    const copy = new WaitGroupState();
    copy.counter = this.counter;
    return copy;
  }

  add(delta: number): void {
    this.counter += delta;
    if (this.counter < 0) stringPanic('sync: negative WaitGroup counter');
    if (this.counter > 0) return;
    const running = scheduler();
    for (const waiter of this.waiters.splice(0)) running.ready(waiter);
  }
}

const WAIT_GROUP = namedType('sync', 'WaitGroup', { kind: 'struct', fields: [] });
const waitGroupOf = (receiver: Value): WaitGroupState => stateOf(receiver, 'waitGroup', () => new WaitGroupState());

addMethod(
  WAIT_GROUP,
  'Add',
  fn([INT], []),
  (receiver, [delta]) => {
    waitGroupOf(receiver).add(Number(delta as bigint));
    return;
  },
  true
);
addMethod(
  WAIT_GROUP,
  'Done',
  NO_ARGS,
  (receiver) => {
    waitGroupOf(receiver).add(-1);
    return;
  },
  true
);
addBlockingMethod(WAIT_GROUP, 'Wait', NO_ARGS, function* (receiver) {
  const state = waitGroupOf(receiver);
  if (state.counter === 0) return;
  const running = scheduler();
  state.waiters.push(running.current as Goroutine);
  yield* running.park('sync.WaitGroup.Wait');
  return;
});
/** `wg.Go(f)`: `wg.Add(1)` and a goroutine that calls f and then `wg.Done()`. */
addMethod(
  WAIT_GROUP,
  'Go',
  fn([fn([], [])], []),
  (receiver, [task]) => {
    const state = waitGroupOf(receiver);
    state.add(1);
    scheduler().spawn(
      function* () {
        try {
          yield* callFunction(task, []);
        } finally {
          state.add(-1);
        }
        return;
      },
      [task]
    );
    return;
  },
  true
);

// Mutex ---------------------------------------------------------------------------------------------------------------

/** A lock that hands itself to the goroutine that has waited longest when unlocked. */
class MutexState {
  locked = false;
  waiters: Goroutine[] = [];

  clone(): MutexState {
    const copy = new MutexState();
    copy.locked = this.locked;
    return copy;
  }

  *lock(): Suspending<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    const running = scheduler();
    this.waiters.push(running.current as Goroutine);
    yield* running.park('sync.Mutex.Lock');
  }

  unlock(): void {
    if (!this.locked) throw new GoFatal('fatal error: sync: unlock of unlocked mutex');
    const next = this.waiters.shift();
    if (next) scheduler().ready(next);
    else this.locked = false;
  }
}

const MUTEX = namedType('sync', 'Mutex', { kind: 'struct', fields: [] });
const mutexOf = (receiver: Value): MutexState => stateOf(receiver, 'mutex', () => new MutexState());

addBlockingMethod(MUTEX, 'Lock', NO_ARGS, function* (receiver) {
  yield* mutexOf(receiver).lock();
  return;
});
addMethod(
  MUTEX,
  'Unlock',
  NO_ARGS,
  (receiver) => {
    mutexOf(receiver).unlock();
    return;
  },
  true
);
addMethod(
  MUTEX,
  'TryLock',
  fn([], [BOOL]),
  (receiver) => {
    const state = mutexOf(receiver);
    if (state.locked) return false;
    state.locked = true;
    return true;
  },
  true
);

// RWMutex -------------------------------------------------------------------------------------------------------------

/**
 * A reader/writer lock. A waiting writer keeps new readers waiting, as in Go; unlocking wakes the goroutines waiting
 * longest: a writer, or all the readers ahead of the next writer.
 */
class RWMutexState {
  writing = false;
  readers = 0;
  queue: { goroutine: Goroutine; writer: boolean }[] = [];

  clone(): RWMutexState {
    const copy = new RWMutexState();
    copy.writing = this.writing;
    copy.readers = this.readers;
    return copy;
  }

  *acquire(writer: boolean): Suspending<void> {
    const free = writer ? !this.writing && this.readers === 0 : !this.writing && !this.queue.some((w) => w.writer);
    if (free && this.queue.length === 0) {
      if (writer) this.writing = true;
      else this.readers++;
      return;
    }
    const running = scheduler();
    this.queue.push({ goroutine: running.current as Goroutine, writer });
    yield* running.park(writer ? 'sync.RWMutex.Lock' : 'sync.RWMutex.RLock');
  }

  release(writer: boolean): void {
    if (writer) {
      if (!this.writing) throw new GoFatal('fatal error: sync: Unlock of unlocked RWMutex');
      this.writing = false;
    } else {
      if (this.readers === 0) throw new GoFatal('fatal error: sync: RUnlock of unlocked RWMutex');
      this.readers--;
    }
    this.wake();
  }

  private wake(): void {
    const running = scheduler();
    while (this.queue.length > 0 && !this.writing) {
      const next = this.queue[0];
      if (next.writer) {
        if (this.readers > 0) return;
        this.queue.shift();
        this.writing = true;
        running.ready(next.goroutine);
        return;
      }
      this.queue.shift();
      this.readers++;
      running.ready(next.goroutine);
    }
  }
}

const RW_MUTEX = namedType('sync', 'RWMutex', { kind: 'struct', fields: [] });
const rwMutexOf = (receiver: Value): RWMutexState => stateOf(receiver, 'rwMutex', () => new RWMutexState());

for (const [name, writer] of [
  ['Lock', true],
  ['RLock', false],
] as const) {
  addBlockingMethod(RW_MUTEX, name, NO_ARGS, function* (receiver) {
    yield* rwMutexOf(receiver).acquire(writer);
    return;
  });
}
for (const [name, writer] of [
  ['Unlock', true],
  ['RUnlock', false],
] as const) {
  addMethod(
    RW_MUTEX,
    name,
    NO_ARGS,
    (receiver) => {
      rwMutexOf(receiver).release(writer);
      return;
    },
    true
  );
}
for (const [name, writer] of [
  ['TryLock', true],
  ['TryRLock', false],
] as const) {
  addMethod(
    RW_MUTEX,
    name,
    fn([], [BOOL]),
    (receiver) => {
      const state = rwMutexOf(receiver);
      const free = writer
        ? !state.writing && state.readers === 0
        : !state.writing && !state.queue.some((w) => w.writer);
      if (!free) return false;
      if (writer) state.writing = true;
      else state.readers++;
      return true;
    },
    true
  );
}

const LOCKER = namedType('sync', 'Locker', {
  kind: 'interface',
  methods: [
    { name: 'Lock', type: NO_ARGS },
    { name: 'Unlock', type: NO_ARGS },
  ],
});
const RLOCKER = namedType('sync', 'rlocker', { kind: 'struct', fields: [] });
const readLockerOf = (receiver: Value): RWMutexState =>
  rwMutexOf(((receiver as Pointer).load() as GoStruct).native?.receiver as Value);
addMethod(
  RW_MUTEX,
  'RLocker',
  fn([], [LOCKER]),
  (receiver) =>
    new Iface(pointerTo(RLOCKER), new Pointer(new Cell(new GoStruct([], { receiver, roots: () => [receiver] })), 'v')),
  true
);
addBlockingMethod(RLOCKER, 'Lock', NO_ARGS, function* (receiver) {
  yield* readLockerOf(receiver).acquire(false);
  return;
});
addMethod(
  RLOCKER,
  'Unlock',
  NO_ARGS,
  (receiver) => {
    readLockerOf(receiver).release(false);
    return;
  },
  true
);

// Once ----------------------------------------------------------------------------------------------------------------

class OnceState {
  done = false;
  running = false;
  waiters: Goroutine[] = [];

  clone(): OnceState {
    const copy = new OnceState();
    copy.done = this.done;
    return copy;
  }
}

const ONCE = namedType('sync', 'Once', { kind: 'struct', fields: [] });

/** `once.Do(f)`: the first call runs f; the others wait until it returns, then do nothing. */
addBlockingMethod(ONCE, 'Do', fn([fn([], [])], []), function* (receiver, [task]) {
  const state = stateOf(receiver, 'once', () => new OnceState());
  if (state.done) return;
  const running = scheduler();
  if (state.running) {
    state.waiters.push(running.current as Goroutine);
    yield* running.park('sync.Mutex.Lock');
    return;
  }
  state.running = true;
  try {
    yield* callFunction(task, []);
  } finally {
    state.done = true;
    state.running = false;
    for (const waiter of state.waiters.splice(0)) running.ready(waiter);
  }
  return;
});

// Map -----------------------------------------------------------------------------------------------------------------

class MapState {
  entries = new Map<unknown, { key: Value; value: Value }>();
  private readonly keyOf = mapKeyOf(ANY);

  roots(): unknown[] {
    return [...this.entries.values()].flatMap(({ key, value }) => [key, value]);
  }

  clone(): MapState {
    const copy = new MapState();
    copy.entries = new Map([...this.entries].map(([hash, entry]) => [hash, { ...entry }]));
    return copy;
  }

  find(key: Value): { key: Value; value: Value } | undefined {
    return this.entries.get(this.keyOf(key));
  }

  store(key: Value, value: Value): void {
    const hash = this.keyOf(key);
    const found = this.entries.get(hash);
    if (found) found.value = value;
    else {
      currentRuntime().allocate(2);
      this.entries.set(hash, { key, value });
    }
  }

  remove(key: Value): { key: Value; value: Value } | undefined {
    const hash = this.keyOf(key);
    const found = this.entries.get(hash);
    this.entries.delete(hash);
    return found;
  }
}

const SYNC_MAP = namedType('sync', 'Map', { kind: 'struct', fields: [] });
const mapOf = (receiver: Value): MapState => stateOf(receiver, 'syncMap', () => new MapState());

const mapMethods: [string, FuncType, (state: MapState, args: Value[]) => Value | Value[]][] = [
  [
    'CompareAndSwap',
    fn([ANY, ANY, ANY], [BOOL]),
    (state, [key, old, value]) => {
      const found = state.find(key);
      if (!found || !equalityOf(ANY)(found.value, old)) return false;
      found.value = value;
      return true;
    },
  ],
  [
    'CompareAndDelete',
    fn([ANY, ANY], [BOOL]),
    (state, [key, old]) => {
      const found = state.find(key);
      if (!found || !equalityOf(ANY)(found.value, old)) return false;
      state.remove(key);
      return true;
    },
  ],
  [
    'Load',
    fn([ANY], [ANY, BOOL]),
    (state, [key]) => {
      const found = state.find(key);
      return [found?.value, found !== undefined];
    },
  ],
  [
    'Store',
    fn([ANY, ANY], []),
    (state, [key, value]) => {
      const found = state.find(key);
      if (found) found.value = value;
      else state.store(key, value);
      return;
    },
  ],
  [
    'LoadOrStore',
    fn([ANY, ANY], [ANY, BOOL]),
    (state, [key, value]) => {
      const found = state.find(key);
      if (found) return [found.value, true];
      state.store(key, value);
      return [value, false];
    },
  ],
  [
    'LoadAndDelete',
    fn([ANY], [ANY, BOOL]),
    (state, [key]) => {
      const found = state.remove(key);
      return [found?.value, found !== undefined];
    },
  ],
  [
    'Delete',
    fn([ANY], []),
    (state, [key]) => {
      state.remove(key);
      return;
    },
  ],
  [
    'Swap',
    fn([ANY, ANY], [ANY, BOOL]),
    (state, [key, value]) => {
      const found = state.find(key);
      if (found) {
        const previous = found.value;
        found.value = value;
        return [previous, true];
      }
      state.store(key, value);
      return [undefined, false];
    },
  ],
  [
    'Clear',
    NO_ARGS,
    (state) => {
      state.entries.clear();
      return;
    },
  ],
];
for (const [name, signature, impl] of mapMethods) {
  addMethod(SYNC_MAP, name, signature, (receiver, args) => impl(mapOf(receiver), args), true);
}
/** `m.Range(f)`: calls f for each entry in the order stored, until f returns false. */
addBlockingMethod(SYNC_MAP, 'Range', fn([fn([ANY, ANY], [BOOL])], []), function* (receiver, [visit]) {
  // The entries stored when Range began, of which the deleted ones are skipped.
  const snapshot = [...mapOf(receiver).entries];
  for (const [hash, entry] of snapshot) {
    if (mapOf(receiver).entries.get(hash) !== entry) continue;
    if ((yield* callFunction(visit, [entry.key, entry.value])) === false) break;
  }
  return;
});

const members: Record<string, Entity> = {
  WaitGroup: typeEntity(WAIT_GROUP),
  Mutex: typeEntity(MUTEX),
  RWMutex: typeEntity(RW_MUTEX),
  Locker: typeEntity(LOCKER),
  Once: typeEntity(ONCE),
  Map: typeEntity(SYNC_MAP),
};

export const SYNC_PACKAGE = definePackage('sync', members, [
  'Cond',
  'NewCond',
  'Pool',
  'OnceFunc',
  'OnceValue',
  'OnceValues',
]);
