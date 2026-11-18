import type { Annotations, LocalVar } from './annotations';
import type { Block, Expr, Stmt } from './ast';
import { forEachDirect } from './astWalk';
import { normalize } from './infer';
import { compileError } from './items';
import { castValue, wrap } from './ops';
import { intMax, intMin, type IntName, resolve, shallow, type Type } from './types';

type Known = bigint | number | boolean;

/**
 * Rejects operations that rustc's deny-by-default lints find always panic, by propagating constants through
 * literals, `const` items, and variables declared without `mut`: arithmetic that overflows (`arithmetic_overflow`),
 * division by zero and indexes of arrays out of bounds (`unconditional_panic`).
 */
export class ConstLint {
  private readonly known = new Map<LocalVar, Known>();

  constructor(private readonly annotations: Annotations) {}

  check(block: Block): void {
    this.block(block);
  }

  private block(block: Block): void {
    for (const stmt of block.stmts) this.stmt(stmt);
    if (block.tail) this.expr(block.tail);
  }

  private stmt(stmt: Stmt): void {
    if (stmt.kind === 'let') {
      if (stmt.init) {
        const value = this.expr(stmt.init);
        const local = stmt.pattern.kind === 'binding' ? this.annotations.bindings.get(stmt.pattern) : undefined;
        if (local && !local.mutable && local.mode === 'move' && value !== undefined) this.known.set(local, value);
      }
      if (stmt.else) this.block(stmt.else);
    } else if (stmt.kind === 'expr') {
      this.expr(stmt.expr);
    }
  }

  /** Checks an expression's operations, returning its value when it is a constant. */
  private expr(expr: Expr): Known | undefined {
    switch (expr.kind) {
      case 'int': {
        const type = intTypeOf(expr.ty);
        return type ? expr.value : undefined;
      }
      case 'bool': {
        return expr.value;
      }
      case 'path': {
        const res = this.annotations.paths.get(expr);
        if (res?.kind === 'local') return this.known.get(res.local);
        if (res?.kind === 'const') {
          const ast = res.def.ast as { value?: Expr };
          // A constant's initializer may not be checked yet, so its literal value counts by the constant's type.
          if (ast.value?.kind === 'int' && intTypeOf(res.def.type)) return ast.value.value;
          return ast.value ? this.constValue(ast.value) : undefined;
        }
        if (res?.kind === 'builtinConst') return integerConst(res.name);
        return undefined;
      }
      case 'unary': {
        const operand = this.expr(expr.operand);
        if (expr.op !== '-' || typeof operand !== 'bigint') return undefined;
        const name = intTypeOf(expr.ty);
        if (!name) return undefined;
        return this.checked(-operand, name, expr);
      }
      case 'binary': {
        if (['==', '!=', '<', '<=', '>', '>='].includes(expr.op)) return this.comparison(expr);
        return this.binary(expr);
      }
      case 'cast': {
        const operand = this.expr(expr.operand);
        if (operand === undefined || !intTypeOf(expr.ty)) return undefined;
        return castValue(operand, resolve(expr.operand.ty!, true), resolve(expr.ty!, true)) as Known;
      }
      case 'index': {
        this.expr(expr.operand);
        const index = this.expr(expr.index);
        const operand = normalize(shallow(resolve(expr.operand.ty!, true)));
        const array = operand.kind === 'ref' ? normalize(shallow(operand.target)) : operand;
        if (array.kind === 'array' && typeof index === 'bigint' && index >= BigInt(array.len)) {
          compileError(
            expr.span,
            `この添字（${index}）は、長さ ${array.len} の配列の範囲外なので、実行すると必ず panic します。`
          );
        }
        return undefined;
      }
      case 'closure': {
        const lint = new ConstLint(this.annotations);
        for (const [local, value] of this.known) lint.known.set(local, value);
        if (expr.body.kind === 'block') lint.block(expr.body);
        else lint.expr(expr.body);
        return undefined;
      }
      case 'block': {
        this.block(expr);
        return undefined;
      }
      case 'if': {
        // A branch that a known condition never takes is unreachable, where rustc's lints do not look.
        if (expr.cond.kind === 'let') {
          this.expr(expr.cond.value);
          this.block(expr.consequent);
          if (expr.else) this.expr(expr.else);
          return undefined;
        }
        const cond = this.expr(expr.cond.expr);
        if (cond !== false) this.block(expr.consequent);
        if (expr.else && cond !== true) this.expr(expr.else);
        return undefined;
      }
      default: {
        forEachDirect(expr, (child) => {
          this.expr(child);
        });
        return undefined;
      }
    }
  }

