import { decodeDoubleQuoted } from './escapes';
import { regexpByteEscape, RegexpEncodingError } from './regexpEscapes';
import { regexpSourceTokens } from './regexpLexicalSource';
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
  if (!isAsciiText(source)) throw new RegexpEncodingError('incompatible character encoding');
  let bytes = '';
  const flush = (): void => {
    const valid = encoding === 'n' || (encoding === 'e' ? eucJpBytes : windows31jBytes).test(bytes);
    if (!valid) throw new RegexpEncodingError('invalid multibyte escape');
    bytes = '';
  };
  for (const token of regexpSourceTokens(source, flags.includes('x'))) {
    if (token.type !== 'Character') {
      flush();
      continue;
    }
    let index = 0;
    while (index < token.raw.length) {
      const byte = regexpByteEscape(token.raw, index);
      if (byte) {
        bytes += String.fromCodePoint(byte.value);
        index += byte.length;
        continue;
      }
      flush();
      if (token.raw.startsWith(String.raw`\u`)) {
        const decoded = decodeDoubleQuoted(token.raw);
        if (decoded && !isAsciiText(decoded.text)) throw new RegexpEncodingError('incompatible character encoding');
      }
      break;
    }
  }
  flush();
}
