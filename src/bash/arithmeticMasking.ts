import type { Node, Parser } from '@willbooster/web-tree-sitter';

import { arithmeticEnd, skipBalanced, skipBlanks, skipWordPiece, SourceText } from './syntaxWords';

/**
 * The text of arithmetic expressions that the grammar cannot read, by the offset where each one's text starts. Bash
 * reads `$((...))`, `((...))`, and `$[...]` as text that it evaluates only when it runs them, so an invalid expression
 * is an error at run time, not a syntax error; the grammar parses them as expressions and fails on invalid ones.
 */
export type MaskedArithmetic = Map<number, string>;

const MAX_PASSES = 50;
const BOUNDARY_CHARS = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
const COMPOUND_ARRAY_LHS = /(?:^|[ \t\n;&|()])(?:[A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=$/;

interface Region {
  opener: '((' | '$((' | '$[' | '[';
  openStart: number;
  start: number;
  end: number;
  closeEnd: number;
  keepsSemicolons: boolean;
}

/**
 * Blanks out the text of every arithmetic expression the grammar fails on, keeping its newlines (and, in `for ((`,
 * its top-level semicolons) so that rows and offsets stay in place, until the program parses or no failing region remains.
 */
export function maskInvalidArithmetic(parser: Parser, source: string): { source: string; masked: MaskedArithmetic } {
  const masked: MaskedArithmetic = new Map();
  const regions = collectArithmeticRegions(source);
  let text = source;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const tree = parser.parse(text);
    if (!tree) throw new Error('The parser returned no tree');
    try {
      const region = firstFailingRegion(tree.rootNode, regions, masked);
      if (!region) break;
      const original = source.slice(region.start, region.end);
      masked.set(region.start, original);
      const blank = blankArithmeticSlice(original, region.keepsSemicolons);
      text = text.slice(0, region.start) + blank + text.slice(region.end);
    } finally {
      tree.delete();
    }
  }
  return { source: text, masked };
}

function firstFailingRegion(root: Node, regions: readonly Region[], masked: MaskedArithmetic): Region | undefined {
  const errors = root.hasError ? collectErrorNodes(root) : [];
  for (const region of regions) {
    if (masked.has(region.start) || region.end === region.start) continue;
    const misparsedSubshell =
      region.opener === '((' && root.descendantForIndex(region.openStart, region.openStart + 2)?.type !== '((';
    const fails =
      misparsedSubshell || errors.some((err) => err.startIndex <= region.closeEnd && err.endIndex >= region.openStart);
    if (fails) return region;
  }
  return undefined;
}

function collectErrorNodes(root: Node): Node[] {
  const errors: Node[] = [];
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop() as Node;
    if (node.isError || node.isMissing) {
      errors.push(node);
      continue;
    }
    if (!node.hasError) continue;
    let childHasError = false;
    for (const child of node.children) {
      if (child.hasError || child.isError || child.isMissing) {
        childHasError = true;
        pending.push(child);
      }
    }
    if (!childHasError) errors.push(node);
  }
  return errors;
}

// code-gauge-allow functionCognitiveComplexity -- Preserves newlines and top-level semicolons outside quotes and parentheses in C-style for headers.
function blankArithmeticSlice(slice: string, keepsSemicolons: boolean): string {
  if (!keepsSemicolons) return slice.replaceAll(/[^\n]/g, ' ');
  let out = '';
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    if (c === '\\' && quote !== "'") {
      out += i + 1 < slice.length && slice[i + 1] === '\n' ? ' \n' : '  ';
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = undefined;
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && depth > 0) depth--;
    out += c === '\n' || (c === ';' && depth === 0) ? c : ' ';
  }
  return out;
}

function collectArithmeticRegions(source: string): Region[] {
  const text = new SourceText(source);
  const regions: Region[] = [];
  text.parseSubstitution = (start) => scanPlain(text, start, ')', regions);
  text.onArithmetic = (opener, openStart, start, end, closeEnd) => {
    regions.push({ opener, openStart, start, end, closeEnd, keepsSemicolons: false });
  };
  try {
    scanPlain(text, 0, undefined, regions);
  } catch {
    // Unclosed quotes or excessive nesting are reported by the main syntax/tree checks.
  }
  for (const bq of text.backquotes) collectBackquoteRegions(source, bq.start + 1, bq.end - 1, regions);
  return regions.toSorted((a, b) => a.openStart - b.openStart);
}

