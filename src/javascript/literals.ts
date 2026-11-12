/** Reads a numeric or BigInt literal, or returns undefined for a legacy octal one, which the interpreter rejects. */
export function parseNumberLiteral(text: string): number | bigint | undefined {
  const digits = text.replaceAll('_', '');
  if (/^0\d/.test(digits)) return undefined;
  return digits.endsWith('n') ? BigInt(digits.slice(0, -1)) : Number(digits);
}

/** Decodes a quoted string literal. */
export function decodeStringLiteral(text: string): string {
  return decodeEscapes(text.slice(1, -1));
}

/** Decodes the text of a template literal between its substitutions, where a raw line break stays as `\n`. */
export function decodeTemplateFragment(text: string): string {
  return decodeEscapes(text.replaceAll(/\r\n?/g, '\n'));
}

const simpleEscapes: Record<string, string> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '0': '\0',
};

function decodeEscapes(text: string): string {
  return text.replaceAll(
    /\\(?:u\{([\dA-Fa-f]+)\}|u([\dA-Fa-f]{4})|x([\dA-Fa-f]{2})|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/g,
    (_, codePoint?: string, unit?: string, hex?: string, lineBreak?: string, other?: string) => {
      if (codePoint !== undefined) return String.fromCodePoint(Math.min(Number.parseInt(codePoint, 16), 0x10_ff_ff));
      // oxlint-disable-next-line unicorn/prefer-code-point -- A `\uXXXX` escape is a UTF-16 code unit, maybe half a pair.
      if (unit !== undefined) return String.fromCharCode(Number.parseInt(unit, 16));
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (lineBreak !== undefined) return '';
      return simpleEscapes[other as string] ?? (other as string);
    }
  );
}
