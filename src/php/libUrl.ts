// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { lower } from './bytes';
import { visibleProps } from './classes';
import { formatFloat, normalizeKeyString } from './conversions';
import { throwError, warn } from './errors';
import { isCtypeAlpha, isCtypeControl } from './libLocale';
import { defineConstant, defineFunction } from './native';
import { rt } from './runtime';
import { PhpArray, PhpObject, type Value } from './values';

const s = (value: Value): string => value as string;

const URL_COMPONENTS = ['scheme', 'host', 'port', 'user', 'pass', 'path', 'query', 'fragment'] as const;
for (const [index, name] of URL_COMPONENTS.entries()) defineConstant(`PHP_URL_${name.toUpperCase()}`, BigInt(index));
defineConstant('PHP_QUERY_RFC1738', 1n);
defineConstant('PHP_QUERY_RFC3986', 2n);

// Base64 -------------------------------------------------------------------------------------------------------------

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

defineFunction('base64_encode(string $string): string', ({ args }) =>
  Buffer.from(s(args[0]), 'latin1').toString('base64')
);
// code-gauge-allow functionCognitiveComplexity 26 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
defineFunction('base64_decode(string $string, bool $strict = false): string|false', ({ args }) => {
  const strict = args[1] === true;
  const bytes: number[] = [];
  let count = 0;
  let padding = 0;
  for (const char of s(args[0])) {
    if (char === '=') {
      padding++;
      continue;
    }
    const value = BASE64.indexOf(char);
    if (value === -1 || (strict && padding > 0)) {
      if (!strict || ' \t\r\n'.includes(char)) continue;
      return false;
    }
    const shift = [2, -4, -2, 0][count % 4];
    if (count % 4 === 0) bytes.push(value << 2);
    else {
      bytes[bytes.length - 1] |= shift < 0 ? value >> -shift : value;
      if (count % 4 !== 3) bytes.push((value << (8 + shift)) & 0xff);
    }
    count++;
  }
  if (strict && (count % 4 === 1 || (padding > 0 && (padding > 2 || (count + padding) % 4 !== 0)))) return false;
  // The bits a group of fewer than four characters leaves in its last byte are not part of the output.
  if (count % 4 !== 0) bytes.pop();
  return String.fromCharCode(...bytes.map((byte) => byte & 0xff));
});

// URL encoding -------------------------------------------------------------------------------------------------------

defineFunction('urlencode(string $string): string', ({ args }) => urlEncode(s(args[0]), false));
defineFunction('rawurlencode(string $string): string', ({ args }) => urlEncode(s(args[0]), true));
defineFunction('urldecode(string $string): string', ({ args }) => urlDecode(s(args[0]), false));
defineFunction('rawurldecode(string $string): string', ({ args }) => urlDecode(s(args[0]), true));

