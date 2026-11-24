// code-gauge-allow-file fileNcss -- Holds the filter extension, whose validators and sanitizers share option and flag handling.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { lower, untilNul } from './bytes';
import { callCallback, checkCallable } from './callables';
import { numericValue, valueName } from './conversions';
import { throwError, warn } from './errors';
import { escapeHtml } from './htmlEntities';
import { isCtypeAlpha } from './libLocale';
import { patternMatches } from './libRegex';
import { parseUrl } from './libUrl';
import { defineClass, defineConstant, defineFunction } from './native';
import { toFloat, toInt, toStr } from './operators';
import { rt } from './runtime';
import { stripTags } from './stripTags';
import { UnsupportedFeatureError } from './unsupported';
import { PhpArray, PhpObject, type Value } from './values';

const REQUIRE_ARRAY = 0x1_00_00_00;
const REQUIRE_SCALAR = 0x2_00_00_00;
const FORCE_ARRAY = 0x4_00_00_00;
const NULL_ON_FAILURE = 0x8_00_00_00;
const THROW_ON_FAILURE = 0x10_00_00_00;

const ALLOW_OCTAL = 0x1;
const ALLOW_HEX = 0x2;
const STRIP_LOW = 0x4;
const STRIP_HIGH = 0x8;
const ENCODE_LOW = 0x10;
const ENCODE_HIGH = 0x20;
const ENCODE_AMP = 0x40;
const NO_ENCODE_QUOTES = 0x80;
const EMPTY_STRING_NULL = 0x1_00;
const STRIP_BACKTICK = 0x2_00;
const ALLOW_FRACTION = 0x10_00;
const ALLOW_THOUSAND = 0x20_00;
const ALLOW_SCIENTIFIC = 0x40_00;
const PATH_REQUIRED = 0x4_00_00;
const QUERY_REQUIRED = 0x8_00_00;
const IPV4 = 0x10_00_00;
const IPV6 = 0x20_00_00;
const NO_RES_RANGE = 0x40_00_00;
const NO_PRIV_RANGE = 0x80_00_00;
const GLOBAL_RANGE = 0x20_00_00_00;
const HOSTNAME = 0x10_00_00;
const EMAIL_UNICODE = 0x10_00_00;

const FILTER_DEFAULT = 0x2_04n;
const FILTER_CALLBACK = 0x4_00n;

for (const [index, name] of ['POST', 'GET', 'COOKIE', undefined, 'ENV', 'SERVER'].entries()) {
  if (name) defineConstant(`INPUT_${name}`, BigInt(index));
}
for (const [name, value] of Object.entries({
  FILTER_FLAG_NONE: 0,
  FILTER_REQUIRE_SCALAR: REQUIRE_SCALAR,
  FILTER_REQUIRE_ARRAY: REQUIRE_ARRAY,
  FILTER_FORCE_ARRAY: FORCE_ARRAY,
  FILTER_NULL_ON_FAILURE: NULL_ON_FAILURE,
  FILTER_THROW_ON_FAILURE: THROW_ON_FAILURE,
  FILTER_VALIDATE_INT: 0x1_01,
  FILTER_VALIDATE_BOOLEAN: 0x1_02,
  FILTER_VALIDATE_BOOL: 0x1_02,
  FILTER_VALIDATE_FLOAT: 0x1_03,
  FILTER_VALIDATE_REGEXP: 0x1_10,
  FILTER_VALIDATE_DOMAIN: 0x1_15,
  FILTER_VALIDATE_URL: 0x1_11,
  FILTER_VALIDATE_EMAIL: 0x1_12,
  FILTER_VALIDATE_IP: 0x1_13,
  FILTER_VALIDATE_MAC: 0x1_14,
  FILTER_DEFAULT: Number(FILTER_DEFAULT),
  FILTER_UNSAFE_RAW: Number(FILTER_DEFAULT),
  FILTER_SANITIZE_ENCODED: 0x2_02,
  FILTER_SANITIZE_SPECIAL_CHARS: 0x2_03,
  FILTER_SANITIZE_FULL_SPECIAL_CHARS: 0x2_0a,
  FILTER_SANITIZE_EMAIL: 0x2_05,
  FILTER_SANITIZE_URL: 0x2_06,
  FILTER_SANITIZE_NUMBER_INT: 0x2_07,
  FILTER_SANITIZE_NUMBER_FLOAT: 0x2_08,
  FILTER_SANITIZE_ADD_SLASHES: 0x2_0b,
  FILTER_CALLBACK: Number(FILTER_CALLBACK),
  FILTER_FLAG_ALLOW_OCTAL: ALLOW_OCTAL,
  FILTER_FLAG_ALLOW_HEX: ALLOW_HEX,
  FILTER_FLAG_STRIP_LOW: STRIP_LOW,
  FILTER_FLAG_STRIP_HIGH: STRIP_HIGH,
  FILTER_FLAG_STRIP_BACKTICK: STRIP_BACKTICK,
  FILTER_FLAG_ENCODE_LOW: ENCODE_LOW,
  FILTER_FLAG_ENCODE_HIGH: ENCODE_HIGH,
  FILTER_FLAG_ENCODE_AMP: ENCODE_AMP,
  FILTER_FLAG_NO_ENCODE_QUOTES: NO_ENCODE_QUOTES,
  FILTER_FLAG_EMPTY_STRING_NULL: EMPTY_STRING_NULL,
  FILTER_FLAG_ALLOW_FRACTION: ALLOW_FRACTION,
  FILTER_FLAG_ALLOW_THOUSAND: ALLOW_THOUSAND,
  FILTER_FLAG_ALLOW_SCIENTIFIC: ALLOW_SCIENTIFIC,
  FILTER_FLAG_PATH_REQUIRED: PATH_REQUIRED,
  FILTER_FLAG_QUERY_REQUIRED: QUERY_REQUIRED,
  FILTER_FLAG_IPV4: IPV4,
  FILTER_FLAG_IPV6: IPV6,
  FILTER_FLAG_NO_RES_RANGE: NO_RES_RANGE,
  FILTER_FLAG_NO_PRIV_RANGE: NO_PRIV_RANGE,
  FILTER_FLAG_GLOBAL_RANGE: GLOBAL_RANGE,
  FILTER_FLAG_HOSTNAME: HOSTNAME,
  FILTER_FLAG_EMAIL_UNICODE: EMAIL_UNICODE,
})) {
  defineConstant(name, BigInt(value));
}
for (const name of ['FILTER_SANITIZE_STRING', 'FILTER_SANITIZE_STRIPPED']) {
  defineConstant(name, 0x2_01n, `Constant ${name} is deprecated since 8.1, use htmlspecialchars() instead`);
}

