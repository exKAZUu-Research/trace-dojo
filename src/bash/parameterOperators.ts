// code-gauge-allow-file fileNcss -- Keeps Bash's parameter expansion operators and transformations in one module.
import type { ParameterExpansion, Word, WordPart } from './ast';
import { appendMetered, joinMetered, pushMeteredItem } from './budget';
import { ATTRIBUTE_ORDER, rejectListInScalarContext, rejectUnsupportedExpansion } from './capabilities';
import { charactersOf, lowerCase, upperCase } from './characters';
import { decodeAnsiC } from './converter';
import { declarationText, quoteKey, quoteValue } from './declarePrint';
import { type Expander, isListExpansionSyntax, type ParameterValue, type SubscriptRef } from './expansion';
import {
  EMPTY_LIST_SEGMENT,
  QUOTED_EMPTY_SEGMENT,
  splitWordSegments,
  textSegment,
  type WordContext,
  type WordSegment,
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
import { quoteReusable } from './quoting';
import { ExitSignal } from './runtime';
import type { Shell } from './shell';
import {
  type ResolvedTarget,
  resolveScalarTarget,
  resolveSubscriptTarget,
  resolveTargetName,
  writeResolvedTarget,
} from './targets';
import type { VariableView } from './variables';

/** Applies the operator of `${name<operator>argument}` to the parameter's value. */
// code-gauge-allow functionCognitiveComplexity -- One case per operator family of Bash's parameter expansion.
// code-gauge-allow functionNcss -- One case per operator family of Bash's parameter expansion.
// code-gauge-allow functionParameterCount -- Passes explicit immutable WordContext alongside parameter metadata.
export function applyOperator(
  expander: Expander,
  shell: Shell,
  expansion: ParameterExpansion,
  value: ParameterValue,
  name: string,
  subscript: SubscriptRef | undefined,
  ctx: WordContext
): WordSegment[] {
  const operator = expansion.operator as string;
  const { argument } = expansion;
  rejectNestedListParts(argument);
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
      const isNull = isUnset || (colon && isEmptyParameterValue(expander, value, ctx.inDouble));
      const kind = operator.at(-1) as string;
      if (kind === '+') {
        if (isNull) return value.kind === 'list' && !value.star && ctx.inDouble ? [EMPTY_LIST_SEGMENT] : [];
        return expandArgument(expander, argument, ctx, false);
      }
      if (!isNull) return expander.valueSegments(value, ctx, expansion.text);
      return defaultValue(expander, shell, expansion, kind, colon, name, subscript, ctx);
    }
    case '#':
    case '##':
    case '%':
    case '%%': {
      const pattern = expander.patternOf(expandArgument(expander, argument, ctx, true));
      return mapPatternRemoval(expander, shell, value, ctx, (text) => removePattern(text, pattern, operator, shell));
    }
    case '/':
    case '//':
    case '/#':
    case '/%': {
      const { pattern: patternParts, replacement } = splitReplacement(argument);
      const pattern = expander.patternOf(expandArgument(expander, patternParts, ctx, true));
      const replace = replacement === undefined ? [] : expandArgument(expander, replacement, ctx, true);
      return mapValues(expander, value, ctx, (text) => substitute(text, pattern, replace, operator, shell));
    }
    case ':': {
      return substring(expander, shell, expansion, value, name, ctx);
    }
    case '^':
    case '^^':
    case ',':
    case ',,':
    case '~':
    case '~~': {
      const pattern = argument.length > 0 ? expander.patternOf(expandArgument(expander, argument, ctx, true)) : '?';
      return mapValues(expander, value, ctx, (text) => changeCase(text, pattern, operator, shell));
    }
    case '@': {
      return transform(expander, shell, expansion, value, name, ctx);
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

function rejectNestedListParts(parts: readonly WordPart[]): void {
  for (const part of parts) {
    if (part.kind === 'parameter' && isListExpansionSyntax(part)) rejectListInScalarContext(part.text);
    else if (part.kind === 'double') rejectNestedListParts(part.parts);
  }
}

/** Expands a scalar-only operator argument word (list expansions inside operator words are gated by `Expander`). */
function expandArgument(expander: Expander, parts: WordPart[], ctx: WordContext, isPattern: boolean): WordSegment[] {
  if (isPattern) {
    expander.checkTilde(parts, false);
    return expander.expandParts(parts, { inDouble: false, spacedStar: false, inOperatorWord: true });
  }
  if (!ctx.inDouble) {
    expander.checkTilde(parts, Boolean(ctx.inAssignmentValue));
    const expanded = expander.expandParts(parts, {
      inDouble: false,
      spacedStar: false,
      ...(ctx.inAssignmentValue ? { inAssignmentValue: true } : {}),
      inOperatorWord: true,
    });
    return expanded.map((seg) =>
      seg.kind === 'text' && !seg.quoted && !ctx.inAssignmentValue ? { ...seg, split: true } : seg
    );
  }
  const segments: WordSegment[] = [];
  for (const part of parts) {
    segments.push(...expandDoubleQuotedOperatorPart(expander, part));
  }
  const kept = segments.filter((seg) => seg.kind !== 'emptyList');
  return kept.length === 0 ? [QUOTED_EMPTY_SEGMENT] : kept;
}

function expandDoubleQuotedOperatorPart(expander: Expander, part: WordPart): WordSegment[] {
  if (part.kind === 'single') return [textSegment(`'${part.text}'`, true, false)];
  const inDouble = part.kind !== 'double';
  return expander.expandParts([part], {
    inDouble,
    spacedStar: false,
    inOperatorWord: true,
    inQuotedOperatorWord: true,
  });
}

// code-gauge-allow functionParameterCount -- Default and assignment operators take expansion metadata and explicit WordContext.
function defaultValue(
  expander: Expander,
  shell: Shell,
  expansion: ParameterExpansion,
  kind: string,
  colon: boolean,
  name: string,
  subscript: SubscriptRef | undefined,
  ctx: WordContext
): WordSegment[] {
  if (kind === '-') return expandArgument(expander, expansion.argument, ctx, false);
  if (kind === '?') return failRequireOperator(expander, shell, expansion.argument, colon, name, subscript);
  const word = expandArgument(
    expander,
    expansion.argument,
    { inDouble: ctx.inDouble, spacedStar: false, inAssignmentValue: true },
    false
  );
  const text = expander.joinSegments(word);
  const target = resolveAssignOperatorTarget(shell, name, subscript);
  const outcome = writeResolvedTarget(shell, target, text, false);
  if (!outcome.ok) shell.failures.handleStoreFailure('expansion', outcome);
  const stored = outcome.ok ? outcome.stored : '';
  return expander.valueSegments({ kind: 'scalar', value: stored }, ctx, expansion.text);
}

function failRequireOperator(
  expander: Expander,
  shell: Shell,
  argument: WordPart[],
  colon: boolean,
  name: string,
  subscript: SubscriptRef | undefined
): never {
  const message =
    argument.length === 0
      ? colon
        ? 'parameter null or not set'
        : 'parameter not set'
      : expandErrorWord(expander, shell, argument);
  expander.failParameter(subscript === undefined ? name : `${name}[${subscript.text}]`, message);
}

function resolveAssignOperatorTarget(shell: Shell, name: string, subscript: SubscriptRef | undefined): ResolvedTarget {
  if (subscript?.indirect !== undefined) {
    shell.discard(`${subscript.indirect}: invalid variable name`);
  }
  if (name.startsWith('!')) {
    shell.discard(`${name}: invalid indirect expansion`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || subscript?.wholeArray) {
    shell.discard(`$${name}: cannot assign in this way`);
  }
  return subscript === undefined
    ? resolveScalarTarget(shell, name, true)
    : resolveSubscriptTarget(shell, {
        name,
        subscript: { kind: 'word', word: subscript.word as Word, unquoteAnsiC: true },
        operation: 'write',
      });
}

function expandErrorWord(expander: Expander, shell: Shell, parts: WordPart[]): string {
  expander.checkTilde(parts, false);
  const segments = expander.expandParts(parts, { inDouble: false, spacedStar: false, inOperatorWord: true });
  const spend = (cost?: number): void => shell.runtime.spend(cost);
  const fields = expander.splitFields(segments).map((field) =>
    joinMetered(
      field.map((fragment) => fragment.text),
      '',
      spend
    )
  );
  return joinMetered(fields, ' ', spend);
}

function mapPatternRemoval(
  expander: Expander,
  shell: Shell,
  value: ParameterValue,
  ctx: WordContext,
  map: (text: string) => string
): WordSegment[] {
  if (!ctx.inDouble && value.kind === 'list' && !value.positional && shell.store.readScalar('IFS') === '') {
    if (value.values.length === 0) return [];
    const text = joinMetered(value.values.map(map), ' ', (cost) => shell.runtime.spend(cost));
    return text === '' ? [] : [textSegment(text, false, false)];
  }
  return mapValues(expander, value, ctx, map);
}

function mapValues(
  expander: Expander,
  value: ParameterValue,
  ctx: WordContext,
  map: (text: string) => string
): WordSegment[] {
  if (value.kind === 'scalar') {
    if (value.value === undefined) return [];
    return expander.valueSegments({ kind: 'scalar', value: map(value.value) }, ctx);
  }
  return expander.valueSegments({ ...value, values: value.values.map(map), transformed: true }, ctx);
}

function removePattern(text: string, pattern: string, operator: string, shell: Shell): string {
  const chars = charactersOf(text);
  const step = shell.runtime.step;
  const glob = compileGlob(pattern, step);
  if (operator === '#') {
    const end = shortestPrefixMatch(glob, chars, 0, step);
    return end === undefined ? text : chars.slice(end).join('');
  }
  if (operator === '##') {
    const end = longestPrefixMatch(glob, chars, 0, step);
    return end === undefined ? text : chars.slice(end).join('');
  }
  const start = operator === '%' ? shortestSuffixMatch(glob, chars, step) : longestSuffixMatch(glob, chars, step);
  return start === undefined ? text : chars.slice(0, start).join('');
}

// code-gauge-allow functionCognitiveComplexity -- Finds the first unquoted slash across the argument's parts.
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

function replacementFor(replacement: readonly WordSegment[], matched: string, spend: (cost?: number) => void): string {
  let text = '';
  for (const seg of replacement) {
    if (seg.kind === 'emptyList') continue;
    if (seg.kind === 'break') text = appendMetered(text, ' ', spend);
    else if (seg.quoted) text = appendMetered(text, seg.text, spend);
    else text = appendUnquotedReplacement(text, seg.text, matched, spend);
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
      text = appendMetered(appendMetered(text, raw.slice(literalStart, i), spend), '&', spend);
      i++;
      literalStart = i + 1;
    } else if (c === '&') {
      text = appendMetered(appendMetered(text, raw.slice(literalStart, i), spend), matched, spend);
      literalStart = i + 1;
    }
  }
  return appendMetered(text, raw.slice(literalStart), spend);
}

// code-gauge-allow functionCognitiveComplexity -- Shares leftmost-longest search and empty-match advance across `/`, `//`, `/#`, and `/%`.
function substitute(
  text: string,
  pattern: string,
  replacement: readonly WordSegment[],
  operator: string,
  shell: Shell
): string {
  if (pattern === '' && operator !== '/#' && operator !== '/%') return text;
  const chars = charactersOf(text);
  const spend = (cost?: number): void => shell.runtime.spend(cost);
  const step = shell.runtime.step;
  const glob = compileGlob(pattern, step);
  const replace = (start: number, end: number): string =>
    replacementFor(replacement, chars.slice(start, end).join(''), spend);
  if (operator === '/#') {
    const end = longestPrefixMatch(glob, chars, 0, step);
    return end === undefined ? text : appendMetered(replace(0, end), chars.slice(end).join(''), spend);
  }
  if (operator === '/%') {
    const start = longestSuffixMatch(glob, chars, step);
    return start === undefined
      ? text
      : appendMetered(chars.slice(0, start).join(''), replace(start, chars.length), spend);
  }
  let result = '';
  for (let position = 0; position <= chars.length;) {
    const match = nextLeftmostLongestMatch(glob, chars, position, step);
    if (!match) return appendMetered(result, chars.slice(position).join(''), spend);
    result = appendMetered(result, chars.slice(position, match.start).join(''), spend);
    result = appendMetered(result, replace(match.start, match.end), spend);
    if (operator === '/' || chars.length === 0) return appendMetered(result, chars.slice(match.end).join(''), spend);
    if (match.end === match.start) {
      result = appendMetered(result, chars[match.start] ?? '', spend);
      position = match.start + 1;
    } else position = match.end;
  }
  return result;
}

function substring(
  expander: Expander,
  shell: Shell,
  expansion: ParameterExpansion,
  value: ParameterValue,
  name: string,
  ctx: WordContext
): WordSegment[] {
  if (expansion.argument.length === 0) shell.discard(`${expansion.text}: bad substitution`);
  const { offset: offsetParts, length: lengthParts } = splitSubstring(expansion.argument, ctx.inDouble);
  if (value.kind === 'scalar' && value.value === undefined) return [];
  if (value.kind === 'list' && name !== '@' && name !== '*' && value.values.length === 0) {
    return expander.valueSegments({ ...value, values: [] }, ctx, expansion.text);
  }
  const scalarTarget = value.kind === 'scalar' ? value.value : scalarWholeArrayText(shell, name, value);
  const evaluate = (parts: (string | WordPart)[]): bigint => {
    const expanded = expander.arithmeticText({ pieces: parts, row: shell.currentRow }, true, true);
    return shell.evaluateText(expanded, undefined, true);
  };
  const offset = evaluate(offsetParts);
  const negativeLength = (): never =>
    shell.discard(`${rawLengthSource(expansion.text, expansion.name)}: substring expression < 0`);
  if (value.kind === 'scalar' || scalarTarget !== undefined) {
    const sliced = sliceString(
      scalarTarget as string,
      offset,
      lengthParts && (() => evaluate(lengthParts)),
      negativeLength
    );
    return sliceScalarSegments(expander, value, sliced, ctx);
  }
  const values = sliceList(shell, name, value, offset);
  if (values === undefined) return expander.valueSegments({ ...value, values: [] }, ctx, expansion.text);
  const length = lengthParts === undefined ? undefined : evaluate(lengthParts);
  if (length !== undefined && length < 0n) negativeLength();
  return expander.valueSegments(
    { ...value, values: length === undefined ? values : values.slice(0, Number(length)), transformed: true },
    ctx,
    expansion.text
  );
}

function scalarWholeArrayText(
  shell: Shell,
  name: string,
  value: Extract<ParameterValue, { kind: 'list' }>
): string | undefined {
  if (name === '@' || name === '*') return undefined;
  const resolved = resolveTargetName(shell, name);
  return shell.store.isArrayName(resolved) ? undefined : value.values[0];
}

function sliceScalarSegments(
  expander: Expander,
  value: ParameterValue,
  sliced: string | undefined,
  ctx: WordContext
): WordSegment[] {
  if (value.kind === 'scalar') {
    return sliced === undefined ? [] : expander.valueSegments({ kind: 'scalar', value: sliced }, ctx);
  }
  return expander.valueSegments({ ...value, values: sliced === undefined ? [] : [sliced], transformed: true }, ctx);
}

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
  const resolved = resolveTargetName(shell, name);
  if (shell.store.isAssociativeName(resolved)) return sliceAssociative(value.values, start);
  const keys = shell.store.readArrayKeys(resolved);
  const keyed: [bigint, string][] = value.values.map((element, index) => [BigInt(keys[index] ?? index), element]);
  const last = keyed.length > 0 ? (keyed.at(-1) as [bigint, string])[0] : -1n;
  const offset = start < 0n ? last + 1n + start : start;
  if (offset < 0n || offset > last) return undefined;
  return keyed.filter(([key]) => key >= offset).map(([, element]) => element);
}

function sliceAssociative(values: string[], start: bigint): string[] | undefined {
  const size = BigInt(values.length) + (start < 0n ? 1n : 0n);
  const offset = start < 0n ? start + size : start;
  if (offset < 0n || offset > size) return undefined;
  return values.slice(Math.max(Number(offset) - 1, 0));
}

interface SubstringScanState {
  depth: number;
  conditional: number;
  inSingle: boolean;
}

function splitSubstring(
  parts: WordPart[],
  inDouble: boolean
): {
  offset: (string | WordPart)[];
  length: (string | WordPart)[] | undefined;
} {
  const offset: (string | WordPart)[] = [];
  const state: SubstringScanState = { depth: 0, conditional: 0, inSingle: false };
  const unescapeState = { inSingle: false };
  for (const [index, part] of parts.entries()) {
    if (part.kind !== 'literal') {
      offset.push(part.kind === 'single' ? `'${part.text}'` : part);
      continue;
    }
    const splitAt = findSubstringSeparator(part.text, state);
    if (splitAt === -1) {
      offset.push(unescapeSubstringSlice(part.text, inDouble, unescapeState));
      continue;
    }
    const before = unescapeSubstringSlice(part.text.slice(0, splitAt), inDouble, unescapeState);
    if (before) offset.push(before);
    return { offset, length: formatSubstringRest(part.text.slice(splitAt + 1), parts.slice(index + 1), inDouble) };
  }
  return { offset, length: undefined };
}

function formatSubstringRest(after: string, tail: readonly WordPart[], inDouble: boolean): (string | WordPart)[] {
  const state = { inSingle: false };
  const head = unescapeSubstringSlice(after, inDouble, state);
  const rest = tail.map((item): string | WordPart => {
    if (item.kind === 'single') return `'${item.text}'`;
    return item.kind === 'literal' ? unescapeSubstringSlice(item.text, inDouble, state) : item;
  });
  return head ? [head, ...rest] : rest;
}

function unescapeSubstringSlice(text: string, inDouble: boolean, state: { inSingle: boolean }): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const step = stepSubstringChar(text, i, inDouble, state);
    out += step.emit;
    i = step.nextIndex;
  }
  return out;
}

