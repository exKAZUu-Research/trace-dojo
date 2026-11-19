import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn, type TraceOptions } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import { maskInvalidArithmetic } from './arithmeticMasking';
import type { Program, WordPart } from './ast';
import { Converter } from './converter';
import { syntaxErrorsOf } from './syntaxErrors';

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
  const atomicRows = new Set(trace?.atomicAnnotations.keys());
  const { source: parsedSource, masked } = maskInvalidArithmetic(parser, source);
  return parseSource(
    parser,
    parsedSource,
    {},
    (root) => {
      const converter = new Converter(parsedSource, atomicRows, masked, rawArithmeticPieces);
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
    const [part] = new Converter(wrapped, new Set(), new Map(), () => [raw]).word(string).parts;
    if (part?.kind !== 'double') return [raw];
    return part.parts.map((inner) => (inner.kind === 'literal' ? inner.text.replaceAll(String.raw`\"`, '"') : inner));
  } finally {
    tree.delete();
  }
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
