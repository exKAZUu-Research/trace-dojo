import type { Position } from './ast';
import type { BoundExpression } from './bound';
import { type ConversionKind, INTEGRAL_RANGES, isEnum, isNumeric } from './conversions';
import { CsDecimal } from './decimal';
import { LookupBinder } from './lookup';
import { convertNumeric, type NumericValue, PendingException } from './numeric';
import type { FunctionScope, LocalScope } from './scopes';
import {
  displayType,
  ERROR_TYPE,
  isReferenceType,
  isValueType,
  type NamedType,
  nullableUnderlying,
  sameType,
  specialOf,
  type SpecialType,
  type Type,
} from './types';

/** Where an expression is being bound: its block and its function. */
export interface BindContext {
  scope: LocalScope;
  fn: FunctionScope;
}

/** How a conversion happens, which decides its diagnostics. */
export type ConversionMode = 'implicit' | 'explicit';

/** Converts bound expressions to types, folding constants and reporting conversions that do not exist. */
export abstract class ConversionBinder extends LookupBinder {
  /** Binds an expression whose type comes from its target, such as a lambda, once that target is known. */
  protected abstract bindUnbound(
    expression: Extract<BoundExpression, { kind: 'unbound' }>,
    target: Type,
    mode: ConversionMode,
    report: boolean
  ): BoundExpression | undefined;

  /** The type that a target-typed expression has on its own, if any, such as a lambda's natural delegate type. */
  protected abstract naturalTypeOf(expression: Extract<BoundExpression, { kind: 'unbound' }>): Type | undefined;

  isConstant(expression: BoundExpression): expression is Extract<BoundExpression, { kind: 'constant' }> {
    return expression.kind === 'constant';
  }

  constant(value: unknown, type: Type, row: number): BoundExpression {
    return { kind: 'constant', value, type, row };
  }

  /** The implicit conversion of an expression to a type, including the conversions of constants, if any. */
  implicitConversionOf(expression: BoundExpression, target: Type): ConversionKind | undefined {
    if (expression.kind === 'unbound')
      return this.bindUnbound(expression, target, 'implicit', false) ? 'identity' : undefined;
    const kind = this.conversions.implicit(expression.type, target);
    if (kind) return kind;
    if (expression.kind === 'constant') {
      if (this.fitsConstant(expression, target)) return 'numeric';
      const underlying = nullableUnderlying(target);
      if (underlying && this.fitsConstant(expression, underlying)) return 'nullableLifted';
      if (isEnum(target) && isZeroConstant(expression)) return 'enumNumeric';
    }
    return undefined;
  }

  /** Whether a constant of an integral type converts implicitly to a narrower integral type, holding its value. */
  private fitsConstant(expression: Extract<BoundExpression, { kind: 'constant' }>, target: Type): boolean {
    const from = specialOf(expression.type);
    const to = specialOf(target);
    if (!from || !to || to === 'char' || !INTEGRAL_RANGES[to]) return false;
    if (from === 'int' || (from === 'long' && to === 'ulong')) {
      const value = BigInt(expression.value as number | bigint);
      const [min, max] = INTEGRAL_RANGES[to];
      return value >= min && value <= max;
    }
    return false;
  }

