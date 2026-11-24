// code-gauge-allow-file fileNcss -- Keeps Bash's parameter expansion operators and transformations in one module.
import type { ParameterExpansion, WordPart } from './ast';
import { charactersOf, lowerCase, upperCase } from './characters';
import { decodeAnsiC } from './converter';
import { declarationText } from './declare';
import { appendBounded, type Expander, joinBounded, type ParameterValue, type SubscriptRef } from './expansion';
import {
  EMPTY_LIST,
  FIELD_BREAK,
  FieldSplitter,
  type Fragment,
  isFieldBreak,
  type Piece,
  POSITIONAL_BREAK,
  STAR_BREAK,
} from './fields';
import { rawLengthSource } from './parse';
import {
  compileGlob,
  longestPrefixMatch,
  longestSuffixMatch,
  matchesSlice,
  nextLeftmostLongestMatch,
  shortestPrefixMatch,
  shortestSuffixMatch,
} from './pattern';
import { doubleQuote, quoteReusable } from './quoting';
import { DiscardSignal, ExitSignal } from './runtime';
import type { Shell } from './shell';
import { UnsupportedFeatureError } from './unsupported';
import { ATTRIBUTE_ORDER, isArrayVariable, type Variable } from './variables';

/** Applies the operator of `${name<operator>argument}` to the parameter's value. */
// code-gauge-allow functionCognitiveComplexity -- One case per operator family of Bash's parameter expansion, each needing the expansion's context.
// code-gauge-allow functionNcss -- One case per operator family of Bash's parameter expansion, each needing the expansion's context.
// code-gauge-allow functionParameterCount -- One case per operator family of Bash's parameter expansion, each needing the expansion's context.
export function applyOperator(
  expander: Expander,
  shell: Shell,
  expansion: ParameterExpansion,
  value: ParameterValue,
  name: string,
  subscript: SubscriptRef | undefined,
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
      const isNull = isUnset || (colon && isEmptyParameterValue(expander, value, inDouble));
      const kind = operator.at(-1) as string;
      if (kind === '+') {
        if (isNull) return value.kind === 'list' && !value.star && inDouble ? [EMPTY_LIST] : [];
        return expander.withSpacedStar(() => expandArgument(expander, argument, inDouble, false));
      }
      if (!isNull) return expander.valuePieces(value, inDouble);
      return defaultValue(expander, shell, expansion, kind, colon, name, subscript, inDouble);
    }
    case '#':
    case '##':
    case '%':
    case '%%': {
      const pattern = expander.patternOf(expandArgument(expander, argument, inDouble, true));
      return mapPatternRemoval(expander, shell, value, inDouble, (text) =>
        removePattern(text, pattern, operator, shell)
      );
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
      return transform(expander, shell, expansion, value, name, inDouble);
    }
    default: {
      return shell.discard(`${expansion.text}: bad substitution`);
    }
  }
}

function isEmptyParameterValue(expander: Expander, value: ParameterValue, inDouble: boolean): boolean {
  if (value.kind === 'scalar') return (value.value ?? '') === '';
  const sep = value.star && inDouble ? expander.ifsJoiner() : ' ';
  if (value.values.length > 1 && sep !== '') return false;
  return value.values.every((element) => element === '');
}

/**
 * Expands the parts after an operator. Inside double quotes, the word of `-`, `+`, and `=` expands as double-quoted
 * text, where single quotes are literal; the pattern and the replacement of the pattern operators expand as unquoted
 * words, whose quotes and backslashes quote, as Bash 5.3 does.
 */
function expandArgument(expander: Expander, parts: WordPart[], inDouble: boolean, isPattern: boolean): Piece[] {
  if (isPattern) {
    expander.checkTilde(parts, false);
    return expander.expandParts(parts, false);
  }
  if (!inDouble) return expandUnquotedOperatorWord(expander, parts);
  const pieces: Piece[] = [];
  for (const part of parts) {
    if (part.kind === 'single') pieces.push({ text: `'${part.text}'`, quoted: true, split: false });
    else if (part.kind === 'double') pieces.push(...expander.expandParts([part], false));
    else pieces.push(...expander.expandParts([part], true));
  }
  const kept = pieces.filter((piece) => piece !== EMPTY_LIST);
  return kept.length === 0 ? [{ text: '', quoted: true, split: false }] : kept;
}

