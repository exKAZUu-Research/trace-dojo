import type { Designation, Expression, MemberInitializer, Pattern, Position, TypeNode } from './ast';
import { bindAwaitPattern } from './awaitPattern';
import type {
  BoundDeconstruct,
  BoundDeconstructTarget,
  BoundExpression,
  BoundLValue,
  BoundMemberInit,
  BoundPattern,
} from './bound';
import type { ArgumentInfo, ResolvedCall } from './callBinder';
import { isEnum, isNumeric } from './conversions';
import type { BindContext, ConversionMode } from './convertBinder';
import { CsDecimal } from './decimal';
import { isDelegateType } from './declarations';
import { missingDeconstruct } from './deconstructionErrors';
import {
  bindFormattable,
  bindHandler,
  type InterpolationParts,
  type InterpolationSource,
  interpolationTargetOf,
} from './interpolatedConversions';
import { LambdaBinder, typeIdentityKey } from './lambdaBinder';
import type { MethodCandidate } from './lookup';
import { type BindResult, type DeconstructTargets, isNonValue, type NonValue } from './memberBinder';
import { ASSIGNMENT_OPERATOR_NAMES, checkedOperatorName } from './natives';
import { paramsCollectionOf } from './paramsCollections';
import type { Space } from './patternSpace';
// code-gauge-allow-file fileNcss -- The expressionBinder module keeps one stage of the C# interpreter together.
import { sizeOf } from './pointers';
import { desugarQuery } from './queries';
import { type FunctionScope, LocalScope } from './scopes';
import {
  allInterfacesOf,
  arrayType,
  displayType,
  ERROR_TYPE,
  FieldSymbol,
  isDynamicType,
  isPointerType,
  isReferenceType,
  isRefLikeType,
  isSpecial,
  isValueType,
  isVoidPointer,
  LocalSymbol,
  MethodSymbol,
  type NamedType,
  namedType,
  NULL_TYPE,
  nullableUnderlying,
  outlives,
  type ParameterSymbol,
  pointeeOf,
  PropertySymbol,
  type SafeContext,
  sameType,
  specialOf,
  substitute,
  substitutionOf,
  type Type,
  TypeSymbol,
  VOID_TYPE,
} from './types';
import type { CsObject } from './values';
import { isFixedBufferAccess, isFixedVariable } from './variables';

type Unbound = Extract<BoundExpression, { kind: 'unbound' }>;

/** Binds every kind of expression, and the target-typed ones once their targets are known. */
export abstract class ExpressionBinder extends LambdaBinder {
  /** Binds a pattern against an input type, declaring its variables in the context's scope. */
  abstract bindPattern(pattern: Pattern, inputType: Type, context: BindContext): BoundPattern;
  abstract bindRefTarget(
    operand: Expression,
    isReadonly: boolean,
    context: BindContext,
    use: 'local' | 'return'
  ): BoundLValue;
  abstract checkRefType(actual: Type, expected: Type, position: Position): void;
  abstract refScopeOf(target: BoundLValue, fn: FunctionScope): 'return' | 'local';
  abstract refContextOf(target: BoundLValue, fn: FunctionScope): SafeContext;
  abstract valueContextOf(value: BoundExpression, fn: FunctionScope): SafeContext;
  abstract checkValueEscape(value: BoundExpression, required: SafeContext, context: BindContext): void;
  abstract checkReadonlyField(
    field: FieldSymbol,
    context: BindContext,
    position: Position,
    use: 'assign' | 'ref' | 'out' | 'compound' | 'initializer'
  ): void;

  /** Reports a switch arm whose pattern the earlier arms handle, then adds an unguarded arm's values to them. */
  protected abstract checkArmReachable(
    handled: Space,
    arm: { pattern: BoundPattern; guard: unknown },
    position: Position
  ): void;

  /** The anonymous types by shape, which share one type per list of member names and types. */
  private readonly anonymousTypes = new Map<string, TypeSymbol>();

  bindExpression(node: Expression, context: BindContext): BindResult {
    return this.withOperatorScope(
      context.fn.typeContext,
      () =>
        this.bindPrimaryExpression(node, context) ??
        this.bindCreationExpression(node, context) ??
        this.bindOperatorExpression(node, context) ??
        this.bindOtherExpression(node, context)
    );
  }

