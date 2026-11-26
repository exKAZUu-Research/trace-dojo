import type { Culture } from '../cultures';

/** The fields that a `DateTime.ParseExact` format read, undefined for those it does not have. */
export interface ExactDateFields {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
  /** Ticks (100 ns) past the second. */
  fraction: number;
  dayOfWeek?: number;
  /** The UTC offset in minutes, which a `z` or `K` specifier read. */
  offsetMinutes?: number;
}

/** Why a string does not match a format, by .NET's `ParseFailureKind`. */
export type ExactDateFailure =
  | { kind: 'badDateTime' }
  | { kind: 'badQuote'; quote: string }
  | { kind: 'badFormatSpecifier' }
  | { kind: 'invalidString' };

/** The message of .NET's FormatException for a string that a format does not read. */
export function exactFailureMessage(text: string, failure: ExactDateFailure): string {
  switch (failure.kind) {
    case 'badDateTime': {
      return `String '${text}' was not recognized as a valid DateTime.`;
    }
    case 'badQuote': {
      return `Cannot find a matching quote character for the character '${failure.quote}'.`;
    }
    case 'badFormatSpecifier': {
      return "Format specifier '' was invalid.";
    }
    case 'invalidString': {
      return 'Input string was not in a correct format.';
    }
  }
}

/** The `DateTimeStyles` that a string may have white space by. */
export interface WhiteSpaceStyles {
  leading: boolean;
  trailing: boolean;
  inner: boolean;
}

/** The standard formats that every culture writes alike and reads back, by `DateTimeFormat.ExpandPredefinedFormat`. */
const INVARIANT_PATTERNS: Record<string, string> = {
  s: "yyyy'-'MM'-'dd'T'HH':'mm':'ss",
};

/** The fraction digits that `f` and `F` read at most, one per tick. */
const MAX_FRACTION_DIGITS = 7;

/**
 * Reads a string by one format as .NET's `DateTimeParse.ParseExact` does, with a culture's names and standard patterns.
 * The standard formats `o`, `r`, `u`, and `U`, which read and write UTC, are left to the caller to reject.
 */
export function parseExactDate(
  text: string,
  format: string,
  culture: Culture,
  styles: WhiteSpaceStyles
): ExactDateFields | ExactDateFailure {
  if (format === '') return { kind: 'badFormatSpecifier' };
  let pattern = format;
  if (format.length === 1) {
    const expanded = INVARIANT_PATTERNS[format] ?? (culture.datePatterns as Record<string, string | undefined>)[format];
    if (expanded === undefined) return { kind: 'invalidString' };
    pattern = expanded;
  }
  return new ExactDateParser(text, pattern, culture, styles).parse();
}

/** The standard formats that `parseExactDate` leaves to the caller. */
export function isUniversalStandardFormat(format: string): boolean {
  return format.length === 1 && 'oOrRuU'.includes(format);
}

class ExactDateParser {
  private index = 0;
  private position = 0;
  private readonly fields: ExactDateFields = { fraction: 0 };
  private usesHour12 = false;
  private timeMark: 'am' | 'pm' | undefined;

  constructor(
    private text: string,
    private pattern: string,
    private readonly culture: Culture,
    private readonly styles: WhiteSpaceStyles
  ) {}

  parse(): ExactDateFields | ExactDateFailure {
    if (this.styles.leading) {
      this.text = this.text.trimStart();
      this.pattern = this.pattern.trimStart();
    }
    if (this.styles.trailing) {
      this.text = this.text.trimEnd();
      this.pattern = this.pattern.trimEnd();
    }
    while (this.position < this.pattern.length) {
      if (this.styles.inner) this.skipWhiteSpace();
      const failure = this.parseElement();
      if (failure) return failure;
    }
    if (this.index < this.text.length) return BAD_DATE_TIME;
    return this.applyTimeMark() ?? this.fields;
  }

