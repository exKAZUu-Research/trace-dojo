import { isBoolean, isComplex, isFloat, isInteger, isString, type Type, underlying } from './types';
import { Complex, GoArray, GoStruct, type Value } from './values';

/** Makes the zero value of a type: false, 0, "", nil, or a struct or array of zero values. */
export function zeroValueOf(type: Type): () => Value {
  const under = underlying(type);
  switch (under.kind) {
    case 'basic': {
      if (isBoolean(under)) return () => false;
      if (isString(under)) return () => '';
      if (isInteger(under)) return () => 0n;
      if (isFloat(under)) return () => 0;
      if (isComplex(under)) return () => new Complex(0, 0);
      return () => {};
    }
    case 'struct': {
      const zeros = under.fields.map((field) => zeroValueOf(field.type));
      return () => new GoStruct(zeros.map((zero) => zero()));
    }
    case 'array': {
      const zero = zeroValueOf(under.element);
      const { length } = under;
      return () => new GoArray(Array.from({ length }, zero));
    }
    default: {
      return () => {};
    }
  }
}
