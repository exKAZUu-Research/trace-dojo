import { createHash, randomBytes } from 'node:crypto';

import { builtin } from '../define';
import { pyHash } from '../hashing';
import { registerModule } from '../modules';
import { argument, checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import { getItem, isTruthy, lengthOf, setItem, toArray } from '../objects';
import { binaryOp, lessThan } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { newList, None, pyError, typeError, typeName, valueError } from '../types';
import { type Kwargs, PyDict, PySet, type PyValue } from '../values';
import { realArgument } from './math';

const N = 624;
const M = 397;

/** The Mersenne Twister of CPython's `_random` module, seeded as `random.seed` seeds it. */
export class MersenneTwister {
  private readonly state = new Uint32Array(N);
  private index = N + 1;
  gaussNext: number | undefined;

  private initGenrand(seed: number): void {
    const mt = this.state;
    mt[0] = seed >>> 0;
    for (let index = 1; index < N; index++) {
      const previous = mt[index - 1] ^ (mt[index - 1] >>> 30);
      mt[index] = (Math.imul(1_812_433_253, previous) + index) >>> 0;
    }
    this.index = N;
  }

  initByArray(key: number[]): void {
    const mt = this.state;
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
    const mt = this.state;
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
  if (value === undefined || value === None) return BigInt(`0x${randomBytes(32).toString('hex')}`);
  if (typeof value === 'bigint' || typeof value === 'boolean') return BigInt(value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    const digest = createHash('sha512').update(bytes).digest();
    return BigInt(`0x${Buffer.concat([bytes, digest]).toString('hex')}`);
  }
  if (typeof value === 'number') return pyHash(value);
  throw typeError('The only supported seed types are:\nNone, int, float, str, bytes, and bytearray.');
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

function sample(generator: MersenneTwister, args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'sample', min: 2, max: 2, style: 'takes', keywords: ['counts'] }, args, kwargs);
  const [population, kValue] = args;
  if (!isSequence(population) && typeof population !== 'string') {
    throw typeError('Population must be a sequence.  For dicts or sets, use sorted(d).');
  }
  const n = lengthOf(population);
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

registerModule('random', () => {
  const generator = new MersenneTwister();
  generator.initByArray(keyOf(seedOf(undefined)));
  return new Map<string, PyValue>([
    [
      'seed',
      builtin(
        'seed',
        'takes',
        0,
        2,
        (args, kwargs) => {
          generator.initByArray(keyOf(seedOf(argument(args, kwargs, 0, 'a'))));
          return None;
        },
        { keywords: ['a', 'version'] }
      ),
    ],
    ['random', builtin('random', 'none', 0, 0, () => generator.random())],
    [
      'getrandbits',
      builtin('getrandbits', 'one', 1, 1, ([bits]) => {
        const count = Number(toIndex(bits));
        if (count < 0) throw valueError('number of bits must be non-negative');
        return generator.getrandbits(count);
      }),
    ],
    ['randrange', builtin('randrange', 'expected', 1, 3, (args) => randrange(generator, args))],
    [
      'randint',
      builtin('randint', 'expected', 2, 2, ([a, b]) => {
        const low = toIndex(a);
        const high = toIndex(b);
        if (high + 1n - low <= 0n) throw valueError(`empty range in randint(${low}, ${high})`);
        return randrange(generator, [low, high + 1n]);
      }),
    ],
    [
      'choice',
      builtin('choice', 'one', 1, 1, ([sequence]) => {
        const length = lengthOf(sequence);
        if (length === 0) throw pyError('IndexError', 'Cannot choose from an empty sequence');
        return getItem(sequence, generator.randbelow(BigInt(length)));
      }),
    ],
    [
      'choices',
      builtin('choices', 'takes', 1, 2, (args, kwargs) => choices(generator, args, kwargs), {
        keywords: ['population', 'weights', 'cum_weights', 'k'],
      }),
    ],
    [
      'shuffle',
      builtin('shuffle', 'one', 1, 1, ([list]) => {
        const length = lengthOf(list);
        for (let index = length - 1; index > 0; index--) {
          const j = generator.randbelow(BigInt(index + 1));
          const a = getItem(list, BigInt(index));
          const b = getItem(list, j);
          setItem(list, BigInt(index), b);
          setItem(list, j, a);
        }
        return None;
      }),
    ],
    [
      'sample',
      builtin('sample', 'takes', 2, 2, (args, kwargs) => sample(generator, args, kwargs), { keywords: ['counts'] }),
    ],
    [
      'uniform',
      builtin('uniform', 'expected', 2, 2, ([a, b]) => {
        const low = realArgument(a);
        return low + (realArgument(b) - low) * generator.random();
      }),
    ],
    [
      'gauss',
      builtin(
        'gauss',
        'takes',
        0,
        2,
        (args, kwargs) =>
          gauss(
            generator,
            realArgument(argument(args, kwargs, 0, 'mu') ?? 0),
            realArgument(argument(args, kwargs, 1, 'sigma') ?? 1)
          ),
        { keywords: ['mu', 'sigma'] }
      ),
    ],
  ]);
});

export { isTruthy, typeName };
