import type { Expr, Span } from './ast';
import { changeString, concatStrings, sizeTable } from './capacity';
import type { Compiler, Eval } from './compiler';
import { derefAll, evaluateValues, stringish, stripRefs } from './compilerCommon';
import { normalize } from './infer';
import { btreeSetOp, hashSetMembers, type SetOp } from './natives/setOps';
import { cloneValue, floatArith, intArith, overflow, testPartialOrder, valuesEqual, wrap } from './ops';
import type { Frame } from './runtime';
import { runtimeType } from './runtimeTypes';
import { type IntName, resolve, shallow, type Type } from './types';
import { DONE, type Place, SetValue, UNIT_VALUE } from './values';

type ExprOf<K extends Expr['kind']> = Extract<Expr, { kind: K }>;

const BTREE_OPS: Record<string, SetOp> = {
  '|': 'union',
  '&': 'intersection',
  '-': 'difference',
  '^': 'symmetric_difference',
};

export function compileUnary(c: Compiler, expr: ExprOf<'unary'>): Eval {
  const operand = expr.op === '*' ? c.read(expr.operand) : c.value(expr.operand);
  if (expr.op === '*') {
    const operandType = normalize(shallow(expr.operand.ty!));
    if (operandType.kind === 'ref' && operandType.mutable) return (frame) => (operand(frame) as Place).get();
    return operand;
  }
  const type = numericType(expr.ty!);
  const span = expr.span;
  if (expr.op === '!') {
    if (type.kind === 'bool') return (frame) => !derefAll(operand(frame));
    const name = (type as { name: IntName }).name;
    return (frame) => {
      const value = derefAll(operand(frame)) as bigint;
      return name.startsWith('u') ? BigInt.asUintN(intBitsOf(name), ~value) : ~value;
    };
  }
  if (type.kind === 'float') return (frame) => -(derefAll(operand(frame)) as number);
  const name = (type as { name: IntName }).name;
  return (frame) => {
    const negated = -(derefAll(operand(frame)) as bigint);
    if (negated !== wrap(name, negated)) overflow('neg', span);
    return negated;
  };
}

export function compileBinary(c: Compiler, expr: ExprOf<'binary'>): Eval {
  const { op } = expr;
  if (op === '&&' || op === '||') {
    const left = c.value(expr.left);
    const right = c.value(expr.right);
    return op === '&&'
      ? (frame) => (left(frame) as boolean) && (right(frame) as boolean)
      : (frame) => (left(frame) as boolean) || (right(frame) as boolean);
  }
  const left = c.read(expr.left);
  const right = c.read(expr.right);
  const leftCoerced = c.annotations.coercions.get(expr.left) ? c.value(expr.left) : left;
  const rightCoerced = c.annotations.coercions.get(expr.right) ? c.value(expr.right) : right;
  if (['==', '!=', '<', '<=', '>', '>='].includes(op)) return comparison(expr, leftCoerced, rightCoerced);
  return arithmetic(expr, left, right, rightCoerced);
}

function comparison(expr: ExprOf<'binary'>, left: Eval, right: Eval): Eval {
  const { op } = expr;
  const staticType = resolve(expr.left.ty!, true);
  const compareType = runtimeType(stringish(staticType) ?? staticType);
  if (op === '==' || op === '!=') {
    const equal = op === '==';
    const rhsType = runtimeType(resolve(expr.right.ty!, true));
    return (frame) => valuesEqual(compareType(frame), left(frame), right(frame), rhsType(frame)) === equal;
  }
  const method = { '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' } as const;
  const relation = method[op as keyof typeof method];
  const rhs = runtimeType(resolve(expr.right.ty!, true));
  return (frame) => testPartialOrder(relation, compareType(frame), left(frame), right(frame), rhs(frame));
}

function arithmetic(expr: ExprOf<'binary'>, left: Eval, right: Eval, rightCoerced: Eval): Eval {
  const { op } = expr;
  const type = numericType(expr.ty!);
  const span = expr.span;
  if (type.kind === 'adt' && (type.def.builtin === 'HashSet' || type.def.builtin === 'BTreeSet')) {
    const elem = runtimeType(type.args[0]);
    if (type.def.builtin === 'BTreeSet') {
      const setType = runtimeType(type);
      const merge = BTREE_OPS[op];
      return (frame) => mergeOrderedSets(merge, frame, left, right, elem(frame), setType(frame));
    }
    return (frame) => mergeHashSets(BTREE_OPS[op], frame, left, right, elem(frame));
  }
  if (type.kind === 'adt') {
    // String + &str
    return (frame) => {
      const text = left(frame) as string;
      const addition = derefAll(rightCoerced(frame)) as string;
      frame.runtime.allocateString(text.length + addition.length, addition.length);
      return concatStrings(text, addition);
    };
  }
  if (type.kind === 'bool') {
    const fn = {
      '&': (a: boolean, b: boolean) => a && b,
      '|': (a: boolean, b: boolean) => a || b,
      '^': (a: boolean, b: boolean) => a !== b,
    }[op as '&'];
    return (frame) => fn(derefAll(left(frame)) as boolean, derefAll(right(frame)) as boolean);
  }
  if (type.kind === 'float') {
    const f32 = type.name === 'f32';
    return (frame) => floatArith(op, derefAll(left(frame)) as number, derefAll(right(frame)) as number, f32);
  }
  return intArithmetic(op, (type as { name: IntName }).name, left, right, span);
}

