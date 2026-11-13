// code-gauge-allow-file fileNcss 819 -- Expression compilation shares lvalue and conversion invariants; splitting by operator would couple more compiler classes.
import {
  binaryOperation,
  complement,
  convertScalar,
  isRecordValue,
  isZero,
  negate,
  oneOf,
  type RecordValue,
  type Scalar,
  type Value,
} from './arith';
import type { BinaryOperator, Expression } from './ast';
import { CompilerBase, type Entity, type Location, type LValue, type Operand } from './compilerBase';
import { CRuntimeError } from './errors';
import { decodeCharLiteral, decodeStringLiteral, parseNumber } from './literals';
import {
  type Address,
  addressOf as pointerAddress,
  arithmeticResult,
  boundPointer,
  checkAddress,
  evaluate,
  type Evaluated,
  type Evaluator,
  evaluatorOf,
  type MetadataReader,
  pointerAt,
  pointerEvaluator,
  rangeOfBytes,
  replacePointerBytes,
  resultOperand,
  slicePointerBytes,
} from './pointerBounds';
import { type Frame, type FunctionInfo, loaderOf, loadRecord, storeRecord, storeValue } from './runtime';
import {
  BOOL,
  commonType,
  compatible,
  type CType,
  decay,
  DOUBLE,
  type FloatType,
  type FunctionType,
  hasConstMember,
  INT,
  INT_PROPERTIES,
  type IntType,
  isArithmetic,
  isComplete,
  isConstQualified,
  isInteger,
  isScalar,
  isVoidPointer,
  LONG,
  pointerTo,
  promote,
  type RecordType,
  SIZE_T,
  sizeOf,
  typeName,
  unqualified,
  VOID,
  withQualifiers,
} from './types';
import { unsupported } from './unsupported';

/** Where a value is converted to another type, for the messages of the conversions clang rejects. */
export type ConversionContext = 'assignment' | 'initialization' | 'argument' | 'return';

const CONTEXT_WORDS: Record<ConversionContext, string> = {
  assignment: '代入',
  initialization: '初期化',
  argument: '引数に',
  return: '戻り値に',
};

/** A function the compiler checks itself, because its parameters depend on how it is called. */
export type SpecialCall = (
  compiler: ExpressionCompiler,
  call: Extract<Expression, { kind: 'call' }>,
  fn: FunctionInfo
) => Operand | undefined;

export abstract class ExpressionCompiler extends CompilerBase {
  protected abstract specialCall(name: string): SpecialCall | undefined;
  /** Rejects a library function the interpreter leaves out, when the program refers to it. */
  protected abstract checkFunctionUse(fn: FunctionInfo, row: number): void;

  protected constantOperand(expression: Expression): Operand | undefined {
    const operand = this.expression(expression);
    return operand.constant === undefined ? undefined : operand;
  }

  /** An expression as an rvalue: arrays and functions decay to pointers. */
  rvalue(expression: Expression): Operand {
    const operand = this.expression(expression);
    if (operand.type.kind === 'array') {
      const size = operand.type.length === undefined ? undefined : sizeOf(operand.type);
      const pointer = (frame: Frame): Address => {
        const address = operand.value(frame) as number;
        return { address, start: address, end: address + (size ?? frame.runtime.memory.findBase(address)?.size ?? 0) };
      };
      if (operand.lvalue?.isRegister) this.error(expression.row, 'register を付けた配列のアドレスは使えません。');
      return { ...operand, type: rvalueType(operand), pointer, read: undefined, arrayObject: true };
    }
    return { ...operand, type: rvalueType(operand) };
  }

  // code-gauge-allow functionNcss 55 -- One case per C expression kind; helpers already isolate the nontrivial forms.
  expression(expression: Expression): Operand {
    const row = expression.operatorRow ?? expression.row;
    switch (expression.kind) {
      case 'identifier': {
        return this.identifier(expression.name, row);
      }
      case 'number': {
        const { type, value } = parseNumber(expression.text, row);
        return constantOperand(type, value);
      }
      case 'char': {
        return constantOperand(INT, decodeCharLiteral(expression.text, row));
      }
      case 'string': {
        return this.stringLiteral(expression.parts, row);
      }
      case 'paren': {
        return this.expression(expression.expression);
      }
      case 'binary': {
        const left = expression.left;
        if (RELATIONAL.has(expression.operator) && left.kind === 'binary' && RELATIONAL.has(left.operator)) {
          this.error(
            row,
            `比較「${left.operator}」と「${expression.operator}」をつなげて書くと、数学の式とは違う意味になります（&& でつないでください）。`
          );
        }
        return this.binary(expression.operator, this.rvalue(expression.left), this.rvalue(expression.right), row);
      }
      case 'assign': {
        return this.assignment(expression);
      }
      case 'unary': {
        return this.unary(expression.operator, this.rvalue(expression.operand), row);
      }
      case 'deref': {
        return this.dereference(this.rvalue(expression.operand), row);
      }
      case 'address': {
        return this.addressOf(this.expression(expression.operand), row);
      }
      case 'update': {
        return this.update(expression);
      }
      case 'cast': {
        return this.cast(this.typeOfName(expression.typeName), this.rvalue(expression.operand), row);
      }
      case 'sizeofType': {
        return this.sizeofType(this.typeOfName(expression.typeName), row);
      }
      case 'sizeofExpression': {
        const operand = this.unevaluated(() => this.expression(expression.operand));
        if (operand.lvalue?.isBitField) this.error(row, 'ビットフィールドに sizeof は使えません。');
        return this.sizeofType(operand.type, row);
      }
      case 'conditional': {
        return this.conditional(expression);
      }
      case 'comma': {
        const left = this.rvalue(expression.left);
        const right = this.rvalue(expression.right);
        const leftEffect = left.effect ?? left.value;
        return resultOperand(right.type, (frame) => {
          leftEffect(frame);
          return evaluate(evaluatorOf(right), frame);
        });
      }
      case 'call': {
        return this.call(expression);
      }
      case 'subscript': {
        return this.subscript(expression);
      }
      case 'member': {
        return this.member(expression);
      }
      case 'offsetof': {
        return this.offsetof(expression);
      }
    }
  }

  /** `offsetof(T, m)`, which stddef.h provides and tree-sitter parses as an expression of its own. */
  private offsetof(expression: Extract<Expression, { kind: 'offsetof' }>): Operand {
    const { row, member } = expression;
    if (!this.scope.lookup(OFFSETOF_MARKER)) this.undeclaredFunction('offsetof', row);
    const type = this.typeOfName(expression.typeName);
    if (type.kind !== 'record' || !type.info.isComplete)
      this.error(row, 'offsetof の1つ目には、中身が定義された構造体・共用体の型を書いてください。');
    const field = type.info.field(member);
    if (!field) this.error(row, `「${typeName(type)}」にはメンバ「${member}」がありません。`);
    if (field.bitWidth !== undefined) this.error(row, 'ビットフィールドに offsetof は使えません。');
    return constantOperand(SIZE_T, BigInt(field.offset));
  }

