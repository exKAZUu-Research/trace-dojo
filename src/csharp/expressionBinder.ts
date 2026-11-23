// code-gauge-allow-file fileNcss -- The expressionBinder module keeps one stage of the C# interpreter together.
import type { SourceDiagnostic } from '../interpreter/diagnostics';
import type { Block, Designation, Expression, LambdaParameter, Pattern, Position } from './ast';
import type {
  BoundBlock,
  BoundDeconstructTarget,
  BoundExpression,
  BoundLValue,
  BoundMemberInit,
  BoundPattern,
  LambdaInfo,
} from './bound';
import type { ArgumentInfo } from './callBinder';
import { isEnum, isNumeric } from './conversions';
import type { BindContext, ConversionMode } from './convertBinder';
import { CsDecimal } from './decimal';
import { isDelegateType } from './declarations';
import { missingDeconstruct } from './deconstructionErrors';
import { type BindResult, isNonValue, MemberBinder, type NonValue } from './memberBinder';
import type { Space } from './patternSpace';
import { desugarQuery, TRANSPARENT_PREFIX } from './queries';
import { FunctionScope, LocalScope } from './scopes';
import {
  arrayType,
  displayType,
  ERROR_TYPE,
  FieldSymbol,
  isReferenceType,
  isValueType,
  LocalSymbol,
  MethodSymbol,
  type NamedType,
  namedType,
  NULL_TYPE,
  nullableUnderlying,
  type ParameterSymbol,
  PropertySymbol,
  sameType,
  specialOf,
  substitute,
  substitutionOf,
  type Type,
  TypeSymbol,
  VOID_TYPE,
} from './types';
import type { CsObject } from './values';

type Unbound = Extract<BoundExpression, { kind: 'unbound' }>;
type LambdaExpression = Extract<Expression, { kind: 'lambda' }>;

/** Binds every kind of expression, and the target-typed ones once their targets are known. */
export abstract class ExpressionBinder extends MemberBinder {
  /** Binds a pattern against an input type, declaring its variables in the context's scope. */
  abstract bindPattern(pattern: Pattern, inputType: Type, context: BindContext): BoundPattern;

  /** Reports a switch arm whose pattern the earlier arms handle, then adds an unguarded arm's values to them. */
  protected abstract checkArmReachable(
    handled: Space,
    arm: { pattern: BoundPattern; guard: unknown },
    position: Position
  ): void;

  /** Binds a block that forms a function's body, such as a lambda's. */
  protected abstract bindFunctionBlock(block: Block, context: BindContext): BoundBlock;

  /** The anonymous types by shape, which share one type per list of member names and types. */
  private readonly anonymousTypes = new Map<string, TypeSymbol>();
  private readonly lambdaCache = new Map<
    Expression,
    Map<
      string,
      {
        result: BoundExpression | undefined;
        diagnostics: SourceDiagnostic[];
        returnType: Type | undefined;
      }
    >
  >();

  bindExpression(node: Expression, context: BindContext): BindResult {
    return (
      this.bindPrimaryExpression(node, context) ??
      this.bindCreationExpression(node, context) ??
      this.bindOperatorExpression(node, context) ??
      this.bindOtherExpression(node, context)
    );
  }

  // code-gauge-allow functionNcss -- One case per kind of primary expression.
  private bindPrimaryExpression(node: Expression, context: BindContext): BindResult | undefined {
    const row = node.row;
    switch (node.kind) {
      case 'literal': {
        return this.bindLiteral(node);
      }
      case 'interpolated': {
        return this.bindInterpolated(node, context);
      }
      case 'name': {
        return this.bindSimpleName(node.name, node.typeArgs, node, context);
      }
      case 'predefinedTypeName': {
        return {
          kind: 'typeRef',
          type: this.resolveType(
            { kind: 'predefinedType', name: node.name, row, column: node.column },
            context.fn.typeContext
          ),
          row,
        };
      }
      case 'this': {
        return this.thisValue(context, node);
      }
      case 'base': {
        this.error(node, 'CS0175', "キーワード 'base' をこのコンテキストで使用することはできません");
        return { kind: 'default', type: ERROR_TYPE, row };
      }
      case 'memberAccess': {
        return this.bindMemberAccess(node, context);
      }
      case 'conditionalAccess': {
        return this.bindConditionalAccess(node, context);
      }
      case 'conditionalReceiver': {
        const receiver = this.conditionalReceivers.at(-1);
        if (!receiver) throw new Error('A conditional receiver outside a conditional access');
        return receiver;
      }
      case 'invocation': {
        return this.bindInvocation(node, context);
      }
      case 'elementAccess': {
        const target = this.bindValue(node.target, context);
        return this.bindElementAccess(target, node.args, node, context);
      }
      case 'tuple': {
        return this.bindTuple(node, context);
      }
      case 'declaration': {
        this.error(node, 'CS8185', '宣言はこのコンテキストでは許可されていません。');
        return { kind: 'default', type: ERROR_TYPE, row };
      }
      default: {
        return undefined;
      }
    }
  }

  private bindCreationExpression(node: Expression, context: BindContext): BindResult | undefined {
    const row = node.row;
    switch (node.kind) {
      case 'new': {
        const type = this.resolveType(node.type, context.fn.typeContext);
        if (
          node.type.kind === 'nullableType' &&
          type.kind === 'named' &&
          !nullableUnderlying(type) &&
          isReferenceType(type)
        ) {
          this.error(node, 'CS8628', 'オブジェクト作成では Null 許容参照型を使用できません。');
        }
        return this.bindCreation(type, node.args, node.initializer, node, context);
      }
      case 'implicitNew':
      case 'collection':
      case 'lambda': {
        return { kind: 'unbound', node, context, type: ERROR_TYPE, row };
      }
      case 'default': {
        if (!node.type) return { kind: 'unbound', node, context, type: ERROR_TYPE, row };
        const type = this.resolveType(node.type, context.fn.typeContext);
        return this.defaultValue(type, row);
      }
      case 'newArray': {
        return this.bindNewArray(node, context);
      }
      case 'implicitNewArray': {
        return this.bindImplicitArray(node, context);
      }
      case 'arrayInitializer': {
        this.error(
          node,
          'CS0623',
          '配列初期化子は変数かフィールド初期化子の中でのみ使用できます。new 式を使用してください。'
        );
        return { kind: 'default', type: ERROR_TYPE, row };
      }
      case 'anonymousObject': {
        return this.bindAnonymousObject(node, context);
      }
      case 'with': {
        return this.bindWith(node, context);
      }
      default: {
        return undefined;
      }
    }
  }

  // code-gauge-allow functionNcss -- One case per kind of operator expression.
  private bindOperatorExpression(node: Expression, context: BindContext): BindResult | undefined {
    const row = node.row;
    switch (node.kind) {
      case 'unary': {
        const operand = this.bindValue(node.operand, context);
        if (node.operator === '-' && operand.kind === 'constant' && node.operand.kind === 'literal')
          return this.negatedLiteral(node, operand);
        return this.bindUnary(node.operator, operand, row);
      }
      case 'increment': {
        return this.bindIncrement(node, context);
      }
      case 'nullForgiving': {
        return this.bindExpression(node.operand, context);
      }
      case 'binary': {
        return this.bindBinaryExpression(node, context);
      }
      case 'assign': {
        return this.bindAssignment(node, context);
      }
      case 'conditional': {
        return (
          this.bindConditional(node, context, undefined) ?? { kind: 'unbound', node, context, type: ERROR_TYPE, row }
        );
      }
      case 'cast': {
        const type = this.resolveType(node.type, context.fn.typeContext);
        const operand = this.bindValue(node.operand, context);
        return this.convert(operand, type, node, 'explicit');
      }
      case 'as': {
        return this.bindAs2(node, context);
      }
      case 'is': {
        const operand = this.bindValue(node.operand, context);
        if (operand.kind === 'unbound' || operand.type.kind === 'void') {
          this.error(
            node,
            'CS0837',
            "'is' または 'as' 演算子の最初のオペランドとして、ラムダ式、匿名メソッド、またはメソッド グループを使用することはできません"
          );
          return { kind: 'default', type: this.boolType, row };
        }
        // `x is T` is the type-testing operator, which only warns (CS0184) when T can never match.
        const isTypeTest = node.pattern.kind === 'constantPattern' || node.pattern.kind === 'typePattern';
        const saved = this.isTypeTestOperator;
        const savedUnderIs = this.isUnderIsPattern;
        this.isTypeTestOperator = isTypeTest;
        this.isUnderIsPattern = true;
        try {
          const pattern = this.bindPattern(node.pattern, operand.type, context);
          return { kind: 'is', operand, pattern, type: this.boolType, row };
        } finally {
          this.isTypeTestOperator = saved;
          this.isUnderIsPattern = savedUnderIs;
        }
      }
      default: {
        return undefined;
      }
    }
  }

  private bindOtherExpression(node: Expression, context: BindContext): BindResult {
    const row = node.row;
    switch (node.kind) {
      case 'switch': {
        return (
          this.bindSwitchExpression(node, context, undefined) ?? {
            kind: 'unbound',
            node,
            context,
            type: ERROR_TYPE,
            row,
          }
        );
      }
      case 'throw': {
        if (!this.allowsThrowExpression) {
          this.error(node, 'CS8115', 'このコンテキストではスロー式は許可されていません。');
        }
        const value = this.bindThrowValue(node.value, context, node);
        return { kind: 'throw', value, type: NULL_TYPE, row };
      }
      case 'query': {
        return this.bindExpression(desugarQuery(node), context);
      }
      default: {
        throw new Error(`Unexpected expression ${node.kind}`);
      }
    }
  }

