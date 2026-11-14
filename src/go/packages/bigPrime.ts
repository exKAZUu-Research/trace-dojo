import { currentRuntime } from '../native';
import { LaggedFibonacci } from './rand';

type ModularPower = (base: bigint, exponent: bigint, modulus: bigint) => bigint;

export function probablyPrime(
  value: bigint,
  rounds: bigint,
  power: ModularPower,
  sqrt: (value: bigint) => bigint
): boolean {
  if (value < 2n) return false;
  for (const prime of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n, 53n, 59n, 61n]) {
    if (value === prime) return true;
    if (value % prime === 0n) return false;
  }
  return millerRabin(value, rounds, power) && lucas(value, sqrt);
}

// code-gauge-allow functionCognitiveComplexity 16 -- Keeps Go primality rounds, Lucas recurrence and parameter selection together with deadline checks.
function millerRabin(value: bigint, rounds: bigint, power: ModularPower): boolean {
  const bits = (value - 1n).toString(2);
  const zeros = bits.length - bits.lastIndexOf('1') - 1;
  const exponent = (value - 1n) >> BigInt(zeros);
  const random = new LaggedFibonacci(BigInt.asIntN(64, value));
  for (let round = 0n; round <= rounds; round++) {
    currentRuntime().spend();
    const base = round === rounds ? 2n : randomBelow(value - 3n, random) + 2n;
    let x = power(base, exponent, value);
    if (x === 1n || x === value - 1n) continue;
    let passed = false;
    for (let index = 1; index < zeros; index++) {
      currentRuntime().spend();
      x = (x * x) % value;
      if (x === value - 1n) {
        passed = true;
        break;
      }
      if (x === 1n) return false;
    }
    if (!passed) return false;
  }
  return true;
}

function randomBelow(limit: bigint, random: LaggedFibonacci): bigint {
  const length = limit.toString(2).length;
  const words = Math.ceil(length / 64);
  const mask = (1n << BigInt(length % 64 || 64)) - 1n;
  for (;;) {
    currentRuntime().spend();
    let result = 0n;
    for (let word = 0; word < words; word++) {
      let value = (random.int63() >> 31n) | ((random.int63() >> 31n) << 32n);
      if (word === words - 1) value &= mask;
      result |= value << BigInt(word * 64);
    }
    if (result < limit) return result;
  }
}

// code-gauge-allow functionCognitiveComplexity 20 -- Keeps Go primality rounds, Lucas recurrence and parameter selection together with deadline checks.
// code-gauge-allow functionNcss 36 -- Keeps Go primality rounds, Lucas recurrence and parameter selection together with deadline checks.
function lucas(value: bigint, sqrt: (value: bigint) => bigint): boolean {
  let p = 3n;
  for (;;) {
    currentRuntime().spend();
    const symbol = jacobi(p * p - 4n, value);
    if (symbol === -1) break;
    if (symbol === 0) return value === p + 2n;
    if (p === 40n && sqrt(value) ** 2n === value) return false;
    p++;
  }
  const bits = (value + 1n).toString(2);
  const zeros = bits.length - bits.lastIndexOf('1') - 1;
  const odd = bits.slice(0, bits.length - zeros);
  let current = 2n;
  let next = p;
  for (const bit of odd) {
    currentRuntime().spend();
    const product = modulo(current * next - p, value);
    if (bit === '1') {
      current = product;
      next = modulo(next * next - 2n, value);
    } else {
      next = product;
      current = modulo(current * current - 2n, value);
    }
  }
  if ((current === 2n || current === value - 2n) && (p * current - 2n * next) % value === 0n) return true;
  for (let index = 0; index < zeros - 1; index++) {
    currentRuntime().spend();
    if (current === 0n) return true;
    if (current === 2n) return false;
    current = modulo(current * current - 2n, value);
  }
  return false;
}

function jacobi(numerator: bigint, denominator: bigint): number {
  let a = numerator % denominator;
  let n = denominator;
  let sign = 1;
  while (a !== 0n) {
    currentRuntime().spend();
    while ((a & 1n) === 0n) {
      a >>= 1n;
      if (n % 8n === 3n || n % 8n === 5n) sign = -sign;
    }
    [a, n] = [n, a];
    if (a % 4n === 3n && n % 4n === 3n) sign = -sign;
    a %= n;
  }
  return n === 1n ? sign : 0;
}

function modulo(value: bigint, modulus: bigint): bigint {
  const result = value % modulus;
  return result < 0n ? result + modulus : result;
}
