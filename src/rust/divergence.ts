import type { Expr } from './ast';
import { shallow } from './types';

/**
 * Whether evaluating an expression surely evaluates one that never finishes, whatever the expression's own type is:
 * `n = panic!()` and `println!("{}", todo!())` are of type `()` but never complete. Only operands that are always
 * evaluated count, so branches, the right of `&&` and `||`, loops, closures, and an assertion's message do not.
 */
export function neverCompletes(expr: Expr): boolean {
  if (expr.ty && shallow(expr.ty).kind === 'never') return true;
  return requiredOperands(expr).some(neverCompletes);
}

function requiredOperands(expr: Expr): Expr[] {
  switch (expr.kind) {
    case 'unary':
    case 'ref':
    case 'cast':
    case 'try':
    case 'field': {
      return [expr.operand];
    }
    case 'binary': {
      return expr.op === '&&' || expr.op === '||' ? [expr.left] : [expr.left, expr.right];
    }
    case 'assign':
    case 'compoundAssign': {
      return [expr.value, expr.target];
    }
    case 'index': {
      return [expr.operand, expr.index];
    }
    case 'call': {
      return [expr.callee, ...expr.args];
    }
    case 'methodCall': {
      return [expr.receiver, ...expr.args];
    }
    case 'tuple':
    case 'array': {
      return expr.elems;
    }
    case 'macro': {
      const { macro } = expr;
      return macro.kind === 'print' || macro.kind === 'format' ? (macro.format?.args ?? []) : [];
    }
    default: {
      return [];
    }
  }
}
