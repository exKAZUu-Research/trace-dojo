import { isIdentifier } from './associativeTable';
import type { ParameterExpansion, WordPart } from './ast';
import { charactersOf } from './characters';

/** A character of a word that brace expansion may read (or a term of a sequence), or a part it passes over as a whole. */
type Token = { kind: 'char'; c: string } | { kind: 'opaque'; part: WordPart };

/** Expands the braces of a word's parts, as Bash's `brace_expand`, giving the parts of each resulting word. */
export function expandBraces(parts: WordPart[], spend: () => void): WordPart[][] {
  if (!parts.some((part) => part.kind === 'literal' && part.text.includes('{'))) return [parts];
  return expandTokens(tokensOf(parts), spend).map(partsOf);
}

function tokensOf(parts: WordPart[]): Token[] {
  const tokens: Token[] = [];
  for (const part of parts) {
    if (part.kind !== 'literal') {
      tokens.push({ kind: 'opaque', part });
      continue;
    }
    const chars = charactersOf(part.text);
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] === '\\' && i + 1 < chars.length) {
        tokens.push({ kind: 'opaque', part: { kind: 'literal', text: `\\${chars[i + 1]}` } });
        i++;
      } else tokens.push({ kind: 'char', c: chars[i] });
    }
  }
  return tokens;
}

function partsOf(tokens: Token[]): WordPart[] {
  const parts: WordPart[] = [];
  for (const token of tokens) {
    if (token.kind === 'char') appendCharToken(parts, token.c);
    else appendOpaquePart(parts, token.part);
  }
  return parts;
}

function appendCharToken(parts: WordPart[], text: string): void {
  if (text === '') return;
  const last = parts.at(-1);
  if (tryExtendParameter(parts, last, text) || tryPromoteTrailingDollar(parts, last, text)) return;
  if (last?.kind === 'literal') last.text += text;
  else parts.push({ kind: 'literal', text });
}

function tryExtendParameter(parts: WordPart[], last: WordPart | undefined, text: string): boolean {
  if (!canExtendIdentifierParameter(last)) return false;
  const match = /^([A-Za-z0-9_]+)(.*)$/s.exec(text);
  if (!match) return false;
  last.name += match[1];
  last.text = `$${last.name}`;
  if (match[2] !== '') parts.push({ kind: 'literal', text: match[2] });
  return true;
}

function tryPromoteTrailingDollar(parts: WordPart[], last: WordPart | undefined, text: string): boolean {
  if (last?.kind !== 'literal' || !hasTrailingUnescapedDollar(last.text)) return false;
  const started = startDollarParameter(text);
  if (!started) return false;
  last.text = last.text.slice(0, -1);
  if (last.text === '') parts.pop();
  parts.push(started.parameter);
  if (started.rest !== '') parts.push({ kind: 'literal', text: started.rest });
  return true;
}

function canExtendIdentifierParameter(part: WordPart | undefined): part is ParameterExpansion {
  return (
    part?.kind === 'parameter' &&
    !part.braced &&
    part.operator === undefined &&
    part.prefix === undefined &&
    part.subscript === undefined &&
    isIdentifier(part.name)
  );
}

