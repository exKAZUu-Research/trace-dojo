import type { Node } from '@willbooster/web-tree-sitter';

import type { BinaryOp, Block, Condition, Expr, Item, MatchArm, Pattern, Span, Stmt, TypeAst } from './ast';
import { forEachDirect } from './astWalk';
import { MacroConverter } from './convertMacros';
import { isComment, syntaxError, unavailable, withoutDocAttributes } from './convertSyntax';
import {
  parseByteLiteral,
  parseByteStringLiteral,
  parseCharLiteral,
  parseFloatLiteral,
  parseIntegerLiteral,
  parseRawStringLiteral,
  parseStringLiteral,
} from './literals';

const UNSUPPORTED_EXPRESSIONS: Record<string, string> = {
  await_expression: '.await',
  async_block: 'async ブロック',
  unsafe_block: 'unsafe ブロック',
  const_block: 'const ブロック',
  gen_block: 'gen ブロック',
  try_block: 'try ブロック',
  yield_expression: 'yield',
  become_expression: 'become',
  attribute_item: '式に付けた属性',
  attributed_expression: '式に付けた属性',
};

/** Converts statements and expressions. */
export abstract class ExpressionConverter extends MacroConverter {
  // code-gauge-allow functionCognitiveComplexity -- One case per kind of syntax node.
  // code-gauge-allow functionNcss -- One case per kind of syntax node.
  block(node: Node): Block {
    const span = this.span(node);
    const stmts: Stmt[] = [];
    const items: Item[] = [];
    let tail: Expr | undefined;
    const children = node.namedChildren.filter((child) => !isComment(child)).map(withoutDocAttributes);
    for (const [index, child] of children.entries()) {
      const isLast = index === children.length - 1;
      if (child.type === 'label') continue;
      if (child.type === 'let_declaration') {
        stmts.push(this.letStmt(child));
      } else if (child.type === 'expression_statement') {
        const inner = child.namedChildren.find((c) => !isComment(c)) as Node;
        const semi = child.text.trimEnd().endsWith(';') && !inner.text.endsWith(';');
        const expression = withoutDocAttributes(inner);
        const expr = this.expr(expression);
        const terminated = semi || child.lastChild?.type === ';';
        if (isLast && !terminated && (expr.kind === 'macro' || isBlockLike(expr))) tail = expr;
        else stmts.push({ kind: 'expr', expr, semi: terminated, span: this.span(expression) });
      } else if (child.type === 'empty_statement') {
        this.emptyStatement(stmts, child, children[index - 1]);
      } else if (isItem(child)) {
        const item = this.item(child);
        if (item) items.push(item);
      } else if (isLast) {
        tail = this.expr(child);
      } else {
        stmts.push({ kind: 'expr', expr: this.expr(child), semi: false, span: this.span(child) });
      }
    }
    return { kind: 'block', stmts, tail, span, endRow: node.endPosition.row, items };
  }

  /**
   * A lone `;`. The grammar leaves the `;` after a block-like expression (`match x { .. };`) as a statement of its own,
   * where rustc makes it end that expression's statement.
   */
  private emptyStatement(stmts: Stmt[], node: Node, previousNode: Node | undefined): void {
    const previous = stmts.at(-1);
    if (previous?.kind === 'expr' && !previous.semi && previousNode?.type === 'expression_statement')
      previous.semi = true;
    else stmts.push({ kind: 'empty', span: this.span(node) });
  }

  private letStmt(node: Node): Stmt {
    const span = this.span(node);
    let pattern = this.pattern(this.field(node, 'pattern'));
    if (node.namedChildren.some((child) => child.type === 'mutable_specifier')) {
      if (pattern.kind !== 'binding') syntaxError(span, 'mut は名前の前に書いてください。');
      pattern = { ...pattern, mutable: true };
    }
    const type = node.childForFieldName('type');
    const value = node.childForFieldName('value');
    const alternative = node.childForFieldName('alternative');
    return {
      kind: 'let',
      pattern,
      type: type ? this.type(type) : undefined,
      init: value ? this.expr(value) : undefined,
      else: alternative ? this.block(alternative) : undefined,
      span,
    };
  }

