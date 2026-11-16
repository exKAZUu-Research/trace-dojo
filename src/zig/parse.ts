import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import type { SourceFile } from './ast';
import { convertFile } from './convert';

const parser = await loadParser('@willbooster/tree-sitter-zig/tree-sitter-zig.wasm');

const MISSING_TOKEN_NAMES: Record<string, string> = {
  identifier: '名前',
  builtin_identifier: '組み込み関数の名前',
  ';': ';',
};

/** Parses a source file, throwing a `CompileError` for invalid or unsupported syntax. */
export function parseZig(source: string): SourceFile {
  return parseSource(parser, source, MISSING_TOKEN_NAMES, (root) => convertFile(root));
}

/** The `// atomic` annotations of a file, read from its line comments (not doc comments). */
export function findZigTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(commentTokens(parser, source).filter((comment) => /^\/\/(?![/!])/.test(comment.text)));
}
