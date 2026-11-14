// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { LIMITS } from '../../interpreter/limits';
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { fma } from '../fma';
import {
  addMethod,
  currentRuntime,
  definePackage,
  fn,
  genericFunction,
  namedType,
  nativeFunction,
  typeEntity,
  typeParam,
} from '../native';
import { nilPointerPanic, runtimeErrorPanic } from '../runtimeErrors';
import {
  BASIC,
  funcType,
  type InterfaceType,
  missingMethod,
  type NamedType,
  pointerTo,
  sliceOf,
  type Type,
} from '../types';
import { Cell, type GoArray, GoStruct, Iface, type NativeState, Pointer, Slice, type Value } from '../values';
import { ChaCha8 } from './chacha8';
import { exp, log } from './goMath';
import { RNG_COOKED } from './rngCooked';
import {
  appendBytes,
  BYTES,
  byteSlice,
  bytesOf,
  callFunction,
  callMethod,
  ERROR_TYPE,
  FLOAT64,
  INT,
  receiverStruct,
  spendFor,
  stringPanic,
} from './support';
import { expFloat64, normFloat64 } from './ziggurat';

const MASK64 = (1n << 64n) - 1n;
const MASK63 = (1n << 63n) - 1n;
const INT32_MAX = 2_147_483_647n;

/** math/rand's additive lagged Fibonacci generator (rngSource), transcribed from Go's rng.go. */
class LaggedFibonacci {
  private readonly vec: bigint[] = Array.from({ length: 607 }, () => 0n);
  private tap = 0;
  private feed = 607 - 273;

  constructor(seed?: bigint) {
    if (seed !== undefined) this.seed(seed);
  }

  clone(): LaggedFibonacci {
    const copy = new LaggedFibonacci();
    for (let index = 0; index < this.vec.length; index++) copy.vec[index] = this.vec[index];
    copy.tap = this.tap;
    copy.feed = this.feed;
    return copy;
  }

  seed(seedValue: bigint): void {
    this.tap = 0;
    this.feed = 607 - 273;
    let seed = seedValue % INT32_MAX;
    if (seed < 0n) seed += INT32_MAX;
    if (seed === 0n) seed = 89_482_311n;
    let x = Number(seed);
    for (let i = -20; i < 607; i++) {
      x = seedrand(x);
      if (i >= 0) {
        let u = BigInt(x) << 40n;
        x = seedrand(x);
        u ^= BigInt(x) << 20n;
        x = seedrand(x);
        u ^= BigInt(x);
        u ^= RNG_COOKED[i];
        this.vec[i] = BigInt.asIntN(64, u);
      }
    }
  }

  uint64(): bigint {
    this.tap--;
    if (this.tap < 0) this.tap += 607;
    this.feed--;
    if (this.feed < 0) this.feed += 607;
    const x = BigInt.asIntN(64, this.vec[this.feed] + this.vec[this.tap]);
    this.vec[this.feed] = x;
    return BigInt.asUintN(64, x);
  }

  int63(): bigint {
    return this.uint64() & MASK63;
  }
}

function seedrand(value: number): number {
  const a = 48_271;
  const q = 44_488;
  const r = 3399;
  const hi = Math.trunc(value / q);
  const lo = value % q;
  let x = a * lo - r * hi;
  if (x < 0) x += 2_147_483_647;
  return x;
}

/** The methods of math/rand's Rand, over a source that gives 63 or 64 random bits. */
class RandV1 {
  /** The random bits that Read has drawn but not yet used, and how many bytes of them remain. */
  private readVal = 0n;
  private readPos = 0;

  constructor(
    private readonly int63Source: () => bigint,
    private readonly uint64Source: (() => bigint) | undefined,
    private readonly seedSource: (seed: bigint) => void
  ) {}

  clone(): RandV1 {
    const copy = new RandV1(this.int63Source, this.uint64Source, this.seedSource);
    copy.readVal = this.readVal;
    copy.readPos = this.readPos;
    return copy;
  }

  seed(seed: bigint): void {
    this.seedSource(seed);
    this.readPos = 0;
  }

