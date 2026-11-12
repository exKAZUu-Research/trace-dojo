import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { misplacedAtomicMessage, type TraceOptions } from '../interpreter/traceAnnotations';
import type { ClassNode, Expression, FunctionKind, FunctionNode, ScopeDeclarations } from './ast';
import { fail, rowOf } from './convertNodes';

interface ScopeBuilder {
  declarations: ScopeDeclarations;
  /** Each declared name with how it was declared, which decides whether it may be declared again. */
  names: Map<string, 'lexical' | 'var' | 'parameter'>;
  isFunction: boolean;
}

export interface FunctionContext {
  canReturn: boolean;
  canCallSuper: boolean;
  canReferenceSuper: boolean;
  /** Whether `yield` may appear, in the body of a generator function. */
  isGenerator: boolean;
  /** The `yield` expressions converted so far in this function, which tell the expressions around one apart. */
  yieldCount: number;
  /** Whether `new.target` may appear: anywhere but outside every function, which arrow functions inherit. */
  canUseNewTarget: boolean;
  /** Labels in scope, each with whether it labels a loop. */
  labels: Map<string, boolean>;
  breakableDepth: number;
  loopDepth: number;
  /**
   * Shared by a function and the arrow functions inside it, which read its `arguments`; a field initializer or a
   * static block forbids reading it.
   */
  argumentsUse: { isUsed: boolean; isForbidden?: boolean };
}

/** The context of a class field initializer or a static block, where `this` is the instance or the class. */
export function initializerContext(): FunctionContext {
  return { ...newContext(false, false, true), argumentsUse: { isUsed: false, isForbidden: true } };
}

export function newContext(canReturn: boolean, canCallSuper: boolean, canReferenceSuper: boolean): FunctionContext {
  return {
    canReturn,
    canCallSuper,
    canReferenceSuper,
    canUseNewTarget: true,
    isGenerator: false,
    yieldCount: 0,
    labels: new Map(),
    breakableDepth: 0,
    loopDepth: 0,
    argumentsUse: { isUsed: false },
  };
}

interface ConvertedFunction {
  fn: FunctionNode;
  /** The rows of its header, from its start to its body's start. */
  row: number;
  bodyRow: number;
  startIndex: number;
  endIndex: number;
  bodyStartIndex: number;
}

/** The scopes, steps, and contexts that converting a program tracks, which its early errors depend on. */
export abstract class ConverterBase {
  protected context: FunctionContext = {
    ...newContext(false, false, false),
    canUseNewTarget: false,
  };
  private readonly scopes: ScopeBuilder[] = [];
  /** The functions converted so far, among which the annotations find their owners once the program is converted. */
  private readonly functions: ConvertedFunction[] = [];

  constructor(
    protected readonly source: string,
    private readonly trace: TraceOptions | undefined
  ) {}

  abstract expression(node: Node): Expression;

  abstract functionNode(node: Node, kind: FunctionKind, name?: string): FunctionNode;

  abstract classNode(node: Node, name: string): ClassNode;

  protected sourceOf(node: Node): string {
    return this.source.slice(node.startIndex, node.endIndex);
  }

  // Steps -----------------------------------------------------------------------------------------------------------

  /** The row whose step a statement starting at `node` records, when the program is converted for tracing. */
  protected stepRowOf(node: Node): number | undefined {
    return this.trace ? rowOf(node) : undefined;
  }

  protected addFunction(node: Node, bodyNode: Node, fn: FunctionNode): void {
    this.functions.push({
      fn,
      row: rowOf(node),
      bodyRow: rowOf(bodyNode),
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      bodyStartIndex: bodyNode.startIndex,
    });
  }

  /**
   * Marks the function each `// atomic` annotation belongs to, rejecting one that belongs to none. The owner's header,
   * from its start to its body's row, holds the annotation outside any function nested in it; among such headers on
   * one row, the annotation follows the opening of the body it annotates, so the latest body opened before it wins,
   * and otherwise the innermost header continuing past it.
   */
  protected assignAtomicAnnotations(): void {
    const misplaced: number[] = [];
    for (const [row, index] of this.trace?.atomicAnnotations ?? []) {
      const owner = this.ownerOf(row, index);
      if (owner) owner.fn.isAtomic = true;
      else misplaced.push(row);
    }
    if (misplaced.length > 0)
      throw new CompileError(misplaced.map((row) => ({ row, message: misplacedAtomicMessage })));
  }

