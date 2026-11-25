import type { NativeFunction, NativeProperty } from '../nativeTypes';
import type { Frame, SuspendInvoker } from '../runtime';
import type { ClassSymbol } from '../symbols';
import { KObject, type Value } from '../values';

/** The natives of the prelude, by the keys its `external` declarations name. */
export const nativeFunctions = new Map<string, NativeFunction>();
export const nativeProperties = new Map<string, NativeProperty>();

export function defineNative(key: string, native: NativeFunction): void {
  if (nativeFunctions.has(key)) throw new Error(`The native ${key} is defined twice`);
  nativeFunctions.set(key, native);
}

/** The natives of the prelude's `external suspend` functions, which suspend where their generators yield. */
export const suspendNatives = new Map<string, SuspendInvoker>();

export function defineSuspendNative(key: string, native: SuspendInvoker): void {
  suspendNatives.set(key, native);
}

export function defineNativeProperty(key: string, get: NativeProperty['get'], set?: NativeProperty['set']): void {
  nativeProperties.set(key, { get, set });
}

let classes: ReadonlyMap<string, ClassSymbol> | undefined;

/** Gives natives the library's classes once it is loaded. */
export function setLibraryClasses(byName: ReadonlyMap<string, ClassSymbol>): void {
  classes = byName;
}

/** A class of the library by its Kotlin name, such as `kotlin.collections.ArrayList`. */
export function libraryClass(kotlinName: string): ClassSymbol {
  const found = classes?.get(kotlinName);
  if (!found) throw new Error(`The library has no class ${kotlinName}`);
  return found;
}

/** Creates an instance of a native class of the library holding items, such as a list. */
export function newItems(frame: Frame, kotlinName: string, items: Value[]): KObject {
  frame.runtime.allocate(frame, items.length + 1);
  const object = new KObject(libraryClass(kotlinName), 0);
  object.items = items;
  object.modCount = 0;
  return object;
}

export function throwError(frame: Frame, qualifiedName: string, message?: string): never {
  return frame.runtime.throwError(frame, qualifiedName, message);
}

/**
 * How an object of a library class shows in a trace, which the class declares when its fields are how it is
 * implemented rather than what it holds: the elements of an array, or a map's entries.
 */
export type TraceShape = { kind: 'array'; items: Value[] } | { kind: 'map'; entries: { key: Value; value: Value }[] };

const traceShapes = new Map<string, (object: KObject) => TraceShape>();

/** Declares how the objects of a library class, by its Kotlin name, show in a trace. */
export function defineTraceShape(kotlinName: string, shape: (object: KObject) => TraceShape): void {
  traceShapes.set(kotlinName, shape);
}

export function traceShapeOf(object: KObject): TraceShape | undefined {
  return traceShapes.get(object.cls.kotlinName)?.(object);
}

/** A field of an object of a prelude class, by the name its declaration gives it. */
export function fieldValue(object: KObject, name: string): Value {
  for (let cls: ClassSymbol | undefined = object.cls; cls; cls = cls.superclass?.cls) {
    const field = cls.ownFields.find((property) => property.name === name);
    if (field) return object.fields[field.slot as number] as Value;
  }
  throw new Error(`The class ${object.cls.name} has no field ${name}`);
}
