// code-gauge-allow-file fileNcss -- Keeps 64-bit shell arithmetic tokenization, precedence climbing, and integer literal parsing together in one module.
/**
 * Clean-room 64-bit signed integer arithmetic evaluator implementing GNU Bash's documented arithmetic rules
 * (Bash Reference Manual §6.5 Shell Arithmetic): C-precedence operators, `**` exponentiation, `base#digits`
 * constants (bases 2–64), short-circuit `&&`/`||`/`?:`, recursive variable-value evaluation, and single-evaluation
 * structured lvalue resolution.
 */

import { skipBalanced, SourceText, SyntaxFailure, UnknownSyntax } from './syntaxWords';

export type ArithmeticTarget =
  | { kind: 'scalar'; name: string }
  | { kind: 'associativeElement'; name: string; key: string }
  | { kind: 'indexedElement'; name: string; index: bigint }
  | { kind: 'invalidElement'; raw: string; emptyWrite?: boolean };

export type WriteTargetResult = 'ok' | 'ignored' | 'readonly' | 'invalid';

export interface ArithmeticHost {
  /** Resolves a variable or `name[subscript]` once into a reusable target. */
  resolveTarget(
    name: string,
    rawSubscript: string | undefined,
    willRead: boolean,
    expandSubscript?: boolean
  ): ArithmeticTarget;
  /** Reads the current string value of `target`, or `undefined` when unset. */
  readTarget(target: ArithmeticTarget): string | undefined;
  /** Stores `value` into `target`, reporting why a failed store was rejected. */
  writeTarget(target: ArithmeticTarget, value: string): WriteTargetResult;
  /** Reports a diagnostic without formatting it as an arithmetic syntax error. */
  reportError(message: string): void;
}

/** Formatted arithmetic evaluation error (`[cmd: ]expr: message (error token is "...")`). */
export class ArithmeticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArithmeticError';
  }
}

/** Aborts remaining arithmetic evaluation after a host variable store fails and already reported its own error. */
export class ArithmeticStoreError extends Error {
  constructor(readonly isReadonly = false) {
    super('Arithmetic store failed');
    this.name = 'ArithmeticStoreError';
  }
}

type OperatorText =
  | ','
  | '='
  | '+='
  | '-='
  | '*='
  | '/='
  | '%='
  | '<<='
  | '>>='
  | '&='
  | '^='
  | '|='
  | '?'
  | ':'
  | '||'
  | '&&'
  | '|'
  | '^'
  | '&'
  | '=='
  | '!='
  | '<='
  | '>='
  | '<'
  | '>'
  | '<<'
  | '>>'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '**'
  | '!'
  | '~'
  | '('
  | ')'
  | 'pre++'
  | 'pre--'
  | 'post++'
  | 'post--';

type LexToken =
  | { kind: 'eof' }
  | { kind: 'number'; value: bigint }
  | { kind: 'identifier'; name: string; subscript: string | undefined }
  | { kind: 'op'; op: OperatorText };

interface EvalOutcome {
  value: bigint;
  assignable: boolean;
  target?: ArithmeticTarget;
  deferred?: { name: string; subscript: string | undefined };
}

interface ScannerSnapshot {
  cursor: number;
  errorStart: number;
  current: LexToken;
}

const MAX_RECURSION_DEPTH = 256;
const MIN_INT64 = -(2n ** 63n);
const SIMPLE_IDENTIFIER_EXPRESSION = /^[ \t\n]*([A-Za-z_][A-Za-z0-9_]*)[ \t\n]*$/;

const COMPOUND_OPERATORS = new Map<string, OperatorText>([
  ['+=', '+='],
  ['-=', '-='],
  ['*=', '*='],
  ['/=', '/='],
  ['%=', '%='],
  ['<<=', '<<='],
  ['>>=', '>>='],
  ['&=', '&='],
  ['^=', '^='],
  ['|=', '|='],
]);

