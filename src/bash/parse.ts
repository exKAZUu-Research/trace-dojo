import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn, type TraceOptions } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import { skipSubscript } from './arithmetic';
import { maskInvalidArithmetic } from './arithmeticMasking';
import type { Program, Statement, WordPart } from './ast';
import { hideInvalidBackquotes } from './backquotes';
import { Converter, decodeAnsiC } from './converter';
import { checkBashSyntax } from './syntaxCheck';
import { syntaxErrorMessage, syntaxErrorsOf } from './syntaxErrors';
import { skipBalanced, skipWordPiece, SourceText } from './syntaxWords';

const parser = await loadParser('@willbooster/tree-sitter-bash/tree-sitter-bash.wasm');

export const misplacedBashAtomicMessage =
  '# atomic は、関数を定義する行（関数の名前から本体の { がある行まで）に付けてください。';

/**
 * Parses a program, throwing a `CompileError` for the syntax errors Bash reports and for syntax this environment
 * does not support.
 *
 * @param trace Marks the functions whose headers hold `# atomic`, for a model program.
 */
export function parseBash(source: string, trace?: TraceOptions): Program {
  return parseText(source, new Set(trace?.atomicAnnotations.keys()));
}

function parseText(source: string, atomicRows: ReadonlySet<number>): Program {
  const { error, backquotes, literalSingleQuotes } = checkBashSyntax(source);
  if (error && error !== 'unknown')
    throw new CompileError([{ row: error.row, message: syntaxErrorMessage(error.text) }]);
  const hidden = hideInvalidBackquotes(source, backquotes);
  const quoteSet = new Set([...literalSingleQuotes, ...hidden.literalSingleQuotes]);
  const quoteNormalized = maskLiteralSingleQuotes(hidden.source, quoteSet);
  const { source: parsedSource, masked } = maskInvalidArithmetic(parser, quoteNormalized);
  return parseSource(
    parser,
    parsedSource,
    {},
    (root) => {
      const converter = new Converter(
        parsedSource,
        atomicRows,
        masked,
        rawArithmeticPieces,
        reparseBackquoted,
        hidden.errors,
        quoteSet,
        source
      );
      const program = converter.convertProgram(root);
      for (const row of atomicRows) {
        if (!converter.claimedAtomicRows.has(row)) {
          throw new CompileError([{ row, message: misplacedBashAtomicMessage }]);
        }
      }
      return program;
    },
    {
      locateErrors: (root: Node) => syntaxErrorsOf(root, parsedSource, isEmptySubscript),
      isBenignError: isEmptySubscript,
    }
  );
}

function maskLiteralSingleQuotes(source: string, offsets: ReadonlySet<number>): string {
  if (offsets.size === 0) return source;
  let out = '';
  for (let i = 0; i < source.length; i++) out += offsets.has(i) ? '\u001F' : source[i];
  return out;
}

/** An empty subscript (`a[]`), which the grammar fills with a missing token but Bash rejects only when it runs. */
function isEmptySubscript(node: Node): boolean {
  return node.type === 'raw_string' && node.startIndex === node.endIndex && node.parent?.type === 'subscript';
}

/**
 * The pieces of arithmetic text the grammar could not read, whose expansions Bash still performs before it evaluates
 * the text: the text is read as a double-quoted string, as Bash treats it.
 */