  read(bytes: Slice | undefined): bigint {
    const length = bytes?.length ?? 0;
    spendFor(length);
    for (let n = 0; n < length; n++) {
      if (this.readPos === 0) {
        this.readVal = this.int63();
        this.readPos = 7;
      }
      bytes?.set(n, this.readVal & 0xffn);
      this.readVal >>= 8n;
      this.readPos--;
    }
    return BigInt(length);
  }

  normFloat64(): number {
    return normFloat64(
      () => {
        const j = Number(BigInt.asIntN(32, this.uint32()));
        return { j, i: j & 0x7f };
      },
      () => this.float64()
    );
  }

  expFloat64(): number {
    return expFloat64(
      () => {
        const j = Number(this.uint32());
        return { j, i: j & 0xff };
      },
      () => this.float64()
    );
  }

  int63(): bigint {
    return this.int63Source();
  }

  uint32(): bigint {
    return BigInt.asUintN(32, this.int63() >> 31n);
  }

  uint64(): bigint {
    if (this.uint64Source) return this.uint64Source();
    return ((this.int63() >> 31n) | (this.int63() << 32n)) & MASK64;
  }

  int31(): bigint {
    return this.int63() >> 32n;
  }

  int(): bigint {
    return this.int63();
  }

  int63n(n: bigint): bigint {
    if (n <= 0n) stringPanic('invalid argument to Int63n');
    if ((n & (n - 1n)) === 0n) return this.int63() & (n - 1n);
    const max = MASK63 - ((1n << 63n) % n);
    let v = this.int63();
    while (v > max) v = this.int63();
    return v % n;
  }

  int31n(n: bigint): bigint {
    if (n <= 0n) stringPanic('invalid argument to Int31n');
    if ((n & (n - 1n)) === 0n) return this.int31() & (n - 1n);
    const max = INT32_MAX - ((1n << 31n) % n);
    let v = this.int31();
    while (v > max) v = this.int31();
    return v % n;
  }

  /** Lemire's method, which Shuffle uses. */
  int31nLemire(n: bigint): bigint {
    let v = this.uint32();
    let product = v * n;
    let low = product & 0xff_ff_ff_ffn;
    if (low < n) {
      const threshold = BigInt.asUintN(32, -n) % n;
      while (low < threshold) {
        v = this.uint32();
        product = v * n;
        low = product & 0xff_ff_ff_ffn;
      }
    }
    return product >> 32n;
  }

  intn(n: bigint): bigint {
    if (n <= 0n) stringPanic('invalid argument to Intn');
    if (n <= INT32_MAX) return this.int31n(n);
    return this.int63n(n);
  }

  float64(): number {
    for (;;) {
      const f = Number(this.int63()) / 2 ** 63;
      if (f !== 1) return f;
    }
  }

  float32(): number {
    for (;;) {
      const f = Math.fround(this.float64());
      if (f !== 1) return f;
    }
  }

  perm(n: bigint): Slice {
    if (n < 0n) stringPanic('invalid argument to Intn');
    const runtime = currentRuntime();
    if (n > BigInt(LIMITS.maxSlots)) runtime.allocate(LIMITS.maxSlots + 1);
    const count = Number(n);
    runtime.allocate(count);
    spendFor(count);
    const values: bigint[] = Array.from({ length: count }, () => 0n);
    for (let i = 0; i < count; i++) {
      runtime.spend();
      const j = Number(this.intn(BigInt(i + 1)));
      values[i] = values[j];
      values[j] = BigInt(i);
    }
    return new Slice(values, 0, count, count);
  }

  shuffle(n: bigint, swap: Value): void {
    if (n < 0n) stringPanic('invalid argument to Shuffle');
    const runtime = currentRuntime();
    for (let i = n - 1n; i > 0n; i--) {
      runtime.spend();
      const j = this.int31nLemire(i + 1n);
      callFunction(swap, [i, j]);
    }
  }
}

const SOURCE = namedType('rand', 'Source', {
  kind: 'interface',
  methods: [
    { name: 'Int63', type: fn([], [BASIC.int64]) },
    { name: 'Seed', type: fn([BASIC.int64], []) },
  ],
});

const RNG_SOURCE = namedType('rand', 'rngSource', { kind: 'struct', fields: [] });