const TWO_CHAR_OPERATORS = new Map<string, OperatorText>([
  ['==', '=='],
  ['!=', '!='],
  ['<=', '<='],
  ['>=', '>='],
  ['<<', '<<'],
  ['>>', '>>'],
  ['&&', '&&'],
  ['||', '||'],
  ['**', '**'],
]);

const SINGLE_CHAR_OPERATORS = new Set<OperatorText>([
  ',',
  '=',
  '?',
  ':',
  '|',
  '^',
  '&',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '~',
  '(',
  ')',
]);

const wrap64 = (n: bigint): bigint => BigInt.asIntN(64, n);
const isBlank = (c: string): boolean => c === ' ' || c === '\t';
const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n';
const isIdentStart = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string): boolean => isIdentStart(c) || (c >= '0' && c <= '9');
const isAsciiAlnum = (c: string): boolean => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

/** Evaluates an arithmetic string in 64-bit signed two's-complement integer arithmetic. */
export function evaluateArithmetic(
  expression: string,
  host: ArithmeticHost,
  commandName: string | undefined,
  spend: () => void,
  preExpanded = false
): bigint {
  return new ExpressionSession(host, commandName, spend).evaluateSubexpression(expression, preExpanded);
}

/** Splits `name[subscript]` into `{ name, subscript }` when `[`...`]` spans to the end of `text`. */
export function splitSubscriptText(text: string): { name: string; subscript: string } | undefined {
  const open = text.indexOf('[');
  if (open === -1) return undefined;
  const close = skipSubscript(text, open);
  return close === text.length - 1 ? { name: text.slice(0, open), subscript: text.slice(open + 1, close) } : undefined;
}

/** Finds the index of the `]` matching the `[` at `start`, skipping quotes, escapes, expansions, and nested `[...]`. */
export function skipSubscript(source: string, start: number): number {
  if (source[start] !== '[') return source.length;
  const text = new SourceText(source);
  text.parseSubstitution = (subStart) => skipBalanced(text, subStart - 1, '(', ')');
  try {
    return skipBalanced(text, start, '[', ']') - 1;
  } catch (error) {
    if (error instanceof SyntaxFailure || error instanceof UnknownSyntax) return source.length;
    throw error;
  }
}

class ExpressionSession {
  private depth = 0;

  constructor(
    readonly host: ArithmeticHost,
    readonly commandName: string | undefined,
    readonly spend: () => void
  ) {}

  evaluateSubexpression(source: string, preExpanded = false): bigint {
    let current = source;
    let entered = 0;
    try {
      for (;;) {
        this.spend();
        const first = firstNonSpace(current);
        if (first >= current.length) return 0n;
        if (this.depth >= MAX_RECURSION_DEPTH) {
          throw formatError(this.commandName, current, undefined, first, 'expression recursion level exceeded');
        }
        this.depth++;
        entered++;
        const identMatch = SIMPLE_IDENTIFIER_EXPRESSION.exec(current);
        if (!identMatch) return new FrameParser(this, current, !preExpanded || entered > 1).parseAll();
        const nextRaw = this.host.readTarget(this.host.resolveTarget(identMatch[1], undefined, true));
        if (!nextRaw) return 0n;
        current = nextRaw;
      }
    } catch (error) {
      if (error instanceof RangeError) {
        throw formatError(
          this.commandName,
          current,
          undefined,
          firstNonSpace(current),
          'expression recursion level exceeded'
        );
      }
      throw error;
    } finally {
      this.depth -= entered;
    }
  }
}

function firstNonSpace(text: string): number {
  let i = 0;
  while (i < text.length && isSpace(text[i])) i++;
  return i;
}

class FrameParser {
  private cursor = 0;
  private errorStart = 0;
  private errorEnd: number | undefined;
  private suppress = 0;
  private current: LexToken = { kind: 'eof' };
  private afterPreIncDec = false;

