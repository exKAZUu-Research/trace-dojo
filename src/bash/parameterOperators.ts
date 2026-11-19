import type { ParameterExpansion, WordPart } from './ast';
import { charactersOf } from './characters';
import { decodeAnsiC } from './converter';
import { declarationText } from './declare';
import type { Expander, ParameterValue } from './expansion';
import { isFieldBreak, type Piece } from './fields';
import { matchesPattern } from './pattern';
import { quoteReusable } from './quoting';
import { ExitSignal } from './runtime';
import type { Shell } from './shell';
import { lowerCase, upperCase } from './shell';
import { UnsupportedFeatureError } from './unsupported';
import { ATTRIBUTE_ORDER } from './variables';

/** Applies the operator of `${name<operator>argument}` to the parameter's value. */
// code-gauge-allow functionCognitiveComplexity 16 -- One case per operator family of Bash's parameter expansion, each needing the expansion's context.
// code-gauge-allow functionNcss 49 -- One case per operator family of Bash's parameter expansion, each needing the expansion's context.
// code-gauge-allow functionParameterCount 7 -- One case per operator family of Bash's parameter expansion, each needing the expansion's context.
export function applyOperator(
  expander: Expander,
  shell: Shell,
  expansion: ParameterExpansion,
  value: ParameterValue,
  name: string,
  subscript: string | undefined,
  inDouble: boolean
): Piece[] {
  const operator = expansion.operator as string;
  const { argument } = expansion;
  switch (operator) {
    case ':-':
    case '-':
    case ':=':
    case '=':
    case ':?':
    case '?':
    case ':+':
    case '+': {
      const colon = operator.startsWith(':');
      const isUnset = value.kind === 'scalar' ? value.value === undefined : value.values.length === 0;
      const isNull = isUnset || (colon && joined(value) === '');
      const kind = operator.at(-1) as string;
      if (kind === '+') {
        return isNull ? [] : expander.withSpacedStar(() => expandArgument(expander, argument, inDouble, false));
      }
      if (!isNull) return expander.valuePieces(value, inDouble);
      return defaultValue(expander, shell, expansion, kind, colon, name, subscript, inDouble);
    }
    case '#':
    case '##':
    case '%':
    case '%%': {
      const pattern = expander.patternOf(expandArgument(expander, argument, inDouble, true));
      return mapValues(expander, value, inDouble, (text) => removePattern(text, pattern, operator, shell));
    }
    case '/':
    case '//':
    case '/#':
    case '/%': {
      const { pattern: patternParts, replacement } = splitReplacement(argument);
      const pattern = expander.patternOf(expandArgument(expander, patternParts, inDouble, true));
      const replace = replacement === undefined ? [] : expandArgument(expander, replacement, inDouble, true);
      return mapValues(expander, value, inDouble, (text) => substitute(text, pattern, replace, operator, shell));
    }
    case ':': {
      return substring(expander, shell, expansion, value, name, inDouble);
    }
    case '^':
    case '^^':
    case ',':
    case ',,':
    case '~':
    case '~~': {
      const pattern =
        argument.length > 0 ? expander.patternOf(expandArgument(expander, argument, inDouble, true)) : '?';
      return mapValues(expander, value, inDouble, (text) => changeCase(text, pattern, operator, shell));
    }
    case '@': {
      return transform(expander, shell, expansion, value, name, subscript, inDouble);
    }
    default: {
      return shell.discard(`${expansion.text}: bad substitution`);
    }
  }
}

function joined(value: ParameterValue): string {
  return value.kind === 'scalar' ? (value.value ?? '') : value.values.join(' ');
}

/**
 * Expands the parts after an operator. Inside double quotes, the word of `-`, `+`, `=`, and `?` expands as double-quoted
 * text, where single quotes are literal; the pattern and the replacement of the pattern operators expand as unquoted
 * words, whose quotes and backslashes quote, as Bash 5.3 does.
 */
function expandArgument(expander: Expander, parts: WordPart[], inDouble: boolean, isPattern: boolean): Piece[] {
  if (!inDouble || isPattern) return expander.expandParts(parts, false);
  const pieces: Piece[] = [];
  for (const part of parts) {
    if (part.kind === 'single') pieces.push({ text: `'${part.text}'`, quoted: true, split: false });
    else if (part.kind === 'double') pieces.push(...expander.expandParts([part], false));
    else pieces.push(...expander.expandParts([part], true));
  }
  return pieces;
}

