/**
 * Translates a Java fragment written in a blank into the instrumented (JavaScript) dialect used by `traceProgram`.
 * Only a conservative subset of Java is supported; anything else throws `UnsupportedJavaError`,
 * which tells the grader to fall back to real Java execution.
 *
 * The translated code is evaluated inside the server process, so this module is a privilege boundary:
 * it must never emit an identifier, member name, or index expression that it does not understand.
 */

export class UnsupportedJavaError extends Error {
  constructor(message: string) {
    super(`Unsupported Java fragment: ${message}`);
    this.name = 'UnsupportedJavaError';
  }
}

interface Token {
  type: 'number' | 'identifier' | 'operator';
  value: string;
}

/** Turtle members whose JavaScript counterparts have identical semantics, keyed by Java name. */
const turtleMemberMap = new Map([
  ['前に進む', 'forward'],
  ['forward', 'forward'],
  ['後に戻る', 'backward'],
  ['backward', 'backward'],
  ['右を向く', 'turnRight'],
  ['turnRight', 'turnRight'],
  ['左を向く', 'turnLeft'],
  ['turnLeft', 'turnLeft'],
  ['前に進めるか', 'canMoveForward'],
  ['canMoveForward', 'canMoveForward'],
  ['前のマスが塗られているか', '前のマスが塗られているか'],
  ['remove', 'remove'],
]);
// Only the members whose semantics are identical between Java and JavaScript for int arguments.
const mathMembers = new Set(['max', 'min', 'abs']);
const primitiveTypeNames = new Set(['int', 'long', 'short', 'byte', 'boolean', 'char']);
const MAX_INT = 2_147_483_647;
const literalNames = new Set(['true', 'false']);
const operatorRegex = /^(?:\+\+|--|==|!=|<=|>=|&&|\|\||[+\-*%<>!=(),.;])/;
const identifierRegex = /^[\p{L}_$][\p{L}\p{N}_$]*/u;
const numberRegex = /^\d+/;

/**
 * Extracts identifiers that the instrumented program declares as plain JavaScript bindings
 * (i.e., not stored in the `Scope` object `s`).
 */
