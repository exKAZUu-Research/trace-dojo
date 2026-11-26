// code-gauge-allow-file fileNcss -- Single source-aware Bash validator and span analyzer over mutual-recursion shell grammar rules.
/**
 * Clean-room pre-execution Bash syntax validator and source-span analyzer from POSIX.1-2017 XCU §2.3/§2.10 and
 * GNU Bash Reference Manual §3.2–3.4. Owns syntax diagnostics, contextual literal-quote offsets, deferred backquote
 * diagnostics, and deferred balanced arithmetic/subscript spans in one pass for tree-sitter CST conversion.
 */
import type { Node, Parser } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { skipSubscript } from './arithmetic';
import type { BackquoteSyntaxError } from './ast';
import { parseConditional, trailingLineToken } from './conditionalSyntax';
import { formatSyntaxToken, syntaxErrorMessage } from './syntaxErrors';
import {
  arithmeticClose,
  arithmeticEnd,
  type BashSyntaxError,
  type DeferredRegion,
  skipBalanced,
  skipBlanks,
  skipWordPiece,
  SourceText,
  SyntaxFailure,
  UnknownSyntax,
} from './syntaxWords';
import { isIdentifier } from './variables';

export interface DeferredExpansion {
  readonly slice: string;
  readonly inDouble: boolean;
}

export interface AnalyzedBashSource {
  readonly originalSource: string;
  readonly grammarSource: string;
  readonly deferredArithmetic: ReadonlyMap<number, string>;
  readonly deferredExpansions: ReadonlyMap<number, DeferredExpansion>;
  readonly backquoteErrors: ReadonlyMap<number, BackquoteSyntaxError>;
  readonly literalQuotes: ReadonlySet<number>;
  readonly declarationFunctionStarts: ReadonlySet<number>;
}

/** Validates `source` and builds the single source-aware span and deferred-error map for `Converter`. */
export function analyzeBashSource(parser: Parser, source: string): AnalyzedBashSource {
  const checked = checkBashSyntax(source);
  if (checked.error && checked.error !== 'unknown') {
    throw new CompileError([{ row: checked.error.row, message: syntaxErrorMessage(checked.error.text) }]);
  }
  const backquotes = analyzeBackquotes(source, checked.backquotes);
  const literalQuotes = new Set([...checked.literalSingleQuotes, ...backquotes.literalSingleQuotes]);
  const declarationFunctionStarts = new Set([
    ...checked.declarationFunctionStarts,
    ...backquotes.declarationFunctionStarts,
  ]);
  const normalized = applySourceNormalizations(backquotes.source, literalQuotes, declarationFunctionStarts);
  const regions = sortDeferredRegions([...checked.arithmeticRegions, ...backquotes.arithmeticRegions]);
  const { grammarSource, deferredArithmetic, deferredExpansions } = resolveDeferredArithmeticRegions(
    parser,
    normalized,
    source,
    regions
  );
  return {
    originalSource: source,
    grammarSource,
    deferredArithmetic,
    deferredExpansions,
    backquoteErrors: backquotes.errors,
    literalQuotes,
    declarationFunctionStarts,
  };
}

export function checkBashSyntax(source: string): {
  error: BashSyntaxError | 'unknown' | undefined;
  backquotes: { start: number; end: number }[];
  literalSingleQuotes: number[];
  declarationFunctionStarts: number[];
  arithmeticRegions: DeferredRegion[];
} {
  const text = createValidatorSourceText(source);
  return {
    error: detectSyntaxError(text),
    backquotes: text.backquotes,
    literalSingleQuotes: text.literalSingleQuotes,
    declarationFunctionStarts: text.declarationFunctionStarts,
    arithmeticRegions: text.arithmeticRegions,
  };
}

/** Inspects an unescaped backquoted body at `row` for runtime syntax errors. */
export function inspectUnescapedBackquoteBody(body: string, row: number): BackquoteSyntaxError | undefined {
  const text = `${'\n'.repeat(row)}${body}\n`;
  const { error } = checkBashSyntax(text);
  if (!error || error === 'unknown') return undefined;
  const messages = error.near === undefined ? [error.text] : [error.text, `syntax error near \`${error.near}'`];
  const shows = (messages.at(-1) as string).startsWith('syntax error near');
  return { row: error.row, messages, ...(shows ? { line: text.split('\n')[error.row] } : {}) };
}

function analyzeBackquotes(
  source: string,
  backquotes: readonly { start: number; end: number }[]
): {
  source: string;
  errors: Map<number, BackquoteSyntaxError>;
  literalSingleQuotes: number[];
  declarationFunctionStarts: number[];
  arithmeticRegions: DeferredRegion[];
} {
  const errors = new Map<number, BackquoteSyntaxError>();
  const literalSingleQuotes: number[] = [];
  const declarationFunctionStarts: number[] = [];
  const arithmeticRegions: DeferredRegion[] = [];
  let normalized = source;
  for (const { start, end } of backquotes) {
    const inspected = inspectBackquoteSpan(source, start, end);
    if (inspected.error) {
      errors.set(start, inspected.error);
      const body = source.slice(start + 1, end - 1).replaceAll(/[^\n]/g, ' ');
      normalized = `${normalized.slice(0, start + 1)}${body}${normalized.slice(end - 1)}`;
    } else {
      literalSingleQuotes.push(...inspected.quoteOffsets);
      declarationFunctionStarts.push(...inspected.fnStarts);
      arithmeticRegions.push(...inspected.arithmeticRegions);
    }
  }
  return { source: normalized, errors, literalSingleQuotes, declarationFunctionStarts, arithmeticRegions };
}

