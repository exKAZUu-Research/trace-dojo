import { fma } from '../../c/library/binaryFloat';
import { CppRuntimeError } from '../errors';
import type { Expr } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import {
  ClassInfo,
  classType,
  DOUBLE,
  INT,
  intMax,
  isConstType,
  isInteger,
  isSigned,
  isWide,
  sizeOf,
  type Type,
  typeName,
  UINT,
  ULLONG,
  unqualified,
  VOID,
} from '../types';
import { type Ptr, Store, type Value } from '../values';
import type { Library, LibraryTemplate } from './registry';
import { addMethod, native, nativeConstructor } from './support';
import { typeKey } from './templates';

interface EngineParameters {
  w: number;
  n: number;
  m: number;
  r: number;
  a: bigint;
  u: number;
  d: bigint;
  s: number;
  b: bigint;
  t: number;
  c: bigint;
  l: number;
  f: bigint;
}

const MT19937: EngineParameters = {
  w: 32,
  n: 624,
  m: 397,
  r: 31,
  a: 0x99_08_b0_dfn,
  u: 11,
  d: 0xff_ff_ff_ffn,
  s: 7,
  b: 0x9d_2c_56_80n,
  t: 15,
  c: 0xef_c6_00_00n,
  l: 18,
  f: 1_812_433_253n,
};

const MT19937_64: EngineParameters = {
  w: 64,
  n: 312,
  m: 156,
  r: 31,
  a: 0xb5_02_6f_5a_a9_66_19_e9n,
  u: 29,
  d: 0x55_55_55_55_55_55_55_55n,
  s: 17,
  b: 0x71_d6_7f_ff_ed_a6_00_00n,
  t: 37,
  c: 0xff_f7_ee_e0_00_00_00_00n,
  l: 43,
  f: 6_364_136_223_846_793_005n,
};

/** A random number engine: a Mersenne Twister, or `std::random_device`. */
export class EngineValue extends Store {
  private state: bigint[] = [];
  private index = 0;

  constructor(
    readonly parameters: EngineParameters | undefined,
    seed = 5489n
  ) {
    super();
    if (parameters) this.seed(seed);
  }

  get length(): number {
    return 1;
  }

  get(): Value {
    return this;
  }

  set(): void {
    throw new Error('An engine is assigned by its operations');
  }

  get bits(): number {
    return this.parameters?.w ?? 32;
  }

  seed(value: bigint): void {
    const { w, n, f } = this.parameters as EngineParameters;
    const mask = (1n << BigInt(w)) - 1n;
    this.state = [BigInt.asUintN(w, value)];
    for (let i = 1; i < n; i++) {
      const previous = this.state[i - 1];
      this.state.push((f * (previous ^ (previous >> BigInt(w - 2))) + BigInt(i)) & mask);
    }
    this.index = 0;
  }

  copyFrom(other: EngineValue): void {
    this.state = [...other.state];
    this.index = other.index;
  }

  next(): bigint {
    const parameters = this.parameters;
    if (!parameters) return BigInt(Math.floor(Math.random() * 2 ** 32));
    const { w, n, m, r, a, u, d, s, b, t, c, l } = parameters;
    const mask = (1n << BigInt(w)) - 1n;
    const lower = (1n << BigInt(r)) - 1n;
    const state = this.state;
    const i = this.index;
    const j = (i + 1) % n;
    const y = (state[i] & ~lower & mask) | (state[j] & lower);
    const k = (i + m) % n;
    state[i] = state[k] ^ (y >> 1n) ^ (y & 1n ? a : 0n);
    let z = state[i] ^ ((state[i] >> BigInt(u)) & d);
    this.index = j;
    z ^= (z << BigInt(s)) & b & mask;
    z ^= (z << BigInt(t)) & c & mask;
    return z ^ (z >> BigInt(l));
  }
}

/**
 * libc++'s `__independent_bits_engine`, which takes `bits` random bits from an engine of `engineBits` bits, giving them
 * as an unsigned integer of `resultBits` bits.
 */
