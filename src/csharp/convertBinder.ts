import type { Expression, Position } from './ast';
import type { TypeContext } from './binderBase';
import type { BoundExpression } from './bound';
import { type ConversionKind, INTEGRAL_RANGES, isEnum, isNumeric } from './conversions';
import { CsDecimal } from './decimal';
import { LookupBinder } from './lookup';
import { convertNumeric, type NumericValue, PendingException } from './numeric';
import type { FunctionScope, LocalScope } from './scopes';
import {
  displayType,
  ERROR_TYPE,
  isDynamicType,
  isReferenceType,
  isValueType,
  type MethodSymbol,
  type NamedType,
  nullableUnderlying,
  sameType,
  specialOf,
  type SpecialType,
  substitute,
  substitutionOf,
  type Type,
  withoutNullable,
} from './types';

/** Where an expression is being bound: its block and its function. */
export interface BindContext {
  scope: LocalScope;
  fn: FunctionScope;
}

/** A user-defined conversion operator chosen for a conversion, with the types it converts between. */
export interface UserConversion {
  method: MethodSymbol;
  owner: NamedType;
  from: Type;
  to: Type;
  /** Whether the operator is lifted from value types to their nullable forms. */
  isLifted: boolean;
}

/** How a conversion happens, which decides its diagnostics. */
export type ConversionMode = 'implicit' | 'explicit';

/** What a late-bound operation needs besides its syntax and operands. */
export interface LateOptions {
  receiver?: number;
  target?: { type: Type; isExplicit: boolean };
  isStatement?: boolean;
}

