import type { Expression, Span } from '../ast';
import { FunctionInstance } from '../functions';
import { type Frame, withHeldValues } from '../runtime';
import {
  evaluateHeld,
  inMemoryCoercible,
  NATIVE_FN_TYPE,
  type NativeCall,
  NativeFn,
  type NativeSignature,
  runtime,
  type SemaApi,
  type TExpr,
  valueEvaluators,
} from '../semaBase';
import {
  type Decl,
  fnType,
  type Namespace,
  type StructField,
  type StructType,
  TYPE,
  type Type,
  typeName,
  VOID as VOID_TYPE,
} from '../types';
import {
  FnValue,
  NativeHandle,
  type NativeState,
  type Pointer,
  registerNativeReferences,
  type Value,
  type ZStruct,
} from '../values';
import { PUBLIC_STD_MEMBERS } from './publicMembers';

/** A declaration's type and value, which a native namespace resolves on first use. */
export interface Member {
  type: Type;
  value: Value;
  /** What learners call a member this grader does not run, which referring to it reports. */
  unavailable?: string;
}

/** A member of Zig's library that this grader does not run. */
export function unavailableMember(what: string): () => Member {
  return () => ({ type: TYPE, value: VOID_TYPE, unavailable: what });
}

/** A struct type whose declarations the grader implements, such as `std.mem` or `std.ArrayList(i32)`. */
export function nativeStruct(
  name: string,
  members: Record<string, () => Member>,
  fields: StructField[] = [],
  native?: StructType['native']
): StructType {
  const namespace: Namespace = { name, decls: new Map() };
  const type: StructType = {
    kind: 'struct',
    isTuple: false,
    namespace,
    layout: 'auto',
    fields,
    native,
  };
  addMembers(type, { ...unavailableDeclarations(name), ...members });
  return type;
}

export function unavailableDeclarations(name: string): Record<string, () => Member> {
  return Object.fromEntries(
    (publicMembers(name) ?? []).map((member) => [member, unavailableMember(`${name}.${member}`)])
  );
}

/** Adds declarations to a native struct, which may refer to the struct itself. */
export function addMembers(type: { namespace: Namespace }, members: Record<string, () => Member>): void {
  const allowed = publicMembers(type.namespace.name);
  for (const [key, resolve] of Object.entries(members)) {
    if (allowed && !allowed.includes(key)) continue;
    let resolved: Member | undefined;
    const decl: Decl = {
      kind: 'native',
      name: key,
      resolve: () => {
        resolved ??= resolve();
        return resolved;
      },
    };
    type.namespace.decls.set(key, decl);
  }
}

function publicMembers(name: string): readonly string[] | undefined {
  const base = name.split('(')[0];
  return Object.hasOwn(PUBLIC_STD_MEMBERS, base) ? PUBLIC_STD_MEMBERS[base] : undefined;
}

/** A namespace member that is a type. */
export function typeMember(type: () => Type): () => Member {
  return () => ({ type: TYPE, value: type() });
}

/** A namespace member that is a native function, analyzing its own calls. */
export function fnMember(
  name: string,
  compileCall: (sema: SemaApi, call: NativeCall) => TExpr,
  signature?: NativeSignature | (() => NativeSignature)
): () => Member {
  return () => {
    const concrete = typeof signature === 'function' ? signature() : signature;
    return {
      type: concrete?.type ?? NATIVE_FN_TYPE,
      value: new NativeFn(name, compileCall, concrete) as unknown as Value,
    };
  };
}

export function concreteFnMember(
  name: string,
  params: readonly Type[],
  returnType: Type,
  run: (args: Value[], frame: Frame) => Value
): () => Member {
  const instance = nativeFunction(name, params, returnType, (args, frame) => {
    frame.runtime.spend(args.length);
    return withHeldValues(frame, args, () => run(args, frame), params);
  });
  const value = new FnValue(instance);
  return () => ({ type: fnType(params, returnType), value });
}

export function constMember(type: Type, value: Value): () => Member {
  return () => ({ type, value });
}

/** Checks a native call's argument count. */
export function expectArgs(sema: SemaApi, call: NativeCall, count: number, name: string): readonly Expression[] {
  if (call.args.length !== count) {
    sema.error(call.span, `${name} の引数の数が合いません（${count} 個が必要ですが、${call.args.length} 個です）。`);
  }
  return call.args;
}

/** Compiles arguments with their expected types, coercing each. */
export function compileArgs(sema: SemaApi, args: readonly Expression[], types: readonly Type[]): TExpr[] {
  return args.map((arg, index) => sema.coerce(sema.compile(arg, types[index]), types[index], arg));
}