// code-gauge-allow functionParameterCount 8 -- The default and assignment operators need the expansion, the parameter, and how it is quoted.
function defaultValue(
  expander: Expander,
  shell: Shell,
  expansion: ParameterExpansion,
  kind: string,
  colon: boolean,
  name: string,
  subscript: string | undefined,
  inDouble: boolean
): Piece[] {
  if (kind === '-') return expander.withSpacedStar(() => expandArgument(expander, expansion.argument, inDouble, false));
  const word = expandArgument(expander, expansion.argument, inDouble, false);
  const text = expander.joinPieces(word);
  if (kind === '?') {
    const message = text === '' ? (colon ? 'parameter null or not set' : 'parameter not set') : text;
    expander.failParameter(subscript === undefined ? name : `${name}[${subscript}]`, message);
  }
  // `:=` and `=` assign to variables only.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || subscript === '@' || subscript === '*') {
    shell.discard(`$${name}: cannot assign in this way`);
  }
  const assigned =
    subscript === undefined ? shell.assignScalar(name, text) : shell.assignElement(name, subscript, text, false);
  if (!assigned) shell.discard(`${name}: cannot assign`);
  const stored = subscript === undefined ? shell.scalarValue(name) : shell.elementValue(name, subscript);
  return expander.valuePieces({ kind: 'scalar', value: stored }, inDouble);
}

/** Applies a string operation to a scalar or to each element of a list, keeping the list's fields. */
function mapValues(
  expander: Expander,
  value: ParameterValue,
  inDouble: boolean,
  map: (text: string) => string
): Piece[] {
  if (value.kind === 'scalar') {
    if (value.value === undefined) return [];
    return expander.valuePieces({ kind: 'scalar', value: map(value.value) }, inDouble);
  }
  return expander.valuePieces({ ...value, values: value.values.map(map) }, inDouble);
}

/** `${x#p}`, `${x##p}`, `${x%p}`, and `${x%%p}`, matching by characters. */
function removePattern(text: string, pattern: string, operator: string, shell: Shell): string {
  const chars = charactersOf(text);
  const spend = (): void => shell.runtime.spend();
  const matches = (candidate: string[]): boolean => matchesPattern(pattern, candidate.join(''), spend);
  if (operator === '#' || operator === '##') {
    const lengths = operator === '#' ? range(0, chars.length) : range(chars.length, 0);
    for (const length of lengths) if (matches(chars.slice(0, length))) return chars.slice(length).join('');
    return text;
  }
  const starts = operator === '%' ? range(chars.length, 0) : range(0, chars.length);
  for (const start of starts) if (matches(chars.slice(start))) return chars.slice(0, start).join('');
  return text;
}

/** The integers from `from` to `to`, both included, in either direction. */
function range(from: number, to: number): number[] {
  const result: number[] = [];
  if (from <= to) for (let i = from; i <= to; i++) result.push(i);
  else for (let i = from; i >= to; i--) result.push(i);
  return result;
}

/** Splits the argument of `${x/pattern/replacement}` at its first unquoted `/`. */
// code-gauge-allow functionCognitiveComplexity 17 -- Finds the first unquoted slash across the argument's parts, as Bash splits ${x/p/r}.
function splitReplacement(parts: WordPart[]): { pattern: WordPart[]; replacement: WordPart[] | undefined } {
  for (const [index, part] of parts.entries()) {
    if (part.kind !== 'literal') continue;
    for (let i = 0; i < part.text.length; i++) {
      if (part.text[i] === '\\') {
        i++;
        continue;
      }
      if (part.text[i] !== '/') continue;
      const before = part.text.slice(0, i);
      const after = part.text.slice(i + 1);
      return {
        pattern: [...parts.slice(0, index), ...(before ? [{ kind: 'literal' as const, text: before }] : [])],
        replacement: [...(after ? [{ kind: 'literal' as const, text: after }] : []), ...parts.slice(index + 1)],
      };
    }
  }
  return { pattern: parts, replacement: undefined };
}

/** The replacement text for one match: an unquoted `&` stands for the matched text, as `patsub_replacement` makes it. */
function replacementFor(replacement: Piece[], matched: string): string {
  let text = '';
  for (const piece of replacement) {
    if (isFieldBreak(piece)) {
      text += ' ';
      continue;
    }
    if (piece.quoted) {
      text += piece.text;
      continue;
    }
    for (let i = 0; i < piece.text.length; i++) {
      const c = piece.text[i];
      if (c === '\\' && i + 1 < piece.text.length && piece.text[i + 1] === '&') {
        text += '&';
        i++;
      } else if (c === '&') text += matched;
      else text += c;
    }
  }
  return text;
}