  constructor(
    private readonly session: ExpressionSession,
    private readonly source: string,
    private readonly expandSubscripts = true
  ) {}

  parseAll(): bigint {
    this.advance();
    const outcome = this.parseComma();
    if (this.current.kind !== 'eof') this.fail('arithmetic syntax error in expression');
    return outcome.value;
  }

  private parseComma(): EvalOutcome {
    let result = this.parseAssignment();
    while (this.isOp(',')) {
      this.advance();
      result = this.parseAssignment();
    }
    return result;
  }

  // code-gauge-allow functionCognitiveComplexity -- Evaluates RHS first, resolves deferred plain-= lvalues, and guards compound zero-divisors.
  private parseAssignment(): EvalOutcome {
    const left = this.parseTernary();
    if (this.current.kind !== 'op') return left;
    const { op } = this.current;
    if (op !== '=' && !COMPOUND_OPERATORS.has(op)) return left;
    if (!left.assignable) this.fail('attempted assignment to non-variable');
    this.advance();
    const right = this.parseAssignment();
    let value = right.value;
    if (op !== '=') {
      if ((op === '/=' || op === '%=') && value === 0n) {
        if (this.suppress === 0) this.fail('division by 0');
        value = 1n;
      }
      value = applyCompound(op, left.value, value);
    }
    if (this.suppress === 0) {
      const target =
        left.deferred === undefined
          ? left.target
          : this.session.host.resolveTarget(left.deferred.name, left.deferred.subscript, false, this.expandSubscripts);
      if (target) this.store(target, value);
    }
    return { value, assignable: false };
  }

  private parseTernary(): EvalOutcome {
    const cond = this.parseLogicalOr();
    if (!this.isOp('?')) return cond;
    const skipTrue = cond.value === 0n;
    if (skipTrue) this.suppress++;
    this.advance();
    if (this.isEof() || this.isOp(':')) this.fail('expression expected');
    const whenTrue = this.parseComma();
    if (skipTrue) this.suppress--;
    if (!this.isOp(':')) this.fail("`:' expected for conditional expression");
    const skipFalse = cond.value !== 0n;
    if (skipFalse) this.suppress++;
    this.advance();
    if (this.isEof()) this.fail('expression expected');
    const whenFalse = this.parseTernary();
    if (skipFalse) this.suppress--;
    return { value: cond.value !== 0n ? whenTrue.value : whenFalse.value, assignable: false };
  }

  private parseLogicalOr(): EvalOutcome {
    let left = this.parseLogicalAnd();
    while (this.isOp('||')) {
      const skip = left.value !== 0n;
      if (skip) this.suppress++;
      this.advance();
      const right = this.parseLogicalAnd();
      if (skip) this.suppress--;
      left = { value: left.value !== 0n || right.value !== 0n ? 1n : 0n, assignable: false };
    }
    return left;
  }

  private parseLogicalAnd(): EvalOutcome {
    let left = this.parseBitwiseOr();
    while (this.isOp('&&')) {
      const skip = left.value === 0n;
      if (skip) this.suppress++;
      this.advance();
      const right = this.parseBitwiseOr();
      if (skip) this.suppress--;
      left = { value: left.value !== 0n && right.value !== 0n ? 1n : 0n, assignable: false };
    }
    return left;
  }

  private parseBinary(
    ops: readonly OperatorText[],
    next: () => EvalOutcome,
    combine: (op: OperatorText, a: bigint, b: bigint) => bigint
  ): EvalOutcome {
    let left = next();
    while (this.current.kind === 'op' && ops.includes(this.current.op)) {
      const { op } = this.current;
      this.advance();
      const right = next();
      left = { value: wrap64(combine(op, left.value, right.value)), assignable: false };
    }
    return left;
  }

  private parseBitwiseOr(): EvalOutcome {
    return this.parseBinary(
      ['|'],
      () => this.parseBitwiseXor(),
      (_, a, b) => a | b
    );
  }

