import { RegexpSourceError } from './regexpEscapes';
import { type RegexpToken, regexpTokens, unicodeEscapePoints } from './regexpTokens';
import { UnsupportedFeatureError } from './runtime';

interface Rewrite {
  text: string;
  /** The source length that the text replaces, from the start of the token. */
  length: number;
}

const REFERENCE_NAME = /<([^>]*)>|'([^']*)'/y;
const INTERVAL = /\{(\d+)(?:,(\d*))?\}(\?)?/y;
/** Whitespace that the library skips in extended mode although Ruby matches it literally. */
const LITERAL_WHITESPACE = /^[^\S \t\n\f\r]$/;
const ASCII_NAME = /^[A-Za-z_]\w*$/;

/** Ruby's `\d`, `\s` and `\w` cover ASCII only, while Oniguruma's default ones cover Unicode. */
const ASCII_SHORTHANDS: Record<string, string> = {
  d: '[0-9]',
  D: '[^0-9]',
  s: String.raw`[ \t\n\v\f\r]`,
  S: String.raw`[^ \t\n\v\f\r]`,
  w: '[a-zA-Z0-9_]',
  W: '[^a-zA-Z0-9_]',
};

/** Rewrites the Ruby (Onigmo) forms whose Oniguruma meaning differs into Oniguruma forms with Ruby's meaning. */
export function onigurumaSource(source: string, extended: boolean): string {
  const tokens = regexpTokens(source, extended);
  // Oniguruma restricts capture names to ASCII words, so any other name gets an alias.
  const aliases = new Map<string, string>();
  const names = new Set(tokens.map((token) => token.name));
  let serial = 0;
  for (const name of names) {
    if (name === undefined || ASCII_NAME.test(name)) continue;
    while (names.has(`__capture${serial}__`)) serial++;
    aliases.set(name, `__capture${serial++}__`);
  }
  let out = '';
  let consumed = 0;
  for (const token of tokens) {
    if (token.start < consumed) continue;
    const rewrite = rewrittenToken(source, token, aliases);
    out += rewrite?.text ?? token.raw;
    consumed = token.start + (rewrite?.length ?? token.raw.length);
  }
  return out;
}

function rewrittenToken(source: string, token: RegexpToken, aliases: Map<string, string>): Rewrite | undefined {
  if (token.name !== undefined)
    return { text: `(?<${aliases.get(token.name) ?? token.name}>`, length: token.raw.length };
  if (token.kind === 'escape') return rewrittenEscape(source, token, aliases);
  if (token.kind !== 'char') return undefined;
  if (token.raw === '{' && !token.inClass) return rubyInterval(source, token.start);
  if (LITERAL_WHITESPACE.test(token.raw))
    return { text: `\\x{${token.raw.codePointAt(0)!.toString(16)}}`, length: token.raw.length };
  return undefined;
}

function rewrittenEscape(source: string, token: RegexpToken, aliases: Map<string, string>): Rewrite | undefined {
  const next = token.raw[1];
  const end = token.start + token.raw.length;
  if (next === 'K' && !token.inClass) throw new UnsupportedFeatureError(String.raw`正規表現の\K`);
  // Oniguruma reads these two as character sets, while Ruby reads an unknown escape as the letter itself.
  if (next === 'N' || next === 'O') return { text: next, length: token.raw.length };
  if (next in ASCII_SHORTHANDS)
    return boundsRange(source, token) ? undefined : { text: ASCII_SHORTHANDS[next], length: token.raw.length };
  if (next === 'u') {
    const list = unicodeEscapePoints(source, end);
    if (!list && source[end] === '{') throw new RegexpSourceError('invalid Unicode list');
    return (
      list && {
        text: list.points.map((point) => `\\x{${point.toString(16)}}`).join(''),
        length: token.raw.length + list.length,
      }
    );
  }
  return (next === 'k' || next === 'g') && !token.inClass ? rewrittenReference(source, token, aliases) : undefined;
}

function rewrittenReference(source: string, token: RegexpToken, aliases: Map<string, string>): Rewrite | undefined {
  REFERENCE_NAME.lastIndex = token.start + token.raw.length;
  const reference = REFERENCE_NAME.exec(source);
  if (!reference) return undefined;
  const name = reference[1] ?? reference[2];
  return { text: `${token.raw}<${aliases.get(name) ?? name}>`, length: token.raw.length + reference[0].length };
}

/** Whether a class shorthand stands where a range bound would; the unchanged shorthand lets the library reject it as Ruby does. */
function boundsRange(source: string, token: RegexpToken): boolean {
  if (!token.inClass) return false;
  const end = token.start + token.raw.length;
  return (
    (source[end] === '-' && source[end + 1] !== ']') ||
    (source[token.start - 1] === '-' && !/[[^\\]/.test(source[token.start - 2] ?? '['))
  );
}

/** An interval in Oniguruma's terms: Ruby rejects a reversed range and reads `{n}?` as an optional `{n}`, not a lazy one. */
function rubyInterval(source: string, start: number): Rewrite | undefined {
  INTERVAL.lastIndex = start;
  const interval = INTERVAL.exec(source);
  if (!interval) return undefined;
  const [text, lower, upper, optional] = interval;
  if (upper && Number(lower) > Number(upper))
    throw new RegexpSourceError('upper is smaller than lower in repeat range');
  return { text: upper === undefined && optional ? `{${lower}}{0,1}` : text, length: text.length };
}