  /** Converts an expression to a type, reporting Roslyn's error when the conversion does not exist. */
  convert(
    expression: BoundExpression,
    target: Type,
    position: Position | number,
    mode: ConversionMode = 'implicit'
  ): BoundExpression {
    const row = typeof position === 'number' ? position : position.row;
    if (target.kind === 'error' || expression.type.kind === 'error') {
      if (expression.kind === 'unbound' && target.kind !== 'error') {
        return this.bindUnbound(expression, target, mode, true) ?? { ...expression, type: ERROR_TYPE };
      }
      if (expression.kind === 'unbound') return { kind: 'default', type: ERROR_TYPE, row };
      return expression;
    }
    if (expression.kind === 'unbound')
      return this.bindUnbound(expression, target, mode, true) ?? { kind: 'default', type: ERROR_TYPE, row };
    if (expression.type.kind === 'void') {
      this.error(row, 'CS0029', `型 'void' を '${displayType(target)}' に暗黙的に変換できません`);
      return { ...expression, type: ERROR_TYPE };
    }
    const implicit = this.implicitConversionOf(expression, target);
    const kind = implicit ?? (mode === 'explicit' ? this.conversions.explicit(expression.type, target) : undefined);
    if (!kind) {
      this.reportMissingConversion(expression, target, row, mode);
      return {
        kind: 'convert',
        operand: expression,
        conversion: 'identity',
        from: expression.type,
        isExplicit: true,
        type: ERROR_TYPE,
        row,
      };
    }
    return this.applyConversion(expression, target, kind, mode === 'explicit' && !implicit, row);
  }

  private reportMissingConversion(expression: BoundExpression, target: Type, row: number, mode: ConversionMode): void {
    const from = displayType(expression.type);
    const to = displayType(target);
    if (expression.type.kind === 'null') {
      this.error(row, 'CS0037', `Null 非許容の値型であるため、Null を '${to}' に変換できません`);
      return;
    }
    if (mode === 'explicit') {
      this.error(row, 'CS0030', `型 '${from}' を '${to}' に変換できません`);
      return;
    }
    if (
      expression.kind === 'constant' &&
      specialOf(expression.type) === 'double' &&
      (specialOf(target) === 'float' || specialOf(target) === 'decimal') &&
      expression.row >= 0 &&
      (expression as { isLiteral?: boolean }).isLiteral
    ) {
      const suffix = specialOf(target) === 'float' ? 'F' : 'M';
      this.error(
        row,
        'CS0664',
        `型 double のリテラルを暗黙的に型 '${to}' に変換することはできません。'${suffix}' サフィックスを使用して、この型のリテラルを作成してください`
      );
      return;
    }
    if (
      expression.kind === 'constant' &&
      specialOf(expression.type) &&
      INTEGRAL_RANGES[specialOf(target) as SpecialType] &&
      isNumeric(expression.type) &&
      this.conversions.explicit(expression.type, target) &&
      ['int', 'long'].includes(specialOf(expression.type) as string) &&
      specialOf(target) !== 'char'
    ) {
      this.error(row, 'CS0031', `定数値 '${constantText(expression.value)}' を '${to}' に変換できません`);
      return;
    }
    if (this.conversions.explicit(expression.type, target)) {
      this.error(
        row,
        'CS0266',
        `型 '${from}' を '${to}' に暗黙的に変換できません。明示的な変換が存在します (cast が不足していないかどうかを確認してください)`
      );
      return;
    }
    this.error(row, 'CS0029', `型 '${from}' を '${to}' に暗黙的に変換できません`);
  }

  /** Builds the conversion node, folding constants. */
  protected applyConversion(
    expression: BoundExpression,
    target: Type,
    kind: ConversionKind,
    isExplicit: boolean,
    row: number
  ): BoundExpression {
    if (kind === 'identity' && sameType(expression.type, target)) {
      if (
        expression.type.kind === 'named' &&
        target.kind === 'named' &&
        target.tupleNames !== expression.type.tupleNames
      )
        return { ...expression, type: target };
      return expression;
    }
    if (expression.kind === 'constant') {
      const folded = this.foldConversion(expression, target, kind, isExplicit, row);
      if (folded) return folded;
    }
    if (kind === 'nullLiteral') return { kind: 'constant', value: undefined, type: target, row };
    if (kind === 'tuple' && expression.kind === 'tuple' && target.kind === 'named') {
      const elements = expression.elements.map((element, index) =>
        this.convert(element, target.args[index], row, isExplicit ? 'explicit' : 'implicit')
      );
      return { kind: 'tuple', elements, type: target, row };
    }
    return {
      kind: 'convert',
      operand: expression,
      conversion: kind,
      from: expression.type,
      isExplicit,
      type: target,
      row,
    };
  }

