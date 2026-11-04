import type { Expression, VariableDeclaration } from './ast';

/** Whether an expression statement only calls functions or creates objects, whose own steps show what it did. */
export function onlyCalls(expression: Expression): boolean {
  const inner = withoutParentheses(expression);
  // A compound assignment such as `s += new Box()` computes and stores a value after the constructor returns.
  if (inner.kind === 'assign') return inner.operator === '=' && isObjectCreation(inner.value);
  return inner.kind === 'call' || isObjectCreation(inner);
}

/** Whether a declaration only creates objects, whose constructors' steps show what it did. */
export function onlyCreates({ declarators }: VariableDeclaration): boolean {
  return declarators.every(({ init }) => !init || isObjectCreation(init));
}

/** Whether an expression only creates objects, whose constructors' steps show what creating them did. */
export function isObjectCreation(expression: Expression): boolean {
  const inner = withoutParentheses(expression);
  if (inner.kind === 'array')
    return inner.elements.every(
      (element) => element?.kind !== 'spread' && element !== undefined && isObjectCreation(element)
    );
  return inner.kind === 'new';
}

/** The expression inside any parentheses, which Java's parser drops and so never classifies. */
function withoutParentheses(expression: Expression): Expression {
  return expression.kind === 'parenthesized' ? withoutParentheses(expression.expression) : expression;
}

/** Whether an expression combines only literals, as a Java constant expression does, so evaluating it has no effect. */
export function isConstantExpression(expression: Expression): boolean {
  switch (expression.kind) {
    case 'literal': {
      return true;
    }
    case 'template': {
      return expression.expressions.every(isConstantExpression);
    }
    case 'parenthesized': {
      return isConstantExpression(expression.expression);
    }
    case 'unary': {
      return ['-', '+', '!', '~'].includes(expression.operator) && isConstantExpression(expression.argument);
    }
    case 'binary': {
      return (
        !['in', 'instanceof'].includes(expression.operator) &&
        isConstantExpression(expression.left) &&
        isConstantExpression(expression.right)
      );
    }
    case 'logical': {
      return isConstantExpression(expression.left) && isConstantExpression(expression.right);
    }
    case 'conditional': {
      return [expression.test, expression.consequent, expression.alternate].every(isConstantExpression);
    }
    default: {
      return false;
    }
  }
}
