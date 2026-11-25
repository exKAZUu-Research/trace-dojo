/**
 * Clean-room implementation of the `test` and `[` builtins from POSIX.1-2017 XCU `test` (0–4 argument disambiguation)
 * and GNU Bash Reference Manual §4.1 (`==`, `<`, `>`, `-v`, `-R`, and parenthesized/compound expressions).
 */

import { rejectUnsupportedTestOperator } from './capabilities';
import { legalNumber } from './characters';
import { ARITHMETIC_OPERATORS, FILE_TEST_OPERATORS, unaryTest } from './conditional';
import type { Shell } from './shell';

const UNARY_FLAGS = new Set([
  ...[...FILE_TEST_OPERATORS].filter((op) => op.length === 2),
  '-z',
  '-n',
  '-v',
  '-R',
  '-o',
  '-t',
]);

const BINARY_FLAGS = new Set(['=', '==', '!=', '<', '>', '-nt', '-ot', '-ef', ...Object.keys(ARITHMETIC_OPERATORS)]);

class TestDiagnosticError extends Error {}

export function testBuiltin(shell: Shell, args: string[], name: string): number {
  let tokens = args;
  if (name === '[') {
    if (tokens.at(-1) !== ']') {
      shell.reportError("[: missing `]'");
      return 2;
    }
    tokens = tokens.slice(0, -1);
  }
  if (tokens.length === 0) return 1;
  try {
    return evaluateTestTokens(shell, name, tokens) ? 0 : 1;
  } catch (error) {
    if (error instanceof TestDiagnosticError) return 2;
    throw error;
  }
}

function evaluateTestTokens(shell: Shell, name: string, tokens: readonly string[]): boolean {
  const cursor = new TestReader(shell, name, tokens);
  const result = cursor.evaluateSpan(tokens.length);
  if (!cursor.atEnd) {
    const rest = cursor.peek() as string;
    if (rest.startsWith('-')) cursor.fail(`syntax error: \`${rest}' unexpected`);
    cursor.fail('too many arguments');
  }
  return result;
}

class TestReader {
  private index = 0;

  constructor(
    private readonly shell: Shell,
    private readonly name: string,
    private readonly tokens: readonly string[]
  ) {}

  get atEnd(): boolean {
    return this.index >= this.tokens.length;
  }

  peek(offset = 0): string | undefined {
    return this.tokens[this.index + offset];
  }

  fail(message: string): never {
    this.shell.reportError(`${this.name}: ${message}`);
    throw new TestDiagnosticError();
  }

  /** Evaluates `count` tokens starting at `this.index` using POSIX `test` argument-count rules. */
  evaluateSpan(count: number): boolean {
    if (count === 1) return this.take() !== '';
    if (count === 2) return this.evaluateTwo();
    if (count === 3) return this.evaluateThree();
    if (count === 4) {
      if (this.peek() === '!') {
        this.index++;
        return !this.evaluateThree();
      }
      if (this.peek() === '(' && this.peek(3) === ')') {
        this.index++;
        const inner = this.evaluateTwo();
        this.index++;
        return inner;
      }
    }
    return this.parseDisjunction();
  }

  private take(): string {
    if (this.atEnd) this.fail('argument expected');
    return this.tokens[this.index++];
  }

  private evaluateTwo(): boolean {
    const first = this.peek() as string;
    if (first === '!') {
      this.index++;
      return this.take() === '';
    }
    if (UNARY_FLAGS.has(first)) return this.applyUnary();
    return this.fail(`${first}: unary operator expected`);
  }

  private evaluateThree(): boolean {
    const first = this.peek() as string;
    const middle = this.peek(1) as string;
    const third = this.peek(2) as string;
    if (BINARY_FLAGS.has(middle)) return this.applyBinary();
    if (middle === '-a' || middle === '-o') {
      this.index += 3;
      return middle === '-a' ? first !== '' && third !== '' : first !== '' || third !== '';
    }
    if (first === '!') {
      this.index++;
      return !this.evaluateTwo();
    }
    if (first === '(' && third === ')') {
      this.index += 3;
      return middle !== '';
    }
    return this.fail(`${middle}: binary operator expected`);
  }

