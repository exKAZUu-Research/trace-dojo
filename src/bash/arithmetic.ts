// code-gauge-allow-file fileNcss 559 -- A port of Bash's expr.c, whose recursive-descent levels and token reader share one evaluator's state.
/**
 * Bash's arithmetic evaluator, ported from `expr.c` of Bash 5.3 so that its results, its order of side effects, and
 * its error messages (which quote the remaining text as the "error token") match.
 */

/** What arithmetic reads and writes: the shell's variables, which hold strings that are themselves expressions. */
export interface ArithmeticHost {
  /** The value of a variable or of an array element named with its subscript (`a[i+1]`), or `undefined` when unset. */
  valueOf(token: string, isElement: boolean): { value: string | undefined; index: bigint };
  /** Assigns a value to a variable, or to an array element named with its subscript (`a[3]`). */
  assign(lhs: string, value: string): void;
  /** Evaluates an indexed array's subscript, or `undefined` when the variable is an associative array. */
  isAssociative(name: string): boolean;
}

/** An evaluation error, whose message already holds Bash's `expression: message (error token is "...")` form. */
export class ArithmeticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArithmeticError';
  }
}

const MAX_EXPR_RECURSION_LEVEL = 1024;

enum Token {
  End = 0,
  EQEQ = 1,
  NEQ,
  LEQ,
  GEQ,
  STR,
  NUM,
  LAND,
  LOR,
  LSH,
  RSH,
  OP_ASSIGN,
  COND,
  POWER,
  PREINC,
  PREDEC,
  POSTINC,
  POSTDEC,
  /** `++` or `--`, which `readtok` resolves by what surrounds it. */
  INCDEC,
}

const EQ = '='.codePointAt(0) as number;
const GT = '>'.codePointAt(0) as number;
const LT = '<'.codePointAt(0) as number;
const PLUS = '+'.codePointAt(0) as number;
const MINUS = '-'.codePointAt(0) as number;
const MUL = '*'.codePointAt(0) as number;
const DIV = '/'.codePointAt(0) as number;
const MOD = '%'.codePointAt(0) as number;
const NOT = '!'.codePointAt(0) as number;
const LPAR = '('.codePointAt(0) as number;
const RPAR = ')'.codePointAt(0) as number;
const BAND = '&'.codePointAt(0) as number;
const BOR = '|'.codePointAt(0) as number;
const BXOR = '^'.codePointAt(0) as number;
const BNOT = '~'.codePointAt(0) as number;
const QUES = '?'.codePointAt(0) as number;
const COL = ':'.codePointAt(0) as number;
const COMMA = ','.codePointAt(0) as number;

const INTMAX_MIN = -(2n ** 63n);

/** The tokens of two characters, before `readtok` resolves the ones that depend on what follows or precedes them. */
const TWO_CHARACTER_TOKENS: Record<string, number> = {
  '==': Token.EQEQ,
  '!=': Token.NEQ,
  '>=': Token.GEQ,
  '<=': Token.LEQ,
  '<<': Token.LSH,
  '>>': Token.RSH,
  '&&': Token.LAND,
  '||': Token.LOR,
  '**': Token.POWER,
  '++': Token.INCDEC,
  '--': Token.INCDEC,
};

const toInt64 = (value: bigint): bigint => BigInt.asIntN(64, value);

interface LValue {
  tokstr: string | undefined;
  tokval: bigint;
  ind: bigint;
}

interface Context {
  expression: string;
  curtok: number;
  lasttok: number;
  tp: number;
  lasttp: number;
  tokval: bigint;
  tokstr: string | undefined;
  noeval: number;
  lval: LValue;
}

const newLValue = (): LValue => ({ tokstr: undefined, tokval: -1n, ind: -1n });

const isWhitespace = (c: string): boolean => c === ' ' || c === '\t';
const isCrWhitespace = (c: string): boolean => isWhitespace(c) || c === '\n';
const isVariableStarter = (c: string): boolean => /^[A-Za-z_]$/.test(c);
const isVariableChar = (c: string): boolean => /^[A-Za-z0-9_]$/.test(c);
const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isAlnum = (c: string): boolean => /^[A-Za-z0-9]$/.test(c);
const isValidNumChar = (c: string): boolean => isAlnum(c) || c === '_' || c === '@';

/**
 * Evaluates an arithmetic expression whose expansions are already substituted, throwing an {@link ArithmeticError}.
 *
 * @param commandName The command whose arguments hold the expression (`let`, `((`), which errors name.
 */
