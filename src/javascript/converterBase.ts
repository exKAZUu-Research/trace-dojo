import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { ClassNode, Expression, FunctionKind, FunctionNode, ScopeDeclarations } from './ast';
import { depthOf, fail } from './convertNodes';

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
}

/** Where a construct lies: its rows, and its offsets, which order constructs on one row. */
interface Extent {
  row: number;
  endRow: number;
  start: number;
  end: number;
}

interface Steppable extends Extent {
  depth: number;
  assign: (stepId: number) => void;
}

function extentOf(node: Node): Extent {
  return { row: node.startPosition.row, endRow: node.endPosition.row, start: node.startIndex, end: node.endIndex };
}

function encloses(outer: Extent, inner: Extent): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

export function newContext(canReturn: boolean, canCallSuper: boolean, canReferenceSuper: boolean): FunctionContext {
  return { canReturn, canCallSuper, canReferenceSuper, labels: new Map(), breakableDepth: 0, loopDepth: 0 };
}

/** The scopes, steps, and contexts that converting a program tracks, which its early errors depend on. */
export abstract class ConverterBase {
  protected context: FunctionContext = newContext(false, false, false);
  private readonly scopes: ScopeBuilder[] = [];
  private readonly steppables: Steppable[] = [];
  /** Function bodies, whose rows belong to the statements of that body. */
  private readonly bodies: Extent[] = [];

  constructor(
    protected readonly source: string,
    private readonly stepIdByRow: ReadonlyMap<number, number>
  ) {}

  abstract expression(node: Node): Expression;

  abstract functionNode(node: Node, kind: FunctionKind, name?: string): FunctionNode;

  abstract classNode(node: Node, name: string): ClassNode;

  protected sourceOf(node: Node): string {
    return this.source.slice(node.startIndex, node.endIndex);
  }

  // Steps -----------------------------------------------------------------------------------------------------------

  /**
   * Lets a statement record the step of a `// step` row it spans.
   *
   * @param depthOffset Moves the statement's depth, for header parts that record steps as their loop's body does.
   */
  protected addSteppable(node: Node, assign: (stepId: number) => void, depthOffset = 0): void {
    this.steppables.push({ ...extentOf(node), depth: depthOf(node) + depthOffset, assign });
  }

  protected addBody(body: Node): void {
    this.bodies.push(extentOf(body));
  }

  /**
   * Gives each `// step` row to the innermost statements on it, where the rows inside a function body belong to the
   * statements of that body, and a body on the step row alone belongs to the statement containing the function.
   */
  protected assignSteps(): void {
    for (const [row, stepId] of this.stepIdByRow) {
      const onRow = this.steppables.filter((steppable) => steppable.row <= row && row <= steppable.endRow);
      const candidates = onRow.filter(
        (steppable) =>
          !this.isInNestedBody(steppable, row) &&
          !this.bodies.some(
            (body) =>
              body.row === row &&
              body.endRow === row &&
              encloses(body, steppable) &&
              onRow.some((outer) => encloses(outer, body))
          )
      );
      if (candidates.length === 0) {
        throw new CompileError([
          {
            row,
            message: '// step は、式文、初期値のある変数宣言やフィールド、return 文、for 文の行に付けてください。',
          },
        ]);
      }
      let depth = 0;
      for (const candidate of candidates) depth = Math.max(depth, candidate.depth);
      for (const candidate of candidates) if (candidate.depth === depth) candidate.assign(stepId);
    }
  }

  private isInNestedBody(steppable: Steppable, row: number): boolean {
    return this.bodies.some((body) => encloses(steppable, body) && body.row < row && row < body.endRow);
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
      if (!scope.isFunction) continue;
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
