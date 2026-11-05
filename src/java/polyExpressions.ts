import type { Block, Expression, Statement } from './ast';
import { canCompleteNormally, nestedStatements } from './reachability';

/**
 * Whether a call or creation passes an argument whose type its target may decide: an implicitly typed lambda, or a
 * generic call such as `Comparator.reverseOrder()` in `comparingByValue(Comparator.reverseOrder())`, directly or
 * through such a call, so that the call waits for its own target when it cannot be typed alone.
 */
export function passesPolyArgument(expression: Expression): boolean {
  if (expression.kind !== 'call' && expression.kind !== 'new') return false;
  return expression.args.some(
    (arg) =>
      (arg.kind === 'lambda' && arg.parameters.some((parameter) => !parameter.type)) ||
      arg.kind === 'call' ||
      arg.kind === 'new' ||
      passesPolyArgument(arg)
  );
}

/**
 * Whether a conditional or switch expression may result in a lambda or method reference, which only a target type
 * types: a conditional's operands, or the values its switch yields, directly or through such expressions.
 */
export function resultsInFunction(expression: Expression): boolean {
  switch (expression.kind) {
    case 'lambda':
    case 'methodRef': {
      return true;
    }
    case 'conditional': {
      return resultsInFunction(expression.consequence) || resultsInFunction(expression.alternative);
    }
    case 'switchExpression': {
      return expression.groups.some((group) =>
        yieldedValues(group.statements).some((value) => resultsInFunction(value))
      );
    }
    default: {
      return false;
    }
  }
}

/** The values the `yield` statements among `statements` give, outside the switch expressions nested in them. */
function yieldedValues(statements: readonly Statement[]): Expression[] {
  return statements.flatMap((statement) =>
    statement.kind === 'yield' ? [statement.value] : yieldedValues(nestedStatements(statement))
  );
}

/**
 * Where a lambda body may stand (JLS 15.27.2), as a void function's body and as a value-returning function's, and
 * whether its parameters' types are known, written or none.
 */
export interface LambdaShape {
  inVoid: boolean;
  inValue: boolean;
  isExplicit: boolean;
}

export function lambdaShapeOf(expression: Extract<Expression, { kind: 'lambda' }>): LambdaShape {
  const isExplicit = expression.parameters.every((parameter) => parameter.type !== undefined);
  return { ...lambdaResults(expression.body), isExplicit };
}

/**
 * The shape of a lambda's body: an expression may return a value and, when it is a statement expression, be run for
 * its effect; a block returns a value when every `return` has one and it cannot complete normally, and suits a void
 * function when no `return` has one.
 */
function lambdaResults(body: Expression | Block): Omit<LambdaShape, 'isExplicit'> {
  if (body.kind !== 'block') return { inVoid: isStatementExpression(body), inValue: true };
  const returns = returnsOf(body.statements);
  return {
    inVoid: returns.every((statement) => statement.value === undefined),
    inValue: !canCompleteNormally(body) && returns.every((statement) => statement.value !== undefined),
  };
}

function isStatementExpression(expression: Expression): boolean {
  return ['call', 'new', 'assign', 'update'].includes(expression.kind);
}

/** The `return` statements among `statements`, outside the lambdas and classes nested in them. */
function returnsOf(statements: readonly Statement[]): Extract<Statement, { kind: 'return' }>[] {
  return statements.flatMap((statement) =>
    statement.kind === 'return' ? [statement] : returnsOf(nestedStatements(statement))
  );
}

/** Whether a call passes a lambda, a method reference, or an anonymous class, which compiling it again would repeat. */
export function passesFunction(node: unknown): boolean {
  if (Array.isArray(node)) return node.some((child) => passesFunction(child));
  if (typeof node !== 'object' || node === null) return false;
  const { kind, body } = node as { kind?: string; body?: unknown };
  if (kind === 'lambda' || kind === 'methodRef' || kind === 'switchExpression' || (kind === 'new' && body)) return true;
  return Object.values(node).some((child) => passesFunction(child));
}
