import type { BoundExpression, OperandKind } from './bound';
import { isEnum, isIntegral, isNumeric } from './conversions';
import { ConversionBinder } from './convertBinder';
import { CsDecimal } from './decimal';
import type { MethodCandidate } from './lookup';
import { OPERATOR_NAMES, UNARY_OPERATOR_NAMES } from './natives';
import {
  arithmetic,
  booleanOperation,
  compareNumeric,
  type NumericValue,
  PendingException,
  unaryNumeric,
} from './numeric';
import {
  displayType,
  ERROR_TYPE,
  isReferenceType,
  type NamedType,
  nullableUnderlying,
  sameType,
  specialOf,
  type SpecialType,
  substitute,
  substitutionOf,
  type Type,
} from './types';

const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
const SHIFTS = new Set(['<<', '>>', '>>>']);
const BITWISE = new Set(['&', '|', '^']);
const EQUALITY = new Set(['==', '!=']);
const RELATIONAL = new Set(['<', '>', '<=', '>=']);

/** The kinds of the predefined numeric operators, in the order that binary numeric promotion prefers. */
const PROMOTED: ReadonlySet<SpecialType> = new Set<SpecialType>([
  'int',
  'uint',
  'long',
  'ulong',
  'float',
  'double',
  'decimal',
]);

/** Resolves C#'s predefined and user-defined operators, folding operations on constants. */
export abstract class OperatorBinder extends ConversionBinder {
  /** Resolves the user-defined operators of the operand types among candidates, returning the call if one applies. */
  protected abstract bindOperatorCall(
    candidates: MethodCandidate[],
    operands: BoundExpression[],
    row: number
  ): BoundExpression | undefined;

  bindUnary(operator: string, operand: BoundExpression, row: number): BoundExpression {
    if (operand.type.kind === 'error') return { ...operand, type: ERROR_TYPE };
    const userDefined = this.userOperator(UNARY_OPERATOR_NAMES[operator], [operand], row);
    if (userDefined) return userDefined;
    const underlying = nullableUnderlying(operand.type);
    const type = underlying ?? operand.type;
    const special = specialOf(type);
    if (operator === '!') {
      if (special === 'bool')
        return this.unaryNode('!', operand, 'bool', underlying ? operand.type : this.boolType, !!underlying, row);
    } else if (isEnum(type) && operator === '~') {
      return this.unaryNode('~', operand, 'enum', operand.type, !!underlying, row);
    } else if (special && isNumeric(type)) {
      const kind = this.unaryKind(operator, special);
      if (kind) {
        const resultType = this.specialType(kind);
        const converted = underlying ? operand : this.convert(operand, resultType, row);
        return this.unaryNode(
          operator,
          converted,
          kind,
          underlying ? this.nullableOf(resultType) : resultType,
          !!underlying,
          row
        );
      }
    }
    this.error(row, 'CS0023', `演算子 '${operator}' は '${displayType(operand.type)}' 型のオペランドに適用できません`);
    return { ...operand, type: ERROR_TYPE };
  }

  private unaryKind(operator: string, special: SpecialType): SpecialType | undefined {
    if (operator === '~') {
      if (['float', 'double', 'decimal'].includes(special)) return undefined;
      return special === 'uint' || special === 'long' || special === 'ulong' ? special : 'int';
    }
    if (operator === '-') {
      if (special === 'ulong') return undefined;
      if (special === 'uint') return 'long';
    }
    return ['uint', 'long', 'ulong', 'float', 'double', 'decimal'].includes(special) ? special : 'int';
  }

  private unaryNode(
    operator: string,
    operand: BoundExpression,
    kind: OperandKind | SpecialType,
    type: Type,
    isLifted: boolean,
    row: number
  ): BoundExpression {
    if (operand.kind === 'constant' && !isLifted && operand.value !== undefined) {
      if (kind === 'bool') return this.constant(!(operand.value as boolean), type, row);
      if (kind !== 'enum') {
        return this.constant(unaryNumeric(operator, kind as OperandKind, operand.value as NumericValue), type, row);
      }
    }
    return {
      kind: 'unary',
      operator,
      operand,
      operandKind: kind as OperandKind,
      isLifted,
      type,
      row,
    };
  }

