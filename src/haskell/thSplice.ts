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

/** How a splice's program runs: the code it spells, and what it printed while it ran. */
export type SpliceRunner = (program: string) => { code: string; printed: string };

/**
 * Runs a program's splices in the order they are written, as GHC does, and puts the code of each in its place,
 * giving the program's text and what the splices printed. The code takes the rows the splice had, and the text
 * after the splice keeps its row and column, so that the layout of the rest of the program stays. A splice runs as
 * a program of the module's pragmas and imports, as GHC's stage restriction allows: it cannot use the module's own
 * definitions.
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
  const texts = uniqueNames(codes, outsideSplices(source, sites));
  let result = source;
  // From the last site back, so that the offsets of the earlier ones stay.
  for (const [index, site] of sites.entries().toArray().toReversed()) {
    const text = texts[index];
    const spliceLines = source.slice(site.start, site.end).split('\n');
    const replacement = site.runner === 'runDecSplice' ? text : `(${text})`;
    // Tabs stay, so that the layout reads the same column for the text after the splice.
    const indent = spliceLines.length > 1 ? (spliceLines.at(-1) ?? '').replaceAll(/[^\t]/g, ' ') : '';
    result =
      result.slice(0, site.start) + replacement + '\n'.repeat(spliceLines.length - 1) + indent + result.slice(site.end);
  }
  return { source: result, printed };
}

function outsideSplices(source: string, sites: readonly SpliceSite[]): string {
  let text = '';
  let from = 0;
  for (const site of sites) {
    text += `${source.slice(from, site.start)} `;
    from = site.end;
  }
  return text + source.slice(from);
}

/**
 * Names the new names of the splices' code across the module: each by its own name when no other new name has it
 * and no plain name (from mkName, or the program's own) does, and with a number otherwise, as `x_1`, that no other
 * name has. A splice's program numbers its new names afresh, so a new name is the splice it comes from with its
 * number. The library marks them as `\u0001name\u0002number\u0003`.
 */
function uniqueNames(codes: readonly string[], program: string): string[] {
  // oxlint-disable-next-line no-control-regex -- The library marks new names with control characters, which no source text has.
  const pattern = /\u0001([^\u0002]*)\u0002(\d+)\u0003/g;
  const identities = new Map<string, Set<string>>();
  for (const [index, code] of codes.entries()) {
    for (const match of code.matchAll(pattern)) {
      const set = identities.get(match[1]) ?? new Set();
      set.add(`${index}:${match[2]}`);
      identities.set(match[1], set);
    }
  }
  // A plain name of the same text would capture a new name written plainly.
  const plainText = [program, ...codes.map((code) => code.replaceAll(pattern, ' '))].join(' ');
  const taken = new Set(plainText.match(/[\w']+/g));
  const renamed = new Map<string, string>();
  const numbered: [string, string][] = [];
  for (const [name, ids] of identities) {
    if (!/^[\w']+$/.test(name) || (ids.size === 1 && !taken.has(name))) {
      for (const id of ids) renamed.set(`${id}:${name}`, name);
      taken.add(name);
    } else for (const id of ids) numbered.push([name, id]);
  }
  for (const [name, id] of numbered) {
    let number = Number(id.split(':')[1]);
    while (taken.has(`${name}_${number}`)) number++;
    taken.add(`${name}_${number}`);
    renamed.set(`${id}:${name}`, `${name}_${number}`);
  }
  return codes.map((code, index) =>
    code.replaceAll(pattern, (_, name: string, number: string) => renamed.get(`${index}:${number}:${name}`) ?? name)
  );
}
