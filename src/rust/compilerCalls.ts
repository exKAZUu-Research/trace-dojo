import type { MethodRes, ReceiverAdjust } from './annotations';
import type { Expr } from './ast';
import type { Compiler, Eval } from './compiler';
import { construct, derefAll, isStringType, stripRefs } from './compilerCommon';
import { placeThrough, valueThrough } from './compilerPlaces';
import { copyValue, needsCopy } from './ops';
import { runtimeType } from './runtimeTypes';
import { type FnDef, resolve } from './types';
import { CellPlace, DynValue } from './values';

type ExprOf<K extends Expr['kind']> = Extract<Expr, { kind: K }>;

export function compileCall(c: Compiler, expr: ExprOf<'call'>): Eval {
  const { callee } = expr;
  const args = expr.args.map((arg) => c.value(arg));
  const span = expr.span;
  const callRow = expr.span.row;
  const res = callee.kind === 'path' ? c.annotations.paths.get(callee) : undefined;
  if (res?.kind === 'fn') {
    const { fn } = res;
    if ((fn as { nativeKey?: string }).nativeKey === 'Turtle::new') {
      return (frame) =>
        c.support.turtleNew(
          args.map((arg) => arg(frame)),
          span,
          frame
        );
    }
    const typeArgs = res.typeArgs.map((arg) => runtimeType(arg));
    return (frame) => {
      const values = args.map((arg) => arg(frame));
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
      return construct(
        def,
        variant,
        args.map((arg) => arg(frame))
      );
    };
  }
  const calleeValue = c.read(callee);
  return (frame) => {
    const fn = derefAll(calleeValue(frame));
    const values = args.map((arg) => arg(frame));
    return c.support.callValue(fn instanceof DynValue ? fn.value : fn, values, callRow);
  };
}

export function compileMethodCall(c: Compiler, expr: ExprOf<'methodCall'>): Eval {
  const method = c.annotations.methods.get(expr);
  if (!method) throw new Error(`Unresolved method ${expr.method}`);
  const receiver = compileReceiver(c, expr, method);
  const args = expr.args.map((arg) => c.value(arg));
  const typeArgs = method.typeArgs.map((arg) => runtimeType(arg));
  const { fn } = method;
  const span = expr.methodSpan;
  const callRow = expr.span.row;
  return (frame) => {
    const self = receiver(frame);
    const values = [self];
    for (const arg of args) values.push(arg(frame));
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
  // `String::capacity` reads where the string is stored, which keeps its capacity (a JS string cannot).
  if (adjust.autoref === 'mut' || (adjust.autoref === 'ref' && isStringCapacity(method.fn))) {
    const place = placeThrough(c, expr.receiver, adjust.derefs);
    if (iterFrom) return (frame) => new CellPlace(c.support.toIter(place(frame).get(), iterFrom(frame)));
    return place;
  }
  const byValue = adjust.autoref === 'none' && method.fn.selfMode === 'value' && adjust.derefs.length === 0;
  const read = byValue ? c.value(expr.receiver) : valueThrough(c, expr.receiver, adjust.derefs);
  if (iterFrom) return (frame) => c.support.toIter(read(frame), iterFrom(frame));
  const selfType = resolve(expr.receiver.ty!, true);
  if (method.fn.selfMode === 'value' && adjust.autoref === 'none' && adjust.derefs.length > 0 && needsCopy(selfType)) {
    return (frame) => copyValue(read(frame));
  }
  return read;
}

function isStringCapacity(fn: FnDef): boolean {
  return fn.name === 'capacity' && fn.impl !== undefined && isStringType(fn.impl.selfType);
}