export function evaluateArithmetic(
  expression: string,
  host: ArithmeticHost,
  commandName: string | undefined,
  spend: () => void
): bigint {
  return new Evaluator(host, commandName, spend).subexpr(expression);
}

class Evaluator {
  private expression = '';
  private tp = 0;
  private lasttp = 0;
  private curtok = 0;
  private lasttok = 0;
  private assigntok = 0;
  private tokstr: string | undefined;
  private tokval = 0n;
  private noeval = 0;
  /** Where the expression ends while a number is read, or `undefined` for its whole text. */
  private end: number | undefined;
  private curlval: LValue = newLValue();
  private readonly stack: Context[] = [];

  /** The current token, read through a getter because `readtok` changes it behind the type checker's narrowing. */
  private get token(): number {
    return this.curtok;
  }

  private get tokenText(): string | undefined {
    return this.tokstr;
  }

  constructor(
    private readonly host: ArithmeticHost,
    private readonly commandName: string | undefined,
    private readonly spend: () => void
  ) {}

  subexpr(expr: string): bigint {
    let p = 0;
    while (p < expr.length && isCrWhitespace(expr[p])) p++;
    if (p >= expr.length) return 0n;
    this.pushexp();
    this.expression = expr;
    this.tp = 0;
    this.curtok = this.lasttok = 0;
    this.tokstr = undefined;
    this.tokval = 0n;
    this.curlval = newLValue();
    this.readtok();
    const value = this.expcomma();
    if (this.curtok !== 0) this.evalerror('arithmetic syntax error in expression');
    this.popexp();
    return value;
  }

  private pushexp(): void {
    if (this.stack.length >= MAX_EXPR_RECURSION_LEVEL) this.evalerror('expression recursion level exceeded');
    this.stack.push({ expression: this.expression, ...this.saveToken() });
  }

  private popexp(): void {
    const context = this.stack.pop() as Context;
    this.expression = context.expression;
    this.restoreToken(context);
  }

  private saveToken(): Omit<Context, 'expression'> {
    return {
      curtok: this.curtok,
      lasttok: this.lasttok,
      tp: this.tp,
      lasttp: this.lasttp,
      tokval: this.tokval,
      tokstr: this.tokstr,
      noeval: this.noeval,
      lval: { ...this.curlval },
    };
  }

  private restoreToken(context: Omit<Context, 'expression'>): void {
    this.curtok = context.curtok;
    this.lasttok = context.lasttok;
    this.tp = context.tp;
    this.lasttp = context.lasttp;
    this.tokval = context.tokval;
    this.tokstr = context.tokstr;
    this.noeval = context.noeval;
    this.curlval = { ...context.lval };
  }

