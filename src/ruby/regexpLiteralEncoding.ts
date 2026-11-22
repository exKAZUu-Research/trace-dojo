import { regexpByteEscape, RegexpSourceError } from './regexpEscapes';
import { regexpTokens, unicodeEscapePoints } from './regexpTokens';
import { isAsciiText } from './unicodeText';

// oxlint-disable-next-line no-control-regex -- These ranges validate encoded bytes, including ASCII control bytes.
const eucJpBytes = /^(?:[\u0000-\u007F]|\u008E[\u00A1-\u00FE]|\u008F[\u00A1-\u00FE]{2}|[\u00A1-\u00FE]{2})*$/;
// oxlint-disable-next-line no-control-regex -- Windows-31J byte sequences include ASCII and halfwidth kana.
const windows31jBytes = /^(?:[\u0000-\u007F\u00A1-\u00DF]|[\u0081-\u009F\u00E0-\u00FC][\u0040-\u007E\u0080-\u00FC])*$/;

export function regexpLiteralEncoding(flags: string): string | undefined {
  return flags.match(/[unes]/g)?.at(-1);
}

// code-gauge-allow functionCognitiveComplexity -- Source tokens, Unicode escapes and contiguous encoded-byte runs retain distinct native validity rules.
export function validateRegexpLiteralEncoding(source: string, flags: string): void {
  const encoding = regexpLiteralEncoding(flags);
  if (encoding === undefined || encoding === 'u') return;
  if (!isAsciiText(source)) throw new RegexpSourceError('incompatible character encoding');
  let bytes = '';
  const flush = (): void => {
    const valid = encoding === 'n' || (encoding === 'e' ? eucJpBytes : windows31jBytes).test(bytes);
    if (!valid) throw new RegexpSourceError('invalid multibyte escape');
    bytes = '';
  };
  let consumed = 0;
  for (const token of regexpTokens(source, flags.includes('x'))) {
    if (token.start < consumed) continue;
    const byte = token.kind === 'escape' ? regexpByteEscape(source, token.start) : undefined;
    if (byte) {
      bytes += String.fromCodePoint(byte.value);
      consumed = token.start + byte.length;
      continue;
    }
    flush();
    if (
      token.raw === String.raw`\u` &&
      unicodeEscapePoints(source, token.start + 2)?.points.some((point) => point > 127)
    )
      throw new RegexpSourceError('incompatible character encoding');
  }
  flush();
}
