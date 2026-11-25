import { alignmentOperand } from './admissibility';
import { valueSlots } from './allocation';
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
import { activeUnionIndex, packedValuesEqual, physicalUnion } from './bufferMemory';
import { enumLookup } from './enumLookup';
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
import { integerOperationWork, type IntegerWork, spendIntegerOperation, spendIntegerShift } from './integerWork';
import { errorUnionOffsets, fieldOffsets, optionalNicheBits, sizeOf, unionOffsets } from './layout';
import { isPublicStdMember } from './library/native';
import { valuesEqual } from './library/valueEquality';
import { memorySpace, spendMemory } from './memoryAccounting';
import { MemoryFault } from './memoryFault';
import { callableNative } from './nativeAdapter';
import { asFloat, comparisonTest, isArithmeticType, isIntegerType, isZero, sign } from './operands';
import { sliceLengthPointer } from './pointerViews';
import { type Frame, Jump, withHeldValues } from './runtime';
import {
  addDecls,
  copyForFrame,
  copyForStorage,
  evaluateHeld,
  FnRef,
  isAnonymous,
  isType,
  known,
  knownLengthOf,
  type LocalBinding,
  mismatch,
  NativeFn,
  newArray,
  nullUnwrapPanic,
  type Place,
  POINTER_OPERATIONS,
  pointerShapeOf,
  runtime,
  type Scope,
  SemaBase,
  staticResultOf,
  type TExpr,
  undefinedValue,
  valueEvaluators,
} from './semaBase';
import { singleValueOf } from './singleValue';
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
  maxInt,
  minInt,
  NULL_TYPE,
  optionalOf,
  pointerOf,
  pointerTo,
  primitiveType,
  sameSentinel,
  Sentinel,
  sliceOf,
  type StructField,
  type StructType,
  TYPE,
  type Type,
  typeId,
  typeName,
  U8,
  UNDEFINED_TYPE,
  USIZE,
  wrapInt,
} from './types';
import { unavailableMessage } from './unavailable';
import { concatenatedFacts, fieldFacts, payloadFacts, valueFactsOf } from './valueFacts';
import {
  arrayPointerView,
  compileTimeReadable,
  EnumLiteral,
  ErrorValue,
  FnValue,
  hasAggregateStorage,
  hasUndefinedHeader,
  markConstantStorage,
  NULL,
  optionalPayload,
  Pointer,
  registerStorageLocation,
  scalarValuesEqual,
  Slice,
  type Slots,
  Some,
  storageLocation,
  type Value,
  ZArray,
  zeroArrayElement,
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

const rawArithmeticOperations: Partial<Record<ExpressionOf<'binary'>['operator'], (a: bigint, b: bigint) => bigint>> = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '%': (a, b) => a % b,
};

const RUNTIME_COMPTIME_VAR_POSITION = '実行時に決まる位置で、comptime var を指すことはできません。';

export abstract class ExpressionCompiler extends SemaBase {
  private readonly constants = new Map<string, Constant>();

  // Abstract parts that later layers compile.
  protected abstract compileCall(expression: ExpressionOf<'call'>, resultType: Type | undefined): TExpr;
  protected abstract compileBuiltin(expression: ExpressionOf<'builtinCall'>, resultType: Type | undefined): TExpr;
  protected abstract checkBuiltinAvailable(expression: ExpressionOf<'builtinCall'>): void;
  protected abstract compileControl(expression: Expression, resultType: Type | undefined): TExpr;
  protected abstract compileTry(expression: ExpressionOf<'try'>, resultType: Type | undefined): TExpr;
  protected abstract compileCatch(expression: ExpressionOf<'catch'>, resultType: Type | undefined): TExpr;
  protected abstract localSlot(): number;

  compile(expression: Expression, resultType?: Type): TExpr {
    this.compilationBudget.spend();
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
        return this.identifier(expression.name, expression, expression.quotedName);
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
        this.checkBuiltinAvailable(expression);
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
      case 'pointerType':
      case 'sliceType': {
        return known(TYPE, this.pointerTypeExpression(expression), expression);
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
      case 'comptime': {
        return this.comptimeValue(() => this.compile(expression.operand, resultType), expression);
      }
      case 'nosuspend': {
        return this.compile(expression.operand, resultType);
      }
      case 'async': {
        return this.error(
          expression,
          'async の機能（suspend・resume・anyframe）は、Zig 0.17 の処理系でまだ実装されていません。'
        );
      }
    }
  }

  private pointerTypeExpression(expression: ExpressionOf<'pointerType' | 'sliceType'>): Type {
    const child = this.compileType(expression.child);
    const size = expression.kind === 'sliceType' ? 'slice' : expression.size;
    if (expression.bitRange) this.error(expression, unavailableMessage('syntax:packedFieldPointer'));
    if (expression.addressSpace) this.addressSpace(expression.addressSpace);
    const sentinel = expression.sentinel ? this.sentinelValue(expression.sentinel, child) : undefined;
    return pointerOf(size, child, {
      isConst: expression.isConst,
      isVolatile: expression.isVolatile,
      allowZero: expression.allowZero,
      alignment: expression.alignment ? alignmentOperand(this, expression.alignment) : undefined,
      sentinel,
    });
  }

  /** `addrspace(.generic)`; the others name address spaces of particular CPUs. */
  protected addressSpace(expression: Expression): void {
    if (expression.kind !== 'enumLiteral' || expression.name !== 'generic')
      this.error(expression, unavailableMessage('syntax:addrspace'));
  }

  // Names -----------------------------------------------------------------------------------------------------------

  protected identifier(name: string, span: Span, quotedName = false): TExpr {
    const binding = this.lookup(name);
    if (!binding) {
      // tree-sitter's grammar lacks some primitive type names, such as `f80`.
      const primitive = primitiveType(name);
      if (primitive && !quotedName) return known(TYPE, primitive, span);
      return this.error(span, `「${name}」は宣言されていません。`);
    }
    if (binding.kind === 'local') return this.localReference(binding, span);
    return this.resolveDecl(binding, span);
  }

  // code-gauge-allow functionCognitiveComplexity -- Distinguishes the kinds of locals that a name may refer to, as Zig's Sema does.
  protected localReference(binding: LocalBinding, span: Span): TExpr {
    const cell = binding.comptimeCell;
    if (cell) {
      const place: Place = {
        isConst: false,
        locate: () => new Pointer(cell, 0),
        compileTimePointer: new Pointer(cell, 0),
        comptimeVar: binding,
      };
      // Code that the compiler runs reads the variable when it runs; other code, its value where the code stands.
      if (this.readsComptimeVarLive(binding))
        return { ...runtime(binding.type, () => cell.slots[0], span, place), local: binding };
      // A value read here is a constant of the code that stands here, which later stores must not change: its parts
      // come from a copy, while stores still reach the variable.
      return {
        ...known(binding.type, copyForStorage(cell.slots[0]), span),
        place: { ...place, snapshot: true },
        local: binding,
      };
    }
    const fact = binding.known
      ? { value: binding.value }
      : binding.isConst
        ? singleValueOf(binding.type, () => this.spendCompilation())
        : undefined;
    let crossedNamespace = false;
    for (let scope: Scope | undefined = this.scope; scope; scope = scope.parent) {
      if (scope.locals?.get(binding.name) === binding) {
        if (crossedNamespace) {
          if (!binding.isConst || !fact)
            return this.error(span, `「${binding.name}」は、内側の関数や型から参照できません。`);
          return known(binding.type, fact.value, span);
        }
        break;
      }
      crossedNamespace ||= scope.namespace !== undefined;
    }
    const { slot } = binding;
    const place: Place = {
      isConst: binding.isConst,
      locate: (frame) => new Pointer(frame, slot),
      alignment: binding.alignment,
    };
    if (fact) return { ...known(binding.type, fact.value, span), place, local: binding };
    return {
      ...runtime(binding.type, (frame) => frame.slots[slot], span, place),
      knownLength: binding.knownLength,
      valueFacts: binding.valueFacts,
      local: binding,
    };
  }

  private enumLiteral(name: string, span: Span, resultType: Type | undefined): TExpr {
    const literal = known(ENUM_LITERAL, EnumLiteral.of(name), span);
    if (!resultType) return literal;
    const target = unwrapResult(resultType);
    const decl = this.findDecl(target, name);
    if (decl) return this.requireKnownDeclarationLiteral(this.resolveDecl(decl, span), span);
    if (target.kind === 'enum' || target.kind === 'union') return this.coerce(literal, target, span);
    return literal;
  }

  protected requireKnownDeclarationLiteral(value: TExpr, span: Span): TExpr {
    if (value.known) return value;
    this.resolveStorage(value.type, span);
    const singleton = singleValueOf(value.type, () => this.spendCompilation());
    if (singleton) return known(value.type, singleton.value, span);
    return this.error(span, '宣言リテラルはコンパイルのときに値が決まっていなければなりません。');
  }

  findDecl(type: Type, name: string): Decl | undefined {
    if (type.kind === 'struct' || type.kind === 'enum' || type.kind === 'union') return type.namespace.decls.get(name);
    return undefined;
  }

  protected stringLiteral(bytes: readonly number[], span: Span): TExpr {
    const type = arrayOf(bytes.length, U8, 0n);
    const value = new ZArray([...bytes.map(BigInt), 0n], 0, bytes.length, true);
    return known(pointerTo(type, true), this.constantPointer(type, value), span);
  }

  private constantPointer(type: Type, value: Value): Pointer {
    const singleton = type.kind === 'array' ? singleValueOf(type, () => this.spendCompilation()) : undefined;
    if (singleton) value = singleton.value;
    const key = `${typeId(type)} ${constantKey(value, () => this.spendCompilation())}`;
    let storage = this.constants.get(key);
    if (!storage) {
      storage = new Constant(copyForStorage(value));
      markConstantStorage(storage, type);
      this.constants.set(key, storage);
    }
    return new Pointer(storage, 0);
  }

  // Field access ----------------------------------------------------------------------------------------------------

