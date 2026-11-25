import { ArithmeticError, ArithmeticStoreError, evaluateArithmetic } from './arithmetic';
import type { TestExpression } from './ast';
import { FILE_TEST_OPERATORS, rejectUnsupportedTestOperator } from './capabilities';
import { charactersOf, legalNumber } from './characters';
import { compareCollated } from './collation';
import { compileRegex, RegexSyntaxError, searchRegex } from './regex';
import type { Shell } from './shell';
import { isResolvedTargetSet, resolveScalarTarget, resolveSubscriptTarget } from './targets';
import { isIdentifier } from './variables';

export { FILE_TEST_OPERATORS };

export const ARITHMETIC_OPERATORS: Record<string, (a: bigint, b: bigint) => boolean> = {
  '-eq': (a, b) => a === b,
  '-ne': (a, b) => a !== b,
  '-lt': (a, b) => a < b,
  '-le': (a, b) => a <= b,
  '-gt': (a, b) => a > b,
  '-ge': (a, b) => a >= b,
};

/** Evaluates `[[ expression ]]` to an exit status: 0 when true, 1 when false or after an arithmetic error, and 2 on bad regex. */
export function conditionalStatus(shell: Shell, expression: TestExpression): number {
  const { expander } = shell;
  switch (expression.kind) {
    case 'word': {
      return expander.expandString(expression.word) === '' ? 1 : 0;
    }
    case 'not': {
      return conditionalStatus(shell, expression.expression) === 0 ? 1 : 0;
    }
    case 'and': {
      const left = conditionalStatus(shell, expression.left);
      return left === 0 ? conditionalStatus(shell, expression.right) : left;
    }
    case 'or': {
      const left = conditionalStatus(shell, expression.left);
      return left === 0 ? 0 : conditionalStatus(shell, expression.right);
    }
    case 'unary': {
      return unaryTest(shell, expression.operator, expander.expandString(expression.operand)) ? 0 : 1;
    }
    case 'binary': {
      return evaluateBinaryConditional(shell, expression) ? 0 : 1;
    }
    case 'regex': {
      const left = expander.expandString(expression.left);
      return regexStatus(shell, left, expander.expandRegex(expression.right));
    }
  }
}

function evaluateBinaryConditional(shell: Shell, expression: Extract<TestExpression, { kind: 'binary' }>): boolean {
  const { expander } = shell;
  const { operator } = expression;
  const left = expander.expandString(expression.left);
  if (operator === '==' || operator === '=' || operator === '!=') {
    const matched = expander.matches(left, expander.expandPattern(expression.right), true);
    return operator === '!=' ? !matched : matched;
  }
  const right = expander.expandString(expression.right);
  if (operator === '<') return compareCollated(left, right) < 0;
  if (operator === '>') return compareCollated(left, right) > 0;
  if (FILE_TEST_OPERATORS.has(operator)) rejectUnsupportedTestOperator(operator);
  const compare = ARITHMETIC_OPERATORS[operator];
  const leftNum = conditionalNumber(shell, left);
  if (leftNum === undefined) return false;
  const rightNum = conditionalNumber(shell, right);
  if (rightNum === undefined) return false;
  return compare(leftNum, rightNum);
}

function conditionalNumber(shell: Shell, text: string): bigint | undefined {
  try {
    return evaluateArithmetic(text, shell, undefined, shell.runtime.step);
  } catch (error) {
    if (error instanceof ArithmeticStoreError) {
      shell.failures.handleStoreFailure('conditional', error.failure);
      return undefined;
    }
    if (!(error instanceof ArithmeticError)) throw error;
    shell.reportError(error.message);
    return undefined;
  }
}

/** Evaluates a unary test operator shared by `test`, `[`, and `[[ ]]`. */
export function unaryTest(shell: Shell, operator: string, operand: string): boolean {
  switch (operator) {
    case '-z': {
      return operand === '';
    }
    case '-n': {
      return operand !== '';
    }
    case '-v': {
      return isSet(shell, operand);
    }
    case '-R': {
      const view = shell.store.ownView(operand);
      return view?.attributes.has('n') === true && view.kind !== 'unset';
    }
    default: {
      return rejectUnsupportedTestOperator(operator);
    }
  }
}

/** `-v name`: whether a variable, an array element, or a positional parameter is set. */
function isSet(shell: Shell, operand: string): boolean {
  const split = shell.splitSubscript(operand);
  if (split && isIdentifier(split.name)) {
    const target = resolveSubscriptTarget(shell, {
      name: split.name,
      subscript: { kind: 'text', text: split.subscript },
      operation: 'testSet',
    });
    return isResolvedTargetSet(shell, target);
  }
  const index = legalNumber(operand);
  if (index !== undefined) {
    return index >= 0n && index <= BigInt(shell.store.positionalArgs().length);
  }
  if (!isIdentifier(operand)) return false;
  return isResolvedTargetSet(shell, resolveScalarTarget(shell, operand, false));
}

/** `[[ text =~ regex ]]`, updating `BASH_REMATCH` via `VariableStore` and returning status 2 on invalid ERE. */
function regexStatus(shell: Shell, text: string, source: string): number {
  let compiled;
  try {
    compiled = compileRegex(source, shell.runtime.step);
  } catch (error) {
    if (!(error instanceof RegexSyntaxError)) throw error;
    shell.reportError(`[[: invalid regular expression \`${source}': ${error.message}`);
    return 2;
  }
  const match = searchRegex(compiled, text, shell.runtime.step);
  const chars = charactersOf(text);
  const elements = match ? match.map(([start, end]) => (start === -1 ? '' : chars.slice(start, end).join(''))) : [];
  shell.store.setRematch(elements);
  return match === undefined ? 1 : 0;
}
