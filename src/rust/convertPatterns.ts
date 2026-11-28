import type { Node } from '@willbooster/web-tree-sitter';

import type { PathSegment, Pattern, Span } from './ast';
import { isComment, SyntaxConverter, syntaxError, unavailable } from './convertSyntax';

/** Converts patterns. */
export abstract class PatternConverter extends SyntaxConverter {
  protected abstract userMacroPattern(node: Node): Pattern;

  /** `(a, b)` is a tuple of patterns, and `(x)` one grouped pattern: only a comma makes a tuple of one. */
  private tupleOrGroup(node: Node, span: Span): Pattern {
    const elems = this.subpatterns(node).map((child) => this.pattern(child));
    const grouped = elems.length === 1 && !node.children.some((child) => child.type === ',');
    return grouped ? elems[0] : { kind: 'tuple', elems, span };
  }

  /** `mut name` or `mut name @ pattern` in a pattern, which binds a variable that can be assigned to. */
  private mutableBinding(node: Node, span: Span): Pattern {
    const inner = node.namedChildren.find((child) => child.type !== 'mutable_specifier' && !isComment(child));
    const pattern = inner && this.pattern(inner);
    if (pattern?.kind !== 'binding' || pattern.byRef) syntaxError(span, 'mut は名前の前に書いてください。');
    return { ...pattern, mutable: true, span };
  }

  /** `ref name` and `ref mut name`, which bind a reference to what they match. */
  private refBinding(node: Node, span: Span): Pattern {
    const inner = node.namedChildren.find((child) => !isComment(child));
    const pattern = inner && this.pattern(inner);
    if (pattern?.kind !== 'binding' || pattern.byRef) syntaxError(span, 'ref は名前の前に書いてください。');
    return { ...pattern, mutable: false, byRef: pattern.mutable ? 'refMut' : 'ref', span };
  }

  /** `name @ pattern`, which binds the whole value while the pattern matches it. */
  private capturedPattern(node: Node, span: Span): Pattern {
    const nameNode = node.namedChildren.find((child) => !isComment(child)) as Node;
    // The pattern after `@` may be an unnamed token (`x @ _`).
    const at = node.children.findIndex((child) => child.type === '@');
    const subNode = node.children.slice(at + 1).find((child) => !isComment(child));
    if (!subNode) syntaxError(span, '@ の後にはパターンを書いてください。');
    const name = this.pattern(nameNode);
    if (name.kind !== 'binding' || name.sub) syntaxError(span, '@ の前には名前を書いてください。');
    return { ...name, sub: this.pattern(subNode), span };
  }

  private rangePattern(node: Node, span: Span): Pattern {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    const operator = node.children.find((child) => child.type === '..' || child.type === '..=' || child.type === '...');
    if (operator?.type === '...') syntaxError(span, '範囲のパターンには ... ではなく ..= と書いてください。');
    const inclusive = operator?.type === '..=';
    if (!right && inclusive) syntaxError(span, '..= の後には終わりの値が要ります。');
    const end = (bound: Node): Pattern => {
      const pattern = this.pattern(bound);
      if (pattern.kind !== 'lit' && pattern.kind !== 'path' && pattern.kind !== 'binding') {
        syntaxError(this.span(bound), '範囲のパターンの端には、リテラルか定数を書いてください。');
      }
      return pattern.kind === 'binding' ? { kind: 'path', path: this.exprPath(bound), span: pattern.span } : pattern;
    };
    return { kind: 'range', start: left ? end(left) : undefined, end: right ? end(right) : undefined, inclusive, span };
  }

  private slicePattern(node: Node, span: Span): Pattern {
    for (const child of this.subpatterns(node)) {
      const range = child.type === 'captured_pattern' ? child.namedChildren.at(-1) : child;
      if (range?.type === 'range_pattern' && !range.childForFieldName('right') && range.childForFieldName('left')) {
        syntaxError(this.span(range), 'スライスのパターンの中の X.. は、不安定な機能なので使えません（E0658）。');
      }
    }
    return { kind: 'slice', elems: this.subpatterns(node).map((child) => this.pattern(child)), span };
  }

  // code-gauge-allow functionNcss -- One case per kind of syntax node.
  pattern(node: Node): Pattern {
    const span = this.span(node);
    switch (node.type) {
      case 'identifier': {
        if (node.text === '_') return { kind: 'wild', span };
        return { kind: 'binding', name: this.identifier(node), mutable: false, sub: undefined, span };
      }
      case 'mut_pattern': {
        return this.mutableBinding(node, span);
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
        return this.tupleOrGroup(node, span);
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
      case 'ref_pattern': {
        return this.refBinding(node, span);
      }
      case 'captured_pattern': {
        return this.capturedPattern(node, span);
      }
      case 'remaining_field_pattern': {
        return { kind: 'rest', span };
      }
      case 'range_pattern': {
        return this.rangePattern(node, span);
      }
      case 'slice_pattern': {
        return this.slicePattern(node, span);
      }
      case 'generic_pattern': {
        const typeArguments = this.field(node, 'type_arguments');
        const base = this.exprPath(node.namedChildren.find((child) => child.id !== typeArguments.id) as Node);
        const last = base.segments.at(-1) as PathSegment;
        const segments = [...base.segments.slice(0, -1), { ...last, args: this.typeArgs(typeArguments) }];
        return { kind: 'path', path: { segments, span }, span };
      }
      case 'macro_invocation': {
        return this.userMacroPattern(node);
      }
      case 'box_pattern': {
        return syntaxError(span, 'box パターンは、不安定な機能なので使えません（E0658）。');
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
    let rest = false;
    for (const child of node.namedChildren) {
      if (child.id === type.id || isComment(child)) continue;
      if (child.type === 'remaining_field_pattern') rest = true;
      else if (child.type === 'field_pattern') {
        if (rest) syntaxError(this.span(child), '.. は、フィールドのパターンの最後に書いてください。');
        fields.push(this.fieldPattern(child));
      }
    }
    return { kind: 'struct', path: this.typePath(type), fields, rest, span };
  }

  private fieldPattern(node: Node): { name: string; pattern: Pattern; span: Span } {
    const name = this.identifier(this.field(node, 'name'));
    const sub = node.childForFieldName('pattern');
    const span = this.span(node);
    if (sub) return { name, pattern: this.pattern(sub), span };
    // `P { mut x }` binds the field to a mutable variable of its name, and `P { ref x }` to a reference to it.
    const mutable = node.namedChildren.some((child) => child.type === 'mutable_specifier');
    const byRef = /^\s*ref\b/.test(node.text) ? (mutable ? 'refMut' : 'ref') : undefined;
    return { name, pattern: { kind: 'binding', name, mutable: mutable && !byRef, byRef, sub: undefined, span }, span };
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
    if (node.type === 'self') syntaxError(span, 'self はパターンに書けません。');
    if (node.isError || node.isMissing) syntaxError(span, '書き方に誤りがあります。');
    return unavailable(span, `パターンの書き方（${node.type}）`);
  }

  /** `_` is an anonymous token, so the element patterns are the named children and the `_` tokens. */
  private subpatterns(node: Node): Node[] {
    return node.children.filter((child) => (child.isNamed || child.type === '_') && !isComment(child));
  }
}
