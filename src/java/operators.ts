import type { BinaryOperator } from './ast';
import { type Builtins, stringify } from './builtins';
import { type Frame, throwBuiltin } from './runtime';
import {
  BOOLEAN,
  type ClassInfo,
  DOUBLE,
  INT,
  isCastable,
  isIntegral,
  isNumeric,
  isReference,
  isSubclass,
  isWidening,
  type JavaType,
  sameType,
  typeName,
} from './types';
import { doubleToInt, JavaArray, JavaObject, JavaString, toInt32, type Value } from './values';

export interface Operation<Operands extends unknown[]> {
  type: JavaType;
  apply: (frame: Frame, ...operands: Operands) => Value;
}

type BinaryOperation = Operation<[left: Value, right: Value]>;

/** Types a binary operator, returning `undefined` when Java rejects the operand types. */
export function binaryOperation(
  builtins: Builtins,
  operator: BinaryOperator,
  left: JavaType,
  right: JavaType
): BinaryOperation | undefined {
  const isString = (type: JavaType): boolean => type.kind === 'class' && type.cls === builtins.stringClass;
  if (operator === '+' && (isString(left) || isString(right))) {
    return left.kind === 'void' || right.kind === 'void' ? undefined : concatenation(builtins, left, right);
  }
  switch (operator) {
    case '+':
    case '-':
    case '*':
    case '/':
    case '%': {
      return arithmetic(operator, left, right);
    }
    case '<<':
    case '>>':
    case '>>>': {
      return shift(operator, left, right);
    }
    case '<':
    case '>':
    case '<=':
    case '>=': {
      return comparison(operator, left, right);
    }
    case '==':
    case '!=': {
      return equality(builtins.objectClass, operator, left, right);
    }
    case '&&':
    case '||': {
      // Short-circuit operators evaluate their operands themselves, so only their type matters here.
      return left.kind === 'boolean' && right.kind === 'boolean' ? { type: BOOLEAN, apply: () => false } : undefined;
    }
    case '&':
    case '|':
    case '^': {
      return bitwise(operator, left, right);
    }
  }
}

function concatenation(builtins: Builtins, leftType: JavaType, rightType: JavaType): BinaryOperation {
  return {
    type: builtins.stringClass.type,
    apply: (frame, left, right) => {
      const text = stringify(frame, left, leftType) + stringify(frame, right, rightType);
      frame.runtime.spend(Math.ceil(text.length / 256));
      return new JavaString(text);
    },
  };
}

function arithmetic(
  operator: '+' | '-' | '*' | '/' | '%',
  left: JavaType,
  right: JavaType
): BinaryOperation | undefined {
  if (!isNumeric(left) || !isNumeric(right)) return undefined;
  const isDouble = left.kind === 'double' || right.kind === 'double';
  return { type: isDouble ? DOUBLE : INT, apply: isDouble ? doubleArithmetic(operator) : intArithmetic(operator) };
}

function intArithmetic(operator: '+' | '-' | '*' | '/' | '%'): BinaryOperation['apply'] {
  switch (operator) {
    case '+': {
      return (_, a, b) => toInt32((a as number) + (b as number));
    }
    case '-': {
      return (_, a, b) => toInt32((a as number) - (b as number));
    }
    case '*': {
      return (_, a, b) => Math.imul(a as number, b as number);
    }
    case '/': {
      return (frame, a, b) => {
        if (b === 0) throwBuiltin(frame, 'ArithmeticException', '/ by zero');
        return toInt32((a as number) / (b as number));
      };
    }
    case '%': {
      return (frame, a, b) => {
        if (b === 0) throwBuiltin(frame, 'ArithmeticException', '/ by zero');
        return toInt32((a as number) % (b as number));
      };
    }
  }
}

function doubleArithmetic(operator: '+' | '-' | '*' | '/' | '%'): BinaryOperation['apply'] {
  const apply = {
    '+': (a: number, b: number) => a + b,
    '-': (a: number, b: number) => a - b,
    '*': (a: number, b: number) => a * b,
    '/': (a: number, b: number) => a / b,
    '%': (a: number, b: number) => a % b,
  }[operator];
  return (_, a, b) => apply(a as number, b as number);
}

function shift(operator: '<<' | '>>' | '>>>', left: JavaType, right: JavaType): BinaryOperation | undefined {
  if (!isIntegral(left) || !isIntegral(right)) return undefined;
  const apply = {
    '<<': (a: number, b: number) => a << b,
    '>>': (a: number, b: number) => a >> b,
    '>>>': (a: number, b: number) => toInt32(a >>> b),
  }[operator];
  return { type: INT, apply: (_, a, b) => apply(a as number, b as number) };
}

function comparison(operator: '<' | '>' | '<=' | '>=', left: JavaType, right: JavaType): BinaryOperation | undefined {
  if (!isNumeric(left) || !isNumeric(right)) return undefined;
  const apply = {
    '<': (a: number, b: number) => a < b,
    '>': (a: number, b: number) => a > b,
    '<=': (a: number, b: number) => a <= b,
    '>=': (a: number, b: number) => a >= b,
  }[operator];
  return { type: BOOLEAN, apply: (_, a, b) => apply(a as number, b as number) };
}

