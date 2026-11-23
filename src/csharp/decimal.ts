/** The largest coefficient of a .NET decimal, whose 96 bits hold it. */
const MAX_COEFFICIENT = (1n << 96n) - 1n;
const MAX_SCALE = 28;
/** The digits of the largest coefficient, 79228162514264337593543950335. */
const MAX_DIGITS = 29;
/** The significant digits of a numeral that parsing keeps, beyond the 29 a decimal holds and its rounding digit. */
const PARSED_DIGITS = 40;

export class DecimalOverflowError extends Error {}

/** A .NET `decimal`: a 96-bit coefficient, a sign, and a scale of 0 to 28 decimal places, which keeps trailing zeros. */
export class CsDecimal {
  constructor(
    /** The coefficient, which is never negative. */
    readonly coefficient: bigint,
    readonly scale: number,
    readonly isNegative: boolean
  ) {}

  static readonly ZERO = new CsDecimal(0n, 0, false);
  static readonly ONE = new CsDecimal(1n, 0, false);

  static fromBigInt(value: bigint): CsDecimal {
    const magnitude = value < 0n ? -value : value;
    if (magnitude > MAX_COEFFICIENT) throw new DecimalOverflowError();
    return new CsDecimal(magnitude, 0, value < 0n);
  }

  /** Converts from double as .NET does, keeping 15 significant digits. */
  static fromDouble(value: number, significantDigits = 15): CsDecimal {
    if (!Number.isFinite(value) || Math.abs(value) >= 7.922816251426434e28) throw new DecimalOverflowError();
    if (value === 0) return new CsDecimal(0n, 0, Object.is(value, -0));
    const text = Math.abs(value).toExponential(significantDigits - 1);
    const [mantissa, exponentText] = text.split('e');
    const digits = mantissa.replace('.', '');
    const exponent = Number(exponentText);
    // The value is 0.digits × 10^(exponent + 1), so its scale is the digits after the point.
    let scale = significantDigits - 1 - exponent;
    let coefficient = BigInt(digits);
    while (scale > MAX_SCALE) {
      coefficient = roundDivide(coefficient, 10n);
      scale--;
    }
    while (scale < 0) {
      coefficient *= 10n;
      scale++;
    }
    // .NET drops trailing zeros of the converted digits.
    while (scale > 0 && coefficient % 10n === 0n) {
      coefficient /= 10n;
      scale--;
    }
    if (coefficient === 0n) return new CsDecimal(0n, 0, false);
    return checked(coefficient, scale, value < 0);
  }