function createSourceState(source: LaggedFibonacci): NativeState {
  const state: NativeState = {
    source,
    clone: () => createSourceState(source.clone()),
  };
  return state;
}

const sourceOf = (receiver: Value): LaggedFibonacci => {
  const struct = receiverStruct(receiver);
  struct.native ??= createSourceState(new LaggedFibonacci());
  return struct.native.source as LaggedFibonacci;
};
addMethod(RNG_SOURCE, 'Int63', fn([], [BASIC.int64]), (receiver) => sourceOf(receiver).int63(), true);
addMethod(RNG_SOURCE, 'Uint64', fn([], [BASIC.uint64]), (receiver) => sourceOf(receiver).uint64(), true);
addMethod(
  RNG_SOURCE,
  'Seed',
  fn([BASIC.int64], []),
  (receiver, [seed]) => {
    sourceOf(receiver).seed(seed as bigint);
    return;
  },
  true
);

const RAND_V1 = namedType('rand', 'Rand', { kind: 'struct', fields: [] });

function randV1State(rand: RandV1): NativeState {
  const state: NativeState = { rand, clone: () => randV1State(rand.clone()) };
  return state;
}

function randV1Of(receiver: Value): RandV1 {
  const struct = receiverStruct(receiver);
  struct.native ??= randV1State(new RandV1(nilPointerPanic, undefined, nilPointerPanic));
  return struct.native.rand as RandV1;
}

type RandV1Method = (rand: RandV1, args: Value[]) => Value | Value[];

/** Defines the methods of a Rand type and the package functions that use the default generator. */
function defineV1Methods(type: NamedType, of: (receiver: Value) => RandV1): Record<string, RandV1Method> {
  const methods: Record<string, [Parameters<typeof fn>, RandV1Method]> = {
    Int63: [[[], [BASIC.int64]], (rand) => rand.int63()],
    Uint32: [[[], [BASIC.uint32]], (rand) => rand.uint32()],
    Uint64: [[[], [BASIC.uint64]], (rand) => rand.uint64()],
    Int31: [[[], [BASIC.int32]], (rand) => rand.int31()],
    Int: [[[], [INT]], (rand) => rand.int()],
    Int63n: [[[BASIC.int64], [BASIC.int64]], (rand, [n]) => rand.int63n(n as bigint)],
    Int31n: [[[BASIC.int32], [BASIC.int32]], (rand, [n]) => rand.int31n(n as bigint)],
    Intn: [[[INT], [INT]], (rand, [n]) => rand.intn(n as bigint)],
    Float64: [[[], [FLOAT64]], (rand) => rand.float64()],
    Float32: [[[], [BASIC.float32]], (rand) => rand.float32()],
    NormFloat64: [[[], [FLOAT64]], (rand) => rand.normFloat64()],
    ExpFloat64: [[[], [FLOAT64]], (rand) => rand.expFloat64()],
    Perm: [[[INT], [sliceOf(INT)]], (rand, [n]) => rand.perm(n as bigint)],
    Shuffle: [[[INT, funcType([INT, INT], [])], []], (rand, [n, swap]) => (rand.shuffle(n as bigint, swap), undefined)],
    Read: [[[BYTES], [INT, ERROR_TYPE]], (rand, [bytes]) => [rand.read(bytes as Slice | undefined), undefined]],
  };
  const impls: Record<string, RandV1Method> = {};
  for (const [name, [signature, impl]] of Object.entries(methods)) {
    addMethod(type, name, fn(...signature), (receiver, args) => impl(of(receiver), args), true);
    impls[name] = impl;
  }
  return impls;
}

const v1Methods = defineV1Methods(RAND_V1, randV1Of);
addMethod(
  RAND_V1,
  'Seed',
  fn([BASIC.int64], []),
  (receiver, [seed]) => {
    randV1Of(receiver).seed(seed as bigint);
    return;
  },
  true
);

/** The generator of the package functions, which Go seeds randomly. */
function defaultV1(): RandV1 {
  const runtime = currentRuntime() as { randV1?: RandV1 };
  runtime.randV1 ??= new RandV1(
    () => BigInt.asUintN(63, randomBits()),
    randomBits,
    () => {}
  );
  return runtime.randV1;
}

