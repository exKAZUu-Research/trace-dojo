import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { compileError } from './errors';

/** A splice of a program, which runs while the program compiles: `$(e)`, `$$(e)`, a declaration, or `[q|...|]`. */
export interface SpliceSite {
  start: number;
  end: number;
  /** The row (from 0) the splice starts on, where an error in it is reported. */
  row: number;
  /** How the program that runs the splice gives its result: as declarations, a typed expression, or any tree. */
  runner: 'runSplice' | 'runDecSplice' | 'runTypedSplice';
  /** The code that builds the tree, with the column its first line starts at. */
  code: string;
  column: number;
}

/** The nodes inside which a splice belongs to the code a quote builds, not to the program's compilation. */
const QUOTE_NODES = new Set(['quote', 'typed_quote']);

/** The splices of a program's syntax tree that its compilation runs, outermost first and in order. */
export function collectSplices(root: Node): SpliceSite[] {
  const sites: SpliceSite[] = [];
  const names = topLevelNames(root);
  const visit = (node: Node): void => {
    if (QUOTE_NODES.has(node.type)) return;
    if (node.type === 'top_splice' || node.type === 'splice' || node.type === 'quasiquote') {
      sites.push(spliceSite(node, names));
      return;
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return sites;
}

interface ModuleNames {
  module: string;
  values: Set<string>;
  constructors: Set<string>;
  types: Set<string>;
}

/** The names the module's own declarations define, which a splice may quote but not use. */
function topLevelNames(root: Node): ModuleNames {
  const header = root.namedChildren.find((child) => child?.type === 'header');
  const names: ModuleNames = {
    module: header?.childForFieldName('module')?.text.trim() ?? 'Main',
    values: new Set(),
    constructors: new Set(),
    types: new Set(),
  };
  const declarations = root.childForFieldName('declarations');
  for (const decl of declarations?.namedChildren ?? []) {
    if (!decl) continue;
    const name = decl.childForFieldName('name')?.text.trim();
    if (!name) continue;
    if (['function', 'bind', 'signature'].includes(decl.type)) names.values.add(name);
    if (['data_type', 'newtype', 'class', 'type_synonym', 'type_family', 'data_family'].includes(decl.type)) {
      names.types.add(name);
      for (const con of decl.descendantsOfType(['data_constructor', 'newtype_constructor', 'gadt_constructor'])) {
        const inner = con?.childForFieldName('constructor') ?? con;
        const conName =
          inner?.childForFieldName('name') ?? inner?.namedChildren.find((child) => child?.type === 'constructor');
        if (conName) names.constructors.add(conName.text.trim());
      }
      // Record fields and class methods are values the declaration defines too.
      for (const field of decl.descendantsOfType('field')) {
        for (const fieldName of field?.childrenForFieldName('name') ?? []) {
          if (fieldName) names.values.add(fieldName.text.trim());
        }
      }
      if (decl.type === 'class') {
        for (const signature of decl.descendantsOfType('signature')) {
          const single = signature?.childForFieldName('name');
          const list = signature?.childForFieldName('names')?.childrenForFieldName('name') ?? [];
          for (const method of single ? [single] : list) if (method) names.values.add(method.text.trim());
        }
      }
    }
  }
  return names;
}

/**
 * The code of a splice, with the quoted names of the module's own declarations (`'f`, `''T`) written as the names
 * themselves, since the program that runs the splice does not have those declarations.
 */
function spliceCode(inner: Node, names: ModuleNames): string {
  const base = inner.startIndex;
  let code = inner.text;
  const quoted = inner.descendantsOfType('th_quoted_name').filter((node): node is Node => node !== null);
  for (const node of quoted.toReversed()) {
    const typeNode = node.childForFieldName('type');
    const nameNode = typeNode ?? node.childForFieldName('name');
    const name = nameNode?.text.trim().replaceAll(/^\(|\)$/g, '') ?? '';
    const make = typeNode
      ? names.types.has(name) && 'mkNameG_tc'
      : names.constructors.has(name)
        ? 'mkNameG_d'
        : names.values.has(name) && 'mkNameG_v';
    if (!make) continue;
    const replacement = `(SpliceRunner.${make} "main" ${JSON.stringify(names.module)} ${JSON.stringify(name)})`;
    code = code.slice(0, node.startIndex - base) + replacement + code.slice(node.endIndex - base);
  }
  return code;
}

function spliceSite(node: Node, names: ModuleNames): SpliceSite {
  // The scanner gives a splice the spaces before its `$`, which stay where they are.
  const leading = node.text.length - node.text.trimStart().length;
  const base = { start: node.startIndex + leading, end: node.endIndex, row: node.startPosition.row };
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
  return { ...base, runner, code: spliceCode(inner, names), column: inner.startPosition.column };
}

/** The text of a program's header: its pragmas and imports, which the program that runs a splice keeps. */
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

/**
 * Runs a program's splices and puts the code they give in their places, each on the rows it had, so that the rows
 * of the rest of the program stay. A splice runs as a program of the module's pragmas and imports, as GHC's stage
 * restriction allows: it cannot use the module's own definitions.
 */
/** How a splice's program runs: the code it spells, and what it printed while it ran. */
export type SpliceRunner = (program: string) => { code: string; printed: string };

/**
 * Runs a program's splices in the order they are written, as GHC does, and puts the code of each in its place,
 * giving the program's text and what the splices printed.
 */
export function expandSplices(
  source: string,
  header: string,
  sites: readonly SpliceSite[],
  run: SpliceRunner
): { source: string; printed: string } {
  let printed = '';
  const codes = sites.map((site) => {
    const lines = site.code.split('\n');
    const padded = [' '.repeat(site.column + 2) + lines[0], ...lines.slice(1).map((line) => `  ${line}`)].join('\n');
    const program = `${header}\nimport qualified Language.Haskell.TH.Runner as SpliceRunner\nmain :: IO ()\nmain = SpliceRunner.${site.runner} (\n${padded}\n  )\n`;
    try {
      const output = run(program);
      printed += output.printed;
      return output.code;
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      const detail = error.diagnostics[0]?.message ?? '';
      throw compileError(site.row, `Template Haskell のスプライスを実行できません。${detail}`);
    }
  });
  let result = source;
  // From the last site back, so that the offsets of the earlier ones stay.
  for (const [index, site] of sites.entries().toArray().toReversed()) {
    const text = uniqueNames(codes[index]);
    const rows = source.slice(site.start, site.end).split('\n').length - 1;
    const replacement = site.runner === 'runDecSplice' ? text : `(${text})`;
    result = result.slice(0, site.start) + replacement + '\n'.repeat(rows) + result.slice(site.end);
  }
  return { source: result, printed };
}

/**
 * Names the new names of a splice's code: each by its own name when no other name of the code has it (another new
 * name, or a plain one such as mkName gives), and with its number otherwise, as `x_1`. The library marks them as `\u0001name\u0002number\u0003`.
 */
function uniqueNames(text: string): string {
  const pattern = /\u0001([^\u0002]*)\u0002(\d+)\u0003/g;
  const numbers = new Map<string, Set<string>>();
  for (const match of text.matchAll(pattern)) {
    const set = numbers.get(match[1]) ?? new Set();
    set.add(match[2]);
    numbers.set(match[1], set);
  }
  // A plain name (from mkName, or the program's own) of the same text would capture a new name written plainly.
  const plain = new Set(text.replaceAll(pattern, ' ').match(/[\w']+/g));
  return text.replaceAll(pattern, (_, name: string, number: string) =>
    ((numbers.get(name)?.size ?? 0) > 1 || plain.has(name)) && /^[\w']+$/.test(name) ? `${name}_${number}` : name
  );
}
