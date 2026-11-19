import { type AST, RegExpParser, visitRegExpAST } from '@eslint-community/regexpp';

import { rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';

type Length = readonly [number, number];

// code-gauge-allow functionNcss 59 -- Keeps the regex AST validation and subject restrictions in the same traversal.
// code-gauge-allow functionCognitiveComplexity 30 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function analyzeRegex(
  source: string,
  unicode: boolean,
  utf8: boolean,
  ignoreCase: boolean,
  invalidLookbehind: (start: number, reason: string) => never,
  emptyMarkers: ReadonlyMap<string, string>
): { byteCaselessReferences: Set<string>; emptySource?: string; ambiguousRepetition: boolean } {
  let tree: AST.Pattern;
  try {
    tree = new RegExpParser({ ecmaVersion: 2025 }).parsePattern(source, 0, source.length, { unicode });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof RangeError)
      throw new UnsupportedFeatureError('解析器の制限を超える正規表現');
    throw error;
  }
  const capturesAtEntry = new Map<AST.Assertion, number>();
  let captureCount = 0;
  const references = new Set<string>();
  const contexts: boolean[] = [];
  const lookbehinds: AST.LookaroundAssertion[] = [];
  const lengths = new Map<AST.Element, Length>();
  const ambiguousBodies = new WeakMap<AST.Element, boolean>();
  const alphabets = new WeakMap<AST.Element, bigint>();
  let backwardCaptureReference = false;
  let ambiguousRepetition = false;
  visitRegExpAST(tree, {
    onGroupEnter(node) {
      contexts.push(ignoreCase);
      if (node.modifiers?.add.ignoreCase) ignoreCase = true;
      if (node.modifiers?.remove?.ignoreCase) ignoreCase = false;
    },
    onGroupLeave() {
      ignoreCase = contexts.pop() as boolean;
    },
    onCharacterEnter(node) {
      rt().spend();
      if (!utf8 && ignoreCase && node.value > 127)
        throw new UnsupportedFeatureError('非 UTF-8 の非 ASCII 文字を大文字・小文字を区別せずに照合する正規表現');
    },
    onCharacterSetEnter(node) {
      if (!utf8 && ignoreCase && node.kind === 'property')
        throw new UnsupportedFeatureError('非 UTF-8 の Unicode プロパティの大文字・小文字を区別しない照合');
    },
    onBackreferenceEnter(node) {
      const groups = node.ambiguous ? node.resolved : [node.resolved];
      backwardCaptureReference ||= referencesLocalLookbehindGroup(groups, lookbehinds);
      if (!utf8 && ignoreCase) recordReferenceNames(references, groups);
    },
    onAssertionEnter(node) {
      if (node.kind !== 'lookbehind') return;
      capturesAtEntry.set(node, captureCount);
      lookbehinds.push(node);
    },
    onAssertionLeave(node) {
      if (node.kind !== 'lookbehind') return;
      lookbehinds.pop();
      if (validateLookbehind(node, lengths, invalidLookbehind) && captureCount !== capturesAtEntry.get(node))
        throw new UnsupportedFeatureError('可変長後読みのキャプチャ');
    },
    onAlternativeLeave(node) {
      ambiguousRepetition ||= overlapsInSequence(node, alphabets, lengths);
    },
    onQuantifierLeave(node) {
      validateNullableRepeat(node, lengths);
      ambiguousRepetition ||= node.max > 1 && ambiguousRepeatBody(node.element, ambiguousBodies);
    },
    onCapturingGroupEnter() {
      captureCount++;
    },
  });
  if (backwardCaptureReference) throw new UnsupportedFeatureError('後読みの内部キャプチャへの後方参照');
  return {
    byteCaselessReferences: references,
    emptySource: emptyMarkers.size === 0 ? undefined : specializeForEmptySubject(tree, emptyMarkers),
    ambiguousRepetition,
  };
}

const NON_ASCII = 1n << 128n;
const ANY_CHARACTER = (NON_ASCII << 1n) - 1n;

