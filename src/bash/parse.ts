import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn, type TraceOptions } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import { skipSubscript } from './arithmetic';
import type { ParameterExpansion, Program, Statement, WordPart } from './ast';
import { rejectUnsupportedFeature } from './capabilities';
import { Converter, decodeAnsiC } from './converter';
import { analyzeBashSource, createValidatorSourceText, inspectUnescapedBackquoteBody } from './syntaxCheck';
import { syntaxErrorsOf } from './syntaxErrors';
import type { SourceText } from './syntaxWords';
import { arithmeticEnd, skipBalanced, skipWordPiece } from './syntaxWords';

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

function parseText(source: string, atomicRows: ReadonlySet<number>, readsApart = false): Program {
  const analyzed = analyzeBashSource(parser, source);
  return parseSource(
    parser,
    analyzed.grammarSource,
    {},
    (root) => {
      const converter = new Converter(analyzed, atomicRows, {
        rawPieces: rawArithmeticPieces,
        reparse: reparseBackquoted,
        parseSubscriptParts: parseSubscriptWordParts,
        parseBracedExpansion: parseBracedParameterExpansion,
        readsApart,
      });
      const program = converter.convertProgram(root);
      for (const row of atomicRows) {
        if (!converter.claimedAtomicRows.has(row)) {
          throw new CompileError([{ row, message: misplacedBashAtomicMessage }]);
        }
      }
      return program;
    },
    {
      locateErrors: (root: Node) => syntaxErrorsOf(root, analyzed.grammarSource, isEmptySubscript),
      isBenignError: isEmptySubscript,
    }
  );
}

/** An empty subscript (`a[]`), which the grammar fills with a missing token but Bash rejects only when it runs. */
function isEmptySubscript(node: Node): boolean {
  return node.type === 'raw_string' && node.startIndex === node.endIndex && node.parent?.type === 'subscript';
}

const UNSUPPORTED_SUFFIX = 'は、この採点環境では使えません。';

/**
 * The commands of a `trap` action, read when the trap is set, numbered as the `trap` command's line so that their
 * steps show there, or `undefined` for an action with a syntax error, which Bash finds only as it runs the action.
 */
export function parseTrapAction(text: string, row: number): Statement[][] | undefined {
  try {
    return parseText(`${'\n'.repeat(row)}${text}`, new Set()).units;
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    const message = error.diagnostics[0]?.message ?? '';
    // What the action uses that this environment does not provide stops the program when the trap is set.
    if (message.endsWith(UNSUPPORTED_SUFFIX)) rejectUnsupportedFeature(message.slice(0, -UNSUPPORTED_SUFFIX.length));
    return undefined;
  }
}

/**
 * The commands of a `trap` action with a syntax error that Bash runs before it reaches the error: those of the lines
 * before the line of the error that read as complete commands, numbered as `parseTrapAction` numbers them.
 */
export function parseTrapActionPrefix(text: string, row: number): Statement[][] {
  const lines = text.split('\n');
  let errorRow = lines.length;
  try {
    parseText(`${text}\n`, new Set());
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    errorRow = error.diagnostics[0]?.row ?? 0;
  }
  for (let count = Math.min(errorRow, lines.length); count > 0; count--) {
    const text = lines.slice(0, count).join('\n');
    const prefix = parseTrapAction(text, row);
    if (prefix !== undefined && endsAtLineEnd(text, prefix.flat().length)) return prefix;
  }
  return [];
}

/**
 * Whether the commands of `text`, `count` of them, end at its last line's end, which a backslash continuing that line
 * into the next prevents: a command on a line after it is then one more command, read as the grammar reads comments
 * and quotes.
 */
function endsAtLineEnd(text: string, count: number): boolean {
  try {
    return parseText(`${text}\n:\n`, new Set()).units.flat().length === count + 1;
  } catch {
    return false;
  }
}

/**
 * The syntax error of a `trap` action that `parseTrapAction` could not read, as Bash reports it when the action runs:
 * its message, numbered from `firstLine` for the action's first line, and the action's line it names, if any.
 */
