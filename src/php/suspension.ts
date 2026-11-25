import type { Expr, Stmt } from './ast';
import { nestedBodies } from './astAnalysis';

const suspendingExpressions = new WeakMap<Expr, boolean>();

/** Whether an expression contains a `yield` of the function it belongs to, outside nested functions. */
export function suspends(e: Expr): boolean {
  let cached = suspendingExpressions.get(e);
  if (cached === undefined) {
    cached =
      e.k === 'yield' ||
      e.k === 'yieldFrom' ||
      (e.k !== 'lit' && e.k !== 'held' && e.k !== 'closure' && e.k !== 'arrow' && partsSuspend(e));
    suspendingExpressions.set(e, cached);
  }
  return cached;
}

function partsSuspend(node: object): boolean {
  for (const [key, value] of Object.entries(node)) {
    // An anonymous class's body belongs to its methods.
    if (!value || typeof value !== 'object' || key === 'decl') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === 'object' && nodeSuspends(item as object)) return true;
    } else if (nodeSuspends(value as object)) return true;
  }
  return false;
}

function nodeSuspends(node: object): boolean {
  return 'k' in node && 'row' in node ? suspends(node as Expr) : partsSuspend(node);
}

/** Marks the statements of a generator's body whose own expressions, or loop headers, contain a `yield`. */
export function markSuspendingStatements(body: Stmt[]): void {
  for (const statement of body) {
    if (ownExpressions(statement).some(suspends)) statement.suspends = true;
    for (const [nested] of nestedBodies(statement)) markSuspendingStatements(nested);
  }
}

function ownExpressions(statement: Stmt): Expr[] {
  switch (statement.k) {
    case 'expr': {
      return [statement.e];
    }
    case 'echo': {
      return statement.args;
    }
    case 'unset': {
      return statement.targets;
    }
    case 'return': {
      return statement.e ? [statement.e] : [];
    }
    case 'if':
    case 'while':
    case 'do': {
      return [statement.cond];
    }
    case 'for': {
      return [...statement.init, ...statement.cond, ...statement.update];
    }
    case 'foreach': {
      return [statement.subject];
    }
    case 'switch': {
      return [statement.subject, ...statement.cases.flatMap((item) => (item.test ? [item.test] : []))];
    }
    case 'static': {
      return statement.vars.flatMap((item) => (item.init ? [item.init] : []));
    }
    default: {
      return [];
    }
  }
}
