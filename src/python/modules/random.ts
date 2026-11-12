import { createHash, randomBytes } from 'node:crypto';

import { setAttribute } from '../attributes';
import { pyStr } from '../conversions';
import { method, pythonMethod } from '../define';
import { defineUnsupportedAttributes } from '../descriptors';
import { pyHash } from '../hashing';
import { libraryReceiver, unsupportedReceiver } from '../libraryReceivers';
import { registerModule, registerUnsupportedAttributes } from '../modules';
import { type ArgStyle, argument, bindPythonArgs, pythonSignature } from '../nativeArgs';
import { toIndex } from '../numbers';
import {
  bindValue,
  callValue,
  exactLength,
  getAttribute,
  getItem,
  isTruthy,
  lengthOf,
  setItem,
  toArray,
} from '../objects';
import { binaryOp, lessThan } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { builtinClass, newList, newTuple, None, pyError, typeError, typeName, valueError } from '../types';
import { type Kwargs, PyDict, PyOpaque, PySet, PyTuple, type PyValue } from '../values';
import { realArgument } from './math';
import {
  betavariate,
  binomialvariate,
  expovariate,
  gammavariate,
  LOG4,
  lognormvariate,
  normalvariate,
  NV_MAGICCONST,
  paretovariate,
  SG_MAGICCONST,
  triangular,
  TWOPI,
  vonmisesvariate,
  weibullvariate,
} from './randomDistributions';

const N = 624;
const M = 397;

/** The Mersenne Twister of CPython's `_random` module, seeded as `random.seed` seeds it. */
class MersenneTwister {
  private readonly state32 = new Uint32Array(N);
  private index = N + 1;
  gaussNext: number | undefined;

  private initGenrand(seed: number): void {
    const mt = this.state32;
    mt[0] = seed >>> 0;
    for (let index = 1; index < N; index++) {
      const previous = mt[index - 1] ^ (mt[index - 1] >>> 30);
      mt[index] = (Math.imul(1_812_433_253, previous) + index) >>> 0;
    }
    this.index = N;
  }

  initByArray(key: number[]): void {
    const mt = this.state32;
    this.initGenrand(19_650_218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const previous = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(previous, 1_664_525)) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const previous = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(previous, 1_566_083_941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
    }
    mt[0] = 0x80_00_00_00;
    this.gaussNext = undefined;
  }

  nextUint32(): number {
    const mt = this.state32;
    if (this.index >= N) {
      for (let k = 0; k < N; k++) {
        const y = (mt[k] & 0x80_00_00_00) | (mt[(k + 1) % N] & 0x7f_ff_ff_ff);
        mt[k] = (mt[(k + M) % N] ^ (y >>> 1) ^ (y & 1 ? 0x99_08_b0_df : 0)) >>> 0;
      }
      this.index = 0;
    }
    let y = mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d_2c_56_80;
    y ^= (y << 15) & 0xef_c6_00_00;
    y ^= y >>> 18;
    return y >>> 0;
  }

  random(): number {
    const a = this.nextUint32() >>> 5;
    const b = this.nextUint32() >>> 6;
    return (a * 67_108_864 + b) * (1 / 9_007_199_254_740_992);
  }

  /** The 624 words and the position, which `getstate()` gives. */
  state(): { words: number[]; index: number } {
    return { words: [...this.state32], index: Math.min(this.index, N) };
  }

  restore(words: number[], index: number): void {
    this.state32.set(words);
    this.index = index;
  }

  getrandbits(bits: number): bigint {
    if (bits === 0) return 0n;
    if (bits <= 32) return BigInt(this.nextUint32() >>> (32 - bits));
    currentRuntime().chargeBits(BigInt(bits));
    // The words come least significant first; one hexadecimal literal builds the int in linear time.
    const words: string[] = [];
    for (let remaining = bits; remaining > 0; remaining -= 32) {
      let r = this.nextUint32();
      if (remaining < 32) r >>>= 32 - remaining;
      words.push(r.toString(16).padStart(8, '0'));
    }
    return BigInt(`0x${words.toReversed().join('')}`);
  }

