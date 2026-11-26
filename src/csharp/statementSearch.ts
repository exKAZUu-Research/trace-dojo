import type { Statement } from './ast';

/**
 * Whether a statement, or a statement nested in it in the same function, passes a test. A local function is a
 * function of its own, so the search does not enter one.
 */
export function anyStatement(statement: Statement, test: (statement: Statement) => boolean): boolean {
  if (test(statement)) return true;
  const visit = (inner: Statement): boolean => anyStatement(inner, test);
  switch (statement.kind) {
    case 'block': {
      return statement.statements.some(visit);
    }
    case 'if': {
      return visit(statement.consequence) || (statement.alternative !== undefined && visit(statement.alternative));
    }
    case 'while':
    case 'do':
    case 'for':
    case 'foreach':
    case 'lock':
    case 'using':
    case 'checked': {
      return visit(statement.body);
    }
    case 'labeled': {
      return visit(statement.statement);
    }
    case 'switch': {
      return statement.sections.some((section) => section.statements.some(visit));
    }
    case 'try': {
      return (
        visit(statement.body) ||
        statement.catches.some((clause) => visit(clause.body)) ||
        (statement.finally !== undefined && visit(statement.finally))
      );
    }
    default: {
      return false;
    }
  }
}