type NonEmptyPiece = Exclude<Piece, typeof EMPTY_LIST>;

interface OperatorWordEntry {
  piece: NonEmptyPiece;
  keepsFields: boolean;
}

function expandUnquotedOperatorWord(expander: Expander, parts: WordPart[]): Piece[] {
  expander.checkTilde(parts, false);
  const ifs = expander.currentIfs();
  const entries = collectOperatorWordEntries(expander, parts, expander.ifsJoiner());
  if (ifs !== '' && ifs[0] !== ' ' && entries.some(isUnquotedAtListEntry)) {
    return joinOperatorWordFields(ifs, entries);
  }
  return entries.map(({ piece, keepsFields }) =>
    isFieldBreak(piece) || piece.quoted || keepsFields ? piece : { ...piece, split: true }
  );
}

function collectOperatorWordEntries(expander: Expander, parts: WordPart[], starJoiner: string): OperatorWordEntry[] {
  const entries: OperatorWordEntry[] = [];
  for (const part of parts) {
    const keepsFields = keepsOperatorFields(part);
    for (const piece of expander.expandParts([part], false)) {
      appendOperatorWordPiece(entries, piece, keepsFields, starJoiner);
    }
  }
  return entries;
}

function keepsOperatorFields(part: WordPart): boolean {
  return (
    part.kind === 'double' ||
    (part.kind === 'parameter' && part.operator !== undefined && /^:?[-+]$/.test(part.operator))
  );
}

function appendOperatorWordPiece(
  entries: OperatorWordEntry[],
  piece: Piece,
  keepsFields: boolean,
  starJoiner: string
): void {
  if (piece === EMPTY_LIST) return;
  if (piece === STAR_BREAK && !keepsFields && starJoiner !== '') {
    entries.push({ piece: { text: starJoiner, quoted: false, split: true }, keepsFields });
    return;
  }
  entries.push({ piece, keepsFields });
}

function isUnquotedAtListEntry({ piece, keepsFields }: OperatorWordEntry): boolean {
  return !keepsFields && !isFieldBreak(piece) && piece.atListElement === true;
}

function isProtectedFieldBreak({ piece, keepsFields }: OperatorWordEntry): boolean {
  return keepsFields && isFieldBreak(piece);
}

function joinOperatorWordFields(ifs: string, entries: OperatorWordEntry[]): Piece[] {
  const hasProtectedBreak = entries.some(isProtectedFieldBreak);
  const segments = splitOperatorSegments(entries, hasProtectedBreak);
  const result: Piece[] = [];
  for (const [index, segment] of segments.entries()) {
    if (index > 0) result.push(FIELD_BREAK);
    result.push(...joinOperatorSegment(ifs, segment));
  }
  return result;
}

function splitOperatorSegments(entries: OperatorWordEntry[], hasProtectedBreak: boolean): OperatorWordEntry[][] {
  const segments: OperatorWordEntry[][] = [[]];
  for (const entry of entries) {
    if (isHardOperatorBreak(entry, hasProtectedBreak)) segments.push([]);
    else (segments.at(-1) as OperatorWordEntry[]).push(entry);
  }
  return segments;
}

function isHardOperatorBreak({ piece, keepsFields }: OperatorWordEntry, hasProtectedBreak: boolean): boolean {
  return (keepsFields && isFieldBreak(piece)) || (hasProtectedBreak && piece === POSITIONAL_BREAK);
}

function joinOperatorSegment(ifs: string, entries: OperatorWordEntry[]): Piece[] {
  const splitter = new FieldSplitter(ifs);
  for (const entry of entries) splitter.add(toOperatorSplitterPiece(entry));
  const fields = splitter.finish();
  if (fields.length === 0) return [];
  return joinNonEmptyOperatorFields(fields);
}

function toOperatorSplitterPiece({ piece, keepsFields }: OperatorWordEntry): Piece {
  if (isFieldBreak(piece) || piece.quoted || keepsFields) return piece;
  if (piece.atListElement) {
    return piece.text === '' ? { ...piece, split: true, operatorNull: true } : { ...piece, split: false };
  }
  return { ...piece, split: true };
}