  /** Binds a binary operator other than `&&`, `||`, and `??`. */
  /** @param shownOperator The operator that an error names, such as `-=` for a compound assignment's `-`. */
  bindBinary(
    operator: string,
    left: BoundExpression,
    right: BoundExpression,
    row: number,
    shownOperator = operator
  ): BoundExpression {
    if (left.type.kind === 'error' || right.type.kind === 'error')
      return {
        kind: 'binary',
        operator,
        left,
        right,
        operandKind: 'int',
        isLifted: false,
        type: ERROR_TYPE,
        row,
      };
    const userDefined = this.userOperator(OPERATOR_NAMES[operator], [left, right], row);
    if (userDefined) return userDefined;
    if (operator === '+' && (this.isString(left.type) || this.isString(right.type)))
      return this.concatenation(left, right, row);
    if (EQUALITY.has(operator)) {
      const equality = this.bindEquality(operator, left, right, row);
      if (equality) return equality;
    }
    const delegateOperation = this.bindDelegateOperator(operator, left, right, row);
    if (delegateOperation) return delegateOperation;
    const enumOperation = this.bindEnumOperator(operator, left, right, row);
    if (enumOperation) return enumOperation;
    const leftUnderlying = nullableUnderlying(left.type);
    const rightUnderlying = nullableUnderlying(right.type);
    const isLifted =
      leftUnderlying !== undefined ||
      rightUnderlying !== undefined ||
      left.type.kind === 'null' ||
      right.type.kind === 'null';
    // A `null` operand takes the other operand's type, as a lifted operator's null.
    const leftType = leftUnderlying ?? (left.type.kind === 'null' ? (rightUnderlying ?? right.type) : left.type);
    const rightType = rightUnderlying ?? (right.type.kind === 'null' ? (leftUnderlying ?? left.type) : right.type);
    if (
      (BITWISE.has(operator) || EQUALITY.has(operator)) &&
      specialOf(leftType) === 'bool' &&
      specialOf(rightType) === 'bool'
    ) {
      return this.finishBinary(operator, left, right, 'bool', this.specialType('bool'), isLifted, row);
    }
    const kind = SHIFTS.has(operator) ? this.shiftKind(leftType, rightType) : this.promotedKind(leftType, rightType);
    if (kind === 'ambiguous') {
      this.error(
        row,
        'CS0034',
        `型 '${displayType(left.type)}' および '${displayType(right.type)}' のオペランドの演算子 '${operator}' があいまいです`
      );
      return {
        kind: 'binary',
        operator,
        left,
        right,
        operandKind: 'int',
        isLifted: false,
        type: ERROR_TYPE,
        row,
      };
    }
    if (
      kind &&
      (ARITHMETIC.has(operator) ||
        SHIFTS.has(operator) ||
        EQUALITY.has(operator) ||
        RELATIONAL.has(operator) ||
        (BITWISE.has(operator) && !['float', 'double', 'decimal'].includes(kind)))
    ) {
      const operandType = this.specialType(kind);
      const rightTarget = SHIFTS.has(operator) ? this.intType : operandType;
      return this.finishBinary(operator, left, right, kind, operandType, isLifted, row, rightTarget);
    }
    this.reportBinary(shownOperator, left, right, row);
    return {
      kind: 'binary',
      operator,
      left,
      right,
      operandKind: 'int',
      isLifted: false,
      type: ERROR_TYPE,
      row,
    };
  }

  protected reportBinary(operator: string, left: BoundExpression, right: BoundExpression, row: number): void {
    this.error(
      row,
      'CS0019',
      `演算子 '${operator}' を '${displayType(left.type)}' と '${displayType(right.type)}' 型のオペランドに適用することはできません`
    );
  }

