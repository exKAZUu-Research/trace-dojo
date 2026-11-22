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

type LiteralKind = 'byte' | 'char' | 'string';

export function parseCharLiteral(text: string): string | undefined {
  const body = text.slice(1, -1);
  const chars = unescape(body, 'char');
  if (chars === undefined || [...chars].length !== 1) return undefined;
  return chars;
}

export function parseByteLiteral(text: string): bigint | undefined {
  const chars = unescape(text.slice(2, -1), 'byte');
  return chars?.length === 1 ? BigInt(chars.codePointAt(0)!) : undefined;
}

export function parseStringLiteral(text: string): string | undefined {
  return unescape(text.slice(1, -1), 'string');
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
      if (kind !== 'string' && "\n\t'".includes(char)) return undefined;
      if (kind === 'byte' && char.codePointAt(0)! > 0x7f) return undefined;
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
function readEscape(body: string, index: number, kind: LiteralKind): { text: string; last: number } | undefined {
  const next = body[index];
  if (Object.hasOwn(SIMPLE_ESCAPES, next)) return { text: SIMPLE_ESCAPES[next], last: index };
  switch (next) {
    case 'x': {
      const hex = body.slice(index + 1, index + 3);
      if (!/^[\da-f]{2}$/i.test(hex)) return undefined;
      const code = Number.parseInt(hex, 16);
      if (kind !== 'byte' && code > 0x7f) return undefined;
      return { text: String.fromCodePoint(code), last: index + 2 };
    }
    case 'u': {
      return kind === 'byte' ? undefined : readUnicodeEscape(body, index);
    }
    case '\n': {
      if (kind !== 'string') return undefined;
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