function randomBits(): bigint {
  const high = BigInt(Math.floor(Math.random() * 2 ** 32));
  const low = BigInt(Math.floor(Math.random() * 2 ** 32));
  return (high << 32n) | low;
}

/** `rand.New`: a Rand over the source, which uses the source's Uint64 when it has one, as Go's Source64 check does. */
function newRandV1(source: Value): RandV1 {
  const iface = source as Iface | undefined;
  const native = iface?.value instanceof Pointer ? (iface.value.load() as GoStruct).native?.source : undefined;
  if (native instanceof LaggedFibonacci) {
    return new RandV1(
      () => native.int63(),
      () => native.uint64(),
      (seed) => native.seed(seed)
    );
  }
  const hasUint64 = iface !== undefined && !missingMethod(iface.type, SOURCE64.underlying as InterfaceType);
  return new RandV1(
    () => callMethod(source, 'Int63') as bigint,
    hasUint64 ? () => callMethod(source, 'Uint64') as bigint : undefined,
    (seed) => callMethod(source, 'Seed', [seed])
  );
}

const SOURCE64 = namedType('rand', 'Source64', {
  kind: 'interface',
  methods: [...(SOURCE.underlying as InterfaceType).methods, { name: 'Uint64', type: fn([], [BASIC.uint64]) }],
});

const v1Members: Record<string, Entity> = {
  Source: typeEntity(SOURCE),
  Source64: typeEntity(SOURCE64),
  Rand: typeEntity(RAND_V1),
  NewSource: nativeFunction(
    'NewSource',
    fn([BASIC.int64], [SOURCE]),
    ([seed]) =>
      new Iface(
        pointerTo(RNG_SOURCE),
        new Pointer(new Cell(new GoStruct([], createSourceState(new LaggedFibonacci(seed as bigint)))), 'v')
      )
  ),
  New: nativeFunction(
    'New',
    fn([SOURCE], [pointerTo(RAND_V1)]),
    ([source]) => new Pointer(new Cell(new GoStruct([], randV1State(newRandV1(source)))), 'v')
  ),
  // Since Go 1.24, Seed has no effect on the package functions.
  Seed: nativeFunction('Seed', fn([BASIC.int64], []), () => {}),
};
for (const [name, impl] of Object.entries(v1Methods)) {
  const method = RAND_V1.methods.find((candidate) => candidate.name === name);
  if (method) v1Members[name] = nativeFunction(name, method.type, (args) => impl(defaultV1(), args));
}

/** The Zipf distribution of zipf.go, which math/rand and math/rand/v2 share, drawing uniform values from `float64`. */
class Zipf {
  private readonly imax: number;
  private readonly oneminusQ: number;
  private readonly oneminusQinv: number;
  private readonly hxm: number;
  private readonly hx0minusHxm: number;
  private readonly s: number;

  constructor(
    private readonly float64: () => number,
    private readonly q: number,
    private readonly v: number,
    imax: bigint
  ) {
    this.imax = Number(imax);
    this.oneminusQ = 1 - q;
    this.oneminusQinv = 1 / this.oneminusQ;
    this.hxm = this.h(this.imax + 0.5);
    this.hx0minusHxm = this.h(0.5) - exp(log(v) * -q) - this.hxm;
    this.s = 1 - this.hinv(this.h(1.5) - exp(-q * log(v + 1)));
  }

  private h(x: number): number {
    return exp(this.oneminusQ * log(this.v + x)) * this.oneminusQinv;
  }

  private hinv(x: number): number {
    return exp(this.oneminusQinv * log(this.oneminusQ * x)) - this.v;
  }

  uint64(): bigint {
    const runtime = currentRuntime();
    let k = 0;
    for (;;) {
      runtime.spend();
      const r = this.float64();
      const ur = fma(r, this.hx0minusHxm, this.hxm);
      const x = this.hinv(ur);
      k = Math.floor(x + 0.5);
      if (k - x <= this.s) break;
      if (ur >= this.h(k + 0.5) - exp(-log(k + this.v) * this.q)) break;
    }
    // arm64 converts with FCVTZU, which saturates out-of-range values and gives 0 for NaN.
    if (Number.isNaN(k) || k < 0) return 0n;
    return k >= 2 ** 64 ? (1n << 64n) - 1n : BigInt(k);
  }
}