function inspectBackquoteSpan(
  source: string,
  start: number,
  end: number
): {
  error?: BackquoteSyntaxError;
  quoteOffsets: number[];
  fnStarts: number[];
  arithmeticRegions: DeferredRegion[];
} {
  let body = '';
  const bodyOffsets: number[] = [];
  for (let i = start + 1; i < end - 1; i++) {
    if (source[i] === '\\' && i + 1 < end - 1 && '$`\\'.includes(source[i + 1])) i++;
    bodyOffsets.push(i);
    body += source[i];
  }
  bodyOffsets.push(end - 1);
  const row = source.slice(0, start).split('\n').length - 1;
  const pad = '\n'.repeat(row);
  const padded = `${pad}${body}\n`;
  const checked = checkBashSyntax(padded);
  if (checked.error && checked.error !== 'unknown') {
    return { error: inspectUnescapedBackquoteBody(body, row), quoteOffsets: [], fnStarts: [], arithmeticRegions: [] };
  }
  const nested = analyzeBackquotes(padded, checked.backquotes);
  const mapOffset = (idx: number): number | undefined => {
    const rel = idx - pad.length;
    return rel >= 0 && rel < bodyOffsets.length ? bodyOffsets[rel] : undefined;
  };
  const mapOffsets = (a: readonly number[], b: readonly number[]): number[] =>
    [...a, ...b].map(mapOffset).filter((v): v is number => v !== undefined);
  const quoteOffsets = mapOffsets(checked.literalSingleQuotes, nested.literalSingleQuotes);
  const fnStarts = mapOffsets(checked.declarationFunctionStarts, nested.declarationFunctionStarts);
  const arithmeticRegions = [...checked.arithmeticRegions, ...nested.arithmeticRegions]
    .map((r) => mapDeferredRegion(r, mapOffset))
    .filter((r): r is DeferredRegion => r !== undefined);
  return { quoteOffsets, fnStarts, arithmeticRegions };
}

function mapDeferredRegion(
  region: DeferredRegion,
  mapOffset: (idx: number) => number | undefined
): DeferredRegion | undefined {
  const openStart = mapOffset(region.openStart);
  const start = mapOffset(region.start);
  const end = mapOffset(region.end);
  const closeEnd = mapOffset(region.closeEnd);
  if (openStart === undefined || start === undefined || end === undefined || closeEnd === undefined) return undefined;
  return {
    opener: region.opener,
    openStart,
    start,
    end,
    closeEnd,
    keepsSemicolons: region.keepsSemicolons,
    ...(region.inDouble ? { inDouble: true } : {}),
  };
}

function sortDeferredRegions(regions: readonly DeferredRegion[]): DeferredRegion[] {
  return regions.toSorted((a, b) => {
    const aIsBrace = a.opener === '${' ? 1 : 0;
    const bIsBrace = b.opener === '${' ? 1 : 0;
    if (aIsBrace !== bIsBrace) return aIsBrace - bIsBrace;
    if (aIsBrace === 1) {
      const spanDiff = a.closeEnd - a.openStart - (b.closeEnd - b.openStart);
      if (spanDiff !== 0) return spanDiff;
    }
    return a.openStart - b.openStart;
  });
}

function applySourceNormalizations(
  source: string,
  quoteOffsets: ReadonlySet<number>,
  fnStarts: ReadonlySet<number>
): string {
  if (quoteOffsets.size === 0 && fnStarts.size === 0) return source;
  let out = '';
  for (let i = 0; i < source.length; i++) {
    out += quoteOffsets.has(i) ? '\u001F' : fnStarts.has(i) ? '_' : source[i];
  }
  return out;
}

function resolveDeferredArithmeticRegions(
  parser: Parser,
  source: string,
  originalSource: string,
  regions: readonly DeferredRegion[]
): {
  grammarSource: string;
  deferredArithmetic: Map<number, string>;
  deferredExpansions: Map<number, DeferredExpansion>;
} {
  const deferredArithmetic = new Map<number, string>();
  const deferredExpansions = new Map<number, DeferredExpansion>();
  if (regions.length === 0) return { grammarSource: source, deferredArithmetic, deferredExpansions };
  let text = source;
  for (;;) {
    const tree = parser.parse(text);
    if (!tree) throw new Error('The parser returned no tree');
    try {
      const failing = findFirstFailingRegion(tree.rootNode, regions, deferredArithmetic, deferredExpansions);
      if (!failing) break;
      text = maskFailingRegion(text, source, originalSource, failing, deferredArithmetic, deferredExpansions);
    } finally {
      tree.delete();
    }
  }
  return { grammarSource: text, deferredArithmetic, deferredExpansions };
}

function maskFailingRegion(
  text: string,
  source: string,
  originalSource: string,
  failing: DeferredRegion,
  deferredArithmetic: Map<number, string>,
  deferredExpansions: Map<number, DeferredExpansion>
): string {
  if (failing.opener === '${') {
    if (deferredExpansions.has(failing.openStart)) {
      throw new Error(`Deferred expansion region at ${failing.openStart} was selected twice`);
    }
    deferredExpansions.set(failing.openStart, {
      slice: originalSource.slice(failing.openStart, failing.closeEnd),
      inDouble: Boolean(failing.inDouble),
    });
    const masked = text.slice(failing.start, failing.end).replaceAll(/[^\n]/g, '_');
    return text.slice(0, failing.start) + masked + text.slice(failing.end);
  }
  if (deferredArithmetic.has(failing.start)) {
    throw new Error(`Deferred arithmetic region at ${failing.start} was selected twice`);
  }
  const original = source.slice(failing.start, failing.end);
  deferredArithmetic.set(failing.start, original);
  const blank = blankDeferredSlice(original, failing.keepsSemicolons);
  return text.slice(0, failing.start) + blank + text.slice(failing.end);
}

