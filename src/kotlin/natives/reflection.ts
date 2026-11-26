import { runtimeClassOf } from '../dispatch';
import { stringHash } from '../format';
import type { ClassSymbol } from '../symbols';
import { KObject, NULL, type Value } from '../values';
import { defineNative, defineNativeProperty, libraryClass } from './registry';

/** The classes that Kotlin maps to JVM classes of its own, whose `KClass` tells their Kotlin names. */
const MAPPED_CLASSES = new Set([
  'kotlin.Any',
  'kotlin.String',
  'kotlin.CharSequence',
  'kotlin.Number',
  'kotlin.Int',
  'kotlin.Long',
  'kotlin.Short',
  'kotlin.Byte',
  'kotlin.Double',
  'kotlin.Float',
  'kotlin.Char',
  'kotlin.Boolean',
  'kotlin.Unit',
  'kotlin.Comparable',
  'kotlin.Throwable',
  'kotlin.Enum',
  'kotlin.Annotation',
  'kotlin.Array',
  'kotlin.IntArray',
  'kotlin.LongArray',
  'kotlin.ShortArray',
  'kotlin.ByteArray',
  'kotlin.DoubleArray',
  'kotlin.FloatArray',
  'kotlin.CharArray',
  'kotlin.BooleanArray',
  'kotlin.collections.Iterable',
  'kotlin.collections.MutableIterable',
  'kotlin.collections.Collection',
  'kotlin.collections.MutableCollection',
  'kotlin.collections.List',
  'kotlin.collections.MutableList',
  'kotlin.collections.Set',
  'kotlin.collections.MutableSet',
  'kotlin.collections.Map',
  'kotlin.collections.MutableMap',
  'kotlin.collections.Iterator',
  'kotlin.collections.MutableIterator',
  'kotlin.collections.ListIterator',
  'kotlin.collections.MutableListIterator',
]);

/** What a `KClass` stands for: a class, or `Nothing`, which the JVM represents by `java.lang.Void`. */
export type ClassReference = { cls: ClassSymbol } | { nothing: true };

export function classReference(reference: ClassReference): KObject {
  const value = new KObject(libraryClass('kotlin.reflect.KClass'), 0);
  value.native = { reference };
  return value;
}

function referenceOf(value: Value): ClassReference {
  return (value as KObject).native?.reference as ClassReference;
}

function simpleName(reference: ClassReference): string | undefined {
  if ('nothing' in reference) return 'Void';
  return reference.cls.isAnonymous ? undefined : reference.cls.name;
}

function qualifiedName(reference: ClassReference): string | undefined {
  if ('nothing' in reference) return 'java.lang.Void';
  const { cls } = reference;
  if (cls.isAnonymous || cls.isLocal) return undefined;
  if (!cls.isLibrary || MAPPED_CLASSES.has(cls.kotlinName)) return cls.kotlinName;
  return cls.qualifiedName.replaceAll('$', '.');
}

/** The name `toString` of a `KClass` tells, which is the JVM's binary name for a class that Kotlin does not map. */
function binaryName(reference: ClassReference): string {
  if ('nothing' in reference) return 'java.lang.Void';
  const { cls } = reference;
  return cls.isLibrary && MAPPED_CLASSES.has(cls.kotlinName) ? cls.kotlinName : cls.qualifiedName;
}

function isSameReference(a: ClassReference, b: ClassReference): boolean {
  if ('nothing' in a || 'nothing' in b) return 'nothing' in a && 'nothing' in b;
  return a.cls === b.cls;
}

defineNativeProperty(
  'kotlin.reflect.KClass.simpleName',
  (_frame, receiver) => simpleName(referenceOf(receiver)) ?? NULL
);
defineNativeProperty(
  'kotlin.reflect.KClass.qualifiedName',
  (_frame, receiver) => qualifiedName(referenceOf(receiver)) ?? NULL
);
defineNative('kotlin.reflect.KClass.isInstance(Any?)', (_frame, receiver, [value]) => {
  const reference = referenceOf(receiver);
  if (value === NULL || 'nothing' in reference) return false;
  return runtimeClassOf(value).isSubclassOf(reference.cls);
});
defineNative('kotlin.reflect.KClass.equals(Any?)', (_frame, receiver, [other]) => {
  if (!(other instanceof KObject) || other.cls !== libraryClass('kotlin.reflect.KClass')) return false;
  return isSameReference(referenceOf(receiver), referenceOf(other));
});
defineNative('kotlin.reflect.KClass.hashCode()', (frame, receiver) =>
  stringHash(binaryName(referenceOf(receiver)), frame)
);
defineNative('kotlin.reflect.KClass.toString()', (_frame, receiver) => `class ${binaryName(referenceOf(receiver))}`);