function zipfType(rand: NamedType, float64Of: (rand: Value) => number): Record<string, Entity> {
  const type = namedType('rand', 'Zipf', { kind: 'struct', fields: [] });
  addMethod(
    type,
    'Uint64',
    fn([], [BASIC.uint64]),
    (receiver) => {
      if (!(receiver instanceof Pointer)) stringPanic('rand: nil Zipf');
      const zipf = (receiver.load() as GoStruct).native?.zipf as Zipf | undefined;
      // A zero Zipf has no generator, which Go dereferences as nil.
      if (!zipf) nilPointerPanic();
      return zipf.uint64();
    },
    true
  );
  const newZipf = nativeFunction(
    'NewZipf',
    fn([pointerTo(rand), FLOAT64, FLOAT64, BASIC.uint64], [pointerTo(type)]),
    ([randPointer, s, v, imax]) => {
      if ((s as number) <= 1 || (v as number) < 1) return;
      const zipf = new Zipf(() => float64Of(randPointer), s as number, v as number, imax as bigint);
      return new Pointer(new Cell(new GoStruct([], { zipf })), 'v');
    }
  );
  return { Zipf: typeEntity(type), NewZipf: newZipf };
}

Object.assign(
  v1Members,
  zipfType(RAND_V1, (rand) => randV1Of(rand).float64())
);

export const RAND_PACKAGE = definePackage('math/rand', v1Members);

// math/rand/v2 ----------------------------------------------------------------------------------------------------

/** math/rand/v2's PCG step, transcribed from Go's pcg.go, over the `hi` and `lo` fields of a PCG struct. */
function pcgUint64(pcg: GoStruct): bigint {
  const mulHi = 2_549_297_995_355_413_924n;
  const mulLo = 4_865_540_595_714_422_341n;
  const incHi = 6_364_136_223_846_793_005n;
  const incLo = 1_442_695_040_888_963_407n;
  const state = ((pcg.fields[0] as bigint) << 64n) | (pcg.fields[1] as bigint);
  const multiplier = (mulHi << 64n) | mulLo;
  const increment = (incHi << 64n) | incLo;
  const next = BigInt.asUintN(128, state * multiplier + increment);
  const lo = next & MASK64;
  let hi = next >> 64n;
  pcg.fields[0] = hi;
  pcg.fields[1] = lo;
  const cheapMul = 0xda_94_20_42_e4_dd_58_b5n;
  hi ^= hi >> 32n;
  hi = (hi * cheapMul) & MASK64;
  hi ^= hi >> 48n;
  hi = (hi * (lo | 1n)) & MASK64;
  return hi;
}

class RandV2 {
  constructor(private readonly source: () => bigint) {}

  uint64(): bigint {
    return this.source();
  }

  uint64n(n: bigint): bigint {
    if ((n & (n - 1n)) === 0n) return this.uint64() & (n - 1n);
    let product = this.uint64() * n;
    let lo = product & MASK64;
    if (lo < n) {
      const threshold = BigInt.asUintN(64, -n) % n;
      while (lo < threshold) {
        product = this.uint64() * n;
        lo = product & MASK64;
      }
    }
    return product >> 64n;
  }

  float64(): number {
    return Number(this.uint64() & ((1n << 53n) - 1n)) / 2 ** 53;
  }

  normFloat64(): number {
    return normFloat64(
      () => {
        const u = this.uint64();
        return { j: Number(BigInt.asIntN(32, u)), i: Number((u >> 32n) & 0x7fn) };
      },
      () => this.float64()
    );
  }

  expFloat64(): number {
    return expFloat64(
      () => {
        const u = this.uint64();
        return { j: Number(BigInt.asUintN(32, u)), i: Number((u >> 32n) & 0xffn) };
      },
      () => this.float64()
    );
  }

