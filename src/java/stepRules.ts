import type { ArrayInitializer, Expression } from './ast';

/** Whether an expression statement only calls methods or creates objects, whose own steps show what it did. */
export function onlyCalls(expression: Expression): boolean {
  // A compound assignment such as `s += new Box()` computes and stores a value after the constructor returns.
  if (expression.kind === 'assign') return expression.operator === '=' && isObjectCreation(expression.value);
  return expression.kind === 'call' || isObjectCreation(expression);
}

/** Whether an expression only creates objects, whose constructors' steps show what creating them did. */
export function isObjectCreation(expression: Expression | ArrayInitializer): boolean {
  if (expression.kind === 'arrayInitializer') return expression.elements.every(isObjectCreation);
  if (expression.kind === 'newArray')
    return expression.initializer !== undefined && isObjectCreation(expression.initializer);
  return expression.kind === 'new';
}