/** Percent-encodes all but letters, digits, `-`, `.`, and `_` (and `~` when raw); `urlencode` writes a space as `+`. */
function urlEncode(text: string, raw: boolean): string {
  return text.replaceAll(raw ? /[^\w.~-]/g : /[^\w.-]/g, (char) =>
    char === ' ' && !raw ? '+' : `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  );
}

function urlDecode(text: string, raw: boolean): string {
  return text.replaceAll(raw ? /%[\dA-Fa-f]{2}/g : /%[\dA-Fa-f]{2}|\+/g, (match) =>
    match === '+' ? ' ' : String.fromCharCode(Number.parseInt(match.slice(1), 16))
  );
}

// Query strings ------------------------------------------------------------------------------------------------------

interface QueryBuild {
  parts: string[];
  raw: boolean;
  numericPrefix: string;
  /** The arrays and objects being encoded, which a nested reference to one of them skips as PHP's recursion guard does. */
  visiting: Set<PhpArray | PhpObject>;
  /** The length of the query built so far. */
  length: number;
}

defineFunction(
  'http_build_query(array|object $data, string $numeric_prefix = "", ?string $arg_separator = null, int $encoding_type = PHP_QUERY_RFC1738): string',
  ({ args }) => {
    const data = args[0];
    const query: QueryBuild = {
      parts: [],
      raw: args[3] === 2n,
      numericPrefix: args[1] === undefined ? '' : s(args[1]),
      visiting: new Set(),
      length: 0,
    };
    buildQuery(query, data as PhpArray | PhpObject, undefined);
    return query.parts.join(args[2] === undefined || args[2] === null ? '&' : s(args[2]));
  }
);

/** Appends the pairs of an array or an object's visible properties as php_url_encode_hash_ex does. */
// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function buildQuery(query: QueryBuild, data: PhpArray | PhpObject, prefix: string | undefined): void {
  if (query.visiting.has(data)) return;
  query.visiting.add(data);
  const entries: [string | bigint, Value][] =
    data instanceof PhpArray ? [...data.entries()] : visibleProps(data, rt().frame.scope);
  for (const [key, value] of entries) {
    rt().spend();
    const numeric = typeof key === 'bigint';
    const name = numeric ? `${prefix === undefined ? query.numericPrefix : ''}${key}` : urlEncode(key, query.raw);
    const fullName = prefix === undefined ? name : `${prefix}${name}%5D`;
    if (value instanceof PhpArray || value instanceof PhpObject) {
      buildQuery(query, value, prefix === undefined ? `${name}%5B` : `${prefix}${name}%5D%5B`);
    } else if (value !== null) {
      const part = `${fullName}=${queryValue(value, query.raw)}`;
      query.length += part.length + 1;
      rt().ensureStringFits(query.length);
      query.parts.push(part);
    }
  }
  query.visiting.delete(data);
}

function queryValue(value: Value, raw: boolean): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return urlEncode(formatFloat(value), raw);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return urlEncode(s(value), raw);
}

defineFunction('parse_str(string $string, &$result): void', ({ args, refs }) => {
  const result = new PhpArray();
  refs[1]?.assign(result);
  const text = s(args[0]);
  for (const pair of text.slice(0, text.includes('\0') ? text.indexOf('\0') : undefined).split('&')) {
    if (pair === '') continue;
    const equals = pair.indexOf('=');
    const name = untilNul(urlDecode(equals === -1 ? pair : pair.slice(0, equals), false));
    registerVariable(result, name, equals === -1 ? '' : urlDecode(pair.slice(equals + 1), false));
  }
  return null;
});

function untilNul(text: string): string {
  const nul = text.indexOf('\0');
  return nul === -1 ? text : text.slice(0, nul);
}

/** Stores a value under a name such as `a[b][]` as php_register_variable_ex does. */
// code-gauge-allow functionCognitiveComplexity 22 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
// code-gauge-allow functionNcss 36 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function registerVariable(target: PhpArray, rawName: string, value: string): void {
  const name = rawName.replace(/^ +/, '');
  const bracket = name.indexOf('[');
  let base = (bracket === -1 ? name : name.slice(0, bracket)).replaceAll(/[ .]/g, '_');
  if (base === '') return;
  let table = target;
  let key: string | undefined = base;
  let rest = bracket === -1 ? undefined : name.slice(bracket);
  for (let level = 1; rest !== undefined; level++) {
    if (level > 64) {
      target.delete(normalizeKeyString(base));
      return;
    }
    let inner = rest.slice(1);
    if (/^\s/.test(inner)) inner = inner.slice(1);
    let index: string | undefined;
    if (inner.startsWith(']')) {
      rest = inner.slice(1);
    } else {
      const close = inner.indexOf(']');
      if (close === -1) {
        // Without a closing bracket, the rest is part of a plain name, whose '[' becomes '_' too.
        if (key === base) {
          base = `${base}_${rest.slice(1).replaceAll(/[ .[]/g, '_')}`;
          key = base;
        }
        break;
      }
      index = rest.slice(1, rest.indexOf(']'));
      rest = inner.slice(close + 1);
    }
    table = childTable(table, key);
    key = index;
    if (!rest.startsWith('[')) rest = undefined;
  }
  if (key === undefined) table.append(value);
  else table.set(normalizeKeyString(key), value);
}

/** The array under `key` (appended when undefined), replacing a value there that is not an array. */
function childTable(table: PhpArray, key: string | undefined): PhpArray {
  if (key === undefined) {
    const child = new PhpArray();
    table.append(child);
    return child;
  }
  const normalized = normalizeKeyString(key);
  const existing = table.get(normalized);
  if (existing instanceof PhpArray) return existing;
  const child = new PhpArray();
  table.set(normalized, child);
  return child;
}

// URLs ---------------------------------------------------------------------------------------------------------------

interface ParsedUrl {
  scheme?: string;
  host?: string;
  port?: bigint;
  user?: string;
  pass?: string;
  path?: string;
  query?: string;
  fragment?: string;
}

defineFunction('parse_url(string $url, int $component = -1): mixed', ({ args }) => {
  const component = args[1] === undefined ? -1n : (args[1] as bigint);
  const url = parseUrl(s(args[0]));
  if (!url) return false;
  if (component > -1n) {
    const name = URL_COMPONENTS[Number(component)] as (typeof URL_COMPONENTS)[number] | undefined;
    if (component > 7n || !name) {
      throwError(
        'ValueError',
        `parse_url(): Argument #2 ($component) must be a valid URL component identifier, ${component} given`
      );
    }
    return url[name] ?? null;
  }
  const array = new PhpArray();
  for (const name of URL_COMPONENTS) {
    const value = url[name];
    if (value !== undefined) array.set(name, value);
  }
  return array;
});

