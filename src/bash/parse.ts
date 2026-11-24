import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn, type TraceOptions } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
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
  const { error, backquotes } = checkBashSyntax(source);
  if (error && error !== 'unknown')
    throw new CompileError([{ row: error.row, message: syntaxErrorMessage(error.text) }]);
  const hidden = hideInvalidBackquotes(source, backquotes);
  const { source: parsedSource, masked } = maskInvalidArithmetic(parser, hidden.source);
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
        hidden.errors
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
    const [part] = new Converter(wrapped, new Set(), new Map(), () => [raw], reparseBackquoted, new Map()).word(
      string
    ).parts;
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
// code-gauge-allow functionCognitiveComplexity -- Scans quotes, escapes, and `$`/backquote expansions across raw subscript text.
export function parseSubscriptWordParts(raw: string): WordPart[] {
  const parts: WordPart[] = [];
  const text = new SourceText(raw);
  text.parseSubstitution = (start) => skipBalanced(text, start - 1, '(', ')');
  for (let i = 0; i < raw.length;) {
    const c = raw[i];
    if (c === "'") {
      const close = raw.indexOf("'", i + 1);
      if (close === -1) {
        parts.push({ kind: 'single', text: "'" });
        i++;
      } else {
        parts.push({ kind: 'single', text: raw.slice(i + 1, close) });
        i = close + 1;
      }
      continue;
    }
    if (c === '\\') {
      if (i + 1 < raw.length && raw[i + 1] !== '\n') parts.push({ kind: 'single', text: raw[i + 1] });
      else if (i + 1 >= raw.length) parts.push({ kind: 'single', text: '\\' });
      i += 2;
      continue;
    }
    if (c === '$' && raw[i + 1] === "'") {
      let close = i + 2;
      while (close < raw.length && raw[close] !== "'") close += raw[close] === '\\' ? 2 : 1;
      if (close < raw.length) {
        parts.push({ kind: 'ansiC', text: decodeAnsiC(raw.slice(i + 2, close)) });
        i = close + 1;
        continue;
      }
    }
    if (
      c === '"' ||
      c === '`' ||
      (c === '$' && (raw[i + 1] === '"' || raw[i + 1] === '{' || raw[i + 1] === '(' || raw[i + 1] === '['))
    ) {
      let end = i + 1;
      try {
        end = skipWordPiece(text, i);
      } catch {
        end = raw.length;
      }
      parts.push(...parsePiece(raw.slice(i, end)));
      i = end;
      continue;
    }
    if (c === '$') {
      const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@#?*!$-])/.exec(raw.slice(i));
      if (match) {
        parts.push({ kind: 'parameter', name: match[0].slice(1), argument: [], text: match[0], braced: false });
        i += match[0].length;
        continue;
      }
    }
    parts.push({ kind: 'single', text: c });
    i++;
  }
  return parts;
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
