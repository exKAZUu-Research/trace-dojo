import type { StackBuffers } from './runtime';
import { nilPointerPanic } from './runtimeErrors';
import { funcType, lookupFieldOrMethod, type Method, type Type, underlying } from './types';
import { copyValue, type GoStruct, type Iface, Pointer, type Value } from './values';

/** Stands for a method with a pointer receiver, for reaching an embedded field's address. */
export const POINTER_METHOD: Method = { name: '', pointerReceiver: true, type: funcType([], []) };

export type BoundCall = (
  receiver: Value,
  args: Value[],
  callRow?: number,
  deferredFor?: unknown,
  stackBuffers?: StackBuffers
) => Value | Value[];

/** Calls a method's code with a receiver of the right form: a pointer for pointer receivers, a copy otherwise. */
export function invokeMethod(
  method: Method,
  receiver: Value,
  args: Value[],
  callRow?: number,
  deferredFor?: unknown,
  stackBuffers?: StackBuffers
): Value | Value[] {
  const call = method.code?.call as BoundCall | undefined;
  if (!call) throw new Error(`Method ${method.name} has no code`);
  return call(receiver, args, callRow, deferredFor, stackBuffers);
}

/**
 * Walks embedded fields from a receiver value to the value that declares the method, dereferencing pointers along
 * the way, and then adapts it to the method's receiver.
 */
export function receiverFor(value: Value, path: readonly number[], method: Method, viaPointer = false): Value {
  if (method.pointerReceiver) return pointerAwareReceiver(value, path);
  const current = walk(value, path);
  if (current instanceof Pointer) return copyValue(current.load());
  // A value method called through a nil pointer dereferences it, which panics.
  if (current === undefined && (path.length > 0 || viaPointer)) nilPointerPanic();
  return copyValue(current);
}

const dispatchCache = new WeakMap<Type, Map<string, BoundCall | undefined>>();

/** A call of the method that a dynamic type provides, as calling through an interface does. */
export function dynamicMethod(type: Type, name: string): BoundCall | undefined {
  let methods = dispatchCache.get(type);
  if (!methods) {
    methods = new Map();
    dispatchCache.set(type, methods);
  }
  if (methods.has(name)) return methods.get(name);
  const selection = lookupFieldOrMethod(type, name);
  let call: BoundCall | undefined;
  if (selection.kind === 'method') {
    const { method, path } = selection;
    call = (receiver, args, callRow, deferredFor) =>
      invokeMethod(
        method,
        receiverFor(receiver, path, method, underlying(type).kind === 'pointer'),
        args,
        callRow,
        deferredFor
      );
  } else if (selection.kind === 'interfaceMethod') {
    const { path } = selection;
    call = (receiver, args, callRow, deferredFor) => {
      const inner = walk(receiver, path) as Iface | undefined;
      if (!inner) nilPointerPanic();
      const target = dynamicMethod(inner.type, name);
      if (!target) throw new Error(`Missing method ${name}`);
      return target(inner.value, args, callRow, deferredFor);
    };
  }
  methods.set(name, call);
  return call;
}

/** The receiver for a promoted method, taking the address of an embedded value field when the method needs one. */
function pointerAwareReceiver(receiver: Value, path: readonly number[]): Value {
  if (path.length === 0) return receiver;
  let current: Value = receiver;
  let container: Value[] | undefined;
  let key = 0;
  for (const index of path) {
    if (current instanceof Pointer) current = current.load();
    else if (current === undefined) nilPointerPanic();
    container = (current as GoStruct).fields;
    key = index;
    current = container[index];
  }
  if (current instanceof Pointer || current === undefined) return current;
  return new Pointer(container as Value[], key);
}

function walk(value: Value, path: readonly number[]): Value {
  let current = value;
  for (const index of path) {
    if (current instanceof Pointer) current = current.load();
    else if (current === undefined) nilPointerPanic();
    current = (current as GoStruct).fields[index];
  }
  return current;
}

/** Calls a method of an interface value's dynamic type by name, for the library's use of `String` and `Error`. */
export function callDynamic(iface: Iface, name: string, args: Value[] = []): Value | Value[] {
  const call = dynamicMethod(iface.type, name);
  if (!call) throw new Error(`Missing method ${name}`);
  return call(iface.value, args);
}
