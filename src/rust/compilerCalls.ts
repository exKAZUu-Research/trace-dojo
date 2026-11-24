import type { MethodRes, ReceiverAdjust } from './annotations';
import type { Expr } from './ast';
import type { Compiler, Eval } from './compiler';
import { construct, derefAll, evaluateValues, isPlaceExpr, stripRefs } from './compilerCommon';
import { placeThrough, valueThrough } from './compilerPlaces';
import { normalize } from './infer';
import { derefOnce } from './methods';
import { copyValue, needsCopy } from './ops';
import { MOVED } from './runtime';
import { runtimeType } from './runtimeTypes';
import { shallow, type Type } from './types';
import { CellPlace, DynValue, type Place } from './values';

type ExprOf<K extends Expr['kind']> = Extract<Expr, { kind: K }>;

export function compileCall(c: Compiler, expr: ExprOf<'call'>): Eval {
  const { callee } = expr;
  const args = expr.args.map((arg) => c.value(arg));
  const span = expr.span;
  const callRow = expr.span.row;
  const res = callee.kind === 'path' ? c.annotations.paths.get(callee) : undefined;
  if (res?.kind === 'fn') {
    const { fn } = res;
    const typeArgs = res.typeArgs.map((arg) => runtimeType(arg));
    return (frame) => {
      const values = evaluateValues(frame, args);
      return c.support.callFn(
        fn,
        typeArgs.map((arg) => arg(frame)),
        values,
        callRow,
        span,
        frame
      );
    };
  }
  if (res?.kind === 'ctor') {
    const { def, variant } = res;
    return (frame) => {
      frame.runtime.allocate(args.length);
      return construct(def, variant, evaluateValues(frame, args));
    };
  }
  const calleeValue = c.annotations.callKinds.get(expr) === 'FnOnce' ? c.value(callee) : c.read(callee);
  const operands: Eval[] = [(frame) => derefAll(calleeValue(frame)), ...args];
  return (frame) => {
    const [fn, ...values] = evaluateValues(frame, operands);
    return c.support.callValue(fn instanceof DynValue ? fn.value : fn, values, callRow);
  };
}

export function compileMethodCall(c: Compiler, expr: ExprOf<'methodCall'>): Eval {
  const method = c.annotations.methods.get(expr);
  if (!method) throw new Error(`Unresolved method ${expr.method}`);
  const receiver = compileReceiver(c, expr, method);
  receiver.valueType = expr.receiver.ty;
  const args = [receiver, ...expr.args.map((arg) => c.value(arg))];
  const typeArgs = method.typeArgs.map((arg) => runtimeType(arg));
  const { fn } = method;
  const span = expr.methodSpan;
  const callRow = expr.span.row;
  return (frame) => {
    const values = evaluateValues(frame, args);
    return c.support.callFn(
      fn,
      typeArgs.map((arg) => arg(frame)),
      values,
      callRow,
      span,
      frame
    );
  };
}

/** The receiver a method takes, after the derefs and the reference its call adds. */
function compileReceiver(c: Compiler, expr: ExprOf<'methodCall'>, method: MethodRes): Eval {
  const adjust: ReceiverAdjust = method.receiver;
  const iterFrom = adjust.asIter ? runtimeType(stripRefs(expr.receiver.ty!)) : undefined;
  if (adjust.autoref === 'mut') {
    const place = placeThrough(c, expr.receiver, adjust.derefs);
    if (iterFrom) return (frame) => new CellPlace(c.support.toIter(place(frame).get(), iterFrom(frame)));
    return dropsTemporary(c, expr.receiver, adjust, place);
  }
  const byValue = adjust.autoref === 'none' && method.fn.selfMode === 'value' && adjust.derefs.length === 0;
  // rustc reborrows a `&mut` receiver rather than moving it out of its variable.
  const reborrowed = byValue && isMutReference(expr.receiver.ty);
  const read = byValue && !reborrowed ? c.value(expr.receiver) : valueThrough(c, expr.receiver, adjust.derefs);
  if (iterFrom) return (frame) => c.support.toIter(read(frame), iterFrom(frame));
  if (method.fn.selfMode === 'value' && adjust.autoref === 'none' && adjust.derefs.length > 0) {
    return derefedSelf(c, expr.receiver, adjust.derefs, read);
  }
  return read;
}

/** A receiver borrowed from a temporary value (`v.into_iter().next()`), which goes at the end of the statement. */
function dropsTemporary(c: Compiler, receiver: Expr, adjust: ReceiverAdjust, place: Eval): Eval {
  if (adjust.derefs.length > 0 || isPlaceExpr(receiver, c.annotations)) return place;
  const type = runtimeType(receiver.ty!);
  return (frame) => {
    const borrowed = place(frame) as Place;
    const { dropper } = frame.runtime;
    const temporaryType = type(frame);
    if (dropper?.needsDrop(temporaryType)) {
      frame.runtime.liveGuards.push({ release: () => dropper.drop(borrowed.get(), temporaryType) });
    }
    return borrowed;
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
