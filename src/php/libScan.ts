// code-gauge-allow-file fileNcss 453 -- Holds the cases of one concern of the interpreter, which share their helpers.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { byteAt, charAt, untilNul, utf8Length } from './bytes';
import { deprecated, throwError, warn } from './errors';
import { isCtypeSpace, isUtf8Ctype } from './libLocale';
import { defineFunction } from './native';
import { rt } from './runtime';
import { INT_MAX, INT_MIN, PhpArray, type Value } from './values';

const s = (value: Value): string => value as string;

/** The string that `strtok` tokenizes and where its next token starts, for each run. */
const strtokStates = new WeakMap<object, { text: string | undefined; position: number }>();

defineFunction('strtok(string $string, ?string $token = null): string|false', ({ args }) => {
  const state = strtokStates.get(rt()) ?? { text: undefined, position: 0 };
  strtokStates.set(rt(), state);
  let token = s(args[0]);
  if (args[1] !== undefined && args[1] !== null) {
    token = s(args[1]);
    state.text = s(args[0]);
    state.position = 0;
  }
  const { text } = state;
  if (text === undefined) {
    warn('strtok(): Both arguments must be provided when starting tokenization');
    return false;
  }
  let index = state.position;
  // Past the end, PHP keeps the string, so later calls with one argument return false without a warning.
  if (index >= text.length) return false;
  const runtime = rt();
  runtime.spend(token.length);
  const delimiters = new Uint8Array(256);
  for (let at = 0; at < token.length; at++) delimiters[token.charCodeAt(at)] = 1;
  while (delimiters[text.charCodeAt(index)]) {
    runtime.spend();
    if (++index >= text.length) {
      state.text = undefined;
      return false;
    }
  }
  const start = index;
  while (++index < text.length && !delimiters[text.charCodeAt(index)]) runtime.spend();
  state.position = index + 1;
  return text.slice(start, index);
});

defineFunction(
  String.raw`str_getcsv(string $string, string $separator = ",", string $enclosure = '"', string $escape = '\'): array`,
  ({ args }) => {
    const separator = args[1] === undefined ? ',' : s(args[1]);
    const enclosure = args[2] === undefined ? '"' : s(args[2]);
    if (separator.length !== 1)
      throwError('ValueError', 'str_getcsv(): Argument #2 ($separator) must be a single character');
    if (enclosure.length !== 1)
      throwError('ValueError', 'str_getcsv(): Argument #3 ($enclosure) must be a single character');
    if (args[3] === undefined) {
      deprecated('str_getcsv(): the $escape parameter must be provided as its default value will change');
    } else if (s(args[3]).length > 1) {
      throwError('ValueError', 'str_getcsv(): Argument #4 ($escape) must be empty or a single character');
    }
    const escape = args[3] === undefined ? '\\' : s(args[3]) || undefined;
    return PhpArray.list(parseCsv(s(args[0]), separator, enclosure, escape));
  }
);

interface CsvCursor {
  text: string;
  /** Where the line ends without its line break, which php_fgetcsv calls `limit`. */
  limit: number;
  delimiter: string;
  enclosure: string;
  escape: string | undefined;
  index: number;
  /** The length of the character at `index` as the C library's mblen measures it: 0 at the limit, -1 when invalid. */
  charLength: number;
}