  /** Whether the expression being bound may be a `throw` expression, as `??` and `?:` operands and lambda bodies may. */
  protected allowsThrowExpression = false;

  protected bindThrowValue(node: Expression, context: BindContext, position: Position): BoundExpression {
    const value = this.bindValue(node, context);
    const exception = namedType(this.library.specials.get('exception') as TypeSymbol);
    if (
      value.type.kind !== 'null' &&
      value.type.kind !== 'error' &&
      !this.conversions.implicit(value.type, exception)
    ) {
      this.error(position, 'CS0029', `型 '${displayType(value.type)}' を 'System.Exception' に暗黙的に変換できません`);
    }
    return value;
  }

  /** Binds an operand where a `throw` expression may stand. */
  private bindAllowingThrow(node: Expression, context: BindContext): BoundExpression {
    const saved = this.allowsThrowExpression;
    this.allowsThrowExpression = true;
    try {
      return this.bindValue(node, context);
    } finally {
      this.allowsThrowExpression = saved;
    }
  }

  private bindLiteral(node: Extract<Expression, { kind: 'literal' }>): BoundExpression {
    const { value } = node;
    const row = node.row;
    switch (value.type) {
      case 'int': {
        return this.integerLiteral(value.value, value.suffix, node, false);
      }
      case 'real': {
        return this.realLiteral(value.text, value.suffix, node);
      }
      case 'char': {
        return this.constant(value.value, this.specialType('char'), row);
      }
      case 'string': {
        return this.constant(value.value, this.stringType, row);
      }
      case 'bool': {
        return this.constant(value.value, this.boolType, row);
      }
      default: {
        return { kind: 'constant', value: undefined, type: NULL_TYPE, row };
      }
    }
  }

  /** The type of an integer literal: the first of its suffix's types that holds its value. */
  private integerLiteral(
    value: bigint,
    suffix: '' | 'u' | 'l' | 'ul',
    position: Position,
    isNegated: boolean
  ): BoundExpression {
    const candidates = {
      '': ['int', 'uint', 'long', 'ulong'],
      u: ['uint', 'ulong'],
      l: ['long', 'ulong'],
      ul: ['ulong'],
    }[suffix] as ('int' | 'uint' | 'long' | 'ulong')[];
    const ranges = {
      int: 2_147_483_647n,
      uint: 4_294_967_295n,
      long: 9_223_372_036_854_775_807n,
      ulong: 18_446_744_073_709_551_615n,
    };
    for (const candidate of candidates) {
      const limit = ranges[candidate] + (isNegated && (candidate === 'int' || candidate === 'long') ? 1n : 0n);
      if (value <= limit) {
        const special = candidate;
        const literal = special === 'long' || special === 'ulong' ? value : Number(value);
        return this.constant(literal, this.specialType(special), position.row);
      }
    }
    this.error(position, 'CS1021', '整数定数が大きすぎます');
    return this.constant(0, this.intType, position.row);
  }

  private realLiteral(text: string, suffix: '' | 'f' | 'd' | 'm', position: Position): BoundExpression {
    if (suffix === 'm') {
      const value = CsDecimal.parse(text);
      if (!value) {
        this.error(position, 'CS0594', "浮動小数点定数が、型 'decimal' の範囲外にあります");
        return this.constant(CsDecimal.ZERO, this.specialType('decimal'), position.row);
      }
      return this.constant(value, this.specialType('decimal'), position.row);
    }
    const number = Number(text);
    if (!Number.isFinite(number)) {
      this.error(position, 'CS0594', `浮動小数点定数が型 '${suffix === 'f' ? 'float' : 'double'}' の範囲外です`);
      return this.constant(0, this.specialType('double'), position.row);
    }
    if (suffix === 'f') return this.constant(Math.fround(number), this.specialType('float'), position.row);
    const literal = this.constant(number, this.specialType('double'), position.row) as BoundExpression & {
      isLiteral?: boolean;
    };
    literal.isLiteral = true;
    return literal;
  }

  /** `-2147483648` is an int, since the literal's value is negated before it is typed. */
  private negatedLiteral(
    node: Extract<Expression, { kind: 'unary' }>,
    operand: Extract<BoundExpression, { kind: 'constant' }>
  ): BoundExpression {
    const literal = (node.operand as Extract<Expression, { kind: 'literal' }>).value;
    if (
      literal.type === 'int' &&
      literal.suffix === '' &&
      (literal.value === 2_147_483_648n || literal.value === 9_223_372_036_854_775_808n)
    ) {
      const typed = this.integerLiteral(literal.value, '', node, true) as Extract<
        BoundExpression,
        { kind: 'constant' }
      >;
      const value = typeof typed.value === 'bigint' ? -typed.value : -(typed.value as number);
      return this.constant(value, typed.type, node.row);
    }
    const result = this.bindUnary('-', operand, node.row);
    if (result.kind === 'constant' && (operand as { isLiteral?: boolean }).isLiteral)
      (result as { isLiteral?: boolean }).isLiteral = true;
    return result;
  }

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private bindInterpolated(node: Extract<Expression, { kind: 'interpolated' }>, context: BindContext): BoundExpression {
    const parts: Extract<BoundExpression, { kind: 'interpolated' }>['parts'] = [];
    for (const part of node.parts) {
      if (part.text !== undefined) {
        parts.push(part.text);
        continue;
      }
      const hole = part.hole as NonNullable<typeof part.hole>;
      let value = this.bindValue(hole.expression, context);
      // A method group or a lambda with a natural type formats as its delegate.
      if (value.kind === 'unbound' && this.naturalTypeOf(value))
        value = this.convert(value, this.objectType, hole.expression);
      if (value.kind === 'unbound' || value.type.kind === 'void') {
        this.error(
          hole.expression,
          'CS0029',
          `型 '${value.type.kind === 'void' ? 'void' : 'ラムダ式'}' を 'object' に暗黙的に変換できません`
        );
      }
      let alignment: number | undefined;
      if (hole.alignment) {
        const bound = this.bindAs(hole.alignment, this.intType, context);
        if (bound.kind !== 'constant') this.error(hole.alignment, 'CS0150', '定数値が必要です');
        else alignment = bound.value as number;
      }
      parts.push({ value, alignment, format: hole.format });
    }
    if (parts.every((part) => typeof part === 'string'))
      return this.constant(parts.join(''), this.stringType, node.row);
    return { kind: 'interpolated', parts, type: this.stringType, row: node.row };
  }

  private readonly conditionalReceivers: BoundExpression[] = [];

