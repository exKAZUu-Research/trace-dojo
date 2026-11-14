import { inspect, inspectRange, toFloat, toInt, toStepFloat } from './conversions';
import { def, sdef } from './define';
import { argumentError, frozenError, rangeError, rubyError } from './errors';
import { callMethod, type Gen, invoke, respondsTo } from './interp';
import { isRubyFloat, isRubyNumber, NIL, RFloat, RObject, RRange, type Value } from './objects';
import { rt, UnsupportedFeatureError } from './runtime';
import { classOf } from './values';

/** Ruby's Mersenne Twister (MT19937), seeded and drawn from as `random.c` does. */
export class MersenneTwister {
  private readonly state = new Uint32Array(624);
  private index = 625;
  seed: bigint;

  constructor(seed: bigint) {
    this.seed = seed;
    const magnitude = seed < 0n ? -seed : seed;
    const words: number[] = [];
    const digits = magnitude.toString(16);
    for (let end = digits.length; end > 0; end -= 8) {
      words.push(Number.parseInt(digits.slice(Math.max(0, end - 8), end), 16));
      if (words.length % 256 === 0) rt().spend(256);
    }
    if (words.length <= 1) this.initGenrand(words[0] ?? 0);
    else {
      if (words.at(-1) === 1) words.pop();
      this.initByArray(words);
    }
  }

  copy(): MersenneTwister {
    const copied = new MersenneTwister(this.seed);
    copied.state.set(this.state);
    copied.index = this.index;
    return copied;
  }