  /** Folds the conversion of a constant, reporting a constant that does not fit an explicit target. */
  private foldConversion(
    expression: Extract<BoundExpression, { kind: 'constant' }>,
    target: Type,
    kind: ConversionKind,
    isExplicit: boolean,
    row: number
  ): BoundExpression | undefined {
    const from =
      specialOf(expression.type) ??
      (isEnum(expression.type) ? specialOf((expression.type as NamedType).symbol.enumUnderlying as Type) : undefined);
    const targetUnderlying = isEnum(target)
      ? specialOf((target as NamedType).symbol.enumUnderlying as Type)
      : specialOf(target);
    if (kind === 'numeric' || kind === 'enumNumeric') {
      if (!from || !targetUnderlying || expression.value === undefined) return undefined;
      if (!isNumericSpecial(from) || !isNumericSpecial(targetUnderlying)) return undefined;
      const value = expression.value as NumericValue;
      if (
        isExplicit &&
        from !== 'decimal' &&
        targetUnderlying !== 'decimal' &&
        !this.constantFits(value, from, targetUnderlying)
      ) {
        this.error(
          row,
          'CS0221',
          `定数値 '${constantText(value)}' は '${displayType(target)}' に変換できません (unchecked 構文を使ってオーバーライドしてください)`
        );
        return { kind: 'constant', value: convertNumeric(value, from, targetUnderlying), type: target, row };
      }
      try {
        return { kind: 'constant', value: convertNumeric(value, from, targetUnderlying), type: target, row };
      } catch (error) {
        if (!(error instanceof PendingException)) throw error;
        this.error(row, 'CS0031', `定数値 '${constantText(value)}' を '${displayType(target)}' に変換できません`);
        return { kind: 'constant', value: 0, type: target, row };
      }
    }
    if (kind === 'reference' && specialOf(expression.type) === 'string') return undefined;
    return undefined;
  }

  /** Whether a constant converts to an integral type without overflow, as constant expressions are checked. */
  private constantFits(value: NumericValue, from: SpecialType, to: SpecialType): boolean {
    const range = INTEGRAL_RANGES[to];
    if (!range) return true;
    if (value instanceof CsDecimal) return true;
    if (typeof value === 'number' && (from === 'float' || from === 'double')) {
      if (!Number.isFinite(value)) return false;
      const truncated = Math.trunc(value);
      return truncated >= Number(range[0]) && truncated <= Number(range[1]);
    }
    const integer = BigInt(value as number | bigint);
    return integer >= range[0] && integer <= range[1];
  }

  /** Whether a type is a value type that `null` cannot be, for diagnostics. */
  protected isNonNullableValueType(type: Type): boolean {
    return isValueType(type) && !nullableUnderlying(type);
  }

  protected isReference(type: Type): boolean {
    return isReferenceType(type) || type.kind === 'array';
  }
}

function isNumericSpecial(special: SpecialType): boolean {
  return [
    'sbyte',
    'byte',
    'short',
    'ushort',
    'int',
    'uint',
    'long',
    'ulong',
    'char',
    'float',
    'double',
    'decimal',
  ].includes(special);
}

function isZeroConstant(expression: Extract<BoundExpression, { kind: 'constant' }>): boolean {
  const value = expression.value;
  if (!isNumeric(expression.type) || specialOf(expression.type) === 'char') return false;
  if (value instanceof CsDecimal) return value.isZero();
  return value === 0 || value === 0n;
}

/** The text of a constant in a diagnostic, as Roslyn prints it. */
export function constantText(value: unknown): string {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Number.POSITIVE_INFINITY) return '∞';
    if (value === Number.NEGATIVE_INFINITY) return '-∞';
    if (Number.isInteger(value) && Math.abs(value) >= 1e15)
      return value
        .toExponential()
        .replace('e+', 'E+')
        .replace(/^(\d)E/, '$1E');
    return String(value);
  }
  return String(value);
}
