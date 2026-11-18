import type { Expr } from './ast';

export function constantAstRow(expression: Expr): number {
  for (;;) {
    switch (expression.k) {
      case 'bin': {
        expression = expression.l;
        break;
      }
      case 'cond': {
        expression = expression.test;
        break;
      }
      case 'idx': {
        expression = expression.base;
        break;
      }
      case 'prop': {
        expression = expression.obj;
        break;
      }
      case 'array': {
        return expression.initializerRow ?? expression.row;
      }
      case 'cconst': {
        return expression.scopeRow ?? expression.row;
      }
      default: {
        return expression.row;
      }
    }
  }
}

export function compiledOperandRow(expression: Expr): number {
  for (;;) {
    const last = lastCompiledOperand(expression);
    if (!last) return expression.row;
    expression = last;
  }
}

export function dimensionWriteRow(dimension: Extract<Expr, { k: 'idx' }>): number {
  return compiledOperandRow(dimension.index ?? dimension.base);
}

// code-gauge-allow functionNcss 31 -- Keeps the compiler operand order in one dispatch over AST expressions.
function lastCompiledOperand(expression: Expr): Expr | undefined {
  switch (expression.k) {
    case 'array': {
      return expression.items[0]?.value;
    }
    case 'idx': {
      return expression.index ?? expression.base;
    }
    case 'prop':
    case 'sprop':
    case 'cconst': {
      return typeof expression.name === 'string' ? undefined : expression.name;
    }
    case 'call':
    case 'mcall':
    case 'scall':
    case 'new':
    case 'newAnon': {
      return expression.args.at(-1)?.e;
    }
    case 'cast':
    case 'clone':
    case 'empty':
    case 'print':
    case 'silence':
    case 'throw':
    case 'unary': {
      return expression.e;
    }
    case 'bin':
    case 'pipe': {
      return expression.r;
    }
    case 'cond': {
      return expression.alternate;
    }
    default: {
      return undefined;
    }
  }
}