  private parseBitwiseXor(): EvalOutcome {
    return this.parseBinary(
      ['^'],
      () => this.parseBitwiseAnd(),
      (_, a, b) => a ^ b
    );
  }

  private parseBitwiseAnd(): EvalOutcome {
    return this.parseBinary(
      ['&'],
      () => this.parseEquality(),
      (_, a, b) => a & b
    );
  }

  private parseEquality(): EvalOutcome {
    return this.parseBinary(
      ['==', '!='],
      () => this.parseRelational(),
      (op, a, b) => ((op === '==' ? a === b : a !== b) ? 1n : 0n)
    );
  }

  private parseRelational(): EvalOutcome {
    return this.parseBinary(
      ['<=', '>=', '<', '>'],
      () => this.parseShift(),
      (op, a, b) => {
        if (op === '<=') return a <= b ? 1n : 0n;
        if (op === '>=') return a >= b ? 1n : 0n;
        return (op === '<' ? a < b : a > b) ? 1n : 0n;
      }
    );
  }

  private parseShift(): EvalOutcome {
    return this.parseBinary(
      ['<<', '>>'],
      () => this.parseAdditive(),
      (op, a, b) => (op === '<<' ? shiftLeft64(a, b) : shiftRight64(a, b))
    );
  }

  private parseAdditive(): EvalOutcome {
    return this.parseBinary(
      ['+', '-'],
      () => this.parseMultiplicative(),
      (op, a, b) => (op === '+' ? a + b : a - b)
    );
  }

