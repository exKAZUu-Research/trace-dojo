import { fieldOf, hasToken, type Syntax } from './syntax';

/** Whether an expression statement only calls functions or creates or destroys objects, whose own steps show what it did. */
export function onlyCalls(expression: Syntax): boolean {
  if (expression.type === 'parenthesized_expression' && expression.children[0])
    return onlyCalls(expression.children[0]);
  if (expression.type === 'assignment_expression') {
    // A compound assignment such as `s += f()` computes and stores a value after the call returns.
    const right = fieldOf(expression, 'right');
    return hasToken(expression, '=') && right !== undefined && isObjectCreation(right);
  }
  return (
    expression.type === 'call_expression' || expression.type === 'delete_expression' || isObjectCreation(expression)
  );
}

/**
 * Whether an expression only creates objects with `new` (or is a braced list of such), whose constructors' steps
 * show what creating them did.
 */
export function isObjectCreation(expression: Syntax): boolean {
  if (expression.type === 'initializer_list')
    return expression.children.length > 0 && expression.children.every(isObjectCreation);
  return expression.type === 'new_expression';
}
