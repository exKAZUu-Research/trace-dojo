import type { Entity } from '../entities';
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
import { GoPanic } from '../runtime';
import { BASIC, funcType, type NamedType, pointerTo, sliceOf } from '../types';
import { Cell, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { RNG_COOKED } from './rngCooked';
import { callFunction, callMethod, FLOAT64, INT } from './support';

const MASK64 = (1n << 64n) - 1n;
const MASK63 = (1n << 63n) - 1n;
const INT32_MAX = 2_147_483_647n;

function stringPanic(message: string): never {
  throw new GoPanic(new Iface(BASIC.string, message));
}

/** math/rand's additive lagged Fibonacci generator (rngSource), transcribed from Go's rng.go. */
class LaggedFibonacci {
  private readonly vec: bigint[] = Array.from({ length: 607 }, () => 0n);
  private tap = 0;
  private feed = 607 - 273;

  constructor(seed: bigint) {
    this.seed(seed);
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
  constructor(
    private readonly int63Source: () => bigint,
    private readonly uint64Source: (() => bigint) | undefined
  ) {}

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
    const count = Number(n);
    if (count < 0) stringPanic('invalid argument to Intn');
    currentRuntime().allocate(count);
    const values: bigint[] = Array.from({ length: count }, () => 0n);
    for (let i = 0; i < count; i++) {
      const j = Number(this.intn(BigInt(i + 1)));
      values[i] = values[j];
      values[j] = BigInt(i);
    }
    return new Slice(values, 0, count, count);
  }

  shuffle(n: bigint, swap: Value): void {
    if (n < 0n) stringPanic('invalid argument to Shuffle');
    for (let i = n - 1n; i > 0n; i--) {
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
const sourceOf = (receiver: Value): LaggedFibonacci =>
  ((receiver as Pointer).load() as GoStruct).native?.source as LaggedFibonacci;
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
RAND_V1.unsupported = new Set(['NormFloat64', 'ExpFloat64', 'Read']);

function randV1Of(receiver: Value): RandV1 {
  const struct = (receiver as Pointer).load() as GoStruct;
  return struct.native?.rand as RandV1;
}

/** Defines the methods of a Rand type and the package functions that use the default generator. */
function defineV1Methods(
  type: NamedType,
  of: (receiver: Value) => RandV1
): Record<string, (rand: RandV1, args: Value[]) => Value> {
  const methods: Record<string, [Parameters<typeof fn>, (rand: RandV1, args: Value[]) => Value]> = {
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
    Perm: [[[INT], [sliceOf(INT)]], (rand, [n]) => rand.perm(n as bigint)],
    Shuffle: [[[INT, funcType([INT, INT], [])], []], (rand, [n, swap]) => (rand.shuffle(n as bigint, swap), undefined)],
  };
  const impls: Record<string, (rand: RandV1, args: Value[]) => Value> = {};
  for (const [name, [signature, impl]] of Object.entries(methods)) {
    addMethod(type, name, fn(...signature), (receiver, args) => impl(of(receiver), args), true);
    impls[name] = impl;
  }
  return impls;
}

const v1Methods = defineV1Methods(RAND_V1, randV1Of);

/** The generator of the package functions, which Go seeds randomly. */
function defaultV1(): RandV1 {
  const runtime = currentRuntime() as { randV1?: RandV1 };
  runtime.randV1 ??= new RandV1(() => BigInt.asUintN(63, randomBits()), randomBits);
  return runtime.randV1;
}

function randomBits(): bigint {
  const high = BigInt(Math.floor(Math.random() * 2 ** 32));
  const low = BigInt(Math.floor(Math.random() * 2 ** 32));
  return (high << 32n) | low;
}

const v1Members: Record<string, Entity> = {
  Source: typeEntity(SOURCE),
  Rand: typeEntity(RAND_V1),
  NewSource: nativeFunction(
    'NewSource',
    fn([BASIC.int64], [SOURCE]),
    ([seed]) =>
      new Iface(
        pointerTo(RNG_SOURCE),
        new Pointer(new Cell(new GoStruct([], { source: new LaggedFibonacci(seed as bigint) })), 'v')
      )
  ),
  New: nativeFunction('New', fn([SOURCE], [pointerTo(RAND_V1)]), ([source]) => {
    const iface = source as Iface;
    const native = iface.value instanceof Pointer ? (iface.value.load() as GoStruct).native?.source : undefined;
    const rand =
      native instanceof LaggedFibonacci
        ? new RandV1(
            () => native.int63(),
            () => native.uint64()
          )
        : new RandV1(() => callMethod(source, 'Int63') as bigint, undefined);
    return new Pointer(new Cell(new GoStruct([], { rand })), 'v');
  }),
  // Since Go 1.24, Seed has no effect on the package functions.
  Seed: nativeFunction('Seed', fn([BASIC.int64], []), () => {}),
};
for (const [name, impl] of Object.entries(v1Methods)) {
  const method = RAND_V1.methods.find((candidate) => candidate.name === name);
  if (method) v1Members[name] = nativeFunction(name, method.type, (args) => impl(defaultV1(), args));
}

export const RAND_PACKAGE = definePackage('math/rand', v1Members, [
  'NewZipf',
  'Zipf',
  'Read',
  'ExpFloat64',
  'NormFloat64',
  'Source64',
]);

// math/rand/v2 ----------------------------------------------------------------------------------------------------

/** math/rand/v2's PCG, transcribed from Go's pcg.go. */
class Pcg {
  constructor(
    public hi: bigint,
    public lo: bigint
  ) {}

  uint64(): bigint {
    const mulHi = 2_549_297_995_355_413_924n;
    const mulLo = 4_865_540_595_714_422_341n;
    const incHi = 6_364_136_223_846_793_005n;
    const incLo = 1_442_695_040_888_963_407n;
    const state = (this.hi << 64n) | this.lo;
    const multiplier = (mulHi << 64n) | mulLo;
    const increment = (incHi << 64n) | incLo;
    const next = BigInt.asUintN(128, state * multiplier + increment);
    this.hi = next >> 64n;
    this.lo = next & MASK64;
    let hi = this.hi;
    const cheapMul = 0xda_94_20_42_e4_dd_58_b5n;
    hi ^= hi >> 32n;
    hi = (hi * cheapMul) & MASK64;
    hi ^= hi >> 48n;
    hi = (hi * (this.lo | 1n)) & MASK64;
    return hi;
  }
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

  shuffle(n: bigint, swap: Value): void {
    if (n < 0n) stringPanic('invalid argument to Shuffle');
    for (let i = n - 1n; i > 0n; i--) callFunction(swap, [i, this.uint64n(i + 1n)]);
  }
}

const SOURCE_V2 = namedType('rand', 'Source', {
  kind: 'interface',
  methods: [{ name: 'Uint64', type: fn([], [BASIC.uint64]) }],
});
const PCG = namedType('rand', 'PCG', { kind: 'struct', fields: [] });
const pcgOf = (receiver: Value): Pcg => ((receiver as Pointer).load() as GoStruct).native?.pcg as Pcg;
addMethod(PCG, 'Uint64', fn([], [BASIC.uint64]), (receiver) => pcgOf(receiver).uint64(), true);
addMethod(
  PCG,
  'Seed',
  fn([BASIC.uint64, BASIC.uint64], []),
  (receiver, [hi, lo]) => {
    const pcg = pcgOf(receiver);
    pcg.hi = hi as bigint;
    pcg.lo = lo as bigint;
    return;
  },
  true
);

const RAND_V2 = namedType('rand', 'Rand', { kind: 'struct', fields: [] });
RAND_V2.unsupported = new Set(['NormFloat64', 'ExpFloat64', 'N']);
const randV2Of = (receiver: Value): RandV2 => ((receiver as Pointer).load() as GoStruct).native?.rand as RandV2;

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
  Float32: [[[], [BASIC.float32]], (rand) => Number((rand.uint64() >> 32n) & 0xff_ff_ffn) / 2 ** 24],
  Perm: [
    [[INT], [sliceOf(INT)]],
    (rand, [n]) => {
      const count = Number(n as bigint);
      const values: Value[] = Array.from({ length: count }, (_, index) => BigInt(index));
      currentRuntime().allocate(count);
      const slice = new Slice(values, 0, count, count);
      for (let i = BigInt(count) - 1n; i > 0n; i--) {
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
  NewPCG: nativeFunction(
    'NewPCG',
    fn([BASIC.uint64, BASIC.uint64], [pointerTo(PCG)]),
    ([hi, lo]) => new Pointer(new Cell(new GoStruct([], { pcg: new Pcg(hi as bigint, lo as bigint) })), 'v')
  ),
  New: nativeFunction('New', fn([SOURCE_V2], [pointerTo(RAND_V2)]), ([source]) => {
    const iface = source as Iface;
    const native = iface.value instanceof Pointer ? (iface.value.load() as GoStruct).native?.pcg : undefined;
    const rand =
      native instanceof Pcg
        ? new RandV2(() => native.uint64())
        : new RandV2(() => callMethod(source, 'Uint64') as bigint);
    return new Pointer(new Cell(new GoStruct([], { rand })), 'v');
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

export const RAND_V2_PACKAGE = definePackage('math/rand/v2', v2Members, [
  'ChaCha8',
  'NewChaCha8',
  'Zipf',
  'NewZipf',
  'ExpFloat64',
  'NormFloat64',
]);
