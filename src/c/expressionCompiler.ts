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
import { type Frame, type FunctionInfo, loaderOf, loadRecord, storeRecord, storerOf } from './runtime';
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
    return { ...operand, type: rvalueType(operand) };
  }

  expression(expression: Expression): Operand {
    const { row } = expression;
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
        return { ...this.expression(expression.expression), isParenthesized: true };
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
        const operand = this.expression(expression.operand);
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
        const value = right.value;
        return { type: right.type, value: (frame) => (leftEffect(frame), value(frame)) };
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
        const index = global.index;
        const operand = this.memoryOperand(entity.type, (frame) => frame.runtime.globals[index].base);
        return {
          ...(entity.constant === undefined ? {} : { constant: entity.constant }),
          ...operand,
          isAddressConstant: entity.type.kind === 'array',
          lvalue: { ...(operand.lvalue as LValue), isStatic: true },
        };
      }
      case 'local': {
        const { local } = entity;
        const folded = entity.constant === undefined ? {} : { constant: entity.constant };
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
          return { ...operand, ...folded, lvalue: { ...(operand.lvalue as LValue), local } };
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
          ...folded,
          lvalue: {
            resolve: (frame) => ({
              load: () => load(frame),
              store: (value) => {
                frame.slots[index] = value as Scalar;
              },
            }),
            local,
            isRegister: this.fn?.registerLocals.has(local) ?? false,
          },
        };
      }
    }
  }

  protected memoryOperand(type: CType, address: (frame: Frame) => number): Operand {
    const resolve = (frame: Frame): Location => {
      const at = address(frame);
      if (type.kind === 'array' || type.kind === 'function') return { load: () => at, store: () => {} };
      if (type.kind === 'record')
        return {
          load: () => loadRecord(frame.runtime, at, sizeOf(type)),
          store: (value) => storeRecord(frame.runtime, at, value as RecordValue),
        };
      if (type.kind === 'void') return { load: () => 0, store: () => {} };
      return {
        load: () => loaderOf(type)(frame.runtime, at),
        store: (value) => storerOf(type)(frame.runtime, at, value as Scalar),
      };
    };
    return { type, value: (frame) => resolve(frame).load(), lvalue: { resolve, address } };
  }

  private stringLiteral(parts: string[], row: number): Operand {
    const bytes = decodeStringLiteral(parts, row);
    const index = this.stringIndex(bytes);
    const type: CType = { kind: 'array', of: { kind: 'int', name: 'char' }, length: bytes.length };
    const address = (frame: Frame): number => frame.runtime.literals[index].base;
    return { ...this.memoryOperand(type, address), isAddressConstant: true };
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
    const constant = logicalConstant(operator, left.constant, right.constant, value);
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
    return foldBinary(operation.type, (frame) => operation.run(a(frame) as Scalar, b(frame) as Scalar), left, right);
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
    const base = pointer.value;
    const index = this.converted(offset, LONG);
    const value = (frame: Frame): Value => {
      const address = base(frame) as number;
      const delta = Number(index(frame)) * size * sign;
      return offsetAddress(frame, address, delta);
    };
    return { type, value, isAddressConstant: pointer.isAddressConstant && offset.constant !== undefined };
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
      return fold(INT, (frame) => (truth(frame) ? 0 : 1), operand);
    }
    if (operator === '~') {
      if (type.kind !== 'int') this.error(row, `「~」は整数にしか使えません（${typeName(type)}）。`);
      const promoted = promote(type);
      const value = this.converted(operand, promoted);
      const operation = complement(promoted);
      return fold(promoted, (frame) => operation(value(frame) as Scalar), operand);
    }
    if (!isArithmetic(type)) this.error(row, `「${operator}」は数にしか使えません（${typeName(type)}）。`);
    const promoted = type.kind === 'int' ? promote(type) : unqualified(type);
    const value = this.converted(operand, promoted);
    if (operator === '+') return fold(promoted, value, operand);
    const operation = negate(promoted);
    return fold(promoted, (frame) => operation(value(frame) as Scalar), operand);
  }

  dereference(operand: Operand, row: number): Operand {
    const type = operand.type;
    if (type.kind !== 'pointer') this.error(row, `「*」はポインタにしか使えません（${typeName(type)}）。`);
    const target = type.to;
    if (target.kind === 'void') this.error(row, 'void * の指す先は読めません（型を決めるキャストをしてください）。');
    if (target.kind === 'function') return { type: target, value: operand.value };
    const address = operand.value as (frame: Frame) => number;
    if (target.kind === 'record' && !target.info.isComplete) {
      return {
        type: target,
        value: () => this.error(row, '中身が定義されていない型の値は使えません。'),
        lvalue: { resolve: () => ({ load: () => 0, store: () => {} }), address },
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
    return { type: pointerTo(type), value: address, isAddressConstant: isStatic };
  }

  private update(expression: Extract<Expression, { kind: 'update' }>): Operand {
    const { row } = expression;
    const operand = this.expression(expression.operand);
    this.requireModifiable(operand, row, expression.operator);
    const type = unqualified(operand.type);
    const lvalue = operand.lvalue as LValue;
    const step = this.updateOperation(type, expression.operator, row);
    const value = (frame: Frame): Value => {
      const location = lvalue.resolve(frame);
      const previous = location.load() as Scalar;
      const next = step(previous, frame);
      location.store(next);
      return expression.prefix ? (lvalue.isBitField ? location.load() : next) : previous;
    };
    return { type, value, bitWidth: operand.bitWidth };
  }

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

  private assignment(expression: Extract<Expression, { kind: 'assign' }>): Operand {
    const { row, operator } = expression;
    const target = this.expression(expression.left);
    this.requireModifiable(target, row, operator ? `${operator}=` : '=');
    const type = unqualified(target.type);
    const lvalue = target.lvalue as LValue;
    const source = this.rvalue(expression.right);
    const calculate = operator ? this.compoundOperation(operator, rvalueType(target), source, row) : undefined;
    const value = calculate ? undefined : this.convertForAssignment(source, type, 'assignment', row);
    return {
      type,
      bitWidth: target.bitWidth,
      value: (frame) => {
        const location = lvalue.resolve(frame);
        const result = calculate
          ? convertScalar(calculate(frame, location.load() as Scalar), calculate.type, type)
          : (value as (frame: Frame) => Value)(frame);
        location.store(result);
        return lvalue.isBitField ? location.load() : result;
      },
    };
  }

  private compoundOperation(
    operator: BinaryOperator,
    type: CType,
    right: Operand,
    row: number
  ): ((frame: Frame, previous: Scalar) => Scalar) & { type: CType } {
    if (type.kind === 'pointer' && (operator === '+' || operator === '-') && isInteger(right.type)) {
      const size = this.pointerElementSize(type, row) * (operator === '+' ? 1 : -1);
      const offset = this.converted(right, LONG);
      return Object.assign(
        (frame: Frame, previous: Scalar) => offsetAddress(frame, previous as number, Number(offset(frame)) * size),
        { type }
      );
    }
    if (!isArithmetic(type) || !isArithmetic(right.type))
      this.error(row, `「${operator}=」の左右の型（${typeName(type)} と ${typeName(right.type)}）では計算できません。`);
    const operation = this.arithmeticOperation(operator, type, right.type, row);
    const value = this.converted(right, operation.right);
    return Object.assign(
      (frame: Frame, previous: Scalar) =>
        operation.run(convertScalar(previous, type, operation.left), value(frame) as Scalar),
      { type: operation.type }
    );
  }

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
    const value = operand.value;
    const convert = (frame: Frame): Value => convertScalar(value(frame) as Scalar, source, type);
    const constant =
      operand.constant !== undefined && isArithmetic(type) ? convertScalar(operand.constant, source, type) : undefined;
    const result: Operand = {
      type,
      value: convert,
      ...(constant === undefined ? {} : { constant }),
      isAddressConstant: operand.isAddressConstant && type.kind === 'pointer',
    };
    if (type.kind === 'pointer' && isVoidPointer(type) && isNullConstant(operand))
      return { ...result, constant: 0, isAddressConstant: true };
    return result;
  }

  private sizeofType(type: CType, row: number): Operand {
    if (type.kind === 'function') return constantOperand(SIZE_T, 1n);
    if (type.kind === 'void') return constantOperand(SIZE_T, 1n);
    if (!isComplete(type)) this.error(row, `中身が決まっていない型（${typeName(type)}）に sizeof は使えません。`);
    return constantOperand(SIZE_T, BigInt(sizeOf(type)));
  }

  private conditional(expression: Extract<Expression, { kind: 'conditional' }>): Operand {
    const { row } = expression;
    const condition = this.rvalue(expression.condition);
    this.requireScalar(condition, row, '?');
    const truth = this.truthOf(condition);
    const whenTrue = this.rvalue(expression.consequent);
    const whenFalse = this.rvalue(expression.alternative);
    const type = this.conditionalType(whenTrue, whenFalse, row);
    const a = type.kind === 'void' || type.kind === 'record' ? whenTrue.value : this.converted(whenTrue, type);
    const b = type.kind === 'void' || type.kind === 'record' ? whenFalse.value : this.converted(whenFalse, type);
    const value = (frame: Frame): Value => (truth(frame) ? a(frame) : b(frame));
    if (condition.constant !== undefined) {
      const chosen = isZero(condition.constant) ? whenFalse : whenTrue;
      if (chosen.constant !== undefined && isArithmetic(type)) {
        return { type, value, constant: convertScalar(chosen.constant, chosen.type, type) };
      }
    }
    return { type, value };
  }

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
      this.error(row, `関数ではないもの（${typeName(callee.type)}）を呼び出しています。`);
    }
    const fnType = calleeType.to;
    const { args, argTypes } = this.arguments(fnType, expression.args, row, direct?.name);
    return this.callOperand(fnType, callee.value as (frame: Frame) => number, direct, args, argTypes, row);
  }

  protected undeclaredFunction(name: string, row: number): never {
    this.error(row, `関数「${name}」は宣言されていません（使う前に宣言するか、ヘッダを #include してください）。`);
  }

  /** Converts a call's arguments to the parameters' types, or promotes them where the function declares none. */
  arguments(
    fnType: FunctionType,
    argExpressions: Expression[],
    row: number,
    name?: string
  ): { args: ((frame: Frame) => Value)[]; argTypes: CType[] } {
    const params = fnType.params;
    const what = name ? `関数「${name}」` : '関数';
    if (params) {
      if (argExpressions.length < params.length)
        this.error(row, `${what}の引数が足りません（${params.length} 個必要です）。`);
      if (argExpressions.length > params.length && !fnType.variadic) {
        this.error(row, `${what}の引数が多すぎます（${params.length} 個です）。`);
      }
    }
    const args: ((frame: Frame) => Value)[] = [];
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
      args.push(promoted === operand.type ? operand.value : this.converted(operand, promoted));
      argTypes.push(promoted);
    }
    return { args, argTypes };
  }

  callOperand(
    fnType: FunctionType,
    callee: (frame: Frame) => number,
    direct: FunctionInfo | undefined,
    args: ((frame: Frame) => Value)[],
    argTypes: CType[],
    row: number
  ): Operand {
    const ret = unqualified(fnType.ret);
    const invoke = direct
      ? (frame: Frame): Value | undefined => {
          const values = args.map((arg) => arg(frame));
          return frame.runtime.call(direct, values, argTypes, row);
        }
      : (frame: Frame): Value | undefined => {
          const address = callee(frame);
          const values = args.map((arg) => arg(frame));
          const fn = frame.runtime.functions.get(address);
          if (!fn) throw new CRuntimeError(address === 0 ? 'nullAccess' : 'badFunctionPointer');
          return frame.runtime.call(fn, values, argTypes, row);
        };
    const effect = (frame: Frame): void => {
      invoke(frame);
    };
    if (ret.kind === 'void') return { type: VOID, value: (frame) => (invoke(frame), 0), effect, isCall: true };
    if (ret.kind === 'record' && !isComplete(ret))
      this.error(row, '中身が定義されていない型の値を返す関数は呼び出せません。');
    return {
      type: ret,
      value: (frame) => {
        const result = invoke(frame);
        if (result === undefined) throw new CRuntimeError('missingReturn');
        return result;
      },
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
    const base = array.value;
    const offset = this.converted(index, LONG);
    const address = (frame: Frame): number => (base(frame) as number) + Number(offset(frame)) * size;
    const operand = this.memoryOperand(target, address);
    const isStatic = array.isAddressConstant === true && index.constant !== undefined;
    return {
      ...operand,
      isAddressConstant: isStatic && target.kind === 'array',
      lvalue: { ...(operand.lvalue as LValue), isStatic },
    };
  }

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
      address = object.value as (frame: Frame) => number;
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
    const fieldType = isConstQualified(recordType) ? { ...field.type, isConst: true } : field.type;
    if (!address) {
      // A member of a struct value, such as a function's result, which is no lvalue.
      const value = object.value;
      const offset = field.offset;
      const size = sizeOf(field.type);
      const temporary = (frame: Frame): Value => {
        const record = value(frame) as RecordValue;
        if (field.bitWidth !== undefined)
          return readBits(record.bytes, offset, field.bitOffset ?? 0, field.bitWidth, field.type as IntType);
        return readFromBytes(record, offset, size, field.type);
      };
      return { type: fieldType as CType, value: temporary, bitWidth: field.bitWidth };
    }
    const base = address;
    const offset = field.offset;
    if (field.bitWidth !== undefined)
      return this.bitFieldOperand(
        fieldType as IntType,
        (frame) => base(frame) + offset,
        field.bitOffset ?? 0,
        field.bitWidth
      );
    const operand = this.memoryOperand(fieldType as CType, (frame) => base(frame) + offset);
    const isStatic = !arrow && object.lvalue?.isStatic === true;
    return {
      ...operand,
      isAddressConstant: isStatic && fieldType.kind === 'array',
      lvalue: { ...(operand.lvalue as LValue), isStatic },
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
          for (let index = 0; index < size; index++) {
            if (block.initialized[offset + index] === 0) throw new CRuntimeError('uninitialized');
          }
          return readBits(block.bytes, offset, bitOffset, width, type);
        },
        store: (value) => {
          const block = frame.runtime.memory.locate(address, size);
          if (block.isReadOnly) throw new CRuntimeError('readOnly');
          const offset = address - block.base;
          writeBits(block.bytes, offset, bitOffset, width, value as Scalar);
          block.initialized.fill(1, offset, offset + size);
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
  converted(operand: Operand, type: CType): (frame: Frame) => Value {
    const from = operand.type;
    const value = operand.value;
    if (from.kind === 'record' || type.kind === 'record' || type.kind === 'void') return value;
    if (operand.constant !== undefined && isScalar(type)) {
      const constant = convertScalar(operand.constant, from, type);
      return () => constant;
    }
    const sameInteger = from.kind === 'int' && type.kind === 'int' && from.name === type.name;
    const sameFloat = from.kind === 'float' && type.kind === 'float' && from.name === type.name;
    if (sameInteger || sameFloat || (from.kind === 'pointer' && type.kind === 'pointer')) return value;
    return (frame) => convertScalar(value(frame) as Scalar, from, type);
  }

  /** Converts a value as assignment does, rejecting the conversions clang rejects. */
  // code-gauge-allow functionCognitiveComplexity 30 -- C's rules for simple assignment, with clang's errors.
  convertForAssignment(
    operand: Operand,
    target: CType,
    context: ConversionContext,
    row: number
  ): (frame: Frame) => Value {
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
        return operand.value;
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
      return result !== 0 && !(typeof result === 'number' && Number.isNaN(result) && false);
    };
  }

  condition(expression: Expression, what: string): (frame: Frame) => boolean {
    const operand = this.rvalue(expression);
    if (!isScalar(operand.type)) {
      this.error(expression.row, `${what}の条件には、数かポインタを書いてください（${typeName(operand.type)}）。`);
    }
    return this.truthOf(operand);
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

function fold(type: CType, value: (frame: Frame) => Value, operand: Operand): Operand {
  if (operand.constant === undefined) return { type, value };
  try {
    const constant = value({} as Frame) as Scalar;
    return { type, value: () => constant, constant };
  } catch (error) {
    if (error instanceof CRuntimeError) return { type, value };
    throw error;
  }
}

function foldBinary(type: CType, value: (frame: Frame) => Value, left: Operand, right: Operand): Operand {
  if (left.constant === undefined || right.constant === undefined) return { type, value };
  try {
    const constant = value({} as Frame) as Scalar;
    return { type, value: () => constant, constant };
  } catch (error) {
    if (error instanceof CRuntimeError) return { type, value };
    throw error;
  }
}

function logicalConstant(
  operator: '&&' | '||',
  left: Scalar | undefined,
  right: Scalar | undefined,
  value: (frame: Frame) => Value
): number | undefined {
  if (left === undefined) return undefined;
  if (operator === '&&' ? isZero(left) : !isZero(left)) return operator === '&&' ? 0 : 1;
  return right === undefined ? undefined : (value({} as Frame) as number);
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

export function readBits(bytes: Uint8Array, offset: number, bitOffset: number, width: number, type: IntType): Scalar {
  let raw = 0n;
  const size = sizeOf(type);
  for (let index = size - 1; index >= 0; index--) raw = (raw << 8n) | BigInt(bytes[offset + index]);
  let field = (raw >> BigInt(bitOffset)) & ((1n << BigInt(width)) - 1n);
  const signed = INT_PROPERTIES[type.name].signed;
  if (signed && width > 0 && (field >> BigInt(width - 1)) & 1n) field -= 1n << BigInt(width);
  return size === 8 ? field : Number(field);
}

function writeBits(bytes: Uint8Array, offset: number, bitOffset: number, width: number, value: Scalar): void {
  const mask = ((1n << BigInt(width)) - 1n) << BigInt(bitOffset);
  let size = 0;
  while (size < 8 && offset + size < bytes.length && mask >> BigInt(size * 8) > 0n) size++;
  let raw = 0n;
  for (let index = size - 1; index >= 0; index--) raw = (raw << 8n) | BigInt(bytes[offset + index]);
  raw = (raw & ~mask) | ((BigInt(value) << BigInt(bitOffset)) & mask);
  for (let index = 0; index < size; index++) bytes[offset + index] = Number((raw >> BigInt(index * 8)) & 0xffn);
}

function readFromBytes(record: RecordValue, offset: number, size: number, type: CType): Value {
  if (type.kind === 'record') {
    return {
      bytes: record.bytes.slice(offset, offset + size),
      initialized: record.initialized.slice(offset, offset + size),
    };
  }
  for (let index = offset; index < offset + size; index++) {
    if (record.initialized[index] === 0) throw new CRuntimeError('uninitialized');
  }
  const view = new DataView(record.bytes.buffer, record.bytes.byteOffset);
  return readScalar(view, offset, type);
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
