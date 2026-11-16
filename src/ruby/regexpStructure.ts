import { type AST, RegExpParser, RegExpSyntaxError, visitRegExpAST } from '@eslint-community/regexpp';
import {
  type AlternativeNode,
  type LookaroundAssertionNode,
  type Node as SourceNode,
  parse as parseOniguruma,
} from 'oniguruma-parser/parser';

import { ExecutionLimitError } from '../interpreter/limits';
import { UnsupportedFeatureError } from './runtime';

export function supportsRegexpByteView(source: string, extended: boolean): boolean {
  try {
    return byteViewNode(
      parseOniguruma(normalizeRubyUnicodeEscapes(source), {
        flags: extended ? 'x' : '',
        skipLookbehindValidation: true,
        skipBackrefValidation: true,
        skipPropertyNameValidation: true,
      }),
      false
    );
  } catch {
    return false;
  }
}

function byteViewNode(node: SourceNode, inClass: boolean): boolean {
  if (node.type === 'LookaroundAssertion' && node.kind === 'lookbehind') return false;
  if (node.type === 'Assertion' && node.kind === 'word_boundary') return false;
  if (node.type === 'CharacterSet' && !['any', 'digit', 'dot', 'hex', 'space', 'word'].includes(node.kind))
    return false;
  if (node.type === 'Group' && node.flags?.enable?.ignoreCase) return false;
  if (inClass && node.type === 'Character' && node.value >= 128) return false;
  if (node.type === 'CharacterClassRange') return node.max.value < 128;
  if (node.type === 'Quantifier') return byteViewNode(node.body, inClass);
  if ('body' in node) return node.body.every((child) => byteViewNode(child, inClass || node.type === 'CharacterClass'));
  return true;
}

export function validateSourceRanges(source: string, extended: boolean): void {
  if (!source.includes('[')) return;
  try {
    parseOniguruma(normalizeRubyUnicodeEscapes(source), {
      flags: extended ? 'x' : '',
      skipLookbehindValidation: true,
      skipBackrefValidation: true,
      skipPropertyNameValidation: true,
    });
  } catch (error) {
    if (error instanceof RangeError) return;
    if (error instanceof Error && error.message === 'Invalid character class range')
      throw new SyntaxError(onigurumaSyntaxReason(source, extended));
  }
}

// code-gauge-allow functionCognitiveComplexity 18 -- Source and host AST validation distinguish invalid patterns, unsupported forms, and exhausted budgets.
export function validateRegexpStructure(source: string, rubySource: string, extended: boolean): void {
  if (!source.includes('(?<') && !/\\(?:[1-9]|k<)/.test(source)) return;
  try {
    new RegExp(source, 'u');
  } catch (error) {
    if (error instanceof SyntaxError) return;
    if (error instanceof RangeError) throw new ExecutionLimitError('operations');
    throw error;
  }
  try {
    if (rubySource.includes('(?<')) validateSourceLookbehind(rubySource, extended);
    const pattern = new RegExpParser().parsePattern(source, 0, source.length, { unicode: true });
    visitRegExpAST(pattern, {
      onBackreferenceEnter(reference) {
        if (reference.ambiguous || !captureAlwaysParticipates(reference.resolved, reference))
          throw new UnsupportedFeatureError('正規表現の省略可能なキャプチャへの後方参照');
      },
    });
  } catch (error) {
    if (error instanceof RangeError) throw new ExecutionLimitError('operations');
    if (error instanceof RegExpSyntaxError) throw new UnsupportedFeatureError('正規表現の構文の検証');
    throw error;
  }
}

function validateSourceLookbehind(source: string, extended: boolean): void {
  let root: SourceNode;
  try {
    root = parseOniguruma(normalizeRubyUnicodeEscapes(source), {
      flags: extended ? 'x' : '',
      skipBackrefValidation: true,
      skipLookbehindValidation: true,
      skipPropertyNameValidation: true,
    });
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new UnsupportedFeatureError('正規表現の後読みの構文の検証');
  }
  visitSource(root, false, false);
}

