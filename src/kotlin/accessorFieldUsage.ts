import type { Accessor } from './ast';

export function accessesBackingField(accessor: Accessor | undefined): boolean {
  return accessor?.parameterName !== 'field' && usesField(accessor?.body);
}

function usesField(part: unknown): boolean {
  if (Array.isArray(part)) return part.some(usesField);
  if (!isNode(part)) return false;
  switch (part.kind) {
    case 'name': {
      return part.name === 'field';
    }
    case 'for': {
      return usesField(part.iterable) || (!bindsField(part.variable) && usesField(part.body));
    }
    case 'try': {
      return (
        usesField(part.body) ||
        usesField(part.finally) ||
        (Array.isArray(part.catches) && part.catches.some((clause) => !bindsField(clause) && usesField(clause)))
      );
    }
  }
  if (Array.isArray(part.statements)) {
    if (Array.isArray(part.params) && part.params.some(bindsField)) return false;
    return statementsUseField(part.statements);
  }
  return Object.values(part).some(usesField);
}

function statementsUseField(statements: unknown[]): boolean {
  for (const statement of statements) {
    if (usesField(statement)) return true;
    if (
      isNode(statement) &&
      (statement.kind === 'property' || statement.kind === 'destructuring') &&
      bindsField(statement)
    )
      return false;
  }
  return false;
}

function bindsField(part: unknown): boolean {
  return isNode(part) && (part.name === 'field' || (Array.isArray(part.names) && part.names.some(bindsField)));
}

function isNode(part: unknown): part is Record<string, unknown> {
  return typeof part === 'object' && part !== null;
}
