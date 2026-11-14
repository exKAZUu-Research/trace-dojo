import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import {
  addressOf,
  caseEquals,
  comparisonFailed,
  inspect,
  numericCompare,
  spaceship,
  toIndex,
  toIndexExact,
  toInt,
  toStepFloat,
  tryImplicitConversion,
} from './conversions';
import { def, sdef } from './define';
import { argumentCountError, argumentError, floatDomainError, rangeError, rubyError, typeError } from './errors';
import { floatStepCount } from './floatMath';
import { pushFrameReferences } from './garbageCollection';
import { hashGet, hashSet } from './hashes';
import {
  callMethod,
  callProc,
  flattenGenerator,
  type Gen,
  isGenerator,
  nativeProc,
  requireBlock,
  respondsTo,
  runToEnd,
} from './interp';
import { iterate, iterateYielded, STOP, zipCollections } from './libEnumerable';
import { rangeSize } from './libRange';
import { setSize } from './libSet';
import {
  isRubyFloat,
  isRubyNumber,
  NIL,
  RArray,
  RHash,
  RObject,
  RProc,
  RRange,
  RString,
  RSymbol,
  type Value,
} from './objects';
import { type Frame, rt, RubyError, UnsupportedFeatureError } from './runtime';
import { arr, isA, newHash, realClassOf, str, stringBytes, stringCharacterCount, truthy } from './values';

/** What an enumerator iterates: a method of a receiver, called with the block it is given. */
export interface EnumeratorSource {
  /** The state of `next`: the suspended iteration and the calls it was inside when it suspended. */
  cursor?: Cursor;
  recv: Value;
  method: string;
  args: Value[];
  keywords?: RHash;
  size?: () => Value | Gen<Value>;
  arithmetic?: boolean;
  sizeBlock?: RProc;
  generatorAddress?: string;
  iterate?: (block: RProc) => Gen;
  held: () => Value[];
}

export function makeEnumerator(
  recv: Value,
  method: string,
  args: Value[],
  keywords?: RHash,
  explicit?: { sizeBlock?: RProc }
): RObject {
  const sizeBlock = explicit?.sizeBlock;
  const spec = method === 'step' || method === '%' ? arithmeticSpec(recv, args, keywords) : undefined;
  const arithmetic =
    spec !== undefined &&
    (spec.end === NIL || isRubyNumber(spec.end)) &&
    isRubyNumber(spec.step) &&
    (isRubyNumber(recv) || (recv instanceof RRange && isRubyNumber(recv.begin)));
  const enumerator = new RObject(arithmetic ? rt().c['Enumerator::ArithmeticSequence'] : rt().c.Enumerator);
  const source: EnumeratorSource = {
    recv,
    method,
    args,
    keywords,
    arithmetic,
    sizeBlock,
    size:
      explicit === undefined
        ? () => enumeratorSize(recv, method, args, keywords)
        : sizeBlock === undefined
          ? () => NIL
          : () => callProc(sizeBlock, args),
    held() {
      return [
        this.recv,
        ...this.args,
        ...(this.keywords ? [this.keywords] : []),
        ...(this.sizeBlock ? [this.sizeBlock] : []),
        ...cursorRoots(this.cursor),
      ];
    },
  };
  enumerator.data = source;
  return enumerator;
}

function* enumeratorSize(recv: Value, method: string, args: Value[], keywords?: RHash): Gen<Value> {
  if (method === 'step' || method === '%') return yield* stepSize(recv, args, keywords);
  if (recv instanceof RString && method === 'each_byte') return BigInt(stringBytes(recv).length);
  if (recv instanceof RArray && ARRAY_SELECTION_METHODS.has(method))
    return arraySelectionSize(recv.items.length, method, args[0] === undefined ? undefined : yield* toInt(args[0]));
  if (typeof recv === 'bigint') {
    const limit = args[0];
    if (method === 'times') return recv > 0n ? recv : 0n;
    if (typeof limit === 'bigint' && method === 'upto') return limit >= recv ? limit - recv + 1n : 0n;
    if (typeof limit === 'bigint' && method === 'downto') return limit <= recv ? recv - limit + 1n : 0n;
    if (isRubyFloat(limit) && (method === 'upto' || method === 'downto')) {
      const boundary = Number(limit);
      if (Number.isNaN(boundary)) throw floatDomainError('NaN');
      if (!Number.isFinite(boundary)) return (method === 'upto') === boundary > 0 ? Number.POSITIVE_INFINITY : 0n;
      const end = BigInt(method === 'upto' ? Math.floor(boundary) : Math.ceil(boundary));
      const distance = method === 'upto' ? end - recv : recv - end;
      return distance < 0n ? 0n : distance + 1n;
    }
  }
  const base = receiverSize(recv);
  if (method === 'each_slice' && args[0] !== undefined && typeof base === 'bigint') {
    const count = (yield* toIndexExact(args[0])).integer;
    if (count <= 0n) throw argumentError('invalid slice size');
    return (base + count - 1n) / count;
  }
  if (method === 'each_cons' && args[0] !== undefined && typeof base === 'bigint') {
    const count = (yield* toIndexExact(args[0])).integer;
    if (count <= 0n) throw argumentError('invalid size');
    return base >= count ? base - count + 1n : 0n;
  }
  if (method === 'cycle' && typeof base === 'bigint') {
    if (base === 0n) return 0n;
    const count = args[0] === undefined || args[0] === NIL ? undefined : (yield* toIndexExact(args[0])).integer;
    if (count !== undefined && count <= 0n) return 0n;
    return count === undefined ? Number.POSITIVE_INFINITY : base * count;
  }
  if (method === 'loop') return Number.POSITIVE_INFINITY;
  if (NIL_SIZE_METHODS.has(method)) return NIL;
  if (FIXED_SIZE_METHODS.has(method)) return base;
  return NIL;
}

