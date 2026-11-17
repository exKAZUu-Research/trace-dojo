// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { callMethod } from './callables';
import { findClass } from './classes';
import { valueName } from './conversions';
import { deprecated, throwError } from './errors';
import { defineClass, type NativeMethod } from './native';
import { toStr } from './operators';
import { MersenneTwister } from './random';
import { rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { type Key, PhpArray, type PhpClass, PhpObject, type Value } from './values';

const MASK64 = (1n << 64n) - 1n;
const MASK32 = 0xff_ff_ff_ffn;
const RANGE_ATTEMPTS = 50;

/** One output of an engine: its bytes, little-endian, in `result`. */
interface Generated {
  size: number;
  result: bigint;
}

interface Algo {
  generate(): Generated;
}

/** The state of one of PHP's engine classes, which a Randomizer using the engine shares. */
abstract class EngineState implements Algo {
  abstract generate(): Generated;
  abstract clone(): EngineState;
  /** The `__states` list Mt19937's, PcgOneseq128XslRr64's, and Xoshiro256StarStar's __debugInfo show. */
  abstract states(): Value[];
}

class Mt19937State extends EngineState {
  constructor(readonly mt = new MersenneTwister()) {
    super();
  }

  generate(): Generated {
    return { size: 4, result: BigInt(this.mt.next()) };
  }

  clone(): Mt19937State {
    return new Mt19937State(this.mt.copy());
  }

  states(): Value[] {
    const { words, count } = this.mt.snapshot();
    return [...words.map((word) => hexLe(BigInt(word), 4)), BigInt(count), this.mt.phpMode ? 1n : 0n];
  }
}

const PCG_MULTIPLIER = (2_549_297_995_355_413_924n << 64n) | 4_865_540_595_714_422_341n;
const PCG_INCREMENT = (6_364_136_223_846_793_005n << 64n) | 1_442_695_040_888_963_407n;
const MASK128 = (1n << 128n) - 1n;

class PcgState extends EngineState {
  state = 0n;

  seed(seed: bigint): void {
    this.state = 0n;
    this.step();
    this.state = (this.state + seed) & MASK128;
    this.step();
  }

  generate(): Generated {
    this.step();
    const high = this.state >> 64n;
    const value = (high ^ this.state) & MASK64;
    const shift = high >> 58n;
    return { size: 8, result: ((value >> shift) | (value << (-shift & 63n))) & MASK64 };
  }

  /** Transcribes php_random_pcgoneseq128xslrr64_advance, which jumps `advance` steps ahead. */
  advance(steps: bigint): void {
    let multiplier = PCG_MULTIPLIER;
    let increment = PCG_INCREMENT;
    let accMultiplier = 1n;
    let accIncrement = 0n;
    for (let left = steps; left > 0n; left >>= 1n) {
      if (left & 1n) {
        accMultiplier = (accMultiplier * multiplier) & MASK128;
        accIncrement = (accIncrement * multiplier + increment) & MASK128;
      }
      increment = ((multiplier + 1n) * increment) & MASK128;
      multiplier = (multiplier * multiplier) & MASK128;
    }
    this.state = (accMultiplier * this.state + accIncrement) & MASK128;
  }

  clone(): PcgState {
    const copy = new PcgState();
    copy.state = this.state;
    return copy;
  }

  states(): Value[] {
    return [hexLe(this.state >> 64n, 8), hexLe(this.state & MASK64, 8)];
  }

  private step(): void {
    this.state = (this.state * PCG_MULTIPLIER + PCG_INCREMENT) & MASK128;
  }
}

const rotl = (value: bigint, bits: bigint): bigint => ((value << bits) | (value >> (64n - bits))) & MASK64;

class XoshiroState extends EngineState {
  state = [0n, 0n, 0n, 0n];

  seed64(seed: bigint): void {
    let current = seed;
    this.state = this.state.map(() => {
      current = (current + 0x9e_37_79_b9_7f_4a_7c_15n) & MASK64;
      let value = current;
      value = ((value ^ (value >> 30n)) * 0xbf_58_47_6d_1c_e4_e5_b9n) & MASK64;
      value = ((value ^ (value >> 27n)) * 0x94_d0_49_bb_13_31_11_ebn) & MASK64;
      return value ^ (value >> 31n);
    });
  }

  generate(): Generated {
    const s = this.state;
    const result = (rotl((s[1] * 5n) & MASK64, 7n) * 9n) & MASK64;
    const shifted = (s[1] << 17n) & MASK64;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= shifted;
    s[3] = rotl(s[3], 45n);
    return { size: 8, result };
  }

  jump(table: bigint[]): void {
    const jumped = [0n, 0n, 0n, 0n];
    for (const word of table) {
      for (let bit = 0n; bit < 64n; bit++) {
        if ((word >> bit) & 1n) for (let index = 0; index < 4; index++) jumped[index] ^= this.state[index];
        this.generate();
      }
    }
    this.state = jumped;
  }

  clone(): XoshiroState {
    const copy = new XoshiroState();
    copy.state = [...this.state];
    return copy;
  }

  states(): Value[] {
    return this.state.map((word) => hexLe(word, 8));
  }
}

/** A Random\Engine the program implements, whose generate() gives the bytes. */
class UserAlgo implements Algo {
  constructor(private readonly engine: PhpObject) {}

  generate(): Generated {
    const bytes = toStr(callMethod(this.engine, 'generate', []));
    if (bytes.length === 0)
      throwError(String.raw`Random\BrokenRandomEngineError`, 'A random engine must return a non-empty string');
    return { size: Math.min(bytes.length, 8), result: littleEndian(bytes.slice(0, 8)) };
  }
}

function littleEndian(bytes: string): bigint {
  let result = 0n;
  for (let index = bytes.length - 1; index >= 0; index--)
    result = (result << 8n) | BigInt(bytes.codePointAt(index) as number);
  return result;
}

/** The bytes of `value` in memory order as hexadecimal, as php_random_bin2hex_le writes them. */
function hexLe(value: bigint, size: number): string {
  let text = '';
  for (let index = 0; index < size; index++)
    text += Number((value >> BigInt(index * 8)) & 0xffn)
      .toString(16)
      .padStart(2, '0');
  return text;
}

function bytesOf(generated: Generated): string {
  let text = '';
  for (let index = 0; index < generated.size; index++)
    text += String.fromCodePoint(Number((generated.result >> BigInt(index * 8)) & 0xffn));
  return text;
}

// Ranges -------------------------------------------------------------------------------------------------------------

/** Transcribes php_random_range, which draws 32 bits for a range that fits them and 64 otherwise. */
function range(algo: Algo, min: bigint, max: bigint): bigint {
  const umax = BigInt.asUintN(64, max - min);
  return BigInt.asIntN(64, (umax > MASK32 ? rangeBits(algo, umax, 64) : rangeBits(algo, umax, 32)) + min);
}

/** Transcribes php_random_range32 and php_random_range64, which reject draws above a multiple of the range. */
function rangeBits(algo: Algo, umax: bigint, bits: 32 | 64): bigint {
  const max = bits === 32 ? MASK32 : MASK64;
  let result = draw(algo, bits);
  if (umax === max) return result;
  const size = umax + 1n;
  if ((size & (size - 1n)) === 0n) return result & (size - 1n);
  const limit = max - (max % size) - 1n;
  let count = 0;
  while (result > limit) {
    if (++count > RANGE_ATTEMPTS) brokenEngine();
    result = draw(algo, bits);
  }
  return result % size;
}

function draw(algo: Algo, bits: 32 | 64): bigint {
  let result = 0n;
  let total = 0;
  do {
    const generated = algo.generate();
    result |= (bits === 32 ? generated.result & MASK32 : generated.result) << BigInt(total * 8);
    total += generated.size;
  } while (total * 8 < bits);
  return BigInt.asUintN(bits, result);
}

function brokenEngine(): never {
  throwError(
    String.raw`Random\BrokenRandomEngineError`,
    `Failed to generate an acceptable random number in ${RANGE_ATTEMPTS} attempts`
  );
}

// Floats -------------------------------------------------------------------------------------------------------------

function nextAfter(value: number, direction: number): number {
  if (value === direction) return value;
  if (value === 0) return direction > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, value < direction === value > 0 ? bits + 1n : bits - 1n);
  return view.getFloat64(0);
}