  /** Reads the text of one specifier or literal of the pattern, telling why it did not match. */
  // code-gauge-allow functionCognitiveComplexity -- One case per custom date format specifier.
  // code-gauge-allow functionNcss -- One case per custom date format specifier.
  private parseElement(): ExactDateFailure | undefined {
    const char = this.pattern[this.position];
    const count = this.repeatCount();
    switch (char) {
      case 'y': {
        const year = this.digits(count === 1 ? 1 : count, count === 1 ? 2 : count);
        // A one- or two-digit year is in the century up to the Gregorian calendar's TwoDigitYearMax, 2049.
        return this.set('year', year === undefined || count > 2 ? year : year + (year > 49 ? 1900 : 2000));
      }
      case 'M': {
        return this.set('month', count <= 2 ? this.numberOf(count) : this.monthName(count));
      }
      case 'd': {
        if (count <= 2) return this.set('day', this.numberOf(count));
        const names = count === 3 ? this.culture.abbreviatedDayNames : this.culture.dayNames;
        const index = this.name(names);
        return this.set('dayOfWeek', index === undefined ? undefined : index - 1);
      }
      case 'h': {
        this.usesHour12 = true;
        return this.set('hour', this.numberOf(Math.min(count, 2)));
      }
      case 'H': {
        return this.set('hour', this.numberOf(Math.min(count, 2)));
      }
      case 'm': {
        return this.set('minute', this.numberOf(Math.min(count, 2)));
      }
      case 's': {
        return this.set('second', this.numberOf(Math.min(count, 2)));
      }
      case 'f':
      case 'F': {
        return this.fraction(char, count);
      }
      case 't': {
        return this.designator(count);
      }
      case 'z': {
        return this.set('offsetMinutes', this.offset(count));
      }
      case 'K': {
        if (this.text[this.index] === 'Z') {
          this.index++;
          return this.set('offsetMinutes', 0);
        }
        if (this.text[this.index] === '+' || this.text[this.index] === '-')
          return this.set('offsetMinutes', this.offset(3));
        return undefined;
      }
      case 'g': {
        return this.literal(this.culture.era);
      }
      default: {
        this.position -= count;
        return this.parseLiteral();
      }
    }
  }

  /** Reads a literal of the pattern: a quoted string, an escaped character, a separator, or any other character. */
  private parseLiteral(): ExactDateFailure | undefined {
    const char = this.pattern[this.position++];
    if (char === "'" || char === '"') {
      const end = this.pattern.indexOf(char, this.position);
      if (end === -1) return { kind: 'badQuote', quote: char };
      const quoted = this.pattern.slice(this.position, end);
      this.position = end + 1;
      return this.literal(quoted);
    }
    if (char === '\\') {
      const escaped = this.pattern[this.position++];
      return escaped === undefined ? BAD_DATE_TIME : this.literal(escaped);
    }
    if (char === '%') return undefined;
    if (/\s/.test(char)) {
      if (this.styles.inner) return undefined;
      return this.literal(char);
    }
    if (char === '.' && this.text[this.index] !== '.' && this.pattern[this.position] === 'F') {
      // A point before `F` digits may be left out with them, as `ss.FFF` reads `09`.
      this.repeatCount();
      return undefined;
    }
    return this.literal(char);
  }

  private literal(expected: string): ExactDateFailure | undefined {
    if (!this.text.startsWith(expected, this.index)) return BAD_DATE_TIME;
    this.index += expected.length;
    return undefined;
  }

  /** The length of the run of the pattern's character at the position, which it moves past. */
  private repeatCount(): number {
    const char = this.pattern[this.position];
    const start = this.position;
    while (this.pattern[this.position] === char) this.position++;
    return this.position - start;
  }

  private skipWhiteSpace(): void {
    while (this.index < this.text.length && /\s/.test(this.text[this.index])) this.index++;
  }

  /** A number of one or two digits for a single specifier, and of exactly that many digits for a longer one. */
  private numberOf(count: number): number | undefined {
    return count === 1 ? this.digits(1, 2) : this.digits(count, count);
  }

  private digits(min: number, max: number): number | undefined {
    let end = this.index;
    while (end < this.text.length && end - this.index < max && /[0-9]/.test(this.text[end])) end++;
    if (end - this.index < min) return undefined;
    const value = Number(this.text.slice(this.index, end));
    this.index = end;
    return value;
  }