  /** Converts the operands, computes the result type, and folds constants. */
  private finishBinary(
    operator: string,
    left: BoundExpression,
    right: BoundExpression,
    kind: OperandKind | SpecialType,
    operandType: Type,
    isLifted: boolean,
    row: number,
    rightTarget: Type = operandType
  ): BoundExpression {
    const leftTarget = isLifted ? this.nullableOf(operandType) : operandType;
    const convertedLeft = this.convert(left, leftTarget, row);
    const convertedRight = this.convert(right, isLifted ? this.nullableOf(rightTarget) : rightTarget, row);
    const isComparison = EQUALITY.has(operator) || RELATIONAL.has(operator);
    const resultType = isComparison ? this.boolType : isLifted ? this.nullableOf(operandType) : operandType;
    const node: BoundExpression = {
      kind: 'binary',
      operator,
      left: convertedLeft,
      right: convertedRight,
      operandKind: kind as OperandKind,
      isLifted,
      type: resultType,
      row,
    };
    return this.foldBinary(node);
  }

  /** Computes an operation on constants, reporting what overflows or divides by zero, as constant expressions are checked. */
  protected foldBinary(node: Extract<BoundExpression, { kind: 'binary' }>): BoundExpression {
    const { left, right, operator, operandKind, row } = node;
    if (
      left.kind !== 'constant' ||
      right.kind !== 'constant' ||
      node.isLifted ||
      left.value === undefined ||
      right.value === undefined
    )
      return node;
    try {
      if (operandKind === 'bool')
        return this.constant(booleanOperation(operator, left.value as boolean, right.value as boolean), node.type, row);
      if (
        operandKind === 'string' ||
        operandKind === 'object' ||
        operandKind === 'enum' ||
        operandKind === 'delegate'
      ) {
        if (operandKind === 'string' && EQUALITY.has(operator))
          return this.constant((left.value === right.value) === (operator === '=='), node.type, row);
        return node;
      }
      return this.foldNumeric(node, left.value as NumericValue, right.value as NumericValue);
    } catch (error) {
      if (!(error instanceof PendingException)) throw error;
      this.error(row, 'CS0220', 'この操作はチェック モードでコンパイルしたときにオーバーフローします');
      return node;
    }
  }

  private foldNumeric(
    node: Extract<BoundExpression, { kind: 'binary' }>,
    left: NumericValue,
    right: NumericValue
  ): BoundExpression {
    const { operator, operandKind, row } = node;
    if (EQUALITY.has(operator) || RELATIONAL.has(operator))
      return this.constant(compareNumeric(operator, operandKind, left, right), node.type, row);
    const isIntegralKind = !['float', 'double', 'decimal'].includes(operandKind);
    if ((operator === '/' || operator === '%') && isIntegralKind && (right === 0 || right === 0n)) {
      this.error(row, 'CS0020', '定数 0 による除算です');
      return node;
    }
    if (operandKind === 'decimal' && (operator === '/' || operator === '%') && (right as CsDecimal).isZero()) {
      this.error(row, 'CS0020', '定数 0 による除算です');
      return node;
    }
    return this.constant(arithmetic(operator, operandKind, left, right, true), node.type, row);
  }

  /** The operand kind that binary numeric promotion chooses for two numeric types, if any. */
  promotedKind(left: Type, right: Type): SpecialType | 'ambiguous' | undefined {
    const a = specialOf(left);
    const b = specialOf(right);
    if (!a || !b || !isNumeric(left) || !isNumeric(right)) return undefined;
    if (a === 'decimal' || b === 'decimal')
      return a === 'float' || a === 'double' || b === 'float' || b === 'double' ? undefined : 'decimal';
    if (a === 'double' || b === 'double') return 'double';
    if (a === 'float' || b === 'float') return 'float';
    if (a === 'ulong' || b === 'ulong') return signed(a) || signed(b) ? 'ambiguous' : 'ulong';
    if (a === 'long' || b === 'long') return 'long';
    if ((a === 'uint' && signed(b)) || (b === 'uint' && signed(a))) return 'long';
    if (a === 'uint' || b === 'uint') return 'uint';
    return 'int';
  }

  private shiftKind(left: Type, right: Type): SpecialType | undefined {
    const a = specialOf(left);
    if (!a || !isIntegral(left) || !isIntegral(right)) return undefined;
    if (specialOf(right) === 'uint' || specialOf(right) === 'long' || specialOf(right) === 'ulong') return undefined;
    return PROMOTED.has(a) ? a : 'int';
  }

