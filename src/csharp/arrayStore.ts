import { PendingException } from './numeric';
import { isReferenceType, type Type } from './types';
import type { CsArray, Value } from './values';

/** The runtime's type test that a store into an array needs. */
export interface InstanceTest {
  isInstanceOf(value: Value, type: Type): boolean;
}

/**
 * The check that every store into an array's element makes, from the program or a library native: a covariant array
 * (a `string[]` seen as `object[]`) holds only values of its runtime element type, so a store of another value fails
 * as .NET's does before it writes, and no later read of the array meets a value of the wrong type.
 */
export function checkElementStore(test: InstanceTest, array: CsArray, value: Value): void {
  const element = array.type.element;
  if (value !== undefined && isReferenceType(element) && !test.isInstanceOf(value, element))
    throw new PendingException(
      'System.ArrayTypeMismatchException',
      'Attempted to access an element as a type incompatible with the array.'
    );
}