function independentBits(engine: EngineValue, bits: number, resultBits: number): bigint {
  const engineBits = engine.bits;
  const workingBits = Math.max(engineBits, resultBits);
  const workingMask = (1n << BigInt(workingBits)) - 1n;
  const range = ((1n << BigInt(engineBits)) - 1n + 1n) & workingMask;
  const m = range === 0n ? workingBits : log2(range);
  let n = Math.floor(bits / m) + (bits % m === 0 ? 0 : 1);
  let w0 = Math.floor(bits / n);
  const shiftedRange = (shift: number): bigint =>
    shift < workingBits ? ((range >> BigInt(shift)) << BigInt(shift)) & workingMask : 0n;
  let y0 = range === 0n ? 0n : shiftedRange(w0);
  if (range !== 0n && ((range - y0) & workingMask) > y0 / BigInt(n)) {
    n++;
    w0 = Math.floor(bits / n);
    y0 = shiftedRange(w0);
  }
  const n0 = n - (bits % n);
  const y1 = w0 < workingBits - 1 ? shiftedRange(w0 + 1) : 0n;
  const engineMask = (1n << BigInt(engineBits)) - 1n;
  const mask0 = w0 > 0 ? engineMask >> BigInt(engineBits - w0) : 0n;
  const mask1 = w0 < engineBits - 1 ? engineMask >> BigInt(engineBits - (w0 + 1)) : engineMask;
  if (range === 0n) return engine.next() & mask0;
  const resultMask = (1n << BigInt(resultBits)) - 1n;
  let sum = 0n;
  for (let k = 0; k < n0; k++) {
    let value: bigint;
    do value = engine.next();
    while (value >= y0);
    sum = w0 < resultBits ? (sum << BigInt(w0)) & resultMask : 0n;
    sum = (sum + (value & mask0)) & resultMask;
  }
  for (let k = n0; k < n; k++) {
    let value: bigint;
    do value = engine.next();
    while (value >= y1);
    sum = w0 < resultBits - 1 ? (sum << BigInt(w0 + 1)) & resultMask : 0n;
    sum = (sum + (value & mask1)) & resultMask;
  }
  return sum;
}

function log2(value: bigint): number {
  return value.toString(2).length - 1;
}

/** `std::uniform_int_distribution`'s draw of an integer in [a, b], as libc++ draws it. */
export function uniformInteger(engine: EngineValue, a: bigint, b: bigint, resultBits: number): bigint {
  const bits = resultBits <= 32 ? 32 : 64;
  const mask = (1n << BigInt(bits)) - 1n;
  const range = (BigInt.asUintN(bits, b) - BigInt.asUintN(bits, a) + 1n) & mask;
  if (range === 1n) return a;
  if (range === 0n) return BigInt.asIntN(bits, independentBits(engine, bits, bits));
  let w = log2(range);
  if ((range & (mask >> BigInt(bits - w))) !== 0n) w++;
  let value: bigint;
  do value = independentBits(engine, w, bits);
  while (value >= range);
  return BigInt.asUintN(bits, value + BigInt.asUintN(bits, a));
}

/** `std::generate_canonical<T, digits>`, a number in [0, 1) from enough engine calls for the type's digits. */
function canonical(engine: EngineValue, digits: number, isFloat: boolean): number {
  const round = isFloat ? Math.fround : (value: number): number => value;
  const logR = engine.bits;
  const k = Math.max(1, Math.floor(digits / logR) + (digits % logR === 0 ? 0 : 1));
  const rp = 2 ** logR;
  let base = rp;
  let sum = round(Number(engine.next()));
  // libc++ computes in the result type, and clang fuses `sum += value * base` into one rounding.
  for (let i = 1; i < k; i++, base *= rp) sum = fma(round(Number(engine.next())), base, sum, isFloat);
  return round(sum / base);
}

