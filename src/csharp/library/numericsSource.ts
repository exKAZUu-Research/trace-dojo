/** The integral types that convert to BigInteger implicitly, and that BigInteger converts to explicitly. */
const INTEGRAL_TYPES = ['byte', 'sbyte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'char'];

const BINARY_OPERATORS = ['+', '-', '*', '/', '%', '&', '|', '^'];
const COMPARISONS = ['==', '!=', '<', '<=', '>', '>='];

/** The comparisons of BigInteger with itself and with `long` and `ulong` on either side. */
const COMPARISON_OPERATORS = COMPARISONS.flatMap((operator) =>
  [
    ['BigInteger', 'BigInteger'],
    ['BigInteger', 'long'],
    ['long', 'BigInteger'],
    ['BigInteger', 'ulong'],
    ['ulong', 'BigInteger'],
  ].map(([left, right]) => `public static bool operator ${operator}(${left} left, ${right} right);`)
).join('\n    ');

/**
 * The declarations of `System.Numerics`, in C#: BigInteger, which keeps its value as a JavaScript bigint of any size in
 * its one field. Members without bodies are implemented natively (see `nativesBigInteger.ts`).
 */
export const NUMERICS_SOURCE = String.raw`
namespace System.Numerics {
  public readonly struct BigInteger : IComparable, IComparable<BigInteger>, IEquatable<BigInteger>, IFormattable {
    private readonly long _value;
    public BigInteger(int value);
    public BigInteger(uint value);
    public BigInteger(long value);
    public BigInteger(ulong value);
    public BigInteger(float value);
    public BigInteger(double value);
    public BigInteger(decimal value);
    public static BigInteger Zero { get; }
    public static BigInteger One { get; }
    public static BigInteger MinusOne { get; }
    public bool IsZero { get; }
    public bool IsOne { get; }
    public bool IsEven { get; }
    public bool IsPowerOfTwo { get; }
    public int Sign { get; }
    public static BigInteger Abs(BigInteger value);
    public static BigInteger Negate(BigInteger value);
    public static BigInteger Add(BigInteger left, BigInteger right);
    public static BigInteger Subtract(BigInteger left, BigInteger right);
    public static BigInteger Multiply(BigInteger left, BigInteger right);
    public static BigInteger Divide(BigInteger dividend, BigInteger divisor);
    public static BigInteger Remainder(BigInteger dividend, BigInteger divisor);
    public static BigInteger DivRem(BigInteger dividend, BigInteger divisor, out BigInteger remainder);
    public static (BigInteger Quotient, BigInteger Remainder) DivRem(BigInteger left, BigInteger right);
    public static BigInteger Pow(BigInteger value, int exponent);
    public static BigInteger ModPow(BigInteger value, BigInteger exponent, BigInteger modulus);
    public static BigInteger GreatestCommonDivisor(BigInteger left, BigInteger right);
    public static BigInteger Min(BigInteger left, BigInteger right);
    public static BigInteger Max(BigInteger left, BigInteger right);
    public static int Compare(BigInteger left, BigInteger right);
    public static double Log(BigInteger value);
    public static double Log(BigInteger value, double baseValue);
    public static double Log10(BigInteger value);
    public int CompareTo(long other);
    public int CompareTo(ulong other);
    public int CompareTo(BigInteger other);
    public int CompareTo(object? obj);
    public override bool Equals(object? obj);
    public bool Equals(long other);
    public bool Equals(ulong other);
    public bool Equals(BigInteger other);
    public override int GetHashCode();
    public override string ToString();
    public string ToString(IFormatProvider? provider);
    public string ToString(string? format);
    public string ToString(string? format, IFormatProvider? provider);
    public static BigInteger Parse(string value);
    public static BigInteger Parse(string value, System.Globalization.NumberStyles style);
    public static BigInteger Parse(string value, IFormatProvider? provider);
    public static BigInteger Parse(string value, System.Globalization.NumberStyles style, IFormatProvider? provider);
    public static bool TryParse(string? value, out BigInteger result);
    public static bool TryParse(string? value, IFormatProvider? provider, out BigInteger result);
    public static bool TryParse(string? value, System.Globalization.NumberStyles style, IFormatProvider? provider, out BigInteger result);
    ${INTEGRAL_TYPES.map((type) => `public static implicit operator BigInteger(${type} value);`).join('\n    ')}
    public static explicit operator BigInteger(float value);
    public static explicit operator BigInteger(double value);
    public static explicit operator BigInteger(decimal value);
    ${[...INTEGRAL_TYPES, 'float', 'double', 'decimal'].map((type) => `public static explicit operator ${type}(BigInteger value);`).join('\n    ')}
    ${BINARY_OPERATORS.map((operator) => `public static BigInteger operator ${operator}(BigInteger left, BigInteger right);`).join('\n    ')}
    public static BigInteger operator <<(BigInteger value, int shift);
    public static BigInteger operator >>(BigInteger value, int shift);
    public static BigInteger operator >>>(BigInteger value, int shiftAmount);
    public static BigInteger operator -(BigInteger value);
    public static BigInteger operator +(BigInteger value);
    public static BigInteger operator ~(BigInteger value);
    public static BigInteger operator ++(BigInteger value);
    public static BigInteger operator --(BigInteger value);
    ${COMPARISON_OPERATORS}
  }
}
`;