export function receiverSize(recv: Value): Value {
  if (recv instanceof RArray) return BigInt(recv.items.length);
  if (recv instanceof RHash) return BigInt(recv.map.size);
  if (recv instanceof RString) return BigInt(stringCharacterCount(recv));
  if (recv instanceof RRange) return rangeSize(recv);
  if (recv instanceof RObject && recv.cls.isSubclassOf(rt().c.Set)) return setSize(recv);
  if (recv instanceof RObject && recv.cls.isSubclassOf(rt().c.Enumerator)) {
    const size = sourceOf(recv).size?.() ?? NIL;
    return isGenerator(size) ? runToEnd(size) : size;
  }
  return NIL;
}

function arraySelectionSize(length: number, method: string, requested: bigint | undefined): Value {
  if (length === 0 && requested !== undefined && requested > 0n) return 0n;
  if (requested !== undefined && requested >= 0n && length === 1 && method.startsWith('repeated_')) return 1n;
  if (method === 'repeated_combination' && requested !== undefined) {
    if (requested < 0n) return 0n;
    const factors = BigInt(length - 1);
    const total = BigInt(length) + requested - 1n;
    let result = 1n;
    for (let index = 1n; index <= factors; index++) {
      rt().spend();
      result = (result * (total - factors + index)) / index;
    }
    return result;
  }
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

function* stepSize(recv: Value, args: Value[], keywords?: RHash): Gen<Value> {
  const { start, end: originalEnd, step, exclusive } = arithmeticSpec(recv, args, keywords);
  const end =
    originalEnd !== NIL &&
    typeof originalEnd !== 'bigint' &&
    !isRubyFloat(originalEnd) &&
    (isRubyFloat(start) || isRubyFloat(step))
      ? yield* toStepFloat(originalEnd)
      : originalEnd;
  if (!isRubyNumber(start) || (!isRubyNumber(end) && end !== NIL) || !isRubyNumber(step)) return NIL;
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
  source.held = () => [recv, ...held, ...cursorRoots(source.cursor)];
  source.generatorAddress = addressOf(enumerator);
  return enumerator;
}

function sourceOf(self: RObject): EnumeratorSource {
  if (self.cls === rt().c['Enumerator::Lazy']) {
    const data = self.data as LazyData;
    data.enumerator ??= {
      recv: self,
      method: 'each',
      args: [],
      size: () => lazySize(self),
      iterate: (block) => callMethod(self, 'each', [], undefined, block),
      held: () => [self, ...data.held()],
    };
    return data.enumerator;
  }
  return self.data as EnumeratorSource;
}

/** Runs the enumerator's method, passing each yielded value (several packed into an array) to `visit`. */
export function* iterateEnumerator(self: RObject, visit: (value: Value) => Gen): Gen {
  return yield* iterateEnumeratorArgs(self, (args) => visit(args.length === 1 ? args[0] : arr(args)));
}

function* iterateEnumeratorArgs(self: RObject, visit: (args: Value[]) => Gen): Gen {
  const source = sourceOf(self);
  const block = nativeProc(-1, visit);
  return yield* runSource(source, block);
}

function* runSource(source: EnumeratorSource, block: RProc, args: Value[] = []): Gen {
  if (source.iterate) {
    const count = source.args.length + args.length;
    if (source.method === 'chain' && count > 0) throw argumentCountError(count, 0, 0);
    return yield* source.iterate(block);
  }
  return yield* callMethod(source.recv, source.method, [...source.args, ...args], source.keywords, block, {
    fcall: true,
  });
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
def('Enumerator', 'with_index', [0, 1], (self: RObject, args, block) => withIndex(self, args, block, 'with_index'));
def('Enumerator', 'each_with_index', 0, (self: RObject, args, block) =>
  withIndex(self, args, block, 'each_with_index')
);

function* withIndex(self: RObject, args: Value[], block: RProc | undefined, name: string): Gen {
  let index = args.length > 0 && args[0] !== NIL ? yield* toInt(args[0]) : 0n;
  if (!block) return makeEnumerator(self, name, args);
  const userBlock = block;
  const source = sourceOf(self);
  const proc = nativeProc(-1, (yielded, _block, used) => {
    const value = yielded.length === 1 ? yielded[0] : arr(yielded);
    return callProc(userBlock, [value, index++], { used });
  });
  return yield* runSource(source, proc);
}
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
def('Enumerator', 'size', 0, function* (self: RObject) {
  const source = sourceOf(self);
  if (source.size === undefined) return NIL;
  const result = source.size();
  return isGenerator(result) ? yield* result : result;
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
def('Enumerator::ArithmeticSequence', 'first', [0, 1], function* (self: RObject, args) {
  const source = sourceOf(self);
  const { start, end, step } = arithmeticSpec(source.recv, source.args, source.keywords);
  const floatSequence = isRubyFloat(start) || isRubyFloat(end) || isRubyFloat(step);
  const first = floatSequence ? Number(start) : start;
  const order = yield* arithmeticFirstOrder(start, end, floatSequence, args.length === 0);
  const empty = order !== undefined && ((Number(step) > 0 && order > 0) || (Number(step) < 0 && order < 0));
  if (args.length === 0) {
    if (isRubyFloat(step) && Number.isNaN(Number(step))) throw comparisonFailed(step, 0n);
    return empty ? NIL : start;
  }
  const count = yield* toIndex(args[0]);
  if (count < 0) throw argumentError('attempt to take negative size');
  if (empty) return arr([]);
  if (isRubyFloat(step) && Number.isNaN(Number(step))) {
    rt().chargeSlots(count);
    rt().spend(count);
    return arr(Array.from({ length: count }, () => Number.NaN));
  }
  if (isRubyFloat(step) && !Number.isFinite(Number(step))) return arr(count === 0 ? [] : [first]);
  if ((isRubyFloat(end) && Number.isNaN(Number(end))) || (isRubyFloat(start) && Number.isNaN(Number(start)))) {
    const values: Value[] = [];
    for (let index = 0; index < count; index++) {
      rt().spend();
      values.push(Number(first) + Number(step) * index);
    }
    return arr(values);
  }
  return yield* callMethod(self, 'take', [BigInt(count)]);
});

function* arithmeticFirstOrder(
  start: Value,
  end: Value,
  floatSequence: boolean,
  uncounted: boolean
): Gen<number | undefined> {
  if (end === NIL) return undefined;
  const customFloatEnd = floatSequence && !isRubyNumber(end);
  if (customFloatEnd && !uncounted) return undefined;
  return yield* spaceship(start, customFloatEnd ? yield* toStepFloat(end) : end);
}

def('Enumerator::ArithmeticSequence', 'last', [0, 1], function* (self: RObject, args) {
  const source = sourceOf(self);
  const { start, step, end, exclusive } = arithmeticSpec(source.recv, source.args, source.keywords);
  if (end === NIL) throw rangeError('cannot get the last element of endless arithmetic sequence');
  if (isRubyFloat(step) && Number.isNaN(Number(step))) throw floatDomainError('NaN');
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
    return arithmeticLastValue(
      start as bigint | number,
      end as bigint | number,
      step as bigint | number,
      index,
      exclusive
    );
  }
  const requested = yield* toInt(args[0]);
  if (requested < 0n) throw argumentError('negative array size');
  const values: Value[] = [];
  const count = requested < index + 1n ? requested : index + 1n;
  let value = arithmeticLastValue(
    start as bigint | number,
    end as bigint | number,
    step as bigint | number,
    index,
    exclusive
  );
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
  if (!Number.isFinite(index))
    throw floatDomainError(Number.isNaN(index) ? 'NaN' : index > 0 ? 'Infinity' : '-Infinity');
  if (exclusive && Number(start) + Number(step) * index === Number(end)) index--;
  return BigInt(index);
}

function arithmeticValue(start: bigint | number, step: bigint | number, index: bigint): Value {
  return typeof start === 'bigint' && typeof step === 'bigint'
    ? start + step * index
    : Number(start) + Number(step) * Number(index);
}

function arithmeticLastValue(
  start: bigint | number,
  end: bigint | number,
  step: bigint | number,
  index: bigint,
  exclusive: boolean
): Value {
  if (typeof start === 'bigint' && typeof step === 'bigint') return arithmeticValue(start, step, index);
  const value = Number(start) + Number(step) * Math.floor((Number(end) - Number(start)) / Number(step));
  return exclusive && value === Number(end) ? value - Number(step) : value;
}

function canonicalNumber(value: Value): string {
  if (typeof value === 'bigint') return `i${value}`;
  return `f${Number(value) === 0 ? 0 : Number(value)}`;
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
    const elements = new BoundedTextParts('#<Enumerator::Chain: []>'.length);
    for (const value of [source.recv, ...source.held().slice(1)]) elements.add(yield* inspect(value));
    return str(`#<Enumerator::Chain: [${elements.text()}]>`);
  }
  if (source.iterate) {
    const prefix = `#<Enumerator: #<Enumerator::Generator:${source.generatorAddress ?? addressOf(self)}>:each`;
    const argumentsText = new BoundedTextParts(prefix.length + (source.args.length > 0 ? 3 : 1));
    for (const arg of source.args) argumentsText.add(yield* inspect(arg));
    return str(`${prefix}${argumentsText.count > 0 ? `(${argumentsText.text()})` : ''}>`);
  }
  if (source.arithmetic) {
    const receiver = yield* inspect(source.recv);
    const prefix = `(${source.recv instanceof RRange ? `(${receiver})` : receiver}.${source.method}`;
    const argumentsText = new BoundedTextParts(prefix.length + 3);
    for (const arg of source.args) argumentsText.add(yield* inspect(arg));
    if (source.keywords)
      for (const entry of source.keywords.map.values())
        argumentsText.add(
          `${entry.key instanceof RSymbol ? entry.key.name : yield* inspect(entry.key)}: ${yield* inspect(entry.value)}`
        );
    const argumentsList = argumentsText.count > 0 ? `(${argumentsText.text()})` : '';
    return str(`${prefix}${argumentsList})`);
  }
  let text = `#<Enumerator: ${yield* inspect(source.recv)}:${source.method}`;
  if (source.args.length > 0) {
    const parts = new BoundedTextParts(text.length + 3);
    for (const arg of source.args) parts.add(yield* inspect(arg));
    text += `(${parts.text()})`;
  }
  return str(`${text}>`);
});

class BoundedTextParts {
  private readonly parts: string[] = [];
  private length: number;

  constructor(prefixLength: number) {
    this.length = prefixLength;
  }

  get count(): number {
    return this.parts.length;
  }

  add(part: string): void {
    this.length += part.length + (this.parts.length > 0 ? 2 : 0);
    if (this.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
    rt().spend(Math.ceil(part.length / 256));
    this.parts.push(part);
  }

  text(): string {
    return this.parts.join(', ');
  }
}
/** A curried lambda: it collects arguments until it has `arity`, then calls `proc` with them. */
export function curry(proc: RProc, arity: number, collected: Value[]): Value {
  const curried = nativeProc(
    -1,
    (args) => {
      const all = [...collected, ...args];
      if (all.length >= arity) return callProc(proc, all);
      return curry(proc, arity, all);
    },
    true
  );
  curried.captured = [proc, ...collected];
  return curried;
}

// External iteration ---------------------------------------------------------------------------------------------------

/** A value the iteration hands to `next`, suspending the generators that run the enumerator's method. */
class Suspension {
  constructor(readonly args: Value[]) {}
}

interface Cursor {
  runner: Generator<unknown, Value, unknown>;
  /** The frames, held values, and catch tags of the suspended calls, put back while the iteration resumes. */
  frames: Frame[];
  held: Value[];
  catchTags: Value[];
  peeked: Value[][];
  feed?: Value;
  feedSet: boolean;
  started: boolean;
  result?: Value;
}

function cursorRoots(cursor: Cursor | undefined): Value[] {
  if (!cursor) return [];
  const values = [...cursor.held, ...cursor.catchTags, ...cursor.peeked.flat()];
  if (cursor.feedSet) values.push(cursor.feed as Value);
  if (cursor.result !== undefined) values.push(cursor.result);
  for (const frame of cursor.frames) pushFrameReferences(frame, values);
  return values;
}

function startCursor(self: RObject): Cursor {
  const runner = flattenGenerator(
    (function* () {
      return yield* iterateEnumeratorArgs(self, function* (args) {
        return (yield new Suspension(args)) as Value;
      });
    })()
  );
  return { runner, frames: [], held: [], catchTags: [], peeked: [], feedSet: false, started: false };
}

/** Resumes the iteration until it yields its next value, or raises StopIteration when it has ended. */
function nextValues(self: RObject): Value[] {
  const source = sourceOf(self);
  source.cursor ??= startCursor(self);
  const cursor = source.cursor;
  if (cursor.peeked.length > 0) return cursor.peeked.shift() as Value[];
  if (cursor.result !== undefined) throw stopIteration(cursor.result);
  const runtime = rt();
  const frameBase = runtime.frames.length;
  const heldBase = runtime.held.length;
  const row = runtime.currentRow;
  const callerTags = runtime.catchTags.splice(0);
  runtime.frames.push(...cursor.frames);
  runtime.held.push(...cursor.held);
  runtime.catchTags.push(...cursor.catchTags);
  let step: IteratorResult<unknown, Value>;
  let failed = false;
  try {
    const feed = cursor.started && cursor.feedSet ? cursor.feed : NIL;
    if (cursor.started) {
      cursor.feedSet = false;
      cursor.feed = undefined;
    }
    step = cursor.runner.next(feed);
    cursor.started = true;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    cursor.frames = runtime.frames.splice(frameBase);
    cursor.held = runtime.held.splice(heldBase);
    cursor.catchTags = runtime.catchTags.splice(0);
    runtime.catchTags.push(...callerTags);
    runtime.currentRow = row;
    if (failed) source.cursor = undefined;
  }
  if (step.done) {
    cursor.result = step.value;
    throw stopIteration(step.value);
  }
  if (!(step.value instanceof Suspension)) throw new Error('An enumerator suspended for another reason');
  return step.value.args;
}

function nextValue(self: RObject): Value {
  const args = nextValues(self);
  return args.length === 0 ? NIL : args.length === 1 ? args[0] : arr(args);
}

function stopIteration(result: Value): unknown {
  const error = rubyError(rt().c.StopIteration, 'iteration reached an end');
  error.exception.ivars = new Map([['@result', result]]);
  return error;
}

def('Enumerator', 'next', 0, (self: RObject) => nextValue(self));
def('Enumerator', 'peek', 0, (self: RObject) => {
  const args = nextValues(self);
  (sourceOf(self).cursor as Cursor).peeked.unshift(args);
  return args.length === 0 ? NIL : args.length === 1 ? args[0] : arr(args);
});
def('Enumerator', 'rewind', 0, function* (self: RObject) {
  const receiver = sourceOf(self).recv;
  if (receiver !== self && respondsTo(receiver, 'rewind')) yield* callMethod(receiver, 'rewind', []);
  sourceOf(self).cursor = undefined;
  return self;
});
def('Enumerator', 'next_values', 0, (self: RObject) => {
  return arr(nextValues(self));
});
def('Enumerator', 'peek_values', 0, (self: RObject) => {
  const args = nextValues(self);
  (sourceOf(self).cursor as Cursor).peeked.unshift(args);
  return arr(args);
});
def('Enumerator', 'feed', 1, (self: RObject, [value]) => {
  const source = sourceOf(self);
  source.cursor ??= startCursor(self);
  if (source.cursor.feedSet) throw typeError('feed value already set');
  source.cursor.feed = value;
  source.cursor.feedSet = true;
  return NIL;
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
  if (size !== undefined) {
    const source = enumerator.data as EnumeratorSource;
    if (size instanceof RProc || respondsTo(size, 'call')) {
      source.size = () => callMethod(size, 'call', []);
      const previousHeld = source.held?.bind(source);
      source.held = () => [...(previousHeld?.() ?? []), size];
    } else {
      const normalized = size === NIL || (isRubyFloat(size) && Number(size) === Infinity) ? size : yield* toInt(size);
      source.size = () => normalized;
    }
  }
  return enumerator;
});
def('Enumerator::Generator', 'each', [0, -1], function* (self: RObject, args, block) {
  const producer = (self.data as GeneratorData | undefined)?.block;
  if (!producer) throw argumentError('uninitialized generator');
  const yielder = new RObject(rt().c['Enumerator::Yielder']);
  const consumer = requireBlock(block);
  const data: { consumer: RProc; held(): Value[] } = {
    consumer,
    held() {
      return [this.consumer];
    },
  };
  yielder.data = data;
  return yield* callProc(producer, [yielder, ...args]);
});

def(
  'Enumerator::Generator',
  'initialize',
  0,
  (self: RObject, _args, block) => {
    if (!block) throw rubyError(rt().c.LocalJumpError, 'no block given');
    self.data = { block, held: () => [block] } satisfies GeneratorData;
    return NIL;
  },
  { visibility: 'private' }
);

function consumerOf(self: RObject): RProc {
  const consumer = (self.data as { consumer?: RProc } | undefined)?.consumer;
  if (!consumer) throw argumentError('uninitialized yielder');
  return consumer;
}

def(
  'Enumerator::Yielder',
  'initialize',
  0,
  (self: RObject, _args, block) => {
    if (!block) throw rubyError(rt().c.LocalJumpError, 'no block given');
    self.data = { consumer: block, held: () => [block] };
    return NIL;
  },
  { visibility: 'private' }
);

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
    try {
      let value = args.length > 0 ? args[0] : yield* callProc(step, []);
      for (;;) {
        yield* callMethod(yielder, '<<', [value]);
        value = yield* callProc(step, [value]);
      }
    } catch (error) {
      if (error instanceof RubyError && isA(error.exception, runtime.c.StopIteration)) return NIL;
      throw error;
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

type LazyStep = (
  | { kind: 'map' | 'select' | 'reject' | 'take_while' | 'drop_while' | 'filter_map' | 'flat_map'; block: RProc }
  | { kind: 'take' | 'drop'; count: number }
  | { kind: 'compact' }
  | { kind: 'with_index'; offset: bigint; block?: RProc }
  | { kind: 'grep' | 'grep_v'; pattern: Value; block?: RProc }
  | { kind: 'uniq'; block?: RProc }
  | { kind: 'zip'; others: Value[] }
  | { kind: 'each_slice' | 'each_cons'; count: number }
  | { kind: 'each_entry' }
  | { kind: 'each_with_object'; memo: Value }
) & { label?: string; args?: Value[] };

interface LazyData {
  source: Value;
  steps: LazyStep[];
  enumerator?: EnumeratorSource;
  held(): Value[];
}

function* lazySize(self: RObject): Gen {
  const { source, steps } = self.data as LazyData;
  if (!respondsTo(source, 'size')) return NIL;
  let size = yield* callMethod(source, 'size', []);
  for (const step of steps) size = nextLazySize(size, step);
  return size;
}

function nextLazySize(size: Value, step: LazyStep): Value {
  if (size === NIL) return NIL;
  if (step.kind === 'take') {
    if (typeof size === 'bigint') return size < BigInt(step.count) ? size : BigInt(step.count);
    if (isRubyFloat(size)) return Number(size) < step.count ? size : BigInt(step.count);
    return size;
  }
  if (step.kind === 'drop') {
    if (typeof size === 'bigint') return size > BigInt(step.count) ? size - BigInt(step.count) : 0n;
    if (isRubyFloat(size)) return Math.max(0, Number(size) - step.count);
    return size;
  }
  if (step.kind === 'each_slice' && typeof size === 'bigint')
    return (size + BigInt(step.count - 1)) / BigInt(step.count);
  if (step.kind === 'each_cons' && typeof size === 'bigint')
    return size >= BigInt(step.count) ? size - BigInt(step.count) + 1n : 0n;
  return ['map', 'with_index', 'zip', 'each_entry', 'each_with_object'].includes(step.kind) ? size : NIL;
}

function makeLazy(source: Value, steps: LazyStep[]): RObject {
  const lazy = new RObject(rt().c['Enumerator::Lazy']);
  const data: LazyData = {
    source,
    steps,
    held() {
      return [
        this.source,
        ...this.steps.flatMap((step) => ('block' in step && step.block ? [step.block] : [])),
        ...this.steps.flatMap((step) => step.args ?? []),
        ...this.steps.flatMap((step) => ('pattern' in step ? [step.pattern] : 'others' in step ? step.others : [])),
        ...cursorRoots(this.enumerator?.cursor),
      ];
    },
  };
  lazy.data = data;
  return lazy;
}

def('Enumerable', 'lazy', 0, (self) => makeLazy(self, []));
def('Enumerator::Lazy', 'lazy', 0, (self) => self);

for (const kind of [
  'map',
  'collect',
  'select',
  'filter',
  'reject',
  'take_while',
  'drop_while',
  'filter_map',
  'flat_map',
  'collect_concat',
  'find_all',
] as const) {
  def('Enumerator::Lazy', kind, 0, (self: RObject, _args, block) => {
    const data = self.data as LazyData;
    const normalized =
      kind === 'collect'
        ? 'map'
        : kind === 'filter' || kind === 'find_all'
          ? 'select'
          : kind === 'collect_concat'
            ? 'flat_map'
            : kind;
    return makeLazy(data.source, [...data.steps, { kind: normalized, block: requireBlock(block), label: kind }]);
  });
}
for (const kind of ['grep', 'grep_v'] as const) {
  def('Enumerator::Lazy', kind, 1, (self: RObject, [pattern], block) => {
    const data = self.data as LazyData;
    return makeLazy(data.source, [...data.steps, { kind, pattern, block, args: [pattern] }]);
  });
}
def('Enumerator::Lazy', 'uniq', 0, (self: RObject, _args, block) => {
  const data = self.data as LazyData;
  return makeLazy(data.source, [...data.steps, { kind: 'uniq', block }]);
});
for (const kind of ['each_slice', 'each_cons'] as const) {
  def('Enumerator::Lazy', kind, 1, function* (self: RObject, [count], block) {
    const size = Number(yield* toInt(count));
    if (size <= 0) throw argumentError('invalid slice size');
    const data = self.data as LazyData;
    const lazy = makeLazy(data.source, [...data.steps, { kind, count: size, args: [count] }]);
    if (!block) return lazy;
    yield* runLazy(lazy, (value) => callProc(block, [value], { used: false }));
    return self;
  });
}
def('Enumerator::Lazy', 'each_entry', 0, function* (self: RObject, _args, block) {
  const data = self.data as LazyData;
  const lazy = makeLazy(data.source, [...data.steps, { kind: 'each_entry' }]);
  if (!block) return lazy;
  yield* runLazy(lazy, (value) => callProc(block, [value], { used: false }));
  return self;
});
for (const name of ['each_with_object', 'with_object']) {
  def('Enumerator::Lazy', name, 1, function* (self: RObject, [memo], block) {
    if (block) {
      yield* runLazy(self, (value) => callProc(block, [value, memo], { used: false }));
      return memo;
    }
    const data = self.data as LazyData;
    return makeLazy(data.source, [...data.steps, { kind: 'each_with_object', memo, label: name, args: [memo] }]);
  });
}
for (const name of ['slice_when', 'slice_before', 'slice_after', 'chunk', 'chunk_while'])
  def('Enumerator::Lazy', name, [0, -1], () => {
    throw new UnsupportedFeatureError(`Enumerator::Lazy#${name}`);
  });
def('Enumerator::Lazy', 'zip', [0, -1], function* (self: RObject, others, block) {
  if (block) return yield* zipCollections(self, others, block);
  for (const other of others)
    if (!(other instanceof RArray) && !respondsTo(other, 'each', true))
      throw typeError(`wrong argument type ${realClassOf(other).name} (must respond to :each)`);
  const data = self.data as LazyData;
  return makeLazy(data.source, [...data.steps, { kind: 'zip', others, args: others }]);
});
for (const kind of ['take', 'drop'] as const) {
  def('Enumerator::Lazy', kind, 1, function* (self: RObject, [count]) {
    const data = self.data as LazyData;
    const n = Number(yield* toInt(count));
    if (n < 0) throw argumentError(`attempt to ${kind} negative size`);
    return makeLazy(data.source, [...data.steps, { kind, count: n, args: [count] }]);
  });
}
def('Enumerator::Lazy', 'compact', 0, (self: RObject) => {
  const data = self.data as LazyData;
  return makeLazy(data.source, [...data.steps, { kind: 'compact' }]);
});
def('Enumerator::Lazy', 'with_index', [0, 1], function* (self: RObject, args, block) {
  const data = self.data as LazyData;
  const offset = args.length > 0 && args[0] !== NIL ? yield* toInt(args[0]) : 0n;
  return makeLazy(data.source, [...data.steps, { kind: 'with_index', offset, block, args }]);
});
def('Enumerator::Lazy', 'each_with_index', 0, function* (self: RObject, _args, block) {
  if (!block) return yield* callMethod(self, 'with_index', []);
  let index = 0n;
  return yield* runLazy(self, (value) => callProc(block, [value, index++], { used: false }));
});

/** Runs a lazy chain: each element of the source passes the steps in turn, and `take` ends the iteration. */
function* runLazy(self: RObject, visit: (value: Value, yielded?: Value[]) => Gen<unknown>, args: Value[] = []): Gen {
  const data = self.data as LazyData;
  const states: LazyState[] = data.steps.map((step) => ({
    seen: 0,
    dropping: true,
    index: 'offset' in step ? step.offset : 0n,
  }));
  const takeZero = data.steps.some((step) => step.kind === 'take' && step.count === 0);
  if (takeZero) return NIL;
  const held = rt().held.length;
  const arrays = rt().heldArrays;
  const arrayMark = arrays.length;
  let visitorStopped = false;
  const visitWithStop = function* (value: Value, yielded?: Value[]): Gen<unknown> {
    const outcome = yield* visit(value, yielded);
    if (outcome === STOP) visitorStopped = true;
    return outcome;
  };
  try {
    const result = yield* iterateYielded(
      data.source,
      function* (yielded) {
        const value = yielded.length === 0 ? NIL : yielded.length === 1 ? yielded[0] : arr(yielded);
        const args = yielded.length === 0 && data.steps.length > 0 ? [NIL] : yielded;
        return yield* streamLazyStep(data.steps, states, 0, value, visitWithStop, args);
      },
      args
    );
    if (!visitorStopped)
      for (const [position, step] of data.steps.entries()) {
        const buffer = states[position].buffer;
        if (step.kind === 'each_slice' && buffer && buffer.length > 0) {
          states[position].buffer = [];
          const outcome = yield* streamLazyStep(data.steps, states, position + 1, arr(buffer), visitWithStop);
          if (outcome === STOP) break;
        }
      }
    return data.steps.length === 0 ? result : NIL;
  } finally {
    for (const state of states) for (const iterator of state.iterators ?? []) iterator?.return();
    rt().held.length = held;
    arrays.length = arrayMark;
  }
}

interface LazyState {
  seen: number;
  dropping: boolean;
  index: bigint;
  keys?: RHash;
  iterators?: (Generator<unknown, void, unknown> | undefined)[];
  buffer?: Value[];
}

function* streamLazyStep(
  steps: LazyStep[],
  states: LazyState[],
  position: number,
  item: Value,
  visit: (value: Value, yielded?: Value[]) => Gen<unknown>,
  yielded: Value[] = [item]
): Gen<unknown> {
  const held = rt().held;
  const rootIndex = held.push(item) - 1;
  try {
    const step = steps[position];
    if (!step) return yield* visit(item, yielded);
    const state = states[position];
    const next = (value: Value, args: Value[] = [value]): Gen<unknown> =>
      streamLazyStep(steps, states, position + 1, value, visit, args);
    switch (step.kind) {
      case 'map': {
        return yield* next(yield* callProc(step.block, yielded));
      }
      case 'select':
      case 'reject': {
        return truthy(yield* callProc(step.block, yielded)) === (step.kind === 'select')
          ? yield* next(item, yielded)
          : undefined;
      }
      case 'filter_map': {
        const mapped = yield* callProc(step.block, yielded);
        return truthy(mapped) ? yield* next(mapped) : undefined;
      }
      case 'flat_map': {
        return yield* streamFlattened(yield* callProc(step.block, yielded), next);
      }
      case 'take_while': {
        return truthy(yield* callProc(step.block, yielded)) ? yield* next(item, yielded) : STOP;
      }
      case 'drop_while': {
        if (state.dropping && truthy(yield* callProc(step.block, yielded))) return undefined;
        state.dropping = false;
        return yield* next(item, yielded);
      }
      case 'take': {
        if (state.seen >= step.count) return STOP;
        state.seen++;
        const result = yield* next(item, yielded);
        return result === STOP || state.seen >= step.count ? STOP : undefined;
      }
      case 'drop': {
        return state.seen++ >= step.count ? yield* next(item, yielded) : undefined;
      }
      case 'compact': {
        return item === NIL ? undefined : yield* next(item, yielded);
      }
      case 'with_index': {
        const index = state.index++;
        if (step.block) yield* callProc(step.block, [item, index]);
        return step.block ? yield* next(item) : yield* next(arr([item, index]), [item, index]);
      }
      case 'grep':
      case 'grep_v': {
        if (truthy(yield* caseEquals(step.pattern, item)) !== (step.kind === 'grep')) return;
        return step.block ? yield* next(yield* callProc(step.block, [item])) : yield* next(item, yielded);
      }
      case 'uniq': {
        const key = step.block ? yield* callProc(step.block, [item]) : item;
        if (!state.keys) {
          state.keys = newHash();
          rt().held.push(state.keys);
        }
        if (yield* hashGet(state.keys, key)) return;
        yield* hashSet(state.keys, key, true);
        return yield* next(item, yielded);
      }
      case 'zip': {
        state.iterators ??= step.others.map((other) =>
          other instanceof RArray
            ? undefined
            : flattenGenerator(
                (function* (): Gen<void> {
                  yield* iterate(other, function* (value) {
                    yield value;
                  });
                })()
              )
        );
        const tuple: Value[] = [item];
        const index = state.seen++;
        for (const [position, other] of step.others.entries()) {
          const result = state.iterators[position]?.next();
          tuple.push(
            other instanceof RArray ? (other.items[index] ?? NIL) : result?.done ? NIL : (result?.value as Value)
          );
        }
        const arrays = rt().heldArrays;
        arrays.push(tuple);
        try {
          return yield* next(arr(tuple));
        } finally {
          arrays.pop();
        }
      }
      case 'each_slice':
      case 'each_cons': {
        if (!state.buffer) {
          state.buffer = [];
          rt().heldArrays.push(state.buffer);
        }
        state.buffer.push(item);
        if (state.buffer.length < step.count) return;
        const values = arr([...state.buffer]);
        if (step.kind === 'each_slice') state.buffer.length = 0;
        else state.buffer.shift();
        return yield* next(values);
      }
      case 'each_entry': {
        return yield* next(item);
      }
      case 'each_with_object': {
        return yield* next(arr([item, step.memo]), [item, step.memo]);
      }
    }
  } finally {
    held.splice(rootIndex, 1);
  }
}

function* streamFlattened(mapped: Value, next: (value: Value) => Gen<unknown>): Gen<unknown> {
  const held = rt().held;
  const rootIndex = held.push(mapped) - 1;
  try {
    if (mapped instanceof RArray) {
      for (const item of mapped.items) if ((yield* next(item)) === STOP) return STOP;
      return;
    }
    if (mapped instanceof RObject && respondsTo(mapped, 'force') && respondsTo(mapped, 'each')) {
      let stopped = false;
      yield* iterate(mapped, function* (item) {
        if ((yield* next(item)) === STOP) {
          stopped = true;
          return STOP;
        }
      });
      return stopped ? STOP : undefined;
    }
    const array = yield* tryImplicitConversion(mapped, 'to_ary');
    if (array !== undefined) {
      if (array instanceof RArray) return yield* streamFlattened(array, next);
      if (array !== NIL)
        throw typeError(
          `can't convert ${realClassOf(mapped).name} to Array (${realClassOf(mapped).name}#to_ary gives ${realClassOf(array).name})`
        );
    }
    return yield* next(mapped);
  } finally {
    held.splice(rootIndex, 1);
  }
}

def('Enumerator::Lazy', 'each', [0, -1], function* (self: RObject, args, block) {
  if (!block) {
    if (args.length === 0) return self;
    const data = self.data as LazyData;
    return makeLazy(makeEnumerator(data.source, 'each', args), data.steps);
  }
  return yield* runLazy(self, (value, yielded) => callProc(block, yielded ?? [value], { used: false }), args);
});
def('Enumerator::Lazy', ['force', 'to_a'], [0, -1], function* (self: RObject, args) {
  const items: Value[] = [];
  rt().heldArrays.push(items);
  try {
    yield* runLazy(
      self,
      function* (value) {
        items.push(value);
        yield* [];
      },
      args
    );
    return arr(items);
  } finally {
    rt().heldArrays.pop();
  }
});
def('Enumerator::Lazy', 'first', [0, 1], function* (self: RObject, args) {
  const items: Value[] = [];
  const count = args.length > 0 ? Number(yield* toInt(args[0])) : 1;
  if (count < 0) throw argumentError('attempt to take negative size');
  rt().heldArrays.push(items);
  try {
    if (count > 0) {
      yield* runLazy(self, function* (value) {
        items.push(value);
        yield* [];
        return items.length >= count ? STOP : undefined;
      });
    }
    if (args.length === 0) return items[0] ?? NIL;
    return arr(items);
  } finally {
    rt().heldArrays.pop();
  }
});
def('Enumerator::Lazy', 'eager', 0, function* (self: RObject) {
  return makeEnumerator(self, 'each', []);
});
def('Enumerator::Lazy', ['inspect', 'to_s'], 0, function* (self: RObject) {
  const data = self.data as LazyData;
  let text = `#<Enumerator::Lazy: ${yield* inspect(data.source)}>`;
  for (const step of data.steps) {
    const argumentsText: string[] = [];
    for (const argument of step.args ?? []) argumentsText.push(yield* inspect(argument));
    const suffix = argumentsText.length > 0 ? `(${argumentsText.join(', ')})` : '';
    text = `#<Enumerator::Lazy: ${text}:${step.label ?? step.kind}${suffix}>`;
  }
  return str(text);
});