function stepSubstringChar(
  text: string,
  index: number,
  inDouble: boolean,
  state: { inSingle: boolean }
): { emit: string; nextIndex: number } {
  const c = text[index];
  if (state.inSingle) return stepSingleQuotedSubstringChar(text, index, inDouble, state);
  if (c === "'") {
    state.inSingle = true;
    return { emit: c, nextIndex: index };
  }
  if (c !== '\\' || index + 1 >= text.length) return { emit: c, nextIndex: index };
  const next = text[index + 1];
  if (next === '\n') return { emit: '', nextIndex: index + 1 };
  const unescape = inDouble && '$`"\\'.includes(next);
  return { emit: unescape ? next : text.slice(index, index + 2), nextIndex: index + 1 };
}

function stepSingleQuotedSubstringChar(
  text: string,
  index: number,
  inDouble: boolean,
  state: { inSingle: boolean }
): { emit: string; nextIndex: number } {
  const c = text[index];
  if (inDouble && c === '\\' && index + 1 < text.length && '"\\\n'.includes(text[index + 1])) {
    const next = text[index + 1];
    return { emit: next === '\n' ? '' : next, nextIndex: index + 1 };
  }
  if (c === "'") state.inSingle = false;
  return { emit: c, nextIndex: index };
}

function findSubstringSeparator(text: string, state: SubstringScanState): number {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state.inSingle) {
      if (c === "'") state.inSingle = false;
      continue;
    }
    if (c === "'") {
      state.inSingle = true;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (updateSubstringNesting(c, state)) return i;
  }
  return -1;
}

