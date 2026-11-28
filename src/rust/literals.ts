import { decimalToF32 } from './floatFormat';

const INT_SUFFIXES = ['i128', 'isize', 'i16', 'i32', 'i64', 'i8', 'u128', 'usize', 'u16', 'u32', 'u64', 'u8'];

/** An integer literal's value and suffix; a decimal literal with a float suffix (`1f64`) is a float. */
export function parseIntegerLiteral(
  text: string
):
  | { kind: 'int'; value: bigint; suffix: string | undefined }
  | { kind: 'float'; value: number; f32: number; suffix: string }
  | undefined {
  let body = text;
  let suffix: string | undefined;
  // Rust writes the prefix in lowercase only (`0XFF` is an error), though hexadecimal digits may be uppercase.
  const radix = /^0[xob]/.test(body) ? body[1] : undefined;
  for (const candidate of radix === 'x' ? INT_SUFFIXES : [...INT_SUFFIXES, 'f32', 'f64']) {
    if (body.endsWith(candidate)) {
      suffix = candidate;
      body = body.slice(0, -candidate.length);
      break;
    }
  }
  body = body.replaceAll('_', '');
  if (suffix?.startsWith('f')) {
    if (!/^\d+$/.test(body)) return undefined;
    const f32 = decimalToF32(body);
    return { kind: 'float', value: suffix === 'f32' ? f32 : Number(body), f32, suffix };
  }
  if (radix) {
    const digits = body.slice(2);
    const pattern = { x: /^[\da-f]+$/i, o: /^[0-7]+$/, b: /^[01]+$/ }[radix as 'x' | 'o' | 'b'];
    if (!pattern.test(digits)) return undefined;
    return { kind: 'int', value: BigInt(`0${radix}${digits}`), suffix };
  }
  if (!/^\d+$/.test(body)) return undefined;
  return { kind: 'int', value: BigInt(body), suffix };
}

/** A float literal's value as an `f64`, and as an `f32` rounded from its digits. */
export function parseFloatLiteral(
  text: string
): { value: number; f32: number; suffix: string | undefined } | undefined {
  let body = text;
  let suffix: string | undefined;
  for (const candidate of ['f32', 'f64']) {
    if (body.endsWith(candidate)) {
      suffix = candidate;
      body = body.slice(0, -3);
      break;
    }
  }
  body = body.replaceAll('_', '');
  if (!/^\d+(\.\d*)?([eE][+-]?\d+)?$/.test(body)) return undefined;
  const digits = body.endsWith('.') ? body.slice(0, -1) : body;
  const f32 = decimalToF32(digits);
  return { value: suffix === 'f32' ? f32 : Number(digits), f32, suffix };
}

type LiteralKind = 'byte' | 'char' | 'string' | 'byteString' | 'cString';

export function parseCharLiteral(text: string): string | undefined {
  const body = text.slice(1, -1);
  const chars = unescape(body, 'char');
  if (chars === undefined || !/^.$/su.test(chars)) return undefined;
  return chars;
}

export function parseByteLiteral(text: string): bigint | undefined {
  const chars = unescape(text.slice(2, -1), 'byte');
  return chars?.length === 1 ? BigInt(chars.codePointAt(0)!) : undefined;
}

export function parseStringLiteral(text: string): string | undefined {
  return unescape(text.slice(1, -1), 'string');
}

/** The bytes of a byte string literal (`b"..."`), which may hold only ASCII characters and byte escapes. */
export function parseByteStringLiteral(text: string): number[] | undefined {
  const chars = unescape(text.slice(2, -1), 'byteString');
  return chars === undefined ? undefined : Array.from(chars, (char) => char.codePointAt(0) ?? 0);
}

/** The bytes of a C string literal (`c"..."`) without its terminating NUL, which no character inside may be. */
export function parseCStringLiteral(text: string): number[] | undefined {
  const chars = unescape(text.slice(2, -1), 'cString');
  return chars === undefined ? undefined : cStringBytes(chars);
}

