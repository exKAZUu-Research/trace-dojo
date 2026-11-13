import { inspect, toInt } from './conversions';
import { def, sdef } from './define';
import { argumentError, rubyError } from './errors';
import { callMethod, callProc, type Gen, nativeProc, requireBlock } from './interp';
import { iterate, STOP } from './libEnumerable';
import { NIL, RArray, type RHash, RObject, type RProc, type Value } from './objects';
import { type Frame, rt, RubyError } from './runtime';
import { arr, str, truthy } from './values';

/** What an enumerator iterates: a method of a receiver, called with the block it is given. */
export interface EnumeratorSource {
  /** The state of `next`: the suspended iteration and the calls it was inside when it suspended. */
  cursor?: Cursor;
  recv: Value;
  method: string;
  args: Value[];
  keywords?: RHash;
  size?: () => Value;
  held: () => Value[];
}

export function makeEnumerator(recv: Value, method: string, args: Value[], keywords?: RHash): RObject {
  const enumerator = new RObject(rt().c.Enumerator);
  const source: EnumeratorSource = {
    recv,
    method,
    args,
    keywords,
    held() {
      return [this.recv, ...this.args];
    },
  };
  enumerator.data = source;
  return enumerator;
}

export function sizedEnumerator(recv: Value, method: string, args: Value[], size: () => Value): RObject {
  const enumerator = makeEnumerator(recv, method, args);
  (enumerator.data as EnumeratorSource).size = size;
  return enumerator;
}

function sourceOf(self: RObject): EnumeratorSource {
  return self.data as EnumeratorSource;
}

/** Runs the enumerator's method, passing each yielded value (several packed into an array) to `visit`. */
export function* iterateEnumerator(self: RObject, visit: (value: Value) => Gen): Gen {
  const source = sourceOf(self);
  const block = nativeProc(-1, (args) => visit(args.length === 1 ? args[0] : arr(args)));
  return yield* callMethod(source.recv, source.method, source.args, source.keywords, block, { fcall: true });
}

def('Enumerator', 'each', [0, -1], function* (self: RObject, args, block) {
  if (!block) return self;
  const source = sourceOf(self);
  const blockArgs = [...source.args, ...args];
  return yield* callMethod(source.recv, source.method, blockArgs, source.keywords, block, { fcall: true });
});
def('Enumerator', ['with_index', 'each_with_index'], [0, 1], function* (self: RObject, args, block) {
  let index = args.length > 0 && args[0] !== NIL ? yield* toInt(args[0]) : 0n;
  if (!block) return makeEnumerator(self, 'with_index', args);
  const userBlock = block;
  const source = sourceOf(self);
  const proc = nativeProc(-1, (yielded) => {
    const value = yielded.length === 1 ? yielded[0] : arr(yielded);
    return callProc(userBlock, [value, index++]);
  });
  return yield* callMethod(source.recv, source.method, source.args, source.keywords, proc, { fcall: true });
});
def('Enumerator', ['with_object', 'each_with_object'], 1, function* (self: RObject, [memo], block) {
  if (!block) return makeEnumerator(self, 'with_object', [memo]);
  const userBlock = block;
  const source = sourceOf(self);
  const proc = nativeProc(-1, (yielded) => {
    const value = yielded.length === 1 ? yielded[0] : arr(yielded);
    return callProc(userBlock, [value, memo]);
  });
  yield* callMethod(source.recv, source.method, source.args, source.keywords, proc, { fcall: true });
  return memo;
});
def('Enumerator', 'size', 0, (self: RObject) => {
  const source = sourceOf(self);
  return source.size === undefined ? NIL : source.size();
});
def('Enumerator', ['inspect', 'to_s'], 0, function* (self: RObject) {
  const source = sourceOf(self);
  let text = `#<Enumerator: ${yield* inspect(source.recv)}:${source.method}`;
  if (source.args.length > 0) {
    const parts: string[] = [];
    for (const arg of source.args) parts.push(yield* inspect(arg));
    text += `(${parts.join(', ')})`;
  }
  return str(`${text}>`);
});
/** A curried lambda: it collects arguments until it has `arity`, then calls `proc` with them. */
export function curry(proc: RProc, arity: number, collected: Value[]): Value {
  if (collected.length >= arity) return undefined as never;
  return nativeProc(
    -1,
    (args) => {
      const all = [...collected, ...args];
      if (all.length >= arity) return callProc(proc, all);
      return curry(proc, arity, all);
    },
    true
  );
}

