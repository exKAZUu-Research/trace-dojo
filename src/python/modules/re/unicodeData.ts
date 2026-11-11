import { ALNUM_RANGES, CASED_RANGES, DECIMAL_RANGES, LOWER_RUNS, SPACE_RANGES, UPPER_RUNS } from './unicodeTables';

/** A set of code points as sorted, disjoint half-open ranges `[starts[i], ends[i])`. */
class CodeSet {
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];

  constructor(encoded: string) {
    let previous = 0;
    const numbers = encoded.split(',').map((part) => Number.parseInt(part, 36));
    for (let index = 0; index < numbers.length; index += 2) {
      const start = previous + numbers[index];
      previous = start + numbers[index + 1];
      this.starts.push(start);
      this.ends.push(previous);
    }
  }

  has(code: number): boolean {
    let low = 0;
    let high = this.starts.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (code < this.starts[middle]) high = middle - 1;
      else if (code >= this.ends[middle]) low = middle + 1;
      else return true;
    }
    return false;
  }
}

function decodeCaseMap(encoded: string): Map<number, number> {
  const map = new Map<number, number>();
  let previous = 0;
  for (const run of encoded.split(',')) {
    const [gap, count, stride, delta] = run.split(':').map((part) => Number.parseInt(part, 36));
    const start = previous + gap;
    for (let index = 0; index < count; index++) map.set(start + index * stride, start + index * stride + delta);
    previous = start + (count - 1) * stride + 1;
  }
  return map;
}

let tables:
  | {
      lower: Map<number, number>;
      upper: Map<number, number>;
      cased: CodeSet;
      decimal: CodeSet;
      space: CodeSet;
      alnum: CodeSet;
    }
  | undefined;

function unicodeTables(): NonNullable<typeof tables> {
  tables ??= {
    lower: decodeCaseMap(LOWER_RUNS),
    upper: decodeCaseMap(UPPER_RUNS),
    cased: new CodeSet(CASED_RANGES),
    decimal: new CodeSet(DECIMAL_RANGES),
    space: new CodeSet(SPACE_RANGES),
    alnum: new CodeSet(ALNUM_RANGES),
  };
  return tables;
}

/** `_PyUnicode_ToLowercase`: the simple lowercase mapping, which `re` uses for case-insensitive matching. */
export function unicodeLower(code: number): number {
  if (code < 0x80) return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
  return unicodeTables().lower.get(code) ?? code;
}

/** `_PyUnicode_ToUppercase`: the simple uppercase mapping. */
export function unicodeUpper(code: number): number {
  if (code < 0x80) return code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
  return unicodeTables().upper.get(code) ?? code;
}

export function unicodeIsCased(code: number): boolean {
  if (code < 0x80) return (code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a;
  return unicodeTables().cased.has(code);
}

export function unicodeIsDecimal(code: number): boolean {
  if (code < 0x80) return code >= 0x30 && code <= 0x39;
  return unicodeTables().decimal.has(code);
}

export function unicodeIsSpace(code: number): boolean {
  if (code < 0x80) return code === 0x20 || (code >= 0x09 && code <= 0x0d) || (code >= 0x1c && code <= 0x1f);
  return unicodeTables().space.has(code);
}

export function unicodeIsWord(code: number): boolean {
  if (code < 0x80) return isAsciiWord(code);
  return unicodeTables().alnum.has(code);
}

export function isAsciiWord(code: number): boolean {
  return (
    code === 0x5f || (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
  );
}

export function isAsciiSpace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

export function asciiLower(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

export function asciiIsCased(code: number): boolean {
  return code < 0x80 && (code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a;
}