  // code-gauge-allow functionNcss -- One case per kind of syntax node.
  expr(node: Node): Expr {
    const span = this.span(node);
    switch (node.type) {
      case 'integer_literal': {
        return this.integerLiteral(node, span);
      }
      case 'float_literal': {
        const literal = parseFloatLiteral(node.text);
        if (!literal) syntaxError(span, `小数の書き方（${node.text}）に誤りがあります。`);
        return { kind: 'float', value: literal.value, f32: literal.f32, suffix: literal.suffix, span };
      }
      case 'boolean_literal': {
        return { kind: 'bool', value: node.text === 'true', span };
      }
      case 'char_literal': {
        return this.charLiteral(node, span);
      }
      case 'string_literal': {
        return this.stringLiteral(node, span);
      }
      case 'raw_string_literal': {
        return this.rawStringLiteral(node, span);
      }
      case 'identifier':
      case 'self':
      case 'scoped_identifier':
      case 'generic_function':
      case 'crate':
      case 'super': {
        return this.pathExpr(node, span);
      }
      case 'generic_type':
      case 'type_identifier':
      case 'primitive_type': {
        return { kind: 'path', path: this.exprPath(node), span };
      }
      case 'parenthesized_expression': {
        return { ...this.expr(this.onlyChild(node)), span };
      }
      case 'call_expression': {
        return this.call(node);
      }
      case 'struct_expression': {
        return this.structExpr(node);
      }
      case 'block': {
        const label = this.label(node);
        return label === undefined ? this.block(node) : this.labeledBlock(node, label, span);
      }
      case 'if_expression':
      case 'else_clause': {
        return this.ifExpr(node);
      }
      case 'match_expression': {
        return this.matchExpr(node);
      }
      case 'closure_expression': {
        return this.closure(node);
      }
      case 'macro_invocation': {
        return { kind: 'macro', macro: this.macro(node), span };
      }
      default: {
        return this.operatorExpr(node, span);
      }
    }
  }

  /**
   * `'a: { ... }`, which runs as `'a: loop { break 'a { ... } }`: only a `break 'a` leaves it early, and rustc rejects
   * the unlabeled `break` and `continue` that the loop would catch.
   */
  private labeledBlock(node: Node, label: string, span: Span): Expr {
    const block = this.block(node);
    const check = (expr: Expr): void => {
      if (expr.kind === 'closure' || expr.kind === 'loop' || expr.kind === 'while' || expr.kind === 'for') {
        if (expr.kind === 'for') check(expr.iterable);
        if (expr.kind === 'while' && expr.cond.kind === 'expr') check(expr.cond.expr);
        return;
      }
      if ((expr.kind === 'break' || expr.kind === 'continue') && expr.label === undefined) {
        syntaxError(expr.span, `ラベル付きのブロックの中の ${expr.kind} には、ラベルを書いてください（E0695）。`);
      }
      if (expr.kind === 'continue' && expr.label === label) {
        syntaxError(expr.span, `continue '${label} は、ブロックのラベルには使えません（E0696）。`);
      }
      forEachDirect(expr, check);
    };
    check(block);
    const exit: Expr = { kind: 'break', label, value: block, span };
    const body: Block = {
      kind: 'block',
      stmts: [{ kind: 'expr', expr: exit, semi: true, span }],
      tail: undefined,
      span,
      endRow: block.endRow,
      items: [],
    };
    return { kind: 'loop', label, body, span };
  }

  private integerLiteral(node: Node, span: Span): Expr {
    const literal = parseIntegerLiteral(node.text);
    if (!literal) syntaxError(span, `整数の書き方（${node.text}）に誤りがあります。`);
    if (literal.kind === 'float') {
      return { kind: 'float', value: literal.value, f32: literal.f32, suffix: literal.suffix, span };
    }
    return { kind: 'int', value: literal.value, suffix: literal.suffix, span };
  }

  private charLiteral(node: Node, span: Span): Expr {
    if (node.text.startsWith('b')) {
      const value = parseByteLiteral(node.text);
      if (value === undefined) syntaxError(span, `バイトのリテラル（${node.text}）に誤りがあります。`);
      return { kind: 'int', value, suffix: 'u8', span };
    }
    const value = parseCharLiteral(node.text);
    if (value === undefined) syntaxError(span, `文字の書き方（${node.text}）に誤りがあります。`);
    return { kind: 'char', value, span };
  }

