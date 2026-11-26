import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import {
  convertDeclaration,
  convertModuleHeader,
  convertSpliceCode,
  moduleDeclarationNodes,
  moduleImports,
  spanOf,
} from './convert';
import { compileError } from './errors';
import type { Extensions } from './extensions';
import { lowerDeclarations } from './lowering';
import { collectPatNames, StageRestrictionError } from './rename';
import type { Decl, Expr, Module, Name, Span } from './syntax';
import { SpliceNames, type SpliceSyntax } from './thDecode';

/** The name of the binding of a splice's code where it runs, which no program can spell, since it holds a space. */
export const SPLICE_ENTRY = ' splice';

/**
 * Compiles a module whose {@link SPLICE_ENTRY} binds a splice's code and runs that code, giving the tree the splice
 * gave, decoded with `names`, and what it printed. `pending` are the declarations of the splice's group that cannot
 * compile before it runs, whose names only quotes may use.
 */
export type SpliceRunner = (
  module: Module,
  pending: Decl[],
  span: Span,
  names: SpliceNames
) => { result: SpliceSyntax; printed: string; printedError: string };

/**
 * Converts a module whose splices run while it compiles, group by group as GHC's top-level declaration splices split
 * it: a group's declarations compile before the declaration splice after them runs, which adds its declarations to
 * the module, and the splices inside a group run in order with what of the group compiles without them. Each
 * splice's tree enters conversion and lowering where the splice is, as source would.
 */
export function convertWithSplices(
  root: Node,
  extensions: Extensions,
  defaultName: string,
  run: SpliceRunner
): { module: Module; printed: string; printedError: string } {
  return new ModuleSplices(root, extensions, defaultName, run).convert();
}

class ModuleSplices {
  private readonly header: Omit<Module, 'decls'>;
  private readonly grafts = new Map<number, SpliceSyntax>();
  private readonly names = new SpliceNames();
  /** The lowered declarations of the groups compiled so far. */
  private readonly compiled: Decl[] = [];
  /** The lowered declarations of each declaration node whose splices have all run, by the node's start. */
  private readonly lowered = new Map<number, Decl[]>();
  private printed = '';
  private printedError = '';

  constructor(
    private readonly root: Node,
    private readonly extensions: Extensions,
    defaultName: string,
    private readonly run: SpliceRunner
  ) {
    this.header = convertModuleHeader(root, extensions, defaultName);
  }

  convert(): { module: Module; printed: string; printedError: string } {
    let group: Node[] = [];
    for (const node of moduleDeclarationNodes(this.root)) {
      if (node.type !== 'top_splice') {
        group.push(node);
        continue;
      }
      this.compileGroup(group);
      group = [];
      this.runSplice(node, this.compiled, []);
      this.compiled.push(...this.loweredOf(node));
    }
    this.compileGroup(group);
    const module = { ...this.header, imports: moduleImports(this.header.imports), decls: this.compiled };
    return { module, printed: this.printed, printedError: this.printedError };
  }

  private compileGroup(nodes: Node[]): void {
    const sites = nodes.map((node) => collectSplices(node));
    for (const site of sites.flat()) {
      const ready = nodes.filter((_, index) => sites[index].every((other) => this.grafts.has(other.startIndex)));
      const { complete, pending } = this.partition(
        ready,
        nodes.filter((node) => !ready.includes(node))
      );
      this.runSplice(site, [...this.compiled, ...complete], pending);
    }
    for (const node of nodes) this.compiled.push(...this.loweredOf(node));
  }

  /**
   * The declarations of a group that compile before a splice of it runs: those whose splices have all run and that
   * name nothing the others declare, with the others' instances, whose methods are left out. The others are
   * pending: one that does not convert without its splices' trees still declares the name it is written with.
   */
  private partition(ready: Node[], waiting: Node[]): { complete: Decl[]; pending: Decl[] } {
    const complete = ready.flatMap((node) => this.loweredOf(node));
    const pending: Decl[] = [];
    const declared = new Set<string>();
    for (const node of waiting) {
      const decls = this.convertWaiting(node);
      if (!decls) {
        const name = node.childForFieldName('name')?.text.replaceAll(/[()\s]/g, '');
        if (name) declared.add(name);
        continue;
      }
      for (const decl of decls) {
        if (decl.kind !== 'instance') pending.push(decl);
        else complete.push({ ...decl, decls: decl.decls.filter((inner) => inner.kind === 'sig') });
      }
    }
    return withDependents(complete, pending, declared);
  }

  /** A declaration whose splices have not all run, unlowered, or `undefined` when it does not convert without them. */
  private convertWaiting(node: Node): Decl[] | undefined {
    try {
      return convertDeclaration(this.extensions, this.grafts, node);
    } catch (error) {
      if (error instanceof CompileError) return undefined;
      throw error;
    }
  }

  private loweredOf(node: Node): Decl[] {
    let decls = this.lowered.get(node.startIndex);
    if (!decls) {
      decls = lowerDeclarations(this.extensions, convertDeclaration(this.extensions, this.grafts, node));
      this.lowered.set(node.startIndex, decls);
    }
    return decls;
  }

