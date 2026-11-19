import { ARITHMETIC_OPERATORS, FILE_TEST_OPERATORS, unaryTest } from './conditional';
import type { Shell } from './shell';
import { UnsupportedFeatureError } from './unsupported';

const UNARY_OPERATORS = new Set([...FILE_TEST_OPERATORS].filter((op) => !['-nt', '-ot', '-ef'].includes(op)));
for (const op of ['-z', '-n', '-v', '-R', '-o', '-t']) UNARY_OPERATORS.add(op);

const BINARY_OPERATORS = new Set([
  '=',
  '==',
  '!=',
  '<',
  '>',
  '-nt',
  '-ot',
  '-ef',
  ...Object.keys(ARITHMETIC_OPERATORS),
]);

class TestSyntaxError extends Error {}

/** `test` and `[`, ported from Bash's `test.c`: arguments decide the form by their number, as POSIX says. */
export function testBuiltin(shell: Shell, args: string[], name: string): number {
  let argv = args;
  if (name === '[') {
    if (argv.at(-1) !== ']') {
      shell.reportError("[: missing `]'");
      return 2;
    }
    argv = argv.slice(0, -1);
  }
  try {
    return new Test(shell, argv, name).run() ? 0 : 1;
  } catch (error) {
    if (error instanceof TestSyntaxError) return 2;
    throw error;
  }
}

class Test {
  private pos = 0;

  constructor(
    private readonly shell: Shell,
    private readonly argv: string[],
    private readonly name: string
  ) {}

  private error(message: string): never {
    this.shell.reportError(`${this.name}: ${message}`);
    throw new TestSyntaxError();
  }

  run(): boolean {
    if (this.argv.length === 0) return false;
    const value = this.posixtest(this.argv.length);
    if (this.pos !== this.argv.length) {
      const next = this.argv[this.pos];
      if (next?.startsWith('-')) this.error(`syntax error: \`${next}' unexpected`);
      this.error('too many arguments');
    }
    return value;
  }

  private posixtest(count: number): boolean {
    const { argv } = this;
    switch (count) {
      case 1: {
        this.pos++;
        return argv[0] !== '';
      }
      case 2: {
        return this.twoArguments();
      }
      case 3: {
        return this.threeArguments();
      }
      case 4: {
        if (argv[this.pos] === '!') {
          this.pos++;
          return !this.threeArguments();
        }
        if (argv[this.pos] === '(' && argv[this.pos + 3] === ')') {
          this.pos++;
          const value = this.twoArguments();
          this.pos++;
          return value;
        }
        return this.expr();
      }
      default: {
        return this.expr();
      }
    }
  }

  private twoArguments(): boolean {
    const { argv } = this;
    if (argv[this.pos] === '!') {
      this.pos++;
      return argv[this.pos++] === '';
    }
    const op = argv[this.pos];
    if (op.length === 2 && op.startsWith('-') && UNARY_OPERATORS.has(op)) return this.unaryOperator();
    return this.error(`${op}: unary operator expected`);
  }

  private threeArguments(): boolean {
    const { argv } = this;
    const middle = argv[this.pos + 1];
    if (BINARY_OPERATORS.has(middle)) return this.binaryOperator();
    if (middle === '-a' || middle === '-o') {
      const left = argv[this.pos] !== '';
      const right = argv[this.pos + 2] !== '';
      this.pos += 3;
      return middle === '-a' ? left && right : left || right;
    }
    if (argv[this.pos] === '!') {
      this.pos++;
      return !this.twoArguments();
    }
    if (argv[this.pos] === '(' && argv[this.pos + 2] === ')') {
      const value = argv[this.pos + 1] !== '';
      this.pos += 3;
      return value;
    }
    return this.error(`${middle}: binary operator expected`);
  }

  private expr(): boolean {
    if (this.pos >= this.argv.length) this.error('argument expected');
    return this.or();
  }

  private or(): boolean {
    const value = this.and();
    if (this.pos < this.argv.length && this.argv[this.pos] === '-o') {
      this.pos++;
      const other = this.or();
      return value || other;
    }
    return value;
  }

  private and(): boolean {
    const value = this.term();
    if (this.pos < this.argv.length && this.argv[this.pos] === '-a') {
      this.pos++;
      const other = this.and();
      return value && other;
    }
    return value;
  }

  private term(): boolean {
    const { argv } = this;
    if (this.pos >= argv.length) this.error('argument expected');
    if (argv[this.pos] === '!') return this.negation();
    if (argv[this.pos] === '(') return this.parenthesized();
    if (this.pos + 3 <= argv.length && BINARY_OPERATORS.has(argv[this.pos + 1])) return this.binaryOperator();
    if (this.pos + 2 <= argv.length && UNARY_OPERATORS.has(argv[this.pos])) return this.unaryOperator();
    return argv[this.pos++] !== '';
  }

  /** `! term`, where each `!` inverts the term after it. */
  private negation(): boolean {
    let negate = false;
    while (this.pos < this.argv.length && this.argv[this.pos] === '!') {
      this.pos++;
      if (this.pos >= this.argv.length) this.error('argument expected');
      negate = !negate;
    }
    const value = this.term();
    return negate ? !value : value;
  }

  /** `( expression )`, which reads a short expression by its number of arguments, as Bash 5.3 does. */
  private parenthesized(): boolean {
    const { argv } = this;
    this.pos++;
    if (this.pos >= argv.length) this.error('argument expected');
    let count = 1;
    let nargs = 1;
    for (; this.pos + nargs < argv.length; nargs++) {
      if (argv[this.pos + nargs] === ')') count--;
      else if (argv[this.pos + nargs] === '(') count++;
      if (count === 0) break;
    }
    const value = this.pos + nargs < argv.length && nargs <= 4 ? this.posixtest(nargs) : this.expr();
    if (this.pos >= argv.length) this.error("`)' expected");
    if (argv[this.pos] !== ')') this.error(`\`)' expected, found ${argv[this.pos]}`);
    this.pos++;
    return value;
  }

  private unaryOperator(): boolean {
    const op = this.argv[this.pos++];
    if (this.pos >= this.argv.length) this.error('argument expected');
    const operand = this.argv[this.pos++];
    return unaryTest(this.shell, op, operand, false);
  }

  private binaryOperator(): boolean {
    const left = this.argv[this.pos];
    const op = this.argv[this.pos + 1];
    const right = this.argv[this.pos + 2];
    this.pos += 3;
    if (op === '=' || op === '==') return left === right;
    if (op === '!=') return left !== right;
    if (op === '<') return left < right;
    if (op === '>') return left > right;
    if (FILE_TEST_OPERATORS.has(op)) throw new UnsupportedFeatureError(`ファイルを調べる演算子（${op}）`);
    return ARITHMETIC_OPERATORS[op](this.integer(left), this.integer(right));
  }

  /** An operand of `-eq` and the others, which must be an integer, as Bash's `legal_number` reads one. */
  private integer(text: string): bigint {
    const match = /^[ \t\n]*([-+]?\d+)[ \t\n]*$/.exec(text);
    if (!match) this.error(`${text}: integer expected`);
    const value = BigInt(match[1]);
    if (value !== BigInt.asIntN(64, value)) this.error(`${text}: integer expected`);
    return value;
  }
}
