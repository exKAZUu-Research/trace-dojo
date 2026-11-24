// code-gauge-allow-file fileNcss -- The builtins that inspect types share the analysis of `std.lang.Type`'s values.
import { PANIC, panic } from './arith';
import type { Expression, ExpressionOf, Span } from './ast';
import { BufferMemory } from './bufferMemory';
import { BuiltinCompiler } from './builtins';
import { constantText } from './constantText';
import { alignOf, bitSizeOf, fieldOffsets, sizeOf } from './layout';
import { langNamespace } from './library/lang';
import { memorySpace, spendMemory } from './memoryAccounting';
import { known, runtime, type TExpr } from './semaBase';
import {
  BOOL,
  COMPTIME_INT,
  ENUM_LITERAL,
  intType,
  isComptimeOnly,
  optionalOf,
  sliceOf,
  type StructField,
  type StructType,
  TYPE,
  type Type,
  typeName,
  type UnionType,
  VOID,
  withPointerAttributes,
} from './types';
import { decodeUtf8 } from './utf8';
import { Cell, markConstantStorage, NULL, Pointer, Slice, type Value, ZArray, ZStruct, ZUnion } from './values';

/**
 * The builtins that inspect types and steer the compiler: `@typeName`, `@typeInfo`, `@sizeOf`, `@field`,
 * `@compileError`, `@setEvalBranchQuota`, and the like.
 */