  // Names and literals ----------------------------------------------------------------------------------------------

  private identifier(name: string, row: number): Operand {
    const feature = UNSUPPORTED_NAMES[name];
    if (feature && !this.scope.lookup(name)) unsupported(row, feature);
    const entity = this.scope.lookup(name);
    if (!entity) this.error(row, `「${name}」は宣言されていません。`);
    return this.entityOperand(entity, name, row);
  }

  // code-gauge-allow functionCognitiveComplexity 23 -- Storage classes require distinct load, address, provenance, and tracing contracts.
  // code-gauge-allow functionNcss 43 -- Each symbol storage class has its own load/address contract; keep that dispatch together.
  protected entityOperand(entity: Entity, name: string, row: number): Operand {
    switch (entity.kind) {
      case 'typedef': {
        this.error(row, `「${name}」は型の名前なので、値としては使えません。`);
      }
      // falls through
      case 'enumConstant': {
        return constantOperand(INT, entity.value);
      }
      case 'function': {
        this.checkFunctionUse(entity.fn, row);
        const fn = entity.fn;
        return { type: entity.type, value: () => fn.address as number, isAddressConstant: true };
      }
      case 'global': {
        const { global } = entity;
        if (!this.isUnevaluated) global.referencedAt ??= row;
        const index = global.index;
        const operand = this.memoryOperand(entity.type, (frame) => frame.runtime.globals[index].base);
        return {
          ...(entity.constant === undefined ? {} : { constant: entity.constant }),
          ...operand,
          constantBytes: entity.constantBytes,
          isAddressConstant: entity.type.kind === 'array',
          lvalue: { ...(operand.lvalue as LValue), isStatic: true },
        };
      }
      case 'local': {
        const { local } = entity;
        const folded = { constant: entity.constant, constantBytes: entity.constantBytes };
        if (local.staticGlobal) {
          const index = local.staticGlobal.index;
          const operand = this.memoryOperand(entity.type, (frame) => frame.runtime.globals[index].base);
          return {
            ...operand,
            ...folded,
            isAddressConstant: entity.type.kind === 'array',
            lvalue: { ...(operand.lvalue as LValue), local, isStatic: true },
          };
        }
        if (local.inMemory) {
          const index = local.index;
          const operand = this.memoryOperand(entity.type, (frame) => frame.bases[index]);
          return {
            ...operand,
            ...folded,
            lvalue: { ...(operand.lvalue as LValue), local, isRegister: this.fn?.registerLocals.has(local) ?? false },
          };
        }
        const index = local.index;
        const load = (frame: Frame): Value => {
          const value = frame.slots[index];
          if (value === undefined) throw new CRuntimeError('uninitialized');
          return value;
        };
        return {
          type: entity.type,
          value: load,
          read: (frame) => ({
            value: load(frame),
            range: frame.scalarRanges.get(index),
            bytes: frame.scalarBytes.get(index),
          }),
          ...folded,
          pointer:
            entity.type.kind === 'pointer'
              ? (frame) => {
                  const address = load(frame) as number;
                  const range = frame.scalarRanges.get(index);
                  return range
                    ? { address, ...range }
                    : boundPointer(frame, address, (entity.type as Extract<CType, { kind: 'pointer' }>).to);
                }
              : undefined,
          lvalue: {
            resolve: (frame) => ({
              load: () => load(frame),
              range: () => frame.scalarRanges.get(index),
              bytes: () => frame.scalarBytes.get(index),
              store: (value, range, bytes) => frame.assign(index, { value, range, bytes }),
            }),
            local,
            isRegister: this.fn?.registerLocals.has(local) ?? false,
          },
        };
      }
    }
  }

  protected memoryOperand(type: CType, address: (frame: Frame) => Address): Operand {
    const resolve = (frame: Frame): Location => {
      const at = checkAddress(address(frame), sizeOf(type));
      if (type.kind === 'array' || type.kind === 'function') return { load: () => at, store: () => {} };
      if (type.kind === 'record')
        return {
          load: () => loadRecord(frame.runtime, at, sizeOf(type)),
          store: (value) => storeRecord(frame.runtime, at, value as RecordValue),
        };
      if (type.kind === 'void') return { load: () => 0, store: () => {} };
      return {
        load: () => loaderOf(type)(frame.runtime, at),
        range: () => {
          const block = frame.runtime.memory.locate(at, sizeOf(type));
          return sizeOf(type) === 8
            ? rangeOfBytes(block.pointerBytes, at - block.base, block.bytes, frame.runtime.budget)
            : undefined;
        },
        bytes: () => {
          const block = frame.runtime.memory.locate(at, sizeOf(type));
          return slicePointerBytes(block.pointerBytes, at - block.base, sizeOf(type));
        },
        store: (value, range, bytes) => storeValue(frame.runtime, at, type, value, range, bytes),
      };
    };
    return {
      type,
      value: (frame) => resolve(frame).load(),
      read: Object.assign(
        (frame: Frame) => {
          const location = resolve(frame);
          return { value: location.load(), range: location.range?.(), bytes: location.bytes?.() };
        },
        { always: true }
      ),
      pointer:
        type.kind === 'pointer'
          ? (frame) => {
              const location = resolve(frame);
              const address = location.load() as number;
              const range = location.range?.();
              return pointerAt(frame, address, type.to, range);
            }
          : undefined,
      lvalue: { resolve, location: address, address: (frame) => checkAddress(address(frame), 0) },
    };
  }

  private stringLiteral(parts: string[], row: number): Operand {
    const bytes = decodeStringLiteral(parts, row);
    const index = this.stringIndex(bytes);
    const type: CType = { kind: 'array', of: { kind: 'int', name: 'char' }, length: bytes.length };
    const address = (frame: Frame): number => frame.runtime.literals[index].base;
    return { ...this.memoryOperand(type, address), isAddressConstant: true, constantBytes: bytes };
  }

  // Operators -------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 25 -- C's operand rules for each binary operator.
  binary(operator: BinaryOperator, left: Operand, right: Operand, row: number): Operand {
    const lt = left.type;
    const rt = right.type;
    if (operator === '&&' || operator === '||') return this.logical(operator, left, right, row);
    if (isArithmetic(lt) && isArithmetic(rt)) return this.arithmetic(operator, left, right, row);
    if (operator === '+' || operator === '-') {
      if (lt.kind === 'pointer' && isInteger(rt))
        return this.pointerOffset(left, right, operator === '+' ? 1 : -1, row);
      if (operator === '+' && isInteger(lt) && rt.kind === 'pointer') return this.pointerOffset(right, left, 1, row);
      if (operator === '-' && lt.kind === 'pointer' && rt.kind === 'pointer')
        return this.pointerDifference(left, right, row);
    }
    if (['==', '!=', '<', '<=', '>', '>='].includes(operator) && (lt.kind === 'pointer' || rt.kind === 'pointer')) {
      return this.pointerComparison(operator, left, right, row);
    }
    this.error(row, `「${operator}」の左右の型（${typeName(lt)} と ${typeName(rt)}）では計算できません。`);
  }