/** Splits a CSV line as php_fgetcsv does, which the C library's locale makes skip whole multibyte characters. */
// code-gauge-allow functionCognitiveComplexity 21 -- Tracks field text, enclosure state and escapes in a single forward scan.
function parseCsv(text: string, delimiter: string, enclosure: string, escape: string | undefined): (string | null)[] {
  const limit = withoutLineBreak(text, text.length);
  const cursor: CsvCursor = { text, limit, delimiter, enclosure, escape, index: 0, charLength: 0 };
  const values: string[] = [];
  do {
    cursor.charLength = csvCharLength(cursor);
    if (cursor.charLength === 1) {
      let ahead = cursor.index;
      while (text[ahead] !== delimiter && isCtypeSpace(byteAt(text, ahead))) ahead++;
      if (text[ahead] === enclosure && ahead < limit) cursor.index = ahead;
    }
    if (values.length === 0 && cursor.index === limit) return [null];
    if (cursor.charLength !== 0 && text[cursor.index] === enclosure) values.push(enclosedCsvField(cursor));
    else {
      const start = cursor.index;
      skipToDelimiter(cursor);
      const field = text.slice(start, cursor.index);
      values.push(field.slice(0, withoutLineBreak(field, field.length)));
      if (text[cursor.index] === delimiter) cursor.index++;
    }
  } while (cursor.charLength > 0);
  return values;
}

interface EnclosedField {
  text: string;
  /** Where the bytes not yet copied to `text` start. */
  hunk: number;
  /** Whether the last character was the escape character or an enclosure, which may close the field or be doubled. */
  state: 'plain' | 'escaped' | 'enclosure';
}

/** Reads a field that starts with the enclosure, leaving the cursor after its delimiter. */
function enclosedCsvField(cursor: CsvCursor): string {
  const field: EnclosedField = { text: '', hunk: ++cursor.index, state: 'plain' };
  // The first character of the field is read with the length of the enclosure before it, as php_fgetcsv does.
  while (!readEnclosedChar(cursor, field)) cursor.charLength = csvCharLength(cursor);
  skipToDelimiter(cursor);
  const rest = cursor.text.slice(field.hunk, cursor.index);
  cursor.index += cursor.charLength;
  return field.text + rest;
}

/** Reads the character at the cursor in an enclosed field, returning whether the enclosed part ended. */
function readEnclosedChar(cursor: CsvCursor, field: EnclosedField): boolean {
  const { text } = cursor;
  if (cursor.charLength === 0) {
    endEnclosedField(cursor, field);
    return true;
  }
  const single = cursor.charLength === 1 || cursor.charLength === -1;
  if (field.state === 'enclosure') {
    if (!single || text[cursor.index] !== cursor.enclosure) {
      field.text += text.slice(field.hunk, cursor.index - 1);
      field.hunk = cursor.index;
      return true;
    }
    field.text += text.slice(field.hunk, cursor.index);
    field.hunk = ++cursor.index;
    field.state = 'plain';
  } else if (field.state === 'escaped' || !single) {
    cursor.index += single ? 1 : cursor.charLength;
    field.state = 'plain';
  } else {
    if (text[cursor.index] === cursor.enclosure) field.state = 'enclosure';
    else if (cursor.escape !== undefined && text[cursor.index] === cursor.escape) field.state = 'escaped';
    cursor.index++;
  }
  return false;
}

/** Ends a field at the limit; an unterminated field keeps its line break, and a read past the limit is undone. */
function endEnclosedField(cursor: CsvCursor, field: EnclosedField): void {
  const { text } = cursor;
  if (field.state === 'enclosure') field.text += text.slice(field.hunk, cursor.index - 1);
  else {
    if (field.state === 'escaped' || field.hunk !== cursor.limit) field.text += text.slice(field.hunk, cursor.index);
    field.text += text.slice(cursor.limit);
    if (cursor.index > cursor.limit) cursor.index--;
  }
  field.hunk = cursor.index;
}

function skipToDelimiter(cursor: CsvCursor): void {
  while (cursor.charLength !== 0) {
    if (cursor.charLength < 0) cursor.charLength = 1;
    if (cursor.charLength === 1 && cursor.text[cursor.index] === cursor.delimiter) return;
    cursor.index += cursor.charLength;
    cursor.charLength = csvCharLength(cursor);
  }
}

function csvCharLength(cursor: CsvCursor): number {
  if (cursor.index >= cursor.limit) return 0;
  if (cursor.text.charCodeAt(cursor.index) < 0x80 || !isUtf8Ctype()) return 1;
  const length = utf8Length(cursor.text.slice(0, cursor.limit), cursor.index);
  return length === 1 ? -1 : length;
}

