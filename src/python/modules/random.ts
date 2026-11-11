import { newBytes } from '../bytesValues';
import { pyStr } from '../conversions';
import { builtin, method } from '../define';
import { sha512 } from '../hashAlgorithms';
import { pyHash } from '../hashing';
import { defineNew } from '../instances';
import { registerModule, registerUnsupportedAttributes } from '../modules';
import { type ArgStyle, argument, checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import { bindValue, callValue, getItem, isTruthy, lengthOf, setItem, toArray } from '../objects';
import { binaryOp, lessThan } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { registerSourceModule } from '../sourceModules';
import {
  builtinClass,
  classOf,
  methodClass,
  nativeFunction,
  newList,
  newTuple,
  None,
  objectClass,
  pyError,
  typeError,
  typeName,
  valueError,
} from '../types';
import {
  type Kwargs,
  PyBoundMethod,
  PyDict,
  PyFunction,
  PyInstance,
  type PyObject,
  PyOpaque,
  PySet,
  PyTuple,
  type PyValue,
} from '../values';
import { realArgument } from './math';
import {
  betavariate,
  binomialvariate,
  expovariate,
  gammavariate,
  lognormvariate,
  normalvariate,
  paretovariate,
  triangular,
  vonmisesvariate,
  weibullvariate,
} from './randomDistributions';
import { RANDOM_SOURCE } from './randomSource';

const N = 624;
const M = 397;

/** The Mersenne Twister of CPython's `_random` module, seeded as `random.seed` seeds it. */
export class MersenneTwister {
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
    if (bits <= 32) return BigInt(this.nextUint32() >>> (32 - bits));
    let result = 0n;
    let remaining = bits;
    for (let word = 0; remaining > 0; word++, remaining -= 32) {
      let r = this.nextUint32();
      if (remaining < 32) r >>>= 32 - remaining;
      result |= BigInt(r) << BigInt(word * 32);
    }
    return result;
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

/** The 32-bit words of a seed's absolute value, least significant first, as CPython's random_seed splits it. */
export function keyOf(seed: bigint): number[] {
  let value = seed < 0n ? -seed : seed;
  if (value === 0n) return [0];
  const key: number[] = [];
  while (value > 0n) {
    key.push(Number(value & 0xff_ff_ff_ffn));
    value >>= 32n;
  }
  return key;
}

export function seedOf(value: PyValue | undefined): bigint {
  if (value === undefined || value === None) return bigintOfBytes(crypto.getRandomValues(new Uint8Array(32)));
  if (typeof value === 'bigint' || typeof value === 'boolean') return BigInt(value);
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return bigintOfBytes(new Uint8Array([...bytes, ...sha512(bytes)]));
  }
  if (typeof value === 'number') return pyHash(value);
  throw typeError('The only supported seed types are:\nNone, int, float, str, bytes, and bytearray.');
}

/** The big-endian unsigned integer that bytes encode. */
function bigintOfBytes(bytes: Uint8Array): bigint {
  return BigInt(`0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`);
}

function randrange(generator: MersenneTwister, args: PyValue[]): bigint {
  const start = toIndex(args[0]);
  if (args.length === 1 || args[1] === None) {
    if (start > 0n) return generator.randbelow(start);
    throw valueError('empty range for randrange()');
  }
  const stop = toIndex(args[1]);
  const step = args.length > 2 ? toIndex(args[2]) : 1n;
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
// code-gauge-allow functionCognitiveComplexity 16 -- Follows random.sample with and without counts.
function sample(generator: MersenneTwister, args: PyValue[], kwargs: Kwargs): PyValue {
  const population = argument(args, kwargs, 0, 'population') as PyValue;
  const kValue = argument(args, kwargs, 1, 'k');
  if (kValue === undefined) throw typeError("Random.sample() missing 1 required positional argument: 'k'");
  const counts = kwargs?.get('counts') ?? None;
  if (!isSequence(population) && typeof population !== 'string') {
    throw typeError('Population must be a sequence.  For dicts or sets, use sorted(d).');
  }
  const n = lengthOf(population);
  if (counts !== None) return sampleWithCounts(generator, population, n, kValue, counts);
  const k = Number(toIndex(kValue));
  if (k < 0 || k > n) throw valueError('Sample larger than population or is negative');
  const result: PyValue[] = [];
  let setSize = 21;
  if (k > 5) setSize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
  if (n <= setSize) {
    const pool = toArray(population);
    for (let index = 0; index < k; index++) {
      const j = Number(generator.randbelow(BigInt(n - index)));
      result.push(pool[j]);
      pool[j] = pool[n - index - 1];
    }
  } else {
    const selected = new Set<number>();
    for (let index = 0; index < k; index++) {
      let j = Number(generator.randbelow(BigInt(n)));
      while (selected.has(j)) j = Number(generator.randbelow(BigInt(n)));
      selected.add(j);
      result.push(getItem(population, BigInt(j)));
    }
  }
  return newList(result);
}

/** `sample(population, k, counts=...)`, which samples positions of the repeated population and maps them back. */
function sampleWithCounts(
  generator: MersenneTwister,
  population: PyValue,
  n: number,
  k: PyValue,
  counts: PyValue
): PyValue {
  const cumulative: PyValue[] = [];
  let running: PyValue | undefined;
  for (const count of toArray(counts)) {
    running = running === undefined ? count : binaryOp('+', running, count);
    cumulative.push(running);
  }
  if (cumulative.length !== n) throw valueError('The number of counts does not match the population');
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

// code-gauge-allow functionNcss 38 -- Follows random.choices with and without weights.
// code-gauge-allow functionCognitiveComplexity 17 -- Follows random.choices with and without weights.
function choices(generator: MersenneTwister, args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs(
    { qualified: 'choices', min: 1, max: 2, style: 'takes', keywords: ['population', 'weights', 'cum_weights', 'k'] },
    args,
    kwargs
  );
  const population = argument(args, kwargs, 0, 'population') as PyValue;
  const weights = argument(args, kwargs, 1, 'weights') ?? None;
  let cumulative = kwargs?.get('cum_weights') ?? None;
  const k = Number(toIndex(kwargs?.get('k') ?? 1n));
  const n = lengthOf(population);
  const result: PyValue[] = [];
  if (cumulative === None) {
    if (weights === None) {
      for (let index = 0; index < k; index++)
        result.push(getItem(population, BigInt(Math.floor(generator.random() * n))));
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
  for (let index = 0; index < k; index++) {
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
randomClass.construct = (cls, args, kwargs) => {
  if (args.length > 1) {
    throw typeError(`Random.__init__() takes from 1 to 2 positional arguments but ${args.length + 1} were given`);
  }
  const generator = new MersenneTwister();
  generator.initByArray(keyOf(seedOf(argument(args, kwargs, 0, 'x'))));
  return new PyOpaque(cls, 'Random', generator);
};

type RandomMethod = (generator: MersenneTwister, args: PyValue[], kwargs: Kwargs) => PyValue;
const generatorOf = (self: PyValue): MersenneTwister => (self as PyOpaque).data as MersenneTwister;

/** The methods of Random, which the module's functions also are, bound to the hidden instance. */
const RANDOM_METHODS: [string, { style: ArgStyle; min: number; max: number; keywords?: string[] }, RandomMethod][] = [
  ['seed', { style: 'takes', min: 0, max: 2, keywords: ['a', 'version'] }, seedMethod],
  ['random', { style: 'none', min: 0, max: 0 }, (generator) => generator.random()],
  ['getrandbits', { style: 'one', min: 1, max: 1 }, (generator, [bits]) => getrandbits(generator, bits)],
  ['randbytes', { style: 'one', min: 1, max: 1 }, (generator, [n]) => randbytes(generator, n)],
  ['randrange', { style: 'expected', min: 1, max: 3 }, (generator, args) => randrange(generator, args)],
  ['randint', { style: 'expected', min: 2, max: 2 }, (generator, [a, b]) => randint(generator, a, b)],
  ['choice', { style: 'one', min: 1, max: 1 }, (generator, [sequence]) => choice(generator, sequence)],
  [
    'choices',
    { style: 'takes', min: 1, max: 2, keywords: ['population', 'weights', 'cum_weights', 'k'] },
    (generator, args, kwargs) => choices(generator, args, kwargs),
  ],
  ['shuffle', { style: 'one', min: 1, max: 1 }, (generator, [list]) => shuffle(generator, list)],
  [
    'sample',
    { style: 'takes', min: 1, max: 2, keywords: ['population', 'k', 'counts'] },
    (generator, args, kwargs) => sample(generator, args, kwargs),
  ],
  [
    'uniform',
    { style: 'expected', min: 2, max: 2 },
    (generator, [a, b]) => {
      const low = realArgument(a);
      return low + (realArgument(b) - low) * generator.random();
    },
  ],
  [
    'triangular',
    { style: 'takes', min: 0, max: 3, keywords: ['low', 'high', 'mode'] },
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
  [
    'gauss',
    { style: 'takes', min: 0, max: 2, keywords: ['mu', 'sigma'] },
    (generator, args, kwargs) => gauss(generator, ...muSigma(args, kwargs)),
  ],
  [
    'normalvariate',
    { style: 'takes', min: 0, max: 2, keywords: ['mu', 'sigma'] },
    (generator, args, kwargs) => normalvariate(generator, ...muSigma(args, kwargs)),
  ],
  [
    'lognormvariate',
    { style: 'takes', min: 2, max: 2, keywords: ['mu', 'sigma'] },
    (generator, args, kwargs) => lognormvariate(generator, ...muSigma(args, kwargs)),
  ],
  [
    'expovariate',
    { style: 'takes', min: 0, max: 1, keywords: ['lambd'] },
    (generator, args, kwargs) => expovariate(generator, realArgument(argument(args, kwargs, 0, 'lambd') ?? 1)),
  ],
  [
    'vonmisesvariate',
    { style: 'takes', min: 2, max: 2, keywords: ['mu', 'kappa'] },
    (generator, [mu, kappa]) => vonmisesvariate(generator, realArgument(mu), realArgument(kappa)),
  ],
  [
    'gammavariate',
    { style: 'takes', min: 2, max: 2, keywords: ['alpha', 'beta'] },
    (generator, [alpha, beta]) => gammavariate(generator, realArgument(alpha), realArgument(beta)),
  ],
  [
    'betavariate',
    { style: 'takes', min: 2, max: 2, keywords: ['alpha', 'beta'] },
    (generator, [alpha, beta]) => betavariate(generator, realArgument(alpha), realArgument(beta)),
  ],
  [
    'paretovariate',
    { style: 'takes', min: 1, max: 1, keywords: ['alpha'] },
    (generator, [alpha]) => paretovariate(generator, realArgument(alpha)),
  ],
  [
    'weibullvariate',
    { style: 'takes', min: 2, max: 2, keywords: ['alpha', 'beta'] },
    (generator, [alpha, beta]) => weibullvariate(generator, realArgument(alpha), realArgument(beta)),
  ],
  [
    'binomialvariate',
    { style: 'takes', min: 0, max: 2, keywords: ['n', 'p'] },
    (generator, args, kwargs) =>
      binomialvariate(generator, argument(args, kwargs, 0, 'n') ?? 1n, argument(args, kwargs, 1, 'p') ?? 0.5),
  ],
  ['getstate', { style: 'none', min: 0, max: 0 }, (generator) => getstate(generator)],
  ['setstate', { style: 'one', min: 1, max: 1 }, (generator, [state]) => setstate(generator, state)],
];

for (const [name, spec, run] of RANDOM_METHODS) {
  method(
    randomClass,
    name,
    spec.style,
    spec.min,
    spec.max,
    (self, args, kwargs) => run(generatorOf(self), args, kwargs),
    {
      keywords: spec.keywords,
    }
  );
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
    generator.initByArray(keyOf(seedOf(a)));
  }
  generator.gaussNext = undefined;
  return None;
}

/** The seed version 1 of random.seed makes from a string, which hashes it as Python 2 did. */
function versionOneSeed(text: string): bigint {
  const codes = Array.from(text, (char) => BigInt(char.codePointAt(0) as number));
  let x = codes.length > 0 ? codes[0] << 7n : 0n;
  for (const code of codes) x = ((1_000_003n * x) ^ code) & 0xff_ff_ff_ff_ff_ff_ff_ffn;
  x ^= BigInt(codes.length);
  return x === -1n ? -2n : x;
}

/** `Random.randbytes(n)`: the bytes of `getrandbits(n * 8)`, least significant first. */
function randbytes(generator: MersenneTwister, n: PyValue): PyValue {
  const count = Number(toIndex(n));
  if (count < 0) throw valueError('Cannot convert negative int');
  let value = generator.getrandbits(count * 8);
  const data = new Uint8Array(count);
  for (let index = 0; index < count; index++) {
    data[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return newBytes(data);
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
  const length = lengthOf(sequence);
  if (length === 0) throw pyError('IndexError', 'Cannot choose from an empty sequence');
  return getItem(sequence, generator.randbelow(BigInt(length)));
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
  restoreState(generator, internal);
  generator.gaussNext = gaussNext === None ? undefined : realArgument(gaussNext);
  return None;
}

/** `_random.Random.setstate(state)`: the 624 words of the Mersenne Twister and its position. */
function restoreState(generator: MersenneTwister, internal: PyValue): void {
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
}

registerUnsupportedAttributes('random', { main: 'random.main()（コマンドライン）' });

// _random ------------------------------------------------------------------------------------------------------------

/**
 * `_random.Random`, the Mersenne Twister under CPython's random.Random, which random.py derives from and programs may
 * derive from in turn.
 */
const coreClass = builtinClass('Random', objectClass, true);
coreClass.module = '_random';
const coreGenerators = new WeakMap<PyObject, MersenneTwister>();

function coreOf(self: PyValue): MersenneTwister {
  let generator = coreGenerators.get(self as PyObject);
  if (!generator) {
    generator = new MersenneTwister();
    generator.initByArray(keyOf(coreSeed(None)));
    coreGenerators.set(self as PyObject, generator);
  }
  return generator;
}

/** The seed `_random.Random.seed(n)` takes: random bytes for None, an int's absolute value, or another value's hash. */
function coreSeed(value: PyValue): bigint {
  if (value === None) return seedOf(undefined);
  if (typeof value === 'bigint' || typeof value === 'boolean') return BigInt(value);
  return BigInt.asUintN(64, pyHash(value));
}

defineNew(coreClass, (cls, _args, kwargs) => {
  if (cls === coreClass && kwargs !== undefined && kwargs.size > 0) {
    throw typeError('Random() takes no keyword arguments');
  }
  currentRuntime().allocate(1);
  const instance = new PyInstance(cls);
  coreOf(instance);
  return instance;
});
method(coreClass, '__init__', 'expected', 0, Number.POSITIVE_INFINITY, (self, args) => {
  if (args.length > 1) throw typeError('Random() requires 0 or 1 argument');
  coreOf(self).initByArray(keyOf(coreSeed(args[0] ?? None)));
  return None;
});
method(coreClass, 'random', 'none', 0, 0, (self) => coreOf(self).random());
method(coreClass, 'seed', 'expected', 0, 1, (self, [n]) => {
  coreOf(self).initByArray(keyOf(coreSeed(n ?? None)));
  return None;
});
method(coreClass, 'getrandbits', 'one', 1, 1, (self, [k]) => getrandbits(coreOf(self), k));
method(coreClass, 'getstate', 'none', 0, 0, (self) => {
  const { words, index } = coreOf(self).state();
  return newTuple([...words.map(BigInt), BigInt(index)]);
});
method(coreClass, 'setstate', 'one', 1, 1, (self, [state]) => {
  restoreState(coreOf(self), state);
  return None;
});

registerModule('_random', () => new Map<string, PyValue>([['Random', coreClass]]));

// random -------------------------------------------------------------------------------------------------------------

/** Whether a method's parameters after `self` take these arguments. */
function fitsSignature(fn: PyFunction, args: readonly PyValue[], kwargs: Kwargs): boolean {
  const params = fn.def.params.slice(1);
  const positional = params.filter((param) => param.kind === 'positionalOnly' || param.kind === 'positional');
  const varArgs = params.some((param) => param.kind === 'varArgs');
  const varKeywords = params.some((param) => param.kind === 'varKeywords');
  if (args.length > positional.length && !varArgs) return false;
  const named = new Set(kwargs?.keys());
  for (const name of named) {
    const param = params.find((each) => each.name === name && each.kind !== 'positionalOnly');
    if (param === undefined && !varKeywords) return false;
    // A keyword for a parameter the positional arguments already gave.
    if (param !== undefined && positional.includes(param) && positional.indexOf(param) < args.length) return false;
  }
  return params.every(
    (param, index) =>
      param.default !== undefined ||
      param.kind === 'varArgs' ||
      param.kind === 'varKeywords' ||
      (positional.includes(param) && index < args.length) ||
      named.has(param.name)
  );
}

/**
 * Gives the module the natives of the hidden instance's methods, bound to the generator of random.py's `_inst`, which
 * give what its Python methods give.
 */
function bindNatives(globals: PyValue, instance: PyValue): PyValue {
  const fast = new PyOpaque(randomClass, 'Random', coreOf(instance));
  for (const [name] of RANDOM_METHODS) {
    // The function is random.py's method bound to _inst, as CPython's is, which runs the native in its place.
    const fn = classOf(instance).lookup(name);
    if (!(fn instanceof PyFunction)) continue;
    const bound = new PyBoundMethod(methodClass, instance, fn);
    const native = bindValue(randomClass.dict.get(name) as PyValue, fast);
    // Arguments the Python method would refuse reach it, which words the TypeError as CPython does.
    bound.fastCall = nativeFunction(name, (args, kwargs) =>
      fitsSignature(fn, args, kwargs) ? callValue(native, args, kwargs) : callValue(fn, [instance, ...args], kwargs)
    );
    setItem(globals, name, bound);
  }
  return None;
}

registerSourceModule(
  'random',
  RANDOM_SOURCE,
  () =>
    new Map<string, PyValue>([
      [
        '_bind_natives',
        builtin('_bind_natives', 'expected', 2, 2, ([globals, instance]) => bindNatives(globals, instance)),
      ],
      // os.urandom, which SystemRandom reads: random bytes from the host.
      [
        '_urandom',
        builtin('_urandom', 'one', 1, 1, ([n]) => newBytes(crypto.getRandomValues(new Uint8Array(Number(toIndex(n)))))),
      ],
    ])
);

export { isTruthy, typeName };