  private ownerOf(row: number, index: number): ConvertedFunction | undefined {
    const candidates = this.functions.filter(
      (fn) => fn.row <= row && row <= fn.bodyRow && fn.startIndex <= index && !this.nestsFunctionAt(fn, index)
    );
    const opened = candidates.filter((fn) => fn.bodyStartIndex <= index);
    return (
      opened.toSorted((a, b) => b.bodyStartIndex - a.bodyStartIndex)[0] ??
      candidates.toSorted((a, b) => b.startIndex - a.startIndex)[0]
    );
  }

  /** Whether a function nested in `outer` spans the offset `index`. */
  private nestsFunctionAt(outer: ConvertedFunction, index: number): boolean {
    return this.functions.some(
      (inner) =>
        outer.startIndex < inner.startIndex &&
        inner.endIndex <= outer.endIndex &&
        inner.startIndex <= index &&
        index < inner.endIndex
    );
  }

  // Scopes ----------------------------------------------------------------------------------------------------------

  protected pushScope(isFunction: boolean): ScopeDeclarations {
    const declarations: ScopeDeclarations = { lexical: [], functions: [], vars: [], order: [] };
    this.scopes.push({ declarations, names: new Map(), isFunction });
    return declarations;
  }

  protected popScope(): void {
    this.scopes.pop();
  }

  protected withScope<T>(convert: (scope: ScopeDeclarations) => T): T {
    const scope = this.pushScope(false);
    try {
      return convert(scope);
    } finally {
      this.popScope();
    }
  }

  /** Runs `convert` in the context of a function body, restoring the enclosing context afterward. */
  protected withContext<T>(context: FunctionContext, convert: () => T): T {
    const outer = this.context;
    this.context = context;
    try {
      return convert();
    } finally {
      this.context = outer;
    }
  }

  private get currentScope(): ScopeBuilder {
    return this.scopes.at(-1) as ScopeBuilder;
  }

  protected declareLexical(node: Node, name: string, isConst: boolean): void {
    const scope = this.currentScope;
    if (scope.names.has(name)) duplicate(node, name);
    scope.names.set(name, 'lexical');
    scope.declarations.lexical.push({ name, isConst });
    scope.declarations.order.push(name);
  }

  protected declareVar(node: Node, name: string): void {
    for (const scope of this.scopes.toReversed()) {
      if (scope.names.get(name) === 'lexical') duplicate(node, name);
      if (!scope.isFunction) {
        // Recorded in each block it passes through, so a later let or const of the name there is a duplicate too.
        scope.names.set(name, 'var');
        continue;
      }
      if (!scope.names.has(name)) {
        scope.names.set(name, 'var');
        scope.declarations.vars.push(name);
        scope.declarations.order.push(name);
      }
      return;
    }
  }

  protected declareFunction(node: Node, fn: FunctionNode): void {
    const scope = this.currentScope;
    const previous = scope.names.get(fn.name);
    // At the top of a function, a function declaration may repeat a `var` or another function.
    if (previous && (previous === 'lexical' || !scope.isFunction)) duplicate(node, fn.name);
    scope.names.set(fn.name, scope.isFunction ? 'var' : 'lexical');
    scope.declarations.functions.push(fn);
    if (!previous) scope.declarations.order.push(fn.name);
  }

  protected declareParameter(node: Node, name: string): void {
    const scope = this.currentScope;
    if (scope.names.has(name)) duplicate(node, name);
    scope.names.set(name, 'parameter');
  }

  /** Declares a name of a `var`, `let`, or `const` declaration. */
  protected declareVariable(node: Node, name: string, kind: 'var' | 'let' | 'const'): void {
    if (kind === 'var') this.declareVar(node, name);
    else this.declareLexical(node, name, kind === 'const');
  }
}

function duplicate(node: Node, name: string): never {
  return fail(node, `${name} はすでに宣言されています。`);
}
