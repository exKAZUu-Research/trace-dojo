import { builtinClass, defineMethod, typeClass } from './types';
import { UnsupportedFeatureError } from './unsupported';
import { PyOpaque, type PyValue } from './values';

/**
 * The class of a value CPython has but this grader cannot reproduce, such as a file path, which a program may hold and
 * pass around but not look into.
 */
const unavailableClass = builtinClass('unavailable');
/** The metaclass of that class, so that showing the type of such a value stops the program too. */
const unavailableType = builtinClass('unavailable_type', typeClass);
unavailableClass.cls = unavailableType;
defineMethod(unavailableType, '__repr__', () => {
  throw new UnsupportedFeatureError('CPython の内部の値の型');
});

const OPERATIONS = [
  '__repr__',
  '__str__',
  '__format__',
  '__bool__',
  '__len__',
  '__iter__',
  '__contains__',
  '__getitem__',
  '__hash__',
  '__eq__',
  '__ne__',
  '__lt__',
  '__le__',
  '__gt__',
  '__ge__',
  '__add__',
  '__radd__',
  '__mul__',
  '__rmul__',
  '__mod__',
  '__getattr__',
];

for (const name of OPERATIONS) {
  defineMethod(unavailableClass, name, (self) => {
    throw new UnsupportedFeatureError((self as PyOpaque).text);
  });
}

/** A value whose use stops the program with an UnsupportedFeatureError naming `feature`. */
export function unavailableValue(feature: string): PyValue {
  return new PyOpaque(unavailableClass, feature);
}

/** Whether a value stands for one this grader cannot reproduce, which has no attributes a program could read. */
export function isUnavailable(value: PyValue): boolean {
  return value instanceof PyOpaque && value.cls === unavailableClass;
}
