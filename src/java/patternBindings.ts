import type { Expression, Pattern, PatternBinding } from './ast';

/** The pattern variables that `expression` introduces where it is `whenTrue`, as JLS 6.3.1 lists them. */
export function bindingsWhen(expression: Expression, whenTrue: boolean): PatternBinding[] {
  switch (expression.kind) {
    case 'instanceOf': {
      if (!whenTrue) return [];
      if (expression.pattern) return bindingsOfPattern(expression.pattern);
      return expression.binding ? [expression.binding] : [];
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

/** The variables a pattern declares, including those of the patterns nested in a record pattern. */
export function bindingsOfPattern(pattern: Pattern): PatternBinding[] {
  return pattern.kind === 'typePattern'
    ? [pattern.binding]
    : pattern.components.flatMap((component) => bindingsOfPattern(component));
}