function findFirstFailingRegion(
  root: Node,
  regions: readonly DeferredRegion[],
  deferredArithmetic: ReadonlyMap<number, string>,
  deferredExpansions: ReadonlyMap<number, DeferredExpansion>
): DeferredRegion | undefined {
  const errors = root.hasError ? nonBenignCstErrors(root) : [];
  for (const region of regions) {
    const alreadyDeferred =
      region.opener === '${' ? deferredExpansions.has(region.openStart) : deferredArithmetic.has(region.start);
    if (alreadyDeferred || region.end === region.start) continue;
    const misparsedSubshell =
      region.opener === '((' && root.descendantForIndex(region.openStart, region.openStart + 2)?.type !== '((';
    const fails =
      misparsedSubshell || errors.some((err) => err.startIndex <= region.closeEnd && err.endIndex >= region.openStart);
    if (fails) return region;
  }
  return undefined;
}

function nonBenignCstErrors(root: Node): Node[] {
  return collectCstErrorNodes(root).filter((node) => !isBenignEmptySubscript(node));
}

function collectCstErrorNodes(root: Node): Node[] {
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

function isBenignEmptySubscript(node: Node): boolean {
  return node.type === 'raw_string' && node.startIndex === node.endIndex && node.parent?.type === 'subscript';
}

function blankDeferredSlice(slice: string, keepsSemicolons: boolean): string {
  if (!keepsSemicolons) return slice.replaceAll(/[^\n]/g, ' ');
  const semis = new Set(findForHeaderSemicolons(slice));
  let out = '';
  for (let i = 0; i < slice.length; i++) out += slice[i] === '\n' || semis.has(i) ? slice[i] : ' ';
  return out;
}

export function createValidatorSourceText(source: string): SourceText {
  const text = new SourceText(source);
  text.parseSubstitution = (start) => new ShellGrammarValidator(text, start, true).validateSubstitution();
  text.parseBraceSubstitution = (start) =>
    new ShellGrammarValidator(text, start, true, true).validateBraceSubstitution();
  return text;
}

export function findForHeaderSemicolons(source: string, start = 0, end = source.length): number[] {
  const text = createValidatorSourceText(source);
  try {
    return forHeaderSemicolons(text, start, end);
  } catch {
    return [];
  }
}

function detectSyntaxError(text: SourceText): BashSyntaxError | 'unknown' | undefined {
  try {
    new ShellGrammarValidator(text, 0, false).validateScript();
    return undefined;
  } catch (error) {
    if (error instanceof SyntaxFailure) return { row: error.row, text: error.text, near: error.near };
    if (error instanceof UnknownSyntax || error instanceof RangeError) return 'unknown';
    throw error;
  }
}

type ShellTokenKind = 'word' | 'ioNumber' | 'operator' | 'newline' | 'eof';

interface ShellToken {
  kind: ShellTokenKind;
  value: string;
  row: number;
  start: number;
  end: number;
  quoted: boolean;
}

const SHELL_OPERATORS = [
  ';;&',
  ';;',
  ';&',
  '&&',
  '&>>',
  '&>',
  '||',
  '|&',
  '<<<',
  '<<-',
  '<<',
  '<&',
  '<>',
  '>>',
  '>&',
  '>|',
  '((',
  ';',
  '&',
  '|',
  '<',
  '>',
  '(',
  ')',
];
const REDIRECTION_OPERATORS = new Set(['<', '>', '>>', '<>', '>|', '&>', '&>>', '<&', '>&', '<<<', '<<', '<<-']);
const WORD_BREAK_CHARS = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);
const DECLARATION_NAMES = new Set(['declare', 'typeset', 'local', 'export', 'readonly']);

/** Whether `token` is `{name}` written right before a redirection operator, as in `{fd}>file`. */
function isDescriptorVariableWord(token: ShellToken, source: string): boolean {
  return (
    token.kind === 'word' &&
    !token.quoted &&
    /^\{[A-Za-z_]\w*(?:\[[^\]]*\])?\}$/.test(token.value) &&
    (source[token.end] === '<' || source[token.end] === '>')
  );
}

function isAssignmentWord(word: string): boolean {
  const open = word.indexOf('[');
  const eq = word.indexOf('=');
  if (eq <= 0) return false;
  if (open === -1 || open > eq) {
    return isIdentifier(word.slice(0, word[eq - 1] === '+' ? eq - 1 : eq));
  }
  if (!isIdentifier(word.slice(0, open))) return false;
  const close = skipSubscript(word, open);
  return close < word.length && (word.startsWith('=', close + 1) || word.startsWith('+=', close + 1));
}

function isCompoundAssignmentPrefix(prefix: string): boolean {
  if (!prefix.endsWith('=')) return false;
  const lhs = prefix.slice(0, prefix.endsWith('+=') ? -2 : -1);
  if (isIdentifier(lhs)) return true;
  const open = lhs.indexOf('[');
  return open > 0 && isIdentifier(lhs.slice(0, open)) && skipSubscript(lhs, open) === lhs.length - 1;
}

type WordContext = 'command' | 'declaration' | 'argument';