function updateSubstringNesting(c: string, state: SubstringScanState): boolean {
  if (c === '(') state.depth++;
  else if (c === ')') state.depth = Math.max(0, state.depth - 1);
  else if (c === '?' && state.depth === 0) state.conditional++;
  else if (c === ':' && state.depth === 0) {
    if (state.conditional === 0) return true;
    state.conditional--;
  }
  return false;
}

function changeCase(text: string, pattern: string, operator: string, shell: Shell): string {
  const chars = charactersOf(text);
  const step = shell.runtime.step;
  const glob = compileGlob(pattern, step);
  const all = operator.length === 2;
  for (let i = 0; i < chars.length; i++) {
    if (!all && i > 0) break;
    if (!matchesSlice(glob, chars, i, i + 1, step)) continue;
    const c = chars[i];
    if (operator.startsWith('^')) chars[i] = upperCase(c);
    else if (operator.startsWith(',')) chars[i] = lowerCase(c);
    else chars[i] = upperCase(c) === c ? lowerCase(c) : upperCase(c);
  }
  return chars.join('');
}

function transform(
  expander: Expander,
  shell: Shell,
  expansion: ParameterExpansion,
  value: ParameterValue,
  name: string,
  ctx: WordContext
): WordSegment[] {
  const letter =
    expansion.argument.length === 1 && expansion.argument[0].kind === 'literal' ? expansion.argument[0].text : '';
  if (!/^[QEPAKakuUL]$/.test(letter)) {
    shell.reportError(`${expansion.text}: bad substitution`);
    throw new ExitSignal(1);
  }
  switch (letter) {
    case 'Q': {
      return mapValues(expander, value, ctx, quoteReusable);
    }
    case 'E': {
      return mapValues(expander, value, ctx, decodeAnsiC);
    }
    case 'P': {
      return rejectUnsupportedExpansion('promptTransform');
    }
    case 'u': {
      return mapValues(
        expander,
        value,
        ctx,
        (text) => upperCase(charactersOf(text)[0] ?? '') + charactersOf(text).slice(1).join('')
      );
    }
    case 'U': {
      return mapValues(expander, value, ctx, upperCase);
    }
    case 'L': {
      return mapValues(expander, value, ctx, lowerCase);
    }
    case 'a': {
      return attributeTransformSegments(expander, shell, name, value, ctx);
    }
    case 'A': {
      return declarationTransformSegments(expander, shell, value, { name, expansionText: expansion.text }, ctx);
    }
    case 'K':
    case 'k': {
      return keyValuePairs(expander, shell, name, value, letter === 'K', ctx);
    }
    default: {
      throw new Error(`Unknown transformation ${letter}`);
    }
  }
}

