import { MAX_TUPLE_ARITY } from '../types';

/**
 * The declarations of the `System` library types that programs use, in C#. Members without bodies are implemented
 * natively (see `natives*.ts`); their signatures follow .NET 10, so that overload resolution picks the same members.
 */
export const SYSTEM_SOURCE =
  String.raw`
namespace System {
  public class Object {
    public Object();
    public virtual string? ToString();
    public virtual bool Equals(object? obj);
    public virtual int GetHashCode();
    public Type GetType();
    public static bool ReferenceEquals(object? objA, object? objB);
    public static bool Equals(object? objA, object? objB);
    protected object MemberwiseClone();
  }
  public abstract class ValueType {
    public override bool Equals(object? obj);
    public override int GetHashCode();
    public override string? ToString();
  }
  public abstract class Type {
    public string Name { get; }
    public string? FullName { get; }
    public string? Namespace { get; }
    public override string ToString();
  }
  public readonly ref struct ReadOnlySpan<T> {
    public ReadOnlySpan(T[]? array);
    public static ReadOnlySpan<T> Empty { get; }
    public int Length { get; }
    public bool IsEmpty { get; }
    public ref readonly T this[int index] { get; }
    public T[] ToArray();
    public ReadOnlySpan<T> Slice(int start);
    public ReadOnlySpan<T> Slice(int start, int length);
    public Enumerator GetEnumerator();
    public override string ToString();
    public static bool operator ==(ReadOnlySpan<T> left, ReadOnlySpan<T> right);
    public static bool operator !=(ReadOnlySpan<T> left, ReadOnlySpan<T> right);
    public static implicit operator ReadOnlySpan<T>(T[]? array);
    public ref struct Enumerator { public T Current { get; } public bool MoveNext(); }
  }
  public static class MemoryExtensions {
    public static bool SequenceEqual<T>(this ReadOnlySpan<T> span, ReadOnlySpan<T> other) where T : IEquatable<T>;
  }
  public ref struct TypedReference {
    public static Type GetTargetType(TypedReference value);
    public static object? ToObject(TypedReference value);
    public override bool Equals(object? o);
    public override int GetHashCode();
  }
  public abstract class Enum : ValueType, IComparable, IFormattable {
    public bool HasFlag(Enum flag);
    public int CompareTo(object? target);
    public override string ToString();
    public string ToString(string? format);
    public static string? GetName<TEnum>(TEnum value) where TEnum : struct, Enum;
    public static string[] GetNames<TEnum>() where TEnum : struct, Enum;
    public static TEnum[] GetValues<TEnum>() where TEnum : struct, Enum;
    public static bool IsDefined<TEnum>(TEnum value) where TEnum : struct, Enum;
    public static TEnum Parse<TEnum>(string value) where TEnum : struct;
    public static TEnum Parse<TEnum>(string value, bool ignoreCase) where TEnum : struct;
    public static bool TryParse<TEnum>(string? value, out TEnum result) where TEnum : struct;
    public static bool TryParse<TEnum>(string? value, bool ignoreCase, out TEnum result) where TEnum : struct;
    public static string? GetName(Type enumType, object value);
    public static string[] GetNames(Type enumType);
    public static Array GetValues(Type enumType);
    public static bool IsDefined(Type enumType, object value);
    public static object Parse(Type enumType, string value);
    public static object Parse(Type enumType, string value, bool ignoreCase);
    public static bool TryParse(Type enumType, string? value, out object? result);
    public static bool TryParse(Type enumType, string? value, bool ignoreCase, out object? result);
    public static Type GetUnderlyingType(Type enumType);
    public static object ToObject(Type enumType, object value);
    public static object ToObject(Type enumType, int value);
    public static object ToObject(Type enumType, long value);
  }
  public interface IComparable { int CompareTo(object? obj); }
  public interface IComparable<in T> { int CompareTo(T? other); }
  public interface IEquatable<T> { bool Equals(T? other); }
  public interface IFormattable { string ToString(string? format, IFormatProvider? formatProvider); }
  public interface IFormatProvider { object? GetFormat(Type? formatType); }
  public interface IDisposable { void Dispose(); }
  public interface ICloneable { object Clone(); }

  public sealed class String : IComparable, IComparable<string?>, IEquatable<string?>, IEnumerable<char>, ICloneable {
    public static readonly string Empty = "";
    public static implicit operator ReadOnlySpan<char>(string? value);
    public String(char c, int count);
    public String(char[]? value);
    public String(char[] value, int startIndex, int length);
    public int Length { get; }
    public char this[int index] { get; }
    public object Clone();
    public int CompareTo(object? value);
    public int CompareTo(string? strB);
    public bool Contains(string value);
    public bool Contains(char value);
    public bool Contains(string value, StringComparison comparisonType);
    public bool Contains(char value, StringComparison comparisonType);
    public bool EndsWith(char value);
    public bool EndsWith(string value);
    public bool EndsWith(string value, StringComparison comparisonType);
    public override bool Equals(object? obj);
    public bool Equals(string? value);
    public bool Equals(string? value, StringComparison comparisonType);
    public static bool Equals(string? a, string? b);
    public static bool Equals(string? a, string? b, StringComparison comparisonType);
    public CharEnumerator GetEnumerator();
    public override int GetHashCode();
    public int IndexOf(char value);
    public int IndexOf(char value, int startIndex);
    public int IndexOf(char value, int startIndex, int count);
    public int IndexOf(string value);
    public int IndexOf(string value, int startIndex);
    public int IndexOf(string value, int startIndex, int count);
    public int IndexOf(string value, StringComparison comparisonType);
    public int IndexOf(char value, StringComparison comparisonType);
    public int IndexOf(string value, int startIndex, StringComparison comparisonType);
    public int IndexOf(string value, int startIndex, int count, StringComparison comparisonType);
    public int IndexOfAny(char[] anyOf);
    public int IndexOfAny(char[] anyOf, int startIndex);
    public string Insert(int startIndex, string value);
    public int LastIndexOf(char value);
    public int LastIndexOf(char value, int startIndex);
    public int LastIndexOf(char value, int startIndex, int count);
    public int LastIndexOf(string value);
    public int LastIndexOf(string value, int startIndex);
    public int LastIndexOf(string value, int startIndex, int count);
    public int LastIndexOf(string value, int startIndex, int count, StringComparison comparisonType);
    public int LastIndexOf(string value, int startIndex, StringComparison comparisonType);
    public int LastIndexOf(string value, StringComparison comparisonType);
    public int LastIndexOfAny(char[] anyOf);
    public string PadLeft(int totalWidth);
    public string PadLeft(int totalWidth, char paddingChar);
    public string PadRight(int totalWidth);
    public string PadRight(int totalWidth, char paddingChar);
    public string Remove(int startIndex);
    public string Remove(int startIndex, int count);
    public string Replace(char oldChar, char newChar);
    public string Replace(string oldValue, string? newValue);
    public string Replace(string oldValue, string? newValue, StringComparison comparisonType);
    public string[] Split(char separator, StringSplitOptions options = StringSplitOptions.None);
    public string[] Split(char separator, int count, StringSplitOptions options = StringSplitOptions.None);
    public string[] Split(params char[]? separator);
    public string[] Split(char[]? separator, int count);
    public string[] Split(char[]? separator, StringSplitOptions options);
    public string[] Split(char[]? separator, int count, StringSplitOptions options);
    public string[] Split(string? separator, StringSplitOptions options = StringSplitOptions.None);
    public string[] Split(string? separator, int count, StringSplitOptions options = StringSplitOptions.None);
    public string[] Split(string[]? separator, StringSplitOptions options);
    public string[] Split(string[]? separator, int count, StringSplitOptions options);
    public bool StartsWith(char value);
    public bool StartsWith(string value);
    public bool StartsWith(string value, StringComparison comparisonType);
    public string Substring(int startIndex);
    public string Substring(int startIndex, int length);
    public char[] ToCharArray();
    public char[] ToCharArray(int startIndex, int length);
    public string ToLower();
    public string ToLowerInvariant();
    public override string ToString();
    public string ToUpper();
    public string ToUpperInvariant();
    public string Trim();
    public string Trim(char trimChar);
    public string Trim(params char[]? trimChars);
    public string TrimEnd();
    public string TrimEnd(char trimChar);
    public string TrimEnd(params char[]? trimChars);
    public string TrimStart();
    public string TrimStart(char trimChar);
    public string TrimStart(params char[]? trimChars);
    public bool IsNormalized();
    public static int Compare(string? strA, string? strB);
    public static int Compare(string? strA, string? strB, bool ignoreCase);
    public static int Compare(string? strA, string? strB, StringComparison comparisonType);
    public static int Compare(string? strA, int indexA, string? strB, int indexB, int length);
    public static int CompareOrdinal(string? strA, string? strB);
    public static int CompareOrdinal(string? strA, int indexA, string? strB, int indexB, int length);
    public static string Concat(object? arg0);
    public static string Concat(object? arg0, object? arg1);
    public static string Concat(object? arg0, object? arg1, object? arg2);
    public static string Concat(params object?[] args);
    public static string Concat(string? str0, string? str1);
    public static string Concat(string? str0, string? str1, string? str2);
    public static string Concat(string? str0, string? str1, string? str2, string? str3);
    public static string Concat(params string?[] values);
    public static string Concat(IEnumerable<string?> values);
    public static string Concat<T>(IEnumerable<T> values);
    public static string Copy(string str);
    public static string Format(string format, object? arg0);
    public static string Format(string format, object? arg0, object? arg1);
    public static string Format(string format, object? arg0, object? arg1, object? arg2);
    public static string Format(string format, params object?[] args);
    public static string Format(IFormatProvider? provider, string format, object? arg0);
    public static string Format(IFormatProvider? provider, string format, object? arg0, object? arg1);
    public static string Format(IFormatProvider? provider, string format, object? arg0, object? arg1, object? arg2);
    public static string Format(IFormatProvider? provider, string format, params object?[] args);
    public static bool IsNullOrEmpty(string? value);
    public static bool IsNullOrWhiteSpace(string? value);
    public static string Join(char separator, params object?[] values);
    public static string Join(char separator, params string?[] value);
    public static string Join(string? separator, IEnumerable<string?> values);
    public static string Join(string? separator, params object?[] values);
    public static string Join(string? separator, params string?[] value);
    public static string Join(string? separator, string?[] value, int startIndex, int count);
    public static string Join<T>(char separator, IEnumerable<T> values);
    public static string Join<T>(string? separator, IEnumerable<T> values);
    public static bool operator ==(string? a, string? b);
    public static bool operator !=(string? a, string? b);
  }
  public sealed class CharEnumerator : IEnumerator<char>, IDisposable, ICloneable {
    public char Current { get; }
    public bool MoveNext();
    public void Reset();
    public void Dispose();
    public object Clone();
  }

  public struct Boolean : IComparable, IComparable<bool>, IEquatable<bool> {
    public static readonly string FalseString = "False";
    public static readonly string TrueString = "True";
    public int CompareTo(object? obj);
    public int CompareTo(bool value);
    public override bool Equals(object? obj);
    public bool Equals(bool obj);
    public override int GetHashCode();
    public override string ToString();
    public static bool Parse(string value);
    public static bool TryParse(string? value, out bool result);
  }
  public struct Char : IComparable, IComparable<char>, IEquatable<char> {
    public const char MaxValue = '￿';
    public const char MinValue = '\0';
    public int CompareTo(object? value);
    public int CompareTo(char value);
    public override bool Equals(object? obj);
    public bool Equals(char obj);
    public override int GetHashCode();
    public override string ToString();
    public static string ToString(char c);
    public static double GetNumericValue(char c);
    public static double GetNumericValue(string s, int index);
    public static bool IsAscii(char c);
    public static bool IsAsciiDigit(char c);
    public static bool IsAsciiLetter(char c);
    public static bool IsAsciiLetterOrDigit(char c);
    public static bool IsAsciiLetterLower(char c);
    public static bool IsAsciiLetterUpper(char c);
    public static bool IsAsciiHexDigit(char c);
    public static bool IsControl(char c);
    public static bool IsDigit(char c);
    public static bool IsDigit(string s, int index);
    public static bool IsLetter(char c);
    public static bool IsLetter(string s, int index);
    public static bool IsLetterOrDigit(char c);
    public static bool IsLetterOrDigit(string s, int index);
    public static bool IsLower(char c);
    public static bool IsLower(string s, int index);
    public static bool IsNumber(char c);
    public static bool IsNumber(string s, int index);
    public static bool IsPunctuation(char c);
    public static bool IsPunctuation(string s, int index);
    public static bool IsSeparator(char c);
    public static bool IsSeparator(string s, int index);
    public static bool IsSurrogate(char c);
    public static bool IsSurrogate(string s, int index);
    public static bool IsHighSurrogate(char c);
    public static bool IsHighSurrogate(string s, int index);
    public static bool IsLowSurrogate(char c);
    public static bool IsLowSurrogate(string s, int index);
    public static bool IsSymbol(char c);
    public static bool IsSymbol(string s, int index);
    public static bool IsControl(string s, int index);
    public static bool IsUpper(char c);
    public static bool IsUpper(string s, int index);
    public static bool IsWhiteSpace(char c);
    public static bool IsWhiteSpace(string s, int index);
    public static bool IsBetween(char c, char minInclusive, char maxInclusive);
    public static char Parse(string s);
    public static bool TryParse(string? s, out char result);
    public static char ToLower(char c);
    public static char ToLowerInvariant(char c);
    public static char ToUpper(char c);
    public static char ToUpperInvariant(char c);
    public static string ConvertFromUtf32(int utf32);
    public static int ConvertToUtf32(char highSurrogate, char lowSurrogate);
    public static int ConvertToUtf32(string s, int index);
  }
` +
  [
    'SByte:sbyte:-128:127',
    'Byte:byte:0:255',
    'Int16:short:-32768:32767',
    'UInt16:ushort:0:65535',
    'Int32:int:-2147483648:2147483647',
    'UInt32:uint:0:4294967295U',
    'Int64:long:-9223372036854775808L:9223372036854775807L',
    'UInt64:ulong:0:18446744073709551615UL',
  ]
    .map((entry) => {
      const [name, keyword, min, max] = entry.split(':');
      const minValue =
        min === '-9223372036854775808L' ? '-9223372036854775807L - 1' : min === '-2147483648' ? '-2147483647 - 1' : min;
      return String.raw`
  public struct ${name} : IComparable, IComparable<${keyword}>, IEquatable<${keyword}>, IFormattable {
    public const ${keyword} MaxValue = ${max};
    public const ${keyword} MinValue = ${minValue};
    public int CompareTo(object? value);
    public int CompareTo(${keyword} value);
    public override bool Equals(object? obj);
    public bool Equals(${keyword} obj);
    public override int GetHashCode();
    public override string ToString();
    public string ToString(string? format);
    public string ToString(IFormatProvider? provider);
    public string ToString(string? format, IFormatProvider? provider);
    public static ${keyword} Parse(string s);
    public static ${keyword} Parse(string s, IFormatProvider? provider);
    public static ${keyword} Parse(string s, System.Globalization.NumberStyles style);
    public static ${keyword} Parse(string s, System.Globalization.NumberStyles style, IFormatProvider? provider);
    public static bool TryParse(string? s, out ${keyword} result);
    public static bool TryParse(string? s, IFormatProvider? provider, out ${keyword} result);
    public static bool TryParse(string? s, System.Globalization.NumberStyles style, IFormatProvider? provider, out ${keyword} result);
    public static ${keyword} Abs(${keyword} value);
    public static ${keyword} Clamp(${keyword} value, ${keyword} min, ${keyword} max);
    public static ${keyword} Max(${keyword} x, ${keyword} y);
    public static ${keyword} Min(${keyword} x, ${keyword} y);
    public static int Sign(${keyword} value);
    public static bool IsEvenInteger(${keyword} value);
    public static bool IsOddInteger(${keyword} value);
    public static bool IsPow2(${keyword} value);
    public static ${keyword} PopCount(${keyword} value);
    public static ${keyword} LeadingZeroCount(${keyword} value);
    public static ${keyword} TrailingZeroCount(${keyword} value);
    public static ${keyword} Log2(${keyword} value);
    public static ${keyword} RotateLeft(${keyword} value, int rotateAmount);
    public static ${keyword} RotateRight(${keyword} value, int rotateAmount);
    public static bool IsNegative(${keyword} value);
    public static bool IsPositive(${keyword} value);
    public static (${keyword} Quotient, ${keyword} Remainder) DivRem(${keyword} left, ${keyword} right);
    public static ${keyword} CopySign(${keyword} value, ${keyword} sign);
  }`;
    })
    .join('\n') +
  String.raw`
  public struct Single : IComparable, IComparable<float>, IEquatable<float>, IFormattable {
    public const float MaxValue = 3.40282347E+38f;
    public const float MinValue = -3.40282347E+38f;
    public const float Epsilon = 1.401298E-45f;
    public const float NaN = 0.0f / 0.0f;
    public const float PositiveInfinity = 1.0f / 0.0f;
    public const float NegativeInfinity = -1.0f / 0.0f;
    public const float Pi = 3.14159274f;
    public const float E = 2.71828175f;
    public const float Tau = 6.28318548f;
    public int CompareTo(object? value);
    public int CompareTo(float value);
    public override bool Equals(object? obj);
    public bool Equals(float obj);
    public override int GetHashCode();
    public override string ToString();
    public string ToString(string? format);
    public string ToString(IFormatProvider? provider);
    public string ToString(string? format, IFormatProvider? provider);
    public static float Parse(string s);
    public static float Parse(string s, IFormatProvider? provider);
    public static float Parse(string s, System.Globalization.NumberStyles style);
    public static float Parse(string s, System.Globalization.NumberStyles style, IFormatProvider? provider);
    public static bool TryParse(string? s, out float result);
    public static bool TryParse(string? s, IFormatProvider? provider, out float result);
    public static bool TryParse(string? s, System.Globalization.NumberStyles style, IFormatProvider? provider, out float result);
    public static bool IsNaN(float f);
    public static bool IsInfinity(float f);
    public static bool IsPositiveInfinity(float f);
    public static bool IsNegativeInfinity(float f);
    public static bool IsFinite(float f);
    public static bool IsNegative(float f);
    public static bool IsInteger(float f);
    public static float Abs(float value);
    public static float Max(float x, float y);
    public static float Min(float x, float y);
    public static float Clamp(float value, float min, float max);
    public static float Round(float x);
    public static float Floor(float x);
    public static float Ceiling(float x);
    public static float Truncate(float x);
    public static float Sqrt(float x);
    public static float Pow(float x, float y);
  }
  public struct Double : IComparable, IComparable<double>, IEquatable<double>, IFormattable {
    public const double MaxValue = 1.7976931348623157E+308;
    public const double MinValue = -1.7976931348623157E+308;
    public const double Epsilon = 4.9406564584124654E-324;
    public const double NaN = 0.0 / 0.0;
    public const double PositiveInfinity = 1.0 / 0.0;
    public const double NegativeInfinity = -1.0 / 0.0;
    public const double Pi = 3.1415926535897931;
    public const double E = 2.7182818284590451;
    public const double Tau = 6.2831853071795862;
    public int CompareTo(object? value);
    public int CompareTo(double value);
    public override bool Equals(object? obj);
    public bool Equals(double obj);
    public override int GetHashCode();
    public override string ToString();
    public string ToString(string? format);
    public string ToString(IFormatProvider? provider);
    public string ToString(string? format, IFormatProvider? provider);
    public static double Parse(string s);
    public static double Parse(string s, IFormatProvider? provider);
    public static double Parse(string s, System.Globalization.NumberStyles style);
    public static double Parse(string s, System.Globalization.NumberStyles style, IFormatProvider? provider);
    public static bool TryParse(string? s, out double result);
    public static bool TryParse(string? s, IFormatProvider? provider, out double result);
    public static bool TryParse(string? s, System.Globalization.NumberStyles style, IFormatProvider? provider, out double result);
    public static bool IsNaN(double d);
    public static bool IsInfinity(double d);
    public static bool IsPositiveInfinity(double d);
    public static bool IsNegativeInfinity(double d);
    public static bool IsFinite(double d);
    public static bool IsNegative(double d);
    public static bool IsInteger(double d);
    public static double Abs(double value);
    public static double Max(double x, double y);
    public static double Min(double x, double y);
    public static double Clamp(double value, double min, double max);
    public static double Round(double x);
    public static double Floor(double x);
    public static double Ceiling(double x);
    public static double Truncate(double x);
    public static double Sqrt(double x);
    public static double Pow(double x, double y);
  }
  public struct Decimal : IComparable, IComparable<decimal>, IEquatable<decimal>, IFormattable {
    public const decimal MaxValue = 79228162514264337593543950335m;
    public const decimal MinValue = -79228162514264337593543950335m;
    public const decimal One = 1m;
    public const decimal Zero = 0m;
    public const decimal MinusOne = -1m;
    public Decimal(int value);
    public Decimal(long value);
    public Decimal(double value);
    public Decimal(float value);
    public Decimal(uint value);
    public Decimal(ulong value);
    public int CompareTo(object? value);
    public int CompareTo(decimal value);
    public override bool Equals(object? value);
    public bool Equals(decimal value);
    public override int GetHashCode();
    public override string ToString();
    public string ToString(string? format);
    public string ToString(IFormatProvider? provider);
    public string ToString(string? format, IFormatProvider? provider);
    public static decimal Parse(string s);
    public static decimal Parse(string s, IFormatProvider? provider);
    public static decimal Parse(string s, System.Globalization.NumberStyles style);
    public static decimal Parse(string s, System.Globalization.NumberStyles style, IFormatProvider? provider);
    public static bool TryParse(string? s, out decimal result);
    public static bool TryParse(string? s, IFormatProvider? provider, out decimal result);
    public static bool TryParse(string? s, System.Globalization.NumberStyles style, IFormatProvider? provider, out decimal result);
    public static decimal Abs(decimal value);
    public static decimal Max(decimal x, decimal y);
    public static decimal Min(decimal x, decimal y);
    public static decimal Clamp(decimal value, decimal min, decimal max);
    public static decimal Add(decimal d1, decimal d2);
    public static decimal Subtract(decimal d1, decimal d2);
    public static decimal Multiply(decimal d1, decimal d2);
    public static decimal Divide(decimal d1, decimal d2);
    public static decimal Remainder(decimal d1, decimal d2);
    public static decimal Negate(decimal d);
    public static decimal Round(decimal d);
    public static decimal Round(decimal d, int decimals);
    public static decimal Round(decimal d, MidpointRounding mode);
    public static decimal Round(decimal d, int decimals, MidpointRounding mode);
    public static decimal Floor(decimal d);
    public static decimal Ceiling(decimal d);
    public static decimal Truncate(decimal d);
    public static int Sign(decimal d);
    public static int ToInt32(decimal d);
    public static long ToInt64(decimal d);
    public static double ToDouble(decimal d);
  }
  public struct Nullable<T> where T : struct {
    public Nullable(T value);
    public bool HasValue { get; }
    public T Value { get; }
    public T GetValueOrDefault();
    public T GetValueOrDefault(T defaultValue);
    public override bool Equals(object? other);
    public override int GetHashCode();
    public override string? ToString();
  }

  public abstract class StringComparer : IComparer<string?>, IEqualityComparer<string?> {
    public static StringComparer Ordinal { get; }
    public static StringComparer OrdinalIgnoreCase { get; }
    public static StringComparer CurrentCulture { get; }
    public static StringComparer CurrentCultureIgnoreCase { get; }
    public static StringComparer InvariantCulture { get; }
    public static StringComparer InvariantCultureIgnoreCase { get; }
    public int Compare(string? x, string? y);
    public bool Equals(string? x, string? y);
    public int GetHashCode(string obj);
  }
  public enum StringComparison { CurrentCulture = 0, CurrentCultureIgnoreCase = 1, InvariantCulture = 2, InvariantCultureIgnoreCase = 3, Ordinal = 4, OrdinalIgnoreCase = 5 }
  public enum StringSplitOptions { None = 0, RemoveEmptyEntries = 1, TrimEntries = 2 }
  public enum MidpointRounding { ToEven = 0, AwayFromZero = 1, ToZero = 2, ToNegativeInfinity = 3, ToPositiveInfinity = 4 }
  public enum DayOfWeek { Sunday = 0, Monday = 1, Tuesday = 2, Wednesday = 3, Thursday = 4, Friday = 5, Saturday = 6 }

  public readonly struct Index : IEquatable<Index> {
    private readonly int _value;
    public Index(int value, bool fromEnd = false);
    public static Index Start { get; }
    public static Index End { get; }
    public static Index FromStart(int value);
    public static Index FromEnd(int value);
    public int Value { get; }
    public bool IsFromEnd { get; }
    public int GetOffset(int length);
    public override bool Equals(object? value);
    public bool Equals(Index other);
    public override int GetHashCode();
    public static implicit operator Index(int value);
    public override string ToString();
  }

  public readonly struct Range : IEquatable<Range> {
    private readonly Index _start;
    private readonly Index _end;
    public Range(Index start, Index end);
    public Index Start { get; }
    public Index End { get; }
    public static Range All { get; }
    public static Range StartAt(Index start);
    public static Range EndAt(Index end);
    public (int Offset, int Length) GetOffsetAndLength(int length);
    public override bool Equals(object? value);
    public bool Equals(Range other);
    public override int GetHashCode();
    public override string ToString();
  }

  public abstract class Attribute { protected Attribute(); }
  [Flags]
  public enum AttributeTargets { Assembly = 1, Module = 2, Class = 4, Struct = 8, Enum = 16, Constructor = 32, Method = 64, Property = 128, Field = 256, Event = 512, Interface = 1024, Parameter = 2048, Delegate = 4096, ReturnValue = 8192, GenericParameter = 16384, All = 32767 }
  [AttributeUsage(AttributeTargets.Class, Inherited = true)]
  public sealed class AttributeUsageAttribute : Attribute {
    public AttributeUsageAttribute(AttributeTargets validOn);
    public bool AllowMultiple { get; set; }
    public bool Inherited { get; set; }
    public AttributeTargets ValidOn { get; }
  }
  [AttributeUsage(AttributeTargets.Enum, Inherited = false)]
  public class FlagsAttribute : Attribute { public FlagsAttribute(); }
  [AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Enum | AttributeTargets.Constructor | AttributeTargets.Method | AttributeTargets.Property | AttributeTargets.Field | AttributeTargets.Event | AttributeTargets.Interface | AttributeTargets.Delegate, Inherited = false)]
  public sealed class ObsoleteAttribute : Attribute {
    public ObsoleteAttribute();
    public ObsoleteAttribute(string? message);
    public ObsoleteAttribute(string? message, bool error);
    public string? Message { get; }
    public bool IsError { get; }
    public string? DiagnosticId { get; set; }
    public string? UrlFormat { get; set; }
  }
  [AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Enum | AttributeTargets.Delegate, Inherited = false)]
  public sealed class SerializableAttribute : Attribute { public SerializableAttribute(); }
  [AttributeUsage(AttributeTargets.Field, Inherited = false)]
  public sealed class NonSerializedAttribute : Attribute { public NonSerializedAttribute(); }
  [AttributeUsage(AttributeTargets.All, Inherited = true)]
  public sealed class CLSCompliantAttribute : Attribute {
    public CLSCompliantAttribute(bool isCompliant);
    public bool IsCompliant { get; }
  }

  public struct HashCode {
    public static int Combine<T1>(T1 value1);
    public static int Combine<T1, T2>(T1 value1, T2 value2);
    public static int Combine<T1, T2, T3>(T1 value1, T2 value2, T3 value3);
    public static int Combine<T1, T2, T3, T4>(T1 value1, T2 value2, T3 value3, T4 value4);
    public static int Combine<T1, T2, T3, T4, T5>(T1 value1, T2 value2, T3 value3, T4 value4, T5 value5);
    public static int Combine<T1, T2, T3, T4, T5, T6>(T1 value1, T2 value2, T3 value3, T4 value4, T5 value5, T6 value6);
    public static int Combine<T1, T2, T3, T4, T5, T6, T7>(T1 value1, T2 value2, T3 value3, T4 value4, T5 value5, T6 value6, T7 value7);
    public static int Combine<T1, T2, T3, T4, T5, T6, T7, T8>(T1 value1, T2 value2, T3 value3, T4 value4, T5 value5, T6 value6, T7 value7, T8 value8);
  }

  public static class Math {
    public const double E = 2.7182818284590451;
    public const double PI = 3.1415926535897931;
    public const double Tau = 6.2831853071795862;
    public static decimal Abs(decimal value);
    public static double Abs(double value);
    public static short Abs(short value);
    public static int Abs(int value);
    public static long Abs(long value);
    public static sbyte Abs(sbyte value);
    public static float Abs(float value);
    public static double Acos(double d);
    public static double Acosh(double d);
    public static double Asin(double d);
    public static double Asinh(double d);
    public static double Atan(double d);
    public static double Atan2(double y, double x);
    public static double Atanh(double d);
    public static long BigMul(int a, int b);
    public static ulong BigMul(uint a, uint b);
    public static long BigMul(long a, long b, out long low);
    public static ulong BigMul(ulong a, ulong b, out ulong low);
    public static double Cbrt(double d);
    public static decimal Ceiling(decimal d);
    public static double Ceiling(double a);
    public static byte Clamp(byte value, byte min, byte max);
    public static decimal Clamp(decimal value, decimal min, decimal max);
    public static double Clamp(double value, double min, double max);
    public static short Clamp(short value, short min, short max);
    public static int Clamp(int value, int min, int max);
    public static long Clamp(long value, long min, long max);
    public static sbyte Clamp(sbyte value, sbyte min, sbyte max);
    public static float Clamp(float value, float min, float max);
    public static ushort Clamp(ushort value, ushort min, ushort max);
    public static uint Clamp(uint value, uint min, uint max);
    public static ulong Clamp(ulong value, ulong min, ulong max);
    public static double CopySign(double x, double y);
    public static double Cos(double d);
    public static double Cosh(double value);
    public static int DivRem(int a, int b, out int result);
    public static long DivRem(long a, long b, out long result);
    public static (int Quotient, int Remainder) DivRem(int left, int right);
    public static (long Quotient, long Remainder) DivRem(long left, long right);
    public static double Exp(double d);
    public static decimal Floor(decimal d);
    public static double Floor(double d);
    public static double FusedMultiplyAdd(double x, double y, double z);
    public static double IEEERemainder(double x, double y);
    public static double Log(double d);
    public static double Log(double a, double newBase);
    public static double Log10(double d);
    public static double Log2(double x);
    public static byte Max(byte val1, byte val2);
    public static decimal Max(decimal val1, decimal val2);
    public static double Max(double val1, double val2);
    public static short Max(short val1, short val2);
    public static int Max(int val1, int val2);
    public static long Max(long val1, long val2);
    public static sbyte Max(sbyte val1, sbyte val2);
    public static float Max(float val1, float val2);
    public static ushort Max(ushort val1, ushort val2);
    public static uint Max(uint val1, uint val2);
    public static ulong Max(ulong val1, ulong val2);
    public static byte Min(byte val1, byte val2);
    public static decimal Min(decimal val1, decimal val2);
    public static double Min(double val1, double val2);
    public static short Min(short val1, short val2);
    public static int Min(int val1, int val2);
    public static long Min(long val1, long val2);
    public static sbyte Min(sbyte val1, sbyte val2);
    public static float Min(float val1, float val2);
    public static ushort Min(ushort val1, ushort val2);
    public static uint Min(uint val1, uint val2);
    public static ulong Min(ulong val1, ulong val2);
    public static double Pow(double x, double y);
    public static decimal Round(decimal d);
    public static decimal Round(decimal d, int decimals);
    public static decimal Round(decimal d, int decimals, MidpointRounding mode);
    public static decimal Round(decimal d, MidpointRounding mode);
    public static double Round(double a);
    public static double Round(double value, int digits);
    public static double Round(double value, int digits, MidpointRounding mode);
    public static double Round(double value, MidpointRounding mode);
    public static int Sign(decimal value);
    public static int Sign(double value);
    public static int Sign(short value);
    public static int Sign(int value);
    public static int Sign(long value);
    public static int Sign(sbyte value);
    public static int Sign(float value);
    public static double Sin(double a);
    public static double Sinh(double value);
    public static double Sqrt(double d);
    public static double Tan(double a);
    public static double Tanh(double value);
    public static decimal Truncate(decimal d);
    public static double Truncate(double d);
  }

  public static class Console {
    public static System.IO.TextWriter Out { get; }
    public static System.IO.TextWriter Error { get; }
    public static System.IO.TextReader In { get; }
    public static string? ReadLine();
    public static int Read();
    public static ConsoleKeyInfo ReadKey();
    public static ConsoleKeyInfo ReadKey(bool intercept);
    public static bool KeyAvailable { get; }
    public static bool IsInputRedirected { get; }
    public static bool IsOutputRedirected { get; }
    public static bool IsErrorRedirected { get; }
    public static void Clear();
    public static void Beep();
    public static void Beep(int frequency, int duration);
    public static void ResetColor();
    public static ConsoleColor ForegroundColor { get; set; }
    public static ConsoleColor BackgroundColor { get; set; }
    public static string Title { get; set; }
    public static bool CursorVisible { get; set; }
    public static int CursorLeft { get; set; }
    public static int CursorTop { get; set; }
    public static (int Left, int Top) GetCursorPosition();
    public static void SetCursorPosition(int left, int top);
    public static System.Text.Encoding OutputEncoding { get; set; }
    public static void Write(bool value);
    public static void Write(char value);
    public static void Write(char[]? buffer);
    public static void Write(char[] buffer, int index, int count);
    public static void Write(decimal value);
    public static void Write(double value);
    public static void Write(int value);
    public static void Write(long value);
    public static void Write(object? value);
    public static void Write(float value);
    public static void Write(string? value);
    public static void Write(string format, object? arg0);
    public static void Write(string format, object? arg0, object? arg1);
    public static void Write(string format, object? arg0, object? arg1, object? arg2);
    public static void Write(string format, params object?[]? arg);
    public static void Write(uint value);
    public static void Write(ulong value);
    public static void WriteLine();
    public static void WriteLine(bool value);
    public static void WriteLine(char value);
    public static void WriteLine(char[]? buffer);
    public static void WriteLine(char[] buffer, int index, int count);
    public static void WriteLine(decimal value);
    public static void WriteLine(double value);
    public static void WriteLine(int value);
    public static void WriteLine(long value);
    public static void WriteLine(object? value);
    public static void WriteLine(float value);
    public static void WriteLine(string? value);
    public static void WriteLine(string format, object? arg0);
    public static void WriteLine(string format, object? arg0, object? arg1);
    public static void WriteLine(string format, object? arg0, object? arg1, object? arg2);
    public static void WriteLine(string format, params object?[]? arg);
    public static void WriteLine(uint value);
    public static void WriteLine(ulong value);
  }
  public enum ConsoleColor { Black = 0, DarkBlue = 1, DarkGreen = 2, DarkCyan = 3, DarkRed = 4, DarkMagenta = 5, DarkYellow = 6, Gray = 7, DarkGray = 8, Blue = 9, Green = 10, Cyan = 11, Red = 12, Magenta = 13, Yellow = 14, White = 15 }
  public readonly struct ConsoleKeyInfo : IEquatable<ConsoleKeyInfo> {
    private readonly char _keyChar;
    private readonly ConsoleKey _key;
    private readonly ConsoleModifiers _mods;
    public ConsoleKeyInfo(char keyChar, ConsoleKey key, bool shift, bool alt, bool control);
    public char KeyChar { get; }
    public ConsoleKey Key { get; }
    public ConsoleModifiers Modifiers { get; }
    public override bool Equals(object? value);
    public bool Equals(ConsoleKeyInfo obj);
    public override int GetHashCode();
    public static bool operator ==(ConsoleKeyInfo a, ConsoleKeyInfo b);
    public static bool operator !=(ConsoleKeyInfo a, ConsoleKeyInfo b);
  }
  public enum ConsoleKey { None = 0, Backspace = 8, Tab = 9, Clear = 12, Enter = 13, Pause = 19, Escape = 27, Spacebar = 32, PageUp = 33, PageDown = 34, End = 35, Home = 36, LeftArrow = 37, UpArrow = 38, RightArrow = 39, DownArrow = 40, Select = 41, Print = 42, Execute = 43, PrintScreen = 44, Insert = 45, Delete = 46, Help = 47, D0 = 48, D1 = 49, D2 = 50, D3 = 51, D4 = 52, D5 = 53, D6 = 54, D7 = 55, D8 = 56, D9 = 57, A = 65, B = 66, C = 67, D = 68, E = 69, F = 70, G = 71, H = 72, I = 73, J = 74, K = 75, L = 76, M = 77, N = 78, O = 79, P = 80, Q = 81, R = 82, S = 83, T = 84, U = 85, V = 86, W = 87, X = 88, Y = 89, Z = 90, LeftWindows = 91, RightWindows = 92, Applications = 93, Sleep = 95, NumPad0 = 96, NumPad1 = 97, NumPad2 = 98, NumPad3 = 99, NumPad4 = 100, NumPad5 = 101, NumPad6 = 102, NumPad7 = 103, NumPad8 = 104, NumPad9 = 105, Multiply = 106, Add = 107, Separator = 108, Subtract = 109, Decimal = 110, Divide = 111, F1 = 112, F2 = 113, F3 = 114, F4 = 115, F5 = 116, F6 = 117, F7 = 118, F8 = 119, F9 = 120, F10 = 121, F11 = 122, F12 = 123, F13 = 124, F14 = 125, F15 = 126, F16 = 127, F17 = 128, F18 = 129, F19 = 130, F20 = 131, F21 = 132, F22 = 133, F23 = 134, F24 = 135, BrowserBack = 166, BrowserForward = 167, BrowserRefresh = 168, BrowserStop = 169, BrowserSearch = 170, BrowserFavorites = 171, BrowserHome = 172, VolumeMute = 173, VolumeDown = 174, VolumeUp = 175, MediaNext = 176, MediaPrevious = 177, MediaStop = 178, MediaPlay = 179, LaunchMail = 180, LaunchMediaSelect = 181, LaunchApp1 = 182, LaunchApp2 = 183, Oem1 = 186, OemPlus = 187, OemComma = 188, OemMinus = 189, OemPeriod = 190, Oem2 = 191, Oem3 = 192, Oem4 = 219, Oem5 = 220, Oem6 = 221, Oem7 = 222, Oem8 = 223, Oem102 = 226, Process = 229, Packet = 231, Attention = 246, CrSel = 247, ExSel = 248, EraseEndOfFile = 249, Play = 250, Zoom = 251, NoName = 252, Pa1 = 253, OemClear = 254 }
  [Flags]
  public enum ConsoleModifiers { None = 0, Alt = 1, Shift = 2, Control = 4 }

  public static class Convert {
    public static bool ToBoolean(object? value);
    public static bool ToBoolean(string? value);
    public static bool ToBoolean(int value);
    public static bool ToBoolean(double value);
    public static bool ToBoolean(char value);
    public static bool ToBoolean(bool value);
    public static bool ToBoolean(sbyte value);
    public static bool ToBoolean(byte value);
    public static bool ToBoolean(short value);
    public static bool ToBoolean(ushort value);
    public static bool ToBoolean(uint value);
    public static bool ToBoolean(long value);
    public static bool ToBoolean(ulong value);
    public static bool ToBoolean(float value);
    public static bool ToBoolean(decimal value);
    public static char ToChar(int value);
    public static char ToChar(object? value);
    public static char ToChar(string value);
    public static char ToChar(byte value);
    public static char ToChar(long value);
    public static char ToChar(bool value);
    public static char ToChar(double value);
    public static char ToChar(char value);
    public static char ToChar(sbyte value);
    public static char ToChar(short value);
    public static char ToChar(ushort value);
    public static char ToChar(uint value);
    public static char ToChar(ulong value);
    public static char ToChar(float value);
    public static char ToChar(decimal value);
    public static byte ToByte(object? value);
    public static byte ToByte(string? value);
    public static byte ToByte(string? value, int fromBase);
    public static byte ToByte(string? value, IFormatProvider? provider);
    public static byte ToByte(int value);
    public static byte ToByte(double value);
    public static byte ToByte(char value);
    public static byte ToByte(bool value);
    public static byte ToByte(byte value);
    public static byte ToByte(sbyte value);
    public static byte ToByte(short value);
    public static byte ToByte(ushort value);
    public static byte ToByte(uint value);
    public static byte ToByte(long value);
    public static byte ToByte(ulong value);
    public static byte ToByte(float value);
    public static byte ToByte(decimal value);
    public static sbyte ToSByte(object? value);
    public static sbyte ToSByte(string? value);
    public static sbyte ToSByte(string? value, int fromBase);
    public static sbyte ToSByte(string? value, IFormatProvider? provider);
    public static sbyte ToSByte(int value);
    public static sbyte ToSByte(double value);
    public static sbyte ToSByte(bool value);
    public static sbyte ToSByte(sbyte value);
    public static sbyte ToSByte(char value);
    public static sbyte ToSByte(byte value);
    public static sbyte ToSByte(short value);
    public static sbyte ToSByte(ushort value);
    public static sbyte ToSByte(uint value);
    public static sbyte ToSByte(long value);
    public static sbyte ToSByte(ulong value);
    public static sbyte ToSByte(float value);
    public static sbyte ToSByte(decimal value);
    public static short ToInt16(object? value);
    public static short ToInt16(string? value);
    public static short ToInt16(string? value, int fromBase);
    public static short ToInt16(string? value, IFormatProvider? provider);
    public static short ToInt16(int value);
    public static short ToInt16(double value);
    public static short ToInt16(bool value);
    public static short ToInt16(char value);
    public static short ToInt16(sbyte value);
    public static short ToInt16(byte value);
    public static short ToInt16(ushort value);
    public static short ToInt16(uint value);
    public static short ToInt16(short value);
    public static short ToInt16(long value);
    public static short ToInt16(ulong value);
    public static short ToInt16(float value);
    public static short ToInt16(decimal value);
    public static int ToInt32(object? value);
    public static int ToInt32(bool value);
    public static int ToInt32(char value);
    public static int ToInt32(byte value);
    public static int ToInt32(short value);
    public static int ToInt32(int value);
    public static int ToInt32(long value);
    public static int ToInt32(uint value);
    public static int ToInt32(ulong value);
    public static int ToInt32(float value);
    public static int ToInt32(double value);
    public static int ToInt32(decimal value);
    public static int ToInt32(string? value);
    public static int ToInt32(string? value, int fromBase);
    public static int ToInt32(string? value, IFormatProvider? provider);
    public static int ToInt32(sbyte value);
    public static int ToInt32(ushort value);
    public static long ToInt64(object? value);
    public static long ToInt64(bool value);
    public static long ToInt64(char value);
    public static long ToInt64(byte value);
    public static long ToInt64(short value);
    public static long ToInt64(int value);
    public static long ToInt64(uint value);
    public static long ToInt64(ulong value);
    public static long ToInt64(long value);
    public static long ToInt64(float value);
    public static long ToInt64(double value);
    public static long ToInt64(decimal value);
    public static long ToInt64(string? value);
    public static long ToInt64(string? value, int fromBase);
    public static long ToInt64(string? value, IFormatProvider? provider);
    public static long ToInt64(sbyte value);
    public static long ToInt64(ushort value);
    public static double ToDouble(object? value);
    public static double ToDouble(bool value);
    public static double ToDouble(char value);
    public static double ToDouble(byte value);
    public static double ToDouble(short value);
    public static double ToDouble(int value);
    public static double ToDouble(uint value);
    public static double ToDouble(ulong value);
    public static double ToDouble(long value);
    public static double ToDouble(float value);
    public static double ToDouble(double value);
    public static double ToDouble(decimal value);
    public static double ToDouble(string? value);
    public static double ToDouble(string? value, IFormatProvider? provider);
    public static double ToDouble(sbyte value);
    public static double ToDouble(ushort value);
    public static float ToSingle(object? value);
    public static float ToSingle(double value);
    public static float ToSingle(char value);
    public static float ToSingle(string? value);
    public static float ToSingle(string? value, IFormatProvider? provider);
    public static float ToSingle(sbyte value);
    public static float ToSingle(byte value);
    public static float ToSingle(short value);
    public static float ToSingle(ushort value);
    public static float ToSingle(int value);
    public static float ToSingle(uint value);
    public static float ToSingle(long value);
    public static float ToSingle(ulong value);
    public static float ToSingle(float value);
    public static float ToSingle(decimal value);
    public static float ToSingle(bool value);
    public static decimal ToDecimal(object? value);
    public static decimal ToDecimal(byte value);
    public static decimal ToDecimal(short value);
    public static decimal ToDecimal(int value);
    public static decimal ToDecimal(uint value);
    public static decimal ToDecimal(ulong value);
    public static decimal ToDecimal(char value);
    public static decimal ToDecimal(long value);
    public static decimal ToDecimal(double value);
    public static decimal ToDecimal(float value);
    public static decimal ToDecimal(string? value);
    public static decimal ToDecimal(string? value, IFormatProvider? provider);
    public static decimal ToDecimal(sbyte value);
    public static decimal ToDecimal(ushort value);
    public static decimal ToDecimal(decimal value);
    public static decimal ToDecimal(bool value);
    public static string ToString(object? value);
    public static string? ToString(string? value);
    public static string ToString(bool value);
    public static string ToString(char value);
    public static string ToString(byte value);
    public static string ToString(short value);
    public static string ToString(int value);
    public static string ToString(uint value);
    public static string ToString(long value);
    public static string ToString(ulong value);
    public static string ToString(float value);
    public static string ToString(double value);
    public static string ToString(decimal value);
    public static string ToString(object? value, IFormatProvider? provider);
    public static string ToString(int value, IFormatProvider? provider);
    public static string ToString(long value, IFormatProvider? provider);
    public static string ToString(float value, IFormatProvider? provider);
    public static string ToString(double value, IFormatProvider? provider);
    public static string ToString(decimal value, IFormatProvider? provider);
    public static string ToString(byte value, int toBase);
    public static string ToString(short value, int toBase);
    public static string ToString(int value, int toBase);
    public static string ToString(sbyte value);
    public static string ToString(ushort value);
    public static string ToString(long value, int toBase);
  }

  public class Random {
    public Random();
    public Random(int Seed);
    public static Random Shared { get; }
    public virtual int Next();
    public virtual int Next(int maxValue);
    public virtual int Next(int minValue, int maxValue);
    public virtual long NextInt64();
    public virtual long NextInt64(long maxValue);
    public virtual long NextInt64(long minValue, long maxValue);
    public virtual double NextDouble();
    public virtual float NextSingle();
    public virtual void NextBytes(byte[] buffer);
    public void Shuffle<T>(T[] values);
    public T[] GetItems<T>(T[] choices, int length);
  }

  public static class Environment {
    public static string NewLine { get; }
    public static int TickCount { get; }
    public static long TickCount64 { get; }
    public static void Exit(int exitCode);
  }

  public abstract class Delegate : ICloneable {
    public object Clone();
    public object? DynamicInvoke(params object?[]? args);
    public override bool Equals(object? obj);
    public override int GetHashCode();
    public static Delegate? Combine(Delegate? a, Delegate? b);
    public static Delegate? Remove(Delegate? source, Delegate? value);
    public Delegate[] GetInvocationList();
  }
  public abstract class MulticastDelegate : Delegate { }
  public delegate void Action();
  public delegate void Action<in T>(T obj);
  public delegate void Action<in T1, in T2>(T1 arg1, T2 arg2);
  public delegate void Action<in T1, in T2, in T3>(T1 arg1, T2 arg2, T3 arg3);
  public delegate void Action<in T1, in T2, in T3, in T4>(T1 arg1, T2 arg2, T3 arg3, T4 arg4);
  public delegate void Action<in T1, in T2, in T3, in T4, in T5>(T1 arg1, T2 arg2, T3 arg3, T4 arg4, T5 arg5);
  public delegate void Action<in T1, in T2, in T3, in T4, in T5, in T6>(T1 arg1, T2 arg2, T3 arg3, T4 arg4, T5 arg5, T6 arg6);
  public delegate TResult Func<out TResult>();
  public delegate TResult Func<in T, out TResult>(T arg);
  public delegate TResult Func<in T1, in T2, out TResult>(T1 arg1, T2 arg2);
  public delegate TResult Func<in T1, in T2, in T3, out TResult>(T1 arg1, T2 arg2, T3 arg3);
  public delegate TResult Func<in T1, in T2, in T3, in T4, out TResult>(T1 arg1, T2 arg2, T3 arg3, T4 arg4);
  public delegate TResult Func<in T1, in T2, in T3, in T4, in T5, out TResult>(T1 arg1, T2 arg2, T3 arg3, T4 arg4, T5 arg5);
  public delegate TResult Func<in T1, in T2, in T3, in T4, in T5, in T6, out TResult>(T1 arg1, T2 arg2, T3 arg3, T4 arg4, T5 arg5, T6 arg6);
  public delegate bool Predicate<in T>(T obj);
  public delegate int Comparison<in T>(T x, T y);
  public delegate TOutput Converter<in TInput, out TOutput>(TInput input);
  public delegate void EventHandler(object? sender, EventArgs e);
  public delegate void EventHandler<TEventArgs>(object? sender, TEventArgs e);
  public class EventArgs {
    public static readonly EventArgs Empty = new EventArgs();
    public EventArgs();
  }

  public class Exception {
    public Exception();
    public Exception(string? message);
    public Exception(string? message, Exception? innerException);
    public virtual string Message { get; }
    public Exception? InnerException { get; }
    public virtual string? StackTrace { get; }
    public virtual string? Source { get; set; }
    public string? HelpLink { get; set; }
    public int HResult { get; set; }
    public virtual Exception GetBaseException();
    public override string ToString();
  }
` +
  [
    'SystemException:Exception',
    'ApplicationException:Exception',
    'ArithmeticException:SystemException',
    'DivideByZeroException:ArithmeticException',
    'OverflowException:ArithmeticException',
    'NotFiniteNumberException:ArithmeticException',
    'FormatException:SystemException',
    'IndexOutOfRangeException:SystemException',
    'InvalidCastException:SystemException',
    'InvalidOperationException:SystemException',
    'ObjectDisposedException:InvalidOperationException',
    'NotImplementedException:SystemException',
    'NotSupportedException:SystemException',
    'NullReferenceException:SystemException',
    'OutOfMemoryException:SystemException',
    'InsufficientExecutionStackException:SystemException',
    'RankException:SystemException',
    'ArrayTypeMismatchException:SystemException',
    'TimeoutException:SystemException',
    'PlatformNotSupportedException:NotSupportedException',
    'TypeInitializationException:SystemException',
    'EntryPointNotFoundException:SystemException',
    'MemberAccessException:SystemException',
    'MissingMemberException:MemberAccessException',
  ]
    .map((entry) => {
      const [name, base] = entry.split(':');
      return `  public class ${name} : ${base} { public ${name}(); public ${name}(string? message); public ${name}(string? message, Exception? innerException); }`;
    })
    .join('\n') +
  String.raw`
  public class ArgumentException : SystemException {
    public ArgumentException();
    public ArgumentException(string? message);
    public ArgumentException(string? message, Exception? innerException);
    public ArgumentException(string? message, string? paramName);
    public ArgumentException(string? message, string? paramName, Exception? innerException);
    public virtual string? ParamName { get; }
    public override string Message { get; }
    public static void ThrowIfNullOrEmpty(string? argument, string? paramName = null);
    public static void ThrowIfNullOrWhiteSpace(string? argument, string? paramName = null);
  }
  public class ArgumentNullException : ArgumentException {
    public ArgumentNullException();
    public ArgumentNullException(string? paramName);
    public ArgumentNullException(string? message, Exception? innerException);
    public ArgumentNullException(string? paramName, string? message);
    public static void ThrowIfNull(object? argument, string? paramName = null);
  }
  public class ArgumentOutOfRangeException : ArgumentException {
    public ArgumentOutOfRangeException();
    public ArgumentOutOfRangeException(string? paramName);
    public ArgumentOutOfRangeException(string? message, Exception? innerException);
    public ArgumentOutOfRangeException(string? paramName, string? message);
    public ArgumentOutOfRangeException(string? paramName, object? actualValue, string? message);
    public virtual object? ActualValue { get; }
    public override string Message { get; }
    public static void ThrowIfNegative(int value, string? paramName = null);
    public static void ThrowIfZero(int value, string? paramName = null);
    public static void ThrowIfNegativeOrZero(int value, string? paramName = null);
    public static void ThrowIfGreaterThan(int value, int other, string? paramName = null);
    public static void ThrowIfLessThan(int value, int other, string? paramName = null);
  }

  public struct ValueTuple<T1> : IComparable<ValueTuple<T1>> { public T1 Item1; public ValueTuple(T1 item1); public override string ToString(); public override bool Equals(object? obj); public override int GetHashCode(); public int CompareTo(ValueTuple<T1> other); }
  public struct ValueTuple<T1, T2> : IComparable<ValueTuple<T1, T2>> { public T1 Item1; public T2 Item2; public ValueTuple(T1 item1, T2 item2); public override string ToString(); public override bool Equals(object? obj); public override int GetHashCode(); public int CompareTo(ValueTuple<T1, T2> other); }
  public struct ValueTuple<T1, T2, T3> : IComparable<ValueTuple<T1, T2, T3>> { public T1 Item1; public T2 Item2; public T3 Item3; public ValueTuple(T1 item1, T2 item2, T3 item3); public override string ToString(); public override bool Equals(object? obj); public override int GetHashCode(); public int CompareTo(ValueTuple<T1, T2, T3> other); }
  public struct ValueTuple<T1, T2, T3, T4> : IComparable<ValueTuple<T1, T2, T3, T4>> { public T1 Item1; public T2 Item2; public T3 Item3; public T4 Item4; public ValueTuple(T1 item1, T2 item2, T3 item3, T4 item4); public override string ToString(); public override bool Equals(object? obj); public override int GetHashCode(); public int CompareTo(ValueTuple<T1, T2, T3, T4> other); }
  public struct ValueTuple<T1, T2, T3, T4, T5> : IComparable<ValueTuple<T1, T2, T3, T4, T5>> { public T1 Item1; public T2 Item2; public T3 Item3; public T4 Item4; public T5 Item5; public ValueTuple(T1 item1, T2 item2, T3 item3, T4 item4, T5 item5); public override string ToString(); public override bool Equals(object? obj); public override int GetHashCode(); public int CompareTo(ValueTuple<T1, T2, T3, T4, T5> other); }
  public struct ValueTuple<T1, T2, T3, T4, T5, T6> : IComparable<ValueTuple<T1, T2, T3, T4, T5, T6>> { public T1 Item1; public T2 Item2; public T3 Item3; public T4 Item4; public T5 Item5; public T6 Item6; public ValueTuple(T1 item1, T2 item2, T3 item3, T4 item4, T5 item5, T6 item6); public override string ToString(); public override bool Equals(object? obj); public override int GetHashCode(); public int CompareTo(ValueTuple<T1, T2, T3, T4, T5, T6> other); }
  public struct ValueTuple<T1, T2, T3, T4, T5, T6, T7> : IComparable<ValueTuple<T1, T2, T3, T4, T5, T6, T7>> { public T1 Item1; public T2 Item2; public T3 Item3; public T4 Item4; public T5 Item5; public T6 Item6; public T7 Item7; public ValueTuple(T1 item1, T2 item2, T3 item3, T4 item4, T5 item5, T6 item6, T7 item7); public override string ToString(); public override bool Equals(object? obj); public override int GetHashCode(); public int CompareTo(ValueTuple<T1, T2, T3, T4, T5, T6, T7> other); }
` +
  longTupleDeclarations() +
  String.raw`
  public struct ValueTuple {
    public static ValueTuple<T1> Create<T1>(T1 item1);
    public static ValueTuple<T1, T2> Create<T1, T2>(T1 item1, T2 item2);
    public static ValueTuple<T1, T2, T3> Create<T1, T2, T3>(T1 item1, T2 item2, T3 item3);
    public static ValueTuple<T1, T2, T3, T4> Create<T1, T2, T3, T4>(T1 item1, T2 item2, T3 item3, T4 item4);
    public static ValueTuple<T1, T2, T3, T4, T5> Create<T1, T2, T3, T4, T5>(T1 item1, T2 item2, T3 item3, T4 item4, T5 item5);
    public static ValueTuple<T1, T2, T3, T4, T5, T6> Create<T1, T2, T3, T4, T5, T6>(T1 item1, T2 item2, T3 item3, T4 item4, T5 item5, T6 item6);
    public static ValueTuple<T1, T2, T3, T4, T5, T6, T7> Create<T1, T2, T3, T4, T5, T6, T7>(T1 item1, T2 item2, T3 item3, T4 item4, T5 item5, T6 item6, T7 item7);
  }
  public class Tuple<T1, T2> { public Tuple(T1 item1, T2 item2); public T1 Item1 { get; } public T2 Item2 { get; } public override string ToString(); public override bool Equals(object? obj); public override int GetHashCode(); }
  public class Tuple<T1, T2, T3> { public Tuple(T1 item1, T2 item2, T3 item3); public T1 Item1 { get; } public T2 Item2 { get; } public T3 Item3 { get; } public override string ToString(); public override bool Equals(object? obj); public override int GetHashCode(); }
  public static class TupleExtensions {
    public static Tuple<T1, T2> ToTuple<T1, T2>(this ValueTuple<T1, T2> value);
    public static Tuple<T1, T2, T3> ToTuple<T1, T2, T3>(this ValueTuple<T1, T2, T3> value);
    public static ValueTuple<T1, T2> ToValueTuple<T1, T2>(this Tuple<T1, T2> value);
    public static ValueTuple<T1, T2, T3> ToValueTuple<T1, T2, T3>(this Tuple<T1, T2, T3> value);
  }
  public static class Tuple {
    public static Tuple<T1, T2> Create<T1, T2>(T1 item1, T2 item2);
    public static Tuple<T1, T2, T3> Create<T1, T2, T3>(T1 item1, T2 item2, T3 item3);
  }

  public abstract class Array : ICloneable, System.Collections.IEnumerable {
    public int Length { get; }
    public long LongLength { get; }
    public int Rank { get; }
    public object Clone();
    public void CopyTo(Array array, int index);
    public int GetLength(int dimension);
    public int GetUpperBound(int dimension);
    public int GetLowerBound(int dimension);
    public object? GetValue(int index);
    public void SetValue(object? value, int index);
    public System.Collections.IEnumerator GetEnumerator();
    public static int BinarySearch<T>(T[] array, T value);
    public static int BinarySearch<T>(T[] array, T value, System.Collections.Generic.IComparer<T>? comparer);
    public static int BinarySearch<T>(T[] array, int index, int length, T value);
    public static int BinarySearch<T>(T[] array, int index, int length, T value, System.Collections.Generic.IComparer<T>? comparer);
    public static void Clear(Array array);
    public static void Clear(Array array, int index, int length);
    public static TOutput[] ConvertAll<TInput, TOutput>(TInput[] array, Converter<TInput, TOutput> converter);
    public static void Copy(Array sourceArray, Array destinationArray, int length);
    public static void Copy(Array sourceArray, int sourceIndex, Array destinationArray, int destinationIndex, int length);
    public static T[] Empty<T>();
    public static bool Exists<T>(T[] array, Predicate<T> match);
    public static void Fill<T>(T[] array, T value);
    public static void Fill<T>(T[] array, T value, int startIndex, int count);
    public static T? Find<T>(T[] array, Predicate<T> match);
    public static T[] FindAll<T>(T[] array, Predicate<T> match);
    public static int FindIndex<T>(T[] array, Predicate<T> match);
    public static int FindIndex<T>(T[] array, int startIndex, Predicate<T> match);
    public static T? FindLast<T>(T[] array, Predicate<T> match);
    public static int FindLastIndex<T>(T[] array, Predicate<T> match);
    public static void ForEach<T>(T[] array, Action<T> action);
    public static int IndexOf<T>(T[] array, T value);
    public static int IndexOf<T>(T[] array, T value, int startIndex);
    public static int IndexOf<T>(T[] array, T value, int startIndex, int count);
    public static int IndexOf(Array array, object? value);
    public static int LastIndexOf<T>(T[] array, T value);
    public static int LastIndexOf<T>(T[] array, T value, int startIndex);
    public static int LastIndexOf<T>(T[] array, T value, int startIndex, int count);
    public static void Resize<T>(ref T[]? array, int newSize);
    public static void Reverse(Array array);
    public static void Reverse(Array array, int index, int length);
    public static void Reverse<T>(T[] array);
    public static void Sort(Array array);
    public static void Sort<T>(T[] array);
    public static void Sort<T>(T[] array, Comparison<T> comparison);
    public static void Sort<T>(T[] array, System.Collections.Generic.IComparer<T>? comparer);
    public static void Sort<T>(T[] array, int index, int length);
    public static void Sort<TKey, TValue>(TKey[] keys, TValue[] items);
    public static bool TrueForAll<T>(T[] array, Predicate<T> match);
  }

  public struct TimeSpan : IComparable, IComparable<TimeSpan>, IEquatable<TimeSpan>, IFormattable {
    public const long TicksPerMillisecond = 10000L;
    public const long TicksPerSecond = 10000000L;
    public const long TicksPerMinute = 600000000L;
    public const long TicksPerHour = 36000000000L;
    public const long TicksPerDay = 864000000000L;
    private long _ticks;
    public static readonly TimeSpan Zero = new TimeSpan(0L);
    public static readonly TimeSpan MaxValue = new TimeSpan(9223372036854775807L);
    public static readonly TimeSpan MinValue = new TimeSpan(-9223372036854775807L - 1L);
    public TimeSpan(long ticks);
    public TimeSpan(int hours, int minutes, int seconds);
    public TimeSpan(int days, int hours, int minutes, int seconds);
    public TimeSpan(int days, int hours, int minutes, int seconds, int milliseconds);
    public long Ticks { get; }
    public int Days { get; }
    public int Hours { get; }
    public int Minutes { get; }
    public int Seconds { get; }
    public int Milliseconds { get; }
    public double TotalDays { get; }
    public double TotalHours { get; }
    public double TotalMinutes { get; }
    public double TotalSeconds { get; }
    public double TotalMilliseconds { get; }
    public TimeSpan Add(TimeSpan ts);
    public TimeSpan Subtract(TimeSpan ts);
    public TimeSpan Negate();
    public TimeSpan Duration();
    public int CompareTo(object? value);
    public int CompareTo(TimeSpan value);
    public override bool Equals(object? value);
    public bool Equals(TimeSpan obj);
    public override int GetHashCode();
    public override string ToString();
    public string ToString(string? format);
    public string ToString(string? format, IFormatProvider? formatProvider);
    public static TimeSpan FromDays(double value);
    public static TimeSpan FromHours(double value);
    public static TimeSpan FromMinutes(double value);
    public static TimeSpan FromSeconds(double value);
    public static TimeSpan FromMilliseconds(double value);
    public static TimeSpan FromTicks(long value);
    public static TimeSpan Parse(string s);
    public static TimeSpan operator +(TimeSpan t1, TimeSpan t2);
    public static TimeSpan operator -(TimeSpan t1, TimeSpan t2);
    public static TimeSpan operator -(TimeSpan t);
    public static TimeSpan operator *(TimeSpan timeSpan, double factor);
    public static TimeSpan operator /(TimeSpan timeSpan, double divisor);
    public static double operator /(TimeSpan t1, TimeSpan t2);
    public static bool operator ==(TimeSpan t1, TimeSpan t2);
    public static bool operator !=(TimeSpan t1, TimeSpan t2);
    public static bool operator <(TimeSpan t1, TimeSpan t2);
    public static bool operator <=(TimeSpan t1, TimeSpan t2);
    public static bool operator >(TimeSpan t1, TimeSpan t2);
    public static bool operator >=(TimeSpan t1, TimeSpan t2);
  }
  public struct DateTime : IComparable, IComparable<DateTime>, IEquatable<DateTime>, IFormattable {
    private long _ticks;
    public static readonly DateTime MinValue = new DateTime(0L);
    public static readonly DateTime MaxValue = new DateTime(3155378975999999999L);
    public DateTime(long ticks);
    public DateTime(int year, int month, int day);
    public DateTime(int year, int month, int day, int hour, int minute, int second);
    public DateTime(int year, int month, int day, int hour, int minute, int second, int millisecond);
    public static DateTime Now { get; }
    public static DateTime Today { get; }
    public static DateTime UtcNow { get; }
    public DateTime Date { get; }
    public int Year { get; }
    public int Month { get; }
    public int Day { get; }
    public int Hour { get; }
    public int Minute { get; }
    public int Second { get; }
    public int Millisecond { get; }
    public long Ticks { get; }
    public DayOfWeek DayOfWeek { get; }
    public int DayOfYear { get; }
    public TimeSpan TimeOfDay { get; }
    public DateTime Add(TimeSpan value);
    public DateTime AddDays(double value);
    public DateTime AddHours(double value);
    public DateTime AddMinutes(double value);
    public DateTime AddSeconds(double value);
    public DateTime AddMilliseconds(double value);
    public DateTime AddMonths(int months);
    public DateTime AddYears(int value);
    public DateTime AddTicks(long value);
    public TimeSpan Subtract(DateTime value);
    public DateTime Subtract(TimeSpan value);
    public int CompareTo(object? value);
    public int CompareTo(DateTime value);
    public override bool Equals(object? value);
    public bool Equals(DateTime value);
    public override int GetHashCode();
    public override string ToString();
    public string ToString(string? format);
    public string ToString(IFormatProvider? provider);
    public string ToString(string? format, IFormatProvider? provider);
    public string ToShortDateString();
    public string ToLongDateString();
    public string ToShortTimeString();
    public string ToLongTimeString();
    public static int DaysInMonth(int year, int month);
    public static bool IsLeapYear(int year);
    public static DateTime Parse(string s);
    public static DateTime Parse(string s, IFormatProvider? provider);
    public static DateTime Parse(string s, IFormatProvider? provider, System.Globalization.DateTimeStyles styles);
    public static bool TryParse(string? s, out DateTime result);
    public static bool TryParse(string? s, IFormatProvider? provider, out DateTime result);
    public static bool TryParse(string? s, IFormatProvider? provider, System.Globalization.DateTimeStyles styles, out DateTime result);
    public static DateTime ParseExact(string s, string format, IFormatProvider? provider);
    public static DateTime ParseExact(string s, string format, IFormatProvider? provider, System.Globalization.DateTimeStyles style);
    public static DateTime ParseExact(string s, string[] formats, IFormatProvider? provider, System.Globalization.DateTimeStyles style);
    public static bool TryParseExact(string? s, string? format, IFormatProvider? provider, System.Globalization.DateTimeStyles style, out DateTime result);
    public static bool TryParseExact(string? s, string?[]? formats, IFormatProvider? provider, System.Globalization.DateTimeStyles style, out DateTime result);
    public static int Compare(DateTime t1, DateTime t2);
    public static DateTime operator +(DateTime d, TimeSpan t);
    public static DateTime operator -(DateTime d, TimeSpan t);
    public static TimeSpan operator -(DateTime d1, DateTime d2);
    public static bool operator ==(DateTime d1, DateTime d2);
    public static bool operator !=(DateTime d1, DateTime d2);
    public static bool operator <(DateTime t1, DateTime t2);
    public static bool operator <=(DateTime t1, DateTime t2);
    public static bool operator >(DateTime t1, DateTime t2);
    public static bool operator >=(DateTime t1, DateTime t2);
  }
}

namespace System.Diagnostics {
  [AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = true)]
  public sealed class ConditionalAttribute : Attribute {
    public ConditionalAttribute(string conditionString);
    public string ConditionString { get; }
  }
  [AttributeUsage(AttributeTargets.Assembly | AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Enum | AttributeTargets.Property | AttributeTargets.Field | AttributeTargets.Delegate, AllowMultiple = true)]
  public sealed class DebuggerDisplayAttribute : Attribute {
    public DebuggerDisplayAttribute(string? value);
    public string Value { get; }
    public string? Name { get; set; }
    public string? Type { get; set; }
  }
  [AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Constructor | AttributeTargets.Method, Inherited = false)]
  public sealed class DebuggerStepThroughAttribute : Attribute { public DebuggerStepThroughAttribute(); }
  [AttributeUsage(AttributeTargets.Class | AttributeTargets.Constructor | AttributeTargets.Method | AttributeTargets.Property, Inherited = false)]
  public sealed class DebuggerHiddenAttribute : Attribute { public DebuggerHiddenAttribute(); }
  public class Stopwatch {
    public Stopwatch();
    public static readonly long Frequency = 1000000000L;
    public static readonly bool IsHighResolution = true;
    public bool IsRunning { get; }
    public TimeSpan Elapsed { get; }
    public long ElapsedMilliseconds { get; }
    public long ElapsedTicks { get; }
    public static Stopwatch StartNew();
    public void Start();
    public void Stop();
    public void Reset();
    public void Restart();
    public static long GetTimestamp();
    public static TimeSpan GetElapsedTime(long startingTimestamp);
    public static TimeSpan GetElapsedTime(long startingTimestamp, long endingTimestamp);
    public override string ToString();
  }
}

namespace System.Diagnostics.CodeAnalysis {
  [AttributeUsage(AttributeTargets.Constructor, AllowMultiple = false, Inherited = false)]
  public sealed class SetsRequiredMembersAttribute : Attribute { public SetsRequiredMembersAttribute(); }
  [AttributeUsage(AttributeTargets.Field | AttributeTargets.Parameter | AttributeTargets.Property | AttributeTargets.ReturnValue, Inherited = false)]
  public sealed class NotNullAttribute : Attribute { public NotNullAttribute(); }
  [AttributeUsage(AttributeTargets.Field | AttributeTargets.Parameter | AttributeTargets.Property | AttributeTargets.ReturnValue, Inherited = false)]
  public sealed class MaybeNullAttribute : Attribute { public MaybeNullAttribute(); }
  [AttributeUsage(AttributeTargets.Field | AttributeTargets.Parameter | AttributeTargets.Property, Inherited = false)]
  public sealed class AllowNullAttribute : Attribute { public AllowNullAttribute(); }
  [AttributeUsage(AttributeTargets.Field | AttributeTargets.Parameter | AttributeTargets.Property, Inherited = false)]
  public sealed class DisallowNullAttribute : Attribute { public DisallowNullAttribute(); }
  [AttributeUsage(AttributeTargets.Parameter, Inherited = false)]
  public sealed class NotNullWhenAttribute : Attribute {
    public NotNullWhenAttribute(bool returnValue);
    public bool ReturnValue { get; }
  }
  [AttributeUsage(AttributeTargets.Parameter, Inherited = false)]
  public sealed class MaybeNullWhenAttribute : Attribute {
    public MaybeNullWhenAttribute(bool returnValue);
    public bool ReturnValue { get; }
  }
  [AttributeUsage(AttributeTargets.Method, Inherited = false)]
  public sealed class DoesNotReturnAttribute : Attribute { public DoesNotReturnAttribute(); }
  [AttributeUsage(AttributeTargets.Assembly | AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Constructor | AttributeTargets.Method | AttributeTargets.Property | AttributeTargets.Event, Inherited = false, AllowMultiple = false)]
  public sealed class ExcludeFromCodeCoverageAttribute : Attribute {
    public ExcludeFromCodeCoverageAttribute();
    public string? Justification { get; set; }
  }
}

namespace System.Runtime.CompilerServices {
  [AttributeUsage(AttributeTargets.Parameter, Inherited = false)]
  public sealed class CallerMemberNameAttribute : Attribute { public CallerMemberNameAttribute(); }
  [AttributeUsage(AttributeTargets.Parameter, Inherited = false)]
  public sealed class CallerLineNumberAttribute : Attribute { public CallerLineNumberAttribute(); }
  [AttributeUsage(AttributeTargets.Parameter, Inherited = false)]
  public sealed class CallerFilePathAttribute : Attribute { public CallerFilePathAttribute(); }
  [AttributeUsage(AttributeTargets.Parameter, AllowMultiple = false, Inherited = false)]
  public sealed class CallerArgumentExpressionAttribute : Attribute {
    public CallerArgumentExpressionAttribute(string parameterName);
    public string ParameterName { get; }
  }
  [AttributeUsage(AttributeTargets.Constructor | AttributeTargets.Method, Inherited = false)]
  public sealed class MethodImplAttribute : Attribute {
    public MethodImplAttribute();
    public MethodImplAttribute(MethodImplOptions methodImplOptions);
    public MethodImplOptions Value { get; }
  }
  [Flags]
  public enum MethodImplOptions { Unmanaged = 4, NoInlining = 8, ForwardRef = 16, Synchronized = 32, NoOptimization = 64, PreserveSig = 128, AggressiveInlining = 256, AggressiveOptimization = 512, InternalCall = 4096 }
  [AttributeUsage(AttributeTargets.Method, Inherited = false)]
  public sealed class ModuleInitializerAttribute : Attribute { public ModuleInitializerAttribute(); }
  /** The type of a pointer \`T*\`, which no program names; \`void*\` points to \`__Void\`. */
  public sealed class __Pointer<T> { }
  public sealed class __Void { }
  /** The type \`dynamic\`, which no program names this way; its values are objects bound at run time. */
  public sealed class __Dynamic { }
  public static class RuntimeHelpers { public static T[] GetSubArray<T>(T[] array, Range range); }
  public sealed class SwitchExpressionException : InvalidOperationException {
    public SwitchExpressionException();
    public SwitchExpressionException(object? unmatchedValue);
    public object? UnmatchedValue { get; }
  }
}

namespace System.Reflection {
  public sealed class TargetInvocationException : ApplicationException {
    public TargetInvocationException(Exception? inner);
    public TargetInvocationException(string? message, Exception? inner);
  }
}
namespace System.Text {
  public abstract class Encoding {
    public static Encoding UTF8 { get; }
    public virtual byte[] GetBytes(string s);
    public virtual string GetString(byte[] bytes);
    public string GetString(ReadOnlySpan<byte> bytes);
  }
}

namespace Microsoft.CSharp.RuntimeBinder {
  public class RuntimeBinderException : Exception { public RuntimeBinderException(); public RuntimeBinderException(string? message); public RuntimeBinderException(string? message, Exception? innerException); }
}

`;

/**
 * Tuples of 8 to `MAX_TUPLE_ARITY` elements, which .NET nests as `ValueTuple<T1, …, T7, TRest>`. They are flat here, with their
 * `ItemN` fields; `runtimeTypeName` gives them .NET's nested names.
 */
function longTupleDeclarations(): string {
  const declarations: string[] = [];
  for (let arity = 8; arity <= MAX_TUPLE_ARITY; arity++) {
    const numbers = Array.from({ length: arity }, (_, index) => index + 1);
    const parameters = numbers.map((number) => `T${number}`).join(', ');
    const self = `ValueTuple<${parameters}>`;
    const fields = numbers.map((number) => `public T${number} Item${number};`).join(' ');
    const constructorParameters = numbers.map((number) => `T${number} item${number}`).join(', ');
    declarations.push(
      `  public struct ${self} : IComparable<${self}> { ${fields} public ValueTuple(${constructorParameters}); public override string ToString(); public override bool Equals(object? obj); public override int GetHashCode(); public int CompareTo(${self} other); }`
    );
  }
  return `${declarations.join('\n')}\n`;
}
