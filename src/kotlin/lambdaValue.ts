import type { Eval, Repr } from './compilerBase';
import { callFunction } from './dispatch';
import { libraryClass } from './natives/registry';
import type { Frame, FunctionInfo } from './runtime';
import type { ClassSymbol } from './symbols';
import { Boxed, KObject, type Value } from './values';

/**
 * Makes a lambda's function value, which captures its environment and calls the lambda's body with the receiver and
 * the arguments, unboxing those that the lambda holds as primitives.
 */
export function lambdaValue(lambda: {
  captureBuilder: (frame: Frame) => unknown[];
  info: FunctionInfo;
  arity: number;
  hasReceiver: boolean;
  receiverIsUnboxed: boolean;
  paramReprs: Repr[];
  nonNullParameters: boolean[];
  resultEval: Eval;
  functionClass: ClassSymbol;
}): Eval {
  const { captureBuilder, info, arity, hasReceiver, receiverIsUnboxed, paramReprs, resultEval, functionClass } = lambda;
  return (frame) => {
    const env = captureBuilder(frame);
    const value = new KObject(functionClass, 0);
    value.env = env;
    value.function = {
      arity,
      call: (caller, args) => {
        if (args.some((value, index) => value === undefined && lambda.nonNullParameters[index]))
          caller.runtime.throwError(caller, 'java.lang.NullPointerException');
        const receiver = hasReceiver ? unboxedIf(receiverIsUnboxed, args[0]) : undefined;
        const values = hasReceiver ? args.slice(1) : args;
        const converted = values.map((arg, index) => unboxedIf(paramReprs[index] !== 'ref', arg));
        return frame.runtime.call(info, caller, env, receiver, converted, undefined, resultEval, frame);
      },
    };
    return value;
  };
}

/** Calls a function value with arguments held as references. */
export function invokeFunctionValue(frame: Frame, fn: KObject, args: Value[]): Value {
  // A function-valued property read before its initializer ran, as a superclass initializer may, holds null.
  if ((fn as KObject | undefined) === undefined)
    return frame.runtime.throwError(frame, 'java.lang.NullPointerException');
  const { function: callable } = fn;
  if (!callable) return invokeFunctionObject(frame, fn, args);
  return callable.call(frame, args);
}

/** Calls an instance of a class that implements a function type, as `class Twice : (Int) -> Int` does, by its `invoke`. */
function invokeFunctionObject(frame: Frame, fn: KObject, args: Value[]): Value {
  const invoke = libraryClass(`kotlin.jvm.functions.Function${args.length}`).members.get('invoke')?.[0];
  if (invoke?.kind !== 'function') throw new Error('A function value without its function');
  return callFunction(invoke, frame, fn, args, undefined);
}

/** Function values receive their arguments boxed, while a parameter of a primitive type holds the bare value. */
function unboxedIf(unboxed: boolean, value: Value): Value {
  return unboxed && value instanceof Boxed ? value.value : value;
}