  // code-gauge-allow functionCognitiveComplexity -- Handles `*`, `/`, and `%` with zero-divisor reporting at the divisor token and MIN_INT64 / -1 overflow guards.
  private parseMultiplicative(): EvalOutcome {
    let left = this.parseExponent();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = (this.current as Extract<LexToken, { kind: 'op' }>).op;
      const afterOp = this.cursor;
      this.advance();
      const right = this.parseExponent();
      let divisor = right.value;
      if ((op === '/' || op === '%') && divisor === 0n) {
        if (this.suppress === 0) {
          let tokenPos = afterOp;
          while (tokenPos < this.source.length && isBlank(this.source[tokenPos])) tokenPos++;
          this.errorStart = tokenPos;
          this.fail('division by 0');
        }
        divisor = 1n;
      }
      const value =
        op === '*'
          ? wrap64(left.value * divisor)
          : op === '/'
            ? safeDivide64(left.value, divisor)
            : safeModulo64(left.value, divisor);
      left = { value, assignable: false };
    }
    return left;
  }

  private parseExponent(): EvalOutcome {
    let base = this.parseUnary();
    if (this.isOp('**')) {
      this.advance();
      const exp = this.parseExponent();
      if (this.suppress > 0) return { value: 1n, assignable: false };
      if (exp.value === 0n) return { value: 1n, assignable: false };
      if (exp.value < 0n) this.fail('exponent less than 0');
      base = { value: pow64(base.value, exp.value, this.session.spend), assignable: false };
    }
    return base;
  }

  // code-gauge-allow functionCognitiveComplexity -- Handles logical, bitwise, sign, and pre-increment/decrement unary operators.
  private parseUnary(): EvalOutcome {
    if (this.isOp('!') || this.isOp('~') || this.isOp('+') || this.isOp('-')) {
      const op = (this.current as Extract<LexToken, { kind: 'op' }>).op;
      this.advance();
      const inner = this.parseUnary();
      const value =
        op === '!'
          ? inner.value === 0n
            ? 1n
            : 0n
          : op === '~'
            ? ~inner.value
            : op === '-'
              ? wrap64(-inner.value)
              : inner.value;
      return { value, assignable: false };
    }
    if (this.isOp('pre++') || this.isOp('pre--')) return this.parsePreIncDec();
    return this.parsePrimary();
  }

  private parsePreIncDec(): EvalOutcome {
    const delta = this.isOp('pre++') ? 1n : -1n;
    this.advance();
    if (this.current.kind !== 'identifier') {
      this.fail('identifier expected after pre-increment or pre-decrement');
    }
    const { name, subscript } = this.current;
    const target =
      this.suppress > 0 ? undefined : this.session.host.resolveTarget(name, subscript, true, this.expandSubscripts);
    const current = this.readValue(target);
    const updated = wrap64(current + delta);
    if (this.suppress === 0 && target) this.store(target, updated);
    this.afterPreIncDec = true;
    this.advance();
    this.afterPreIncDec = false;
    return { value: updated, assignable: false };
  }

  private parsePrimary(): EvalOutcome {
    if (this.isOp('(')) {
      this.advance();
      const inner = this.parseComma();
      if (!this.isOp(')')) this.fail("missing `)'");
      this.advance();
      return { value: inner.value, assignable: false };
    }
    if (this.current.kind === 'number') {
      const { value } = this.current;
      this.advance();
      return { value, assignable: false };
    }
    if (this.current.kind === 'identifier') return this.parseIdentifier();
    return this.fail('arithmetic syntax error: operand expected');
  }

  private parseIdentifier(): EvalOutcome {
    const { name, subscript } = this.current as Extract<LexToken, { kind: 'identifier' }>;
    const peeked = this.peekAfterIdentifier();
    if (peeked.kind === 'op' && peeked.op === '=') {
      this.advance();
      return { value: 0n, assignable: true, deferred: { name, subscript } };
    }
    const target =
      this.suppress > 0 ? undefined : this.session.host.resolveTarget(name, subscript, true, this.expandSubscripts);
    const current = this.readValue(target);
    this.advance();
    if (this.isOp('post++') || this.isOp('post--')) {
      const delta = this.isOp('post++') ? 1n : -1n;
      const updated = wrap64(current + delta);
      if (this.suppress === 0 && target) this.store(target, updated);
      this.advance();
      return { value: current, assignable: false };
    }
    return { value: current, assignable: true, target };
  }

  private peekAfterIdentifier(): LexToken {
    const saved: ScannerSnapshot = {
      cursor: this.cursor,
      errorStart: this.errorStart,
      current: this.current,
    };
    this.suppress++;
    try {
      this.advance();
      return this.current;
    } finally {
      this.suppress--;
      this.cursor = saved.cursor;
      this.errorStart = saved.errorStart;
      this.current = saved.current;
    }
  }

  private readValue(target: ArithmeticTarget | undefined): bigint {
    if (!target || this.suppress > 0) return 0n;
    const raw = this.session.host.readTarget(target);
    return raw ? this.session.evaluateSubexpression(raw) : 0n;
  }

  private store(target: ArithmeticTarget, value: bigint): void {
    if (target.kind === 'invalidElement' && target.emptyWrite) {
      const prefix = this.session.commandName === undefined ? '' : `${this.session.commandName}: `;
      this.session.host.reportError(`${prefix}\`${target.raw}': not a valid identifier`);
      throw new ArithmeticStoreError(false);
    }
    const status = this.session.host.writeTarget(target, value.toString());
    if (status === 'readonly' || status === 'invalid') throw new ArithmeticStoreError(status === 'readonly');
  }

  private isOp(op: OperatorText): boolean {
    return this.current.kind === 'op' && this.current.op === op;
  }

  private isEof(): boolean {
    return this.current.kind === 'eof';
  }

  // ---------------------------------------------------------------- lexer

  private advance(): void {
    this.session.spend();
    let pos = this.cursor;
    while (pos < this.source.length && isSpace(this.source[pos])) pos++;
    if (pos >= this.source.length) {
      this.current = { kind: 'eof' };
      this.cursor = pos;
      return;
    }
    this.errorStart = pos;
    const ch = this.source[pos];
    if (isIdentStart(ch)) {
      this.scanIdentifier(pos);
      return;
    }
    if (ch >= '0' && ch <= '9') {
      this.scanNumber(pos);
      return;
    }
    this.scanOperator(pos);
  }

  private scanIdentifier(start: number): void {
    let end = start + 1;
    while (end < this.source.length && isIdentPart(this.source[end])) end++;
    let subscript: string | undefined;
    if (this.source[end] === '[') {
      const close = skipSubscript(this.source, end);
      if (close >= this.source.length || this.source[close] !== ']') this.fail('bad array subscript');
      subscript = this.source.slice(end + 1, close);
      end = close + 1;
    }
    this.current = {
      kind: 'identifier',
      name: this.source.slice(
        start,
        subscript === undefined ? end : start + this.source.slice(start, end).indexOf('[')
      ),
      subscript,
    };
    this.cursor = end;
  }

  private scanNumber(start: number): void {
    let end = start + 1;
    while (
      end < this.source.length &&
      (isAsciiAlnum(this.source[end]) ||
        this.source[end] === '#' ||
        this.source[end] === '@' ||
        this.source[end] === '_')
    ) {
      end++;
    }
    this.errorEnd = end;
    const value = this.parseIntegerConstant(this.source.slice(start, end));
    this.errorEnd = undefined;
    this.current = { kind: 'number', value };
    this.cursor = end;
  }

  private scanOperator(start: number): void {
    const three = this.source.slice(start, start + 3);
    const threeOp = COMPOUND_OPERATORS.get(three);
    if (threeOp) {
      this.setOp(threeOp, start + 3);
      return;
    }
    const two = this.source.slice(start, start + 2);
    if (two === '++' || two === '--') {
      this.scanIncDec(two[0] as '+' | '-', start);
      return;
    }
    const twoCompound = COMPOUND_OPERATORS.get(two);
    if (twoCompound) {
      this.setOp(twoCompound, start + 2);
      return;
    }
    const twoOp = TWO_CHAR_OPERATORS.get(two);
    if (twoOp) {
      this.setOp(twoOp, start + 2);
      return;
    }
    const one = this.source[start] as OperatorText;
    if (SINGLE_CHAR_OPERATORS.has(one)) {
      this.setOp(one, start + 1);
      return;
    }
    const expectsOperand =
      this.current.kind === 'eof' ||
      (this.current.kind === 'op' &&
        this.current.op !== ')' &&
        this.current.op !== 'post++' &&
        this.current.op !== 'post--');
    this.fail(`arithmetic syntax error: ${expectsOperand ? 'operand expected' : 'invalid arithmetic operator'}`);
  }

  private scanIncDec(sign: '+' | '-', start: number): void {
    if (this.afterPreIncDec) {
      this.fail(sign === '-' ? '--: assignment requires lvalue' : '++: assignment requires lvalue');
    }
    if (this.current.kind === 'identifier') {
      this.setOp(sign === '-' ? 'post--' : 'post++', start + 2);
      return;
    }
    let look = start + 2;
    while (look < this.source.length && isSpace(this.source[look])) look++;
    if (look < this.source.length && isIdentStart(this.source[look])) {
      this.setOp(sign === '-' ? 'pre--' : 'pre++', start + 2);
      return;
    }
    this.setOp(sign, start + 1);
  }

  private setOp(op: OperatorText, nextCursor: number): void {
    this.current = { kind: 'op', op };
    this.cursor = nextCursor;
  }

  // code-gauge-allow functionCognitiveComplexity -- Parses 0x hex, leading-0 octal, decimal, and base#digits (bases 2..64) integer constants.
  // code-gauge-allow functionNcss -- Parses 0x hex, leading-0 octal, decimal, and base#digits (bases 2..64) integer constants.
  private parseIntegerConstant(literal: string): bigint {
    let idx = 0;
    let radix = 10n;
    let hasPrefix = false;
    if (literal[0] === '0') {
      if (literal.length === 1) return 0n;
      if (literal[1] === 'x' || literal[1] === 'X') {
        radix = 16n;
        idx = 2;
      } else {
        radix = 8n;
        idx = 1;
      }
      hasPrefix = true;
    }
    let acc = 0n;
    while (idx < literal.length) {
      const ch = literal[idx++];
      if (ch === '#') {
        if (hasPrefix) this.fail('invalid number');
        if (acc < 2n || acc > 64n) this.fail('invalid arithmetic base');
        radix = acc;
        acc = 0n;
        hasPrefix = true;
        if (idx >= literal.length || !isBase64Digit(literal[idx])) this.fail('invalid integer constant');
        continue;
      }
      if (!isBase64Digit(ch)) break;
      const digit = radixDigit(ch, radix);
      if (digit >= radix) this.fail('value too great for base');
      acc = wrap64(acc * radix + digit);
    }
    return acc;
  }

  private fail(message: string): never {
    throw formatError(this.session.commandName, this.source, this.errorEnd, this.errorStart, message);
  }
}