defineClass({ name: String.raw`Filter\FilterException`, parent: 'Exception' });
defineClass({ name: String.raw`Filter\FilterFailedException`, parent: String.raw`Filter\FilterException` });
const FAILED_EXCEPTION = String.raw`Filter\FilterFailedException`;

// Entry points -------------------------------------------------------------------------------------------------------

defineFunction('filter_var(mixed $value, int $filter = FILTER_DEFAULT, array|int $options = 0): mixed', ({ args }) => {
  const filter = (args[1] as bigint | undefined) ?? FILTER_DEFAULT;
  if (!filterExists(filter)) {
    warn(`filter_var(): Unknown filter with ID ${filter}`);
    return false;
  }
  return filterCall(
    { name: 'filter_var', optionsArgument: 3 },
    args[0],
    filter,
    (args[2] as PhpArray | bigint | undefined) ?? 0n,
    REQUIRE_SCALAR
  );
});

defineFunction(
  'filter_var_array(array $array, array|int $options = FILTER_DEFAULT, bool $add_empty = true): array|false|null',
  // code-gauge-allow functionCognitiveComplexity -- Follows php_filter_array_handler, which checks each definition entry in order.
  ({ args }) => {
    const input = args[0] as PhpArray;
    const definition = (args[1] as PhpArray | bigint | undefined) ?? FILTER_DEFAULT;
    const call = { name: 'filter_var_array', optionsArgument: 2 };
    if (!(definition instanceof PhpArray)) {
      if (!filterExists(definition)) {
        warn(`filter_var_array(): Unknown filter with ID ${definition}`);
        return false;
      }
      return filterCall(call, input, -1n, definition, REQUIRE_ARRAY);
    }
    const result = new PhpArray();
    for (const [key, element] of definition.entries()) {
      if (typeof key !== 'string')
        throwError('TypeError', 'filter_var_array(): Argument #2 ($options) must contain only string keys');
      if (key === '') throwError('ValueError', 'filter_var_array(): Argument #2 ($options) cannot contain empty keys');
      const value = input.get(key);
      if (value === undefined) {
        if (args[2] !== false) result.set(key, null);
        continue;
      }
      if (element instanceof PhpArray) {
        result.set(key, filterCall(call, value, -1n, element, REQUIRE_SCALAR));
      } else {
        const filter = toInt(element);
        if (!filterExists(filter)) warn(`filter_var_array(): Unknown filter with ID ${filter}`);
        result.set(key, filterCall(call, value, -1n, filter, REQUIRE_SCALAR));
      }
    }
    return result;
  }
);

defineFunction('filter_has_var(int $input_type, string $var_name): bool', ({ args }) => {
  const input = args[0] as bigint;
  if (input === 4n || input === 5n)
    throw new UnsupportedFeatureError(`${input === 4n ? '環境変数' : 'サーバーの情報'}の検査（filter_has_var）`);
  if (input < 0n || input > 2n)
    throwError('ValueError', 'filter_has_var(): Argument #1 ($input_type) must be an INPUT_* constant');
  // The CLI receives no request, so GET, POST, and cookie input is always empty.
  return false;
});

defineFunction('filter_list(): array', () => PhpArray.list(FILTERS.map((filter) => filter.name)));

defineFunction('filter_id(string $name): int|false', ({ args }) => {
  const name = untilNul(args[0] as string);
  return FILTERS.find((filter) => filter.name === name)?.id ?? false;
});

// Applying a filter --------------------------------------------------------------------------------------------------

interface FilterCall {
  name: string;
  /** The position of the `$options` parameter, which errors about the flags name. */
  optionsArgument: number;
}

type Options = PhpArray | Value | undefined;

function filterExists(id: bigint): boolean {
  return (id >= 0x2_00n && id <= 0x2_0bn) || (id >= 0x1_00n && id <= 0x1_15n) || id === FILTER_CALLBACK;
}

/**
 * Filters a value as php_filter_call does. A `filter` of -1 takes the filter from `filterArgs`: from its `filter` key
 * when it is a definition array, or as the ID itself when it is an int, as filter_var_array passes one.
 */
