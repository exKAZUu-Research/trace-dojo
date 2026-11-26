/**
 * The declarations of `System.Globalization`, in C#: the two cultures this grader has (see `cultures.ts`) and the
 * styles that parsing takes. Members without bodies are implemented natively (see `nativesGlobalization.ts`).
 */
export const GLOBALIZATION_SOURCE = String.raw`
namespace System.Globalization {
  public class CultureInfo : IFormatProvider {
    public CultureInfo(string name);
    public static CultureInfo CurrentCulture { get; set; }
    public static CultureInfo CurrentUICulture { get; set; }
    public static CultureInfo InvariantCulture { get; }
    public static CultureInfo GetCultureInfo(string name);
    public virtual string Name { get; }
    public virtual string DisplayName { get; }
    public virtual string EnglishName { get; }
    public virtual string NativeName { get; }
    public virtual string TwoLetterISOLanguageName { get; }
    public bool IsReadOnly { get; }
    public virtual object? GetFormat(Type? formatType);
    public override bool Equals(object? value);
    public override int GetHashCode();
    public override string ToString();
  }
  public class CultureNotFoundException : ArgumentException {
    public CultureNotFoundException();
    public CultureNotFoundException(string? message);
    public CultureNotFoundException(string? paramName, string? message);
    public CultureNotFoundException(string? message, Exception? innerException);
  }
  [Flags]
  public enum NumberStyles {
    None = 0,
    AllowLeadingWhite = 1,
    AllowTrailingWhite = 2,
    AllowLeadingSign = 4,
    AllowTrailingSign = 8,
    AllowParentheses = 16,
    AllowDecimalPoint = 32,
    AllowThousands = 64,
    AllowExponent = 128,
    AllowCurrencySymbol = 256,
    AllowHexSpecifier = 512,
    AllowBinarySpecifier = 1024,
    Integer = 7,
    HexNumber = 515,
    BinaryNumber = 1027,
    Number = 111,
    Float = 167,
    Currency = 383,
    Any = 511,
  }
  [Flags]
  public enum DateTimeStyles {
    None = 0,
    AllowLeadingWhite = 1,
    AllowTrailingWhite = 2,
    AllowInnerWhite = 4,
    AllowWhiteSpaces = 7,
    NoCurrentDateDefault = 8,
    AdjustToUniversal = 16,
    AssumeLocal = 32,
    AssumeUniversal = 64,
    RoundtripKind = 128,
  }
}
`;
