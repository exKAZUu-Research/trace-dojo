import { exactParts } from './binaryFloat';

/**
 * Formats doubles as macOS's libc does for `%f`, `%e`, `%g`, and `%a`: from the exact binary value, rounded to the
 * requested digits using macOS rounding rules.
 */

/** The exact decimal digits of a finite positive double, and the power of ten of the first digit. */
function exactDigits(value: number): { digits: string; exponent: number } {
  const { mantissa, exponent } = exactParts(value);
  let digits: string;
  let pointPosition: number;
  if (exponent >= 0) {
    digits = (mantissa << BigInt(exponent)).toString();
    pointPosition = digits.length;
  } else {
    // mantissa / 2^k = mantissa * 5^k / 10^k
    const scaled = mantissa * 5n ** BigInt(-exponent);
    digits = scaled.toString();
    pointPosition = digits.length + exponent;
  }
  const stripped = digits.replace(/^0+/, '');
  const leadingZeros = digits.length - stripped.length;
  return { digits: stripped.replace(/0+$/, '') || '0', exponent: pointPosition - leadingZeros - 1 };
}

/**
 * Rounds a digit string to `count` digits with ties to even, returning the rounded digits (exactly `count` of them,
 * or `count + 1` when rounding carries into a new leading digit).
 */
function roundDigits(digits: string, count: number): { digits: string; carried: boolean } {
  if (count < 0) return { digits: '', carried: false };
  if (digits.length <= count) return { digits: digits.padEnd(count, '0'), carried: false };
  const kept = digits.slice(0, count);
  const rest = digits.slice(count);
  const first = Number(rest[0]);
  let roundUp: boolean;
  if (first > 5) roundUp = true;
  else if (first < 5) roundUp = false;
  else if (/[1-9]/.test(rest.slice(1))) roundUp = true;
  else roundUp = count > 0 ? Number(kept[count - 1]) % 2 === 1 : false;
  if (!roundUp) return { digits: kept, carried: false };
  const incremented = (BigInt(kept || '0') + 1n).toString().padStart(count, '0');
  if (incremented.length > count) return { digits: incremented, carried: true };
  return { digits: incremented, carried: false };
}

/** `%.<precision>f` of a finite non-negative double, without its sign. */
export function formatFixed(value: number, precision: number): string {
  if (value === 0) return precision > 0 ? `0.${'0'.repeat(precision)}` : '0';
  const { digits, exponent } = exactDigits(value);
  // The number of digits kept: those before the point plus `precision` after it.
  const count = exponent + 1 + precision;
  let integerPart: string;
  let fraction: string;
  if (count <= 0) {
    // The first digit lies past the last kept place, so the value rounds to 0 or to one unit of that place.
    const roundsUp = count === 0 && roundDigits(digits, 0).carried;
    const units = roundsUp ? '1' : '0';
    const padded = units.padStart(precision + 1, '0');
    integerPart = padded.slice(0, padded.length - precision);
    fraction = padded.slice(padded.length - precision);
  } else {
    const { digits: rounded, carried } = roundDigits(digits, count);
    const integerLength = exponent + 1 + (carried ? 1 : 0);
    const all = integerLength > 0 ? rounded : '0'.repeat(-integerLength) + rounded;
    const split = Math.max(integerLength, 0);
    integerPart = all.slice(0, split) || '0';
    fraction = all.slice(split, split + precision).padEnd(precision, '0');
  }
  integerPart = integerPart.replace(/^0+(?=\d)/, '');
  return precision > 0 ? `${integerPart}.${fraction}` : integerPart;
}

/** The digits and exponent of a finite non-negative double rounded to `significant` digits, as `%e` shows it. */
function scientificParts(value: number, significant: number): { digits: string; exponent: number } {
  if (value === 0) return { digits: '0'.repeat(significant), exponent: 0 };
  const { digits, exponent } = exactDigits(value);
  const { digits: rounded, carried } = roundDigits(digits, significant);
  return { digits: carried ? rounded.slice(0, significant) : rounded, exponent: exponent + (carried ? 1 : 0) };
}

function exponentText(exponent: number): string {
  const sign = exponent < 0 ? '-' : '+';
  return `${sign}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

/** `%.<precision>e` of a finite non-negative double, without its sign. */
export function formatScientific(value: number, precision: number, alternate: boolean): string {
  const { digits, exponent } = scientificParts(value, precision + 1);
  const mantissa = precision > 0 || alternate ? `${digits[0]}.${digits.slice(1)}` : digits[0];
  return `${mantissa}e${exponentText(exponent)}`;
}

/** `%.<precision>g` of a finite non-negative double, without its sign. */
export function formatGeneral(value: number, precision: number, alternate: boolean): string {
  const significant = precision === 0 ? 1 : precision;
  const { exponent } = scientificParts(value, significant);
  let text: string;
  if (exponent < -4 || exponent >= significant) {
    text = formatScientific(value, significant - 1, alternate);
    if (!alternate) text = text.replace(/\.?0+e/, 'e');
  } else {
    text = formatFixed(value, significant - 1 - exponent);
    if (alternate && !text.includes('.')) text += '.';
    if (!alternate && text.includes('.')) text = text.replace(/\.?0+$/, '');
  }
  return text;
}

/** `%a` of a finite non-negative double, without its sign: macOS's form, `0x1.8p+1`, with the precision if given. */
export function formatHex(value: number, precision: number | undefined, alternate: boolean): string {
  if (value === 0) {
    const fraction = precision ? `.${'0'.repeat(precision)}` : alternate ? '.' : '';
    return `0x0${fraction}p+0`;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  let biasedExponent = Number((bits >> 52n) & 0x7_ffn);
  let mantissa = bits & ((1n << 52n) - 1n);
  // macOS normalizes subnormal numbers so that they start with 1, as normal ones do.
  if (biasedExponent === 0) {
    let shift = 0;
    while ((mantissa & (1n << 52n)) === 0n) {
      mantissa <<= 1n;
      shift++;
    }
    mantissa &= (1n << 52n) - 1n;
    biasedExponent = 1 - shift;
  }
  let exponent = biasedExponent - 1023;
  let lead = 1n;
  let hex = mantissa.toString(16).padStart(13, '0');
  if (precision !== undefined && precision < 13) {
    const dropBits = BigInt((13 - precision) * 4);
    const full = (lead << 52n) | mantissa;
    const kept = full >> dropBits;
    const dropped = full & ((1n << dropBits) - 1n);
    const first = Number(dropped >> (dropBits - 4n));
    const next = dropBits >= 8n ? Number((dropped >> (dropBits - 8n)) & 15n) : 0;
    // Apple's __hdtoa uses the first discarded digit and the low bit of the next, ignoring later digits.
    // https://github.com/apple-oss-distributions/Libc/blob/main/gdtoa/FreeBSD/_hdtoa.c
    const rounded = kept + (first > 8 || (first === 8 && (next & 1) !== 0) ? 1n : 0n);
    const fractionBits = BigInt(precision * 4);
    lead = rounded >> fractionBits;
    hex = precision > 0 ? (rounded & ((1n << fractionBits) - 1n)).toString(16).padStart(precision, '0') : '';
  } else if (precision === undefined) {
    hex = hex.replace(/0+$/, '');
  } else {
    hex = hex.padEnd(precision, '0');
  }
  const point = hex.length > 0 || alternate ? '.' : '';
  return `0x${lead.toString(16)}${point}${hex}p${exponent < 0 ? '-' : '+'}${Math.abs(exponent)}`;
}
