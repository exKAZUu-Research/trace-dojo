import { addressOf, inspect, toInt } from './conversions';
import { def, sdef } from './define';
import { argumentCountError } from './errors';
import { callMethod, callProc, type Gen, nativeProc } from './interp';
import { rangeSize } from './libRange';
import { setSize } from './libSet';
import { NIL, RArray, RHash, RObject, type RProc, RRange, RString, RSymbol, type Value } from './objects';
import { rt, UnsupportedFeatureError } from './runtime';
import { arr, str, stringBytes, stringCharacters } from './values';

/** What an enumerator iterates: a method of a receiver, called with the block it is given. */
export interface EnumeratorSource {
  recv: Value;
  method: string;
  args: Value[];
  keywords?: RHash;
  size?: () => Value;
  arithmetic?: boolean;
  iterate?: (block: RProc) => Gen;
  held: () => Value[];
}

export function makeEnumerator(recv: Value, method: string, args: Value[], keywords?: RHash): RObject {
  const arithmetic =
    (method === 'step' || method === '%') &&
    (typeof recv === 'bigint' ||
      typeof recv === 'number' ||
      (recv instanceof RRange && (typeof recv.begin === 'bigint' || typeof recv.begin === 'number')));
  const enumerator = new RObject(arithmetic ? rt().c['Enumerator::ArithmeticSequence'] : rt().c.Enumerator);
  const source: EnumeratorSource = {
    recv,
    method,
    args,
    keywords,
    arithmetic,
    size: () => enumeratorSize(recv, method, args, keywords),
    held() {
      return [this.recv, ...this.args];
    },
  };
  enumerator.data = source;
  return enumerator;
}

function enumeratorSize(recv: Value, method: string, args: Value[], keywords?: RHash): Value {
  if (method === 'step' || method === '%') return stepSize(recv, args, keywords);
  if (recv instanceof RString && method === 'each_byte') return BigInt(stringBytes(recv).length);
  if (recv instanceof RArray && ARRAY_SELECTION_METHODS.has(method))
    return arraySelectionSize(recv.items.length, method, args[0]);
  if (typeof recv === 'bigint') {
    const limit = args[0];
    if (method === 'times') return recv > 0n ? recv : 0n;
    if (typeof limit === 'bigint' && method === 'upto') return limit >= recv ? limit - recv + 1n : 0n;
    if (typeof limit === 'bigint' && method === 'downto') return limit <= recv ? recv - limit + 1n : 0n;
  }
  const base = receiverSize(recv);
  if (method === 'each_slice' && typeof args[0] === 'bigint' && typeof base === 'bigint')
    return (base + args[0] - 1n) / args[0];
  if (method === 'each_cons' && typeof args[0] === 'bigint' && typeof base === 'bigint')
    return base >= args[0] ? base - args[0] + 1n : 0n;
  if (method === 'cycle' && typeof base === 'bigint') {
    if (base === 0n || (typeof args[0] === 'bigint' && args[0] <= 0n)) return 0n;
    return typeof args[0] === 'bigint' ? base * args[0] : Number.POSITIVE_INFINITY;
  }
  if (NIL_SIZE_METHODS.has(method)) return NIL;
  if (FIXED_SIZE_METHODS.has(method)) return base;
  return NIL;
}

function receiverSize(recv: Value): Value {
  if (recv instanceof RArray) return BigInt(recv.items.length);
  if (recv instanceof RHash) return BigInt(recv.map.size);
  if (recv instanceof RString) return BigInt(stringCharacters(recv).length);
  if (recv instanceof RRange) return rangeSize(recv);
  if (recv instanceof RObject && recv.cls.isSubclassOf(rt().c.Set)) return setSize(recv);
  if (recv instanceof RObject && recv.cls.isSubclassOf(rt().c.Enumerator)) return sourceOf(recv).size?.() ?? NIL;
  return NIL;
}