function attributeTransformSegments(
  expander: Expander,
  shell: Shell,
  name: string,
  value: ParameterValue,
  ctx: WordContext
): WordSegment[] {
  const view = resolveTransformationView(shell, name);
  const flags = view ? ATTRIBUTE_ORDER.filter((attribute) => view.attributes.has(attribute)).join('') : '';
  if (value.kind === 'list') {
    const values = view?.kind === 'unset' ? (flags === '' ? [] : [flags]) : value.values.map(() => flags);
    return expander.valueSegments({ ...value, values }, ctx);
  }
  return value.value === undefined && !view ? [] : expander.valueSegments({ kind: 'scalar', value: flags }, ctx);
}

function declarationTransformSegments(
  expander: Expander,
  shell: Shell,
  value: ParameterValue,
  target: { name: string; expansionText: string },
  ctx: WordContext
): WordSegment[] {
  if (value.kind === 'list' && value.positional) {
    return positionalDeclarationSegments(expander, shell, value, target.expansionText, ctx);
  }
  const { text, isArray } = formatDeclarationTransform(shell, target.name, value);
  if (value.kind !== 'list') {
    return expander.valueSegments({ kind: 'scalar', value: text }, ctx, target.expansionText);
  }
  if (text === '') return expander.valueSegments({ ...value, values: [] }, ctx, target.expansionText);
  const values =
    isArray && ctx.inDouble && !value.star ? splitQuotedDeclarationFields(text, expander.currentIfs()) : [text];
  return expander.valueSegments({ ...value, values, transformed: true }, ctx, target.expansionText);
}

