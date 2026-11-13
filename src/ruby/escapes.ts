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
      result += new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
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
    if (next === 'M' && text[index + 1] === '-') {
      const meta = text[index + 2];
      if (meta === undefined || meta === '\\') return undefined;
      const byte = meta.codePointAt(0)! | 0x80;
      bytes.push(byte);
      allBytes.push(byte);
      index += 2;
      continue;
    }
    flushBytes();
    if (next === 'C' && text[index + 1] === '-') {
      const control = text[index + 2];
      if (control === undefined) return undefined;
      appendText(String.fromCodePoint(control === '?' ? 0x7f : control.codePointAt(0)! & 0x1f));
      index += 2;
    } else if (next === 'c') {
      const control = text[index + 1];
      if (control === undefined) return undefined;
      appendText(String.fromCodePoint(control === '?' ? 0x7f : control.codePointAt(0)! & 0x1f));
      index++;
    } else if (next in SIMPLE_ESCAPES) {
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