// External iteration ---------------------------------------------------------------------------------------------------

/** A value the iteration hands to `next`, suspending the generators that run the enumerator's method. */
class Suspension {
  constructor(readonly value: Value) {}
}

interface Cursor {
  runner: Generator<unknown, Value, unknown>;
  /** The frames, held values, and catch tags of the suspended calls, put back while the iteration resumes. */
  frames: Frame[];
  held: Value[];
  peeked: Value[];
  result?: Value;
}

function startCursor(self: RObject): Cursor {
  const runner = (function* () {
    return yield* iterateEnumerator(self, function* (value) {
      return (yield new Suspension(value)) as Value;
    });
  })();
  return { runner, frames: [], held: [], peeked: [] };
}

/** Resumes the iteration until it yields its next value, or raises StopIteration when it has ended. */
function nextValue(self: RObject): Value {
  const source = sourceOf(self);
  source.cursor ??= startCursor(self);
  const cursor = source.cursor;
  if (cursor.peeked.length > 0) return cursor.peeked.shift() as Value;
  if (cursor.result !== undefined) throw stopIteration(cursor.result);
  const runtime = rt();
  const frameBase = runtime.frames.length;
  const heldBase = runtime.held.length;
  const row = runtime.currentRow;
  runtime.frames.push(...cursor.frames);
  runtime.held.push(...cursor.held);
  let step: IteratorResult<unknown, Value>;
  try {
    step = cursor.runner.next(NIL);
  } finally {
    cursor.frames = runtime.frames.splice(frameBase);
    cursor.held = runtime.held.splice(heldBase);
    runtime.currentRow = row;
  }
  if (step.done) {
    cursor.result = step.value;
    throw stopIteration(step.value);
  }
  if (!(step.value instanceof Suspension)) throw new Error('An enumerator suspended for another reason');
  return step.value.value;
}

function stopIteration(result: Value): unknown {
  const error = rubyError(rt().c.StopIteration, 'iteration reached an end');
  error.exception.ivars = new Map([['@result', result]]);
  return error;
}

def('Enumerator', 'next', 0, (self: RObject) => nextValue(self));
def('Enumerator', 'peek', 0, (self: RObject) => {
  const value = nextValue(self);
  (sourceOf(self).cursor as Cursor).peeked.unshift(value);
  return value;
});
def('Enumerator', 'rewind', 0, (self: RObject) => {
  sourceOf(self).cursor = undefined;
  return self;
});
def('Enumerator', 'next_values', 0, (self: RObject) => {
  const value = nextValue(self);
  return arr([value]);
});

// Enumerator.new and its yielder --------------------------------------------------------------------------------------

/** The object `Enumerator.new` iterates: its block, which receives a yielder. */
interface GeneratorData {
  block: RProc;
  held(): Value[];
}

sdef('Enumerator', 'new', [0, 1], function* (_self, args, block) {
  const runtime = rt();
  const generator = new RObject(runtime.c['Enumerator::Generator']);
  const data: GeneratorData = {
    block: requireBlock(block),
    held() {
      return [this.block];
    },
  };
  generator.data = data;
  const enumerator = makeEnumerator(generator, 'each', []);
  const [size] = args;
  if (size !== undefined) (enumerator.data as EnumeratorSource).size = () => size;
  yield* [];
  return enumerator;
});
def('Enumerator::Generator', 'each', [0, -1], function* (self: RObject, args, block) {
  const yielder = new RObject(rt().c['Enumerator::Yielder']);
  const consumer = requireBlock(block);
  const data: { consumer: RProc; held(): Value[] } = {
    consumer,
    held() {
      return [this.consumer];
    },
  };
  yielder.data = data;
  return yield* callProc((self.data as GeneratorData).block, [yielder, ...args]);
});