function joinNonEmptyOperatorFields(fields: Fragment[][]): Piece[] {
  const joined: Piece[] = [];
  for (const [index, field] of fields.entries()) {
    if (index > 0) joined.push({ text: ' ', quoted: false, split: true });
    if (field.length === 0) {
      joined.push({ text: '', quoted: false, split: true, operatorNull: true });
      continue;
    }
    for (const fragment of field) joined.push({ ...fragment, split: false });
  }
  return joined;
}

// code-gauge-allow functionParameterCount -- The default and assignment operators need the expansion, the parameter, and how it is quoted.
function defaultValue(
  expander: Expander,
  shell: Shell,
  expansion: ParameterExpansion,
  kind: string,
  colon: boolean,
  name: string,
  subscript: SubscriptRef | undefined,
  inDouble: boolean
): Piece[] {
  if (kind === '-') return expander.withSpacedStar(() => expandArgument(expander, expansion.argument, inDouble, false));
  if (kind === '?') {
    const message =
      expansion.argument.length === 0
        ? colon
          ? 'parameter null or not set'
          : 'parameter not set'
        : expandErrorWord(expander, shell, expansion.argument);
    expander.failParameter(subscript === undefined ? name : `${name}[${subscript.text}]`, message);
  }
  const word = expander.withSpacedStar(() => expandArgument(expander, expansion.argument, inDouble, false), false);
  const text = expander.joinPieces(word);
  // `:=` and `=` assign to variables only.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || subscript?.wholeArray) {
    shell.discard(`$${name}: cannot assign in this way`);
  }
  if (!assignDefaultTarget(shell, name, subscript?.text, text)) throw new DiscardSignal();
  return expander.valuePieces({ kind: 'scalar', value: shell.lastStored }, inDouble);
}

function expandErrorWord(expander: Expander, shell: Shell, parts: WordPart[]): string {
  expander.checkTilde(parts, false);
  const pieces = expander.withSpacedStar(() => expander.expandParts(parts, false));
  const spend = (cost?: number): void => shell.runtime.spend(cost);
  const fields = expander.splitFields(pieces).map((field) =>
    joinBounded(
      field.map((fragment) => fragment.text),
      '',
      spend
    )
  );
  return joinBounded(fields, ' ', spend);
}

function assignDefaultTarget(shell: Shell, name: string, subscript: string | undefined, text: string): boolean {
  const resolved = shell.resolveNameOrUndefined(name);
  if (resolved === undefined) return false;
  if (subscript !== undefined) return shell.assignElement(resolved, subscript, text, false);
  const split = shell.splitSubscript(resolved);
  if (!split) return shell.assignScalar(name, text);
  const arr = shell.resolveNameOrUndefined(split.name);
  if (arr === undefined) return false;
  if (shell.isAssociative(arr)) {
    const sub = shell.expandDynamicSubscript(split.subscript);
    return sub === ''
      ? failDefaultSubscript(shell, `${split.name}[${split.subscript}]`)
      : shell.assignElement(arr, sub, text, false, true);
  }
  if (split.subscript === '@' || split.subscript === '*')
    return failDefaultSubscript(shell, `${arr}[${split.subscript}]`);
  const sub = shell.expandDynamicSubscript(split.subscript);
  return shell.assignElement(arr, sub === '' && split.subscript !== '' ? '0' : sub, text, false);
}

function failDefaultSubscript(shell: Shell, label: string): false {
  shell.reportError(`${label}: bad array subscript`);
  return false;
}

function mapPatternRemoval(
  expander: Expander,
  shell: Shell,
  value: ParameterValue,
  inDouble: boolean,
  map: (text: string) => string
): Piece[] {
  if (!inDouble && value.kind === 'list' && !value.positional && shell.scalarValue('IFS') === '') {
    if (value.values.length === 0) return [];
    const text = joinBounded(value.values.map(map), ' ', (cost) => shell.runtime.spend(cost));
    return text === '' ? [] : [{ text, quoted: false, split: false }];
  }
  return mapValues(expander, value, inDouble, map);
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
  return expander.valuePieces({ ...value, values: value.values.map(map), transformed: true }, inDouble);
}

