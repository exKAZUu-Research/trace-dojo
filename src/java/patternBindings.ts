import type { Expression, PatternBinding } from './ast';

/** The pattern variables that `expression` introduces where it is `whenTrue`, as JLS 6.3.1 lists them. */
export function bindingsWhen(expression: Expression, whenTrue: boolean): PatternBinding[] {
  switch (expression.kind) {
    case 'instanceOf': {
      return whenTrue && expression.binding ? [expression.binding] : [];
    }
    case 'unary': {
      return expression.operator === '!' ? bindingsWhen(expression.operand, !whenTrue) : [];
    }
    case 'binary': {
      const { operator } = expression;
      if ((operator === '&&' && whenTrue) || (operator === '||' && !whenTrue)) {
        return [...bindingsWhen(expression.left, whenTrue), ...bindingsWhen(expression.right, whenTrue)];
      }
      return [];
    }
    default: {
      return [];
    }
  }
}
