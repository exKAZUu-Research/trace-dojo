import { fitsElement, runtimeClassNameOf, typeClassName } from './builtinClass';
import { addMethod } from './builtinSupport';
import { type Frame, throwBuiltin } from './runtime';
import { type ClassInfo, INT, isPrimitive, type JavaType, VOID } from './types';
import { JavaArray, type Value } from './values';

/**
 * `System.arraycopy`, which checks its arrays and range as HotSpot does, with its messages, copies as if through a
 * temporary array, so that overlapping ranges of one array copy correctly, and checks each reference it stores, so that
 * a failing store leaves the elements before it copied.
 */
export function defineArrayCopy(systemClass: ClassInfo, objectType: JavaType): void {
  addMethod(
    systemClass,
    'arraycopy',
    [objectType, INT, objectType, INT, INT],
    VOID,
    true,
    (frame, _, [source, sourcePosition, target, targetPosition, length]) => {
      const [from, to] = checkedArrays(frame, source, target);
      checkRange(frame, from, sourcePosition as number, to, targetPosition as number, length as number);
      const copied = from.values.slice(sourcePosition as number, (sourcePosition as number) + (length as number));
      frame.runtime.spend(Math.ceil(copied.length / 64));
      const checksStores = !isPrimitive(to.elementType);
      for (const [offset, value] of copied.entries()) {
        if (checksStores) checkElement(frame, from, to, value);
        to.values[(targetPosition as number) + offset] = value;
      }
    }
  );
}

function checkedArrays(frame: Frame, source: Value, target: Value): [JavaArray, JavaArray] {
  if (source === undefined || target === undefined) return throwBuiltin(frame, 'NullPointerException');
  if (!(source instanceof JavaArray)) {
    return throwBuiltin(
      frame,
      'ArrayStoreException',
      `arraycopy: source type ${runtimeClassNameOf(frame, source)} is not an array`
    );
  }
  if (!(target instanceof JavaArray)) {
    return throwBuiltin(
      frame,
      'ArrayStoreException',
      `arraycopy: destination type ${runtimeClassNameOf(frame, target)} is not an array`
    );
  }
  const [fromPrimitive, toPrimitive] = [isPrimitive(source.elementType), isPrimitive(target.elementType)];
  if (
    (fromPrimitive || toPrimitive) &&
    (fromPrimitive !== toPrimitive || source.elementType.kind !== target.elementType.kind)
  ) {
    throwBuiltin(
      frame,
      'ArrayStoreException',
      `arraycopy: type mismatch: can not copy ${arrayName(source, '[]')} into ${arrayName(target, '[]')}`
    );
  }
  return [source, target];
}

function checkRange(
  frame: Frame,
  from: JavaArray,
  sourcePosition: number,
  to: JavaArray,
  targetPosition: number,
  length: number
): void {
  const outOfBounds = (message: string): never =>
    throwBuiltin(frame, 'ArrayIndexOutOfBoundsException', `arraycopy: ${message}`);
  if (sourcePosition < 0) outOfBounds(`source index ${sourcePosition} out of bounds for ${sized(from)}`);
  if (targetPosition < 0) outOfBounds(`destination index ${targetPosition} out of bounds for ${sized(to)}`);
  if (length < 0) outOfBounds(`length ${length} is negative`);
  if (sourcePosition + length > from.values.length) {
    outOfBounds(`last source index ${sourcePosition + length} out of bounds for ${sized(from)}`);
  }
  if (targetPosition + length > to.values.length) {
    outOfBounds(`last destination index ${targetPosition + length} out of bounds for ${sized(to)}`);
  }
}

/** An array with its length as HotSpot's messages name it, such as `int[3]` or `object array[2]`. */
export function sized(array: JavaArray): string {
  return arrayName(array, `[${array.values.length}]`);
}

/** An array as HotSpot names it in these messages: `int` and the like for primitives, `object array` for others. */
function arrayName(array: JavaArray, suffix: string): string {
  return `${isPrimitive(array.elementType) ? array.elementType.kind : 'object array'}${suffix}`;
}

function checkElement(frame: Frame, from: JavaArray, to: JavaArray, value: Value): void {
  if (fitsElement(frame, to.elementType, value)) return;
  const [source, target] = [typeClassName(frame, from.elementType), typeClassName(frame, to.elementType)];
  throwBuiltin(
    frame,
    'ArrayStoreException',
    `arraycopy: element type mismatch: can not cast one of the elements of ${source}[] to the type of the destination array, ${target}`
  );
}