function rawArithmeticPieces(raw: string): (string | WordPart)[] {
  if (!/[$`]/.test(raw)) return [raw];
  const wrapped = `"${raw.replaceAll('"', String.raw`\"`)}"`;
  const tree = parser.parse(wrapped);
  if (!tree) throw new Error('The parser returned no tree');
  try {
    const string = tree.rootNode.descendantsOfType('string')[0];
    if (tree.rootNode.hasError || !string) return [raw];
    const [part] = new Converter(
      wrapped,
      new Set(),
      new Map(),
      () => [raw],
      reparseBackquoted,
      new Map(),
      new Set()
    ).word(string).parts;
    if (part?.kind !== 'double') return [raw];
    return part.parts.map((inner) => (inner.kind === 'literal' ? inner.text.replaceAll(String.raw`\"`, '"') : inner));
  } finally {
    tree.delete();
  }
}

/** The statements of a backquoted body read again, padded so that its rows stay those of the program. */
function reparseBackquoted(text: string, row: number): Statement[] {
  return parseText(`${'\n'.repeat(row)}${text}`, new Set()).units.flat();
}

/** Matches the annotation a line comment ends with, which may follow an ordinary remark. */
const BASH_ANNOTATION_PATTERN = /#[ \t]*atomic[ \t]*$/;

/** The `# atomic` annotations of a program, read from its comment tokens. */
export function findBashTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(
    commentTokens(parser, source).filter((comment) => comment.text.startsWith('#')),
    BASH_ANNOTATION_PATTERN
  );
}

/**
 * Parses an associative-array subscript taken from an arithmetic string (`let 'a[$k]+=1'`, `let 'a["x"]+=1'`) into
 * word parts whose quotes are stripped and whose `$` / backquote expansions run while keeping plain spaces intact.
 */
export function parseSubscriptWordParts(raw: string): WordPart[] {
  const parts: WordPart[] = [];
  const text = new SourceText(raw);
  text.parseSubstitution = (start) => skipBalanced(text, start - 1, '(', ')');
  for (let i = 0; i < raw.length;) {
    const piece = readSubscriptPiece(raw, i, text);
    parts.push(...piece.parts);
    i = piece.next;
  }
  return parts;
}

function readSubscriptPiece(raw: string, i: number, text: SourceText): { parts: WordPart[]; next: number } {
  const c = raw[i];
  if (c === "'") return readSingleQuotedSubscript(raw, i);
  if (c === '\\') return readEscapedSubscript(raw, i);
  if (c === '$' && raw[i + 1] === "'") {
    const ansi = tryReadAnsiCSubscript(raw, i);
    if (ansi) return ansi;
  }
  if (c === '"' || c === '`' || (c === '$' && `"{([`.includes(raw[i + 1] ?? ''))) {
    return readTreeParsedSubscript(raw, i, text);
  }
  if (c === '$') {
    const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@#?*!$-])/.exec(raw.slice(i));
    if (match) {
      return {
        parts: [{ kind: 'parameter', name: match[0].slice(1), argument: [], text: match[0], braced: false }],
        next: i + match[0].length,
      };
    }
  }
  return { parts: [{ kind: 'single', text: c }], next: i + 1 };
}

function readSingleQuotedSubscript(raw: string, i: number): { parts: WordPart[]; next: number } {
  const close = raw.indexOf("'", i + 1);
  if (close === -1) return { parts: [{ kind: 'single', text: "'" }], next: i + 1 };
  return { parts: [{ kind: 'single', text: raw.slice(i + 1, close) }], next: close + 1 };
}

function readEscapedSubscript(raw: string, i: number): { parts: WordPart[]; next: number } {
  if (i + 1 >= raw.length) return { parts: [{ kind: 'single', text: '\\' }], next: i + 2 };
  if (raw[i + 1] === '\n') return { parts: [], next: i + 2 };
  return { parts: [{ kind: 'single', text: raw[i + 1] }], next: i + 2 };
}

function tryReadAnsiCSubscript(raw: string, i: number): { parts: WordPart[]; next: number } | undefined {
  let close = i + 2;
  while (close < raw.length && raw[close] !== "'") close += raw[close] === '\\' ? 2 : 1;
  if (close >= raw.length) return undefined;
  return { parts: [{ kind: 'ansiC', text: decodeAnsiC(raw.slice(i + 2, close)) }], next: close + 1 };
}

function readTreeParsedSubscript(raw: string, i: number, text: SourceText): { parts: WordPart[]; next: number } {
  let end = i + 1;
  try {
    end = skipWordPiece(text, i);
  } catch {
    end = raw.length;
  }
  return { parts: parsePiece(raw.slice(i, end)), next: end };
}

function parsePiece(piece: string): WordPart[] {
  const tree = parser.parse(piece);
  if (!tree) return [{ kind: 'single', text: piece }];
  try {
    const first = tree.rootNode.namedChildren[0];
    const target = first?.type === 'command' ? (first.childForFieldName('name')?.namedChildren[0] ?? first) : first;
    if (tree.rootNode.hasError || !target) return [{ kind: 'single', text: piece }];
    return new Converter(piece, new Set(), new Map(), () => [piece], reparseBackquoted, new Map()).word(target).parts;
  } finally {
    tree.delete();
  }
}

/** Extracts the unexpanded `length` slice from `${name:offset:length}` for Bash's negative-length diagnostic. */
export function rawLengthSource(expansionText: string, name: string): string {
  let i = 2;
  if (expansionText[i] === '#' || expansionText[i] === '!') i++;
  i += name.length;
  if (expansionText[i] === '[') i = skipSubscript(expansionText, i) + 1;
  if (expansionText[i] === ':') i++;
  const body = expansionText.slice(i, -1);
  const splitIndex = findRawLengthColon(body);
  return (splitIndex === -1 ? body : body.slice(splitIndex + 1)).trim();
}

const SUBSTRING_BRACKET_DELTA: Record<string, number | undefined> = { '{': 1, '(': 1, '}': -1, ')': -1 };

function findRawLengthColon(body: string): number {
  let depth = 0;
  let conditional = 0;
  for (let pos = 0; pos < body.length; pos++) {
    const quoted = skipQuotedSubstringAtom(body, pos);
    if (quoted !== pos) {
      pos = quoted;
      continue;
    }
    const delta = SUBSTRING_BRACKET_DELTA[body[pos]];
    if (delta !== undefined) {
      depth += delta;
      continue;
    }
    if (depth > 0) continue;
    if (body[pos] === '?') conditional++;
    else if (body[pos] === ':' && conditional > 0) conditional--;
    else if (body[pos] === ':') return pos;
  }
  return -1;
}

function skipQuotedSubstringAtom(body: string, pos: number): number {
  const c = body[pos];
  if (c === '\\') return pos + 1;
  if (c === "'") {
    const close = body.indexOf("'", pos + 1);
    return close === -1 ? body.length : close;
  }
  if (c !== '"') return pos;
  let end = pos + 1;
  for (; end < body.length && body[end] !== '"'; end++) if (body[end] === '\\') end++;
  return end;
}
