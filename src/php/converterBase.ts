// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { ExecutionBudget } from '../interpreter/limits';
import type { ClassDecl, ClassRef, Expr, ResolvedName, Stmt } from './ast';
import { nestedBodies } from './astAnalysis';
import { dec, enc, lower } from './bytes';
import { unavailableVariable, unsupportedMessage } from './unsupported';
import type { TypeDecl } from './values';

export const PHP_NUMBER =
  /^(?:0[xX][\dA-Fa-f](?:_?[\dA-Fa-f])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?)/;

export function unexpectedTextToken(kind: string, raw: string): string {
  const bytes = enc(raw.split('\n', 1)[0]);
  const spelling = bytes.length > 33 ? `${dec(bytes.slice(0, 30))}...` : dec(bytes);
  return `${kind} "${spelling}"`;
}

export function semanticChildren(node: Node): Node[] {
  return node.namedChildren.filter((child) => child.type !== 'comment');
}

/** A notice PHP prints when it compiles the program, before running it. */
export interface CompileNotice {
  level: 'Deprecated' | 'Warning';
  message: string;
  row: number;
}

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

export function explicitlyQualifiedName(raw: string): string | undefined {
  if (raw.startsWith('\\')) return raw.slice(1);
  if (lower(raw).startsWith('namespace\\')) return raw.slice('namespace\\'.length);
  return undefined;
}

export function relativeClassName(raw: string, allowAbsolute = false): 'self' | 'parent' | 'static' | undefined {
  const name = lower(raw);
  const word =
    name.startsWith('namespace\\') || (allowAbsolute && name.startsWith('\\')) ? explicitlyQualifiedName(name) : name;
  return word === 'self' || word === 'parent' || word === 'static' ? word : undefined;
}

export function isReservedClassName(name: string): boolean {
  const word = lower(name);
  return BUILTIN_TYPES.has(word) || word === 'self' || word === 'parent' || word === 'static';
}

export interface LoopContext {
  /** The number of loops and switches enclosing the current statement in its function. */
  depth: number;
  /** Whether each enclosing construct is a switch, innermost last, which `continue` treats as `break`. */
  switches: boolean[];
}

export interface FunctionContext {
  returnType?: TypeDecl;
  byRefReturn?: boolean;
  isGenerator: boolean;
  labels: Set<string>;
  gotos: { label: string; row: number; offset: number }[];
  className?: string;
  isMethod: boolean;
  /** Whether the code is a function's body (not the file's), and whether that function is a closure. */
  isFunction?: boolean;
  isClosure?: boolean;
  usesThis?: boolean;
  /** The function's name in the names of the closures it defines, such as `A::m()`; undefined at the top level. */
  displayName?: string;
  name?: string;
  propertyName?: string;
}

/** The state a conversion shares: the namespace and imports, the enclosing function and loops, and errors. */
export abstract class ConverterBase {
  protected abstract readonly preserveSyntax: boolean;
  readonly claimedAtomicRows = new Set<number>();
  readonly notices: CompileNotice[] = [];
  protected namespace = '';
  protected classImports = new Map<string, string>();
  protected functionImports = new Map<string, string>();
  protected constImports = new Map<string, string>();
  protected loop: LoopContext = { depth: 0, switches: [] };
  protected fn: FunctionContext = { isGenerator: false, labels: new Set(), gotos: [], isMethod: false };
  protected strictTypes = false;
  protected currentClass?: string;
  protected currentClassKind?: ClassDecl['kind'];
  protected currentClassHasParent = false;

  constructor(
    protected readonly source: string,
    protected readonly atomicRows: ReadonlySet<number>,
    private compilationBudget?: ExecutionBudget
  ) {}