/** `${x/p/r}`, `${x//p/r}`, `${x/#p/r}`, and `${x/%p/r}`, replacing the longest match at each position. */
// code-gauge-allow functionCognitiveComplexity 23 -- Bash's four replacement operators share the match search and the empty-match rule.
function substitute(text: string, pattern: string, replacement: Piece[], operator: string, shell: Shell): string {
  if (pattern === '') return text;
  const chars = charactersOf(text);
  const spend = (): void => shell.runtime.spend();
  const matches = (start: number, end: number): boolean =>
    matchesPattern(pattern, chars.slice(start, end).join(''), spend);
  const replace = (start: number, end: number): string => replacementFor(replacement, chars.slice(start, end).join(''));
  if (operator === '/#') {
    const end = longestMatch(chars.length, 0, matches);
    return end === undefined ? text : replace(0, end) + chars.slice(end).join('');
  }
  if (operator === '/%') {
    for (let start = 0; start <= chars.length; start++) {
      if (matches(start, chars.length)) return chars.slice(0, start).join('') + replace(start, chars.length);
    }
    return text;
  }
  let result = '';
  for (let position = 0; position <= chars.length;) {
    const end =
      position < chars.length || chars.length === 0 ? longestMatch(chars.length, position, matches) : undefined;
    if (end === undefined || (end === position && position >= chars.length)) {
      result += chars[position] ?? '';
      position++;
      continue;
    }
    result += replace(position, end);
    if (operator === '/') return result + chars.slice(end).join('');
    // An empty match moves on by one character, which it keeps.
    if (end === position) result += chars[position++] ?? '';
    else position = end;
  }
  return result;
}

/** The end of the longest match that starts at `start`. */
function longestMatch(
  length: number,
  start: number,
  matches: (start: number, end: number) => boolean
): number | undefined {
  for (let end = length; end >= start; end--) if (matches(start, end)) return end;
  return undefined;
}

/** `${x:offset}` and `${x:offset:length}`, and the slices of arrays and positional parameters. */
function substring(
  expander: Expander,
  shell: Shell,
  expansion: ParameterExpansion,
  value: ParameterValue,
  name: string,
  inDouble: boolean
): Piece[] {
  if (expansion.argument.length === 0) shell.discard(`${expansion.text}: bad substitution`);
  const { offset: offsetParts, length: lengthParts } = splitSubstring(expansion.argument);
  const evaluate = (parts: (string | WordPart)[]): bigint =>
    shell.evaluateText(expander.arithmeticText({ pieces: parts, row: shell.currentRow }), undefined);
  const offset = evaluate(offsetParts);
  const length = lengthParts === undefined ? undefined : evaluate(lengthParts);
  const negativeLength = (): never =>
    shell.discard(`${expander.arithmeticText({ pieces: lengthParts ?? [], row: 0 }).trim()}: substring expression < 0`);
  if (value.kind === 'scalar') {
    if (value.value === undefined) return [];
    const sliced = sliceString(value.value, offset, length, negativeLength);
    return sliced === undefined ? [] : expander.valuePieces({ kind: 'scalar', value: sliced }, inDouble);
  }
  if (length !== undefined && length < 0n) negativeLength();
  const values = sliceList(shell, name, value, offset);
  if (values === undefined) return [];
  return expander.valuePieces(
    { ...value, values: length === undefined ? values : values.slice(0, Number(length)) },
    inDouble
  );
}

/** A string's characters from `offset`, counting from the end when negative, and `length` of them or to the end. */
function sliceString(
  text: string,
  start: bigint,
  length: bigint | undefined,
  negativeLength: () => never
): string | undefined {
  const chars = charactersOf(text);
  const size = BigInt(chars.length);
  const offset = start < 0n ? start + size : start;
  if (offset < 0n || offset > size) return undefined;
  let end = length === undefined ? size : length < 0n ? size + length : offset + length;
  if (length !== undefined && length < 0n && end < offset) negativeLength();
  if (end > size) end = size;
  return chars.slice(Number(offset), Number(end)).join('');
}

/**
 * The elements of a list from `offset`: positional parameters counting `$0` first, or array elements whose index is
 * at least `offset`, a negative one counting back from after the last index.
 */