  private expcomma(): bigint {
    let value = this.expassign();
    while (this.curtok === COMMA) {
      this.readtok();
      value = this.expassign();
    }
    return value;
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- A port of Bash's expassign, whose compound operators share the token state of the assignment.
  // code-gauge-allow functionNcss 31 -- A port of Bash's expassign, whose compound operators share the token state of the assignment.
  private expassign(): bigint {
    let value = this.expcond();
    if (this.curtok !== EQ && this.curtok !== Token.OP_ASSIGN) return value;
    const special = this.curtok === Token.OP_ASSIGN;
    if (this.lasttok !== Token.STR) this.evalerror('attempted assignment to non-variable');
    const op = this.assigntok;
    const lvalue = value;
    if (this.tokstr === undefined) this.evalerror('arithmetic syntax error in variable assignment');
    const lhs = this.tokstr as string;
    const lind = this.curlval.ind;
    this.readtok();
    value = this.expassign();
    if (special) {
      if ((op === DIV || op === MOD) && value === 0n) {
        if (this.noeval === 0) this.evalerror('division by 0');
        else value = 1n;
      }
      value = applyOperator(op, lvalue, value);
    }
    if (this.noeval === 0) {
      if (lind !== -1n) this.bindArrayElement(lhs, lind, value.toString());
      else this.host.assign(lhs, value.toString());
    }
    if (this.curlval.tokstr !== undefined && this.curlval.tokstr === this.tokstr) this.curlval = newLValue();
    this.tokstr = undefined;
    return value;
  }

  private expcond(): bigint {
    const cval = this.explor();
    let rval = cval;
    if (this.curtok !== QUES) return rval;
    let setNoeval = false;
    if (cval === 0n) {
      setNoeval = true;
      this.noeval++;
    }
    this.readtok();
    if (this.curtok === 0 || this.curtok === COL) this.evalerror('expression expected');
    const val1 = this.expcomma();
    if (setNoeval) this.noeval--;
    if (this.curtok !== COL) this.evalerror("`:' expected for conditional expression");
    setNoeval = false;
    if (cval !== 0n) {
      setNoeval = true;
      this.noeval++;
    }
    this.readtok();
    if (this.curtok === 0) this.evalerror('expression expected');
    const val2 = this.expcond();
    if (setNoeval) this.noeval--;
    rval = cval === 0n ? val2 : val1;
    this.lasttok = Token.COND;
    return rval;
  }

  private explor(): bigint {
    let val1 = this.expland();
    while (this.curtok === Token.LOR) {
      const setNoeval = val1 !== 0n;
      if (setNoeval) this.noeval++;
      this.readtok();
      const val2 = this.expland();
      if (setNoeval) this.noeval--;
      val1 = val1 !== 0n || val2 !== 0n ? 1n : 0n;
      this.lasttok = Token.LOR;
    }
    return val1;
  }

  private expland(): bigint {
    let val1 = this.expbor();
    while (this.curtok === Token.LAND) {
      const setNoeval = val1 === 0n;
      if (setNoeval) this.noeval++;
      this.readtok();
      const val2 = this.expbor();
      if (setNoeval) this.noeval--;
      val1 = val1 !== 0n && val2 !== 0n ? 1n : 0n;
      this.lasttok = Token.LAND;
    }
    return val1;
  }

  private binaryLevel(
    operators: readonly number[],
    next: () => bigint,
    apply: (op: number, a: bigint, b: bigint) => bigint
  ): bigint {
    let val1 = next();
    while (operators.includes(this.curtok)) {
      const op = this.curtok;
      this.readtok();
      const val2 = next();
      val1 = toInt64(apply(op, val1, val2));
      this.lasttok = Token.NUM;
    }
    return val1;
  }

  private expbor(): bigint {
    return this.binaryLevel(
      [BOR],
      () => this.expbxor(),
      (_, a, b) => a | b
    );
  }

  private expbxor(): bigint {
    return this.binaryLevel(
      [BXOR],
      () => this.expband(),
      (_, a, b) => a ^ b
    );
  }

  private expband(): bigint {
    return this.binaryLevel(
      [BAND],
      () => this.expeq(),
      (_, a, b) => a & b
    );
  }

  private expeq(): bigint {
    return this.binaryLevel(
      [Token.EQEQ, Token.NEQ],
      () => this.expcompare(),
      (op, a, b) => ((op === Token.EQEQ ? a === b : a !== b) ? 1n : 0n)
    );
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- A port of Bash's expcompare, one comparison per operator token.
  private expcompare(): bigint {
    return this.binaryLevel(
      [Token.LEQ, Token.GEQ, LT, GT],
      () => this.expshift(),
      (op, a, b) => {
        if (op === Token.LEQ) return a <= b ? 1n : 0n;
        if (op === Token.GEQ) return a >= b ? 1n : 0n;
        if (op === LT) return a < b ? 1n : 0n;
        return a > b ? 1n : 0n;
      }
    );
  }

  private expshift(): bigint {
    return this.binaryLevel(
      [Token.LSH, Token.RSH],
      () => this.expaddsub(),
      (op, a, b) => (op === Token.LSH ? shiftLeft(a, b) : shiftRight(a, b))
    );
  }

  private expaddsub(): bigint {
    return this.binaryLevel(
      [PLUS, MINUS],
      () => this.expmuldiv(),
      (op, a, b) => (op === PLUS ? a + b : a - b)
    );
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- A port of Bash's expmuldiv, whose division checks follow its order of errors and overflow.
  private expmuldiv(): bigint {
    let val1 = this.exppower();
    while (this.curtok === MUL || this.curtok === DIV || this.curtok === MOD) {
      const op = this.curtok;
      const stp = this.tp;
      this.readtok();
      let val2 = this.exppower();
      if ((op === DIV || op === MOD) && val2 === 0n) {
        if (this.noeval === 0) {
          this.lasttp = stp;
          while (this.lasttp < this.expression.length && isWhitespace(this.expression[this.lasttp])) this.lasttp++;
          this.evalerror('division by 0');
        } else val2 = 1n;
      } else if (op === MOD && val1 === INTMAX_MIN && val2 === -1n) {
        val1 = 0n;
        continue;
      } else if (op === DIV && val1 === INTMAX_MIN && val2 === -1n) val2 = 1n;
      val1 = toInt64(applyOperator(op, val1, val2));
      this.lasttok = Token.NUM;
    }
    return val1;
  }

  private exppower(): bigint {
    let val1 = this.expunary();
    while (this.curtok === Token.POWER) {
      this.readtok();
      const val2 = this.exppower();
      this.lasttok = Token.NUM;
      if (this.noeval === 0) {
        if (val2 === 0n) return 1n;
        if (val2 < 0n) this.evalerror('exponent less than 0');
        val1 = power(val1, val2, this.spend);
      } else val1 = 1n;
    }
    return val1;
  }

  private expunary(): bigint {
    const unary: Record<number, (value: bigint) => bigint> = {
      [NOT]: (value) => (value === 0n ? 1n : 0n),
      [BNOT]: (value) => ~value,
      [MINUS]: (value) => toInt64(-value),
      [PLUS]: (value) => value,
    };
    const apply = unary[this.curtok];
    if (!apply) return this.exp0();
    this.readtok();
    const value = apply(this.expunary());
    this.lasttok = Token.NUM;
    return value;
  }

  private exp0(): bigint {
    if (this.curtok === Token.PREINC || this.curtok === Token.PREDEC) return this.preIncrement();
    if (this.curtok === LPAR) {
      this.readtok();
      const value = this.expcomma();
      if (this.curtok !== RPAR) this.evalerror("missing `)'");
      this.readtok();
      return value;
    }
    if (this.curtok === Token.NUM) {
      const value = this.tokval;
      this.readtok();
      return value;
    }
    if (this.curtok === Token.STR) return this.variable();
    return this.evalerror('arithmetic syntax error: operand expected');
  }

  /** `++x` and `--x`. */
  private preIncrement(): bigint {
    const stok = (this.lasttok = this.curtok);
    this.readtok();
    if (this.token !== Token.STR) this.evalerror('identifier expected after pre-increment or pre-decrement');
    const value = toInt64(this.tokval + (stok === Token.PREINC ? 1n : -1n));
    if (this.noeval === 0) {
      if (this.curlval.ind !== -1n) this.bindArrayElement(this.curlval.tokstr as string, this.curlval.ind, `${value}`);
      else if (this.tokstr !== undefined) this.host.assign(this.tokstr, `${value}`);
    }
    this.curtok = Token.NUM;
    this.readtok();
    return value;
  }

  /** A variable's value, and `x++` and `x--`, which Bash tells apart by reading the next token ahead. */
  private variable(): bigint {
    const value = this.tokval;
    const ec = this.saveToken();
    this.tokstr = undefined;
    this.noeval = 1;
    this.readtok();
    const stok = this.token;
    if (stok === Token.POSTINC || stok === Token.POSTDEC) {
      this.tokstr = ec.tokstr;
      this.noeval = ec.noeval;
      this.curlval = { ...ec.lval };
      this.lasttok = Token.STR;
      const updated = toInt64(value + (stok === Token.POSTINC ? 1n : -1n));
      if (this.noeval === 0) {
        if (this.curlval.ind !== -1n)
          this.bindArrayElement(this.curlval.tokstr as string, this.curlval.ind, `${updated}`);
        else this.host.assign(this.tokstr as string, `${updated}`);
      }
      this.curtok = Token.NUM;
    } else this.restoreToken(ec);
    this.readtok();
    return value;
  }

  private bindArrayElement(token: string, index: bigint, value: string): void {
    const name = token.slice(0, token.indexOf('['));
    this.host.assign(`${name}[${index}]`, value);
  }

  private streval(token: string, isElement: boolean): bigint {
    if (this.noeval) return 0n;
    const { value, index } = this.host.valueOf(token, isElement);
    const tval = value ? this.subexpr(value) : 0n;
    this.curlval = { tokstr: token, tokval: tval, ind: index };
    return tval;
  }

  /** Reads the next token, as Bash's `readtok`: a variable (whose value it evaluates), a number, or an operator. */
  private readtok(): void {
    this.spend();
    const expr = this.expression;
    let cp = this.tp;
    while (cp < expr.length && isCrWhitespace(expr[cp])) cp++;
    if (cp >= expr.length) {
      this.lasttok = this.curtok;
      this.curtok = 0;
      this.tp = cp;
      return;
    }
    const c = expr[cp];
    this.lasttp = this.tp = cp;
    if (isVariableStarter(c)) this.readVariable(cp + 1);
    else if (isDigit(c)) this.readNumber(cp + 1);
    else this.readOperator(c, cp + 1);
  }

  private readVariable(start: number): void {
    const expr = this.expression;
    let cp = start;
    let isElement = false;
    while (cp < expr.length && isVariableChar(expr[cp])) cp++;
    if (expr[cp] === '[') {
      const end = skipSubscript(expr, cp);
      if (end >= expr.length || expr[end] !== ']') this.evalerror('bad array subscript');
      cp = end + 1;
      isElement = true;
    }
    if (this.curlval.tokstr !== undefined && this.curlval.tokstr === this.tokstr) this.curlval = newLValue();
    this.tokstr = expr.slice(this.tp, cp);
    // Reads the next token ahead without evaluating it, since an assignment does not read the variable first.
    const ec = this.saveToken();
    this.tokstr = undefined;
    this.tp = cp;
    this.noeval = 1;
    this.curtok = Token.STR;
    this.readtok();
    const peektok = this.token;
    this.restoreToken(ec);
    this.tp = cp;
    const token = this.tokenText as string;
    const assignsOnly = this.lasttok !== Token.PREINC && this.lasttok !== Token.PREDEC && peektok === EQ;
    this.tokval = assignsOnly ? 0n : this.streval(token, isElement);
    this.lasttok = this.curtok;
    this.curtok = Token.STR;
  }

  private readNumber(start: number): void {
    const expr = this.expression;
    let cp = start;
    while (cp < expr.length && (isAlnum(expr[cp]) || expr[cp] === '#' || expr[cp] === '@' || expr[cp] === '_')) cp++;
    // Bash ends the expression at the number while it reads one, so an error there quotes the text up to it.
    this.end = cp;
    this.tokval = this.strlong(expr.slice(this.tp, cp));
    this.end = undefined;
    this.lasttok = this.curtok;
    this.curtok = Token.NUM;
    this.tp = cp;
  }

  private readOperator(c: string, start: number): void {
    const expr = this.expression;
    let cp = start;
    const c1 = cp < expr.length ? expr[cp] : '';
    cp++;
    let token = TWO_CHARACTER_TOKENS[`${c}${c1}`] ?? (c.codePointAt(0) as number);
    if ((token === Token.LSH || token === Token.RSH) && expr[cp] === '=') {
      this.assigntok = token;
      token = Token.OP_ASSIGN;
      cp++;
    } else if (token === Token.INCDEC) {
      ({ token, cp } = this.incrementOperator(c, cp));
    } else if (c1 === '=' && '*/%+-&^|'.includes(c)) {
      this.assigntok = c.codePointAt(0) as number;
      token = Token.OP_ASSIGN;
    } else if (TWO_CHARACTER_TOKENS[`${c}${c1}`] === undefined) {
      cp--;
      if (!isArithop(token)) {
        const expectsOperand = this.curtok === 0 || isArithop(this.curtok) || isMultiop(this.curtok);
        this.evalerror(
          `arithmetic syntax error: ${expectsOperand ? 'operand expected' : 'invalid arithmetic operator'}`
        );
      }
    }
    this.lasttok = this.curtok;
    this.curtok = token;
    this.tp = cp;
  }

  /** `++` and `--`: after a variable a post-increment, before one a pre-increment, otherwise two signs. */
  private incrementOperator(c: string, start: number): { token: number; cp: number } {
    if (this.curtok === Token.STR) return { token: c === '-' ? Token.POSTDEC : Token.POSTINC, cp: start };
    if (this.curtok === Token.NUM && (this.lasttok === Token.PREINC || this.lasttok === Token.PREDEC)) {
      this.evalerror(c === '-' ? '--: assignment requires lvalue' : '++: assignment requires lvalue');
    }
    let xp = start;
    while (xp < this.expression.length && isCrWhitespace(this.expression[xp])) xp++;
    if (xp < this.expression.length && isVariableStarter(this.expression[xp])) {
      return { token: c === '-' ? Token.PREDEC : Token.PREINC, cp: start };
    }
    return { token: c.codePointAt(0) as number, cp: start - 1 };
  }

  private evalerror(message: string): never {
    const expression = this.expression.slice(0, this.end);
    let t = 0;
    while (t < expression.length && isWhitespace(expression[t])) t++;
    const name = this.commandName === undefined ? '' : `${this.commandName}: `;
    const token = this.lasttp < expression.length ? expression.slice(this.lasttp) : '';
    throw new ArithmeticError(`${name}${expression.slice(t)}: ${message} (error token is "${token}")`);
  }

  // code-gauge-allow functionCognitiveComplexity 26 -- A port of Bash's strlong, whose base prefixes, base#digits, and digit values share one scan.
  // code-gauge-allow functionNcss 36 -- A port of Bash's strlong, whose base prefixes, base#digits, and digit values share one scan.
  private strlong(num: string): bigint {
    let s = 0;
    let base = 10n;
    let foundbase = 0;
    if (num[s] === '0') {
      s++;
      if (s >= num.length) return 0n;
      if (num[s] === 'x' || num[s] === 'X') {
        base = 16n;
        s++;
      } else base = 8n;
      foundbase++;
    }
    let val = 0n;
    while (s < num.length) {
      const c = num[s++];
      if (c === '#') {
        if (foundbase) this.evalerror('invalid number');
        if (val < 2n || val > 64n) this.evalerror('invalid arithmetic base');
        base = val;
        val = 0n;
        foundbase++;
        if (s >= num.length || !isValidNumChar(num[s])) this.evalerror('invalid integer constant');
      } else if (isValidNumChar(c)) {
        const digit = digitValue(c, base);
        if (digit >= base) this.evalerror('value too great for base');
        val = toInt64(val * base + digit);
      } else break;
    }
    return val;
  }
}

function digitValue(c: string, base: bigint): bigint {
  if (isDigit(c)) return BigInt((c.codePointAt(0) as number) - 48);
  if (c >= 'a' && c <= 'z') return BigInt((c.codePointAt(0) as number) - 97 + 10);
  if (c >= 'A' && c <= 'Z') return BigInt((c.codePointAt(0) as number) - 65 + (base <= 36n ? 10 : 36));
  return c === '@' ? 62n : 63n;
}

function applyOperator(op: number, a: bigint, b: bigint): bigint {
  switch (op) {
    case MUL: {
      return toInt64(a * b);
    }
    case DIV: {
      if (a === INTMAX_MIN && b === -1n) return INTMAX_MIN;
      return toInt64(a / b);
    }
    case MOD: {
      if (a === INTMAX_MIN && b === -1n) return 0n;
      return toInt64(a % b);
    }
    case PLUS: {
      return toInt64(a + b);
    }
    case MINUS: {
      return toInt64(a - b);
    }
    case Token.LSH: {
      return shiftLeft(a, b);
    }
    case Token.RSH: {
      return shiftRight(a, b);
    }
    case BAND: {
      return a & b;
    }
    case BOR: {
      return a | b;
    }
    case BXOR: {
      return a ^ b;
    }
    default: {
      throw new Error(`Unknown arithmetic operator ${op}`);
    }
  }
}

/** A shift as the arm64 CPU does it, which uses only the low 6 bits of the count, as C leaves larger counts undefined. */
function shiftLeft(a: bigint, b: bigint): bigint {
  return toInt64(a << BigInt.asUintN(6, b));
}

function shiftRight(a: bigint, b: bigint): bigint {
  return a >> BigInt.asUintN(6, b);
}

function power(base: bigint, exponent: bigint, spend: () => void): bigint {
  let result = 1n;
  let b = base;
  let e = exponent;
  while (e) {
    spend();
    if (e & 1n) result = toInt64(result * b);
    e >>= 1n;
    b = toInt64(b * b);
  }
  return result;
}

function isMultiop(c: number): boolean {
  return [
    Token.EQEQ,
    Token.NEQ,
    Token.LEQ,
    Token.GEQ,
    Token.LAND,
    Token.LOR,
    Token.LSH,
    Token.RSH,
    Token.OP_ASSIGN,
    Token.COND,
    Token.POWER,
    Token.PREINC,
    Token.PREDEC,
    Token.POSTINC,
    Token.POSTDEC,
  ].includes(c);
}

function isArithop(c: number): boolean {
  return [EQ, GT, LT, PLUS, MINUS, MUL, DIV, MOD, NOT, LPAR, RPAR, BAND, BOR, BXOR, BNOT, QUES, COL, COMMA].includes(c);
}

/** The index of the `]` that closes the subscript opening at `start`, counting nested brackets, as Bash's skipsubscript. */
export function skipSubscript(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      i++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}