/** Transcribes php_random_gammasection_closed_open, which picks one of the evenly spaced floats in [min, max). */
function gammaClosedOpen(algo: Algo, min: number, max: number): number {
  const gamma =
    Math.abs(min) > Math.abs(max) ? nextAfter(min, Number.MAX_VALUE) - min : max - nextAfter(max, -Number.MAX_VALUE);
  const high = ceilInt(min, max, gamma);
  if (max <= min || high < 1n) return Number.NaN;
  const k = 1n + rangeBits(algo, high - 1n, 64);
  if (Math.abs(min) <= Math.abs(max)) {
    if (k === high) return min;
    return 4 * (max * 0.25 - Number(k >> 2n) * gamma) - Number(k & 3n) * gamma;
  }
  const below = k - 1n;
  return 4 * (min * 0.25 + Number(below >> 2n) * gamma) + Number(below & 3n) * gamma;
}

function ceilInt(a: number, b: number, gamma: number): bigint {
  const s = b / gamma - a / gamma;
  const e = Math.abs(a) <= Math.abs(b) ? -a / gamma - (s - b / gamma) : b / gamma - (s + a / gamma);
  const ceiling = Math.ceil(s);
  return BigInt(ceiling) + (s === ceiling && e > 0 ? 1n : 0n);
}