  /** `f` reads exactly as many digits as it has, and `F` up to that many, none at all included. */
  private fraction(char: 'f' | 'F', count: number): ExactDateFailure | undefined {
    if (count > MAX_FRACTION_DIGITS) return BAD_DATE_TIME;
    let end = this.index;
    while (end < this.text.length && end - this.index < count && /[0-9]/.test(this.text[end])) end++;
    const digits = this.text.slice(this.index, end);
    if (char === 'f' && digits.length < count) return BAD_DATE_TIME;
    this.index = end;
    this.fields.fraction = Number(digits.padEnd(MAX_FRACTION_DIGITS, '0'));
    return undefined;
  }

  /** `tt` reads a whole designator, ignoring case, and `t` its first character, which must match. */
  private designator(count: number): ExactDateFailure | undefined {
    const { amDesignator, pmDesignator } = this.culture;
    if (count === 1) {
      const char = this.text[this.index];
      if (char !== undefined && char === amDesignator[0]) this.timeMark = 'am';
      else if (char !== undefined && char === pmDesignator[0]) this.timeMark = 'pm';
      else return BAD_DATE_TIME;
      this.index++;
      return undefined;
    }
    const index = this.name([amDesignator, pmDesignator]);
    if (index === undefined) return BAD_DATE_TIME;
    this.timeMark = index === 1 ? 'am' : 'pm';
    return undefined;
  }

  /** A UTC offset in minutes: `z` reads `+9`, `zz` `+09`, and `zzz` `+09:00`. */
  private offset(count: number): number | undefined {
    const sign = this.text[this.index];
    if (sign !== '+' && sign !== '-') return undefined;
    this.index++;
    const hours = this.numberOf(Math.min(count, 2));
    if (hours === undefined) return undefined;
    let minutes = 0;
    if (count >= 3) {
      if (this.text[this.index] === ':') this.index++;
      const read = this.digits(2, 2);
      if (read === undefined) return undefined;
      minutes = read;
    }
    const total = hours * 60 + minutes;
    return sign === '-' ? -total : total;
  }

  private monthNames(count: number): readonly string[] {
    return count === 3 ? this.culture.abbreviatedMonthNames : this.culture.monthNames;
  }

  /** The one-based month of the name the text has next, in its own form or the form that goes with a day. */
  private monthName(count: number): number | undefined {
    const genitive = count === 3 ? this.culture.abbreviatedMonthGenitiveNames : this.culture.monthGenitiveNames;
    const index = this.name([...this.monthNames(count), ...genitive]);
    return index === undefined ? undefined : ((index - 1) % 12) + 1;
  }

  /** The one-based index of the longest of the names that the text has next, ignoring case, which it moves past. */
  private name(names: readonly string[]): number | undefined {
    let best: number | undefined;
    const rest = this.text.slice(this.index).toLowerCase();
    for (const [index, name] of names.entries()) {
      if (rest.startsWith(name.toLowerCase()) && (best === undefined || name.length > names[best - 1].length))
        best = index + 1;
    }
    if (best !== undefined) this.index += names[best - 1].length;
    return best;
  }

  /** Records a field, which a pattern may repeat only with the same value. */
  private set(
    field: Exclude<keyof ExactDateFields, 'fraction'>,
    value: number | undefined
  ): ExactDateFailure | undefined {
    if (value === undefined) return BAD_DATE_TIME;
    const previous = this.fields[field];
    if (previous !== undefined && previous !== value) return BAD_DATE_TIME;
    this.fields[field] = value;
    return undefined;
  }

  /** Applies an AM or PM designator to the hour, which `h` reads on a 12-hour clock and `H` on a 24-hour one. */
  private applyTimeMark(): ExactDateFailure | undefined {
    const hour = this.fields.hour ?? 0;
    if (this.usesHour12) {
      if (hour > 12) return BAD_DATE_TIME;
      const isPm = this.timeMark === 'pm';
      this.fields.hour = isPm ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour;
      return undefined;
    }
    if ((this.timeMark === 'am' && hour >= 12) || (this.timeMark === 'pm' && hour < 12)) return BAD_DATE_TIME;
    return undefined;
  }
}

const BAD_DATE_TIME: ExactDateFailure = { kind: 'badDateTime' };