  private bindEquality(
    operator: string,
    left: BoundExpression,
    right: BoundExpression,
    row: number
  ): BoundExpression | undefined {
    const leftType = left.type;
    const rightType = right.type;
    if (isNull(leftType) && isNull(rightType)) return this.constant(operator === '==', this.boolType, row);
    // `x == null` on a nullable value type tests HasValue, and on a reference compares references.
    for (const [value, other] of [
      [left, right],
      [right, left],
    ] as const) {
      if (
        isNull(other.type) &&
        (nullableUnderlying(value.type) || this.isReference(value.type) || value.type.kind === 'typeParameter')
      ) {
        return {
          kind: 'binary',
          operator,
          left: value,
          right: this.constant(undefined, value.type, row),
          operandKind: 'object',
          isLifted: false,
          type: this.boolType,
          row,
        };
      }
    }
    if (this.isString(leftType) && this.isString(rightType)) {
      return this.foldBinary({
        kind: 'binary',
        operator,
        left,
        right,
        operandKind: 'string',
        isLifted: false,
        type: this.boolType,
        row,
      });
    }
    const leftReference = this.isReference(leftType) || isNull(leftType);
    const rightReference = this.isReference(rightType) || isNull(rightType);
    if (leftReference && rightReference) {
      if (
        !this.conversions.isReferenceConvertible(leftType, rightType) &&
        !this.conversions.isReferenceConvertible(rightType, leftType) &&
        !isNull(leftType) &&
        !isNull(rightType) &&
        !this.isInterfaceComparable(leftType, rightType)
      ) {
        return undefined;
      }
      const kind: OperandKind =
        leftType.kind === 'named' && leftType.symbol.kind === 'delegate' ? 'delegate' : 'object';
      return {
        kind: 'binary',
        operator,
        left,
        right,
        operandKind: kind,
        isLifted: false,
        type: this.boolType,
        row,
      };
    }
    return undefined;
  }

  private isInterfaceComparable(a: Type, b: Type): boolean {
    return (isInterface(a) && !isSealedClass(b)) || (isInterface(b) && !isSealedClass(a));
  }

  private bindDelegateOperator(
    operator: string,
    left: BoundExpression,
    right: BoundExpression,
    row: number
  ): BoundExpression | undefined {
    if (operator !== '+' && operator !== '-') return undefined;
    const delegateType = [left.type, right.type].find(
      (type) => type.kind === 'named' && type.symbol.kind === 'delegate'
    );
    if (!delegateType) return undefined;
    const convertedLeft = this.convert(left, delegateType, row);
    const convertedRight = this.convert(right, delegateType, row);
    return {
      kind: 'binary',
      operator,
      left: convertedLeft,
      right: convertedRight,
      operandKind: 'delegate',
      isLifted: false,
      type: delegateType,
      row,
    };
  }