/** Whether a compound command starts at `index`, past blanks, which makes the word before it a coprocess's name. */
function startsCompoundCommand(source: string, index: number): boolean {
  return /^[ \t]*(?:[{(]|\[\[|(?:if|while|until|for|case|select)(?![^\s;&|<>()]))/.test(
    source.slice(index, index + 16)
  );
}

/** What a simple command's words set `extglob` to, as `shopt -s extglob` or `shopt -u extglob` does. */
function extglobSetBy(words: readonly string[]): boolean | undefined {
  const [name, option, ...operands] = words;
  if (name !== 'shopt' || (option !== '-s' && option !== '-u') || !operands.includes('extglob')) return undefined;
  return option === '-s';
}

/** Whether the text before `index`, past blanks, ends a command, so that a word at `index` starts one. */
function endsCommand(source: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && (source[i] === ' ' || source[i] === '\t')) i--;
  return i >= 0 && ';&|\n'.includes(source[i]);
}

class ShellTokenStream {
  /**
   * Whether `shopt -s extglob` ran before the line being read, which makes `@(...)` and the other extended patterns
   * part of a word, as Bash reads each line of a script after running the ones before it.
   */
  extglob = false;
  private pendingHeredocSpec: { stripLeadingTabs: boolean } | undefined;
  private readonly queuedHeredocs: { endMarker: string; stripLeadingTabs: boolean }[] = [];

  constructor(
    private readonly text: SourceText,
    public position: number,
    /** Whether a `}` that starts a command ends the list, even with a word right after it, as in `"${ f; }"`. */
    private readonly closesBrace = false
  ) {}

  readNext(context: WordContext): ShellToken {
    const { source } = this.text;
    this.position = skipBlanks(source, this.position);
    const start = this.position;
    const row = this.text.rowAt(start);
    if (start >= source.length) return this.makeToken('eof', '', row, start, false);
    const ch = source[start];
    if (this.closesBrace && ch === '}' && endsCommand(source, start)) {
      this.position++;
      return this.makeToken('word', '}', row, start, false);
    }
    if (ch === '\n') {
      this.position++;
      this.consumeQueuedHeredocs();
      return this.makeToken('newline', '\n', row, start, false);
    }
    if ((ch === '<' || ch === '>') && source[start + 1] === '(') return this.scanWord(context);
    const op = SHELL_OPERATORS.find((candidate) => source.startsWith(candidate, start));
    if (op) {
      if (op === '<<' || op === '<<-') this.pendingHeredocSpec = { stripLeadingTabs: op === '<<-' };
      this.position += op.length;
      return this.makeToken('operator', op, row, start, false);
    }
    const word = this.scanWord(context);
    if (this.pendingHeredocSpec) {
      this.queuedHeredocs.push({
        endMarker: word.value.replaceAll(/\\(.)|["']/g, '$1'),
        stripLeadingTabs: this.pendingHeredocSpec.stripLeadingTabs,
      });
      this.pendingHeredocSpec = undefined;
    }
    return word;
  }

  private consumeQueuedHeredocs(): void {
    for (const { endMarker, stripLeadingTabs } of this.queuedHeredocs.splice(0)) {
      let line: string | undefined;
      do line = this.consumeRawLine();
      while (line !== undefined && (stripLeadingTabs ? line.replace(/^\t+/, '') : line) !== endMarker);
    }
  }

  private consumeRawLine(): string | undefined {
    const { source } = this.text;
    if (this.position >= source.length) return undefined;
    const nl = source.indexOf('\n', this.position);
    const end = nl === -1 ? source.length : nl;
    const content = source.slice(this.position, end);
    this.position = nl === -1 ? end : end + 1;
    return content;
  }

  private scanWord(context: WordContext): ShellToken {
    const { source } = this.text;
    const start = this.position;
    const unclosedBrackets: number[] = [];
    let quoted = false;
    while (this.position < source.length) {
      const ch = source[this.position];
      if (this.tryScanSpecialWordSegment(start, context, ch, unclosedBrackets)) continue;
      if (this.extglob && '?*+@!'.includes(ch) && source[this.position + 1] === '(') {
        this.position = skipBalanced(this.text, this.position + 1, '(', ')');
        continue;
      }
      if (WORD_BREAK_CHARS.has(ch)) break;
      if (`'"\\\`$`.includes(ch)) quoted ||= ch !== '$';
      this.position = skipWordPiece(this.text, this.position);
    }
    for (const bracket of unclosedBrackets) this.text.literalSingleQuotes.push(bracket);
    const value = source.slice(start, this.position);
    const nextChar = source[this.position];
    const kind: ShellTokenKind = /^\d+$/.test(value) && (nextChar === '<' || nextChar === '>') ? 'ioNumber' : 'word';
    return this.makeToken(kind, value, this.text.rowAt(start), start, quoted);
  }

  // code-gauge-allow functionCognitiveComplexity -- Handles process substitutions, command subscripts, compound array bodies, line continuations, and declaration brackets.
  private tryScanSpecialWordSegment(
    start: number,
    context: WordContext,
    ch: string,
    unclosedBrackets: number[]
  ): boolean {
    const { source } = this.text;
    if ((ch === '<' || ch === '>') && source[this.position + 1] === '(') {
      this.position = this.text.parseSubstitution(this.position + 2);
      return true;
    }
    if (ch === '[' && context === 'command' && isIdentifier(source.slice(start, this.position))) {
      const close = skipSubscript(source, this.position);
      if (close < source.length) {
        const hasEquals = source.startsWith('=', close + 1) || source.startsWith('+=', close + 1);
        this.consumeSubscriptInWord(close, !hasEquals);
        return true;
      }
    }
    if (ch === '(' && context !== 'argument' && isCompoundAssignmentPrefix(source.slice(start, this.position))) {
      this.position = this.scanCompoundArrayBody(this.position);
      return true;
    }
    if (ch === '\\' && source[this.position + 1] === '\n') {
      this.position += 2;
      return true;
    }
    if (context === 'declaration' && (ch === '[' || ch === ']')) {
      if (ch === '[') unclosedBrackets.push(this.position);
      else unclosedBrackets.pop();
      this.position++;
      return true;
    }
    return false;
  }

  private consumeSubscriptInWord(close: number, maskBreaks: boolean): void {
    if (!maskBreaks) {
      this.position = skipBalanced(this.text, this.position, '[', ']');
      return;
    }
    const { source } = this.text;
    let i = this.position + 1;
    while (i < close) {
      const c = source[i];
      if (WORD_BREAK_CHARS.has(c)) {
        if (c !== '\n') this.text.literalSingleQuotes.push(i);
        i++;
      } else {
        i = skipWordPiece(this.text, i);
      }
    }
    this.position = close + 1;
  }

  private scanCompoundArrayBody(openIndex: number): number {
    const { source } = this.text;
    this.position = openIndex + 1;
    for (;;) {
      this.position = skipBlanks(source, this.position);
      if (source[this.position] === '[') {
        this.consumeBracketedCompoundElement();
        continue;
      }
      const inner = this.readNext('argument');
      if (inner.kind === 'eof') this.text.unclosed(openIndex, ')');
      if (inner.kind === 'operator' && inner.value === ')') return this.position;
      if (inner.kind === 'operator') {
        const shown = inner.value === '((' ? '(' : formatSyntaxToken(inner.value);
        this.text.fail(inner.row, `syntax error near unexpected token \`${shown}'`);
      }
    }
  }

  private consumeBracketedCompoundElement(): void {
    const { source } = this.text;
    const openStart = this.position;
    const closeEnd = skipBalanced(this.text, openStart, '[', ']');
    if (source.startsWith('+=', closeEnd) || source.startsWith('=', closeEnd)) {
      this.text.arithmeticRegions.push({
        opener: '[',
        openStart,
        start: openStart + 1,
        end: closeEnd - 1,
        closeEnd,
        keepsSemicolons: false,
      });
    }
    if (source.startsWith('+=', closeEnd)) this.position = closeEnd + 2;
    else if (source.startsWith('=', closeEnd)) this.position = closeEnd + 1;
    else this.position = closeEnd;
    if (this.position < source.length && !WORD_BREAK_CHARS.has(source[this.position])) {
      this.scanWord('argument');
    }
  }

  private makeToken(kind: ShellTokenKind, value: string, row: number, start: number, quoted: boolean): ShellToken {
    return { kind, value, row, start, end: this.position, quoted };
  }
}

const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'select',
  'while',
  'until',
  'do',
  'done',
  'in',
  'function',
  'time',
  'coproc',
  '{',
  '}',
  '!',
  '[[',
  ']]',
]);

const CONTINUATION_OR_CLOSING_KEYWORDS = new Set(['then', 'else', 'elif', 'fi', 'esac', 'do', 'done', 'in', '}', ']]']);
const CASE_CLAUSE_TERMINATORS = new Set([';;', ';&', ';;&']);

class ShellGrammarValidator {
  private readonly stream: ShellTokenStream;
  private cached: ShellToken | undefined;
  private cachedContext: WordContext = 'argument';
  /** How many compound commands, function bodies, and coprocesses enclose the command being read. */
  private compoundDepth = 0;
  /** What the top-level commands of the line being read set `extglob` to, if any of them sets it. */
  private lineExtglob: boolean | undefined;
  private readonly activeBlocks: { keyword: string; row: number }[] = [];

  constructor(
    private readonly text: SourceText,
    start: number,
    private readonly insideSubstitution: boolean,
    closesBrace = false
  ) {
    this.stream = new ShellTokenStream(text, start, closesBrace);
  }

  validateScript(): void {
    for (;;) {
      this.consumeNewlines();
      const start = this.peek();
      if (start.kind === 'eof') return;
      this.lineExtglob = undefined;
      this.parseList(false);
      const end = this.peek();
      if (end.kind !== 'newline' && end.kind !== 'eof') this.failUnexpected(end);
      if (this.lineExtglob !== undefined) this.stream.extglob = this.lineExtglob;
    }
  }

  validateSubstitution(): number {
    for (;;) {
      this.consumeNewlines();
      if (this.hasOperator(this.peek(), ')')) return this.advance().end;
      this.parseList(false);
    }
  }

  validateBraceSubstitution(): number {
    this.parseCompoundList();
    const end = this.peek();
    if (!this.hasKeyword(end, '}')) this.failUnexpected(end);
    return this.advance().end;
  }

  private parseCompoundList(): void {
    this.parseList(true);
  }

  private parseList(multiline: boolean): void {
    if (multiline) this.consumeNewlines();
    this.parsePipeline();
    for (;;) {
      const next = this.peek();
      if (this.hasOperator(next, '&&') || this.hasOperator(next, '||')) {
        this.advance();
        this.consumeNewlines();
        this.parsePipeline();
        continue;
      }
      const isSeparator =
        this.hasOperator(next, ';') || this.hasOperator(next, '&') || (multiline && next.kind === 'newline');
      if (!isSeparator) return;
      this.advance();
      if (multiline) this.consumeNewlines();
      if (!this.canBeginCommand(this.peek())) return;
      this.parsePipeline();
    }
  }

  private parsePipeline(): void {
    const first = this.peek();
    if (this.hasKeyword(first, '!')) {
      this.advance();
      this.text.nested(() => this.parsePipeline());
      return;
    }
    if (this.hasKeyword(first, 'time')) {
      this.advance();
      if (this.peek().kind === 'word' && this.peek().value === '-p') this.advance();
      const after = this.peek();
      const emptyTimed =
        after.kind === 'newline' ||
        after.kind === 'eof' ||
        this.hasOperator(after, ';') ||
        this.hasOperator(after, '&');
      if (!emptyTimed) this.parsePipeline();
      return;
    }
    this.parseCommand();
    while (this.hasOperator(this.peek(), '|') || this.hasOperator(this.peek(), '|&')) {
      this.advance();
      this.consumeNewlines();
      this.parseCommand();
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Dispatches function definitions, coprocesses, compound constructs, and simple commands.
  private parseCommand(): void {
    this.text.nested(() => {
      const lead = this.peek();
      if (lead.kind === 'word' && this.isKeywordToken(lead)) {
        if (CONTINUATION_OR_CLOSING_KEYWORDS.has(lead.value)) this.failUnexpected(lead);
        if (lead.value === 'function') {
          this.parseFunctionKeywordForm();
          return;
        }
        if (lead.value === 'coproc') {
          this.advance();
          const name = this.peek();
          if (name.kind === 'word' && !this.isKeywordToken(name) && startsCompoundCommand(this.text.source, name.end)) {
            this.advance();
          }
          this.withinCompound(() => this.parseCommand());
          return;
        }
        this.parseCompoundWithRedirections();
        return;
      }
      if (this.hasOperator(lead, '(') || this.hasOperator(lead, '((')) {
        this.parseCompoundWithRedirections();
        return;
      }
      if (lead.kind === 'word' || lead.kind === 'ioNumber' || this.isRedirectionOperator(lead)) {
        this.parseSimpleOrFunctionDef();
        return;
      }
      this.failUnexpected(lead);
    });
  }

  private withinCompound(parse: () => void): void {
    this.compoundDepth++;
    try {
      parse();
    } finally {
      this.compoundDepth--;
    }
  }

  private parseCompoundWithRedirections(): void {
    let requiresSeparator = false;
    this.withinCompound(() => {
      requiresSeparator = this.parseCompoundConstruct();
    });
    this.parseTrailingRedirections();
    const next = this.peek();
    const closesEnclosing =
      next.kind === 'word' &&
      this.isKeywordToken(next) &&
      CONTINUATION_OR_CLOSING_KEYWORDS.has(next.value) &&
      next.value !== 'in' &&
      next.value !== ']]';
    if (requiresSeparator && next.kind === 'word' && !closesEnclosing) this.failUnexpected(next);
  }

  // code-gauge-allow functionNcss -- Dispatches each compound shell construct in the grammar.
  private parseCompoundConstruct(): boolean {
    if (this.hasOperator(this.peek(), '((') && this.tryParseArithmeticConstruct()) return true;
    const lead = this.peek();
    if (this.hasOperator(lead, '(')) {
      this.parseDelimitedCompound(lead, ')');
      return false;
    }
    if (lead.kind !== 'word' || !this.isKeywordToken(lead)) this.failUnexpected(lead);
    switch (lead.value) {
      case 'if': {
        this.parseIfConstruct(lead);
        return false;
      }
      case 'while':
      case 'until': {
        this.parseLoopConstruct(lead);
        return false;
      }
      case 'for':
      case 'select': {
        this.parseForOrSelectConstruct(lead);
        return false;
      }
      case 'case': {
        this.parseCaseConstruct(lead);
        return false;
      }
      case '{': {
        this.parseDelimitedCompound(lead, '}');
        return false;
      }
      case '[[': {
        this.parseConditionalConstruct(lead);
        return true;
      }
      default: {
        this.failUnexpected(lead);
      }
    }
  }

  private tryParseArithmeticConstruct(): boolean {
    const open = this.peek();
    const closeEnd = arithmeticEnd(this.text, open.start);
    if (closeEnd !== undefined) {
      this.text.arithmeticRegions.push({
        opener: '((',
        openStart: open.start,
        start: open.start + 2,
        end: closeEnd - 2,
        closeEnd,
        keepsSemicolons: false,
      });
      this.seekTo(closeEnd);
      return true;
    }
    this.seekTo(open.start + 1);
    this.cached = { ...open, value: '(', end: open.start + 1 };
    return false;
  }

  private parseLoopConstruct(open: ShellToken): void {
    this.withBlock(open, () => {
      this.advance();
      this.parseCompoundList();
      this.requireKeyword('do');
      this.parseCompoundList();
      this.requireKeyword('done');
    });
  }

  private parseIfConstruct(open: ShellToken): void {
    this.withBlock(open, () => {
      this.advance();
      this.parseCompoundList();
      this.requireKeyword('then');
      this.parseCompoundList();
      while (this.hasKeyword(this.peek(), 'elif')) {
        this.advance();
        this.parseCompoundList();
        this.requireKeyword('then');
        this.parseCompoundList();
      }
      if (this.hasKeyword(this.peek(), 'else')) {
        this.advance();
        this.parseCompoundList();
      }
      this.requireKeyword('fi');
    });
  }

  private parseForOrSelectConstruct(open: ShellToken): void {
    this.withBlock(open, () => {
      this.advance();
      const target = this.peek();
      let allowsBraceBody = true;
      if (this.hasOperator(target, '((') && open.value === 'for') {
        this.parseCStyleForHeader(open, target);
      } else {
        allowsBraceBody = this.parseWordListForHeader(target);
      }
      this.parseLoopBodyGroup(allowsBraceBody);
    });
  }

  private parseWordListForHeader(variable: ShellToken): boolean {
    if (variable.kind !== 'word') this.failUnexpected(variable);
    if (!isIdentifier(variable.value)) this.maskWordToken(variable);
    this.advance();
    const hadNewline = this.consumeNewlines();
    const afterName = this.peek();
    if (afterName.kind === 'word' && afterName.value === 'in' && !afterName.quoted) {
      this.advance();
      while (this.peek().kind === 'word' || this.peek().kind === 'ioNumber') this.advance();
      const term = this.peek();
      if (!this.hasOperator(term, ';') && term.kind !== 'newline') this.failUnexpected(term);
    } else if (!this.hasOperator(afterName, ';')) {
      return hadNewline;
    }
    this.advance();
    this.consumeNewlines();
    return true;
  }

  private parseCStyleForHeader(forKeyword: ShellToken, openParens: ShellToken): void {
    const close = arithmeticClose(this.text, openParens.start);
    if (!close.doubleClosed) this.failSingleClosedForHeader(close.index);
    const closeEnd = close.index + 2;
    const sections = forHeaderSemicolons(this.text, openParens.start + 2, closeEnd - 2).length + 1;
    if (sections < 3) this.text.fail(forKeyword.row, 'syntax error: arithmetic expression required');
    if (sections > 3) this.text.fail(forKeyword.row, "syntax error: `;' unexpected");
    this.text.arithmeticRegions.push({
      opener: '((',
      openStart: openParens.start,
      start: openParens.start + 2,
      end: closeEnd - 2,
      closeEnd,
      keepsSemicolons: true,
    });
    this.seekTo(closeEnd);
    if (this.hasOperator(this.peek(), ';')) this.advance();
    this.consumeNewlines();
  }

  private failSingleClosedForHeader(singleCloseIndex: number): never {
    const { source } = this.text;
    const after = singleCloseIndex + 1;
    const next = source[after];
    let near: string;
    if (next === ';' || next === '&' || next === '|') {
      near = next;
    } else if (next !== undefined && !' \t\n\r'.includes(next)) {
      let end = after;
      while (end < source.length && !' \t\n;|&'.includes(source[end])) end++;
      near = trailingLineToken(source, end) ?? '(';
    } else {
      near = trailingLineToken(source, after) ?? '(';
    }
    this.text.fail(this.text.rowAt(singleCloseIndex), `syntax error near \`${near}'`);
  }

  private parseLoopBodyGroup(allowsBraceBody: boolean): void {
    const open = this.peek();
    if (allowsBraceBody && this.hasKeyword(open, '{')) {
      this.parseDelimitedCompound(open, '}');
      return;
    }
    this.requireKeyword('do');
    this.parseCompoundList();
    this.requireKeyword('done');
  }

  private parseCaseConstruct(open: ShellToken): void {
    this.withBlock(open, () => {
      this.advance();
      const subject = this.peek();
      if (subject.kind !== 'word' && subject.kind !== 'ioNumber') this.failUnexpected(subject);
      this.advance();
      this.consumeNewlines();
      const inKeyword = this.peek();
      if (inKeyword.kind !== 'word' || inKeyword.value !== 'in' || inKeyword.quoted) this.failUnexpected(inKeyword);
      this.advance();
      for (;;) {
        this.consumeNewlines();
        if (this.hasKeyword(this.peek(), 'esac')) {
          this.advance();
          return;
        }
        this.parseCaseBranch();
      }
    });
  }

  private parseCaseBranch(): void {
    if (this.hasOperator(this.peek(), '(')) this.advance();
    this.parseCasePattern();
    while (this.hasOperator(this.peek(), '|')) {
      this.advance();
      this.parseCasePattern();
    }
    if (!this.hasOperator(this.peek(), ')')) this.failUnexpected(this.peek());
    this.advance();
    this.consumeNewlines();
    if (!this.isCaseTerminator(this.peek()) && !this.hasKeyword(this.peek(), 'esac')) {
      this.parseCompoundList();
      const afterBody = this.peek();
      if (!this.isCaseTerminator(afterBody) && !this.hasKeyword(afterBody, 'esac')) this.failUnexpected(afterBody);
    }
    if (this.isCaseTerminator(this.peek())) this.advance();
  }

  private isCaseTerminator(token: ShellToken): boolean {
    return token.kind === 'operator' && CASE_CLAUSE_TERMINATORS.has(token.value);
  }

  private parseCasePattern(): void {
    const pat = this.peek();
    if (pat.kind !== 'word' && pat.kind !== 'ioNumber') this.failUnexpected(pat);
    this.advance();
  }

  private parseDelimitedCompound(open: ShellToken, closeSymbol: string): void {
    this.withBlock(open, () => {
      this.advance();
      this.parseCompoundList();
      const end = this.peek();
      const matched = closeSymbol === ')' ? this.hasOperator(end, ')') : this.hasKeyword(end, closeSymbol);
      if (!matched) this.failUnexpected(end);
      this.advance();
    });
  }

  private parseConditionalConstruct(open: ShellToken): void {
    this.withBlock(open, () => {
      const outcome = parseConditional(this.text, open.end);
      if ('error' in outcome) throw new SyntaxFailure(outcome.error.row, outcome.error.text, outcome.error.near);
      this.seekTo(outcome.end);
    });
  }

  private parseFunctionKeywordForm(): void {
    this.advance();
    const fnName = this.peek();
    if (fnName.kind !== 'word' || this.isKeywordToken(fnName)) this.failUnexpected(fnName);
    if (DECLARATION_NAMES.has(fnName.value) || !isIdentifier(fnName.value)) {
      this.maskWordToken(fnName);
    }
    this.advance();
    if (this.hasOperator(this.peek(), '(')) {
      this.advance();
      if (!this.hasOperator(this.peek(), ')')) this.failUnexpected(this.peek());
      this.advance();
    }
    this.parseFunctionBody();
  }

  private parseFunctionBody(): void {
    this.consumeNewlines();
    const bodyLead = this.peek();
    const validCompound =
      this.hasOperator(bodyLead, '(') ||
      this.hasOperator(bodyLead, '((') ||
      (bodyLead.kind === 'word' &&
        this.isKeywordToken(bodyLead) &&
        !CONTINUATION_OR_CLOSING_KEYWORDS.has(bodyLead.value) &&
        bodyLead.value !== '!');
    if (!validCompound || bodyLead.value === 'function' || bodyLead.value === 'time' || bodyLead.value === 'coproc') {
      this.failUnexpected(bodyLead);
    }
    this.parseCompoundWithRedirections();
  }

  // code-gauge-allow functionCognitiveComplexity -- Parses simple commands (redirections, prefix assignments, arguments) and `name () body` functions.
  private parseSimpleOrFunctionDef(): void {
    let commandName: string | undefined;
    const words: string[] = [];
    for (let position = 0; ; position++) {
      const context: WordContext =
        commandName === undefined ? 'command' : DECLARATION_NAMES.has(commandName) ? 'declaration' : 'argument';
      const token = this.peek(context);
      if (token.kind === 'ioNumber' || this.isRedirectionOperator(token)) {
        this.parseOneRedirection();
        continue;
      }
      if (token.kind !== 'word') {
        // Bash reads each line after running the lines before it, so only a top-level `shopt` changes later lines.
        if (this.compoundDepth === 0) this.lineExtglob = extglobSetBy(words) ?? this.lineExtglob;
        return;
      }
      this.advance();
      if (commandName === undefined && !isAssignmentWord(token.value)) {
        commandName = token.value;
      }
      if (commandName !== undefined) words.push(token.value);
      if (position === 0 && commandName !== undefined && this.hasOperator(this.peek(), '(')) {
        if (DECLARATION_NAMES.has(token.value) || !isIdentifier(token.value)) {
          this.maskWordToken(token);
        }
        this.advance();
        if (!this.hasOperator(this.peek(), ')')) this.failUnexpected(this.peek());
        this.advance();
        this.parseFunctionBody();
        return;
      }
    }
  }

  private maskWordToken(token: ShellToken): void {
    const { source } = this.text;
    for (let i = token.start; i < token.end; i++) {
      if (source[i] === '\n' || (source[i] === '\\' && source[i + 1] === '\n')) continue;
      this.text.declarationFunctionStarts.push(i);
    }
  }

  private parseTrailingRedirections(): void {
    for (;;) {
      const token = this.peek();
      // `{name}` right before an operator names the descriptor the redirection allocates, as after a simple command.
      if (isDescriptorVariableWord(token, this.text.source)) this.advance();
      else if (token.kind !== 'ioNumber' && !this.isRedirectionOperator(token)) return;
      this.parseOneRedirection();
    }
  }

  private parseOneRedirection(): void {
    if (this.peek().kind === 'ioNumber') this.advance();
    const op = this.peek();
    if (!this.isRedirectionOperator(op)) this.failUnexpected(op);
    this.advance();
    const target = this.peek();
    if (target.kind !== 'word' && target.kind !== 'ioNumber') this.failUnexpected(target);
    this.advance();
  }

  private peek(context: WordContext = 'argument'): ShellToken {
    if (
      this.cached &&
      this.cachedContext === 'argument' &&
      context !== 'argument' &&
      this.needsAssignmentRescan(this.cached)
    ) {
      const { start } = this.cached;
      while ((this.text.backquotes.at(-1)?.start ?? -1) >= start) this.text.backquotes.pop();
      while ((this.text.literalSingleQuotes.at(-1) ?? -1) >= start) this.text.literalSingleQuotes.pop();
      while ((this.text.declarationFunctionStarts.at(-1) ?? -1) >= start) this.text.declarationFunctionStarts.pop();
      while ((this.text.arithmeticRegions.at(-1)?.openStart ?? -1) >= start) this.text.arithmeticRegions.pop();
      this.stream.position = start;
      this.cached = undefined;
    }
    if (!this.cached) {
      this.cached = this.stream.readNext(context);
      this.cachedContext = context;
    }
    return this.cached;
  }

  private needsAssignmentRescan(token: ShellToken): boolean {
    if (token.kind !== 'word') return false;
    if (this.text.source[token.end] === '(' && isCompoundAssignmentPrefix(token.value)) return true;
    return token.value.includes('[');
  }

  private advance(): ShellToken {
    const token = this.cached ?? this.peek();
    this.cached = undefined;
    return token;
  }

  private seekTo(index: number): void {
    this.cached = undefined;
    this.stream.position = index;
  }

  private consumeNewlines(): boolean {
    let consumed = false;
    while (this.peek().kind === 'newline') {
      this.advance();
      consumed = true;
    }
    return consumed;
  }

  private withBlock(open: ShellToken, body: () => void): void {
    this.activeBlocks.push({ keyword: open.value, row: open.row });
    body();
    this.activeBlocks.pop();
  }

  private requireKeyword(expected: string): void {
    const next = this.peek();
    if (!this.hasKeyword(next, expected)) this.failUnexpected(next);
    this.advance();
  }

  private canBeginCommand(token: ShellToken): boolean {
    if (token.kind === 'ioNumber' || this.isRedirectionOperator(token)) return true;
    if (this.hasOperator(token, '(') || this.hasOperator(token, '((')) return true;
    return token.kind === 'word' && !(this.isKeywordToken(token) && CONTINUATION_OR_CLOSING_KEYWORDS.has(token.value));
  }

  private isKeywordToken(token: ShellToken): boolean {
    return !token.quoted && KEYWORDS.has(token.value);
  }

  private hasKeyword(token: ShellToken, expected: string): boolean {
    return token.kind === 'word' && token.value === expected && !token.quoted;
  }

  private hasOperator(token: ShellToken, expected: string): boolean {
    return token.kind === 'operator' && token.value === expected;
  }

  private isRedirectionOperator(token: ShellToken): boolean {
    return token.kind === 'operator' && REDIRECTION_OPERATORS.has(token.value);
  }

  private failUnexpected(token: ShellToken): never {
    if (token.kind === 'eof') this.failAtEof();
    const shown = token.kind === 'newline' ? 'newline' : token.value === '((' ? '(' : formatSyntaxToken(token.value);
    const suffix = this.insideSubstitution && !this.hasOperator(token, ')') ? " while looking for matching `)'" : '';
    this.text.fail(token.row, `syntax error near unexpected token \`${shown}'${suffix}`);
  }

  private failAtEof(): never {
    const row = this.text.eofRow;
    if (this.insideSubstitution) this.text.fail(row, "unexpected EOF while looking for matching `)'");
    const innermost = this.activeBlocks.at(-1);
    if (innermost) {
      this.text.fail(
        row,
        `syntax error: unexpected end of file from \`${innermost.keyword}' command on line ${innermost.row + 1}`
      );
    }
    this.text.fail(row, 'syntax error: unexpected end of file');
  }
}

/** Offsets of top-level `;` separators in `for ((init; condition; update))` outside quotes, expansions, and `(...)`. */
function forHeaderSemicolons(text: SourceText, start: number, end: number): number[] {
  const offsets: number[] = [];
  let parenDepth = 0;
  for (let i = start; i < end;) {
    const ch = text.source[i];
    if (ch === ';' && parenDepth === 0) offsets.push(i);
    else if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    i = ch === '(' || ch === ')' || ch === ';' ? i + 1 : skipWordPiece(text, i);
  }
  return offsets;
}
