// code-gauge-allow-file fileNcss 594 -- The file holds one layer of the compiler, whose parts share its private state.
import {
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
import { ExpressionCompiler, log2IntType } from './expressions';
import {
  type AnyFloat,
  asBigFloat,
  BigFloat,
  compareFloats,
  type FloatBits,
  floatFromBigInt,
  floatOf,
  floatSqrt,
  isNaNFloat,
  roundNumber,
  roundTo,
  signBit,
  toNumber,
} from './floats';
import { importStd } from './library/std';
import { ZigPanic } from './runtime';
import { copyForStorage, known, newArray, runtime, type TExpr } from './semaBase';
import {
  BOOL,
  COMPTIME_FLOAT,
  COMPTIME_INT,
  type EnumType,
  fitsInt,
  type FloatType,
  type IntType,
  intType,
  maxInt,
  minInt,
  sliceOf,
  TYPE,
  type Type,
  typeName,
  U8,
  USIZE,
  VOID,
  wrapInt,
} from './types';
import { ErrorValue, Pointer, Slice, type Value, ZArray, ZStruct, ZUnion } from './values';

/** Builtins of stages C and D, which this grader rejects with the stage's message. */
const UNAVAILABLE = new Map<string, string>([
  ['@cImport', 'C との連携（@cImport）'],
  ['@cInclude', 'C との連携（@cInclude）'],
  ['@cDefine', 'C との連携（@cDefine）'],
  ['@cUndef', 'C との連携（@cUndef）'],
  ['@embedFile', '@embedFile（ファイルの読み込み）'],
  ['@extern', '@extern'],
  ['@export', '@export'],
  ['@ptrCast', '@ptrCast（メモリの表現に依存する変換）'],
  ['@intFromPtr', '@intFromPtr（メモリの表現に依存する変換）'],
  ['@ptrFromInt', '@ptrFromInt（メモリの表現に依存する変換）'],
  ['@fieldParentPtr', '@fieldParentPtr（メモリの表現に依存する変換）'],
  ['@alignCast', '@alignCast'],
  ['@addrSpaceCast', '@addrSpaceCast'],
  ['@atomicLoad', 'アトミック操作（@atomicLoad）'],
  ['@atomicStore', 'アトミック操作（@atomicStore）'],
  ['@atomicRmw', 'アトミック操作（@atomicRmw）'],
  ['@cmpxchgStrong', 'アトミック操作（@cmpxchgStrong）'],
  ['@cmpxchgWeak', 'アトミック操作（@cmpxchgWeak）'],
  ['@frameAddress', '@frameAddress'],
  ['@returnAddress', '@returnAddress'],
  ['@breakpoint', '@breakpoint'],
  ['@trap', '@trap'],
  ['@wasmMemorySize', 'WebAssembly の組み込み関数'],
  ['@wasmMemoryGrow', 'WebAssembly の組み込み関数'],
  ['@workGroupId', 'GPU の組み込み関数'],
  ['@workGroupSize', 'GPU の組み込み関数'],
  ['@workItemId', 'GPU の組み込み関数'],
  ['@SpirvType', 'GPU の組み込み関数'],
  ['@cVaArg', '可変個の引数'],
  ['@cVaCopy', '可変個の引数'],
  ['@cVaEnd', '可変個の引数'],
  ['@cVaStart', '可変個の引数'],
  ['@prefetch', '@prefetch'],
  ['@setFloatMode', '@setFloatMode'],
  ['@setRuntimeSafety', '@setRuntimeSafety'],
  ['@setEvalBranchQuota', '@setEvalBranchQuota（comptime）'],
  ['@compileError', '@compileError（comptime）'],
  ['@compileLog', '@compileLog（comptime）'],
  ['@inComptime', '@inComptime（comptime）'],
  ['@typeInfo', '@typeInfo（リフレクション）'],
  ['@typeName', '@typeName（リフレクション）'],
  ['@Type', '@Type（リフレクション）'],
  ['@field', '@field（リフレクション）'],
  ['@hasDecl', '@hasDecl（リフレクション）'],
  ['@hasField', '@hasField（リフレクション）'],
  ['@FieldType', '@FieldType（リフレクション）'],
  ['@src', '@src（リフレクション）'],
  ['@call', '@call'],
  ['@bitCast', '@bitCast（メモリの表現に依存する変換）'],
  ['@sizeOf', '@sizeOf（メモリの表現）'],
  ['@bitSizeOf', '@bitSizeOf（メモリの表現）'],
  ['@alignOf', '@alignOf（メモリの表現）'],
  ['@offsetOf', '@offsetOf（メモリの表現）'],
  ['@bitOffsetOf', '@bitOffsetOf（メモリの表現）'],
  ['@Vector', 'ベクトル（@Vector）'],
  ['@reduce', 'ベクトル（@reduce）'],
  ['@shuffle', 'ベクトル（@shuffle）'],
  ['@select', 'ベクトル（@select）'],
  ['@constCast', '@constCast'],
  ['@volatileCast', '@volatileCast'],
  ['@intFromError', '@intFromError（エラーの番号）'],
  ['@errorFromInt', '@errorFromInt（エラーの番号）'],
  ['@errorReturnTrace', '@errorReturnTrace'],
  ['@branchHint', '@branchHint'],
  ['@Int', '@Int（型の操作）'],
  ['@Tuple', '@Tuple（型の操作）'],
  ['@Pointer', '@Pointer（型の操作）'],
  ['@Fn', '@Fn（型の操作）'],
  ['@Struct', '@Struct（型の操作）'],
  ['@Union', '@Union（型の操作）'],
  ['@Enum', '@Enum（型の操作）'],
  ['@EnumLiteral', '@EnumLiteral（型の操作）'],
  ['@backingInt', '@backingInt'],
  ['@fromBackingInt', '@fromBackingInt'],
]);

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

export abstract class BuiltinCompiler extends ExpressionCompiler {
  protected compileBuiltin(expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr {
    const { name, args } = expression;
    const unavailable = UNAVAILABLE.get(name);
    if (unavailable) return this.error(expression, `${unavailable}は、この採点環境では使えません。`);
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
        return runtime({ kind: 'noreturn' }, (frame) => panic(bytesToText(evaluate(frame))), expression);
      }
      case '@intCast': {
        return this.intCastBuiltin(args[0], this.castTarget(expression, resultType, 'int'), expression);
      }
      case '@truncate': {
        const target = this.castTarget(expression, resultType, 'int') as IntType;
        const operand = this.compile(args[0]);
        if (operand.type.kind !== 'int' && operand.type.kind !== 'comptime_int') {
          this.error(args[0], `@truncate は整数にだけ使えます（${typeName(operand.type)} 型です）。`);
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
        const target = this.castTarget(expression, resultType, 'float') as FloatType;
        const operand = this.compile(args[0]);
        if (operand.type.kind !== 'float' && operand.type.kind !== 'comptime_float') {
          this.error(args[0], `@floatCast は浮動小数点数にだけ使えます（${typeName(operand.type)} 型です）。`);
        }
        return this.derived(operand, target, (value) => convertFloat(value as AnyFloat, target.bits));
      }
      case '@floatFromInt': {
        const target = this.castTarget(expression, resultType, 'float');
        const operand = this.compile(args[0]);
        if (operand.type.kind !== 'int' && operand.type.kind !== 'comptime_int') {
          this.error(args[0], `@floatFromInt は整数にだけ使えます（${typeName(operand.type)} 型です）。`);
        }
        const bits: FloatBits = target.kind === 'float' ? target.bits : 128;
        return this.derived(operand, target, (value) => {
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
        if (operand.known && target.kind === 'int') {
          const value = operand.value as AnyFloat;
          try {
            return known(target, intFromFloat(value, target), expression);
          } catch {
            return this.error(expression, `浮動小数点数の整数部分が ${typeName(target)} 型に入りません。`);
          }
        }
        return this.derived(operand, target, (value) => intFromFloat(value as AnyFloat, target as IntType));
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
        const type = this.compileType(args[0]);
        if (type.kind !== 'float') this.error(args[0], '@mulAdd は浮動小数点数の型にだけ使えます。');
        const [a, b, c] = args.slice(1).map((arg) => this.coerce(this.compile(arg, type), type, arg));
        const bits = (type as FloatType).bits;
        const compute = (x: Value, y: Value, z: Value): Value => {
          const product = asBigFloat(x as AnyFloat);
          const exact = new BigFloat(false, 'finite', 0n, 0);
          void exact;
          return fusedMultiplyAdd(product, asBigFloat(y as AnyFloat), asBigFloat(z as AnyFloat), bits);
        };
        return this.combine([a, b, c], type, (values) => compute(values[0], values[1], values[2]), expression);
      }
      case '@intFromEnum': {
        const operand = this.compile(args[0]);
        const type = operand.type;
        if (type.kind === 'union' && type.tagType) {
          const tagType = type.tagType;
          this.enumFields(tagType);
          return this.derived(operand, tagType.tagType as IntType, (value) => {
            const field = (tagType.fields ?? [])[(value as ZUnion).tag];
            return field.value;
          });
        }
        if (type.kind !== 'enum')
          return this.error(args[0], `@intFromEnum は enum の値にだけ使えます（${typeName(type)} 型です）。`);
        this.enumFields(type);
        return { ...operand, type: type.tagType as IntType, place: undefined };
      }
      case '@enumFromInt': {
        const target = this.castTarget(expression, resultType, 'enum') as EnumType;
        const fields = this.enumFields(target);
        const tagType = target.tagType as IntType;
        const operand = this.compile(args[0], tagType);
        if (operand.known) {
          const value = operand.value as bigint;
          if (target.exhaustive && !fields.some((field) => field.value === value)) {
            this.error(expression, `enum ${typeName(target)} には、値 ${value} のフィールドがありません。`);
          }
          return known(target, value, expression);
        }
        const coerced = operand.type.kind === 'int' ? operand : this.coerce(operand, tagType, args[0]);
        const exhaustive = target.exhaustive;
        return this.derived(coerced, target, (value) => {
          if (!fitsInt(value as bigint, tagType)) panic(PANIC.invalidEnum);
          if (exhaustive && !fields.some((field) => field.value === value)) panic(PANIC.invalidEnum);
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
        return this.derived(operand, CONST_U8, (value) => bytesSlice((value as ErrorValue).name));
      }
      case '@errorCast': {
        const target = resultType;
        if (!target || (target.kind !== 'error_set' && target.kind !== 'error_union')) {
          return this.error(expression, '@errorCast には、結果の型が要ります。');
        }
        const operand = this.compile(args[0]);
        const names = target.kind === 'error_set' ? target.names : target.errorSet.names;
        return {
          ...operand,
          type: target,
          eval: (frame) => {
            const value = operand.eval(frame);
            if (value instanceof ErrorValue && names && !names.has(value.name)) panic(PANIC.invalidErrorCode);
            return value;
          },
          known: false,
          place: undefined,
        };
      }
      case '@unionInit': {
        const type = this.compileType(args[0]);
        if (type.kind !== 'union') return this.error(args[0], '@unionInit の最初の引数は union の型にしてください。');
        const fieldName = bytesToText(this.knownValue(this.compile(args[1], CONST_U8), 'フィールドの名前'));
        const fields = this.unionFields(type);
        const index = fields.findIndex((field) => field.name === fieldName);
        if (index === -1)
          return this.error(args[1], `${typeName(type)} 型には、フィールド「${fieldName}」がありません。`);
        const value = this.coerce(this.compile(args[2], fields[index].type), fields[index].type, args[2]);
        return this.derived(value, type, (payload) => new ZUnion(index, payload));
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
        const { length, sentinel } = target;
        return this.derived(element, target, (value) =>
          newArray(
            Array.from({ length }, () => copyForStorage(value)),
            sentinel
          )
        );
      }
      default: {
        return this.error(expression, `${name} は、この採点環境では使えません。`);
      }
    }
  }

  private importBuiltin(expression: ExpressionOf<'builtinCall'>): TExpr {
    const [path] = expression.args;
    if (path.kind !== 'string') return this.error(expression, '@import の引数は、文字列のリテラルにしてください。');
    const name = String.fromCodePoint(...path.bytes);
    if (name === 'std') return known(TYPE, importStd(), expression);
    if (name === 'builtin' || name === 'root')
      return this.error(expression, `@import("${name}") は、この採点環境では使えません。`);
    return this.error(expression, `別のファイルの読み込み（@import("${name}")）は、この採点環境では使えません。`);
  }

  /** `@This()`: the innermost struct, enum, or union being declared. */
  protected thisType(span: Span): Type {
    const namespace = this.enclosingNamespace();
    for (const type of this.containerTypes.values()) {
      if ((type as { namespace?: unknown }).namespace === namespace) return type;
    }
    if (namespace === this.root) return this.rootType();
    return this.error(span, '@This() の型が見つかりません。');
  }

  protected abstract rootType(): Type;

  /** Analyzes an expression only for its type, as `@TypeOf` does, without running it. */
  protected withoutEffects<T>(run: () => T): T {
    return run();
  }

  /** The type that a cast builtin converts to: its result type. */
  private castTarget(
    expression: ExpressionOf<'builtinCall'>,
    resultType: Type | undefined,
    kind: 'int' | 'float' | 'enum'
  ): Type {
    const target = resultType?.kind === 'optional' ? resultType.child : resultType;
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
    return target;
  }

  private intCastBuiltin(arg: Expression, target: Type, span: Span): TExpr {
    const operand = this.compile(arg);
    if (operand.type.kind !== 'int' && operand.type.kind !== 'comptime_int') {
      return this.error(arg, `@intCast は整数にだけ使えます（${typeName(operand.type)} 型です）。`);
    }
    if (target.kind === 'comptime_int') return this.coerce(operand, target, span);
    const int = target as IntType;
    if (operand.known) {
      if (!fitsInt(operand.value as bigint, int)) {
        this.error(span, `${typeName(int)} 型では、整数 ${operand.value as bigint} を表せません。`);
      }
      return known(int, operand.value, span);
    }
    return this.derived(operand, int, (value) => intCast(value as bigint, int));
  }

  // code-gauge-allow functionNcss 54 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  // code-gauge-allow functionCognitiveComplexity 29 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
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
      return this.combine([left, right], type, ([a, b]) => operation(a, b), expression);
    }
    if (type.kind !== 'int' && type.kind !== 'comptime_int') {
      return this.error(expression, `${name} は数の型にだけ使えます（${typeName(type)} 型です）。`);
    }
    const int = type.kind === 'int' ? type : undefined;
    if ((name === '@mod' || name === '@rem') && right.known && (right.value as bigint) <= 0n) {
      this.error(rightSyntax, `${name} の割る数は、正の数にしてください。`);
    }
    if (right.known && (right.value as bigint) === 0n) this.error(rightSyntax, '0 で割っています。');
    const operation = (a: Value, b: Value): Value => {
      const x = a as bigint;
      const y = b as bigint;
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
          if (y < 0n) panic('remainder division by zero or negative value');
          return mod(x, y);
        }
        default: {
          if (y < 0n) panic('remainder division by zero or negative value');
          return rem(x, y);
        }
      }
    };
    if (left.known && right.known) {
      try {
        return known(type, operation(left.value, right.value), expression);
      } catch {
        return this.error(expression, `${name} の計算ができません（0 で割る、割り切れない、あふれるなど）。`);
      }
    }
    return this.combine([left, right], type, ([a, b]) => operation(a, b), expression);
  }

  /** `@min` and `@max`, whose integer result type Zig narrows to the range the result can take. */
  private minMax(name: string, expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr {
    const { args } = expression;
    if (args.length < 2) this.error(expression, `${name} には2つ以上の引数が要ります。`);
    let operands = args.map((arg) => this.compile(arg));
    const runtimeType = operands.find((operand) => !operand.type.kind.startsWith('comptime'))?.type;
    if (runtimeType) operands = args.map((arg) => this.compile(arg, runtimeType));
    void resultType;
    const peer = this.peerType(operands, expression);
    if (
      peer.kind !== 'int' &&
      peer.kind !== 'comptime_int' &&
      peer.kind !== 'float' &&
      peer.kind !== 'comptime_float'
    ) {
      return this.error(expression, `${name} は数の型にだけ使えます（${typeName(peer)} 型です）。`);
    }
    const isMax = name === '@max';
    const pick = (a: Value, b: Value): Value => {
      if (typeof a === 'bigint' && typeof b === 'bigint') return isMax ? (a > b ? a : b) : a < b ? a : b;
      const x = a as AnyFloat;
      const y = b as AnyFloat;
      if (isNaNFloat(x)) return y;
      if (isNaNFloat(y)) return x;
      const order = compareFloats(x, y) ?? 0;
      return isMax ? (order >= 0 ? x : y) : order <= 0 ? x : y;
    };
    let type: Type = peer;
    if (peer.kind === 'int') {
      // The result's range is the min or max of the operands' ranges.
      const ranges = operands.map((operand) => {
        if (operand.known) return [operand.value as bigint, operand.value as bigint] as const;
        const int = operand.type as IntType;
        return [minInt(int), maxInt(int)] as const;
      });
      let [low, high] = ranges[0];
      for (const [rangeLow, rangeHigh] of ranges.slice(1)) {
        low = isMax === rangeLow > low ? rangeLow : low;
        high = isMax === rangeHigh > high ? rangeHigh : high;
      }
      type = intFittingRange(low, high);
    }
    const coerced = operands.map((operand) =>
      operand.type === peer ? operand : this.coerce(operand, peer, operand.span)
    );
    const all = coerced.every((operand) => operand.known);
    const pickAll = (values: Value[]): Value => {
      let result = values[0];
      for (const value of values.slice(1)) result = pick(result, value);
      return result;
    };
    if (all) return known(type, pickAll(coerced.map((operand) => operand.value)), expression);
    return this.combine(coerced, type, pickAll, expression);
  }

  private absBuiltin(expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr {
    const operand = this.compile(expression.args[0], resultType);
    const type = operand.type;
    if (type.kind === 'int') {
      const result = type.signed ? intType(false, type.bits) : type;
      return this.derived(operand, result, (value) =>
        (value as bigint) < 0n ? -(value as bigint) : (value as bigint)
      );
    }
    if (type.kind === 'comptime_int')
      return this.derived(operand, type, (value) => ((value as bigint) < 0n ? -(value as bigint) : (value as bigint)));
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
    let operand = this.compile(expression.args[0], resultType);
    if (operand.type.kind === 'comptime_int') operand = this.coerce(operand, COMPTIME_FLOAT, expression.args[0]);
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
      // Transcendental functions are computed in double precision, which matches f32 and f64.
      const double = typeof x === 'number' ? x : toNumber(x);
      const result = MATH_FUNCTIONS[name](double);
      return bits <= 64 ? roundNumber(result, bits as 16 | 32 | 64) : roundTo(asBigFloat(result), bits);
    };
    return this.derived(operand, type, apply);
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  private overflowBuiltin(name: string, expression: ExpressionOf<'builtinCall'>): TExpr {
    const [leftSyntax, rightSyntax] = expression.args;
    let left = this.compile(leftSyntax);
    let right = this.compile(rightSyntax, left.type);
    if (left.type.kind === 'comptime_int' && right.type.kind === 'int') left = this.compile(leftSyntax, right.type);
    const type = name === '@shlWithOverflow' ? left.type : this.peerType([left, right], expression);
    if (type.kind !== 'int')
      return this.error(expression, `${name} は整数の型にだけ使えます（${typeName(type)} 型です）。`);
    left = this.coerce(left, type, leftSyntax);
    right = this.coerce(right, name === '@shlWithOverflow' ? log2IntType(type) : type, rightSyntax);
    const bit = intType(false, 1);
    const tuple = this.tupleType([
      { name: '0', type, hasDefault: false },
      { name: '1', type: bit, hasDefault: false },
    ]);
    const compute = (a: Value, b: Value): Value => {
      const x = a as bigint;
      const y = b as bigint;
      const exact =
        name === '@addWithOverflow'
          ? x + y
          : name === '@subWithOverflow'
            ? x - y
            : name === '@mulWithOverflow'
              ? x * y
              : x << y;
      const wrapped = wrapInt(exact, type);
      return new ZStruct([wrapped, wrapped === exact ? 0n : 1n]);
    };
    return this.combine([left, right], tuple, ([a, b]) => compute(a, b), expression);
  }

  private exactShift(name: string, expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr {
    const left = this.compile(expression.args[0], resultType);
    const type = left.type;
    if (type.kind !== 'int')
      return this.error(expression, `${name} は整数の型にだけ使えます（${typeName(type)} 型です）。`);
    const amountType = log2IntType(type);
    const right = this.coerce(this.compile(expression.args[1], amountType), amountType, expression.args[1]);
    return this.combine(
      [left, right],
      type,
      ([a, b]) => {
        const x = a as bigint;
        const y = b as bigint;
        if (name === '@shlExact') {
          const shifted = x << y;
          if (wrapInt(shifted, type) !== shifted) panic(PANIC.leftShiftOverflow);
          return shifted;
        }
        if ((x >> y) << y !== x) panic(PANIC.rightShiftOverflow);
        return x >> y;
      },
      expression
    );
  }

  // code-gauge-allow functionNcss 39 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  // code-gauge-allow functionCognitiveComplexity 17 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  private bitBuiltin(name: string, expression: ExpressionOf<'builtinCall'>): TExpr {
    const operand = this.compile(expression.args[0]);
    const type = operand.type;
    if (type.kind !== 'int')
      return this.error(expression, `${name} は整数の型にだけ使えます（${typeName(type)} 型です）。`);
    const { bits } = type;
    const unsigned = (value: bigint): bigint => BigInt.asUintN(bits, value);
    const countType = log2IntType(intType(false, bits + 1));
    switch (name) {
      case '@clz': {
        return this.derived(operand, countType, (value) => {
          const text = unsigned(value as bigint).toString(2);
          return BigInt(value === 0n ? bits : bits - text.length);
        });
      }
      case '@ctz': {
        return this.derived(operand, countType, (value) => {
          let x = unsigned(value as bigint);
          if (x === 0n) return BigInt(bits);
          let count = 0n;
          while ((x & 1n) === 0n) {
            x >>= 1n;
            count++;
          }
          return count;
        });
      }
      case '@popCount': {
        return this.derived(operand, countType, (value) =>
          BigInt([...unsigned(value as bigint).toString(2)].filter((digit) => digit === '1').length)
        );
      }
      case '@byteSwap': {
        if (bits % 8 !== 0) this.error(expression, '@byteSwap は、8 の倍数のビット数の整数にだけ使えます。');
        return this.derived(operand, type, (value) => {
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
        return this.derived(operand, type, (value) => {
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
      return this.derived(operand, CONST_U8, (value) => bytesSlice((value as { name: string }).name));
    }
    if (type.kind === 'union' && type.tagType) {
      const fields = this.unionFields(type);
      return this.derived(operand, CONST_U8, (value) => bytesSlice(fields[(value as ZUnion).tag].name));
    }
    if (type.kind !== 'enum')
      return this.error(expression, `@tagName は enum の値にだけ使えます（${typeName(type)} 型です）。`);
    const fields = this.enumFields(type);
    if (operand.known) {
      const field = fields.find((each) => each.value === operand.value);
      if (!field)
        this.error(expression, `enum ${typeName(type)} には、値 ${operand.value as bigint} のフィールドがありません。`);
    }
    return this.derived(operand, CONST_U8, (value) => {
      const field = fields.find((each) => each.value === value);
      if (!field) panic(PANIC.invalidEnum);
      return bytesSlice(field.name);
    });
  }

  private memoryCopy(name: string, expression: ExpressionOf<'builtinCall'>): TExpr {
    const destination = this.compile(expression.args[0]);
    const source = this.compile(expression.args[1]);
    const target = elementAccessor(destination.type);
    const from = elementAccessor(source.type);
    if (!target || target.isConst)
      return this.error(expression.args[0], `${name} の書き込み先には、変更できる配列やスライスを指定してください。`);
    if (!from) return this.error(expression.args[1], `${name} の読み込み元には、配列やスライスを指定してください。`);
    const evaluateDestination = destination.eval;
    const evaluateSource = source.eval;
    return runtime(
      VOID,
      (frame) => {
        const out = target.view(evaluateDestination(frame));
        const input = from.view(evaluateSource(frame));
        if (out.length !== input.length) panic(PANIC.memcpyLengths);
        const values = input.slots.slots.slice(input.start, input.start + input.length);
        if (name === '@memcpy' && out.slots === input.slots && Math.abs(out.start - input.start) < out.length)
          panic(PANIC.memcpyAlias);
        for (const [index, value] of values.entries()) out.slots.slots[out.start + index] = value;
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
    const value = this.coerce(this.compile(expression.args[1], target.child), target.child, expression.args[1]);
    const evaluateDestination = destination.eval;
    const evaluateValue = value.eval;
    return runtime(
      VOID,
      (frame) => {
        const out = target.view(evaluateDestination(frame));
        const filler = evaluateValue(frame);
        for (let index = 0; index < out.length; index++) out.slots.slots[out.start + index] = filler;
        return;
      },
      expression
    );
  }

  /** An expression computed from others, known when they all are. */
  protected combine(operands: readonly TExpr[], type: Type, compute: (values: Value[]) => Value, span: Span): TExpr {
    if (operands.every((operand) => operand.known)) {
      try {
        return known(type, compute(operands.map((operand) => operand.value)), span);
      } catch (error) {
        // Zig reports the safety check that known operands fail as a compile error.
        if (error instanceof ZigPanic)
          this.error(span, `値が決まっている計算が、実行時のエラー（${error.text}）になります。`);
        throw error;
      }
    }
    const evaluators = operands.map((operand) => operand.eval);
    return runtime(type, (frame) => compute(evaluators.map((evaluate) => evaluate(frame))), span);
  }
}

export const CONST_U8: Type = sliceOf(U8, true);

/** A string's UTF-8 bytes as a slice of constants. */
export function bytesSlice(text: string): Slice {
  const bytes = [...new TextEncoder().encode(text)].map(BigInt);
  return new Slice(new ZArray([...bytes, 0n], 0, bytes.length), 0, bytes.length);
}

/** The text of a byte slice or a pointer to a byte array, decoded as UTF-8. */
export function bytesToText(value: Value): string {
  return new TextDecoder().decode(new Uint8Array(byteValues(value).map(Number)));
}

export function byteValues(value: Value): bigint[] {
  if (value instanceof Slice) return value.values() as bigint[];
  if (value instanceof Pointer) return (value.load() as ZArray).values() as bigint[];
  if (value instanceof ZArray) return value.values() as bigint[];
  return [];
}

function elementAccessor(type: Type):
  | {
      child: Type;
      isConst: boolean;
      view: (value: Value) => { slots: { slots: Value[] }; start: number; length: number };
    }
  | undefined {
  if (type.kind === 'pointer' && type.size === 'slice') {
    return {
      child: type.child,
      isConst: type.isConst,
      view: (value) => {
        const slice = value as Slice;
        return { slots: slice.target, start: slice.start, length: slice.length };
      },
    };
  }
  if (type.kind === 'pointer' && type.size === 'one' && type.child.kind === 'array') {
    return {
      child: type.child.child,
      isConst: type.isConst,
      view: (value) => {
        const array = (value as Pointer).load() as ZArray;
        return { slots: array, start: array.offset, length: array.length };
      },
    };
  }
  return undefined;
}

const MATH_FUNCTIONS: Record<string, (x: number) => number> = {
  '@sin': Math.sin,
  '@cos': Math.cos,
  '@tan': Math.tan,
  '@exp': Math.exp,
  '@exp2': (x) => 2 ** x,
  '@log': Math.log,
  '@log2': Math.log2,
  '@log10': Math.log10,
};

function roundFloat(name: string, value: AnyFloat, bits: FloatBits): AnyFloat {
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
  const double = toNumber(value);
  const result = roundFloat(name, double, 64) as number;
  return roundTo(asBigFloat(result), bits);
}

function floatDivision(name: string, x: AnyFloat, y: AnyFloat, bits: FloatBits): AnyFloat {
  const quotient = floatOperationFor(x, y, bits);
  if (name === '@divTrunc') return roundFloat('@trunc', quotient, bits);
  if (name === '@divFloor') return roundFloat('@floor', quotient, bits);
  if (name === '@divCeil') return roundFloat('@ceil', quotient, bits);
  return quotient;
}

function floatOperationFor(x: AnyFloat, y: AnyFloat, bits: FloatBits): AnyFloat {
  if (bits <= 64) return roundNumber((x as number) / (y as number), bits as 16 | 32 | 64);
  return floatOf(asBigFloat(roundTo(asBigFloat(x), 128)), bits);
}

function convertFloat(value: AnyFloat, bits: FloatBits): AnyFloat {
  if (bits <= 64 && typeof value === 'number') return roundNumber(value, bits as 16 | 32 | 64);
  return floatOf(asBigFloat(value), bits);
}

function fusedMultiplyAdd(a: BigFloat, b: BigFloat, c: BigFloat, bits: FloatBits): AnyFloat {
  // Exact product and sum in 128-bit... the exact rational is rounded once.
  const product = {
    sign: a.sign !== b.sign,
    mantissa: a.mantissa * b.mantissa,
    exponent: a.exponent + b.exponent,
  };
  const exactProduct = new BigFloat(product.sign, 'finite', product.mantissa, product.exponent);
  const sum = addExact(exactProduct, c);
  return floatOf(sum, bits);
}

function addExact(a: BigFloat, b: BigFloat): BigFloat {
  const exponent = Math.min(a.exponent, b.exponent);
  const x = (a.sign ? -a.mantissa : a.mantissa) << BigInt(a.exponent - exponent);
  const y = (b.sign ? -b.mantissa : b.mantissa) << BigInt(b.exponent - exponent);
  const sum = x + y;
  return new BigFloat(sum < 0n, 'finite', sum < 0n ? -sum : sum, exponent);
}

/** The smallest integer type that holds every value from `low` to `high`, as `std.math.IntFittingRange` gives. */
export function intFittingRange(low: bigint, high: bigint): IntType {
  if (low >= 0n) {
    let bits = 0;
    while (high >= 1n << BigInt(bits)) bits++;
    return intType(false, bits);
  }
  let bits = 1;
  while (low < -(1n << BigInt(bits - 1)) || high > (1n << BigInt(bits - 1)) - 1n) bits++;
  return intType(true, bits);
}

export { COMPTIME_INT, USIZE };
