import type { Node } from '@willbooster/web-tree-sitter';

import type { BinaryOp, Block, Condition, Expr, Item, MatchArm, PathAst, Pattern, Span, Stmt, TypeAst } from './ast';
import { forEachDirect } from './astWalk';
import { MacroConverter } from './convertMacros';
import { isComment, splitAttributes, syntaxError, unavailable } from './convertSyntax';
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
  attribute_item: '式に付けた属性',
  attributed_expression: '式に付けた属性',
};

/** Converts statements and expressions. */
export abstract class ExpressionConverter extends MacroConverter {
  /** Whether the expressions being converted are in an `async` block, where `.await` may be written. */
  protected inAsync = false;

  // code-gauge-allow functionCognitiveComplexity -- One case per kind of syntax node.
  // code-gauge-allow functionNcss -- One case per kind of syntax node.
  block(node: Node): Block {
    const span = this.span(node);
    const stmts: Stmt[] = [];
    const items: Item[] = [];
    let tail: Expr | undefined;
    const children = this.blockChildren(node);
    for (const [index, child] of children.entries()) {
      const isLast = index === children.length - 1;
      if (child.type === 'label') continue;
      if (child.type === 'let_declaration') {
        stmts.push(this.letStmt(child));
      } else if (this.userMacroStatement(child)) {
        const node = this.userMacroStatement(child) as Node;
        const expansion = this.userMacroStatements(node);
        stmts.push(...expansion.stmts);
        items.push(...expansion.items);
        if (expansion.tail) {
          const terminated = child.type === 'expression_statement' && child.text.trimEnd().endsWith(';');
          if (isLast && !terminated) tail = expansion.tail;
          else stmts.push({ kind: 'expr', expr: expansion.tail, semi: terminated, span: expansion.tail.span });
        }
      } else if (child.type === 'expression_statement') {
        const inner = child.namedChildren.find((c) => !isComment(c)) as Node;
        const semi = child.text.trimEnd().endsWith(';') && !inner.text.endsWith(';');
        const { attributes, target } = splitAttributes(inner);
        if (!this.attributes.read(attributes) || !target) continue;
        const expression = target;
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
   * The elements of a list of expressions (a tuple, an array, arguments), without those that `#[cfg]` removes; an
   * attribute may precede an element or wrap it.
   */
  private listElements(children: Node[]): Node[] {
    return this.withAttributes(children).flatMap(({ node }) => {
      const { attributes, target } = splitAttributes(node);
      return this.attributes.read(attributes) && target ? [target] : [];
    });
  }

  /**
   * The statements and items of a block, without the comments, the inner attributes, and what `#[cfg]` removes, and
   * with the other attributes read.
   */
  private blockChildren(node: Node): Node[] {
    const children: Node[] = [];
    for (const child of node.namedChildren) {
      if (isComment(child)) continue;
      if (child.type === 'inner_attribute_item') {
        this.attributes.readInner(child);
        continue;
      }
      if (child.type === 'attribute_item')
        syntaxError(this.span(child), '属性の後には、それを付ける文を書いてください。');
      if (child.type !== 'attributed_declaration' && child.type !== 'attributed_expression') {
        children.push(child);
        continue;
      }
      const { attributes, target } = splitAttributes(child);
      const attrs = this.attributes.read(attributes);
      if (!attrs || !target) continue;
      // An item keeps its attributes, which the item's conversion reads.
      children.push(
        isItem(target) && target.type !== 'attributed_declaration' && attributes.length > 0 ? child : target
      );
    }
    return children;
  }

  /** The invocation of a program's macro that a block's child is, as a statement, if it is one. */
  private userMacroStatement(child: Node): Node | undefined {
    const node = child.type === 'expression_statement' ? child.namedChildren.find((part) => !isComment(part)) : child;
    return node?.type === 'macro_invocation' && this.isUserMacro(node) ? node : undefined;
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
      case 'unsafe_block': {
        return {
          ...this.block(node.namedChildren.find((child) => child.type === 'block') as Node),
          isUnsafe: true,
          span,
        };
      }
      case 'const_block': {
        return { ...this.block(this.field(node, 'body')), isConst: true, span };
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
      case 'async_block': {
        const isMove = node.children.some((child) => child.type === 'move');
        const body = this.inContext(true, () =>
          this.block(node.namedChildren.find((child) => child.type === 'block') as Node)
        );
        return asyncBlock(body, isMove, span);
      }
      case 'await_expression': {
        if (!this.inAsync) syntaxError(span, '.await は、async 関数か async ブロックの中でしか使えません（E0728）。');
        return awaitLoop(this.expr(node.namedChildren.find((child) => !isComment(child)) as Node), span);
      }
      case 'macro_invocation': {
        if (this.isUserMacro(node)) return { ...this.userMacroExpr(node), span };
        return this.literalMacro(node) ?? { kind: 'macro', macro: this.macro(node), span };
      }
      case 'attributed_expression': {
        // Attributes may stand on a statement and on the elements of a list, but on no other expression.
        return syntaxError(span, '式に付けた属性は、不安定な機能なので使えません（E0658）。');
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
    return { kind: 'loop', label, body, span, isBlock: true };
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
        const left = this.field(node, 'left');
        const value = this.expr(this.field(node, 'right'));
        if (this.isDestructuring(left)) return this.destructuringAssignment(left, value, span);
        return { kind: 'assign', target: this.assignee(left), value, span };
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
    const raw = node.children.some((child) => child.type === 'raw');
    const mutable = node.namedChildren.some((child) => child.type === 'mutable_specifier');
    if (raw) return { kind: 'ref', mutable, operand: this.expr(this.field(node, 'value')), span, raw };
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
        const elems = this.listElements(node.namedChildren);
        return { kind: 'tuple', elems: elems.map((child) => this.expr(child)), span };
      }
      case 'unit_expression': {
        return { kind: 'tuple', elems: [], span };
      }
      case 'array_expression': {
        const length = node.childForFieldName('length');
        const elems = this.listElements(node.namedChildren.filter((child) => child.id !== length?.id));
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
        const condition = this.field(node, 'condition');
        const body = this.block(this.field(node, 'body'));
        const label = this.label(node);
        if (condition.type !== 'let_chain')
          return { kind: 'while', label, cond: this.condition(condition), body, span };
        // `while` on a chain of conditions runs as `loop { if <chain> { ... } else { break } }`.
        const exit: Expr = { kind: 'break', label, value: undefined, span };
        const otherwise: Block = {
          kind: 'block',
          stmts: [{ kind: 'expr', expr: exit, semi: true, span }],
          tail: undefined,
          span,
          endRow: body.endRow,
          items: [],
        };
        const step = this.conditional(condition, body, otherwise, span);
        const loopBody: Block = {
          kind: 'block',
          stmts: [{ kind: 'expr', expr: step, semi: true, span }],
          tail: undefined,
          span,
          endRow: body.endRow,
          items: [],
        };
        return { kind: 'loop', label, body: loopBody, span };
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

  /** The left side of an assignment, where `_` discards the value. */
  private assignee(node: Node): Expr {
    if (node.type === 'identifier' && node.text === '_') {
      return {
        kind: 'path',
        path: { segments: [{ name: '_', args: undefined, span: this.span(node) }], span: this.span(node) },
        span: this.span(node),
      };
    }
    return this.expr(node);
  }

  /** Whether the left side of an assignment destructures the value (`(a, b) = ...`), rather than naming one place. */
  private isDestructuring(node: Node): boolean {
    if (node.type === 'parenthesized_expression') return this.isDestructuring(this.onlyChild(node));
    if (node.type === 'call_expression') return this.field(node, 'function').type !== 'field_expression';
    return ['tuple_expression', 'array_expression', 'struct_expression', 'unit_expression'].includes(node.type);
  }

  /**
   * A destructuring assignment, which runs as rustc runs it: `(a, b) = value;` as
   * `{ let (lhs0, lhs1) = value; a = lhs0; b = lhs1; }`.
   */
  private destructuringAssignment(left: Node, value: Expr, span: Span): Expr {
    const stores: Stmt[] = [];
    const pattern = this.assigneePattern(left, stores);
    const binding: Stmt = { kind: 'let', pattern, type: undefined, init: value, else: undefined, span, hidden: true };
    return { kind: 'block', stmts: [binding, ...stores], tail: undefined, span, endRow: span.row, items: [] };
  }

  // code-gauge-allow functionCognitiveComplexity -- One case per kind of assignee expression.
  private assigneePattern(node: Node, stores: Stmt[]): Pattern {
    const span = this.span(node);
    switch (node.type) {
      case 'parenthesized_expression': {
        return this.assigneePattern(this.onlyChild(node), stores);
      }
      case 'unit_expression': {
        return { kind: 'tuple', elems: [], span };
      }
      case 'tuple_expression':
      case 'array_expression': {
        const elems = node.namedChildren
          .filter((child) => !isComment(child))
          .map((child) => this.assigneePattern(child, stores));
        if (node.type === 'tuple_expression' && elems.length === 1 && !node.children.some((c) => c.type === ',')) {
          return elems[0];
        }
        return node.type === 'tuple_expression' ? { kind: 'tuple', elems, span } : { kind: 'slice', elems, span };
      }
      case 'range_expression': {
        if (node.namedChildren.some((child) => !isComment(child))) break;
        return { kind: 'rest', span };
      }
      case 'call_expression': {
        const callee = this.field(node, 'function');
        if (callee.type === 'field_expression') break;
        const elems = this.field(node, 'arguments')
          .namedChildren.filter((child) => !isComment(child))
          .map((child) => this.assigneePattern(child, stores));
        return { kind: 'tupleStruct', path: this.exprPath(callee), elems, span };
      }
      case 'struct_expression': {
        return this.structAssigneePattern(node, stores, span);
      }
      case 'identifier': {
        if (node.text === '_') return { kind: 'wild', span };
        break;
      }
      default: {
        break;
      }
    }
    const name = `lhs#${stores.length}`;
    const target = this.expr(node);
    const read: Expr = { kind: 'path', path: { segments: [{ name, args: undefined, span }], span }, span };
    stores.push({ kind: 'expr', expr: { kind: 'assign', target, value: read, span }, semi: true, span, hidden: true });
    return { kind: 'binding', name, mutable: false, sub: undefined, span };
  }

  private structAssigneePattern(node: Node, stores: Stmt[], span: Span): Pattern {
    const nameNode = this.field(node, 'name');
    const path =
      nameNode.type === 'generic_type_with_turbofish' || nameNode.type === 'generic_type'
        ? this.typePath(nameNode)
        : this.exprPath(nameNode);
    const fields: { name: string; pattern: Pattern; span: Span }[] = [];
    let rest = false;
    for (const child of this.field(node, 'body').namedChildren) {
      if (isComment(child)) continue;
      const childSpan = this.span(child);
      if (child.type === 'shorthand_field_initializer') {
        const name = this.onlyChild(child);
        fields.push({ name: this.identifier(name), pattern: this.assigneePattern(name, stores), span: childSpan });
      } else if (child.type === 'field_initializer') {
        const field = this.identifier(this.field(child, 'field'));
        fields.push({
          name: field,
          pattern: this.assigneePattern(this.field(child, 'value'), stores),
          span: childSpan,
        });
      } else if (child.type === 'remaining_field_pattern' || child.type === 'base_field_initializer') {
        if (child.type === 'base_field_initializer') {
          syntaxError(childSpan, '分割代入の左辺では、.. の後に値を書けません。');
        }
        rest = true;
      }
    }
    return { kind: 'struct', path, fields, rest, span };
  }

  private call(node: Node): Expr {
    const span = this.span(node);
    const fn = this.field(node, 'function');
    const args = this.listElements(this.field(node, 'arguments').namedChildren).map((child) => this.expr(child));
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
    for (const { node: child } of this.withAttributes(this.field(node, 'body').namedChildren)) {
      const childSpan = this.span(child);
      const attributes = child.namedChildren.filter((part) => part.type === 'attribute_item');
      if (attributes.length > 0 && !this.attributes.read(attributes)) continue;
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
      elseExpr = this.conditional(condition, consequence, elseExpr, this.span(alternative));
    }
    return this.conditional(this.field(node, 'condition'), this.block(this.field(node, 'consequence')), elseExpr, span);
  }

  /**
   * An `if` on a condition, where a chain of conditions (`if let Some(x) = a && x > 3 && let ...`) runs as
   * `'chain: { if let Some(x) = a { if x > 3 { if let ... { break 'chain { ... } } } } else-branch }`: the first
   * condition that fails goes on to the else branch, and the bindings of each `let` reach the conditions after it.
   */
  private conditional(condition: Node, consequent: Block, elseExpr: Expr | undefined, span: Span): Expr {
    if (condition.type !== 'let_chain') {
      return { kind: 'if', cond: this.condition(condition), consequent, else: elseExpr, span };
    }
    const label = `chain#${span.row}:${span.col}`;
    const parts = condition.namedChildren.filter((child) => !isComment(child)).map((child) => this.condition(child));
    let inner: Expr = { kind: 'break', label, value: consequent, span: consequent.span };
    for (const part of parts.toReversed()) {
      const body: Block = {
        kind: 'block',
        stmts: [{ kind: 'expr', expr: inner, semi: true, span }],
        tail: undefined,
        span,
        endRow: consequent.endRow,
        items: [],
      };
      inner = { kind: 'if', cond: part, consequent: body, else: undefined, span };
    }
    const fallback: Expr = elseExpr ?? { kind: 'tuple', elems: [], span };
    const stmts: Block['stmts'] = [{ kind: 'expr', expr: inner, semi: true, span }];
    const blockBody: Block = { kind: 'block', stmts, tail: fallback, span, endRow: consequent.endRow, items: [] };
    const exit: Expr = { kind: 'break', label, value: blockBody, span };
    const loopBody: Block = {
      kind: 'block',
      stmts: [{ kind: 'expr', expr: exit, semi: true, span }],
      tail: undefined,
      span,
      endRow: consequent.endRow,
      items: [],
    };
    return { kind: 'loop', label, body: loopBody, span, isBlock: true };
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
    if (node.type === 'let_chain') syntaxError(this.span(node), 'let の連鎖は、if と while の条件にだけ書けます。');
    return { kind: 'expr', expr: this.expr(node) };
  }

  private matchExpr(node: Node): Expr {
    const span = this.span(node);
    const arms: MatchArm[] = [];
    const body = this.field(node, 'body');
    for (const { node: arm } of this.withAttributes(body.namedChildren)) {
      if (arm.type !== 'match_arm') continue;
      const attributes = arm.namedChildren.filter((part) => part.type === 'attribute_item');
      if (attributes.length > 0 && !this.attributes.read(attributes)) continue;
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
    if (/^\s*static\b/.test(node.text))
      syntaxError(span, 'static クロージャは、不安定な機能なので使えません（E0658）。');
    const isAsync = /^\s*async\b/.test(node.text);
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
    const retType = ret ? this.type(ret) : undefined;
    const bodyExpr = this.inContext(isAsync, () => this.expr(body));
    if (!isAsync) return { kind: 'closure', isMove, params, ret: retType, body: bodyExpr, span };
    // `async |x| body` runs as `|x| async { body }`, whose future borrows what the closure captures.
    const inner: Expr = { kind: 'closure', isMove, params: [], ret: retType, body: bodyExpr, isAsync: 'block', span };
    return { kind: 'closure', isMove, params, ret: undefined, body: inner, span };
  }

  /** Converts with `.await` allowed or not, as in an `async` block or a closure or function. */
  protected inContext<T>(inAsync: boolean, convert: () => T): T {
    const outer = this.inAsync;
    this.inAsync = inAsync;
    try {
      return convert();
    } finally {
      this.inAsync = outer;
    }
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

/** Expressions of unstable features, which stable rustc rejects (E0658). */
const UNSTABLE_EXPRESSIONS: Record<string, string> = {
  gen_block: 'gen ブロック',
  try_block: 'try ブロック',
  yield_expression: 'yield',
  become_expression: 'become',
};

function asyncBlock(body: Block, isMove: boolean, span: Span): Expr {
  return { kind: 'closure', isMove, params: [], ret: undefined, body, isAsync: 'block', span };
}

/**
 * `future.await` as `{ let mut f = future; loop { match Future::poll(unsafe { Pin::new_unchecked(&mut f) }, &mut cx) { Ready(v) => break v,
 * Pending => thread::yield_now() } } }`: it polls the future until it is ready, letting waiting threads run between
 * polls, so the `async` block it is in never returns `Pending` itself.
 */
function awaitLoop(future: Expr, span: Span): Expr {
  const name = `fut#${span.row}:${span.col}`;
  const value = `ready#${span.row}:${span.col}`;
  const local: Expr = pathExpr([name], span);
  const pin = callExpr(
    ['std', 'pin', 'Pin', 'new_unchecked'],
    [{ kind: 'ref', mutable: true, operand: local, span }],
    span
  );
  const pinned: Expr = { ...blockOf([], pin, span), isUnsafe: true };
  const waker = callExpr(['std', 'task', 'Waker', 'noop'], [], span);
  const context = callExpr(['std', 'task', 'Context', 'from_waker'], [waker], span);
  const poll = callExpr(
    ['std', 'future', 'Future', 'poll'],
    [pinned, { kind: 'ref', mutable: true, operand: context, span }],
    span
  );
  const binding: Pattern = { kind: 'binding', name: value, mutable: false, sub: undefined, span };
  const arms: MatchArm[] = [
    {
      pattern: { kind: 'tupleStruct', path: pathAst(['std', 'task', 'Poll', 'Ready'], span), elems: [binding], span },
      guard: undefined,
      body: { kind: 'break', label: undefined, value: pathExpr([value], span), span },
      span,
    },
    {
      pattern: { kind: 'path', path: pathAst(['std', 'task', 'Poll', 'Pending'], span), span },
      guard: undefined,
      body: callExpr(['std', 'thread', 'yield_now'], [], span),
      span,
    },
  ];
  const match: Expr = { kind: 'match', scrutinee: poll, arms, endRow: span.row, span };
  const loop: Expr = { kind: 'loop', label: undefined, body: blockOf([], match, span), span };
  const binder: Pattern = { kind: 'binding', name, mutable: true, sub: undefined, span };
  const let_: Stmt = {
    kind: 'let',
    pattern: binder,
    type: undefined,
    init: future,
    else: undefined,
    span,
    hidden: true,
  };
  return blockOf([let_], loop, span);
}

function blockOf(stmts: Stmt[], tail: Expr, span: Span): Block {
  return { kind: 'block', stmts, tail, span, endRow: span.row, items: [] };
}

function callExpr(names: string[], args: Expr[], span: Span): Expr {
  return { kind: 'call', callee: pathExpr(names, span), args, span };
}

function pathExpr(names: string[], span: Span): Expr {
  return { kind: 'path', path: pathAst(names, span), span };
}

function pathAst(names: string[], span: Span): PathAst {
  return { segments: names.map((name) => ({ name, args: undefined, span })), span };
}

function unsupportedExpr(node: Node, span: Span): never {
  if (Object.hasOwn(UNSTABLE_EXPRESSIONS, node.type)) {
    syntaxError(span, `${UNSTABLE_EXPRESSIONS[node.type]}は、不安定な機能なので使えません（E0658）。`);
  }
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