  private parseDisjunction(): boolean {
    if (this.atEnd) this.fail('argument expected');
    let left = this.parseConjunction();
    while (this.peek() === '-o') {
      this.index++;
      const right = this.parseConjunction();
      left = left || right;
    }
    return left;
  }

  private parseConjunction(): boolean {
    let left = this.parsePrimary();
    while (this.peek() === '-a') {
      this.index++;
      const right = this.parsePrimary();
      left = left && right;
    }
    return left;
  }

  private parsePrimary(): boolean {
    const current = this.peek();
    if (current === undefined) this.fail('argument expected');
    if (current === '!') return this.parseNegated();
    if (current === '(') return this.parseGrouped();
    if (this.index + 3 <= this.tokens.length && BINARY_FLAGS.has(this.peek(1) as string)) {
      return this.applyBinary();
    }
    if (this.index + 2 <= this.tokens.length && UNARY_FLAGS.has(current)) {
      return this.applyUnary();
    }
    return this.take() !== '';
  }

  private parseNegated(): boolean {
    let inverted = false;
    while (this.peek() === '!') {
      this.index++;
      if (this.atEnd) this.fail('argument expected');
      inverted = !inverted;
    }
    const inner = this.parsePrimary();
    return inverted ? !inner : inner;
  }

  private parseGrouped(): boolean {
    this.index++;
    if (this.atEnd) this.fail('argument expected');
    const shortLength = this.findShortGroupLength();
    if (shortLength !== undefined) {
      const value = this.evaluateSpan(shortLength);
      this.index++;
      return value;
    }
    const inner = this.parseDisjunction();
    if (this.atEnd) this.fail("`)' expected");
    if (this.peek() !== ')') this.fail(`\`)' expected, found ${this.peek()}`);
    this.index++;
    return inner;
  }

  private findShortGroupLength(): number | undefined {
    const first = this.peek() as string;
    const second = this.peek(1);
    if (second === undefined) return undefined;
    if (second === ')') return 1;
    let depth = first === '(' && !isThreeTokenGroupOperator(second) ? 2 : 1;
    for (let offset = 1; offset <= 4 && this.index + offset < this.tokens.length; offset++) {
      const token = this.tokens[this.index + offset];
      if (token === '(') depth++;
      else if (token === ')' && --depth === 0) return offset;
    }
    return undefined;
  }

  private applyUnary(): boolean {
    const op = this.take();
    const operand = this.take();
    return unaryTest(this.shell, op, operand);
  }

  private applyBinary(): boolean {
    const left = this.take();
    const op = this.take();
    const right = this.take();
    if (op === '=' || op === '==') return left === right;
    if (op === '!=') return left !== right;
    if (op === '<') return compareUtf8Bytes(left, right) < 0;
    if (op === '>') return compareUtf8Bytes(left, right) > 0;
    if (FILE_TEST_OPERATORS.has(op)) rejectUnsupportedTestOperator(op);
    return ARITHMETIC_OPERATORS[op](this.parseInteger(left), this.parseInteger(right));
  }

  private parseInteger(text: string): bigint {
    const value = legalNumber(text);
    if (value === undefined) this.fail(`${text}: integer expression expected`);
    return value;
  }
}

const UTF8_ENCODER = new TextEncoder();

function isThreeTokenGroupOperator(op: string): boolean {
  return BINARY_FLAGS.has(op) || op === '-a' || op === '-o';
}

function compareUtf8Bytes(a: string, b: string): number {
  const bytesA = UTF8_ENCODER.encode(a);
  const bytesB = UTF8_ENCODER.encode(b);
  const length = Math.min(bytesA.length, bytesB.length);
  for (let i = 0; i < length; i++) {
    if (bytesA[i] !== bytesB[i]) return bytesA[i] - bytesB[i];
  }
  return bytesA.length - bytesB.length;
}