/** The name of a late-bound operation's operand, which the binder declares as a hidden local when the operation runs. */
export function lateOperandName(index: number): string {
  return `\0d${index}`;
}

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
    const standard = this.standardImplicitOf(expression, target);
    if (standard) return standard;
    if (expression.kind === 'unbound') return undefined;
    const user = this.userConversion(expression, target, false);
    return user && !('ambiguous' in user) ? 'userDefined' : undefined;
  }

  /** The standard implicit conversion of an expression to a type (C# spec §10.4.2), if any. */
  private standardImplicitOf(expression: BoundExpression, target: Type): ConversionKind | undefined {
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

  /**
   * The user-defined conversion of an expression to a type (C# spec §10.5.4–10.5.5): the conversion operators of the
   * source and target types and their bases whose parameter the expression converts to and whose result converts to
   * the target by standard conversions, from the most specific source to the most specific target. An explicit
   * conversion also takes `explicit` operators and standard explicit conversions around them, and a checked context
   * prefers an operator's `checked` form. A lifted operator converts between the nullable forms of its value types.
   */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one step of the C# rule.
  protected userConversion(
    expression: BoundExpression,
    target: Type,
    isExplicit: boolean
  ): UserConversion | { ambiguous: UserConversion[] } | undefined {
    const source = expression.type;
    if (source.kind === 'error' || target.kind === 'error' || source.kind === 'void') return undefined;
    const owners = [withoutNullable(source), withoutNullable(target)].filter(
      (type): type is NamedType =>
        type.kind === 'named' && (type.symbol.kind === 'class' || type.symbol.kind === 'struct')
    );
    const names = isExplicit ? ['op_Implicit', 'op_Explicit'] : ['op_Implicit'];
    if (isExplicit && this.checkedContext) names.push('op_CheckedExplicit');
    const operators = owners.flatMap((owner) => names.flatMap((name) => this.lookupOperators(owner, name)));
    if (operators.length === 0) return undefined;
    const fromFits = (from: Type): boolean =>
      sameType(source, from) ||
      this.standardImplicitOf(expression, from) !== undefined ||
      (isExplicit && this.conversions.explicit(source, from) !== undefined);
    const toFits = (to: Type): boolean =>
      sameType(to, target) ||
      this.conversions.implicit(to, target) !== undefined ||
      (isExplicit && this.conversions.explicit(to, target) !== undefined);
    const candidates: UserConversion[] = [];
    for (const { method, owner } of operators) {
      const substitution = substitutionOf(owner);
      const from = substitute(method.parameters[0]?.type ?? ERROR_TYPE, substitution);
      const to = substitute(method.returnType, substitution);
      if (candidates.some((candidate) => candidate.method === method)) continue;
      if (fromFits(from) && toFits(to)) candidates.push({ method, owner, from, to, isLifted: false });
      else if (
        isValueType(from) &&
        !nullableUnderlying(from) &&
        isValueType(to) &&
        !nullableUnderlying(to) &&
        nullableUnderlying(source) &&
        fromFits(this.nullableOf(from)) &&
        toFits(this.nullableOf(to))
      )
        candidates.push({ method, owner, from: this.nullableOf(from), to: this.nullableOf(to), isLifted: true });
    }
    if (candidates.length === 0) return undefined;
    // A checked context prefers `op_CheckedExplicit` over `op_Explicit` of the same types.
    const preferred = candidates.filter(
      (candidate) =>
        candidate.method.name !== 'op_Explicit' ||
        !candidates.some(
          (other) =>
            other.method.name === 'op_CheckedExplicit' &&
            sameType(other.from, candidate.from) &&
            sameType(other.to, candidate.to)
        )
    );
    // The most encompassed source and the most encompassing target, unless one is the exact type (§10.5.3).
    const mostSpecific = (types: Type[], exact: Type, isSource: boolean): Type | undefined =>
      types.find((type) => sameType(type, exact)) ??
      types.find((type) =>
        types.every(
          (other) =>
            sameType(type, other) ||
            (isSource ? this.conversions.implicit(type, other) : this.conversions.implicit(other, type)) !== undefined
        )
      );
    const sourceType = mostSpecific(
      preferred.map((candidate) => candidate.from),
      source,
      true
    );
    const targetType = mostSpecific(
      preferred.map((candidate) => candidate.to),
      target,
      false
    );
    if (!sourceType || !targetType) return { ambiguous: preferred };
    const chosen = preferred.filter(
      (candidate) => sameType(candidate.from, sourceType) && sameType(candidate.to, targetType)
    );
    if (chosen.length !== 1) {
      const unlifted = chosen.filter((candidate) => !candidate.isLifted);
      return unlifted.length === 1 ? unlifted[0] : { ambiguous: chosen };
    }
    return chosen[0];
  }

  /** Binds a user-defined conversion: the standard conversion to the operator's parameter, the call, and then the standard conversion of its result. */
  private applyUserConversion(
    expression: BoundExpression,
    target: Type,
    conversion: UserConversion,
    isExplicit: boolean,
    row: number
  ): BoundExpression {
    const mode: ConversionMode = isExplicit ? 'explicit' : 'implicit';
    const { method, owner, from, to, isLifted } = conversion;
    const operand = this.convert(expression, from, row, mode);
    const parameterType = isLifted ? (nullableUnderlying(from) as Type) : from;
    const call: BoundExpression = {
      kind: 'call',
      method,
      receiver: undefined,
      args: [{ kind: 'compoundOperand', type: parameterType, row }],
      typeArgs: [],
      owner,
      isVirtual: false,
      type: isLifted ? (nullableUnderlying(to) as Type) : to,
      row,
    };
    const converted: BoundExpression = {
      kind: 'convert',
      operand,
      conversion: 'userDefined',
      from,
      isExplicit,
      userCall: isLifted ? this.convert(call, to, row) : call,
      isLifted,
      type: to,
      row,
    };
    return sameType(to, target) ? converted : this.convert(converted, target, row, mode);
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
  /** The syntax of a late-bound operation's operand. */
  lateOperand(index: number, position: Position): Expression {
    return {
      kind: 'name',
      name: lateOperandName(index),
      typeArgs: undefined,
      row: position.row,
      column: position.column,
    };
  }

  /** An operation on `dynamic` values, which binds to the values' types when it runs. */
  late(
    syntax: Expression,
    operands: BoundExpression[],
    context: { fn: { typeContext: TypeContext | undefined } },
    options: LateOptions = {}
  ): BoundExpression {
    return {
      kind: 'late',
      syntax,
      operands,
      receiver: options.receiver,
      target: options.target,
      typeContext: context.fn.typeContext,
      isStatement: options.isStatement ?? false,
      type: options.target?.type ?? this.dynamicType,
      row: syntax.row,
    };
  }

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
      this.error(row, 'CS0029', `型 'void' を '${displayType(target, true)}' に暗黙的に変換できません`);
      return { ...expression, type: ERROR_TYPE };
    }
    // A `dynamic` value converts to another type by its runtime type, as the runtime binder decides.
    if (isDynamicType(expression.type) && !isDynamicType(target) && !sameType(target, this.objectType)) {
      const at = { row, column: typeof position === 'number' ? 0 : position.column };
      return this.late(
        this.lateOperand(0, at),
        [expression],
        { fn: { typeContext: undefined } },
        { target: { type: target, isExplicit: mode === 'explicit' } }
      );
    }
    const implicit = this.standardImplicitOf(expression, target);
    const standard = implicit ?? (mode === 'explicit' ? this.conversions.explicit(expression.type, target) : undefined);
    if (!standard) {
      const user = this.userConversion(expression, target, mode === 'explicit');
      if (user && 'ambiguous' in user) {
        const [first, second] = user.ambiguous.map(
          ({ method, owner }) =>
            `${displayType(owner)}.${method.name === 'op_Implicit' ? 'implicit' : 'explicit'} operator ${displayType(method.returnType)}(${method.parameters.map((parameter) => displayType(parameter.type)).join(', ')})`
        );
        this.error(
          row,
          'CS0457',
          `'${displayType(expression.type, true)}' から '${displayType(target, true)}' へ変換するときの、あいまいなユーザー定義の変換 '${first}' および '${second}' です`
        );
        return { ...expression, type: ERROR_TYPE };
      }
      if (user) return this.applyUserConversion(expression, target, user, mode === 'explicit', row);
    }
    const kind = standard;
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
    const to = displayType(target);
    // Roslyn's conversion errors name the types with their namespaces.
    const fromQualified = displayType(expression.type, true);
    const toQualified = displayType(target, true);
    if (expression.type.kind === 'null' && target.kind === 'typeParameter') {
      this.error(
        row,
        'CS0403',
        `Null 非許容の値型である可能性があるため、Null を型パラメーター '${to}' に変換できません。'default(${to})' を使用してください。`
      );
      return;
    } else if (expression.type.kind === 'null') {
      this.error(row, 'CS0037', `Null 非許容の値型であるため、Null を '${to}' に変換できません`);
      return;
    }
    if (mode === 'explicit') {
      this.error(row, 'CS0030', `型 '${fromQualified}' を '${toQualified}' に変換できません`);
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
        `型 '${fromQualified}' を '${toQualified}' に暗黙的に変換できません。明示的な変換が存在します (cast が不足していないかどうかを確認してください)`
      );
      return;
    }
    this.error(row, 'CS0029', `型 '${fromQualified}' を '${toQualified}' に暗黙的に変換できません`);
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
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
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
        this.checkedContext !== false &&
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
