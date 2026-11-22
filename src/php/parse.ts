import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import {
  misplacedAtomicMessage,
  type TraceAnnotation,
  traceAnnotationsIn,
  type TraceOptions,
} from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import type { Program } from './ast';
import { castType, type CompileNotice, Converter } from './converter';
import {
  PHP_NUMBER,
  reservedIdentifierToken,
  traitAdaptationModifierError,
  unexpectedTextToken,
} from './converterBase';

const parser = await loadParser('@willbooster/tree-sitter-php/tree-sitter-php.wasm');

const MISSING_TOKEN_NAMES: Record<string, string> = {
  name: '名前',
  variable_name: '変数の名前',
  _automatic_semicolon: ';',
  heredoc_end: 'ヒアドキュメントの終わりの印',
};

const newClassKeywordOperators = new Set(['instanceof', 'and', 'or', 'xor']);
const OPEN_DELIMITERS = new Set(['(', '[', '{']);
const CLOSING_DELIMITERS = new Map([
  [')', '('],
  [']', '['],
  ['}', '{'],
]);

const PHP_TRIVIA = /^(?:[ \t\r\n\v\f]|\/\*[\s\S]*?\*\/|(?:\/\/|#(?!\[))(?:[^?\r\n]|\?(?!>))*)*/;
const PHP_PUNCTUATOR =
  /^(?:\?->|\?\?=|===|!==|<=>|\.\.\.|<<=|>>=|\*\*=|->|::|=>|\?\?|==|!=|<>|<=|>=|<<|>>|\*\*|\+\+|--|\|\||&&|\|>|[+\-*/%.&|^]=|#\[|[)\][{},;=<>+\-*/%.&|^!?~:@\u0060])/;

export interface ParsedProgram {
  program: Program;
  notices: CompileNotice[];
  parseNotices: CompileNotice[];
  conversionError?: CompileError;
}

/**
 * Parses a program, throwing a `CompileError` for the errors PHP reports before running and for unsupported syntax.
 *
 * @param trace Marks the functions whose headers hold `// atomic` (or `# atomic`), for a model program.
 */
export function parsePhp(source: string, trace?: TraceOptions): ParsedProgram {
  const atomicRows = new Set(trace?.atomicAnnotations.keys());
  const ignoredPrefix = shebangEnd(source);
  const text = hideShebang(source, ignoredPrefix);
  return parseSource(parser, text, MISSING_TOKEN_NAMES, (root) => convertPhp(root, text, atomicRows, ignoredPrefix), {
    locateErrors: locatePhpErrors,
  });
}

function convertPhp(root: Node, text: string, atomicRows: Set<number>, ignoredPrefix: number): ParsedProgram {
  const parseNotices = collectLexerNotices(root);
  const converter = new Converter(text, atomicRows, ignoredPrefix);
  let program: Program;
  try {
    program = converter.convertProgram(root);
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    program = converter.compiledPrefix();
    return { program, notices: converter.notices, parseNotices, conversionError: error };
  }
  for (const row of atomicRows) {
    if (!converter.claimedAtomicRows.has(row)) throw new CompileError([{ row, message: misplacedAtomicMessage }]);
  }
  return { program, notices: converter.notices, parseNotices };
}

function collectLexerNotices(root: Node): CompileNotice[] {
  const notices: CompileNotice[] = [];
  for (const token of root.descendantsOfType(['cast_type', 'escape_sequence'])) {
    const row = token.startPosition.row;
    if (token.type === 'cast_type' && token.parent?.type === 'cast_expression') {
      const { spelling, type } = castType(token.parent);
      if (spelling !== type)
        notices.push({
          level: 'Deprecated',
          message: `Non-canonical cast (${spelling}) is deprecated, use the (${type}) cast instead`,
          row,
        });
    } else if (/^\\[4-7][0-7]{2}$/.test(token.text)) {
      notices.push({
        level: 'Warning',
        message: `Octal escape sequence overflow ${token.text} is greater than \\377`,
        row,
      });
    }
  }
  return notices;
}

function locatePhpErrors(root: Node, diagnostics: SourceDiagnostic[]): SourceDiagnostic[] {
  const creationError = newKeywordError(root, diagnostics.length > 0);
  if (creationError) return [creationError];
  if (diagnostics.length === 0) return diagnostics;
  for (const error of root.descendantsOfType('ERROR')) {
    if (diagnostics[0].row !== error.startPosition.row) continue;
    const diagnostic = reservedClassSyntax(error) ?? recoveredTraitModifier(root, error) ?? recoveredMatchError(error);
    if (diagnostic) return [diagnostic];
    const shifted = shiftPhpTagError(error, diagnostics);
    if (shifted) return shifted;
  }
  return diagnostics;
}

function recoveredMatchError(error: Node): SourceDiagnostic | undefined {
  const next = error.nextNamedSibling;
  if (
    error.parent?.type === 'match_block' &&
    next?.type === 'match_default_expression' &&
    error.namedChildCount === 1 &&
    error.firstNamedChild?.type === 'match_condition_list'
  ) {
    return { row: next.startPosition.row, message: 'syntax error, unexpected token "default", expecting "=>"' };
  }
  const children = error.children;
  const open = children.findIndex((node) => node.type === '{');
  if (
    open < 2 ||
    children[open - 2].text.toLowerCase() !== 'match' ||
    children[open - 1].type !== 'parenthesized_expression'
  )
    return undefined;
  const token = children.slice(open + 1).find((node) => node.type !== 'comment');
  if (token?.type === ',')
    return { row: token.startPosition.row, message: 'syntax error, unexpected token ",", expecting "}"' };
  return undefined;
}

function shiftPhpTagError(error: Node, diagnostics: SourceDiagnostic[]): SourceDiagnostic[] | undefined {
  const children = error.children;
  let index = 0;
  while (index < children.length && children[index].type === 'text') index++;
  if (children[index]?.type !== 'php_tag') return undefined;
  index++;
  while (index < children.length && children[index].type === 'comment') index++;
  const first = children[index];
  if (!first || first.startPosition.row === error.startPosition.row) return undefined;
  return [{ ...diagnostics[0], row: first.startPosition.row }, ...diagnostics.slice(1)];
}

function recoveredTraitModifier(root: Node, error: Node): SourceDiagnostic | undefined {
  const children = error.children.filter((node) => node.type !== 'comment');
  for (const [index, child] of children.entries()) {
    if (child.type !== 'as') continue;
    const use = traitUseBeforeAlias(error, children, index);
    if (!use) continue;
    const rest = root.text.slice(child.endIndex).replace(PHP_TRIVIA, '');
    const modifier = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(rest)?.[0];
    const message = modifier && traitAdaptationModifierError(modifier);
    if (message) return { row: use.startPosition.row, message };
  }
}

function traitUseBeforeAlias(error: Node, children: Node[], index: number): Node | undefined {
  if (error.parent?.type === 'use_list') return error.parent.parent ?? undefined;
  const use = children.findLastIndex((node, position) => position < index && node.type === 'use');
  if (use === -1) return;
  const open = children.findIndex((node, position) => position > use && position < index && node.type === '{');
  if (open <= use + 1) return;
  if (
    children.slice(use + 1, open).every((node) => ['name', 'qualified_name', 'relative_name', ','].includes(node.type))
  )
    return children[use];
}

function newKeywordError(root: Node, recovering: boolean): SourceDiagnostic | undefined {
  for (const expression of root.descendantsOfType('object_creation_expression')) {
    const diagnostic = creationClassDiagnostic(root, expression);
    if (diagnostic) return diagnostic;
  }
  if (!recovering) return undefined;
  for (const error of root.descendantsOfType('ERROR')) {
    const diagnostic = recoveredNewName(root, error);
    if (diagnostic) return diagnostic;
  }
  return undefined;
}

function creationClassDiagnostic(root: Node, expression: Node): SourceDiagnostic | undefined {
  const name = expression.namedChildren.find((child) => child.type !== 'comment');
  if (name?.type !== 'name') return undefined;
  if (name.isMissing) {
    const keyword = expression.children.find((child) => child.type === 'new');
    return keyword && emptyNewClassDiagnostic(root, keyword, startsNewArgument(expression));
  }
  const parent = expression.parent;
  const binary =
    parent?.type === 'binary_expression' && parent.childForFieldName('left')?.id === expression.id ? parent : undefined;
  const operator =
    binary?.childForFieldName('operator') ??
    (parent?.type === 'ERROR' ? nextSignificantSibling(expression) : undefined);
  if (name.text.toLowerCase() === 'enum') {
    const hasArgs = expression.namedChildren.some((child) => child.type === 'arguments');
    if (!operator || !newClassKeywordOperators.has(operator.text.toLowerCase()) || hasArgs) return undefined;
  }
  return unexpectedNewName(name, startsNewArgument(binary ?? expression));
}

function startsNewArgument(expression: Node): boolean {
  const parent = expression.parent;
  if (parent?.type === 'argument') return parent.startIndex === expression.startIndex;
  if (parent?.type !== 'ERROR' && parent?.type !== 'arguments') return false;
  const parts = parent.children.filter((child) => child.type !== 'comment');
  const index = parts.findIndex((part) => part.id === expression.id);
  return followsArgumentSeparator(parts, index, parent.type === 'arguments');
}

function followsArgumentSeparator(parts: Node[], index: number, knownArguments: boolean): boolean {
  const previous = parts[index - 1]?.type;
  if (previous !== '(' && previous !== ',') return false;
  if (knownArguments) return true;
  const delimiters: Node[] = [];
  for (const part of parts.slice(0, index)) trackDelimiter(delimiters, part);
  const open = delimiters.at(-1);
  if (open?.type !== '(') return false;
  const callee = parts[parts.indexOf(open) - 1];
  return (
    callee !== undefined &&
    (callee.type !== 'name' || reservedIdentifierToken(callee.text) === undefined) &&
    ['name', 'variable_name', 'qualified_name', 'relative_name', ')', ']'].includes(callee.type)
  );
}

function nextSignificantSibling(node: Node): Node | undefined {
  let next = node.nextSibling;
  while (next?.type === 'comment') next = next.nextSibling;
  return next ?? undefined;
}

// code-gauge-allow functionCognitiveComplexity -- Keeps the ordered PHP cases together because each branch shares the same dispatch state.
function recoveredNewName(root: Node, error: Node): SourceDiagnostic | undefined {
  const parts = error.children.filter((child) => child.type !== 'comment');
  if (
    error.parent?.type === 'object_creation_expression' &&
    parts[0]?.type === 'readonly_modifier' &&
    parts[1]?.text.toLowerCase() === 'instanceof'
  )
    return {
      row: parts[1].startPosition.row,
      message: 'syntax error, unexpected token "instanceof", expecting "class"',
    };
  for (const [index, child] of parts.entries()) {
    if (child.text.toLowerCase() !== 'new') continue;
    const startsArgument =
      index === 0 && parts.length === 1 ? startsNewArgument(error) : followsArgumentSeparator(parts, index, false);
    const name = parts[index + 1];
    const operatorNode = parts[index + 2];
    const operator = operatorNode?.text.toLowerCase();
    if (name?.text.toLowerCase() === 'readonly' && operator === 'instanceof')
      return {
        row: operatorNode.startPosition.row,
        message: 'syntax error, unexpected token "instanceof", expecting "class"',
      };
    if (!name || !operator || !newClassKeywordOperators.has(operator)) {
      const diagnostic = emptyNewClassDiagnostic(root, child, startsArgument);
      if (diagnostic) return diagnostic;
      continue;
    }
    const diagnostic = unexpectedNewName(name, startsArgument);
    if (diagnostic) return diagnostic;
  }
  return undefined;
}

function emptyNewClassDiagnostic(root: Node, keyword: Node, startsArgument: boolean): SourceDiagnostic | undefined {
  const suffix = root.text.slice(keyword.endIndex - root.startIndex);
  const trivia = PHP_TRIVIA.exec(suffix)?.[0] ?? '';
  const offset = keyword.endIndex + trivia.length;
  const row = keyword.endPosition.row + (trivia.match(/\r\n?|\n/g)?.length ?? 0);
  const token = newClassNameToken(suffix.slice(trivia.length));
  if (!token) return undefined;
  const { symbol, description } = token;
  const opening = symbol && CLOSING_DELIMITERS.get(symbol);
  if (opening) {
    const open = unclosedDelimiterAt(root, offset);
    if (!open) return { row, message: `Unmatched '${symbol}'` };
    if (open.type !== opening) {
      const line = open.startPosition.row === row ? '' : ` on line ${open.startPosition.row + 1}`;
      return { row, message: `Unclosed '${open.type}'${line} does not match '${symbol}'` };
    }
  }
  const expected = startsArgument ? ':' : 'class';
  return { row, message: `syntax error, unexpected ${description}, expecting "${expected}"` };
}

function newClassNameToken(text: string): { symbol?: string; description: string } | undefined {
  if (text === '') return { description: 'end of file' };
  const quote = text[0];
  if (quote === '"' || quote === "'") return { description: unexpectedQuotedToken(text, quote) };
  const number = PHP_NUMBER.exec(text)?.[0];
  if (number) {
    const kind = /^0[xXbBoO]/.test(number) || !/[.eE]/.test(number) ? 'integer' : 'floating-point number';
    return { description: unexpectedTextToken(kind, number) };
  }
  const symbol = PHP_PUNCTUATOR.exec(text)?.[0];
  if (symbol) return { symbol, description: `token "${symbol}"` };
  const word = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(text)?.[0];
  if (!word || text[word.length] === '\\') return undefined;
  const keyword = reservedIdentifierToken(word);
  if (keyword && keyword !== 'static' && keyword !== 'class' && keyword !== 'readonly')
    return { description: `token "${keyword}"` };
  return undefined;
}

function unexpectedQuotedToken(text: string, quote: string): string {
  const match = (quote === '"' ? /^"(?:\\[\s\S]|[^"\\])*"/ : /^'(?:\\[\s\S]|[^'\\])*'/).exec(text)?.[0];
  if (!match) return quote === '"' ? 'double-quote mark' : 'end of file';
  const contents = match.slice(1, -1);
  if (quote === '"') {
    const tokens = contents.matchAll(/\\[\s\S]|\$[A-Za-z_{\u0080-\uFFFF]|\{\$/g);
    for (const [token] of tokens) if (!token.startsWith('\\')) return 'double-quote mark';
  }
  return unexpectedTextToken(quote === '"' ? 'double-quoted string' : 'single-quoted string', contents);
}

function unclosedDelimiterAt(root: Node, offset: number): Node | undefined {
  const delimiters: Node[] = [];
  const pending = [root];
  for (let node = pending.pop(); node && node.startIndex < offset; node = pending.pop()) {
    if (node.childCount === 0) {
      trackDelimiter(delimiters, node);
    } else {
      const children = node.children;
      for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
    }
  }
  return delimiters.at(-1);
}

function trackDelimiter(delimiters: Node[], token: Node): void {
  if (token.isMissing) return;
  if (OPEN_DELIMITERS.has(token.type)) delimiters.push(token);
  else if (delimiters.length > 0 && CLOSING_DELIMITERS.get(token.type) === delimiters.at(-1)?.type) delimiters.pop();
}

function unexpectedNewName(name: Node, startsArgument: boolean): SourceDiagnostic | undefined {
  const word = name.text.toLowerCase();
  if (word === 'static' || word === 'class' || word === 'readonly') return undefined;
  const token = word === 'enum' ? word : reservedIdentifierToken(word);
  if (!token) return undefined;
  const expected = startsArgument ? ':' : 'class';
  return {
    row: name.startPosition.row,
    message: `syntax error, unexpected token "${token}", expecting "${expected}"`,
  };
}

function reservedClassSyntax(error: Node): SourceDiagnostic | undefined {
  const children = error.namedChildren.filter((node) => node.type !== 'comment');
  const [context, name] = children;
  if (!context || !name || name.type !== 'name') return;
  const word = context.text.toLowerCase();
  if (!['new', 'extends', 'implements'].includes(word)) return;
  const token = reservedIdentifierToken(name.text);
  if (!token) return;
  const expected = word === 'new' ? ', expecting "class"' : '';
  return { row: name.startPosition.row, message: `syntax error, unexpected token "${token}"${expected}` };
}

/** Matches the annotation a line comment ends with, which may follow an ordinary remark. */
const PHP_ANNOTATION_PATTERN = /(?:\/\/|#)[ \t]*atomic[ \t]*$/;

/** The `// atomic` and `# atomic` annotations of a program, read from its line comments. */
export function findPhpTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(
    commentTokens(parser, hideShebang(source, shebangEnd(source))).filter(
      (comment) => comment.text.startsWith('//') || (comment.text.startsWith('#') && !comment.text.startsWith('#['))
    ),
    PHP_ANNOTATION_PATTERN
  );
}

function shebangEnd(source: string): number {
  if (!source.startsWith('#!')) return 0;
  const end = source.indexOf('\n');
  return end === -1 ? source.length : end + 1;
}

function hideShebang(source: string, end: number): string {
  if (end === 0) return source;
  const hasNewline = source[end - 1] === '\n';
  return ' '.repeat(end - Number(hasNewline)) + (hasNewline ? '\n' : '') + source.slice(end);
}
