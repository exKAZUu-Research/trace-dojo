import { addressOf, inspect, toInt } from './conversions';
import { def, sdef } from './define';
import { callMethod, callProc, type Gen, nativeProc } from './interp';
import { NIL, type RHash, RObject, type RProc, type Value } from './objects';
import { rt, UnsupportedFeatureError } from './runtime';
import { arr, str } from './values';

/** What an enumerator iterates: a method of a receiver, called with the block it is given. */
export interface EnumeratorSource {
  recv: Value;
  method: string;
  args: Value[];
  keywords?: RHash;
  size?: () => Value;
  iterate?: (block: RProc) => Gen;
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

export function customEnumerator(recv: Value, method: string, held: Value[], iterate: (block: RProc) => Gen): RObject {
  const enumerator = makeEnumerator(recv, method, []);
  const source = enumerator.data as EnumeratorSource;
  source.iterate = iterate;
  source.held = () => [recv, ...held];
  return enumerator;
}

function sourceOf(self: RObject): EnumeratorSource {
  return self.data as EnumeratorSource;
}

/** Runs the enumerator's method, passing each yielded value (several packed into an array) to `visit`. */
export function* iterateEnumerator(self: RObject, visit: (value: Value) => Gen): Gen {
  const source = sourceOf(self);
  const block = nativeProc(-1, (args) => visit(args.length === 1 ? args[0] : arr(args)));
  return yield* runSource(source, block);
}

function* runSource(source: EnumeratorSource, block: RProc, args: Value[] = []): Gen {
  if (source.iterate) return yield* source.iterate(block);
  return yield* callMethod(source.recv, source.method, [...source.args, ...args], source.keywords, block);
}

def('Enumerator', 'each', [0, -1], function* (self: RObject, args, block) {
  if (!block) return self;
  const source = sourceOf(self);
  return yield* runSource(source, block, args);
});
def('Enumerator', ['with_index', 'each_with_index'], [0, 1], function* (self: RObject, args, block) {
  let index = args.length > 0 && args[0] !== NIL ? yield* toInt(args[0]) : 0n;
  if (!block) return makeEnumerator(self, 'with_index', args);
  const userBlock = block;
  const source = sourceOf(self);
  const proc = nativeProc(-1, (yielded, _block, used) => {
    const value = yielded.length === 1 ? yielded[0] : arr(yielded);
    return callProc(userBlock, [value, index++], { used });
  });
  return yield* runSource(source, proc);
});
def('Enumerator', ['with_object', 'each_with_object'], 1, function* (self: RObject, [memo], block) {
  if (!block) return makeEnumerator(self, 'with_object', [memo]);
  const userBlock = block;
  const source = sourceOf(self);
  const proc = nativeProc(-1, (yielded, _block, used) => {
    const value = yielded.length === 1 ? yielded[0] : arr(yielded);
    return callProc(userBlock, [value, memo], { used });
  });
  yield* runSource(source, proc);
  return memo;
});
def('Enumerator', 'size', 0, (self: RObject) => {
  const source = sourceOf(self);
  return source.size === undefined ? NIL : source.size();
});
def('Enumerator', ['inspect', 'to_s'], 0, function* (self: RObject) {
  const source = sourceOf(self);
  if (source.iterate) return str(`#<Enumerator: #<Enumerator::Generator:${addressOf(self)}>:each>`);
  let text = `#<Enumerator: ${yield* inspect(source.recv)}:${source.method}`;
  if (source.args.length > 0) {
    const parts: string[] = [];
    for (const arg of source.args) parts.push(yield* inspect(arg));
    text += `(${parts.join(', ')})`;
  }
  return str(`${text}>`);
});
for (const name of ['next', 'peek', 'rewind', 'next_values', 'peek_values', 'feed', 'lazy', 'produce']) {
  def('Enumerator', name, [0, -1], () => {
    throw new UnsupportedFeatureError(`外部イテレータ（Enumerator#${name}）`);
  });
}
sdef('Enumerator', 'new', [0, -1], () => {
  throw new UnsupportedFeatureError('Enumerator.new');
});

/** A curried lambda: it collects arguments until it has `arity`, then calls `proc` with them. */
export function curry(proc: RProc, arity: number, collected: Value[]): Value {
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
