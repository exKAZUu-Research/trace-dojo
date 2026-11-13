import { addressOf, inspect, numericCompare, toInt } from './conversions';
import { def, sdef } from './define';
import { argumentCountError, argumentError, floatDomainError, rangeError } from './errors';
import { floatStepCount } from './floatMath';
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
  generatorAddress?: string;
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
    if (typeof limit === 'number' && (method === 'upto' || method === 'downto')) {
      if (Number.isNaN(limit)) throw floatDomainError('NaN');
      if (!Number.isFinite(limit)) return (method === 'upto') === limit > 0 ? Number.POSITIVE_INFINITY : 0n;
      const end = BigInt(method === 'upto' ? Math.floor(limit) : Math.ceil(limit));
      const distance = method === 'upto' ? end - recv : recv - end;
      return distance < 0n ? 0n : distance + 1n;
    }
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
  if (method === 'loop') return Number.POSITIVE_INFINITY;
  if (NIL_SIZE_METHODS.has(method)) return NIL;
  if (FIXED_SIZE_METHODS.has(method)) return base;
  return NIL;
}

export function receiverSize(recv: Value): Value {
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
  const { start, end, step, exclusive } = arithmeticSpec(recv, args, keywords);
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
  const count = floatStepCount(Number(start), Number(end), Number(step), exclusive);
  if (Number.isNaN(count)) throw floatDomainError('NaN');
  return Number.isFinite(count) ? BigInt(count) : Number.POSITIVE_INFINITY;
}

function arithmeticSpec(
  recv: Value,
  args: Value[],
  keywords?: RHash
): {
  start: Value;
  end: Value;
  step: Value;
  exclusive: boolean;
} {
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
  return { start, end, step, exclusive };
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
  'each_codepoint',
]);
const NIL_SIZE_METHODS = new Set(['find', 'find_index', 'take_while', 'drop_while', 'bsearch', 'each_line']);
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
  source.generatorAddress = addressOf(enumerator);
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
    if (source.iterate) {
      const enumerator = new RObject(rt().c.Enumerator);
      enumerator.data = { ...source, args: [...source.args, ...args], size: () => NIL } satisfies EnumeratorSource;
      return enumerator;
    }
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
for (const name of ['begin', 'end', 'step'] as const)
  def('Enumerator::ArithmeticSequence', name, 0, (self: RObject) => {
    const source = sourceOf(self);
    const spec = arithmeticSpec(source.recv, source.args, source.keywords);
    return name === 'begin' ? spec.start : name === 'end' ? spec.end : spec.step;
  });