  private stringLiteral(node: Node, span: Span): Expr {
    if (node.text.startsWith('b')) {
      const bytes = parseByteStringLiteral(node.text);
      if (bytes === undefined) syntaxError(span, `バイト文字列の書き方（${node.text}）に誤りがあります。`);
      return byteStringExpr(bytes, span);
    }
    if (node.text.startsWith('c')) unavailable(span, 'C の文字列（c"..."）');
    const value = parseStringLiteral(node.text);
    if (value === undefined) syntaxError(span, `文字列の書き方（${node.text}）に誤りがあります。`);
    return { kind: 'str', value, span };
  }

  private rawStringLiteral(node: Node, span: Span): Expr {
    const literal = parseRawStringLiteral(node.text);
    if (!literal) syntaxError(span, `生の文字列の書き方（${node.text}）に誤りがあります。`);
    if (literal.prefix === 'c') unavailable(span, 'C の文字列（cr"..."）');
    if (literal.prefix === 'b')
      return byteStringExpr(
        Array.from(literal.body, (char) => char.codePointAt(0) ?? 0),
        span
      );
    return { kind: 'str', value: literal.body, span };
  }

  private pathExpr(node: Node, span: Span): Expr {
    if (node.type === 'generic_function' && this.field(node, 'function').type === 'field_expression') {
      // A method with turbofish arguments; the call converts it.
      syntaxError(span, 'メソッドは、呼び出す形（x.f::<T>()）で書いてください。');
    }
    if (node.type === 'crate' || node.type === 'super') syntaxError(span, `${node.text} だけでは値になりません。`);
    return { kind: 'path', path: this.exprPath(node), span };
  }

  private operatorExpr(node: Node, span: Span): Expr {
    switch (node.type) {
      case 'unary_expression': {
        const op = node.child(0)?.text as '-' | '!' | '*';
        return { kind: 'unary', op, operand: this.expr(this.onlyChild(node)), span };
      }
      case 'binary_expression': {
        const operator = this.field(node, 'operator');
        return {
          kind: 'binary',
          op: operator.text as BinaryOp,
          left: this.expr(this.field(node, 'left')),
          right: this.expr(this.field(node, 'right')),
          opSpan: this.span(operator),
          span,
        };
      }
      case 'assignment_expression': {
        return {
          kind: 'assign',
          target: this.assignee(this.field(node, 'left')),
          value: this.expr(this.field(node, 'right')),
          span,
        };
      }
      case 'compound_assignment_expr': {
        const operator = this.field(node, 'operator').text;
        return {
          kind: 'compoundAssign',
          op: operator.slice(0, -1) as never,
          target: this.expr(this.field(node, 'left')),
          value: this.expr(this.field(node, 'right')),
          span,
        };
      }
      case 'reference_expression': {
        return this.referenceExpr(node, span);
      }
      case 'type_cast_expression': {
        return {
          kind: 'cast',
          operand: this.expr(this.field(node, 'value')),
          type: this.type(this.field(node, 'type')),
          span,
        };
      }
      case 'try_expression': {
        return { kind: 'try', operand: this.expr(this.onlyChild(node)), span };
      }
      default: {
        return this.accessExpr(node, span);
      }
    }
  }

  private referenceExpr(node: Node, span: Span): Expr {
    if (/^&\s*raw\b/.test(node.text)) unavailable(span, '&raw');
    const mutable = node.namedChildren.some((child) => child.type === 'mutable_specifier');
    const ref: Expr = { kind: 'ref', mutable, operand: this.expr(this.field(node, 'value')), span };
    // `&&x` is one token, which stands for two borrows.
    if (node.children[0]?.type === '&&') return { kind: 'ref', mutable: false, operand: ref, span };
    return ref;
  }