  private constValue(expr: Expr): Known | undefined {
    return new ConstLint(this.annotations).expr(expr);
  }

  // code-gauge-allow functionNcss 35 -- One case per kind of constant expression.
  private binary(expr: Extract<Expr, { kind: 'binary' }>): Known | undefined {
    const left = this.expr(expr.left);
    const right = this.expr(expr.right);
    const name = intTypeOf(expr.left.ty);
    if (!name || typeof right !== 'bigint') return undefined;
    if ((expr.op === '/' || expr.op === '%') && right === 0n) {
      compileError(expr.span, '0 で割る計算なので、実行すると必ず panic します。');
    }
    if ((expr.op === '<<' || expr.op === '>>') && (right < 0n || right >= BigInt(bits(name)))) {
      compileError(expr.span, 'この計算は、実行すると必ずあふれます。');
    }
    if (typeof left !== 'bigint') return undefined;
    switch (expr.op) {
      case '+': {
        return this.checked(left + right, name, expr);
      }
      case '-': {
        return this.checked(left - right, name, expr);
      }
      case '*': {
        return this.checked(left * right, name, expr);
      }
      case '/': {
        return this.checked(left / right, name, expr);
      }
      case '%': {
        return this.checked(left % right, name, expr);
      }
      case '&': {
        return left & right;
      }
      case '|': {
        return left | right;
      }
      case '^': {
        return left ^ right;
      }
      case '<<': {
        return wrap(name, left << right);
      }
      case '>>': {
        return left >> right;
      }
      default: {
        return undefined;
      }
    }
  }

  // code-gauge-allow duplicateLines 21 -- Each language compares its own constants, as its operators define.
  private comparison(expr: Extract<Expr, { kind: 'binary' }>): Known | undefined {
    const left = this.expr(expr.left);
    const right = this.expr(expr.right);
    if (typeof left !== 'bigint' || typeof right !== 'bigint') return undefined;
    switch (expr.op) {
      case '==': {
        return left === right;
      }
      case '!=': {
        return left !== right;
      }
      case '<': {
        return left < right;
      }
      case '<=': {
        return left <= right;
      }
      case '>': {
        return left > right;
      }
      default: {
        return left >= right;
      }
    }
  }

  private checked(value: bigint, name: IntName, expr: Expr): bigint {
    if (value < intMin(name) || value > intMax(name)) {
      compileError(expr.span, 'この計算は、実行すると必ずあふれます。');
    }
    return value;
  }
}

function intTypeOf(type: Type | undefined): IntName | undefined {
  if (!type) return undefined;
  const t = normalize(shallow(resolve(type, true)));
  return t.kind === 'int' ? t.name : undefined;
}

function bits(name: IntName): number {
  return name === 'isize' || name === 'usize' ? 64 : Number(name.slice(1));
}

/** The value of an integer type's associated constant (`i32::MAX`), which rustc's lints know. */
function integerConst(name: string): bigint | undefined {
  const [type, constant] = name.split('::') as [IntName, string];
  if (!INT_NAMES.has(type)) return undefined;
  if (constant === 'MAX') return intMax(type);
  if (constant === 'MIN') return intMin(type);
  return undefined;
}

const INT_NAMES = new Set<string>([
  'i8',
  'i16',
  'i32',
  'i64',
  'i128',
  'isize',
  'u8',
  'u16',
  'u32',
  'u64',
  'u128',
  'usize',
]);