/**
 * A raw string literal (`r#"..."#`, `br"..."`, `cr"..."`): its prefix and its text as written, with `\r\n` read as
 * `\n`.
 */
export function parseRawStringLiteral(text: string): { prefix: '' | 'b' | 'c'; body: string } | undefined {
  const match = /^([bc]?)r(#*)"([\s\S]*)"\2$/.exec(text);
  if (!match) return undefined;
  const body = match[3].replaceAll('\r\n', '\n');
  if (body.includes('\r')) return undefined;
  const prefix = match[1] as '' | 'b' | 'c';
  if (prefix === 'b' && /[^\0-\u007F]/.test(body)) return undefined;
  return { prefix, body };
}

/** A lone surrogate that stands for a raw byte of a C string, which no Rust character can be. */
const RAW_BYTE = 0xdc_00;

/** The UTF-8 bytes of a C string's text (with its raw bytes as they are), or undefined when it holds a NUL. */
export function cStringBytes(text: string): number[] | undefined {
  if (text.includes('\0')) return undefined;
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char.length === 1 && code >= RAW_BYTE + 0x80 && code <= RAW_BYTE + 0xff) bytes.push(code - RAW_BYTE);
    else bytes.push(...encoder.encode(char));
  }
  return bytes;
}

// code-gauge-allow functionCognitiveComplexity -- Rust escape forms have different widths and allowed values.
function unescape(body: string, kind: LiteralKind): string | undefined {
  if (body.includes('\r')) {
    body = body.replaceAll('\r\n', '\n');
    if (body.includes('\r')) return undefined;
  }
  let result = '';
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char !== '\\') {
      if ((kind === 'byte' || kind === 'char') && "\n\t'".includes(char)) return undefined;
      if ((kind === 'byte' || kind === 'byteString') && char.codePointAt(0)! > 0x7f) return undefined;
      result += char;
      continue;
    }
    const escape = readEscape(body, index + 1, kind);
    if (!escape) return undefined;
    result += escape.text;
    index = escape.last;
  }
  return result;
}

const SIMPLE_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"', '0': '\0' };

/** The text of the escape whose letter is at `index`, and the index of its last character. */
// code-gauge-allow functionCognitiveComplexity -- One case per kind of escape sequence.
function readEscape(body: string, index: number, kind: LiteralKind): { text: string; last: number } | undefined {
  const next = body[index];
  if (Object.hasOwn(SIMPLE_ESCAPES, next)) return { text: SIMPLE_ESCAPES[next], last: index };
  switch (next) {
    case 'x': {
      const hex = body.slice(index + 1, index + 3);
      if (!/^[\da-f]{2}$/i.test(hex)) return undefined;
      const code = Number.parseInt(hex, 16);
      if (kind !== 'byte' && kind !== 'byteString' && kind !== 'cString' && code > 0x7f) return undefined;
      // In a C string, `\x80`–`\xff` is one byte, not a character, so it is kept apart as a lone surrogate.
      if (kind === 'cString' && code > 0x7f) return { text: String.fromCodePoint(RAW_BYTE + code), last: index + 2 };
      return { text: String.fromCodePoint(code), last: index + 2 };
    }
    case 'u': {
      return kind === 'byte' || kind === 'byteString' ? undefined : readUnicodeEscape(body, index);
    }
    case '\n': {
      if (kind === 'byte' || kind === 'char') return undefined;
      let last = index;
      while (last + 1 < body.length && /[ \t\n]/.test(body[last + 1])) last++;
      return { text: '', last };
    }
    default: {
      return undefined;
    }
  }
}

function readUnicodeEscape(body: string, index: number): { text: string; last: number } | undefined {
  const match = /^\{([\da-f][\da-f_]*)\}/i.exec(body.slice(index + 1));
  if (!match) return undefined;
  const hex = match[1].replaceAll('_', '');
  const code = Number.parseInt(hex, 16);
  if (hex.length > 6 || code > 0x10_ff_ff || (code >= 0xd8_00 && code <= 0xdf_ff)) return undefined;
  return { text: String.fromCodePoint(code), last: index + match[0].length };
}