/** `${x#p}`, `${x##p}`, `${x%p}`, and `${x%%p}`, matching by characters. */
function removePattern(text: string, pattern: string, operator: string, shell: Shell): string {
  const chars = charactersOf(text);
  const spend = (): void => shell.runtime.spend();
  const glob = compileGlob(pattern, spend);
  if (operator === '#') {
    const end = shortestPrefixMatch(glob, chars, 0, spend);
    return end === undefined ? text : chars.slice(end).join('');
  }
  if (operator === '##') {
    const end = longestPrefixMatch(glob, chars, 0, spend);
    return end === undefined ? text : chars.slice(end).join('');
  }
  const start = operator === '%' ? shortestSuffixMatch(glob, chars, spend) : longestSuffixMatch(glob, chars, spend);
  return start === undefined ? text : chars.slice(0, start).join('');
}

/** Splits the argument of `${x/pattern/replacement}` at its first unquoted `/`. */
// code-gauge-allow functionCognitiveComplexity -- Finds the first unquoted slash across the argument's parts, as Bash splits ${x/p/r}.
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

/** Formats one replacement match: unquoted `&` expands to the matched substring, and `\&` produces literal `&`. */
function replacementFor(replacement: Piece[], matched: string, spend: (cost?: number) => void): string {
  let text = '';
  for (const piece of replacement) {
    if (piece === EMPTY_LIST) continue;
    if (isFieldBreak(piece)) text = appendBounded(text, ' ', spend);
    else if (piece.quoted) text = appendBounded(text, piece.text, spend);
    else text = appendUnquotedReplacement(text, piece.text, matched, spend);
  }
  return text;
}

function appendUnquotedReplacement(
  initial: string,
  raw: string,
  matched: string,
  spend: (cost?: number) => void
): string {
  let text = initial;
  let literalStart = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length && raw[i + 1] === '&') {
      text = appendBounded(appendBounded(text, raw.slice(literalStart, i), spend), '&', spend);
      i++;
      literalStart = i + 1;
    } else if (c === '&') {
      text = appendBounded(appendBounded(text, raw.slice(literalStart, i), spend), matched, spend);
      literalStart = i + 1;
    }
  }
  return appendBounded(text, raw.slice(literalStart), spend);
}

/** `${x/p/r}`, `${x//p/r}`, `${x/#p/r}`, and `${x/%p/r}`, replacing the longest match at each position. */
// code-gauge-allow functionCognitiveComplexity -- Bash's four replacement operators share the match search and the empty-match rule.
function substitute(text: string, pattern: string, replacement: Piece[], operator: string, shell: Shell): string {
  if (pattern === '' && operator !== '/#' && operator !== '/%') return text;
  const chars = charactersOf(text);
  const spend = (cost?: number): void => shell.runtime.spend(cost);
  const glob = compileGlob(pattern, () => spend());
  const replace = (start: number, end: number): string =>
    replacementFor(replacement, chars.slice(start, end).join(''), spend);
  if (operator === '/#') {
    const end = longestPrefixMatch(glob, chars, 0, () => spend());
    return end === undefined ? text : appendBounded(replace(0, end), chars.slice(end).join(''), spend);
  }
  if (operator === '/%') {
    const start = longestSuffixMatch(glob, chars, () => spend());
    return start === undefined
      ? text
      : appendBounded(chars.slice(0, start).join(''), replace(start, chars.length), spend);
  }
  let result = '';
  for (let position = 0; position <= chars.length;) {
    const match = nextLeftmostLongestMatch(glob, chars, position, () => spend());
    if (!match) return appendBounded(result, chars.slice(position).join(''), spend);
    result = appendBounded(result, chars.slice(position, match.start).join(''), spend);
    result = appendBounded(result, replace(match.start, match.end), spend);
    if (operator === '/' || chars.length === 0) return appendBounded(result, chars.slice(match.end).join(''), spend);
    // An empty match moves on by one character, which it keeps.
    if (match.end === match.start) {
      result = appendBounded(result, chars[match.start] ?? '', spend);
      position = match.start + 1;
    } else position = match.end;
  }
  return result;
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
  if (value.kind === 'scalar' && value.value === undefined) return [];
  if (value.kind === 'list' && name !== '@' && name !== '*' && value.values.length === 0) {
    return expander.valuePieces({ ...value, values: [] }, inDouble);
  }
  const evaluate = (parts: (string | WordPart)[]): bigint =>
    shell.evaluateText(expander.arithmeticText({ pieces: parts, row: shell.currentRow }), undefined);
  const offset = evaluate(offsetParts);
  const negativeLength = (): never =>
    shell.discard(`${rawLengthSource(expansion.text, expansion.name)}: substring expression < 0`);
  if (value.kind === 'scalar') {
    const sliced = sliceString(
      value.value as string,
      offset,
      lengthParts && (() => evaluate(lengthParts)),
      negativeLength
    );
    return sliced === undefined ? [] : expander.valuePieces({ kind: 'scalar', value: sliced }, inDouble);
  }
  const values = sliceList(shell, name, value, offset);
  if (values === undefined) return expander.valuePieces({ ...value, values: [] }, inDouble);
  const length = lengthParts === undefined ? undefined : evaluate(lengthParts);
  if (length !== undefined && length < 0n) negativeLength();
  return expander.valuePieces(
    { ...value, values: length === undefined ? values : values.slice(0, Number(length)), transformed: true },
    inDouble
  );
}