/** Splits a URL as php_url_parse_ex2 does, or returns undefined for one it rejects. */
function parseUrl(text: string): ParsedUrl | undefined {
  const colon = text.indexOf(':');
  if (colon > 0 && isScheme(text.slice(0, colon))) return parseAfterScheme(text, colon);
  // A colon that is not after a scheme may start a port, as in `example.com:80`.
  if (colon === 0 || (colon > 0 && colon + 1 < text.length && colon < firstOf(text, 0, text.length, '?#'))) {
    return parsePort(text, colon);
  }
  return text.startsWith('//') ? parseHost(text, {}, 2) : parsePath(text, {}, 0);
}

function isScheme(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (!isCtypeAlpha(text.charCodeAt(index)) && !/[\d+.-]/.test(text[index])) return false;
  }
  return true;
}

function parseAfterScheme(text: string, colon: number): ParsedUrl | undefined {
  const url: ParsedUrl = { scheme: controlsReplaced(text.slice(0, colon)) };
  if (colon + 1 === text.length) return url;
  if (text[colon + 1] !== '/') {
    // Schemes like mailto: have no slash after them, unless the digits after the colon are a port.
    const digits = /^\d*/.exec(text.slice(colon + 1))?.[0] ?? '';
    const after = colon + 1 + digits.length;
    if ((after === text.length || text[after] === '/') && digits.length < 6) return parsePort(text, colon);
    return parsePath(text, url, colon + 1);
  }
  if (text[colon + 2] !== '/') return parsePath(text, url, colon + 1);
  if (lower(url.scheme ?? '') === 'file' && text[colon + 3] === '/') {
    // A Windows drive letter, as in file:///c:/dir, starts the path.
    return parsePath(text, url, text[colon + 5] === ':' ? colon + 4 : colon + 3);
  }
  return parseHost(text, url, colon + 3);
}

/** Reads the digits after a colon that does not end a scheme as a port, as the parse_port label of PHP's parser does. */
function parsePort(text: string, colon: number): ParsedUrl | undefined {
  const digits = /^\d{0,6}/.exec(text.slice(colon + 1))?.[0] ?? '';
  const after = colon + 1 + digits.length;
  const hostStart = text.startsWith('//') ? 2 : 0;
  if (digits.length > 0 && digits.length < 6 && (after === text.length || text[after] === '/')) {
    const port = Number(digits);
    return port > 65_535 ? undefined : parseHost(text, { port: BigInt(port) }, hostStart);
  }
  if (digits.length === 0 && after === text.length) return undefined;
  return hostStart === 2 ? parseHost(text, {}, 2) : parsePath(text, {}, 0);
}