  private accessExpr(node: Node, span: Span): Expr {
    switch (node.type) {
      case 'field_expression': {
        return this.fieldExpr(node, span);
      }
      case 'index_expression': {
        const [operand, index] = node.namedChildren.filter((child) => !isComment(child));
        const bracket = node.children.find((child) => child.type === '[');
        return {
          kind: 'index',
          operand: this.expr(operand),
          index: this.expr(index),
          bracketSpan: bracket ? this.span(bracket) : span,
          span,
        };
      }
      case 'range_expression': {
        return this.rangeExpr(node, span);
      }
      case 'tuple_expression': {
        const elems = node.namedChildren.filter((child) => !isComment(child));
        return { kind: 'tuple', elems: elems.map((child) => this.expr(child)), span };
      }
      case 'unit_expression': {
        return { kind: 'tuple', elems: [], span };
      }
      case 'array_expression': {
        const length = node.childForFieldName('length');
        const elems = node.namedChildren.filter((child) => !isComment(child) && child.id !== length?.id);
        if (length) return { kind: 'arrayRepeat', value: this.expr(elems[0]), count: this.expr(length), span };
        return { kind: 'array', elems: elems.map((child) => this.expr(child)), span };
      }
      default: {
        return this.loopExpr(node, span);
      }
    }
  }

  private fieldExpr(node: Node, span: Span): Expr {
    const fieldNode = this.field(node, 'field');
    if (fieldNode.type === 'integer_literal' && !/^\d+$/.test(fieldNode.text)) {
      syntaxError(span, `タプルの要素の番号（${fieldNode.text}）に誤りがあります。`);
    }
    return {
      kind: 'field',
      operand: this.expr(this.field(node, 'value')),
      name: this.identifier(fieldNode),
      nameSpan: this.span(fieldNode),
      span,
    };
  }

  private rangeExpr(node: Node, span: Span): Expr {
    const children = node.namedChildren.filter((child) => !isComment(child));
    const operator = node.children.find((child) => child.type === '..' || child.type === '..=' || child.type === '...');
    if (!operator) syntaxError(span, '範囲には .. または ..= を書いてください。');
    if (operator.type === '...') syntaxError(span, '... ではなく ..= と書いてください。');
    let start: Expr | undefined;
    let end: Expr | undefined;
    for (const child of children) {
      if (child.startIndex < operator.startIndex) start = this.expr(child);
      else end = this.expr(child);
    }
    const inclusive = operator.type === '..=';
    if (inclusive && !end) syntaxError(span, '..= の後には終わりの値が要ります。');
    return { kind: 'range', start, end, inclusive, span };
  }

  private loopExpr(node: Node, span: Span): Expr {
    switch (node.type) {
      case 'loop_expression': {
        return { kind: 'loop', label: this.label(node), body: this.block(this.field(node, 'body')), span };
      }
      case 'while_expression': {
        return {
          kind: 'while',
          label: this.label(node),
          cond: this.condition(this.field(node, 'condition')),
          body: this.block(this.field(node, 'body')),
          span,
        };
      }
      case 'for_expression': {
        return {
          kind: 'for',
          label: this.label(node),
          pattern: this.pattern(this.field(node, 'pattern')),
          iterable: this.expr(this.field(node, 'value')),
          body: this.block(this.field(node, 'body')),
          span,
        };
      }
      case 'break_expression': {
        const value = node.namedChildren.find((child) => child.type !== 'label' && !isComment(child));
        return { kind: 'break', label: this.label(node), value: value ? this.expr(value) : undefined, span };
      }
      case 'continue_expression': {
        return { kind: 'continue', label: this.label(node), span };
      }
      case 'return_expression': {
        const value = node.namedChildren.find((child) => !isComment(child));
        return { kind: 'return', value: value ? this.expr(value) : undefined, span };
      }
      default: {
        return unsupportedExpr(node, span);
      }
    }
  }

  /** The left side of an assignment, where `_` discards the value and tuples assign each element. */
  private assignee(node: Node): Expr {
    if (node.type === 'identifier' && node.text === '_') {
      return {
        kind: 'path',
        path: { segments: [{ name: '_', args: undefined, span: this.span(node) }], span: this.span(node) },
        span: this.span(node),
      };
    }
    if (node.type === 'tuple_expression' || node.type === 'struct_expression' || node.type === 'call_expression') {
      unavailable(this.span(node), '分割代入（(a, b) = ...）');
    }
    return this.expr(node);
  }