// code-gauge-allow functionNcss -- Follows php_filter_call, which reads the definition and flags in this order.
// code-gauge-allow functionCognitiveComplexity -- Follows php_filter_call, which reads the definition and flags in this order.
function filterCall(
  call: FilterCall,
  value: Value,
  filterId: bigint,
  filterArgs: PhpArray | bigint,
  defaultFlags: number
): Value {
  let filter = filterId;
  let flags = defaultFlags;
  let options: Options;
  if (filterArgs instanceof PhpArray) {
    const filterOption = filterArgs.get('filter');
    if (filterOption !== undefined) filter = toInt(filterOption);
    const optionsOption = filterArgs.get('options');
    if (optionsOption !== undefined) {
      if (filter !== FILTER_CALLBACK) {
        if (optionsOption instanceof PhpArray) options = optionsOption;
      } else {
        options = optionsOption;
        flags = 0;
      }
    }
    const flagsOption = filterArgs.get('flags');
    if (flagsOption !== undefined) flags = scalarUnlessArray(toFlags(toInt(flagsOption)));
  } else if (filter === -1n) filter = filterArgs;
  else flags = scalarUnlessArray(toFlags(filterArgs));
  if (flags & NULL_ON_FAILURE && flags & THROW_ON_FAILURE) {
    throwError(
      'ValueError',
      `${call.name}(): Argument #${call.optionsArgument} ($options) cannot use both FILTER_NULL_ON_FAILURE and FILTER_THROW_ON_FAILURE`
    );
  }
  const filterFunction = findFilter(filter);
  if (value instanceof PhpArray) {
    if (flags & REQUIRE_SCALAR) {
      if (flags & THROW_ON_FAILURE)
        throwError(FAILED_EXCEPTION, 'filter validation failed: not a scalar value (got an array)');
      return failure(flags);
    }
    return filterArray(call, value, filterFunction, flags, options, new Set());
  }
  if (flags & REQUIRE_ARRAY) {
    if (flags & THROW_ON_FAILURE)
      throwError(FAILED_EXCEPTION, `filter validation failed: not an array (got ${valueName(value)})`);
    return failure(flags);
  }
  const result = filterValue(call, value, filterFunction, flags, options);
  return flags & FORCE_ARRAY ? PhpArray.list([result]) : result;
}

/** The flags as a filter reads them: PHP's flags all fit in the low 31 bits. */
function toFlags(value: bigint): number {
  return Number(BigInt.asUintN(31, value));
}

function scalarUnlessArray(flags: number): number {
  return flags & (REQUIRE_ARRAY | FORCE_ARRAY) ? flags : flags | REQUIRE_SCALAR;
}

function failure(flags: number): null | false {
  return flags & NULL_ON_FAILURE ? null : false;
}

function filterArray(
  call: FilterCall,
  array: PhpArray,
  filter: FilterEntry,
  flags: number,
  options: Options,
  visiting: Set<PhpArray>
): PhpArray {
  // PHP leaves an array that contains itself as it is where it recurs.
  if (visiting.has(array)) return array;
  visiting.add(array);
  const result = new PhpArray();
  for (const [key, element] of array.entries()) {
    result.set(
      key,
      element instanceof PhpArray
        ? filterArray(call, element, filter, flags, options, visiting)
        : filterValue(call, element, filter, flags, options)
    );
  }
  visiting.delete(array);
  return result;
}

/** Filters a scalar or an object as php_zval_filter does, then replaces a failure with the `default` option. */
function filterValue(call: FilterCall, value: Value, filter: FilterEntry, flags: number, options: Options): Value {
  let result: Value;
  if (value instanceof PhpObject && !value.isResource && !value.cls.findMethod('__tostring')) {
    if (flags & THROW_ON_FAILURE) {
      throwError(
        FAILED_EXCEPTION,
        `filter validation failed: object of type ${value.cls.name} has no __toString() method`
      );
    }
    result = failure(flags);
  } else {
    const text = toStr(value);
    rt().spend(1 + Math.ceil(text.length / 64));
    const outcome = filter.run(text, flags, options, call.name);
    if (outcome === FAILED) {
      if (flags & THROW_ON_FAILURE) {
        throwError(
          FAILED_EXCEPTION,
          `filter validation failed: filter ${filter.name} not satisfied by '${untilNul(text)}'`
        );
      }
      result = failure(flags);
    } else result = outcome;
  }
  if (options instanceof PhpArray && result === failure(flags)) {
    const fallback = options.get('default');
    if (fallback !== undefined) result = fallback;
  }
  return result;
}

const FAILED = Symbol('failed');

type FilterFunction = (text: string, flags: number, options: Options, functionName: string) => Value | typeof FAILED;

interface FilterEntry {
  name: string;
  id: bigint;
  run: FilterFunction;
}

function findFilter(id: bigint): FilterEntry {
  return (
    FILTERS.find((filter) => filter.id === id) ??
    (FILTERS.find((filter) => filter.id === FILTER_DEFAULT) as FilterEntry)
  );
}

function option(options: Options, name: string): Value | undefined {
  return options instanceof PhpArray ? options.get(name) : undefined;
}

function stringOption(options: Options, name: string): string | undefined {
  const value = option(options, name);
  return typeof value === 'string' ? value : undefined;
}