  randbelow(n: bigint): bigint {
    if (n <= 0n) return 0n;
    const bits = n.toString(2).length;
    let r = this.getrandbits(bits);
    while (r >= n) {
      currentRuntime().spend();
      r = this.getrandbits(bits);
    }
    return r;
  }
}

/** The key a seed initializes the generator with: its 32-bit words, as CPython's random_seed splits it. */
function seedKey(value: PyValue | undefined): number[] {
  if (value === undefined || value === None) return wordsOfHex(randomBytes(32).toString('hex'));
  if (typeof value === 'bigint' || typeof value === 'boolean') return keyOf(BigInt(value));
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    currentRuntime().scan(bytes.length);
    const digest = createHash('sha512').update(bytes).digest();
    return wordsOfHex(Buffer.concat([bytes, digest]).toString('hex'));
  }
  // CPython seeds from a non-int's hash converted to size_t, so a negative hash wraps instead of losing its sign.
  if (typeof value === 'number') return keyOf(BigInt.asUintN(64, pyHash(value)));
  throw typeError('The only supported seed types are:\nNone, int, float, str, bytes, and bytearray.');
}

/** The 32-bit words of an int's absolute value, least significant first. */
function keyOf(seed: bigint): number[] {
  const hex = (seed < 0n ? -seed : seed).toString(16);
  currentRuntime().chargeBits(BigInt(hex.length * 4));
  return wordsOfHex(hex);
}

/** The 32-bit words of a hexadecimal number, least significant first, read in one pass over its digits. */
function wordsOfHex(hex: string): number[] {
  const words: number[] = [];
  for (let end = hex.length; end > 0; end -= 8) words.push(Number.parseInt(hex.slice(Math.max(end - 8, 0), end), 16));
  return words;
}

function randrange(generator: MersenneTwister, args: PyValue[]): bigint {
  const start = toIndex(args[0]);
  if (args[1] === undefined || args[1] === None) {
    // random.py checks `step is not _ONE`, which only the cached int 1 passes.
    if (args[2] !== undefined && args[2] !== 1n) throw typeError('Missing a non-None stop argument');
    if (start > 0n) return generator.randbelow(start);
    throw valueError('empty range for randrange()');
  }
  const stop = toIndex(args[1]);
  const step = args[2] === undefined ? 1n : toIndex(args[2]);
  const width = stop - start;
  if (step === 1n) {
    if (width > 0n) return start + generator.randbelow(width);
    throw valueError(`empty range in randrange(${start}, ${stop})`);
  }
  if (step === 0n) throw valueError('zero step for randrange()');
  const n = step > 0n ? floorDivision(width + step - 1n, step) : floorDivision(width + step + 1n, step);
  if (n <= 0n) throw valueError(`empty range in randrange(${start}, ${stop}, ${step})`);
  return start + step * generator.randbelow(n);
}

function floorDivision(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}

function isSequence(value: PyValue): boolean {
  return !(value instanceof PySet || value instanceof PyDict) && typeof value === 'object';
}

// code-gauge-allow functionNcss 33 -- Follows random.sample with and without counts.
function sample(generator: MersenneTwister, args: PyValue[], kwargs: Kwargs): PyValue {
  const population = argument(args, kwargs, 0, 'population') as PyValue;
  const kValue = argument(args, kwargs, 1, 'k') as PyValue;
  const counts = kwargs?.get('counts') ?? None;
  if (!isSequence(population) && typeof population !== 'string') {
    throw typeError('Population must be a sequence.  For dicts or sets, use sorted(d).');
  }
  const n = exactLength(population);
  if (counts !== None) return sampleWithCounts(generator, population, n, kValue, counts);
  const k = Number(toIndex(kValue));
  if (k < 0 || BigInt(k) > n) throw valueError('Sample larger than population or is negative');
  currentRuntime().ensureRoom(k);
  const result: PyValue[] = [];
  let setSize = 21;
  if (k > 5) setSize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
  if (n <= BigInt(setSize)) {
    const pool = toArray(population);
    const size = Number(n);
    for (let index = 0; index < k; index++) {
      const j = Number(generator.randbelow(BigInt(size - index)));
      result.push(pool[j]);
      pool[j] = pool[size - index - 1];
    }
  } else {
    const selected = new Set<bigint>();
    for (let index = 0; index < k; index++) {
      let j = generator.randbelow(n);
      while (selected.has(j)) j = generator.randbelow(n);
      selected.add(j);
      result.push(getItem(population, j));
    }
  }
  return newList(result);
}

