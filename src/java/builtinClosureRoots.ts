import { collectors } from './builtinCollectors';
import { functionalMethodOf } from './builtinFunctions';
import type { ClassInfo, NativeMethod } from './types';
import { JavaArray, JavaObject } from './values';

/**
 * Makes every builtin method that returns a function or a collector the library made, as `Predicate.isEqual`,
 * `Comparator.thenComparing`, or `Collectors.toMap` do, keep the receiver and the arguments it was made from
 * reachable: the host closure the result runs holds them out of the reachability walk's view, while the turtles they
 * reach must stay as long as the result can still run.
 */
export function retainClosureOperands(
  classes: Iterable<ClassInfo>,
  objectClass: ClassInfo,
  collectorClass: ClassInfo
): void {
  const makesClosures = (cls: ClassInfo): boolean =>
    cls === collectorClass || functionalMethodOf(cls, objectClass) !== undefined;
  for (const cls of classes) {
    for (const method of cls.methods) {
      const { native, returnType } = method;
      if (native && returnType.kind === 'class' && makesClosures(returnType.cls)) method.native = retaining(native);
    }
  }
}

function retaining(native: NativeMethod): NativeMethod {
  return (frame, receiver, args) => {
    const result = native(frame, receiver, args);
    if (!(result instanceof JavaObject)) return result;
    const operands = [receiver, ...args].filter((value) => value instanceof JavaObject || value instanceof JavaArray);
    // Only what the library made has nothing recorded yet; a program's lambda records its own captures.
    if (result.function && !result.function.captured) result.function.captured = operands;
    else if (collectors.has(result) && !result.retained) result.retained = operands;
    return result;
  };
}
