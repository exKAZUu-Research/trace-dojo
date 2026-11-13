// code-gauge-allow-file fileNcss 466 -- The native random generator and the methods random.py's module functions run.
import { setAttribute } from '../attributes';
import { bytesClass, latin1Text, newBytes, PyBytes } from '../bytesValues';
import { pyStr } from '../conversions';
import { builtin, method, pythonMethod } from '../define';
import { sha512 } from '../hashAlgorithms';
import { pyHash } from '../hashing';
import { defineNew } from '../instances';
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
import { binaryOp, equals, lessThan } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { registerSourceModule } from '../sourceModules';
import {
  builtinClass,
  classOf,
  floatClass,
  intClass,
  isInstanceOf,
  methodClass,
  nativeFunction,
  newList,
  newTuple,
  None,
  objectClass,
  pyError,
  strClass,
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

// code-gauge-allow functionCognitiveComplexity 19 -- Follows random_seed and Random.seed, one case per seed type and version.
export function seedOf(value: PyValue | undefined, version: PyValue = 2n): bigint {
  if (value === undefined || value === None) return bigintOfBytes(crypto.getRandomValues(new Uint8Array(32)));
  if (isInstanceOf(value, intClass)) return toIndex(value);
  if (isInstanceOf(value, strClass) || value instanceof PyBytes) {
    if (equals(version, 1n) && (isInstanceOf(value, strClass) || isInstanceOf(value, bytesClass))) {
      const text =
        value instanceof PyBytes
          ? latin1Text(value.data)
          : typeof value === 'string'
            ? value
            : ((value as PyInstance).primitive as string);
      return versionOneSeed(text);
    }
    if (equals(version, 2n)) return bigintOfBytes(versionTwoBytes(value));
    return BigInt.asUintN(64, pyHash(value));
  }
  if (isInstanceOf(value, floatClass)) return BigInt.asUintN(64, pyHash(value));
  throw typeError('The only supported seed types are:\nNone, int, float, str, bytes, and bytearray.');
}

/**
 * The key a seed initializes the generator with. A str or bytes seed of version 2 makes it from its bytes directly,
 * as the int CPython makes of them may exceed the size of the ints this grader lets a program make.
 */
function seedKey(value: PyValue | undefined, version: PyValue = 2n): number[] {
  if (value !== undefined && (isInstanceOf(value, strClass) || value instanceof PyBytes) && equals(version, 2n)) {
    return wordsOfHex(hexOfBytes(versionTwoBytes(value)).replace(/^0+(?=.)/, ''));
  }
  return keyOf(seedOf(value, version));
}

/** The bytes of a str or bytes seed of version 2 followed by their SHA-512, whose int CPython seeds with. */
function versionTwoBytes(value: PyValue): Uint8Array {
  const bytes =
    value instanceof PyBytes
      ? value.data
      : new TextEncoder().encode(typeof value === 'string' ? value : ((value as PyInstance).primitive as string));
  currentRuntime().scan(bytes.length);
  const combined = new Uint8Array(bytes.length + 64);
  combined.set(bytes);
  combined.set(sha512(bytes), bytes.length);
  return combined;
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

/** The 32-bit words of a seed's absolute value, least significant first, as CPython's random_seed splits it. */
export function keyOf(seed: bigint): number[] {
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

function hexOfBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The big-endian unsigned integer that bytes encode. */
function bigintOfBytes(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(`0x${hexOfBytes(bytes)}`);
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
  ['randbytes', 'n', (generator, [n]) => randbytes(generator, n)],
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
  generator.initByArray(seedKey(a, version));
  generator.gaussNext = undefined;
  return None;
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
coreClass.typeName = '_random.Random';
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
  if (isInstanceOf(value, intClass)) return toIndex(value);
  return BigInt.asUintN(64, pyHash(value));
}

defineNew(coreClass, (cls, _args, kwargs) => {
  if (cls === coreClass && kwargs !== undefined && kwargs.size > 0) {
    throw typeError('Random() takes no keyword arguments');
  }
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