function intOption(options: Options, name: string): bigint | undefined {
  const value = option(options, name);
  return value === undefined ? undefined : toInt(value);
}

function floatOption(options: Options, name: string): number | undefined {
  const value = option(options, name);
  return value === undefined ? undefined : toFloat(value);
}

// Validation filters -------------------------------------------------------------------------------------------------

/** Trims the whitespace PHP_FILTER_TRIM_DEFAULT does, which leaves out the form feed. */
function trimDefault(text: string): string {
  return text.replace(/^[ \t\r\v\n]+/, '').replace(/[ \t\r\v\n]+$/, '');
}

// code-gauge-allow functionCognitiveComplexity -- Follows php_filter_int, which reads decimal, hexadecimal, and octal forms by the flags.
function validateInt(text: string, flags: number, options: Options): Value | typeof FAILED {
  const min = intOption(options, 'min_range');
  const max = intOption(options, 'max_range');
  const trimmed = trimDefault(text);
  if (trimmed === '') return FAILED;
  let value: bigint | undefined;
  if (trimmed[0] === '0') {
    let rest = trimmed.slice(1);
    if (flags & ALLOW_HEX && (rest[0] === 'x' || rest[0] === 'X')) {
      rest = rest.slice(1);
      value = rest === '' ? undefined : parseUnsigned(rest, 16);
    } else if (flags & ALLOW_OCTAL) {
      const prefixed = rest[0] === 'o' || rest[0] === 'O';
      if (prefixed) rest = rest.slice(1);
      value = prefixed && rest === '' ? undefined : parseUnsigned(rest, 8);
    } else if (rest === '') value = 0n;
  } else if (/^[+-]?(?:0|[1-9]\d*)$/.test(trimmed)) {
    value = BigInt(trimmed);
    if (value !== BigInt.asIntN(64, value)) value = undefined;
  }
  if (value === undefined || (min !== undefined && value < min) || (max !== undefined && value > max)) return FAILED;
  return value;
}

/** Reads hexadecimal or octal digits as an unsigned 64-bit number, which PHP then stores as a signed int. */
function parseUnsigned(digits: string, radix: 8 | 16): bigint | undefined {
  if (!(radix === 16 ? /^[\dA-Fa-f]*$/ : /^[0-7]*$/).test(digits)) return undefined;
  const value = digits === '' ? 0n : BigInt(`${radix === 16 ? '0x' : '0o'}${digits}`);
  return value > 0xff_ff_ff_ff_ff_ff_ff_ffn ? undefined : BigInt.asIntN(64, value);
}

function validateBool(text: string): Value | typeof FAILED {
  switch (lower(trimDefault(text))) {
    case '':
    case '0':
    case 'no':
    case 'off':
    case 'false': {
      return false;
    }
    case '1':
    case 'on':
    case 'yes':
    case 'true': {
      return true;
    }
    default: {
      return FAILED;
    }
  }
}

function validateFloat(text: string, flags: number, options: Options, functionName: string): Value | typeof FAILED {
  const input = trimDefault(text);
  if (input === '') return FAILED;
  const format = floatFormat(options, flags, functionName);
  const min = floatOption(options, 'min_range');
  const max = floatOption(options, 'max_range');
  const number = scanFloat(input, format);
  if (number === undefined) return FAILED;
  const parsed = numericValue(number);
  if (parsed === undefined) return FAILED;
  const result = Number(parsed);
  if (
    typeof parsed === 'number' &&
    ((result === 0 && number.length > 1 && /[1-9]/.test(number)) || !Number.isFinite(result))
  ) {
    return FAILED;
  }
  if ((min !== undefined && result < min) || (max !== undefined && result > max)) return FAILED;
  return result;
}

interface FloatFormat {
  decimal: string;
  /** The thousands separators, or undefined when the flags do not allow them. */
  thousands: string | undefined;
}

function floatFormat(options: Options, flags: number, functionName: string): FloatFormat {
  const decimal = stringOption(options, 'decimal');
  if (decimal !== undefined && decimal.length !== 1) {
    throwError('ValueError', `${functionName}(): "decimal" option must be one character long`);
  }
  const thousand = stringOption(options, 'thousand');
  if (thousand === '') throwError('ValueError', `${functionName}(): "thousand" option must not be empty`);
  return { decimal: decimal ?? '.', thousands: flags & ALLOW_THOUSAND ? untilNul(thousand ?? "',.") : undefined };
}

/** Copies a number as php_filter_float scans it, with thousands separators dropped and `.` as its decimal point. */
// code-gauge-allow functionCognitiveComplexity -- Follows php_filter_float, which checks the digit groups between thousands separators in one loop.
function scanFloat(input: string, format: FloatFormat): string | undefined {
  const scanner = new FloatScanner(input);
  scanner.sign();
  for (let first = true; ; first = false) {
    const digits = scanner.digits();
    const char = scanner.char;
    if (scanner.atEnd || char === format.decimal || char === 'e' || char === 'E') {
      if (!first && digits !== 3) return undefined;
      scanner.fractionAndExponent(format.decimal);
      return scanner.atEnd ? scanner.number : undefined;
    }
    // strchr also finds the terminating NUL, so a NUL byte counts as a thousands separator.
    if (format.thousands === undefined || !(format.thousands.includes(char) || char === '\0')) return undefined;
    if (first ? digits < 1 || digits > 3 : digits !== 3) return undefined;
    scanner.skip();
  }
}

