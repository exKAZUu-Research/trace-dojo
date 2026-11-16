import { CompileError } from '../interpreter/diagnostics';
import {
  misplacedAtomicMessage,
  type TraceAnnotation,
  traceAnnotationsIn,
  type TraceOptions,
} from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import type { Program } from './ast';
import { type CompileNotice, Converter } from './converter';

const parser = await loadParser('@willbooster/tree-sitter-php/tree-sitter-php.wasm');

const MISSING_TOKEN_NAMES: Record<string, string> = {
  name: '名前',
  variable_name: '変数の名前',
  _automatic_semicolon: ';',
  heredoc_end: 'ヒアドキュメントの終わりの印',
};

export interface ParsedProgram {
  program: Program;
  notices: CompileNotice[];
}

/**
 * Parses a program, throwing a `CompileError` for the errors PHP reports before running and for unsupported syntax.
 *
 * @param trace Marks the functions whose headers hold `// atomic` (or `# atomic`), for a model program.
 */
export function parsePhp(source: string, trace?: TraceOptions): ParsedProgram {
  const atomicRows = new Set(trace?.atomicAnnotations.keys());
  return parseSource(parser, source, MISSING_TOKEN_NAMES, (root) => {
    const converter = new Converter(source, atomicRows);
    const program = converter.convertProgram(root);
    for (const row of atomicRows) {
      if (!converter.claimedAtomicRows.has(row)) throw new CompileError([{ row, message: misplacedAtomicMessage }]);
    }
    return { program, notices: converter.notices };
  });
}

/** Matches the annotation a line comment ends with, which may follow an ordinary remark. */
const PHP_ANNOTATION_PATTERN = /(?:\/\/|#)[ \t]*atomic[ \t]*$/;

/** The `// atomic` and `# atomic` annotations of a program, read from its line comments. */
export function findPhpTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(
    commentTokens(parser, source).filter(
      (comment) => comment.text.startsWith('//') || (comment.text.startsWith('#') && !comment.text.startsWith('#['))
    ),
    PHP_ANNOTATION_PATTERN
  );
}
