const INT_SUFFIXES = ['i128', 'isize', 'i16', 'i32', 'i64', 'i8', 'u128', 'usize', 'u16', 'u32', 'u64', 'u8'];

/** An integer literal's value and suffix; a decimal literal with a float suffix (`1f64`) is a float. */
export function parseIntegerLiteral(
  text: string
):
  | { kind: 'int'; value: bigint; suffix: string | undefined }
  | { kind: 'float'; value: number; suffix: string }
  | undefined {
  let body = text;
  let suffix: string | undefined;
  const radix = /^0[xob]/i.test(body) ? body[1].toLowerCase() : undefined;
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
    return { kind: 'float', value: Number(body), suffix };
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

export function parseFloatLiteral(text: string): { value: number; suffix: string | undefined } | undefined {
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
  const value = Number(body.endsWith('.') ? body.slice(0, -1) : body);
  return { value: suffix === 'f32' ? Math.fround(value) : value, suffix };
}

/** The character a literal such as `'a'`, `'\n'`, or `'\u{3042}'` denotes. */
export function parseCharLiteral(text: string): string | undefined {
  const body = text.slice(1, -1);
  const chars = unescape(body, true);
  if (chars === undefined || [...chars].length !== 1) return undefined;
  return chars;
}

export function parseStringLiteral(text: string): string | undefined {
  return unescape(text.slice(1, -1), false);
}

// code-gauge-allow functionCognitiveComplexity 25 -- One case per escape.
function unescape(body: string, isChar: boolean): string | undefined {
  let result = '';
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '\r' && body[index + 1] === '\n') continue;
    if (char !== '\\') {
      result += char;
      continue;
    }
    const next = body[++index];
    switch (next) {
      case 'n': {
        result += '\n';
        break;
      }
      case 'r': {
        result += '\r';
        break;
      }
      case 't': {
        result += '\t';
        break;
      }
      case '\\':
      case "'":
      case '"': {
        result += next;
        break;
      }
      case '0': {
        result += '\0';
        break;
      }
      case 'x': {
        const hex = body.slice(index + 1, index + 3);
        if (!/^[0-7][\da-f]$/i.test(hex)) return undefined;
        result += String.fromCodePoint(Number.parseInt(hex, 16));
        index += 2;
        break;
      }
      case 'u': {
        const match = /^\{([\da-f_]{1,8})\}/i.exec(body.slice(index + 1));
        if (!match) return undefined;
        const code = Number.parseInt(match[1].replaceAll('_', ''), 16);
        if (code > 0x10_ff_ff || (code >= 0xd8_00 && code <= 0xdf_ff)) return undefined;
        result += String.fromCodePoint(code);
        index += match[0].length;
        break;
      }
      case '\n': {
        if (isChar) return undefined;
        while (index + 1 < body.length && /\s/.test(body[index + 1])) index++;
        break;
      }
      case '\r': {
        if (isChar) return undefined;
        while (index + 1 < body.length && /\s/.test(body[index + 1])) index++;
        break;
      }
      default: {
        return undefined;
      }
    }
  }
  return result;
}
