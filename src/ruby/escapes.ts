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
export function decodeDoubleQuoted(text: string): string | undefined {
  let result = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== '\\') {
      result += char;
      continue;
    }
    const next = text[++index];
    if (next === undefined) return undefined;
    if (next in SIMPLE_ESCAPES) {
      result += SIMPLE_ESCAPES[next];
    } else if (next === 'u') {
      if (text[index + 1] === '{') {
        const end = text.indexOf('}', index);
        if (end === -1) return undefined;
        for (const hex of text
          .slice(index + 2, end)
          .trim()
          .split(/\s+/)) {
          if (!/^[\da-fA-F]{1,6}$/.test(hex)) return undefined;
          result += String.fromCodePoint(Number.parseInt(hex, 16));
        }
        index = end;
      } else {
        const hex = text.slice(index + 1, index + 5);
        if (!/^[\da-fA-F]{4}$/.test(hex)) return undefined;
        result += String.fromCodePoint(Number.parseInt(hex, 16));
        index += 4;
      }
    } else if (next === 'x') {
      const hex = /^[\da-fA-F]{1,2}/.exec(text.slice(index + 1))?.[0];
      if (!hex) return undefined;
      result += String.fromCodePoint(Number.parseInt(hex, 16));
      index += hex.length;
    } else if (/[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(text.slice(index))?.[0] ?? next;
      result += String.fromCodePoint(Number.parseInt(octal, 8) & 0xff);
      index += octal.length - 1;
    } else {
      result += next;
    }
  }
  return result;
}