function positionalDeclarationSegments(
  expander: Expander,
  shell: Shell,
  value: Extract<ParameterValue, { kind: 'list' }>,
  expansionText: string,
  ctx: WordContext
): WordSegment[] {
  if (value.values.length === 0) {
    return expander.valueSegments({ ...value, values: [] }, ctx, expansionText);
  }
  const items = ['set', '--'];
  for (const element of value.values) {
    pushMeteredItem(items, quoteReusable(element), shell.runtime.step);
  }
  return expander.valueSegments({ ...value, values: items, transformed: true }, ctx, expansionText);
}

function splitQuotedDeclarationFields(text: string, ifs: string): string[] {
  const eqIndex = text.indexOf('=');
  const segs: WordSegment[] =
    eqIndex === -1
      ? [textSegment(text, false, true)]
      : [textSegment(text.slice(0, eqIndex + 1), false, true), textSegment(text.slice(eqIndex + 1), true, false)];
  return splitWordSegments(segs, ifs || ' ').map((field) => field.map((fragment) => fragment.text).join(''));
}

function resolveTransformationView(shell: Shell, name: string): VariableView | undefined {
  const resolved = resolveTargetName(shell, name);
  return shell.store.ownView(resolved) ?? shell.store.dynamicView(resolved);
}

function formatDeclarationTransform(
  shell: Shell,
  name: string,
  value: ParameterValue
): { text: string; isArray: boolean } {
  const view = resolveTransformationView(shell, name);
  if (!view) return { text: '', isArray: false };
  const isArray =
    view.kind === 'indexed' || view.kind === 'associative' || view.attributes.has('a') || view.attributes.has('A');
  if (value.kind === 'list' && isArray) {
    return { text: declarationText(view), isArray: true };
  }
  const rawScalar = value.kind === 'list' ? value.values[0] : value.value;
  return { text: scalarAssignmentText(view, rawScalar), isArray: false };
}