class FloatScanner {
  number = '';
  private index = 0;

  constructor(private readonly input: string) {}

  /** The current character, or NUL past the end as C's string end reads. */
  get char(): string {
    return this.input[this.index] ?? '\0';
  }

  get atEnd(): boolean {
    return this.index === this.input.length;
  }

  sign(): void {
    if (this.char === '+' || this.char === '-') this.take();
  }

  digits(): number {
    let count = 0;
    for (; this.char >= '0' && this.char <= '9'; count++) this.take();
    return count;
  }

  fractionAndExponent(decimal: string): void {
    if (this.char === decimal) {
      this.number += '.';
      this.skip();
      this.digits();
    }
    if (this.char === 'e' || this.char === 'E') {
      this.take();
      this.sign();
      this.digits();
    }
  }

  skip(): void {
    this.index++;
  }

  private take(): void {
    this.number += this.input[this.index++];
  }
}

function validateRegexp(text: string, _flags: number, options: Options, functionName: string): Value | typeof FAILED {
  const pattern = stringOption(options, 'regexp');
  if (pattern === undefined) throwError('ValueError', `${functionName}(): "regexp" option is missing`);
  return patternMatches(functionName, pattern, text) ? text : FAILED;
}

function validateDomain(text: string, flags: number): Value | typeof FAILED {
  return isValidDomain(text, (flags & HOSTNAME) !== 0) ? text : FAILED;
}

/** Checks a domain as php_filter_validate_domain_ex does, which reads the byte after a label as C's string end allows. */
// code-gauge-allow functionCognitiveComplexity -- Follows php_filter_validate_domain_ex, which checks labels and their characters in one scan.
function isValidDomain(domain: string, hostname: boolean): boolean {
  const at = (index: number): number => (index < domain.length ? domain.charCodeAt(index) : 0);
  const end = domain.endsWith('.') ? domain.length - 1 : domain.length;
  if (end > 253) return false;
  if (at(0) === 0x2e || (hostname && !isAlnum(at(0)))) return false;
  let labelLength = 1;
  for (let index = 0; index < end; index++) {
    const char = at(index);
    if (char === 0x2e) {
      if (at(index + 1) === 0x2e || (hostname && (!isAlnum(at(index - 1)) || !isAlnum(at(index + 1))))) return false;
      labelLength = 1;
    } else {
      if (labelLength > 63 || (hostname && (char !== 0x2d || at(index + 1) === 0) && !isAlnum(char))) return false;
      labelLength++;
    }
  }
  return true;
}

function isAlnum(code: number): boolean {
  return isDigit(code) || isCtypeAlpha(code);
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

// code-gauge-allow functionCognitiveComplexity -- Follows php_filter_validate_url, whose checks depend on the scheme and the flags.
function validateUrl(text: string, flags: number, options: Options, functionName: string): Value | typeof FAILED {
  if (sanitizeUrl(text).length !== text.length) return FAILED;
  const parser = stringOption(options, 'uri_parser_class');
  if (parser !== undefined && parser !== 'parse_url') {
    if (parser === String.raw`Uri\Rfc3986\Uri` || parser === String.raw`Uri\WhatWg\Url`) {
      throw new UnsupportedFeatureError(`URI 拡張の解析器（${parser}）`);
    }
    throwError('ValueError', `${functionName}(): "uri_parser_class" option has invalid value`);
  }
  const url = parseUrl(text);
  if (!url) return FAILED;
  if (url.scheme !== undefined && (lower(url.scheme) === 'http' || lower(url.scheme) === 'https')) {
    if (url.host === undefined) return FAILED;
    if (!isBracketedIpv6(url.host) && !isValidDomain(url.host, true)) return FAILED;
  }
  if (
    url.scheme === undefined ||
    (url.host === undefined && url.scheme !== 'mailto' && url.scheme !== 'news' && url.scheme !== 'file') ||
    (flags & PATH_REQUIRED && url.path === undefined) ||
    (flags & QUERY_REQUIRED && url.query === undefined)
  ) {
    return FAILED;
  }
  if (
    (url.user !== undefined && !isValidUserinfo(url.user)) ||
    (url.pass !== undefined && !isValidUserinfo(url.pass))
  ) {
    return FAILED;
  }
  return text;
}

function isBracketedIpv6(host: string): boolean {
  return host.startsWith('[') && host.endsWith(']') && parseIpv6(host.slice(1, -1)) !== undefined;
}

/** Checks user information as is_userinfo_valid does, which wants a decimal digit right after `%`. */
function isValidUserinfo(text: string): boolean {
  const at = (index: number): number => (index < text.length ? text.charCodeAt(index) : 0);
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (isAlnum(at(index)) || "-._~!$&'()*+,;=:\0".includes(char)) index++;
    else if (char === '%' && isDigit(at(index + 1)) && /[\dA-Fa-f]/.test(String.fromCharCode(at(index + 2))))
      index += 3;
    else return false;
  }
  return true;
}