  // code-gauge-allow functionNcss -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  // code-gauge-allow functionCognitiveComplexity -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  protected fieldAccess(
    expression: ExpressionOf<'field'>,
    load = true,
    object = this.compileLocation(expression.object)
  ): TExpr {
    const { name } = expression;
    if (object.type.kind === 'type') {
      return this.typeMember(this.knownValue(object, '型') as Type, name, expression);
    }
    let base = object;
    let type = object.type;
    if (type.kind === 'pointer' && type.size === 'one') {
      if (type.child.kind === 'array') {
        if (name === 'len') return this.fixedResult(object, USIZE, type.child.length, expression);
        if (name === 'ptr' && POINTER_OPERATIONS[pointerShapeOf(type)].ptr) {
          const array = type.child;
          const many = pointerOf('many', array.child, {
            isConst: type.isConst,
            isVolatile: type.isVolatile,
            alignment: type.alignment,
            sentinel: array.sentinel,
          });
          return this.derived(object, many, (value) => {
            const view = arrayPointerView(value as Pointer, array, sizeOf(array.child));
            return new Pointer(view, view.offset);
          });
        }
        return this.error(expression, `配列へのポインタには、フィールド「${name}」がありません。`);
      }
      base = this.dereferenced(object, expression, false);
      type = base.type;
    }
    switch (type.kind) {
      case 'struct': {
        if (type.isTuple && name === 'len') {
          return this.fixedResult(
            this.typeOnlyOperand(base),
            COMPTIME_INT,
            BigInt(this.structFields(type, expression).length),
            expression
          );
        }
        return this.validateComptimeLoad(this.structField(base, type, name, expression), load);
      }
      case 'union': {
        return this.validateComptimeLoad(this.unionField(base, type, name, expression), load);
      }
      case 'array': {
        if (name === 'len') return this.fixedResult(this.typeOnlyOperand(base), USIZE, type.length, expression);
        break;
      }
      case 'pointer': {
        if (type.size === 'slice') {
          if (name === 'len') {
            this.checkMemoryHeader(base, expression);
            const evaluate = base.eval;
            const length = this.sliceLengthValue(base);
            if (length !== undefined) return this.fixedResult(base, USIZE, length, expression);
            const place = base.place;
            const lengthPlace: Place | undefined = place && {
              isConst: place.isConst,
              locate: (frame) => sliceLengthPointer(place.locate(frame)),
            };
            return runtime(USIZE, (frame) => (evaluate(frame) as Slice).lengthValue, expression, lengthPlace);
          }
          if (name === 'ptr' && POINTER_OPERATIONS[pointerShapeOf(type)].ptr) {
            this.checkMemoryHeader(base, expression);
            const many = pointerOf('many', type.child, {
              isConst: type.isConst,
              isVolatile: type.isVolatile,
              alignment: type.alignment,
              sentinel: type.sentinel,
            });
            return this.derived(base, many, (value) => new Pointer((value as Slice).target, (value as Slice).start));
          }
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
      const field = enumLookup(this.enumFields(type), () => this.spendCompilation()).byName.get(name);
      if (field) return known(type, field.value, span);
    }
    if (type.kind === 'union') {
      // The fields resolve first, which gives `union(enum)` its tag type.
      const hasField = this.fieldIndexes(this.unionFields(type)).has(name);
      if (hasField && type.tagType) return this.typeMember(type.tagType, name, span);
    }
    if (
      (type.kind === 'struct' || type.kind === 'enum' || type.kind === 'union') &&
      isPublicStdMember(type.namespace.name, name)
    )
      return this.error(span, `${type.namespace.name}.${name}は、この採点環境では使えません。`);
    return this.error(span, `${typeName(type)} には、「${name}」という宣言がありません。`);
  }

  private sliceLengthValue(value: TExpr): bigint | undefined {
    const fact = staticResultOf(value);
    if (fact?.value instanceof Slice) return fact.value.lengthValue;
    const length = knownLengthOf(value);
    return length;
  }

  private typeOnlyOperand(value: TExpr): TExpr {
    return value.place ? this.addressOf(value) : value;
  }

  protected structField(base: TExpr, type: StructType, name: string, span: Span): TExpr {
    const fields = this.structFields(type, span);
    let index = this.fieldIndexes(fields).get(name) ?? -1;
    if (index === -1 && type.isTuple && /^\d+$/.test(name)) index = Number(name);
    const field = fields[index] as StructField | undefined;
    if (!field) {
      if (this.findDecl(type, name)) {
        this.error(span, `「${name}」はフィールドではなく宣言です。呼び出すときは ${name}(...) と書きます。`);
      }
      if (type.native && isPublicStdMember(type.namespace.name, name))
        return this.error(span, `${typeName(type)}.${name}は、この採点環境では使えません。`);
      return this.error(span, `${typeName(type)} 型には、フィールド「${name}」がありません。`);
    }
    if (field.comptimeValue !== undefined) return this.fixedResult(base, field.type, field.comptimeValue.value, span);
    const project = this.fieldPointer(
      type,
      field.type,
      span,
      () => fieldOffsets(type)[index] / 8,
      (parent) => new Pointer(parent.load() as ZStruct, index)
    );
    const parent = this.knownAddress(base);
    // A pointer to a field carries the alignment that `align(n)` gives the field.
    const { alignment } = field;
    if (parent) {
      const atField = knownAt(field.type, project(parent), span);
      return alignment === undefined ? atField : { ...atField, place: { ...(atField.place as Place), alignment } };
    }
    const fieldPlace = this.projectedPlace(base, field.type, project, alignment);
    const facts = fieldFacts(valueFactsOf(base), index);
    const result = facts?.exact
      ? this.fixedResult(base, field.type, facts.exact.value, span)
      : this.derived(base, field.type, (value) => (value as ZStruct).slots[index]);
    return { ...result, valueFacts: facts, knownLength: facts?.length, place: fieldPlace, span };
  }

  private unionField(base: TExpr, type: Extract<Type, { kind: 'union' }>, name: string, span: Span): TExpr {
    const fields = this.unionFields(type);
    const index = this.fieldIndexes(fields).get(name) ?? -1;
    if (index === -1) return this.error(span, `${typeName(type)} 型には、フィールド「${name}」がありません。`);
    const field = fields[index];
    if (type.layout !== 'auto') {
      const view = (value: Value): Slots => physicalUnion(type, value as ZUnion).fieldView!(index);
      const project = this.fieldPointer(
        type,
        field.type,
        span,
        () => 0,
        (parent) => new Pointer(view(parent.load()), 0)
      );
      const parent = this.knownAddress(base);
      if (parent) return knownAt(field.type, project(parent), span);
      return {
        ...this.derived(base, field.type, (value) => view(value).slots[0]),
        span,
        place: this.projectedPlace(base, field.type, project),
      };
    }
    const check = (value: Value): ZUnion => {
      const union = value as ZUnion;
      const active = activeUnionIndex(union);
      if (active !== index) {
        panic(`access of union field '${name}' while field '${fields[active].name}' is active`);
      }
      return union;
    };
    const project = this.unionPayloadPointer(type, field.type, span, check);
    if (base.known) {
      const union = base.value as ZUnion;
      const active = activeUnionIndex(union);
      if (active !== index) {
        this.error(
          span,
          `union のフィールド「${name}」を読もうとしましたが、有効なのは「${fields[active].name}」です。`
        );
      }
      const parent = this.knownAddress(base);
      if (parent) return knownAt(field.type, project(parent), span);
    }
    const fieldPlace = this.projectedPlace(base, field.type, project);
    return {
      ...this.derived(base, field.type, (value) => check(value).slots[0]),
      valueFacts: fieldFacts(valueFactsOf(base), index),
      span,
      place: fieldPlace,
    };
  }

  protected unionPayloadPointer(
    type: Extract<Type, { kind: 'union' }>,
    child: Type,
    span: Span,
    check?: (value: Value) => ZUnion
  ): (parent: Pointer, value?: Value) => Pointer {
    const fixed = !this.requiresComptime(type, span) && sizeOf(child) !== 0;
    return this.fieldPointer(
      type,
      child,
      span,
      () => unionOffsets(type).payload,
      (parent, value) => {
        const source = value ?? parent.load();
        const union = check ? check(source) : (source as ZUnion);
        const slots = fixed ? physicalUnion(type, union).fieldView!(activeUnionIndex(union)) : union;
        return new Pointer(slots, 0);
      }
    );
  }

  private fieldPointer(
    base: Type,
    child: Type,
    span: Span,
    offsetOf: () => number,
    project: (parent: Pointer, value?: Value) => Pointer
  ): (parent: Pointer, value?: Value) => Pointer {
    const comptime = this.requiresComptime(base, span);
    if (comptime) return project;
    const zero = sizeOf(child) === 0;
    if (!zero && !hasAggregateStorage(child)) return project;
    const offset = offsetOf();
    if (sizeOf(base) === 0) return (parent) => this.zeroPointerAt(parent.fieldLocation(offset), child);
    return (parent, value) => {
      const target = project(parent, value);
      return zero
        ? this.zeroPointerAt(target.projectedLocation() ?? parent.fieldLocation(offset), child)
        : target.withFieldLocation(parent, offset);
    };
  }

  private projectedPlace(
    base: TExpr,
    child: Type,
    project: (parent: Pointer) => Pointer,
    alignment?: number
  ): Place | undefined {
    const place = base.place;
    if (!place) return undefined;
    const stable = base.type.kind !== 'union' || staticResultOf(base) !== undefined;
    const addressType = pointerOf('one', child, { isConst: place.isConst, alignment });
    return {
      isConst: place.isConst,
      alignment,
      comptimeVar: place.comptimeVar,
      locate: (frame) => project(place.locate(frame)),
      compileTimePointer: stable && place.compileTimePointer ? project(place.compileTimePointer) : undefined,
      address: () => {
        const parent = this.addressOf(base);
        return stable
          ? this.derived(parent, addressType, (value) => project(value as Pointer))
          : runtime(addressType, (frame) => project(parent.eval(frame) as Pointer), base.span);
      },
    };
  }

  // Pointers --------------------------------------------------------------------------------------------------------

  /**
   * A C pointer known to be null, as one the program holds when it runs: Zig checks a C pointer where the program uses
   * it, so `.*`, `.?`, and an index of a known null fail when they run, not when they compile.
   */
  private nullCPointerAtRuntime(pointer: TExpr): TExpr {
    const isNullC =
      pointer.type.kind === 'pointer' && pointer.type.size === 'c' && staticResultOf(pointer)?.value === NULL;
    if (!isNullC) return pointer;
    const evaluate = pointer.eval;
    return { ...runtime(pointer.type, (frame) => evaluate(frame), pointer.span), place: pointer.place };
  }

  /**
   * A pointer or slice into a `comptime var`, which the compiler knows and remembers the variable of, since code that
   * runs when the program runs holds none.
   */
  protected comptimeVarReference(reference: TExpr, variable: LocalBinding | undefined): TExpr {
    if (!variable || this.context.comptimeDepth > 0) return reference;
    if (!reference.known || !(reference.value instanceof Pointer || reference.value instanceof Slice))
      return this.error(reference.span, RUNTIME_COMPTIME_VAR_POSITION);
    this.comptimeVarReferences.set(reference.value, variable);
    return reference;
  }

  /** A read through a place in a `comptime var`, which takes the value where the code stands unless it runs at compile time. */
  protected comptimeVarRead(result: TExpr, place: Place): TExpr {
    const variable = place.comptimeVar;
    if (!variable || this.readsComptimeVarLive(variable) || !place.compileTimePointer) return result;
    return {
      ...known(result.type, copyForStorage(place.compileTimePointer.load()), result.span),
      place: { ...place, snapshot: true },
    };
  }

  /** `p.*`, or a pointer that a field access or an index goes through. */
  // code-gauge-allow functionCognitiveComplexity -- Checks each kind of pointer that `.*` may go through.
  protected dereferenced(pointer: TExpr, span: Span, load = true): TExpr {
    const type = pointer.type;
    if (type.kind === 'pointer' && type.size === 'c') {
      const single = this.derived(
        this.nullCPointerAtRuntime(pointer),
        pointerOf('one', type.child, { isConst: type.isConst }),
        (value) => {
          // Debug builds check a C pointer for null where it is used, as `.?` does.
          if (value === NULL) return nullUnwrapPanic();
          if (!(value instanceof Pointer)) throw new MemoryFault();
          return value;
        }
      );
      return this.dereferenced(single, span, load);
    }
    if (type.kind !== 'pointer' || type.size !== 'one') {
      if (type.kind === 'pointer' && type.size === 'many')
        return this.error(span, '多要素のポインタは .* で参照できません（p[0] のように添字を使います）。');
      return this.error(span, `${typeName(type)} 型はポインタではないので、.* で参照できません。`);
    }
    if (type.child.kind === 'fn') return { ...pointer, type: type.child, place: undefined, local: undefined };
    const comptime = this.requiresComptime(type.child, span);
    if (sizeOf(type.child) !== 0) this.checkMemoryOperand(pointer, span);
    const evaluate = pointer.eval;
    const zero = sizeOf(type.child) === 0 && !comptime;
    const place: Place = {
      isConst: type.isConst,
      address: () => pointer,
      locate: (frame) =>
        zero ? this.zeroPointer(evaluate(frame) as Pointer, type.child) : (evaluate(frame) as Pointer),
      compileTimePointer: pointer.known && pointer.value instanceof Pointer ? pointer.value : undefined,
      comptimeVar: this.comptimeVarOf(pointer),
    };
    if (zero) return { ...this.fixedResult(pointer, type.child, undefinedValue(type.child), span), place };
    const fact = staticResultOf(pointer);
    const result =
      type.isConst && isConstantData(fact?.value)
        ? { ...this.derived(pointer, type.child, (value) => (value as Pointer).load()), span, place }
        : runtime(type.child, (frame) => (evaluate(frame) as Pointer).load(), span, place);
    return this.validateComptimeLoad(this.comptimeVarRead(result, place), load);
  }

  private validateComptimeLoad(expression: TExpr, load = true): TExpr {
    if (load && this.requiresComptime(expression.type, expression.span) && !staticResultOf(expression))
      this.error(expression.span, 'コンパイルのときだけの型は、実行時のポインタから読み出せません。');
    return expression;
  }

  protected compileLocation(expression: Expression, resultType?: Type): TExpr {
    if (expression.kind === 'paren') return this.compileLocation(expression.operand, resultType);
    if (expression.kind === 'field' || expression.kind === 'index') {
      this.compilationBudget.spend();
      return expression.kind === 'field' ? this.fieldAccess(expression, false) : this.index(expression, false);
    }
    if (expression.kind === 'deref') {
      this.compilationBudget.spend();
      return this.dereferenced(this.compile(expression.operand), expression, false);
    }
    if (expression.kind === 'unwrap') {
      this.spendCompilation();
      return this.unwrapOptional(expression, true);
    }
    return this.compile(expression, resultType);
  }

  protected zeroPointer(pointer: Pointer, type: Type, arrayAddress?: Value): Pointer {
    const location = arrayAddress instanceof Pointer ? arrayAddress.slotLocation() : pointer.storageLocation();
    return this.zeroPointerAt(location, type);
  }

  private zeroPointerAt(location: ReturnType<Pointer['storageLocation']>, type: Type): Pointer {
    let loaded: { value: Value } | undefined;
    const slots: Value[] = [];
    Object.defineProperty(slots, 0, {
      get: () => {
        if (!loaded) {
          const value = undefinedValue(type);
          if (value instanceof ZArray) registerStorageLocation(value.slots, () => location, true);
          loaded = { value };
        }
        return loaded.value;
      },
      set: (value: Value) => {
        loaded = { value };
      },
    });
    const storage = { slots };
    registerStorageLocation(storage.slots, () => location, true);
    return new Pointer(storage, 0);
  }

  private dereference(expression: ExpressionOf<'deref'>): TExpr {
    return this.dereferenced(this.compile(expression.operand), expression);
  }

  /** `&x`: a pointer to what an expression names, or to a temporary that holds its value. */
  addressOf(expression: TExpr): TExpr {
    const address = this.placeAddress(expression);
    const pointer = expression.place?.compileTimePointer;
    // A place in a `comptime var` is where the compiler keeps it, which its address is known to be.
    const fixed =
      !address.known && pointer && expression.place?.comptimeVar ? known(address.type, pointer, address.span) : address;
    return this.comptimeVarReference(fixed, expression.place?.comptimeVar);
  }

  private placeAddress(expression: TExpr): TExpr {
    const place = expression.place;
    const span = expression.span;
    if (expression.type.kind === 'fn' || expression.value instanceof FnRef) {
      return known(
        pointerTo(this.functionType(expression, span), true),
        this.knownFunctionValue(expression, span),
        span
      );
    }
    if (place?.address) return place.address();
    const placeType = (): Type =>
      pointerOf('one', expression.type, { isConst: place?.isConst ?? true, alignment: place?.alignment });
    if (place?.compileTimePointer) return known(placeType(), place.compileTimePointer, span);
    if (place && !expression.local) return runtime(placeType(), (frame) => place.locate(frame), span);
    if (expression.known && !expression.local?.alignment)
      return known(pointerTo(expression.type, true), this.constantPointer(expression.type, expression.value), span);
    if (place) return runtime(placeType(), (frame) => place.locate(frame), span);
    const result = staticResultOf(expression);
    if (result)
      return this.fixedResult(
        expression,
        pointerTo(expression.type, true),
        this.constantPointer(expression.type, result.value)
      );
    const evaluate = expression.eval;
    return runtime(pointerTo(expression.type, true), (frame) => new Pointer(new Constant(evaluate(frame)), 0), span);
  }

  protected knownAddress(expression: TExpr): Pointer | undefined {
    if (!expression.known || expression.place?.snapshot) return undefined;
    const address = this.addressOf(expression);
    return address.known && address.value instanceof Pointer ? address.value : undefined;
  }

  private functionType(expression: TExpr, span: Span): Type {
    const fn = this.functionOf(expression, span);
    return fnType(fn.params, fn.returnType);
  }

  knownFunctionValue(expression: TExpr, span: Span): FnValue {
    if (expression.value instanceof FnValue) return expression.value;
    if (expression.value instanceof NativeFn && expression.value.signature)
      return new FnValue(callableNative(this, expression.value, span));
    const ref = expression.value as unknown as FnRef;
    if (!(ref instanceof FnRef)) this.error(span, 'この関数は、値として使えません。');
    return new FnValue(this.instantiate(ref, [], span));
  }

  private unwrapOptional(expression: ExpressionOf<'unwrap'>, location = false): TExpr {
    const operand = location ? this.compileLocation(expression.operand) : this.compile(expression.operand);
    const type = operand.type;
    // `.?` checks a C pointer for null and keeps its type, though Zig refuses it where the result is a place.
    if (type.kind === 'pointer' && POINTER_OPERATIONS[pointerShapeOf(type)].unwrap && !location) {
      // Zig checks a known C pointer only where the program uses what `.?` gives.
      if (staticResultOf(operand)?.value === NULL) return this.nullCPointerAtRuntime(operand);
      return this.derived(operand, type, (value) => (value === NULL ? nullUnwrapPanic() : value));
    }
    if (type.kind !== 'optional')
      return this.error(expression, `${typeName(type)} 型は optional ではないので、.? は使えません。`);
    const child = type.child;
    this.checkMemoryHeader(operand, expression);
    if (location && operand.known && operand.value === NULL)
      return this.error(expression, 'null の optional は参照できません。');
    const parent = operand.value === NULL ? undefined : this.knownAddress(operand);
    if (parent) return knownAt(child, this.optionalPayloadPointer(parent, child), expression);
    const evaluate = operand.eval;
    const place = operand.place;
    const unwrapPlace: Place | undefined = place && {
      isConst: place.isConst,
      locate: (frame) => {
        const pointer = place.locate(frame);
        const value = pointer.load();
        if (value === NULL) nullUnwrapPanic();
        return this.optionalPayloadPointer(pointer, child);
      },
    };
    return {
      ...runtime(child, (frame) => unwrapOptionalValue(evaluate(frame)), expression, unwrapPlace),
      valueFacts: payloadFacts(operand),
      knownLength: payloadFacts(operand)?.length,
      staticResult:
        staticResultOf(operand)?.value !== NULL
          ? this.constantResult([operand], ([value]) => unwrapOptionalValue(value), expression)
          : undefined,
    };
  }

  protected optionalPayloadPointer(pointer: Pointer, child: Type): Pointer {
    if (optionalNicheBits(child)) return pointer;
    const payload = this.taggedPayloadPointer(pointer, child, 0, (parent) => parent.project('optional'));
    return hasAggregateStorage(child) ? payload.withFieldLocation(pointer, 0) : payload;
  }

  protected errorUnionPayloadPointer(
    type: Extract<Type, { kind: 'error_union' }>,
    span: Span
  ): (parent: Pointer) => Pointer {
    if (this.requiresComptime(type, span)) return (parent) => parent;
    const { payload } = type;
    const offset = errorUnionOffsets(payload).payload;
    if (sizeOf(payload) === 0) return (parent) => this.zeroPointerAt(parent.fieldLocation(offset), payload);
    return (parent) => {
      const projection = this.taggedPayloadPointer(parent, payload, offset, (pointer) =>
        pointer.projectErrorPayload(offset)
      );
      return hasAggregateStorage(payload) ? projection.withFieldLocation(parent, offset) : projection;
    };
  }

  private taggedPayloadPointer(
    parent: Pointer,
    child: Type,
    offset: number,
    logical: (pointer: Pointer) => Pointer
  ): Pointer {
    const backing = memorySpace().typedViews.get(parent.target.slots);
    return backing
      ? new Pointer(backing.memory.arrayView(child, 1n, backing.offset(parent.index) + offset * 8), 0)
      : logical(parent);
  }

  // Indexing and slicing ----------------------------------------------------------------------------------------------

  protected index(expression: ExpressionOf<'index'>, load = true): TExpr {
    const object = this.nullCPointerAtRuntime(this.compileLocation(expression.object));
    const index = this.coerce(this.compile(expression.index, USIZE), USIZE, expression.index);
    const type = object.type;
    if (type.kind === 'struct' && type.isTuple) {
      const position = Number(this.knownValue(index, 'タプルの添字') as bigint);
      return this.structField(object, type, String(position), expression);
    }
    const child = indexableChild(type);
    if (!child) return this.error(expression, `${typeName(type)} 型には、添字が使えません。`);
    this.resolveStorage(child, expression);
    const stride = sizeOf(child);
    if (type.kind === 'pointer' && type.size === 'slice') this.checkMemoryHeader(object, expression);
    if (stride !== 0) this.checkMemoryOperand(object, expression);
    const zero = stride === 0 && !this.requiresComptime(child, expression);
    const length = knownLengthOf(object);
    if (index.known && length !== undefined && (index.value as bigint) >= length + (hasSentinel(type) ? 1n : 0n)) {
      this.error(expression.index, `添字 ${index.value as bigint} は、長さ ${length} の範囲の外です。`);
    }
    const isConst = isConstIndexable(type, object.place);
    const access = this.elementAccess(type, stride);
    const projectElement = (source: Value, position: bigint): Pointer => {
      const value =
        type.kind === 'array' && source instanceof Pointer ? arrayPointerView(source, type, stride) : source;
      const element = access(value, position);
      const pointer = new Pointer(element.slots, element.position);
      return zero ? this.zeroPointer(pointer, child, source) : pointer;
    };
    // Zig rejects a known index past the memory a known pointer points into, which reading it would fault on.
    const projectKnown = (source: Value, position: bigint): Pointer => {
      try {
        return projectElement(source, position);
      } catch (error) {
        if (error instanceof MemoryFault)
          this.error(expression, `添字 ${position} は、${typeName(type)} が指している先の範囲の外です。`);
        throw error;
      }
    };
    const arrayAddress = index.known && type.kind === 'array' ? this.knownAddress(object) : undefined;
    if (index.known && (arrayAddress || (object.known && type.kind !== 'array' && isConstantData(object.value)))) {
      const pointer = projectKnown(arrayAddress ?? object.value, index.value as bigint);
      return knownAt(child, pointer, expression);
    }
    const base = this.deferredLoad(object);
    const evaluateObject = base.operand.eval;
    const locatePointer = (frame: Frame): Pointer => {
      const value = evaluateObject(frame);
      return withHeldValues(
        frame,
        [value],
        () => {
          const position = index.eval(frame) as bigint;
          return projectElement(type.kind === 'array' ? value : base.read(value), position);
        },
        [base.operand.type]
      );
    };
    const staticSource =
      type.kind === 'array' ? object.place?.compileTimePointer : object.known ? object.value : undefined;
    const addressType = pointerTo(child, isConst);
    const place: Place = {
      isConst,
      comptimeVar: this.comptimeVarOf(object),
      address: () => ({
        ...runtime(addressType, locatePointer, expression),
        staticResult: this.constantResult(
          [type.kind === 'array' ? base.operand : object, index],
          ([value, position]) => projectKnown(value, position as bigint),
          expression
        ),
      }),
      locate: locatePointer,
      compileTimePointer:
        index.known && staticSource !== undefined ? projectKnown(staticSource, index.value as bigint) : undefined,
    };
    const facts =
      !zero && index.known && type.kind === 'array' ? fieldFacts(valueFactsOf(object), Number(index.value)) : undefined;
    const projected = runtime(child, (frame) => locatePointer(frame).load(), expression, place);
    const result = {
      ...(facts?.exact ? this.fixedResult(object, child, facts.exact.value, expression) : projected),
      place,
      valueFacts: facts,
      knownLength: facts?.length,
      staticResult:
        facts?.exact ??
        (type.kind === 'array' || isConstantData(staticResultOf(object)?.value)
          ? this.constantResult(
              [object, index],
              ([value, position]) => {
                const element = access(value, position as bigint);
                return zero ? undefinedValue(child) : element.slots.slots[element.position];
              },
              expression
            )
          : undefined),
    };
    return this.validateComptimeLoad(
      this.comptimeVarRead(result, place),
      load || (type.kind === 'pointer' && type.size === 'one')
    );
  }

  /** Locates the element at an index of an array, a pointer to one, or a slice, checking the bounds. */
  // code-gauge-allow functionCognitiveComplexity -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
  private elementAccess(
    type: Type,
    stride: number
  ): (value: Value, index: bigint) => { slots: Slots; position: number } {
    if (type.kind === 'array') {
      const limit = type.length + (type.sentinel === undefined ? 0n : 1n);
      return (value, index) => {
        const array = value as ZArray;
        if (index >= limit) indexOutOfBounds(index, type.length);
        return { slots: array, position: array.offset + Number(index) };
      };
    }
    if (type.kind === 'pointer' && type.size === 'one' && type.child.kind === 'array') {
      const array = type.child;
      const limit = array.length + (array.sentinel === undefined ? 0n : 1n);
      return (value, index) => {
        const target = arrayPointerView(value as Pointer, array, stride);
        if (index >= limit) indexOutOfBounds(index, array.length);
        return { slots: target, position: target.offset + Number(index) };
      };
    }
    if (type.kind === 'pointer' && (type.size === 'many' || type.size === 'c')) {
      // A many-item pointer has no length: reading past the memory it points into crashes, as Zig's would.
      return (value, index) => {
        const pointer = manyPointer(value);
        const position = pointer.index + Number(index);
        if (position < 0 || position >= pointer.target.slots.length) throw new MemoryFault();
        return { slots: pointer.target, position };
      };
    }
    const sentinel = type.kind === 'pointer' ? type.sentinel : undefined;
    return (value, index) => {
      const slice = value as Slice;
      const limit = slice.lengthValue + (sentinel === undefined ? 0n : 1n);
      if (index >= limit) indexOutOfBounds(index, slice.lengthValue);
      return { slots: slice.target, position: slice.start + Number(index) };
    };
  }

  private slice(expression: ExpressionOf<'slice'>): TExpr {
    const operand = this.compileLocation(expression.object);
    let type = operand.type;
    const start = this.coerce(this.compile(expression.start, USIZE), USIZE, expression.start);
    const end = expression.end ? this.coerce(this.compile(expression.end, USIZE), USIZE, expression.end) : undefined;
    // Slicing an array slices it where it lives, as through a pointer to it.
    let base = operand;
    if (type.kind === 'array') {
      if (!operand.place && !staticResultOf(operand))
        this.error(expression, 'この配列はスライスできません（変数に入れてください）。');
      base = this.addressOf(operand);
      type = base.type;
    }
    let child: Type;
    let isConst: boolean;
    let staticLen: bigint | undefined;
    let sourceSentinel: Sentinel | undefined;
    const many = type.kind === 'pointer' && POINTER_OPERATIONS[pointerShapeOf(type)].unbounded;
    if (type.kind === 'pointer' && many) {
      child = type.child;
      isConst = type.isConst;
      sourceSentinel = type.sentinel;
      if (!end) {
        if (expression.sentinel)
          this.error(expression, '終わりのない多要素のポインタのスライスには、番兵を書けません。');
        return this.combine(
          [operand, start],
          type,
          ([pointer, offset]) => {
            const { target, index } = manyPointer(pointer);
            return new Pointer(target, index + Number(offset as bigint));
          },
          expression
        );
      }
    } else if (type.kind === 'pointer' && type.size === 'one' && type.child.kind === 'array') {
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
    staticLen ??= knownLengthOf(base);
    const first = staticResultOf(start)?.value as bigint | undefined;
    const last = end ? (staticResultOf(end)?.value as bigint | undefined) : staticLen;
    const reachesSentinel = !end || (last !== undefined && staticLen !== undefined && last === staticLen);
    const sentinelExpression = expression.sentinel ? this.compileSentinel(expression.sentinel, child) : undefined;
    const sentinel = sentinelExpression
      ? new Sentinel(
          (staticResultOf(sentinelExpression) ?? { value: this.knownValue(sentinelExpression, '番兵') }).value
        )
      : reachesSentinel
        ? sourceSentinel
        : undefined;
    const limitOf = (length: bigint): bigint => length + (sourceSentinel === undefined ? 0n : 1n);
    if (first !== undefined && last !== undefined && first > last) {
      this.error(expression, `スライスの始まり ${first} が、終わり ${last} より大きくなっています。`);
    }
    const extra = sentinelExpression ? 1n : 0n;
    if (staticLen !== undefined && last !== undefined && last + extra > limitOf(staticLen)) {
      this.error(expression, `スライスの終わり ${last + extra} は、長さ ${staticLen} の範囲の外です。`);
    }
    if (staticLen !== undefined && first !== undefined && first > (end ? limitOf(staticLen) : staticLen)) {
      this.error(expression, `スライスの始まり ${first} は、長さ ${staticLen} の範囲の外です。`);
    }
    const resultLength = first !== undefined && last !== undefined ? last - first : undefined;
    const resultType =
      resultLength === undefined
        ? sliceOf(child, isConst, sentinel)
        : pointerTo(arrayOf(resultLength, child, sentinel), isConst);
    if (type.size === 'slice') this.checkMemoryHeader(operand, expression);
    if (resultLength !== undefined && (resultLength !== 0n || sentinel !== undefined))
      this.checkMemoryOperand(operand, expression);
    const arrayType =
      type.kind === 'pointer' && type.size === 'one' && type.child.kind === 'array' ? type.child : undefined;
    const zero = !this.requiresComptime(child, expression) && sizeOf(child) === 0;
    const loaded = this.deferredLoad(base);
    const operands = [
      loaded.operand,
      start,
      ...(end ? [end] : []),
      ...(sentinelExpression ? [sentinelExpression] : []),
    ];
    const render = ([baseValue, first, last]: Value[]): Value => {
      const value = loaded.read(baseValue);
      let target: Slots;
      let offset: number;
      let length: bigint;
      if (arrayType) {
        const pointer = value as Pointer;
        const array = zero
          ? (this.zeroPointerAt(pointer.slotLocation(), arrayType).load() as ZArray)
          : arrayPointerView(pointer, arrayType, sizeOf(child));
        target = array;
        offset = array.offset;
        length = staticLen as bigint;
      } else if (many) {
        const pointer = manyPointer(value);
        target = pointer.target;
        offset = pointer.index;
        length = BigInt(Math.max(target.slots.length - offset, 0));
        if (BigInt(offset) + (last as bigint) + extra > BigInt(target.slots.length)) throw new MemoryFault();
      } else {
        const slice = value as Slice;
        target = slice.target;
        offset = slice.start;
        length = slice.lengthValue;
      }
      const fromValue = first as bigint;
      const toValue = end ? (last as bigint) : length;
      if (toValue + extra > limitOf(length)) indexOutOfBounds(toValue + extra, limitOf(length));
      if (fromValue > toValue) panic(`start index ${fromValue} is larger than end index ${toValue}`);
      const from = offset + Number(fromValue),
        to = offset + Number(toValue);
      if (sentinelExpression && sentinel !== undefined) {
        const actual = sizeOf(child) === 0 ? undefinedValue(child) : target.slots[to];
        if (!scalarValuesEqual(actual, sentinel.value))
          panic(`sentinel mismatch: expected ${String(sentinel.value)}, found ${String(actual)}`);
      }
      if (resultLength === undefined) return new Slice(target, from, toValue - fromValue);
      const view = new Constant(new ZArray(target.slots, from, toValue - fromValue, sentinel !== undefined));
      if (zero) {
        const location = storageLocation(target.slots, from);
        registerStorageLocation(view.slots, () => location);
      }
      return new Pointer(view, 0);
    };
    // A slice of a comptime var, or of a slice known to refer into one, refers into the same variable.
    const variable = this.comptimeVarOf(loaded.operand) ?? this.comptimeVarOf(base);
    if (variable && this.context.comptimeDepth === 0) {
      if (!operands.every((each) => each.known)) return this.error(expression, RUNTIME_COMPTIME_VAR_POSITION);
      const slice = known(resultType, render(operands.map((each) => each.value as Value)), expression);
      return this.comptimeVarReference(slice, variable);
    }
    const evaluators = valueEvaluators(operands, false);
    return {
      ...runtime(resultType, (frame) => render(evaluateHeld(frame, evaluators)), expression),
      staticResult:
        sentinel === undefined || isConstantData(staticResultOf(base)?.value)
          ? this.constantResult(operands, render, expression)
          : undefined,
      knownLength: base.known || base.knownLength !== undefined ? resultLength : undefined,
    };
  }

  private deferredLoad(value: TExpr): { operand: TExpr; read: (value: Value) => Value } {
    return value.place
      ? { operand: this.addressOf(value), read: (value) => (value as Pointer).load() }
      : { operand: value, read: (value) => value };
  }

  private sentinelValue(expression: Expression, child: Type): Sentinel {
    return new Sentinel(this.knownValue(this.compileSentinel(expression, child), '番兵'));
  }

  private compileSentinel(expression: Expression, child: Type): TExpr {
    let scalar = child;
    while (scalar.kind === 'optional') {
      this.spendCompilation();
      scalar = scalar.child;
    }
    switch (scalar.kind) {
      case 'int':
      case 'float':
      case 'comptime_int':
      case 'comptime_float':
      case 'void':
      case 'bool':
      case 'type':
      case 'enum':
      case 'enum_literal':
      case 'error_set':
      case 'fn': {
        return this.coerce(this.compile(expression, child), child, expression);
      }
      case 'pointer': {
        if (scalar.size !== 'slice') return this.coerce(this.compile(expression, child), child, expression);
        break;
      }
      default: {
        break;
      }
    }
    return this.error(expression, `番兵の型はスカラー型にしてください（${typeName(child)} 型です）。`);
  }

  // Operators -------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity -- Keeps each numeric unary operation with its type checks and evaluation.
  private unary(expression: ExpressionOf<'unary'>, resultType: Type | undefined): TExpr {
    if (expression.operator === '&') return this.addressOperand(expression, resultType);
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
        return this.integerUnary(operand, (value) => wrapInt(~value, type));
      }
      case '-': {
        if (type.kind === 'comptime_int') return this.integerUnary(operand, (value) => -value);
        if (type.kind === 'int') {
          if (!type.signed) this.error(expression, `符号なしの整数 ${typeName(type)} には、- を付けられません。`);
          return this.integerUnary(operand, (value) =>
            operand.known ? this.checkedKnown(-value, type, expression) : checked(-value, type)
          );
        }
        if (type.kind === 'float' || type.kind === 'comptime_float')
          return this.derived(operand, type, (v) => negate(v as AnyFloat));
        return this.error(expression, `- は、数の型にだけ使えます（${typeName(type)} 型です）。`);
      }
      case '-%': {
        if (type.kind === 'int') return this.integerUnary(operand, (value) => wrapInt(-value, type));
        if (type.kind === 'comptime_int') return this.integerUnary(operand, (value) => -value);
        return this.error(expression, `-% は、整数の型にだけ使えます（${typeName(type)} 型です）。`);
      }
    }
  }

  private integerUnary(operand: TExpr, compute: (value: bigint) => bigint): TExpr {
    return this.derived(operand, operand.type, (value, frame) => {
      this.integerWork(value as bigint, 0n, 'read', frame);
      return compute(value as bigint);
    });
  }

  private addressOperand(expression: ExpressionOf<'unary'>, resultType: Type | undefined): TExpr {
    const pointerType = resultType && unwrapResult(resultType);
    let operandType = pointerType?.kind === 'pointer' ? pointerType.child : undefined;
    // A slice or many-item pointer points to an array of its elements; a C pointer takes no array literal, as in Zig.
    const many =
      pointerType?.kind === 'pointer' && pointerType.size !== 'one' && pointerType.size !== 'c'
        ? pointerType
        : undefined;
    if (many && expression.operand.kind === 'arrayInit' && !expression.operand.type) {
      operandType = arrayOf(expression.operand.elements.length, many.child, many.sentinel);
    }
    if (
      many &&
      expression.operand.kind === 'structInit' &&
      !expression.operand.type &&
      expression.operand.fields.length === 0
    ) {
      operandType = arrayOf(0, many.child, many.sentinel);
    }
    let operand = this.compileLocation(expression.operand, operandType);
    // A pointer to many elements takes the operand's own type, which it then coerces from.
    const valueType = pointerType?.kind === 'pointer' && pointerType.size !== 'one' ? undefined : operandType;
    if (!operand.place && valueType && operand.type !== valueType)
      operand = this.coerce(operand, valueType, expression.operand);
    return this.addressOf(operand);
  }

  protected checkedKnown(value: bigint, type: IntType, span: Span): bigint {
    if (!fitsInt(value, type)) this.error(span, `整数 ${typeName(type)} があふれます（値は ${value}）。`);
    return value;
  }

  // code-gauge-allow functionNcss -- One case per kind of syntax node, type, or format specifier, as Zig defines them.
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

  /** `p + n` and `p - n` on a many-item pointer, which moves it by `n` elements. */
  private pointerArithmetic(pointer: TExpr, expression: ExpressionOf<'binary'>): TExpr {
    const { operator } = expression;
    if (operator !== '+' && operator !== '-')
      return this.error(expression, `多要素のポインタには、${operator} は使えません（+ と - だけです）。`);
    const offset = this.coerce(this.compile(expression.right, USIZE), USIZE, expression.right);
    const sign = operator === '+' ? 1 : -1;
    return this.combine(
      [pointer, offset],
      pointer.type,
      ([value, count]) => {
        if (!(value instanceof Pointer)) throw new MemoryFault();
        return new Pointer(value.target, value.index + sign * Number(count as bigint));
      },
      expression
    );
  }

  private logical(expression: ExpressionOf<'binary'>): TExpr {
    const left = this.coerce(this.compile(expression.left, BOOL), BOOL, expression.left);
    const isAnd = expression.operator === 'and';
    const leftResult = staticResultOf(left);
    if (leftResult && leftResult.value !== isAnd) return this.fixedResult(left, BOOL, !isAnd, expression);
    // The right side runs only when the left side lets it, a runtime condition unless the left side is known.
    const compileRight = (): TExpr => this.coerce(this.compile(expression.right, BOOL), BOOL, expression.right);
    const right = left.known ? compileRight() : this.underRuntimeCondition(compileRight);
    if (left.known) return right;
    const evaluateLeft = left.eval;
    const evaluateRight = right.eval;
    return {
      ...runtime(
        BOOL,
        isAnd
          ? (frame) => (evaluateLeft(frame) as boolean) && (evaluateRight(frame) as boolean)
          : (frame) => (evaluateLeft(frame) as boolean) || (evaluateRight(frame) as boolean),
        expression
      ),
      staticResult: leftResult ? staticResultOf(right) : undefined,
    };
  }

  // code-gauge-allow functionNcss -- Keeps the known, constant, and runtime forms of one `orelse` together.
  private orelse(expression: ExpressionOf<'binary'>, resultType: Type | undefined): TExpr {
    const left = this.compile(expression.left, resultType ? optionalOf(resultType) : undefined);
    if (left.type.kind !== 'optional') {
      return this.error(expression, `orelse の左は optional にしてください（${typeName(left.type)} 型です）。`);
    }
    this.checkMemoryHeader(left, expression);
    const child = left.type.child;
    // Zig does not analyze the right side of an `orelse` whose left side it knows holds a value.
    if (left.known && left.value !== NULL) return known(child, optionalPayload(left.value), expression);
    const right = left.known
      ? this.compile(expression.right, child)
      : this.underRuntimeCondition(() => this.compile(expression.right, child));
    const type =
      right.type.kind === 'noreturn' ? child : this.peerType([known(child, undefined, expression), right], expression);
    const otherwise = this.coerce(right, type, expression.right);
    if (left.known && left.value !== NULL)
      return this.coerce(known(child, optionalPayload(left.value), expression), type, expression);
    if (left.known) return otherwise;
    const leftResult = staticResultOf(left);
    if (leftResult && leftResult.value !== NULL)
      return this.coerce(this.derived(left, child, optionalPayload), type, expression);
    if (left.valueFacts?.payload) {
      const payload = {
        ...this.derived(left, child, optionalPayload),
        valueFacts: payloadFacts(left),
        knownLength: payloadFacts(left)?.length,
      };
      return this.coerce(payload, type, expression);
    }
    const evaluateLeft = left.eval;
    const evaluateRight = otherwise.eval;
    // The payload converts to the result type as a value of the child type would.
    let current: Value;
    const convert = this.coerce(
      runtime(child, () => current, expression),
      type,
      expression
    ).eval;
    return {
      ...runtime(
        type,
        (frame) => {
          const value = evaluateLeft(frame);
          if (value === NULL) return evaluateRight(frame);
          current = optionalPayload(value);
          return convert(frame);
        },
        expression
      ),
      staticResult: leftResult ? staticResultOf(otherwise) : undefined,
    };
  }

  // code-gauge-allow functionCognitiveComplexity -- Keeps one operation of the interpreter in one place.
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
    if (right.type.kind === 'null' || left.type.kind === 'null') return this.nullComparison(expression, left, right);
    const ordered = operator !== '==' && operator !== '!=';
    const errorUnion = [left, right].find((operand) => operand.type.kind === 'error_union');
    const error = [left, right].find((operand) => operand.type.kind === 'error_set');
    if (errorUnion && error && !ordered) {
      // An error union equals an error when it holds that error.
      const isEqual = operator === '==';
      return this.combine([left, right], BOOL, ([a, b]) => (a === b) === isEqual, expression);
    }
    // Integers of any types compare by their values, without a common type.
    const type =
      isIntegerType(left.type) && isIntegerType(right.type) ? COMPTIME_INT : this.peerType([left, right], expression);
    if (type !== COMPTIME_INT) {
      left = this.coerce(left, type, expression.left);
      right = this.coerce(right, type, expression.right);
    }
    const compare = this.valueComparator(type, ordered, expression);
    const test = comparisonTest(operator);
    return this.combine([this.comparisonSnapshot(left), right], BOOL, ([a, b]) => test(compare(a, b)), expression);
  }

  /** `x == null`, which compares an optional or a C pointer with null. */
  private nullComparison(expression: ExpressionOf<'binary'>, left: TExpr, right: TExpr): TExpr {
    const { operator } = expression;
    if (operator !== '==' && operator !== '!=') this.error(expression, 'null とは == と != でだけ比べられます。');
    const isEqual = operator === '==';
    const optional = right.type.kind === 'null' ? left : right;
    if (optional.type.kind === 'pointer' && optional.type.size === 'c') {
      const evaluate = optional.eval;
      return runtime(BOOL, (frame) => (evaluate(frame) === NULL) === isEqual, expression);
    }
    if (optional.type.kind !== 'optional' && optional.type.kind !== 'null') {
      this.error(expression, `${typeName(optional.type)} 型は optional ではないので、null と比べられません。`);
    }
    const index = right.type.kind === 'null' ? 0 : 1;
    return this.combine([left, right], BOOL, (values) => (values[index] === NULL) === isEqual, expression);
  }

  private comparisonSnapshot(operand: TExpr): TExpr {
    const payload = unwrapResult(operand.type);
    if (operand.known || !((payload.kind === 'struct' || payload.kind === 'union') && payload.layout === 'packed'))
      return operand;
    const evaluate = operand.eval;
    return { ...operand, eval: (frame) => copyForFrame(frame, evaluate(frame), operand.type) };
  }

  /** A function comparing two values of a type: negative, zero, or positive, or NaN when unordered. */
  valueComparator(type: Type, ordered: boolean, span: Span): (a: Value, b: Value) => number {
    switch (type.kind) {
      case 'int':
      case 'comptime_int':
      case 'enum': {
        if (type.kind === 'enum' && ordered) this.error(span, `enum の値は、大小を比べられません。`);
        return (a, b) => {
          spendIntegerOperation(a as bigint, b as bigint, 'read', spendMemory);
          return (a as bigint) < (b as bigint) ? -1 : (a as bigint) > (b as bigint) ? 1 : 0;
        };
      }
      case 'float':
      case 'comptime_float': {
        return (a, b) => compareFloats(a as AnyFloat, b as AnyFloat) ?? Number.NaN;
      }
      case 'void': {
        if (ordered) this.error(span, 'void の値は、大小を比べられません。');
        return () => 0;
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
        if (ordered) this.error(span, 'enum リテラルは、大小を比べられません。');
        return (a, b) => (a === b ? 0 : 1);
      }
      case 'pointer': {
        if (ordered || type.size === 'slice') this.error(span, `${typeName(type)} 型の値は、== で比べられません。`);
        return type.child.kind === 'fn'
          ? (a, b) => ((a as FnValue).fn === (b as FnValue).fn ? 0 : 1)
          : (a, b) => ((a as Pointer).equals(b as Pointer) ? 0 : 1);
      }
      case 'struct':
      case 'union': {
        if (ordered || type.layout !== 'packed')
          return this.error(span, `${typeName(type)} 型の値は、${ordered ? '大小を' : '== で'}比べられません。`);
        this.resolveStorage(type, span);
        return (a, b) => (packedValuesEqual(type, a, b) ? 0 : 1);
      }
      case 'optional': {
        if (ordered) this.error(span, `${typeName(type)} 型の値は、大小を比べられません。`);
        const compareChild = this.valueComparator(type.child, false, span);
        return (a, b) =>
          a === NULL || b === NULL ? (a === b ? 0 : 1) : compareChild(optionalPayload(a), optionalPayload(b));
      }
      default: {
        return this.error(span, `${typeName(type)} 型の値は、${ordered ? '大小を' : '== で'}比べられません。`);
      }
    }
  }

  // code-gauge-allow functionCognitiveComplexity -- Keeps numeric peer-type checks, budget checks, and evaluation together.
  // code-gauge-allow functionNcss -- Keeps numeric operand coercion and evaluation together.
  private arithmetic(expression: ExpressionOf<'binary'>, resultType: Type | undefined): TExpr {
    const { operator } = expression;
    // Zig gives the operands of arithmetic no result type, so `@floatFromInt(x) / 2` is an error.
    void resultType;
    let left = this.compile(expression.left);
    if (left.type.kind === 'pointer' && POINTER_OPERATIONS[pointerShapeOf(left.type)].unbounded)
      return this.pointerArithmetic(left, expression);
    let right = this.compile(expression.right);
    const bitwise = operator === '&' || operator === '|' || operator === '^';
    if (bitwise && (left.type.kind === 'bool' || right.type.kind === 'bool')) {
      this.error(expression, `bool の値には ${operator} ではなく and・or を使います。`);
    }
    const kinds = new Set([left.type.kind, right.type.kind]);
    const initialLeft = staticResultOf(left),
      initialRight = staticResultOf(right);
    if (
      operator === '/' &&
      kinds.has('comptime_int') &&
      kinds.has('comptime_float') &&
      initialLeft &&
      initialRight &&
      !isZero(initialRight.value)
    ) {
      this.checkMixedDivision(
        known(left.type, initialLeft.value, left.span),
        known(right.type, initialRight.value, right.span),
        expression
      );
    }
    const type = this.peerType([left, right], expression);
    if (!isArithmeticType(type)) {
      return this.error(expression, `${operator} は、数の型にだけ使えます（${typeName(type)} 型です）。`);
    }
    left = this.coerce(left, type, expression.left);
    right = this.coerce(right, type, expression.right);
    this.checkDivision(operator, type, left, right, expression);
    const compute = this.operation(operator, type, expression);
    const work = integerOperationWork(operator);
    const operation = (a: Value, b: Value, frame?: Frame): Value => {
      if (type.kind === 'int' || type.kind === 'comptime_int') this.integerWork(a as bigint, b as bigint, work, frame);
      const result = compute(a, b);
      if (type.kind === 'comptime_int' && work === 'read') this.integerWork(result as bigint, 0n, 'read', frame);
      return result;
    };
    // A float of a fixed type divided by zero gives an infinity or NaN, as at run time.
    const dividesByZero =
      (operator === '/' || operator === '%') &&
      staticResultOf(right) !== undefined &&
      isZero(staticResultOf(right)?.value) &&
      type.kind !== 'float';
    if (dividesByZero) this.error(expression, '0 で割っています。');
    const a = staticResultOf(left),
      b = staticResultOf(right);
    const result = a && b ? { value: this.foldArithmetic(operation, a.value, b.value, type, expression) } : undefined;
    return this.combine([left, right], type, ([a, b], frame) => operation(a, b, frame), expression, result);
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
    const compute = rawArithmeticOperations[expression.operator];
    return compute ? String(compute(a as bigint, b as bigint)) : '?';
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
    const a = staticResultOf(left),
      b = staticResultOf(right);
    const bothKnown = Boolean(a && b);
    if (operator === '/' && type.kind === 'int' && type.signed && !bothKnown) {
      this.error(
        span,
        `符号付きの整数 ${typeName(type)} の割り算には、@divTrunc・@divFloor・@divCeil・@divExact を使ってください。`
      );
    }
    const mayBeNegative = (type.kind === 'int' && type.signed) || type.kind !== 'int';
    if (operator === '%' && mayBeNegative && !(bothKnown && sign(a?.value) >= 0 && sign(b?.value) > 0)) {
      this.error(
        span,
        `符号付きの整数や浮動小数点数の余りには、@rem か @mod を使ってください（${typeName(type)} 型です）。`
      );
    }
  }

  // code-gauge-allow functionNcss -- One case per kind of syntax node, type, or format specifier, as Zig defines them.
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

  // code-gauge-allow functionCognitiveComplexity -- Keeps unbounded and fixed-width shift contracts together.
  private shift(expression: ExpressionOf<'binary'>, resultType: Type | undefined): TExpr {
    const left = this.compile(expression.left, resultType);
    const type = left.type;
    if (type.kind !== 'int' && type.kind !== 'comptime_int') {
      return this.error(expression, `シフトは整数の型にだけ使えます（${typeName(type)} 型です）。`);
    }
    if (type.kind !== 'int') {
      const right = this.comptimeOperand(this.coerce(this.compile(expression.right), COMPTIME_INT, expression.right));
      const source = this.comptimeOperand(left);
      return this.combine(
        [source, right],
        type,
        ([a, b]) => {
          const value = a as bigint,
            amount = b as bigint;
          if (amount < 0n) this.error(expression.right, 'シフトの量が負の数です。');
          spendIntegerShift(value, amount, expression.operator !== '>>', (cost) => this.spendCompilation(cost));
          return expression.operator === '>>' ? value >> amount : value << amount;
        },
        expression
      );
    }

    const int = type;
    const amountType = log2IntType(int);
    const right =
      expression.operator === '<<|'
        ? this.unsignedShiftCount(expression.right)
        : this.coerce(this.compile(expression.right, amountType), amountType, expression.right);
    if (expression.operator !== '<<|') this.checkKnownShift(right, int, expression.right);
    const operation =
      expression.operator === '<<'
        ? (a: Value, b: Value): Value => shiftLeft(a as bigint, b as bigint, int)
        : expression.operator === '>>'
          ? (a: Value, b: Value): Value => shiftRight(a as bigint, b as bigint, int)
          : (a: Value, b: Value): Value => shiftLeftSaturating(a as bigint, b as bigint, int);
    return this.combine(
      [left, right],
      type,
      ([a, b], frame) => {
        const amount = (b as bigint) > BigInt(int.bits) ? BigInt(int.bits) : (b as bigint);
        spendIntegerShift(a as bigint, amount, expression.operator !== '>>', (cost) =>
          frame ? frame.runtime.spend(cost) : this.spendCompilation(cost)
        );
        return operation(a, b);
      },
      expression
    );
  }

  protected integerWork(left: bigint, right: bigint, operation: IntegerWork, frame?: Frame): void {
    spendIntegerOperation(left, right, operation, (cost) =>
      frame ? frame.runtime.spend(cost) : this.spendCompilation(cost)
    );
  }

  private unsignedShiftCount(expression: Expression): TExpr {
    const amount = this.compile(expression);
    const fact = staticResultOf(amount);
    if (amount.type.kind === 'comptime_int' || (amount.type.kind === 'int' && fact)) {
      if (((fact?.value ?? this.knownValue(amount, 'シフト量')) as bigint) < 0n)
        this.error(expression, 'シフトの量が負の数です。');
    } else if (amount.type.kind !== 'int' || amount.type.signed) {
      this.error(expression, '飽和シフトの量は符号なし整数にしてください。');
    }
    return amount;
  }

  protected checkKnownShift(amount: TExpr, type: IntType, span: Span): void {
    if (staticResultOf(amount) && (staticResultOf(amount)?.value as bigint) >= BigInt(type.bits))
      this.error(
        span,
        `シフトの量 ${staticResultOf(amount)?.value as bigint} は、${typeName(type)} 型のビット数以上です。`
      );
  }

  /** `a ++ b`: concatenates arrays whose lengths are known at compile time. */
  // code-gauge-allow functionNcss -- Keeps tuple/array coercion with the corresponding concatenation representation.
  // code-gauge-allow functionCognitiveComplexity -- Keeps tuple/array coercion with the corresponding concatenation representation.
  private concatenate(expression: ExpressionOf<'binary'>): TExpr {
    let left = this.compile(expression.left);
    let right = this.compile(expression.right);
    const leftTuple = left.type.kind === 'struct' && left.type.isTuple ? left.type : undefined;
    const rightTuple = right.type.kind === 'struct' && right.type.isTuple ? right.type : undefined;
    if (leftTuple && rightTuple) {
      const fields = [...this.structFields(leftTuple, expression), ...this.structFields(rightTuple, expression)].map(
        (field, index) => ({ ...field, name: String(index) })
      );
      const type = this.tupleType(fields);
      const a = this.arrayOperand(left, expression.left);
      const b = this.arrayOperand(right, expression.right);
      return {
        ...this.aggregate(type, [left, right], expression, ([x, y]) => new ZStruct([...a.read(x), ...b.read(y)])),
        valueFacts: concatenatedFacts(left, right, Number(a.length), Number(b.length), () => this.spendCompilation()),
      };
    }
    if (leftTuple) {
      const child = this.arrayOperand(right, expression.right).child;
      left = this.coerce(left, arrayOf(this.structFields(leftTuple, expression).length, child), expression.left);
    }
    if (rightTuple) {
      const child = this.arrayOperand(left, expression.left).child;
      right = this.coerce(right, arrayOf(this.structFields(rightTuple, expression).length, child), expression.right);
    }
    const a = this.arrayOperand(left, expression.left);
    const b = this.arrayOperand(right, expression.right);
    if (a.child !== b.child) {
      this.error(expression, `要素の型が違う配列はつなげられません（${typeName(a.child)} と ${typeName(b.child)}）。`);
    }
    const child = a.child;
    const sentinel =
      a.sentinel === undefined
        ? b.sentinel
        : b.sentinel === undefined || sameSentinel(a.sentinel, b.sentinel)
          ? a.sentinel
          : undefined;
    const length = a.length + b.length;
    const arrayType = arrayOf(length, child, sentinel);
    this.storage.reserve(arrayType);
    const viaPointer = a.viaPointer || b.viaPointer;
    const singleton = singleValueOf(arrayType, () => this.spendCompilation());
    if (singleton) {
      const type = viaPointer ? pointerTo(arrayType, true) : arrayType;
      return this.aggregate(type, [left, right], expression, () => {
        const array = copyForStorage(singleton.value);
        return viaPointer ? new Pointer(new Constant(array), 0) : array;
      });
    }
    const resultType = viaPointer ? pointerTo(arrayType, true) : arrayType;
    const build = (x: Value[], y: Value[]): Value => {
      const array = newArray(
        [...x, ...y].map((value) => copyForStorage(value)),
        sentinel
      );
      if (!viaPointer) return array;
      // `"a" ++ b` of strings is constant data, as Zig computes it at compile time.
      const storage = new Constant(array);
      markConstantStorage(storage, arrayType);
      return new Pointer(storage, 0);
    };
    const readable =
      (!a.viaPointer || isConstantData(staticResultOf(left)?.value)) &&
      (!b.viaPointer || isConstantData(staticResultOf(right)?.value));
    if (left.known && right.known && readable)
      return known(resultType, build(a.read(left.value), b.read(right.value)), expression);
    const evaluators = valueEvaluators([left, right]);
    return {
      ...runtime(
        resultType,
        (frame) => {
          frame.runtime.reserveStorage(valueSlots(arrayType));
          const values = evaluateHeld(frame, evaluators);
          return build(a.read(values[0]), b.read(values[1]));
        },
        expression
      ),
      staticResult: readable
        ? this.constantResult([left, right], ([x, y]) => build(a.read(x), b.read(y)), expression)
        : undefined,
    };
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
    const arrayType = arrayOf(a.length * BigInt(count), a.child, a.sentinel);
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
    length: bigint;
    sentinel?: Sentinel;
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
    // A slice known at compile time has a known length, as Zig reads it for `++`; so does a comptime var's slice,
    // whose value the compiler holds as it analyzes the code.
    const variablePlace = operand.place?.comptimeVar ? operand.place.compileTimePointer : undefined;
    const known =
      type.kind === 'pointer' && type.size === 'slice'
        ? (staticResultOf(operand) ?? (variablePlace && { value: variablePlace.load() }))
        : undefined;
    if (type.kind === 'pointer' && known) {
      if (hasUndefinedHeader(known.value)) return this.error(span, 'undefined のヘッダーは参照できません。');
      const length = (known.value as Slice).lengthValue;
      return {
        child: type.child,
        length,
        sentinel: type.sentinel,
        viaPointer: true,
        read: (value) => {
          const slice = value as Slice;
          // Code that a `comptime` block runs after it changes the variable sees another length than its analysis.
          if (slice.lengthValue !== length) panic('unable to resolve comptime value');
          return Array.from({ length: slice.length }, (_, index) => slice.get(index));
        },
      };
    }
    if (type.kind === 'struct' && type.isTuple) {
      const fields = type.fields ?? [];
      return {
        child: fields[0]?.type ?? COMPTIME_INT,
        length: BigInt(fields.length),
        viaPointer: false,
        read: (value) =>
          fields.map((field, index) =>
            field.comptimeValue ? field.comptimeValue.value : (value as ZStruct).slots[index]
          ),
      };
    }
    return this.error(span, `++ と ** は、長さが決まった配列にだけ使えます（${typeName(type)} 型です）。`);
  }

  // Initializers ----------------------------------------------------------------------------------------------------

  /** Whether two values known at compile time are one value, as Zig interns them: a slice by its elements. */
  private sameComptimeValue(type: Type, a: Value, b: Value): boolean {
    if (!(type.kind === 'pointer' && type.size === 'slice' && a instanceof Slice && b instanceof Slice))
      return valuesEqual(type, a, b, () => this.spendCompilation());
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++)
      if (!this.sameComptimeValue(type.child, a.get(index), b.get(index))) return false;
    return true;
  }

  /** A comptime field takes only its own value, which Zig checks where a literal gives it. */
  private checkComptimeField(compiled: TExpr, field: StructField, span: Span): void {
    const fact = staticResultOf(compiled);
    const expected = field.comptimeValue?.value;
    if (!fact || !this.sameComptimeValue(field.type, fact.value, expected))
      this.error(span, `comptime のフィールド「${field.name}」には、既定の値と同じ値しか入れられません。`);
  }

  // code-gauge-allow functionCognitiveComplexity -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
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
    if (type.kind !== 'struct') {
      if (!expression.type && resultType) return this.anonymousStruct(expression);
      return this.error(expression, `${typeName(type)} 型は、{ .x = ... } の形では初期化できません。`);
    }
    if (expression.fields.length === 0 && type.native && this.structFields(type, expression).length === 0)
      return this.nativeDefault(type, expression);
    const plan = this.structInitializerPlan(expression, type);
    const elements = plan.map(({ field, value }) => {
      if (!value) return known(field.type, field.defaultValue, expression);
      const compiled = this.coerce(this.compile(value, field.type), field.type, value);
      if (field.comptimeValue) this.checkComptimeField(compiled, field, value);
      return compiled;
    });
    return this.aggregate(type, elements, expression, (values) => {
      const slots: Value[] = [];
      for (const [index, { position }] of plan.entries()) slots[position] = values[index];
      return new ZStruct(slots);
    });
  }

  private unionInit(expression: ExpressionOf<'structInit'>, type: Extract<Type, { kind: 'union' }>): TExpr {
    if (expression.fields.length !== 1) this.error(expression, 'union は、フィールドを1つだけ初期化してください。');
    const [init] = expression.fields;
    const fields = this.unionFields(type);
    const index = this.fieldIndexes(fields).get(init.name);
    if (index === undefined)
      return this.error(init, `${typeName(type)} 型には、フィールド「${init.name}」がありません。`);
    const value = this.coerce(this.compile(init.value, fields[index].type), fields[index].type, init.value);
    return this.materializeUnion(type, index, value, expression);
  }

  /** `.{ .x = 1 }` without a result type, whose type is an anonymous struct of the fields' types. */
  private anonymousStruct(expression: ExpressionOf<'structInit'>): TExpr {
    const values = expression.fields.map((init) => this.compile(init.value));
    const fields: StructField[] = expression.fields.map((init, index) => ({
      name: init.name,
      type: values[index].type,
      hasDefault: false,
      comptimeValue: this.requiresComptime(values[index].type, values[index].span)
        ? staticResultOf(values[index])
        : undefined,
    }));
    const type = this.anonymousStructType(fields);
    return this.aggregate(type, values, expression, (slots) => new ZStruct(slots), true);
  }

  private anonymousStructType(fields: StructField[]): StructType {
    return this.structuralStruct(fields, fields.length === 0);
  }

  tupleType(fields: StructField[]): StructType {
    return this.structuralStruct(fields, true);
  }

  private readonly structuralTypes = new Map<string, StructType>();

  private structuralStruct(fields: StructField[], isTuple: boolean): StructType {
    const key = JSON.stringify([
      isTuple,
      fields.map((field) => ({
        name: field.name,
        type: typeId(field.type),
        value:
          field.comptimeValue === undefined
            ? undefined
            : constantKey(field.comptimeValue.value, () => this.spendCompilation()),
      })),
    ]);
    let type = this.structuralTypes.get(key);
    if (!type) {
      type = {
        kind: 'struct',
        isTuple,
        namespace: {
          name: isTuple
            ? 'tuple'
            : `anonymous struct { ${fields.map((field) => `${field.name}:${typeName(field.type)}`).join(',')} }`,
          decls: new Map(),
        },
        layout: 'auto',
        fields,
      };
      this.structuralTypes.set(key, type);
    }
    return type;
  }

  // code-gauge-allow functionCognitiveComplexity -- Keeps the analysis and the generated code of one construct together, as Zig's Sema does.
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
    if (type?.kind === 'array') {
      const array = type;
      if (array.length !== BigInt(expression.elements.length)) {
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
      comptimeValue: value.type.kind === 'void' ? { value: undefined } : staticResultOf(value),
    }));
    const tuple = this.tupleType(fields);
    return this.aggregate(tuple, values, expression, (slots) => new ZStruct(slots), true);
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
    return known(TYPE, arrayOf(length, child, sentinel), expression);
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

