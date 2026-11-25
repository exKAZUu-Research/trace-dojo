// code-gauge-allow-file fileNcss -- Keeps Bash's parameter expansion operators and transformations in one module.
import type { ParameterExpansion, WordPart } from './ast';
import { ATTRIBUTE_ORDER } from './capabilities';
import { charactersOf, lowerCase, upperCase } from './characters';
import { decodeAnsiC } from './converter';
import { declarationText, quoteKey, quoteValue } from './declarePrint';
import { appendBounded, type Expander, joinBounded, type ParameterValue, type SubscriptRef } from './expansion';
import {
  EMPTY_LIST_SEGMENT,
  FIELD_BREAK_SEGMENT,
  isBreakSegment,
  QUOTED_EMPTY_SEGMENT,
  splitWordSegments,
  type TextSegment,
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
import { UnsupportedFeatureError } from './unsupported';
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
  const roots = parameterValueRoots(value);
  return shell.withValuesRoot(roots, () => {
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
        const isNull = isUnset || (colon && isEmptyParameterValue(expander, value, ctx.inDouble));
        const kind = operator.at(-1) as string;
        if (kind === '+') {
          if (isNull) return value.kind === 'list' && !value.star && ctx.inDouble ? [EMPTY_LIST_SEGMENT] : [];
          return expandArgument(expander, argument, { inDouble: ctx.inDouble, spacedStar: true }, false, roots);
        }
        if (!isNull) return expander.valueSegments(value, ctx);
        return defaultValue(expander, shell, expansion, kind, colon, name, subscript, ctx, roots);
      }
      case '#':
      case '##':
      case '%':
      case '%%': {
        const pattern = expander.patternOf(expandArgument(expander, argument, ctx, true, roots));
        return mapPatternRemoval(expander, shell, value, ctx, (text) => removePattern(text, pattern, operator, shell));
      }
      case '/':
      case '//':
      case '/#':
      case '/%': {
        const { pattern: patternParts, replacement } = splitReplacement(argument);
        const pattern = expander.patternOf(expandArgument(expander, patternParts, ctx, true, roots));
        const replace = replacement === undefined ? [] : expandArgument(expander, replacement, ctx, true, roots);
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
        const pattern =
          argument.length > 0 ? expander.patternOf(expandArgument(expander, argument, ctx, true, roots)) : '?';
        return mapValues(expander, value, ctx, (text) => changeCase(text, pattern, operator, shell));
      }
      case '@': {
        return transform(expander, shell, expansion, value, name, ctx);
      }
      default: {
        return shell.discard(`${expansion.text}: bad substitution`);
      }
    }
  });
}

function parameterValueRoots(value: ParameterValue): string[] {
  if (value.kind === 'list') return [...value.values];
  return value.value === undefined ? [] : [value.value];
}

function isEmptyParameterValue(expander: Expander, value: ParameterValue, inDouble: boolean): boolean {
  if (value.kind === 'scalar') return (value.value ?? '') === '';
  const sep = value.star && inDouble ? expander.ifsJoiner() : ' ';
  if (value.values.length > 1 && sep !== '') return false;
  return value.values.every((element) => element === '');
}

function expandArgument(
  expander: Expander,
  parts: WordPart[],
  ctx: WordContext,
  isPattern: boolean,
  roots: string[]
): WordSegment[] {
  if (isPattern) {
    expander.checkTilde(parts, false);
    const expanded = expander.expandParts(parts, { inDouble: false, spacedStar: ctx.spacedStar });
    pushSegmentRoots(roots, expanded);
    return expanded;
  }
  if (!ctx.inDouble) return expandUnquotedOperatorWord(expander, parts, ctx.spacedStar, roots);
  const segments: WordSegment[] = [];
  for (const part of parts) {
    const chunk = expandDoubleQuotedOperatorPart(expander, part, ctx.spacedStar);
    pushSegmentRoots(roots, chunk);
    segments.push(...chunk);
  }
  const kept = segments.filter((seg) => seg.kind !== 'emptyList');
  return kept.length === 0 ? [QUOTED_EMPTY_SEGMENT] : kept;
}

function expandDoubleQuotedOperatorPart(expander: Expander, part: WordPart, spacedStar: boolean): WordSegment[] {
  if (part.kind === 'single') return [textSegment(`'${part.text}'`, true, false)];
  const inDouble = part.kind !== 'double';
  return expander.expandParts([part], { inDouble, spacedStar });
}

function pushSegmentRoots(roots: string[], segments: readonly WordSegment[]): void {
  for (const seg of segments) {
    if (seg.kind === 'text' && seg.text !== '') roots.push(seg.text);
  }
}

type NonEmptySegment = Exclude<WordSegment, { kind: 'emptyList' }>;

interface OperatorWordEntry {
  readonly segment: NonEmptySegment;
  readonly keepsFields: boolean;
}

