import { ArithmeticError, ArithmeticStoreError, evaluateArithmetic } from './arithmetic';
import type { TestExpression } from './ast';
import { charactersOf } from './characters';
import { compareCollated } from './collation';
import { compileRegex, RegexSyntaxError, searchRegex } from './regex';
import type { Shell } from './shell';
import { UnsupportedFeatureError } from './unsupported';
import { isIdentifier } from './variables';

/** The file tests, which read the file system this environment does not have. */
export const FILE_TEST_OPERATORS = new Set([
  '-a',
  '-b',
  '-c',
  '-d',
  '-e',
  '-f',
  '-g',
  '-h',
  '-k',
  '-p',
  '-r',
  '-s',
  '-u',
  '-w',
  '-x',
  '-G',
  '-L',
  '-N',
  '-O',
  '-S',
  '-nt',
  '-ot',
  '-ef',
]);

export const ARITHMETIC_OPERATORS: Record<string, (a: bigint, b: bigint) => boolean> = {
  '-eq': (a, b) => a === b,
  '-ne': (a, b) => a !== b,
  '-lt': (a, b) => a < b,
  '-le': (a, b) => a <= b,
  '-gt': (a, b) => a > b,
  '-ge': (a, b) => a >= b,
};

/** Evaluates `[[ expression ]]`. */
export function evaluateConditional(shell: Shell, expression: TestExpression): boolean {
  const { expander } = shell;
  switch (expression.kind) {
    case 'word': {
      return expander.expandString(expression.word) !== '';
    }
    case 'not': {
      return !evaluateConditional(shell, expression.expression);
    }
    case 'and': {
      return evaluateConditional(shell, expression.left) && evaluateConditional(shell, expression.right);
    }
    case 'or': {
      return evaluateConditional(shell, expression.left) || evaluateConditional(shell, expression.right);
    }
    case 'unary': {
      return unaryTest(shell, expression.operator, expander.expandString(expression.operand));
    }
    case 'binary': {
      const { operator } = expression;
      const left = expander.expandString(expression.left);
      if (operator === '==' || operator === '=' || operator === '!=') {
        const matched = expander.matches(left, expander.expandPattern(expression.right));
        return operator === '!=' ? !matched : matched;
      }
      const right = expander.expandString(expression.right);
      if (operator === '<') return compareCollated(left, right) < 0;
      if (operator === '>') return compareCollated(left, right) > 0;
      if (FILE_TEST_OPERATORS.has(operator)) throw new UnsupportedFeatureError(`ファイルを調べる演算子（${operator}）`);
      const compare = ARITHMETIC_OPERATORS[operator];
      return compare(conditionalNumber(shell, left), conditionalNumber(shell, right));
    }
    case 'regex': {
      return regexTest(shell, expander.expandString(expression.left), expander.expandRegex(expression.right));
    }
  }
}

class ConditionalArithmeticError extends Error {}

function conditionalNumber(shell: Shell, text: string): bigint {
  try {
    return evaluateArithmetic(text, shell, undefined, () => shell.runtime.spend());
  } catch (error) {
    if (error instanceof ArithmeticStoreError) throw new ConditionalArithmeticError();
    if (!(error instanceof ArithmeticError)) throw error;
    shell.reportError(error.message);
    throw new ConditionalArithmeticError();
  }
}

/** Evaluates `[[ ]]` to an exit status: 0 when true, 1 when false or after an arithmetic error, and 2 on bad regex. */
export function conditionalStatus(shell: Shell, expression: TestExpression): number {
  try {
    return evaluateConditional(shell, expression) ? 0 : 1;
  } catch (error) {
    if (error instanceof ConditionalArithmeticError) return 1;
    if (error instanceof RegexStatus) return 2;
    throw error;
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
      const variable = shell.findOwnVariable(operand);
      return variable?.attributes.has('n') === true && variable.value !== undefined;
    }
    case '-o': {
      throw new UnsupportedFeatureError('シェルのオプションを調べる演算子（-o）');
    }
    case '-t': {
      throw new UnsupportedFeatureError('端末を調べる演算子（-t）');
    }
    default: {
      throw new UnsupportedFeatureError(`ファイルを調べる演算子（${operator}）`);
    }
  }
}

/** `-v name`: whether a variable, an array element, or a positional parameter is set. */
function isSet(shell: Shell, operand: string): boolean {
  const split = shell.splitSubscript(operand);
  if (split && isIdentifier(split.name)) {
    const resolved = shell.resolveName(split.name);
    if (shell.isAssociative(resolved)) {
      const key = shell.expander.expandSubscriptText(split.subscript);
      if (key === '') {
        shell.reportError(`${resolved}: bad array subscript`);
        return false;
      }
      return shell.elementValue(resolved, key) !== undefined;
    }
    if (split.subscript === '@' || split.subscript === '*') return shell.arrayValues(resolved).length > 0;
    const index = shell.arrayIndex(resolved, split.subscript);
    return index !== undefined && shell.elementValue(resolved, String(index)) !== undefined;
  }
  if (/^\s*[-+]?\d+\s*$/.test(operand)) {
    const index = Number(operand);
    return index >= 0 && index <= (shell.state.positional.at(-1) as string[]).length;
  }
  if (!isIdentifier(operand)) return false;
  return shell.scalarValue(operand) !== undefined;
}

/** `[[ text =~ regex ]]`, which sets `BASH_REMATCH` and gives 2 for a regex macOS rejects. */
function regexTest(shell: Shell, text: string, source: string): boolean {
  let compiled;
  try {
    compiled = compileRegex(source);
  } catch (error) {
    if (!(error instanceof RegexSyntaxError)) throw error;
    shell.reportError(`[[: invalid regular expression \`${source}': ${error.message}`);
    throw new RegexStatus();
  }
  const match = searchRegex(compiled, text, () => shell.runtime.spend());
  const chars = charactersOf(text);
  const elements = match ? match.map(([start, end]) => (start === -1 ? '' : chars.slice(start, end).join(''))) : [];
  shell.assignCompound('BASH_REMATCH', elements, false);
  const variable = shell.findOwnVariable('BASH_REMATCH');
  if (variable) variable.isSystem = true;
  return match !== undefined;
}

/** Ends `[[ =~ ]]` with status 2 after an invalid regular expression. */
export class RegexStatus extends Error {}
