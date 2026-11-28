import type { MethodRes, ReceiverAdjust } from './annotations';
import type { Expr, Span } from './ast';
import type { Compiler, Eval } from './compiler';
import { construct, derefAll, evaluateValues, stripRefs } from './compilerCommon';
import { placeThrough, valueThrough } from './compilerPlaces';
import { dropsBorrowedTemporary } from './compilerTemporaries';
import { normalize } from './infer';
import { isUserIterator } from './iterTypes';
import { derefOnce } from './methods';
import { borrowedView } from './natives/iterators';
import { copyValue, needsCopy } from './ops';
import { type Frame, MOVED } from './runtime';
import { runtimeType } from './runtimeTypes';
import { type FnDef, shallow, type Type } from './types';
import { CellPlace, DynValue, FnValue, IterValue, type Place } from './values';

type ExprOf<K extends Expr['kind']> = Extract<Expr, { kind: K }>;

export function compileCall(c: Compiler, expr: ExprOf<'call'>): Eval {
  const { callee } = expr;
  const args = expr.args.map((arg) => c.value(arg));
  const span = expr.span;
  const callRow = expr.span.row;
  const res = callee.kind === 'path' ? c.annotations.paths.get(callee) : undefined;
  if (res?.kind === 'fn') return fnCall(c, res.fn, res.typeArgs, args, callRow, span);
  if (res?.kind === 'ctor') {
    const { def, variant } = res;
    return (frame) => {
      frame.runtime.allocate(args.length);
      return construct(def, variant, evaluateValues(frame, args));
    };
  }
  const once = c.annotations.callKinds.get(expr) === 'FnOnce';
  // A closure no variable holds (`(move |x| ..)(5)`) is a temporary, which goes when the statement ends.
  const calleeValue = once ? c.value(callee) : dropsBorrowedTemporary(c, callee, c.read(callee));
  const operands: Eval[] = [(frame) => derefAll(calleeValue(frame)), ...args];
  return (frame) => {
    const [fn, ...values] = evaluateValues(frame, operands);
    const closure = fn instanceof DynValue ? fn.value : fn;
    try {
      return c.support.callValue(closure, values, callRow);
    } finally {
      // A call that takes the closure by value consumes it, and what its body did not take goes when it ends.
      if (once && closure instanceof FnValue) closure.dropCaptures?.();
    }
  };
}

export function compileMethodCall(c: Compiler, expr: ExprOf<'methodCall'>): Eval {
  const method = c.annotations.methods.get(expr);
  if (!method) throw new Error(`Unresolved method ${expr.method}`);
  const receiver = compileReceiver(c, expr, method);
  receiver.valueType = expr.receiver.ty;
  const args = [receiver, ...expr.args.map((arg) => c.value(arg))];
  return fnCall(c, method.fn, method.typeArgs, args, expr.span.row, expr.methodSpan);
}

/** A call of a function with the values of `args`, its type arguments instantiated for the running frame. */
export function fnCall(c: Compiler, fn: FnDef, typeArgs: Type[], args: Eval[], callRow: number, span: Span): Eval {
  const runtimeArgs = typeArgs.map((arg) => runtimeType(arg));
  return (frame) => {
    const values = evaluateValues(frame, args);
    return c.support.callFn(
      fn,
      runtimeArgs.map((arg) => arg(frame)),
      values,
      callRow,
      span,
      frame
    );
  };
}

/** An iterator a `&mut` receiver makes of its place; the program's own stays there, so adapters advance it. */
function borrowedIterator(c: Compiler, place: (frame: Frame) => Place, iterFrom: (frame: Frame) => Type): Eval {
  return (frame) => {
    const target = place(frame);
    const type = iterFrom(frame);
    return new CellPlace(c.support.toIter(isUserIterator(type) ? target : target.get(), type));
  };
}

/** The receiver a method takes, after the derefs and the reference its call adds. */
function compileReceiver(c: Compiler, expr: ExprOf<'methodCall'>, method: MethodRes): Eval {
  const adjust: ReceiverAdjust = method.receiver;
  const iterFrom = adjust.asIter ? runtimeType(stripRefs(expr.receiver.ty!)) : undefined;
  if (adjust.autoref === 'mut') {
    const place = placeThrough(c, expr.receiver, adjust.derefs);
    if (iterFrom) return borrowedIterator(c, place, iterFrom);
    return adjust.derefs.length > 0 ? place : dropsBorrowedTemporary(c, expr.receiver, place);
  }
  const byValue = adjust.autoref === 'none' && method.fn.selfMode === 'value' && adjust.derefs.length === 0;
  // rustc reborrows a `&mut` receiver rather than moving it out of its variable.
  const reborrowed = byValue && isMutReference(expr.receiver.ty);
  const borrowed = adjust.autoref !== 'none';
  const read =
    byValue && !reborrowed ? c.value(expr.receiver) : valueThrough(c, expr.receiver, adjust.derefs, borrowed);
  if (iterFrom) return (frame) => c.support.toIter(read(frame), iterFrom(frame));
  if (method.fn.selfMode === 'value' && adjust.autoref === 'none' && adjust.derefs.length > 0) {
    const self = derefedSelf(c, expr.receiver, adjust.derefs, read);
    return adjust.derefs.includes('mutRef') ? borrowedIteratorSelf(self) : self;
  }
  return read;
}

/** An iterator a `&mut` reaches (`(&mut it).take(2)`), which the adapter or consumer it is given to only borrows. */
function borrowedIteratorSelf(self: Eval): Eval {
  return (frame) => {
    const value = self(frame);
    return value instanceof IterValue ? borrowedView(value) : value;
  };
}

/** A receiver taken by value after derefs: a `Copy` value is copied, and through owners only (a `Box`), one that is not `Copy` moves out of the place that owns it. */
function derefedSelf(c: Compiler, receiver: Expr, derefs: ReceiverAdjust['derefs'], read: Eval): Eval {
  let type = receiver.ty!;
  for (let index = 0; index < derefs.length; index++) type = derefOnce(c.program, type)?.type ?? type;
  const adjusted = runtimeType(type);
  const owner =
    derefs.every((step) => step === 'own') && c.ownedPlace(receiver) ? placeThrough(c, receiver, derefs) : undefined;
  return (frame) => {
    const self = adjusted(frame);
    if (c.isCopy(self)) return needsCopy(self) ? copyValue(read(frame)) : read(frame);
    if (!owner) return read(frame);
    const place = owner(frame);
    const value = place.get();
    place.set(MOVED);
    return value;
  };
}

function isMutReference(type: Type | undefined): boolean {
  const t = type && normalize(shallow(type));
  return t?.kind === 'ref' && t.mutable;
}