export function extractNativeNames(instrumented: string): Set<string> {
  const names = new Set<string>();
  for (const match of instrumented.matchAll(/\b(?:const|let|var|function|class)\s+([\p{L}_$][\p{L}\p{N}_$]*)/gu)) {
    names.add(match[1]);
  }
  for (const match of instrumented.matchAll(/\bfunction\s+[\p{L}_$][\p{L}\p{N}_$]*\s*\(([^)]*)\)/gu)) {
    for (const param of match[1].split(',')) {
      const name = param.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

export function translateJavaFragment(fragment: string, nativeNames: ReadonlySet<string>): string {
  const tokens = tokenize(fragment);
  const segments: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.type === 'operator' && token.value === ';') {
      segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  const endsWithSemicolon = current.length === 0 && segments.length > 0;
  if (current.length > 0) segments.push(current);

  // Turtle variables declared earlier in the same fragment are plain JavaScript bindings too.
  const scopedNativeNames = new Set(nativeNames);
  const translated = segments.map((segment) => translateSegment(segment, scopedNativeNames));
  return translated.join('; ') + (endsWithSemicolon ? ';' : '');
}

function translateSegment(tokens: Token[], nativeNames: Set<string>): string {
  if (tokens.length === 0) return '';

  // Declaration: `int x = expr`, `Turtle t = expr`, or `var t = expr`
  if (
    tokens.length >= 3 &&
    tokens[0].type === 'identifier' &&
    tokens[1].type === 'identifier' &&
    isOperator(tokens[2], '=')
  ) {
    const typeName = tokens[0].value;
    const name = tokens[1].value;
    // `var` holds a turtle when initialized from `new` or another turtle binding, and a scope value otherwise.
    const typedValue = new ExpressionTranslator(tokens.slice(3), nativeNames).translate();
    const value = typedValue.code;
    if (primitiveTypeNames.has(typeName) || (typeName === 'var' && typedValue.type !== 'turtle')) {
      return `s.set('${name}', ${value})`;
    }
    if (typeName === 'Turtle' || typeName === 'var' || nativeNames.has(typeName)) {
      nativeNames.add(name);
      return `const ${name} = ${value}`;
    }
    throw new UnsupportedJavaError(`declaration of type ${typeName}`);
  }

  // Assignment: `x = expr`
  if (tokens.length >= 2 && tokens[0].type === 'identifier' && isOperator(tokens[1], '=')) {
    const name = tokens[0].value;
    // Native bindings are `const` in the instrumented program, so reassigning them is left to Java.
    if (nativeNames.has(name)) throw new UnsupportedJavaError(`assignment to ${name}`);
    return `s.set('${name}', ${translateExpression(tokens.slice(2), nativeNames)})`;
  }

  // Increment / decrement: `i++`, `++i`, `i--`, `--i`
  if (tokens.length === 2) {
    const [first, second] = tokens;
    const incrementOperator = isIncrementOperator(first) ? first : isIncrementOperator(second) ? second : undefined;
    const identifier = first.type === 'identifier' ? first : second.type === 'identifier' ? second : undefined;
    if (incrementOperator && identifier) {
      const name = identifier.value;
      if (nativeNames.has(name)) throw new UnsupportedJavaError(`assignment to ${name}`);
      const binaryOperator = incrementOperator.value === '++' ? '+' : '-';
      return `s.set('${name}', (s.get('${name}') ${binaryOperator} 1) | 0)`;
    }
  }

  return translateExpression(tokens, nativeNames);
}

function translateExpression(tokens: Token[], nativeNames: ReadonlySet<string>): string {
  return new ExpressionTranslator(tokens, nativeNames).translate().code;
}

/** A coarse Java type; `unknown` is a scope variable or function result whose type the translator cannot see. */
type JavaType = 'int' | 'boolean' | 'turtle' | 'void' | 'unknown';

interface TypedCode {
  code: string;
  type: JavaType;
}

/**
 * A precedence-climbing parser that emits JavaScript with Java `int` semantics (32-bit wrap-around).
 * Operand types are checked coarsely so that JavaScript coercion cannot accept what javac rejects.
 */
class ExpressionTranslator {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly nativeNames: ReadonlySet<string>
  ) {}

  translate(): TypedCode {
    if (this.tokens.length === 0) throw new UnsupportedJavaError('empty expression');
    const result = this.parseOr();
    if (this.index < this.tokens.length) {
      throw new UnsupportedJavaError(`unexpected token ${this.tokens[this.index].value}`);
    }
    return result;
  }

  private parseOr(): TypedCode {
    let left = this.parseAnd();
    while (this.consumeOperator('||')) {
      left = { code: `${expect(left, 'boolean')} || ${expect(this.parseAnd(), 'boolean')}`, type: 'boolean' };
    }
    return left;
  }

  private parseAnd(): TypedCode {
    let left = this.parseEquality();
    while (this.consumeOperator('&&')) {
      left = { code: `${expect(left, 'boolean')} && ${expect(this.parseEquality(), 'boolean')}`, type: 'boolean' };
    }
    return left;
  }

  // Chained comparisons such as `a < b > c` compare a boolean in Java and do not compile, so only one is allowed.
  private parseEquality(): TypedCode {
    const left = this.parseRelational();
    const operator = this.consumeOperator('==') ? '===' : this.consumeOperator('!=') ? '!==' : undefined;
    if (!operator) return left;
    const right = this.parseRelational();
    if (
      left.type === 'void' ||
      right.type === 'void' ||
      (isKnown(left) && isKnown(right) && left.type !== right.type)
    ) {
      throw new UnsupportedJavaError(`comparison of ${left.type} with ${right.type}`);
    }
    return { code: `${left.code} ${operator} ${right.code}`, type: 'boolean' };
  }

  private parseRelational(): TypedCode {
    const left = this.parseAdditive();
    const operator = ['<', '>', '<=', '>='].find((op) => this.consumeOperator(op));
    if (!operator) return left;
    return { code: `${expect(left, 'int')} ${operator} ${expect(this.parseAdditive(), 'int')}`, type: 'boolean' };
  }

  private parseAdditive(): TypedCode {
    let left = this.parseMultiplicative();
    for (;;) {
      const operator = this.consumeOperator('+') ? '+' : this.consumeOperator('-') ? '-' : undefined;
      if (!operator) return left;
      left = {
        code: `((${expect(left, 'int')} ${operator} ${expect(this.parseMultiplicative(), 'int')}) | 0)`,
        type: 'int',
      };
    }
  }

  private parseMultiplicative(): TypedCode {
    let left = this.parseUnary();
    for (;;) {
      if (this.consumeOperator('*')) {
        left = { code: `Math.imul(${expect(left, 'int')}, ${expect(this.parseUnary(), 'int')})`, type: 'int' };
      } else if (this.consumeOperator('%')) {
        // Java throws on a zero divisor while JavaScript yields NaN, so only nonzero literal divisors are translated.
        const divisor = this.parseUnary();
        if (!/^[1-9]\d*$/.test(divisor.code)) throw new UnsupportedJavaError(`remainder by ${divisor.code}`);
        left = { code: `(${expect(left, 'int')} % ${divisor.code})`, type: 'int' };
      } else {
        return left;
      }
    }
  }

  private parseUnary(): TypedCode {
    if (this.consumeOperator('!')) return { code: `!${expect(this.parseUnary(), 'boolean')}`, type: 'boolean' };
    if (this.consumeOperator('-')) return { code: `((-${expect(this.parseUnary(), 'int')}) | 0)`, type: 'int' };
    if (this.consumeOperator('+')) return { code: expect(this.parseUnary(), 'int'), type: 'int' };
    return this.parsePostfix();
  }

  private parsePostfix(): TypedCode {
    let result = this.parsePrimary();
    while (this.consumeOperator('.')) {
      const member = this.next();
      if (member.type !== 'identifier') throw new UnsupportedJavaError(`member ${member.value}`);
      if (result.code === 'Math') {
        if (!mathMembers.has(member.value)) throw new UnsupportedJavaError(`Math.${member.value}`);
        // `| 0` reproduces Java's `Math.abs(Integer.MIN_VALUE) == Integer.MIN_VALUE`.
        const args = this.parseArguments(member.value === 'abs' ? 1 : 2, 'int');
        result = { code: `(Math.${member.value}${args} | 0)`, type: 'int' };
      } else if (member.value === 'length' && !this.peekOperator('(') && result.type === 'unknown') {
        result = { code: `${result.code}.length`, type: 'int' };
      } else if (result.type === 'turtle' || result.type === 'unknown') {
        const turtleMember = turtleMemberMap.get(member.value);
        if (!turtleMember || !this.peekOperator('(')) throw new UnsupportedJavaError(`member ${member.value}`);
        const type: JavaType = turtleMember.endsWith('か') || turtleMember === 'canMoveForward' ? 'boolean' : 'void';
        result = { code: `${result.code}.${turtleMember}${this.parseArguments(0)}`, type };
      } else {
        throw new UnsupportedJavaError(`member ${member.value} of ${result.type}`);
      }
    }
    return result;
  }

  private parsePrimary(): TypedCode {
    const token = this.next();
    if (token.type === 'number') {
      if (Number(token.value) > MAX_INT) throw new UnsupportedJavaError(`int literal ${token.value}`);
      return { code: token.value, type: 'int' };
    }
    if (token.type === 'operator') {
      if (token.value !== '(') throw new UnsupportedJavaError(`operator ${token.value}`);
      const inner = this.parseOr();
      if (!this.consumeOperator(')')) throw new UnsupportedJavaError('missing )');
      return { code: `(${inner.code})`, type: inner.type };
    }
    const name = token.value;
    if (literalNames.has(name)) return { code: name, type: 'boolean' };
    if (name === 'new') {
      const className = this.next();
      if (className.type !== 'identifier') throw new UnsupportedJavaError('instantiation without a class');
      if (className.value === 'Turtle') {
        return { code: `new Turtle${this.parseArguments([0, 2, 3], 'int')}`, type: 'turtle' };
      }
      if (!this.nativeNames.has(className.value)) throw new UnsupportedJavaError(`instantiation of ${className.value}`);
      return { code: `new ${className.value}${this.parseArguments()}`, type: 'unknown' };
    }
    if (name === 'Math') {
      if (!this.peekOperator('.')) throw new UnsupportedJavaError('Math without member');
      return { code: 'Math', type: 'unknown' };
    }
    if (this.nativeNames.has(name)) {
      // Native bindings in the instrumented programs are turtles (or functions and classes, which are called).
      return this.peekOperator('(')
        ? { code: `${name}${this.parseArguments()}`, type: 'unknown' }
        : { code: name, type: 'turtle' };
    }
    if (this.peekOperator('(')) throw new UnsupportedJavaError(`call of unknown function ${name}`);
    if (
      primitiveTypeNames.has(name) ||
      name === 'var' ||
      name === 'null' ||
      /^\p{Lu}/u.test(name) ||
      name === 'this' ||
      name === 'super'
    ) {
      throw new UnsupportedJavaError(`identifier ${name}`);
    }
    return { code: `s.get('${name}')`, type: 'unknown' };
  }

  /**
   * Parses an argument list; `arity` restricts the accepted argument counts because JavaScript ignores extras,
   * and `argumentType` the accepted operand type.
   */
  private parseArguments(arity?: number | number[], argumentType?: JavaType): string {
    if (!this.consumeOperator('(')) throw new UnsupportedJavaError('missing (');
    const args: string[] = [];
    if (!this.consumeOperator(')')) {
      do {
        const arg = this.parseOr();
        args.push(argumentType ? expect(arg, argumentType) : arg.code);
      } while (this.consumeOperator(','));
      if (!this.consumeOperator(')')) throw new UnsupportedJavaError('missing )');
    }
    const arities = typeof arity === 'number' ? [arity] : arity;
    if (arities && !arities.includes(args.length)) throw new UnsupportedJavaError(`${args.length} arguments`);
    return `(${args.join(', ')})`;
  }

  private next(): Token {
    const token = this.tokens[this.index++];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!token) throw new UnsupportedJavaError('unexpected end of expression');
    return token;
  }

  private peekOperator(value: string): boolean {
    const token = this.tokens[this.index];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return token !== undefined && isOperator(token, value);
  }

  private consumeOperator(value: string): boolean {
    if (!this.peekOperator(value)) return false;
    this.index++;
    return true;
  }
}

