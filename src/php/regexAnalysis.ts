import { type AST, RegExpParser, visitRegExpAST } from '@eslint-community/regexpp';

import { rt } from './runtime';
import { UnsupportedFeatureError } from './unsupported';

type Length = readonly [number, number];

// code-gauge-allow functionNcss 49 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
// code-gauge-allow functionCognitiveComplexity 30 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
export function analyzeRegex(
  source: string,
  unicode: boolean,
  utf8: boolean,
  ignoreCase: boolean,
  invalidLookbehind: (start: number, reason: string) => never
): Set<string> {
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
  const lengths = new Map<AST.Element, Length>();
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
      if (!utf8 && ignoreCase) {
        const groups = node.ambiguous ? node.resolved : [node.resolved];
        for (const group of groups) if (group.name) references.add(group.name);
      }
    },
    onAssertionEnter(node) {
      capturesAtEntry.set(node, captureCount);
    },
    onAssertionLeave(node) {
      if (validateLookbehind(node, lengths, invalidLookbehind) && captureCount !== capturesAtEntry.get(node))
        throw new UnsupportedFeatureError('可変長後読みのキャプチャ');
    },
    onQuantifierLeave(node) {
      validateCaptureRepeat(node, lengths);
    },
    onCapturingGroupEnter() {
      captureCount++;
    },
  });
  return references;
}

function validateCaptureRepeat(node: AST.Quantifier, lengths: Map<AST.Element, Length>): void {
  const group = node.element;
  if (group.type !== 'CapturingGroup' || !/^\$\d+$/.test(group.name ?? '') || node.max === node.min) return;
  const [min, max] = elementLength(group, lengths, new Set());
  if (min === 0 && (node.min === 0 || max > 0)) throw new UnsupportedFeatureError('空に一致できるキャプチャの繰り返し');
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
