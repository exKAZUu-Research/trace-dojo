// code-gauge-allow-file fileNcss 1000 -- The file holds one layer of the compiler, whose parts share its private state.
import {
  checked,
  divExact,
  divide,
  floatMod,
  floatOperation,
  floatRem,
  indexOutOfBounds,
  PANIC,
  panic,
  saturate,
  shiftLeft,
  shiftLeftSaturating,
  shiftRight,
} from './arith';
import type { BinaryOperator, Expression, ExpressionOf, Span } from './ast';
import {
  type AnyFloat,
  BigFloat,
  compareFloats,
  floatArithmetic,
  type FloatBits,
  floatOf,
  isIntegral,
  negate,
  parseFloatLiteral,
} from './floats';
import { asFloat, comparisonTest, isArithmeticType, isIntegerType, isZero, sign } from './operands';
import { type Frame, Jump } from './runtime';
import {
  addDecls,
  copyForStorage,
  FnRef,
  isAnonymous,
  isType,
  known,
  type LocalBinding,
  mismatch,
  NativeFn,
  newArray,
  nullUnwrapPanic,
  type Place,
  runtime,
  SemaBase,
  type TExpr,
} from './semaBase';
import {
  ANYERROR,
  arrayOf,
  BOOL,
  COMPTIME_FLOAT,
  COMPTIME_INT,
  CONST_U8_SLICE,
  type Decl,
  ENUM_LITERAL,
  errorSetOf,
  errorUnionOf,
  fitsInt,
  fnType,
  indexableChild,
  type IntType,
  intType,
  isComptimeOnly,
  maxInt,
  minInt,
  NULL_TYPE,
  optionalOf,
  pointerTo,
  primitiveType,
  sliceOf,
  type StructField,
  type StructType,
  TYPE,
  type Type,
  typeName,
  U8,
  UNDEFINED_TYPE,
  USIZE,
  wrapInt,
} from './types';
import {
  EnumLiteral,
  ErrorValue,
  FnValue,
  NULL,
  Pointer,
  Slice,
  type Slots,
  Some,
  type Value,
  ZArray,
  ZStruct,
  ZUnion,
} from './values';

const NOTHING: Value = undefined;

/** Constant storage for literals such as strings, which pointers refer into. */
class Constant {
  slots: Value[];

  constructor(value: Value) {
    this.slots = [value];
  }
}

export abstract class ExpressionCompiler extends SemaBase {
  private readonly stringConstants = new Map<string, Constant>();

  // Abstract parts that later layers compile.
  protected abstract compileCall(expression: ExpressionOf<'call'>, resultType: Type | undefined): TExpr;
  protected abstract compileBuiltin(expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr;
  protected abstract compileControl(expression: Expression, resultType: Type | undefined): TExpr;
  protected abstract compileTry(expression: ExpressionOf<'try'>, resultType: Type | undefined): TExpr;
  protected abstract compileCatch(expression: ExpressionOf<'catch'>, resultType: Type | undefined): TExpr;
  protected abstract localSlot(): number;

  compile(expression: Expression, resultType?: Type): TExpr {
    switch (expression.kind) {
      case 'integer':
      case 'character': {
        return known(COMPTIME_INT, expression.value, expression);
      }
      case 'float': {
        return known(COMPTIME_FLOAT, parseFloatLiteral(expression.text, 128), expression);
      }
      case 'string': {
        return this.stringLiteral(expression.bytes, expression);
      }
      case 'bool': {
        return known(BOOL, expression.value, expression);
      }
      case 'null': {
        return known(NULL_TYPE, NULL, expression);
      }
      case 'undefined': {
        return known(UNDEFINED_TYPE, NOTHING, expression);
      }
      case 'unreachable': {
        return runtime({ kind: 'noreturn' }, () => panic(PANIC.unreachable), expression);
      }
      case 'identifier': {
        return this.identifier(expression.name, expression);
      }
      case 'builtinType': {
        const type = primitiveType(expression.name);
        if (!type) this.error(expression, `型「${expression.name}」は、この採点環境では使えません。`);
        return known(TYPE, type, expression);
      }
      case 'enumLiteral': {
        return this.enumLiteral(expression.name, expression, resultType);
      }
      case 'errorValue': {
        return known(errorSetOf([expression.name]), ErrorValue.of(expression.name), expression);
      }
      case 'field': {
        return this.fieldAccess(expression);
      }
      case 'index': {
        return this.index(expression);
      }
      case 'slice': {
        return this.slice(expression);
      }
      case 'deref': {
        return this.dereference(expression);
      }
      case 'unwrap': {
        return this.unwrapOptional(expression);
      }
      case 'call': {
        return this.compileCall(expression, resultType);
      }
      case 'builtinCall': {
        return this.compileBuiltin(expression, resultType);
      }
      case 'unary': {
        return this.unary(expression, resultType);
      }
      case 'binary': {
        return this.binary(expression, resultType);
      }
      case 'try': {
        return this.compileTry(expression, resultType);
      }
      case 'catch': {
        return this.compileCatch(expression, resultType);
      }
      case 'if':
      case 'while':
      case 'for':
      case 'switch':
      case 'block':
      case 'break':
      case 'continue':
      case 'return': {
        return this.compileControl(expression, resultType);
      }
      case 'structInit': {
        return this.structInit(expression, resultType);
      }
      case 'arrayInit': {
        return this.arrayInit(expression, resultType);
      }
      case 'optionalType': {
        return known(TYPE, optionalOf(this.compileType(expression.child)), expression);
      }
      case 'pointerType': {
        return known(TYPE, pointerTo(this.compileType(expression.child), expression.isConst), expression);
      }
      case 'sliceType': {
        const child = this.compileType(expression.child);
        const sentinel = expression.sentinel ? this.sentinelValue(expression.sentinel, child) : undefined;
        return known(TYPE, sliceOf(child, expression.isConst, sentinel), expression);
      }
      case 'arrayType': {
        return this.arrayTypeExpression(expression);
      }
      case 'errorUnionType': {
        const errorSet = this.compileType(expression.errorSet);
        if (errorSet.kind !== 'error_set')
          this.error(expression.errorSet, `「!」の左には、エラー集合の型を書いてください。`);
        return known(TYPE, errorUnionOf(errorSet, this.compileType(expression.payload)), expression);
      }
      case 'errorSetType': {
        return known(TYPE, errorSetOf(expression.names), expression);
      }
      case 'fnType': {
        const params = expression.params.map((param) => {
          if (!param.type) this.error(param, '関数の型の引数に anytype は書けません。');
          return this.compileType(param.type);
        });
        return known(TYPE, fnType(params, this.compileType(expression.returnType)), expression);
      }
      case 'container': {
        return known(TYPE, this.containerType(expression, undefined), expression);
      }
      case 'paren': {
        return this.compile(expression.operand, resultType);
      }
      case 'assign': {
        return this.error(expression, '代入は式の中には書けません。');
      }
    }
  }

  // Names -----------------------------------------------------------------------------------------------------------

  protected identifier(name: string, span: Span): TExpr {
    const binding = this.lookup(name);
    if (!binding) {
      // tree-sitter's grammar lacks some primitive type names, such as `f80`.
      const primitive = primitiveType(name);
      if (primitive) return known(TYPE, primitive, span);
      return this.error(span, `「${name}」は宣言されていません。`);
    }
    if (binding.kind === 'local') return this.localReference(binding, span);
    return this.resolveDecl(binding, span);
  }

  protected localReference(binding: LocalBinding, span: Span): TExpr {
    const { slot } = binding;
    const place: Place = { isConst: binding.isConst, locate: (frame) => new Pointer(frame, slot) };
    if (binding.known) return { ...known(binding.type, binding.value, span), place, local: binding };
    return { ...runtime(binding.type, (frame) => frame.slots[slot], span, place), local: binding };
  }

  private enumLiteral(name: string, span: Span, resultType: Type | undefined): TExpr {
    const literal = known(ENUM_LITERAL, EnumLiteral.of(name), span);
    if (!resultType) return literal;
    const target = resultType.kind === 'optional' ? resultType.child : resultType;
    if (target.kind === 'enum' || target.kind === 'union') return this.coerce(literal, target, span);
    // A declaration literal, such as `.empty` or `.init`, names a declaration of the result type.
    if (target.kind === 'struct') {
      const decl = this.findDecl(target, name);
      if (decl) return this.resolveDecl(decl, span);
    }
    return literal;
  }

  findDecl(type: Type, name: string): Decl | undefined {
    if (type.kind === 'struct' || type.kind === 'enum' || type.kind === 'union') return type.namespace.decls.get(name);
    return undefined;
  }

  protected stringLiteral(bytes: readonly number[], span: Span): TExpr {
    // Equal literals share their constant data, so their pointers compare equal as in Zig.
    const key = bytes.join(',');
    let constant = this.stringConstants.get(key);
    if (!constant) {
      constant = new Constant(new ZArray([...bytes.map(BigInt), 0n], 0, bytes.length));
      this.stringConstants.set(key, constant);
    }
    const type = pointerTo(arrayOf(bytes.length, U8, 0n), true);
    return known(type, new Pointer(constant, 0), span);
  }

  // Field access ----------------------------------------------------------------------------------------------------

  // code-gauge-allow functionNcss 38 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  // code-gauge-allow functionCognitiveComplexity 26 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  protected fieldAccess(expression: ExpressionOf<'field'>): TExpr {
    const object = this.compile(expression.object);
    const { name } = expression;
    if (object.type.kind === 'type') {
      return this.typeMember(this.knownValue(object, '型') as Type, name, expression);
    }
    let base = object;
    let type = object.type;
    if (type.kind === 'pointer' && type.size === 'one') {
      if (type.child.kind === 'array') {
        if (name === 'len') return known(USIZE, BigInt(type.child.length), expression);
        return this.error(expression, `配列へのポインタには、フィールド「${name}」がありません。`);
      }
      base = this.dereferenced(object, expression);
      type = base.type;
    }
    switch (type.kind) {
      case 'struct': {
        if (type.isTuple && name === 'len') {
          return known(COMPTIME_INT, BigInt(this.structFields(type, expression).length), expression);
        }
        return this.structField(base, type, name, expression);
      }
      case 'union': {
        return this.unionField(base, type, name, expression);
      }
      case 'array': {
        if (name === 'len') return known(USIZE, BigInt(type.length), expression);
        break;
      }
      case 'pointer': {
        if (type.size === 'slice') {
          if (name === 'len') {
            const evaluate = base.eval;
            if (base.known) return known(USIZE, BigInt((base.value as Slice).length), expression);
            return runtime(USIZE, (frame) => BigInt((evaluate(frame) as Slice).length), expression);
          }
          if (name === 'ptr') this.error(expression, '多要素のポインタ（.ptr）は、この採点環境では使えません。');
        }
        break;
      }
      default: {
        break;
      }
    }
    return this.error(expression, `${typeName(type)} 型には、フィールド「${name}」がありません。`);
  }

