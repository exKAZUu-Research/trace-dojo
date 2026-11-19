import type { NativeFunction, NativeProperty } from '../nativeTypes';
import type { Frame } from '../runtime';
import type { ClassSymbol } from '../symbols';
import { KObject, type Value } from '../values';

/** The natives of the prelude, by the keys its `external` declarations name. */
export const nativeFunctions = new Map<string, NativeFunction>();
export const nativeProperties = new Map<string, NativeProperty>();

export function defineNative(key: string, native: NativeFunction): void {
  if (nativeFunctions.has(key)) throw new Error(`The native ${key} is defined twice`);
  nativeFunctions.set(key, native);
}

export function defineNatives(natives: Record<string, NativeFunction>): void {
  for (const [key, native] of Object.entries(natives)) defineNative(key, native);
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
