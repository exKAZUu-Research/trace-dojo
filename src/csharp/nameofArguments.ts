import type { Expression, TypeNode } from './ast';

/**
 * The argument of `nameof` with each unbound generic name, as `List<>` (C# 14), given `object` type arguments, whose
 * members are the same as the generic type's for the name to bind to.
 */
export function withBoundTypeArguments(expression: Expression): Expression {
  if (expression.kind === 'name') return { ...expression, ...objectTypeArguments(expression) };
  if (expression.kind === 'memberAccess')
    return { ...expression, target: withBoundTypeArguments(expression.target), ...objectTypeArguments(expression) };
  return expression;
}

function objectTypeArguments(node: Expression & { unboundArity?: number }): {
  typeArgs?: TypeNode[];
  unboundArity?: undefined;
} {
  if (node.unboundArity === undefined) return {};
  const object: TypeNode = { kind: 'predefinedType', name: 'object', row: node.row, column: node.column };
  return { typeArgs: Array.from({ length: node.unboundArity }, () => object), unboundArity: undefined };
}
