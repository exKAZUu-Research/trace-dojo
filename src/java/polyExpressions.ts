import type { Expression, Statement } from './ast';

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
  return statements.flatMap((statement): Expression[] => {
    switch (statement.kind) {
      case 'yield': {
        return [statement.value];
      }
      case 'block': {
        return yieldedValues(statement.statements);
      }
      case 'if': {
        return yieldedValues(
          statement.alternative ? [statement.consequence, statement.alternative] : [statement.consequence]
        );
      }
      case 'while':
      case 'do':
      case 'for':
      case 'forEach':
      case 'labeled': {
        return yieldedValues([statement.body]);
      }
      case 'synchronized': {
        return yieldedValues(statement.body.statements);
      }
      case 'try': {
        const blocks = [
          statement.body,
          ...statement.catches.map((clause) => clause.body),
          ...(statement.finallyBlock ? [statement.finallyBlock] : []),
        ];
        return blocks.flatMap((block) => yieldedValues(block.statements));
      }
      case 'switch': {
        return statement.groups.flatMap((group) => yieldedValues(group.statements));
      }
      default: {
        return [];
      }
    }
  });
}
