// The caller has already recognized the decimal or hexadecimal floating-point grammar.
export function float32FromText(text: string): number {
  const sign = text.startsWith('-') ? -1 : 1;
  const unsigned = text.replaceAll(/^[+-]|[fFdD]$/g, '');
  const hexadecimal = /^0[xX]/.test(unsigned);
  const [significand, exponent = '0'] = hexadecimal ? unsigned.slice(2).split(/[pP]/) : unsigned.split(/[eE]/);
  const mark = significand.indexOf('.');
  const fractional = mark === -1 ? 0 : significand.length - mark - 1;
  const digits = significand.replace('.', '').replace(/^0+/, '');
  if (digits === '') return sign * 0;
  const magnitude = hexadecimal
    ? hexMagnitude(digits, Number(exponent) - fractional * 4)
    : decimalMagnitude(digits, Number(exponent) - fractional);
  return sign * magnitude;
}

function decimalMagnitude(digits: string, power: number): number {
  const order = digits.length - 1 + power;
  if (order > 38) return Infinity;
  if (order < -46) return 0;
  // All binary32 midpoints have terminating decimals within this precision.
  const prefix = digits.slice(0, 192);
  const shift = power + digits.length - prefix.length;
  const sticky = /[1-9]/.test(digits.slice(prefix.length));
  const integer = BigInt(prefix);
  return shift < 0
    ? roundBinary32(integer, 10n ** BigInt(-shift), sticky)
    : roundBinary32(integer * 10n ** BigInt(shift), 1n, sticky);
}

function hexMagnitude(digits: string, power: number): number {
  const lead = Number.parseInt(digits[0], 16);
  const order = (digits.length - 1) * 4 + Math.floor(Math.log2(lead)) + power;
  if (order > 127) return Infinity;
  if (order < -150) return 0;
  const prefix = digits.slice(0, 16);
  const shift = power + (digits.length - prefix.length) * 4;
  const sticky = /[1-9a-f]/i.test(digits.slice(prefix.length));
  const integer = BigInt(`0x${prefix}`);
  return shift < 0
    ? roundBinary32(integer, 1n << BigInt(-shift), sticky)
    : roundBinary32(integer << BigInt(shift), 1n, sticky);
}

function roundBinary32(numerator: bigint, denominator: bigint, sticky: boolean): number {
  const difference = numerator.toString(2).length - denominator.toString(2).length;
  const belowPower =
    difference < 0 ? numerator << BigInt(-difference) < denominator : numerator < denominator << BigInt(difference);
  const exponent = difference - Number(belowPower);
  const step = Math.max(-149, exponent - 23);
  const dividend = step < 0 ? numerator << BigInt(-step) : numerator;
  const divisor = step > 0 ? denominator << BigInt(step) : denominator;
  const quotient = dividend / divisor;
  const remainder = (dividend % divisor) * 2n;
  const roundsUp = remainder > divisor || (remainder === divisor && (sticky || (quotient & 1n) === 1n));
  const result = Number(quotient + (roundsUp ? 1n : 0n)) * 2 ** step;
  return result >= 2 ** 128 ? Infinity : result;
}