  // code-gauge-allow functionCognitiveComplexity 28 -- Each operator that enums define has its own operand types.
  private bindEnumOperator(
    operator: string,
    left: BoundExpression,
    right: BoundExpression,
    row: number
  ): BoundExpression | undefined {
    const leftType = nullableUnderlying(left.type) ?? left.type;
    const rightType = nullableUnderlying(right.type) ?? right.type;
    const isLifted = nullableUnderlying(left.type) !== undefined || nullableUnderlying(right.type) !== undefined;
    const leftEnum = isEnum(leftType);
    const rightEnum = isEnum(rightType);
    if (!leftEnum && !rightEnum) return undefined;
    const enumType = (leftEnum ? leftType : rightType) as NamedType;
    const underlying = enumType.symbol.enumUnderlying as NamedType;
    const lift = (type: Type): Type => (isLifted ? this.nullableOf(type) : type);
    const node = (leftOperandType: Type, rightOperandType: Type, resultType: Type): BoundExpression => ({
      kind: 'binary',
      operator,
      left: this.convert(left, lift(leftOperandType), row),
      right: this.convert(right, lift(rightOperandType), row),
      operandKind: 'enum',
      isLifted,
      type: resultType,
      row,
    });
    const isCompatible = (): boolean =>
      sameType(leftType, rightType) ||
      (leftEnum && this.implicitConversionOf(right, enumType) !== undefined) ||
      (rightEnum && this.implicitConversionOf(left, enumType) !== undefined);
    if ((EQUALITY.has(operator) || RELATIONAL.has(operator)) && isCompatible())
      return node(enumType, enumType, this.boolType);
    if (BITWISE.has(operator) && isCompatible()) return node(enumType, enumType, lift(enumType));
    if (operator === '+' && leftEnum !== rightEnum) {
      if (!this.implicitConversionOf(leftEnum ? right : left, underlying)) return undefined;
      return leftEnum ? node(enumType, underlying, lift(enumType)) : node(underlying, enumType, lift(enumType));
    }
    if (operator !== '-') return undefined;
    if (leftEnum && rightEnum && sameType(leftType, rightType)) return node(enumType, enumType, lift(underlying));
    if (leftEnum && !rightEnum && this.implicitConversionOf(right, underlying))
      return node(enumType, underlying, lift(enumType));
    return undefined;
  }

  /** `+` with a string operand concatenates, calling `ToString()` on the other operand. */
  private concatenation(left: BoundExpression, right: BoundExpression, row: number): BoundExpression {
    const parts = [left, right].flatMap((part) => (part.kind === 'concat' ? part.parts : [part]));
    if (
      parts.every(
        (part) =>
          part.kind === 'constant' &&
          (typeof part.value === 'string' || part.value === undefined) &&
          this.isString(part.type)
      )
    ) {
      return this.constant(
        parts.map((part) => (part as { value: string | undefined }).value ?? '').join(''),
        this.stringType,
        row
      );
    }
    for (const part of parts) {
      if (part.kind === 'unbound' || part.type.kind === 'void') {
        this.error(
          row,
          'CS0019',
          `演算子 '+' を '${displayType(left.type)}' と '${displayType(right.type)}' 型のオペランドに適用することはできません`
        );
      }
    }
    return { kind: 'concat', parts, type: this.stringType, row };
  }

  isString(type: Type): boolean {
    return specialOf(type) === 'string';
  }

  /** Binds a user-defined operator of either operand's type, if one applies. */
  private userOperator(
    name: string | undefined,
    operands: BoundExpression[],
    row: number
  ): BoundExpression | undefined {
    if (!name) return undefined;
    const candidates: MethodCandidate[] = [];
    for (const operand of operands) {
      const type = nullableUnderlying(operand.type) ?? operand.type;
      if (
        type.kind !== 'named' ||
        type.symbol.special === 'string' ||
        (type.symbol.special && type.symbol.special !== 'decimal' && isNumeric(type))
      )
        continue;
      for (const candidate of this.lookupOperators(type, name)) {
        if (!candidates.some((existing) => existing.method === candidate.method)) candidates.push(candidate);
      }
    }
    if (candidates.length === 0) return undefined;
    return this.bindOperatorCall(candidates, operands, row);
  }

  /** The type of a user-defined operator's parameter in the constructed type that declares it. */
  protected operatorParameterType(candidate: MethodCandidate, index: number): Type {
    return substitute(candidate.method.parameters[index].type, substitutionOf(candidate.owner));
  }

  protected isReferenceOrNull(type: Type): boolean {
    return isReferenceType(type) || type.kind === 'null' || type.kind === 'array';
  }

  /** The decimal value of a numeric constant, for folding. */
  protected decimalOf(value: number | bigint): CsDecimal {
    return CsDecimal.fromBigInt(BigInt(value));
  }
}

function signed(type: SpecialType): boolean {
  return ['sbyte', 'short', 'int', 'long'].includes(type);
}

function isNull(type: Type): boolean {
  return type.kind === 'null';
}

function isInterface(type: Type): boolean {
  return type.kind === 'named' && type.symbol.kind === 'interface';
}

function isSealedClass(type: Type): boolean {
  return type.kind === 'named' && type.symbol.isSealed;
}