function collectBackquoteRegions(source: string, bodyStart: number, bodyEnd: number, regions: Region[]): void {
  let inner = '';
  const offsets: number[] = [];
  for (let i = bodyStart; i < bodyEnd; i++) {
    if (source[i] === '\\' && i + 1 < bodyEnd && '$`\\'.includes(source[i + 1])) {
      i++;
    }
    offsets.push(i);
    inner += source[i];
  }
  offsets.push(bodyEnd);
  if (!inner.trim()) return;
  for (const sub of collectArithmeticRegions(inner)) {
    regions.push({
      opener: sub.opener,
      openStart: offsets[sub.openStart],
      start: offsets[sub.start],
      end: offsets[sub.end],
      closeEnd: offsets[sub.closeEnd],
      keepsSemicolons: sub.keepsSemicolons,
    });
  }
}

// code-gauge-allow functionCognitiveComplexity -- Scans shell comments, boundaries, ((...)) constructs, compound subscripts, and word pieces with bounded nesting.
function scanPlain(text: SourceText, from: number, stopChar: string | undefined, regions: Region[]): number {
  return text.nested(() => {
    const { source } = text;
    let atBoundary = true;
    for (let i = from; i < source.length;) {
      const c = source[i];
      if (c === stopChar) return i + 1;
      if (c === '#' && atBoundary) {
        while (i < source.length && source[i] !== '\n') i++;
        continue;
      }
      if (c === '(' && source[i + 1] === '(' && atBoundary) {
        const closeEnd = tryFindParenArithmeticEnd(text, i);
        if (closeEnd !== undefined) {
          regions.push({
            opener: '((',
            openStart: i,
            start: i + 2,
            end: closeEnd - 2,
            closeEnd,
            keepsSemicolons: isAfterFor(source, i),
          });
          i = closeEnd;
          atBoundary = true;
          continue;
        }
      }
      if (c === '(' && !atBoundary && COMPOUND_ARRAY_LHS.test(source.slice(0, i))) {
        i = scanCompoundSubscripts(text, i + 1, regions);
        atBoundary = false;
        continue;
      }
      if (BOUNDARY_CHARS.has(c)) {
        atBoundary = true;
        i++;
        continue;
      }
      i = skipWordPiece(text, i);
      atBoundary = false;
    }
    return source.length;
  });
}

// code-gauge-allow functionCognitiveComplexity -- Scans compound array elements for balanced [subscript]= and [subscript]+= headers.
function scanCompoundSubscripts(text: SourceText, from: number, regions: Region[]): number {
  const { source } = text;
  for (let i = from; i < source.length;) {
    i = skipBlanks(source, i);
    if (i >= source.length) return i;
    const c = source[i];
    if (c === '\n') {
      i++;
      continue;
    }
    if (c === ')') return i + 1;
    if (c === '[') {
      const closeEnd = tryFindSubscriptEnd(text, i);
      if (closeEnd !== undefined && (source.startsWith('=', closeEnd) || source.startsWith('+=', closeEnd))) {
        regions.push({ opener: '[', openStart: i, start: i + 1, end: closeEnd - 1, closeEnd, keepsSemicolons: false });
        i = closeEnd + (source.startsWith('+=', closeEnd) ? 2 : 1);
        while (i < source.length && !BOUNDARY_CHARS.has(source[i])) i = skipWordPiece(text, i);
        continue;
      }
    }
    if (BOUNDARY_CHARS.has(c)) i++;
    else while (i < source.length && !BOUNDARY_CHARS.has(source[i])) i = skipWordPiece(text, i);
  }
  return source.length;
}

function tryFindSubscriptEnd(text: SourceText, openBracket: number): number | undefined {
  try {
    return skipBalanced(text, openBracket, '[', ']');
  } catch {
    return undefined;
  }
}

function tryFindParenArithmeticEnd(text: SourceText, openParens: number): number | undefined {
  try {
    return arithmeticEnd(text, openParens);
  } catch {
    return undefined;
  }
}

function isAfterFor(source: string, openPos: number): boolean {
  return /(?:^|[ \t\n;&|()])for(?:[ \t]|\\\n)+$/.test(source.slice(0, openPos));
}