  private logical(operator: '&&' | '||', left: Operand, right: Operand, row: number): Operand {
    this.requireScalar(left, row, operator);
    this.requireScalar(right, row, operator);
    const a = this.truthOf(left);
    const b = this.truthOf(right);
    const value =
      operator === '&&'
        ? (frame: Frame): Value => (a(frame) && b(frame) ? 1 : 0)
        : (frame: Frame): Value => (a(frame) || b(frame) ? 1 : 0);
    const constant = logicalConstant(operator, left.constant, right.constant);
    return { type: INT, value, ...(constant === undefined ? {} : { constant }) };
  }

  private arithmetic(operator: BinaryOperator, left: Operand, right: Operand, row: number): Operand {
    const operation = this.arithmeticOperation(
      operator,
      left.type as IntType | FloatType,
      right.type as IntType | FloatType,
      row
    );
    const a = this.converted(left, operation.left);
    const b = this.converted(right, operation.right);
    const preserveOrigin = operation.type.kind === 'int' && !['==', '!=', '<', '<=', '>', '>='].includes(operator);
    const read = (frame: Frame): Evaluated => {
      const av = evaluate(a, frame),
        bv = evaluate(b, frame);
      const value = operation.run(av.value as Scalar, bv.value as Scalar);
      return preserveOrigin ? arithmeticResult(value, [av, bv], frame.runtime.budget, operator) : { value };
    };
    return foldBinary(
      operation.type,
      (frame) => operation.run(a(frame) as Scalar, b(frame) as Scalar),
      left,
      right,
      () =>
        operation.run(
          convertScalar(left.constant!, left.type, operation.left),
          convertScalar(right.constant!, right.type, operation.right)
        ),
      read
    );
  }

  private arithmeticOperation(
    operator: BinaryOperator,
    left: IntType | FloatType,
    right: IntType | FloatType,
    row: number
  ): {
    type: CType;
    left: CType;
    right: CType;
    run: (a: Scalar, b: Scalar) => Scalar;
  } {
    if (['%', '<<', '>>', '&', '|', '^'].includes(operator) && (left.kind !== 'int' || right.kind !== 'int'))
      this.error(row, `「${operator}」は整数どうしでしか計算できません（${typeName(left)} と ${typeName(right)}）。`);
    if (operator === '<<' || operator === '>>') {
      const type = promote(left as IntType);
      const run = binaryOperation(operator, type);
      return { type, left: type, right: LONG, run: (a, b) => run(a, Number(b)) };
    }
    const common = commonType(left, right);
    return {
      type: ['==', '!=', '<', '<=', '>', '>='].includes(operator) ? INT : common,
      left: common,
      right: common,
      run: binaryOperation(operator, common),
    };
  }

  private pointerOffset(pointer: Operand, offset: Operand, sign: 1 | -1, row: number): Operand {
    const type = pointer.type as Extract<CType, { kind: 'pointer' }>;
    const size = this.pointerElementSize(type, row);
    const index = this.converted(offset, LONG);
    const locate = (frame: Frame): Address => {
      const original = pointer.pointer?.(frame) ?? boundPointer(frame, pointer.value(frame) as number, type.to);
      const address = pointerAddress(original);
      const delta = Number(index(frame)) * size * sign;
      const result = offsetAddress(frame, address, delta);
      const location = typeof original === 'number' ? result : { ...original, address: result };
      checkAddress(location, 0);
      return location;
    };
    const value = (frame: Frame): Value => pointerAddress(locate(frame));
    const constantOffset = offset.constant === undefined ? undefined : Number(offset.constant) * size * sign;
    const constantBytes =
      pointer.constantBytes &&
      constantOffset !== undefined &&
      constantOffset >= 0 &&
      constantOffset <= pointer.constantBytes.length
        ? pointer.constantBytes.slice(constantOffset)
        : undefined;
    return {
      type,
      value,
      pointer: locate,
      constantBytes,
      isAddressConstant: pointer.isAddressConstant && offset.constant !== undefined,
    };
  }

  private pointerElementSize(type: Extract<CType, { kind: 'pointer' }>, row: number): number {
    if (type.to.kind === 'function') this.error(row, '関数ポインタには、整数を足したり引いたりできません。');
    if (!isComplete(type.to) && type.to.kind !== 'void') {
      this.error(
        row,
        `中身が定義されていない型（${typeName(type.to)}）へのポインタには、整数を足したり引いたりできません。`
      );
    }
    return sizeOf(type.to);
  }

  private pointerDifference(left: Operand, right: Operand, row: number): Operand {
    const lt = left.type as Extract<CType, { kind: 'pointer' }>;
    const rt = right.type as Extract<CType, { kind: 'pointer' }>;
    if (!compatible(unqualified(lt.to), unqualified(rt.to), true)) {
      this.error(row, `型の違うポインタどうし（${typeName(lt)} と ${typeName(rt)}）の差は求められません。`);
    }
    const size = sizeOf(lt.to);
    const a = left.value;
    const b = right.value;
    return {
      type: LONG,
      value: (frame) => {
        const x = a(frame) as number;
        const y = b(frame) as number;
        const memory = frame.runtime.memory;
        const block = memory.find(x) ?? memory.find(x - 1);
        if (block && !(y >= block.base && y <= block.end)) throw new CRuntimeError('pointerDifference');
        return BigInt(Math.trunc((x - y) / size));
      },
    };
  }

  private pointerComparison(operator: BinaryOperator, left: Operand, right: Operand, row: number): Operand {
    const lt = left.type;
    const rt = right.type;
    const isEquality = operator === '==' || operator === '!=';
    const nullComparison =
      (lt.kind === 'pointer' && isNullConstant(right)) || (rt.kind === 'pointer' && isNullConstant(left));
    if (!nullComparison) {
      if (lt.kind === 'pointer' && rt.kind === 'pointer') {
        // clang only warns about comparing distinct pointer types.
      } else if (isInteger(lt) || isInteger(rt)) {
        // Comparing a pointer with a nonzero integer is a warning in clang too.
      } else {
        this.error(row, `「${operator}」の左右の型（${typeName(lt)} と ${typeName(rt)}）では比べられません。`);
      }
    }
    void isEquality;
    const a = this.pointerValue(left);
    const b = this.pointerValue(right);
    const compare = binaryOperation(operator, { kind: 'int', name: 'ulong' });
    return { type: INT, value: (frame) => compare(BigInt(a(frame)), BigInt(b(frame))) };
  }

  private pointerValue(operand: Operand): (frame: Frame) => number {
    const value = operand.value;
    const type = operand.type;
    if (type.kind === 'pointer') return value as (frame: Frame) => number;
    return (frame) => Number(convertScalar(value(frame) as Scalar, type, { kind: 'pointer', to: VOID }));
  }

