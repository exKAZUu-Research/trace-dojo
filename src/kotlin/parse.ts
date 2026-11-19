import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { loadParser, parseSource } from '../interpreter/treeSitter';
import type { KotlinFile } from './ast';
import { Converter } from './convert';

const parser = await loadParser('@willbooster/tree-sitter-kotlin/tree-sitter-kotlin.wasm');

const MISSING_TOKEN_NAMES = { identifier: '名前' };

/**
 * Parses a Kotlin file, throwing a `CompileError` for invalid syntax or syntax this environment does not run.
 *
 * @param isLibrary Whether the source is the prelude of the standard library, which may use any syntax the
 * interpreter implements.
 */
export function parseKotlin(source: string, isLibrary = false): KotlinFile {
  return parseSource(parser, source, MISSING_TOKEN_NAMES, (root) => new Converter(isLibrary).convertFile(root));
}

/** The `// atomic` annotations of a file, read from its line comments. */
export function findKotlinTraceAnnotations(source: string): TraceAnnotation[] {
  const tree = parser.parse(source);
  if (!tree) throw new Error('The parser returned no tree');
  try {
    const comments = tree.rootNode
      .descendantsOfType('line_comment')
      .flatMap((node) => (node ? [{ index: node.startIndex, text: node.text }] : []));
    return traceAnnotationsIn(comments);
  } finally {
    tree.delete();
  }
}