// code-gauge-allow functionCognitiveComplexity 18 -- Source traversal carries lookbehind and negative-capture context through nested AST nodes.
function visitSource(node: SourceNode, behind: boolean, negative: boolean): void {
  if (
    behind &&
    ((node.type === 'LookaroundAssertion' && node.kind === 'lookahead') ||
      (node.type === 'Assertion' && ['string_end', 'string_end_newline'].includes(node.kind)) ||
      (node.type === 'CapturingGroup' && negative) ||
      (node.type === 'Group' && node.atomic) ||
      node.type === 'AbsenceFunction' ||
      node.type === 'Subroutine')
  )
    throw new SyntaxError('invalid pattern in look-behind');
  const lookbehind = node.type === 'LookaroundAssertion' && node.kind === 'lookbehind';
  if (lookbehind && !validSourceLookbehind(node)) throw new SyntaxError('invalid pattern in look-behind');
  const inBehind = behind || lookbehind;
  const inNegative = negative || (lookbehind && node.negate);
  if ('body' in node && node.type !== 'Quantifier')
    for (const child of node.body) visitSource(child, inBehind, inNegative);
  if (node.type === 'Quantifier') visitSource(node.body, inBehind, inNegative);
}

function validSourceLookbehind(node: LookaroundAssertionNode | { body: AlternativeNode[] }): boolean {
  if (node.body.every((alternative) => sourceWidth(alternative) !== undefined)) return true;
  if (node.body.length !== 1 || node.body[0].body.length !== 1) return false;
  let sole: SourceNode = node.body[0].body[0];
  while (sole.type === 'Quantifier' && sole.min === 1 && sole.max === 1) sole = sole.body;
  return sole.type === 'Group' && validSourceLookbehind(sole);
}

// code-gauge-allow functionCognitiveComplexity 17 -- Width computation distinguishes sequences, equal-width alternatives, exact quantifiers and zero-width assertions.
function sourceWidth(node: SourceNode): number | undefined {
  if (node.type === 'Alternative') {
    let width = 0;
    for (const child of node.body) {
      const part = sourceWidth(child);
      if (part === undefined) return undefined;
      width += part;
    }
    return width;
  }
  if (node.type === 'Group' || node.type === 'CapturingGroup') {
    const widths = node.body.map(sourceWidth);
    return widths.every((width) => width === widths[0]) ? widths[0] : undefined;
  }
  if (node.type === 'Quantifier') {
    const width = sourceWidth(node.body);
    return width === undefined || node.min !== node.max ? undefined : width * node.min;
  }
  if (node.type === 'Assertion' || node.type === 'LookaroundAssertion' || node.type === 'Directive') return 0;
  if (node.type === 'Backreference') throw new UnsupportedFeatureError('正規表現の後読み内の後方参照');
  return 1;
}

function normalizeRubyUnicodeEscapes(source: string): string {
  return source.replaceAll(/\\(?:\\|u\{([\dA-Fa-f\s]+)\})/g, (raw, points: string | undefined) =>
    points
      ? points
          .trim()
          .split(/\s+/)
          .map((point) => `\\x{${point}}`)
          .join('')
      : raw
  );
}

function captureAlwaysParticipates(capture: AST.CapturingGroup, reference: AST.Backreference): boolean {
  if (capture.end > reference.start) return false;
  for (let node: AST.Node | undefined = capture; node; node = parentOf(node)) {
    if (node.type === 'Quantifier' && node.min === 0 && !(node.start <= reference.start && reference.end <= node.end))
      return false;
    if (node.type === 'Assertion' && (node.kind === 'lookbehind' || ('negate' in node && node.negate))) return false;
    if (
      node.type === 'Alternative' &&
      node.parent.alternatives.length > 1 &&
      !(node.start <= reference.start && reference.end <= node.end)
    )
      return false;
  }
  return true;
}

function parentOf(node: AST.Node): AST.Node | undefined {
  return node.parent ?? undefined;
}