  private unary(operator: '-' | '+' | '!' | '~', operand: Operand, row: number): Operand {
    const type = operand.type;
    if (operator === '!') {
      this.requireScalar(operand, row, '!');
      const truth = this.truthOf(operand);
      return fold(
        INT,
        (frame) => (truth(frame) ? 0 : 1),
        operand,
        () => (isZero(operand.constant!) ? 1 : 0)
      );
    }
    if (operator === '~') {
      if (type.kind !== 'int') this.error(row, `「~」は整数にしか使えません（${typeName(type)}）。`);
      const promoted = promote(type);
      const value = this.converted(operand, promoted);
      const operation = complement(promoted);
      return fold(
        promoted,
        (frame) => operation(value(frame) as Scalar),
        operand,
        () => operation(convertScalar(operand.constant!, type, promoted)),
        (frame) => {
          const previous = evaluate(value, frame);
          return arithmeticResult(operation(previous.value as Scalar), [previous], frame.runtime.budget);
        }
      );
    }
    if (!isArithmetic(type)) this.error(row, `「${operator}」は数にしか使えません（${typeName(type)}）。`);
    const promoted = type.kind === 'int' ? promote(type) : unqualified(type);
    const value = this.converted(operand, promoted);
    if (operator === '+')
      return fold(
        promoted,
        value,
        operand,
        () => convertScalar(operand.constant!, type, promoted),
        (frame) => evaluate(value, frame)
      );
    const operation = negate(promoted);
    return fold(
      promoted,
      (frame) => operation(value(frame) as Scalar),
      operand,
      () => operation(convertScalar(operand.constant!, type, promoted)),
      (frame) => {
        const previous = evaluate(value, frame);
        const result = operation(previous.value as Scalar);
        return promoted.kind === 'int'
          ? arithmeticResult(result, [{ value: 0 }, previous], frame.runtime.budget, '-')
          : { value: result };
      }
    );
  }

  dereference(operand: Operand, row: number): Operand {
    const type = operand.type;
    if (type.kind !== 'pointer') this.error(row, `「*」はポインタにしか使えません（${typeName(type)}）。`);
    const target = type.to;
    if (target.kind === 'void') this.error(row, 'void * の指す先は読めません（型を決めるキャストをしてください）。');
    if (target.kind === 'function') return { type: target, value: operand.value };
    const address = operand.pointer ?? ((frame: Frame) => boundPointer(frame, operand.value(frame) as number, target));
    if (target.kind === 'record' && !target.info.isComplete) {
      return {
        type: target,
        value: () => this.error(row, '中身が定義されていない型の値は使えません。'),
        lvalue: {
          resolve: () => ({ load: () => 0, store: () => {} }),
          address: (frame) => pointerAddress(address(frame)),
        },
      };
    }
    return this.memoryOperand(target, address);
  }

