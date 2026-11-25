import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import { convertModule } from './convert';
import { preprocess } from './cpp';
import { validateDialect } from './dialect';
import { Extensions, readExtensions } from './extensions';
import type { Module } from './syntax';
import type { SpliceSyntax } from './thDecode';
import { runSplices, type SpliceRunner } from './thSplice';

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

/**
 * Parses a module, throwing a `CompileError` for syntax errors and for syntax this environment does not support. A
 * program's text has already gone through {@link preprocessProgram}: preprocessing is a stage of its own, and parsing
 * never runs it.
 */
export function parseHaskell(source: string, defaultName = 'Main', library = false): Module {
  return parseModule(source, defaultName, library).module;
}

/**
 * Parses a program, running its Template Haskell splices with `run` and putting the syntax each gives in its place,
 * and gives what the splices printed while they ran.
 */
export function parseProgram(
  source: string,
  run: SpliceRunner
): { module: Module; printed: string; printedError: string } {
  return parseModule(source, 'Main', false, run);
}

function parseModule(
  source: string,
  defaultName: string,
  library: boolean,
  run?: SpliceRunner
): { module: Module; printed: string; printedError: string } {
  const extensions = library
    ? new Extensions(['TypeFamilies', 'DataKinds', 'RoleAnnotations'])
    : readExtensions(source);
  const features = extensions.gates('parse');
  return parseSource(
    features.allows('extendedGrammar') ? extendedParser : parser,
    source,
    MISSING_TOKEN_NAMES,
    (root) => {
      if (!library) validateDialect(root, extensions);
      const spliced =
        run && features.allows('splices')
          ? runSplices(root, run)
          : { grafts: new Map<number, SpliceSyntax>(), printed: '', printedError: '' };
      return {
        module: convertModule(root, extensions, defaultName, spliced.grafts),
        printed: spliced.printed,
        printedError: spliced.printedError,
      };
    }
  );
}

/**
 * A program's text after the C preprocessor, when the program enables CPP, which every later step reads: the splices
 * a branch `#if` leaves out are not run.
 */
export function preprocessProgram(source: string): string {
  return readExtensions(source).gates('parse').allows('cpp') ? preprocess(source) : source;
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
