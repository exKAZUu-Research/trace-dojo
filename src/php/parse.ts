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
import { parseTypeText } from './calls';
import { castType, type CompileNotice, Converter } from './converter';
import {
  PHP_NUMBER,
  reservedIdentifierToken,
  traitAdaptationModifierError,
  unexpectedTextToken,
} from './converterBase';
import { typeToString } from './types';

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
  let text = hideShebang(source, ignoredPrefix);
  for (;;) {
    const rewrites: Rewrite[] = [];
    try {
      return parseSource(
        parser,
        text,
        MISSING_TOKEN_NAMES,
        (root) => convertPhp(root, text, atomicRows, ignoredPrefix),
        { locateErrors: (root, diagnostics) => locatePhpErrors(root, diagnostics, rewrites) }
      );
    } catch (error) {
      if (!(error instanceof CompileError) || rewrites.length === 0) throw error;
      for (const { start, end, replacement } of rewrites) text = text.slice(0, start) + replacement + text.slice(end);
    }
  }
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

function locatePhpErrors(root: Node, diagnostics: SourceDiagnostic[], rewrites: Rewrite[]): SourceDiagnostic[] {
  const creationError = newKeywordError(root, diagnostics.length > 0);
  if (creationError) return [creationError];
  if (diagnostics.length === 0) return diagnostics;
  const voidCast = voidCastError(root, rewrites);
  if (voidCast) return [voidCast];
  const errors = root.descendantsOfType('ERROR');
  for (const error of errors) {
    const diagnostic = recoveredEnumError(root, error, rewrites);
    if (diagnostic) return [diagnostic];
  }
  for (const error of errors) {
    if (diagnostics[0].row !== error.startPosition.row) continue;
    const diagnostic = reservedClassSyntax(error) ?? recoveredTraitModifier(root, error) ?? recoveredMatchError(error);
    if (diagnostic) return [diagnostic];
    const shifted = shiftPhpTagError(error, diagnostics);
    if (shifted) return shifted;
  }
  return diagnostics;
}

/** A change to the source that lets the grammar parse valid PHP it does not know, keeping every offset. */
interface Rewrite {
  start: number;
  end: number;
  replacement: string;
}

/** Text before a `(void)` cast that ends a statement or begins one, where PHP allows the cast. */
const STATEMENT_BOUNDARY = /(?:[;{}:)]|<\?php|<\?=|\?>|\belse|\bdo)$/i;

/**
 * The error PHP reports for a `(void)` cast where an expression is expected. The grammar lacks the cast, which only
 * discards a statement's value, so the source is parsed again with a `(bool)` cast in its place: it evaluates the
 * operand alike and also marks the result as used.
 */
function voidCastError(root: Node, rewrites: Rewrite[]): SourceDiagnostic | undefined {
  for (const node of root.descendantsOfType('parenthesized_expression')) {
    const [name, ...rest] = node.namedChildren.filter((child) => child.type !== 'comment');
    if (rest.length > 0 || name?.type !== 'name' || name.text.toLowerCase() !== 'void') continue;
    const before = root.text.slice(0, node.startIndex - root.startIndex).trimEnd();
    if (!STATEMENT_BOUNDARY.test(before))
      return { row: node.startPosition.row, message: 'syntax error, unexpected token "(void)"' };
    rewrites.push({ start: name.startIndex, end: name.endIndex, replacement: 'bool' });
  }
  return rewrites.length > 0 ? { row: 0, message: 'syntax error' } : undefined;
}

const ENUM_MEMBERS = new Set(['enum_case', 'const_declaration', 'method_declaration', 'use_declaration', 'comment']);
const CLASS_MEMBERS = new Set([
  'const_declaration',
  'property_declaration',
  'method_declaration',
  'use_declaration',
  'comment',
]);
const PROPERTY_START =
  /^(?:(?:public|protected|private|var|static|readonly|final|abstract)\b\s*)+(?:[^\s$;(){}]+\s+)?\$/i;