function consumerOf(self: RObject): RProc {
  return (self.data as { consumer: RProc }).consumer;
}

def('Enumerator::Yielder', ['<<'], 1, function* (self: RObject, [value]) {
  yield* callProc(consumerOf(self), [value]);
  return self;
});
def('Enumerator::Yielder', ['yield', 'call'], [0, -1], function* (self: RObject, args) {
  return yield* callProc(consumerOf(self), args);
});
def('Enumerator::Yielder', 'to_proc', 0, (self: RObject) => nativeProc(-1, (args) => callProc(consumerOf(self), args)));
sdef('Enumerator', 'produce', [0, 1], function* (_self, args, block) {
  const step = requireBlock(block);
  const runtime = rt();
  const generator = new RObject(runtime.c['Enumerator::Generator']);
  const producer = nativeProc(1, function* ([yielder]) {
    let value = args.length > 0 ? args[0] : yield* callProc(step, []);
    for (;;) {
      yield* callMethod(yielder, '<<', [value]);
      try {
        value = yield* callProc(step, [value]);
      } catch (error) {
        if (error instanceof RubyError && error.exception.cls === runtime.c.StopIteration) return NIL;
        throw error;
      }
    }
  });
  generator.data = {
    block: producer,
    held() {
      return [step, ...args];
    },
  };
  return makeEnumerator(generator, 'each', []);
});

// Lazy -----------------------------------------------------------------------------------------------------------------

type LazyStep =
  | { kind: 'map' | 'select' | 'reject' | 'take_while' | 'drop_while' | 'filter_map' | 'flat_map'; block: RProc }
  | { kind: 'take' | 'drop'; count: number }
  | { kind: 'compact' }
  | { kind: 'with_index'; offset: bigint; block?: RProc };

interface LazyData {
  source: Value;
  steps: LazyStep[];
  held(): Value[];
}

function makeLazy(source: Value, steps: LazyStep[]): RObject {
  const lazy = new RObject(rt().c['Enumerator::Lazy']);
  const data: LazyData = {
    source,
    steps,
    held() {
      return [this.source, ...this.steps.flatMap((step) => ('block' in step && step.block ? [step.block] : []))];
    },
  };
  lazy.data = data;
  return lazy;
}

def('Enumerable', 'lazy', 0, (self) => makeLazy(self, []));
def('Enumerator::Lazy', 'lazy', 0, (self) => self);

for (const kind of ['map', 'collect', 'select', 'filter', 'reject', 'take_while', 'drop_while', 'filter_map', 'flat_map'] as const) {
  def('Enumerator::Lazy', kind, 0, (self: RObject, _args, block) => {
    const data = self.data as LazyData;
    const normalized = kind === 'collect' ? 'map' : kind === 'filter' ? 'select' : kind;
    return makeLazy(data.source, [...data.steps, { kind: normalized, block: requireBlock(block) }]);
  });
}
for (const kind of ['take', 'drop'] as const) {
  def('Enumerator::Lazy', kind, 1, function* (self: RObject, [count]) {
    const data = self.data as LazyData;
    const n = Number(yield* toInt(count));
    if (n < 0) throw argumentError(`attempt to ${kind} negative size`);
    return makeLazy(data.source, [...data.steps, { kind, count: n }]);
  });
}
def('Enumerator::Lazy', 'compact', 0, (self: RObject) => {
  const data = self.data as LazyData;
  return makeLazy(data.source, [...data.steps, { kind: 'compact' }]);
});
def('Enumerator::Lazy', ['with_index', 'each_with_index'], [0, 1], function* (self: RObject, args, block) {
  const data = self.data as LazyData;
  const offset = args.length > 0 && args[0] !== NIL ? yield* toInt(args[0]) : 0n;
  return makeLazy(data.source, [...data.steps, { kind: 'with_index', offset, block }]);
});

