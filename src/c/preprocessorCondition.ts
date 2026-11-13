import { CompileError } from '../interpreter/diagnostics';
import type { PPToken } from './lexer';
import { decodeCharLiteral, parseNumber } from './literals';
import { INT_PROPERTIES } from './types';

export function evaluatePreprocessorCondition(tokens: PPToken[], row: number): bigint {
  return new ConditionParser(tokens, row).parse();
}

const truth = (value: boolean): bigint => (value ? 1n : 0n);

interface ConditionValue {
  value: bigint;
  unsigned: boolean;
}

function conditionValue(value: bigint, unsigned = false): ConditionValue {
  return { value: unsigned ? BigInt.asUintN(64, value) : BigInt.asIntN(64, value), unsigned };
}

const CONDITION_OPERATIONS: Record<string, (a: bigint, b: bigint) => bigint> = {
  '||': (a, b) => truth(a !== 0n || b !== 0n),
  '&&': (a, b) => truth(a !== 0n && b !== 0n),
  '|': (a, b) => a | b,
  '^': (a, b) => a ^ b,
  '&': (a, b) => a & b,
  '==': (a, b) => truth(a === b),
  '!=': (a, b) => truth(a !== b),
  '<': (a, b) => truth(a < b),
  '>': (a, b) => truth(a > b),
  '<=': (a, b) => truth(a <= b),
  '>=': (a, b) => truth(a >= b),
  '<<': (a, b) => a << b,
  '>>': (a, b) => a >> b,
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '%': (a, b) => a % b,
};

/** Evaluates the integer constant expression of `#if`, in the widest integer type as C requires. */
class ConditionParser {
  private index = 0;

  constructor(
    private readonly tokens: PPToken[],
    private readonly row: number
  ) {}

  parse(): bigint {
    const value = this.conditional();
    if (this.index < this.tokens.length) this.fail();
    return value.value;
  }

  private fail(): never {
    throw new CompileError([{ row: this.row, message: '#if の条件の書き方に誤りがあります。' }]);
  }

  private peek(): string | undefined {
    return this.tokens[this.index]?.text;
  }

  private conditional(evaluate = true): ConditionValue {
    const condition = this.binary(0, evaluate);
    if (this.peek() !== '?') return condition;
    this.index++;
    const whenTrue = this.conditional(evaluate && condition.value !== 0n);
    if (this.peek() !== ':') this.fail();
    this.index++;
    const whenFalse = this.conditional(evaluate && condition.value === 0n);
    const selected = condition.value === 0n ? whenFalse : whenTrue;
    return conditionValue(selected.value, whenTrue.unsigned || whenFalse.unsigned);
  }

  private static readonly LEVELS: string[][] = [
    ['||'],
    ['&&'],
    ['|'],
    ['^'],
    ['&'],
    ['==', '!='],
    ['<', '>', '<=', '>='],
    ['<<', '>>'],
    ['+', '-'],
    ['*', '/', '%'],
  ];

  private binary(level: number, evaluate: boolean): ConditionValue {
    if (level >= ConditionParser.LEVELS.length) return this.unary(evaluate);
    let left = this.binary(level + 1, evaluate);
    for (;;) {
      const operator = this.peek();
      if (operator === undefined || !ConditionParser.LEVELS[level].includes(operator)) return left;
      this.index++;
      const skipped = (operator === '&&' && left.value === 0n) || (operator === '||' && left.value !== 0n);
      const right = this.binary(level + 1, evaluate && !skipped);
      left = this.apply(operator, left, right, evaluate);
    }
  }

  private apply(operator: string, a: ConditionValue, b: ConditionValue, evaluate: boolean): ConditionValue {
    const comparison = ['||', '&&', '==', '!=', '<', '>', '<=', '>='].includes(operator);
    const shift = operator === '<<' || operator === '>>';
    const unsigned = !comparison && (shift ? a.unsigned : a.unsigned || b.unsigned);
    if (!evaluate) return conditionValue(0n, unsigned);
    const left = conditionValue(a.value, a.unsigned || (!shift && b.unsigned)).value;
    const right = conditionValue(b.value, b.unsigned || (!shift && a.unsigned)).value;
    if ((operator === '/' || operator === '%') && right === 0n)
      throw new CompileError([{ row: this.row, message: '#if の条件で 0 で割っています。' }]);
    if (shift && (right < 0n || right >= 64n)) this.fail();
    const value = CONDITION_OPERATIONS[operator](left, right);
    return conditionValue(value, unsigned);
  }

  private unary(evaluate: boolean): ConditionValue {
    const token = this.tokens[this.index++];
    if (!token) this.fail();
    switch (token.text) {
      case '-': {
        const value = this.unary(evaluate);
        return conditionValue(-value.value, value.unsigned);
      }
      case '+': {
        return this.unary(evaluate);
      }
      case '!': {
        return conditionValue(truth(this.unary(evaluate).value === 0n));
      }
      case '~': {
        const value = this.unary(evaluate);
        return conditionValue(~value.value, value.unsigned);
      }
      case '(': {
        const value = this.conditional(evaluate);
        if (this.peek() !== ')') this.fail();
        this.index++;
        return value;
      }
    }
    if (token.kind === 'number') {
      const parsed = parseNumber(token.text, this.row, true);
      if (parsed.type.kind !== 'int') this.fail();
      return conditionValue(BigInt(parsed.value), !INT_PROPERTIES[parsed.type.name].signed);
    }
    if (token.kind === 'char') return conditionValue(BigInt(decodeCharLiteral(token.text, this.row)));
    this.fail();
  }
}