  /** Parses the text of a decimal literal or of `decimal.Parse`, keeping its trailing zeros. */
  static parse(text: string): CsDecimal | undefined {
    const match = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!match || (match[2] === '' && (match[3] ?? '') === '')) return undefined;
    const integer = match[2];
    const fraction = match[3] ?? '';
    let scale = fraction.length - Number(match[4] ?? 0);
    // Digits past the first PARSED_DIGITS significant ones cannot change the rounded result except as a nonzero tail,
    // which one sticky digit keeps, so a long numeral is reduced at once rather than by one division per digit.
    let digits = `${integer}${fraction}`.replace(/^0+/, '');
    if (digits.length > PARSED_DIGITS) {
      const hasNonzeroTail = /[1-9]/.test(digits.slice(PARSED_DIGITS));
      scale -= digits.length - PARSED_DIGITS - 1;
      digits = `${digits.slice(0, PARSED_DIGITS)}${hasNonzeroTail ? '1' : '0'}`;
    }
    let coefficient = BigInt(digits || '0');
    // An exponent far outside the decimal range decides the result at once, which digit-by-digit scaling would take
    // as many steps as the exponent to reach.
    const digitCount = coefficient === 0n ? 0 : coefficient.toString().length;
    if (scale < 0 && coefficient === 0n) scale = 0;
    if (scale < 0 && digitCount - scale > MAX_DIGITS) return undefined;
    if (scale > MAX_SCALE + digitCount + 1) {
      coefficient = 0n;
      scale = MAX_SCALE;
    }
    while (scale < 0) {
      coefficient *= 10n;
      scale++;
    }
    while (scale > MAX_SCALE || (coefficient > MAX_COEFFICIENT && scale > 0)) {
      coefficient = roundDivide(coefficient, 10n);
      scale--;
    }
    if (coefficient > MAX_COEFFICIENT) return undefined;
    return new CsDecimal(coefficient, scale, match[1] === '-' && coefficient !== 0n);
  }

  get signed(): bigint {
    return this.isNegative ? -this.coefficient : this.coefficient;
  }

  isZero(): boolean {
    return this.coefficient === 0n;
  }

  negate(): CsDecimal {
    return new CsDecimal(this.coefficient, this.scale, !this.isNegative);
  }

  add(other: CsDecimal): CsDecimal {
    const scale = Math.max(this.scale, other.scale);
    const sum = this.signed * 10n ** BigInt(scale - this.scale) + other.signed * 10n ** BigInt(scale - other.scale);
    return fitted(sum, scale, this.isNegative && other.isNegative);
  }

  subtract(other: CsDecimal): CsDecimal {
    return this.add(other.negate());
  }

  multiply(other: CsDecimal): CsDecimal {
    return fitted(this.signed * other.signed, this.scale + other.scale, this.isNegative !== other.isNegative);
  }

  /** Divides as .NET does: exactly at the scale the operands suggest or the least that holds the quotient, else rounded. */
  divide(other: CsDecimal): CsDecimal {
    if (other.isZero()) throw new RangeError('divide by zero');
    const negative = this.isNegative !== other.isNegative;
    const preferred = this.scale - other.scale;
    const numerator = this.coefficient;
    const denominator = other.coefficient;
    // The quotient at scale s is numerator × 10^(s − preferred) / denominator.
    for (let scale = Math.max(preferred, 0); scale <= MAX_SCALE; scale++) {
      const shift = scale - preferred;
      const scaledNumerator = shift >= 0 ? numerator * 10n ** BigInt(shift) : numerator;
      const scaledDenominator = shift >= 0 ? denominator : denominator * 10n ** BigInt(-shift);
      const quotient = scaledNumerator / scaledDenominator;
      if (quotient > MAX_COEFFICIENT) {
        if (scale === Math.max(preferred, 0)) throw new DecimalOverflowError();
        return fittedQuotient(numerator, denominator, scale - 1, preferred, negative);
      }
      if (scaledNumerator % scaledDenominator === 0n)
        return new CsDecimal(quotient, scale, negative && quotient !== 0n);
    }
    return fittedQuotient(numerator, denominator, MAX_SCALE, preferred, negative);
  }

  /** The remainder of a truncated division, whose sign is the dividend's. */
  remainder(other: CsDecimal): CsDecimal {
    if (other.isZero()) throw new RangeError('divide by zero');
    const scale = Math.max(this.scale, other.scale);
    const a = this.signed * 10n ** BigInt(scale - this.scale);
    const b = other.signed * 10n ** BigInt(scale - other.scale);
    // A dividend smaller in magnitude than the divisor is its own remainder, scale included, as .NET returns it.
    if ((a < 0n ? -a : a) < (b < 0n ? -b : b)) return this;
    const result = a % b;
    return new CsDecimal(result < 0n ? -result : result, scale, this.isNegative);
  }

  compare(other: CsDecimal): number {
    const scale = Math.max(this.scale, other.scale);
    const a = this.signed * 10n ** BigInt(scale - this.scale);
    const b = other.signed * 10n ** BigInt(scale - other.scale);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** Converts to double as .NET's `decimal` does, which is not always the nearest double. */
  toDouble(): number {
    const low = Number(BigInt.asUintN(64, this.coefficient));
    const high = Number(this.coefficient >> 64n);
    const magnitude = (low + high * 18_446_744_073_709_551_616) / 10 ** this.scale;
    return this.isNegative ? -magnitude : magnitude;
  }

  /** The value rounded toward zero to an integer. */
  truncate(): bigint {
    const integer = this.coefficient / 10n ** BigInt(this.scale);
    return this.isNegative ? -integer : integer;
  }

  /** Rounds to a number of decimal places, ties to even or away from zero, as `Math.Round` does. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  round(decimals: number, mode: 'even' | 'awayFromZero' | 'down' | 'floor' | 'ceiling'): CsDecimal {
    if (this.scale <= decimals) return this;
    const divisor = 10n ** BigInt(this.scale - decimals);
    let quotient = this.coefficient / divisor;
    const remainder = this.coefficient % divisor;
    const twice = remainder * 2n;
    const roundsUp =
      mode === 'even'
        ? twice > divisor || (twice === divisor && quotient % 2n === 1n)
        : mode === 'awayFromZero'
          ? twice >= divisor
          : mode === 'floor'
            ? this.isNegative && remainder > 0n
            : mode === 'ceiling'
              ? !this.isNegative && remainder > 0n
              : false;
    if (roundsUp) quotient++;
    return new CsDecimal(quotient, decimals, this.isNegative && quotient !== 0n);
  }

  /** The digits of the coefficient with the decimal point at the scale, as `ToString()` shows it. */
  toString(): string {
    let digits = this.coefficient.toString();
    if (this.scale > 0) {
      digits = digits.padStart(this.scale + 1, '0');
      digits = `${digits.slice(0, -this.scale)}.${digits.slice(-this.scale)}`;
    }
    return this.isNegative && this.coefficient !== 0n ? `-${digits}` : digits;
  }

  equals(other: CsDecimal): boolean {
    return this.compare(other) === 0;
  }
}