export abstract class ReflectionCompiler extends BuiltinCompiler {
  protected compileBuiltin(expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr {
    return this.reflectionBuiltin(expression, resultType) ?? super.compileBuiltin(expression, resultType);
  }

  // code-gauge-allow functionNcss -- Dispatches one case per builtin, as Zig's language reference lists them.
  private reflectionBuiltin(expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr | undefined {
    switch (expression.name) {
      case '@typeName': {
        return this.builtinTypeName(expression);
      }
      case '@compileError': {
        return this.builtinCompileError(expression);
      }
      case '@compileLog': {
        return this.builtinCompileLog(expression);
      }
      case '@setEvalBranchQuota': {
        return this.builtinSetEvalBranchQuota(expression);
      }
      case '@inComptime': {
        return this.builtinInComptime(expression);
      }
      case '@sizeOf': {
        return this.builtinSizeOf(expression);
      }
      case '@alignOf': {
        return this.builtinSizeOf(expression);
      }
      case '@bitSizeOf': {
        return this.builtinSizeOf(expression);
      }
      case '@offsetOf': {
        return this.builtinOffsetOf(expression);
      }
      case '@bitOffsetOf': {
        return this.builtinOffsetOf(expression);
      }
      case '@hasDecl': {
        return this.builtinHasDecl(expression);
      }
      case '@hasField': {
        return this.builtinHasField(expression);
      }
      case '@FieldType': {
        return this.builtinFieldType(expression);
      }
      case '@field': {
        return this.builtinField(expression);
      }
      case '@src': {
        return this.builtinSrc(expression);
      }
      case '@setRuntimeSafety': {
        return this.builtinSetRuntimeSafety(expression);
      }
      case '@setFloatMode': {
        return this.builtinSetRuntimeSafety(expression);
      }
      case '@branchHint': {
        return this.builtinSetRuntimeSafety(expression);
      }
      case '@prefetch': {
        return this.builtinSetRuntimeSafety(expression);
      }
      case '@typeInfo': {
        return this.builtinTypeInfo(expression);
      }
      case '@Int': {
        return this.builtinInt(expression);
      }
      case '@EnumLiteral': {
        return this.builtinEnumLiteral(expression);
      }
      case '@Tuple': {
        return this.builtinTuple(expression);
      }
      case '@constCast': {
        return this.builtinConstCast(expression);
      }
      case '@volatileCast': {
        return this.builtinConstCast(expression);
      }
      case '@bitCast': {
        return this.builtinBitCast(expression, resultType);
      }
      case '@backingInt': {
        return this.builtinBackingInt(expression);
      }
      case '@fromBackingInt': {
        return this.builtinFromBackingInt(expression, resultType);
      }
      default: {
        return undefined;
      }
    }
  }

  private builtinArity(expression: ExpressionOf<'builtinCall'>, count: number): void {
    if (expression.args.length !== count)
      this.error(
        expression,
        `${expression.name} の引数の数が合いません（${count} 個が必要ですが、${expression.args.length} 個です）。`
      );
  }

  private builtinTypeName(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { args } = expression;
    this.builtinArity(expression, 1);
    return this.text(typeName(this.compileType(args[0])), expression);
  }

  private builtinCompileError(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { args } = expression;
    this.builtinArity(expression, 1);
    return this.error(expression, this.comptimeText(args[0]));
  }

  private builtinCompileLog(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { args } = expression;
    const parts = args.map((arg) => this.logText(this.compile(arg)));
    return this.error(expression, `@compileLog が残っています（出力: ${parts.join(', ')}）。`);
  }

  private builtinSetEvalBranchQuota(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { args } = expression;
    this.builtinArity(expression, 1);
    const quota = Number(
      this.knownValue(this.coerce(this.compile(args[0], intType(false, 32)), intType(false, 32)), '上限')
    );
    this.evalBranches.quota = Math.max(this.evalBranches.quota, quota);
    return runtime(
      VOID,
      (frame) => {
        const count = frame.runtime.branchCount;
        if (count) count.quota = Math.max(count.quota, quota);
      },
      expression
    );
  }

  private builtinInComptime(expression: ExpressionOf<'builtinCall'>): TExpr {
    this.builtinArity(expression, 0);
    if (this.comptimeDepth > 0) return known(BOOL, true, expression);
    return runtime(BOOL, (frame) => frame.runtime.branchCount !== undefined, expression);
  }

  private builtinSizeOf(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { name, args } = expression;
    this.builtinArity(expression, 1);
    const type = this.sizedType(args[0], name);
    const size = name === '@sizeOf' ? sizeOf(type) : name === '@alignOf' ? alignOf(type) : bitSizeOf(type);
    return known(COMPTIME_INT, BigInt(size), expression);
  }

  private builtinOffsetOf(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { name, args } = expression;
    this.builtinArity(expression, 2);
    const type = this.sizedType(args[0], name);
    const fieldName = this.comptimeText(args[1]);
    if (type.kind !== 'struct')
      return this.error(args[0], `${name} には構造体の型を書いてください（${typeName(type)} 型です）。`);
    const fields = this.structFields(type, expression);
    const index = fields.findIndex((field) => field.name === fieldName);
    if (index === -1) return this.error(args[1], `${typeName(type)} 型には、フィールド「${fieldName}」がありません。`);
    if (fields[index].comptimeValue)
      return this.error(args[1], `comptime のフィールド「${fieldName}」には位置がありません。`);
    const bits = fieldOffsets(type)[index];
    return known(COMPTIME_INT, BigInt(name === '@offsetOf' ? Math.floor(bits / 8) : bits), expression);
  }

  private builtinHasDecl(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { name, args } = expression;
    this.builtinArity(expression, 2);
    const type = this.containerArgument(args[0], name);
    const declName = this.comptimeText(args[1]);
    const decl = this.findDecl(type, declName);
    return known(BOOL, decl !== undefined && (decl.kind === 'native' || decl.syntax.isPub), expression);
  }

  private builtinHasField(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { name, args } = expression;
    this.builtinArity(expression, 2);
    const type = this.containerArgument(args[0], name);
    const fieldName = this.comptimeText(args[1]);
    return known(BOOL, this.fieldNames(type, expression).includes(fieldName), expression);
  }

  private builtinFieldType(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { name, args } = expression;
    this.builtinArity(expression, 2);
    const type = this.containerArgument(args[0], name);
    const fieldName = this.comptimeText(args[1]);
    const fields =
      type.kind === 'struct'
        ? this.structFields(type, expression)
        : type.kind === 'union'
          ? this.unionFields(type)
          : [];
    const field = fields.find((each) => each.name === fieldName);
    if (!field) return this.error(args[1], `${typeName(type)} 型には、フィールド「${fieldName}」がありません。`);
    return known(TYPE, field.type, expression);
  }

  private builtinField(expression: ExpressionOf<'builtinCall'>): TExpr {
    this.builtinArity(expression, 2);
    return this.compile(this.fieldExpression(expression));
  }

  private builtinSrc(expression: ExpressionOf<'builtinCall'>): TExpr {
    this.builtinArity(expression, 0);
    const type = this.langType('SourceLocation', expression) as StructType;
    return known(
      type,
      this.structValue(type, expression, {
        module: this.nameSlice('main'),
        file: this.nameSlice('main.zig'),
        fn_name: this.nameSlice(this.functionName() ?? ''),
        line: BigInt(expression.row + 1),
        column: BigInt(expression.col + 1),
      }),
      expression
    );
  }

  private builtinSetRuntimeSafety(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { name, args } = expression;
    // The grader runs as a Debug build does: it keeps every safety check, and evaluates floats strictly.
    this.builtinArity(expression, name === '@prefetch' ? 2 : 1);
    for (const arg of args) this.compile(arg);
    return known(VOID, undefined, expression);
  }

  private builtinTypeInfo(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { args } = expression;
    this.builtinArity(expression, 1);
    const type = this.compileType(args[0]);
    const info = this.langMember('Type', expression) as UnionType;
    return known(info, this.typeInfo(type, info, expression), expression);
  }

  private builtinInt(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { args } = expression;
    this.builtinArity(expression, 2);
    const signedness = this.langMember('Signedness', expression);
    const signed = this.knownValue(this.coerce(this.compile(args[0], signedness), signedness, args[0]), '符号') === 0n;
    const u16 = intType(false, 16);
    const bits = Number(this.knownValue(this.coerce(this.compile(args[1], u16), u16, args[1]), 'ビット数'));
    return known(TYPE, intType(signed, bits), expression);
  }

  private builtinEnumLiteral(expression: ExpressionOf<'builtinCall'>): TExpr {
    this.builtinArity(expression, 0);
    return known(TYPE, ENUM_LITERAL, expression);
  }

  private builtinTuple(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { args } = expression;
    this.builtinArity(expression, 1);
    const types = this.comptimeElements(args[0], TYPE) as Type[];
    return known(
      TYPE,
      this.tupleType(types.map((type, index) => ({ name: String(index), type, hasDefault: false }))),
      expression
    );
  }

  private builtinConstCast(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { name, args } = expression;
    this.builtinArity(expression, 1);
    const operand = this.compile(args[0]);
    const pointer = operand.type.kind === 'optional' ? operand.type.child : operand.type;
    if (pointer.kind !== 'pointer')
      return this.error(args[0], `${name} にはポインタを渡してください（${typeName(operand.type)} 型です）。`);
    const cast = withPointerAttributes(pointer, name === '@constCast' ? { isConst: false } : { isVolatile: false });
    return {
      ...operand,
      type: operand.type.kind === 'optional' ? optionalOf(cast) : cast,
      place: undefined,
      local: undefined,
    };
  }

  private builtinBitCast(expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr {
    const { args } = expression;
    this.builtinArity(expression, 1);
    const target = this.resultTypeOf(expression, resultType);
    const operand = this.compile(args[0]);
    for (const [type, span] of [
      [operand.type, args[0]],
      [target, expression],
    ] as const) {
      this.resolveStorage(type, span);
      if (!bitCastable(type)) return this.error(span, `@bitCast では ${typeName(type)} 型を変換できません。`);
    }
    const from = bitSizeOf(operand.type);
    const to = bitSizeOf(target);
    if (from !== to)
      return this.error(
        expression,
        `@bitCast の変換の前後でビット数が合いません（${typeName(target)} は ${to} ビット、${typeName(operand.type)} は ${from} ビットです）。`
      );
    return this.derived(operand, target, (value) => reinterpret(value, operand.type, target));
  }

  private builtinBackingInt(expression: ExpressionOf<'builtinCall'>): TExpr {
    const { args } = expression;
    this.builtinArity(expression, 1);
    const operand = this.compile(args[0]);
    const type = operand.type;
    if (type.kind === 'enum') {
      const tag = this.enumFields(type) && (type.tagType as Type);
      return this.derived(operand, tag, (value) => value);
    }
    if (type.kind === 'union' && type.layout !== 'packed' && type.tagType) {
      const tags = this.enumFields(type.tagType);
      this.unionFields(type);
      return this.derived(operand, type.tagType.tagType as Type, (value) => tags[(value as ZUnion).tag].value);
    }
    if ((type.kind === 'struct' || type.kind === 'union') && type.layout === 'packed') {
      // Zig takes the backing integer only of a packed type that names it, as `packed struct(u8)` does.
      if (!type.namespace.syntax?.argument)
        return this.error(
          args[0],
          `${typeName(type)} 型は基底の整数型を書いていないので、@backingInt があいまいです。`
        );
      this.resolveStorage(type, args[0]);
      const backing = intType(false, bitSizeOf(type));
      return this.derived(operand, backing, (value) => reinterpret(value, type, backing));
    }
    return this.error(
      args[0],
      `@backingInt には enum か packed struct・packed union を渡してください（${typeName(type)} 型です）。`
    );
  }

  private builtinFromBackingInt(expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr {
    const { args } = expression;
    this.builtinArity(expression, 1);
    const target = this.resultTypeOf(expression, resultType);
    if (target.kind === 'enum') {
      const fields = this.enumFields(target);
      const tag = target.tagType as Type;
      const operand = this.coerce(this.compile(args[0], tag), tag, args[0]);
      const values = new Set(fields.map((field) => field.value));
      const exhaustive = target.exhaustive;
      return this.derived(operand, target, (value) =>
        exhaustive && !values.has(value as bigint) ? panic(PANIC.invalidEnum) : value
      );
    }
    if ((target.kind === 'struct' || target.kind === 'union') && target.layout === 'packed') {
      this.resolveStorage(target, expression);
      const backing = intType(false, bitSizeOf(target));
      const operand = this.coerce(this.compile(args[0], backing), backing, args[0]);
      return this.derived(operand, target, (value) => reinterpret(value, backing, target));
    }
    return this.error(
      expression,
      `@fromBackingInt の結果の型には enum か packed struct・packed union が要ります（${typeName(target)} 型です）。`
    );
  }

  private resultTypeOf(expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): Type {
    let target = resultType;
    while (target?.kind === 'optional' || target?.kind === 'error_union')
      target = target.kind === 'optional' ? target.child : target.payload;
    if (!target)
      return this.error(
        expression,
        `${expression.name} には結果の型が要ります（@as(T, ${expression.name}(...)) のように書いてください）。`
      );
    return target;
  }

  /** `@field(object, "name")` as the field access `object.name`, which may also be assigned to. */
  protected fieldExpression(expression: ExpressionOf<'builtinCall'>): Expression {
    return {
      kind: 'field',
      row: expression.row,
      col: expression.col,
      endRow: expression.endRow,
      object: expression.args[0],
      name: this.comptimeText(expression.args[1]),
    };
  }

  /** The name of the function being compiled, for `@src`. */
  protected abstract functionName(): string | undefined;

  private text(text: string, span: Span): TExpr {
    return this.stringLiteral([...new TextEncoder().encode(text)], span);
  }

  /** A string that the compiler knows, such as a field's name given to `@field`. */
  protected comptimeText(arg: Expression): string {
    const value = this.knownValue(this.compile(arg), '文字列');
    let bytes: Value[] | undefined;
    if (value instanceof Slice) bytes = value.values();
    else if (value instanceof Pointer && value.load() instanceof ZArray) bytes = (value.load() as ZArray).values();
    if (!bytes) return this.error(arg, '文字列が必要です。');
    return decodeUtf8(bytes.map(Number));
  }

  /** The elements of an array or slice that the compiler knows, such as `@Tuple`'s types. */
  private comptimeElements(arg: Expression, element: Type): Value[] {
    const type = sliceOf(element, true);
    const value = this.knownValue(this.coerce(this.compile(arg, type), type, arg), '配列');
    if (value instanceof Slice) return value.values();
    if (value instanceof Pointer && value.load() instanceof ZArray) return (value.load() as ZArray).values();
    if (value instanceof ZArray) return value.values();
    if (value instanceof ZStruct) return value.slots;
    return this.error(arg, '配列が必要です。');
  }

  private logText(value: TExpr): string {
    const type = value.type;
    if (!value.known) return `@as(${typeName(type)}, [runtime value])`;
    if (type.kind === 'pointer' && type.child.kind === 'array' && value.value instanceof Pointer) {
      const array = value.value.load() as ZArray;
      return `@as(${typeName(type)}, ${JSON.stringify(decodeUtf8(array.values().map(Number)))})`;
    }
    return `@as(${typeName(type)}, ${constantText(value.value, type, typeName)})`;
  }

  private sizedType(arg: Expression, name: string): Type {
    const type = this.compileType(arg);
    this.resolveStorage(type, arg);
    if (type.kind === 'anyopaque' || (type.kind === 'struct' && type.namespace.syntax?.containerKind === 'opaque'))
      this.error(arg, `${name} は、大きさのない opaque 型 ${typeName(type)} には使えません。`);
    if (isComptimeOnly(type) && name !== '@alignOf')
      this.error(arg, `${typeName(type)} 型はコンパイルのときだけの型なので、${name} は使えません。`);
    return type;
  }

  private containerArgument(arg: Expression, name: string): Type {
    const type = this.compileType(arg);
    if (type.kind !== 'struct' && type.kind !== 'enum' && type.kind !== 'union')
      return this.error(
        arg,
        `${name} には、構造体・enum・union・opaque の型を書いてください（${typeName(type)} 型です）。`
      );
    return type;
  }

  private fieldNames(type: Type, span: Span): string[] {
    if (type.kind === 'struct') return this.structFields(type, span).map((field) => field.name);
    if (type.kind === 'union') return this.unionFields(type).map((field) => field.name);
    if (type.kind === 'enum') return this.enumFields(type).map((field) => field.name);
    return [];
  }

  /** A declaration of `std.lang`, such as the type `Type` that `@typeInfo` returns. */
  protected langMember(name: string, span: Span): Type {
    const decl = langNamespace().namespace.decls.get(name);
    if (!decl) throw new Error(`std.lang.${name} is missing`);
    return this.knownValue(this.resolveDecl(decl, span), '型') as Type;
  }

  private langType(name: string, span: Span): Type {
    return this.langMember(name, span);
  }

  private memberType(type: Type, name: string, span: Span): Type {
    const decl = this.findDecl(type, name);
    if (!decl) throw new Error(`${typeName(type)}.${name} is missing`);
    return this.knownValue(this.resolveDecl(decl, span), '型') as Type;
  }

  /** A value of a struct type from its fields' values by name, with the defaults for the rest. */
  private structValue(type: StructType, span: Span, values: Record<string, Value>): ZStruct {
    const fields = this.structFields(type, span);
    this.reserveStorage(type, span);
    return new ZStruct(fields.map((field) => (field.name in values ? values[field.name] : field.defaultValue)));
  }

  private constSlice(values: Value[], sentinel = false): Slice {
    this.spendCompilation(values.length + 1);
    const array = new ZArray(sentinel ? [...values, 0n] : values, 0, values.length, sentinel);
    markConstantStorage(array);
    return new Slice(array, 0, values.length);
  }

  private names(names: readonly string[]): Slice {
    return this.constSlice(names.map((name) => this.nameSlice(name)));
  }

  private declNames(type: Type): Slice {
    const namespace = 'namespace' in type ? type.namespace : undefined;
    const names: string[] = [];
    for (const [name, decl] of namespace?.decls ?? []) {
      this.spendCompilation();
      if (decl.kind === 'native' || decl.syntax.isPub) names.push(name);
    }
    return this.names(names);
  }

  // code-gauge-allow functionNcss -- One case per kind of type, as `std.lang.Type` lists them.
  // code-gauge-allow functionCognitiveComplexity -- One case per kind of type, as `std.lang.Type` lists them.
  private typeInfo(type: Type, info: UnionType, span: Span): ZUnion {
    const tags = this.unionFields(info);
    const variant = (tag: string, values?: Record<string, Value>): ZUnion => {
      const index = tags.findIndex((field) => field.name === tag);
      const payloadType = tags[index].type;
      return new ZUnion(index, values ? this.structValue(payloadType as StructType, span, values) : undefined);
    };
    const nested = (name: string): Type => this.memberType(info, name, span);
    switch (type.kind) {
      case 'type':
      case 'void':
      case 'bool':
      case 'noreturn':
      case 'comptime_float':
      case 'comptime_int':
      case 'undefined':
      case 'null': {
        return variant(type.kind);
      }
      case 'enum_literal': {
        return variant('enum_literal');
      }
      case 'int': {
        return variant('int', { signedness: type.signed ? 0n : 1n, bits: BigInt(type.bits) });
      }
      case 'float': {
        return variant('float', { bits: BigInt(type.bits) });
      }
      case 'optional': {
        return variant('optional', { child: type.child });
      }
      case 'error_union': {
        return variant('error_union', { error_set: type.errorSet, payload: type.payload });
      }
      case 'error_set': {
        return variant('error_set', { error_names: type.names ? this.names([...type.names]) : NULL });
      }
      case 'array': {
        return variant('array', {
          len: type.length,
          child: type.child,
          sentinel_ptr: type.sentinel === undefined ? NULL : new Pointer(new Cell(type.sentinel.value), 0),
        });
      }
      case 'pointer': {
        const pointer = nested('Pointer') as StructType;
        const attributes = this.memberType(pointer, 'Attributes', span) as StructType;
        const size = { one: 0n, many: 1n, slice: 2n, c: 3n }[type.size];
        return variant('pointer', {
          size,
          attrs: this.structValue(attributes, span, {
            const: type.isConst,
            volatile: type.isVolatile ?? false,
            allowzero: type.allowZero ?? false,
            align: type.alignment === undefined ? NULL : BigInt(type.alignment),
          }),
          child: type.child,
          sentinel_ptr: type.sentinel === undefined ? NULL : new Pointer(new Cell(type.sentinel.value), 0),
        });
      }
      case 'struct': {
        const struct = nested('Struct') as StructType;
        const attributes = this.memberType(struct, 'FieldAttributes', span) as StructType;
        const fields = this.structFields(type, span);
        return variant('struct', {
          is_tuple: type.isTuple,
          layout: { auto: 0n, extern: 1n, packed: 2n }[type.layout],
          backing_integer: optionalValue(type.layout === 'packed' ? intType(false, bitSizeOf(type)) : undefined),
          field_names: this.names(fields.map((field) => field.name)),
          field_types: this.constSlice(fields.map((field) => field.type)),
          field_attrs: this.constSlice(fields.map((field) => this.fieldAttributes(attributes, field, span))),
          decl_names: this.declNames(type),
        });
      }
      case 'enum': {
        const fields = this.enumFields(type);
        return variant('enum', {
          tag_type: type.tagType,
          mode: type.exhaustive ? 0n : 1n,
          field_names: this.names(fields.map((field) => field.name)),
          field_values: this.constSlice(fields.map((field) => field.value)),
          decl_names: this.declNames(type),
        });
      }
      case 'union': {
        const union = nested('Union') as StructType;
        const attributes = this.memberType(union, 'FieldAttributes', span) as StructType;
        const fields = this.unionFields(type);
        return variant('union', {
          layout: { auto: 0n, extern: 1n, packed: 2n }[type.layout],
          tag_type: optionalValue(type.tagType),
          backing_integer: optionalValue(type.layout === 'packed' ? intType(false, bitSizeOf(type)) : undefined),
          field_names: this.names(fields.map((field) => field.name)),
          field_types: this.constSlice(fields.map((field) => field.type)),
          field_attrs: this.constSlice(fields.map(() => this.structValue(attributes, span, {}))),
          decl_names: this.declNames(type),
        });
      }
      case 'fn': {
        const fn = nested('Fn') as StructType;
        const attributes = this.memberType(fn, 'Attributes', span) as StructType;
        const paramAttributes = this.memberType(fn, 'ParamAttributes', span) as StructType;
        return variant('fn', {
          attrs: this.structValue(attributes, span, {}),
          is_generic: false,
          return_type: type.returnType,
          param_types: this.constSlice([...type.params]),
          param_attrs: this.constSlice(type.params.map(() => this.structValue(paramAttributes, span, {}))),
        });
      }
      default: {
        return this.error(span, `${typeName(type)} 型の @typeInfo は、この採点環境では使えません。`);
      }
    }
  }

  private fieldAttributes(attributes: StructType, field: StructField, span: Span): ZStruct {
    const value = field.comptimeValue?.value ?? field.defaultValue;
    return this.structValue(attributes, span, {
      comptime: field.comptimeValue !== undefined,
      default_value_ptr: field.hasDefault ? new Pointer(new Cell(value), 0) : NULL,
    });
  }
}

function optionalValue(value: Type | undefined): Value {
  return value ?? NULL;
}

/** Whether `@bitCast` takes or gives a value of a type, which must have a fixed bit layout. */
// code-gauge-allow duplicateLines -- Each classifies types by a different rule of Zig's (bit casts, packed fields, the C ABI).
function bitCastable(type: Type): boolean {
  switch (type.kind) {
    case 'int':
    case 'float':
    case 'bool': {
      return true;
    }
    case 'enum': {
      return type.namespace.syntax?.argument !== undefined;
    }
    case 'struct':
    case 'union': {
      return type.layout !== 'auto';
    }
    case 'array': {
      return bitCastable(type.child);
    }
    default: {
      return false;
    }
  }
}

/** A value's bits read as a value of another type of the same size, as memory holds them on a little-endian CPU. */
function reinterpret(value: Value, from: Type, to: Type): Value {
  const length = Math.max(sizeOf(from), sizeOf(to));
  const bytes = Array.from<Value>({ length }).fill(0n);
  new BufferMemory(bytes, spendMemory, memorySpace()).write(from, 0, value);
  return new BufferMemory(bytes, spendMemory, memorySpace()).read(to, 0);
}