export function trapActionSyntaxError(text: string, firstLine: number, showsLine: boolean): string[] {
  try {
    // Bash ends the action's last line itself; an action that already ends with a newline gets no empty line more.
    parseText(text.endsWith('\n') ? text : `${text}\n`, new Set());
    return [];
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    const { row, message } = error.diagnostics[0] ?? { row: 0, message: '' };
    const bashMessage = message.replace(/^構文エラーです（/, '').replace(/）。$/, '');
    const line = firstLine + row;
    const renumbered = bashMessage.replace(/on line (\d+)/, (_, n: string) => `on line ${firstLine + Number(n) - 1}`);
    const lines = [`line ${line}: ${renumbered}`];
    // Bash shows the line of an unexpected token, but not while `set -e` is on.
    if (showsLine && bashMessage.startsWith('syntax error near unexpected token')) {
      lines.push(`line ${line}: \`${text.split('\n')[row] ?? ''}'`);
    }
    return lines;
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
 * Scans deferred arithmetic text into literal slices and `WordPart` expansions using the single `SourceText` lexer,
 * without synthetic-string reparsing.
 */
export function rawArithmeticPieces(raw: string): (string | WordPart)[] {
  if (!/[$`"\\]/.test(raw)) return [raw];
  const text = createSubscriptSourceText(raw);
  const pieces: (string | WordPart)[] = [];
  let plain = '';
  for (let i = 0; i < raw.length;) {
    if (isArithmeticExpansionStart(raw, i)) {
      if (plain) pieces.push(plain);
      plain = '';
      const step = readLexicalPiece(raw, i, text, false);
      pieces.push(...step.parts);
      i = step.next;
    } else {
      const span = readPlainArithmeticChunk(raw, i);
      plain += span.chunk;
      i = span.next;
    }
  }
  if (plain) pieces.push(plain);
  return pieces;
}

function isArithmeticExpansionStart(raw: string, i: number): boolean {
  const c = raw[i];
  const next = raw[i + 1];
  return c === '"' || c === '`' || (c === '$' && next !== undefined && /['"{([A-Za-z_0-9@#?*!$-]/.test(next));
}

function readPlainArithmeticChunk(raw: string, i: number): { chunk: string; next: number } {
  const c = raw[i];
  if (c === "'") {
    const close = raw.indexOf("'", i + 1);
    if (close === -1) return { chunk: raw.slice(i), next: raw.length };
    return { chunk: `'${unescapeArithmeticSingleQuoted(raw.slice(i + 1, close))}'`, next: close + 1 };
  }
  const next = raw[i + 1];
  if (c === '\\' && next !== undefined) {
    return { chunk: unescapeArithmeticEscape(next), next: i + 2 };
  }
  return { chunk: c, next: i + 1 };
}

function unescapeArithmeticSingleQuoted(inner: string): string {
  if (!inner.includes('\\') && !inner.includes('"')) return inner;
  let out = '';
  for (let i = 0; i < inner.length;) {
    let end = i;
    while (inner[end] === '\\') end++;
    const step = formatSingleQuotedBackslashRun(end - i, inner[end]);
    out += step.text;
    i = end + step.consumed;
  }
  return out;
}

function formatSingleQuotedBackslashRun(runLen: number, after: string | undefined): { text: string; consumed: number } {
  if (after === '$' || after === '`') return { text: `${'\\'.repeat(runLen)}${after}`, consumed: 1 };
  const pairs = '\\'.repeat(Math.floor(runLen / 2));
  if (runLen % 2 === 1) {
    if (after === undefined) return { text: `${pairs}\\`, consumed: 0 };
    const tail = after === '"' || after === '\n' ? after : `\\${after}`;
    return { text: `${pairs}${tail}`, consumed: 1 };
  }
  if (after === undefined) return { text: pairs, consumed: 0 };
  return { text: after === '"' ? pairs : `${pairs}${after}`, consumed: 1 };
}

function unescapeArithmeticEscape(next: string): string {
  if (next === '\n') return '';
  return '$`"\\'.includes(next) ? next : `\\${next}`;
}

/**
 * Scans an associative-array subscript taken from runtime or deferred text into `WordPart`s without invoking
 * `parser.parse` on synthetic fragments.
 */
export function parseSubscriptWordParts(raw: string): WordPart[] {
  return scanWordSliceParts(raw, false, true);
}

function createSubscriptSourceText(raw: string): SourceText {
  const text = createValidatorSourceText(raw);
  text.parseSubstitution = (start) => skipBalanced(text, start - 1, '(', ')');
  return text;
}

function scanWordSliceParts(raw: string, inDouble: boolean, subscriptMode = false): WordPart[] {
  const parts: WordPart[] = [];
  const text = createSubscriptSourceText(raw);
  for (let i = 0; i < raw.length;) {
    const step = inDouble ? readDoubleInnerPiece(raw, i, text) : readLexicalPiece(raw, i, text, subscriptMode);
    for (const part of step.parts) appendWordPart(parts, part);
    i = step.next;
  }
  return parts;
}

function appendWordPart(parts: WordPart[], part: WordPart): void {
  const prev = parts.at(-1);
  if (part.kind === 'literal' && prev?.kind === 'literal') prev.text += part.text;
  else parts.push(part);
}

// code-gauge-allow functionCognitiveComplexity -- Dispatches single/double/ANSI-C quotes, escapes, command substitutions, arithmetic, and parameters.
function readLexicalPiece(
  raw: string,
  i: number,
  text: SourceText,
  subscriptMode: boolean
): { parts: WordPart[]; next: number } {
  const c = raw[i];
  if ((c === '<' || c === '>') && raw[i + 1] === '(') rejectUnsupportedFeature('プロセス置換（<( ... )）');
  if (c === "'") return readSingleQuotedSubscript(raw, i);
  if (c === '\\') return readEscapedPiece(raw, i, subscriptMode);
  if (c === '"' || (c === '$' && raw[i + 1] === '"')) return readDoubleQuotedPiece(raw, i, text);
  if (c === '`') return readBackquotedPiece(raw, i, text);
  if (c !== '$') {
    return { parts: [{ kind: subscriptMode ? 'single' : 'literal', text: c }], next: i + 1 };
  }
  if (raw[i + 1] === "'") {
    const ansi = tryReadAnsiCSubscript(raw, i);
    if (ansi) return ansi;
  }
  if (raw[i + 1] === '{') return readBracedExpansionPiece(raw, i, text, false);
  if (raw[i + 1] === '(' || raw[i + 1] === '[') return readDollarGroupPiece(raw, i, text);
  const simple = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@#?*!$_-])/.exec(raw.slice(i));
  if (simple) {
    return {
      parts: [{ kind: 'parameter', name: simple[0].slice(1), argument: [], text: simple[0], braced: false }],
      next: i + simple[0].length,
    };
  }
  return { parts: [{ kind: subscriptMode ? 'single' : 'literal', text: '$' }], next: i + 1 };
}

function readDoubleInnerPiece(raw: string, i: number, text: SourceText): { parts: WordPart[]; next: number } {
  const c = raw[i];
  if (c === '\\') {
    if (i + 1 < raw.length && raw[i + 1] === '\n') return { parts: [], next: i + 2 };
    const end = Math.min(i + 2, raw.length);
    return { parts: [{ kind: 'literal', text: raw.slice(i, end) }], next: end };
  }
  if (c === '`') return readBackquotedPiece(raw, i, text);
  if (c === '$') {
    if (raw[i + 1] === '{') return readBracedExpansionPiece(raw, i, text, true);
    if (raw[i + 1] === '(' || raw[i + 1] === '[') return readDollarGroupPiece(raw, i, text);
    const simple = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@#?*!$_-])/.exec(raw.slice(i));
    if (simple) {
      return {
        parts: [{ kind: 'parameter', name: simple[0].slice(1), argument: [], text: simple[0], braced: false }],
        next: i + simple[0].length,
      };
    }
  }
  return { parts: [{ kind: 'literal', text: c }], next: i + 1 };
}

function readSingleQuotedSubscript(raw: string, i: number): { parts: WordPart[]; next: number } {
  const close = raw.indexOf("'", i + 1);
  if (close === -1) return { parts: [{ kind: 'single', text: "'" }], next: i + 1 };
  return { parts: [{ kind: 'single', text: raw.slice(i + 1, close) }], next: close + 1 };
}

function readEscapedPiece(raw: string, i: number, subscriptMode: boolean): { parts: WordPart[]; next: number } {
  if (i + 1 >= raw.length) {
    return { parts: [{ kind: subscriptMode ? 'single' : 'literal', text: '\\' }], next: i + 2 };
  }
  if (raw[i + 1] === '\n') return { parts: [], next: i + 2 };
  return subscriptMode
    ? { parts: [{ kind: 'single', text: raw[i + 1] }], next: i + 2 }
    : { parts: [{ kind: 'literal', text: raw.slice(i, i + 2) }], next: i + 2 };
}

function tryReadAnsiCSubscript(raw: string, i: number): { parts: WordPart[]; next: number } | undefined {
  let close = i + 2;
  while (close < raw.length && raw[close] !== "'") close += raw[close] === '\\' ? 2 : 1;
  if (close >= raw.length) return undefined;
  return {
    parts: [{ kind: 'ansiC', text: decodeAnsiC(raw.slice(i + 2, close)), rawText: raw.slice(i, close + 1) }],
    next: close + 1,
  };
}

function readDoubleQuotedPiece(raw: string, i: number, text: SourceText): { parts: WordPart[]; next: number } {
  const quoteStart = raw[i] === '$' ? i + 1 : i;
  let end = raw.length;
  try {
    end = skipWordPiece(text, i);
  } catch {
    return { parts: [{ kind: 'single', text: raw[i] }], next: i + 1 };
  }
  const inner = raw.slice(quoteStart + 1, end - 1);
  return {
    parts: [{ kind: 'double', parts: scanWordSliceParts(inner, true, false), rawText: raw.slice(quoteStart, end) }],
    next: end,
  };
}

function readBackquotedPiece(raw: string, i: number, text: SourceText): { parts: WordPart[]; next: number } {
  let end = raw.length;
  try {
    end = skipWordPiece(text, i);
  } catch {
    return { parts: [{ kind: 'single', text: '`' }], next: i + 1 };
  }
  const slice = raw.slice(i, end);
  const unescaped = slice.slice(1, -1).replaceAll(/\\([$`\\])/g, '$1');
  const syntaxError = inspectUnescapedBackquoteBody(unescaped, 0);
  if (syntaxError) {
    return { parts: [{ kind: 'commandSubstitution', body: [], text: slice, row: 0, syntaxError }], next: end };
  }
  return {
    parts: [{ kind: 'commandSubstitution', body: reparseBackquoted(unescaped, 0), text: slice, row: 0 }],
    next: end,
  };
}

function readDollarGroupPiece(raw: string, i: number, text: SourceText): { parts: WordPart[]; next: number } {
  if (raw[i + 1] === '[') {
    let end = raw.length;
    try {
      end = skipBalanced(text, i + 1, '[', ']');
    } catch {
      return { parts: [{ kind: 'single', text: '$[' }], next: i + 2 };
    }
    const inner = raw.slice(i + 2, end - 1);
    return {
      parts: [
        {
          kind: 'arithmeticExpansion',
          expression: { pieces: rawArithmeticPieces(inner), row: 0 },
          rawText: raw.slice(i, end),
        },
      ],
      next: end,
    };
  }
  if (raw[i + 2] === '(') {
    let closeEnd: number | undefined;
    try {
      closeEnd = arithmeticEnd(text, i + 1);
    } catch {
      return { parts: [{ kind: 'single', text: '$((' }], next: i + 3 };
    }
    if (closeEnd !== undefined) {
      const inner = raw.slice(i + 3, closeEnd - 2);
      return {
        parts: [
          {
            kind: 'arithmeticExpansion',
            expression: { pieces: rawArithmeticPieces(inner), row: 0 },
            rawText: raw.slice(i, closeEnd),
          },
        ],
        next: closeEnd,
      };
    }
  }
  let end = raw.length;
  try {
    end = skipBalanced(text, i + 1, '(', ')');
  } catch {
    return { parts: [{ kind: 'single', text: '$(' }], next: i + 2 };
  }
  const slice = raw.slice(i, end);
  const body = parseSafeSubstitutionBody(raw.slice(i + 2, end - 1));
  return {
    parts: body ? [{ kind: 'commandSubstitution', body, text: slice, row: 0 }] : [{ kind: 'single', text: slice }],
    next: end,
  };
}

function parseSafeSubstitutionBody(inner: string): Statement[] | undefined {
  try {
    return parseText(inner, new Set(), true).units.flat();
  } catch (error) {
    if (error instanceof CompileError) {
      const msg = error.diagnostics[0]?.message ?? '';
      if (msg.endsWith('は、この採点環境では使えません。')) {
        rejectUnsupportedFeature(msg.slice(0, -'は、この採点環境では使えません。'.length));
      }
      return undefined;
    }
    throw error;
  }
}

function readBracedExpansionPiece(
  raw: string,
  i: number,
  text: SourceText,
  inDouble: boolean
): { parts: WordPart[]; next: number } {
  let end = raw.length;
  try {
    end = skipWordPiece(text, i);
  } catch {
    return { parts: [{ kind: 'single', text: '${' }], next: i + 2 };
  }
  const slice = raw.slice(i, end);
  if (/^\$\{[ \t\n|]/.test(slice)) {
    const reply = slice[2] === '|';
    const body = parseSafeSubstitutionBody(slice.slice(reply ? 3 : 2, -1));
    const part: WordPart = body
      ? { kind: 'commandSubstitution', body, text: slice, row: 0, mode: reply ? 'reply' : 'current' }
      : { kind: 'single', text: slice };
    return { parts: [part], next: end };
  }
  return { parts: [parseBracedParameterExpansion(slice, inDouble)], next: end };
}

const ORDERED_PARAMETER_OPERATORS = [
  ':-',
  ':=',
  ':?',
  ':+',
  '##',
  '%%',
  '//',
  '/#',
  '/%',
  '^^',
  ',,',
  '~~',
  '-',
  '=',
  '?',
  '+',
  '#',
  '%',
  '/',
  ':',
  '^',
  ',',
  '~',
  '@',
  '*',
];

const UNQUOTED_ARGUMENT_OPERATORS = new Set([
  '#',
  '##',
  '%',
  '%%',
  '/',
  '//',
  '/#',
  '/%',
  '^',
  '^^',
  ',',
  ',,',
  '~',
  '~~',
  '?',
  ':?',
]);

export function parseBracedParameterExpansion(slice: string, inDouble: boolean, row = 0): ParameterExpansion {
  const inner = slice.slice(2, -1);
  if (inner === '') return { kind: 'parameter', name: '', argument: [], text: slice, braced: true };
  const { prefix, pos: afterPrefix } = readParameterPrefix(inner);
  const header = readParameterNameAndSubscript(inner, afterPrefix, row);
  if (!header || header.kind === 'unclosedSubscript') {
    return {
      kind: 'parameter',
      name: '',
      argument: [],
      text: slice,
      braced: true,
      ...(header?.kind === 'unclosedSubscript' ? { unclosedSubscript: true } : {}),
    };
  }
  if (header.next >= inner.length) {
    return {
      kind: 'parameter',
      name: header.name,
      ...(header.subscript ? { subscript: header.subscript } : {}),
      ...(prefix ? { prefix } : {}),
      argument: [],
      text: slice,
      braced: true,
    };
  }
  const operator = ORDERED_PARAMETER_OPERATORS.find((op) => inner.startsWith(op, header.next));
  if (!operator) return { kind: 'parameter', name: '', argument: [], text: slice, braced: true };
  const argSlice = inner.slice(header.next + operator.length);
  const argInDouble = inDouble && !UNQUOTED_ARGUMENT_OPERATORS.has(operator);
  return {
    kind: 'parameter',
    name: header.name,
    ...(header.subscript ? { subscript: header.subscript } : {}),
    ...(prefix ? { prefix } : {}),
    operator,
    argument: scanWordSliceParts(argSlice, argInDouble, false),
    text: slice,
    braced: true,
  };
}

function readParameterPrefix(inner: string): { prefix?: '#' | '!'; pos: number } {
  if (inner[0] === '!') return { prefix: '!', pos: 1 };
  if (inner[0] !== '#') return { pos: 0 };
  const second = inner[1] ?? '';
  const isLengthPrefix = /[A-Za-z_0-9]/.test(second) || (inner.length === 2 && '@*?!$_-'.includes(second));
  return isLengthPrefix ? { prefix: '#', pos: 1 } : { pos: 0 };
}

type ParsedParameterHeader =
  | { kind: 'ok'; name: string; subscript?: { parts: WordPart[]; row: number; text: string }; next: number }
  | { kind: 'unclosedSubscript' };

function readParameterNameAndSubscript(inner: string, pos: number, row = 0): ParsedParameterHeader | undefined {
  const rest = inner.slice(pos);
  const idMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
  if (idMatch) return readNamedParameterHeader(inner, pos, idMatch[0], row);
  const numMatch = /^\d+/.exec(rest);
  if (numMatch) return { kind: 'ok', name: numMatch[0], next: pos + numMatch[0].length };
  if ('@#?*!$_-'.includes(rest[0] ?? '')) return { kind: 'ok', name: rest[0], next: pos + 1 };
  return undefined;
}

function readNamedParameterHeader(inner: string, pos: number, initialName: string, row: number): ParsedParameterHeader {
  let name = initialName;
  const afterName = pos + name.length;
  if (inner[afterName] !== '[') return { kind: 'ok', name, next: afterName };
  const text = createSubscriptSourceText(inner);
  try {
    const closeEnd = skipBalanced(text, afterName, '[', ']');
    const subRaw = inner.slice(afterName + 1, closeEnd - 1);
    let scanEnd = closeEnd;
    if (inner[scanEnd] === '[') name = '';
    while (inner[scanEnd] === '[') scanEnd = skipBalanced(text, scanEnd, '[', ']');
    return {
      kind: 'ok',
      name,
      subscript: { parts: scanWordSliceParts(subRaw, false, false), row, text: subRaw },
      next: closeEnd,
    };
  } catch {
    return { kind: 'unclosedSubscript' };
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
  if (c !== '"' && c !== '`') return pos;
  let end = pos + 1;
  for (; end < body.length && body[end] !== c; end++) if (body[end] === '\\') end++;
  return end;
}