  /** Runs a splice, after the splices in its code, in a module of `decls`, and keeps its tree for its place. */
  private runSplice(node: Node, decls: Decl[], pending: Decl[]): void {
    for (const inner of collectSplices(spliceCodeNode(node))) this.runSplice(inner, decls, pending);
    const span = spanOf(node);
    const code = convertSpliceCode(this.extensions, this.grafts, node);
    const run: Expr = { kind: 'support', name: spliceRunnerName(node), span };
    const entry: Decl = {
      kind: 'funClause',
      name: { name: SPLICE_ENTRY, span },
      args: [],
      rhs: { body: { kind: 'plain', expr: { kind: 'app', fn: run, arg: code, span } }, where: [], span },
      span,
    };
    const module: Module = {
      ...this.header,
      exports: undefined,
      decls: [...decls, ...lowerDeclarations(this.extensions, [entry])],
    };
    try {
      const output = this.run(module, pending, span, this.names);
      this.printed += output.printed;
      this.printedError += output.printedError;
      this.grafts.set(node.startIndex, output.result);
    } catch (error) {
      if (!(error instanceof CompileError) || error instanceof StageRestrictionError) throw error;
      const row = error.diagnostics[0]?.row ?? span.row;
      // An error of the module's declarations is theirs, not the splice's.
      if (row < span.row || row > span.endRow) throw error;
      throw compileError(span, `Template Haskell のスプライスを実行できません。${error.diagnostics[0]?.message ?? ''}`);
    }
  }
}

/** The nodes inside which a splice belongs to the code a quote builds, not to the program's compilation. */
const QUOTE_NODES = new Set(['quote', 'typed_quote']);

/** The outermost splices inside a node that its compilation runs, in order. */
function collectSplices(node: Node): Node[] {
  const sites: Node[] = [];
  const visit = (child: Node): void => {
    if (QUOTE_NODES.has(child.type)) return;
    if (child.type === 'top_splice' || child.type === 'splice' || child.type === 'quasiquote') {
      sites.push(child);
      return;
    }
    for (const grandchild of child.namedChildren) if (grandchild) visit(grandchild);
  };
  for (const child of node.namedChildren) if (child) visit(child);
  return sites;
}

/** The node of a splice's code, in which the splices inside it are. */
function spliceCodeNode(node: Node): Node {
  const code = node.type === 'top_splice' ? (node.namedChildren[0] ?? node) : node;
  return code.type === 'splice' ? (code.childForFieldName('expression') ?? code) : code;
}

/** Moves to `pending` every complete declaration that names what a pending one declares, and those naming them. */
function withDependents(
  complete: Decl[],
  pending: Decl[],
  declared: Set<string>
): { complete: Decl[]; pending: Decl[] } {
  let remaining = complete;
  for (const name of pending.flatMap(declaredNames)) declared.add(name);
  for (;;) {
    const naming = remaining.filter((decl) => mentions(decl, declared));
    if (naming.length === 0) return { complete: remaining, pending };
    remaining = remaining.filter((decl) => !naming.includes(decl));
    pending.push(...naming);
    for (const name of naming.flatMap(declaredNames)) declared.add(name);
  }
}

/** The library's function that runs a splice's code of its kind and stores its tree. */
function spliceRunnerName(node: Node): string {
  const splice = node.type === 'top_splice' ? (node.namedChildren[0] ?? node) : node;
  if (splice.type === 'splice' && splice.text.trimStart().startsWith('$$')) return 'runTypedSplice';
  return node.type === 'top_splice' ? 'runDecSplice' : 'runSplice';
}

function declaredNames(decl: Decl): string[] {
  switch (decl.kind) {
    case 'funClause': {
      return [decl.name.name];
    }
    case 'patBind': {
      const names: Name[] = [];
      collectPatNames(decl.pat, names);
      return names.map((name) => name.name);
    }
    case 'data': {
      return [
        ...(decl.instanceOf ? [] : [decl.name.name]),
        ...decl.cons.flatMap((con) => [con.name.name, ...(con.fieldNames ?? []).map((field) => field.name)]),
      ];
    }
    case 'class': {
      return [
        decl.name.name,
        ...decl.decls.flatMap((member) => (member.kind === 'sig' ? member.names : [])).map((name) => name.name),
      ];
    }
    case 'typeSyn':
    case 'typeFamily':
    case 'dataFamily':
    case 'patSyn': {
      return [decl.name.name];
    }
    default: {
      return [];
    }
  }
}

/** Whether syntax spells any of the names anywhere, a binder's name included, which may only make it pending. */
function mentions(syntax: unknown, names: ReadonlySet<string>): boolean {
  if (Array.isArray(syntax)) return syntax.some((item: unknown) => mentions(item, names));
  if (typeof syntax !== 'object' || syntax === null) return false;
  const fields = syntax as Record<string, unknown>;
  if (typeof fields.name === 'string' && names.has(fields.name)) return true;
  return Object.values(fields).some((value) => mentions(value, names));
}