function scalarAssignmentText(view: VariableView, rawScalar: string | undefined): string {
  const flags = ATTRIBUTE_ORDER.filter((attribute) => view.attributes.has(attribute)).join('');
  const quoted = view.kind !== 'unset' && rawScalar !== undefined ? quoteReusable(rawScalar) : undefined;
  if (flags) return `declare -${flags} ${view.name}${quoted === undefined ? '' : `=${quoted}`}`;
  if (view.isCurrentLocal) return `declare ${view.name}${quoted === undefined ? '' : `=${quoted}`}`;
  return quoted === undefined ? '' : `${view.name}=${quoted}`;
}

function keyValuePairs(
  expander: Expander,
  shell: Shell,
  name: string,
  value: ParameterValue,
  quoted: boolean,
  ctx: WordContext
): WordSegment[] {
  if (value.kind === 'scalar') {
    if (value.value === undefined) return [];
    return expander.valueSegments({ kind: 'scalar', value: quoteReusable(value.value) }, ctx);
  }
  if (value.values.length === 0) return expander.valueSegments({ ...value, values: [] }, ctx);
  const resolved = resolveTargetName(shell, name);
  if (!shell.store.isArrayName(resolved)) {
    return expander.valueSegments({ ...value, values: value.values.map(quoteReusable) }, ctx);
  }
  const keys = shell.store.readArrayKeys(resolved);
  if (!quoted) {
    return expander.valueSegments(
      { ...value, values: value.values.flatMap((element, index) => [keys[index], element]) },
      ctx
    );
  }
  const isAssociative = shell.store.isAssociativeName(resolved);
  const spend = (cost?: number): void => shell.runtime.spend(cost);
  const pairs = value.values.map(
    (element, index) => `${isAssociative ? quoteKey(keys[index]) : keys[index]} ${quoteValue(element)}`
  );
  const text = isAssociative
    ? joinMetered(
        pairs.map((pair) => `${pair} `),
        '',
        spend
      )
    : joinMetered(pairs, ' ', spend);
  return expander.valueSegments({ kind: 'scalar', value: text }, ctx);
}
