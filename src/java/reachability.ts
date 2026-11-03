import type { Expression, Statement } from './ast';

/** A conservative version of Java's reachability rule for a method body's end. */
export function canCompleteNormally(statement: Statement): boolean {
  switch (statement.kind) {
    case 'return':
    case 'throw': {
      return false;
    }
    case 'block': {
      return statement.statements.every((child) => canCompleteNormally(child));
    }
    case 'if': {
      return (
        !statement.alternative ||
        canCompleteNormally(statement.consequence) ||
        canCompleteNormally(statement.alternative)
      );
    }
    case 'while':
    case 'do':
    case 'for': {
      return loopCanCompleteNormally(statement);
    }
    case 'try': {
      if (statement.finallyBlock && !canCompleteNormally(statement.finallyBlock)) return false;
      return (
        canCompleteNormally(statement.body) || statement.catches.some((clause) => canCompleteNormally(clause.body))
      );
    }
    case 'switch': {
      return switchCanCompleteNormally(statement);
    }
    case 'labeled': {
      return canCompleteNormally(statement.body) || containsBreak(statement.body, statement.label);
    }
    default: {
      return true;
    }
  }
}

function loopCanCompleteNormally(statement: Extract<Statement, { kind: 'while' | 'do' | 'for' }>): boolean {
  if (containsBreak(statement.body)) return true;
  // A for statement without a condition loops as if its condition were true.
  const runsForever = statement.condition === undefined || booleanConstants.get(statement.condition) === true;
  return !runsForever && (statement.kind !== 'do' || canCompleteNormally(statement.body));
}

function switchCanCompleteNormally(statement: Extract<Statement, { kind: 'switch' }>): boolean {
  const hasDefault = statement.groups.some((group) => group.labels.includes(undefined));
  if (!hasDefault) return true;
  if (statement.groups.some((group) => group.statements.some((child) => containsBreak(child)))) return true;
  if (statement.isArrowForm) {
    return statement.groups.some((group) => group.statements.every((child) => canCompleteNormally(child)));
  }
  const last = statement.groups.at(-1);
  return !last || last.statements.every((child) => canCompleteNormally(child));
}

/** The values of the boolean constant expressions compiled so far, which decide reachability in Java. */
export const booleanConstants = new WeakMap<Expression, boolean>();

/** Whether `statement` contains a `break` that exits it (unlabeled at loop level, or to `label`). */
function containsBreak(statement: Statement, label?: string, depth = 0): boolean {
  switch (statement.kind) {
    case 'break': {
      return label === undefined ? statement.label === undefined && depth === 0 : statement.label === label;
    }
    case 'block': {
      return statement.statements.some((child) => containsBreak(child, label, depth));
    }
    case 'if': {
      return (
        containsBreak(statement.consequence, label, depth) ||
        (!!statement.alternative && containsBreak(statement.alternative, label, depth))
      );
    }
    case 'while':
    case 'do':
    case 'for':
    case 'forEach': {
      return containsBreak(statement.body, label, depth + 1);
    }
    case 'switch': {
      return statement.groups.some((group) => group.statements.some((child) => containsBreak(child, label, depth + 1)));
    }
    case 'labeled': {
      return containsBreak(statement.body, label, depth);
    }
    case 'try': {
      return (
        containsBreak(statement.body, label, depth) ||
        statement.catches.some((clause) => containsBreak(clause.body, label, depth)) ||
        (!!statement.finallyBlock && containsBreak(statement.finallyBlock, label, depth))
      );
    }
    default: {
      return false;
    }
  }
}
