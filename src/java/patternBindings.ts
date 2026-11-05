import { type Expression, type Pattern, type PatternBinding, type Statement, UNNAMED } from './ast';
import { breaksOut, canCompleteNormally } from './reachability';

/**
 * The pattern variables that stay in scope after `statement` (JLS 6.3.2): those of an `if` condition's other outcome
 * when a branch cannot complete normally, and those of a loop condition when false when no `break` in the body targets
 * the loop or a statement enclosing it.
 */
export function bindingsAfter(statement: Statement): PatternBinding[] {
  switch (statement.kind) {
    case 'if': {
      const { condition, consequence, alternative } = statement;
      return [
        ...(canCompleteNormally(consequence) ? [] : bindingsWhen(condition, false)),
        ...(alternative && !canCompleteNormally(alternative) ? bindingsWhen(condition, true) : []),
      ];
    }
    case 'while':
    case 'do':
    case 'for': {
      const { body, condition } = statement;
      return condition && !breaksOut(body) ? bindingsWhen(condition, false) : [];
    }
    default: {
      return [];
    }
  }
}

/** The pattern variables that `expression` introduces where it is `whenTrue`, as JLS 6.3.1 lists them. */
export function bindingsWhen(expression: Expression, whenTrue: boolean): PatternBinding[] {
  switch (expression.kind) {
    case 'instanceOf': {
      if (!whenTrue) return [];
      if (expression.pattern) return bindingsOfPattern(expression.pattern);
      return expression.binding && expression.binding.name !== UNNAMED ? [expression.binding] : [];
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
  if (pattern.kind === 'typePattern') return pattern.binding.name === UNNAMED ? [] : [pattern.binding];
  return pattern.components.flatMap((component) => bindingsOfPattern(component));
}
