import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { loadParser, parseSource } from '../interpreter/treeSitter';
import type { Declaration, TranslationUnit } from './ast';
import { Converter, declaredName, type HeaderDeclarations } from './convert';
import { tokenize } from './lexer';
import { lookupHeader, TURTLE_HEADER } from './library/headers';
import { preprocess } from './preprocessor';

const parser = await loadParser('@willbooster/tree-sitter-c/tree-sitter-c.wasm');

const MISSING_TOKEN_NAMES: Record<string, string> = {
  identifier: '名前',
  type_identifier: '型の名前',
  field_identifier: 'メンバの名前',
  statement_identifier: 'ラベルの名前',
  primitive_type: '型',
};

/** The name under which the interpreter's own declarations are visible from the first row. */
export const TURTLE_HEADER_NAME = '<turtle>';

/** Preprocesses and parses a translation unit, throwing a `CompileError` for invalid or unsupported syntax. */
export function parseC(source: string): TranslationUnit {
  const { text, includes } = preprocess(source, lookupHeader);
  const headers: HeaderDeclarations[] = [];
  const typedefNames: string[] = [];
  for (const header of [{ row: -1, name: TURTLE_HEADER_NAME, declarations: TURTLE_HEADER }, ...includes]) {
    const parsed = parseHeader(header.name, header.declarations, typedefNames);
    typedefNames.push(...parsed.typedefNames);
    headers.push({ row: header.row, name: header.name, ...parsed });
  }
  try {
    return parseSource(parser, text, MISSING_TOKEN_NAMES, (root) => ({
      items: new Converter([]).convertUnit(root, headers),
    }));
  } catch (error) {
    throw atEndOfFile(error, text);
  }
}

/** clang reports a `}` missing at the end of the file at the end of the file, after the last line. */
function atEndOfFile(error: unknown, text: string): unknown {
  if (!(error instanceof CompileError)) return error;
  const [first] = error.diagnostics;
  if (first?.message !== '「}」が足りません。' || text.slice(text.lastIndexOf('}') + 1).trim() !== '') return error;
  // clang places the end of a file that ends with a newline on the last line, not after it.
  const newlines = text.split('\n').length - 1;
  const lastRow = text.endsWith('\n') ? newlines - 1 : newlines;
  return new CompileError([{ ...first, row: lastRow }]);
}

const headerCache = new Map<string, { items: Declaration[]; typedefNames: string[] }>();

/** A header's declarations, which parse alike wherever a program includes the header. */
function parseHeader(
  name: string,
  text: string,
  knownTypedefs: readonly string[]
): { items: Declaration[]; typedefNames: string[] } {
  const key = `${name}\n${knownTypedefs.join(' ')}\n${text}`;
  const cached = headerCache.get(key);
  if (cached) return cached;
  const items = parseSource(parser, text, MISSING_TOKEN_NAMES, (root: Node) =>
    new Converter(knownTypedefs, name).convertUnit(root)
  ) as Declaration[];
  const typedefNames = items.flatMap((item) =>
    item.specifiers.storage === 'typedef'
      ? item.declarators.flatMap((declarator) => declaredName(declarator.declarator) ?? [])
      : []
  );
  const result = { items, typedefNames };
  headerCache.set(key, result);
  return result;
}

/** The `// atomic` annotations of a program, read from its line comments. */
export function findCTraceAnnotations(source: string): TraceAnnotation[] {
  const { comments } = tokenize(source);
  return traceAnnotationsIn(comments.filter((comment) => comment.isLine));
}