// Randomizer ---------------------------------------------------------------------------------------------------------

const algoOf = (object: PhpObject): Algo => object.internal as Algo;

/** Transcribes php_array_data_shuffle and php_binary_string_shuffle, a Fisher-Yates shuffle from the end. */
function shuffle<T>(algo: Algo, items: T[]): T[] {
  for (let left = items.length - 1; left > 0; left--) {
    const index = Number(range(algo, 0n, BigInt(left)));
    if (index !== left) [items[left], items[index]] = [items[index], items[left]];
  }
  return items;
}

const randomizerMethods: NativeMethod[] = [
  {
    // The parameter's type is checked here: a native signature cannot spell the nullable class type as PHP does.
    signature: '__construct($engine = null)',
    impl: ({ thisObj, args }) => {
      const engine = args[0] ?? null;
      if (
        engine !== null &&
        !(engine instanceof PhpObject && engine.cls.isSubclassOf(findClass(String.raw`Random\Engine`) as PhpClass))
      )
        throwError(
          'TypeError',
          `Random\\Randomizer::__construct(): Argument #1 ($engine) must be of type ?Random\\Engine, ${valueName(engine)} given`
        );
      if (!(engine instanceof PhpObject))
        throw new UnsupportedFeatureError(String.raw`乱数の種を指定できない Random\Engine\Secure`);
      thisObj.props.set('engine', engine);
      thisObj.internal = engine.internal instanceof EngineState ? engine.internal : new UserAlgo(engine);
      return null;
    },
  },
  {
    signature: 'nextInt(): int',
    impl: ({ thisObj }) => BigInt.asIntN(64, algoOf(thisObj).generate().result >> 1n),
  },
  {
    signature: 'nextFloat(): float',
    impl: ({ thisObj }) => Number(draw(algoOf(thisObj), 64) >> 11n) * 2 ** -53,
  },
  {
    signature: 'getFloat(float $min, float $max)',
    impl: ({ thisObj, args }) => {
      const [min, max] = args as [number, number];
      if (!Number.isFinite(min))
        throwError('ValueError', String.raw`Random\Randomizer::getFloat(): Argument #1 ($min) must be finite`);
      if (!Number.isFinite(max))
        throwError('ValueError', String.raw`Random\Randomizer::getFloat(): Argument #2 ($max) must be finite`);
      if (max <= min)
        throwError(
          'ValueError',
          String.raw`Random\Randomizer::getFloat(): Argument #2 ($max) must be greater than argument #1 ($min)`
        );
      return gammaClosedOpen(algoOf(thisObj), min, max);
    },
  },
  {
    signature: 'getInt(int $min, int $max): int',
    impl: ({ thisObj, args }) => {
      const [min, max] = args as [bigint, bigint];
      if (max < min)
        throwError(
          'ValueError',
          String.raw`Random\Randomizer::getInt(): Argument #2 ($max) must be greater than or equal to argument #1 ($min)`
        );
      const algo = algoOf(thisObj);
      if (!(algo instanceof Mt19937State) || !algo.mt.phpMode) return range(algo, min, max);
      // MT_RAND_PHP scales a 31-bit output into the range with floats (RAND_RANGE_BADSCALING).
      const r = algo.mt.next() >>> 1;
      const offset = Math.trunc((Number(max) - Number(min) + 1) * (r / 2_147_483_648));
      return BigInt.asIntN(64, BigInt(offset) + min);
    },
  },
  {
    signature: 'getBytes(int $length): string',
    impl: ({ thisObj, args }) => {
      const length = Number(args[0]);
      if (length < 1)
        throwError(
          'ValueError',
          String.raw`Random\Randomizer::getBytes(): Argument #1 ($length) must be greater than 0`
        );
      return randomBytes(algoOf(thisObj), length);
    },
  },
  {
    signature: 'getBytesFromString(string $string, int $length): string',
    impl: ({ thisObj, args }) => {
      const source = args[0] as string;
      const length = Number(args[1]);
      if (source.length === 0)
        throwError(
          'ValueError',
          String.raw`Random\Randomizer::getBytesFromString(): Argument #1 ($string) must not be empty`
        );
      if (length < 1)
        throwError(
          'ValueError',
          String.raw`Random\Randomizer::getBytesFromString(): Argument #2 ($length) must be greater than 0`
        );
      return bytesFromString(algoOf(thisObj), source, length);
    },
  },
  {
    signature: 'shuffleArray(array $array): array',
    impl: ({ thisObj, args }) => PhpArray.copySlots(shuffle(algoOf(thisObj), [...(args[0] as PhpArray).map.values()])),
  },
  {
    signature: 'shuffleBytes(string $bytes): string',
    impl: ({ thisObj, args }) => shuffle(algoOf(thisObj), (args[0] as string).split('')).join(''),
  },
  {
    signature: 'pickArrayKeys(array $array, int $num): array',
    impl: ({ thisObj, args }) => pickKeys(algoOf(thisObj), args[0] as PhpArray, Number(args[1])),
  },
  ...['__serialize(): array', '__unserialize(array $data): void'].map((signature): NativeMethod => ({
    signature,
    impl: () => {
      throw new UnsupportedFeatureError('直列化');
    },
  })),
];