function arraySelectionSize(length: number, method: string, requested: Value | undefined): Value {
  if (requested !== undefined && typeof requested !== 'bigint') return NIL;
  const size = requested === undefined ? length : Number(requested);
  if (!Number.isSafeInteger(size)) return 0n;
  if (size < 0 || ((method === 'combination' || method === 'permutation') && size > length)) return 0n;
  if (size === 0) return 1n;
  if (method === 'repeated_permutation') {
    let result = 1n;
    for (let i = 0; i < size; i++) {
      rt().spend();
      result *= BigInt(length);
    }
    return result;
  }
  if (method === 'permutation') {
    let result = 1n;
    for (let i = 0; i < size; i++) {
      rt().spend();
      result *= BigInt(length - i);
    }
    return result;
  }
  const count = method === 'repeated_combination' ? length + size - 1 : length;
  if (count < 0) return 0n;
  let result = 1n;
  for (let i = 1; i <= size; i++) {
    rt().spend();
    result = (result * BigInt(count - i + 1)) / BigInt(i);
  }
  return result;
}

function stepSize(recv: Value, args: Value[], keywords?: RHash): Value {
  let start: Value = recv;
  let end: Value = args[0] ?? NIL;
  let step: Value = args[1] ?? 1n;
  let exclusive = false;
  if (recv instanceof RRange) {
    start = recv.begin;
    end = recv.end;
    step = args[0] ?? 1n;
    exclusive = recv.exclusive;
  }
  if (keywords) {
    for (const entry of keywords.map.values()) {
      if (entry.key instanceof RSymbol && entry.key.name === 'to') end = entry.value;
      if (entry.key instanceof RSymbol && entry.key.name === 'by') step = entry.value;
    }
  }
  if (
    (typeof start !== 'bigint' && typeof start !== 'number') ||
    (typeof end !== 'bigint' && typeof end !== 'number' && end !== NIL) ||
    (typeof step !== 'bigint' && typeof step !== 'number')
  )
    return NIL;
  if (end === NIL) return Number.POSITIVE_INFINITY;
  if (typeof start === 'bigint' && typeof end === 'bigint' && typeof step === 'bigint') {
    const distance = step > 0n ? end - start : start - end;
    const adjusted = distance - (exclusive ? 1n : 0n);
    return adjusted < 0n ? 0n : adjusted / (step > 0n ? step : -step) + 1n;
  }
  const distance = (Number(end) - Number(start)) / Number(step);
  if (!Number.isFinite(distance)) return distance > 0 ? Number.POSITIVE_INFINITY : 0n;
  const count = exclusive ? Math.ceil(distance - 1e-12) : Math.floor(distance + 1e-12) + 1;
  return BigInt(Math.max(0, count));
}

const FIXED_SIZE_METHODS = new Set([
  'each',
  'each_index',
  'each_key',
  'each_value',
  'reverse_each',
  'map',
  'map!',
  'flat_map',
  'select',
  'select!',
  'keep_if',
  'reject',
  'reject!',
  'delete_if',
  'filter_map',
  'partition',
  'each_with_index',
  'with_index',
  'each_with_object',
  'with_object',
  'each_entry',
  'min_by',
  'max_by',
  'minmax_by',
  'group_by',
  'transform_values',
  'transform_values!',
  'transform_keys',
  'transform_keys!',
  'each_char',
  'each_byte',
]);
const NIL_SIZE_METHODS = new Set(['find', 'find_index', 'take_while', 'drop_while', 'bsearch', 'each_line', 'loop']);
const ARRAY_SELECTION_METHODS = new Set(['combination', 'permutation', 'repeated_combination', 'repeated_permutation']);

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
  const source = sourceOf(self);
  if (source.arithmetic && args.length > 0) throw argumentCountError(args.length, 0, 0);
  if (!block) {
    if (args.length === 0) return self;
    const enumerator = makeEnumerator(source.recv, source.method, [...source.args, ...args], source.keywords);
    sourceOf(enumerator).size = () => NIL;
    return enumerator;
  }
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
  if (source.arithmetic) {
    const receiver = yield* inspect(source.recv);
    const argumentsText: string[] = [];
    for (const arg of source.args) argumentsText.push(yield* inspect(arg));
    if (source.keywords)
      for (const entry of source.keywords.map.values())
        argumentsText.push(
          `${entry.key instanceof RSymbol ? entry.key.name : yield* inspect(entry.key)}: ${yield* inspect(entry.value)}`
        );
    const argumentsList = argumentsText.length > 0 ? `(${argumentsText.join(', ')})` : '';
    return str(`(${source.recv instanceof RRange ? `(${receiver})` : receiver}.${source.method}${argumentsList})`);
  }
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