function formatError(
  commandName: string | undefined,
  source: string,
  end: number | undefined,
  tokenStart: number,
  message: string
): ArithmeticError {
  const shown = source.slice(0, end);
  let lead = 0;
  while (lead < shown.length && isBlank(shown[lead])) lead++;
  const prefix = commandName === undefined ? '' : `${commandName}: `;
  const errorToken = tokenStart < shown.length ? shown.slice(tokenStart) : '';
  return new ArithmeticError(`${prefix}${shown.slice(lead)}: ${message} (error token is "${errorToken}")`);
}

function isBase64Digit(c: string): boolean {
  return isAsciiAlnum(c) || c === '_' || c === '@';
}

function radixDigit(c: string, radix: bigint): bigint {
  const code = c.codePointAt(0) as number;
  if (c >= '0' && c <= '9') return BigInt(code - 48);
  if (c >= 'a' && c <= 'z') return BigInt(code - 97 + 10);
  if (c >= 'A' && c <= 'Z') return BigInt(code - 65 + (radix <= 36n ? 10 : 36));
  return c === '@' ? 62n : 63n;
}

function safeDivide64(a: bigint, b: bigint): bigint {
  return a === MIN_INT64 && b === -1n ? MIN_INT64 : wrap64(a / b);
}

function safeModulo64(a: bigint, b: bigint): bigint {
  return a === MIN_INT64 && b === -1n ? 0n : wrap64(a % b);
}

