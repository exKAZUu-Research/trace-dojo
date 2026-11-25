import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import { convertModule } from './convert';
import { preprocess } from './cpp';
import { validateDialect } from './dialect';
import { Extensions, readExtensions } from './extensions';
import type { FeatureGates } from './features';
import type { Module } from './syntax';
import { collectSplices, spliceHeader, type SpliceSite } from './thSplice';

const parser = await loadParser('@willbooster/tree-sitter-haskell/tree-sitter-haskell_ghc2021.wasm');
/** The grammar with the lexical syntax of the extensions GHC2021 lacks, which a program reads with when it enables one. */
const extendedParser = await loadParser('@willbooster/tree-sitter-haskell/tree-sitter-haskell.wasm');

const MISSING_TOKEN_NAMES: Record<string, string> = {
  variable: '名前',
  constructor: '構成子の名前',
  name: '型の名前',
  _layout_end: 'ブロックの終わり',
  _layout_semicolon: '改行',
};

export const misplacedHaskellAtomicMessage =
  '-- atomic は、関数を宣言する行（型シグネチャか、定義の最初の行）に付けてください。';

/** Parses a module, throwing a `CompileError` for syntax errors and for syntax this environment does not support. */
export function parseHaskell(source: string, defaultName = 'Main', library = false): Module {
  const extensions = library
    ? new Extensions(['TypeFamilies', 'DataKinds', 'RoleAnnotations'])
    : readExtensions(source);
  const features = extensions.gates('parse');
  const text = withDeclarationQuoteBraces(features, !library && features.allows('cpp') ? preprocess(source) : source);
  return parseSource(
    features.allows('extendedGrammar') ? extendedParser : parser,
    text,
    MISSING_TOKEN_NAMES,
    (root) => {
      if (!library) validateDialect(root, extensions);
      return convertModule(root, extensions, defaultName);
    }
  );
}

/**
 * The splices of a program that uses Template Haskell, which run before it compiles, with the pragmas and imports
 * the programs that run them keep.
 */
export function findProgramSplices(source: string): { sites: SpliceSite[]; header: string } | undefined {
  const features = readExtensions(source).gates('parse');
  if (!features.allows('splices')) return undefined;
  return parseSource(extendedParser, withDeclarationQuoteBraces(features, source), MISSING_TOKEN_NAMES, (root) => ({
    sites: collectSplices(root),
    header: spliceHeader(root),
  }));
}

/**
 * Writes the layout of each declaration quote, `[d| ... |]`, with explicit braces and semicolons, which the grammar
 * reads where its layout fails (a first declaration on the quote's line): each goes in place of a space where there
 * is one, so that rows and columns stay.
 */
function withDeclarationQuoteBraces(features: FeatureGates<'parse'>, source: string): string {
  if (!features.allows('declarationQuotes')) return source;
  let result = source;
  let from = 0;
  for (;;) {
    const open = result.indexOf('[d|', from);
    if (open === -1) return result;
    const close = result.indexOf('|]', open + 3);
    if (close === -1) return result;
    const body = result.slice(open + 3, close);
    const first = /\S/.exec(body);
    if (!first || body.trimStart().startsWith('{')) {
      from = close + 2;
      continue;
    }
    const lineStart = result.lastIndexOf('\n', open + 3 + first.index) + 1;
    const column = open + 3 + first.index - lineStart;
    const lines = body.split('\n');
    const rebuilt = lines.map((line, index) => {
      if (index === 0) return line;
      const indent = /^ */.exec(line)?.[0].length ?? 0;
      if (indent !== column || indent === 0 || line.length === indent) return line;
      return `${line.slice(0, indent - 1)};${line.slice(indent)}`;
    });
    let inner = rebuilt.join('\n');
    inner = inner.startsWith(' ') ? `{${inner.slice(1)}` : `{${inner}`;
    inner = inner.endsWith(' ') ? `${inner.slice(0, -1)}}` : `${inner}}`;
    result = result.slice(0, open + 3) + inner + result.slice(close);
    from = open + 3 + inner.length + 2;
  }
}

/** Matches the annotation a line comment ends with, which may follow an ordinary remark. */
const HASKELL_ANNOTATION_PATTERN = /--[ \t]*atomic[ \t]*$/;

/** The `-- atomic` annotations of a program, read from its comment tokens. */
export function findHaskellTraceAnnotations(source: string): TraceAnnotation[] {
  return traceAnnotationsIn(
    commentTokens(parser, source).filter((comment) => comment.text.startsWith('--')),
    HASKELL_ANNOTATION_PATTERN
  );
}