function isKnown(typed: TypedCode): boolean {
  return typed.type !== 'unknown';
}

/** Returns the code if its type may be `expected`; a provably different type is left to Java. */
function expect(typed: TypedCode, expected: JavaType): string {
  if (typed.type !== expected && typed.type !== 'unknown') {
    throw new UnsupportedJavaError(`${typed.type} used as ${expected}`);
  }
  return typed.code;
}

function tokenize(fragment: string): Token[] {
  const tokens: Token[] = [];
  let rest = fragment.trim();
  while (rest.length > 0) {
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) {
      rest = rest.slice(whitespace[0].length);
      continue;
    }
    // Java promotes chars to their code points in arithmetic, so a plain char literal becomes a number.
    const char = /^'([^'\\])'/.exec(rest);
    if (char) {
      tokens.push({ type: 'number', value: char[1].codePointAt(0)!.toString() });
      rest = rest.slice(char[0].length);
      continue;
    }
    const number = numberRegex.exec(rest);
    if (number) {
      // Reject radix prefixes, type suffixes, digit separators and decimals, which JavaScript would misread.
      if (/^[\p{L}\p{N}_.]/u.test(rest.slice(number[0].length))) {
        throw new UnsupportedJavaError(`number literal ${rest.slice(0, 10)}`);
      }
      tokens.push({ type: 'number', value: number[0] });
      rest = rest.slice(number[0].length);
      continue;
    }
    const identifier = identifierRegex.exec(rest);
    if (identifier) {
      tokens.push({ type: 'identifier', value: identifier[0] });
      rest = rest.slice(identifier[0].length);
      continue;
    }
    const operator = operatorRegex.exec(rest);
    if (operator) {
      tokens.push({ type: 'operator', value: operator[0] });
      rest = rest.slice(operator[0].length);
      continue;
    }
    throw new UnsupportedJavaError(`token ${rest.slice(0, 10)}`);
  }
  return tokens;
}

function isOperator(token: Token, value: string): boolean {
  return token.type === 'operator' && token.value === value;
}

function isIncrementOperator(token: Token): boolean {
  return token.type === 'operator' && (token.value === '++' || token.value === '--');
}
