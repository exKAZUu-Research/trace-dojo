import { callSpecial, lookupSpecial } from './objects';
import { classOf, None, typeError, typeName } from './types';
import { PyComplex, PyInstance, PyObject, PySet, PyTuple, type PyValue } from './values';

const MASK64 = (1n << 64n) - 1n;
const MODULUS = (1n << 61n) - 1n;
const HASH_BITS = 61n;
const HASH_INF = 314_159n;
const XXPRIME_1 = 11_400_714_785_074_694_791n;
const XXPRIME_2 = 14_029_467_366_897_019_727n;
const XXPRIME_5 = 2_870_177_450_012_600_261n;

/** Converts an unsigned 64-bit hash to the signed value Python shows. */
function signed(value: bigint): bigint {
  const masked = value & MASK64;
  return masked >= 1n << 63n ? masked - (1n << 64n) : masked;
}

export function hashInt(value: bigint): bigint {
  const magnitude = (value < 0n ? -value : value) % MODULUS;
  const hash = value < 0n ? -magnitude : magnitude;
  return hash === -1n ? -2n : hash;
}

export function hashFloat(value: number): bigint {
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) return 0n;
    return value > 0 ? HASH_INF : -HASH_INF;
  }
  if (Number.isInteger(value)) return hashInt(BigInt(value));
  let { mantissa, exponent } = frexp(value);
  let sign = 1n;
  if (mantissa < 0) {
    sign = -1n;
    mantissa = -mantissa;
  }
  let x = 0n;
  while (mantissa) {
    x = ((x << 28n) & MODULUS) | (x >> (HASH_BITS - 28n));
    mantissa *= 268_435_456;
    exponent -= 28;
    const y = Math.floor(mantissa);
    mantissa -= y;
    x += BigInt(y);
    if (x >= MODULUS) x -= MODULUS;
  }
  const bits = Number(HASH_BITS);
  const e = BigInt(exponent >= 0 ? exponent % bits : bits - 1 - ((-1 - exponent) % bits));
  x = ((x << e) & MODULUS) | (x >> (HASH_BITS - e));
  const hash = signed(x * sign);
  return hash === -1n ? -2n : hash;
}

/** Splits a finite nonzero number into a mantissa in [0.5, 1) and a power of two, as C's frexp does. */
export function frexp(value: number): { mantissa: number; exponent: number } {
  if (value === 0 || !Number.isFinite(value)) return { mantissa: value, exponent: 0 };
  let exponent = Math.max(-1073, Math.floor(Math.log2(Math.abs(value))) + 1);
  let mantissa = value * 2 ** -exponent;
  while (Math.abs(mantissa) < 0.5) {
    mantissa *= 2;
    exponent--;
  }
  while (Math.abs(mantissa) >= 1) {
    mantissa /= 2;
    exponent++;
  }
  return { mantissa, exponent };
}

function hashTuple(items: readonly PyValue[]): bigint {
  let acc = XXPRIME_5;
  for (const item of items) {
    const lane = pyHash(item) & MASK64;
    acc = (acc + lane * XXPRIME_2) & MASK64;
    acc = ((acc << 31n) | (acc >> 33n)) & MASK64;
    acc = (acc * XXPRIME_1) & MASK64;
  }
  acc = (acc + (BigInt(items.length) ^ (XXPRIME_5 ^ 3_527_539n))) & MASK64;
  if (acc === MASK64) return 1_546_275_796n;
  return signed(acc);
}

function shuffleBits(hash: bigint): bigint {
  return ((hash ^ 89_869_747n ^ (hash << 16n)) * 3_644_798_167n) & MASK64;
}

function hashFrozenset(set: PySet): bigint {
  let hash = 0n;
  const { table } = set;
  for (const slot of table.slots()) hash ^= shuffleBits(slot === undefined ? 0n : slot.hash & MASK64);
  if ((BigInt(table.capacity - table.fill) & 1n) === 1n) hash ^= shuffleBits(0n);
  if ((BigInt(table.fill - table.used) & 1n) === 1n) hash ^= shuffleBits(MASK64);
  hash ^= ((BigInt(table.used) + 1n) * 1_927_868_237n) & MASK64;
  hash ^= (hash >> 11n) ^ (hash >> 25n);
  hash = (hash * 69_069n + 907_133_923n) & MASK64;
  if (hash === MASK64) hash = 590_923_713n;
  return signed(hash);
}

/**
 * A deterministic stand-in for Python's string hash, which CPython randomizes per process, so no program can depend
 * on its values or on the order of a set of strings.
 */
function hashString(value: string): bigint {
  let high = 0x81_1c_9d_c5;
  let low = 0x01_00_01_93;
  for (let index = 0; index < value.length; index++) {
    const code = value.codePointAt(index) as number;
    high = Math.imul(high ^ code, 0x01_00_01_93) >>> 0;
    low = Math.imul(low ^ (code + index), 0x85_eb_ca_6b) >>> 0;
  }
  const hash = signed((BigInt(high) << 32n) | BigInt(low));
  return hash === -1n ? -2n : hash;
}

const NONE_HASH = 4_238_894_112n;

/** Python's `hash()`, raising TypeError for unhashable values. */
// code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of hashable value.
export function pyHash(value: PyValue): bigint {
  switch (typeof value) {
    case 'bigint': {
      return hashInt(value);
    }
    case 'number': {
      return hashFloat(value);
    }
    case 'boolean': {
      return value ? 1n : 0n;
    }
    case 'string': {
      return hashString(value);
    }
  }
  if (value === None) return NONE_HASH;
  if (value instanceof PyTuple && !(value instanceof PyInstance)) return hashTuple(value.items);
  if (value instanceof PyComplex) {
    const hash = signed(hashFloat(value.real) + 1_000_003n * hashFloat(value.imag));
    return hash === -1n ? -2n : hash;
  }
  const special = lookupSpecial(value, '__hash__');
  if (special === None) throw typeError(`unhashable type: '${typeName(value)}'`);
  if (special !== undefined && !isDefaultHash(special)) {
    const result = callSpecial(value, '__hash__', []);
    if (typeof result === 'boolean') return result ? 1n : 0n;
    if (typeof result !== 'bigint') throw typeError('__hash__ method should return an integer');
    return hashInt(result);
  }
  if (value instanceof PySet) return hashFrozenset(value);
  return identityHash(value);
}

/** Whether a class's `__hash__` is the builtin one that hashes by identity or by value natively. */
function isDefaultHash(special: PyValue): boolean {
  return special instanceof PyObject && classOf(special).name === 'method_descriptor';
}

export function identityHash(value: PyObject): bigint {
  return BigInt(value.identity) * 16n + 7n;
}