function overlapsInSequence(
  alternative: AST.Alternative,
  alphabets: WeakMap<AST.Element, bigint>,
  lengths: Map<AST.Element, Length>
): boolean {
  let repeated = 0n;
  for (const atom of alternative.elements) {
    if (atom.type === 'Assertion') continue;
    const alphabet = possibleCharacters(atom, alphabets);
    const repeats = atom.type === 'Quantifier' && atom.max > 1 && atom.min !== atom.max;
    if (repeats && (repeated & alphabet) !== 0n) return true;
    if (elementLength(atom, lengths, new Set())[0] > 0) repeated &= alphabet;
    if (repeats) repeated |= alphabet;
  }
  return false;
}

function possibleCharacters(atom: AST.Element, cache: WeakMap<AST.Element, bigint>): bigint {
  const known = cache.get(atom);
  if (known !== undefined) return known;
  let result = ANY_CHARACTER;
  switch (atom.type) {
    case 'Assertion': {
      result = 0n;
      break;
    }
    case 'Character': {
      result = characterRange(atom.value, atom.value);
      break;
    }
    case 'CharacterClass': {
      result = classCharacters(atom);
      break;
    }
    case 'Group':
    case 'CapturingGroup': {
      result = 0n;
      for (const branch of atom.alternatives)
        for (const element of branch.elements) result |= possibleCharacters(element, cache);
      break;
    }
    case 'Quantifier': {
      result = possibleCharacters(atom.element, cache);
      break;
    }
  }
  cache.set(atom, result);
  return result;
}

function classCharacters(atom: AST.CharacterClass): bigint {
  if (atom.negate) return ANY_CHARACTER;
  let result = 0n;
  for (const element of atom.elements) {
    if (element.type === 'Character') result |= characterRange(element.value, element.value);
    else if (element.type === 'CharacterClassRange') result |= characterRange(element.min.value, element.max.value);
    else return ANY_CHARACTER;
  }
  return result;
}

function characterRange(min: number, max: number): bigint {
  let result = max >= 128 ? NON_ASCII : 0n;
  for (let code = min; code <= Math.min(max, 127); code++) {
    result |= 1n << BigInt(code);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) result |= 1n << BigInt(code ^ 32);
  }
  return result;
}

function ambiguousRepeatBody(node: AST.Element, cache: WeakMap<AST.Element, boolean>): boolean {
  const cached = cache.get(node);
  if (cached !== undefined) return cached;
  let ambiguous = false;
  if (node.type === 'Quantifier') {
    ambiguous = node.min !== node.max || ambiguousRepeatBody(node.element, cache);
  } else if (node.type === 'Group' || node.type === 'CapturingGroup') {
    ambiguous =
      !disjointAlternatives(node.alternatives) ||
      node.alternatives.some((alternative) =>
        alternative.elements.some((element) => ambiguousRepeatBody(element, cache))
      );
  } else if (node.type === 'Backreference') {
    ambiguous = true;
  }
  cache.set(node, ambiguous);
  return ambiguous;
}

function disjointAlternatives(alternatives: AST.Alternative[]): boolean {
  if (alternatives.length <= 1) return true;
  const prefixes = alternatives.map(({ elements }) => {
    let prefix = '';
    for (const element of elements) {
      if (element.type !== 'Character') break;
      prefix += String.fromCodePoint(element.value).toUpperCase().toLowerCase();
    }
    return prefix;
  });
  prefixes.sort();
  return prefixes.every((prefix, index) => index === 0 || !prefix.startsWith(prefixes[index - 1]));
}

function recordReferenceNames(references: Set<string>, groups: readonly AST.CapturingGroup[]): void {
  for (const group of groups) if (group.name) references.add(group.name);
}

function referencesLocalLookbehindGroup(
  groups: readonly AST.CapturingGroup[],
  lookbehinds: readonly AST.LookaroundAssertion[]
): boolean {
  return groups.some(
    (group) =>
      /^\$\d+$/.test(group.name ?? '') &&
      lookbehinds.some((assertion) => group.start > assertion.start && group.end < assertion.end)
  );
}

function specializeForEmptySubject(tree: AST.Pattern, markers: ReadonlyMap<string, string>): string {
  let output = '';
  let cursor = 0;
  const replace = (node: AST.Node, text: string): void => {
    if (node.start < cursor) return;
    output += tree.raw.slice(cursor, node.start) + text;
    cursor = node.end;
  };
  // Character-consuming atoms cannot match an empty subject. Only marker assertions can see the synthetic byte.
  visitRegExpAST(tree, {
    onAssertionEnter(node) {
      const marker = markers.get(node.raw);
      if (marker !== undefined) replace(node, marker);
    },
    onCharacterEnter: (node) => replace(node, '[]'),
    onCharacterSetEnter: (node) => replace(node, '[]'),
    onCharacterClassEnter: (node) => replace(node, '[]'),
  });
  return output + tree.raw.slice(cursor);
}

