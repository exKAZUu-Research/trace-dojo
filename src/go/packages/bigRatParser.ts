import { currentRuntime } from '../native';

interface Fraction {
  num: bigint;
  den: bigint;
}
type IntegerParser = (text: string, base: number) => bigint | undefined;
type CheckBits = (bits: bigint) => void;

// code-gauge-allow functionCognitiveComplexity 18 -- Keeps Go rational scanning and exponent validation beside the host allocation bounds.
// code-gauge-allow functionNcss 37 -- Keeps Go rational scanning and exponent validation beside the host allocation bounds.
export function parseRational(text: string, integer: IntegerParser, checkBits: CheckBits): Fraction | undefined {
  const slash = text.indexOf('/');
  if (slash !== -1) return parseFraction(text, slash, integer);
  const negative = text[0] === '-';
  const start = text[0] === '-' || text[0] === '+' ? 1 : 0;
  const mantissa = scanMantissa(text, start, checkBits);
  if (!mantissa) return undefined;
  const exponent = scanExponent(text, mantissa.end);
  if (!exponent) return undefined;
  if (mantissa.value === 0n) return { num: 0n, den: 1n };
  let exp2 = -BigInt(mantissa.fraction) * BigInt(mantissa.base === 10 ? 1 : Math.log2(mantissa.base));
  let exp5 = mantissa.base === 10 ? -BigInt(mantissa.fraction) : 0n;
  exp2 += exponent.value;
  if (exponent.base === 10) exp5 += exponent.value;
  const abs2 = exp2 < 0n ? -exp2 : exp2;
  const abs5 = exp5 < 0n ? -exp5 : exp5;
  if (abs2 > 10_000_000n || abs5 > 1_000_000n) return undefined;
  checkBits(BigInt(mantissa.value.toString(2).length) + abs2 + 3n * abs5);
  let num = negative ? -mantissa.value : mantissa.value;
  let den = 1n;
  if (exp5 > 0n) num *= 5n ** exp5;
  else if (exp5 < 0n) den = 5n ** -exp5;
  if (exp2 > 0n) num <<= exp2;
  else if (exp2 < 0n) den <<= -exp2;
  return { num, den };
}

function parseFraction(text: string, slash: number, integer: IntegerParser): Fraction | undefined {
  const numerator = integer(text.slice(0, slash), 0);
  const denominatorText = text.slice(slash + 1);
  if (denominatorText[0] === '-' || denominatorText[0] === '+') return undefined;
  const denominator = integer(denominatorText, 0);
  if (numerator === undefined || denominator === undefined || denominator === 0n) return undefined;
  return { num: numerator, den: denominator };
}

// code-gauge-allow functionCognitiveComplexity 29 -- Keeps Go rational scanning and exponent validation beside the host allocation bounds.
// code-gauge-allow functionNcss 36 -- Keeps Go rational scanning and exponent validation beside the host allocation bounds.
function scanMantissa(
  text: string,
  start: number,
  checkBits: CheckBits
):
  | {
      value: bigint;
      base: number;
      fraction: number;
      end: number;
    }
  | undefined {
  const prefix = text.slice(start, start + 2).toLowerCase();
  const base = prefix === '0x' ? 16 : prefix === '0o' ? 8 : prefix === '0b' ? 2 : 10;
  const first = start + (base === 10 ? 0 : 2);
  let position = first;
  let value = 0n;
  let digits = 0;
  let fraction = 0;
  let point = false;
  let previousDigit = false;
  while (position < text.length) {
    currentRuntime().spend();
    const char = text[position];
    if (char === '.' && !point) {
      point = true;
      previousDigit = false;
    } else if (char === '_') {
      if ((!previousDigit && !(position === first && base !== 10)) || digit(text[position + 1], base) < 0)
        return undefined;
      previousDigit = false;
    } else {
      const next = digit(char, base);
      if (next < 0) break;
      value = value * BigInt(base) + BigInt(next);
      digits++;
      if (point) fraction++;
      previousDigit = true;
      if (digits % 256 === 0) checkBits(BigInt(value.toString(2).length));
    }
    position++;
  }
  if (digits === 0) return undefined;
  return { value, base, fraction, end: position };
}

// code-gauge-allow functionCognitiveComplexity 21 -- Keeps Go rational scanning and exponent validation beside the host allocation bounds.
function scanExponent(text: string, start: number): { value: bigint; base: number } | undefined {
  if (start === text.length) return { value: 0n, base: 2 };
  const marker = text[start].toLowerCase();
  if (marker !== 'e' && marker !== 'p') return undefined;
  let position = start + 1;
  const negative = text[position] === '-';
  if (text[position] === '-' || text[position] === '+') position++;
  let value = 0n;
  let previousDigit = false;
  for (; position < text.length; position++) {
    currentRuntime().spend();
    const char = text[position];
    if (char === '_') {
      if (!previousDigit || digit(text[position + 1], 10) < 0) return undefined;
      previousDigit = false;
      continue;
    }
    const next = digit(char, 10);
    if (next < 0) return undefined;
    previousDigit = true;
    value = value * 10n + BigInt(next);
    if (value > 1n << 63n) return undefined;
  }
  if (!previousDigit || (!negative && value === 1n << 63n)) return undefined;
  return { value: negative ? -value : value, base: marker === 'e' ? 10 : 2 };
}

function digit(char: string | undefined, base: number): number {
  const value = char === undefined ? -1 : '0123456789abcdef'.indexOf(char.toLowerCase());
  return value < base ? value : -1;
}
