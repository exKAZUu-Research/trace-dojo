/**
 * Translates a Java fragment written in a blank into the instrumented (JavaScript) dialect used by `traceProgram`.
 * Only a conservative subset of Java is supported; anything else throws `UnsupportedJavaError`,
 * which tells the grader to fall back to real Java execution.
 */

export class UnsupportedJavaError extends Error {
  constructor(message: string) {
    super(`Unsupported Java fragment: ${message}`);
    this.name = 'UnsupportedJavaError';
  }
}

interface Token {
  type: 'number' | 'string' | 'identifier' | 'operator';
  value: string;
}

const turtleMethodNameMap: Record<string, string> = {
  前に進む: 'forward',
  後に戻る: 'backward',
  右を向く: 'turnRight',
  左を向く: 'turnLeft',
  前に進めるか: 'canMoveForward',
};

const primitiveTypeNames = new Set(['int', 'long', 'short', 'byte', 'boolean', 'char', 'String', 'var']);
const javaBuiltinNames = new Set(['true', 'false', 'null', 'new', 'return', 'Turtle', 'Math']);
// Only the members whose semantics are identical between Java and JavaScript.
const supportedMathMembers = new Set(['max', 'min', 'abs']);
const unsupportedKeywords = new Set([
  'this',
  'super',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'instanceof',
  'static',
  'void',
  'public',
  'private',
  'protected',
  'final',
  'throw',
  'try',
  'catch',
  'class',
]);
const operatorRegex = /^(?:\+\+|--|==|!=|<=|>=|&&|\|\||[+\-*%<>!=(),.[\];])/;
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
      return `s.set('${name}', s.get('${name}') ${binaryOperator} 1)`;
    }
  }

  return translateExpression(tokens, nativeNames);
}

function translateExpression(tokens: Token[], nativeNames: ReadonlySet<string>): string {
  if (tokens.length === 0) throw new UnsupportedJavaError('empty expression');

  const parts: string[] = [];
  for (const [index, token] of tokens.entries()) {
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    switch (token.type) {
      case 'number':
      case 'string': {
        parts.push(token.value);
        break;
      }
      case 'operator': {
        if (token.value === '=' || isIncrementOperator(token)) {
          throw new UnsupportedJavaError(`operator ${token.value} inside an expression`);
        }
        parts.push(token.value === '==' ? '===' : token.value === '!=' ? '!==' : token.value);
        break;
      }
      case 'identifier': {
        const name = token.value;
        const isMemberName = previous && isOperator(previous, '.');
        if (unsupportedKeywords.has(name)) {
          throw new UnsupportedJavaError(`keyword ${name}`);
        } else if (isMemberName) {
          const owner = tokens[index - 2];
          if (owner && owner.type === 'identifier' && owner.value === 'Math' && !supportedMathMembers.has(name)) {
            throw new UnsupportedJavaError(`Math.${name}`);
          }
          parts.push(turtleMethodNameMap[name] ?? name);
        } else if (javaBuiltinNames.has(name) || nativeNames.has(name)) {
          if (
            name === 'new' &&
            next &&
            next.type === 'identifier' &&
            next.value !== 'Turtle' &&
            !nativeNames.has(next.value)
          ) {
            throw new UnsupportedJavaError(`instantiation of ${next.value}`);
          }
          parts.push(name);
        } else if (next && isOperator(next, '(')) {
          throw new UnsupportedJavaError(`call of unknown function ${name}`);
        } else if (next && isOperator(next, '.') && tokens[index + 2]?.value !== 'length') {
          throw new UnsupportedJavaError(`member access on unknown variable ${name}`);
        } else if (primitiveTypeNames.has(name)) {
          throw new UnsupportedJavaError(`type name ${name}`);
        } else {
          parts.push(`s.get('${name}')`);
        }
        break;
      }
    }
  }
  return joinTokens(parts);
}

function joinTokens(parts: string[]): string {
  let result = '';
  for (const [index, part] of parts.entries()) {
    const previous = parts[index - 1];
    const needsSpace =
      index > 0 &&
      !/^[.,)\]]$/.test(part) &&
      !/[.([]$/.test(previous) &&
      !(part === '(' && /[\p{L}\p{N}_$]$/u.test(previous));
    result += (needsSpace ? ' ' : '') + part;
  }
  return result;
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
    const string = /^"(?:[^"\\]|\\.)*"/.exec(rest);
    if (string) {
      tokens.push({ type: 'string', value: string[0] });
      rest = rest.slice(string[0].length);
      continue;
    }
    const char = /^'(?:[^'\\]|\\.)'/.exec(rest);
    if (char) {
      tokens.push({ type: 'string', value: `"${char[0].slice(1, -1).replaceAll('"', String.raw`\"`)}"` });
      rest = rest.slice(char[0].length);
      continue;
    }
    const number = numberRegex.exec(rest);
    if (number) {
      if (/^[\d.]/.test(rest.slice(number[0].length))) {
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