function sliceList(
  shell: Shell,
  name: string,
  value: Extract<ParameterValue, { kind: 'list' }>,
  start: bigint
): string[] | undefined {
  if (name === '@' || name === '*') {
    const offset = start < 0n ? start + BigInt(value.values.length + 1) : start;
    return offset < 0n ? undefined : ['main.sh', ...value.values].slice(Number(offset));
  }
  if (shell.isAssociative(shell.resolveName(name))) return sliceAssociative(value.values, start);
  const keyed = arrayEntries(shell, name, value);
  let offset = start;
  if (offset < 0n) {
    const last = keyed.length > 0 ? (keyed.at(-1) as [bigint, string])[0] : -1n;
    offset = last + 1n + offset;
    if (offset < 0n) return undefined;
  }
  return keyed.filter(([key]) => key >= offset).map(([, element]) => element);
}

/** Bash's `assoc_subrange`, which counts an associative array's elements from 1, so offsets 0 and 1 both start at the first. */
function sliceAssociative(values: string[], start: bigint): string[] | undefined {
  const size = BigInt(values.length) + (start < 0n ? 1n : 0n);
  const offset = start < 0n ? start + size : start;
  if (offset < 0n || offset > size) return undefined;
  return values.slice(Math.max(Number(offset) - 1, 0));
}

/** The keyed elements a list came from, so that slices count by index as Bash's do. */
function arrayEntries(
  shell: Shell,
  name: string,
  value: Extract<ParameterValue, { kind: 'list' }>
): [bigint, string][] {
  const keys = shell.arrayKeys(shell.resolveName(name));
  return value.values.map((element, index) => [BigInt(keys[index] ?? index), element]);
}

/** Splits `offset:length` at the first `:` outside parentheses and conditional expressions, as Bash's `skiparith`. */
// code-gauge-allow functionCognitiveComplexity 25 -- A port of Bash's skiparith, which counts parentheses and conditional colons across parts.
function splitSubstring(parts: WordPart[]): {
  offset: (string | WordPart)[];
  length: (string | WordPart)[] | undefined;
} {
  const offset: (string | WordPart)[] = [];
  let depth = 0;
  let conditional = 0;
  for (const [index, part] of parts.entries()) {
    if (part.kind !== 'literal') {
      offset.push(part);
      continue;
    }
    for (let i = 0; i < part.text.length; i++) {
      const c = part.text[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === '?' && depth === 0) conditional++;
      else if (c === ':' && depth === 0) {
        if (conditional > 0) {
          conditional--;
          continue;
        }
        const before = part.text.slice(0, i);
        if (before) offset.push(before);
        const after = part.text.slice(i + 1);
        return { offset, length: [...(after ? [after] : []), ...parts.slice(index + 1)] };
      }
    }
    offset.push(part.text);
  }
  return { offset, length: undefined };
}

/** `${x^p}`, `${x^^p}`, `${x,p}`, `${x,,p}`, `${x~p}`, and `${x~~p}`, changing the characters that match `p`. */
function changeCase(text: string, pattern: string, operator: string, shell: Shell): string {
  const chars = charactersOf(text);
  const all = operator.length === 2;
  const spend = (): void => shell.runtime.spend();
  for (let i = 0; i < chars.length; i++) {
    if (!all && i > 0) break;
    if (!matchesPattern(pattern, chars[i], spend)) continue;
    const c = chars[i];
    if (operator.startsWith('^')) chars[i] = upperCase(c);
    else if (operator.startsWith(',')) chars[i] = lowerCase(c);
    else chars[i] = upperCase(c) === c ? lowerCase(c) : upperCase(c);
  }
  return chars.join('');
}