function equality(
  objectClass: ClassInfo,
  operator: '==' | '!=',
  left: JavaType,
  right: JavaType
): BinaryOperation | undefined {
  const comparable =
    (isNumeric(left) && isNumeric(right)) ||
    (left.kind === 'boolean' && right.kind === 'boolean') ||
    (isReference(left) && isReference(right) && isCastable(left, right, objectClass));
  if (!comparable) return undefined;
  const isEqual = operator === '==';
  return { type: BOOLEAN, apply: (_, a, b) => (a === b) === isEqual };
}

function bitwise(operator: '&' | '|' | '^', left: JavaType, right: JavaType): BinaryOperation | undefined {
  if (left.kind === 'boolean' && right.kind === 'boolean') {
    const apply = {
      '&': (a: boolean, b: boolean) => a && b,
      '|': (a: boolean, b: boolean) => a || b,
      '^': (a: boolean, b: boolean) => a !== b,
    }[operator];
    return { type: BOOLEAN, apply: (_, a, b) => apply(a as boolean, b as boolean) };
  }
  if (!isIntegral(left) || !isIntegral(right)) return undefined;
  const apply = {
    '&': (a: number, b: number) => a & b,
    '|': (a: number, b: number) => a | b,
    '^': (a: number, b: number) => a ^ b,
  }[operator];
  return { type: INT, apply: (_, a, b) => apply(a as number, b as number) };
}

/** Types a unary operator, returning `undefined` when Java rejects the operand type. */
export function unaryOperation(operator: '!' | '-' | '+' | '~', operand: JavaType): Operation<[Value]> | undefined {
  if (operator === '!') {
    return operand.kind === 'boolean' ? { type: BOOLEAN, apply: (_, value) => !(value as boolean) } : undefined;
  }
  if (operator === '~') {
    return isIntegral(operand) ? { type: INT, apply: (_, value) => ~(value as number) } : undefined;
  }
  if (!isNumeric(operand)) return undefined;
  const sign = operator === '-' ? -1 : 1;
  return operand.kind === 'double'
    ? { type: DOUBLE, apply: (_, value) => sign * (value as number) }
    : { type: INT, apply: (_, value) => toInt32(sign * (value as number)) };
}

/** Converts a value for a cast, returning `undefined` when Java rejects the cast at compile time. */
export function castOperation(
  objectClass: ClassInfo,
  from: JavaType,
  to: JavaType
): ((frame: Frame, value: Value) => Value) | undefined {
  if (sameType(from, to)) return (_, value) => value;
  if (isNumeric(from) && isNumeric(to)) return numericCast(from, to);
  if (isReference(from) && isReference(to)) return referenceCast(objectClass, from, to);
  return undefined;
}

function numericCast(from: JavaType, to: JavaType): (frame: Frame, value: Value) => Value {
  const fromDouble = from.kind === 'double';
  switch (to.kind) {
    case 'double': {
      return (_, value) => value;
    }
    case 'int': {
      return fromDouble ? (_, value) => doubleToInt(value as number) : (_, value) => value;
    }
    default: {
      return fromDouble
        ? (_, value) => doubleToInt(value as number) & 0xff_ff
        : (_, value) => (value as number) & 0xff_ff;
    }
  }
}

function referenceCast(objectClass: ClassInfo, from: JavaType, to: JavaType): (frame: Frame, value: Value) => Value {
  if (isWidening(from, to, objectClass)) return (_, value) => value;
  return (frame, value) => {
    if (value === undefined) return value;
    const matches =
      to.kind === 'class'
        ? frame.runtime.isInstance(value, to.cls)
        : value instanceof JavaArray && isWidening({ kind: 'array', element: value.elementType }, to, objectClass);
    if (!matches) {
      const actual = value instanceof JavaObject ? value.cls.name : value instanceof JavaString ? 'String' : 'array';
      throwBuiltin(frame, 'ClassCastException', `class ${actual} cannot be cast to class ${typeName(to)}`);
    }
    return value;
  };
}

/** The type of `condition ? a : b`, or `undefined` when the branches have no common type. */
export function conditionalType(objectClass: ClassInfo, a: JavaType, b: JavaType): JavaType | undefined {
  if (sameType(a, b)) return a;
  if (isNumeric(a) && isNumeric(b)) return a.kind === 'double' || b.kind === 'double' ? DOUBLE : INT;
  if (!isReference(a) || !isReference(b)) return undefined;
  if (isWidening(a, b, objectClass)) return b;
  if (isWidening(b, a, objectClass)) return a;
  if (a.kind !== 'class' || b.kind !== 'class') return objectClass.type;
  for (let ancestor: ClassInfo | undefined = a.cls; ancestor; ancestor = ancestor.superclass) {
    if (isSubclass(b.cls, ancestor)) return ancestor.type;
  }
  return objectClass.type;
}
