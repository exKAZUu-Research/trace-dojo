import { libraryReceiver, unsupportedReceiver } from '../libraryReceivers';
import { getItem, iterate } from '../objects';
import { typeError, typeName } from '../types';
import { DONE, PyDict, type PyValue } from '../values';

const isDict = (value: PyValue): value is PyDict => value instanceof PyDict;

/** The receiver of a Counter method whose body in collections/__init__.py first reads `attribute` from `self`. */
export function counterReceiver(self: PyValue, method: string, attribute = 'items'): PyDict {
  return libraryReceiver(self, isDict, attribute, `Counter.${method}`);
}

/** The receiver of an in-place operator, whose body first reads `self[key]` for the first key of the other operand. */
export function inPlaceReceiver(self: PyValue, firstKey: PyValue | undefined, method: string): PyDict {
  if (self instanceof PyDict) return self;
  if (firstKey !== undefined) getItem(self, firstKey);
  throw unsupportedReceiver(self, `Counter.${method}`);
}

/** The receiver of a comparison, whose body first reads `self[element]` for each element of `self`. */
export function comparedReceiver(self: PyValue, method: string): PyDict {
  if (self instanceof PyDict) return self;
  const first = iterate(self)();
  if (first !== DONE) getItem(self, first);
  throw unsupportedReceiver(self, `Counter.${method}`);
}

/** The error of the `super()` call in a Counter method whose receiver is not a Counter. */
export function superError(self: PyValue): Error {
  return typeError(
    `super(type, obj): obj (instance of ${typeName(self)}) is not an instance or subtype of type (Counter).`
  );
}