/** Divides, rounding half to even. */
function roundDivide(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const twice = (numerator % denominator) * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) return quotient + 1n;
  return quotient;
}

/** The decimal of a signed coefficient at a scale, rounding away digits that do not fit as .NET does. */
function fitted(signed: bigint, scale: number, negativeZero: boolean): CsDecimal {
  let coefficient = signed < 0n ? -signed : signed;
  let currentScale = scale;
  while (currentScale > MAX_SCALE || (coefficient > MAX_COEFFICIENT && currentScale > 0)) {
    coefficient = roundDivide(coefficient, 10n);
    currentScale--;
  }
  if (coefficient > MAX_COEFFICIENT) throw new DecimalOverflowError();
  return new CsDecimal(coefficient, currentScale, signed < 0n || (signed === 0n && negativeZero));
}

function fittedQuotient(
  numerator: bigint,
  denominator: bigint,
  scale: number,
  preferred: number,
  negative: boolean
): CsDecimal {
  for (let current = scale; current >= 0; current--) {
    const shift = current - preferred;
    const scaledNumerator = shift >= 0 ? numerator * 10n ** BigInt(shift) : numerator;
    const scaledDenominator = shift >= 0 ? denominator : denominator * 10n ** BigInt(-shift);
    let quotient = roundDivide(scaledNumerator, scaledDenominator);
    if (quotient > MAX_COEFFICIENT) continue;
    // .NET drops the trailing zeros of a rounded quotient down to the scale the operands suggest.
    let fittedScale = current;
    while (fittedScale > Math.max(preferred, 0) && quotient % 10n === 0n) {
      quotient /= 10n;
      fittedScale--;
    }
    return new CsDecimal(quotient, fittedScale, negative && quotient !== 0n);
  }
  throw new DecimalOverflowError();
}

function checked(coefficient: bigint, scale: number, negative: boolean): CsDecimal {
  if (coefficient > MAX_COEFFICIENT) throw new DecimalOverflowError();
  return new CsDecimal(coefficient, scale, negative);
}
