import type { Expression, Statement } from './ast';

/** A conservative version of Java's reachability rule for a method body's end. */
export function canCompleteNormally(statement: Statement): boolean {
  switch (statement.kind) {
    case 'return':
    case 'throw':
    case 'break':
    case 'continue': {
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
      const { body, label } = statement;
      const bodyCompletes =
        body.kind === 'while' || body.kind === 'do' || body.kind === 'for'
          ? loopCanCompleteNormally(body, label)
          : canCompleteNormally(body);
      return bodyCompletes || containsJump(body, 'break', label);
    }
    default: {
      return true;
    }
  }
}

/** @param label The label written before the loop, which its `continue` statements may name. */
function loopCanCompleteNormally(
  statement: Extract<Statement, { kind: 'while' | 'do' | 'for' }>,
  label?: string
): boolean {
  if (containsJump(statement.body, 'break')) return true;
  // A for statement without a condition loops as if its condition were true.
  const runsForever = statement.condition === undefined || booleanConstants.get(statement.condition) === true;
  if (runsForever) return false;
  if (statement.kind !== 'do') return true;
  // A do statement reaches its condition after its body or through a continue.
  return (
    canCompleteNormally(statement.body) ||
    containsJump(statement.body, 'continue') ||
    (label !== undefined && containsJump(statement.body, 'continue', label))
  );
}

function switchCanCompleteNormally(statement: Extract<Statement, { kind: 'switch' }>): boolean {
  const hasDefault = statement.groups.some((group) => group.labels.includes(undefined));
  if (!hasDefault) return true;
  if (statement.groups.some((group) => group.statements.some((child) => containsJump(child, 'break')))) return true;
  if (statement.isArrowForm) {
    return statement.groups.some((group) => group.statements.every((child) => canCompleteNormally(child)));
  }
  const last = statement.groups.at(-1);
  return !last || last.statements.every((child) => canCompleteNormally(child));
}

/** The values of the boolean constant expressions compiled so far, which decide reachability in Java. */
export const booleanConstants = new WeakMap<Expression, boolean>();

/**
 * Whether `statement` contains a `break` that exits it or a `continue` that continues it: unlabeled outside nested
 * loops (and, for `break`, nested switch statements), or naming `label`.
 */
function containsJump(statement: Statement, kind: 'break' | 'continue', label?: string, depth = 0): boolean {
  const inside = (child: Statement, childDepth = depth): boolean => containsJump(child, kind, label, childDepth);
  switch (statement.kind) {
    case 'break':
    case 'continue': {
      if (statement.kind !== kind) return false;
      return label === undefined ? statement.label === undefined && depth === 0 : statement.label === label;
    }
    case 'block': {
      return statement.statements.some((child) => inside(child));
    }
    case 'if': {
      return inside(statement.consequence) || (!!statement.alternative && inside(statement.alternative));
    }
    case 'while':
    case 'do':
    case 'for':
    case 'forEach': {
      return inside(statement.body, depth + 1);
    }
    case 'switch': {
      // A continue in a switch statement continues the enclosing loop.
      const switchDepth = kind === 'break' ? depth + 1 : depth;
      return statement.groups.some((group) => group.statements.some((child) => inside(child, switchDepth)));
    }
    case 'labeled': {
      return inside(statement.body);
    }
    case 'try': {
      return (
        inside(statement.body) ||
        statement.catches.some((clause) => inside(clause.body)) ||
        (!!statement.finallyBlock && inside(statement.finallyBlock))
      );
    }
    default: {
      return false;
    }
  }
}