  shuffle(n: bigint, swap: Value): void {
    if (n < 0n) stringPanic('invalid argument to Shuffle');
    const runtime = currentRuntime();
    for (let i = n - 1n; i > 0n; i--) {
      runtime.spend();
      callFunction(swap, [i, this.uint64n(i + 1n)]);
    }
  }
}

const SOURCE_V2 = namedType('rand', 'Source', {
  kind: 'interface',
  methods: [{ name: 'Uint64', type: fn([], [BASIC.uint64]) }],
});

const PCG = namedType('rand', 'PCG', {
  kind: 'struct',
  fields: [
    { name: 'hi', type: BASIC.uint64, embedded: false },
    { name: 'lo', type: BASIC.uint64, embedded: false },
  ],
});
const PCG_ENCODING_ERROR = newError('invalid PCG encoding');

function bigEndian(value: bigint): string {
  let bytes = '';
  for (let shift = 56n; shift >= 0n; shift -= 8n) bytes += String.fromCharCode(Number((value >> shift) & 0xffn));
  return bytes;
}

const pcgBinary = (pcg: GoStruct): string =>
  `pcg:${bigEndian(pcg.fields[0] as bigint)}${bigEndian(pcg.fields[1] as bigint)}`;

/** Defines MarshalBinary, AppendBinary, and UnmarshalBinary of a generator type from its encoding. */
function defineBinaryMethods(
  type: NamedType,
  encode: (receiver: Value) => string,
  decode: (receiver: Value, data: string) => Value
): void {
  addMethod(
    type,
    'MarshalBinary',
    fn([], [BYTES, ERROR_TYPE]),
    (receiver) => [byteSlice(encode(receiver)), undefined],
    true
  );
  addMethod(
    type,
    'AppendBinary',
    fn([BYTES], [BYTES, ERROR_TYPE]),
    (receiver, [bytes]) => [appendBytes(bytes, encode(receiver)), undefined],
    true
  );
  addMethod(
    type,
    'UnmarshalBinary',
    fn([BYTES], [ERROR_TYPE]),
    (receiver, [data]) => decode(receiver, bytesOf(data)),
    true
  );
}

addMethod(PCG, 'Uint64', fn([], [BASIC.uint64]), (receiver) => pcgUint64(receiverStruct(receiver)), true);
addMethod(
  PCG,
  'Seed',
  fn([BASIC.uint64, BASIC.uint64], []),
  (receiver, [hi, lo]) => {
    const pcg = receiverStruct(receiver);
    pcg.fields[0] = hi;
    pcg.fields[1] = lo;
    return;
  },
  true
);
defineBinaryMethods(
  PCG,
  (receiver) => pcgBinary(receiverStruct(receiver)),
  (receiver, data) => {
    const pcg = receiverStruct(receiver);
    if (data.length !== 20 || !data.startsWith('pcg:')) return PCG_ENCODING_ERROR;
    const word = (from: number): bigint =>
      Array.from({ length: 8 }, (_, index) => data.charCodeAt(from + index)).reduce(
        (value, byte) => (value << 8n) | BigInt(byte),
        0n
      );
    pcg.fields[0] = word(4);
    pcg.fields[1] = word(12);
    return;
  }
);

const CHACHA8 = namedType('rand', 'ChaCha8', { kind: 'struct', fields: [] });
const SEED_ARRAY: Type = { kind: 'array', element: BASIC.uint8, length: 32 };

const isPointerTo = (iface: Iface | undefined, type: NamedType): boolean =>
  iface?.type.kind === 'pointer' && iface.type.element === type;

/** `*chacha8rand.errUnmarshalChaCha8`, the error of a malformed ChaCha8 state. */
const CHACHA8_ENCODING_ERROR = namedType('chacha8rand', 'errUnmarshalChaCha8', { kind: 'struct', fields: [] });
addMethod(CHACHA8_ENCODING_ERROR, 'Error', fn([], [BASIC.string]), () => 'invalid ChaCha8 encoding', true);

function chaCha8State(chacha: ChaCha8): NativeState {
  const state: NativeState = { chacha, clone: () => chaCha8State(chacha.clone()) };
  return state;
}

