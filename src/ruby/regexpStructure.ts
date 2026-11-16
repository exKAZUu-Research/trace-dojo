import { type AST, RegExpParser, RegExpSyntaxError, visitRegExpAST } from '@eslint-community/regexpp';

import { ExecutionLimitError } from '../interpreter/limits';
import { UnsupportedFeatureError } from './runtime';

// code-gauge-allow functionCognitiveComplexity 17 -- Host syntax validation and AST validation distinguish invalid patterns, unsupported forms, and exhausted budgets.
export function validateRegexpStructure(source: string): void {
  if (!source.includes('(?<') && !/\\(?:[1-9]|k<)/.test(source)) return;
  try {
    new RegExp(source, 'u');
  } catch (error) {
    if (error instanceof SyntaxError) return;
    if (error instanceof RangeError) throw new ExecutionLimitError('operations');
    throw error;
  }
  try {
    const pattern = new RegExpParser().parsePattern(source, 0, source.length, { unicode: true });
    visitRegExpAST(pattern, {
      onAssertionEnter(assertion) {
        if (assertion.kind === 'lookbehind') validateLookbehind(assertion);
      },
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

function validateLookbehind(assertion: AST.LookbehindAssertion): void {
  if (!assertion.alternatives.every(validLookbehindAlternative))
    throw new SyntaxError('invalid pattern in look-behind');
  visitRegExpAST(assertion, {
    onCapturingGroupEnter() {
      if (assertion.negate) throw new SyntaxError('invalid pattern in look-behind');
    },
    onAssertionEnter(inner) {
      if (inner.kind === 'lookahead') throw new SyntaxError('invalid pattern in look-behind');
    },
  });
}

function validLookbehindAlternative(alternative: AST.Alternative): boolean {
  if (fixedWidth(alternative) !== undefined) return true;
  if (alternative.elements.length !== 1) return false;
  let element = alternative.elements[0]!;
  while (element.type === 'Quantifier' && element.min === 1 && element.max === 1) element = element.element;
  return element.type === 'Group' && element.alternatives.every(validLookbehindAlternative);
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

function fixedWidth(node: AST.Element | AST.Alternative): number | undefined {
  switch (node.type) {
    case 'Alternative': {
      let width = 0;
      for (const element of node.elements) {
        const part = fixedWidth(element);
        if (part === undefined) return undefined;
        width += part;
      }
      return width;
    }
    case 'Group':
    case 'CapturingGroup': {
      const widths = node.alternatives.map(fixedWidth);
      return widths.every((width) => width === widths[0]) ? widths[0] : undefined;
    }
    case 'Quantifier': {
      const width = fixedWidth(node.element);
      return width === undefined || node.min !== node.max ? undefined : width * node.min;
    }
    case 'Assertion': {
      return 0;
    }
    case 'Backreference': {
      throw new UnsupportedFeatureError('正規表現の後読み内の後方参照');
    }
    default: {
      return 1;
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 24 -- Each parser diagnostic maps to a distinct Ruby error, with capture names included only where Ruby reports them.
export function regexpSyntaxReason(source: string): string {
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
        ['Invalid escape', 'invalid backref number/name'],
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