// The patterns of php_filter_validate_email, based on Michael Rushton's (Copyright © Michael Rushton 2009-10, http://squiloople.com/).
const EMAIL_LOCAL = String.raw`^(?!(?:(?:\x22?\x5C[\x00-\x7E]\x22?)|(?:\x22?[^\x5C\x22]\x22?)){255,})(?!(?:(?:\x22?\x5C[\x00-\x7E]\x22?)|(?:\x22?[^\x5C\x22]\x22?)){65,}@)(?:(?:[\x21\x23-\x27\x2A\x2B\x2D\x2F-\x39\x3D\x3F\x5E-\x7E$U]+)|(?:\x22(?:[\x01-\x08\x0B\x0C\x0E-\x1F\x21\x23-\x5B\x5D-\x7F$U]|(?:\x5C[\x00-\x7F]))*\x22))(?:\.(?:(?:[\x21\x23-\x27\x2A\x2B\x2D\x2F-\x39\x3D\x3F\x5E-\x7E$U]+)|(?:\x22(?:[\x01-\x08\x0B\x0C\x0E-\x1F\x21\x23-\x5B\x5D-\x7F$U]|(?:\x5C[\x00-\x7F]))*\x22)))*@`;
const EMAIL_DOMAIN = String.raw`(?:(?:(?!.*[^.]{64,})(?:(?:(?:xn--)?[a-z0-9]+(?:-+[a-z0-9]+)*\.){1,126}){1,}(?:(?:[a-z][a-z0-9]*)|(?:(?:xn--)[a-z0-9]+))(?:-+[a-z0-9]+)*)|(?:\[(?:(?:IPv6:(?:(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){7})|(?:(?!(?:.*[a-f0-9][:\]]){7,})(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){0,5})?::(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){0,5})?)))|(?:(?:IPv6:(?:(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){5}:)|(?:(?!(?:.*[a-f0-9]:){5,})(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){0,3})?::(?:[a-f0-9]{1,4}(?::[a-f0-9]{1,4}){0,3}:)?)))?(?:(?:25[0-5])|(?:2[0-4][0-9])|(?:1[0-9]{2})|(?:[1-9]?[0-9]))(?:\.(?:(?:25[0-5])|(?:2[0-4][0-9])|(?:1[0-9]{2})|(?:[1-9]?[0-9]))){3}))\]))$`;
const EMAIL_PATTERN = `/${EMAIL_LOCAL.replaceAll('$U', '')}${EMAIL_DOMAIN}/iD`;
const UNICODE_EMAIL_PATTERN = `/${EMAIL_LOCAL.replaceAll('$U', String.raw`\pL\pN`)}${EMAIL_DOMAIN}/iDu`;

function validateEmail(text: string, flags: number, _options: Options, functionName: string): Value | typeof FAILED {
  // RFC 2821 limits an address to 320 octets.
  if (text.length > 320) return FAILED;
  return patternMatches(functionName, flags & EMAIL_UNICODE ? UNICODE_EMAIL_PATTERN : EMAIL_PATTERN, text)
    ? text
    : FAILED;
}

interface RangeStatus {
  global: boolean;
  reserved: boolean;
  private: boolean;
}

// code-gauge-allow functionCognitiveComplexity -- Follows php_filter_validate_ip, whose flags each reject a kind of range.
function validateIp(text: string, flags: number): Value | typeof FAILED {
  const ipv6 = text.includes(':');
  if (!ipv6 && !text.includes('.')) return FAILED;
  if (!(flags & IPV4 && flags & IPV6) && ((flags & IPV4 && ipv6) || (flags & IPV6 && !ipv6))) return FAILED;
  const address = ipv6 ? parseIpv6(text) : parseIpv4(text);
  if (!address) return FAILED;
  const status = ipv6 ? ipv6Status(address) : ipv4Status(address);
  if (!status) return text;
  if (flags & GLOBAL_RANGE && !status.global) return FAILED;
  if (flags & NO_PRIV_RANGE && status.private) return FAILED;
  if (flags & NO_RES_RANGE && status.reserved) return FAILED;
  return text;
}

/** Parses dotted decimal IPv4 as _php_filter_validate_ipv4 does, which rejects leading zeros. */
function parseIpv4(text: string): number[] | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const address: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255) return undefined;
    address.push(Number(part));
  }
  return address;
}

/** Parses IPv6 into its eight 16-bit blocks as _php_filter_validate_ipv6 does, or returns undefined if it is invalid. */
function parseIpv6(text: string): number[] | undefined {
  if (!text.includes(':')) return undefined;
  const head = ipv6Head(text);
  if (!head) return undefined;
  const scanned = scanIpv6Blocks(text, head.end, head.ipv4 ? 2 : 0);
  if (!scanned || !((scanned.compressed >= 0 && scanned.blocks <= 8) || scanned.blocks === 8)) return undefined;
  if (head.ipv4) {
    const [a, b, c, d] = head.ipv4;
    return [0, 0, 0, 0, 0, 0xff_ff, 256 * a + b, 256 * c + d];
  }
  const { ip, blocks, compressed } = scanned;
  if (compressed >= 0) {
    const offset = 8 - blocks;
    for (let index = 7; index > compressed + offset; index--) ip[index] = ip[index - offset];
    for (let index = compressed + offset; index >= compressed; index--) ip[index] = 0;
  }
  return ip;
}

/** Where the hexadecimal blocks of an IPv6 address end, and the IPv4 address after them, or undefined if invalid. */
function ipv6Head(text: string): { end: number; ipv4?: number[] } | undefined {
  const dot = text.indexOf('.');
  if (dot === -1) return { end: text.length };
  const start = text.lastIndexOf(':', dot) + 1;
  const ipv4 = parseIpv4(text.slice(start));
  if (!ipv4 || start < 2) return undefined;
  // The colon before the IPv4 address belongs to it unless it is the second of `::`.
  return { end: text[start - 2] === ':' ? start : start - 1, ipv4 };
}