  /** A declaration, an enum's field, or an error of a type, as in `Point.init`, `Color.red`, or `MyError.Bad`. */
  protected typeMember(type: Type, name: string, span: Span): TExpr {
    if (type.kind === 'error_set') {
      if (type.names !== undefined && !type.names.has(name)) {
        this.error(span, `エラー集合 ${typeName(type)} には、error.${name} がありません。`);
      }
      return known(type.names === undefined ? errorSetOf([name]) : type, ErrorValue.of(name), span);
    }
    const decl = this.findDecl(type, name);
    if (decl) return this.resolveDecl(decl, span);
    if (type.kind === 'enum') {
      const field = this.enumFields(type).find((each) => each.name === name);
      if (field) return known(type, field.value, span);
    }
    if (type.kind === 'union') {
      // The fields resolve first, which gives `union(enum)` its tag type.
      const field = this.unionFields(type).find((each) => each.name === name);
      if (field && type.tagType) return this.typeMember(type.tagType, name, span);
    }
    return this.error(span, `${typeName(type)} には、「${name}」という宣言がありません。`);
  }

  protected structField(base: TExpr, type: StructType, name: string, span: Span): TExpr {
    const fields = this.structFields(type, span);
    let index = fields.findIndex((field) => field.name === name);
    if (index === -1 && type.isTuple && /^\d+$/.test(name)) index = Number(name);
    const field = fields[index] as StructField | undefined;
    if (!field) {
      if (this.findDecl(type, name)) {
        this.error(span, `「${name}」はフィールドではなく宣言です。呼び出すときは ${name}(...) と書きます。`);
      }
      return this.error(span, `${typeName(type)} 型には、フィールド「${name}」がありません。`);
    }
    if (field.comptimeValue !== undefined) return known(field.type, field.comptimeValue, span);
    if (base.known) {
      return known(field.type, (base.value as ZStruct).slots[index], span);
    }
    const evaluate = base.eval;
    const place = base.place;
    const fieldPlace: Place | undefined = place && {
      isConst: place.isConst,
      locate: (frame) => new Pointer(place.locate(frame).load() as ZStruct, index),
    };
    return runtime(field.type, (frame) => (evaluate(frame) as ZStruct).slots[index], span, fieldPlace);
  }

  private unionField(base: TExpr, type: Extract<Type, { kind: 'union' }>, name: string, span: Span): TExpr {
    const fields = this.unionFields(type);
    const index = fields.findIndex((field) => field.name === name);
    if (index === -1) return this.error(span, `${typeName(type)} 型には、フィールド「${name}」がありません。`);
    const field = fields[index];
    const check = (value: Value): ZUnion => {
      const union = value as ZUnion;
      if (union.tag !== index) {
        panic(`access of union field '${name}' while field '${fields[union.tag].name}' is active`);
      }
      return union;
    };
    if (base.known) {
      const union = base.value as ZUnion;
      if (union.tag !== index) {
        this.error(
          span,
          `union のフィールド「${name}」を読もうとしましたが、有効なのは「${fields[union.tag].name}」です。`
        );
      }
      return known(field.type, union.slots[0], span);
    }
    const evaluate = base.eval;
    const place = base.place;
    const fieldPlace: Place | undefined = place && {
      isConst: place.isConst,
      locate: (frame) => new Pointer(check(place.locate(frame).load()), 0),
    };
    return runtime(field.type, (frame) => check(evaluate(frame)).slots[0], span, fieldPlace);
  }

  // Pointers --------------------------------------------------------------------------------------------------------

  /** `p.*`, or a pointer that a field access or an index goes through. */
  protected dereferenced(pointer: TExpr, span: Span): TExpr {
    const type = pointer.type;
    if (type.kind !== 'pointer' || type.size !== 'one') {
      return this.error(span, `${typeName(type)} 型はポインタではないので、.* で参照できません。`);
    }
    const evaluate = pointer.eval;
    const place: Place = { isConst: type.isConst, locate: (frame) => evaluate(frame) as Pointer };
    if (pointer.known && pointer.value instanceof Pointer && type.isConst && pointer.value.target instanceof Constant) {
      return { ...known(type.child, pointer.value.load(), span), place };
    }
    return runtime(type.child, (frame) => (evaluate(frame) as Pointer).load(), span, place);
  }

  private dereference(expression: ExpressionOf<'deref'>): TExpr {
    return this.dereferenced(this.compile(expression.operand), expression);
  }