export function structReceiver(
  sema: SemaApi,
  call: Pick<NativeCall, 'receiver' | 'span'>,
  type: StructType,
  mutable: boolean
): (frame: Frame) => ZStruct {
  const receiver = call.receiver;
  if (!mutable && receiver?.type === type) return (frame) => receiver.eval(frame) as ZStruct;
  const evaluate = receiverAddress(sema, call, type, mutable).eval;
  return (frame) => (evaluate(frame) as Pointer).load() as ZStruct;
}

export function receiverAddress(
  sema: SemaApi,
  call: Pick<NativeCall, 'receiver' | 'span'>,
  type: StructType,
  mutable = true
): TExpr {
  const receiver = call.receiver;
  if (!receiver) return sema.error(call.span, `${typeName(type)} の値に対して呼び出してください。`);
  const pointer = receiver.type === type ? sema.addressOf(receiver) : receiver;
  if (pointer.type.kind !== 'pointer' || pointer.type.size !== 'one' || pointer.type.child !== type)
    return sema.error(call.span, `${typeName(type)} の値に対して呼び出してください。`);
  if (mutable && pointer.type.isConst) return sema.error(call.span, `定数の ${typeName(type)} は変更できません。`);
  return pointer;
}

export function callbackFunction(sema: SemaApi, value: TExpr, span: Span): ReturnType<SemaApi['functionOf']> {
  if (value.type.kind !== 'fn') return sema.error(span, '関数へのポインタではなく、関数の値を渡してください。');
  if (!value.known) return sema.error(span, 'コールバックの関数は、コンパイルのときに決まっていなければなりません。');
  return sema.functionOf(value, span);
}

export function checkCallback(
  sema: SemaApi,
  name: string,
  callback: { params: readonly Type[]; returnType: Type },
  expected: readonly Type[],
  result: Type,
  span: Span
): void {
  if (inMemoryCoercible(fnType(callback.params, callback.returnType), fnType(expected, result))) return;
  sema.error(span, `${name} に渡す関数は ${typeName(fnType(expected, result))} にしてください。`);
}

/** A call computed natively from its arguments' values at run time. */
export function nativeCall(
  type: Type,
  args: readonly TExpr[],
  span: Span,
  compute: (values: Value[], frame: Frame) => Value
): TExpr {
  const evaluators = valueEvaluators(args);
  return runtime(
    type,
    (frame) => {
      frame.runtime.spend();
      const values = evaluateHeld(frame, evaluators);
      return withHeldValues(
        frame,
        values,
        () => compute(values, frame),
        args.map((arg) => arg.type)
      );
    },
    span
  );
}

export function handle(kind: string, state: Record<string, unknown>): NativeHandle {
  return new NativeHandle(kind, state);
}

export function nativeStructCall(
  type: Type,
  args: readonly TExpr[],
  span: Span,
  receiver: { type: StructType; evaluate: (frame: Frame) => ZStruct },
  compute: (receiver: ZStruct, values: Value[], frame: Frame) => Value
): TExpr {
  return nativeStateCall(
    type,
    args,
    span,
    (frame) => {
      const state = { value: receiver.evaluate(frame) };
      registerNativeReferences(state, () => [{ value: state.value, type: receiver.type }]);
      return state;
    },
    (state, values, frame) => compute(state.value, values, frame)
  );
}

export function nativeStateCall<S extends NativeState>(
  type: Type,
  args: readonly TExpr[],
  span: Span,
  receiver: (frame: Frame) => S,
  compute: (state: S, values: Value[], frame: Frame) => Value
): TExpr {
  const evaluators = valueEvaluators(args);
  return runtime(
    type,
    (frame) => {
      frame.runtime.spend();
      const state = receiver(frame);
      return withHeldValues(frame, [new NativeHandle('methodReceiver', state)], () => {
        const values = evaluateHeld(frame, evaluators);
        return withHeldValues(
          frame,
          values,
          () => compute(state, values, frame),
          args.map((arg) => arg.type)
        );
      });
    },
    span
  );
}

/** A native function as a function value, for library functions that return functions such as `std.sort.asc`. */
export function nativeFunction(
  name: string,
  params: readonly Type[],
  returnType: Type,
  run: (args: Value[], frame: Frame) => Value,
  analyze?: (sema: SemaApi, span: Span) => void
): FunctionInstance {
  return new FunctionInstance(name, params, returnType, run, analyze);
}

/** The receiver of a native method, by value: a pointer receiver is dereferenced. */
export function receiverValue(value: Value): Value {
  return value;
}
