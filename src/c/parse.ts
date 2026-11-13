import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { ExecutionBudget } from '../interpreter/limits';
import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { loadParser, parseSource } from '../interpreter/treeSitter';
import type { Declaration, TranslationUnit } from './ast';
import { Converter, declaredName, type HeaderDeclarations } from './convert';
import { tokenize } from './lexer';
import { lookupHeader, TURTLE_HEADER } from './library/headers';
import { preprocess } from './preprocessor';
import { cSyntaxDiagnostics, CSyntaxError } from './syntaxDiagnostics';
import type { TypeScope } from './syntaxTokens';

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
    headers.push({ row: header.row, name: header.name, ...parsed, items: headerItemsAt(parsed.items, header.row) });
  }
  return parseUnit(text, headers, typedefNames);
}

class ReparseRequired extends Error {
  constructor(readonly source: string) {
    super();
  }
}

// code-gauge-allow functionCognitiveComplexity 20 -- Conversion and syntax recovery share the same source, scopes, and bounded reparse loop.
function parseUnit(text: string, headers: HeaderDeclarations[], typedefNames: readonly string[]): TranslationUnit {
  const budget = new ExecutionBudget();
  let current = text;
  for (;;) {
    budget.spend(current.length);
    try {
      return parseSource(
        parser,
        current,
        MISSING_TOKEN_NAMES,
        (root) => {
          try {
            return { items: new Converter([], parser).convertUnit(root, headers) };
          } catch (error) {
            if (!(error instanceof CompileError)) throw error;
            const scopes = resolveValueTypes(current, root, headers, budget);
            if (!(error instanceof CSyntaxError)) throw error;
            throw new CompileError(
              cSyntaxDiagnostics(parser, current, root, error.diagnostics, {
                headerTypes: typedefNames,
                errorOffset: error.offset,
                typeScopes: scopes,
              })
            );
          }
        },
        (root, errors) => {
          if (errors.length === 0) return errors;
          const scopes = resolveValueTypes(current, root, headers, budget);
          return cSyntaxDiagnostics(parser, current, root, errors, { headerTypes: typedefNames, typeScopes: scopes });
        }
      );
    } catch (error) {
      if (!(error instanceof ReparseRequired)) throw error;
      current = error.source;
    }
  }
}

function resolveValueTypes(
  text: string,
  root: Node,
  headers: HeaderDeclarations[],
  budget: ExecutionBudget
): TypeScope[] {
  const converter = new Converter([], parser, undefined, budget);
  try {
    converter.convertUnit(root, headers);
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
  }
  if (converter.valueTypeRanges.size === 0) return converter.typeScopes;
  budget.spend(text.length + converter.valueTypeRanges.size);
  const chunks: string[] = [];
  let at = 0;
  for (const [start, end] of [...converter.valueTypeRanges].toSorted((a, b) => a[0] - b[0])) {
    chunks.push(text.slice(at, start), '(', text.slice(start, end), ')');
    at = end;
  }
  chunks.push(text.slice(at));
  throw new ReparseRequired(chunks.join(''));
}

function headerItemsAt(source: Declaration[], row: number): Declaration[] {
  const items = structuredClone(source);
  const pending: object[] = [items];
  while (pending.length > 0) {
    const item = pending.pop()!;
    if ('row' in item) item.row = row;
    for (const child of Object.values(item)) if (child && typeof child === 'object') pending.push(child);
  }
  return items;
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
    new Converter(knownTypedefs, parser, name).convertUnit(root)
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