/** The engines of `<random>`, by name: `std::mt19937`, `std::mt19937_64`, and `std::random_device`. */
export function randomEngines(): Map<string, ClassInfo> {
  const engines = new Map<string, ClassInfo>();
  for (const [name, parameters, resultType] of [
    ['mt19937', MT19937, UINT],
    ['mt19937_64', MT19937_64, ULLONG],
    ['random_device', undefined, UINT],
  ] as const) {
    const cls = new ClassInfo(`std::${name}`, 'class');
    cls.isComplete = true;
    cls.memberTypes.set('result_type', resultType);
    const toResult = (value: bigint): Value => (resultType === UINT ? Number(value) : value);
    cls.library = {
      kind: 'engine',
      args: [],
      size: parameters ? parameters.n * (parameters.w / 8) + 8 : 4,
      align: 8,
      call: (compiler, object, args, row) => {
        if (args.length > 0) return;
        if (isConstType(object.type)) return compiler.error(row, `const の ${cls.name} には () を使えません。`);
        const engine = compiler.objectOf(object);
        return {
          type: resultType,
          isLvalue: false,
          row,
          run: (frame) => toResult(((engine(frame) as Ptr).read() as EngineValue).next()),
        };
      },
    };
    cls.operations = {
      copy: (_frame, source) => {
        const engine = new EngineValue(parameters);
        engine.copyFrom(source as EngineValue);
        return engine;
      },
      assign: (_frame, target, source) => (target as EngineValue).copyFrom(source as EngineValue),
    };
    if (parameters) {
      cls.constructors = [
        nativeConstructor(cls, [], () => new EngineValue(parameters)),
        nativeConstructor(cls, [resultType], ([seed]) => new EngineValue(parameters, BigInt(seed as number | bigint)), {
          isExplicit: true,
        }),
      ];
      addMethod(
        cls,
        native(
          'seed',
          [resultType],
          VOID,
          ([seed], { self }) =>
            (self as EngineValue).seed(seed === undefined ? 5489n : BigInt(seed as number | bigint)),
          { optional: 1 }
        )
      );
      addMethod(
        cls,
        native('discard', [ULLONG], VOID, ([count], { frame, self }) => {
          for (let remaining = count as bigint; remaining > 0n; remaining--) {
            frame.runtime.spend();
            (self as EngineValue).next();
          }
        })
      );
      const max = (1n << BigInt(parameters.w)) - 1n;
      for (const [method, value] of [
        ['min', 0n],
        ['max', max],
      ] as const) {
        addMethod(cls, { ...native(method, [], resultType, () => toResult(value)), isStatic: true });
      }
    } else {
      cls.isNoncopyable = true;
      cls.constructors = [nativeConstructor(cls, [], () => new EngineValue(undefined))];
      addMethod(cls, { ...native('min', [], UINT, () => 0), isStatic: true });
      addMethod(cls, { ...native('max', [], UINT, () => 0xff_ff_ff_ff), isStatic: true });
    }
    engines.set(name, cls);
  }
  return engines;
}

/** A distribution's parameters. */
class DistributionValue extends Store {
  constructor(
    public a: Value,
    public b: Value
  ) {
    super();
  }

  get length(): number {
    return 1;
  }

  get(): Value {
    return this;
  }

  set(): void {
    throw new Error('A distribution is assigned by its operations');
  }
}