/** `${x@Q}` and the other transformations. */
// code-gauge-allow functionParameterCount 7 -- The transformations need the expansion, the parameter, and how it is quoted, as the other operators do.
// code-gauge-allow functionNcss 35 -- One case per transformation letter of Bash's parameter expansion.
function transform(
  expander: Expander,
  shell: Shell,
  expansion: ParameterExpansion,
  value: ParameterValue,
  name: string,
  subscript: string | undefined,
  inDouble: boolean
): Piece[] {
  const letter =
    expansion.argument.length === 1 && expansion.argument[0].kind === 'literal' ? expansion.argument[0].text : '';
  if (!/^[QEPAKakuUL]$/.test(letter)) {
    // Unlike most bad substitutions, a non-interactive Bash exits at an unknown transformation.
    shell.reportError(`${expansion.text}: bad substitution`);
    throw new ExitSignal(1);
  }
  switch (letter) {
    case 'Q': {
      return mapValues(expander, value, inDouble, quoteReusable);
    }
    case 'E': {
      return mapValues(expander, value, inDouble, decodeAnsiC);
    }
    case 'P': {
      throw new UnsupportedFeatureError('プロンプトの展開（${x@P}）');
    }
    case 'u': {
      return mapValues(
        expander,
        value,
        inDouble,
        (text) => upperCase(charactersOf(text)[0] ?? '') + charactersOf(text).slice(1).join('')
      );
    }
    case 'U': {
      return mapValues(expander, value, inDouble, upperCase);
    }
    case 'L': {
      return mapValues(expander, value, inDouble, lowerCase);
    }
    case 'a': {
      const variable = shell.findVariable(name);
      const flags = variable ? ATTRIBUTE_ORDER.filter((attribute) => variable.attributes.has(attribute)).join('') : '';
      if (value.kind === 'list')
        return expander.valuePieces({ ...value, values: value.values.map(() => flags) }, inDouble);
      return value.value === undefined && !variable
        ? []
        : expander.valuePieces({ kind: 'scalar', value: flags }, inDouble);
    }
    case 'A': {
      const text = assignmentText(shell, name, value);
      // An array's declaration comes as three words, `declare`, its flags, and its assignment, even when quoted.
      if (value.kind === 'list' && text !== '') {
        const [declare, flags, ...assignment] = text.split(' ');
        return expander.valuePieces(
          { kind: 'list', values: [declare, flags, assignment.join(' ')], star: false },
          inDouble
        );
      }
      return expander.valuePieces({ kind: 'scalar', value: text }, inDouble);
    }
    case 'K':
    case 'k': {
      return keyValuePairs(expander, shell, name, value, letter === 'K', inDouble);
    }
    default: {
      throw new Error(`Unknown transformation ${letter}`);
    }
  }
}

/** `${x@A}`: an assignment that recreates the value, with `declare` and the variable's attributes when it has any. */
/** `${x@A}`, as Bash's `string_var_assignment`, or `declare -p`'s text for an array (`${a[@]@A}`). */
function assignmentText(shell: Shell, name: string, value: ParameterValue): string {
  const variable = shell.findVariable(name);
  if (!variable) return '';
  if (value.kind === 'list') return variable.value ? declarationText(variable) : '';
  const flags = ATTRIBUTE_ORDER.filter((attribute) => variable.attributes.has(attribute)).join('');
  const quoted = variable.value && value.value !== undefined ? quoteReusable(value.value) : undefined;
  const { scopes, functionScopes } = shell.state;
  const isCurrentLocal = functionScopes.length > 0 && scopes[functionScopes.at(-1) as number].get(name) === variable;
  if (flags) return `declare -${flags} ${name}${quoted === undefined ? '' : `=${quoted}`}`;
  if (isCurrentLocal) return `declare ${name}${quoted === undefined ? '' : `=${quoted}`}`;
  return quoted === undefined ? '' : `${name}=${quoted}`;
}

/**
 * `${a[@]@K}` and `${a[@]@k}`: keys and values, quoted in one word for `K`, which ends an associative array's pairs
 * with a space as Bash does, or as separate words for `k`.
 */
function keyValuePairs(
  expander: Expander,
  shell: Shell,
  name: string,
  value: ParameterValue,
  quoted: boolean,
  inDouble: boolean
): Piece[] {
  if (value.kind === 'scalar') {
    if (value.value === undefined) return [];
    return expander.valuePieces({ kind: 'scalar', value: quoted ? quoteReusable(value.value) : value.value }, inDouble);
  }
  const keys = shell.arrayKeys(shell.resolveName(name));
  if (!quoted) {
    return expander.valuePieces(
      { ...value, values: value.values.flatMap((element, index) => [keys[index], element]) },
      inDouble
    );
  }
  const isAssociative = shell.isAssociative(shell.resolveName(name));
  const pairs = value.values.map(
    (element, index) => `${isAssociative ? quoteKey(keys[index]) : keys[index]} ${quoteDouble(element)}`
  );
  const text = isAssociative ? pairs.map((pair) => `${pair} `).join('') : pairs.join(' ');
  return expander.valuePieces({ kind: 'scalar', value: text }, inDouble);
}

function quoteKey(key: string): string {
  return /^[A-Za-z0-9_]+$/.test(key) ? key : quoteDouble(key);
}

function quoteDouble(text: string): string {
  return `"${text.replaceAll(/[\\`$"]/g, String.raw`\$&`)}"`;
}
