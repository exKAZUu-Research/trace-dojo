import type { BinaryOperator } from './ast';
import { classCastMessage, typeClassName } from './builtinClass';
import { type Builtins, stringify } from './builtins';
import { type Frame, throwBuiltin } from './runtime';
import {
  BOOLEAN,
  type ClassInfo,
  type ClassType,
  createClass,
  erasure,
  intersectionParts,
  isCastable,
  isIntegral,
  isNumeric,
  isReference,
  isSubclass,
  isWidening,
  type JavaType,
  type NumericKind,
  promoteBinary,
  promoteUnary,
  sameType,
  SHORT,
  superinterfacesOf,
} from './types';
import { convertNumber, JavaArray, JavaString, toInt32, toInt64, type Value } from './values';

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
      const leftText = stringify(frame, left, leftType);
      const rightText = stringify(frame, right, rightType);
      frame.runtime.allocateString(frame, leftText.length + rightText.length);
      return new JavaString(leftText + rightText);
    },
  };
}

function arithmetic(
  operator: '+' | '-' | '*' | '/' | '%',
  left: JavaType,
  right: JavaType
): BinaryOperation | undefined {
  if (!isNumeric(left) || !isNumeric(right)) return undefined;
  const type = promoteBinary(left, right);
  return promoted(left, right, type, numericArithmetic(operator, type.kind as NumericKind));
}

/** An operation on operands converted to their promoted type `type`. */
function promoted(
  left: { kind: NumericKind },
  right: { kind: NumericKind },
  type: JavaType,
  apply: BinaryOperation['apply'],
  resultType: JavaType = type
): BinaryOperation {
  const to = type.kind as NumericKind;
  if (left.kind === to && right.kind === to) return { type: resultType, apply };
  return {
    type: resultType,
    apply: (frame, a, b) => apply(frame, convertNumber(a, left.kind, to), convertNumber(b, right.kind, to)),
  };
}

