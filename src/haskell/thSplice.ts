import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { convertDeclarationsBeforeSplices, spanOf } from './convert';
import type { Fixity } from './entities';
import { compileError } from './errors';
import type { Extensions } from './extensions';
import type { FeatureGates } from './features';
import { collectPatNames } from './rename';
import type { Decl, Name, Span } from './syntax';
import { SpliceNames, type SpliceSyntax } from './thDecode';

export interface SpliceSite {
  /** The splice's node's start, by which the conversion finds what the splice gives. */
  key: number;
  span: Span;
  runner: 'runSplice' | 'runDecSplice' | 'runTypedSplice';
  code: string;
  column: number;
}

/**
 * The names a module's own declarations define, by namespace, with the fixities it declares: the programs that run
 * the module's splices have none of its declarations, and their quotes refer to these names as the module's.
 */
export interface SpliceModuleNames {
  module: string;
  /** Variables, record fields, and class methods. */
  values: ReadonlySet<string>;
  /** Data constructors and pattern synonyms. */
  constructors: ReadonlySet<string>;
  /** Types and classes. */
  types: ReadonlySet<string>;
  fixities: ReadonlyMap<string, Fixity>;
}

/** The nodes inside which a splice belongs to the code a quote builds, not to the program's compilation. */
const QUOTE_NODES = new Set(['quote', 'typed_quote']);

/** The splices of a program's syntax tree that its compilation runs, outermost first and in order. */
export function collectSplices(root: Node): SpliceSite[] {
  const sites: SpliceSite[] = [];
  const visit = (node: Node): void => {
    if (QUOTE_NODES.has(node.type)) return;
    if (node.type === 'top_splice' || node.type === 'splice' || node.type === 'quasiquote') {
      sites.push(spliceSite(node));
      return;
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return sites;
}

function spliceSite(node: Node): SpliceSite {
  const base = { key: node.startIndex, span: spanOf(node) };
  if (node.type === 'quasiquote') {
    const quoter = node.childForFieldName('quoter')?.text.trim() ?? '';
    const body = node.childForFieldName('body')?.text ?? '';
    return { ...base, runner: 'runSplice', code: `quoteExp ${quoter} ${JSON.stringify(body)}`, column: 0 };
  }
  let inner: Node = node;
  let runner: SpliceSite['runner'] = node.type === 'top_splice' ? 'runDecSplice' : 'runSplice';
  if (node.type === 'top_splice') inner = node.namedChildren[0] ?? node;
  if (inner.type === 'splice') {
    if (inner.text.trimStart().startsWith('$$')) runner = 'runTypedSplice';
    inner = inner.namedChildren[0] ?? inner;
  }
  return { ...base, runner, code: inner.text, column: inner.startPosition.column };
}

// code-gauge-allow functionCognitiveComplexity -- One short case per kind of declaration that defines names.
// code-gauge-allow functionNcss -- One short case per kind of declaration that defines names.
export function spliceModuleNames(module: string, decls: Decl[]): SpliceModuleNames {
  const values = new Set<string>();
  const constructors = new Set<string>();
  const types = new Set<string>();
  const fixities = new Map<string, Fixity>();
  for (const decl of decls) {
    switch (decl.kind) {
      case 'funClause': {
        values.add(decl.name.name);
        break;
      }
      case 'patBind': {
        const names: Name[] = [];
        collectPatNames(decl.pat, names);
        for (const name of names) values.add(name.name);
        break;
      }
      case 'fixity': {
        for (const op of decl.ops) fixities.set(op.name, { assoc: decl.assoc, prec: decl.prec });
        break;
      }
      case 'data': {
        if (!decl.instanceOf) types.add(decl.name.name);
        // The constructors of `type data` are types only.
        for (const con of decl.cons) (decl.typeData ? types : constructors).add(con.name.name);
        for (const field of decl.cons.flatMap((con) => con.fieldNames ?? [])) values.add(field.name);
        break;
      }
      case 'class': {
        types.add(decl.name.name);
        for (const member of decl.decls.flatMap((d) => (d.kind === 'sig' ? d.names : []))) values.add(member.name);
        break;
      }
      case 'typeSyn':
      case 'typeFamily':
      case 'dataFamily': {
        types.add(decl.name.name);
        break;
      }
      case 'patSyn': {
        constructors.add(decl.name.name);
        break;
      }
      default: {
        break;
      }
    }
  }
  return { module, values, constructors, types, fixities };
}

export function spliceHeader(root: Node): string {
  const lines: string[] = [];
  for (const child of root.namedChildren) {
    if (child?.type === 'pragma') lines.push(child.text);
  }
  const imports = root.childForFieldName('imports');
  // The program that runs a splice imports at its own level what the module imports for splices and quotes.
  if (imports) lines.push(imports.text.replaceAll(/^(\s*import)\s+(?:splice|quote)\b/gm, '$1'));
  return lines.join('\n');
}

export type SpliceRunner = (
  program: string,
  span: Span,
  names: SpliceNames,
  module: SpliceModuleNames,
  /** The extensions of the program the splice is in, which give the syntax it makes its meaning there. */
  site: FeatureGates<'convert'>
) => {
  result: SpliceSyntax;
  printed: string;
  printedError: string;
};

/**
 * Runs a program's splices in the order they are written, as GHC does, giving what each gives by its node's start,
 * and what they printed to each standard stream. A splice runs as a program of the module's pragmas and imports, as
 * GHC's stage restriction allows: it cannot use the module's own definitions, which its quotes name by the module's
 * table of names.
 */
export function runSplices(
  root: Node,
  extensions: Extensions,
  run: SpliceRunner
): { grafts: Map<number, SpliceSyntax>; printed: string; printedError: string } {
  const header = spliceHeader(root);
  const moduleNode = root.namedChildren.find((child) => child?.type === 'header')?.childForFieldName('module');
  const moduleName = moduleNode?.text.trim() ?? 'Main';
  const declared = convertDeclarationsBeforeSplices(root, extensions);
  let module = spliceModuleNames(moduleName, declared);
  const names = new SpliceNames();
  const grafts = new Map<number, SpliceSyntax>();
  let printed = '';
  let printedError = '';
  for (const site of collectSplices(root)) {
    const lines = site.code.split('\n');
    const padded = [' '.repeat(site.column + 2) + lines[0], ...lines.slice(1).map((line) => `  ${line}`)].join('\n');
    const program = `${header}\nimport qualified Language.Haskell.TH.Runner as SpliceRunner\nmain :: IO ()\nmain = SpliceRunner.${site.runner} (\n${padded}\n  )\n`;
    try {
      const output = run(program, site.span, names, module, extensions.gates('convert'));
      printed += output.printed;
      printedError += output.printedError;
      grafts.set(site.key, output.result);
      // What a declaration splice declares is the module's for the splices after it.
      if (output.result.kind === 'decs') {
        declared.push(...output.result.decls);
        module = spliceModuleNames(moduleName, declared);
      }
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      const detail = error.diagnostics[0]?.message ?? '';
      throw compileError(site.span, `Template Haskell のスプライスを実行できません。${detail}`);
    }
  }
  return { grafts, printed, printedError };
}