  /** Binds `a?.b`, which evaluates `b` on `a` only when `a` is not null, with a nullable type for value results. */
  private bindConditionalAccess(
    node: Extract<Expression, { kind: 'conditionalAccess' }>,
    context: BindContext
  ): BoundExpression {
    const receiver = this.bindValue(node.target, context);
    if (receiver.type.kind === 'error') return { kind: 'default', type: ERROR_TYPE, row: node.row };
    const underlying = nullableUnderlying(receiver.type);
    if (!underlying && isValueType(receiver.type)) {
      this.error(node, 'CS0023', `演算子 '?' は '${displayType(receiver.type)}' 型のオペランドに適用できません`);
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const temporary = new LocalSymbol('\0receiver', underlying ?? receiver.type, node.row, node.column);
    temporary.isHidden = true;
    context.fn.addLocal(temporary);
    this.conditionalReceivers.push({ kind: 'local', local: temporary, type: temporary.type, row: node.row });
    let access: BoundExpression;
    try {
      access = this.bindValue(node.access, context);
    } finally {
      this.conditionalReceivers.pop();
    }
    const wrapsNullable = isValueType(access.type) && !nullableUnderlying(access.type) && access.type.kind !== 'void';
    const type = wrapsNullable ? this.nullableOf(access.type) : access.type;
    return { kind: 'conditionalAccess', receiver, access, temporary, wrapsNullable, type, row: node.row };
  }

  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private bindBinaryExpression(node: Extract<Expression, { kind: 'binary' }>, context: BindContext): BoundExpression {
    const { operator } = node;
    const row = node.operatorRow;
    if (operator === '&&' || operator === '||') {
      const leftValue = this.bindValue(node.left, context);
      const rightValue = this.bindValue(node.right, context);
      // Roslyn resolves `&&` as an operator on bool, so operands that are no bool fail as its operands.
      const isBool = (operand: BoundExpression): boolean =>
        operand.kind === 'unbound' ||
        operand.type.kind === 'error' ||
        this.implicitConversionOf(operand, this.boolType) !== undefined;
      if (!isBool(leftValue) || !isBool(rightValue)) {
        this.reportBinary(operator, leftValue, rightValue, row);
        return { kind: 'default', type: this.boolType, row: node.row };
      }
      const left = this.convert(leftValue, this.boolType, node.left);
      const right = this.convert(rightValue, this.boolType, node.right);
      if (left.kind === 'constant' && right.kind === 'constant') {
        return this.constant(
          operator === '&&'
            ? (left.value as boolean) && (right.value as boolean)
            : (left.value as boolean) || (right.value as boolean),
          this.boolType,
          node.row
        );
      }
      return { kind: 'logical', operator, left, right, type: this.boolType, row: node.row };
    }
    if (operator === '??') return this.bindCoalesce(node, context);
    const left = this.bindValue(node.left, context);
    const right = this.bindValue(node.right, context);
    for (const [operand, syntax] of [
      [left, node.left],
      [right, node.right],
    ] as const) {
      if (operand.kind === 'unbound' && !(syntax.kind === 'default' && !syntax.type)) {
        this.reportBinary(operator, left, right, row);
        return { kind: 'default', type: ERROR_TYPE, row: node.row };
      }
    }
    if (left.kind === 'unbound' || right.kind === 'unbound') {
      const typed = left.kind === 'unbound' ? right : left;
      const converted = (operand: BoundExpression): BoundExpression =>
        operand.kind === 'unbound' ? this.convert(operand, typed.type, row) : operand;
      return this.bindBinary(operator, converted(left), converted(right), row);
    }
    if ((operator === '==' || operator === '!=') && this.isTuple(left.type) && this.isTuple(right.type)) {
      return this.bindTupleEquality(operator, left, right, node.row, context);
    }
    const result = this.bindBinary(operator, left, right, row);
    return { ...result, row: node.row } as BoundExpression;
  }

  private isTuple(type: Type): type is NamedType {
    return type.kind === 'named' && type.symbol.special === 'valueTuple';
  }

  /** Whether the pattern being bound is the type of an `x is T` operator. */
  protected isTypeTestOperator = false;

  /** Whether the pattern being bound is an `is` expression's rather than a switch's. */
  protected isUnderIsPattern = false;

  /**
   * Binds `==` or `!=` of two tuples, which compares their elements in order after evaluating both tuples, stopping at
   * the first element that decides the result (C# spec §12.12.11).
   */

  private bindTupleEquality(
    operator: '==' | '!=',
    left: BoundExpression,
    right: BoundExpression,
    row: number,
    context: BindContext
  ): BoundExpression {
    const leftType = left.type as NamedType;
    const rightType = right.type as NamedType;
    if (leftType.args.length !== rightType.args.length) {
      this.reportBinary(operator, left, right, row);
      return { kind: 'default', type: ERROR_TYPE, row };
    }
    const temporaryOf = (type: Type): BoundExpression => {
      const local = new LocalSymbol('\0tuple', type, row, 0);
      local.isHidden = true;
      context.fn.addLocal(local);
      return { kind: 'local', local, type, row };
    };
    const leftTemporary = temporaryOf(leftType);
    const rightTemporary = temporaryOf(rightType);
    const element = (tuple: BoundExpression, type: NamedType, index: number): BoundExpression => ({
      kind: 'field',
      receiver: tuple,
      field: type.symbol.fields.find((field) => field.name === `Item${index + 1}`) as FieldSymbol,
      type: type.args[index],
      row,
    });
    const comparisons = leftType.args.map((_, index) => {
      const a = element(leftTemporary, leftType, index);
      const b = element(rightTemporary, rightType, index);
      return this.isTuple(a.type) && this.isTuple(b.type)
        ? this.bindTupleEquality(operator, a, b, row, context)
        : this.bindBinary(operator, a, b, row);
    });
    let value = comparisons[0];
    for (const comparison of comparisons.slice(1)) {
      value = {
        kind: 'logical',
        operator: operator === '==' ? '&&' : '||',
        left: value,
        right: comparison,
        type: this.boolType,
        row,
      };
    }
    const assign = (target: BoundExpression, source: BoundExpression): BoundExpression => ({
      kind: 'assign',
      target: target as BoundLValue,
      value: source,
      type: target.type,
      row,
    });
    return {
      kind: 'sequence',
      locals: [],
      sideEffects: [assign(leftTemporary, left), assign(rightTemporary, right)],
      value,
      type: this.boolType,
      row,
    };
  }

  private bindCoalesce(node: Extract<Expression, { kind: 'binary' }>, context: BindContext): BoundExpression {
    const left = this.bindValue(node.left, context);
    const right = this.bindAllowingThrow(node.right, context);
    if (left.type.kind === 'error') return { kind: 'default', type: ERROR_TYPE, row: node.row };
    const underlying = nullableUnderlying(left.type);
    if (
      !underlying &&
      !this.isReference(left.type) &&
      left.type.kind !== 'typeParameter' &&
      left.type.kind !== 'null'
    ) {
      this.error(
        node.operatorRow,
        'CS0019',
        `演算子 '??' を '${displayType(left.type)}' と '${displayType(right.type)}' 型のオペランドに適用することはできません`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    if (right.kind === 'throw')
      return {
        kind: 'coalesce',
        left,
        right,
        unwrapLeft: underlying !== undefined,
        type: underlying ?? left.type,
        row: node.row,
      };
    if (underlying && this.implicitConversionOf(right, underlying)) {
      return {
        kind: 'coalesce',
        left,
        right: this.convert(right, underlying, node),
        unwrapLeft: true,
        type: underlying,
        row: node.row,
      };
    }
    if (this.implicitConversionOf(right, left.type)) {
      return {
        kind: 'coalesce',
        left,
        right: this.convert(right, left.type, node),
        unwrapLeft: false,
        type: left.type,
        row: node.row,
      };
    }
    const leftType = underlying ?? left.type;
    if (right.kind !== 'unbound' && this.conversions.implicit(leftType, right.type)) {
      return {
        kind: 'coalesce',
        left: this.convert(left, nullableUnderlying(right.type) ? right.type : left.type, node),
        right,
        unwrapLeft: underlying !== undefined && !nullableUnderlying(right.type),
        type: right.type,
        row: node.row,
      };
    }
    this.error(
      node.operatorRow,
      'CS0019',
      `演算子 '??' を '${displayType(left.type)}' と '${displayType(right.type)}' 型のオペランドに適用することはできません`
    );
    return { kind: 'default', type: ERROR_TYPE, row: node.row };
  }

  /** Binds `c ? a : b`, with the natural type of its branches, or with a target type when they have none. */
  private readonly conditionalParts = new WeakMap<
    Expression,
    { scope: LocalScope; condition: BoundExpression; whenTrue: BoundExpression; whenFalse: BoundExpression }
  >();

  private bindConditional(
    node: Extract<Expression, { kind: 'conditional' }>,
    context: BindContext,
    target: Type | undefined
  ): BoundExpression | undefined {
    // A conditional without a natural type binds again once its target is known, reusing its parts so that the
    // variables its condition declares (`out int n`) are declared once.
    let parts = this.conditionalParts.get(node);
    // A lambda's body binds once per candidate delegate type, each time in a new scope, which binds anew.
    if (parts?.scope !== context.scope) {
      parts = {
        scope: context.scope,
        condition: this.bindAs(node.condition, this.boolType, context),
        whenTrue: this.bindAllowingThrow(node.whenTrue, context),
        whenFalse: this.bindAllowingThrow(node.whenFalse, context),
      };
      this.conditionalParts.set(node, parts);
    }
    const { condition, whenTrue, whenFalse } = parts;
    const type = target ?? this.bestCommonType([whenTrue, whenFalse]);
    if (!type) {
      if (
        whenTrue.kind !== 'unbound' &&
        whenFalse.kind !== 'unbound' &&
        whenTrue.type.kind !== 'null' &&
        whenFalse.type.kind !== 'null' &&
        whenTrue.kind !== 'throw' &&
        whenFalse.kind !== 'throw'
      ) {
        this.error(
          node,
          'CS0173',
          `'${displayType(whenTrue.type)}' と '${displayType(whenFalse.type)}' の間に暗黙的な変換がないため、条件式の型がわかりません`
        );
        return { kind: 'default', type: ERROR_TYPE, row: node.row };
      }
      return undefined;
    }
    const convert = (branch: BoundExpression, syntax: Expression): BoundExpression =>
      branch.kind === 'throw' ? branch : this.convert(branch, type, syntax);
    const result: BoundExpression = {
      kind: 'conditional',
      condition,
      whenTrue: convert(whenTrue, node.whenTrue),
      whenFalse: convert(whenFalse, node.whenFalse),
      type,
      row: node.row,
    };
    if (condition.kind === 'constant' && result.whenTrue.kind === 'constant' && result.whenFalse.kind === 'constant') {
      return condition.value ? result.whenTrue : result.whenFalse;
    }
    return result;
  }

  /** The type that every expression converts to among their own types, as `?:`, `switch`, and `new[]` choose. */
  protected bestCommonType(expressions: BoundExpression[]): Type | undefined {
    const typed = expressions.filter(
      (expression) => expression.kind !== 'unbound' && expression.type.kind !== 'null' && expression.kind !== 'throw'
    );
    const candidates = typed
      .map((expression) => expression.type)
      .filter((type, index, list) => list.findIndex((other) => sameType(other, type)) === index);
    if (candidates.some((type) => type.kind === 'error')) return ERROR_TYPE;
    const viable = candidates.filter((candidate) =>
      expressions.every(
        (expression) => expression.kind === 'throw' || this.implicitConversionOf(expression, candidate) !== undefined
      )
    );
    if (viable.length === 0) {
      // `cond ? 1 : null` has no common type among its operands' types, but converts both to `int?` as a target.
      return undefined;
    }
    const best = viable.filter((candidate) =>
      viable.every(
        (other) =>
          other === candidate ||
          this.conversions.implicit(candidate, other) === undefined ||
          this.conversions.implicit(other, candidate) !== undefined
      )
    );
    if (best.length > 0)
      return (
        best.find((candidate) => viable.every((other) => this.conversions.implicit(other, candidate) !== undefined)) ??
        best[0]
      );
    return undefined;
  }

  private bindAs2(node: Extract<Expression, { kind: 'as' }>, context: BindContext): BoundExpression {
    const operand = this.bindValue(node.operand, context);
    const type = this.resolveType(node.type, context.fn.typeContext);
    if (type.kind === 'error' || operand.type.kind === 'error') return { kind: 'default', type, row: node.row };
    if (isValueType(type) && !nullableUnderlying(type)) {
      this.error(
        node,
        'CS0077',
        `as 演算子は参照型または null 許容型で使用してください ('${displayType(type)}' は null 非許容の値型です)`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const conversion = this.conversions.explicit(operand.type, type);
    if (operand.type.kind !== 'null' && (!conversion || conversion === 'numeric' || conversion === 'enumNumeric')) {
      this.error(
        node,
        'CS0039',
        `参照の変換、ボックス変換、アンボックス変換、折り返しの変換、または null 型の変換で、型 '${displayType(operand.type)}' を '${displayType(type)}' に変換できません`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    return { kind: 'as', operand, targetType: type, type, row: node.row };
  }

  private bindNewArray(node: Extract<Expression, { kind: 'newArray' }>, context: BindContext): BoundExpression {
    const type = this.resolveType(node.type, context.fn.typeContext);
    if (type.kind !== 'array') return { kind: 'default', type: ERROR_TYPE, row: node.row };
    const sizes = node.sizes
      .filter((size): size is Expression => size !== undefined)
      .map((size) => {
        const bound = this.bindValue(size, context);
        const special = specialOf(bound.type);
        const converted = this.convert(
          bound,
          special === 'long' || special === 'uint' || special === 'ulong' ? bound.type : this.intType,
          size
        );
        if (converted.kind === 'constant' && typeof converted.value === 'number' && converted.value < 0)
          this.error(size, 'CS0248', '負のサイズで配列を作成することはできません');
        return converted;
      });
    if (!node.initializer) {
      if (sizes.length === 0) {
        this.error(node, 'CS1586', '配列を作成するには、配列のサイズまたは配列の初期化子を指定する必要があります');
        return { kind: 'default', type: ERROR_TYPE, row: node.row };
      }
      return { kind: 'newArray', arrayType: type, sizes, elements: undefined, type, row: node.row };
    }
    return this.bindArrayInitializer(node.initializer, type, context, sizes);
  }

  /** Binds `{ ... }` as the elements of an array of a type, flattening the elements of a multidimensional one. */
  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  bindArrayInitializer(
    initializer: Extract<Expression, { kind: 'arrayInitializer' }>,
    type: Type,
    context: BindContext,
    sizes: BoundExpression[] = []
  ): BoundExpression {
    if (type.kind !== 'array') {
      if (type.kind !== 'error')
        this.error(
          initializer,
          'CS0622',
          '配列型を割り当てるには配列初期化子式だけを使用してください。new 式を使用してください。'
        );
      return { kind: 'default', type: ERROR_TYPE, row: initializer.row };
    }
    const lengths: number[] = [];
    const elements: BoundExpression[] = [];
    const visit = (node: Extract<Expression, { kind: 'arrayInitializer' }>, depth: number): void => {
      if (lengths[depth] === undefined) lengths[depth] = node.elements.length;
      else if (lengths[depth] !== node.elements.length)
        this.error(node, 'CS0847', `長さが '${lengths[depth]}' の配列初期化子が必要です`);
      for (const element of node.elements) {
        if (depth + 1 < type.rank) {
          if (element.kind !== 'arrayInitializer') {
            this.error(element, 'CS0846', '入れ子になった配列初期化子が必要です');
            continue;
          }
          visit(element, depth + 1);
        } else if (element.kind === 'arrayInitializer') {
          elements.push(this.bindArrayInitializer(element, type.element, context));
        } else {
          elements.push(this.bindAs(element, type.element, context));
        }
      }
    };
    visit(initializer, 0);
    for (const [index, size] of sizes.entries()) {
      if (size.kind !== 'constant') this.error(size.row, 'CS0150', '定数値が必要です');
      else if (Number(size.value) !== (lengths[index] ?? 0))
        this.error(size.row, 'CS0847', `長さが '${Number(size.value)}' の配列初期化子が必要です`);
    }
    const lengthNodes = Array.from({ length: type.rank }, (_unused, index) =>
      this.constant(lengths[index] ?? 0, this.intType, initializer.row)
    );
    return { kind: 'newArray', arrayType: type, sizes: lengthNodes, elements, type, row: initializer.row };
  }

  private bindImplicitArray(
    node: Extract<Expression, { kind: 'implicitNewArray' }>,
    context: BindContext
  ): BoundExpression {
    const values = node.initializer.elements.map((element) =>
      element.kind === 'arrayInitializer' ? undefined : this.bindValue(element, context)
    );
    const typed = values.filter((value): value is BoundExpression => value !== undefined);
    const element = this.bestCommonType(typed);
    if (!element || element.kind === 'error') {
      if (!element) this.error(node, 'CS0826', '暗黙的に型指定された配列の最適な型が見つかりませんでした');
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const type = arrayType(element);
    const elements = typed.map((value) => this.convert(value, element, value.row));
    return {
      kind: 'newArray',
      arrayType: type,
      sizes: [this.constant(elements.length, this.intType, node.row)],
      elements,
      type,
      row: node.row,
    };
  }

  private bindTuple(node: Extract<Expression, { kind: 'tuple' }>, context: BindContext): BoundExpression {
    if (node.elements.length < 2) {
      this.error(node, 'CS8124', 'タプルには 2 つ以上の要素が必要です。');
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const elements = node.elements.map((element) => this.bindValue(element.value, context));
    if (elements.some((element) => element.kind === 'unbound' || element.type.kind === 'null'))
      return { kind: 'unbound', node, context, type: ERROR_TYPE, row: node.row };
    const names = node.elements.map((element) => element.name ?? inferredTupleName(element.value));
    const explicitNames = node.elements.map((element) => element.name);
    const uniqueNames = names.map((name, index) =>
      name && names.indexOf(name) === index && !/^Item\d+$/.test(name) ? name : explicitNames[index]
    );
    if (elements.some((element) => element.type.kind === 'void')) {
      this.error(node, 'CS8210', "タプルに 'void' 型の値を含めることはできません。");
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const type = this.tupleType(
      elements.map((element) => element.type),
      uniqueNames
    );
    return { kind: 'tuple', elements, type, row: node.row };
  }

  /** Binds a lambda to a delegate type, or returns undefined when it does not convert, reporting why if `report`. */
  protected bindLambda(
    node: LambdaExpression,
    outer: BindContext,
    delegateType: NamedType | undefined,
    parameterTypes: Type[],
    returnType: Type | undefined,
    report: boolean
  ): { result: BoundExpression | undefined; returnType: Type | undefined } {
    const key = `${parameterTypes.map((type) => displayType(type)).join(',')}->${returnType ? displayType(returnType) : '?'}`;
    let cache = this.lambdaCache.get(node);
    if (!cache) {
      cache = new Map();
      this.lambdaCache.set(node, cache);
    }
    const cached = cache.get(key);
    if (cached && !report) return { result: cached.result, returnType: cached.returnType };
    const savedDiagnostics = this.diagnostics.length;
    const context = this.lambdaContext(node, outer, parameterTypes, returnType);
    const method = context.fn.method;
    const savedThrow = this.allowsThrowExpression;
    let bound: { body: BoundBlock; inferred: Type | undefined };
    try {
      bound = this.bindLambdaBody(node, context, returnType, report);
    } finally {
      this.allowsThrowExpression = savedThrow;
    }
    const { body, inferred } = bound;
    method.body = body;
    const failed = this.diagnostics.length > savedDiagnostics;
    const lambda: LambdaInfo = { method, captures: [...context.fn.captures], isStatic: node.isStatic };
    const result: BoundExpression | undefined =
      failed || !delegateType ? undefined : { kind: 'lambda', lambda, type: delegateType, row: node.row };
    if (!report) {
      const diagnostics = this.diagnostics.splice(savedDiagnostics);
      cache.set(key, { result, diagnostics, returnType: inferred });
      return { result, returnType: inferred };
    }
    return {
      result: delegateType ? { kind: 'lambda', lambda, type: delegateType, row: node.row } : undefined,
      returnType: inferred,
    };
  }

  /** The scope of a lambda's body, with a method for the lambda and its parameters declared. */
  private lambdaContext(
    node: LambdaExpression,
    outer: BindContext,
    parameterTypes: Type[],
    returnType: Type | undefined
  ): BindContext {
    const method = new MethodSymbol('<lambda>', outer.fn.method.owner, 'localFunction');
    method.isStatic = outer.fn.isStatic;
    (method as { isStaticLambda?: boolean }).isStaticLambda = node.isStatic;
    method.row = node.row;
    method.returnType = returnType ?? VOID_TYPE;
    method.parameters = node.parameters.map((parameter, index) => ({
      name: parameter.name,
      type: parameterTypes[index] ?? ERROR_TYPE,
      refKind: parameter.modifier,
      isParams: false,
    }));
    const fn = new FunctionScope(
      method,
      outer.fn,
      outer.fn.typeContext,
      returnType,
      outer.fn.isStatic || node.isStatic,
      outer.fn.isStatic || node.isStatic ? undefined : outer.fn.thisType,
      'lambda'
    );
    const scope = new LocalScope(outer.scope, fn);
    const context: BindContext = { scope, fn };
    for (const [index, parameter] of node.parameters.entries()) {
      if (parameter.name === '_' && node.parameters.filter((other) => other.name === '_').length > 1) continue;
      this.declareParameterLocal(parameter, parameterTypes[index] ?? ERROR_TYPE, context);
    }
    return context;
  }

  private bindLambdaBody(
    node: LambdaExpression,
    context: BindContext,
    returnType: Type | undefined,
    report: boolean
  ): { body: BoundBlock; inferred: Type | undefined } {
    if (node.body.kind === 'block') {
      const body = this.bindFunctionBlock(node.body, context);
      const { fn } = context;
      const inferred =
        returnType ??
        (fn.returnsValue
          ? (this.bestCommonType(
              fn.returnTypes.map((type) => ({ kind: 'default', type, row: node.row }) as BoundExpression)
            ) ?? ERROR_TYPE)
          : VOID_TYPE);
      return { body, inferred };
    }
    const savedThrow = this.allowsThrowExpression;
    this.allowsThrowExpression = true;
    const value = this.bindValue(node.body, context);
    this.allowsThrowExpression = savedThrow;
    return this.expressionLambdaBody(node, node.body, value, returnType, report);
  }

  /** The body of a lambda with an expression body, converted to the delegate's return type. */
  private expressionLambdaBody(
    node: LambdaExpression,
    bodyNode: Expression,
    value: BoundExpression,
    returnType: Type | undefined,
    report: boolean
  ): { body: BoundBlock; inferred: Type | undefined } {
    if (returnType === undefined) {
      const inferred = value.kind === 'throw' ? undefined : value.kind === 'unbound' ? undefined : value.type;
      return { body: this.expressionBody(value, inferred, node.row), inferred };
    }
    if (returnType.kind === 'void')
      return { body: this.voidLambdaBody(node, bodyNode, value, report), inferred: VOID_TYPE };
    const converted = value.kind === 'throw' ? value : this.convert(value, returnType, bodyNode);
    if (
      report &&
      !node.isQuery &&
      value.kind !== 'throw' &&
      value.type.kind !== 'error' &&
      !this.implicitConversionOf(value, returnType)
    ) {
      this.error(
        bodyNode,
        'CS1662',
        'デリゲート戻り値の型に暗黙的に変換できない戻り値の型がブロック内にあるため、ラムダ式 を目的のデリゲート型に変換できません'
      );
    }
    return { body: this.expressionBody(converted, returnType, node.row), inferred: returnType };
  }
  /** The body of a lambda with an expression body whose delegate returns void, which must be a statement expression. */
  private voidLambdaBody(
    node: LambdaExpression,
    bodyNode: Expression,
    value: BoundExpression,
    report: boolean
  ): BoundBlock {
    if (!this.isStatementExpression(value)) {
      if (report)
        this.error(
          bodyNode,
          'CS0201',
          '代入、呼び出し、インクリメント、デクリメント、新しいオブジェクトの式のみがステートメントとして使用できます'
        );
      else this.diagnostics.push({ row: node.row, message: 'not a statement' });
    }
    return {
      kind: 'block',
      statements: [{ kind: 'expression', expression: value, row: bodyNode.row, step: 'none' }],
      capturedLocals: [],
      locals: [],
      row: node.row,
      step: 'none',
    };
  }

  /** Declares a lambda's parameter, which may hide an enclosing function's local of the same name (since C# 8). */
  private declareParameterLocal(parameter: LambdaParameter, type: Type, context: BindContext): void {
    const local = new LocalSymbol(parameter.name, type, parameter.row, parameter.column);
    local.isParameter = true;
    local.refKind = parameter.modifier;
    local.isTransparent = parameter.name.startsWith(TRANSPARENT_PREFIX);
    local.isHidden = local.isTransparent;
    context.fn.addLocal(local);
    context.scope.variables.set(parameter.name, local);
  }

  private expressionBody(value: BoundExpression, returnType: Type | undefined, row: number): BoundBlock {
    const statement =
      returnType?.kind === 'void'
        ? { kind: 'expression' as const, expression: value, row, step: 'none' as const }
        : { kind: 'return' as const, value, row, step: 'none' as const };
    return { kind: 'block', statements: [statement], capturedLocals: [], locals: [], row, step: 'none' };
  }

  /** Whether an expression may stand as a statement: an assignment, a call, an increment, `new`, or `await`. */
  isStatementExpression(expression: BoundExpression): boolean {
    switch (expression.kind) {
      case 'assign':
      case 'compoundAssign':
      case 'increment':
      case 'call':
      case 'invokeDelegate':
      case 'new':
      case 'deconstructAssign':
      case 'eventAccessor':
      case 'throw': {
        return true;
      }
      case 'conditionalAccess': {
        return this.isStatementExpression(expression.access);
      }
      case 'convert': {
        return expression.operand.kind === 'call' && !expression.isExplicit;
      }
      case 'sequence': {
        return this.isStatementExpression(expression.value);
      }
      case 'default': {
        return expression.failedCall === true || expression.type.kind === 'error';
      }
      default: {
        return expression.type.kind === 'error';
      }
    }
  }

  protected bindUnbound(
    expression: Unbound,
    target: Type,
    mode: ConversionMode,
    report: boolean
  ): BoundExpression | undefined {
    const node = expression.node;
    const context = expression.context as BindContext;
    // A method group or a lambda converts to `object` or `Delegate` through its natural type (C# 10).
    if ((expression.methodGroup || node.kind === 'lambda') && !isDelegateType(target) && target.kind !== 'error') {
      const natural = this.naturalTypeOf(expression);
      if (natural && this.conversions.implicit(natural, target) === 'reference') {
        const bound = this.bindUnbound(expression, natural, mode, report);
        return bound && this.convert(bound, target, expression.row);
      }
    }
    if (expression.methodGroup)
      return this.bindMethodGroupConversion(
        expression.methodGroup as Extract<NonValue, { kind: 'methodGroup' }>,
        target,
        report,
        expression.row
      );
    switch (node.kind) {
      case 'lambda': {
        return this.bindLambdaTo(node, context, target, report);
      }
      case 'implicitNew': {
        return this.attempt(report, () => this.bindCreation(target, node.args, node.initializer, node, context));
      }
      case 'default': {
        return this.defaultValue(target, node.row);
      }
      case 'collection': {
        return this.attempt(report, () => this.bindCollectionExpression(node, target, context));
      }
      case 'conditional': {
        return this.attempt(report, () => this.bindConditional(node, context, target));
      }
      case 'switch': {
        return this.attempt(report, () => this.bindSwitchExpression(node, context, target));
      }
      case 'tuple': {
        return this.bindTupleTo(node, context, target, mode, report);
      }
      default: {
        return undefined;
      }
    }
  }

  /** Binds, discarding the result and its diagnostics when it fails unless `report`. */
  private attempt(report: boolean, bind: () => BoundExpression | undefined): BoundExpression | undefined {
    if (report) return bind();
    const saved = this.diagnostics.length;
    const result = bind();
    const failed = this.diagnostics.length > saved;
    this.diagnostics.length = saved;
    return failed ? undefined : result;
  }

  private bindLambdaTo(
    node: LambdaExpression,
    context: BindContext,
    target: Type,
    report: boolean
  ): BoundExpression | undefined {
    const invoke = this.delegateInvokeOf(target);
    if (!invoke) {
      if (report && target.kind !== 'error')
        this.error(node, 'CS1660', `ラムダ式 はデリゲート型ではないため、'${displayType(target)}' 型に変換できません`);
      return undefined;
    }
    if (invoke.parameterTypes.length !== node.parameters.length) {
      if (report)
        this.error(
          node,
          'CS1593',
          `デリゲート '${displayType(target)}' には引数 ${node.parameters.length} を指定できません`
        );
      return undefined;
    }
    for (const [index, parameter] of node.parameters.entries()) {
      if (!parameter.type) continue;
      const declared = this.resolveType(parameter.type, context.fn.typeContext);
      if (!sameType(declared, invoke.parameterTypes[index])) {
        if (report)
          this.error(
            parameter,
            'CS1678',
            `パラメーター ${index + 1} は '${displayType(declared)}' 型として宣言しますが、'${displayType(invoke.parameterTypes[index])}' である必要があります`
          );
        return undefined;
      }
    }
    return this.bindLambda(node, context, target as NamedType, invoke.parameterTypes, invoke.returnType, report).result;
  }

  private bindTupleTo(
    node: Extract<Expression, { kind: 'tuple' }>,
    context: BindContext,
    target: Type,
    mode: ConversionMode,
    report: boolean
  ): BoundExpression | undefined {
    if (target.kind !== 'named' || specialOf(target) !== 'valueTuple' || target.args.length !== node.elements.length) {
      if (report)
        this.error(
          node,
          'CS0029',
          `型 '${this.tupleDisplay(node, context)}' を '${displayType(target, true)}' に暗黙的に変換できません`
        );
      return undefined;
    }
    return this.attempt(report, () => ({
      kind: 'tuple',
      elements: node.elements.map((element, index) =>
        this.convert(this.bindValue(element.value, context), target.args[index], element, mode)
      ),
      type: target,
      row: node.row,
    }));
  }

  private tupleDisplay(node: Extract<Expression, { kind: 'tuple' }>, context: BindContext): string {
    return `(${node.elements
      .map((element) => {
        const value = this.bindValue(element.value, context);
        return value.type.kind === 'null' ? '<null>' : value.kind === 'unbound' ? '?' : displayType(value.type);
      })
      .join(', ')})`;
  }

  protected naturalTypeOf(expression: Unbound): Type | undefined {
    const node = expression.node;
    if (expression.methodGroup) {
      const group = expression.methodGroup as Extract<NonValue, { kind: 'methodGroup' }>;
      if (group.candidates.length !== 1 || group.candidates[0].method.typeParameters.length > 0) return undefined;
      const method = group.candidates[0].method;
      const substitution = substitutionOf(group.candidates[0].owner);
      return this.functionTypeOf(
        method.parameters.map((parameter) => substitute(parameter.type, substitution)),
        substitute(method.returnType, substitution)
      );
    }
    if (node.kind === 'lambda') {
      if (node.parameters.some((parameter) => !parameter.type)) return undefined;
      const context = expression.context as BindContext;
      const parameterTypes = node.parameters.map((parameter) =>
        this.resolveType(parameter.type as NonNullable<LambdaParameter['type']>, context.fn.typeContext)
      );
      const declaredReturn = node.returnType ? this.resolveType(node.returnType, context.fn.typeContext) : undefined;
      const returnType =
        declaredReturn ?? this.bindLambda(node, context, undefined, parameterTypes, undefined, false).returnType;
      if (!returnType) return undefined;
      return this.functionTypeOf(parameterTypes, returnType);
    }
    return undefined;
  }

  /** The `Func` or `Action` type of parameter and return types, the natural type of lambdas and method groups. */
  protected functionTypeOf(parameterTypes: Type[], returnType: Type): NamedType | undefined {
    const isAction = returnType.kind === 'void';
    const arity = parameterTypes.length + (isAction ? 0 : 1);
    if (parameterTypes.length > 6) return undefined;
    const symbol = this.library.typeNamed(`System.${isAction ? 'Action' : 'Func'}`, arity);
    return namedType(symbol, isAction ? parameterTypes : [...parameterTypes, returnType]);
  }

  protected inferReturnType(expression: Unbound, parameterTypes: Type[]): Type | undefined {
    if (expression.methodGroup) {
      const group = expression.methodGroup as Extract<NonValue, { kind: 'methodGroup' }>;
      const args: ArgumentInfo[] = parameterTypes.map((type) => ({
        expression: { kind: 'default', type, row: expression.row },
        name: undefined,
        refKind: undefined,
        row: expression.row,
        target: undefined,
      }));
      const saved = this.diagnostics.length;
      const resolved = this.resolveCall(group.candidates, args, group.typeArgs, expression.row, {
        name: group.name,
        kind: 'method',
      });
      this.diagnostics.length = saved;
      if (!resolved) return undefined;
      return substitute(
        resolved.candidate.method.returnType,
        this.callSubstitution(resolved.candidate, resolved.typeArgs)
      );
    }
    const node = expression.node;
    if (node.kind !== 'lambda') return undefined;
    if (node.parameters.length !== parameterTypes.length) return undefined;
    return this.bindLambda(node, expression.context as BindContext, undefined, parameterTypes, undefined, false)
      .returnType;
  }

  protected lambdaParameterTypes(expression: Unbound): Type[] | undefined {
    const node = expression.node;
    if (node.kind !== 'lambda' || node.parameters.length === 0 || node.parameters.some((parameter) => !parameter.type))
      return undefined;
    const context = expression.context as BindContext;
    return node.parameters.map((parameter) =>
      this.resolveType(parameter.type as NonNullable<LambdaParameter['type']>, context.fn.typeContext)
    );
  }

  /** The default value of a type: null for references and nullables, zero for numbers, an empty struct. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  defaultValue(type: Type, row: number): BoundExpression {
    const special = specialOf(type);
    if (type.kind === 'named' && !nullableUnderlying(type)) {
      if (special === 'bool') return this.constant(false, type, row);
      if (special === 'decimal') return this.constant(CsDecimal.ZERO, type, row);
      if (special === 'long' || special === 'ulong') return this.constant(0n, type, row);
      if (special && isNumeric(type)) return this.constant(0, type, row);
      if (isEnum(type)) {
        const underlying = specialOf(type.symbol.enumUnderlying as Type);
        return this.constant(underlying === 'long' || underlying === 'ulong' ? 0n : 0, type, row);
      }
    }
    if (this.isReference(type) || nullableUnderlying(type)) return this.constant(undefined, type, row);
    return { kind: 'default', type, row };
  }

  /** Binds `[a, b, ..c]` as an array, a list, or another collection type of its target. */
  // code-gauge-allow functionNcss -- Each kind of collection that a collection expression creates.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private bindCollectionExpression(
    node: Extract<Expression, { kind: 'collection' }>,
    target: Type,
    context: BindContext
  ): BoundExpression | undefined {
    const elementType = this.collectionElementType(target);
    if (!elementType) {
      this.error(
        node,
        'CS9174',
        `型が構築可能でないため、コレクション式で型 '${displayType(target)}' を初期化できません。`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const elements = node.elements.map((element) => {
      if (!element.spread) return { spread: false, value: this.bindAs(element.value, elementType, context) };
      const value = this.bindValue(element.value, context);
      return { spread: true, value };
    });
    const row = node.row;
    const listType = namedType(this.library.typeNamed('System.Collections.Generic.List', 1), [elementType]);
    const createType =
      target.kind === 'array' || (target.kind === 'named' && target.symbol.kind === 'interface') ? listType : target;
    const temporary = new LocalSymbol('\0collection', createType, row, node.column);
    temporary.isHidden = true;
    context.fn.addLocal(temporary);
    const receiver: BoundExpression = { kind: 'local', local: temporary, type: createType, row };
    const sideEffects: BoundExpression[] = [];
    const created = this.bindCreation(createType, [], undefined, node, context);
    sideEffects.push({ kind: 'assign', target: receiver as BoundLValue, value: created, type: createType, row });
    const isList = sameType(createType, listType);
    for (const element of elements) {
      if (element.spread && !isList) {
        sideEffects.push(this.addAll(receiver, element.value, elementType, node));
        continue;
      }
      const group = this.bindInstanceMember(receiver, element.spread ? 'AddRange' : 'Add', undefined, node, context);
      if (group.kind !== 'methodGroup') return { kind: 'default', type: ERROR_TYPE, row };
      sideEffects.push(
        this.invokeMethodGroup(
          group,
          [{ expression: element.value, name: undefined, refKind: undefined, row, target: undefined }],
          node
        )
      );
    }
    let value: BoundExpression = receiver;
    if (target.kind === 'array') {
      const toArray = this.bindInstanceMember(receiver, 'ToArray', undefined, node, context);
      if (toArray.kind === 'methodGroup') value = this.invokeMethodGroup(toArray, [], node);
    } else if (createType !== target) {
      value = this.convert(receiver, target, node);
    }
    return { kind: 'sequence', locals: [temporary], sideEffects, value, type: target, row };
  }

  /** Adds a spread's elements to a collection other than a list one by one, as Roslyn's `foreach` with `Add` does. */
  private addAll(
    collection: BoundExpression,
    items: BoundExpression,
    elementType: Type,
    position: Position
  ): BoundExpression {
    const builder = this.library.typeNamed('System.Linq.Internal.CollectionBuilder');
    const method = builder.methods.find((candidate) => candidate.name === 'AddAll') as MethodSymbol;
    const enumerable = namedType(this.library.typeNamed('System.Collections.Generic.IEnumerable', 1), [elementType]);
    const target = namedType(this.library.typeNamed('System.Collections.Generic.ICollection', 1), [elementType]);
    return {
      kind: 'call',
      method,
      receiver: undefined,
      args: [this.convert(collection, target, position), this.convert(items, enumerable, position)],
      typeArgs: [elementType],
      owner: builder.declaredType,
      isVirtual: false,
      type: VOID_TYPE,
      row: position.row,
    };
  }

  /** The element type of a collection expression's target: an array's, or a generic collection's type argument. */
  private collectionElementType(target: Type): Type | undefined {
    if (target.kind === 'array' && target.rank === 1) return target.element;
    if (target.kind !== 'named') return undefined;
    const name = target.symbol.fullName;
    const supported = [
      'System.Collections.Generic.List`1',
      'System.Collections.Generic.IEnumerable`1',
      'System.Collections.Generic.IList`1',
      'System.Collections.Generic.ICollection`1',
      'System.Collections.Generic.IReadOnlyList`1',
      'System.Collections.Generic.IReadOnlyCollection`1',
      'System.Collections.Generic.HashSet`1',
      'System.Collections.Generic.LinkedList`1',
      'System.Collections.Generic.SortedSet`1',
      'System.Collections.Generic.Queue`1',
      'System.Collections.Generic.Stack`1',
    ];
    if (supported.includes(name)) return target.args[0];
    return undefined;
  }

  private bindAnonymousObject(
    node: Extract<Expression, { kind: 'anonymousObject' }>,
    context: BindContext
  ): BoundExpression {
    const members = node.members.map((member) => {
      const name = member.name ?? inferredTupleName(member.value);
      if (!name)
        this.error(
          member.value,
          'CS0746',
          '匿名型のメンバー宣言子が無効です。メンバー代入、簡易名、またはメンバー アクセスを使用して、匿名型メンバーを宣言する必要があります。'
        );
      const value = this.bindValue(member.value, context);
      if (value.type.kind === 'null' || value.kind === 'unbound' || value.type.kind === 'void') {
        this.error(
          member.value,
          'CS0828',
          `'${value.type.kind === 'null' ? '<null>' : value.type.kind === 'void' ? 'void' : 'ラムダ式'}' を匿名型のプロパティに割り当てることはできません`
        );
      }
      return { name: name ?? '?', value };
    });
    const symbol = this.anonymousTypeOf(members.map((member) => ({ name: member.name, type: member.value.type })));
    const type = namedType(symbol, []);
    const args = members.map((member) => member.value);
    return {
      kind: 'new',
      constructor: symbol.constructors[0],
      objectType: type,
      args,
      initializer: undefined,
      type,
      row: node.row,
    };
  }

  /** The anonymous type with members of the names and types, which `new { ... }` creates. */
  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  private anonymousTypeOf(members: { name: string; type: Type }[]): TypeSymbol {
    const key = members.map((member) => `${member.name}:${displayType(member.type)}`).join(';');
    let symbol = this.anonymousTypes.get(key);
    if (symbol) return symbol;
    symbol = new TypeSymbol(`<>f__AnonymousType${this.anonymousTypes.size}`, 'class', '', undefined);
    symbol.isSealed = true;
    symbol.access = 'internal';
    symbol.baseType = this.objectType;
    symbol.runtimeNameOverride = `<>f__AnonymousType${this.anonymousTypes.size}\`${members.length}`;
    symbol.anonymousDisplay = `<anonymous type: ${members.map((member) => `${displayType(member.type)} ${member.name}`).join(', ')}>`;
    const constructor = new MethodSymbol('.ctor', symbol, 'constructor');
    constructor.access = 'public';
    constructor.parameters = members.map((member): ParameterSymbol => ({
      name: member.name,
      type: member.type,
      refKind: undefined,
      isParams: false,
    }));
    constructor.native = (call, receiver, args) => call.frame.runtime.anonymousConstruct(receiver, args);
    symbol.constructors.push(constructor);
    for (const [index, member] of members.entries()) {
      const property = new PropertySymbol(member.name, member.type, symbol, false);
      property.access = 'public';
      const getter = new MethodSymbol(`get_${member.name}`, symbol, 'getter');
      getter.access = 'public';
      getter.property = property;
      getter.returnType = member.type;
      getter.native = (_call, receiver) => (receiver as CsObject).fields[index];
      property.getter = getter;
      // A backing field, which only a `with` expression assigns.
      const field = new FieldSymbol(`<${member.name}>i__Field`, member.type, symbol);
      field.slot = index;
      field.isReadonly = true;
      field.property = property;
      field.access = 'private';
      property.backingField = field;
      symbol.fields.push(field);
      symbol.properties.push(property);
    }
    symbol.instanceFieldCount = members.length;
    for (const name of ['ToString', 'Equals', 'GetHashCode']) {
      const method = new MethodSymbol(name, symbol, 'method');
      method.access = 'public';
      method.isOverride = true;
      method.returnType = name === 'ToString' ? this.stringType : name === 'Equals' ? this.boolType : this.intType;
      method.parameters =
        name === 'Equals' ? [{ name: 'value', type: this.objectType, refKind: undefined, isParams: false }] : [];
      method.native = (call, receiver, args) => call.frame.runtime.recordMember(call, name, receiver, args);
      const objectMethod = this.objectType.symbol.methods.find(
        (candidate) => candidate.name === name && candidate.parameters.length === method.parameters.length
      );
      method.overridden = objectMethod;
      symbol.methods.push(method);
    }
    this.anonymousTypes.set(key, symbol);
    return symbol;
  }

  /** Binds `x with { P = v }`, which copies a record or struct and assigns members of the copy. */
  private bindWith(node: Extract<Expression, { kind: 'with' }>, context: BindContext): BoundExpression {
    const value = this.bindValue(node.value, context);
    const type = value.type;
    if (type.kind === 'error') return { kind: 'default', type: ERROR_TYPE, row: node.row };
    const isRecord =
      type.kind === 'named' &&
      (type.symbol.isRecord || type.symbol.kind === 'struct' || type.symbol.anonymousDisplay !== undefined);
    if (!isRecord) {
      this.error(
        node,
        'CS8858',
        `レシーバーの種類 '${displayType(type)}' は有効なレコード型でも構造体型でもありません。`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const temporary = new LocalSymbol('\0with', type, node.row, node.column);
    temporary.isHidden = true;
    context.fn.addLocal(temporary);
    const receiver: BoundExpression = { kind: 'local', local: temporary, type, row: node.row };
    const assignments: BoundMemberInit[] = node.members.map((member) => {
      const name = member.kind === 'memberAssign' ? member.name : '';
      const found = this.lookupMember(type, name, context.fn.typeContext).found;
      if (!found || (found.kind !== 'field' && found.kind !== 'property')) {
        this.error(member, 'CS0117', `'${displayType(type)}' に '${name}' の定義がありません`);
        return {
          kind: 'memberInit',
          target: { kind: 'discard', type: ERROR_TYPE, row: member.row },
          value: undefined,
          nested: undefined,
        };
      }
      // A `with` expression of an anonymous type sets the members, which have no setters, through their fields.
      const anonymousField =
        found.kind === 'property' &&
        type.kind === 'named' &&
        type.symbol.runtimeNameOverride?.startsWith('<>f__AnonymousType')
          ? found.property.backingField
          : undefined;
      const target: BoundLValue = anonymousField
        ? { kind: 'field', receiver, field: anonymousField, type: anonymousField.type, row: member.row }
        : this.checkAssignable(this.memberAccessOn(receiver, found, member, context), member, context, 'initializer');
      return {
        kind: 'memberInit',
        target,
        value: this.bindAs(member.value as Expression, target.type, context),
        nested: undefined,
      };
    });
    return { kind: 'with', value, clone: undefined, assignments, temporary, type, row: node.row };
  }

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private bindAssignment(node: Extract<Expression, { kind: 'assign' }>, context: BindContext): BoundExpression {
    const { operator } = node;
    if (operator === '=' && node.target.kind === 'tuple') return this.bindDeconstructionAssignment(node, context);
    if (operator === '=') {
      const target = this.bindLValue(node.target, context, 'assign');
      const value = this.bindValue(node.value, context);
      if (target.kind === 'discard') {
        if (value.kind === 'unbound') return this.convert(value, this.naturalTypeOf(value) ?? ERROR_TYPE, node);
        return { kind: 'assign', target: { ...target, type: value.type }, value, type: value.type, row: node.row };
      }
      return {
        kind: 'assign',
        target,
        value: this.convert(value, target.type, node.value),
        type: target.type,
        row: node.row,
      };
    }
    if (operator === '??=') return this.bindCoalesceAssignment(node, context);
    const binaryOperator = operator.slice(0, -1);
    const target = this.bindLValue(node.target, context, 'compound');
    if (target.kind === 'field' && target.field.isEvent && (binaryOperator === '+' || binaryOperator === '-')) {
      const value = this.bindAs(node.value, target.type, context);
      if (context.fn.typeContext.type !== target.field.owner)
        return { kind: 'eventAccessor', target, isAdd: binaryOperator === '+', value, type: VOID_TYPE, row: node.row };
    }
    const value = this.bindValue(node.value, context);
    const operand: BoundExpression = { kind: 'compoundOperand', type: target.type, row: node.row };
    const resolvedValue = value.kind === 'unbound' ? this.convert(value, target.type, node) : value;
    const operation = this.bindBinary(binaryOperator, operand, resolvedValue, node.row, operator);
    if (operation.type.kind === 'error') return { kind: 'default', type: ERROR_TYPE, row: node.row };
    const converted =
      this.implicitConversionOf(operation, target.type) || operation.kind !== 'binary'
        ? this.convert(operation, target.type, node)
        : this.compoundConversion(operation, target.type, resolvedValue, node);
    return { kind: 'compoundAssign', target, operation: converted, type: target.type, row: node.row };
  }

  /** `b += 1` on a byte converts the int result back explicitly, which C# allows when the operand converts implicitly. */
  private compoundConversion(
    operation: BoundExpression,
    type: Type,
    value: BoundExpression,
    node: Position
  ): BoundExpression {
    if (
      this.conversions.explicit(operation.type, type) &&
      (this.implicitConversionOf(value, type) ||
        ['<<', '>>', '>>>'].includes((operation as { operator?: string }).operator ?? ''))
    ) {
      return this.convert(operation, type, node, 'explicit');
    }
    // A constant that the target cannot hold, as in `s += 70000` for a short, is what Roslyn reports (CS0031).
    if (value.kind === 'constant' && this.conversions.explicit(operation.type, type)) {
      this.convert(value, type, node);
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    return this.convert(operation, type, node);
  }

  private bindCoalesceAssignment(node: Extract<Expression, { kind: 'assign' }>, context: BindContext): BoundExpression {
    const target = this.bindLValue(node.target, context, 'compound');
    const underlying = nullableUnderlying(target.type);
    if (
      !underlying &&
      !this.isReference(target.type) &&
      target.type.kind !== 'typeParameter' &&
      target.type.kind !== 'error'
    ) {
      this.error(
        node,
        'CS0019',
        `演算子 '??=' を '${displayType(target.type)}' と '${displayType(this.bindValue(node.value, context).type)}' 型のオペランドに適用することはできません`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const value = this.bindAllowingThrow(node.value, context);
    const operand: BoundExpression = { kind: 'compoundOperand', type: target.type, row: node.row };
    const right = value.kind === 'throw' ? value : this.convert(value, underlying ?? target.type, node);
    const coalesce: BoundExpression = {
      kind: 'coalesce',
      left: operand,
      right: underlying ? this.convert(right, target.type, node) : right,
      unwrapLeft: false,
      type: target.type,
      row: node.row,
    };
    return { kind: 'compoundAssign', target, operation: coalesce, type: underlying ?? target.type, row: node.row };
  }

  private bindIncrement(node: Extract<Expression, { kind: 'increment' }>, context: BindContext): BoundExpression {
    const target = this.bindLValue(node.operand, context, 'compound');
    if (target.type.kind === 'error') return { kind: 'default', type: ERROR_TYPE, row: node.row };
    const operand: BoundExpression = { kind: 'compoundOperand', type: target.type, row: node.row };
    const underlying = nullableUnderlying(target.type) ?? target.type;
    const special = specialOf(underlying);
    const isNumericTarget = (special !== undefined && isNumeric(underlying)) || isEnum(underlying);
    let operation: BoundExpression;
    if (isNumericTarget) {
      operation = {
        kind: 'unary',
        operator: node.operator,
        operand,
        operandKind: (isEnum(underlying) ? 'enum' : special) as never,
        isLifted: nullableUnderlying(target.type) !== undefined,
        type: target.type,
        row: node.row,
      };
    } else {
      const userDefined = this.bindUnary(node.operator, operand, node.row);
      if (userDefined.type.kind === 'error') return userDefined;
      operation = this.convert(userDefined, target.type, node);
    }
    return { kind: 'increment', target, isPrefix: node.prefix, operation, type: target.type, row: node.row };
  }

  /** Binds `(a, b) = value`, deconstructing a tuple or a value with a `Deconstruct` method. */
  private bindDeconstructionAssignment(
    node: Extract<Expression, { kind: 'assign' }>,
    context: BindContext
  ): BoundExpression {
    const value = this.bindValue(node.value, context);
    const targets = this.bindDeconstructTargets(
      node.target as Extract<Expression, { kind: 'tuple' }>,
      value.type,
      value,
      context,
      node
    );
    return {
      kind: 'deconstructAssign',
      targets,
      value: value.kind === 'unbound' ? { kind: 'default', type: ERROR_TYPE, row: node.row } : value,
      type: value.type,
      row: node.row,
    };
  }

  private bindDeconstructTargets(
    node: Extract<Expression, { kind: 'tuple' }>,
    type: Type,
    value: BoundExpression | undefined,
    context: BindContext,
    position: Position
  ): BoundDeconstructTarget {
    const count = node.elements.length;
    const { elementTypes, deconstruct } = this.deconstructionOf(type, count, value, position);
    const elements = node.elements.map((element, index): BoundDeconstructTarget => {
      const elementType = elementTypes[index] ?? ERROR_TYPE;
      const syntax = element.value;
      if (syntax.kind === 'tuple') return this.bindDeconstructTargets(syntax, elementType, undefined, context, syntax);
      if (syntax.kind === 'declaration')
        return this.declareDeconstructed(
          syntax.designation,
          syntax.type.kind === 'varType' ? undefined : this.resolveType(syntax.type, context.fn.typeContext),
          elementType,
          context
        );
      if (syntax.kind === 'name' && syntax.name === '_' && !context.scope.lookup('_'))
        return { kind: 'single', target: undefined, conversion: undefined };
      const target = this.bindLValue(syntax, context, 'assign');
      const conversion = this.convert(
        { kind: 'compoundOperand', type: elementType, row: syntax.row },
        target.type,
        syntax
      );
      return { kind: 'single', target, conversion };
    });
    return { kind: 'nested', elements, deconstruct, elementTypes };
  }

  /** Declares the variables of `var (a, b) = value` or `(int a, var b) = value`. */
  declareDeconstructed(
    designation: Designation,
    declaredType: Type | undefined,
    elementType: Type,
    context: BindContext
  ): BoundDeconstructTarget {
    if (designation.kind === 'discard') return { kind: 'single', target: undefined, conversion: undefined };
    if (designation.kind === 'parenthesized') {
      const { elementTypes, deconstruct } = this.deconstructionOf(
        elementType,
        designation.elements.length,
        undefined,
        designation
      );
      return {
        kind: 'nested',
        elements: designation.elements.map((element, index) => {
          const inner = elementTypes[index];
          if (!inner && elementType.kind !== 'error' && !declaredType && element.kind === 'single' && !element.type) {
            this.error(element, 'CS8130', `暗黙的に型指定された分解変数 '${element.name}' の型を推論できません。`);
          }
          return this.declareDeconstructed(element, declaredType, inner ?? ERROR_TYPE, context);
        }),
        deconstruct,
        elementTypes,
      };
    }
    const type = designation.type
      ? this.resolveType(designation.type, context.fn.typeContext)
      : (declaredType ?? elementType);
    const local = this.declareLocal(designation.name, type, designation, context);
    const target: BoundLValue = { kind: 'local', local, type, row: designation.row };
    return {
      kind: 'single',
      target,
      conversion: this.convert({ kind: 'compoundOperand', type: elementType, row: designation.row }, type, designation),
    };
  }

  /** The element types of a deconstruction: a tuple's elements, or the `out` parameters of a `Deconstruct` method. */
  protected deconstructionOf(
    type: Type,
    count: number,
    value: BoundExpression | undefined,
    position: Position
  ): { elementTypes: Type[]; deconstruct: MethodSymbol | undefined } {
    if (type.kind === 'error') return { elementTypes: [], deconstruct: undefined };
    if (type.kind === 'named' && specialOf(type) === 'valueTuple') {
      if (type.args.length !== count) {
        this.error(
          position,
          'CS8132',
          `'${type.args.length}' 要素のタプルを '${count}' 変数に分解することはできません。`
        );
        // Roslyn still types the variables that the tuple has elements for.
        return { elementTypes: type.args.slice(0, count), deconstruct: undefined };
      }
      return { elementTypes: type.args, deconstruct: undefined };
    }
    if (value?.kind === 'unbound' && value.node.kind === 'tuple') {
      this.unsupported(position, '型のないタプルの分解');
    }
    const { found } = this.lookupMember(type, 'Deconstruct', {
      namespace: [],
      usings: [],
      type: undefined,
      methodTypeParameters: [],
    });
    const candidate =
      found?.kind === 'methods'
        ? found.candidates.find(
            (option) =>
              option.method.parameters.length === count &&
              option.method.parameters.every((parameter) => parameter.refKind === 'out')
          )
        : undefined;
    if (!candidate) {
      const missing = missingDeconstruct(displayType(type), count, found?.kind === 'methods');
      this.error(position, missing.code, missing.message);
      this.error(
        position,
        'CS8129',
        `${count} out パラメーターと void 戻り値の型を持つ、型 '${displayType(type)}' の適切な分解インスタンスまたは拡張メソッドが見つかりませんでした。`
      );
      return { elementTypes: [], deconstruct: undefined };
    }
    const substitution = substitutionOf(candidate.owner);
    return {
      elementTypes: candidate.method.parameters.map((parameter) => substitute(parameter.type, substitution)),
      deconstruct: candidate.method,
    };
  }

  private readonly switchParts = new WeakMap<
    Expression,
    {
      scope: LocalScope;
      value: BoundExpression;
      arms: {
        pattern: BoundPattern;
        guard: BoundExpression | undefined;
        value: BoundExpression;
        row: number;
        syntax: Expression;
      }[];
    }
  >();

  /** Binds `value switch { ... }`, with the natural type of its arms or the target type. */
  protected bindSwitchExpression(
    node: Extract<Expression, { kind: 'switch' }>,
    context: BindContext,
    target: Type | undefined
  ): BoundExpression | undefined {
    // A switch without a natural type binds again once its target is known, reusing its parts so that the variables
    // its patterns declare are declared once (see bindConditional).
    let parts = this.switchParts.get(node);
    if (parts?.scope !== context.scope) {
      const value = this.bindValue(node.value, context);
      const handled: Space = [];
      const arms = node.arms.map((arm) => {
        const scope = new LocalScope(context.scope, context.fn);
        const armContext: BindContext = { scope, fn: context.fn };
        const pattern = this.bindPattern(arm.pattern, value.type, armContext);
        const guard = arm.guard ? this.bindAs(arm.guard, this.boolType, armContext) : undefined;
        if (value.type.kind !== 'error') this.checkArmReachable(handled, { pattern, guard }, arm.pattern);
        const result = this.bindAllowingThrow(arm.value, armContext);
        return { pattern, guard, value: result, row: arm.row, syntax: arm.value };
      });
      parts = { scope: context.scope, value, arms };
      this.switchParts.set(node, parts);
    }
    const { value, arms } = parts;
    if (arms.length === 0) {
      this.error(node, 'CS8506', 'switch 式に最適な型が見つかりませんでした。');
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const type = target ?? this.bestCommonType(arms.map((arm) => arm.value));
    // Without a natural type the switch converts its arms to its target (C# spec §12.11), which a later binding knows.
    if (!type) return undefined;
    return {
      kind: 'switch',
      value,
      arms: arms.map((arm) => ({
        pattern: arm.pattern,
        guard: arm.guard,
        value: arm.value.kind === 'throw' ? arm.value : this.convert(arm.value, type, arm.syntax),
        row: arm.row,
      })),
      type,
      row: node.row,
    };
  }

  protected defaultArgument(parameter: ParameterSymbol, type: Type, row: number): BoundExpression {
    if (parameter.defaultValue) {
      const value = parameter.defaultValue.value;
      return value === undefined ? this.defaultValue(type, row) : this.constant(value, type, row);
    }
    if (parameter.defaultSyntax) {
      const bound = this.bindParameterDefault(parameter, type);
      return { ...bound, row };
    }
    return this.defaultValue(type, row);
  }

  /** Binds a parameter's default value, which must be a constant, `default`, or `new S()` of a value type. */
  protected abstract bindParameterDefault(parameter: ParameterSymbol, type: Type): BoundExpression;

  protected isReferenceTypeOrArray(type: Type): boolean {
    return isReferenceType(type) || type.kind === 'array';
  }

  protected isFieldOf(field: FieldSymbol, type: Type): boolean {
    return type.kind === 'named' && field.owner === type.symbol;
  }
}

/** The name a tuple element or an anonymous type member takes from its expression: `x` from `x`, `Name` from `p.Name`. */
function inferredTupleName(expression: Expression): string | undefined {
  if (expression.kind === 'name' && !expression.typeArgs) return expression.name;
  if (expression.kind === 'memberAccess' && !expression.typeArgs) return expression.name;
  if (expression.kind === 'conditionalAccess') return inferredTupleName(expression.access);
  return undefined;
}

export { isNonValue };
