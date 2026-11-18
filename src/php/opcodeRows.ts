import type { Expr } from './ast';

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

function lastCompiledOperand(expression: Expr): Expr | undefined {
  switch (expression.k) {
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