  /** `&x`: a pointer to what an expression names, or to a temporary that holds its value. */
  addressOf(expression: TExpr): TExpr {
    const place = expression.place;
    const span = expression.span;
    if (expression.type.kind === 'fn' || expression.value instanceof FnRef) {
      return known(
        pointerTo(this.functionType(expression, span), true),
        this.knownFunctionValue(expression, span),
        span
      );
    }
    if (place) {
      const type = pointerTo(expression.type, place.isConst);
      return runtime(type, (frame) => place.locate(frame), span);
    }
    if (expression.known) {
      const storage = new Constant(copyForStorage(expression.value));
      return known(pointerTo(expression.type, true), new Pointer(storage, 0), span);
    }
    const evaluate = expression.eval;
    return runtime(pointerTo(expression.type, true), (frame) => new Pointer(new Constant(evaluate(frame)), 0), span);
  }

  private functionType(expression: TExpr, span: Span): Type {
    const fn = this.functionOf(expression, span);
    return fnType(fn.params, fn.returnType);
  }

  protected knownFunctionValue(expression: TExpr, span: Span): FnValue {
    if (expression.value instanceof FnValue) return expression.value;
    const ref = expression.value as unknown as FnRef;
    if (!(ref instanceof FnRef)) this.error(span, 'この関数は、値として使えません。');
    return new FnValue(this.instantiate(ref, [], span));
  }

  private unwrapOptional(expression: ExpressionOf<'unwrap'>): TExpr {
    const operand = this.compile(expression.operand);
    const type = operand.type;
    if (type.kind !== 'optional')
      return this.error(expression, `${typeName(type)} 型は optional ではないので、.? は使えません。`);
    const child = type.child;
    // A known null still panics only when the program runs, as in Zig.
    if (operand.known && operand.value !== NULL) return known(child, unwrapOptionalValue(operand.value), expression);
    const evaluate = operand.eval;
    const place = operand.place;
    const unwrapPlace: Place | undefined = place && {
      isConst: place.isConst,
      locate: (frame) => {
        const pointer = place.locate(frame);
        const value = pointer.load();
        if (value === NULL) nullUnwrapPanic();
        return value instanceof Some ? new Pointer(new SomeSlots(pointer), 0) : pointer;
      },
    };
    return runtime(child, (frame) => unwrapOptionalValue(evaluate(frame)), expression, unwrapPlace);
  }

  // Indexing and slicing ----------------------------------------------------------------------------------------------

  protected index(expression: ExpressionOf<'index'>): TExpr {
    const object = this.compile(expression.object);
    const index = this.coerce(this.compile(expression.index, USIZE), USIZE, expression.index);
    const type = object.type;
    if (type.kind === 'struct' && type.isTuple) {
      const position = Number(this.knownValue(index, 'タプルの添字') as bigint);
      return this.structField(object, type, String(position), expression);
    }
    const child = indexableChild(type);
    if (!child) return this.error(expression, `${typeName(type)} 型には、添字が使えません。`);
    const length = staticLength(type);
    if (
      index.known &&
      length !== undefined &&
      (index.value as bigint) >= BigInt(length + (hasSentinel(type) ? 1 : 0))
    ) {
      this.error(expression.index, `添字 ${index.value as bigint} は、長さ ${length} の範囲の外です。`);
    }
    const isConst = isConstIndexable(type, object.place);
    if (object.known && index.known && (type.kind === 'array' || isConstantData(object.value))) {
      const elements = elementSlots(object.value, type);
      return known(child, elements.slots[elements.start + Number(index.value)], expression);
    }
    const access = this.elementAccess(object, type);
    const evaluateIndex = index.eval;
    const place: Place = {
      isConst,
      locate: (frame) => {
        const { slots, position } = access(frame, evaluateIndex(frame) as bigint);
        return new Pointer(slots, position);
      },
    };
    return runtime(
      child,
      (frame) => {
        const { slots, position } = access(frame, evaluateIndex(frame) as bigint);
        return slots.slots[position];
      },
      expression,
      place
    );
  }