/** `sample(population, k, counts=...)`, which samples positions of the repeated population and maps them back. */
function sampleWithCounts(
  generator: MersenneTwister,
  population: PyValue,
  n: bigint,
  k: PyValue,
  counts: PyValue
): PyValue {
  const cumulative: PyValue[] = [];
  let running: PyValue | undefined;
  for (const count of toArray(counts)) {
    running = running === undefined ? count : binaryOp('+', running, count);
    cumulative.push(running);
  }
  if (BigInt(cumulative.length) !== n) throw valueError('The number of counts does not match the population');
  const total = cumulative.pop() ?? 0n;
  if (typeof total !== 'bigint' && typeof total !== 'boolean') throw typeError('Counts must be integers');
  if (BigInt(total) < 0n) throw valueError('Counts must be non-negative');
  const range = callValue(currentRuntime().builtins.get('range') as PyValue, [total]);
  const selections = toArray(sample(generator, [range, k], undefined));
  return newList(selections.map((selection) => getItem(population, BigInt(bisectRight(cumulative, selection)))));
}

function bisectRight(items: PyValue[], value: PyValue): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (lessThan(value, items[middle])) high = middle;
    else low = middle + 1;
  }
  return low;
}

// code-gauge-allow functionNcss 41 -- Follows random.choices with and without weights.
// code-gauge-allow functionCognitiveComplexity 17 -- Follows random.choices with and without weights.
function choices(generator: MersenneTwister, args: PyValue[], kwargs: Kwargs): PyValue {
  const population = argument(args, kwargs, 0, 'population') as PyValue;
  const weights = argument(args, kwargs, 1, 'weights') ?? None;
  let cumulative = kwargs?.get('cum_weights') ?? None;
  const k = Number(toIndex(kwargs?.get('k') ?? 1n));
  const n = lengthOf(population);
  const result: PyValue[] = [];
  if (cumulative === None) {
    if (weights === None) {
      currentRuntime().ensureRoom(k);
      for (let index = 0; index < k; index++) {
        currentRuntime().spend();
        result.push(getItem(population, BigInt(Math.floor(generator.random() * n))));
      }
      return newList(result);
    }
    let total: PyValue = 0n;
    cumulative = newList(toArray(weights).map((weight) => (total = binaryOp('+', total, weight))));
  } else if (weights !== None) {
    throw typeError('Cannot specify both weights and cumulative weights');
  }
  const cumulativeWeights = toArray(cumulative);
  if (cumulativeWeights.length !== n) throw valueError('The number of weights does not match the population');
  const total = realArgument(cumulativeWeights.at(-1) ?? 0n) + 0;
  if (total <= 0) throw valueError('Total of weights must be greater than zero');
  if (!Number.isFinite(total)) throw valueError('Total of weights must be finite');
  currentRuntime().ensureRoom(k);
  for (let index = 0; index < k; index++) {
    currentRuntime().spend();
    const target = generator.random() * total;
    let low = 0;
    let high = n - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (lessThan(target, cumulativeWeights[middle])) high = middle;
      else low = middle + 1;
    }
    result.push(getItem(population, BigInt(low)));
  }
  return newList(result);
}

function gauss(generator: MersenneTwister, mu: number, sigma: number): number {
  let z = generator.gaussNext;
  generator.gaussNext = undefined;
  if (z === undefined) {
    const angle = generator.random() * 2 * Math.PI;
    const radius = Math.sqrt(-2 * Math.log(1 - generator.random()));
    z = Math.cos(angle) * radius;
    generator.gaussNext = Math.sin(angle) * radius;
  }
  return mu + z * sigma;
}

