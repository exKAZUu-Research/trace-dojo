import type { WordPart } from './ast';
import { charactersOf } from './characters';

/** A character of a word that brace expansion may read, or a part it passes over as a whole. */
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
    const text = token.kind === 'char' ? token.c : token.part.kind === 'literal' ? token.part.text : undefined;
    const last = parts.at(-1);
    if (text !== undefined && last?.kind === 'literal') last.text += text;
    else if (text !== undefined) parts.push({ kind: 'literal', text });
    else parts.push((token as Extract<Token, { kind: 'opaque' }>).part);
  }
  return parts;
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

// code-gauge-allow functionCognitiveComplexity 27 -- Bash's brace expansion: the preamble, the alternatives or sequence, and the postscript in one recursion.
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
      alternatives = sequence.map((item) => charactersOf(item).map((c): Token => ({ kind: 'char', c })));
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
// code-gauge-allow functionCognitiveComplexity 18 -- Bash's expand_seqterm, whose integer, padding, and letter rules share the parsed terms.
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