/** The generator of a ChaCha8 value; the zero value draws from a zero seed past its first block, as Go's does. */
function chaCha8Of(receiver: Value): ChaCha8 {
  const struct = receiverStruct(receiver);
  struct.native ??= chaCha8State(new ChaCha8());
  return struct.native.chacha as ChaCha8;
}

const seedBytes = (seed: Value): string =>
  (seed as GoArray).elements.map((byte) => String.fromCharCode(Number(byte as bigint))).join('');

addMethod(CHACHA8, 'Uint64', fn([], [BASIC.uint64]), (receiver) => chaCha8Of(receiver).uint64(), true);
addMethod(
  CHACHA8,
  'Seed',
  fn([SEED_ARRAY], []),
  (receiver, [seed]) => {
    chaCha8Of(receiver).seed(seedBytes(seed));
    return;
  },
  true
);
addMethod(
  CHACHA8,
  'Read',
  fn([BYTES], [INT, ERROR_TYPE]),
  (receiver, [bytes]) => {
    const slice = bytes as Slice | undefined;
    const length = slice?.length ?? 0;
    spendFor(length);
    const read = chaCha8Of(receiver).read(length);
    for (let index = 0; index < length; index++) slice?.set(index, BigInt(read.charCodeAt(index)));
    return [BigInt(length), undefined];
  },
  true
);
defineBinaryMethods(
  CHACHA8,
  (receiver) => chaCha8Of(receiver).appendBinary(),
  (receiver, data) => {
    const error = chaCha8Of(receiver).unmarshalBinary(data);
    if (error === undefined) return;
    if (error === 'invalid ChaCha8 encoding') {
      return new Iface(pointerTo(CHACHA8_ENCODING_ERROR), new Pointer(new Cell(new GoStruct([])), 'v'));
    }
    return newError(error);
  }
);

const RAND_V2 = namedType('rand', 'Rand', { kind: 'struct', fields: [] });
// N is a generic method, which Go 1.27 allows but library types here cannot define.
RAND_V2.unsupported = new Set(['N']);
const randV2Of = (receiver: Value): RandV2 => {
  const struct = receiverStruct(receiver);
  struct.native ??= { rand: new RandV2(() => nilPointerPanic()) };
  return struct.native.rand as RandV2;
};

function positive(n: bigint, name: string): bigint {
  if (n <= 0n) stringPanic(`invalid argument to ${name}`);
  return n;
}

const v2Methods: Record<string, [Parameters<typeof fn>, (rand: RandV2, args: Value[]) => Value]> = {
  Int64: [[[], [BASIC.int64]], (rand) => rand.uint64() & MASK63],
  Uint32: [[[], [BASIC.uint32]], (rand) => rand.uint64() >> 32n],
  Uint64: [[[], [BASIC.uint64]], (rand) => rand.uint64()],
  Int32: [[[], [BASIC.int32]], (rand) => rand.uint64() >> 33n],
  Int: [[[], [INT]], (rand) => rand.uint64() & MASK63],
  Uint: [[[], [BASIC.uint]], (rand) => rand.uint64()],
  Int64N: [[[BASIC.int64], [BASIC.int64]], (rand, [n]) => rand.uint64n(positive(n as bigint, 'Int64N'))],
  Uint64N: [[[BASIC.uint64], [BASIC.uint64]], (rand, [n]) => rand.uint64n(positive(n as bigint, 'Uint64N'))],
  Int32N: [[[BASIC.int32], [BASIC.int32]], (rand, [n]) => rand.uint64n(positive(n as bigint, 'Int32N'))],
  Uint32N: [[[BASIC.uint32], [BASIC.uint32]], (rand, [n]) => rand.uint64n(positive(n as bigint, 'Uint32N'))],
  IntN: [[[INT], [INT]], (rand, [n]) => rand.uint64n(positive(n as bigint, 'IntN'))],
  UintN: [[[BASIC.uint], [BASIC.uint]], (rand, [n]) => rand.uint64n(positive(n as bigint, 'UintN'))],
  Float64: [[[], [FLOAT64]], (rand) => rand.float64()],
  NormFloat64: [[[], [FLOAT64]], (rand) => rand.normFloat64()],
  ExpFloat64: [[[], [FLOAT64]], (rand) => rand.expFloat64()],
  Float32: [[[], [BASIC.float32]], (rand) => Number((rand.uint64() >> 32n) & 0xff_ff_ffn) / 2 ** 24],
  Perm: [
    [[INT], [sliceOf(INT)]],
    (rand, [n]) => {
      const requested = n as bigint;
      if (requested < 0n) runtimeErrorPanic('makeslice: len out of range');
      const runtime = currentRuntime();
      if (requested > BigInt(LIMITS.maxSlots)) runtime.allocate(LIMITS.maxSlots + 1);
      const count = Number(requested);
      runtime.allocate(count);
      spendFor(count);
      const values: Value[] = Array.from({ length: count }, (_, index) => BigInt(index));
      const slice = new Slice(values, 0, count, count);
      for (let i = BigInt(count) - 1n; i > 0n; i--) {
        runtime.spend();
        const j = Number(rand.uint64n(i + 1n));
        const value = values[Number(i)];
        values[Number(i)] = values[j];
        values[j] = value;
      }
      return slice;
    },
  ],
  Shuffle: [[[INT, funcType([INT, INT], [])], []], (rand, [n, swap]) => (rand.shuffle(n as bigint, swap), undefined)],
};

