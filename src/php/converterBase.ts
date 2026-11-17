// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { ClassRef, Expr, ResolvedName, Stmt } from './ast';
import { labelInsideLoop } from './astAnalysis';
import { enc, lower } from './bytes';
import { unsupportedMessage } from './unsupported';
import type { TypeDecl } from './values';

/** A notice PHP prints when it compiles the program, before running it. */
export interface CompileNotice {
  level: 'Deprecated' | 'Warning';
  message: string;
  row: number;
}

export const SUPERGLOBALS = new Set(['_GET', '_POST', '_SERVER', '_ENV', '_COOKIE', '_FILES', '_REQUEST', '_SESSION']);
export const BUILTIN_TYPES = new Set([
  'int',
  'float',
  'string',
  'bool',
  'array',
  'callable',
  'iterable',
  'object',
  'mixed',
  'void',
  'null',
  'never',
  'false',
  'true',
]);
export const MAGIC_RUNTIME = new Set(['__CLASS__', '__FUNCTION__', '__METHOD__', '__TRAIT__']);

export interface LoopContext {
  /** The number of loops and switches enclosing the current statement in its function. */
  depth: number;
}

export interface FunctionContext {
  returnType?: TypeDecl;
  isGenerator: boolean;
  labels: Set<string>;
  gotos: { label: string; row: number }[];
  className?: string;
  isMethod: boolean;
  /** The function's name in the names of the closures it defines, such as `A::m()`; undefined at the top level. */
  displayName?: string;
}

/** The state a conversion shares: the namespace and imports, the enclosing function and loops, and errors. */
export abstract class ConverterBase {
  readonly claimedAtomicRows = new Set<number>();
  readonly notices: CompileNotice[] = [];
  protected namespace = '';
  protected classImports = new Map<string, string>();
  protected functionImports = new Map<string, string>();
  protected constImports = new Map<string, string>();
  protected loop: LoopContext = { depth: 0 };
  protected fn: FunctionContext = { isGenerator: false, labels: new Set(), gotos: [], isMethod: false };
  protected strictTypes = false;
  protected declaredFunctions = new Map<string, number>();
  /** The classes declared at run time so far (anonymous ones and those inside blocks), which number anonymous classes. */
  protected runtimeClasses = 0;
  protected currentClass?: string;
  /** Whether the statement to convert follows `<?=`, which echoes it. */
  protected pendingEcho = false;

  constructor(
    protected readonly source: string,
    protected readonly atomicRows: ReadonlySet<number>
  ) {}

  protected error(node: Node | number, message: string): never {
    throw new CompileError([{ row: typeof node === 'number' ? node : node.startPosition.row, message }]);
  }

  protected unsupported(node: Node, what: string): never {
    this.error(node, unsupportedMessage(what));
  }

  // Names -------------------------------------------------------------------------------------------------------------

  protected qualify(name: string): string {
    return this.namespace ? `${this.namespace}\\${name}` : name;
  }

  /** Resolves a class name written in the program to its fully qualified name. */
  protected resolveClassName(raw: string): string {
    if (raw.startsWith('\\')) return raw.slice(1);
    if (lower(raw).startsWith('namespace\\')) return this.qualify(raw.slice('namespace\\'.length));
    const parts = raw.split('\\');
    const alias = this.classImports.get(lower(parts[0]));
    if (alias !== undefined) return [alias, ...parts.slice(1)].join('\\');
    return this.qualify(raw);
  }

  protected resolveFunctionName(raw: string): ResolvedName {
    if (raw.startsWith('\\')) return { name: raw.slice(1) };
    if (lower(raw).startsWith('namespace\\')) return { name: this.qualify(raw.slice('namespace\\'.length)) };
    if (raw.includes('\\')) return { name: this.resolveClassName(raw) };
    const imported = this.functionImports.get(lower(raw));
    if (imported !== undefined) return { name: imported };
    return this.namespace ? { name: this.qualify(raw), fallback: raw } : { name: raw };
  }

  protected resolveConstName(raw: string): ResolvedName {
    if (raw.startsWith('\\')) return { name: raw.slice(1) };
    if (lower(raw).startsWith('namespace\\')) return { name: this.qualify(raw.slice('namespace\\'.length)) };
    if (raw.includes('\\')) return { name: this.resolveClassName(raw) };
    const imported = this.constImports.get(raw);
    if (imported !== undefined) return { name: imported };
    return this.namespace ? { name: this.qualify(raw), fallback: raw } : { name: raw };
  }

  protected nameText(node: Node): string {
    return enc(node.text.replaceAll(/\s+/g, ''));
  }

  protected classRef(node: Node): ClassRef {
    if (node.type === 'relative_scope') {
      const word = lower(node.text);
      if (word === 'self') return { k: 'self' };
      if (word === 'parent') return { k: 'parent' };
      return { k: 'static' };
    }
    if (node.type === 'name' || node.type === 'qualified_name' || node.type === 'relative_name') {
      const raw = this.nameText(node);
      const word = lower(raw);
      if (word === 'self') return { k: 'self' };
      if (word === 'parent') return { k: 'parent' };
      if (word === 'static') return { k: 'static' };
      return { k: 'named', name: this.resolveClassName(raw) };
    }
    return { k: 'expr', e: this.expr(node) };
  }

  // Statements --------------------------------------------------------------------------------------------------------

  protected variableName(node: Node): string {
    if (node.type === 'variable_name') {
      const name = enc(node.namedChildren[0]?.text ?? node.text.replace(/^\$/, ''));
      if (SUPERGLOBALS.has(name)) this.unsupported(node, `スーパーグローバル変数 $${name}`);
      if (name === 'argv' || name === 'argc') this.unsupported(node, `コマンドライン引数 $${name}`);
      return name;
    }
    this.error(node, '書き方に誤りがあります。');
  }

  protected checkGotos(context: FunctionContext, body: Stmt[]): void {
    for (const { label, row } of context.gotos) {
      if (!context.labels.has(label))
        this.error(row, `goto の行き先のラベル「${label}」がありません（'goto' to undefined label '${label}'）。`);
      if (labelInsideLoop(body, label, false)) {
        this.error(
          row,
          `goto でループや switch の中には入れません（'goto' into loop or switch statement is disallowed）。`
        );
      }
    }
  }

  // Functions ---------------------------------------------------------------------------------------------------------

  protected claimAtomic(node: Node, body: Node | null): boolean {
    const first = node.startPosition.row;
    const last = body ? body.startPosition.row : node.endPosition.row;
    let claimed = false;
    for (let row = first; row <= last; row++) {
      if (this.atomicRows.has(row) && !this.claimedAtomicRows.has(row)) {
        this.claimedAtomicRows.add(row);
        claimed = true;
      }
    }
    return claimed;
  }

  abstract expr(node: Node): Expr;
}
