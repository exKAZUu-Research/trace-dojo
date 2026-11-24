import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import { convertModule } from './convert';
import { validateDialect } from './dialect';
import { Extensions, readExtensions } from './extensions';
import type { Module } from './syntax';

const parser = await loadParser('@willbooster/tree-sitter-haskell/tree-sitter-haskell_ghc2021.wasm');
/** The grammar with the lexical syntax of the extensions GHC2021 lacks, which a program reads with when it enables one. */
const extendedParser = await loadParser('@willbooster/tree-sitter-haskell/tree-sitter-haskell.wasm');

/** The extensions whose syntax only the extended grammar reads. */
export const LEXICAL_EXTENSIONS = [
  'TemplateHaskell',
  'TemplateHaskellQuotes',
  'QuasiQuotes',
  'OverloadedRecordDot',
  'OverloadedRecordUpdate',
  'RecursiveDo',
  'PatternSynonyms',
  'UnboxedTuples',
  'UnboxedSums',
  'MagicHash',
  'OverloadedLabels',
];

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
  const extended = LEXICAL_EXTENSIONS.some((name) => extensions.has(name));
  return parseSource(extended ? extendedParser : parser, source, MISSING_TOKEN_NAMES, (root) => {
    if (!library) validateDialect(root, extensions);
    return convertModule(root, extensions, defaultName);
  });
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
