import { type TraceAnnotation, traceAnnotationsIn } from '../interpreter/traceAnnotations';
import { commentTokens, loadParser, parseSource } from '../interpreter/treeSitter';
import { convertModule } from './convert';
import { preprocess } from './cpp';
import { validateDialect } from './dialect';
import { Extensions, readExtensions } from './extensions';
import type { FeatureGates } from './features';
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
  const text = withDeclarationQuoteBraces(features, source);
  return parseSource(
    features.allows('extendedGrammar') ? extendedParser : parser,
    text,
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

/**
 * Writes the layout of each declaration quote, `[d| ... |]`, with explicit braces and semicolons, which the grammar
 * reads where its layout fails (a first declaration on the quote's line): each goes in place of a space where there
 * is one, so that rows stay, and a declaration at the left margin gets its semicolon before it. Only the parse of
 * this text reads its offsets.
 */
function withDeclarationQuoteBraces(features: FeatureGates<'parse'>, source: string): string {
  if (!features.allows('declarationQuotes')) return source;
  let result = source;
  let from = 0;
  for (;;) {
    const open = codeIndexOf(result, '[d|', from);
    if (open === -1) return result;
    const close = codeIndexOf(result, '|]', open + 3);
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
      if (indent !== column || line.length === indent) return line;
      return indent === 0 ? `;${line}` : `${line.slice(0, indent - 1)};${line.slice(indent)}`;
    });
    let inner = rebuilt.join('\n');
    inner = inner.startsWith(' ') ? `{${inner.slice(1)}` : `{${inner}`;
    inner = inner.endsWith(' ') ? `${inner.slice(0, -1)}}` : `${inner}}`;
    result = result.slice(0, open + 3) + inner + result.slice(close);
    from = open + 3 + inner.length + 2;
  }
}

/** Where a text occurs in code from a position on, outside string and character literals and comments, or -1. */
function codeIndexOf(source: string, text: string, from: number): number {
  let index = from;
  while (index < source.length) {
    if (source.startsWith(text, index)) return index;
    if (source.startsWith('{-', index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith('{-', index)) depth++;
        else if (source.startsWith('-}', index)) depth--;
        index += source.startsWith('{-', index) || source.startsWith('-}', index) ? 2 : 1;
      }
    } else if (source.startsWith('"""', index)) {
      const end = source.indexOf('"""', index + 3);
      index = end === -1 ? source.length : end + 3;
    } else if (/^--+(?![!#$%&*+./<=>?@\\^|~:])/.test(source.slice(index, index + 64))) {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
    } else if (
      source[index] === '"' ||
      (/^'(\\.[^']*|[^\\'])'/.test(source.slice(index, index + 16)) && !/[\w']/.test(source[index - 1] ?? ''))
    ) {
      const quote = source[index];
      index++;
      while (index < source.length && source[index] !== quote && source[index] !== '\n')
        index += source[index] === '\\' ? 2 : 1;
      index++;
    } else index++;
  }
  return -1;
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