/** Where `text` ends without one trailing line break, as php_fgetcsv_lookup_trailing_spaces finds it. */
function withoutLineBreak(text: string, end: number): number {
  if (text.endsWith('\r\n')) return end - 2;
  return text.endsWith('\n') || text.endsWith('\r') ? end - 1 : end;
}

// Scanning, which reads both strings only up to their first NUL byte, as PHP's C code does ----------------------------

defineFunction('sscanf(string $string, string $format, mixed &...$vars): array|int|null', ({ args, refs }) => {
  const format = untilNul(s(args[1]));
  const varCount = args.length - 2;
  const total = validateScanFormat(format, varCount);
  const results = new PhpArray();
  if (varCount === 0) for (let index = 0; index < total; index++) results.append(null);
  const scan = scanString(untilNul(s(args[0])), format);
  for (const [index, value] of scan.values) {
    if (varCount === 0) results.set(BigInt(index), value);
    else refs[index + 2]?.assign(value);
  }
  if (scan.underflow && scan.conversions === 0) return varCount === 0 ? null : -1n;
  return varCount === 0 ? results : BigInt(scan.conversions);
});

interface ScanSpec {
  suppress: boolean;
  /** The 1-based number of the value an XPG-style `%n$` conversion assigns. */
  position?: number;
  width: number;
  char: string;
  /** The index in the format after the conversion character. */
  next: number;
}

/** Reads the conversion after the `%` before `index` as both loops of PHP's scanf.c do, or undefined for `%%`. */
function readScanSpec(format: string, index: number): ScanSpec | undefined {
  let at = index;
  let char = charAt(format, at++);
  if (char === '%') return undefined;
  const suppress = char === '*';
  const xpg = suppress ? undefined : /^(\d+)\$/.exec(format.slice(at - 1));
  if (suppress || xpg) {
    at += xpg ? xpg[0].length - 1 : 0;
    char = charAt(format, at++);
  }
  const digits = /^\d+/.exec(format.slice(at - 1))?.[0];
  if (digits) {
    at += digits.length - 1;
    char = charAt(format, at++);
  }
  if (char === 'l' || char === 'L' || char === 'h') char = charAt(format, at++);
  return { suppress, position: xpg ? Number(xpg[1]) : undefined, width: Number(digits ?? 0), char, next: at };
}

interface ScanTargets {
  /** How many conversions assign each value. */
  assigned: number[];
  objIndex: number;
  xpgSize: number;
  gotXpg: boolean;
  gotSequential: boolean;
}