function expandUnquotedOperatorWord(
  expander: Expander,
  parts: WordPart[],
  spacedStar: boolean,
  roots: string[]
): WordSegment[] {
  expander.checkTilde(parts, false);
  const ifs = expander.currentIfs();
  const entries = collectOperatorWordEntries(expander, parts, spacedStar, expander.ifsJoiner(), roots);
  if (ifs !== '' && ifs[0] !== ' ' && entries.some(isUnquotedAtListEntry)) {
    return joinOperatorWordFields(ifs, entries);
  }
  return entries.map(({ segment, keepsFields }) =>
    isBreakSegment(segment) || segment.quoted || keepsFields ? segment : { ...segment, split: true }
  );
}

function collectOperatorWordEntries(
  expander: Expander,
  parts: WordPart[],
  spacedStar: boolean,
  starJoiner: string,
  roots: string[]
): OperatorWordEntry[] {
  const entries: OperatorWordEntry[] = [];
  const itemCtx: WordContext = { inDouble: false, spacedStar };
  for (const part of parts) {
    const keepsFields = keepsOperatorFields(part);
    const expanded = expander.expandParts([part], itemCtx);
    pushSegmentRoots(roots, expanded);
    for (const seg of expanded) {
      if (seg.kind === 'emptyList') continue;
      if (seg.kind === 'break' && seg.breakKind === 'star' && !keepsFields && starJoiner !== '') {
        entries.push({ segment: textSegment(starJoiner, false, true, { fromList: true }), keepsFields });
        continue;
      }
      entries.push({ segment: seg, keepsFields });
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

function isUnquotedAtListEntry({ segment, keepsFields }: OperatorWordEntry): boolean {
  return !keepsFields && segment.kind === 'text' && segment.atListElement === true;
}

function isProtectedFieldBreak({ segment, keepsFields }: OperatorWordEntry): boolean {
  return keepsFields && isBreakSegment(segment);
}

function joinOperatorWordFields(ifs: string, entries: OperatorWordEntry[]): WordSegment[] {
  const hasProtectedBreak = entries.some(isProtectedFieldBreak);
  const groups = splitOperatorGroups(entries, hasProtectedBreak);
  const result: WordSegment[] = [];
  for (const [index, group] of groups.entries()) {
    if (index > 0) result.push(FIELD_BREAK_SEGMENT);
    result.push(...joinOperatorGroup(ifs, group));
  }
  return result;
}

function splitOperatorGroups(entries: OperatorWordEntry[], hasProtectedBreak: boolean): OperatorWordEntry[][] {
  const groups: OperatorWordEntry[][] = [[]];
  for (const entry of entries) {
    const isHardBreak =
      (entry.keepsFields && isBreakSegment(entry.segment)) ||
      (hasProtectedBreak && entry.segment.kind === 'break' && entry.segment.breakKind === 'positional');
    if (isHardBreak) groups.push([]);
    else (groups.at(-1) as OperatorWordEntry[]).push(entry);
  }
  return groups;
}

function joinOperatorGroup(ifs: string, entries: OperatorWordEntry[]): WordSegment[] {
  const fields = splitWordSegments(entries.map(toOperatorSplitterSegment), ifs);
  if (fields.length === 0) return [];
  return joinNonEmptyOperatorFields(fields);
}

function toOperatorSplitterSegment({ segment, keepsFields }: OperatorWordEntry): WordSegment {
  if (isBreakSegment(segment) || segment.quoted || keepsFields) return segment;
  if (segment.atListElement) {
    return segment.text === '' ? { ...segment, split: true, operatorNull: true } : { ...segment, split: false };
  }
  return { ...segment, split: true };
}

function joinNonEmptyOperatorFields(fields: TextSegment[][]): WordSegment[] {
  const joined: WordSegment[] = [];
  for (const [index, field] of fields.entries()) {
    if (index > 0) joined.push(textSegment(' ', false, true));
    if (field.length === 0) {
      joined.push(textSegment('', false, true, { operatorNull: true }));
      continue;
    }
    for (const fragment of field) joined.push({ ...fragment, split: false });
  }
  return joined;
}

// code-gauge-allow functionParameterCount -- Default and assignment operators take expansion metadata, explicit WordContext, and GC roots.
function defaultValue(
  expander: Expander,
  shell: Shell,
  expansion: ParameterExpansion,
  kind: string,
  colon: boolean,
  name: string,
  subscript: SubscriptRef | undefined,
  ctx: WordContext,
  roots: string[]
): WordSegment[] {
  if (kind === '-')
    return expandArgument(expander, expansion.argument, { inDouble: ctx.inDouble, spacedStar: true }, false, roots);
  if (kind === '?') return failRequireOperator(expander, shell, expansion.argument, colon, name, subscript);
  const word = expandArgument(
    expander,
    expansion.argument,
    { inDouble: ctx.inDouble, spacedStar: false },
    false,
    roots
  );
  const text = expander.joinSegments(word);
  const target = resolveAssignOperatorTarget(shell, name, subscript);
  const outcome = writeResolvedTarget(shell, target, text, false);
  if (!outcome.ok) shell.failures.handleStoreFailure('expansion', outcome);
  const stored = outcome.ok ? outcome.stored : '';
  const fromList = !ctx.inDouble && word.some((seg) => seg.kind === 'text' && seg.fromList);
  return fromList && stored !== ''
    ? [textSegment(stored, false, true, { fromList: true })]
    : expander.valueSegments({ kind: 'scalar', value: stored }, ctx);
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
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || subscript?.wholeArray) {
    shell.discard(`$${name}: cannot assign in this way`);
  }
  const target =
    subscript === undefined
      ? resolveScalarTarget(shell, name, true)
      : resolveSubscriptTarget(shell, {
          name,
          subscript: {
            kind: 'text',
            text: subscript.text === '' && subscript.rawText !== '' ? '0' : subscript.text,
            preExpanded: true,
          },
          operation: 'write',
        });
  if (!target) shell.discard(`${name}: circular name reference`);
  return target;
}

function expandErrorWord(expander: Expander, shell: Shell, parts: WordPart[]): string {
  expander.checkTilde(parts, false);
  const segments = expander.expandParts(parts, { inDouble: false, spacedStar: true });
  const spend = (cost?: number): void => shell.runtime.spend(cost);
  const fields = expander.splitFields(segments).map((field) =>
    joinBounded(
      field.map((fragment) => fragment.text),
      '',
      spend
    )
  );
  return joinBounded(fields, ' ', spend);
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
    const text = joinBounded(value.values.map(map), ' ', (cost) => shell.runtime.spend(cost));
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
    if (seg.kind === 'break') text = appendBounded(text, ' ', spend);
    else if (seg.quoted) text = appendBounded(text, seg.text, spend);
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
    if (match.end === match.start) {
      result = appendBounded(result, chars[match.start] ?? '', spend);
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
  const { offset: offsetParts, length: lengthParts } = splitSubstring(expansion.argument);
  if (value.kind === 'scalar' && value.value === undefined) return [];
  if (value.kind === 'list' && name !== '@' && name !== '*' && value.values.length === 0) {
    return expander.valueSegments({ ...value, values: [] }, ctx);
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
    return sliced === undefined ? [] : expander.valueSegments({ kind: 'scalar', value: sliced }, ctx);
  }
  const values = sliceList(shell, name, value, offset);
  if (values === undefined) return expander.valueSegments({ ...value, values: [] }, ctx);
  const length = lengthParts === undefined ? undefined : evaluate(lengthParts);
  if (length !== undefined && length < 0n) negativeLength();
  return expander.valueSegments(
    { ...value, values: length === undefined ? values : values.slice(0, Number(length)), transformed: true },
    ctx
  );
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
  const resolved = resolveTargetName(shell, name, false) ?? name;
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

// code-gauge-allow functionCognitiveComplexity -- Dispatches @Q/@E/@P/@u/@U/@L/@a/@A/@K/@k parameter transformations.
// code-gauge-allow functionNcss -- One case per transformation letter of Bash's parameter expansion.
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
      throw new UnsupportedFeatureError('プロンプトの展開（${x@P}）');
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
      const view = resolveTransformationView(shell, name);
      const flags = view ? ATTRIBUTE_ORDER.filter((attribute) => view.attributes.has(attribute)).join('') : '';
      if (value.kind === 'list') {
        return expander.valueSegments({ ...value, values: value.values.map(() => flags) }, ctx);
      }
      return value.value === undefined && !view ? [] : expander.valueSegments({ kind: 'scalar', value: flags }, ctx);
    }
    case 'A': {
      const { text, isArray } = formatDeclarationTransform(shell, name, value);
      if (value.kind === 'list') {
        if (text === '') return expander.valueSegments({ ...value, values: [] }, ctx);
        const values =
          isArray && ctx.inDouble && !value.star ? splitQuotedDeclarationFields(text, expander.currentIfs()) : [text];
        return expander.valueSegments({ ...value, values, transformed: true }, ctx);
      }
      return expander.valueSegments({ kind: 'scalar', value: text }, ctx);
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

function splitQuotedDeclarationFields(text: string, ifs: string): string[] {
  const eqIndex = text.indexOf('=');
  const segs: WordSegment[] =
    eqIndex === -1
      ? [textSegment(text, false, true)]
      : [textSegment(text.slice(0, eqIndex + 1), false, true), textSegment(text.slice(eqIndex + 1), true, false)];
  return splitWordSegments(segs, ifs || ' ').map((field) => field.map((fragment) => fragment.text).join(''));
}

function resolveTransformationView(shell: Shell, name: string): VariableView | undefined {
  const resolved = resolveTargetName(shell, name, false);
  if (resolved === undefined) return undefined;
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
    return expander.valueSegments({ kind: 'scalar', value: quoted ? quoteReusable(value.value) : value.value }, ctx);
  }
  if (value.values.length === 0) return expander.valueSegments({ ...value, values: [] }, ctx);
  const resolved = resolveTargetName(shell, name, false) ?? name;
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
    ? joinBounded(
        pairs.map((pair) => `${pair} `),
        '',
        spend
      )
    : joinBounded(pairs, ' ', spend);
  return expander.valueSegments({ kind: 'scalar', value: text }, ctx);
}