function validateNullableRepeat(node: AST.Quantifier, lengths: Map<AST.Element, Length>): void {
  const group = node.element;
  if (node.max === node.min || (group.type !== 'CapturingGroup' && group.type !== 'Group')) return;
  const [min, max] = elementLength(group, lengths, new Set());
  if (min !== 0) return;
  if (group.type === 'CapturingGroup' && /^\$\d+$/.test(group.name ?? '') && (node.min === 0 || max > 0))
    throw new UnsupportedFeatureError('空に一致できるキャプチャの繰り返し');
  if (max > 0 && prefersEmpty(group, lengths))
    throw new UnsupportedFeatureError('空の一致を優先する正規表現の繰り返し');
}

function prefersEmpty(node: AST.Element, lengths: Map<AST.Element, Length>): boolean {
  const [min, max] = elementLength(node, lengths, new Set());
  if (min > 0 || max === 0) return false;
  if (node.type === 'Quantifier') return !node.greedy || prefersEmpty(node.element, lengths);
  if (node.type !== 'Group' && node.type !== 'CapturingGroup') return false;
  let nullable = false;
  for (const alternative of node.alternatives) {
    const [alternativeMin, alternativeMax] = alternativeLength(alternative, lengths, new Set());
    if (nullable && alternativeMax > 0) return true;
    if (alternativeMin === 0) {
      if (alternative.elements.some((element) => prefersEmpty(element, lengths))) return true;
      nullable = true;
    }
  }
  return false;
}

function validateLookbehind(
  node: AST.Assertion,
  lengths: Map<AST.Element, Length>,
  invalid: (start: number, reason: string) => never
): boolean {
  if (node.kind !== 'lookbehind') return false;
  let firstLength: number | undefined;
  let variable = false;
  let uneven = false;
  let longest = 0;
  for (const alternative of node.alternatives) {
    const [min, max] = alternativeLength(alternative, lengths, new Set());
    if (!Number.isFinite(max)) invalid(node.start, 'length of lookbehind assertion is not limited');
    if (max > 65_535) invalid(node.start, 'lookbehind assertion is too long');
    variable ||= min !== max;
    uneven ||= firstLength !== undefined && min !== firstLength;
    longest = Math.max(longest, max);
    firstLength ??= min;
  }
  if (variable && longest > 255) invalid(node.start, 'branch too long in variable-length lookbehind assertion');
  return variable || uneven;
}

function alternativeLength(node: AST.Alternative, cache: Map<AST.Element, Length>, active: Set<AST.Element>): Length {
  let min = 0,
    max = 0;
  for (const element of node.elements) {
    const length = elementLength(element, cache, active);
    min += length[0];
    max += length[1];
  }
  return [min, max];
}

// code-gauge-allow functionNcss 33 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function elementLength(node: AST.Element, cache: Map<AST.Element, Length>, active: Set<AST.Element>): Length {
  const cached = cache.get(node);
  if (cached) return cached;
  if (active.has(node)) throw new UnsupportedFeatureError('再帰する後読み正規表現');
  rt().spend();
  active.add(node);
  let result: Length;
  if (node.type === 'Assertion') result = [0, 0];
  else if (node.type === 'Quantifier') {
    const [min, max] = elementLength(node.element, cache, active);
    result = [min * node.min, max === 0 ? 0 : max * node.max];
  } else if (node.type === 'Group' || node.type === 'CapturingGroup') {
    let min = Infinity,
      max = 0;
    for (const part of node.alternatives) {
      const length = alternativeLength(part, cache, active);
      min = Math.min(min, length[0]);
      max = Math.max(max, length[1]);
    }
    result = [min, max];
  } else if (node.type === 'Backreference') {
    if (node.ambiguous) throw new UnsupportedFeatureError('曖昧な後方参照を含む後読み');
    result = elementLength(node.resolved, cache, active);
  } else result = [1, 1];
  active.delete(node);
  cache.set(node, result);
  return result;
}