/** Transcribes Randomizer::getBytes, which copies whole 64-bit outputs while they fit. */
function randomBytes(algo: Algo, length: number): string {
  rt().ensureStringFits(length);
  rt().spend(Math.ceil(length / 8));
  let text = '';
  let carried: Generated | undefined;
  while (text.length + 8 <= length) {
    const generated = algo.generate();
    if (generated.size !== 8) {
      carried = generated;
      break;
    }
    text += bytesOf(generated);
  }
  while (text.length < length) {
    const generated = carried ?? algo.generate();
    carried = undefined;
    text += bytesOf(generated).slice(0, length - text.length);
  }
  return text;
}

/** Transcribes Randomizer::getBytesFromString, which masks each output byte for a short source. */
function bytesFromString(algo: Algo, source: string, length: number): string {
  rt().ensureStringFits(length);
  rt().spend(Math.ceil(length / 8));
  const maxOffset = source.length - 1;
  let text = '';
  if (maxOffset > 0xff) {
    while (text.length < length) text += source[Number(range(algo, 0n, BigInt(maxOffset)))];
    return text;
  }
  let mask = maxOffset;
  mask |= mask >> 1;
  mask |= mask >> 2;
  mask |= mask >> 4;
  let failures = 0;
  while (text.length < length) {
    const generated = algo.generate();
    for (let index = 0; index < generated.size && text.length < length; index++) {
      const offset = Number((generated.result >> BigInt(index * 8)) & BigInt(mask));
      if (offset > maxOffset) {
        if (++failures > RANGE_ATTEMPTS) brokenEngine();
        continue;
      }
      failures = 0;
      text += source[offset];
    }
  }
  return text;
}