/** Runs a lazy chain: each element of the source passes the steps in turn, and `take` ends the iteration. */
function* runLazy(self: RObject, visit: (value: Value) => Gen<unknown>): Gen<void> {
  const data = self.data as LazyData;
  const states = data.steps.map((step) => ({ seen: 0, dropping: true, index: 'offset' in step ? step.offset : 0n }));
  const takeZero = data.steps.some((step) => step.kind === 'take' && step.count === 0);
  if (takeZero) return;
  yield* iterate(data.source, function* (value) {
    let values: Value[] = [value];
    for (const [index, step] of data.steps.entries()) {
      const state = states[index];
      const next: Value[] = [];
      for (const item of values) {
        switch (step.kind) {
          case 'map': {
            next.push(yield* callProc(step.block, [item]));
            break;
          }
          case 'select':
          case 'reject': {
            if (truthy(yield* callProc(step.block, [item])) === (step.kind === 'select')) next.push(item);
            break;
          }
          case 'filter_map': {
            const mapped = yield* callProc(step.block, [item]);
            if (truthy(mapped)) next.push(mapped);
            break;
          }
          case 'flat_map': {
            const mapped = yield* callProc(step.block, [item]);
            if (mapped instanceof RArray) next.push(...mapped.items);
            else next.push(mapped);
            break;
          }
          case 'take_while': {
            if (!truthy(yield* callProc(step.block, [item]))) return STOP;
            next.push(item);
            break;
          }
          case 'drop_while': {
            if (state.dropping && truthy(yield* callProc(step.block, [item]))) break;
            state.dropping = false;
            next.push(item);
            break;
          }
          case 'take': {
            next.push(item);
            state.seen++;
            break;
          }
          case 'drop': {
            if (state.seen++ >= step.count) next.push(item);
            break;
          }
          case 'compact': {
            if (item !== NIL) next.push(item);
            break;
          }
          case 'with_index': {
            const pair = arr([item, state.index++]);
            next.push(step.block ? yield* callProc(step.block, [item, (state.index - 1n)]) : pair);
            if (step.block) next[next.length - 1] = item;
            break;
          }
        }
      }
      values = next;
      if (values.length === 0) return undefined;
    }
    for (const item of values) if ((yield* visit(item)) === STOP) return STOP;
    const finished = data.steps.some((step, index) => step.kind === 'take' && states[index].seen >= step.count);
    return finished ? STOP : undefined;
  });
}

def('Enumerator::Lazy', 'each', 0, function* (self: RObject, _args, block) {
  if (!block) return self;
  yield* runLazy(self, (value) => callProc(block, [value], { used: false }));
  return self;
});
def('Enumerator::Lazy', ['force', 'to_a'], [0, -1], function* (self: RObject) {
  const items: Value[] = [];
  yield* runLazy(self, function* (value) {
    items.push(value);
    yield* [];
  });
  return arr(items);
});
def('Enumerator::Lazy', 'first', [0, 1], function* (self: RObject, args) {
  const items: Value[] = [];
  const count = args.length > 0 ? Number(yield* toInt(args[0])) : 1;
  if (count > 0) {
    yield* runLazy(self, function* (value) {
      items.push(value);
      yield* [];
      return items.length >= count ? STOP : undefined;
    });
  }
  if (args.length === 0) return items[0] ?? NIL;
  return arr(items);
});
def('Enumerator::Lazy', 'eager', 0, function* (self: RObject) {
  return makeEnumerator(self, 'each', []);
});
def('Enumerator::Lazy', ['inspect', 'to_s'], 0, function* (self: RObject) {
  const data = self.data as LazyData;
  let text = `#<Enumerator::Lazy: ${yield* inspect(data.source)}>`;
  for (const step of data.steps) {
    const argument = step.kind === 'take' || step.kind === 'drop' ? `(${step.count})` : '';
    text = `#<Enumerator::Lazy: ${text}:${step.kind}${argument}>`;
  }
  return str(text);
});
