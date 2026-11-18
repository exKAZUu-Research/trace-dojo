import type { Annotations, LocalVar } from './annotations';
import type { Block, Expr, Pattern } from './ast';
import { forEachDirect, patternBindings, walkBlock } from './astWalk';

/**
 * How rustc's `KnownPanicsLint` propagates a variable's value: through the whole function when it is assigned once,
 * only until the end of its basic block when it is assigned again, and not at all when it is borrowed.
 */
export type PropagationMode = 'full' | 'block' | 'none';

/**
 * The propagation mode of each variable of a body, as rustc's `CanConstProp` decides it: `none` for a variable
 * borrowed (`&x`, an autoref receiver, a formatting macro's argument, a closure's capture by reference) or assigned
 * through a projection (`t.0 = ..`), `block` for one assigned more than once, and `full` otherwise.
 */
export function propagationModes(body: Block, annotations: Annotations): Map<LocalVar, PropagationMode> {
  const uses = new VariableUses(annotations);
  uses.lets(body);
  walkBlock(body, (expr) => uses.visit(expr));
  const modes = new Map<LocalVar, PropagationMode>();
  for (const [local, count] of uses.assignments) modes.set(local, count > 1 ? 'block' : 'full');
  for (const local of uses.borrowed) modes.set(local, 'none');
  return modes;
}

/** How many times a body assigns each variable, and which it borrows. */
class VariableUses {
  readonly assignments = new Map<LocalVar, number>();
  readonly borrowed = new Set<LocalVar>();

  constructor(private readonly annotations: Annotations) {}

  /** The `let`s of a block assign their variables. */
  lets(block: Block): void {
    for (const stmt of block.stmts) {
      if (stmt.kind !== 'let') continue;
      if (stmt.init) this.bindings(stmt.pattern);
      if (stmt.else) this.lets(stmt.else);
    }
  }

  visit(expr: Expr): void {
    this.use(expr);
    for (const block of blocksIn(expr)) this.lets(block);
    forEachDirect(expr, (child) => this.visit(child));
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of use.
  private use(expr: Expr): void {
    switch (expr.kind) {
      case 'ref': {
        this.borrow(expr.operand);
        return;
      }
      case 'assign':
      case 'compoundAssign': {
        // An assignment through a field or an index uses the variable as a projection, which rustc does not follow.
        if (expr.target.kind === 'path') this.assigned(this.rootOf(expr.target));
        else this.borrow(expr.target);
        return;
      }
      case 'methodCall': {
        if ((this.annotations.methods.get(expr)?.receiver.autoref ?? 'none') !== 'none') this.borrow(expr.receiver);
        return;
      }
      case 'macro': {
        for (const arg of borrowedByMacro(expr.macro)) this.borrow(arg);
        return;
      }
      case 'closure': {
        const context = this.annotations.closures.get(expr)?.context;
        if (context && !context.isMove) {
          for (const local of context.captures) if (!context.movedCaptures?.includes(local)) this.borrowed.add(local);
        }
        return;
      }
      default: {
        for (const pattern of patternsIn(expr)) this.bindings(pattern);
      }
    }
  }

  private bindings(pattern: Pattern): void {
    for (const local of patternBindings(pattern, this.annotations)) this.assigned(local);
  }

  private assigned(local: LocalVar | undefined): void {
    if (local) this.assignments.set(local, (this.assignments.get(local) ?? 0) + 1);
  }

  private borrow(expr: Expr): void {
    const local = this.rootOf(expr);
    if (local) this.borrowed.add(local);
  }

  private rootOf(expr: Expr): LocalVar | undefined {
    let current = expr;
    while (current.kind === 'field' || current.kind === 'index') current = current.operand;
    if (current.kind !== 'path') return undefined;
    const res = this.annotations.paths.get(current);
    return res?.kind === 'local' || res?.kind === 'capture' ? res.local : undefined;
  }
}

/** The places a macro borrows: formatting macros' arguments and `assert_eq!`'s operands. */
function borrowedByMacro(macro: Extract<Expr, { kind: 'macro' }>['macro']): Expr[] {
  switch (macro.kind) {
    case 'print':
    case 'format':
    case 'panic':
    case 'write':
    case 'assert': {
      return macro.format?.args ?? [];
    }
    case 'assertEq': {
      return [macro.left, macro.right, ...(macro.format?.args ?? [])];
    }
    default: {
      return [];
    }
  }
}

/** The patterns that bind variables directly in an expression: `match` arms, `if let`, `while let`, `for`. */
function patternsIn(expr: Expr): Pattern[] {
  switch (expr.kind) {
    case 'match': {
      return expr.arms.map((arm) => arm.pattern);
    }
    case 'for': {
      return [expr.pattern];
    }
    case 'if':
    case 'while': {
      return expr.cond.kind === 'let' ? [expr.cond.pattern] : [];
    }
    default: {
      return [];
    }
  }
}

/** The blocks directly in an expression, whose `let`s assign their variables. */
function blocksIn(expr: Expr): Block[] {
  switch (expr.kind) {
    case 'block': {
      return [expr];
    }
    case 'if': {
      return [expr.consequent];
    }
    case 'while':
    case 'loop':
    case 'for': {
      return [expr.body];
    }
    default: {
      return [];
    }
  }
}