  private initGenrand(seed: number): void {
    const mt = this.state;
    mt[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) {
      const previous = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1_812_433_253, previous) + i) >>> 0;
    }
    this.index = 624;
  }

  private initByArray(key: number[]): void {
    this.initGenrand(19_650_218);
    const mt = this.state;
    let i = 1;
    let j = 0;
    for (let k = Math.max(624, key.length); k > 0; k--) {
      if (k % 256 === 0) rt().spend(256);
      const previous = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(previous, 1_664_525)) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= 624) {
        mt[0] = mt[623];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k > 0; k--) {
      const previous = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(previous, 1_566_083_941)) - i) >>> 0;
      i++;
      if (i >= 624) {
        mt[0] = mt[623];
        i = 1;
      }
    }
    mt[0] = 0x80_00_00_00;
  }

  private twist(): void {
    const mt = this.state;
    for (let k = 0; k < 624; k++) {
      const y = (mt[k] & 0x80_00_00_00) | (mt[(k + 1) % 624] & 0x7f_ff_ff_ff);
      mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x99_08_b0_df : 0);
    }
    this.index = 0;
  }

  int32(): number {
    if (this.index >= 624) this.twist();
    let y = this.state[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d_2c_56_80;
    y ^= (y << 15) & 0xef_c6_00_00;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** A Float in [0, 1) from two draws (53 bits), or [0, 1] when not `exclusive`. */
  real(exclusive = true): number {
    const a = this.int32();
    const b = this.int32();
    if (exclusive) return ((a >>> 5) * 67_108_864 + (b >>> 6)) / 9_007_199_254_740_992;
    const x = (BigInt(a) << 32n) | BigInt(b);
    return Number((x * ((1n << 53n) | 1n)) >> 64n) / 9_007_199_254_740_992;
  }

  /** A uniform integer in [0, limit], drawing 32 bits at a time and retrying above the limit. */
  // code-gauge-allow functionCognitiveComplexity 22 -- Transcribed from Ruby's random.c, whose draws decide the numbers.
  limited(limit: bigint): bigint {
    if (limit === 0n) return 0n;
    if (limit > 0xff_ff_ff_ffn) return this.limitedLarge(limit);
    const mask = maskOf(limit);
    for (;;) {
      const value = BigInt(this.int32()) & mask;
      if (value <= limit) return value;
    }
  }

  private limitedLarge(limit: bigint): bigint {
    const hex = limit.toString(16);
    const firstWidth = hex.length % 8 || 8;
    const bounds: number[] = [Number.parseInt(hex.slice(0, firstWidth), 16)];
    for (let index = firstWidth; index < hex.length; index += 8)
      bounds.push(Number.parseInt(hex.slice(index, index + 8), 16));
    const mask = 2 ** (32 - Math.clz32(bounds[0])) - 1;
    for (;;) {
      rt().spend();
      const drawn: number[] = [];
      let equal = true;
      let rejected = false;
      for (const [index, bound] of bounds.entries()) {
        rt().spend();
        const word = index === 0 ? (this.int32() & mask) >>> 0 : this.int32();
        if (equal && word > bound) {
          rejected = true;
          break;
        }
        if (word < bound) equal = false;
        drawn.push(word);
      }
      if (!rejected) return BigInt(`0x${drawn.map((word) => word.toString(16).padStart(8, '0')).join('')}`);
    }
  }
}

function maskOf(limit: bigint): bigint {
  return (1n << BigInt(limit.toString(2).length)) - 1n;
}

/** The generator Kernel#rand uses, seeded from the clock until `srand` seeds it. */
export function defaultGenerator(): MersenneTwister {
  const runtime = rt();
  if (!(runtime.random instanceof MersenneTwister)) {
    runtime.random = new MersenneTwister(BigInt(Math.floor(Math.random() * 2 ** 52)));
  }
  return runtime.random as MersenneTwister;
}

function generatorOf(value: Value): MersenneTwister | undefined {
  if (value instanceof RObject && value.data instanceof MersenneTwister) return value.data;
  if (value === rt().c.Random) return defaultGenerator();
  return undefined;
}

/** A random index below `count`, from a generator or an object with `rand`, as Array#shuffle and #sample draw. */
export function* randomIndex(randomizer: Value | undefined, count: number): Gen<number> {
  const generator = randomizer === undefined ? defaultGenerator() : generatorOf(randomizer);
  if (generator) return Number(generator.limited(BigInt(count - 1)));
  const value = yield* toInt(yield* callMethod(randomizer as Value, 'rand', [BigInt(count)]));
  if (value < 0n) throw rangeError(`random number too small ${value}`);
  if (value >= BigInt(count)) throw rangeError(`random number too big ${value}`);
  return Number(value);
}

function domainError(): never {
  throw rubyError(rt().c['Errno::EDOM'], 'Numerical argument out of domain');
}

// code-gauge-allow functionNcss 34 -- Transcribed from Ruby's random.c, whose draws decide the numbers.
// code-gauge-allow functionCognitiveComplexity 27 -- Transcribed from Ruby's random.c, whose draws decide the numbers.
function* randomRange(generator: MersenneTwister, range: RRange): Gen<Value | undefined> {
  const { begin, end, exclusive } = range;
  if (begin === NIL || end === NIL) domainError();
  if (typeof begin === 'bigint' && typeof end === 'bigint') {
    const max = end - begin - (exclusive ? 1n : 0n);
    if (max < 0n) return NIL;
    return begin + generator.limited(max);
  }
  if (isRubyNumber(begin) && isRubyNumber(end)) {
    const low = Number(begin);
    let max = Number(end) - low;
    let scale = 1;
    let mid = 0.5;
    if (!Number.isFinite(max)) {
      if (!Number.isFinite(low) || !Number.isFinite(Number(end))) domainError();
      const min = low / 2;
      max = Number(end) / 2;
      scale = 2;
      mid = max + min;
      max -= min;
    } else if (Number.isNaN(max)) {
      domainError();
    }
    if (max > 0) {
      const r = generator.real(exclusive);
      if (scale > 1) return (r - 0.5) * max * scale + mid;
      return r * max + low;
    }
    if (max === 0 && !exclusive) return 0 + low;
    return NIL;
  }
  return yield* randomArithmeticRange(generator, begin, end, exclusive);
}

function* randomArithmeticRange(generator: MersenneTwister, begin: Value, end: Value, exclusive: boolean): Gen<Value> {
  let distance = yield* callMethod(end, '-', [begin]);
  if (typeof distance !== 'bigint' && !isRubyFloat(distance)) {
    if (respondsTo(distance, 'to_int', true)) distance = yield* toInt(distance);
    else if (respondsTo(distance, 'to_f', true)) distance = yield* toStepFloat(distance);
    else return NIL;
  }
  if (typeof distance === 'bigint') {
    const max = distance - (exclusive ? 1n : 0n);
    return max < 0n ? NIL : yield* callMethod(begin, '+', [generator.limited(max)]);
  }
  return yield* randomFloatArithmeticRange(generator, begin, end, Number(distance), exclusive);
}

function* randomFloatArithmeticRange(
  generator: MersenneTwister,
  begin: Value,
  end: Value,
  distance: number,
  exclusive: boolean
): Gen<Value> {
  if (Number.isNaN(distance)) domainError();
  if (!Number.isFinite(distance)) {
    const low = yield* randomEndpointFloat(begin);
    const high = yield* randomEndpointFloat(end);
    if (!Number.isFinite(low) || !Number.isFinite(high)) domainError();
    const halfLow = low / 2;
    const halfHigh = high / 2;
    const span = halfHigh - halfLow;
    if (span > 0) return (generator.real(exclusive) - 0.5) * span * 2 + (halfHigh + halfLow);
    return span === 0 && !exclusive ? low : NIL;
  }
  if (distance < 0 || (distance === 0 && exclusive)) return NIL;
  const offset = distance === 0 ? 0 : generator.real(exclusive) * distance;
  return yield* addRandomFloatOffset(begin, offset);
}

function* addRandomFloatOffset(begin: Value, offset: number): Gen<Value> {
  if (isRubyNumber(begin) || respondsTo(begin, 'to_f', true)) return (yield* randomEndpointFloat(begin)) + offset;
  return yield* callMethod(begin, '+', [offset]);
}

function* randomEndpointFloat(value: Value): Gen<number> {
  return isRubyNumber(value) ? Number(value) : yield* toStepFloat(value);
}

/** `Random#rand` and `Random.rand`: a Float below 1 or below a Float, an Integer below an Integer, or one in a range. */
function* randomValue(generator: MersenneTwister, args: Value[]): Gen {
  if (args.length === 0) return generator.real();
  const [max] = args;
  if (max === NIL) throw argumentError('invalid argument - nil');
  if (max instanceof RRange) {
    const value = yield* randomRange(generator, max);
    if (value === NIL) throw argumentError(`invalid argument - ${yield* inspectRange(max)}`);
    return value as Value;
  }
  if (typeof max === 'number' || max instanceof RFloat) {
    const limit = Number(max);
    if (!Number.isFinite(limit)) domainError();
    if (limit === 0) return generator.real();
    if (limit < 0) throw argumentError(`invalid argument - ${limit}`);
    return generator.real() * limit;
  }
  const limit = yield* toInt(max);
  if (limit <= 0n) throw argumentError(`invalid argument - ${limit}`);
  return generator.limited(limit - 1n);
}

def(
  'Kernel',
  'rand',
  [0, 1],
  function* (_self, args) {
    const generator = defaultGenerator();
    const [max] = args;
    if (max === undefined || max === NIL) return generator.real();
    if (max instanceof RRange) {
      const value = yield* randomRange(generator, max);
      return value === NIL ? NIL : (value as Value);
    }
    let limit = yield* toInt(max);
    if (limit === 0n) return generator.real();
    if (limit < 0n) limit = -limit;
    return generator.limited(limit - 1n);
  },
  { visibility: 'private' }
);
def(
  'Kernel',
  'srand',
  [0, 1],
  function* (_self, args) {
    const runtime = rt();
    const previous = defaultGenerator().seed;
    const seed = args.length > 0 ? yield* toInt(args[0]) : BigInt(Math.floor(Math.random() * 2 ** 52));
    runtime.random = new MersenneTwister(seed);
    return previous;
  },
  { visibility: 'private' }
);
def(
  'Random',
  'initialize',
  [0, 1],
  function* (self: RObject, args) {
    if (self.frozen) throw frozenError(self, yield* inspect(self));
    self.data = new MersenneTwister(
      args.length > 0 ? yield* toInt(args[0]) : BigInt(Math.floor(Math.random() * 2 ** 52))
    );
    return NIL;
  },
  { visibility: 'private' }
);
sdef('Random', 'new', [0, -1], function* (self, args, block) {
  const random = new RObject(self);
  random.data = new MersenneTwister(BigInt(Math.floor(Math.random() * 2 ** 52)));
  const initialize = classOf(random).findMethod('initialize');
  if (initialize) yield* invoke(initialize, random, args, undefined, block, false);
  return random;
});
sdef('Random', 'rand', [0, 1], (_self, args) => randomValue(defaultGenerator(), args));
sdef('Random', 'new_seed', 0, () => BigInt(Math.floor(Math.random() * 2 ** 52)));
sdef('Random', 'srand', [0, 1], function* (self, args) {
  return yield* callMethod(rt().mainObject, 'srand', args, undefined, undefined, { fcall: true });
});
def('Random', ['rand', 'random_number'], [0, 1], (self: RObject, args) =>
  randomValue(self.data as MersenneTwister, args)
);
def('Random', 'seed', 0, (self: RObject) => (self.data as MersenneTwister).seed);
def('Random', 'bytes', 1, () => {
  throw new UnsupportedFeatureError('Random#bytes');
});

export { toFloat };
