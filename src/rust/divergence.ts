import type { Expr, MacroCall } from './ast';
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

/** The operands a macro always evaluates: not the message of an assertion, which only its failure formats. */
function macroOperands(macro: MacroCall): Expr[] {
  switch (macro.kind) {
    case 'print':
    case 'format':
    case 'panic': {
      return macro.format?.args ?? [];
    }
    case 'write': {
      return [macro.target, ...(macro.format?.args ?? [])];
    }
    case 'assert': {
      return [macro.cond];
    }
    case 'assertEq': {
      return [macro.left, macro.right];
    }
    case 'vec': {
      return macro.elems;
    }
    case 'vecRepeat': {
      return [macro.value, macro.count];
    }
    case 'matches': {
      return [macro.value];
    }
    case 'dbg': {
      return macro.args;
    }
  }
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
    case 'arrayRepeat': {
      return [expr.value, expr.count];
    }
    case 'struct': {
      return [...expr.fields.map((field) => field.value), ...(expr.base ? [expr.base] : [])];
    }
    case 'macro': {
      return macroOperands(expr.macro);
    }
    default: {
      return [];
    }
  }
}
