import { type Collections } from './builtinCollections';
import { addMethod, type Registry } from './builtinSupport';
import { type Wrappers } from './builtinWrappers';
import { type Frame, throwBuiltin } from './runtime';
import {
  type ClassInfo,
  type ClassType,
  type JavaType,
  type MethodInfo,
  type NativeMethod,
  type TypeVariable,
  type WildcardType,
} from './types';
import { JavaObject, type Value } from './values';

export interface Context {
  registry: Registry;
  objectClass: ClassInfo;
  objectType: JavaType;
  stringType: JavaType;
  collections: Collections;
  wrappers: Wrappers;
  fn: (name: string) => ClassInfo;
}

export const classType = (cls: ClassInfo, ...args: JavaType[]): ClassType => ({ kind: 'class', cls, args });
export const superOf = (bound: JavaType): WildcardType => ({ kind: 'wildcard', bound, isSuper: true });
export const extendsOf = (bound: JavaType): WildcardType => ({ kind: 'wildcard', bound, isSuper: false });
export const typeVariable = (name: string, bound: JavaType): TypeVariable => ({ name, bounds: [bound] });
export const variableType = (variable: TypeVariable): JavaType => ({ kind: 'typeVar', variable });

/** The elements a stream yields, one at a time, as each stage pulls them from the stage before. */
export type Source = () => Iterator<Value>;

/**
 * A stream's source, whether a stage has taken it, and for a stream whose size is known without traversing it, as
 * the JDK's SIZED streams, that size, read when the stream is consumed.
 */
interface StreamState {
  source: Source;
  isUsed: boolean;
  size?: () => bigint;
}

const sources = new WeakMap<JavaObject, StreamState>();

/**
 * A stream of the elements `source` yields, which keeps alive the objects in `retained` that hold its elements.
 *
 * @param size The number of elements, when it is known without traversing them.
 */
export function createStream(
  frame: Frame,
  cls: ClassInfo,
  source: Source,
  retained: Value[] = [],
  size?: () => bigint
): JavaObject {
  const object = frame.runtime.allocateObject(frame, cls);
  sources.set(object, { source, isUsed: false, size });
  object.retained = retained;
  return object;
}

/** Takes a stream's elements for its next stage, which Java allows only once per stream. */
export function take(frame: Frame, receiver: Value): Iterator<Value> {
  return claim(frame, receiver)();
}

/** Marks a stream as operated upon, returning its source for a later stage to traverse when it is consumed. */
export function claim(frame: Frame, receiver: Value): Source {
  const state = sources.get(receiver as JavaObject) as StreamState;
  if (state.isUsed) throwBuiltin(frame, 'IllegalStateException', 'stream has already been operated upon or closed');
  state.isUsed = true;
  return state.source;
}

export function* iterate(iterator: Iterator<Value>): Generator<Value> {
  for (let next = iterator.next(); !next.done; next = iterator.next()) yield next.value;
}

/**
 * Adds a stream operation as a default method of the interface, so that every stream object runs the same native.
 * A stream it returns keeps alive the functions and values passed to it, which its later stages call or read.
 */
export function op(
  cls: ClassInfo,
  name: string,
  parameterTypes: JavaType[],
  returnType: JavaType,
  native: NativeMethod,
  typeParameters?: TypeVariable[]
): MethodInfo {
  // Every function or collector an operation takes must be given when the operation is called, as in the JDK.
  const required = parameterTypes.flatMap((type, index) =>
    type.kind === 'class' && type.cls.kind === 'interface' ? [index] : []
  );
  const method = addMethod(cls, name, parameterTypes, returnType, false, (frame, receiver, args) => {
    if (required.some((index) => args[index] === undefined)) throwBuiltin(frame, 'NullPointerException');
    const result = native(frame, receiver, args);
    if (result instanceof JavaObject && sources.has(result)) result.retained?.push(...args);
    return result;
  });
  method.typeParameters = typeParameters;
  return method;
}

/** A stream whose elements `transform` derives from the elements of the stream `receiver`. */
export function derive(
  cls: ClassInfo,
  receiver: Value,
  frame: Frame,
  transform: (items: Iterator<Value>) => Iterator<Value>,
  resize?: true | ((size: bigint) => bigint)
): JavaObject {
  const upstreamSize = resize ? sources.get(receiver as JavaObject)?.size : undefined;
  // A stage that keeps the size (`true`) or changes it predictably, as `skip` does, keeps it known.
  const size =
    upstreamSize && (resize === true ? upstreamSize : () => (resize as (size: bigint) => bigint)(upstreamSize()));
  // The source is read only when the pipeline is consumed, so that changes made to a collection before then show.
  const upstream = claim(frame, receiver);
  return createStream(frame, cls, () => transform(upstream()), [receiver], size);
}

/**
 * `count`, which takes a stream's known size without running its stages, as the JDK counts a SIZED stream whose
 * stages, such as `map` and `peek`, keep the size, and counts the elements otherwise.
 */
export function countOf(frame: Frame, receiver: Value): bigint {
  const { size } = sources.get(receiver as JavaObject) as StreamState;
  const items = claim(frame, receiver);
  if (size) return size();
  let count = 0n;
  const iterator = items();
  while (!iterator.next().done) count++;
  return count;
}