def('Enumerator::ArithmeticSequence', 'exclude_end?', 0, (self: RObject) => {
  const source = sourceOf(self);
  return arithmeticSpec(source.recv, source.args, source.keywords).exclusive;
});
def('Enumerator::ArithmeticSequence', 'last', [0, 1], function* (self: RObject, args) {
  const source = sourceOf(self);
  const { start, step, end, exclusive } = arithmeticSpec(source.recv, source.args, source.keywords);
  if (end === NIL) throw rangeError('cannot get the last element of endless arithmetic sequence');
  for (const value of [start, end, step])
    if (typeof value === 'number' && !Number.isFinite(value))
      throw floatDomainError(Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity');
  const index = arithmeticLastIndex(
    start as bigint | number,
    end as bigint | number,
    step as bigint | number,
    exclusive
  );
  if (args.length === 0) {
    if (
      index < 0n &&
      !(
        source.recv instanceof RRange &&
        exclusive &&
        numericCompare(start as bigint | number, end as bigint | number) === 0
      )
    )
      return NIL;
    return arithmeticValue(start as bigint | number, step as bigint | number, index);
  }
  const requested = yield* toInt(args[0]);
  if (requested < 0n) throw argumentError('negative array size');
  const values: Value[] = [];
  const count = requested < index + 1n ? requested : index + 1n;
  let value = arithmeticValue(start as bigint | number, step as bigint | number, index);
  value =
    typeof value === 'bigint' && typeof step === 'bigint'
      ? value - step * count
      : Number(value) - Number(step) * Number(count);
  for (let position = 0n; position < count; position++) {
    rt().spend();
    value = typeof value === 'bigint' && typeof step === 'bigint' ? value + step : Number(value) + Number(step);
    values.push(value);
  }
  return arr(values);
});
def('Enumerator::ArithmeticSequence', 'hash', 0, (self: RObject) => {
  const source = sourceOf(self);
  const { start, end, step, exclusive } = arithmeticSpec(source.recv, source.args, source.keywords);
  const parts = [
    canonicalNumber(start),
    end === NIL ? 'nil' : canonicalNumber(end),
    canonicalNumber(step),
    String(exclusive),
  ];
  let hash = 0xcb_f2_9c_e4_84_22_23_25n;
  for (const char of parts.join('|'))
    hash = ((hash ^ BigInt(char.codePointAt(0) as number)) * 0x1_00_00_00_01_b3n) & 0xff_ff_ff_ff_ff_ff_ff_ffn;
  return hash;
});

function arithmeticLastIndex(
  start: bigint | number,
  end: bigint | number,
  step: bigint | number,
  exclusive: boolean
): bigint {
  if (typeof start === 'bigint' && typeof end === 'bigint' && typeof step === 'bigint') {
    if ((step > 0n && end < start) || (step < 0n && end > start)) return -1n;
    let index = (end - start) / step;
    if (exclusive && start + index * step === end) index--;
    return index;
  }
  let index = Math.floor((Number(end) - Number(start)) / Number(step));
  if (exclusive && Number(start) + Number(step) * index === Number(end)) index--;
  return BigInt(index);
}

function arithmeticValue(start: bigint | number, step: bigint | number, index: bigint): Value {
  return typeof start === 'bigint' && typeof step === 'bigint'
    ? start + step * index
    : Number(start) + Number(step) * Number(index);
}

function canonicalNumber(value: Value): string {
  if (typeof value === 'bigint') return `i${value}`;
  return `f${typeof value === 'number' && value === 0 ? 0 : value}`;
}
for (const name of ['==', '===', 'eql?'])
  def('Enumerator::ArithmeticSequence', name, 1, (self: RObject, [other]) => {
    if (!(other instanceof RObject) || other.cls !== rt().c['Enumerator::ArithmeticSequence']) return false;
    const left = sourceOf(self);
    const right = sourceOf(other);
    const a = arithmeticSpec(left.recv, left.args, left.keywords);
    const b = arithmeticSpec(right.recv, right.args, right.keywords);
    return (
      a.exclusive === b.exclusive &&
      numericCompare(a.start as bigint | number, b.start as bigint | number) === 0 &&
      (a.end === NIL
        ? b.end === NIL
        : b.end !== NIL && numericCompare(a.end as bigint | number, b.end as bigint | number) === 0) &&
      numericCompare(a.step as bigint | number, b.step as bigint | number) === 0
    );
  });
def('Enumerator', ['inspect', 'to_s'], 0, function* (self: RObject) {
  const source = sourceOf(self);
  if (self.cls === rt().c['Enumerator::Chain']) {
    const elements: string[] = [];
    for (const value of [source.recv, ...source.held().slice(1)]) elements.push(yield* inspect(value));
    return str(`#<Enumerator::Chain: [${elements.join(', ')}]>`);
  }
  if (source.iterate) {
    const argumentsText: string[] = [];
    for (const arg of source.args) argumentsText.push(yield* inspect(arg));
    return str(
      `#<Enumerator: #<Enumerator::Generator:${source.generatorAddress ?? addressOf(self)}>:each${argumentsText.length > 0 ? `(${argumentsText.join(', ')})` : ''}>`
    );
  }
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