interface Ipv6Blocks {
  ip: number[];
  blocks: number;
  /** The block where `::` stands, or -1 for none. */
  compressed: number;
}

/** Reads the hexadecimal blocks and `::` before `end`, counting from `blocks`. */
// code-gauge-allow functionCognitiveComplexity -- Follows _php_filter_validate_ipv6, which reads blocks and `::` in one scan.
function scanIpv6Blocks(text: string, end: number, blocks: number): Ipv6Blocks | undefined {
  const state: Ipv6Blocks = { ip: [], blocks, compressed: -1 };
  for (let index = 0; index < end;) {
    if (text[index] === ':') {
      const next = skipIpv6Separator(text, index, end, state);
      if (next === undefined) return undefined;
      if (next === end) return state;
      index = next;
    }
    const digits = /^[\dA-Fa-f]*/.exec(text.slice(index, end))?.[0] ?? '';
    if (digits.length === 0 || digits.length > 4) return undefined;
    if (state.blocks < 8) state.ip[state.blocks] = Number.parseInt(digits, 16);
    index += digits.length;
    if (++state.blocks > 8) return undefined;
  }
  return state;
}

/** Skips the `:` or `::` at `index`, recording where `::` stands, and returns the index after it or undefined. */
function skipIpv6Separator(text: string, index: number, end: number, state: Ipv6Blocks): number | undefined {
  const next = index + 1;
  if (next >= end) return undefined;
  if (text[next] !== ':') return next === 1 ? undefined : next;
  if (state.compressed >= 0) return undefined;
  if (state.blocks < 8) state.ip[state.blocks] = -1;
  state.compressed = state.blocks++;
  return next + 1 === end && state.blocks > 8 ? undefined : next + 1;
}

/** The special-purpose range an IPv4 address is in, from the tables of RFC 6890, or undefined for none. */
// code-gauge-allow functionCognitiveComplexity -- Mirrors the ordered table of ipv4_get_status_flags.
function ipv4Status([a, b, c]: number[]): RangeStatus | undefined {
  const status = (kind?: keyof RangeStatus): RangeStatus => ({
    global: kind === 'global',
    reserved: kind === 'reserved',
    private: kind === 'private',
  });
  if (a === 0 || a === 127 || (a === 169 && b === 254) || a >= 240) return status('reserved');
  if (a === 10 || (a === 172 && b >= 16 && b <= 31)) return status('private');
  if (a === 100 && b >= 64 && b <= 127) return status();
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return status();
  if (a === 192 && b === 88 && c === 99) return status('global');
  if (a === 192 && b === 168) return status('private');
  if (
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return status();
  }
  return undefined;
}

/** The special-purpose range an IPv6 address is in, from the tables of RFC 6890, or undefined for none. */
// code-gauge-allow functionCognitiveComplexity -- Mirrors the ordered table of ipv6_get_status_flags.
function ipv6Status(ip: number[]): RangeStatus | undefined {
  const status = (kind?: keyof RangeStatus): RangeStatus => ({
    global: kind === 'global',
    reserved: kind === 'reserved',
    private: kind === 'private',
  });
  const zeroUntil = (count: number): boolean => ip.slice(0, count).every((block) => block === 0);
  if (zeroUntil(7) && (ip[7] === 0 || ip[7] === 1)) return status('reserved');
  if (ip[0] === 0x64 && ip[1] === 0xff_9b) return status('global');
  if (zeroUntil(5) && ip[5] === 0xff_ff) return status('reserved');
  if ((ip[0] === 0x1_00 && ip[1] === 0 && ip[2] === 0 && ip[3] === 0) || (ip[0] === 0x20_01 && ip[1] <= 0x1_ff)) {
    return status();
  }
  if (ip[0] === 0x20_01 && (ip[1] === 0xd_b8 || (ip[1] >= 0x10 && ip[1] <= 0x1f))) return status();
  if (ip[0] === 0x20_02) return status();
  if (ip[0] >= 0xfc_00 && ip[0] <= 0xfd_ff) return status('private');
  if (ip[0] >= 0xfe_80 && ip[0] <= 0xfe_bf) return status('reserved');
  return undefined;
}

function validateMac(text: string, _flags: number, options: Options, functionName: string): Value | typeof FAILED {
  const expected = stringOption(options, 'separator');
  if (expected !== undefined && expected.length !== 1) {
    throwError('ValueError', `${functionName}(): "separator" option must be one character long`);
  }
  let format: [tokens: number, length: number, separator: string];
  if (text.length === 14) format = [3, 4, '.'];
  else if (text.length === 17 && (text[2] === '-' || text[2] === ':')) format = [6, 2, text[2]];
  else return FAILED;
  const [tokens, length, separator] = format;
  if (expected !== undefined && expected !== separator) return FAILED;
  for (let token = 0; token < tokens; token++) {
    const offset = token * (length + 1);
    if (token < tokens - 1 && text[offset + length] !== separator) return FAILED;
    if (!/^[\dA-Fa-f]+$/.test(text.slice(offset, offset + length))) return FAILED;
  }
  return text;
}

// Sanitizing filters -------------------------------------------------------------------------------------------------

