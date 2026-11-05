import { callFunction, functionObject } from './builtinFunctions';
import { classType, extendsOf, superOf } from './builtinStreamSupport';
import { addMethod } from './builtinSupport';
import { compareValues } from './builtinWrappers';
import { type Frame } from './runtime';
import { type ClassInfo, type JavaType, type TypeVariable } from './types';
import { type Value } from './values';

/**
 * The `Comparator` factories and defaults that take a comparator for the keys, `comparingLong`, `thenComparingLong`,
 * `nullsFirst`, `nullsLast`, and `Map.Entry.comparingByKey/comparingByValue` with a comparator.
 */
export function defineKeyComparators(
  cls: ClassInfo,
  t: JavaType,
  functions: { fn: ClassInfo; toLong: ClassInfo },
  entryClass: ClassInfo,
  objectType: JavaType
): void {
  const variable = (name: string): [TypeVariable, JavaType] => {
    const created: TypeVariable = { name, bounds: [objectType] };
    return [created, { kind: 'typeVar', variable: created }];
  };
  const compare = (frame: Frame, comparator: Value, a: Value, b: Value): number =>
    callFunction(frame, cls, comparator, [a, b]) as number;
  const byKey = (frame: Frame, key: Value, order: Value, a: Value, b: Value): number =>
    compare(frame, order, callFunction(frame, functions.fn, key, [a]), callFunction(frame, functions.fn, key, [b]));
  const [ct, ctType] = variable('T');
  const [cu, cuType] = variable('U');
  addMethod(
    cls,
    'comparing',
    [classType(functions.fn, superOf(ctType), extendsOf(cuType)), classType(cls, superOf(cuType))],
    classType(cls, ctType),
    true,
    (frame, _, [key, order]) => functionObject(frame, cls, (callFrame, [a, b]) => byKey(callFrame, key, order, a, b))
  ).typeParameters = [ct, cu];
  const [tu, tuType] = variable('U');
  addMethod(
    cls,
    'thenComparing',
    [classType(functions.fn, superOf(t), extendsOf(tuType)), classType(cls, superOf(tuType))],
    classType(cls, t),
    false,
    (frame, receiver, [key, order]) =>
      functionObject(frame, cls, (callFrame, [a, b]) => {
        const first = compare(callFrame, receiver, a, b);
        return first === 0 ? byKey(callFrame, key, order, a, b) : first;
      })
  ).typeParameters = [tu];
  const byLong = (frame: Frame, key: Value, a: Value, b: Value): number =>
    compareValues(callFunction(frame, functions.toLong, key, [a]), callFunction(frame, functions.toLong, key, [b]));
  const [lt, ltType] = variable('T');
  addMethod(
    cls,
    'comparingLong',
    [classType(functions.toLong, superOf(ltType))],
    classType(cls, ltType),
    true,
    (frame, _, [key]) => functionObject(frame, cls, (callFrame, [a, b]) => byLong(callFrame, key, a, b))
  ).typeParameters = [lt];
  addMethod(
    cls,
    'thenComparingLong',
    [classType(functions.toLong, superOf(t))],
    classType(cls, t),
    false,
    (frame, receiver, [key]) =>
      functionObject(frame, cls, (callFrame, [a, b]) => {
        const first = compare(callFrame, receiver, a, b);
        return first === 0 ? byLong(callFrame, key, a, b) : first;
      })
  );
  defineNullsAndEntryOrders(cls, entryClass, objectType);
}

/** `nullsFirst`, `nullsLast`, and `Map.Entry.comparingByKey/comparingByValue` with a comparator. */
// code-gauge-allow functionCognitiveComplexity 21 -- One registration per builtin method, each a small native.
function defineNullsAndEntryOrders(cls: ClassInfo, entryClass: ClassInfo, objectType: JavaType): void {
  const variable = (name: string): [TypeVariable, JavaType] => {
    const created: TypeVariable = { name, bounds: [objectType] };
    return [created, { kind: 'typeVar', variable: created }];
  };
  const compare = (frame: Frame, comparator: Value, a: Value, b: Value): number =>
    callFunction(frame, cls, comparator, [a, b]) as number;
  for (const [name, nullOrder] of [
    ['nullsFirst', -1],
    ['nullsLast', 1],
  ] as const) {
    const [nt, ntType] = variable('T');
    addMethod(cls, name, [classType(cls, superOf(ntType))], classType(cls, ntType), true, (frame, _, [order]) =>
      functionObject(frame, cls, (callFrame, [a, b]) => {
        if (a === undefined) return b === undefined ? 0 : nullOrder;
        if (b === undefined) return -nullOrder;
        // A null comparator leaves the non-null values equal, as the JDK's does.
        return order === undefined ? 0 : compare(callFrame, order, a, b);
      })
    ).typeParameters = [nt];
  }
  for (const [name, getter] of [
    ['comparingByKey', 'getKey'],
    ['comparingByValue', 'getValue'],
  ] as const) {
    const [k, kType] = variable('K');
    const [v, vType] = variable('V');
    addMethod(
      entryClass,
      name,
      [classType(cls, superOf(getter === 'getKey' ? kType : vType))],
      classType(cls, classType(entryClass, kType, vType)),
      true,
      (frame, _, [order]) =>
        functionObject(frame, cls, (callFrame, [a, b]) =>
          compare(
            callFrame,
            order,
            callFrame.runtime.invokeVirtual(callFrame, entryClass, getter, a, []),
            callFrame.runtime.invokeVirtual(callFrame, entryClass, getter, b, [])
          )
        )
    ).typeParameters = [k, v];
  }
}