function hasTrailingUnescapedDollar(text: string): boolean {
  if (!text.endsWith('$')) return false;
  let backslashes = 0;
  for (let i = text.length - 2; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 0;
}

function startDollarParameter(text: string): { parameter: ParameterExpansion; rest: string } | undefined {
  const match = /^([A-Za-z_][A-Za-z0-9_]*|[0-9@#?*!$-])(.*)$/s.exec(text);
  if (!match) return undefined;
  const [, name, rest] = match;
  return {
    parameter: { kind: 'parameter', name, argument: [], text: `$${name}`, braced: false },
    rest,
  };
}

function appendOpaquePart(parts: WordPart[], part: WordPart): void {
  const last = parts.at(-1);
  if (part.kind === 'literal') {
    if (last?.kind === 'literal') last.text += part.text;
    else parts.push({ kind: 'literal', text: part.text });
    return;
  }
  parts.push(part.kind === 'parameter' ? { ...part, argument: [...part.argument] } : part);
}

const isChar = (token: Token | undefined, c: string): boolean => token?.kind === 'char' && token.c === c;

interface Amble {
  close: number;
  commas: number[];
  isSequence: boolean;
}

/** The `}` that closes the brace at `open`, with the commas at its level, or `undefined` when none does. */
function findAmble(tokens: Token[], open: number): Amble | undefined {
  let depth = 0;
  const commas: number[] = [];
  for (let i = open + 1; i < tokens.length; i++) {
    if (isChar(tokens[i], '{') && !isChar(tokens[i - 1], '$')) depth++;
    else if (isChar(tokens[i], '}')) {
      if (depth === 0) {
        const inner = tokens.slice(open + 1, i);
        const isSequence = commas.length === 0 && inner.every((token) => token.kind === 'char');
        return { close: i, commas, isSequence };
      }
      depth--;
    } else if (isChar(tokens[i], ',') && depth === 0) commas.push(i);
  }
  return undefined;
}

// code-gauge-allow functionCognitiveComplexity -- Bash's brace expansion: the preamble, the alternatives or sequence, and the postscript in one recursion.
function expandTokens(tokens: Token[], spend: () => void): Token[][] {
  spend();
  for (let open = 0; open < tokens.length; open++) {
    if (!isChar(tokens[open], '{') || isChar(tokens[open - 1], '$')) continue;
    const amble = findAmble(tokens, open);
    if (!amble) continue;
    const { close, commas } = amble;
    let alternatives: Token[][];
    if (commas.length > 0) {
      const bounds = [open, ...commas, close];
      alternatives = [];
      for (let i = 0; i + 1 < bounds.length; i++) {
        alternatives.push(...expandTokens(tokens.slice(bounds[i] + 1, bounds[i + 1]), spend));
      }
    } else {
      const text = tokens
        .slice(open + 1, close)
        .map((token) => (token.kind === 'char' ? token.c : ''))
        .join('');
      const sequence = amble.isSequence ? sequenceOf(text, spend) : undefined;
      if (!sequence) continue;
      // A term of a sequence holds no brace or comma, so one token stands for all its characters.
      alternatives = sequence.map((item): Token[] => [{ kind: 'char', c: item }]);
    }
    const preamble = tokens.slice(0, open);
    const postambles = expandTokens(tokens.slice(close + 1), spend);
    const results: Token[][] = [];
    for (const alternative of alternatives) {
      for (const postamble of postambles) {
        spend();
        results.push([...preamble, ...alternative, ...postamble]);
      }
    }
    return results;
  }
  return [tokens];
}

const isInteger = (value: string): boolean => /^[-+]?\d+$/.test(value);
const isLetter = (value: string): boolean => /^[A-Za-z]$/.test(value);
/** Whether a term of a sequence starts with a zero, which pads every term to the width of the longer one. */
const isPadded = (value: string): boolean => /^-?0\d/.test(value);

/** The terms of a sequence expression `x..y[..incr]`, as Bash's `expand_seqterm`, or `undefined` when invalid. */
// code-gauge-allow functionCognitiveComplexity -- Bash's expand_seqterm, whose integer, padding, and letter rules share the parsed terms.
function sequenceOf(text: string, spend: () => void): string[] | undefined {
  const match = /^(.+?)\.\.(.+?)(?:\.\.([-+]?\d+))?$/u.exec(text);
  if (!match) return undefined;
  const [, lhs, rhs, incrementText] = match;
  const increment = incrementText === undefined ? 1n : BigInt(incrementText);
  if (isInteger(lhs) && isInteger(rhs)) {
    const start = BigInt(lhs);
    const end = BigInt(rhs);
    let width = 0;
    if (isPadded(lhs) || isPadded(rhs)) width = Math.max(lhs.length, rhs.length);
    return mkseq(start, end, increment, spend).map((n) => {
      const digits = (n < 0n ? -n : n).toString();
      const sign = n < 0n ? '-' : '';
      return width > 0 ? sign + digits.padStart(width - sign.length, '0') : `${n}`;
    });
  }
  if (isLetter(lhs) && isLetter(rhs)) {
    return mkseq(BigInt(lhs.codePointAt(0) as number), BigInt(rhs.codePointAt(0) as number), increment, spend).map(
      (n) => String.fromCodePoint(Number(n))
    );
  }
  return undefined;
}

function mkseq(start: bigint, end: bigint, increment: bigint, spend: () => void): bigint[] {
  let step = increment === 0n ? 1n : increment;
  if (step < 0n) step = -step;
  if (start > end) step = -step;
  const result: bigint[] = [];
  for (let n = start; start <= end ? n <= end : n >= end; n += step) {
    spend();
    result.push(n);
  }
  return result;
}