// code-gauge-allow functionCognitiveComplexity 25 -- Each parser diagnostic maps to a distinct Ruby error, with capture names included only where Ruby reports them.
export function regexpSyntaxReason(source: string, extended = false): string {
  const rubyReason = onigurumaSyntaxReason(source, extended);
  if (rubyReason) return rubyReason;
  try {
    new RegExpParser().parsePattern(source, 0, source.length, { unicode: true });
  } catch (error) {
    if (error instanceof SyntaxError) {
      for (const [reason, message] of [
        ['Unterminated group', 'end pattern with unmatched parenthesis'],
        ["Unmatched ')'", 'unmatched close parenthesis'],
        ['Unterminated character class', 'premature end of char-class'],
        ['Nothing to repeat', 'target of repeat operator is not specified'],
        ['numbers out of order in {} quantifier', 'upper is smaller than lower in repeat range'],
        ['Range out of order in character class', 'empty range in char class'],
      ])
        if (error.message.endsWith(reason)) return message;
      if (error.message.endsWith('Invalid capture group name')) {
        const name = /\(\?<([^=!][^>]*|)>/.exec(source)?.[1];
        return name ? `invalid group name <${name}>` : 'group name is empty';
      }
      if (error.message.endsWith('Invalid named capture referenced')) {
        const name = /\\k<([^>]+)>/.exec(source)?.[1];
        if (name) return `undefined name <${name}> reference`;
      }
    }
  }
  return 'invalid pattern';
}

// code-gauge-allow functionCognitiveComplexity 28 -- Source-parser errors distinguish escape, group, class-range, and reference diagnostics that the host parser conflates.
function onigurumaSyntaxReason(source: string, extended: boolean): string | undefined {
  try {
    parseOniguruma(normalizeRubyUnicodeEscapes(source), {
      flags: extended ? 'x' : '',
      skipPropertyNameValidation: true,
    });
  } catch (error) {
    if (!(error instanceof Error)) return undefined;
    const { message } = error;
    const escape = escapeSyntaxReason(message, source);
    if (escape) return escape;
    if (message.startsWith('Unclosed comment group')) return 'end pattern in group';
    if (message === 'Unclosed character class') return 'premature end of char-class';
    if (message.startsWith('Invalid or unsupported group option')) return invalidGroupReason(source);
    if (message === 'Unclosed character class (started with "]")') return 'empty char-class';
    if (message === 'Invalid character class range')
      return /(?<!\\)(?:\\\\)*-(?:\\[dDsSwWhHpP]|\[:)/.test(source)
        ? 'char-class value at end of range'
        : 'unmatched range specifier in char-class';
    if (message.startsWith('Not enough capturing groups defined')) return 'invalid backref number/name';
  }
  return undefined;
}

function escapeSyntaxReason(message: string, source: string): string | undefined {
  const incompleteEscape = message.startsWith('Incomplete or invalid escape');
  if (incompleteEscape && message.endsWith(String.raw`"\x"`)) return 'invalid hex escape';
  if (incompleteEscape && message.endsWith(String.raw`"\u"`))
    return source.includes(String.raw`\u{`)
      ? 'invalid Unicode list'
      : source.endsWith(String.raw`\u`)
        ? 'too short escape sequence'
        : 'invalid Unicode escape';
  if (message.startsWith('Incomplete or invalid Unicode property')) {
    const property = /\\[pP]\{(\^?)([^}]*)/.exec(source);
    const name = property?.[2] ?? '';
    return `invalid character property name {${source.endsWith('}') ? name : name.slice(0, -1)}}`;
  }
  if (message.startsWith('Invalid code point out of range')) return 'invalid Unicode range';
  if (message.startsWith('Unsupported control character')) return 'too short control escape';
  return undefined;
}

function invalidGroupReason(source: string): string {
  const unclosedName = /\(\?<([^=!>][^>]*)$/.exec(source)?.[1];
  if (unclosedName) return `invalid group name <${unclosedName}>`;
  if (source.endsWith('(?<')) return 'end pattern with unmatched parenthesis';
  return /\(\?[imx-]*$/.test(source) ? 'end pattern in group' : 'undefined group option';
}
