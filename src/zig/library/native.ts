import type { Expression, Span } from '../ast';
import { FunctionInstance } from '../functions';
import { type Frame, withHeldValues } from '../runtime';
import {
  copyForFrame,
  evaluateHeld,
  known,
  NATIVE_FN_TYPE,
  type NativeCall,
  NativeFn,
  runtime,
  type SemaApi,
  type TExpr,
} from '../semaBase';
import {
  type Decl,
  type Namespace,
  type StructField,
  type StructType,
  TYPE,
  type Type,
  VOID as VOID_TYPE,
} from '../types';
import { NativeHandle, type NativeState, type Value } from '../values';
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
  const base = name.split('(')[0];
  return Object.fromEntries(
    (PUBLIC_STD_MEMBERS[base] ?? []).map((member) => [member, unavailableMember(`${name}.${member}`)])
  );
}

/** Adds declarations to a native struct, which may refer to the struct itself. */
export function addMembers(type: { namespace: Namespace }, members: Record<string, () => Member>): void {
  for (const [key, resolve] of Object.entries(members)) {
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

/** A namespace member that is a type. */
export function typeMember(type: () => Type): () => Member {
  return () => ({ type: TYPE, value: type() });
}

/** A namespace member that is a native function, analyzing its own calls. */
export function fnMember(name: string, compileCall: (sema: SemaApi, call: NativeCall) => TExpr): () => Member {
  return () => ({
    type: NATIVE_FN_TYPE,
    value: new NativeFn(name, compileCall) as unknown as Value,
  });
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

/** A call computed natively from its arguments' values at run time. */
export function nativeCall(
  type: Type,
  args: readonly TExpr[],
  span: Span,
  compute: (values: Value[], frame: Frame) => Value
): TExpr {
  const evaluators = args.map((arg) => (frame: Frame) => copyForFrame(frame, arg.eval(frame), arg.type));
  return runtime(
    type,
    (frame) => {
      frame.runtime.spend();
      const values = evaluateHeld(frame, evaluators);
      return withHeldValues(frame, values, () => compute(values, frame));
    },
    span
  );
}

/** A call computed at compile time when every argument is known, else at run time. */
export function pureCall(type: Type, args: readonly TExpr[], span: Span, compute: (values: Value[]) => Value): TExpr {
  if (args.every((arg) => arg.known)) return known(type, compute(args.map((arg) => arg.value)), span);
  return nativeCall(type, args, span, (values) => compute(values));
}

export function handle(kind: string, state: Record<string, unknown>): NativeHandle {
  return new NativeHandle(kind, state);
}

export function nativeStateCall<S extends NativeState>(
  type: Type,
  args: readonly TExpr[],
  span: Span,
  receiver: (frame: Frame) => S,
  compute: (state: S, values: Value[], frame: Frame) => Value
): TExpr {
  const evaluators = args.map((arg) => (frame: Frame) => copyForFrame(frame, arg.eval(frame), arg.type));
  return runtime(
    type,
    (frame) => {
      frame.runtime.spend();
      const state = receiver(frame);
      return withHeldValues(frame, [new NativeHandle('methodReceiver', state)], () => {
        const values = evaluateHeld(frame, evaluators);
        return withHeldValues(frame, values, () => compute(state, values, frame));
      });
    },
    span
  );
}

/** A native function as a function value, for library functions that return functions such as `std.sort.asc`. */
export function nativeFunction(
  name: string,
  params: Type[],
  returnType: Type,
  run: (args: Value[], frame: Frame) => Value
): FunctionInstance {
  return new FunctionInstance(name, params, returnType, run);
}

/** The receiver of a native method, by value: a pointer receiver is dereferenced. */
export function receiverValue(value: Value): Value {
  return value;
}
