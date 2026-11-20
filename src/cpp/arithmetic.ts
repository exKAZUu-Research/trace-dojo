import { binaryOperation, convertScalar, type Scalar } from '../c/arith';
import type { BinaryOperator } from '../c/ast';
import type { CType, FloatType, IntType } from '../c/types';
import { FloatNaN } from './floatSign';

export type NumericValue = Scalar | FloatNaN;

export function arithmeticOperation(operator: BinaryOperator, type: IntType | FloatType) {
  const operation = binaryOperation(operator, type);
  if (type.kind === 'int')
    return (a: NumericValue, b: NumericValue): NumericValue => operation(a as Scalar, b as Scalar);
  return (a: NumericValue, b: NumericValue): NumericValue => {
    const left = Number(a);
    const result = operation(left, Number(b));
    if (Number.isNaN(result)) {
      if (a instanceof FloatNaN) return a;
      if (b instanceof FloatNaN && !Number.isNaN(left)) return b;
    }
    return result;
  };
}

export function convertNumeric(value: NumericValue, from: CType, to: CType): NumericValue {
  if (!(value instanceof FloatNaN)) return convertScalar(value, from, to);
  if (to.kind !== 'float') return convertScalar(Number.NaN, from, to);
  return (from.kind === 'float' && from.name === 'float') === (to.name === 'float')
    ? value
    : value.convertWidth(to.name === 'float');
}
