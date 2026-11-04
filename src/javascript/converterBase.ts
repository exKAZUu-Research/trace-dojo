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
  /** Labels in scope, each with whether it labels a loop. */
  labels: Map<string, boolean>;
  breakableDepth: number;
  loopDepth: number;
  /** Shared by a function and the arrow functions inside it, which read its `arguments`. */
  argumentsUse: { isUsed: boolean };
}

export function newContext(canReturn: boolean, canCallSuper: boolean, canReferenceSuper: boolean): FunctionContext {
  return {
    canReturn,
    canCallSuper,
    canReferenceSuper,
    labels: new Map(),
    breakableDepth: 0,
    loopDepth: 0,
    argumentsUse: { isUsed: false },
  };
}

/** The scopes, steps, and contexts that converting a program tracks, which its early errors depend on. */
export abstract class ConverterBase {
  protected context: FunctionContext = newContext(false, false, false);
  private readonly scopes: ScopeBuilder[] = [];
  private readonly atomicRows: ReadonlySet<number>;
  /** Rows of `// atomic` annotations that a function's header claims. */
  private readonly usedAtomicRows = new Set<number>();

  constructor(
    protected readonly source: string,
    private readonly trace: TraceOptions | undefined
  ) {
    this.atomicRows = trace?.atomicRows ?? new Set();
  }

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

  /** Whether an `// atomic` annotation lies on a function's header, from its first row to its body's. */
  protected claimsAtomicRow(node: Node, bodyNode: Node): boolean {
    let claims = false;
    for (let row = rowOf(node); row <= rowOf(bodyNode); row++) {
      if (!this.atomicRows.has(row)) continue;
      this.usedAtomicRows.add(row);
      claims = true;
    }
    return claims;
  }

  /** Rejects an annotation no function claims, which would silently leave the steps authors meant to hide. */
  protected checkAtomicRows(): void {
    const misplaced = [...this.atomicRows].filter((row) => !this.usedAtomicRows.has(row));
    if (misplaced.length > 0)
      throw new CompileError(misplaced.map((row) => ({ row, message: misplacedAtomicMessage })));
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