/** Transcribes php_array_pick_keys for an array without holes. */
function pickKeys(algo: Algo, array: PhpArray, wanted: number): PhpArray {
  const keys = array.keys();
  if (keys.length === 0)
    throwError('ValueError', String.raw`Random\Randomizer::pickArrayKeys(): Argument #1 ($array) must not be empty`);
  if (wanted === 1) return PhpArray.list([keys[Number(range(algo, 0n, BigInt(keys.length - 1)))]]);
  if (wanted <= 0 || wanted > keys.length)
    throwError(
      'ValueError',
      String.raw`Random\Randomizer::pickArrayKeys(): Argument #2 ($num) must be between 1 and the number of elements in argument #1 ($array)`
    );
  const negative = wanted > keys.length >> 1;
  let left = negative ? keys.length - wanted : wanted;
  const chosen = new Set<number>();
  let failures = 0;
  while (left > 0) {
    const index = Number(range(algo, 0n, BigInt(keys.length - 1)));
    if (chosen.has(index)) {
      if (++failures > RANGE_ATTEMPTS) brokenEngine();
    } else {
      chosen.add(index);
      left--;
      failures = 0;
    }
  }
  return PhpArray.list(keys.filter((_, index) => chosen.has(index) !== negative).map((key: Key) => key));
}

// Classes ------------------------------------------------------------------------------------------------------------

defineClass({
  name: String.raw`Random\Engine`,
  kind: 'interface',
  methods: [{ signature: 'generate(): string', impl: () => null, isAbstract: true }],
});
defineClass({ name: String.raw`Random\CryptoSafeEngine`, kind: 'interface', interfaces: [String.raw`Random\Engine`] });
defineClass({ name: String.raw`Random\RandomError`, parent: 'Error' });
defineClass({ name: String.raw`Random\BrokenRandomEngineError`, parent: String.raw`Random\RandomError` });
defineClass({ name: String.raw`Random\RandomException`, parent: 'Exception' });

const stateOf = <T extends EngineState>(object: PhpObject): T => object.internal as T;

/** The methods every seedable engine has besides its constructor. */
function engineMethods(): NativeMethod[] {
  return [
    { signature: 'generate(): string', impl: ({ thisObj }) => bytesOf(stateOf(thisObj).generate()) },
    ...['__serialize(): array', '__unserialize(array $data): void'].map((signature): NativeMethod => ({
      signature,
      impl: () => {
        throw new UnsupportedFeatureError('直列化');
      },
    })),
    {
      signature: '__debugInfo(): array',
      impl: ({ thisObj }) => {
        const info = new PhpArray();
        info.set('__states', PhpArray.list(stateOf(thisObj).states()));
        return info;
      },
    },
  ];
}

function unseeded(): never {
  throw new UnsupportedFeatureError('乱数の種を指定しない乱数エンジン');
}

/** The 64-bit words of a string seed, each from 8 bytes in little-endian order. */
function seedWords(seed: string): bigint[] {
  const words: bigint[] = [];
  for (let index = 0; index < seed.length; index += 8) words.push(littleEndian(seed.slice(index, index + 8)));
  return words;
}

/** Defines a seedable engine class, whose methods PHP lists as the constructor, generate, the jumps, and the rest. */
function defineEngine(
  name: string,
  constructor: NativeMethod,
  create: () => EngineState,
  jumps: NativeMethod[] = []
): void {
  const [generate, ...rest] = engineMethods();
  defineClass({
    name,
    interfaces: [String.raw`Random\Engine`],
    isFinal: true,
    methods: [constructor, generate, ...jumps, ...rest],
    createInternal: create,
  });
}