/** Checks a format as ValidateFormat of PHP's scanf.c does, returning how many values it assigns. */
// code-gauge-allow functionCognitiveComplexity 21 -- Keeps format validation and destination-count diagnostics in field order.
function validateScanFormat(format: string, varCount: number): number {
  const targets: ScanTargets = { assigned: [], objIndex: 0, xpgSize: 0, gotXpg: false, gotSequential: false };
  for (let index = 0; index < format.length;) {
    if (format[index++] !== '%') continue;
    const spec = readScanSpec(format, index);
    if (!spec) {
      index++;
      continue;
    }
    noteScanTarget(targets, spec, varCount);
    index = spec.char === '[' ? skipScanSet(format, spec.next) : spec.next;
    if (!'ndDioxXufeEgsc['.includes(spec.char)) {
      // PHP formats the message with %c, which a NUL byte ends.
      throwError('ValueError', `Bad scan conversion character "${spec.char === '\0' ? '' : `${spec.char}"`}`);
    }
    if (!spec.suppress) {
      targets.assigned[targets.objIndex] = (targets.assigned[targets.objIndex] ?? 0) + 1;
      targets.objIndex++;
    }
  }
  const total = varCount || targets.xpgSize || targets.objIndex;
  for (let index = 0; index < total; index++) {
    if ((targets.assigned[index] ?? 0) > 1) {
      throwError('ValueError', 'Variable is assigned by multiple "%n$" conversion specifiers');
    }
    if (!targets.xpgSize && !targets.assigned[index]) {
      throwError('ValueError', 'Variable is not assigned by any conversion specifiers');
    }
  }
  return total;
}

/** Checks which value a conversion assigns, refusing a mix of `%` and `%n$` and a value past the variables. */
// code-gauge-allow functionCognitiveComplexity 16 -- Validates positional and sequential destinations against the same output count.
function noteScanTarget(targets: ScanTargets, spec: ScanSpec, varCount: number): void {
  const badIndex = (): never =>
    throwError(
      'ValueError',
      targets.gotXpg ? '"%n$" argument index out of range' : 'Different numbers of variable names and field specifiers'
    );
  if (spec.position !== undefined) {
    targets.gotXpg = true;
    if (targets.gotSequential) throwError('ValueError', 'cannot mix "%" and "%n$" conversion specifiers');
    if (spec.position < 1 || spec.position > (varCount || 255)) badIndex();
    if (varCount === 0) targets.xpgSize = Math.max(targets.xpgSize, spec.position);
    targets.objIndex = spec.position - 1;
  } else if (!spec.suppress) {
    targets.gotSequential = true;
    if (targets.gotXpg) throwError('ValueError', 'cannot mix "%" and "%n$" conversion specifiers');
  }
  if (!spec.suppress && varCount > 0 && targets.objIndex >= varCount) badIndex();
}

/** Skips a `[` set to its closing `]`, returning the index after it. */
function skipScanSet(format: string, index: number): number {
  let at = index;
  const runtime = rt();
  const next = (): string => {
    runtime.spend();
    if (at >= format.length) throwError('ValueError', 'Unmatched [ in format string');
    return format[at++];
  };
  let char = next();
  if (char === '^') char = next();
  if (char === ']') char = next();
  while (char !== ']') char = next();
  return at;
}

interface ScanState {
  text: string;
  position: number;
  objIndex: number;
  values: [number, Value][];
  conversions: number;
  underflow: boolean;
}

/** Scans a string by a valid format as php_sscanf_internal does, stopping at the first mismatch. */
function scanString(text: string, format: string): ScanState {
  const scan: ScanState = { text, position: 0, objIndex: 0, values: [], conversions: 0, underflow: false };
  for (let index = 0; index < format.length;) {
    const char = format[index++];
    if (isCtypeSpace(char.charCodeAt(0))) {
      while (isCtypeSpace(byteAt(text, scan.position))) scan.position++;
      continue;
    }
    const spec = char === '%' ? readScanSpec(format, index) : undefined;
    const next = spec ? scanConversion(scan, format, spec) : scanLiteral(scan, char, char === '%' ? index + 1 : index);
    if (next === undefined) return scan;
    index = next;
  }
  return scan;
}

/** Matches a character of the format, returning the next index in the format, or undefined when scanning stops. */
function scanLiteral(scan: ScanState, char: string, next: number): number | undefined {
  if (scan.position >= scan.text.length) {
    scan.underflow = true;
    return undefined;
  }
  return scan.text[scan.position++] === char ? next : undefined;
}

/** Performs a conversion, returning the next index in the format, or undefined when scanning stops. */
function scanConversion(scan: ScanState, format: string, spec: ScanSpec): number | undefined {
  const { text } = scan;
  if (spec.position !== undefined) scan.objIndex = spec.position - 1;
  if (spec.char === 'n') {
    if (!spec.suppress) scan.values.push([scan.objIndex++, BigInt(scan.position)]);
    scan.conversions++;
    return spec.next;
  }
  if (spec.char !== 'c' && spec.char !== '[' && scan.position < text.length) {
    while (isCtypeSpace(byteAt(text, scan.position))) scan.position++;
  }
  if (scan.position >= text.length) {
    scan.underflow = true;
    return undefined;
  }
  const field = scanField(text, scan.position, format, spec);
  if (field.value === undefined) {
    // A number that stops at the end of the string runs out of input; a set that matches nothing stops before it.
    if (field.end >= text.length) scan.underflow = true;
    return undefined;
  }
  if (!spec.suppress) scan.values.push([scan.objIndex++, field.value]);
  scan.position = field.end;
  scan.conversions++;
  return field.formatIndex;
}

interface ScanField {
  /** Where the field ends in the string, or where reading stopped when it does not match. */
  end: number;
  /** The value of the field, or undefined when it does not match and scanning stops. */
  value?: Value;
  formatIndex: number;
}

// code-gauge-allow functionCognitiveComplexity 16 -- Uses each conversion rule with the same input position and width limit.
function scanField(text: string, start: number, format: string, spec: ScanSpec): ScanField {
  const { char, width, next } = spec;
  if (char === 's' || char === 'c') {
    const limit = width || (char === 'c' ? 1 : Infinity);
    let end = start;
    while (end < text.length && end - start < limit && !isCtypeSpace(text.charCodeAt(end))) end++;
    return { end, value: text.slice(start, end), formatIndex: next };
  }
  if (char === '[') {
    const close = skipScanSet(format, next);
    const inSet = scanSet(format.slice(next, close - 1));
    let end = start;
    const runtime = rt();
    while (end < text.length && end - start < (width || Infinity) && inSet(text[end])) {
      runtime.spend();
      end++;
    }
    return { end, value: end === start ? undefined : text.slice(start, end), formatIndex: close };
  }
  const read = 'feEg'.includes(char) ? scanFloat(text, start, width) : scanInteger(text, start, width, char);
  return { ...read, formatIndex: next };
}

/** How many characters a number may take, which PHP's 64-byte buffer limits. */
function numberWidth(width: number): number {
  return width === 0 || width > 63 ? 63 : width;
}

interface IntegerScan {
  base: number;
  signOk: boolean;
  noDigits: boolean;
  noZero: boolean;
  xOk: boolean;
}

const SCAN_BASES: Record<string, number> = { d: 10, D: 10, i: 0, o: 8, x: 16, X: 16, u: 10 };

/** Reads an integer as php_sscanf_internal does, ending without a value when no digit was read. */
function scanInteger(text: string, start: number, width: number, char: string): { end: number; value?: Value } {
  const scan: IntegerScan = { base: SCAN_BASES[char], signOk: true, noDigits: true, noZero: true, xOk: false };
  let end = start;
  for (
    let left = numberWidth(width);
    left > 0 && end < text.length && acceptsIntegerChar(scan, text[end], end - start);
    left--
  ) {
    end++;
  }
  if (scan.noDigits) return { end };
  // A trailing x after a 0 is given back.
  if (/[xX]/.test(text[end - 1])) end--;
  return { end, value: integerValue(text.slice(start, end), scan.base, char === 'u') };
}

const UINT_MAX = (1n << 64n) - 1n;

/** Whether an integer goes on with `char`, which follows `length` characters of it. */
// code-gauge-allow functionCognitiveComplexity 18 -- Tests prefixes and digits against the accumulated radix and sign.
function acceptsIntegerChar(scan: IntegerScan, char: string, length: number): boolean {
  if (char === '0') {
    if (scan.base === 16) scan.xOk = true;
    if (scan.base === 0) {
      scan.base = 8;
      scan.xOk = true;
    }
    if (!scan.noZero) scan.xOk = false;
    scan.signOk = false;
    scan.noDigits = false;
    scan.noZero = false;
    return true;
  }
  if (/[1-9a-fA-F]/.test(char) && Number.parseInt(char, 16) < (scan.base || 10)) {
    if (scan.base === 0) scan.base = 10;
    scan.signOk = false;
    scan.xOk = false;
    scan.noDigits = false;
    return true;
  }
  if ((char === '+' || char === '-') && scan.signOk) {
    scan.signOk = false;
    return true;
  }
  if ((char !== 'x' && char !== 'X') || !scan.xOk || length !== 1) return false;
  scan.base = 16;
  scan.xOk = false;
  return true;
}

/** Converts digits as strtol (or strtoul when `unsigned`) does, saturating at the limits of its type. */
function integerValue(buffer: string, base: number, unsigned: boolean): Value {
  const negative = buffer.startsWith('-');
  const digits = buffer.replace(/^[+-]/, '').replace(/^0[xX]/, '');
  let value = BigInt(`${{ 8: '0o', 10: '', 16: '0x' }[base] ?? ''}${digits || '0'}`);
  if (!unsigned) {
    value = negative ? -value : value;
    return value > INT_MAX ? INT_MAX : value < INT_MIN ? INT_MIN : value;
  }
  // strtoul negates a negative number modulo 2⁶⁴, and PHP writes one past the int range as a decimal string.
  if (value > UINT_MAX) value = UINT_MAX;
  else if (negative && value > 0n) value = UINT_MAX + 1n - value;
  return value > INT_MAX ? value.toString() : value;
}

interface FloatScan {
  signOk: boolean;
  noDigits: boolean;
  pointOk: boolean;
  exponentOk: boolean;
}

/** Reads a float as php_sscanf_internal does, giving back a trailing exponent letter and sign without digits. */
function scanFloat(text: string, start: number, width: number): { end: number; value?: Value } {
  const scan: FloatScan = { signOk: true, noDigits: true, pointOk: true, exponentOk: true };
  let end = start;
  for (let left = numberWidth(width); left > 0 && end < text.length && acceptsFloatChar(scan, text[end]); left--) end++;
  if (scan.noDigits) {
    if (scan.exponentOk) return { end };
    end -= /[eE]/.test(text[end - 1]) ? 1 : 2;
  }
  return { end, value: Number(text.slice(start, end)) };
}

function acceptsFloatChar(scan: FloatScan, char: string): boolean {
  if (/\d/.test(char)) {
    scan.signOk = false;
    scan.noDigits = false;
  } else if ((char === '+' || char === '-') && scan.signOk) scan.signOk = false;
  else if (char === '.' && scan.pointOk) {
    scan.signOk = false;
    scan.pointOk = false;
  } else if ((char === 'e' || char === 'E') && !scan.noDigits && scan.exponentOk) {
    scan.exponentOk = false;
    scan.pointOk = false;
    scan.signOk = true;
    scan.noDigits = true;
  } else return false;
  return true;
}

/** The membership test of a `[...]` set as BuildCharSet and CharInSet of PHP's scanf.c read it, with signed chars. */
function scanSet(body: string): (char: string) => boolean {
  const exclude = body.startsWith('^');
  const list = exclude ? body.slice(1) : body;
  rt().spend(list.length);
  const boundaries = new Int32Array(257);
  const addRange = (from: number, to = from): void => {
    boundaries[from + 128]++;
    boundaries[to + 129]--;
  };
  let index = 0;
  if (list[0] === ']' || list[0] === '-') addRange(signed(list[index++]));
  for (; index < list.length; index++) {
    const from = signed(list[index]);
    if (list[index + 1] === '-' && index + 2 < list.length) {
      const to = signed(list[index + 2]);
      addRange(Math.min(from, to), Math.max(from, to));
      index += 2;
    } else addRange(from);
  }
  let count = 0;
  const matches = new Uint8Array(256);
  for (let code = 0; code < matches.length; code++) {
    count += boundaries[code];
    matches[code] = Number(count > 0 !== exclude);
  }
  return (char) => Boolean(matches[signed(char) + 128]);
}

/** A byte as C's signed char holds it. */
function signed(char: string): number {
  const code = char.charCodeAt(0);
  return code > 127 ? code - 256 : code;
}