/** `random.Random`, whose instances each have a generator of their own; the module's functions use a hidden one. */
const randomClass = builtinClass('Random');
randomClass.module = 'random';
randomClass.dict.set('__module__', 'random');
randomClass.dict.set('VERSION', 3n);
const RANDOM_INIT = pythonSignature('Random.__init__', 'self, x=None');
randomClass.construct = (cls, args, kwargs) => {
  const [, seed] = bindPythonArgs(RANDOM_INIT, [cls, ...args], kwargs);
  const generator = new MersenneTwister();
  generator.initByArray(seedKey(seed));
  return new PyOpaque(cls, 'Random', generator);
};

type RandomMethod = (generator: MersenneTwister, args: PyValue[], kwargs: Kwargs) => PyValue;
const generatorOf = (self: PyValue): MersenneTwister => (self as PyOpaque).data as MersenneTwister;
const isRandom = (value: PyValue): value is PyOpaque => value instanceof PyOpaque && value.cls === randomClass;
/** The attribute of `self` that methods random.py writes read before checking their arguments. */
const EAGER_READS: Record<string, string> = {
  choices: 'random',
  shuffle: '_randbelow',
  lognormvariate: 'normalvariate',
  betavariate: 'gammavariate',
  getstate: 'VERSION',
};
/** The attribute of `self` random.py reads where the native body uses each member of the generator. */
const GENERATOR_READS: Record<string, string> = { randbelow: '_randbelow', getrandbits: 'getrandbits' };

/**
 * The generator of the receiver of a method random.py writes. With another receiver, the method fails as its body
 * does: at the first read of an attribute of `self`, which may come after the body has checked its arguments.
 */
function pythonGeneratorOf(self: PyValue, name: string): MersenneTwister {
  if (isRandom(self)) return generatorOf(self);
  if (name === 'seed') {
    throw typeError(
      `super(type, obj): obj (instance of ${typeName(self)}) is not an instance or subtype of type (Random).`
    );
  }
  const method = `Random.${name}`;
  const eager = EAGER_READS[name];
  if (eager !== undefined) libraryReceiver(self, isRandom, eager, method);
  return new Proxy({} as MersenneTwister, {
    get: (_target, member) => {
      getAttribute(self, GENERATOR_READS[String(member)] ?? 'random');
      throw unsupportedReceiver(self, method);
    },
    set: () => {
      setAttribute(self, 'gauss_next', None);
      throw unsupportedReceiver(self, method);
    },
  });
}

/**
 * The methods of Random, which the module's functions also are, bound to the hidden instance. A string gives the
 * parameters of a method that CPython writes in Python; the others are methods of its C base class.
 */
