import { type AST, RegExpParser, RegExpSyntaxError, visitRegExpAST } from '@eslint-community/regexpp';
import {
  type AlternativeNode,
  type LookaroundAssertionNode,
  type Node as SourceNode,
  parse as parseOniguruma,
} from 'oniguruma-parser/parser';
import { type Token, tokenize } from 'oniguruma-parser/tokenizer';

import { ExecutionLimitError } from '../interpreter/limits';
import { regexpCommentEnd, regexpLineCommentEnd } from './regexpCaptureNames';
import { decodeRegexpByteEscape, regexpByteEscape, RegexpEncodingError } from './regexpEscapes';
import { regexpPropertyNames } from './regexpProperties';
import { UnsupportedFeatureError } from './runtime';

export function validateRegexpSourceSyntax(source: string, extended: boolean, binary = false): void {
  let root: SourceNode;
  try {
    root = parseSourceRegexp(source, extended, binary);
    validateSourceReferences(root);
  } catch (error) {
    if (error instanceof RegexpEncodingError || error instanceof UnsupportedFeatureError) throw error;
    if (
      error instanceof RangeError ||
      (error instanceof Error &&
        /unsupported/i.test(error.message) &&
        onigurumaSyntaxReason(source, extended) === undefined)
    )
      throw new UnsupportedFeatureError('正規表現の構文の検証');
    throw new SyntaxError('invalid regexp source');
  }
  if (hasZeroWidthRepeat(root)) throw new UnsupportedFeatureError('正規表現の量指定されたゼロ幅表明');
  visitSource(root, false, false);
}

export function hasRegexpProperty(source: string, extended: boolean): boolean {
  if (!/\\[pP]/.test(source)) return false;
  try {
    return propertyNode(parseSourceRegexp(source, extended));
  } catch {
    return false;
  }
}

function propertyNode(node: SourceNode): boolean {
  if (node.type === 'CharacterSet' && node.kind === 'property') return true;
  if (node.type === 'Quantifier') return propertyNode(node.body);
  return 'body' in node && node.body.some(propertyNode);
}

function parseSourceRegexp(source: string, extended: boolean, binary = false): SourceNode {
  const normalized = normalizeRubyRegexpEscapes(source, extended, binary);
  const tokens = tokenize(normalized, { flags: extended ? 'x' : '' }).tokens;
  validateSourceTokens(tokens);
  const root = parseOniguruma(quantifiableAssertionSource(tokens), {
    flags: extended ? 'x' : '',
    skipLookbehindValidation: true,
    skipBackrefValidation: true,
    skipPropertyNameValidation: true,
  });
  return root;
}

