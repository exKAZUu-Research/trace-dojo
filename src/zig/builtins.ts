import { ExecutionLimitError } from '../interpreter/limits';
import { transferCost } from './allocation';
import {
  checkShiftAmount,
  divCeil,
  divExact,
  divFloor,
  divTrunc,
  floatMod,
  floatRem,
  intCast,
  intFromFloat,
  mod,
  PANIC,
  panic,
  rem,
} from './arith';
import type { Expression, ExpressionOf, Span } from './ast';
import { activeUnionIndex, unionTagValue } from './bufferMemory';
// code-gauge-allow-file fileNcss -- The file holds one layer of the compiler, whose parts share its private state.
import { enumLookup } from './enumLookup';
import { ExpressionCompiler, log2IntType } from './expressions';
import {
  type AnyFloat,
  asBigFloat,
  BigFloat,
  floatArithmetic,
  type FloatBits,
  floatFromBigInt,
  floatOf,
  floatSqrt,
  isIntegral,
  isNaNFloat,
  minMaxFloat,
  roundNumber,
  roundTo,
  signBit,
  truncateToBigInt,
} from './floats';
import { integerOperationWork, spendIntegerShift } from './integerWork';
import { sizeOf } from './layout';
import { importStd } from './library/std';
import { spendMemory } from './memoryAccounting';
import { MemoryFault } from './memoryFault';
import { isIntegerType } from './operands';
import { referenceUnary } from './referenceMath';
import type { UnaryOperation } from './referenceMathOperations';
import type { Frame } from './runtime';
import {
  copyForStorage,
  copyIntoReservedStorage,
  evaluateHeld,
  inMemoryCoercible,
  known,
  knownLengthOf,
  newArray,
  runtime,
  type SemaApi,
  staticResultOf,
  type TExpr,
  valueEvaluators,
} from './semaBase';
import { singleValueOf } from './singleValue';
import {
  arrayOf,
  BOOL,
  COMPTIME_INT,
  type EnumType,
  fitsInt,
  type FloatType,
  type IntType,
  intType,
  isVectorType,
  maxInt,
  minInt,
  sliceOf,
  TYPE,
  type Type,
  typeName,
  U8,
  USIZE,
  vectorOf,
  VOID,
  wrapInt,
} from './types';
import { UNAVAILABLE, unavailableMessage } from './unavailable';
import { decodeIdentifierBytes, decodeUtf8, encodeIdentifierText, identifierTextByteLength } from './utf8';
import {
  arrayPointerView,
  ErrorValue,
  isUndefinedMemory,
  markConstantStorage,
  Pointer,
  Slice,
  storageOverlaps,
  storeInto,
  type Value,
  ZArray,
  zeroArray,
  ZStruct,
  type ZUnion,
} from './values';

const ARGUMENT_COUNTS: Record<string, number> = {
  '@as': 2,
  '@intCast': 1,
  '@floatCast': 1,
  '@floatFromInt': 1,
  '@intFromFloat': 1,
  '@truncate': 1,
  '@intFromBool': 1,
  '@divTrunc': 2,
  '@divFloor': 2,
  '@divCeil': 2,
  '@divExact': 2,
  '@mod': 2,
  '@rem': 2,
  '@abs': 1,
  '@sqrt': 1,
  '@floor': 1,
  '@ceil': 1,
  '@round': 1,
  '@trunc': 1,
  '@sin': 1,
  '@cos': 1,
  '@tan': 1,
  '@exp': 1,
  '@exp2': 1,
  '@log': 1,
  '@log2': 1,
  '@log10': 1,
  '@addWithOverflow': 2,
  '@subWithOverflow': 2,
  '@mulWithOverflow': 2,
  '@shlWithOverflow': 2,
  '@shlExact': 2,
  '@shrExact': 2,
  '@clz': 1,
  '@ctz': 1,
  '@popCount': 1,
  '@byteSwap': 1,
  '@bitReverse': 1,
  '@mulAdd': 4,
  '@intFromEnum': 1,
  '@enumFromInt': 1,
  '@tagName': 1,
  '@errorName': 1,
  '@This': 0,
  '@panic': 1,
  '@unionInit': 3,
  '@errorCast': 1,
  '@memcpy': 2,
  '@memset': 2,
  '@memmove': 2,
  '@import': 1,
  '@splat': 1,
};

interface CastTargets {
  int: IntType | { readonly kind: 'comptime_int' };
  float: FloatType | { readonly kind: 'comptime_float' };
  enum: EnumType;
}

const MATH_OPERATIONS: Record<string, UnaryOperation> = {
  '@sin': 'sin',
  '@cos': 'cos',
  '@tan': 'tan',
  '@exp': 'exp',
  '@exp2': 'exp2',
  '@log': 'log',
  '@log2': 'log2',
  '@log10': 'log10',
};

export abstract class BuiltinCompiler extends ExpressionCompiler {
  private readonly nameSlices = new Map<string, Slice>();

  /** Refuses a builtin that this grader does not run, before any class of the compiler handles the call. */
  protected checkBuiltinAvailable(expression: ExpressionOf<'builtinCall'>): void {
    const unavailable = UNAVAILABLE.get(expression.name);
    if (unavailable && !(unavailable.inLibrary && this.enclosingNamespace().internal))
      this.error(expression, unavailableMessage(expression.name));
  }