const RANDOM_METHODS: [string, { style: ArgStyle; min: number; max: number } | string, RandomMethod][] = [
  ['seed', 'a=None, version=2', seedMethod],
  ['random', { style: 'none', min: 0, max: 0 }, (generator) => generator.random()],
  ['getrandbits', { style: 'one', min: 1, max: 1 }, (generator, [bits]) => getrandbits(generator, bits)],
  ['randrange', 'start, stop=None, step=1', (generator, args) => randrange(generator, args)],
  ['randint', 'a, b', (generator, [a, b]) => randint(generator, a, b)],
  ['choice', 'seq', (generator, [sequence]) => choice(generator, sequence)],
  [
    'choices',
    'population, weights=None, *, cum_weights=None, k=1',
    (generator, args, kwargs) => choices(generator, args, kwargs),
  ],
  ['shuffle', 'x', (generator, [list]) => shuffle(generator, list)],
  ['sample', 'population, k, *, counts=None', (generator, args, kwargs) => sample(generator, args, kwargs)],
  [
    'uniform',
    'a, b',
    (generator, [a, b]) => {
      const low = realArgument(a);
      return low + (realArgument(b) - low) * generator.random();
    },
  ],
  [
    'triangular',
    'low=0.0, high=1.0, mode=None',
    (generator, args, kwargs) => {
      const mode = argument(args, kwargs, 2, 'mode');
      return triangular(
        generator,
        argument(args, kwargs, 0, 'low') ?? 0,
        argument(args, kwargs, 1, 'high') ?? 1,
        mode === None ? undefined : mode
      );
    },
  ],
  ['gauss', 'mu=0.0, sigma=1.0', (generator, args, kwargs) => gauss(generator, ...muSigma(args, kwargs))],
  [
    'normalvariate',
    'mu=0.0, sigma=1.0',
    (generator, args, kwargs) => normalvariate(generator, ...muSigma(args, kwargs)),
  ],
  ['lognormvariate', 'mu, sigma', (generator, args, kwargs) => lognormvariate(generator, ...muSigma(args, kwargs))],
  [
    'expovariate',
    'lambd=1.0',
    (generator, args, kwargs) => expovariate(generator, realArgument(argument(args, kwargs, 0, 'lambd') ?? 1)),
  ],
  [
    'vonmisesvariate',
    'mu, kappa',
    (generator, args, kwargs) => vonmisesvariate(generator, ...realArguments(args, kwargs, 'mu', 'kappa')),
  ],
  [
    'gammavariate',
    'alpha, beta',
    (generator, args, kwargs) => gammavariate(generator, ...realArguments(args, kwargs, 'alpha', 'beta')),
  ],
  [
    'betavariate',
    'alpha, beta',
    (generator, args, kwargs) => betavariate(generator, ...realArguments(args, kwargs, 'alpha', 'beta')),
  ],
  [
    'paretovariate',
    'alpha',
    (generator, args, kwargs) => paretovariate(generator, realArgument(argument(args, kwargs, 0, 'alpha') as PyValue)),
  ],
  [
    'weibullvariate',
    'alpha, beta',
    (generator, args, kwargs) => weibullvariate(generator, ...realArguments(args, kwargs, 'alpha', 'beta')),
  ],
  [
    'binomialvariate',
    'n=1, p=0.5',
    (generator, args, kwargs) =>
      binomialvariate(generator, argument(args, kwargs, 0, 'n') ?? 1n, argument(args, kwargs, 1, 'p') ?? 0.5),
  ],
  ['getstate', '', (generator) => getstate(generator)],
  ['setstate', 'state', (generator, [state]) => setstate(generator, state)],
];

for (const [name, spec, run] of RANDOM_METHODS) {
  if (typeof spec === 'string') {
    pythonMethod(randomClass, name, spec, (self, args, kwargs) => run(pythonGeneratorOf(self, name), args, kwargs));
  } else {
    const runMethod = (self: PyValue, args: PyValue[], kwargs: Kwargs): PyValue => run(generatorOf(self), args, kwargs);
    method(randomClass, name, spec.style, spec.min, spec.max, runMethod, { ownerName: '_random.Random' });
  }
}
defineUnsupportedAttributes(randomClass, { randbytes: 'random.randbytes()（bytes 型）' });

/** Two required real arguments, each passed by position or by name. */
function realArguments(args: PyValue[], kwargs: Kwargs, first: string, second: string): [number, number] {
  return [
    realArgument(argument(args, kwargs, 0, first) as PyValue),
    realArgument(argument(args, kwargs, 1, second) as PyValue),
  ];
}

function muSigma(args: PyValue[], kwargs: Kwargs): [number, number] {
  return [realArgument(argument(args, kwargs, 0, 'mu') ?? 0), realArgument(argument(args, kwargs, 1, 'sigma') ?? 1)];
}

function seedMethod(generator: MersenneTwister, args: PyValue[], kwargs: Kwargs): PyValue {
  const a = argument(args, kwargs, 0, 'a');
  const version = argument(args, kwargs, 1, 'version') ?? 2n;
  if (version === 1n && typeof a === 'string') {
    generator.initByArray(keyOf(versionOneSeed(a)));
  } else {
    generator.initByArray(seedKey(a));
  }
  generator.gaussNext = undefined;
  return None;
}