  /** `field` in a property's accessor, or in a lambda or local function there (C# 14): the property's backing field. */
  private bindFieldKeyword(node: Expression, context: BindContext): BoundExpression {
    let fn: FunctionScope | undefined = context.fn;
    while (fn && !fn.method.property) fn = fn.outer;
    const field = fn?.method.property?.keywordField;
    // An interface's instance property has no field to name, which its declaration already reports (CS0525).
    if (!field) return { kind: 'default', type: ERROR_TYPE, row: node.row };
    if (field.isStatic)
      return { kind: 'staticField', field, owner: field.owner.declaredType, type: field.type, row: node.row };
    return { kind: 'field', receiver: this.thisValue(context, node), field, type: field.type, row: node.row };
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
        if (node.isFieldKeyword) return this.bindFieldKeyword(node, context);
        return this.namingMemberOf(node, () => this.bindSimpleName(node.name, node.typeArgs, node, context));
      }
      case 'aliasQualified': {
        return this.bindAliasQualified(node, context);
      }
      case 'checked': {
        return this.inCheckedContext(node.isChecked, () => this.bindExpression(node.operand, context));
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
        const access = this.bindMemberAccess(node, context);
        if (!node.isUnsafe && isFixedBufferAccess(access)) this.reportOutsideUnsafe(node);
        return access;
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
        return this.bindElementAccessExpression(node, context);
      }
      case 'tuple': {
        return this.bindTuple(node, context);
      }
      case 'declaration': {
        this.error(node, 'CS8185', '宣言はこのコンテキストでは許可されていません。');
        return { kind: 'default', type: ERROR_TYPE, row };
      }
      default: {
        return this.bindLessCommonPrimary(node, context);
      }
    }
  }

  /** `a[i]`: of a pointer, a `dynamic` value, an index from the end or a range, or an array or indexer. */
  private bindElementAccessExpression(
    node: Extract<Expression, { kind: 'elementAccess' }>,
    context: BindContext
  ): BindResult {
    const allowed = this.allowsMovableFixedBuffer;
    this.allowsMovableFixedBuffer = node.target.kind === 'memberAccess' || node.target.kind === 'name';
    const target = this.bindTypedValue(node.target, context);
    this.allowsMovableFixedBuffer = allowed;
    // `p[i]` is `*(p + i)`.
    if (isPointerType(target.type) && node.args.length === 1) {
      const index = this.bindValue(node.args[0].value, context);
      return this.dereference(this.bindBinary('+', target, index, node.row), node);
    }
    const late = this.lateElementAccess(node, target, context);
    if (late) return late;
    return (
      this.bindImplicitIndexOrRange(target, node, context) ?? this.bindElementAccess(target, node.args, node, context)
    );
  }

  /** The primary expressions beyond the ones learners write first: `await`, `typeof`, pointers, indices and ranges. */
  private bindLessCommonPrimary(node: Expression, context: BindContext): BindResult | undefined {
    const row = node.row;
    switch (node.kind) {
      case 'await': {
        return this.bindAwait(node, context);
      }
      case 'typeof': {
        return {
          kind: 'typeOf',
          target: this.typeofTarget(node.type, context),
          type: namedType(this.library.typeNamed('System.Type')),
          row,
        };
      }
      case 'sizeof': {
        return this.bindSizeof(node, context);
      }
      case 'addressOf': {
        return this.bindAddressOf(node, context, false);
      }
      case 'deref': {
        if (!node.isUnsafe) this.reportOutsideUnsafe(node);
        return this.dereference(this.bindValue(node.operand, context), node);
      }
      case 'stackalloc': {
        if (!node.isUnsafe) return this.unsupported(node, 'Span への `stackalloc`');
        return this.bindNestedStackalloc(node, context);
      }
      case 'makeRef':
      case 'refType':
      case 'refValue': {
        return this.bindTypedReference(node, context);
      }
      case 'refExpression': {
        // A ref local's initializer, a `return ref`, and `r = ref x` take `ref x` apart; elsewhere it is not run.
        return this.unsupported(node, 'この場所の `ref` 式');
      }
      case 'fromEnd':
      case 'range': {
        return this.bindIndexOrRange(node, context);
      }
      default: {
        return undefined;
      }
    }
  }

  /** `^n`, a `System.Index` from the end, or `a..b`, a `System.Range` whose omitted ends are the start and the end. */
  private bindIndexOrRange(
    node: Extract<Expression, { kind: 'fromEnd' | 'range' }>,
    context: BindContext
  ): BoundExpression {
    const row = node.row;
    if (node.kind === 'fromEnd') {
      const operand = this.bindAs(node.operand, this.intType, context);
      return this.libraryCreation('System.Index', [operand, this.constant(true, this.boolType, row)], node);
    }
    const index = namedType(this.library.typeNamed('System.Index'));
    const end = (written: Expression | undefined, fromEnd: boolean): BoundExpression =>
      written
        ? this.bindAs(written, index, context)
        : this.libraryCreation(
            'System.Index',
            [this.constant(0, this.intType, row), this.constant(fromEnd, this.boolType, row)],
            node
          );
    return this.libraryCreation('System.Range', [end(node.start, false), end(node.end, true)], node);
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
        if (node.whenTrue.kind === 'refExpression' || node.whenFalse.kind === 'refExpression')
          return this.bindRefConditional(node, context);
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
        const operand = this.isOrAsOperand(node.operand, context);
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
      case 'utf8': {
        return this.utf8Literal(value.value, row);
      }
      default: {
        return { kind: 'constant', value: undefined, type: NULL_TYPE, row };
      }
    }
  }

  /** A UTF-8 string literal, whose string must have no lone surrogate, which UTF-8 cannot encode. */
  utf8Literal(text: string, row: number): BoundExpression {
    const type = namedType(this.library.typeNamed('System.ReadOnlySpan', 1), [this.specialType('byte')]);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.exec(text);
    if (lone) {
      const code = (lone[0].codePointAt(0) as number).toString(16).toUpperCase();
      this.error(
        row,
        'CS9026',
        `入力文字列を同等の UTF-8 バイト表現に変換できません。Unable to translate Unicode character \\\\u${code} at index ${lone.index} to specified code page.`
      );
    }
    return { kind: 'utf8', bytes: [...new TextEncoder().encode(text)], type, row };
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
    const number = suffix === 'f' ? Math.fround(Number(text)) : Number(text);
    if (!Number.isFinite(number)) {
      const type = suffix === 'f' ? 'float' : 'double';
      this.error(position, 'CS0594', `浮動小数点定数が型 '${type}' の範囲外です`);
      return this.constant(0, this.specialType(type), position.row);
    }
    if (suffix === 'f') return this.constant(number, this.specialType('float'), position.row);
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
    const parts: InterpolationParts = [];
    const holes: Position[] = [];
    for (const part of node.parts) {
      if (part.text !== undefined) {
        parts.push(part.text);
        continue;
      }
      const hole = part.hole as NonNullable<typeof part.hole>;
      let value = this.bindValue(hole.expression, context);
      // A method group or a lambda with a natural type formats as its delegate, and a conditional without a common
      // type as the object that the hole takes.
      if (value.kind === 'unbound' && (this.naturalTypeOf(value) || value.node.kind === 'conditional'))
        value = this.convert(value, this.objectType, hole.expression);
      if (value.kind === 'unbound' || value.type.kind === 'void') {
        this.error(
          hole.expression,
          'CS0029',
          `型 '${value.type.kind === 'void' ? 'void' : 'ラムダ式'}' を 'object' に暗黙的に変換できません`
        );
      }
      // The handler formats a ref struct by its generic `AppendFormatted<T>`, which takes no ref struct, except a
      // `ReadOnlySpan<char>`, which it has its own overload for.
      if (isRefLikeType(value.type) && !this.isCharSpan(value.type))
        this.checkTypeArgumentKind(
          value.type,
          'T',
          'DefaultInterpolatedStringHandler.AppendFormatted<T>(T)',
          hole.expression.row
        );
      let alignment: number | undefined;
      if (hole.alignment) {
        const bound = this.bindAs(hole.alignment, this.intType, context);
        if (bound.kind !== 'constant') this.error(hole.alignment, 'CS0150', '定数値が必要です');
        else alignment = bound.value as number;
      }
      parts.push({ value, alignment, format: hole.format });
      holes.push(hole.expression);
    }
    const bound =
      holes.length === 0
        ? this.constant(parts.join(''), this.stringType, node.row)
        : { kind: 'interpolated' as const, parts, type: this.stringType, row: node.row };
    this.interpolations.set(bound, { parts, position: node, holes, context });
    return bound;
  }

  protected bindInterpolationConversion(
    source: InterpolationSource,
    target: NamedType,
    handlerArguments: BoundExpression[],
    row: number
  ): BoundExpression {
    return interpolationTargetOf(target) === 'handler'
      ? bindHandler(this, source, target, handlerArguments, row)
      : bindFormattable(this, source, target, row);
  }

  private isCharSpan(type: Type): boolean {
    return (
      type.kind === 'named' &&
      type.symbol.isLibrary &&
      type.symbol.fullName === 'System.ReadOnlySpan`1' &&
      isSpecial(type.args[0], 'char')
    );
  }

  private readonly conditionalReceivers: BoundExpression[] = [];

  /** Binds `a?.b`, which evaluates `b` on `a` only when `a` is not null, with a nullable type for value results. */
  private bindConditionalAccess(
    node: Extract<Expression, { kind: 'conditionalAccess' }>,
    context: BindContext
  ): BoundExpression {
    const receiver = this.bindTypedValue(node.target, context);
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

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private bindBinaryExpression(node: Extract<Expression, { kind: 'binary' }>, context: BindContext): BoundExpression {
    const { operator } = node;
    const row = node.operatorRow;
    if (operator === '&&' || operator === '||') return this.bindLogical(node, operator, context);
    if (operator === '??') return this.bindCoalesce(node, context);
    let left = this.bindValue(node.left, context);
    let right = this.bindValue(node.right, context);
    // `string + object` takes a conditional without a common type opposite a string as its object operand.
    if (operator === '+') {
      if (isTypelessConditional(left) && isStringValue(right)) left = this.convert(left, this.objectType, node.left);
      if (isTypelessConditional(right) && isStringValue(left)) right = this.convert(right, this.objectType, node.right);
    }
    // `d + lambda` and `d - Method` combine delegates, converting the untyped operand to the other's delegate type.
    const other = left.kind === 'unbound' ? right : left;
    const combinesDelegates =
      (operator === '+' || operator === '-') &&
      other.kind !== 'unbound' &&
      other.type.kind === 'named' &&
      other.type.symbol.kind === 'delegate';
    if ((operator === '==' || operator === '!=') && this.isTupleOperand(left) && this.isTupleOperand(right)) {
      return this.bindTupleEquality(operator, left, right, node.row, context);
    }
    for (const [operand, syntax] of [
      [left, node.left],
      [right, node.right],
    ] as const) {
      if (operand.kind === 'unbound' && !combinesDelegates && !(syntax.kind === 'default' && !syntax.type)) {
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
    const result = this.bindBinary(operator, left, right, row);
    return { ...result, row: node.row } as BoundExpression;
  }

  private bindLogical(
    node: Extract<Expression, { kind: 'binary' }>,
    operator: '&&' | '||',
    context: BindContext
  ): BoundExpression {
    const row = node.operatorRow;
    const leftValue = this.bindValue(node.left, context);
    const rightValue = this.bindValue(node.right, context);
    // Roslyn resolves `&&` as an operator on bool, so operands that are no bool fail as its operands.
    const isBool = (operand: BoundExpression): boolean =>
      operand.kind === 'unbound' ||
      operand.type.kind === 'error' ||
      this.implicitConversionOf(operand, this.boolType) !== undefined;
    if (!isBool(leftValue) || !isBool(rightValue)) {
      const userDefined = this.bindUserLogical(operator, leftValue, rightValue, node.row);
      if (userDefined) return userDefined;
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

  /**
   * Binds `x && y` or `x || y` on a type with user-defined `&` or `|` and `true` and `false` (C# spec §12.14.3), which
   * evaluates as `T.false(x) ? x : T.&(x, y)` or `T.true(x) ? x : T.|(x, y)`.
   */
  private bindUserLogical(
    operator: '&&' | '||',
    leftValue: BoundExpression,
    rightValue: BoundExpression,
    row: number
  ): BoundExpression | undefined {
    if (leftValue.kind === 'unbound' || rightValue.kind === 'unbound') return undefined;
    const combine = this.userOperator(
      operator === '&&' ? 'op_BitwiseAnd' : 'op_BitwiseOr',
      [leftValue, rightValue],
      row
    );
    if (combine?.kind !== 'call') return undefined;
    const type = combine.type;
    const operand: BoundExpression = { kind: 'compoundOperand', type, row };
    const test = this.userOperator(operator === '&&' ? 'op_False' : 'op_True', [operand], row);
    if (test?.kind !== 'call') {
      this.error(
        row,
        'CS0218',
        `型 ('${displayType(type)}') には、演算子 true および演算子 false の宣言が含まれていなければなりません`
      );
      return { kind: 'default', type: ERROR_TYPE, row };
    }
    return {
      kind: 'userLogical',
      left: this.convert(leftValue, type, row),
      test,
      combine: { ...combine, args: [operand, combine.args[1]] },
      type,
      row,
    };
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
    const leftOperand = this.tupleEqualityOperand(left, row, context);
    const rightOperand = this.tupleEqualityOperand(right, row, context);
    if (leftOperand.elements.length !== rightOperand.elements.length) {
      this.error(
        row,
        'CS8384',
        `演算子 == または != のオペランドとして使用するタプルの型は、カーディナリティが一致している必要があります。しかし、この演算子は、左辺のタプルの型のカーディナリティが ${leftOperand.elements.length} で、右辺が ${rightOperand.elements.length} です。`
      );
      return { kind: 'default', type: ERROR_TYPE, row };
    }
    const comparisons = leftOperand.elements.map((a, index) => {
      const b = rightOperand.elements[index];
      if (this.isTupleOperand(a) && this.isTupleOperand(b)) return this.bindTupleEquality(operator, a, b, row, context);
      // An element without a type, as `null` in `t == (1, null)`, takes the other element's type, as an operand does.
      if (a.kind === 'unbound' && b.kind !== 'unbound')
        return this.bindBinary(operator, this.convert(a, b.type, row), b, row);
      if (b.kind === 'unbound' && a.kind !== 'unbound')
        return this.bindBinary(operator, a, this.convert(b, a.type, row), row);
      return this.bindBinary(operator, a, b, row);
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
    return {
      kind: 'sequence',
      // The operands' hidden locals leave scope with the comparison, so they hold nothing the program has let go.
      locals: [...leftOperand.locals, ...rightOperand.locals],
      sideEffects: [...leftOperand.sideEffects, ...rightOperand.sideEffects],
      value,
      type: this.boolType,
      row,
    };
  }

  /** A tuple, or a tuple literal without a natural type, as `(1, null)`. */
  private isTupleOperand(operand: BoundExpression): boolean {
    return this.isTuple(operand.type) || (operand.kind === 'unbound' && operand.node.kind === 'tuple');
  }

  /**
   * The elements that a tuple equality compares of one operand, which it evaluates first into hidden locals: a tuple's
   * fields, or each element of a tuple literal without a natural type, whose typeless elements stay unbound.
   */
  private tupleEqualityOperand(
    operand: BoundExpression,
    row: number,
    context: BindContext
  ): { elements: BoundExpression[]; locals: LocalSymbol[]; sideEffects: BoundExpression[] } {
    const locals: LocalSymbol[] = [];
    const sideEffects: BoundExpression[] = [];
    const temporaryOf = (value: BoundExpression): BoundExpression => {
      const local = new LocalSymbol('\0tuple', value.type, row, 0);
      local.isHidden = true;
      context.fn.addLocal(local);
      locals.push(local);
      const temporary: BoundExpression = { kind: 'local', local, type: value.type, row };
      sideEffects.push({ kind: 'assign', target: temporary as BoundLValue, value, type: value.type, row });
      return temporary;
    };
    if (operand.kind === 'unbound' && operand.node.kind === 'tuple') {
      const elements = operand.node.elements.map((element) => {
        const value = this.bindValue(element.value, context);
        return value.kind === 'unbound' || value.kind === 'constant' ? value : temporaryOf(value);
      });
      return { elements, locals, sideEffects };
    }
    const type = operand.type as NamedType;
    const tuple = temporaryOf(operand);
    const elements = type.args.map((elementType, index): BoundExpression => ({
      kind: 'field',
      receiver: tuple,
      field: type.symbol.fields.find((field) => field.name === `Item${index + 1}`) as FieldSymbol,
      type: elementType,
      row,
    }));
    return { elements, locals, sideEffects };
  }

  private bindCoalesce(node: Extract<Expression, { kind: 'binary' }>, context: BindContext): BoundExpression {
    const left = this.bindTypedValue(node.left, context);
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
      const toNullable = nullableUnderlying(right.type) !== undefined;
      return {
        kind: 'coalesce',
        left: this.convert(left, toNullable ? right.type : left.type, node),
        right,
        unwrapLeft: underlying !== undefined && !toNullable,
        leftConversion: toNullable
          ? undefined
          : this.convert({ kind: 'compoundOperand', type: leftType, row: node.row }, right.type, node),
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

  /**
   * `c ? ref a : ref b`, a variable of the type both sides have. Each side is bound as a variable the program may only
   * read; using the whole as a writable one checks both sides then.
   */
  private bindRefConditional(
    node: Extract<Expression, { kind: 'conditional' }>,
    context: BindContext
  ): BoundExpression {
    const condition = this.bindAs(node.condition, this.specialType('bool'), context);
    const { whenTrue, whenFalse } = node;
    if (whenTrue.kind !== 'refExpression' || whenFalse.kind !== 'refExpression') {
      this.bindValue(whenTrue.kind === 'refExpression' ? whenTrue.operand : whenTrue, context);
      this.bindValue(whenFalse.kind === 'refExpression' ? whenFalse.operand : whenFalse, context);
      this.error(
        node,
        'CS8326',
        '条件演算子の両辺の値は、両方とも ref 値にするか、両方とも ref 以外の値にする必要があります'
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const first = this.bindRefTarget(whenTrue.operand, true, context, 'local');
    const second = this.bindRefTarget(whenFalse.operand, true, context, 'local');
    if (first.kind === 'discard' || second.kind === 'discard')
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    if (!sameType(first.type, second.type)) {
      this.error(
        whenFalse,
        'CS8327',
        `式は、代替 ref 値と一致するために、型 '${displayType(first.type)}' である必要があります`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    return { kind: 'refConditional', condition, whenTrue: first, whenFalse: second, type: first.type, row: node.row };
  }

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
        condition: this.bindCondition(node.condition, context),
        whenTrue: this.bindAllowingThrow(node.whenTrue, context),
        whenFalse: this.bindAllowingThrow(node.whenFalse, context),
      };
      this.conditionalParts.set(node, parts);
    }
    const { condition, whenTrue, whenFalse } = parts;
    const type = target ?? this.bestCommonType([whenTrue, whenFalse]);
    // Without a common type the conditional takes its target's (C# 9), so it waits for one; CS0173 is reported if
    // none comes.
    if (!type) return undefined;
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

  protected reportConditionalWithoutType(node: Expression): void {
    const parts = this.conditionalParts.get(node);
    this.error(
      node,
      'CS0173',
      `'${branchTypeText(parts?.whenTrue)}' と '${branchTypeText(parts?.whenFalse)}' の間に暗黙的な変換がないため、条件式の型がわかりません`
    );
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
    const operand = this.isOrAsOperand(node.operand, context);
    const type = this.resolveType(node.type, context.fn.typeContext);
    if (operand.kind === 'unbound') {
      this.error(
        node,
        'CS0837',
        "'is' または 'as' 演算子の最初のオペランドとして、ラムダ式、匿名メソッド、またはメソッド グループを使用することはできません"
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
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
    sizes: BoundExpression[] = [],
    /** Elements already bound, as an implicitly typed array binds them to find its type, which bind only once. */
    bound?: Map<Expression, BoundExpression>
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
          const value = bound?.get(element);
          elements.push(
            value ? this.convert(value, type.element, element) : this.bindAs(element, type.element, context)
          );
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
    if (node.rank > 1) return this.bindImplicitMatrix(node, context);
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

  /**
   * Binds `new[,] { ... }`: its element type is the best common type of the innermost elements, after which the
   * initializer binds as that of an explicitly typed array of the rank, which checks its shape.
   */
  private bindImplicitMatrix(
    node: Extract<Expression, { kind: 'implicitNewArray' }>,
    context: BindContext
  ): BoundExpression {
    const leaves: Expression[] = [];
    const collect = (initializer: Extract<Expression, { kind: 'arrayInitializer' }>, depth: number): void => {
      for (const element of initializer.elements) {
        if (depth + 1 < node.rank && element.kind === 'arrayInitializer') collect(element, depth + 1);
        else if (element.kind !== 'arrayInitializer') leaves.push(element);
      }
    };
    collect(node.initializer, 0);
    const bound = new Map(leaves.map((leaf) => [leaf, this.bindValue(leaf, context)]));
    const element = this.bestCommonType([...bound.values()]);
    if (!element || element.kind === 'error') {
      if (!element) this.error(node, 'CS0826', '暗黙的に型指定された配列の最適な型が見つかりませんでした');
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    return this.bindArrayInitializer(node.initializer, arrayType(element, node.rank), context, [], bound);
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
      uniqueNames,
      node.row
    );
    return { kind: 'tuple', elements, type, row: node.row };
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
      case 'stackalloc': {
        return this.convertNestedStackalloc(expression, target, report);
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
    if (target.kind === 'named' && target.symbol.collectionBuilder)
      return this.bindBuiltCollection(node, target, target.symbol.collectionBuilder, context);
    // A span of the elements is one over an array of them, which Roslyn may put on the stack instead.
    if (target.kind === 'named' && target.symbol.fullName === 'System.ReadOnlySpan`1') {
      const elements = this.bindCollectionExpression(node, arrayType(target.args[0]), context);
      return elements && this.convert(elements, target, node);
    }
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
    // Roslyn reports a lone constructor that needs arguments as the collection's, rather than the call's CS7036.
    const constructors =
      createType.kind === 'named' && createType.symbol.kind === 'class'
        ? createType.symbol.constructors.filter((constructor) => constructor.access === 'public')
        : [];
    if (constructors.length === 1 && !constructors[0].parameters.every(isOptionalParameter)) {
      this.error(
        node,
        'CS9214',
        'コレクション式の型には、引数なしで呼び出すことができる適用可能なコンストラクターが必要です。'
      );
      return { kind: 'default', type: ERROR_TYPE, row };
    }
    const created = this.bindCreation(createType, [], undefined, node, context);
    sideEffects.push({ kind: 'assign', target: receiver as BoundLValue, value: created, type: createType, row });
    const isList = sameType(createType, listType);
    // A type with no `Add` at all reports its missing member as the first element's call does.
    if (elements.length > 0 && this.addArity(createType, context) === 'other') {
      this.error(
        node,
        'CS9215',
        `コレクション式の型 '${displayType(target)}' には、1 つの引数で呼び出すことができるインスタンスメソッドまたは拡張メソッド 'Add' が必要です。`
      );
      return { kind: 'default', type: ERROR_TYPE, row };
    }
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

  /**
   * Reports a `params` class or struct (C# 13) that `new T()` cannot create, as the collection expression of its
   * arguments would, or whose `Add` no element may call.
   */
  protected checkParamsCollections(parameters: readonly ParameterSymbol[], context: BindContext): void {
    for (const parameter of parameters) if (parameter.isParams) this.checkParamsCollection(parameter, context);
  }

  private checkParamsCollection(parameter: ParameterSymbol, context: BindContext): void {
    const collection = paramsCollectionOf(parameter.type, this.objectType);
    if (collection?.kind !== 'constructible') return;
    const { type } = collection;
    const position = parameter.position ?? { row: 0, column: 0 };
    const constructors =
      type.symbol.kind === 'class'
        ? type.symbol.constructors.filter((constructor) => constructor.access === 'public')
        : [];
    if (constructors.length === 1 && !constructors[0].parameters.every(isOptionalParameter)) {
      this.error(
        position,
        'CS9228',
        '配列 params コレクション以外の種類には、引数なしで呼び出すことができる適用可能なコンストラクターが必要です。'
      );
      return;
    }
    const saved = this.diagnostics.length;
    this.bindCreation(type, [], undefined, position, context);
    if (this.diagnostics.length > saved) return;
    const arity = this.addArity(type, context);
    if (arity === 'none') this.error(position, 'CS0117', `'${displayType(type)}' に 'Add' の定義がありません`);
    else if (arity === 'other')
      this.error(
        position,
        'CS9215',
        `コレクション式の型 '${displayType(type)}' には、1 つの引数で呼び出すことができるインスタンスメソッドまたは拡張メソッド 'Add' が必要です。`
      );
  }

  /**
   * Whether a type's `Add` methods, which a collection expression adds each element by, include one that one argument
   * may call, only others, or none at all.
   */
  private addArity(type: Type, context: BindContext): 'one' | 'other' | 'none' {
    const { found } = this.lookupMember(type, 'Add', context.fn.typeContext, 0, true);
    const instance = found?.kind === 'methods' ? found.candidates.filter(({ method }) => !method.isStatic) : [];
    const extensions = this.lookupExtensionMethods('Add', context.fn.typeContext);
    if (
      instance.some(({ method }) => takesOneArgument(method.parameters)) ||
      extensions.some(({ method }) => takesOneArgument(method.parameters.slice(1)))
    )
      return 'one';
    return instance.length > 0 || extensions.length > 0 ? 'other' : 'none';
  }

  /**
   * A collection expression of a type with `[CollectionBuilder]`, which the builder's static method creates from a
   * `ReadOnlySpan` of the elements, here one over an array of them.
   */
  private bindBuiltCollection(
    node: Extract<Expression, { kind: 'collection' }>,
    target: NamedType,
    builder: NonNullable<TypeSymbol['collectionBuilder']>,
    context: BindContext
  ): BoundExpression | undefined {
    const enumerable = allInterfacesOf(target, () => []).find(
      (face) => face.symbol.fullName === 'System.Collections.Generic.IEnumerable`1'
    );
    if (!enumerable) {
      this.error(
        node,
        'CS9188',
        `'${displayType(target)}' は CollectionBuilderAttribute を持っていますが、要素型を持っていません。`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const elementType = enumerable.args[0];
    const span = namedType(this.library.typeNamed('System.ReadOnlySpan', 1), [elementType]);
    const found = this.builderMethod(builder, target, span);
    if (!found) {
      this.error(
        node,
        'CS9187',
        `必要なシグネチャを持つアクセス可能な '${builder.methodName}' メソッドが見つかりませんでした: 最後のパラメーターが '${displayType(span)}' 型で戻り値の型が '${displayType(target)}' の静的メソッド。`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    const elements = this.bindCollectionExpression(node, arrayType(elementType), context);
    if (!elements) return undefined;
    return {
      kind: 'call',
      method: found.method,
      receiver: undefined,
      args: [this.convert(elements, span, node)],
      typeArgs: found.typeArgs,
      owner: builder.builderType as NamedType,
      isVirtual: false,
      type: target,
      row: node.row,
    };
  }

  /**
   * The builder's static method that takes a span of the elements and returns the type: one of the builder's own, or
   * a generic one whose type arguments are the type's.
   */
  private builderMethod(
    builder: NonNullable<TypeSymbol['collectionBuilder']>,
    target: NamedType,
    span: NamedType
  ): { method: MethodSymbol; typeArgs: Type[] } | undefined {
    if (builder.builderType.kind !== 'named') return undefined;
    for (const method of builder.builderType.symbol.methods) {
      if (method.name !== builder.methodName || !method.isStatic || method.parameters.length !== 1) continue;
      if (method.typeParameters.length > 0 && method.typeParameters.length !== target.args.length) continue;
      const typeArgs = method.typeParameters.length === 0 ? [] : target.args;
      const substitution = new Map(method.typeParameters.map((parameter, index) => [parameter, typeArgs[index]]));
      const parameter = method.parameters[0];
      if (
        parameter.refKind === undefined &&
        sameType(substitute(parameter.type, substitution), span) &&
        sameType(substitute(method.returnType, substitution), target)
      )
        return { method, typeArgs };
    }
    return undefined;
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
    return this.constructibleElementType(target);
  }

  /**
   * The element type of a class or struct that a collection expression creates by its parameterless constructor and
   * fills by `Add`: the `T` of the `IEnumerable<T>` it implements, or `object` of a non-generic `IEnumerable`.
   */
  private constructibleElementType(target: NamedType): Type | undefined {
    const { symbol } = target;
    if ((symbol.kind !== 'class' && symbol.kind !== 'struct') || symbol.isAbstract) return undefined;
    const faces = allInterfacesOf(target, () => []);
    const generic = faces.filter((face) => face.symbol.fullName === 'System.Collections.Generic.IEnumerable`1');
    if (generic.length === 1) return generic[0].args[0];
    return faces.some((face) => face.symbol.fullName === 'System.Collections.IEnumerable')
      ? this.objectType
      : undefined;
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
    const key = members.map((member) => `${member.name}:${typeIdentityKey(member.type)}`).join(';');
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

  /**
   * Binds the operand of `is` or `as`, leaving a lambda or a method group unbound for the operator's CS0837 and giving
   * any other value its natural type.
   */
  private isOrAsOperand(node: Expression, context: BindContext): BoundExpression {
    const operand = this.bindValue(node, context);
    if (operand.kind === 'unbound' && (operand.node.kind === 'lambda' || operand.methodGroup)) return operand;
    return this.typedValue(operand, node);
  }

  /** Binds `x with { P = v }`, which copies a record or struct and assigns members of the copy. */
  private bindWith(node: Extract<Expression, { kind: 'with' }>, context: BindContext): BoundExpression {
    const value = this.bindTypedValue(node.value, context);
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

  /** `d[i]` of a `dynamic` value or with a `dynamic` index, whose indexer is found when it runs. */
  private lateElementAccess(
    node: Extract<Expression, { kind: 'elementAccess' }>,
    target: BoundExpression,
    context: BindContext
  ): BoundExpression | undefined {
    if (target.type.kind === 'error' || node.args.some((arg) => arg.modifier !== undefined)) return undefined;
    const peek = node.args.map((arg) => this.quietly(() => this.bindValue(arg.value, context)));
    if (!isDynamicType(target.type) && !peek.some((value) => value && isDynamicType(value.type))) return undefined;
    const indices = node.args.map((arg) => this.bindValue(arg.value, context));
    const syntax: Expression = {
      ...node,
      target: this.lateOperand(0, node.target),
      args: node.args.map((arg, index) => ({ ...arg, value: this.lateOperand(index + 1, arg) })),
    };
    return this.late(syntax, [target, ...indices], context, { receiver: 0 });
  }

  /** `d.X = v`, `d[i] += v`: an assignment to a member of a `dynamic` value, which binds when it runs. */
  private lateAssignment(
    node: Extract<Expression, { kind: 'assign' }>,
    context: BindContext
  ): BoundExpression | undefined {
    if (node.target.kind !== 'memberAccess' && node.target.kind !== 'elementAccess') return undefined;
    const probe = this.quietly(() => this.bindExpression(node.target, context));
    if (probe?.kind !== 'late') return undefined;
    const target = this.bindExpression(node.target, context) as Extract<BoundExpression, { kind: 'late' }>;
    const value = this.bindValue(node.value, context);
    if (value.kind === 'unbound') return undefined;
    const syntax: Expression = {
      ...node,
      target: target.syntax,
      value: this.lateOperand(target.operands.length, node.value),
    };
    return this.late(syntax, [...target.operands, value], context, { receiver: 0, isStatement: true });
  }

  /** `r = ref x`: a ref local, or a ref parameter, refers to another variable from then on. */
  private bindRefAssignment(
    node: Extract<Expression, { kind: 'assign' }>,
    value: Extract<Expression, { kind: 'refExpression' }>,
    context: BindContext
  ): BoundExpression {
    const left = this.toValue(this.bindExpression(node.target, context), node.target);
    if (left.kind === 'field' && left.field.byRef) return this.bindRefFieldAssignment(node, left, value, context);
    const local =
      left.kind === 'local' && (left.local.isRefLocal || left.local.refKind !== undefined) ? left.local : undefined;
    const target = this.bindRefTarget(value.operand, local?.refKind === 'in', context, 'local');
    if (!local) {
      if (left.type.kind !== 'error') this.error(node, 'CS8373', 'ref 代入の左辺は ref 変数である必要があります。');
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    if (local.isRefFixed) return this.reportFixedReference(local, node);
    if (target.kind === 'discard') return { kind: 'default', type: ERROR_TYPE, row: node.row };
    this.checkRefType(target.type, local.type, value);
    this.checkRefLocalTarget(local, target, node, context);
    return { kind: 'refAssign', local, target, type: local.type, row: node.row };
  }

  /** Reports `r = ref x` of a variable that dies sooner than the one the reference referred to. */
  private checkRefLocalTarget(local: LocalSymbol, target: BoundLValue, node: Position, context: BindContext): void {
    const localScope = local.isRefLocal && local.refContext === 'local' ? 'local' : 'return';
    if (localScope !== 'return' || this.refScopeOf(target, context.fn) === 'return') return;
    const name = target.kind === 'local' ? target.local.name : this.describeRefTarget(target);
    this.refSafetyError(
      node,
      'CS8374',
      `'${name}' を '${local.name}' に ref 割り当てすることはできません。'${name}' のエスケープ スコープが '${local.name}' より狭いためです。`
    );
  }

  /** Reports `x = ref y` of a foreach variable, which refers to its element throughout the iteration. */
  private reportFixedReference(local: LocalSymbol, node: Extract<Expression, { kind: 'assign' }>): BoundExpression {
    this.error(
      node.target,
      'CS1656',
      `'${local.name}' は '${local.readonlyReason}' であるため、これに割り当てることはできません`
    );
    return { kind: 'default', type: ERROR_TYPE, row: node.row };
  }

  /** `r.F = ref x`: a ref field refers to another variable, which must outlive the ref struct holding the field. */
  private bindRefFieldAssignment(
    node: Extract<Expression, { kind: 'assign' }>,
    left: Extract<BoundExpression, { kind: 'field' }>,
    value: Extract<Expression, { kind: 'refExpression' }>,
    context: BindContext
  ): BoundExpression {
    const { field } = left;
    // `readonly ref` forbids pointing the field elsewhere outside constructors, as `readonly` forbids assigning.
    this.checkReadonlyField(field, context, node.target, 'assign');
    const target = this.bindRefTarget(value.operand, field.byRef === 'readonly', context, 'local');
    if (target.kind === 'discard') return { kind: 'default', type: ERROR_TYPE, row: node.row };
    this.checkRefType(target.type, left.type, value);
    this.checkRefFieldTarget(target, field, this.valueContextOf(left.receiver, context.fn), node, context);
    return { kind: 'refFieldAssign', field: left, target, type: left.type, row: node.row };
  }

  /** Reports a variable that a ref field may not refer to, as it dies before the ref struct holding the field. */
  checkRefFieldTarget(
    target: BoundLValue,
    field: FieldSymbol,
    holder: SafeContext,
    position: Position,
    context: BindContext
  ): void {
    const targetContext = this.refContextOf(target, context.fn);
    if (outlives(targetContext, holder)) return;
    const name = target.kind === 'local' ? target.local.name : this.describeRefTarget(target);
    if (targetContext === 'return')
      this.refSafetyError(
        position,
        'CS9079',
        `'${name}' は return ステートメントを介してのみ現在のメソッドをエスケープできるため、'${name}' を '${field.name}' に ref 割り当てすることはできません。`
      );
    else
      this.refSafetyError(
        position,
        'CS8374',
        `'${name}' を '${field.name}' に ref 割り当てすることはできません。'${name}' のエスケープ スコープが '${field.name}' より狭いためです。`
      );
  }

  describeRefTarget(target: BoundLValue): string {
    return target.kind === 'field' ? target.field.name : displayType(target.type);
  }

  private bindAssignment(node: Extract<Expression, { kind: 'assign' }>, context: BindContext): BoundExpression {
    const { operator } = node;
    if (operator === '=' && node.target.kind === 'tuple') return this.bindDeconstructionAssignment(node, context);
    const lateAssignment = this.lateAssignment(node, context);
    if (lateAssignment) return lateAssignment;
    if (operator === '=' && node.value.kind === 'refExpression')
      return this.bindRefAssignment(node, node.value, context);
    if (operator === '=') return this.bindSimpleAssignment(node, context);
    if (operator === '??=') return this.bindCoalesceAssignment(node, context);
    return this.bindCompoundAssignment(node, context);
  }

  /** `x = y`, or `_ = y`, which takes the value's own type. */
  private bindSimpleAssignment(node: Extract<Expression, { kind: 'assign' }>, context: BindContext): BoundExpression {
    const target = this.bindLValue(node.target, context, 'assign');
    const value = this.bindValue(node.value, context);
    if (target.kind === 'discard') {
      if (value.kind === 'unbound') return this.convert(value, this.naturalTypeOf(value) ?? ERROR_TYPE, node);
      return { kind: 'assign', target: { ...target, type: value.type }, value, type: value.type, row: node.row };
    }
    const converted = this.convert(value, target.type, node.value);
    // A ref struct variable may take no value that refers to variables dying sooner than the ones it may refer to.
    if (isRefLikeType(target.type)) this.checkValueEscape(converted, this.valueContextOf(target, context.fn), context);
    return { kind: 'assign', target, value: converted, type: target.type, row: node.row };
  }

  /** `e += h` or `e -= h` of an event with `add` and `remove` accessors, which calls the accessor. */
  private callEventAccessor(
    target: BoundLValue,
    method: MethodSymbol,
    node: Extract<Expression, { kind: 'assign' }>,
    context: BindContext
  ): BoundExpression {
    const receiver = target.kind === 'field' ? target.receiver : undefined;
    return {
      kind: 'call',
      method,
      receiver,
      args: [this.bindAs(node.value, target.type, context)],
      typeArgs: [],
      owner:
        target.kind === 'staticField'
          ? target.owner
          : ((receiver?.type as NamedType | undefined) ?? method.owner.declaredType),
      isVirtual: method.isVirtual || method.isOverride || method.isAbstract,
      type: VOID_TYPE,
      row: node.row,
    };
  }

  /** `x op= y`: an event's accessor, a C# 14 instance operator, or `x = (T)(x op y)` (C# spec §12.21.4). */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private bindCompoundAssignment(node: Extract<Expression, { kind: 'assign' }>, context: BindContext): BoundExpression {
    const { operator } = node;
    const binaryOperator = operator.slice(0, -1);
    const saved = this.subscriptionTarget;
    this.subscriptionTarget = binaryOperator === '+' || binaryOperator === '-' ? node.target : undefined;
    let target: BoundLValue;
    try {
      target = this.bindLValue(node.target, context, 'compound');
    } finally {
      this.subscriptionTarget = saved;
    }
    const eventAccessors =
      target.kind === 'field' || target.kind === 'staticField'
        ? (target.field.eventAccessors ?? target.field.virtualEventAccessors)
        : undefined;
    if (eventAccessors && (binaryOperator === '+' || binaryOperator === '-'))
      return this.callEventAccessor(
        target,
        binaryOperator === '+' ? eventAccessors.add : eventAccessors.remove,
        node,
        context
      );
    if (target.kind === 'field' && target.field.isEvent && (binaryOperator === '+' || binaryOperator === '-')) {
      const value = this.bindAs(node.value, target.type, context);
      if (context.fn.typeContext.type !== target.field.owner)
        return { kind: 'eventAccessor', target, isAdd: binaryOperator === '+', value, type: VOID_TYPE, row: node.row };
    }
    const value = this.bindValue(node.value, context);
    const instanceOperator = this.bindAssignmentOperator(operator, target, [value], node.row);
    if (instanceOperator) return instanceOperator;
    const operand: BoundExpression = { kind: 'compoundOperand', type: target.type, row: node.row };
    // `s += c` with a conditional c without a common type is `string + object` as in a binary `+`.
    const valueTarget =
      binaryOperator === '+' && isTypelessConditional(value) && isStringValue(operand) ? this.objectType : target.type;
    const resolvedValue = value.kind === 'unbound' ? this.convert(value, valueTarget, node) : value;
    const operation = this.bindBinary(binaryOperator, operand, resolvedValue, node.row, operator);
    if (operation.type.kind === 'error') return { kind: 'default', type: ERROR_TYPE, row: node.row };
    const converted =
      this.implicitConversionOf(operation, target.type) || operation.kind !== 'binary'
        ? this.convert(operation, target.type, node)
        : this.compoundConversion(operation, target.type, resolvedValue, node);
    return { kind: 'compoundAssign', target, operation: converted, type: target.type, row: node.row };
  }

  /** Binds `await operand` (C# spec §12.9.8), whose awaiter a `dynamic` operand finds only as it runs. */
  private bindAwait(node: Extract<Expression, { kind: 'await' }>, context: BindContext): BoundExpression {
    this.checkAwaitContext(node, context.fn);
    const operand = this.bindTypedValue(node.operand, context);
    if (operand.type.kind === 'error') return { kind: 'default', type: ERROR_TYPE, row: node.row };
    if (isDynamicType(operand.type)) return this.bindDynamicAwait(node, operand, context);
    return bindAwaitPattern(this, node, operand, context);
  }

  /** Reports an `await` outside an async function (CS4032, CS4033, CS4034) or in a `lock` (CS1996). */
  private checkAwaitContext(node: Position, fn: BindContext['fn']): void {
    if (!fn.method.isAsync) {
      if (fn.kind === 'lambda')
        this.error(
          node,
          'CS4034',
          "await' 演算子は、非同期の ラムダ式 でのみ使用できます。この ラムダ式 を 'async' 修飾子でマークすることを検討してください。"
        );
      else if (fn.method.returnType.kind === 'void')
        this.error(
          node,
          'CS4033',
          "await' 演算子は、非同期メソッド内でのみ使用できます。このメソッドに 'async' 修飾子を指定し、戻り値の型を 'Task' に変更することを検討してください。"
        );
      else
        this.error(
          node,
          'CS4032',
          `await' 演算子は、非同期メソッド内でのみ使用できます。このメソッドを 'async' 修飾子でマークし、戻り値の型を 'Task<${displayType(fn.method.returnType)}>' に変更することを検討してください。`
        );
    }
    if (fn.lockDepth > 0) this.error(node, 'CS1996', 'lock ステートメントの本体で待機することはできません');
  }

  /** `await d` of a `dynamic` value, whose awaiter, `IsCompleted`, and `GetResult()` bind when they run. */
  private bindDynamicAwait(
    node: Extract<Expression, { kind: 'await' }>,
    operand: BoundExpression,
    context: BindContext
  ): BoundExpression {
    const { row } = node;
    const member = (name: string): Extract<Expression, { kind: 'memberAccess' }> => ({
      kind: 'memberAccess',
      target: this.lateOperand(0, node),
      name,
      typeArgs: undefined,
      nameRow: row,
      row,
      column: node.column,
    });
    const call = (name: string): Expression => ({
      kind: 'invocation',
      target: member(name),
      args: [],
      row,
      column: node.column,
    });
    const dynamicOperand: BoundExpression = { kind: 'compoundOperand', type: this.dynamicType, row };
    const options = { receiver: 0, isStatement: true };
    const getAwaiter = this.late(call('GetAwaiter'), [dynamicOperand], context, options);
    const isCompleted = this.convert(
      this.late(member('IsCompleted'), [dynamicOperand], context, { receiver: 0 }),
      this.boolType,
      node
    );
    const getResult = this.late(call('GetResult'), [dynamicOperand], context, options);
    return { kind: 'await', operand, getAwaiter, isCompleted, getResult, type: this.dynamicType, row };
  }

  /** The type of `typeof`, where an unbound generic type (`List<>`) stands for its definition. */
  private typeofTarget(node: TypeNode, context: BindContext): Type {
    if (node.kind === 'namedType' && node.unboundArity !== undefined) {
      const symbol = this.findTypeInScope(node.name, node.unboundArity, context.fn.typeContext);
      if (symbol) return symbol.declaredType;
    }
    return this.resolveType(node, context.fn.typeContext);
  }

  /** `sizeof` of a type with a size the language defines (C# spec §23.6.9); others need an unsafe context. */
  private bindSizeof(node: Extract<Expression, { kind: 'sizeof' }>, context: BindContext): BoundExpression {
    const type = this.resolveType(node.type, context.fn.typeContext);
    const size = sizeOfType(type);
    if (size !== undefined) return this.constant(size, this.intType, node.row);
    // In unsafe code, sizeof gives any unmanaged type's size, as .NET lays it out.
    if (node.isUnsafe && type.kind === 'named' && (isPointerType(type) || isValueType(type)))
      return this.constant(sizeOf(type), this.intType, node.row);
    if (type.kind !== 'error')
      this.error(
        node,
        'CS0233',
        `'${displayType(type)}' には定義済みのサイズが指定されていないため、sizeof は unsafe コンテキストでのみ使用できます`
      );
    return { kind: 'default', type: this.intType, row: node.row };
  }

  /** `__makeref(x)`, `__reftype(r)`, and `__refvalue(r, T)`, which make and read a `TypedReference`. */
  private bindTypedReference(
    node: Extract<Expression, { kind: 'makeRef' | 'refType' | 'refValue' }>,
    context: BindContext
  ): BoundExpression {
    const typedReference = namedType(this.library.typeNamed('System.TypedReference'));
    const row = node.row;
    if (node.kind === 'makeRef')
      return { kind: 'makeRef', target: this.bindLValue(node.operand, context, 'ref'), type: typedReference, row };
    const operand = this.bindAs(node.operand, typedReference, context);
    if (node.kind === 'refType')
      return { kind: 'refType', operand, type: namedType(this.library.typeNamed('System.Type')), row };
    if (node.type.kind === 'varType') {
      this.error(
        node.type,
        'CS0825',
        "コンテキスト キーワード 'var' は、ローカル変数宣言内またはスクリプト コード内でのみ有効です"
      );
      return { kind: 'default', type: ERROR_TYPE, row };
    }
    return { kind: 'refValue', operand, type: this.resolveType(node.type, context.fn.typeContext), row };
  }

  pointerTo(type: Type): NamedType {
    return namedType(this.library.typeNamed('System.Runtime.CompilerServices.__Pointer', 1), [type]);
  }

  /** Whether the fixed-size buffer being bound may be movable: one indexed, or one a `fixed` statement fixes. */
  protected allowsMovableFixedBuffer = false;

  /** A fixed-size buffer, which a movable variable gives only to be indexed or fixed (CS1666). */
  protected fixedBufferAccess(access: BoundExpression, elementType: Type, position: Position): BoundExpression {
    if (!this.allowsMovableFixedBuffer && !isFixedVariable(access))
      this.error(
        position,
        'CS1666',
        'fixed でない式に含まれる固定サイズ バッファーは使用できません。fixed ステートメントを使用してください。'
      );
    return { kind: 'addressOf', target: access as BoundLValue, type: this.pointerTo(elementType), row: position.row };
  }

  /** `*p`, the variable a pointer points to. */
  dereference(pointer: BoundExpression, position: Position): BoundExpression {
    if (pointer.type.kind === 'error') return { kind: 'default', type: ERROR_TYPE, row: position.row };
    if (!isPointerType(pointer.type)) {
      this.error(position, 'CS0193', '* または -> 演算子はポインターに対して使用してください');
      return { kind: 'default', type: ERROR_TYPE, row: position.row };
    }
    if (isVoidPointer(pointer.type)) {
      this.error(position, 'CS0242', '問題の操作は void ポインターで定義されていません');
      return { kind: 'default', type: ERROR_TYPE, row: position.row };
    }
    return { kind: 'deref', pointer, type: pointeeOf(pointer.type) as Type, row: position.row };
  }

  /**
   * `&x` of a variable, or of a method for a function pointer. Only a fixed variable (a local, or a field of a struct
   * that is one, or what a pointer points to) has an address outside a `fixed` statement's initializer (CS0212),
   * which takes the address of a movable one only (CS0213).
   */
  bindAddressOf(node: Extract<Expression, { kind: 'addressOf' }>, context: BindContext, inFixed: boolean): BindResult {
    if (!node.isUnsafe) this.reportOutsideUnsafe(node);
    const bound = this.bindExpression(node.operand, context);
    if (bound.kind === 'methodGroup') return bound;
    const value = this.toValue(bound, node.operand);
    if (value.type.kind === 'error') return { kind: 'default', type: ERROR_TYPE, row: node.row };
    if (!['local', 'field', 'staticField', 'element', 'deref'].includes(value.kind)) {
      this.error(node, 'CS0211', '式のアドレスを取得できません');
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    if (value.kind === 'local' && value.local.owner !== context.fn.method) {
      this.error(
        node,
        'CS1686',
        `ローカル '${value.local.name}' またはそのメンバーは、アドレスを与えることも、匿名メソッドまたはラムダ式の内部で使用されることもできません`
      );
    }
    const isFixed = isFixedVariable(value);
    if (!isFixed && !inFixed)
      this.error(node, 'CS0212', 'fixed ステートメントの初期化子内の fixed でない式のアドレスのみを取得できます');
    if (isFixed && inFixed)
      this.error(
        node,
        'CS0213',
        '既に fixed が使用されている式のアドレスを取得するために、fixed ステートメントを使用することはできません'
      );
    return { kind: 'addressOf', target: value as BoundLValue, type: this.pointerTo(value.type), row: node.row };
  }

  /** A `stackalloc` that no pointer local takes as its initializer, which is then a Span of its elements. */
  private bindNestedStackalloc(node: Extract<Expression, { kind: 'stackalloc' }>, context: BindContext): Unbound {
    const bound = this.bindStackalloc(node, undefined, context) as Extract<BoundExpression, { kind: 'stackalloc' }>;
    return { kind: 'unbound', node, context, spanElement: bound.elementType, type: ERROR_TYPE, row: node.row };
  }

  /** Converts a Span's `stackalloc`, which only a pointer local's initializer makes a pointer (CS8346). */
  private convertNestedStackalloc(expression: Unbound, target: Type, report: boolean): undefined {
    if (!isPointerType(target)) return this.unsupported(expression.node, 'Span への `stackalloc`');
    if (report)
      this.error(
        expression.node,
        'CS8346',
        `型 '${displayType(expression.spanElement ?? ERROR_TYPE)}' の stackalloc 式を型 '${displayType(target)}' に変換することはできません。`
      );
    return undefined;
  }

  /** `stackalloc T[n]` or `stackalloc[] { ... }`, as a pointer to a new buffer of its elements. */
  bindStackalloc(
    node: Extract<Expression, { kind: 'stackalloc' }>,
    targetElement: Type | undefined,
    context: BindContext
  ): BoundExpression {
    const values = node.initializer?.map((value) => this.bindValue(value, context));
    let elementType = node.elementType ? this.resolveType(node.elementType, context.fn.typeContext) : targetElement;
    elementType ??= this.bestCommonType(values ?? []) ?? ERROR_TYPE;
    const element = elementType;
    const length = node.count
      ? this.bindAs(node.count, this.intType, context)
      : this.constant(values?.length ?? 0, this.intType, node.row);
    return {
      kind: 'stackalloc',
      elementType: element,
      length,
      values: values?.map((value, index) => this.convert(value, element, node.initializer?.[index] ?? node)),
      type: this.pointerTo(element),
      row: node.row,
    };
  }

  /** `new T(args)` of a library struct whose constructor takes exactly the arguments' types. */
  private libraryCreation(fullName: string, args: BoundExpression[], node: Position): BoundExpression {
    const type = namedType(this.library.typeNamed(fullName));
    const constructor = type.symbol.constructors.find(
      (candidate) =>
        candidate.parameters.length === args.length &&
        candidate.parameters.every((parameter, index) => sameType(parameter.type, args[index].type))
    );
    return { kind: 'new', constructor, objectType: type, args, initializer: undefined, type, row: node.row };
  }

  /**
   * Binds `x[^i]` and `x[a..b]` on a type without an indexer that takes an Index or a Range, by C# spec §12.8.12's
   * implicit support: the receiver and the index are evaluated once into hidden locals, and the access becomes
   * `x[i.GetOffset(x.Length)]` (or `Count`), and for a range `x.Slice(offset, length)`, `Substring` on a string, or
   * `RuntimeHelpers.GetSubArray` on an array.
   */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one kind of receiver of the C# rule.
  /**
   * The argument of `a[i]` when C# lowers the access by the Index or Range it is (C# spec §12.8.12.3): a target with
   * a length and an int indexer or a slice method, and no indexer of its own that takes the Index or the Range.
   */
  private implicitIndexArgument(
    target: BoundExpression,
    node: Extract<Expression, { kind: 'elementAccess' }>,
    context: BindContext
  ): { value: BoundExpression; isRange: boolean } | undefined {
    const [arg] = node.args;
    if (node.args.length !== 1 || arg.name || arg.modifier || target.type.kind === 'error') return undefined;
    const syntax = arg.value;
    if (
      syntax.kind !== 'fromEnd' &&
      syntax.kind !== 'range' &&
      syntax.kind !== 'name' &&
      syntax.kind !== 'memberAccess'
    )
      return undefined;
    const indexType = namedType(this.library.typeNamed('System.Index'));
    const rangeType = namedType(this.library.typeNamed('System.Range'));
    const isIndexOrRange = (type: Type): boolean => sameType(type, indexType) || sameType(type, rangeType);
    let isRangeSyntax = syntax.kind === 'range';
    if (syntax.kind === 'name' || syntax.kind === 'memberAccess') {
      const peeked = this.quietly(() => this.bindValue(syntax, context));
      if (!peeked || !isIndexOrRange(peeked.type)) return undefined;
      isRangeSyntax = sameType(peeked.type, rangeType);
    }
    // Without a slice method, or an int indexer, the access binds as written, which reports the argument's type.
    const isSliceable =
      target.type.kind === 'array' ||
      specialOf(target.type) === 'string' ||
      (isRangeSyntax
        ? this.lookupMember(target.type, 'Slice', context.fn.typeContext, 0, true).found?.kind === 'methods'
        : this.lookupIndexers(target.type, context.fn.typeContext).some(
            (indexer) =>
              indexer.property.parameters.length === 1 && specialOf(indexer.property.parameters[0].type) === 'int'
          ));
    if (!isSliceable) return undefined;
    // A type whose own indexer takes the Index or the Range uses it.
    const indexers = target.type.kind === 'array' ? [] : this.lookupIndexers(target.type, context.fn.typeContext);
    if (
      indexers.some(
        (indexer) => indexer.property.parameters.length === 1 && isIndexOrRange(indexer.property.parameters[0].type)
      )
    )
      return undefined;
    const value = this.bindValue(syntax, context);
    if (!isIndexOrRange(value.type)) return undefined;
    return { value, isRange: sameType(value.type, rangeType) };
  }

  protected override bindIndexInitializerTarget(
    placeholder: BoundExpression,
    member: Extract<MemberInitializer, { kind: 'indexAssign' }>,
    context: BindContext
  ): BoundExpression {
    // `[^1] = v` (C# 13) indexes from the end of the object's member, as `x[^1]` does.
    const node: Extract<Expression, { kind: 'elementAccess' }> = {
      kind: 'elementAccess',
      target: { kind: 'this', row: member.row, column: member.column },
      args: member.args,
      row: member.row,
      column: member.column,
    };
    return (
      this.bindImplicitIndexOrRange(placeholder, node, context) ??
      this.bindElementAccess(placeholder, member.args, member, context)
    );
  }

  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  private bindImplicitIndexOrRange(
    target: BoundExpression,
    node: Extract<Expression, { kind: 'elementAccess' }>,
    context: BindContext
  ): BoundExpression | undefined {
    const argument = this.implicitIndexArgument(target, node, context);
    if (!argument) return undefined;
    const { value, isRange } = argument;
    const scope = new LocalScope(context.scope, context.fn);
    const inner: BindContext = { scope, fn: context.fn };
    const locals: LocalSymbol[] = [];
    const setup: BoundExpression[] = [];
    const hold = (name: string, held: BoundExpression): Expression => {
      const local = new LocalSymbol(`\0${name}`, held.type, node.row, node.column);
      local.isHidden = true;
      context.fn.addLocal(local);
      scope.variables.set(local.name, local);
      locals.push(local);
      setup.push({
        kind: 'assign',
        target: { kind: 'local', local, type: held.type, row: node.row },
        value: held,
        type: held.type,
        row: node.row,
      });
      return { kind: 'name', name: local.name, typeArgs: undefined, row: node.row, column: node.column };
    };
    const position = { row: node.row, column: node.column };
    const receiver = hold('receiver', target);
    const index = hold('index', value);
    const member = (on: Expression, name: string): Expression => ({
      kind: 'memberAccess',
      target: on,
      name,
      typeArgs: undefined,
      nameRow: node.row,
      ...position,
    });
    const call = (callee: Expression, args: Expression[]): Expression => ({
      kind: 'invocation',
      target: callee,
      args: args.map((argument) => ({ name: undefined, modifier: undefined, value: argument, ...position })),
      ...position,
    });
    const isArray = target.type.kind === 'array';
    const isString = specialOf(target.type) === 'string';
    const lengthName =
      isArray || isString || this.lookupMember(target.type, 'Length', context.fn.typeContext).found?.kind === 'property'
        ? 'Length'
        : 'Count';
    if (this.lookupMember(target.type, lengthName, context.fn.typeContext).found?.kind !== 'property' && !isArray) {
      this.error(
        node,
        'CS0021',
        `角かっこ [] 付きインデックスを '${displayType(target.type)}' 型の式に適用することはできません`
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    let access: BoundExpression;
    if (!isRange) {
      const offset = call(member(index, 'GetOffset'), [member(receiver, lengthName)]);
      access = this.bindValue(
        {
          kind: 'elementAccess',
          target: receiver,
          args: [{ name: undefined, modifier: undefined, value: offset, ...position }],
          ...position,
        },
        inner
      );
    } else if (isArray) {
      const system: Expression = {
        kind: 'aliasQualified',
        alias: 'global',
        name: 'System',
        typeArgs: undefined,
        ...position,
      };
      const helpers = member(
        member(member(member(system, 'Runtime'), 'CompilerServices'), 'RuntimeHelpers'),
        'GetSubArray'
      );
      access = this.bindValue(call(helpers, [receiver, index]), inner);
    } else {
      // Roslyn computes both ends' offsets and passes their difference, leaving a reversed range to the slice method.
      const length = hold('length', this.bindValue(member(receiver, lengthName), inner));
      const start = hold('start', this.bindValue(call(member(member(index, 'Start'), 'GetOffset'), [length]), inner));
      const end = hold('end', this.bindValue(call(member(member(index, 'End'), 'GetOffset'), [length]), inner));
      const difference: Expression = {
        kind: 'binary',
        operator: '-',
        left: end,
        right: start,
        operatorRow: node.row,
        ...position,
      };
      access = this.bindValue(call(member(receiver, isString ? 'Substring' : 'Slice'), [start, difference]), inner);
    }
    if (access.type.kind === 'error') return access;
    return { kind: 'implicitIndex', setup, access, locals, type: access.type, row: node.row };
  }

  /** The expression of the expression statement being bound, whose value nothing uses. */
  protected unusedValue: Expression | undefined;

  /**
   * Binds a compound assignment or `++`/`--` to the target type's C# 14 instance operator (`void operator +=(T x)`),
   * which changes the target in place; the expression's value is the target afterwards.
   */
  private bindAssignmentOperator(
    operator: string,
    target: BoundLValue,
    values: BoundExpression[],
    row: number
  ): BoundExpression | undefined {
    const name = ASSIGNMENT_OPERATOR_NAMES[operator];
    const type = target.type;
    if (!name || type.kind !== 'named' || type.symbol.special !== undefined) return undefined;
    const find = (candidateName: string): MethodCandidate[] => {
      const own = this.lookupOperators(type, candidateName).filter((candidate) => !candidate.method.isStatic);
      return own.length > 0 ? own : this.lookupExtensionAssignmentOperators(type, candidateName);
    };
    const checkedCandidates = this.checkedContext ? find(checkedOperatorName(name)) : [];
    const candidates = checkedCandidates.length > 0 ? checkedCandidates : find(name);
    if (candidates.length === 0) return undefined;
    const args: ArgumentInfo[] = values.map((value) => ({
      expression: value,
      name: undefined,
      refKind: undefined,
      row,
      target: undefined,
    }));
    // An extension block's operator takes the target as its receiver argument, by reference for a `ref` receiver.
    const isExtension = candidates[0].method.extensionAssignmentOf !== undefined;
    const receiver: ArgumentInfo = {
      expression: target as BoundExpression,
      name: undefined,
      refKind: undefined,
      row,
      target,
      isReceiver: true,
    };
    // When no instance operator applies, the assignment uses the binary operator, as `b += other` does.
    const saved = this.diagnostics.length;
    const resolved = this.resolveCall(candidates, isExtension ? [receiver, ...args] : args, undefined, row, {
      name,
      kind: 'operator',
      isExtension,
    });
    if (!resolved) {
      this.diagnostics.length = saved;
      return undefined;
    }
    const { method } = resolved.candidate;
    const call: BoundExpression = {
      kind: 'call',
      method,
      receiver: isExtension ? undefined : (target as BoundExpression),
      args: resolved.args,
      typeArgs: resolved.typeArgs,
      owner: resolved.candidate.owner,
      isVirtual: method.isVirtual || method.isAbstract,
      type: VOID_TYPE,
      row,
    };
    return { kind: 'sequence', locals: [], sideEffects: [call], value: target as BoundExpression, type, row };
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
    // `a ??= b` on a nullable `a` has the underlying type when `b` converts to it, and the nullable type otherwise, as
    // for `int? b` or `null` (C# spec §12.22.1).
    const isUnderlying =
      underlying !== undefined &&
      (value.kind === 'throw' || this.implicitConversionOf(value, underlying) !== undefined);
    const resultType = isUnderlying ? (underlying as Type) : target.type;
    const right = value.kind === 'throw' ? value : this.convert(value, resultType, node);
    const coalesce: BoundExpression = {
      kind: 'coalesce',
      left: operand,
      right: isUnderlying ? this.convert(right, target.type, node) : right,
      unwrapLeft: false,
      type: target.type,
      row: node.row,
    };
    return { kind: 'compoundAssign', target, operation: coalesce, type: resultType, row: node.row };
  }

  // code-gauge-allow functionNcss -- One case per kind of syntax or value that the function handles.
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private bindIncrement(node: Extract<Expression, { kind: 'increment' }>, context: BindContext): BoundExpression {
    const readonlyRef = node.operand.kind === 'name' ? context.scope.lookup(node.operand.name)?.local : undefined;
    if (readonlyRef?.isRefLocal && readonlyRef.refKind === 'in' && !readonlyRef.isReadonly) {
      this.error(
        node,
        'CS1059',
        'インクリメント演算子またはデクリメント演算子のオペランドには、変数、プロパティ、またはインデクサーを指定してください'
      );
      return { kind: 'default', type: ERROR_TYPE, row: node.row };
    }
    if (node.operand.kind === 'memberAccess' || node.operand.kind === 'elementAccess') {
      const probe = this.quietly(() => this.bindExpression(node.operand, context));
      if (probe?.kind === 'late') {
        const late = this.bindExpression(node.operand, context) as Extract<BoundExpression, { kind: 'late' }>;
        return this.late({ ...node, operand: late.syntax }, late.operands, context, { receiver: 0, isStatement: true });
      }
    }
    const target = this.bindLValue(node.operand, context, 'compound');
    if (target.type.kind === 'error') return { kind: 'default', type: ERROR_TYPE, row: node.row };
    if (isDynamicType(target.type)) {
      const operand: BoundExpression = { kind: 'compoundOperand', type: target.type, row: node.row };
      const one = this.constant(1, this.intType, node.row);
      const operation = this.bindBinary(node.operator === '++' ? '+' : '-', operand, one, node.row);
      return { kind: 'increment', target, isPrefix: node.prefix, operation, type: target.type, row: node.row };
    }
    const operand: BoundExpression = { kind: 'compoundOperand', type: target.type, row: node.row };
    const underlying = nullableUnderlying(target.type) ?? target.type;
    const special = specialOf(underlying);
    const isNumericTarget = (special !== undefined && isNumeric(underlying)) || isEnum(underlying);
    let operation: BoundExpression;
    if (isPointerType(target.type))
      operation = this.bindBinary(
        node.operator === '++' ? '+' : '-',
        operand,
        this.constant(1, this.intType, node.row),
        node.row
      );
    else if (isNumericTarget) {
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
      // A postfix `x++` whose value is used needs the value before the change, which an instance operator lacks.
      const instanceOperator =
        node.prefix || this.unusedValue === node
          ? this.bindAssignmentOperator(node.operator, target, [], node.row)
          : undefined;
      if (instanceOperator) return instanceOperator;
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
    const target = node.target as Extract<Expression, { kind: 'tuple' }>;
    const targetTypes = this.quietly(() => this.deconstructTargetTypes(target, context)) ?? [];
    const value = this.deconstructedValue(node.value, context, targetTypes);
    if (!value) this.reportTypelessTargets(target, context);
    const valueType = value?.type ?? ERROR_TYPE;
    const targets = this.bindDeconstructTargets(target, valueType, value, context, node);
    return {
      kind: 'deconstructAssign',
      targets,
      value: !value || value.kind === 'unbound' ? { kind: 'default', type: ERROR_TYPE, row: node.row } : value,
      type: valueType,
      row: node.row,
    };
  }

  /** The types of the targets of `(a, (b, c)) = value`, each undefined where a target takes the value's. */
  private deconstructTargetTypes(
    syntax: Extract<Expression, { kind: 'tuple' }>,
    context: BindContext
  ): DeconstructTargets {
    return syntax.elements.map(({ value }) => {
      if (value.kind === 'tuple') return this.deconstructTargetTypes(value, context);
      if (value.kind === 'declaration')
        return value.type.kind === 'varType' ? undefined : this.resolveType(value.type, context.fn.typeContext);
      if (value.kind === 'name' && value.name === '_' && !context.scope.lookup('_')) return;
      return this.bindLValue(value, context, 'assign').type;
    });
  }

  /** Reports each target of `(a, var b) = (null, 1)` that takes its type from a value that leaves it without one. */
  private reportTypelessTargets(syntax: Extract<Expression, { kind: 'tuple' }>, context: BindContext): void {
    for (const { value } of syntax.elements) {
      if (value.kind === 'tuple') this.reportTypelessTargets(value, context);
      else if (value.kind === 'declaration' && value.type.kind === 'varType')
        this.reportTypelessDesignation(value.designation);
      else if (value.kind === 'name' && value.name === '_' && !context.scope.lookup('_'))
        this.reportTypelessDesignation({ ...value, kind: 'discard' });
    }
  }

  /** Reports each variable of `var (a, b) = (null, 1)`, which a value that leaves it without a type cannot type. */
  protected reportTypelessDesignation(designation: Designation): void {
    if (designation.kind === 'parenthesized') {
      for (const element of designation.elements) this.reportTypelessDesignation(element);
      return;
    }
    if (designation.kind === 'single' && designation.type) return;
    const name = designation.kind === 'single' ? designation.name : '_';
    this.error(designation, 'CS8130', `暗黙的に型指定された分解変数 '${name}' の型を推論できません。`);
    if (designation.kind === 'discard')
      this.error(designation, 'CS8183', '暗黙的に型指定された破棄の型を推論できません。');
  }

  private bindDeconstructTargets(
    node: Extract<Expression, { kind: 'tuple' }>,
    type: Type,
    value: BoundExpression | undefined,
    context: BindContext,
    position: Position
  ): BoundDeconstructTarget {
    const count = node.elements.length;
    const { elementTypes, deconstruct } = this.deconstructionOf(type, count, value, position, context);
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
        designation,
        context
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

  /**
   * The element types of a deconstruction: a tuple's elements, or the `out` parameters of a `Deconstruct` method, an
   * instance one or else an extension one in scope.
   */
  protected deconstructionOf(
    type: Type,
    count: number,
    value: BoundExpression | undefined,
    position: Position,
    context: BindContext
  ): { elementTypes: Type[]; deconstruct: BoundDeconstruct | undefined } {
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
    const { found } = this.lookupMember(type, 'Deconstruct', context.fn.typeContext);
    const candidate =
      found?.kind === 'methods'
        ? found.candidates.find(
            (option) =>
              option.method.parameters.length === count &&
              option.method.parameters.every((parameter) => parameter.refKind === 'out')
          )
        : undefined;
    if (candidate) {
      const substitution = substitutionOf(candidate.owner);
      return {
        elementTypes: candidate.method.parameters.map((parameter) => substitute(parameter.type, substitution)),
        deconstruct: { method: candidate.method, typeArgs: [] },
      };
    }
    const extensions = this.lookupExtensionMethods('Deconstruct', context.fn.typeContext);
    const extension = extensions.length > 0 ? this.extensionDeconstruct(type, count, extensions, position) : undefined;
    if (extension) return extension;
    if (extensions.length === 0) {
      const missing = missingDeconstruct(displayType(type), count, found?.kind === 'methods');
      this.error(position, missing.code, missing.message);
    }
    this.error(
      position,
      'CS8129',
      `${count} out パラメーターと void 戻り値の型を持つ、型 '${displayType(type)}' の適切な分解インスタンスまたは拡張メソッドが見つかりませんでした。`
    );
    return { elementTypes: [], deconstruct: undefined };
  }

  /**
   * The extension `Deconstruct` that `value.Deconstruct(out var _, ...)` calls, which overload resolution chooses,
   * inferring type arguments from the value alone, and reports when none applies.
   */
  private extensionDeconstruct(
    type: Type,
    count: number,
    extensions: MethodCandidate[],
    position: Position
  ): { elementTypes: Type[]; deconstruct: BoundDeconstruct } | undefined {
    const resolved = this.resolvePatternExtension(type, extensions, count, position);
    if (!resolved) return undefined;
    const substitution = this.callSubstitution(resolved.candidate, resolved.typeArgs);
    const { method } = resolved.candidate;
    return {
      elementTypes: method.parameters.slice(1).map((parameter) => substitute(parameter.type, substitution)),
      deconstruct: { method, typeArgs: resolved.typeArgs },
    };
  }

  /**
   * The extension method among candidates that a pattern, as deconstruction's or foreach's (C# 9), calls on a value of
   * a type with `out var` arguments of a count, which overload resolution chooses and reports when none applies.
   */
  protected resolvePatternExtension(
    type: Type,
    extensions: MethodCandidate[],
    outCount: number,
    position: Position
  ): ResolvedCall | undefined {
    const { row } = position;
    const receiver: ArgumentInfo = {
      expression: { kind: 'compoundOperand', type, row },
      name: undefined,
      refKind: undefined,
      row,
      target: undefined,
      isReceiver: true,
    };
    const outs = Array.from({ length: outCount }, (): ArgumentInfo => ({
      expression: { kind: 'default', type: ERROR_TYPE, row },
      name: undefined,
      refKind: 'out',
      row,
      target: undefined,
      isOutVar: true,
      declareOut: (elementType) => ({ kind: 'discard', type: elementType, row }),
    }));
    const name = extensions[0]?.method.name ?? '';
    return this.resolveCall(extensions, [receiver, ...outs], undefined, row, {
      name,
      kind: 'method',
      isExtension: true,
    });
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
        locals: LocalSymbol[];
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
      const value = this.bindTypedValue(node.value, context);
      const handled: Space = [];
      const arms = node.arms.map((arm) => {
        const scope = new LocalScope(context.scope, context.fn);
        const armContext: BindContext = { scope, fn: context.fn };
        const pattern = this.bindPattern(arm.pattern, value.type, armContext);
        const guard = arm.guard ? this.bindAs(arm.guard, this.boolType, armContext) : undefined;
        if (value.type.kind !== 'error') this.checkArmReachable(handled, { pattern, guard }, arm.pattern);
        const result = this.bindAllowingThrow(arm.value, armContext);
        return { pattern, guard, value: result, locals: scope.locals, row: arm.row, syntax: arm.value };
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
        locals: arm.locals,
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

/** A conditional branch's type as Roslyn names it in CS0173, `<null>` for one without a type. */
function branchTypeText(branch: BoundExpression | undefined): string {
  return !branch || branch.kind === 'unbound' || branch.type.kind === 'null' ? '<null>' : displayType(branch.type);
}

function isTypelessConditional(value: BoundExpression): boolean {
  return value.kind === 'unbound' && value.node.kind === 'conditional';
}

function isStringValue(value: BoundExpression): boolean {
  return value.kind !== 'unbound' && value.type.kind === 'named' && value.type.symbol.special === 'string';
}

/** The sizes of the types whose `sizeof` is a constant outside unsafe code. */
const PREDEFINED_SIZES: Partial<Record<string, number>> = {
  sbyte: 1,
  byte: 1,
  bool: 1,
  short: 2,
  ushort: 2,
  char: 2,
  int: 4,
  uint: 4,
  float: 4,
  long: 8,
  ulong: 8,
  double: 8,
  decimal: 16,
};

function sizeOfType(type: Type): number | undefined {
  if (type.kind !== 'named') return undefined;
  const special = type.symbol.kind === 'enum' ? type.symbol.enumUnderlying?.symbol.special : type.symbol.special;
  return special ? PREDEFINED_SIZES[special] : undefined;
}

/** Whether one argument may call a method of the parameters. */
function takesOneArgument(parameters: readonly ParameterSymbol[]): boolean {
  return parameters.length > 0 && parameters.slice(1).every(isOptionalParameter);
}

/** Whether a call may leave out a parameter's argument: an optional parameter's or a `params` one's. */
function isOptionalParameter(parameter: ParameterSymbol): boolean {
  return parameter.defaultValue !== undefined || parameter.defaultSyntax !== undefined || parameter.isParams;
}
