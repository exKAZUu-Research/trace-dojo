import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { loadParser, parseSource } from '../interpreter/treeSitter';
import type { KotlinFile } from './ast';
import { ACCESSOR_SEPARATOR, Converter } from './convert';

const parser = await loadParser('@willbooster/tree-sitter-kotlin/tree-sitter-kotlin.wasm');

const MISSING_TOKEN_NAMES = { identifier: '名前' };

/**
 * Parses a Kotlin file, throwing a `CompileError` for invalid syntax or syntax this environment does not run.
 *
 * @param isLibrary Whether the source is the prelude of the standard library, which may use any syntax the
 * interpreter implements.
 */
export function parseKotlin(source: string, isLibrary = false): KotlinFile {
  return parseSource(parser, withoutAccessorSemicolons(source), MISSING_TOKEN_NAMES, (root) =>
    new Converter(isLibrary).convertFile(root)
  );
}

/**
 * Blanks out a `;` between a getter and a setter, as in `var x get() = f; set(v) { f = v }`, which kotlinc accepts and
 * the grammar reads as the end of the property. A form feed keeps every row and column where it was, and tells the
 * converter that the getter ended there.
 */
function withoutAccessorSemicolons(source: string): string {
  return source.replaceAll(
    /(^|[\s;])(get\s*\(\s*\)[^\n;]*?);(\s*(?:(?:private|protected|public|internal)\s+)?set\b)/gm,
    `$1$2${ACCESSOR_SEPARATOR}$3`
  );
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