function shiftLeft64(a: bigint, b: bigint): bigint {
  return wrap64(a << BigInt.asUintN(6, b));
}

function shiftRight64(a: bigint, b: bigint): bigint {
  return a >> BigInt.asUintN(6, b);
}

function pow64(base: bigint, exponent: bigint, spend: () => void): bigint {
  let acc = 1n;
  let factor = base;
  let remaining = exponent;
  while (remaining > 0n) {
    spend();
    if (remaining & 1n) acc = wrap64(acc * factor);
    remaining >>= 1n;
    factor = wrap64(factor * factor);
  }
  return acc;
}

function applyCompound(op: OperatorText, a: bigint, b: bigint): bigint {
  switch (op) {
    case '+=': {
      return wrap64(a + b);
    }
    case '-=': {
      return wrap64(a - b);
    }
    case '*=': {
      return wrap64(a * b);
    }
    case '/=': {
      return safeDivide64(a, b);
    }
    case '%=': {
      return safeModulo64(a, b);
    }
    case '<<=': {
      return shiftLeft64(a, b);
    }
    case '>>=': {
      return shiftRight64(a, b);
    }
    case '&=': {
      return a & b;
    }
    case '^=': {
      return a ^ b;
    }
    case '|=': {
      return a | b;
    }
    default: {
      throw new Error(`Unsupported compound operator ${op}`);
    }
  }
}