const v2Members: Record<string, Entity> = {
  Source: typeEntity(SOURCE_V2),
  Rand: typeEntity(RAND_V2),
  PCG: typeEntity(PCG),
  ChaCha8: typeEntity(CHACHA8),
  NewPCG: nativeFunction(
    'NewPCG',
    fn([BASIC.uint64, BASIC.uint64], [pointerTo(PCG)]),
    ([hi, lo]) => new Pointer(new Cell(new GoStruct([hi, lo])), 'v')
  ),
  NewChaCha8: nativeFunction(
    'NewChaCha8',
    fn([SEED_ARRAY], [pointerTo(CHACHA8)]),
    ([seed]) => new Pointer(new Cell(new GoStruct([], chaCha8State(new ChaCha8(seedBytes(seed))))), 'v')
  ),
  New: nativeFunction('New', fn([SOURCE_V2], [pointerTo(RAND_V2)]), ([source]) => {
    const iface = source as Iface | undefined;
    const pointer = iface?.value;
    let draw = (): bigint => callMethod(source, 'Uint64') as bigint;
    if (pointer instanceof Pointer && isPointerTo(iface, PCG)) draw = () => pcgUint64(receiverStruct(pointer));
    if (pointer instanceof Pointer && isPointerTo(iface, CHACHA8)) draw = () => chaCha8Of(pointer).uint64();
    return new Pointer(new Cell(new GoStruct([], { rand: new RandV2(draw) })), 'v');
  }),

  N: (() => {
    const integer = typeParam('Int', {
      kind: 'interface',
      methods: [],
      typeSet: {
        terms: [
          BASIC.int,
          BASIC.int8,
          BASIC.int16,
          BASIC.int32,
          BASIC.int64,
          BASIC.uint,
          BASIC.uint8,
          BASIC.uint16,
          BASIC.uint32,
          BASIC.uint64,
          BASIC.uintptr,
        ].map((type) => ({ tilde: true, type })),
      },
    });
    return genericFunction(
      'N',
      [integer],
      funcType([integer], [integer]),
      () =>
        ([n]) =>
          defaultV2().uint64n(positive(n as bigint, 'N'))
    );
  })(),
};
for (const [name, [signature, impl]] of Object.entries(v2Methods)) {
  addMethod(RAND_V2, name, fn(...signature), (receiver, args) => impl(randV2Of(receiver), args), true);
  v2Members[name] = nativeFunction(name, fn(...signature), (args) => impl(defaultV2(), args));
}

function defaultV2(): RandV2 {
  const runtime = currentRuntime() as { randV2?: RandV2 };
  runtime.randV2 ??= new RandV2(randomBits);
  return runtime.randV2;
}

Object.assign(
  v2Members,
  zipfType(RAND_V2, (rand) => randV2Of(rand).float64())
);

export const RAND_V2_PACKAGE = definePackage('math/rand/v2', v2Members, ['ChaCha8', 'NewChaCha8']);