  private call(node: Node): Expr {
    const span = this.span(node);
    const fn = this.field(node, 'function');
    const args = this.field(node, 'arguments')
      .namedChildren.filter((child) => !isComment(child))
      .map((child) => {
        if (child.type === 'attribute_item') unavailable(this.span(child), '引数に付けた属性');
        return this.expr(child);
      });
    if (
      fn.type === 'field_expression' ||
      (fn.type === 'generic_function' && this.field(fn, 'function').type === 'field_expression')
    ) {
      const access = fn.type === 'field_expression' ? fn : this.field(fn, 'function');
      const methodNode = this.field(access, 'field');
      if (methodNode.type === 'integer_literal') syntaxError(span, 'タプルの要素は呼び出せません。');
      return {
        kind: 'methodCall',
        receiver: this.expr(this.field(access, 'value')),
        method: this.identifier(methodNode),
        turbofish: fn.type === 'generic_function' ? this.typeArgs(this.field(fn, 'type_arguments')) : undefined,
        args,
        methodSpan: this.span(methodNode),
        span,
      };
    }
    return { kind: 'call', callee: this.expr(fn), args, span };
  }

  private structExpr(node: Node): Expr {
    const span = this.span(node);
    const nameNode = this.field(node, 'name');
    const path =
      nameNode.type === 'generic_type_with_turbofish' || nameNode.type === 'generic_type'
        ? this.typePath(nameNode)
        : this.exprPath(nameNode);
    const fields: { name: string; value: Expr; span: Span }[] = [];
    let base: Expr | undefined;
    for (const child of this.field(node, 'body').namedChildren) {
      if (isComment(child)) continue;
      const childSpan = this.span(child);
      if (child.type === 'shorthand_field_initializer') {
        const name = this.onlyChild(child);
        fields.push({
          name: this.identifier(name),
          value: { kind: 'path', path: this.exprPath(name), span: childSpan },
          span: childSpan,
        });
      } else if (child.type === 'field_initializer') {
        const field = this.field(child, 'field');
        fields.push({ name: this.identifier(field), value: this.expr(this.field(child, 'value')), span: childSpan });
      } else if (child.type === 'base_field_initializer') {
        base = this.expr(this.onlyChild(child));
      } else if (child.type === 'attribute_item') {
        unavailable(childSpan, 'フィールドに付けた属性');
      }
    }
    return { kind: 'struct', path, fields, base, span };
  }

  /**
   * An `if` with its `else if` and `else` clauses, which the grammar lists side by side as `alternative`s of the
   * `if_expression`.
   */
  private ifExpr(node: Node): Expr {
    const span = this.span(node);
    const alternatives = node.childrenForFieldName('alternative');
    let elseExpr: Expr | undefined;
    for (const alternative of alternatives.toReversed()) {
      const condition = alternative.childForFieldName('condition');
      const consequence = this.block(this.field(alternative, 'consequence'));
      if (!condition) {
        elseExpr = consequence;
        continue;
      }
      elseExpr = {
        kind: 'if',
        cond: this.condition(condition),
        consequent: consequence,
        else: elseExpr,
        span: this.span(alternative),
      };
    }
    return {
      kind: 'if',
      cond: this.condition(this.field(node, 'condition')),
      consequent: this.block(this.field(node, 'consequence')),
      else: elseExpr,
      span,
    };
  }

  private condition(node: Node): Condition {
    if (node.type === 'let_condition') {
      return {
        kind: 'let',
        pattern: this.pattern(this.field(node, 'pattern')),
        value: this.expr(this.field(node, 'value')),
        span: this.span(node),
      };
    }
    if (node.type === 'let_chain') unavailable(this.span(node), 'let の連鎖（if let ... && ...）');
    return { kind: 'expr', expr: this.expr(node) };
  }

