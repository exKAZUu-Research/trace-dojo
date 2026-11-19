import type { OutputChannel } from '../../interpreter/programIo';
import { encodableText, stringOf } from '../format';
import { ProgramExit, type Runtime } from '../runtime';
import { DartObject, type Value } from '../values';
import { compareNumbers, toDouble } from './nativeNumbers';
import { define, defineConstructor, intArg, iterableValues, numArg } from './nativeSupport';

// dart:math

define('min', (runtime, _receiver, [a, b]) => {
  const x = numArg(runtime, a, 'a');
  const y = numArg(runtime, b, 'b');
  if (typeof x === 'number' && Number.isNaN(x)) return x;
  if (typeof y === 'number' && Number.isNaN(y)) return y;
  return compareNumbers(x, y) <= 0 ? x : y;
});
define('max', (runtime, _receiver, [a, b]) => {
  const x = numArg(runtime, a, 'a');
  const y = numArg(runtime, b, 'b');
  if (typeof x === 'number' && Number.isNaN(x)) return x;
  if (typeof y === 'number' && Number.isNaN(y)) return y;
  return compareNumbers(x, y) >= 0 ? x : y;
});
for (const [name, fn] of [
  ['sin', Math.sin],
  ['cos', Math.cos],
  ['tan', Math.tan],
  ['acos', Math.acos],
  ['asin', Math.asin],
  ['atan', Math.atan],
  ['sqrt', Math.sqrt],
  ['exp', Math.exp],
  ['log', Math.log],
] as const) {
  define(name, (runtime, _receiver, [x]) => fn(toDouble(numArg(runtime, x, 'x'))));
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
  const b = toDouble(base);
  const p = toDouble(power);
  // Dart follows C's pow, where 1 to any power and any number to the power 0 are 1, even with NaN.
  if (b === 1 || p === 0) return 1;
  return b ** p;
});

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
  const object = new DartObject(runtime.links.classNamed('Random'), [], []);
  // An unseeded Random differs on every run of the VM; any sequence matches as well as another.
  object.native = new RandomState(
    seed === undefined ? BigInt(Date.now()) + BigInt(unseeded++) : intArg(runtime, seed, 'seed')
  ) as unknown as DartObject['native'];
  return object;
});
defineConstructor('Random.secure', (runtime) =>
  runtime.throwError('UnsupportedError', '', ['Random.secure は、この採点環境では使えません。'])
);
define('Random.nextInt', (runtime, receiver, [max]) =>
  randomOf(receiver).nextInt(runtime, intArg(runtime, max, 'max'))
);
define('Random.nextDouble', (runtime, receiver) => {
  const random = randomOf(receiver);
  const high = random.nextInt(runtime, 1n << 26n);
  const low = random.nextInt(runtime, 1n << 27n);
  return (Number(high) * 2 ** 27 + Number(low)) / 2 ** 53;
});
define('Random.nextBool', (runtime, receiver) => randomOf(receiver).nextInt(runtime, 2n) === 0n);

// dart:io

function sinkOf(runtime: Runtime, receiver: Value): Pick<OutputChannel, 'write'> {
  const isError = (receiver as DartObject).fields[0] === true;
  const channel = isError ? runtime.io.stderr : runtime.io.stdout;
  return { write: (text: string) => channel.write(encodableText(text)) };
}

define('_StandardSink.write', (runtime, receiver, [value]) => {
  sinkOf(runtime, receiver).write(stringOf(runtime, value));
  return;
});
define('_StandardSink.writeln', (runtime, receiver, [value = '']) => {
  sinkOf(runtime, receiver).write(`${stringOf(runtime, value)}\n`);
  return;
});
define('_StandardSink.writeAll', (runtime, receiver, [objects, separator = '']) => {
  sinkOf(runtime, receiver).write(
    iterableValues(runtime, objects)
      .map((value) => stringOf(runtime, value))
      .join(separator as string)
  );
  return;
});
define('_StandardSink.writeCharCode', (runtime, receiver, [code]) => {
  sinkOf(runtime, receiver).write(String.fromCodePoint(Number(intArg(runtime, code, 'charCode'))));
  return;
});
define('exit', (runtime, _receiver, [code]) => {
  throw new ProgramExit(Number(intArg(runtime, code, 'code')));
});
