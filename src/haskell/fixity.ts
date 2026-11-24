import type { Fixity } from './entities';
import { compileError } from './errors';
import { RecursionBudget } from './recursionBudget';
import type { ChainItem, Expr, Operator, Pat, Span, TypeExpr } from './syntax';

export const DEFAULT_FIXITY: Fixity = { assoc: 'infixl', prec: 9 };
/** Prefix minus binds like a left-associative operator of precedence 6. */
export const NEGATE_FIXITY: Fixity = { assoc: 'infixl', prec: 6 };

/**
 * A section's operand, whose outermost operator must bind tighter than the section's operator, or as tightly with
 * the associativity that the side of the section needs.
 */
export function sectionOperand(
  op: Operator,
  operand: Expr,
  assoc: Fixity['assoc'],
  fixityOf: (op: Operator) => Fixity
): Expr {
  if (operand.kind !== 'chain') return operand;
  const resolved = resolveExprChain(operand.items, operand.span, fixityOf);
  if (resolved.kind !== 'binop' && resolved.kind !== 'neg') return resolved;
  const inner = resolved.kind === 'binop' ? fixityOf(resolved.op) : NEGATE_FIXITY;
  const outer = fixityOf(op);
  if (inner.prec > outer.prec || (inner.prec === outer.prec && inner.assoc === assoc)) {
    return resolved;
  }
  const innerName = resolved.kind === 'binop' ? resolved.op.name : '-';
  throw compileError(
    op.span,
    `セクションの演算子 ${op.name} [${outer.assoc} ${outer.prec}] と、中の演算子 ${innerName} [${inner.assoc} ${inner.prec}] は、括弧なしでは書けません。`
  );
}

/** Resolves an operator chain by the Haskell report's algorithm, which also places prefix minus. */
// code-gauge-allow functionCognitiveComplexity -- The operator precedence algorithm of the Haskell report, including negation, reads best as one routine.
// code-gauge-allow functionNcss -- The operator precedence algorithm of the Haskell report, including negation, reads best as one routine.
export function resolveExprChain(items: ChainItem<Expr>[], span: Span, fixityOf: (op: Operator) => Fixity): Expr {
  const recursion = new RecursionBudget();
  const tokens = items;
  let position = 0;
  const fixityAt = (item: ChainItem<Expr>): Fixity => (item.kind === 'operator' ? fixityOf(item.op) : NEGATE_FIXITY);
  const parseNeg = (op1: Fixity, op1Name: string): Expr => {
    const token = tokens[position];
    if (!token) throw compileError(span, '書き方に誤りがあります。');
    if (token.kind === 'negate') {
      if (op1.prec >= 6) {
        throw compileError(token.span, `前置きの - は、${op1Name} の後に括弧なしでは書けません。`);
      }
      position++;
      const operand = recursion.run(() => parseNeg(NEGATE_FIXITY, '-'));
      const negated: Expr = {
        kind: 'neg',
        expr: operand,
        span: { ...token.span, endRow: operand.span.endRow, endCol: operand.span.endCol },
      };
      return parse1(op1, op1Name, negated);
    }
    if (token.kind !== 'operand') throw compileError(token.op.span, '書き方に誤りがあります。');
    position++;
    return parse1(op1, op1Name, token.value);
  };
  const parse1 = (op1: Fixity, op1Name: string, left: Expr): Expr => {
    let current = left;
    for (;;) {
      const token = tokens[position];
      if (!token) return current;
      if (token.kind !== 'operator') throw compileError(span, '書き方に誤りがあります。');
      const op2 = fixityAt(token);
      if (op1.prec === op2.prec && (op1.assoc !== op2.assoc || op1.assoc === 'infix')) {
        throw compileError(
          token.op.span,
          `演算子 ${op1Name} [${op1.assoc} ${op1.prec}] と ${token.op.name} [${op2.assoc} ${op2.prec}] は、括弧なしでは並べられません。`
        );
      }
      if (op1.prec > op2.prec || (op1.prec === op2.prec && op1.assoc === 'infixl')) return current;
      position++;
      const right = recursion.run(() => parseNeg(op2, token.op.name));
      current = {
        kind: 'binop',
        op: token.op,
        left: current,
        right,
        span: { row: current.span.row, col: current.span.col, endRow: right.span.endRow, endCol: right.span.endCol },
      };
    }
  };
  const result = parseNeg({ assoc: 'infix', prec: -1 }, '');
  if (position !== tokens.length) throw compileError(span, '書き方に誤りがあります。');
  return result;
}

