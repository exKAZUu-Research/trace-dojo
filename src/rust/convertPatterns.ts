import type { Node } from '@willbooster/web-tree-sitter';

import type { Pattern, Span } from './ast';
import { checkNotReserved, isComment, SyntaxConverter, syntaxError, unavailable } from './convertSyntax';

const UNSUPPORTED_PATTERNS: Record<string, string> = {
  remaining_field_pattern: '残りの要素を省く ..',
  range_pattern: '範囲のパターン（1..=5）',
  captured_pattern: '@ で名前を付けるパターン',
  ref_pattern: 'ref パターン',
  mut_pattern: 'パターンの中の mut',
  slice_pattern: 'スライスのパターン（[a, b]）',
  box_pattern: 'box パターン',
  generic_pattern: '型引数を書いたパターン',
};

/** Converts patterns. */
export abstract class PatternConverter extends SyntaxConverter {
  // code-gauge-allow functionNcss 38 -- One case per kind of syntax node.
  pattern(node: Node): Pattern {
    const span = this.span(node);
    switch (node.type) {
      case 'identifier': {
        if (node.text === '_') return { kind: 'wild', span };
        checkNotReserved(node.text, span);
        return { kind: 'binding', name: node.text, mutable: false, sub: undefined, span };
      }
      case 'scoped_identifier': {
        return { kind: 'path', path: this.exprPath(node), span };
      }
      case 'integer_literal':
      case 'float_literal':
      case 'boolean_literal':
      case 'char_literal':
      case 'string_literal':
      case 'raw_string_literal': {
        return { kind: 'lit', expr: this.expr(node), span };
      }
      case 'negative_literal': {
        return this.negativeLiteralPattern(node, span);
      }
      case 'tuple_pattern': {
        return { kind: 'tuple', elems: this.subpatterns(node).map((child) => this.pattern(child)), span };
      }
      case 'tuple_struct_pattern': {
        const type = this.field(node, 'type');
        const elems = this.subpatterns(node).filter((child) => child.id !== type.id);
        return { kind: 'tupleStruct', path: this.exprPath(type), elems: elems.map((c) => this.pattern(c)), span };
      }
      case 'struct_pattern': {
        return this.structPattern(node, span);
      }
      case 'reference_pattern': {
        return this.referencePattern(node, span);
      }
      case 'or_pattern': {
        return this.orPattern(node, span);
      }
      case 'match_pattern': {
        const inner = node.namedChildren.find((child) => !isComment(child));
        return inner ? this.pattern(inner) : { kind: 'wild', span };
      }
      case '_': {
        return { kind: 'wild', span };
      }
      default: {
        return this.unsupportedPattern(node, span);
      }
    }
  }

  private negativeLiteralPattern(node: Node, span: Span): Pattern {
    const literal = this.expr(this.onlyChild(node));
    if (literal.kind !== 'int' && literal.kind !== 'float') syntaxError(span, 'パターンの書き方に誤りがあります。');
    const negated =
      literal.kind === 'float'
        ? { ...literal, value: -literal.value, f32: -literal.f32 }
        : { ...literal, value: -literal.value };
    return { kind: 'lit', expr: negated, span };
  }

  private structPattern(node: Node, span: Span): Pattern {
    const type = this.field(node, 'type');
    const fields: { name: string; pattern: Pattern; span: Span }[] = [];
    for (const child of node.namedChildren) {
      if (child.id === type.id || isComment(child)) continue;
      if (child.type === 'remaining_field_pattern') unavailable(this.span(child), '残りのフィールドを省く ..');
      if (child.type === 'field_pattern') fields.push(this.fieldPattern(child));
    }
    return { kind: 'struct', path: this.typePath(type), fields, span };
  }

  private fieldPattern(node: Node): { name: string; pattern: Pattern; span: Span } {
    const name = this.field(node, 'name');
    const sub = node.childForFieldName('pattern');
    const span = this.span(node);
    if (node.namedChildren.some((c) => c.type === 'mutable_specifier') || /^\s*ref\b/.test(node.text)) {
      unavailable(span, 'フィールドのパターンの mut・ref');
    }
    return {
      name: name.text,
      pattern: sub ? this.pattern(sub) : { kind: 'binding', name: name.text, mutable: false, sub: undefined, span },
      span,
    };
  }

  private referencePattern(node: Node, span: Span): Pattern {
    const mutable = node.namedChildren.some((child) => child.type === 'mutable_specifier');
    const inner = node.namedChildren.find((child) => child.type !== 'mutable_specifier' && !isComment(child));
    if (!inner) syntaxError(span, 'パターンの書き方に誤りがあります。');
    const pattern: Pattern = { kind: 'ref', mutable, pattern: this.pattern(inner), span };
    // `&&x` is one token, which stands for two reference patterns.
    if (node.children[0]?.type === '&&') return { kind: 'ref', mutable: false, pattern, span };
    return pattern;
  }

  private orPattern(node: Node, span: Span): Pattern {
    const alternatives: Pattern[] = [];
    for (const child of node.namedChildren) {
      if (isComment(child)) continue;
      const pattern = this.pattern(child);
      if (pattern.kind === 'or') alternatives.push(...pattern.alternatives);
      else alternatives.push(pattern);
    }
    return { kind: 'or', alternatives, span };
  }

  private unsupportedPattern(node: Node, span: Span): never {
    if (Object.hasOwn(UNSUPPORTED_PATTERNS, node.type)) unavailable(span, UNSUPPORTED_PATTERNS[node.type]);
    if (node.type === 'self') syntaxError(span, 'self はパターンに書けません。');
    if (node.isError || node.isMissing) syntaxError(span, '書き方に誤りがあります。');
    return unavailable(span, `パターンの書き方（${node.type}）`);
  }

  /** `_` is an anonymous token, so the element patterns are the named children and the `_` tokens. */
  private subpatterns(node: Node): Node[] {
    return node.children.filter((child) => (child.isNamed || child.type === '_') && !isComment(child));
  }
}
