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
const primitiveTypeNames = new Set(['int', 'long', 'short', 'byte', 'boolean', 'char', 'var']);
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

  const translated = segments.map((segment) => translateSegment(segment, nativeNames));
  return translated.join('; ') + (endsWithSemicolon ? ';' : '');
}

function translateSegment(tokens: Token[], nativeNames: ReadonlySet<string>): string {
  if (tokens.length === 0) return '';

  // Declaration: `int x = expr` or `Turtle t = expr`
  if (
    tokens.length >= 3 &&
    tokens[0].type === 'identifier' &&
    tokens[1].type === 'identifier' &&
    isOperator(tokens[2], '=')
  ) {
    const typeName = tokens[0].value;
    const name = tokens[1].value;
    const value = translateExpression(tokens.slice(3), nativeNames);
    if (primitiveTypeNames.has(typeName)) return `s.set('${name}', ${value})`;
    if (typeName === 'Turtle' || nativeNames.has(typeName) || nativeNames.has(name)) return `const ${name} = ${value}`;
    throw new UnsupportedJavaError(`declaration of type ${typeName}`);
  }

  // Assignment: `x = expr`
  if (tokens.length >= 2 && tokens[0].type === 'identifier' && isOperator(tokens[1], '=')) {
    const name = tokens[0].value;
    const value = translateExpression(tokens.slice(2), nativeNames);
    return nativeNames.has(name) ? `${name} = ${value}` : `s.set('${name}', ${value})`;
  }

  // Increment / decrement: `i++`, `++i`, `i--`, `--i`
  if (tokens.length === 2) {
    const [first, second] = tokens;
    const incrementOperator = isIncrementOperator(first) ? first : isIncrementOperator(second) ? second : undefined;
    const identifier = first.type === 'identifier' ? first : second.type === 'identifier' ? second : undefined;
    if (incrementOperator && identifier) {
      const name = identifier.value;
      if (nativeNames.has(name)) return `${name}${incrementOperator.value}`;
      const binaryOperator = incrementOperator.value === '++' ? '+' : '-';
      return `s.set('${name}', (s.get('${name}') ${binaryOperator} 1) | 0)`;
    }
  }

  return translateExpression(tokens, nativeNames);
}

function translateExpression(tokens: Token[], nativeNames: ReadonlySet<string>): string {
  return new ExpressionTranslator(tokens, nativeNames).translate();
}

/**
 * A precedence-climbing parser that emits JavaScript with Java `int` semantics (32-bit wrap-around).
 */
class ExpressionTranslator {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly nativeNames: ReadonlySet<string>
  ) {}

  translate(): string {
    if (this.tokens.length === 0) throw new UnsupportedJavaError('empty expression');
    const result = this.parseOr();
    if (this.index < this.tokens.length) {
      throw new UnsupportedJavaError(`unexpected token ${this.tokens[this.index].value}`);
    }
    return result;
  }

  private parseOr(): string {
    let left = this.parseAnd();
    while (this.consumeOperator('||')) left = `${left} || ${this.parseAnd()}`;
    return left;
  }

  private parseAnd(): string {
    let left = this.parseEquality();
    while (this.consumeOperator('&&')) left = `${left} && ${this.parseEquality()}`;
    return left;
  }

  private parseEquality(): string {
    let left = this.parseRelational();
    for (;;) {
      if (this.consumeOperator('==')) left = `${left} === ${this.parseRelational()}`;
      else if (this.consumeOperator('!=')) left = `${left} !== ${this.parseRelational()}`;
      else return left;
    }
  }

  private parseRelational(): string {
    let left = this.parseAdditive();
    for (;;) {
      const operator = ['<', '>', '<=', '>='].find((op) => this.consumeOperator(op));
      if (!operator) return left;
      left = `${left} ${operator} ${this.parseAdditive()}`;
    }
  }

  private parseAdditive(): string {
    let left = this.parseMultiplicative();
    for (;;) {
      if (this.consumeOperator('+')) left = `((${left} + ${this.parseMultiplicative()}) | 0)`;
      else if (this.consumeOperator('-')) left = `((${left} - ${this.parseMultiplicative()}) | 0)`;
      else return left;
    }
  }

  private parseMultiplicative(): string {
    let left = this.parseUnary();
    for (;;) {
      if (this.consumeOperator('*')) left = `Math.imul(${left}, ${this.parseUnary()})`;
      else if (this.consumeOperator('%')) left = `(${left} % ${this.parseUnary()})`;
      else return left;
    }
  }

  private parseUnary(): string {
    if (this.consumeOperator('!')) return `!${this.parseUnary()}`;
    if (this.consumeOperator('-')) return `((-${this.parseUnary()}) | 0)`;
    if (this.consumeOperator('+')) return this.parseUnary();
    return this.parsePostfix();
  }

  private parsePostfix(): string {
    let result = this.parsePrimary();
    while (this.consumeOperator('.')) {
      const member = this.next();
      if (member.type !== 'identifier') throw new UnsupportedJavaError(`member ${member.value}`);
      if (result === 'Math') {
        if (!mathMembers.has(member.value)) throw new UnsupportedJavaError(`Math.${member.value}`);
        result = `Math.${member.value}${this.parseArguments()}`;
      } else if (member.value === 'length' && !this.peekOperator('(')) {
        result = `${result}.length`;
      } else {
        const turtleMember = turtleMemberMap.get(member.value);
        if (!turtleMember || !this.peekOperator('(')) throw new UnsupportedJavaError(`member ${member.value}`);
        result = `${result}.${turtleMember}${this.parseArguments()}`;
      }
    }
    return result;
  }

  private parsePrimary(): string {
    const token = this.next();
    if (token.type === 'number') return token.value;
    if (token.type === 'operator') {
      if (token.value !== '(') throw new UnsupportedJavaError(`operator ${token.value}`);
      const inner = this.parseOr();
      if (!this.consumeOperator(')')) throw new UnsupportedJavaError('missing )');
      return `(${inner})`;
    }
    const name = token.value;
    if (literalNames.has(name)) return name;
    if (name === 'new') {
      const className = this.next();
      if (className.type !== 'identifier' || (className.value !== 'Turtle' && !this.nativeNames.has(className.value))) {
        throw new UnsupportedJavaError(`instantiation of ${className.value}`);
      }
      return `new ${className.value}${this.parseArguments()}`;
    }
    if (name === 'Math') {
      if (!this.peekOperator('.')) throw new UnsupportedJavaError('Math without member');
      return 'Math';
    }
    if (this.nativeNames.has(name)) {
      return this.peekOperator('(') ? `${name}${this.parseArguments()}` : name;
    }
    if (this.peekOperator('(')) throw new UnsupportedJavaError(`call of unknown function ${name}`);
    if (primitiveTypeNames.has(name) || /^\p{Lu}/u.test(name) || name === 'this' || name === 'super') {
      throw new UnsupportedJavaError(`identifier ${name}`);
    }
    return `s.get('${name}')`;
  }

  private parseArguments(): string {
    if (!this.consumeOperator('(')) throw new UnsupportedJavaError('missing (');
    const args: string[] = [];
    if (!this.consumeOperator(')')) {
      do {
        args.push(this.parseOr());
      } while (this.consumeOperator(','));
      if (!this.consumeOperator(')')) throw new UnsupportedJavaError('missing )');
    }
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