  /** Locates the element at an index of an array, a pointer to one, or a slice, checking the bounds. */
  // code-gauge-allow functionCognitiveComplexity 21 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  private elementAccess(
    object: TExpr,
    type: Type
  ): (frame: Frame, index: bigint) => { slots: Slots; position: number } {
    const evaluate = object.eval;
    if (type.kind === 'array') {
      const place = object.place;
      const limit = type.length + (type.sentinel === undefined ? 0 : 1);
      const length = type.length;
      return (frame, index) => {
        const array = (place ? place.locate(frame).load() : evaluate(frame)) as ZArray;
        if (index >= BigInt(limit)) indexOutOfBounds(index, length);
        return { slots: array, position: array.offset + Number(index) };
      };
    }
    if (type.kind === 'pointer' && type.size === 'one' && type.child.kind === 'array') {
      const array = type.child;
      const limit = array.length + (array.sentinel === undefined ? 0 : 1);
      return (frame, index) => {
        const target = (evaluate(frame) as Pointer).load() as ZArray;
        if (index >= BigInt(limit)) indexOutOfBounds(index, array.length);
        return { slots: target, position: target.offset + Number(index) };
      };
    }
    const sentinel = type.kind === 'pointer' ? type.sentinel : undefined;
    return (frame, index) => {
      const slice = evaluate(frame) as Slice;
      const limit = slice.length + (sentinel === undefined ? 0 : 1);
      if (index >= BigInt(limit)) indexOutOfBounds(index, slice.length);
      return { slots: slice.target, position: slice.start + Number(index) };
    };
  }

  private slice(expression: ExpressionOf<'slice'>): TExpr {
    const operand = this.compile(expression.object);
    let type = operand.type;
    const start = this.coerce(this.compile(expression.start, USIZE), USIZE, expression.start);
    const end = expression.end ? this.coerce(this.compile(expression.end, USIZE), USIZE, expression.end) : undefined;
    // Slicing an array slices it where it lives, as through a pointer to it.
    let base = operand;
    if (type.kind === 'array') {
      if (!operand.place && !operand.known)
        this.error(expression, 'この配列はスライスできません（変数に入れてください）。');
      base = this.addressOf(operand);
      type = base.type;
    }
    let child: Type;
    let isConst: boolean;
    let staticLen: number | undefined;
    let sourceSentinel: Value | undefined;
    if (type.kind === 'pointer' && type.size === 'one' && type.child.kind === 'array') {
      child = type.child.child;
      isConst = type.isConst;
      staticLen = type.child.length;
      sourceSentinel = type.child.sentinel;
    } else if (type.kind === 'pointer' && type.size === 'slice') {
      child = type.child;
      isConst = type.isConst;
      sourceSentinel = type.sentinel;
    } else {
      return this.error(expression, `${typeName(type)} 型はスライスできません。`);
    }
    const sentinel = expression.sentinel ? this.sentinelValue(expression.sentinel, child) : undefined;
    const limitOf = (length: number): number => length + (sourceSentinel === undefined ? 0 : 1);
    if (start.known && end?.known && (start.value as bigint) > (end.value as bigint)) {
      this.error(
        expression,
        `スライスの始まり ${start.value as bigint} が、終わり ${end.value as bigint} より大きくなっています。`
      );
    }
    if (staticLen !== undefined && end?.known && (end.value as bigint) > BigInt(limitOf(staticLen))) {
      this.error(expression, `スライスの終わり ${end.value as bigint} は、長さ ${staticLen} の範囲の外です。`);
    }
    const resultLength =
      start.known && (end ? end.known : staticLen !== undefined)
        ? Number((end ? (end.value as bigint) : BigInt(staticLen as number)) - (start.value as bigint))
        : undefined;
    const resultType =
      resultLength === undefined
        ? sliceOf(child, isConst, sentinel)
        : pointerTo(arrayOf(resultLength, child, sentinel), isConst);
    const evaluateBase = base.eval;
    const evaluateStart = start.eval;
    const evaluateEnd = end?.eval;
    const fromArray = staticLen !== undefined;
    const compute = (frame: Frame): { target: Slots; from: number; to: number } => {
      const value = evaluateBase(frame);
      let target: Slots;
      let offset: number;
      let length: number;
      if (fromArray) {
        const array = (value as Pointer).load() as ZArray;
        target = array;
        offset = array.offset;
        length = staticLen as number;
      } else {
        const slice = value as Slice;
        target = slice.target;
        offset = slice.start;
        length = slice.length;
      }
      const from = Number(evaluateStart(frame) as bigint);
      const to = evaluateEnd ? Number(evaluateEnd(frame) as bigint) : length;
      if (to > limitOf(length)) indexOutOfBounds(to, length);
      if (from > to) panic(`start index ${from} is larger than end index ${to}`);
      if (sentinel !== undefined && target.slots[offset + to] !== sentinel) {
        panic(`sentinel mismatch: expected ${String(sentinel)}, found ${String(target.slots[offset + to])}`);
      }
      return { target, from: offset + from, to: offset + to };
    };
    if (resultLength !== undefined) {
      return runtime(
        resultType,
        (frame) => {
          const { target, from, to } = compute(frame);
          return new Pointer(new Constant(new ZArray(target.slots, from, to - from)), 0);
        },
        expression
      );
    }
    return runtime(
      resultType,
      (frame) => {
        const { target, from, to } = compute(frame);
        return new Slice(target, from, to - from);
      },
      expression
    );
  }

  private sentinelValue(expression: Expression, child: Type): Value {
    return this.knownValue(this.coerce(this.compile(expression, child), child, expression), '番兵');
  }

  // Operators -------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionNcss 37 -- One case per kind of syntax node, type, or format specifier, as Zig defines them.
  // code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of syntax node, type, or format specifier, as Zig defines them.
  private unary(expression: ExpressionOf<'unary'>, resultType: Type | undefined): TExpr {
    if (expression.operator === '&') {
      let operandType = resultType?.kind === 'pointer' ? resultType.child : undefined;
      // `&.{ 1, 2 }` for a slice points to an array of the slice's elements.
      if (
        resultType?.kind === 'pointer' &&
        resultType.size === 'slice' &&
        expression.operand.kind === 'arrayInit' &&
        !expression.operand.type
      ) {
        operandType = arrayOf(expression.operand.elements.length, resultType.child, resultType.sentinel);
      }
      if (
        resultType?.kind === 'pointer' &&
        resultType.size === 'slice' &&
        expression.operand.kind === 'structInit' &&
        !expression.operand.type &&
        expression.operand.fields.length === 0
      ) {
        operandType = arrayOf(0, resultType.child, resultType.sentinel);
      }
      const address = this.addressOf(this.compile(expression.operand, operandType));
      return address;
    }
    const operand = this.compile(expression.operand, expression.operator === '!' ? BOOL : resultType);
    const type = operand.type;
    switch (expression.operator) {
      case '!': {
        const value = this.coerce(operand, BOOL, expression.operand);
        return this.derived(value, BOOL, (v) => !v);
      }
      case '~': {
        if (type.kind !== 'int')
          return this.error(expression, `~ は、整数の型にだけ使えます（${typeName(type)} 型です）。`);
        return this.derived(operand, type, (v) => wrapInt(~(v as bigint), type));
      }
      case '-': {
        if (type.kind === 'comptime_int') return this.derived(operand, type, (v) => -(v as bigint));
        if (type.kind === 'int') {
          if (!type.signed) this.error(expression, `符号なしの整数 ${typeName(type)} には、- を付けられません。`);
          if (operand.known)
            return known(type, this.checkedKnown(-(operand.value as bigint), type, expression), expression);
          return this.derived(operand, type, (v) => checked(-(v as bigint), type));
        }
        if (type.kind === 'float' || type.kind === 'comptime_float')
          return this.derived(operand, type, (v) => negate(v as AnyFloat));
        return this.error(expression, `- は、数の型にだけ使えます（${typeName(type)} 型です）。`);
      }
      case '-%': {
        if (type.kind === 'int') return this.derived(operand, type, (v) => wrapInt(-(v as bigint), type));
        if (type.kind === 'comptime_int') return this.derived(operand, type, (v) => -(v as bigint));
        return this.error(expression, `-% は、整数の型にだけ使えます（${typeName(type)} 型です）。`);
      }
    }
  }

  protected checkedKnown(value: bigint, type: IntType, span: Span): bigint {
    if (!fitsInt(value, type)) this.error(span, `整数 ${typeName(type)} があふれます（値は ${value}）。`);
    return value;
  }

  // code-gauge-allow functionNcss 33 -- One case per kind of syntax node, type, or format specifier, as Zig defines them.
  private binary(expression: ExpressionOf<'binary'>, resultType: Type | undefined): TExpr {
    const { operator } = expression;
    switch (operator) {
      case 'and':
      case 'or': {
        return this.logical(expression);
      }
      case 'orelse': {
        return this.orelse(expression, resultType);
      }
      case '==':
      case '!=':
      case '<':
      case '>':
      case '<=':
      case '>=': {
        return this.comparison(expression);
      }
      case '++': {
        return this.concatenate(expression);
      }
      case '**': {
        return this.repeat(expression);
      }
      case '||': {
        const left = this.compileType(expression.left);
        const right = this.compileType(expression.right);
        if (left.kind !== 'error_set' || right.kind !== 'error_set')
          this.error(expression, '|| は、エラー集合の型どうしにだけ使えます。');
        if (left.names === undefined || right.names === undefined) return known(TYPE, ANYERROR, expression);
        return known(TYPE, errorSetOf([...left.names, ...right.names]), expression);
      }
      case '<<':
      case '>>':
      case '<<|': {
        return this.shift(expression, resultType);
      }
      default: {
        return this.arithmetic(expression, resultType);
      }
    }
  }

  private logical(expression: ExpressionOf<'binary'>): TExpr {
    const left = this.coerce(this.compile(expression.left, BOOL), BOOL, expression.left);
    const isAnd = expression.operator === 'and';
    if (left.known && (left.value as boolean) !== isAnd) return known(BOOL, !isAnd, expression);
    const right = this.coerce(this.compile(expression.right, BOOL), BOOL, expression.right);
    if (left.known) return right;
    const evaluateLeft = left.eval;
    const evaluateRight = right.eval;
    return runtime(
      BOOL,
      isAnd
        ? (frame) => (evaluateLeft(frame) as boolean) && (evaluateRight(frame) as boolean)
        : (frame) => (evaluateLeft(frame) as boolean) || (evaluateRight(frame) as boolean),
      expression
    );
  }

  private orelse(expression: ExpressionOf<'binary'>, resultType: Type | undefined): TExpr {
    const left = this.compile(expression.left, resultType ? optionalOf(resultType) : undefined);
    if (left.type.kind !== 'optional') {
      return this.error(expression, `orelse の左は optional にしてください（${typeName(left.type)} 型です）。`);
    }
    const child = left.type.child;
    const right = this.compile(expression.right, child);
    const type =
      right.type.kind === 'noreturn' ? child : this.peerType([known(child, undefined, expression), right], expression);
    const otherwise = this.coerce(right, type, expression.right);
    if (left.known && left.value !== NULL)
      return this.coerce(known(child, optionalPayload(left.value), expression), type, expression);
    if (left.known) return otherwise;
    const evaluateLeft = left.eval;
    const evaluateRight = otherwise.eval;
    // The payload converts to the result type as a value of the child type would.
    let current: Value;
    const convert = this.coerce(
      runtime(child, () => current, expression),
      type,
      expression
    ).eval;
    return runtime(
      type,
      (frame) => {
        const value = evaluateLeft(frame);
        if (value === NULL) return evaluateRight(frame);
        current = optionalPayload(value);
        return convert(frame);
      },
      expression
    );
  }

  // code-gauge-allow functionCognitiveComplexity 27 -- Keeps one operation of the interpreter in one place.
  private comparison(expression: ExpressionOf<'binary'>): TExpr {
    const { operator } = expression;
    let left = this.compile(expression.left);
    let right = this.compile(expression.right, left.type.kind === 'null' ? undefined : unionTag(left.type));
    if (left.type.kind === 'enum_literal' && right.type.kind !== 'enum_literal')
      left = this.compile(expression.left, unionTag(right.type));
    // A tagged union compares with an enum value by its active tag.
    const leftTag = left.type.kind === 'union' ? left.type.tagType : undefined;
    const rightTag = right.type.kind === 'union' ? right.type.tagType : undefined;
    if (leftTag && right.type === leftTag) left = this.coerce(left, leftTag, expression.left);
    if (rightTag && left.type === rightTag) right = this.coerce(right, rightTag, expression.right);
    // `x == null` compares an optional with null.
    if (right.type.kind === 'null' || left.type.kind === 'null') {
      if (operator !== '==' && operator !== '!=') this.error(expression, 'null とは == と != でだけ比べられます。');
      const optional = right.type.kind === 'null' ? left : right;
      if (optional.type.kind !== 'optional' && optional.type.kind !== 'null') {
        this.error(expression, `${typeName(optional.type)} 型は optional ではないので、null と比べられません。`);
      }
      const isEqual = operator === '==';
      return this.derived(optional, BOOL, (value) => (value === NULL) === isEqual);
    }
    const ordered = operator !== '==' && operator !== '!=';
    const errorUnion = [left, right].find((operand) => operand.type.kind === 'error_union');
    const error = [left, right].find((operand) => operand.type.kind === 'error_set');
    if (errorUnion && error && !ordered) {
      // An error union equals an error when it holds that error.
      const isEqual = operator === '==';
      const evaluateUnion = errorUnion.eval;
      const evaluateError = error.eval;
      return runtime(BOOL, (frame) => (evaluateUnion(frame) === evaluateError(frame)) === isEqual, expression);
    }
    // Integers of any types compare by their values, without a common type.
    const type =
      isIntegerType(left.type) && isIntegerType(right.type) ? COMPTIME_INT : this.peerType([left, right], expression);
    if (type !== COMPTIME_INT) {
      left = this.coerce(left, type, expression.left);
      right = this.coerce(right, type, expression.right);
    }
    const compare = this.comparator(type, ordered, expression);
    const test = comparisonTest(operator);
    if (left.known && right.known) return known(BOOL, test(compare(left.value, right.value)), expression);
    const evaluateLeft = left.eval;
    const evaluateRight = right.eval;
    return runtime(BOOL, (frame) => test(compare(evaluateLeft(frame), evaluateRight(frame))), expression);
  }

  /** A function comparing two values of a type: negative, zero, or positive, or NaN when unordered. */
  private comparator(type: Type, ordered: boolean, span: Span): (a: Value, b: Value) => number {
    switch (type.kind) {
      case 'int':
      case 'comptime_int':
      case 'enum': {
        if (type.kind === 'enum' && ordered) this.error(span, `enum の値は、大小を比べられません。`);
        return (a, b) => ((a as bigint) < (b as bigint) ? -1 : (a as bigint) > (b as bigint) ? 1 : 0);
      }
      case 'float':
      case 'comptime_float': {
        return (a, b) => compareFloats(a as AnyFloat, b as AnyFloat) ?? Number.NaN;
      }
      case 'bool': {
        if (ordered) this.error(span, 'bool の値は、大小を比べられません。');
        return (a, b) => (a === b ? 0 : 1);
      }
      case 'error_set': {
        if (ordered) this.error(span, 'エラーの値は、大小を比べられません。');
        return (a, b) => (a === b ? 0 : 1);
      }
      case 'type': {
        if (ordered) this.error(span, '型は、大小を比べられません。');
        return (a, b) => (a === b ? 0 : 1);
      }
      case 'enum_literal': {
        return (a, b) => (a === b ? 0 : 1);
      }
      case 'union': {
        if (ordered || !type.tagType) this.error(span, `${typeName(type)} 型の値は比べられません。`);
        return (a, b) => ((a as ZUnion).tag === (b as ZUnion).tag ? 0 : 1);
      }
      case 'pointer': {
        if (ordered || type.size === 'slice') this.error(span, `${typeName(type)} 型の値は、== で比べられません。`);
        return (a, b) => ((a as Pointer).equals(b as Pointer) ? 0 : 1);
      }
      case 'optional': {
        if (ordered) this.error(span, `${typeName(type)} 型の値は、大小を比べられません。`);
        const compareChild = this.comparator(type.child, false, span);
        return (a, b) =>
          a === NULL || b === NULL ? (a === b ? 0 : 1) : compareChild(optionalPayload(a), optionalPayload(b));
      }
      default: {
        return this.error(span, `${typeName(type)} 型の値は、${ordered ? '大小を' : '== で'}比べられません。`);
      }
    }
  }

  private arithmetic(expression: ExpressionOf<'binary'>, resultType: Type | undefined): TExpr {
    const { operator } = expression;
    // Zig gives the operands of arithmetic no result type, so `@floatFromInt(x) / 2` is an error.
    void resultType;
    let left = this.compile(expression.left);
    let right = this.compile(expression.right);
    const bitwise = operator === '&' || operator === '|' || operator === '^';
    if (bitwise && (left.type.kind === 'bool' || right.type.kind === 'bool')) {
      this.error(expression, `bool の値には ${operator} ではなく and・or を使います。`);
    }
    const kinds = new Set([left.type.kind, right.type.kind]);
    if (operator === '/' && kinds.has('comptime_int') && kinds.has('comptime_float') && !isZero(right.value)) {
      this.checkMixedDivision(left, right, expression);
    }
    const type = this.peerType([left, right], expression);
    if (!isArithmeticType(type)) {
      return this.error(expression, `${operator} は、数の型にだけ使えます（${typeName(type)} 型です）。`);
    }
    left = this.coerce(left, type, expression.left);
    right = this.coerce(right, type, expression.right);
    this.checkDivision(operator, type, left, right, expression);
    const operation = this.operation(operator, type, expression);
    // A float of a fixed type divided by zero gives an infinity or NaN, as at run time.
    const dividesByZero =
      (operator === '/' || operator === '%') && right.known && isZero(right.value) && type.kind !== 'float';
    if (dividesByZero) this.error(expression, '0 で割っています。');
    if (left.known && right.known) {
      return known(type, this.foldArithmetic(operation, left.value, right.value, type, expression), expression);
    }
    const evaluateLeft = left.eval;
    const evaluateRight = right.eval;
    return runtime(type, (frame) => operation(evaluateLeft(frame), evaluateRight(frame)), expression);
  }

  private foldArithmetic(operation: (a: Value, b: Value) => Value, a: Value, b: Value, type: Type, span: Span): Value {
    try {
      return operation(a, b);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ZigPanic') throw error;
      if (error.message.includes('division by zero')) return this.error(span, '0 で割っています。');
      if (error.message.includes('remainder')) return this.error(span, '割り切れない数を @divExact で割っています。');
      const raw = this.rawArithmetic(span as ExpressionOf<'binary'>, a, b);
      return this.error(span, `整数 ${typeName(type)} があふれます（値は ${raw}）。`);
    }
  }

  private rawArithmetic(expression: ExpressionOf<'binary'>, a: Value, b: Value): string {
    const x = a as bigint;
    const y = b as bigint;
    switch (expression.operator) {
      case '+': {
        return String(x + y);
      }
      case '-': {
        return String(x - y);
      }
      case '*': {
        return String(x * y);
      }
      default: {
        return '?';
      }
    }
  }

  /** Zig rejects dividing a `comptime_int` and a `comptime_float` unless the quotient is an integer. */
  private checkMixedDivision(left: TExpr, right: TExpr, span: Span): void {
    const quotient = floatArithmetic(asFloat(left), asFloat(right), '/', 128);
    if (!isIntegral(quotient)) {
      this.error(
        span,
        'comptime_int と comptime_float の割り算は、割り切れないときは型を決めてください（7.0 / 2.0 のように書きます）。'
      );
    }
  }

  /**
   * Zig accepts `/` on signed integers only when both operands are known, and `%` on signed integers and floats only
   * when both are known and not negative; otherwise the program must choose a rounding with a builtin.
   */
  private checkDivision(operator: BinaryOperator, type: Type, left: TExpr, right: TExpr, span: Span): void {
    if (operator !== '/' && operator !== '%') return;
    const bothKnown = left.known && right.known;
    if (operator === '/' && type.kind === 'int' && type.signed && !bothKnown) {
      this.error(
        span,
        `符号付きの整数 ${typeName(type)} の割り算には、@divTrunc・@divFloor・@divCeil・@divExact を使ってください。`
      );
    }
    const mayBeNegative = (type.kind === 'int' && type.signed) || type.kind !== 'int';
    if (operator === '%' && mayBeNegative && !(bothKnown && sign(left.value) >= 0 && sign(right.value) > 0)) {
      this.error(
        span,
        `符号付きの整数や浮動小数点数の余りには、@rem か @mod を使ってください（${typeName(type)} 型です）。`
      );
    }
  }

  // code-gauge-allow functionNcss 51 -- One case per kind of syntax node, type, or format specifier, as Zig defines them.
  private operation(operator: BinaryOperator, type: Type, span: Span): (a: Value, b: Value) => Value {
    if (type.kind === 'float' || type.kind === 'comptime_float') {
      const bits: FloatBits = type.kind === 'float' ? type.bits : 128;
      switch (operator) {
        case '+':
        case '-':
        case '*':
        case '/': {
          return (a, b) => floatOperation(a as AnyFloat, b as AnyFloat, operator, bits);
        }
        case '%': {
          return (a, b) => floatRem(a as AnyFloat, b as AnyFloat, bits);
        }
        default: {
          return this.error(span, `${operator} は、浮動小数点数には使えません。`);
        }
      }
    }
    const int = type.kind === 'int' ? type : undefined;
    const check = int ? (value: bigint): bigint => checked(value, int) : (value: bigint): bigint => value;
    const wrap = int ? (value: bigint): bigint => wrapInt(value, int) : (value: bigint): bigint => value;
    const clamp = int ? (value: bigint): bigint => saturate(value, int) : (value: bigint): bigint => value;
    switch (operator) {
      case '+': {
        return (a, b) => check((a as bigint) + (b as bigint));
      }
      case '-': {
        return (a, b) => check((a as bigint) - (b as bigint));
      }
      case '*': {
        return (a, b) => check((a as bigint) * (b as bigint));
      }
      case '/': {
        return (a, b) => check(divide(a as bigint, b as bigint));
      }
      case '%': {
        return (a, b) => {
          if ((b as bigint) === 0n) panic(PANIC.divisionByZero);
          return (a as bigint) % (b as bigint);
        };
      }
      case '+%': {
        return (a, b) => wrap((a as bigint) + (b as bigint));
      }
      case '-%': {
        return (a, b) => wrap((a as bigint) - (b as bigint));
      }
      case '*%': {
        return (a, b) => wrap((a as bigint) * (b as bigint));
      }
      case '+|': {
        return (a, b) => clamp((a as bigint) + (b as bigint));
      }
      case '-|': {
        return (a, b) => clamp((a as bigint) - (b as bigint));
      }
      case '*|': {
        return (a, b) => clamp((a as bigint) * (b as bigint));
      }
      case '&': {
        return (a, b) => (a as bigint) & (b as bigint);
      }
      case '|': {
        return (a, b) => (a as bigint) | (b as bigint);
      }
      case '^': {
        return (a, b) => (a as bigint) ^ (b as bigint);
      }
      default: {
        return this.error(span, `演算子 ${operator} は、この採点環境では使えません。`);
      }
    }
  }

  private shift(expression: ExpressionOf<'binary'>, resultType: Type | undefined): TExpr {
    const left = this.compile(expression.left, resultType);
    const type = left.type;
    if (type.kind !== 'int' && type.kind !== 'comptime_int') {
      return this.error(expression, `シフトは整数の型にだけ使えます（${typeName(type)} 型です）。`);
    }
    if (type.kind !== 'int') {
      const right = this.compile(expression.right);
      const amount = this.knownValue(
        this.coerce(right, COMPTIME_INT, expression.right),
        'comptime_int のシフトの量'
      ) as bigint;
      const value = this.knownValue(left, 'comptime_int の値') as bigint;
      if (amount < 0n) this.error(expression.right, 'シフトの量が負の数です。');
      const result = expression.operator === '>>' ? value >> amount : value << amount;
      return known(type, result, expression);
    }
    const int = type;
    const amountType = log2IntType(int);
    const right = this.coerce(this.compile(expression.right, amountType), amountType, expression.right);
    const operation =
      expression.operator === '<<'
        ? (a: Value, b: Value): Value => shiftLeft(a as bigint, b as bigint, int)
        : expression.operator === '>>'
          ? (a: Value, b: Value): Value => shiftRight(a as bigint, b as bigint, int)
          : (a: Value, b: Value): Value => shiftLeftSaturating(a as bigint, b as bigint, int);
    if (left.known && right.known) return known(type, operation(left.value, right.value), expression);
    const evaluateLeft = left.eval;
    const evaluateRight = right.eval;
    return runtime(type, (frame) => operation(evaluateLeft(frame), evaluateRight(frame)), expression);
  }

  /** `a ++ b`: concatenates arrays whose lengths are known at compile time. */
  private concatenate(expression: ExpressionOf<'binary'>): TExpr {
    const left = this.compile(expression.left);
    const right = this.compile(expression.right);
    const a = this.arrayOperand(left, expression.left);
    const b = this.arrayOperand(right, expression.right);
    if (a.child !== b.child && !(a.child.kind === 'comptime_int' || b.child.kind === 'comptime_int')) {
      this.error(expression, `要素の型が違う配列はつなげられません（${typeName(a.child)} と ${typeName(b.child)}）。`);
    }
    const child = a.child.kind === 'comptime_int' ? b.child : a.child;
    const sentinel = a.sentinel !== undefined && a.sentinel === b.sentinel ? a.sentinel : undefined;
    const length = a.length + b.length;
    const arrayType = arrayOf(length, child, sentinel);
    this.storage.reserve(arrayType);
    const resultType = a.viaPointer ? pointerTo(arrayType, true) : arrayType;
    const build = (x: Value[], y: Value[]): Value => {
      const array = newArray(
        [...x, ...y].map((value) => copyForStorage(value)),
        sentinel
      );
      return a.viaPointer ? new Pointer(new Constant(array), 0) : array;
    };
    if (left.known && right.known) return known(resultType, build(a.read(left.value), b.read(right.value)), expression);
    const evaluateLeft = left.eval;
    const evaluateRight = right.eval;
    return runtime(resultType, (frame) => build(a.read(evaluateLeft(frame)), b.read(evaluateRight(frame))), expression);
  }

  /** `a ** n`: repeats an array a number of times known at compile time. */
  private repeat(expression: ExpressionOf<'binary'>): TExpr {
    const left = this.compile(expression.left);
    const count = Number(
      this.knownValue(
        this.coerce(this.compile(expression.right, USIZE), USIZE, expression.right),
        '** の回数'
      ) as bigint
    );
    const a = this.arrayOperand(left, expression.left);
    const arrayType = arrayOf(a.length * count, a.child, a.sentinel);
    const resultType = a.viaPointer ? pointerTo(arrayType, true) : arrayType;
    const build = (x: Value[]): Value => {
      const values: Value[] = [];
      for (let index = 0; index < count; index++) values.push(...x.map((value) => copyForStorage(value)));
      const array = newArray(values, a.sentinel);
      return a.viaPointer ? new Pointer(new Constant(array), 0) : array;
    };
    if (left.known) return known(resultType, build(a.read(left.value)), expression);
    const evaluate = left.eval;
    return runtime(resultType, (frame) => build(a.read(evaluate(frame))), expression);
  }

  private arrayOperand(
    operand: TExpr,
    span: Span
  ): {
    child: Type;
    length: number;
    sentinel?: Value;
    viaPointer: boolean;
    read: (value: Value) => Value[];
  } {
    const type = operand.type;
    if (type.kind === 'array') {
      return {
        child: type.child,
        length: type.length,
        sentinel: type.sentinel,
        viaPointer: false,
        read: (value) => (value as ZArray).values(),
      };
    }
    if (type.kind === 'pointer' && type.size === 'one' && type.child.kind === 'array') {
      const array = type.child;
      return {
        child: array.child,
        length: array.length,
        sentinel: array.sentinel,
        viaPointer: true,
        read: (value) => ((value as Pointer).load() as ZArray).values(),
      };
    }
    if (type.kind === 'struct' && type.isTuple) {
      const fields = type.fields ?? [];
      return {
        child: fields[0]?.type ?? COMPTIME_INT,
        length: fields.length,
        viaPointer: false,
        read: (value) => fields.map((field, index) => field.comptimeValue ?? (value as ZStruct).slots[index]),
      };
    }
    return this.error(span, `++ と ** は、長さが決まった配列にだけ使えます（${typeName(type)} 型です）。`);
  }

  // Initializers ----------------------------------------------------------------------------------------------------

  // code-gauge-allow functionNcss 32 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  // code-gauge-allow functionCognitiveComplexity 26 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  protected structInit(expression: ExpressionOf<'structInit'>, resultType: Type | undefined): TExpr {
    const type = expression.type ? this.compileType(expression.type) : resultType && unwrapResult(resultType);
    if (!type) return this.anonymousStruct(expression);
    if (type.kind === 'array' && expression.fields.length === 0) {
      if (type.length > 0) this.error(expression, `長さ ${type.length} の配列を、空の {} で初期化しています。`);
      return known(type, newArray([], type.sentinel), expression);
    }
    if (type.kind === 'struct' && type.isTuple && expression.fields.length === 0) {
      return this.coerce(known(this.tupleType([]), new ZStruct([]), expression), type, expression);
    }
    if (type.kind === 'union') return this.unionInit(expression, type);
    if (type.kind === 'pointer' && type.size === 'slice' && expression.fields.length === 0 && !expression.type) {
      return known(type, new Slice(new ZArray([]), 0, 0), expression);
    }
    if (type.kind !== 'struct') {
      if (!expression.type && resultType) return this.anonymousStruct(expression);
      return this.error(expression, `${typeName(type)} 型は、{ .x = ... } の形では初期化できません。`);
    }
    const fields = this.structFields(type, expression);
    for (const init of expression.fields) {
      if (!fields.some((field) => field.name === init.name)) {
        this.error(init, `${typeName(type)} 型には、フィールド「${init.name}」がありません。`);
      }
      if (expression.fields.filter((other) => other.name === init.name).length > 1) {
        this.error(init, `フィールド「${init.name}」を2回初期化しています。`);
      }
    }
    const elements = fields.map((field) => {
      const init = expression.fields.find((each) => each.name === field.name);
      if (!init) {
        if (!field.hasDefault) this.error(expression, `フィールド「${field.name}」の値がありません。`);
        return known(field.type, field.defaultValue, expression);
      }
      return this.coerce(this.compile(init.value, field.type), field.type, init.value);
    });
    return this.aggregate(type, elements, expression, (values) => new ZStruct(values));
  }

  private unionInit(expression: ExpressionOf<'structInit'>, type: Extract<Type, { kind: 'union' }>): TExpr {
    if (expression.fields.length !== 1) this.error(expression, 'union は、フィールドを1つだけ初期化してください。');
    const [init] = expression.fields;
    const fields = this.unionFields(type);
    const index = fields.findIndex((field) => field.name === init.name);
    if (index === -1) return this.error(init, `${typeName(type)} 型には、フィールド「${init.name}」がありません。`);
    const value = this.coerce(this.compile(init.value, fields[index].type), fields[index].type, init.value);
    return this.derived(value, type, (payload) => new ZUnion(index, copyForStorage(payload)));
  }

  /** `.{ .x = 1 }` without a result type, whose type is an anonymous struct of the fields' types. */
  private anonymousStruct(expression: ExpressionOf<'structInit'>): TExpr {
    const values = expression.fields.map((init) => this.compile(init.value));
    const fields: StructField[] = expression.fields.map((init, index) => ({
      name: init.name,
      type: values[index].type,
      hasDefault: false,
      comptimeValue: isComptimeOnly(values[index].type) ? values[index].value : undefined,
    }));
    const type = this.anonymousStructType(fields);
    return this.aggregate(type, values, expression, (slots) => new ZStruct(slots));
  }

  private anonymousStructType(fields: StructField[]): StructType {
    const key = fields
      .map((field) => {
        const known = field.comptimeValue === undefined ? '' : `=${valueKey(field.comptimeValue)}`;
        return `${field.name}:${typeName(field.type)}${known}`;
      })
      .join(',');
    let type = this.anonymousTypes.get(key);
    if (!type) {
      type = {
        kind: 'struct',
        isTuple: false,
        namespace: { name: `anonymous struct { ${key} }`, decls: new Map() },
        layout: 'auto',
        fields,
      };
      this.anonymousTypes.set(key, type);
    }
    return type;
  }

  private readonly anonymousTypes = new Map<string, StructType>();
  private readonly tupleTypes = new Map<string, StructType>();

  tupleType(fields: StructField[]): StructType {
    const key = fields
      .map((field) =>
        field.comptimeValue === undefined
          ? typeName(field.type)
          : `${typeName(field.type)}=${valueKey(field.comptimeValue)}`
      )
      .join(',');
    let type = this.tupleTypes.get(key);
    if (!type) {
      type = {
        kind: 'struct',
        isTuple: true,
        namespace: { name: 'tuple', decls: new Map() },
        layout: 'auto',
        fields,
      };
      this.tupleTypes.set(key, type);
    }
    return type;
  }

  // code-gauge-allow functionNcss 36 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  // code-gauge-allow functionCognitiveComplexity 24 -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  protected arrayInit(expression: ExpressionOf<'arrayInit'>, resultType: Type | undefined): TExpr {
    let type: Type | undefined;
    if (expression.type) {
      if (expression.type.kind === 'arrayType' && expression.type.count === undefined) {
        const child = this.compileType(expression.type.child);
        const sentinel = expression.type.sentinel ? this.sentinelValue(expression.type.sentinel, child) : undefined;
        type = arrayOf(expression.elements.length, child, sentinel);
      } else {
        type = this.compileType(expression.type);
      }
    } else if (resultType) {
      type = unwrapResult(resultType);
    }
    if (type?.kind === 'pointer' && type.size === 'slice' && !expression.type) {
      // `.{ 1, 2 }` for a slice of constants is a pointer to a constant array.
      const array = arrayOf(expression.elements.length, type.child, type.sentinel);
      const initialized = this.arrayInit(expression, array);
      return this.coerce(this.addressOf(initialized), type, expression);
    }
    if (type?.kind === 'pointer' && type.size === 'one' && type.child.kind === 'array' && !expression.type) {
      return this.coerce(this.addressOf(this.arrayInit(expression, type.child)), type, expression);
    }
    if (type?.kind === 'array') {
      const array = type;
      if (array.length !== expression.elements.length) {
        this.error(
          expression,
          `配列の長さが合いません（${array.length} 個が必要ですが、${expression.elements.length} 個です）。`
        );
      }
      const elements = expression.elements.map((element) =>
        this.coerce(this.compile(element, array.child), array.child, element)
      );
      return this.aggregate(array, elements, expression, (values) => newArray(values, array.sentinel));
    }
    if (type?.kind === 'struct' && type.isTuple) {
      const fields = this.structFields(type, expression);
      if (fields.length !== expression.elements.length) this.error(expression, 'タプルの要素の数が合いません。');
      const elements = expression.elements.map((element, index) =>
        this.coerce(this.compile(element, fields[index].type), fields[index].type, element)
      );
      return this.aggregate(type, elements, expression, (values) => new ZStruct(values));
    }
    if (type && type.kind !== 'struct') {
      return this.error(expression, `${typeName(type)} 型は、{ 1, 2 } の形では初期化できません。`);
    }
    // A tuple, whose fields are the elements' types.
    const values = expression.elements.map((element) => this.compile(element));
    const fields: StructField[] = values.map((value, index) => ({
      name: String(index),
      type: value.type,
      hasDefault: false,
      comptimeValue: value.known ? value.value : undefined,
    }));
    const tuple = this.tupleType(fields);
    return this.aggregate(tuple, values, expression, (slots) => new ZStruct(slots));
  }

  private arrayTypeExpression(expression: ExpressionOf<'arrayType'>): TExpr {
    if (!expression.count)
      return this.error(expression, '配列の長さを [_] で省くのは、[_]i32{ 1, 2 } のような初期化のときだけです。');
    const length = this.knownValue(
      this.coerce(this.compile(expression.count, USIZE), USIZE, expression.count),
      '配列の長さ'
    ) as bigint;
    const child = this.compileType(expression.child);
    const sentinel = expression.sentinel ? this.sentinelValue(expression.sentinel, child) : undefined;
    return known(TYPE, arrayOf(Number(length), child, sentinel), expression);
  }

  /** Makes a container type from a declaration, to name it after the declaration. */
  protected declareContainer(syntax: ExpressionOf<'container'>, name: string): Type {
    const type = this.containerType(syntax, name);
    void addDecls;
    return type;
  }

  isTypeValue(value: Value): value is Type {
    return isType(value);
  }

  static nativeFnValue(fn: NativeFn): Value {
    return fn as unknown as Value;
  }

  protected isAnonymousStruct(type: StructType): boolean {
    return isAnonymous(type);
  }

  protected mismatch(expected: Type, found: Type): string {
    return mismatch(expected, found);
  }

  protected intBounds(type: IntType): [bigint, bigint] {
    return [minInt(type), maxInt(type)];
  }

  protected newJump(kind: Jump['kind'], target: object, value: Value): Jump {
    return new Jump(kind, target, value);
  }

  protected floatOfBits(value: BigFloat, bits: FloatBits): AnyFloat {
    return floatOf(value, bits);
  }

  protected floatMod(a: AnyFloat, b: AnyFloat, bits: FloatBits): AnyFloat {
    return floatMod(a, b, bits);
  }

  protected divExact(a: bigint, b: bigint, type: IntType): bigint {
    return divExact(a, b, type);
  }

  protected noSlot(): number {
    return this.localSlot();
  }
}