function numericArithmetic(operator: '+' | '-' | '*' | '/' | '%', kind: NumericKind): BinaryOperation['apply'] {
  switch (kind) {
    case 'long': {
      return longArithmetic(operator);
    }
    case 'float': {
      const apply = doubleArithmetic(operator);
      return (frame, a, b) => Math.fround(apply(frame, a, b) as number);
    }
    case 'double': {
      return doubleArithmetic(operator);
    }
    default: {
      return intArithmetic(operator);
    }
  }
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

function longArithmetic(operator: '+' | '-' | '*' | '/' | '%'): BinaryOperation['apply'] {
  const apply = {
    '+': (a: bigint, b: bigint) => a + b,
    '-': (a: bigint, b: bigint) => a - b,
    '*': (a: bigint, b: bigint) => a * b,
    '/': (a: bigint, b: bigint) => a / b,
    '%': (a: bigint, b: bigint) => a % b,
  }[operator];
  const divides = operator === '/' || operator === '%';
  return (frame, a, b) => {
    if (divides && b === 0n) throwBuiltin(frame, 'ArithmeticException', '/ by zero');
    return toInt64(apply(a as bigint, b as bigint));
  };
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

/** Shifts promote each operand on its own; the left one decides the type and the distance is masked to its width. */
function shift(operator: '<<' | '>>' | '>>>', left: JavaType, right: JavaType): BinaryOperation | undefined {
  if (!isIntegral(left) || !isIntegral(right)) return undefined;
  const type = promoteUnary(left as { kind: NumericKind });
  const leftKind = (left as { kind: NumericKind }).kind;
  const rightKind = (right as { kind: NumericKind }).kind;
  const distanceOf = (value: Value): number => Number((convertNumber(value, rightKind, 'long') as bigint) & 63n);
  if (type.kind === 'long') {
    const apply = {
      '<<': (a: bigint, b: number) => toInt64(a << BigInt(b)),
      '>>': (a: bigint, b: number) => a >> BigInt(b),
      '>>>': (a: bigint, b: number) => toInt64(BigInt.asUintN(64, a) >> BigInt(b)),
    }[operator];
    return { type, apply: (_, a, b) => apply(convertNumber(a, leftKind, 'long') as bigint, distanceOf(b)) };
  }
  const apply = {
    '<<': (a: number, b: number) => a << b,
    '>>': (a: number, b: number) => a >> b,
    '>>>': (a: number, b: number) => toInt32(a >>> b),
  }[operator];
  return { type, apply: (_, a, b) => apply(a as number, distanceOf(b) & 31) };
}

function comparison(operator: '<' | '>' | '<=' | '>=', left: JavaType, right: JavaType): BinaryOperation | undefined {
  if (!isNumeric(left) || !isNumeric(right)) return undefined;
  const apply = {
    '<': (a: number | bigint, b: number | bigint) => a < b,
    '>': (a: number | bigint, b: number | bigint) => a > b,
    '<=': (a: number | bigint, b: number | bigint) => a <= b,
    '>=': (a: number | bigint, b: number | bigint) => a >= b,
  }[operator];
  return promoted(
    left,
    right,
    promoteBinary(left, right),
    (_, a, b) => apply(a as number | bigint, b as number | bigint),
    BOOLEAN
  );
}

function equality(
  objectClass: ClassInfo,
  operator: '==' | '!=',
  left: JavaType,
  right: JavaType
): BinaryOperation | undefined {
  const isEqual = operator === '==';
  if (isNumeric(left) && isNumeric(right)) {
    return promoted(left, right, promoteBinary(left, right), (_, a, b) => (a === b) === isEqual, BOOLEAN);
  }
  const comparable =
    (left.kind === 'boolean' && right.kind === 'boolean') ||
    (isReference(left) && isReference(right) && isCastable(left, right, objectClass));
  if (!comparable) return undefined;
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
  const type = promoteBinary(left as { kind: NumericKind }, right as { kind: NumericKind });
  // Bitwise operators on bigints keep them within 64 bits, and on numbers within 32 bits.
  const apply = {
    '&': (a: number | bigint, b: number | bigint) => (a as number) & (b as number),
    '|': (a: number | bigint, b: number | bigint) => (a as number) | (b as number),
    '^': (a: number | bigint, b: number | bigint) => (a as number) ^ (b as number),
  }[operator];
  return promoted(left as { kind: NumericKind }, right as { kind: NumericKind }, type, (_, a, b) =>
    apply(a as number | bigint, b as number | bigint)
  );
}

/** Types a unary operator, returning `undefined` when Java rejects the operand type. */
export function unaryOperation(operator: '!' | '-' | '+' | '~', operand: JavaType): Operation<[Value]> | undefined {
  if (operator === '!') {
    return operand.kind === 'boolean' ? { type: BOOLEAN, apply: (_, value) => !(value as boolean) } : undefined;
  }
  if (!isNumeric(operand)) return undefined;
  if (operator === '~' && !isIntegral(operand)) return undefined;
  const type = promoteUnary(operand);
  const from = operand.kind;
  const to = type.kind as NumericKind;
  const apply = unaryApply(operator, to);
  return { type, apply: (_, value) => apply(convertNumber(value, from, to)) };
}

function unaryApply(operator: '-' | '+' | '~', kind: NumericKind): (value: Value) => Value {
  if (operator === '+') return (value) => value;
  if (kind === 'long') return operator === '-' ? (value) => toInt64(-(value as bigint)) : (value) => ~(value as bigint);
  if (operator === '~') return (value) => ~(value as number);
  return kind === 'int' ? (value) => toInt32(-(value as number)) : (value) => -(value as number);
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

function numericCast(from: { kind: NumericKind }, to: { kind: NumericKind }): (frame: Frame, value: Value) => Value {
  return (_, value) => convertNumber(value, from.kind, to.kind);
}

function referenceCast(objectClass: ClassInfo, from: JavaType, to: JavaType): (frame: Frame, value: Value) => Value {
  if (isWidening(from, to, objectClass)) return (_, value) => value;
  // The JVM checks only what survives erasure: a type variable's bound, and an array's erased element type.
  const checked = erasure(to);
  return (frame, value) => {
    if (value === undefined) return value;
    const matches =
      checked.kind === 'class'
        ? frame.runtime.isInstance(value, checked.cls)
        : value instanceof JavaArray && isWidening({ kind: 'array', element: value.elementType }, checked, objectClass);
    if (!matches)
      throwBuiltin(frame, 'ClassCastException', classCastMessage(frame, value, typeClassName(frame, checked)));
    return value;
  };
}

/** The type of `condition ? a : b`, or `undefined` when the branches have no common type. */
// code-gauge-allow functionCognitiveComplexity 17 -- One case per rule of JLS 15.25.
export function conditionalType(
  objectClass: ClassInfo,
  a: JavaType,
  b: JavaType,
  constants: [Value, Value] = [undefined, undefined]
): JavaType | undefined {
  if (sameType(a, b)) return a;
  if (isNumeric(a) && isNumeric(b)) return conditionalNumericType(a, b, constants);
  if (!isReference(a) || !isReference(b)) return undefined;
  if (isWidening(a, b, objectClass)) return b;
  if (isWidening(b, a, objectClass)) return a;
  if (a.kind !== 'class' || b.kind !== 'class') return objectClass.type;
  let superclass = objectClass;
  for (let ancestor: ClassInfo | undefined = a.cls.superclass; ancestor; ancestor = ancestor.superclass) {
    if (isSubclass(b.cls, ancestor)) {
      superclass = ancestor;
      break;
    }
  }
  // Java types the result as the intersection of the common supertypes, of which only the most specific matter.
  const common = superinterfacesOf(a.cls).filter(
    (parent) => isSubclass(b.cls, parent) && !isSubclass(superclass, parent)
  );
  const interfaces = common.filter((parent) => !common.some((other) => other !== parent && isSubclass(other, parent)));
  if (interfaces.length === 0) return superclass.type;
  if (interfaces.length === 1 && superclass === objectClass) return interfaces[0].type;
  return intersectionOf(superclass, interfaces, objectClass);
}

/** An intersection type such as `Object & Shape & Named`, which has the members of all its types. */
function intersectionOf(superclass: ClassInfo, interfaces: ClassInfo[], objectClass: ClassInfo): JavaType {
  const names = [superclass, ...interfaces].map((type) => type.name).join(' & ');
  const cls = createClass(names, superclass === objectClass ? undefined : superclass, true);
  cls.kind = superclass === objectClass ? 'interface' : 'class';
  cls.interfaces = interfaces;
  cls.supertypes = [...cls.supertypes, ...interfaces.map((parent) => parent.type as ClassType)];
  cls.isAbstract = true;
  intersectionParts.set(cls, [superclass, ...interfaces]);
  return cls.type;
}

/** The numeric type of `condition ? a : b`, which keeps a narrow type that an int constant on the other side fits. */
function conditionalNumericType(
  a: { kind: NumericKind },
  b: { kind: NumericKind },
  [constantA, constantB]: [Value, Value]
): JavaType {
  const kinds = new Set([a.kind, b.kind]);
  if (kinds.has('byte') && kinds.has('short')) return SHORT;
  for (const [narrow, other, constant] of [
    [a, b, constantB],
    [b, a, constantA],
  ] as const) {
    if (other.kind === 'int' && typeof constant === 'number' && fitsIn(constant, narrow.kind)) return narrow;
  }
  return promoteBinary(a, b);
}

/** Whether an int constant fits in `byte`, `short`, or `char`, as assignment and conditionals require. */
export function fitsIn(value: number, kind: NumericKind): boolean {
  switch (kind) {
    case 'byte': {
      return value >= -128 && value <= 127;
    }
    case 'short': {
      return value >= -32_768 && value <= 32_767;
    }
    case 'char': {
      return value >= 0 && value <= 0xff_ff;
    }
    default: {
      return false;
    }
  }
}