// code-gauge-allow functionCognitiveComplexity -- The operator precedence algorithm of the Haskell report reads best as one routine.
// code-gauge-allow functionNcss -- The operator precedence algorithm of the Haskell report reads best as one routine.
export function resolvePatChain(items: ChainItem<Pat>[], span: Span, conFixity: (op: Operator) => Fixity): Pat {
  const recursion = new RecursionBudget();
  let position = 0;
  const parseOperand = (): Pat => {
    const token = items[position];
    if (!token || token.kind !== 'operand') {
      if (token?.kind === 'negate')
        throw compileError(token.span, 'パターンの中では、- は数のリテラルの前にだけ書けます。');
      throw compileError(span, '書き方に誤りがあります。');
    }
    position++;
    return token.value;
  };
  const parse1 = (op1: Fixity, op1Name: string, left: Pat): Pat => {
    let current = left;
    for (;;) {
      const token = items[position];
      if (!token) return current;
      if (token.kind !== 'operator') throw compileError(span, '書き方に誤りがあります。');
      if (!token.op.isConstructor) {
        throw compileError(token.op.span, `パターンの中では、関数 ${token.op.name} は使えません。`);
      }
      const op2 = conFixity(token.op);
      if (op1.prec === op2.prec && (op1.assoc !== op2.assoc || op1.assoc === 'infix')) {
        throw compileError(token.op.span, `演算子 ${op1Name} と ${token.op.name} は、括弧なしでは並べられません。`);
      }
      if (op1.prec > op2.prec || (op1.prec === op2.prec && op1.assoc === 'infixl')) return current;
      position++;
      const right = recursion.run(() => parse1(op2, token.op.name, parseOperand()));
      current = {
        kind: 'pcon',
        con: token.op,
        args: [current, right],
        span: { row: current.span.row, col: current.span.col, endRow: right.span.endRow, endCol: right.span.endCol },
      };
    }
  };
  const result = parse1({ assoc: 'infix', prec: -1 }, '', parseOperand());
  if (position !== items.length) throw compileError(span, '書き方に誤りがあります。');
  return result;
}

/** Resolves `a :+: b :*: c` by the type operators' fixities into applications of the operators. */
export function resolveTypeChain(
  items: ChainItem<TypeExpr>[],
  span: Span,
  fixityOf: (op: Operator) => Fixity
): TypeExpr {
  const recursion = new RecursionBudget();
  let position = 0;
  const parseOperand = (): TypeExpr => {
    const token = items[position];
    if (token?.kind !== 'operand') throw compileError(span, '書き方に誤りがあります。');
    position++;
    return token.value;
  };
  const parse1 = (op1: Fixity, op1Name: string, left: TypeExpr): TypeExpr => {
    let current = left;
    for (;;) {
      const token = items[position];
      if (!token) return current;
      if (token.kind !== 'operator') throw compileError(span, '書き方に誤りがあります。');
      const op2 = fixityOf(token.op);
      if (op1.prec === op2.prec && (op1.assoc !== op2.assoc || op1.assoc === 'infix')) {
        throw compileError(token.op.span, `演算子 ${op1Name} と ${token.op.name} は、括弧なしでは並べられません。`);
      }
      if (op1.prec > op2.prec || (op1.prec === op2.prec && op1.assoc === 'infixl')) return current;
      position++;
      const right = recursion.run(() => parse1(op2, token.op.name, parseOperand()));
      const whole = {
        row: current.span.row,
        col: current.span.col,
        endRow: right.span.endRow,
        endCol: right.span.endCol,
      };
      const op: TypeExpr = token.op.promoted
        ? { kind: 'tpromoted', name: token.op, span: token.op.span }
        : { kind: 'tcon', name: token.op, span: token.op.span };
      current = { kind: 'tapp', fn: { kind: 'tapp', fn: op, arg: current, span: whole }, arg: right, span: whole };
    }
  };
  const result = parse1({ assoc: 'infix', prec: -1 }, '', parseOperand());
  if (position !== items.length) throw compileError(span, '書き方に誤りがあります。');
  return result;
}