function intArithmetic(op: string, name: IntName, left: Eval, right: Eval, span: Span): Eval {
  if (op === '<<' || op === '>>') {
    return (frame) => intArith(op, name, derefAll(left(frame)) as bigint, derefAll(right(frame)) as bigint, span);
  }
  return (frame) => {
    frame.runtime.spend();
    return intArith(op, name, derefAll(left(frame)) as bigint, derefAll(right(frame)) as bigint, span);
  };
}

// code-gauge-allow functionNcss 33 -- One case per kind of expression, statement, or pattern.
export function compileCompoundAssign(c: Compiler, expr: ExprOf<'compoundAssign'>): Eval {
  const place = c.place(expr.target);
  const value = c.value(expr.value);
  const type = numericType(expr.target.ty!);
  const span = expr.span;
  const { op } = expr;
  if (type.kind === 'adt') {
    return (frame) => {
      const target = place(frame);
      const addition = derefAll(value(frame)) as string;
      frame.runtime.allocateString((target.get() as string).length + addition.length, addition.length);
      changeString(target, () => target.set((target.get() as string) + addition));
      return UNIT_VALUE;
    };
  }
  // On primitive types, `a[i()] += f()` evaluates its right side first; `String`'s `+=` is a call, left side first.
  if (type.kind === 'bool') {
    return (frame) => {
      const b = derefAll(value(frame)) as boolean;
      const target = place(frame);
      const a = target.get() as boolean;
      target.set(op === '&' ? a && b : op === '|' ? a || b : a !== b);
      return UNIT_VALUE;
    };
  }
  if (type.kind === 'float') {
    const f32 = type.name === 'f32';
    return (frame) => {
      const operand = derefAll(value(frame)) as number;
      const target = place(frame);
      target.set(floatArith(op, target.get() as number, operand, f32));
      return UNIT_VALUE;
    };
  }
  const name = (type as { name: IntName }).name;
  return (frame) => {
    const operand = derefAll(value(frame)) as bigint;
    const target = place(frame);
    target.set(intArith(op, name, target.get() as bigint, operand, span));
    return UNIT_VALUE;
  };
}

/** The type an operator works on: numbers through references. */
function numericType(type: Type): Type {
  return stripRefs(resolve(type, true));
}

function intBitsOf(name: IntName): number {
  return name === 'usize' || name === 'isize' ? 64 : Number(name.slice(1));
}

function mergeOrderedSets(op: SetOp, frame: Frame, left: Eval, right: Eval, elem: Type, setType: Type): SetValue {
  const [a, b] = evaluateValues(frame, [left, right]).map((value) => derefAll(value) as SetValue);
  const result = new SetValue(true);
  return frame.runtime.withRoots([a, b, result], () => {
    const iter = btreeSetOp(op, [a, b], elem, setType);
    for (let item = iter.next(); item !== DONE; item = iter.next()) {
      frame.runtime.spend();
      frame.runtime.allocate(1);
      result.entries.appendOrdered(cloneValue(elem, item));
    }
    return result;
  });
}

/** The set that `|`, `&`, `-`, or `^` makes of two sets, of clones of their elements, in the order they iterate. */
function mergeHashSets(op: SetOp, frame: Frame, left: Eval, right: Eval, elem: Type): SetValue {
  const [a, b] = evaluateValues(frame, [left, right]).map((value) => derefAll(value) as SetValue);
  const result = new SetValue(false);
  if (a.entries.table) sizeTable(result.entries.table, a.entries.table.entrySize);
  return frame.runtime.withRoots([a, b, result], () => {
    for (const value of hashSetMembers(op, a, b, elem)) {
      frame.runtime.allocate(1);
      result.entries.set(result.entries.key(elem, value), cloneValue(elem, value));
    }
    return result;
  });
}