  protected get compileBudget(): ExecutionBudget {
    return (this.compilationBudget ??= new ExecutionBudget());
  }

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
    // PHP's parser reads an unqualified `readonly(` call as the fully qualified global name.
    if (lower(raw) === 'readonly') return { name: raw };
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
    return enc(node.text.replaceAll(/[ \t\r\n]+/g, ''));
  }

  protected declaredIdentifier(node: Node, expected = 'identifier'): string {
    const raw = this.nameText(node);
    const token = reservedIdentifierToken(raw);
    if (token) {
      this.error(node, `syntax error, unexpected token "${token}"${expected ? `, expecting ${expected}` : ''}`);
    }
    return raw;
  }

  protected namedClass(node: Node, expected = '', declaration?: ClassDecl['kind']): string {
    const raw = this.declaredIdentifier(node, expected);
    const relative = relativeClassName(raw);
    if (relative && declaration && !this.preserveSyntax) {
      const spelling = explicitlyQualifiedName(raw) ?? raw;
      this.error(node, `Cannot use "${spelling}" as ${declaration} name, as it is reserved`);
    }
    if (raw.startsWith('\\') && relativeClassName(raw, true)) this.error(node, `'${raw}' is an invalid class name`);
    return this.resolveClassName(raw);
  }

  protected classRef(node: Node, deferScope = false, use: 'name' | 'constant' | 'reference' = 'reference'): ClassRef {
    const isName = node.type === 'name' || node.type === 'qualified_name' || node.type === 'relative_name';
    if (node.type !== 'relative_scope' && !isName) return { k: 'expr', e: this.expr(node) };
    const raw = this.nameText(node);
    const word = relativeClassName(raw, use === 'name');
    if (word) {
      if (this.preserveSyntax) return { k: 'named', name: lower(raw) === 'static' ? 'static' : raw };
      if (use === 'constant' && lower(raw).startsWith('namespace\\'))
        this.error(node, `'${raw}' is an invalid class name`);
      if (!deferScope) this.checkClassScope(node, word);
      return { k: word };
    }
    const name = this.namedClass(node, node.parent?.type === 'object_creation_expression' ? '"class"' : '');
    return { k: 'named', name };
  }

  /**
   * Rejects `self`, `static`, or `parent` where PHP knows at compile time that they name no class: outside a class, or
   * `parent` in a class without one. A closure or the file's own code may run in any class, so PHP checks neither.
   */
  protected checkClassScope(node: Node, word: 'self' | 'static' | 'parent', context = this.fn): void {
    const known =
      !context.isClosure &&
      (this.currentClass === undefined ? context.isFunction === true : this.currentClassKind !== 'trait');
    if (!known) return;
    if (this.currentClass === undefined) {
      this.error(node, `クラスの外では「${word}」を使えません（Cannot use "${word}" when no class scope is active）。`);
    } else if (word === 'parent' && !this.currentClassHasParent) {
      this.error(
        node,
        `親のないクラスでは「parent」を使えません（Cannot use "parent" when current class scope has no parent）。`
      );
    }
  }

  // Statements --------------------------------------------------------------------------------------------------------

  protected variableName(node: Node): string {
    if (node.type === 'variable_name') {
      const name = enc(semanticChildren(node)[0]?.text ?? node.text.replace(/^\$/, ''));
      this.checkVariableAvailability(node, name);
      return name;
    }
    this.error(node, '書き方に誤りがあります。');
  }

  protected checkVariableAvailability(node: Node, name: string): void {
    const unavailable = unavailableVariable(name);
    if (unavailable) this.unsupported(node, unavailable);
  }

  // code-gauge-allow functionNcss -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  protected checkGotos(context: FunctionContext, body: Stmt[]): void {
    interface Location {
      loops: Stmt[];
      finalizers: Stmt[][];
    }
    const locations = new Map<Stmt, Location>();
    const labels = new Map<string, Stmt>();
    const gotos = new Map<number, Stmt>();
    const visit = (statements: Stmt[], location: Location): void => {
      for (const statement of statements) {
        locations.set(statement, location);
        if (statement.k === 'label') labels.set(statement.name, statement);
        if (statement.k === 'goto') gotos.set(statement.offset, statement);
        if (statement.k === 'break' || statement.k === 'continue') {
          const target = location.loops.at(-statement.depth);
          const destination = target && locations.get(target);
          if (destination && location.finalizers.some((fin) => !destination.finalizers.includes(fin))) {
            this.error(statement.row, 'jump out of a finally block is disallowed');
          }
        }
        for (const [nested, isLoop] of nestedBodies(statement)) {
          visit(nested, {
            loops: isLoop ? [...location.loops, statement] : location.loops,
            finalizers:
              statement.k === 'try' && nested === statement.fin
                ? [...location.finalizers, nested]
                : location.finalizers,
          });
        }
      }
    };
    visit(body, { loops: [], finalizers: [] });
    for (const { label, row, offset } of context.gotos) {
      if (!context.labels.has(label))
        this.error(row, `goto の行き先のラベル「${label}」がありません（'goto' to undefined label '${label}'）。`);
      const source = locations.get(gotos.get(offset) as Stmt);
      const destination = locations.get(labels.get(label) as Stmt);
      if (!source || !destination) continue;
      if (source.finalizers.some((fin) => !destination.finalizers.includes(fin)))
        this.error(row, 'jump out of a finally block is disallowed');
      if (destination.finalizers.some((fin) => !source.finalizers.includes(fin)))
        this.error(row, 'jump into a finally block is disallowed');
      if (destination.loops.some((scope) => !source.loops.includes(scope))) {
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

const BARE_KEYWORDS = new Set(
  `__halt_compiler __class__ __dir__ __file__ __function__ __line__ __method__ __namespace__ __property__ __trait__
   abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty
   enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global
   goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private
   protected public readonly require require_once return static switch throw trait try unset use var while xor yield`.split(
    /\s+/
  )
);

export function traitAdaptationModifierError(modifier: string): string | undefined {
  const word = lower(modifier);
  if (word === 'readonly') return 'Cannot use the readonly modifier on a method';
  if (word === 'abstract' || word === 'static') return `Cannot use "${word}" as method modifier in trait alias`;
}

export function reservedIdentifierToken(name: string): string | undefined {
  const word = lower(name);
  if (word === 'die') return 'exit';
  if (!BARE_KEYWORDS.has(word)) return undefined;
  return word.startsWith('__') && word.endsWith('__') ? word.toUpperCase() : word;
}