/** A text that tells known values apart, for interning the types that carry them. */
function valueKey(value: Value): string {
  if (value instanceof BigFloat) return `f${value.kind}${value.sign}${value.mantissa}e${value.exponent}`;
  if (typeof value === 'number') return `n${Object.is(value, -0) ? '-0' : String(value)}`;
  if (typeof value === 'bigint' || typeof value === 'boolean' || value === undefined)
    return `${typeof value}${String(value)}`;
  if (value instanceof EnumLiteral || value instanceof ErrorValue)
    return `${value.constructor.name}.${JSON.stringify(value.name)}`;
  if (value === NULL) return 'null';
  if (isType(value)) return `type ${typeId(value)}`;
  return `object ${objectId(value)}`;
}

function knownAt(type: Type, pointer: Pointer, span: Span): TExpr {
  return {
    ...known(type, pointer.load(), span),
    place: { isConst: true, locate: () => pointer, compileTimePointer: pointer },
  };
}

export function constantKey(value: Value, spend: () => void): string {
  spend();
  if (value instanceof ZArray && zeroArrayElement(value))
    return `zero array ${value.lengthValue} ${value.hasSentinel} ${constantKey(zeroArrayElement(value)?.value, spend)}`;
  if (value instanceof ZArray)
    return `array ${JSON.stringify(value.values(value.hasSentinel).map((item) => constantKey(item, spend)))}`;
  if (value instanceof ZStruct) return `struct ${JSON.stringify(value.slots.map((item) => constantKey(item, spend)))}`;
  if (value instanceof ZUnion)
    return value.backingKey?.() ?? `union ${value.tag} ${constantKey(value.slots[0], spend)}`;
  if (value instanceof Some) return `some ${constantKey(value.value, spend)}`;
  if (value instanceof Pointer) {
    const location = value.storageLocation();
    return `pointer ${objectId(location.storage)} ${location.index}`;
  }
  if (value instanceof Slice) return `slice ${objectId(value.target.slots)} ${value.start} ${value.lengthValue}`;
  if (value instanceof FnValue) return `fn ${objectId(value.fn)}`;
  if (value instanceof FnRef) return `fn-ref ${objectId(value.decl)}`;
  return valueKey(value);
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

/** The shift amount's type for an integer type: `u5` for 32 bits, as `std.math.Log2Int` gives. */
export function log2IntType(type: IntType): IntType {
  let bits = 0;
  while (2 ** bits < type.bits) bits++;
  return intType(false, bits);
}

function hasSentinel(type: Type): boolean {
  if (type.kind === 'array') return type.sentinel !== undefined;
  if (type.kind === 'pointer')
    return type.size === 'one' && type.child.kind === 'array'
      ? type.child.sentinel !== undefined
      : type.sentinel !== undefined;
  return false;
}

/** A many-item or C pointer's value, which must not be null. */
function manyPointer(value: Value): Pointer {
  if (!(value instanceof Pointer)) throw new MemoryFault();
  return value;
}

function isConstIndexable(type: Type, place: Place | undefined): boolean {
  if (type.kind === 'array') return place ? place.isConst : true;
  if (type.kind === 'pointer') return type.isConst;
  return true;
}

function isConstantData(value: Value): boolean {
  return (value instanceof Pointer || value instanceof Slice) && compileTimeReadable(value);
}

/** The type that a result type asks an initializer for, looking through optionals and error unions. */
export function unwrapResult(type: Type): Type {
  while (type.kind === 'optional' || type.kind === 'error_union') {
    type = type.kind === 'optional' ? type.child : type.payload;
  }
  return type;
}

export { Constant, CONST_U8_SLICE, NativeFn };

/** The type an operand compared with a value of `type` takes: the tag type for a tagged union. */
function unionTag(type: Type): Type {
  return type.kind === 'union' && type.tagType ? type.tagType : type;
}