/** The payload of an optional whose payload is itself optional, as storage that `.?` points into. */
class SomeSlots implements Slots {
  constructor(private readonly pointer: Pointer) {}

  get slots(): Value[] {
    const some = this.pointer.load() as Some;
    const holder = this.pointer;
    return new Proxy([some.value], {
      set: (_, key, value) => {
        if (key === '0') holder.target.slots[holder.index] = new Some(value as Value);
        return true;
      },
    });
  }
}

/** A text that tells known values apart, for interning the types that carry them. */
function valueKey(value: Value): string {
  if (value instanceof BigFloat) return `f${value.kind}${value.sign}${value.mantissa}e${value.exponent}`;
  if (typeof value === 'number') return `n${Object.is(value, -0) ? '-0' : String(value)}`;
  if (typeof value === 'bigint' || typeof value === 'boolean' || value === undefined)
    return `${typeof value}${String(value)}`;
  if (value instanceof EnumLiteral || value instanceof ErrorValue) return `${value.constructor.name}.${value.name}`;
  if (value === NULL) return 'null';
  if (isType(value)) return `type ${typeName(value)}`;
  return `object ${objectId(value)}`;
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function objectId(value: object): number {
  let id = objectIds.get(value);
  if (id === undefined) {
    id = nextObjectId++;
    objectIds.set(value, id);
  }
  return id;
}

function unwrapOptionalValue(value: Value): Value {
  if (value === NULL) nullUnwrapPanic();
  return optionalPayload(value);
}

function optionalPayload(value: Value): Value {
  return value instanceof Some ? value.value : value;
}

/** The shift amount's type for an integer type: `u5` for 32 bits, as `std.math.Log2Int` gives. */
export function log2IntType(type: IntType): IntType {
  let bits = 0;
  while (2 ** bits < type.bits) bits++;
  return intType(false, bits);
}

function staticLength(type: Type): number | undefined {
  if (type.kind === 'array') return type.length;
  if (type.kind === 'pointer' && type.size === 'one' && type.child.kind === 'array') return type.child.length;
  return undefined;
}

function hasSentinel(type: Type): boolean {
  if (type.kind === 'array') return type.sentinel !== undefined;
  if (type.kind === 'pointer')
    return type.size === 'one' && type.child.kind === 'array'
      ? type.child.sentinel !== undefined
      : type.sentinel !== undefined;
  return false;
}

function isConstIndexable(type: Type, place: Place | undefined): boolean {
  if (type.kind === 'array') return place ? place.isConst : true;
  if (type.kind === 'pointer') return type.isConst;
  return true;
}

function isConstantData(value: Value): boolean {
  return value instanceof Pointer && value.target instanceof Constant;
}

function elementSlots(value: Value, type: Type): { slots: Value[]; start: number } {
  if (type.kind === 'array') return { slots: (value as ZArray).slots, start: (value as ZArray).offset };
  if (value instanceof Pointer) {
    const array = value.load() as ZArray;
    return { slots: array.slots, start: array.offset };
  }
  const slice = value as Slice;
  return { slots: slice.target.slots, start: slice.start };
}

/** The type that a result type asks an initializer for, looking through optionals and error unions. */
function unwrapResult(type: Type): Type {
  if (type.kind === 'optional') return unwrapResult(type.child);
  if (type.kind === 'error_union') return unwrapResult(type.payload);
  return type;
}

export { Constant, CONST_U8_SLICE, NativeFn };

/** The type an operand compared with a value of `type` takes: the tag type for a tagged union. */
function unionTag(type: Type): Type {
  return type.kind === 'union' && type.tagType ? type.tagType : type;
}