/**
 * PHP's message for the parts of an enum declaration the grammar rejects but PHP reports as a compile error, and
 * for a case outside an enum. A backing type spelled with capitals is valid PHP, which `rewrites` collects to parse
 * again in lower case.
 */
// code-gauge-allow functionCognitiveComplexity -- Recognizes each recovered enum form in the order PHP reports them.
// code-gauge-allow functionNcss -- Recognizes each recovered enum form in the order PHP reports them.
function recoveredEnumError(root: Node, error: Node, rewrites: Rewrite[]): SourceDiagnostic | undefined {
  const parts = error.children.filter((node) => node.type !== 'comment');
  const last = parts.at(-1);
  const next = error.nextSibling;
  if (last?.type.endsWith('_modifier') && next?.type === 'enum_declaration')
    return {
      row: next.startPosition.row,
      message: 'syntax error, unexpected token "enum", expecting "abstract" or "final" or "readonly" or "class"',
    };
  if (error.parent?.type === 'enum_declaration' && parts[1]?.type === ':' && next?.type === 'name')
    return {
      row: error.parent.startPosition.row,
      message: `Enum backing type must be int or string, ${next.text} given`,
    };
  const keyword = parts.findIndex(
    (node) =>
      ['class', 'interface', 'trait', 'enum'].includes(node.type) || (node.type === 'name' && node.text === 'trait')
  );
  if (keyword === -1 || parts[keyword + 1]?.type !== 'name') return undefined;
  const following = parts[keyword + 2];
  if (parts[keyword].type === 'enum' && following) {
    const header = enumHeaderError(root, parts[keyword], following, rewrites);
    if (header) return header;
  }
  const open = parts.findIndex((node, index) => index > keyword && node.type === '{');
  if (open === -1) return undefined;
  const members = parts[keyword].type === 'enum' ? ENUM_MEMBERS : CLASS_MEMBERS;
  const member = parts.slice(open + 1).find((node) => !members.has(node.type));
  if (!member) return undefined;
  const row = member.startPosition.row;
  if (parts[keyword].type === 'enum') {
    if (!PROPERTY_START.test(root.text.slice(member.startIndex - root.startIndex))) return undefined;
    return { row, message: `Enum ${qualifiedName(root, parts[keyword + 1])} cannot include properties` };
  }
  const word = member.type === 'name' ? member.text.toLowerCase() : '';
  if (word === 'case') return { row, message: 'Case can only be used in enums' };
  if (word === 'enum') return { row, message: 'syntax error, unexpected token "enum", expecting "function"' };
}

/** PHP's message for what follows an enum's name, where the grammar accepts neither `extends` nor most types. */
function enumHeaderError(
  root: Node,
  keyword: Node,
  following: Node,
  rewrites: Rewrite[]
): SourceDiagnostic | undefined {
  const row = keyword.startPosition.row;
  if (following.type === 'name' && following.text.toLowerCase() === 'extends')
    return { row: following.startPosition.row, message: 'syntax error, unexpected token "extends", expecting "{"' };
  if (following.type !== ':') return undefined;
  const rest = root.text.slice(following.endIndex - root.startIndex);
  const typeText = /^\s*([^{]*?)\s*(?:\bimplements\b|\{)/i.exec(rest);
  if (!typeText) return undefined;
  const type = typeToString(parseTypeText(typeText[1].replaceAll(/\s+/g, '')));
  if (type !== 'int' && type !== 'string')
    return { row, message: `Enum backing type must be int or string, ${type} given` };
  const start = following.endIndex + typeText[0].indexOf(typeText[1]);
  rewrites.push({ start, end: start + typeText[1].length, replacement: type });
  return { row, message: 'syntax error' };
}

/** The name a declaration in the program's top level gets, with the namespace declared before it. */
function qualifiedName(root: Node, name: Node): string {
  const namespace = root.namedChildren
    .findLast((node) => node.type === 'namespace_definition' && node.startIndex < name.startIndex)
    ?.childForFieldName('name')?.text;
  return namespace ? `${namespace}\\${name.text}` : name.text;
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