/** The seed version 1 of random.seed makes from a string, which hashes it as Python 2 did. */
function versionOneSeed(text: string): bigint {
  currentRuntime().scan(text.length);
  const codes = Array.from(text, (char) => BigInt(char.codePointAt(0) as number));
  let x = codes.length > 0 ? codes[0] << 7n : 0n;
  for (const code of codes) x = ((1_000_003n * x) ^ code) & 0xff_ff_ff_ff_ff_ff_ff_ffn;
  x ^= BigInt(codes.length);
  return x === -1n ? -2n : x;
}

function getrandbits(generator: MersenneTwister, bits: PyValue): bigint {
  const count = Number(toIndex(bits));
  if (count < 0) throw valueError('number of bits must be non-negative');
  return generator.getrandbits(count);
}

function randint(generator: MersenneTwister, a: PyValue, b: PyValue): bigint {
  const low = toIndex(a);
  const high = toIndex(b);
  if (high < low) throw valueError(`empty range in randint(${low}, ${high})`);
  return low + generator.randbelow(high - low + 1n);
}

function choice(generator: MersenneTwister, sequence: PyValue): PyValue {
  const length = exactLength(sequence);
  if (length === 0n) throw pyError('IndexError', 'Cannot choose from an empty sequence');
  return getItem(sequence, generator.randbelow(length));
}

function shuffle(generator: MersenneTwister, list: PyValue): PyValue {
  const length = lengthOf(list);
  for (let index = length - 1; index > 0; index--) {
    const j = generator.randbelow(BigInt(index + 1));
    const a = getItem(list, BigInt(index));
    const b = getItem(list, j);
    setItem(list, BigInt(index), b);
    setItem(list, j, a);
  }
  return None;
}

/** `Random.getstate()`: the version, the 624 words of the Mersenne Twister and its position, and the next gauss. */
function getstate(generator: MersenneTwister): PyValue {
  const { words, index } = generator.state();
  return newTuple([3n, newTuple([...words.map(BigInt), BigInt(index)]), generator.gaussNext ?? None]);
}

function setstate(generator: MersenneTwister, state: PyValue): PyValue {
  const items = toArray(state);
  const version = items[0];
  if (version !== 3n && version !== 2n) {
    throw valueError(`state with version ${pyStr(version)} passed to Random.setstate() of version 3`);
  }
  if (items.length !== 3) throw valueError(`too many values to unpack (expected 3, got ${items.length})`);
  const [, internal, gaussNext] = items;
  generator.gaussNext = gaussNext === None ? undefined : realArgument(gaussNext);
  if (!(internal instanceof PyTuple)) throw typeError('state vector must be a tuple');
  if (internal.items.length !== 625) throw valueError('state vector is the wrong size');
  const words = internal.items.slice(0, 624).map((word) => {
    const value = toIndex(word);
    if (value < 0n || value > 0xff_ff_ff_ffn)
      throw pyError('OverflowError', 'Python int too large to convert to C unsigned long');
    return Number(value);
  });
  const index = Number(toIndex(internal.items[624]));
  if (index < 0 || index > 624) throw valueError('invalid state');
  generator.restore(words, index);
  return None;
}

registerUnsupportedAttributes('random', {
  SystemRandom: 'random.SystemRandom（OS の乱数）',
  randbytes: 'random.randbytes()（bytes 型）',
  main: 'random.main()（コマンドライン）',
});

registerModule('random', () => {
  const instance = callValue(randomClass, []) as PyOpaque;
  const namespace = new Map<string, PyValue>([
    ['Random', randomClass],
    ['BPF', 53n],
    ['RECIP_BPF', 2 ** -53],
    ['NV_MAGICCONST', NV_MAGICCONST],
    ['LOG4', LOG4],
    ['SG_MAGICCONST', SG_MAGICCONST],
    ['TWOPI', TWOPI],
  ]);
  for (const [name] of RANDOM_METHODS) namespace.set(name, bindValue(randomClass.dict.get(name) as PyValue, instance));
  return namespace;
});

export { isTruthy, typeName };
