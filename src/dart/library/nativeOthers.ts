import { power } from '../../interpreter/power';
import { encodableText } from '../format';
import { ProgramExit, type Runtime } from '../runtime';
import { DartObject, type Value } from '../values';
import { toDouble } from './nativeNumbers';
import { closedSinks, define, defineConstructor, intArg, numArg } from './nativeSupport';

// dart:math

define('min', (runtime, _receiver, [a, b]) => {
  const x = numArg(runtime, a, 'a');
  const y = numArg(runtime, b, 'b');
  const order = compareMathOperands(x, y);
  if (order !== 0) return order < 0 ? x : y;
  if (typeof y === 'number') {
    if (typeof x === 'number' && x === 0) return (x + y) * x * y;
    if (Number.isNaN(y) || (x === 0n && Object.is(y, -0))) return y;
  }
  return x;
});
define('max', (runtime, _receiver, [a, b]) => {
  const x = numArg(runtime, a, 'a');
  const y = numArg(runtime, b, 'b');
  const order = compareMathOperands(x, y);
  if (order !== 0) return order > 0 ? x : y;
  if (typeof y === 'number') {
    if (typeof x === 'number' && x === 0) return x + y;
    if (Number.isNaN(y)) return y;
  } else if (y === 0n && Object.is(x, -0)) {
    return y;
  }
  return x;
});

function compareMathOperands(a: bigint | number, b: bigint | number): number {
  const bothInts = typeof a === 'bigint' && typeof b === 'bigint';
  const x = bothInts ? a : toDouble(a);
  const y = bothInts ? b : toDouble(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

for (const name of ['sin', 'cos', 'tan', 'acos', 'asin', 'atan', 'sqrt', 'exp', 'log'] as const) {
  define(name, (runtime, _receiver, [x]) => Math[name](toDouble(numArg(runtime, x, 'x'))));
}
define('atan2', (runtime, _receiver, [a, b]) =>
  Math.atan2(toDouble(numArg(runtime, a, 'a')), toDouble(numArg(runtime, b, 'b')))
);
define('pow', (runtime, _receiver, [x, exponent]) => {
  const base = numArg(runtime, x, 'x');
  const power = numArg(runtime, exponent, 'exponent');
  if (typeof base === 'bigint' && typeof power === 'bigint' && power >= 0n) {
    let result = 1n;
    let current = base;
    let remaining = power;
    while (remaining > 0n) {
      if (remaining & 1n) result = BigInt.asIntN(64, result * current);
      current = BigInt.asIntN(64, current * current);
      remaining >>= 1n;
      runtime.spend();
    }
    return result;
  }
  return doublePower(toDouble(base), toDouble(power));
});

function doublePower(base: number, exponent: number): number {
  if (exponent === 0 || base === 1) return 1;
  if (exponent === 1) return base;
  if (exponent === 2) return base * base;
  if (exponent === 3) return base * base * base;
  if (exponent === 0.5 && base !== -Infinity) return base === 0 ? 0 : Math.sqrt(base);
  return power(base, exponent);
}

/** The VM's Random: multiply-with-carry with the seed mixed by Thomas Wang's 64-bit hash. */
class RandomState {
  [key: string]: unknown;
  low: bigint;
  high: bigint;

  constructor(seed: bigint) {
    let state = mix64(BigInt.asUintN(64, seed));
    if (state === 0n) state = 0x5a_17n;
    this.low = state & 0xff_ff_ff_ffn;
    this.high = state >> 32n;
    for (let crank = 0; crank < 4; crank++) this.next();
  }

  values(): Iterable<Value> {
    return [];
  }

  next(): void {
    const state = BigInt.asUintN(64, 0xff_ff_da_61n * this.low + this.high);
    this.low = state & 0xff_ff_ff_ffn;
    this.high = state >> 32n;
  }

  nextInt(runtime: Runtime, max: bigint): bigint {
    if (max <= 0n || max > 0x1_00_00_00_00n) {
      runtime.throwError('RangeError', 'range', [max, 1n, 0x1_00_00_00_00n, 'max', 'Must be positive and <= 2^32']);
    }
    if ((max & -max) === max) {
      this.next();
      return this.low & (max - 1n);
    }
    let random: bigint;
    let result: bigint;
    do {
      this.next();
      random = this.low;
      result = random % max;
    } while (random - result + max > 0x1_00_00_00_00n);
    return result;
  }
}

function mix64(value: bigint): bigint {
  let n = value;
  const mask = (1n << 64n) - 1n;
  n = (~n + (n << 21n)) & mask;
  n ^= n >> 24n;
  n = (n * 265n) & mask;
  n ^= n >> 14n;
  n = (n * 21n) & mask;
  n ^= n >> 28n;
  n = (n + (n << 31n)) & mask;
  return n;
}

let unseeded = 0;

function randomOf(receiver: Value): RandomState {
  return (receiver as DartObject).native as unknown as RandomState;
}

defineConstructor('Random.new', (runtime, _instance, args) => {
  const seed = args.positional[0];
  const object = new DartObject(runtime.links.classNamed('_Random'), [], []);
  // An unseeded Random differs on every run of the VM; any sequence matches as well as another.
  object.native = new RandomState(
    seed === undefined ? BigInt(Date.now()) + BigInt(unseeded++) : intArg(runtime, seed, 'seed')
  ) as unknown as DartObject['native'];
  return object;
});
define('_SecureRandom._getBytes', (runtime, _self, [count]) => {
  const bytes = crypto.getRandomValues(new Uint8Array(Number(intArg(runtime, count, 'count'))));
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
});
define('_Random.nextInt', (runtime, receiver, [max]) =>
  randomOf(receiver).nextInt(runtime, intArg(runtime, max, 'max'))
);
define('_Random.nextDouble', (runtime, receiver) => {
  const random = randomOf(receiver);
  const high = random.nextInt(runtime, 1n << 26n);
  const low = random.nextInt(runtime, 1n << 27n);
  return (Number(high) * 2 ** 27 + Number(low)) / 2 ** 53;
});
define('_Random.nextBool', (runtime, receiver) => randomOf(receiver).nextInt(runtime, 2n) === 0n);

// dart:io

define('_writeStream', (runtime, _receiver, [isError, text]) => {
  const channel = isError === true ? runtime.io.stderr : runtime.io.stdout;
  channel.write(text as string, encodableText);
  return;
});
// print reads whether standard output is closed, after which it drops what it prints, as the VM's closed descriptor does.
define('_closeStream', (runtime, _receiver, [isError]) => {
  const closed = closedSinks.get(runtime) ?? new Set<boolean>();
  closed.add(isError === true);
  closedSinks.set(runtime, closed);
  return;
});
define('exit', (runtime, _receiver, [code]) => {
  throw new ProgramExit(Number(intArg(runtime, code, 'code')));
});