/** A string's characters from `offset`, counting from the end when negative, and `length` of them or to the end. */
function sliceString(
  text: string,
  start: bigint,
  readLength: (() => bigint) | undefined,
  negativeLength: () => never
): string | undefined {
  const chars = charactersOf(text);
  const size = BigInt(chars.length);
  const offset = start < 0n ? start + size : start;
  if (offset < 0n || offset > size) return undefined;
  const length = readLength?.();
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
    const total = BigInt(value.values.length + 1);
    const offset = start < 0n ? start + total : start;
    return offset < 0n || offset > total ? undefined : ['main.sh', ...value.values].slice(Number(offset));
  }
  if (shell.isAssociative(shell.resolveName(name))) return sliceAssociative(value.values, start);
  const keyed = arrayEntries(shell, name, value);
  const last = keyed.length > 0 ? (keyed.at(-1) as [bigint, string])[0] : -1n;
  const offset = start < 0n ? last + 1n + start : start;
  if (offset < 0n || offset > last) return undefined;
  return keyed.filter(([key]) => key >= offset).map(([, element]) => element);
}

/** Associative-array slicing counts elements 1-based, so offsets 0 and 1 both start at the first element. */
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

/** Splits `offset:length` at the first `:` outside parentheses and `?:` conditional operators. */
// code-gauge-allow functionCognitiveComplexity -- Tracks parenthesis nesting and ternary ? : pairs across literal word parts.
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
  const spend = (): void => shell.runtime.spend();
  const glob = compileGlob(pattern, spend);
  const all = operator.length === 2;
  for (let i = 0; i < chars.length; i++) {
    if (!all && i > 0) break;
    if (!matchesSlice(glob, chars, i, i + 1, spend)) continue;
    const c = chars[i];
    if (operator.startsWith('^')) chars[i] = upperCase(c);
    else if (operator.startsWith(',')) chars[i] = lowerCase(c);
    else chars[i] = upperCase(c) === c ? lowerCase(c) : upperCase(c);
  }
  return chars.join('');
}