  private matchExpr(node: Node): Expr {
    const span = this.span(node);
    const arms: MatchArm[] = [];
    const body = this.field(node, 'body');
    for (const arm of body.namedChildren) {
      if (isComment(arm)) continue;
      if (arm.type !== 'match_arm') {
        if (arm.type === 'attribute_item') unavailable(this.span(arm), '腕に付けた属性');
        continue;
      }
      const matchPattern = this.field(arm, 'pattern');
      const condition = matchPattern.childForFieldName('condition');
      if (condition && (condition.type === 'let_condition' || condition.type === 'let_chain')) {
        syntaxError(this.span(condition), 'match の腕のガードの if let は、不安定な機能なので使えません（E0658）。');
      }
      const inner = matchPattern.namedChildren.find((child) => !isComment(child) && child.id !== condition?.id);
      const pattern: Pattern = inner ? this.pattern(inner) : { kind: 'wild', span: this.span(matchPattern) };
      const guard = condition ? this.expr(condition) : undefined;
      arms.push({ pattern, guard, body: this.expr(this.field(arm, 'value')), span: this.span(arm) });
    }
    return { kind: 'match', scrutinee: this.expr(this.field(node, 'value')), arms, endRow: node.endPosition.row, span };
  }

  // code-gauge-allow functionCognitiveComplexity -- One case per kind of syntax node.
  private closure(node: Node): Expr {
    const span = this.span(node);
    if (/^\s*(static|async)\b/.test(node.text)) unavailable(span, `${node.text.split(/\s/)[0]} クロージャ`);
    const isMove = node.children.some((child) => child.type === 'move');
    const params: { pattern: Pattern; type: TypeAst | undefined; span: Span }[] = [];
    // `_` is an anonymous token among the parameters.
    for (const child of this.field(node, 'parameters').children) {
      if (isComment(child) || (!child.isNamed && child.type !== '_')) continue;
      if (child.type === 'parameter') {
        let pattern = this.pattern(this.field(child, 'pattern'));
        if (child.namedChildren.some((c) => c.type === 'mutable_specifier') && pattern.kind === 'binding') {
          pattern = { ...pattern, mutable: true };
        }
        params.push({ pattern, type: this.type(this.field(child, 'type')), span: this.span(child) });
      } else {
        params.push({ pattern: this.closureParam(child), type: undefined, span: this.span(child) });
      }
    }
    const ret = node.childForFieldName('return_type');
    const body = this.field(node, 'body');
    if (ret && body.type !== 'block') syntaxError(span, '戻り値の型を書いたクロージャの本体は { } で囲んでください。');
    return { kind: 'closure', isMove, params, ret: ret ? this.type(ret) : undefined, body: this.expr(body), span };
  }

  /** An untyped closure parameter, which may be `mut x` as a function's parameter may. */
  private closureParam(node: Node): Pattern {
    const inner =
      node.type === 'mut_pattern' ? node.namedChildren.find((child) => child.type === 'identifier') : undefined;
    if (!inner) return this.pattern(node);
    const pattern = this.pattern(inner);
    return pattern.kind === 'binding' ? { ...pattern, mutable: true } : pattern;
  }
}

function unsupportedExpr(node: Node, span: Span): never {
  if (Object.hasOwn(UNSUPPORTED_EXPRESSIONS, node.type)) unavailable(span, UNSUPPORTED_EXPRESSIONS[node.type]);
  if (node.type === 'let_condition' || node.type === 'let_chain') {
    syntaxError(span, 'let は if や while の条件にだけ書けます。');
  }
  if (node.isError || node.isMissing) syntaxError(span, '書き方に誤りがあります。');
  return unavailable(span, `この書き方（${node.type}）`);
}

const ITEM_TYPES = new Set([
  'function_item',
  'struct_item',
  'enum_item',
  'trait_item',
  'impl_item',
  'const_item',
  'mod_item',
  'use_declaration',
  'attributed_declaration',
  'static_item',
  'type_item',
  'union_item',
  'macro_definition',
  'extern_crate_declaration',
  'foreign_mod_item',
  'attribute_item',
  'inner_attribute_item',
]);

function isItem(node: Node): boolean {
  return ITEM_TYPES.has(node.type);
}

/** A byte string literal, which is a reference to an array of its bytes (`&[u8; N]`), as `&[b'a', ...]` would be. */
function byteStringExpr(bytes: number[], span: Span): Expr {
  const elems: Expr[] = bytes.map((byte) => ({ kind: 'int', value: BigInt(byte), suffix: 'u8', span }));
  return { kind: 'ref', mutable: false, operand: { kind: 'array', elems, span }, span };
}

function isBlockLike(expr: Expr): boolean {
  return ['block', 'if', 'match', 'loop', 'while', 'for'].includes(expr.kind);
}