/** The constructor of an engine seeded by an int or a string of `bytes` bytes. */
function seedConstructor<T extends EngineState>(
  name: string,
  bytes: number,
  seedInt: (state: T, seed: bigint) => void,
  seedString: (state: T, words: bigint[]) => void
): NativeMethod {
  return {
    signature: '__construct(string|int|null $seed = null)',
    impl: ({ thisObj, args }) => {
      const seed = args[0];
      const state = stateOf<T>(thisObj);
      if (typeof seed === 'bigint') seedInt(state, BigInt.asUintN(64, seed));
      else if (typeof seed !== 'string') unseeded();
      else if (seed.length !== bytes)
        throwError(
          'ValueError',
          `${name}::__construct(): Argument #1 ($seed) must be a ${bytes} byte (${bytes * 8} bit) string`
        );
      else seedString(state, seedWords(seed));
      return null;
    },
  };
}

const MT19937 = String.raw`Random\Engine\Mt19937`;
defineEngine(
  MT19937,
  {
    signature: '__construct(?int $seed = null, int $mode = 0)',
    impl: ({ thisObj, args }) => {
      const mode = args[1] ?? 0n;
      if (mode === 1n) deprecated('The MT_RAND_PHP variant of Mt19937 is deprecated');
      else if (mode !== 0n)
        throwError(
          'ValueError',
          `${MT19937}::__construct(): Argument #2 ($mode) must be either MT_RAND_MT19937 or MT_RAND_PHP`
        );
      const seed = args[0];
      if (typeof seed !== 'bigint') unseeded();
      stateOf<Mt19937State>(thisObj).mt.seed(Number(BigInt.asUintN(32, seed)), mode === 1n);
      return null;
    },
  },
  () => new Mt19937State()
);

const PCG = String.raw`Random\Engine\PcgOneseq128XslRr64`;
defineEngine(
  PCG,
  seedConstructor<PcgState>(
    PCG,
    16,
    (state, seed) => state.seed(seed),
    (state, [high, low]) => state.seed((high << 64n) | low)
  ),
  () => new PcgState(),
  [
    {
      signature: 'jump(int $advance): void',
      impl: ({ thisObj, args }) => {
        const advance = args[0] as bigint;
        if (advance < 0n)
          throwError('ValueError', `${PCG}::jump(): Argument #1 ($advance) must be greater than or equal to 0`);
        stateOf<PcgState>(thisObj).advance(advance);
        return null;
      },
    },
  ]
);

const XOSHIRO_JUMP = [
  0x18_0e_c6_d3_3c_fd_0a_ban,
  0xd5_a6_12_66_f0_c9_39_2cn,
  0xa9_58_26_18_e0_3f_c9_aan,
  0x39_ab_dc_45_29_b1_66_1cn,
];
const XOSHIRO_JUMP_LONG = [
  0x76_e1_5d_3e_fe_fd_cb_bfn,
  0xc5_00_4e_44_1c_52_2f_b3n,
  0x77_71_00_69_85_4e_e2_41n,
  0x39_10_9b_b0_2a_cb_e6_35n,
];

const XOSHIRO = String.raw`Random\Engine\Xoshiro256StarStar`;
defineEngine(
  XOSHIRO,
  seedConstructor<XoshiroState>(
    XOSHIRO,
    32,
    (state, seed) => state.seed64(seed),
    (state, words) => (state.state = words)
  ),
  () => new XoshiroState(),
  [
    {
      signature: 'jump(): void',
      impl: ({ thisObj }) => (stateOf<XoshiroState>(thisObj).jump(XOSHIRO_JUMP), null),
    },
    {
      signature: 'jumpLong(): void',
      impl: ({ thisObj }) => (stateOf<XoshiroState>(thisObj).jump(XOSHIRO_JUMP_LONG), null),
    },
  ]
);
defineClass({
  name: String.raw`Random\Engine\Secure`,
  interfaces: [String.raw`Random\CryptoSafeEngine`, String.raw`Random\Engine`],
  isFinal: true,
  methods: [{ signature: 'generate(): string', impl: () => unseeded() }],
  createInternal: () => {
    throw new UnsupportedFeatureError(String.raw`乱数の種を指定できない Random\Engine\Secure`);
  },
});

defineClass({
  name: String.raw`Random\Randomizer`,
  isFinal: true,
  props: [{ name: 'engine', visibility: 'public', defaultValue: () => null, typed: true, isReadonly: true }],
  methods: randomizerMethods,
});