function strip(text: string, flags: number): string {
  if (!(flags & (STRIP_LOW | STRIP_HIGH | STRIP_BACKTICK))) return text;
  let result = '';
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (
      !(
        (code >= 127 && flags & STRIP_HIGH) ||
        (code < 32 && flags & STRIP_LOW) ||
        (code === 0x60 && flags & STRIP_BACKTICK)
      )
    ) {
      result += text[index];
    }
  }
  return result;
}

/** Writes the bytes `encodes` selects as decimal numeric character references. */
function encodeHtml(text: string, encodes: (code: number) => boolean): string {
  let result = '';
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    result += encodes(code) ? `&#${code};` : text[index];
  }
  rt().ensureStringFits(result.length);
  return result;
}

function sanitizeString(text: string, flags: number): Value {
  const encoded = encodeHtml(
    strip(text, flags),
    (code) =>
      ((code === 0x27 || code === 0x22) && !(flags & NO_ENCODE_QUOTES)) ||
      (code === 0x26 && (flags & ENCODE_AMP) !== 0) ||
      (code < 32 && (flags & ENCODE_LOW) !== 0) ||
      (code >= 127 && (flags & ENCODE_HIGH) !== 0)
  );
  const stripped = stripTags(encoded, '', true);
  if (stripped !== '') return stripped;
  return flags & EMPTY_STRING_NULL ? null : '';
}

function sanitizeEncoded(text: string, flags: number): Value {
  const result = strip(text, flags).replaceAll(
    /[^\w.-]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  );
  rt().ensureStringFits(result.length);
  return result;
}

function sanitizeSpecialChars(text: string, flags: number): Value {
  return encodeHtml(
    strip(text, flags),
    (code) => code < 32 || '\'"<>&'.includes(String.fromCharCode(code)) || (code >= 127 && (flags & ENCODE_HIGH) !== 0)
  );
}

function sanitizeFullSpecialChars(text: string, flags: number): Value {
  const result = escapeHtml(text, flags & NO_ENCODE_QUOTES ? 0n : 3n, true, false);
  rt().ensureStringFits(result.length);
  return result;
}

function unsafeRaw(text: string, flags: number): Value {
  if (flags !== 0 && text !== '') {
    return encodeHtml(
      strip(text, flags),
      (code) =>
        (code === 0x26 && (flags & ENCODE_AMP) !== 0) ||
        (code < 32 && (flags & ENCODE_LOW) !== 0) ||
        (code >= 127 && (flags & ENCODE_HIGH) !== 0)
    );
  }
  return flags & EMPTY_STRING_NULL && text === '' ? null : text;
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function keepOnly(text: string, allowed: string): string {
  let result = '';
  for (const char of text) if (allowed.includes(char)) result += char;
  return result;
}

function sanitizeUrl(text: string): string {
  return keepOnly(text, `${ALNUM}$-_.+!*'(),{}|\\^~[]\`<>#%";/?:@&=`);
}

function sanitizeNumberFloat(text: string, flags: number): Value {
  let allowed = '+-0123456789';
  if (flags & ALLOW_FRACTION) allowed += '.';
  if (flags & ALLOW_THOUSAND) allowed += ',';
  if (flags & ALLOW_SCIENTIFIC) allowed += 'eE';
  return keepOnly(text, allowed);
}

function callback(text: string, _flags: number, options: Options, functionName: string): Value {
  if (options === undefined || !checkCallable(options))
    throwError('TypeError', `${functionName}(): Option must be a valid callback`);
  return callCallback(options, [text]);
}

const FILTERS: FilterEntry[] = [
  { name: 'int', id: 0x1_01n, run: validateInt },
  { name: 'boolean', id: 0x1_02n, run: validateBool },
  { name: 'float', id: 0x1_03n, run: validateFloat },
  { name: 'validate_regexp', id: 0x1_10n, run: validateRegexp },
  { name: 'validate_domain', id: 0x1_15n, run: validateDomain },
  { name: 'validate_url', id: 0x1_11n, run: validateUrl },
  { name: 'validate_email', id: 0x1_12n, run: validateEmail },
  { name: 'validate_ip', id: 0x1_13n, run: validateIp },
  { name: 'validate_mac', id: 0x1_14n, run: validateMac },
  { name: 'string', id: 0x2_01n, run: sanitizeString },
  { name: 'stripped', id: 0x2_01n, run: sanitizeString },
  { name: 'encoded', id: 0x2_02n, run: sanitizeEncoded },
  { name: 'special_chars', id: 0x2_03n, run: sanitizeSpecialChars },
  { name: 'full_special_chars', id: 0x2_0an, run: sanitizeFullSpecialChars },
  { name: 'unsafe_raw', id: FILTER_DEFAULT, run: unsafeRaw },
  { name: 'email', id: 0x2_05n, run: (text) => keepOnly(text, `${ALNUM}!#$%&'*+-=?^_\`{|}~@.[]`) },
  { name: 'url', id: 0x2_06n, run: sanitizeUrl },
  { name: 'number_int', id: 0x2_07n, run: (text) => keepOnly(text, '+-0123456789') },
  { name: 'number_float', id: 0x2_08n, run: sanitizeNumberFloat },
  {
    name: 'add_slashes',
    id: 0x2_0bn,
    run: (text) => text.replaceAll(/["'\\\0]/g, (match) => (match === '\0' ? String.raw`\0` : `\\${match}`)),
  },
  { name: 'callback', id: FILTER_CALLBACK, run: callback },
];