  private addressOf(operand: Operand, row: number): Operand {
    const type = operand.type;
    if (type.kind === 'function')
      return { type: pointerTo(type), value: operand.value, isAddressConstant: operand.isAddressConstant };
    if (!operand.lvalue) this.error(row, '「&」は変数や配列の要素などにしか使えません。');
    if (operand.lvalue.isBitField) this.error(row, 'ビットフィールドのアドレスは取れません。');
    if (operand.lvalue.isRegister) this.error(row, 'register を付けた変数のアドレスは取れません。');
    const address = operand.lvalue.address;
    if (!address) throw new Error('A variable whose address is taken must live in memory');
    const isStatic = operand.isAddressConstant === true || operand.lvalue.isStatic === true;
    const location = operand.lvalue.location;
    const pointer = (frame: Frame): Address => {
      const at = location?.(frame) ?? address(frame);
      const bounded = typeof at === 'number' ? boundPointer(frame, at, type) : at;
      checkAddress(bounded, 0);
      return bounded;
    };
    return {
      type: pointerTo(type),
      value: (frame) => pointerAddress(pointer(frame)),
      pointer,
      isAddressConstant: isStatic,
    };
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- Updating one resolved location must preserve bit-field, pointer, and prefix/postfix result semantics.
  private update(expression: Extract<Expression, { kind: 'update' }>): Operand {
    const row = expression.operatorRow ?? expression.row;
    const operand = this.expression(expression.operand);
    this.requireModifiable(operand, row, expression.operator);
    const type = unqualified(operand.type);
    const lvalue = operand.lvalue as LValue;
    const step = this.updateOperation(type, expression.operator, row);
    const operator = expression.operator === '++' ? '+' : '-';
    const execute = (frame: Frame): Evaluated => {
      const location = lvalue.resolve(frame);
      const previous = location.load() as Scalar;
      const range = location.range?.();
      const previousBytes = location.bytes?.();
      const next = step(previous, frame);
      if (type.kind === 'pointer' && range) checkAddress({ address: next as number, ...range }, 0);
      const metadata =
        type.kind === 'pointer'
          ? { value: next, range, bytes: undefined }
          : arithmeticResult(
              next,
              [{ value: previous, range, bytes: previousBytes }, { value: 1 }],
              frame.runtime.budget,
              operator
            );
      location.store(next, metadata.range, metadata.bytes);
      if (lvalue.local) frame.live[lvalue.local.index] = true;
      const value = expression.prefix ? (lvalue.isBitField ? location.load() : next) : previous;
      return {
        value,
        range: expression.prefix ? metadata.range : range,
        bytes: expression.prefix ? metadata.bytes : previousBytes,
      };
    };
    return resultOperand(type, execute, expression.prefix ? operand.bitWidth : undefined);
  }

  // code-gauge-allow functionCognitiveComplexity 26 -- C pointer, boolean, and arithmetic updates have distinct conversion rules; splitting them only relocates the cases.
  private updateOperation(type: CType, operator: '++' | '--', row: number): (value: Scalar, frame: Frame) => Scalar {
    const sign = operator === '++' ? 1 : -1;
    if (type.kind === 'pointer') {
      if (!isComplete(type.to) && type.to.kind !== 'void') {
        this.error(row, `中身が定義されていない型（${typeName(type.to)}）へのポインタには、${operator} を使えません。`);
      }
      const size = sizeOf(type.to) * sign;
      return (value, frame) => offsetAddress(frame, value as number, size);
    }
    if (isArithmetic(type)) {
      if (type.kind === 'int' && type.name === 'bool') {
        return (value) => (sign === 1 ? 1 : value === 0 ? 1 : 0);
      } else {
        const common = type.kind === 'int' ? commonType(type, INT) : type;
        const operation = binaryOperation(sign === 1 ? '+' : '-', common);
        const one = oneOf(common);
        return (value) => convertScalar(operation(convertScalar(value, type, common), one), common, type);
      }
    } else {
      this.error(row, `「${operator}」は数かポインタにしか使えません（${typeName(type)}）。`);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Assignment conversion, target resolution, and pointer provenance must share the cached right operand.
  private assignment(expression: Extract<Expression, { kind: 'assign' }>): Operand {
    const { row, operator } = expression;
    const target = this.expression(expression.left);
    this.requireModifiable(target, row, operator ? `${operator}=` : '=');
    const type = unqualified(target.type);
    const lvalue = target.lvalue as LValue;
    const source = this.rvalue(expression.right);
    const calculate = operator ? this.compoundOperation(operator, rvalueType(target), source, row) : undefined;
    const value = calculate ? undefined : this.convertForAssignment(source, type, 'assignment', row);
    const execute = (frame: Frame): Evaluated => {
      const evaluated = calculate ? evaluate(calculate.right, frame) : evaluate(value as Evaluator, frame);
      const location = lvalue.resolve(frame);
      const previous = calculate
        ? { value: location.load(), range: location.range?.(), bytes: location.bytes?.() }
        : undefined;
      const result = calculate
        ? convertScalar(
            calculate.apply(frame, previous!.value as Scalar, evaluated.value as Scalar),
            calculate.type,
            type
          )
        : evaluated.value;
      const metadata = calculate
        ? type.kind === 'pointer'
          ? { value: result, range: previous!.range }
          : arithmeticResult(result as Scalar, [previous!, evaluated], frame.runtime.budget, operator)
        : evaluated;
      const range = metadata.range;
      if (type.kind === 'pointer' && range) checkAddress({ address: result as number, ...range }, 0);
      const bytes = metadata.bytes;
      location.store(result, range, bytes);
      if (lvalue.local) frame.live[lvalue.local.index] = true;
      return { value: lvalue.isBitField ? location.load() : result, range, bytes };
    };
    return resultOperand(type, execute, target.bitWidth);
  }

  private compoundOperation(
    operator: BinaryOperator,
    type: CType,
    right: Operand,
    row: number
  ): { type: CType; right: Evaluator; apply: (frame: Frame, previous: Scalar, other: Scalar) => Scalar } {
    if (type.kind === 'pointer' && (operator === '+' || operator === '-') && isInteger(right.type)) {
      const size = this.pointerElementSize(type, row) * (operator === '+' ? 1 : -1);
      return {
        type,
        right: this.converted(right, LONG),
        apply: (frame, previous, other) => offsetAddress(frame, previous as number, Number(other) * size),
      };
    }
    if (!isArithmetic(type) || !isArithmetic(right.type))
      this.error(row, `「${operator}=」の左右の型（${typeName(type)} と ${typeName(right.type)}）では計算できません。`);
    const operation = this.arithmeticOperation(operator, type, right.type, row);
    return {
      type: operation.type,
      right: this.converted(right, operation.right),
      apply: (_frame, previous, other) => operation.run(convertScalar(previous, type, operation.left), other),
    };
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Keep C cast admissibility and static-address classification together with the resulting conversion.
  private cast(target: CType, operand: Operand, row: number): Operand {
    const type = unqualified(target);
    const source = operand.type;
    if (type.kind === 'void') {
      const effect = operand.effect ?? operand.value;
      return { type: VOID, value: (frame) => (effect(frame), 0), effect };
    }
    if (type.kind === 'array' || type.kind === 'function')
      this.error(row, `${typeName(type)} にはキャストできません。`);
    if (type.kind === 'record') {
      this.error(row, '構造体・共用体の型へのキャストはできません。');
    }
    if (!isScalar(source)) this.error(row, `${typeName(source)} の値は ${typeName(type)} にキャストできません。`);
    if ((type.kind === 'pointer' && source.kind === 'float') || (type.kind === 'float' && source.kind === 'pointer')) {
      this.error(row, `${typeName(source)} の値は ${typeName(type)} にキャストできません。`);
    }
    const convert = this.converted(operand, type);
    const constant =
      operand.constant !== undefined && isArithmetic(type)
        ? convertedConstant(operand.constant, source, type)
        : undefined;
    const result: Operand = {
      ...resultOperand(type, (frame) => evaluate(convert, frame)),
      ...(constant === undefined ? {} : { constant }),
      isAddressConstant: operand.isAddressConstant && type.kind === 'pointer',
    };
    if (type.kind === 'pointer' && isNullConstant(operand)) return { ...result, constant: 0, isAddressConstant: true };
    return result;
  }

  private sizeofType(type: CType, row: number): Operand {
    if (type.kind === 'function') return constantOperand(SIZE_T, 1n);
    if (type.kind === 'void') return constantOperand(SIZE_T, 1n);
    if (!isComplete(type)) this.error(row, `中身が決まっていない型（${typeName(type)}）に sizeof は使えません。`);
    return constantOperand(SIZE_T, BigInt(sizeOf(type)));
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Conditional evaluation and constant folding share the selected branch and result type.
  private conditional(expression: Extract<Expression, { kind: 'conditional' }>): Operand {
    const { row } = expression;
    const condition = this.rvalue(expression.condition);
    this.requireScalar(condition, row, '?');
    const truth = this.truthOf(condition);
    const whenTrue = this.rvalue(expression.consequent);
    const whenFalse = this.rvalue(expression.alternative);
    const type = this.conditionalType(whenTrue, whenFalse, row);
    const a = this.converted(whenTrue, type);
    const b = this.converted(whenFalse, type);
    const value = (frame: Frame): Value => (truth(frame) ? a(frame) : b(frame));
    if (condition.constant !== undefined) {
      const chosen = isZero(condition.constant) ? whenFalse : whenTrue;
      if (chosen.constant !== undefined && isArithmetic(type)) {
        return { type, value, constant: convertedConstant(chosen.constant, chosen.type, type) };
      }
    }
    return resultOperand(type, (frame) => evaluate(truth(frame) ? a : b, frame));
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- C conditional expressions have distinct arithmetic, pointer, record, and void rules; retain the single type-selection dispatch.
  private conditionalType(a: Operand, b: Operand, row: number): CType {
    const at = a.type;
    const bt = b.type;
    if (isArithmetic(at) && isArithmetic(bt)) return commonType(at, bt);
    if (at.kind === 'void' && bt.kind === 'void') return VOID;
    if (at.kind === 'record' && bt.kind === 'record' && at.info === bt.info) return unqualified(at);
    if (at.kind === 'pointer' && isNullConstant(b)) return at;
    if (bt.kind === 'pointer' && isNullConstant(a)) return bt;
    if (at.kind === 'pointer' && bt.kind === 'pointer') {
      if (isVoidPointer(at) || isVoidPointer(bt)) return pointerTo(VOID);
      return at;
    }
    // clang accepts a pointer and an integer with a warning, giving the pointer type.
    if (at.kind === 'pointer' && isInteger(bt)) return at;
    if (bt.kind === 'pointer' && isInteger(at)) return bt;
    this.error(row, `条件演算子の2つの値の型（${typeName(at)} と ${typeName(bt)}）が合いません。`);
  }

  // Calls -----------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 18 -- Direct builtin handling and indirect calls converge on the same argument validation; keep that resolution together.
  private call(expression: Extract<Expression, { kind: 'call' }>): Operand {
    const { row } = expression;
    let direct: FunctionInfo | undefined;
    if (expression.callee.kind === 'identifier') {
      const feature = UNSUPPORTED_NAMES[expression.callee.name];
      if (feature && !this.scope.lookup(expression.callee.name)) unsupported(row, feature);
      const entity = this.scope.lookup(expression.callee.name);
      if (!entity) this.undeclaredFunction(expression.callee.name, row);
      if (entity.kind === 'function') {
        direct = entity.fn;
        this.checkFunctionUse(direct, row);
        const special = this.specialCall(direct.name);
        if (special && direct.header !== undefined) {
          const result = special(this, expression, direct);
          if (result) return result;
        }
      }
    }
    const callee = this.rvalue(expression.callee);
    const calleeType = callee.type;
    if (calleeType.kind !== 'pointer' || calleeType.to.kind !== 'function') {
      this.error(expression.operatorRow ?? row, `関数ではないもの（${typeName(callee.type)}）を呼び出しています。`);
    }
    const fnType = calleeType.to;
    const { args, argTypes } = this.arguments(fnType, expression.args, expression.operatorRow ?? row, direct?.name);
    return this.callOperand(fnType, callee.value as (frame: Frame) => number, direct, args, argTypes, row);
  }

  protected undeclaredFunction(name: string, row: number): never {
    this.error(row, `関数「${name}」は宣言されていません（使う前に宣言するか、ヘッダを #include してください）。`);
  }

  /** Converts a call's arguments to the parameters' types, or promotes them where the function declares none. */
  // code-gauge-allow functionCognitiveComplexity 20 -- Prototype, variadic, and default-promotion rules form one ordered argument-validation pass.
  arguments(
    fnType: FunctionType,
    argExpressions: Expression[],
    row: number,
    name?: string
  ): { args: Evaluator[]; argTypes: CType[] } {
    const params = fnType.params;
    const what = name ? `関数「${name}」` : '関数';
    if (params) {
      if (argExpressions.length < params.length)
        this.error(row, `${what}の引数が足りません（${params.length} 個必要です）。`);
      if (argExpressions.length > params.length && !fnType.variadic) {
        this.error(row, `${what}の引数が多すぎます（${params.length} 個です）。`);
      }
    }
    const args: Evaluator[] = [];
    const argTypes: CType[] = [];
    for (const [index, argExpression] of argExpressions.entries()) {
      const operand = this.rvalue(argExpression);
      const param = params?.[index];
      if (operand.type.kind === 'void') this.error(argExpression.row, 'void の値は引数に渡せません。');
      if (param) {
        args.push(this.convertForAssignment(operand, unqualified(param), 'argument', argExpression.row));
        argTypes.push(unqualified(param));
        continue;
      }
      const promoted = defaultPromotion(operand.type);
      if (promoted.kind === 'record' && !isComplete(promoted))
        this.error(argExpression.row, '中身が定義されていない型の値は渡せません。');
      args.push(this.converted(operand, promoted));
      argTypes.push(promoted);
    }
    return { args, argTypes };
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Call validation and pointer-return capture must bracket the same invocation.
  callOperand(
    fnType: FunctionType,
    callee: (frame: Frame) => number,
    direct: FunctionInfo | undefined,
    args: Evaluator[],
    argTypes: CType[],
    row: number
  ): Operand {
    const ret = unqualified(fnType.ret);
    const invoke = (frame: Frame): Value | undefined => {
      const address = direct ? undefined : callee(frame);
      const values = args.map((arg) => evaluate(arg, frame));
      const fn = direct ?? frame.runtime.functions.get(address!);
      if (!fn) throw new CRuntimeError(address === 0 ? 'nullAccess' : 'badFunctionPointer');
      return frame.runtime.call(
        fn,
        values.map((item) => item.value),
        argTypes,
        row,
        undefined,
        values
      );
    };
    const effect = (frame: Frame): void => {
      invoke(frame);
    };
    if (ret.kind === 'void') return { type: VOID, value: (frame) => (invoke(frame), 0), effect, isCall: true };
    if (ret.kind === 'record' && !isComplete(ret))
      this.error(row, '中身が定義されていない型の値を返す関数は呼び出せません。');
    return {
      ...resultOperand(ret, (frame) => {
        const value = invoke(frame);
        if (value === undefined) throw new CRuntimeError('missingReturn');
        return { value, range: frame.runtime.returnRange, bytes: frame.runtime.returnBytes };
      }),
      effect,
      isCall: true,
    };
  }

  // Members and subscripts ------------------------------------------------------------------------------------------

  private subscript(expression: Extract<Expression, { kind: 'subscript' }>): Operand {
    const { row } = expression;
    let array = this.rvalue(expression.array);
    let index = this.rvalue(expression.index);
    if (isInteger(array.type) && index.type.kind === 'pointer') [array, index] = [index, array];
    if (array.type.kind !== 'pointer')
      this.error(row, `添字（[]）は配列やポインタにしか使えません（${typeName(array.type)}）。`);
    if (!isInteger(index.type)) this.error(row, `添字には整数を書いてください（${typeName(index.type)}）。`);
    const target = array.type.to;
    if (target.kind === 'void') this.error(row, 'void * には添字（[]）を使えません。');
    if (target.kind === 'function') this.error(row, '関数ポインタには添字（[]）を使えません。');
    if (!isComplete(target)) this.error(row, `中身が定義されていない型（${typeName(target)}）の要素は読めません。`);
    const size = sizeOf(target);
    const offset = this.converted(index, LONG);
    const address = (frame: Frame): Address => {
      const original = array.pointer?.(frame) ?? boundPointer(frame, array.value(frame) as number, target);
      const at = pointerAddress(original) + Number(offset(frame)) * size;
      return typeof original === 'number' ? at : { ...original, address: at };
    };
    const operand = this.memoryOperand(target, address);
    const isStatic = array.isAddressConstant === true && index.constant !== undefined;
    return {
      ...operand,
      isAddressConstant: isStatic && target.kind === 'array',
      lvalue: {
        ...(operand.lvalue as LValue),
        isStatic,
        local: array.arrayObject ? array.lvalue?.local : undefined,
        isRegister: array.arrayObject && array.lvalue?.isRegister,
      },
    };
  }

  // code-gauge-allow functionCognitiveComplexity 23 -- Record values, lvalues, arrows, and bit-fields share one field lookup; keep those access alternatives together.
  // code-gauge-allow functionNcss 47 -- Record values, lvalues, arrows, and bit-fields share one field lookup; keep those access alternatives together.
  private member(expression: Extract<Expression, { kind: 'member' }>): Operand {
    const { row, field: name, arrow } = expression;
    let recordType: RecordType;
    let address: ((frame: Frame) => number) | undefined;
    let object: Operand;
    if (arrow) {
      object = this.rvalue(expression.object);
      const type = object.type;
      if (type.kind !== 'pointer' || type.to.kind !== 'record') {
        this.error(row, `「->」は構造体・共用体へのポインタにしか使えません（${typeName(type)}）。`);
      }
      recordType = type.to;
      address = (frame) => checkAddress(pointerEvaluator(object).pointer!(frame), sizeOf(recordType));
    } else {
      object = this.expression(expression.object);
      if (object.type.kind !== 'record')
        this.error(row, `「.」は構造体・共用体にしか使えません（${typeName(object.type)}）。`);
      recordType = object.type;
      address = object.lvalue?.address;
    }
    const info = recordType.info;
    if (!info.isComplete)
      this.error(row, `「${typeName(recordType)}」は中身が定義されていないので、メンバを使えません。`);
    const field = info.field(name);
    if (!field) this.error(row, `「${typeName(unqualified(recordType))}」にはメンバ「${name}」がありません。`);
    const fieldType = isConstQualified(recordType)
      ? withQualifiers(field.type, true, recordType.isVolatile === true)
      : field.type;
    const isTemporary = address === undefined;
    address ??= (frame) => frame.runtime.materialize(object.value(frame) as RecordValue, recordType).base;
    const base = address;
    const offset = field.offset;
    if (field.bitWidth !== undefined) {
      const operand = this.bitFieldOperand(
        fieldType as IntType,
        (frame) => base(frame) + offset,
        field.bitOffset ?? 0,
        field.bitWidth
      );
      return {
        ...operand,
        lvalue: isTemporary ? undefined : { ...operand.lvalue!, local: !arrow ? object.lvalue?.local : undefined },
      };
    }
    const operand = this.memoryOperand(fieldType as CType, (frame) => base(frame) + offset);
    const isStatic = !arrow && object.lvalue?.isStatic === true;
    return {
      ...operand,
      isAddressConstant: isStatic && fieldType.kind === 'array',
      lvalue: isTemporary
        ? undefined
        : {
            ...(operand.lvalue as LValue),
            isStatic,
            local: !arrow ? object.lvalue?.local : undefined,
            isRegister: !arrow && object.lvalue?.isRegister,
          },
    };
  }

  private bitFieldOperand(type: IntType, unit: (frame: Frame) => number, bitOffset: number, width: number): Operand {
    const size = sizeOf(type);
    const resolve = (frame: Frame): Location => {
      const address = unit(frame);
      return {
        load: () => {
          const block = frame.runtime.memory.locate(address, size);
          const offset = address - block.base;
          return readBits(block, offset, bitOffset, width, type);
        },
        store: (value) => {
          const block = frame.runtime.memory.locate(address, size);
          if (block.isReadOnly) throw new CRuntimeError('readOnly');
          const offset = address - block.base;
          writeBits(block, offset, bitOffset, width, value as Scalar);
        },
      };
    };
    return {
      type,
      bitWidth: width,
      value: (frame) => resolve(frame).load(),
      lvalue: { resolve, address: unit, isBitField: true },
    };
  }

  // Conversions -----------------------------------------------------------------------------------------------------

  /** Converts an rvalue to a type, which the caller has checked it may be converted to. */
  // code-gauge-allow functionCognitiveComplexity 18 -- Scalar conversion, the plain-value fast path, and metadata propagation must describe the same type conversion.
  converted(operand: Operand, type: CType): Evaluator {
    const from = operand.type;
    const original = evaluatorOf(operand);
    if (from.kind === 'record' || type.kind === 'record' || type.kind === 'void') return original;
    if (operand.constant !== undefined && isScalar(type)) {
      const constant = convertedConstant(operand.constant, from, type);
      if (constant !== undefined) return () => constant;
    }
    const read = (frame: Frame): Evaluated => {
      const result = evaluate(original, frame);
      const value = convertScalar(result.value as Scalar, from, type);
      if (from.kind === 'float' || type.kind === 'float' || (type.kind === 'int' && type.name === 'bool'))
        return { value };
      const size = sizeOf(type);
      return { value, range: size >= 8 ? result.range : undefined, bytes: slicePointerBytes(result.bytes, 0, size) };
    };
    const same =
      from.kind === type.kind &&
      (from.kind === 'pointer' || ('name' in from && 'name' in type && from.name === type.name));
    const value = (frame: Frame): Value =>
      same ? operand.value(frame) : convertScalar(operand.value(frame) as Scalar, from, type);
    return Object.assign(value, {
      read: Object.assign(read, { always: !!original.pointer || original.read?.always === true }),
    });
  }

  /** Converts a value as assignment does, rejecting the conversions clang rejects. */
  // code-gauge-allow functionCognitiveComplexity 30 -- C's rules for simple assignment, with clang's errors.
  convertForAssignment(operand: Operand, target: CType, context: ConversionContext, row: number): Evaluator {
    const source = operand.type;
    const type = unqualified(target);
    const fail = (detail = ''): never =>
      this.error(
        row,
        `${typeName(source)} の値は、${typeName(type)} の${CONTEXT_WORDS[context]}${context === 'argument' || context === 'return' ? '' : 'に'}使えません。${detail}`
      );
    if (source.kind === 'void') this.error(row, 'void の値は使えません。');
    if (isArithmetic(type) && isArithmetic(source)) return this.converted(operand, type);
    if (type.kind === 'int' && type.name === 'bool' && source.kind === 'pointer') {
      const value = operand.value;
      return (frame) => (value(frame) === 0 ? 0 : 1);
    }
    if (type.kind === 'record') {
      if (source.kind === 'record' && source.info === type.info) return operand.value;
      fail();
    }
    if (type.kind === 'pointer') {
      if (isNullConstant(operand)) return () => 0;
      if (source.kind === 'pointer') {
        const targetIsFunction = type.to.kind === 'function';
        const sourceIsFunction = source.to.kind === 'function';
        if (targetIsFunction && sourceIsFunction && !compatible(type.to, source.to))
          fail('（関数ポインタの型が合いません）');
        return pointerEvaluator(operand);
      }
      if (isInteger(source)) fail('（整数はポインタに変換できません）');
      fail();
    }
    if (isInteger(type) && source.kind === 'pointer') fail('（ポインタは整数に変換できません）');
    return fail();
  }

  // Checks ----------------------------------------------------------------------------------------------------------

  requireScalar(operand: Operand, row: number, operator: string): void {
    if (!isScalar(operand.type)) {
      this.error(row, `「${operator}」には数かポインタを書いてください（${typeName(operand.type)}）。`);
    }
  }

  /** Reads a scalar as a condition, which is true when it does not compare equal to zero. */
  truthOf(operand: Operand): (frame: Frame) => boolean {
    const value = operand.value;
    if (operand.type.kind === 'int' && INT_PROPERTIES[operand.type.name].size === 8)
      return (frame) => value(frame) !== 0n;
    return (frame) => {
      const result = value(frame);
      return result !== 0;
    };
  }

  condition(expression: Expression, what: string): (frame: Frame) => boolean {
    const operand = this.rvalue(expression);
    if (!isScalar(operand.type)) {
      this.error(expression.row, `${what}の条件には、数かポインタを書いてください（${typeName(operand.type)}）。`);
    }
    const truth = this.truthOf(operand);
    return (frame) => frame.runtime.fullExpression(() => truth(frame));
  }

  protected requireModifiable(operand: Operand, row: number, operator: string): void {
    const type = operand.type;
    if (!operand.lvalue || type.kind === 'function') {
      this.error(row, `「${operator}」の左側には、変数や配列の要素など、値を入れられるものを書いてください。`);
    }
    if (type.kind === 'array')
      this.error(row, '配列そのものには代入できません（要素ごとに代入するか、memcpy・strcpy を使ってください）。');
    if (isConstQualified(type)) {
      const name = operand.lvalue.local?.name;
      this.error(row, name ? `const の変数「${name}」には代入できません。` : 'const の付いた値には代入できません。');
    }
    if (hasConstMember(type)) this.error(row, 'const のメンバを持つ構造体には、まとめて代入できません。');
    if (!isComplete(type)) this.error(row, `中身が定義されていない型（${typeName(type)}）には代入できません。`);
  }
}

/** A name that stddef.h declares, telling that the program included it and may use offsetof. */
export const OFFSETOF_MARKER = '__offsetof_is_declared';

export function convertedConstant(value: Scalar, source: CType, target: CType): Scalar | undefined {
  try {
    return convertScalar(value, source, target);
  } catch (error) {
    if (!(error instanceof CRuntimeError)) throw error;
    return undefined;
  }
}

function rvalueType(operand: Operand): CType {
  return operand.bitWidth !== undefined &&
    operand.type.kind === 'int' &&
    ['bool', 'int', 'uint'].includes(operand.type.name) &&
    operand.bitWidth < 32
    ? INT
    : decay(operand.type);
}

const RELATIONAL = new Set<string>(['<', '>', '<=', '>=']);

/** Names that clang defines in C17 for features the interpreter leaves out. */
const UNSUPPORTED_NAMES: Record<string, string> = {
  __func__: '__func__',
  __FUNCTION__: '__FUNCTION__',
  __PRETTY_FUNCTION__: '__PRETTY_FUNCTION__',
  _Static_assert: '_Static_assert',
  static_assert: '_Static_assert',
};

// Helpers -------------------------------------------------------------------------------------------------------------

export function constantOperand(type: CType, value: Scalar): Operand {
  return { type, value: () => value, constant: value };
}

function fold(
  type: CType,
  value: (frame: Frame) => Value,
  operand: Operand,
  compute: () => Scalar,
  read?: MetadataReader
): Operand {
  if (read) read.always = operand.read?.always;
  if (operand.constant === undefined) return { type, value, read };
  try {
    const constant = compute();
    return { type, value: () => constant, constant };
  } catch (error) {
    if (error instanceof CRuntimeError) return { type, value };
    throw error;
  }
}

function foldBinary(
  type: CType,
  value: (frame: Frame) => Value,
  left: Operand,
  right: Operand,
  compute: () => Scalar,
  read?: MetadataReader
): Operand {
  if (read) read.always = left.read?.always || right.read?.always;
  if (left.constant === undefined || right.constant === undefined) return { type, value, read };
  try {
    const constant = compute();
    return { type, value: () => constant, constant };
  } catch (error) {
    if (error instanceof CRuntimeError) return { type, value };
    throw error;
  }
}

function logicalConstant(
  operator: '&&' | '||',
  left: Scalar | undefined,
  right: Scalar | undefined
): number | undefined {
  if (left === undefined) return undefined;
  if (operator === '&&' ? isZero(left) : !isZero(left)) return operator === '&&' ? 0 : 1;
  return right === undefined ? undefined : isZero(right) ? 0 : 1;
}

export function isNullConstant(operand: Operand): boolean {
  return (
    operand.constant !== undefined &&
    isZero(operand.constant) &&
    (operand.type.kind === 'int' || isVoidPointer(operand.type))
  );
}

/** The default argument promotions, which apply to arguments that no parameter type governs. */
export function defaultPromotion(type: CType): CType {
  if (type.kind === 'int') return promote(type);
  if (type.kind === 'float' && type.name === 'float') return DOUBLE;
  return unqualified(type);
}

/**
 * Adds an offset to an address, stopping the program when the result leaves the block it pointed into (one past the
 * end is allowed), which C leaves undefined.
 */
export function offsetAddress(frame: Frame, address: number, delta: number): number {
  if (delta === 0) return address;
  const result = address + delta;
  const memory = frame.runtime.memory;
  const block = memory.find(address) ?? (address > 0 ? memory.find(address - 1) : undefined);
  if (block && block.region !== 'text' && (result < block.base || result > block.end)) {
    throw new CRuntimeError('pointerOutOfRange');
  }
  return result;
}

export function readBits(record: RecordValue, offset: number, bitOffset: number, width: number, type: IntType): Scalar {
  const { bytes, initialized } = record;
  const mask = ((1n << BigInt(width)) - 1n) << BigInt(bitOffset);
  for (let index = 0; index < sizeOf(type); index++) {
    const required = Number((mask >> BigInt(index * 8)) & 255n);
    if ((initialized[offset + index] & required) !== required) throw new CRuntimeError('uninitialized');
  }
  let raw = 0n;
  const size = sizeOf(type);
  for (let index = size - 1; index >= 0; index--) raw = (raw << 8n) | BigInt(bytes[offset + index]);
  let field = (raw >> BigInt(bitOffset)) & ((1n << BigInt(width)) - 1n);
  const signed = INT_PROPERTIES[type.name].signed;
  if (signed && width > 0 && (field >> BigInt(width - 1)) & 1n) field -= 1n << BigInt(width);
  return size === 8 ? field : Number(field);
}

export function writeBits(record: RecordValue, offset: number, bitOffset: number, width: number, value: Scalar): void {
  const { bytes, initialized } = record;
  const mask = ((1n << BigInt(width)) - 1n) << BigInt(bitOffset);
  let size = 0;
  while (size < 8 && offset + size < bytes.length && mask >> BigInt(size * 8) > 0n) size++;
  if (record.pointerBytes) replacePointerBytes(record.pointerBytes, offset, size);
  let raw = 0n;
  for (let index = size - 1; index >= 0; index--) raw = (raw << 8n) | BigInt(bytes[offset + index]);
  raw = (raw & ~mask) | ((BigInt(value) << BigInt(bitOffset)) & mask);
  for (let index = 0; index < size; index++) {
    bytes[offset + index] = Number((raw >> BigInt(index * 8)) & 0xffn);
    initialized[offset + index] |= Number((mask >> BigInt(index * 8)) & 255n);
  }
}

export function readScalar(view: DataView, offset: number, type: CType): Scalar {
  if (type.kind === 'float')
    return type.name === 'float' ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
  if (type.kind === 'pointer') return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 2 ** 32;
  if (type.kind !== 'int') throw new Error('Not a scalar type');
  switch (type.name) {
    case 'bool': {
      return view.getUint8(offset) === 0 ? 0 : 1;
    }
    case 'char':
    case 'schar': {
      return view.getInt8(offset);
    }
    case 'uchar': {
      return view.getUint8(offset);
    }
    case 'short': {
      return view.getInt16(offset, true);
    }
    case 'ushort': {
      return view.getUint16(offset, true);
    }
    case 'int': {
      return view.getInt32(offset, true);
    }
    case 'uint': {
      return view.getUint32(offset, true);
    }
    case 'long':
    case 'llong': {
      return view.getBigInt64(offset, true);
    }
    default: {
      return view.getBigUint64(offset, true);
    }
  }
}

export { BOOL, isRecordValue };