function firstOf(text: string, start: number, end: number, chars: string): number {
  let first = end;
  for (const char of chars) {
    const index = text.indexOf(char, start);
    if (index !== -1 && index < first) first = index;
  }
  return first;
}

// code-gauge-allow functionCognitiveComplexity 27 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function parseHost(text: string, url: ParsedUrl, from: number): ParsedUrl | undefined {
  let start = from;
  const hostEnd = firstOf(text, start, text.length, '/?#');
  const at = text.lastIndexOf('@', hostEnd - 1);
  if (at >= start) {
    const credentials = text.slice(start, at);
    const colon = credentials.indexOf(':');
    url.user = controlsReplaced(colon === -1 ? credentials : credentials.slice(0, colon));
    if (colon !== -1) url.pass = controlsReplaced(credentials.slice(colon + 1));
    start = at + 1;
  }
  let hostStop = hostEnd;
  const ipv6 = text[start] === '[' && text[hostEnd - 1] === ']';
  const colon = ipv6 ? -1 : text.lastIndexOf(':', hostEnd - 1);
  if (colon >= start) {
    if (url.port === undefined) {
      const port = text.slice(colon + 1, hostEnd);
      if (port.length > 5) return undefined;
      if (port.length > 0) {
        const digits = /^[\t\n\v\f\r ]*[+-]?\d+/.exec(port)?.[0];
        const value = digits === undefined ? Number.NaN : Number(digits);
        if (!(value >= 0 && value <= 65_535)) return undefined;
        url.port = BigInt(value);
      }
    }
    hostStop = colon;
  }
  if (hostStop - start < 1) return undefined;
  url.host = controlsReplaced(text.slice(start, hostStop));
  return hostEnd === text.length ? url : parsePath(text, url, hostEnd);
}

function parsePath(text: string, url: ParsedUrl, start: number): ParsedUrl {
  let end = text.length;
  const hash = text.indexOf('#', start);
  if (hash !== -1) {
    url.fragment = controlsReplaced(text.slice(hash + 1));
    end = hash;
  }
  const question = text.indexOf('?', start);
  if (question !== -1 && question < end) {
    url.query = controlsReplaced(text.slice(question + 1, end));
    end = question;
  }
  if (start < end || start === text.length) url.path = controlsReplaced(text.slice(start, end));
  return url;
}

/** Replaces control bytes with `_`, as the C library's iscntrl classifies them in the current LC_CTYPE locale. */
function controlsReplaced(text: string): string {
  // oxlint-disable-next-line typescript/no-misused-spread -- PHP strings hold bytes, which spread one by one.
  return [...text].map((char) => (isCtypeControl(char.charCodeAt(0)) ? '_' : char)).join('');
}

// Quoted-printable and uuencode --------------------------------------------------------------------------------------

defineFunction('quoted_printable_encode(string $string): string', ({ args }) => quotedPrintableEncode(s(args[0])));

