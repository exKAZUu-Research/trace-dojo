/** Decodes a single-quoted literal's text, where only `\\` and `\'` are escapes. */
export function decodeSingleQuoted(text: string): string {
  return text.replaceAll(/\\([\\'])/g, '$1');
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  s: ' ',
  r: '\r',
  e: '\u001B',
  a: '\u0007',
  b: '\b',
  f: '\f',
  v: '\v',
  '\n': '',
};

function modifiedByte(text: string, index: number): { byte: number; end: number } | undefined {
  if (index >= text.length) return undefined;
  if (text[index] !== '\\') {
    const byte = text.codePointAt(index) as number;
    return byte <= 0xff ? { byte, end: index } : undefined;
  }
  const kind = text[index + 1];
  if (kind === undefined) return undefined;
  if (kind in SIMPLE_ESCAPES) {
    const escaped = SIMPLE_ESCAPES[kind];
    return escaped.length === 1 ? { byte: escaped.codePointAt(0) as number, end: index + 1 } : undefined;
  }
  if (kind === 'x') {
    const hex = /^[\da-fA-F]{1,2}/.exec(text.slice(index + 2))?.[0];
    return hex ? { byte: Number.parseInt(hex, 16), end: index + 1 + hex.length } : undefined;
  }
  if (/[0-7]/.test(kind)) {
    const octal = /^[0-7]{1,3}/.exec(text.slice(index + 1))?.[0] ?? kind;
    return { byte: Number.parseInt(octal, 8) & 0xff, end: index + octal.length };
  }
  const operand = kind === 'c' ? index + 2 : text[index + 2] === '-' ? index + 3 : -1;
  if (kind !== 'c' && kind !== 'C' && kind !== 'M') {
    if (kind === 'u') return undefined;
    const byte = kind.codePointAt(0) as number;
    return byte <= 0xff ? { byte, end: index + 1 } : undefined;
  }
  if (operand < 0) return undefined;
  const nested = modifiedByte(text, operand);
  if (!nested) return undefined;
  const byte =
    kind === 'M' ? nested.byte | 0x80 : text[operand] === '?' ? 0x7f : (nested.byte & 0x1f) | (nested.byte & 0x80);
  return { byte, end: nested.end };
}

/** Decodes a double-quoted literal's text as Ruby does, or `undefined` for an escape Ruby rejects. */
export function decodeDoubleQuoted(text: string): { text: string; binary: boolean; bytes?: number[] } | undefined {
  let result = '';
  const allBytes: number[] = [];
  const appendText = (value: string): void => {
    result += value;
    for (const byte of new TextEncoder().encode(value)) allBytes.push(byte);
  };
  let bytes: number[] = [];
  let binary = false;
  const flushBytes = (): void => {
    if (bytes.length === 0) return;
    try {
      result += new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes));
    } catch {
      binary = true;
      for (const byte of bytes) result += String.fromCodePoint(byte);
    }
    bytes = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== '\\') {
      flushBytes();
      const point = text.codePointAt(index) as number;
      appendText(String.fromCodePoint(point));
      if (point > 0xff_ff) index++;
      continue;
    }
    const next = text[++index];
    if (next === undefined) return undefined;
    if (next === 'x') {
      const hex = /^[\da-fA-F]{1,2}/.exec(text.slice(index + 1))?.[0];
      if (!hex) return undefined;
      const byte = Number.parseInt(hex, 16);
      bytes.push(byte);
      allBytes.push(byte);
      index += hex.length;
      continue;
    }
    if (/[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(text.slice(index))?.[0] ?? next;
      const byte = Number.parseInt(octal, 8) & 0xff;
      bytes.push(byte);
      allBytes.push(byte);
      index += octal.length - 1;
      continue;
    }
    if (next === 'M' || next === 'C' || next === 'c') {
      const modified = modifiedByte(text, index - 1);
      if (!modified) return undefined;
      bytes.push(modified.byte);
      allBytes.push(modified.byte);
      index = modified.end;
      continue;
    }
    flushBytes();
    if (next in SIMPLE_ESCAPES) {
      appendText(SIMPLE_ESCAPES[next]);
    } else if (next === 'u') {
      if (text[index + 1] === '{') {
        const end = text.indexOf('}', index);
        if (end === -1) return undefined;
        for (const hex of text
          .slice(index + 2, end)
          .trim()
          .split(/\s+/)) {
          if (!/^[\da-fA-F]{1,6}$/.test(hex)) return undefined;
          const point = Number.parseInt(hex, 16);
          if (point > 0x10_ff_ff || (point >= 0xd8_00 && point <= 0xdf_ff)) return undefined;
          appendText(String.fromCodePoint(point));
        }
        index = end;
      } else {
        const hex = text.slice(index + 1, index + 5);
        if (!/^[\da-fA-F]{4}$/.test(hex)) return undefined;
        const point = Number.parseInt(hex, 16);
        if (point >= 0xd8_00 && point <= 0xdf_ff) return undefined;
        appendText(String.fromCodePoint(point));
        index += 4;
      }
    } else {
      appendText(next);
    }
  }
  flushBytes();
  return { text: result, binary, bytes: binary ? allBytes : undefined };
}