  protected compileBuiltin(expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr {
    const { name, args } = expression;
    const count = ARGUMENT_COUNTS[name];
    if (count === undefined && name !== '@min' && name !== '@max' && name !== '@TypeOf') {
      return this.error(expression, `組み込み関数 ${name} はありません。`);
    }
    if (count !== undefined && args.length !== count) {
      this.error(expression, `${name} の引数の数が合いません（${count} 個が必要ですが、${args.length} 個です）。`);
    }
    switch (name) {
      case '@import': {
        return this.importBuiltin(expression);
      }
      case '@as': {
        const type = this.compileType(args[0]);
        return this.coerce(this.compile(args[1], type), type, args[1]);
      }
      case '@This': {
        return known(TYPE, this.thisType(expression), expression);
      }
      case '@TypeOf': {
        if (args.length === 0) this.error(expression, '@TypeOf には引数が要ります。');
        const types = args.map((arg) => this.withoutEffects(() => this.compile(arg)));
        return known(TYPE, types.length === 1 ? types[0].type : this.peerType(types, expression), expression);
      }
      case '@panic': {
        const message = this.coerce(this.compile(args[0], CONST_U8), CONST_U8, args[0]);
        const evaluate = message.eval;
        return runtime({ kind: 'noreturn' }, (frame) => panic(bytesToText(evaluate(frame) as Slice)), expression);
      }
      case '@intCast': {
        return this.intCastBuiltin(args[0], this.castTarget(expression, resultType, 'int'), expression);
      }
      case '@truncate': {
        const target = this.castTarget(expression, resultType, 'int');
        const operand = this.compile(args[0]);
        if (operand.type.kind !== 'int' && operand.type.kind !== 'comptime_int') {
          this.error(args[0], `@truncate は整数にだけ使えます（${typeName(operand.type)} 型です）。`);
        }
        if (target.kind === 'comptime_int') return this.coerce(this.comptimeOperand(operand), target, expression);
        if (operand.type.kind === 'int' && operand.type.signed !== target.signed) {
          this.error(
            args[0],
            `@truncate では符号を変えられません（${typeName(operand.type)} を ${typeName(target)} にしようとしています）。`
          );
        }
        if (operand.type.kind === 'int' && operand.type.bits < target.bits) {
          this.error(
            expression,
            `${typeName(operand.type)} から ${typeName(target)} へは、@truncate で小さくできません。`
          );
        }
        return this.derived(operand, target, (value) => wrapInt(value as bigint, target));
      }
      case '@floatCast': {
        const target = this.castTarget(expression, resultType, 'float');
        const operand = this.compile(args[0]);
        if (operand.type.kind !== 'float' && operand.type.kind !== 'comptime_float') {
          this.error(args[0], `@floatCast は浮動小数点数にだけ使えます（${typeName(operand.type)} 型です）。`);
        }
        if (target.kind === 'comptime_float')
          return this.derived(this.comptimeOperand(operand), target, (value) => asBigFloat(value as AnyFloat));
        return this.derived(operand, target, (value) => convertFloat(value as AnyFloat, target.bits));
      }
      case '@floatFromInt': {
        const target = this.castTarget(expression, resultType, 'float');
        const operand = this.compile(args[0]);
        if (operand.type.kind !== 'int' && operand.type.kind !== 'comptime_int') {
          this.error(args[0], `@floatFromInt は整数にだけ使えます（${typeName(operand.type)} 型です）。`);
        }
        const bits: FloatBits = target.kind === 'float' ? target.bits : 128;
        const source = target.kind === 'comptime_float' ? this.comptimeOperand(operand) : operand;
        return this.derived(source, target, (value) => {
          const converted = floatFromBigInt(value as bigint, bits);
          return target.kind === 'comptime_float' ? asBigFloat(converted) : converted;
        });
      }
      case '@intFromFloat': {
        const target = this.castTarget(expression, resultType, 'int');
        const operand = this.compile(args[0]);
        if (operand.type.kind !== 'float' && operand.type.kind !== 'comptime_float') {
          this.error(args[0], `@intFromFloat は浮動小数点数にだけ使えます（${typeName(operand.type)} 型です）。`);
        }
        if (target.kind === 'comptime_int') {
          return this.derived(this.comptimeOperand(operand), target, (source) => {
            const value = asBigFloat(source as AnyFloat);
            if (value.kind !== 'finite') return this.error(expression, '有限でない値は comptime_int 型にできません。');
            return truncateToBigInt(value);
          });
        }
        if (operand.known && target.kind === 'int') {
          const value = operand.value as AnyFloat;
          if (isNaNFloat(value)) this.error(expression, `NaN は ${typeName(target)} 型にできません。`);
          try {
            return known(target, intFromFloat(value, target), expression);
          } catch {
            return this.error(expression, `浮動小数点数の整数部分が ${typeName(target)} 型に入りません。`);
          }
        }
        return this.derived(operand, target, (value) => intFromFloat(value as AnyFloat, target));
      }
      case '@intFromBool': {
        const operand = this.coerce(this.compile(args[0], BOOL), BOOL, args[0]);
        return this.derived(operand, intType(false, 1), (value) => (value ? 1n : 0n));
      }
      case '@divTrunc':
      case '@divFloor':
      case '@divCeil':
      case '@divExact':
      case '@mod':
      case '@rem': {
        return this.divisionBuiltin(name, expression, resultType);
      }
      case '@min':
      case '@max': {
        return this.minMax(name, expression, resultType);
      }
      case '@abs': {
        return this.absBuiltin(expression, resultType);
      }
      case '@sqrt':
      case '@floor':
      case '@ceil':
      case '@round':
      case '@trunc':
      case '@sin':
      case '@cos':
      case '@tan':
      case '@exp':
      case '@exp2':
      case '@log':
      case '@log2':
      case '@log10': {
        return this.floatMath(name, expression, resultType);
      }
      case '@addWithOverflow':
      case '@subWithOverflow':
      case '@mulWithOverflow':
      case '@shlWithOverflow': {
        return this.overflowBuiltin(name, expression);
      }
      case '@shlExact':
      case '@shrExact': {
        return this.exactShift(name, expression, resultType);
      }
      case '@clz':
      case '@ctz':
      case '@popCount':
      case '@byteSwap':
      case '@bitReverse': {
        return this.bitBuiltin(name, expression);
      }
      case '@mulAdd': {
        return this.mulAdd(expression);
      }
      case '@intFromEnum': {
        const operand = this.compile(args[0]);
        const type = operand.type;
        if (type.kind === 'union' && type.tagType) {
          const tagType = type.tagType;
          const tags = this.enumFields(tagType);
          this.unionFields(type);
          return this.derived(operand, tagType.tagType as IntType, (value) => unionTagValue(value as ZUnion, tags));
        }
        if (type.kind !== 'enum')
          return this.error(args[0], `@intFromEnum は enum の値にだけ使えます（${typeName(type)} 型です）。`);
        this.enumFields(type);
        return { ...operand, type: type.tagType as IntType, place: undefined };
      }
      case '@enumFromInt': {
        const target = this.castTarget(expression, resultType, 'enum');
        const fields = enumLookup(this.enumFields(target), () => this.spendCompilation()).byValue;
        const tagType = target.tagType as IntType;
        const operand = this.compile(args[0], tagType);
        if (!isIntegerType(operand.type)) this.error(args[0], '@enumFromInt の引数は整数にしてください。');
        if (operand.known && !fitsInt(operand.value as bigint, tagType))
          this.error(args[0], `enum ${typeName(target)} の整数型で値を表せません。`);
        if (operand.known) {
          const value = operand.value as bigint;
          if (target.exhaustive && !fields.has(value as bigint)) {
            this.error(expression, `enum ${typeName(target)} には、値 ${value} のフィールドがありません。`);
          }
          return known(target, value, expression);
        }
        const coerced = operand.type.kind === 'int' ? operand : this.coerce(operand, tagType, args[0]);
        const exhaustive = target.exhaustive;
        return this.derived(coerced, target, (value) => {
          if (!fitsInt(value as bigint, tagType)) panic(PANIC.invalidEnum);
          if (exhaustive && !fields.has(value as bigint)) panic(PANIC.invalidEnum);
          return value;
        });
      }
      case '@tagName': {
        return this.tagName(expression);
      }
      case '@errorName': {
        const operand = this.compile(args[0]);
        if (operand.type.kind !== 'error_set')
          this.error(args[0], `@errorName はエラーの値にだけ使えます（${typeName(operand.type)} 型です）。`);
        return this.derived(operand, NAME_SLICE, (value, frame) => this.nameSlice((value as ErrorValue).name, frame));
      }
      case '@errorCast': {
        return this.errorCast(expression, resultType);
      }
      case '@unionInit': {
        const type = this.compileType(args[0]);
        if (type.kind !== 'union') return this.error(args[0], '@unionInit の最初の引数は union の型にしてください。');
        const fieldName = decodeIdentifierBytes(
          byteValues(this.knownValue(this.compile(args[1], CONST_U8), 'フィールドの名前')).map(Number)
        );
        const fields = this.unionFields(type);
        const index = this.fieldIndexes(fields).get(fieldName);
        if (index === undefined)
          return this.error(args[1], `${typeName(type)} 型には、フィールド「${fieldName}」がありません。`);
        const value = this.coerce(this.compile(args[2], fields[index].type), fields[index].type, args[2]);
        return this.materializeUnion(type, index, value, expression);
      }
      case '@memcpy':
      case '@memmove': {
        return this.memoryCopy(name, expression);
      }
      case '@memset': {
        return this.memset(expression);
      }
      case '@splat': {
        const target = resultType;
        if (!target || target.kind !== 'array') {
          return this.error(
            expression,
            '@splat には、配列の結果の型が要ります（const a: [4]u8 = @splat(0); のように書きます）。'
          );
        }
        const element = this.coerce(this.compile(args[0], target.child), target.child, args[0]);
        this.storage.reserve(target);
        const { length, sentinel } = target;
        const zero = singleValueOf(target.child, () => this.spendCompilation());
        return this.derived(
          element,
          target,
          (value) => {
            if (zero) return zeroArray(length, sentinel !== undefined, value);
            const count = Number(length);
            spendMemory(count);
            return newArray(
              Array.from({ length: count }, () => copyIntoReservedStorage(value)),
              sentinel
            );
          },
          true
        );
      }
      default: {
        return this.error(expression, `${name} は、この採点環境では使えません。`);
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Validates error-set membership in the phase where the operand is known.
  private errorCast(expression: ExpressionOf<'builtinCall'>, target: Type | undefined): TExpr {
    if (!target || (target.kind !== 'error_set' && target.kind !== 'error_union'))
      return this.error(expression, '@errorCast には、結果の型が要ります。');
    const operand = this.compile(expression.args[0]);
    if (operand.type.kind !== 'error_set' && operand.type.kind !== 'error_union')
      return this.error(expression, '@errorCast には、エラー集合かエラー共用体の値を渡してください。');
    if (operand.type.kind === 'error_union') {
      if (target.kind !== 'error_union') return this.error(expression, 'エラー共用体をエラー集合には変換できません。');
      if (operand.type.payload !== target.payload)
        return this.error(expression, '@errorCast のエラー共用体のペイロードの型は、同じにしてください。');
    }
    const names = target.kind === 'error_set' ? target.names : target.errorSet.names;
    const rejected = (value: Value): value is ErrorValue =>
      value instanceof ErrorValue && names !== undefined && !names.has(value.name);
    if (operand.known) {
      if (rejected(operand.value))
        return this.error(expression, `${typeName(target)} には、error.${operand.value.name} は含まれていません。`);
      return known(target, operand.value, expression);
    }
    return this.derived(operand, target, (value) => {
      if (rejected(value)) panic(`unexpected error code, found error.${value.name}`);
      return value;
    });
  }

  private importBuiltin(expression: ExpressionOf<'builtinCall'>): TExpr {
    const [path] = expression.args;
    if (path.kind !== 'string') return this.error(expression, '@import の引数は、文字列のリテラルにしてください。');
    const name = decodeUtf8(path.bytes);
    if (name === 'std') return known(TYPE, importStd(), expression);
    if (name === 'builtin' || name === 'root')
      return this.error(expression, `@import("${name}") は、この採点環境では使えません。`);
    return this.error(expression, `別のファイルの読み込み（@import("${name}")）は、この採点環境では使えません。`);
  }

  /** `@This()`: the innermost struct, enum, or union being declared. */
  protected thisType(span: Span): Type {
    const namespace = this.enclosingNamespace();
    const type = this.namespaceTypes.get(namespace);
    if (type) return type;
    if (namespace === this.root) return this.rootType();
    return this.error(span, '@This() の型が見つかりません。');
  }

  protected abstract rootType(): Type;

  /** Analyzes an expression only for its type, as `@TypeOf` does, without running it. */
  protected withoutEffects<T>(run: () => T): T {
    return run();
  }

  /** The type that a cast builtin converts to: its result type. */
  private castTarget<K extends keyof CastTargets>(
    expression: ExpressionOf<'builtinCall'>,
    resultType: Type | undefined,
    kind: K
  ): CastTargets[K] {
    let target = resultType;
    while (target?.kind === 'optional' || target?.kind === 'error_union')
      target = target.kind === 'optional' ? target.child : target.payload;
    if (!target) {
      return this.error(
        expression,
        `${expression.name} には結果の型が要ります（@as(T, ${expression.name}(...)) のように書いてください）。`
      );
    }
    const accepted =
      kind === 'int'
        ? target.kind === 'int' || target.kind === 'comptime_int'
        : kind === 'float'
          ? target.kind === 'float' || target.kind === 'comptime_float'
          : target.kind === 'enum';
    if (!accepted) this.error(expression, `${expression.name} の結果の型として ${typeName(target)} 型は使えません。`);
    return target as CastTargets[K];
  }

  private intCastBuiltin(arg: Expression, target: CastTargets['int'], span: Span): TExpr {
    const operand = this.compile(arg);
    if (operand.type.kind !== 'int' && operand.type.kind !== 'comptime_int') {
      return this.error(arg, `@intCast は整数にだけ使えます（${typeName(operand.type)} 型です）。`);
    }
    if (target.kind === 'comptime_int') return this.coerce(this.comptimeOperand(operand), target, span);
    const int = target;
    if (operand.known) {
      if (!fitsInt(operand.value as bigint, int)) {
        this.error(span, `${typeName(int)} 型では、整数 ${operand.value as bigint} を表せません。`);
      }
      return known(int, operand.value, span);
    }
    return this.derived(operand, int, (value) => intCast(value as bigint, int));
  }

  // code-gauge-allow functionNcss -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  // code-gauge-allow functionCognitiveComplexity -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  private divisionBuiltin(name: string, expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr {
    const [leftSyntax, rightSyntax] = expression.args;
    let left = this.compile(leftSyntax, resultType);
    let right = this.compile(rightSyntax, left.type);
    if (left.type.kind.startsWith('comptime') && !right.type.kind.startsWith('comptime'))
      left = this.compile(leftSyntax, right.type);
    const type = this.peerType([left, right], expression);
    left = this.coerce(left, type, leftSyntax);
    right = this.coerce(right, type, rightSyntax);
    if (type.kind === 'float' || type.kind === 'comptime_float') {
      const bits: FloatBits = type.kind === 'float' ? type.bits : 128;
      const operation = (a: Value, b: Value): Value => {
        const x = a as AnyFloat;
        const y = b as AnyFloat;
        switch (name) {
          case '@mod': {
            return floatMod(x, y, bits);
          }
          case '@rem': {
            return floatRem(x, y, bits);
          }
          default: {
            return floatDivision(name, x, y, bits);
          }
        }
      };
      if (name === '@divExact' && left.known && right.known) {
        const quotient = floatOperationFor(left.value as AnyFloat, right.value as AnyFloat, bits);
        if (!isIntegral(quotient)) this.error(expression, '割り切れない数を @divExact で割っています。');
      }
      return this.combine([left, right], type, ([a, b]) => operation(a, b), expression);
    }
    if (type.kind !== 'int' && type.kind !== 'comptime_int') {
      return this.error(expression, `${name} は数の型にだけ使えます（${typeName(type)} 型です）。`);
    }
    const int = type.kind === 'int' ? type : undefined;
    if (right.known && (right.value as bigint) === 0n) this.error(rightSyntax, '0 で割っています。');
    const operation = (a: Value, b: Value, frame?: Frame): Value => {
      const x = a as bigint;
      const y = b as bigint;
      this.integerWork(x, y, 'read', frame);
      switch (name) {
        case '@divTrunc': {
          return divTrunc(x, y, int);
        }
        case '@divFloor': {
          return divFloor(x, y, int);
        }
        case '@divCeil': {
          return divCeil(x, y, int);
        }
        case '@divExact': {
          return divExact(x, y, int);
        }
        case '@mod': {
          return mod(x, y);
        }
        default: {
          return rem(x, y);
        }
      }
    };
    if (left.known && right.known) {
      try {
        return known(type, operation(left.value, right.value), expression);
      } catch (error) {
        if (error instanceof ExecutionLimitError) throw error;
        return this.error(expression, `${name} の計算ができません（0 で割る、割り切れない、あふれるなど）。`);
      }
    }
    return this.combine([left, right], type, ([a, b], frame) => operation(a, b, frame), expression);
  }

  /** `@min` and `@max`, whose integer result type Zig narrows to the range the result can take. */
  private minMax(name: string, expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr {
    const { args } = expression;
    if (args.length < 2) this.error(expression, `${name} には2つ以上の引数が要ります。`);
    let operands = args.map((arg) => this.compile(arg));
    const runtimeType = operands.find((operand) => !operand.type.kind.startsWith('comptime'))?.type;
    // Integers of any types combine by their ranges, so only other operands need a common type.
    const integers = operands.every((operand) => operand.type.kind === 'int' || operand.type.kind === 'comptime_int');
    if (runtimeType && !integers) operands = args.map((arg) => this.compile(arg, runtimeType));
    void resultType;
    const peer = integers && runtimeType ? runtimeType : this.peerType(operands, expression);
    if (
      peer.kind !== 'int' &&
      peer.kind !== 'comptime_int' &&
      peer.kind !== 'float' &&
      peer.kind !== 'comptime_float'
    ) {
      return this.error(expression, `${name} は数の型にだけ使えます（${typeName(peer)} 型です）。`);
    }
    const isMax = name === '@max';
    const pick = (a: Value, b: Value, comptime = false, frame?: Frame): Value => {
      if (typeof a === 'bigint' && typeof b === 'bigint') {
        this.integerWork(a, b, 'read', frame);
        return isMax ? (a > b ? a : b) : a < b ? a : b;
      }
      return minMaxFloat(a as AnyFloat, b as AnyFloat, isMax, comptime);
    };
    let type: Type = peer;
    if (peer.kind === 'int') {
      // The result's range is the min or max of the operands' ranges.
      const ranges = operands.map((operand) => {
        const fact = staticResultOf(operand);
        if (fact) return [fact.value as bigint, fact.value as bigint] as const;
        const int = operand.type as IntType;
        return [minInt(int), maxInt(int)] as const;
      });
      let [low, high] = ranges[0];
      for (const [rangeLow, rangeHigh] of ranges.slice(1)) {
        low = isMax === rangeLow > low ? rangeLow : low;
        high = isMax === rangeHigh > high ? rangeHigh : high;
      }
      type = intFittingRange(low, high, this, expression);
    }
    const coerced =
      peer.kind === 'int'
        ? operands
        : operands.map((operand) => (operand.type === peer ? operand : this.coerce(operand, peer, operand.span)));
    const all = coerced.every((operand) => operand.known);
    const pickAll = (values: Value[], comptime = false, frame?: Frame): Value => {
      let result = values[0];
      for (const value of values.slice(1)) result = pick(result, value, comptime, frame);
      return result;
    };
    if (all)
      return known(
        type,
        pickAll(
          coerced.map((operand) => operand.value),
          true
        ),
        expression
      );
    return this.combine(coerced, type, (values, frame) => pickAll(values, false, frame), expression);
  }

  private absBuiltin(expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr {
    const operand = this.compile(expression.args[0], resultType);
    const type = operand.type;
    if (type.kind === 'int' || type.kind === 'comptime_int') {
      const result = type.kind === 'int' && type.signed ? intType(false, type.bits) : type;
      return this.derived(operand, result, (value, frame) => {
        this.integerWork(value as bigint, 0n, 'read', frame);
        return (value as bigint) < 0n ? -(value as bigint) : value;
      });
    }
    if (type.kind === 'float' || type.kind === 'comptime_float') {
      return this.derived(operand, type, (value) => {
        const x = value as AnyFloat;
        if (typeof x === 'number') return Math.abs(x);
        return new BigFloat(false, x.kind, x.mantissa, x.exponent);
      });
    }
    return this.error(expression, `@abs は数の型にだけ使えます（${typeName(type)} 型です）。`);
  }

  private floatMath(name: string, expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr {
    const operand = this.compile(expression.args[0], resultType);
    const type = operand.type;
    if (type.kind !== 'float' && type.kind !== 'comptime_float') {
      return this.error(expression, `${name} は浮動小数点数にだけ使えます（${typeName(type)} 型です）。`);
    }
    const bits: FloatBits = type.kind === 'float' ? type.bits : 128;
    const apply = (value: Value): Value => {
      const x = value as AnyFloat;
      if (name === '@sqrt') return floatSqrt(x, bits);
      if (name === '@floor' || name === '@ceil' || name === '@round' || name === '@trunc')
        return roundFloat(name, x, bits);
      return referenceUnary(MATH_OPERATIONS[name], bits, x);
    };
    return this.derived(operand, type, apply);
  }

  /** `@mulAdd(T, a, b, c)`: `a * b + c` rounded once, which Zig applies to each element of a vector type. */
  private mulAdd(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { args } = expression;
    const type = this.compileType(args[0]);
    const scalar = isVectorType(type) ? type.child : type;
    if (scalar.kind !== 'float' && scalar.kind !== 'comptime_float')
      this.error(args[0], '@mulAdd は浮動小数点数の型にだけ使えます。');
    const [a, b, c] = args.slice(1).map((arg) => this.coerce(this.compile(arg, type), type, arg));
    const bits = scalar.kind === 'float' ? scalar.bits : 128;
    return this.combine(
      [a, b, c],
      type,
      ([x, y, z], frame) => {
        const fused = (p: Value, q: Value, r: Value): Value =>
          fusedMultiplyAdd(
            asBigFloat(p as AnyFloat),
            asBigFloat(q as AnyFloat),
            asBigFloat(r as AnyFloat),
            bits,
            (cost) => (frame ? frame.runtime.spend(cost) : this.spendCompilation(cost))
          );
        if (!isVectorType(type)) return fused(x, y, z);
        const [ys, zs] = [y, z].map((operand) => (operand as ZArray).values());
        return newArray(
          (x as ZArray).values().map((element, index) => fused(element, ys[index], zs[index])),
          undefined
        );
      },
      expression
    );
  }

  // code-gauge-allow functionCognitiveComplexity -- Keeps checked overflow arithmetic and phase-specific work accounting together.
  // code-gauge-allow functionNcss -- Keeps the scalar and vector forms of the overflow builtins together.
  /** `@addWithOverflow` and the like, which Zig applies to each element of a vector, with a vector of overflow bits. */
  private overflowBuiltin(name: string, expression: ExpressionOf<'builtinCall'>): TExpr {
    const [leftSyntax, rightSyntax] = expression.args;
    let left = this.compile(leftSyntax);
    let right = this.compile(rightSyntax, left.type);
    if (left.type.kind === 'comptime_int' && right.type.kind === 'int') left = this.compile(leftSyntax, right.type);
    const type = name === '@shlWithOverflow' ? left.type : this.peerType([left, right], expression);
    const vector = isVectorType(type) ? type : undefined;
    const scalar = vector ? vector.child : type;
    if (scalar.kind !== 'int')
      return this.error(expression, `${name} は整数の型にだけ使えます（${typeName(type)} 型です）。`);
    const amountType = log2IntType(scalar);
    left = this.coerce(left, type, leftSyntax);
    right = this.coerce(
      right,
      name !== '@shlWithOverflow' ? type : vector ? vectorOf(vector.length, amountType) : amountType,
      rightSyntax
    );
    const bit = intType(false, 1);
    const tuple = this.tupleType([
      { name: '0', type, hasDefault: false },
      { name: '1', type: vector ? vectorOf(vector.length, bit) : bit, hasDefault: false },
    ]);
    const work = integerOperationWork(name);
    const compute = (x: bigint, y: bigint, frame?: Frame): [bigint, bigint] => {
      if (name === '@shlWithOverflow') {
        checkShiftAmount(y, scalar);
        spendIntegerShift(x, y, true, (cost) => (frame ? frame.runtime.spend(cost) : this.spendCompilation(cost)));
      } else this.integerWork(x, y, work, frame);
      return wrappedWithOverflowBit(name, x, y, scalar);
    };
    const amounts = staticResultOf(right)?.value;
    if (name === '@shlWithOverflow' && amounts !== undefined)
      for (const amount of vector ? ((amounts as ZArray).values() as bigint[]) : [amounts as bigint])
        this.checkKnownShift(known(amountType, amount, rightSyntax), scalar, rightSyntax);
    return this.combine(
      [left, right],
      tuple,
      ([a, b], frame) => {
        if (!vector) return new ZStruct(compute(a as bigint, b as bigint, frame));
        const ys = (b as ZArray).values() as bigint[];
        const results = ((a as ZArray).values() as bigint[]).map((x, index) => compute(x, ys[index], frame));
        return new ZStruct(
          [0, 1].map((part) =>
            newArray(
              results.map((result) => result[part]),
              undefined
            )
          )
        );
      },
      expression
    );
  }

  private exactShift(name: string, expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr {
    const left = this.compile(expression.args[0], resultType);
    const type = left.type;
    if (type.kind !== 'int')
      return this.error(expression, `${name} は整数の型にだけ使えます（${typeName(type)} 型です）。`);
    const amountType = log2IntType(type);
    const right = this.coerce(this.compile(expression.args[1], amountType), amountType, expression.args[1]);
    this.checkKnownShift(right, type, expression.args[1]);
    return this.combine(
      [left, right],
      type,
      ([a, b], frame) => {
        const x = a as bigint;
        const y = b as bigint;
        const spend = (cost: number): void => (frame ? frame.runtime.spend(cost) : this.spendCompilation(cost));
        checkShiftAmount(y, type);
        if (name === '@shlExact') {
          spendIntegerShift(x, y, true, spend);
          const shifted = x << y;
          this.integerWork(shifted, 0n, 'read', frame);
          if (wrapInt(shifted, type) !== shifted) panic(PANIC.leftShiftOverflow);
          return shifted;
        }
        spendIntegerShift(x, y, false, spend);
        const shifted = x >> y;
        spendIntegerShift(shifted, y, true, spend);
        const restored = shifted << y;
        this.integerWork(restored, x, 'read', frame);
        if (restored !== x) panic(PANIC.rightShiftOverflow);
        return shifted;
      },
      expression
    );
  }

  // code-gauge-allow functionNcss -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  // code-gauge-allow functionCognitiveComplexity -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  private bitBuiltin(name: string, expression: ExpressionOf<'builtinCall'>): TExpr {
    const operand = this.compile(expression.args[0]);
    const type = operand.type;
    if (type.kind !== 'int')
      return this.error(expression, `${name} は整数の型にだけ使えます（${typeName(type)} 型です）。`);
    const { bits } = type;
    const unsigned = (value: bigint): bigint => BigInt.asUintN(bits, value);
    const countType = log2IntType(intType(false, bits + 1));
    const derive = (resultType: Type, convert: (value: Value) => Value): TExpr =>
      this.derived(operand, resultType, (value, frame) => {
        if (frame) frame.runtime.spend(bits);
        else this.spendCompilation(bits);
        return convert(value);
      });
    switch (name) {
      case '@clz': {
        return derive(countType, (value) => {
          const text = unsigned(value as bigint).toString(2);
          return BigInt(value === 0n ? bits : bits - text.length);
        });
      }
      case '@ctz': {
        return derive(countType, (value) => {
          const x = unsigned(value as bigint);
          if (x === 0n) return BigInt(bits);
          const text = x.toString(2);
          return BigInt(text.length - text.lastIndexOf('1') - 1);
        });
      }
      case '@popCount': {
        return derive(countType, (value) =>
          BigInt([...unsigned(value as bigint).toString(2)].filter((digit) => digit === '1').length)
        );
      }
      case '@byteSwap': {
        if (bits % 8 !== 0) this.error(expression, '@byteSwap は、8 の倍数のビット数の整数にだけ使えます。');
        return derive(type, (value) => {
          let x = unsigned(value as bigint);
          let result = 0n;
          for (let index = 0; index < bits / 8; index++) {
            result = (result << 8n) | (x & 0xffn);
            x >>= 8n;
          }
          return wrapInt(result, type);
        });
      }
      default: {
        return derive(type, (value) => {
          const text = unsigned(value as bigint)
            .toString(2)
            .padStart(bits, '0');
          return wrapInt(BigInt(`0b${[...text].toReversed().join('') || '0'}`), type);
        });
      }
    }
  }

  private tagName(expression: ExpressionOf<'builtinCall'>): TExpr {
    const operand = this.compile(expression.args[0]);
    const type = operand.type;
    if (type.kind === 'enum_literal') {
      return this.derived(operand, NAME_SLICE, (value, frame) =>
        this.nameSlice((value as { name: string }).name, frame)
      );
    }
    if (type.kind === 'union' && type.tagType) {
      const fields = this.unionFields(type);
      return this.derived(operand, NAME_SLICE, (value, frame) =>
        this.nameSlice(fields[activeUnionIndex(value as ZUnion)].name, frame)
      );
    }
    if (type.kind !== 'enum')
      return this.error(expression, `@tagName は enum の値にだけ使えます（${typeName(type)} 型です）。`);
    const fields = enumLookup(this.enumFields(type), () => this.spendCompilation()).byValue;
    if (operand.known) {
      const field = fields.get(operand.value as bigint);
      if (!field)
        this.error(expression, `enum ${typeName(type)} には、値 ${operand.value as bigint} のフィールドがありません。`);
    }
    return this.derived(operand, NAME_SLICE, (value, frame) => {
      const field = fields.get(value as bigint);
      if (!field) panic(PANIC.invalidEnum);
      return this.nameSlice(field.name, frame);
    });
  }

  nameSlice(text: string, frame?: Frame): Slice {
    const cached = this.nameSlices.get(text);
    if (cached) return cached;
    const spend = (cost: number): void => (frame ? frame.runtime.spend(cost) : this.spendCompilation(cost));
    spend(text.length);
    const length = identifierTextByteLength(text);
    const slots = 2 * (length + 1);
    if (frame) frame.runtime.reserveStorage(slots);
    else this.storage.reserve(arrayOf(BigInt(slots), U8));
    spend(slots);
    const bytes = encodeIdentifierText(text).map(BigInt);
    bytes.push(0n);
    const array = new ZArray(bytes, 0, length, true);
    markConstantStorage(array, arrayOf(length, U8, 0n));
    const slice = new Slice(array, 0, length);
    this.nameSlices.set(text, slice);
    return slice;
  }

  // code-gauge-allow functionNcss -- Keeps bounds, alias checks and reference transfer in copy evaluation order.
  // code-gauge-allow functionCognitiveComplexity -- Keeps bounds, alias checks and reference transfer in copy evaluation order.
  private memoryCopy(name: string, expression: ExpressionOf<'builtinCall'>): TExpr {
    const destination = this.compile(expression.args[0]);
    const source = this.compile(expression.args[1]);
    this.checkMemoryOperand(destination, expression);
    this.checkMemoryOperand(source, expression);
    const target = elementAccessor(destination.type);
    const from = elementAccessor(source.type);
    if (!target || target.isConst)
      return this.error(expression.args[0], `${name} の書き込み先には、変更できる配列やスライスを指定してください。`);
    if (!from) return this.error(expression.args[1], `${name} の読み込み元には、配列やスライスを指定してください。`);
    if (!inMemoryCoercible(from.child, target.child)) this.error(expression, `${name} の要素の型が一致しません。`);
    this.resolveStorage(target.child, expression);
    const cost = transferCost(target.child);
    const destinationLength = knownLengthOf(destination);
    const sourceLength = knownLengthOf(source);
    if (destinationLength !== undefined && sourceLength !== undefined && destinationLength !== sourceLength)
      this.error(expression, `コピー先の長さ ${destinationLength} と、コピー元の長さ ${sourceLength} が一致しません。`);
    const evaluators = valueEvaluators([destination, source], false);
    return runtime(
      VOID,
      (frame) => {
        const valuesOf = evaluateHeld(frame, evaluators);
        const out = target.view(valuesOf[0]);
        const input = from.view(valuesOf[1]);
        if (out.length !== input.length) panic(PANIC.memcpyLengths);
        if (out.length === 0n || sizeOf(target.child) === 0) return;
        if (
          name === '@memcpy' &&
          storageOverlaps(out.slots, out.start, input.slots, input.start, Number(out.length), sizeOf(target.child))
        )
          panic(PANIC.memcpyAlias);
        if (isUndefinedMemory(valuesOf[0]) || isUndefinedMemory(valuesOf[1])) throw new MemoryFault();
        frame.runtime.spend(Number(input.length) * cost);
        const values = input.slots.slots.slice(input.start, input.start + Number(input.length)).map(copyForStorage);
        for (const [index, value] of values.entries()) {
          frame.runtime.spend(cost * 2);
          storeInto(out.slots, out.start + index, value);
        }
        return;
      },
      expression
    );
  }

  private memset(expression: ExpressionOf<'builtinCall'>): TExpr {
    const destination = this.compile(expression.args[0]);
    const target = elementAccessor(destination.type);
    if (!target || target.isConst)
      return this.error(expression.args[0], '@memset の書き込み先には、変更できる配列やスライスを指定してください。');
    if (sizeOf(target.child) !== 0) this.checkMemoryOperand(destination, expression);
    const value = this.coerce(this.compile(expression.args[1], target.child), target.child, expression.args[1]);
    this.resolveStorage(target.child, expression);
    const cost = transferCost(target.child);
    const evaluators = valueEvaluators([destination, value], false);
    return runtime(
      VOID,
      (frame) => {
        const [destination, value] = evaluateHeld(frame, evaluators);
        const out = target.view(destination);
        if (sizeOf(target.child) === 0) return;
        frame.runtime.spend(cost);
        const filler = copyForStorage(value);
        for (let index = 0; index < Number(out.length); index++) {
          frame.runtime.spend(cost * 2);
          storeInto(out.slots, out.start + index, filler);
        }
        return;
      },
      expression
    );
  }
}

export const CONST_U8: Type = sliceOf(U8, true);

const NAME_SLICE = sliceOf(U8, true, 0n);

export function bytesToText(slice: Slice): string {
  const bytes = slice.readBytes(spendMemory);
  spendMemory(bytes.length);
  return decodeUtf8(bytes);
}

export function byteValues(value: Value, spend?: (cost: number) => void): bigint[] {
  if (value instanceof Slice) return value.values(spend) as bigint[];
  if (value instanceof Pointer) return (value.load() as ZArray).values(false, spend) as bigint[];
  if (value instanceof ZArray) return value.values(false, spend) as bigint[];
  return [];
}

function elementAccessor(type: Type):
  | {
      child: Type;
      isConst: boolean;
      view: (value: Value) => { slots: { slots: Value[] }; start: number; length: bigint };
    }
  | undefined {
  if (type.kind === 'pointer' && type.size === 'slice') {
    return {
      child: type.child,
      isConst: type.isConst,
      view: (value) => {
        const slice = value as Slice;
        return { slots: slice.target, start: slice.start, length: slice.lengthValue };
      },
    };
  }
  if (type.kind === 'pointer' && type.size === 'one' && type.child.kind === 'array') {
    const arrayType = type.child;
    return {
      child: type.child.child,
      isConst: type.isConst,
      view: (value) => {
        const array = arrayPointerView(value as Pointer, arrayType, sizeOf(arrayType.child));
        return { slots: array, start: array.offset, length: array.lengthValue };
      },
    };
  }
  return undefined;
}

// code-gauge-allow functionCognitiveComplexity -- Handles native and exact rounding with the same four rounding modes.
export function roundFloat(name: string, value: AnyFloat, bits: FloatBits): AnyFloat {
  if (typeof value === 'number') {
    switch (name) {
      case '@floor': {
        return Math.floor(value);
      }
      case '@ceil': {
        return Math.ceil(value);
      }
      case '@trunc': {
        return Math.trunc(value);
      }
      default: {
        // Rounds half away from zero, unlike Math.round.
        const rounded = Math.sign(value) * Math.round(Math.abs(value));
        return Object.is(rounded, -0) || (rounded === 0 && signBit(value)) ? -0 : rounded;
      }
    }
  }
  if (value.kind !== 'finite' || value.exponent >= 0) return roundTo(value, bits);
  const denominator = 1n << BigInt(-value.exponent);
  let integer = value.mantissa / denominator;
  const remainder = value.mantissa % denominator;
  const increment =
    remainder !== 0n &&
    (name === '@floor'
      ? value.sign
      : name === '@ceil'
        ? !value.sign
        : name !== '@trunc' && remainder * 2n >= denominator);
  if (increment) integer++;
  return roundTo(new BigFloat(value.sign, 'finite', integer, 0), bits);
}

function floatDivision(name: string, x: AnyFloat, y: AnyFloat, bits: FloatBits): AnyFloat {
  const quotient = floatOperationFor(x, y, bits);
  if (name === '@divTrunc') return roundFloat('@trunc', quotient, bits);
  if (name === '@divFloor') return roundFloat('@floor', quotient, bits);
  if (name === '@divCeil') return roundFloat('@ceil', quotient, bits);
  // Zig lowers a float `@divExact` to a division whose result it truncates.
  return roundFloat('@trunc', quotient, bits);
}

function floatOperationFor(x: AnyFloat, y: AnyFloat, bits: FloatBits): AnyFloat {
  if (bits <= 64) return roundNumber((x as number) / (y as number), bits as 16 | 32 | 64);
  return floatArithmetic(x, y, '/', bits);
}

function convertFloat(value: AnyFloat, bits: FloatBits): AnyFloat {
  if (bits <= 64 && typeof value === 'number') return roundNumber(value, bits as 16 | 32 | 64);
  return floatOf(asBigFloat(value), bits);
}

export function fusedMultiplyAdd(
  a: BigFloat,
  b: BigFloat,
  c: BigFloat,
  bits: FloatBits,
  spend: (cost: number) => void
): AnyFloat {
  if (a.kind !== 'finite' || b.kind !== 'finite')
    return floatOf(asBigFloat(floatArithmetic(floatArithmetic(a, b, '*', 128), c, '+', 128)), bits);
  if (c.kind !== 'finite') return floatOf(c, bits);
  spend(Math.ceil((a.mantissa.toString(2).length + b.mantissa.toString(2).length) / 64));
  const product = new BigFloat(a.sign !== b.sign, 'finite', a.mantissa * b.mantissa, a.exponent + b.exponent);
  return floatOf(addExact(product, c, spend), bits);
}

function addExact(a: BigFloat, b: BigFloat, spend: (cost: number) => void): BigFloat {
  if (a.isZero && b.isZero) return BigFloat.zero(a.sign && b.sign);
  if (a.isZero) return b;
  if (b.isZero) return a;
  const exponent = Math.min(a.exponent, b.exponent);
  const width =
    Math.max(
      a.mantissa.toString(2).length + a.exponent - exponent,
      b.mantissa.toString(2).length + b.exponent - exponent
    ) + 1;
  spend(Math.ceil(width / 64));
  const x = (a.sign ? -a.mantissa : a.mantissa) << BigInt(a.exponent - exponent);
  const y = (b.sign ? -b.mantissa : b.mantissa) << BigInt(b.exponent - exponent);
  const sum = x + y;
  return new BigFloat(sum < 0n || (sum === 0n && a.sign && b.sign), 'finite', sum < 0n ? -sum : sum, exponent);
}

/** The smallest integer type that holds every value from `low` to `high`, as `std.math.IntFittingRange` gives. */
export function intFittingRange(low: bigint, high: bigint, sema: SemaApi, span: Span): IntType {
  if (low > high) return sema.error(span, '整数の範囲の始まりは終わり以下にしてください。');
  const signed = low < 0n;
  const magnitude = signed && -low - 1n > high ? -low - 1n : high;
  const digits = magnitude.toString(2);
  const bits = (signed ? 1 : 0) + (magnitude === 0n ? 0 : digits.length);
  if (bits > 65_535) return sema.error(span, '整数の型のビット数は 65535 以下にしてください。');
  sema.spendCompilation(digits.length);
  return intType(signed, bits);
}

export { COMPTIME_INT, USIZE };

/** The wrapped result of an overflow builtin on integers of the type, with 1 when it overflowed. */
function wrappedWithOverflowBit(name: string, x: bigint, y: bigint, type: IntType): [bigint, bigint] {
  const exact =
    name === '@addWithOverflow'
      ? x + y
      : name === '@subWithOverflow'
        ? x - y
        : name === '@mulWithOverflow'
          ? x * y
          : x << y;
  const wrapped = wrapInt(exact, type);
  return [wrapped, wrapped === exact ? 0n : 1n];
}