function validateSourceTokens(tokens: Token[]): void {
  for (const token of tokens) {
    if (token.type === 'Quantifier') {
      const bounds = /^\{(\d+),(\d+)\}/.exec(token.raw);
      if (bounds && Number(bounds[1]) > Number(bounds[2])) throw new SyntaxError('invalid reversed quantifier range');
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 19 -- Source assertions are wrapped for AST parsing while group balance remains checked before recursive parsing.
function quantifiableAssertionSource(tokens: Token[]): string {
  const parts: string[] = [];
  const assertions: boolean[] = [];
  for (const token of tokens) {
    if (token.type === 'Assertion' || (token.type === 'Directive' && token.kind === 'keep'))
      parts.push(`(?:${token.raw})`);
    else if (token.type === 'GroupOpen') {
      const assertion = token.kind === 'lookahead' || token.kind === 'lookbehind';
      assertions.push(assertion);
      parts.push(`${assertion ? '(?:' : ''}${token.raw}`);
    } else if (token.type === 'GroupClose') {
      if (assertions.length === 0) throw new SyntaxError('unmatched close parenthesis');
      parts.push(assertions.pop() ? '))' : ')');
    } else parts.push(token.raw);
  }
  if (assertions.length > 0) throw new SyntaxError('end pattern with unmatched parenthesis');
  return parts.join('');
}

function hasZeroWidthRepeat(node: SourceNode): boolean {
  if (node.type === 'Quantifier') return zeroWidthSource(node.body) || hasZeroWidthRepeat(node.body);
  return 'body' in node && node.body.some(hasZeroWidthRepeat);
}

function zeroWidthSource(node: SourceNode): boolean {
  if (node.type === 'Assertion' || node.type === 'LookaroundAssertion' || node.type === 'Directive') return true;
  if (node.type === 'Quantifier') return node.max === 0 || zeroWidthSource(node.body);
  if (node.type === 'Group' || node.type === 'CapturingGroup' || node.type === 'Alternative')
    return node.body.every(zeroWidthSource);
  return false;
}

export function supportsRegexpByteView(source: string, extended: boolean): boolean {
  try {
    return byteViewNode(parseSourceRegexp(source, extended), false);
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
    root = parseSourceRegexp(source, extended);
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
  return sole.type === 'Group' && !sole.flags && !sole.atomic && validSourceLookbehind(sole);
}

// code-gauge-allow functionCognitiveComplexity 19 -- Width computation distinguishes sequences, equal-width alternatives, exact quantifiers and zero-width assertions.
function sourceWidth(node: SourceNode): number | undefined {
  if (node.type === 'CharacterSet' && node.variableLength) return undefined;
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

function validateSourceReferences(root: SourceNode): void {
  const captures = new Set<number>();
  const references: number[] = [];
  const visit = (node: SourceNode): void => {
    if (node.type === 'CapturingGroup') captures.add(node.number);
    if (node.type === 'Backreference' && typeof node.ref === 'number') references.push(node.ref);
    if (node.type === 'Quantifier') visit(node.body);
    else if ('body' in node) for (const child of node.body) visit(child);
  };
  visit(root);
  if (references.some((reference) => !captures.has(reference))) throw new SyntaxError('invalid backref number');
}

function normalizeRubyRegexpEscapes(source: string, extended: boolean, binary = false): string {
  let result = '';
  let inClass = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (!inClass && (source.startsWith('(?#', index) || (extended && char === '#'))) {
      const end = char === '#' ? regexpLineCommentEnd(source, index) : regexpCommentEnd(source, index + 3);
      if (end < 0) return result + source.slice(index);
      result += source.slice(index, end + 1);
      index = end;
    } else if (char === '\\') {
      const escape = normalizedRegexpEscape(source, index, inClass, binary);
      result += escape.text;
      index += escape.length - 1;
    } else {
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      result += char;
    }
  }
  return result;
}

function normalizedRegexpEscape(
  source: string,
  start: number,
  inClass: boolean,
  binary: boolean
): { text: string; length: number } {
  const next = source[start + 1];
  if (next === 'p' || next === 'P') {
    const property = /^\\[pP]\{(\^?)([^}]*)\}/.exec(source.slice(start));
    if (property) {
      const name = property[2].replaceAll(/[-_ ]/g, '').toLowerCase();
      if (!regexpPropertyNames.has(name))
        throw new RegexpEncodingError(`invalid character property name {${property[2]}}`);
      return { text: `\\${next}{${property[1]}Any}`, length: property[0].length };
    }
  }
  const byte =
    next === 'x' ||
    next === '0' ||
    (inClass && /^[1-7]$/.test(next ?? '')) ||
    (/^[1-7]$/.test(next ?? '') && /^[0-7]/.test(source[start + 2] ?? ''))
      ? regexpByteEscape(source, start)
      : undefined;
  if (byte) {
    const decoded = binary ? byte : decodeRegexpByteEscape(source, start, byte);
    return { text: `\\x{${decoded.value.toString(16)}}`, length: decoded.length };
  }
  const unicode = /^\\u\{([\dA-Fa-f\s]+)\}/.exec(source.slice(start));
  if (unicode)
    return {
      text: unicode[1]
        .trim()
        .split(/\s+/)
        .map((point) => `\\x{${point}}`)
        .join(''),
      length: unicode[0].length,
    };
  return { text: source.slice(start, start + 2), length: Math.min(2, source.length - start) };
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
    parseOniguruma(normalizeRubyRegexpEscapes(source, extended), {
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