/** `${x@Q}` and the other transformations. */
// code-gauge-allow functionCognitiveComplexity -- Dispatches @Q/@E/@P/@u/@U/@L/@a/@A/@K/@k parameter transformations.
// code-gauge-allow functionNcss -- One case per transformation letter of Bash's parameter expansion.
function transform(
  expander: Expander,
  shell: Shell,
  expansion: ParameterExpansion,
  value: ParameterValue,
  name: string,
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
      const variable = resolveTransformationVariable(shell, name);
      const flags = variable ? ATTRIBUTE_ORDER.filter((attribute) => variable.attributes.has(attribute)).join('') : '';
      if (value.kind === 'list')
        return expander.valuePieces({ ...value, values: value.values.map(() => flags) }, inDouble);
      return value.value === undefined && !variable
        ? []
        : expander.valuePieces({ kind: 'scalar', value: flags }, inDouble);
    }
    case 'A': {
      const { text, isArray } = formatDeclarationTransform(shell, name, value);
      if (value.kind === 'list') {
        if (text === '') return expander.valuePieces({ ...value, values: [] }, inDouble);
        const values =
          isArray && inDouble && !value.star ? splitQuotedDeclarationFields(text, expander.currentIfs()) : [text];
        return expander.valuePieces({ ...value, values, transformed: true }, inDouble);
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

function splitQuotedDeclarationFields(text: string, ifs: string): string[] {
  const eqIndex = text.indexOf('=');
  const splitter = new FieldSplitter(ifs || ' ');
  if (eqIndex === -1) {
    splitter.add({ text, quoted: false, split: true });
  } else {
    splitter.add({ text: text.slice(0, eqIndex + 1), quoted: false, split: true });
    splitter.add({ text: text.slice(eqIndex + 1), quoted: true, split: false });
  }
  return splitter.finish().map((field) => field.map((fragment) => fragment.text).join(''));
}

function resolveTransformationVariable(shell: Shell, name: string): Variable | undefined {
  const resolved = shell.resolveNameOrUndefined(name, false);
  if (resolved === undefined) return undefined;
  const own = shell.findOwnVariable(resolved);
  if (own) return own;
  return resolved.includes('[') ? undefined : shell.dynamicDeclaration(resolved);
}

/** `${x@A}`: formats a scalar or local assignment statement, or `declare -p` output for `${a[@]@A}`. */
function formatDeclarationTransform(
  shell: Shell,
  name: string,
  value: ParameterValue
): { text: string; isArray: boolean } {
  const variable = resolveTransformationVariable(shell, name);
  if (!variable) return { text: '', isArray: false };
  if (value.kind === 'list' && isArrayVariable(variable)) {
    return { text: declarationText(variable), isArray: true };
  }
  const rawScalar = value.kind === 'list' ? value.values[0] : value.value;
  return { text: scalarAssignmentText(shell, variable, rawScalar), isArray: false };
}

function scalarAssignmentText(shell: Shell, variable: Variable, rawScalar: string | undefined): string {
  const targetName = variable.name;
  const flags = ATTRIBUTE_ORDER.filter((attribute) => variable.attributes.has(attribute)).join('');
  const quoted = variable.value && rawScalar !== undefined ? quoteReusable(rawScalar) : undefined;
  const { scopes, functionScopes } = shell.state;
  const isCurrentLocal =
    functionScopes.length > 0 && scopes[functionScopes.at(-1) as number].get(targetName) === variable;
  if (flags) return `declare -${flags} ${targetName}${quoted === undefined ? '' : `=${quoted}`}`;
  if (isCurrentLocal) return `declare ${targetName}${quoted === undefined ? '' : `=${quoted}`}`;
  return quoted === undefined ? '' : `${targetName}=${quoted}`;
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
  if (value.values.length === 0) return expander.valuePieces({ ...value, values: [] }, inDouble);
  const keys = shell.arrayKeys(shell.resolveName(name));
  if (!quoted) {
    return expander.valuePieces(
      { ...value, values: value.values.flatMap((element, index) => [keys[index], element]) },
      inDouble
    );
  }
  const isAssociative = shell.isAssociative(shell.resolveName(name));
  const spend = (cost?: number): void => shell.runtime.spend(cost);
  const pairs = value.values.map(
    (element, index) => `${isAssociative ? quoteKey(keys[index]) : keys[index]} ${doubleQuote(element)}`
  );
  const text = isAssociative
    ? joinBounded(
        pairs.map((pair) => `${pair} `),
        '',
        spend
      )
    : joinBounded(pairs, ' ', spend);
  return expander.valuePieces({ kind: 'scalar', value: text }, inDouble);
}

function quoteKey(key: string): string {
  return /^[A-Za-z0-9_]+$/.test(key) ? key : doubleQuote(key);
}