/** Encodes as php_quot_print_encode does, which keeps a line at most 75 characters and a UTF-8 sequence on one line. */
// code-gauge-allow functionCognitiveComplexity 29 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function quotedPrintableEncode(text: string): string {
  let result = '';
  let lineLength = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 13 && text[index + 1] === '\n') {
      result += '\r\n';
      index++;
      lineLength = 0;
    } else if (code < 32 || code >= 0x7f || code === 61 || (code === 32 && text[index + 1] === '\r')) {
      lineLength += 3;
      const needed = code <= 0xdf ? 3 : code <= 0xef ? 6 : code <= 0xf4 ? 9 : 0;
      if ((code <= 0x7f && lineLength > 75) || (code > 0x7f && lineLength + needed > 75 && needed > 0)) {
        result += '=\r\n';
        lineLength = 3;
      }
      result += `=${code.toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      if (++lineLength > 75) {
        result += '=\r\n';
        lineLength = 1;
      }
      result += text[index];
    }
  }
  return result;
}

defineFunction('quoted_printable_decode(string $string): string', ({ args }) => {
  const text = untilNul(s(args[0]));
  let result = '';
  for (let index = 0; index < text.length;) {
    const hex = /^=([\dA-Fa-f]{2})/.exec(text.slice(index, index + 3));
    if (hex) {
      result += String.fromCharCode(Number.parseInt(hex[1], 16));
      index += 3;
      continue;
    }
    const softBreak = text[index] === '=' ? /^=[ \t]*(\r\n|\r|\n|$)/.exec(text.slice(index)) : undefined;
    if (softBreak) index += softBreak[0].length;
    else result += text[index++];
  }
  return result;
});
defineFunction('convert_uuencode(string $string): string', ({ args }) => uuencode(s(args[0])));

/** Encodes as php_uuencode does, in lines of 45 bytes, padding a short last group with NUL bytes. */
function uuencode(text: string): string {
  const byte = (index: number): number => (index < text.length ? text.charCodeAt(index) : 0);
  const group = (index: number, length: number): string =>
    uuChar(byte(index) >> 2) +
    uuChar(((byte(index) << 4) & 0o60) | ((byte(index + 1) >> 4) & 0o17)) +
    (length > 1 ? uuChar(((byte(index + 1) << 2) & 0o74) | ((byte(index + 2) >> 6) & 0o3)) : '`') +
    (length > 2 ? uuChar(byte(index + 2) & 0o77) : '`');
  let result = '';
  let index = 0;
  let lineLength = 45;
  while (index + 3 < text.length) {
    lineLength = Math.min(45, text.length - index);
    const groupsEnd = index + Math.floor(lineLength / 3) * 3;
    result += uuChar(lineLength);
    for (; index < groupsEnd; index += 3) result += group(index, 3);
    if (lineLength === 45) result += '\n';
  }
  if (index < text.length) {
    if (lineLength === 45) {
      result += uuChar(text.length - index);
      lineLength = 0;
    }
    result += group(index, text.length - index);
  }
  if (lineLength < 45) result += '\n';
  return `${result}\`\n`;
}

function uuChar(value: number): string {
  return value ? String.fromCharCode((value & 0o77) + 32) : '`';
}

defineFunction('convert_uudecode(string $string): string|false', ({ args }) => {
  const decoded = uudecode(s(args[0]));
  if (decoded === undefined) {
    warn('convert_uudecode(): Argument #1 ($data) is not a valid uuencoded string');
    return false;
  }
  return decoded;
});

/** Decodes as php_uudecode does, which trusts each line's length character. */
// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function uudecode(text: string): string | undefined {
  if (text === '') return undefined;
  const value = (index: number): number => ((index < text.length ? text.charCodeAt(index) : 0) - 32) & 0o77;
  const decodeGroup = (index: number): string =>
    String.fromCharCode(
      ((value(index) << 2) | (value(index + 1) >> 4)) & 0xff,
      ((value(index + 1) << 4) | (value(index + 2) >> 2)) & 0xff,
      ((value(index + 2) << 6) | value(index + 3)) & 0xff
    );
  let result = '';
  let total = 0;
  let index = 0;
  while (index < text.length) {
    const length = value(index++);
    if (length === 0) break;
    if (length > text.length) return undefined;
    total += length;
    const lineEnd = index + (length === 45 ? 60 : Math.floor(length * 1.33));
    if (lineEnd > text.length) return undefined;
    for (; index < lineEnd; index += 4) {
      if (index + 4 > text.length) return undefined;
      result += decodeGroup(index);
    }
    if (length < 45) break;
    index++;
  }
  if (total > result.length) result += decodeGroup(index).slice(0, total - result.length);
  return result.slice(0, total);
}
