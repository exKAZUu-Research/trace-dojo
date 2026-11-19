import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import type { Library } from './ast';
import { Converter } from './convert';

const parser = await loadParser('@willbooster/tree-sitter-dart/tree-sitter-dart.wasm');

const MISSING_TOKEN_NAMES = {
  identifier: '名前',
  type_identifier: '型の名前',
};

/**
 * Parses a Dart library, throwing a `CompileError` for invalid or unsupported syntax.
 *
 * @param isLibrary Whether the source is one of the interpreter's own libraries, which may declare `external` members.
 */
export function parseDart(source: string, isLibrary = false): Library {
  return parseSource(parser, source, MISSING_TOKEN_NAMES, (root) => new Converter(isLibrary).convertLibrary(root));
}

/** The `// atomic` annotations of a program, read from its line comments. */
export function findDartTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => comment.text.startsWith('//')));
}
