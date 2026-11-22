import { type Token, tokenize } from 'oniguruma-parser/tokenizer';

import { ExecutionLimitError } from '../interpreter/limits';
import { RegexpEncodingError } from './regexpEscapes';
import { UnsupportedFeatureError } from './runtime';

export function regexpHasCharacterMode(source: string, extended: boolean): boolean {
  return regexpSourceTokens(source, extended).some(
    (token) => (token.type === 'GroupOpen' || token.type === 'Directive') && /^\(\?[imxadu]*[adu]/.test(token.raw)
  );
}

export function regexpHasLiteralPosixBracket(source: string, extended: boolean): boolean {
  return (
    source.includes('[:') &&
    regexpSourceTokens(source, extended).some((token) => token.type === 'Character' && token.raw === '[')
  );
}

export function regexpLexicalSource(source: string, extended: boolean): string {
  return regexpSourceTokens(source, extended)
    .map((token) => sourceToken(token, source))
    .join('');
}

export function regexpSourceTokens(source: string, extended: boolean, captureGroup?: boolean): Token[] {
  try {
    return tokenize(source, { flags: extended ? 'x' : '', rules: { rubySyntax: true, captureGroup } }).tokens;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof UnsupportedFeatureError) throw error;
    if (error instanceof RangeError) throw new ExecutionLimitError('operations');
    if (error instanceof Error && error.message === 'Quantifier value unsupported in Oniguruma')
      throw new RegexpEncodingError('too big number for repeat range');
    if (
      error instanceof Error &&
      /unsupported/i.test(error.message) &&
      !error.message.startsWith('Invalid or unsupported group option')
    )
      throw new UnsupportedFeatureError('正規表現の構文の検証');
    throw new SyntaxError(error instanceof Error ? error.message : 'invalid regexp source');
  }
}

// code-gauge-allow functionCognitiveComplexity -- Original token boundaries and option precedence must stay visible while constructing the compiler source.
function sourceToken(token: Token, source: string): string {
  if (token.type === 'Character') {
    if (token.raw.startsWith('\\')) {
      validateEscape(token.raw, token.rawStart, source.length);
      return token.raw;
    }
    return token.raw === ']' ? token.raw : `\\u{${token.value.toString(16)}}`;
  }
  if (
    (token.type === 'GroupOpen' && token.kind === 'group') ||
    (token.type === 'Directive' && token.kind === 'flags')
  ) {
    const options = /^\(\?([imxadu]*)(?:-([imx]*))?([:)])$/.exec(token.raw);
    if (options) {
      const disabled = new Set(options[2]);
      const on = [...new Set(options[1])].filter((flag) => !'xadu'.includes(flag) && !disabled.has(flag)).join('');
      const off = [...disabled].filter((flag) => flag !== 'x').join('');
      return on || off || options[3] === ':' ? `(?${on}${off ? `-${off}` : ''}${options[3]}` : '';
    }
  }
  return token.raw;
}

// code-gauge-allow functionCognitiveComplexity -- The complete Ruby escape families are checked before source rewriting can join or discard their characters.
function validateEscape(raw: string, start: number | undefined, sourceLength: number): void {
  if (raw === '\\') throw new RegexpEncodingError('too short escape sequence');
  if (raw.startsWith(String.raw`\x`) && !/^(?:\\x[\da-f]{1,2})+$/i.test(raw))
    throw new RegexpEncodingError('invalid hex escape');
  if (raw.startsWith(String.raw`\u`)) {
    if (raw.startsWith(String.raw`\u{`)) {
      if (!/^\\u\{[ \t\r\n\f\v]*[\da-f]+(?:[ \t\r\n\f\v]+[\da-f]+)*[ \t\r\n\f\v]*\}$/i.test(raw))
        throw new RegexpEncodingError('invalid Unicode list');
    } else if (!/^\\u[\da-f]{4}$/i.test(raw))
      throw new RegexpEncodingError(
        raw === String.raw`\u` && start !== undefined && start + raw.length === sourceLength
          ? 'too short escape sequence'
          : 'invalid Unicode escape'
      );
  }
  if (/^\\[pP]\{/.test(raw) && !raw.endsWith('}')) {
    const name = raw.slice(3).replace(/^\^/, '').slice(0, -1);
    throw new RegexpEncodingError(`invalid character property name {${name}}`);
  }
}