/** The distribution templates of `<random>`: `std::uniform_int_distribution<T>` and `std::uniform_real_distribution<T>`. */
export function randomClasses(library: Library): LibraryTemplate[] {
  const distribution = (
    kind: 'uniform_int_distribution' | 'uniform_real_distribution',
    argument: Type,
    row: number
  ): Type => {
    const type = unqualified(argument);
    const isIntegral = kind === 'uniform_int_distribution';
    if (isIntegral ? !isInteger(type) || type.name === 'bool' || type.name === 'char' : type.kind !== 'float') {
      return library.compiler.error(row, `std::${kind} のテンプレート引数に ${typeName(type)} は使えません。`);
    }
    const key = `${kind}<${typeKey(type)}>`;
    const cached = library.instances.get(key);
    if (cached) return classType(cached);
    const cls = new ClassInfo(`std::${kind}<${typeName(type)}>`, 'class');
    library.instances.set(key, cls);
    cls.isComplete = true;
    cls.memberTypes.set('result_type', type);
    const wide = type.kind === 'int' && isWide(type);
    const intValue = (value: bigint): number | bigint => (wide ? value : Number(value));
    const resultBits = sizeOf(type) * 8;
    const max = type.kind === 'int' ? intValue(intMax(type.name)) : 1;
    const draw = (engine: EngineValue, a: Value, b: Value): Value => {
      if (type.kind === 'float') {
        const isFloat = type.name === 'float';
        const width = isFloat ? Math.fround((b as number) - (a as number)) : (b as number) - (a as number);
        // `(b - a) * u + a` in the result type, which clang fuses into one rounding.
        return fma(width, canonical(engine, isFloat ? 24 : 53, isFloat), a as number, isFloat);
      }
      const result = uniformInteger(engine, BigInt(a as number | bigint), BigInt(b as number | bigint), resultBits);
      const value =
        type.kind === 'int' && isSigned(type) ? BigInt.asIntN(resultBits, result) : BigInt.asUintN(resultBits, result);
      return intValue(value);
    };
    cls.library = {
      kind,
      args: [type],
      size: 16,
      align: 8,
      call: (compiler: ExpressionCompiler, object: Expr, args: Expr[], row_: number) => {
        if (args.length !== 1) return;
        if (isConstType(object.type)) return compiler.error(row_, `const の ${cls.name} には () を使えません。`);
        const engineType = args[0].type;
        if (
          engineType.kind !== 'class' ||
          engineType.cls.library?.kind !== 'engine' ||
          isConstType(engineType) ||
          !args[0].isLvalue
        ) {
          return compiler.error(
            row_,
            `${cls.name} の () には乱数のエンジン（std::mt19937 など）の変数を書いてください。`
          );
        }
        const self = compiler.objectOf(object);
        const engine = args[0].run;
        return {
          type,
          isLvalue: false,
          row: row_,
          run: (frame) => {
            const parameters = (self(frame) as Ptr).read() as DistributionValue;
            return draw((engine(frame) as Ptr).read() as EngineValue, parameters.a, parameters.b);
          },
        };
      },
    };
    cls.operations = {
      copy: (_frame, source) => new DistributionValue((source as DistributionValue).a, (source as DistributionValue).b),
      assign: (_frame, target, source) => {
        (target as DistributionValue).a = (source as DistributionValue).a;
        (target as DistributionValue).b = (source as DistributionValue).b;
      },
    };
    cls.constructors = [
      nativeConstructor(cls, [], () => new DistributionValue(intValue(0n), max)),
      nativeConstructor(
        cls,
        [type, type],
        ([a, b]) => {
          const low = a as number | bigint;
          const high = (b ?? max) as number | bigint;
          if (!(low <= high)) throw new CppRuntimeError('custom', '乱数を作る範囲の下限は上限以下にしてください。');
          if (!isIntegral) {
            const width = Number(high) - Number(low);
            const limit = sizeOf(type) === 4 ? Math.fround(3.4028234663852886e38) : Number.MAX_VALUE;
            if (!(width <= limit)) throw new CppRuntimeError('custom', '乱数を作る範囲が広すぎます。');
          }
          return new DistributionValue(low, high);
        },
        { optional: 1, isExplicit: false }
      ),
    ];
    for (const [name, pick] of [
      ['a', (value: DistributionValue) => value.a],
      ['b', (value: DistributionValue) => value.b],
      ['min', (value: DistributionValue) => value.a],
      ['max', (value: DistributionValue) => value.b],
    ] as const) {
      addMethod(
        cls,
        native(name, [], type, (_args, { self }) => pick(self as DistributionValue), { isConst: true })
      );
    }
    return classType(cls);
  };
  return (['uniform_int_distribution', 'uniform_real_distribution'] as const).map((name) => ({
    name,
    instantiate: (args: Type[], row: number) => {
      if (args.length > 1) return library.compiler.error(row, `std::${name} のテンプレート引数は1つです。`);
      return distribution(name, args[0] ?? (name === 'uniform_int_distribution' ? INT : DOUBLE), row);
    },
  }));
}
