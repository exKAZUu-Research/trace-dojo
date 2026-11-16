import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import { convertModule } from './convert';
import { validateDialect } from './dialect';
import type { Module } from './syntax';

const parser = await loadParser('@willbooster/tree-sitter-haskell/tree-sitter-haskell.wasm');

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
  return parseSource(parser, source, MISSING_TOKEN_NAMES, (root) => {
    if (!library) validateDialect(root);
    return convertModule(root, defaultName, library);
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
