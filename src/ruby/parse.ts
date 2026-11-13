import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn, type TraceOptions } from '../interpreter/traceAnnotations';
import { loadParser, parseSource } from '../interpreter/treeSitter';
import type { Program } from './ast';
import { Converter } from './converter';

const parser = await loadParser('@willbooster/tree-sitter-ruby/tree-sitter-ruby.wasm');

const MISSING_TOKEN_NAMES: Record<string, string> = {
  identifier: '名前',
  constant: '定数の名前',
  end: 'end',
  _line_break: '改行',
  string_end: '文字列の終わりの引用符',
};

export const misplacedRubyAtomicMessage =
  '# atomic は、メソッドを定義する行（def から引数の並びの終わりまで）に付けてください。';

/**
 * Parses a program, throwing a `CompileError` for the errors Ruby reports before running and for unsupported syntax.
 *
 * @param trace Marks the methods whose headers hold `# atomic`, for a model program.
 */
export function parseRuby(source: string, trace?: TraceOptions): Program {
  const atomicRows = new Set(trace?.atomicAnnotations.keys() ?? []);
  return parseSource(parser, source, MISSING_TOKEN_NAMES, (root) => {
    const converter = new Converter(source, atomicRows);
    const program = converter.convertProgram(root);
    for (const row of atomicRows) {
      if (!converter.claimedAtomicRows.has(row)) throw new CompileError([{ row, message: misplacedRubyAtomicMessage }]);
    }
    return program;
  });
}

/** Matches the annotation a line comment ends with, which may follow an ordinary remark. */
const RUBY_ANNOTATION_PATTERN = /#[ \t]*atomic[ \t]*$/;

/** The `# atomic` annotations of a program, read from its comment tokens. */
// code-gauge-allow duplicateLines 15 -- Each language reads its own comment tokens with its own parser.
export function findRubyTraceAnnotations(source: string): TraceAnnotation[] {
  const tree = parser.parse(source);
  if (!tree) throw new Error('The Ruby parser returned no tree');
  try {
    const comments: TraceAnnotation[] = [];
    const visit = (node: Node): void => {
      if (node.type === 'comment' && node.text.startsWith('#'))
        comments.push({ index: node.startIndex, text: node.text });
      for (const child of node.children) if (child) visit(child);
    };
    visit(tree.rootNode);
    return traceAnnotationsIn(comments, RUBY_ANNOTATION_PATTERN);
  } finally {
    tree.delete();
  }
}
