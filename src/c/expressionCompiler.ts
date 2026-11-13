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
import { CompilerBase, type Entity, type LValue, type Operand } from './compilerBase';
import { CRuntimeError } from './errors';
import { decodeCharLiteral, decodeStringLiteral, parseNumber } from './literals';
import { type Frame, type FunctionInfo, loaderOf, loadRecord, storeRecord, storerOf } from './runtime';
import {
  alignOf,
  BOOL,
  CHAR,
  commonType,
  compatible,
  type CType,
  decay,
  DOUBLE,
  type FloatType,
  type FunctionType,
  hasConstMember,
  hasVla,
  INT,
  INT_PROPERTIES,
  type IntType,
  isArithmetic,
  isCharType,
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
  sizeIn,
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

  protected typeOfExpression(expression: Expression): CType {
    return unqualified(this.expression(expression).type);
  }

  protected constantOperand(expression: Expression): Operand | undefined {
    const operand = this.expression(expression);
    return operand.constant === undefined ? undefined : operand;
  }

  protected rvalueOf(expression: Expression): Operand {
    return this.rvalue(expression);
  }

  /** An expression as an rvalue: arrays and functions decay to pointers. */
  rvalue(expression: Expression): Operand {
    const operand = this.expression(expression);
    return { ...operand, type: decay(operand.type) };
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
        return this.binaryExpression(expression);
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
        const type = this.typeOfName(expression.typeName);
        return withLengths(this.takePendingVla(), this.cast(type, this.rvalue(expression.operand), row));
      }
      case 'sizeofType': {
        const type = this.typeOfName(expression.typeName);
        return withLengths(this.takePendingVla(), this.sizeofType(type, row));
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
        return this.comma(expression);
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
      case 'vaArg': {
        return this.vaArg(expression);
      }
      case 'compoundLiteral': {
        return this.compoundLiteral(expression);
      }
      case 'alignof': {
        return this.alignof(expression);
      }
      case 'offsetof': {
        return this.offsetof(expression);
      }
    }
  }

  private binaryExpression(expression: Extract<Expression, { kind: 'binary' }>): Operand {
    const { left, row } = expression;
    if (RELATIONAL.has(expression.operator) && left.kind === 'binary' && RELATIONAL.has(left.operator)) {
      this.error(
        row,
        `比較「${left.operator}」と「${expression.operator}」をつなげて書くと、数学の式とは違う意味になります（&& でつないでください）。`
      );
    }
    return this.binary(expression.operator, this.rvalue(expression.left), this.rvalue(expression.right), row);
  }

  private comma(expression: Extract<Expression, { kind: 'comma' }>): Operand {
    const left = this.rvalue(expression.left);
    const right = this.rvalue(expression.right);
    const leftEffect = left.effect ?? left.value;
    const value = right.value;
    return { type: right.type, value: (frame) => (leftEffect(frame), value(frame)) };
  }

  private alignof(expression: Extract<Expression, { kind: 'alignof' }>): Operand {
    const type = this.typeOfName(expression.typeName);
    if (type.kind !== 'void' && !isComplete(type))
      this.error(expression.row, `中身が決まっていない型（${typeName(type)}）に _Alignof は使えません。`);
    return constantOperand(SIZE_T, BigInt(alignOf(type)));
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

  /** Creates the unnamed object of a compound literal, which lives as long as the block or program around it. */
  protected abstract compoundLiteral(expression: Extract<Expression, { kind: 'compoundLiteral' }>): Operand;

  /** `va_arg(ap, T)`: reads the next extra argument of a variadic call and moves `ap` past it. */
  private vaArg(expression: Extract<Expression, { kind: 'vaArg' }>): Operand {
    const { row } = expression;
    if (!this.scope.lookup(STDARG_MARKER)) this.undeclaredFunction('va_arg', row);
    const list = this.vaList(expression.operand, row, 'va_arg');
    const type = unqualified(this.typeOfName(expression.typeName));
    if (type.kind === 'void' || type.kind === 'array' || type.kind === 'function' || !isComplete(type)) {
      this.error(row, `va_arg では ${typeName(type)} の値は読めません。`);
    }
    const { load, store } = list;
    const size = sizeOf(type);
    const read =
      type.kind === 'record'
        ? (frame: Frame, at: number): Value => loadRecord(frame.runtime, at, size)
        : (() => {
            const loader = loaderOf(type);
            return (frame: Frame, at: number): Value => loader(frame.runtime, at);
          })();
    return {
      type,
      value: (frame) => {
        const address = load(frame) as number;
        checkVararg(frame, address, type);
        const value = read(frame, address);
        store(frame, address + Math.ceil(size / 8) * 8);
        return value;
      },
    };
  }

  /** The `va_list` variable that `va_start`, `va_arg`, and `va_copy` take. */
  vaList(expression: Expression, row: number, what: string): LValue {
    const operand = this.expression(expression);
    const type = operand.type;
    if (!operand.lvalue || type.kind !== 'pointer' || !isCharType(type.to)) {
      this.error(row, `${what} の1つ目には、va_list の変数を書いてください。`);
    }
    return operand.lvalue;
  }

  // Names and literals ----------------------------------------------------------------------------------------------

  private identifier(name: string, row: number): Operand {
    const feature = UNSUPPORTED_NAMES[name];
    if (feature && !this.scope.lookup(name)) unsupported(row, feature);
    const entity = this.scope.lookup(name);
    if (!entity && FUNCTION_NAMES.has(name)) {
      // clang gives __func__ outside a function an empty name, with a warning.
      const bytes = new TextEncoder().encode(this.currentFunction?.name ?? '');
      const operand = this.stringLiteral([JSON.stringify(new TextDecoder().decode(bytes))], row);
      return { ...operand, type: { ...operand.type, of: { ...CHAR, isConst: true } } as CType };
    }
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
            load,
            store: (frame, value) => {
              frame.slots[index] = value as Scalar;
            },
            local,
            isRegister: this.fn?.registerLocals.has(local) ?? false,
          },
        };
      }
    }
  }

  /** An object in memory at a computed address, read and written as its type. */
  protected memoryOperand(type: CType, address: (frame: Frame) => number): Operand {
    if (type.kind === 'array' || type.kind === 'function') {
      return {
        type,
        value: address,
        lvalue: { load: address, store: () => {}, address },
      };
    }
    if (type.kind === 'record') {
      const size = sizeOf(type);
      const load = (frame: Frame): Value => loadRecord(frame.runtime, address(frame), size);
      return {
        type,
        value: load,
        lvalue: {
          load,
          store: (frame, value) => storeRecord(frame.runtime, address(frame), value as RecordValue),
          address,
        },
      };
    }
    if (type.kind === 'void') {
      return { type, value: () => 0, lvalue: { load: () => 0, store: () => {}, address } };
    }
    const loader = loaderOf(type);
    const storer = storerOf(type);
    const load = (frame: Frame): Value => loader(frame.runtime, address(frame));
    return {
      type,
      value: load,
      lvalue: { load, store: (frame, value) => storer(frame.runtime, address(frame), value as Scalar), address },
    };
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
    const lt = left.type as IntType | FloatType;
    const rt = right.type as IntType | FloatType;
    const integerOnly = ['%', '<<', '>>', '&', '|', '^'].includes(operator);
    if (integerOnly && (lt.kind !== 'int' || rt.kind !== 'int')) {
      this.error(row, `「${operator}」は整数どうしでしか計算できません（${typeName(lt)} と ${typeName(rt)}）。`);
    }
    if (operator === '<<' || operator === '>>') {
      // A shift has the type of its promoted left operand.
      const type = promote(lt as IntType);
      const operation = binaryOperation(operator, type);
      const a = this.converted(left, type);
      const b = this.converted(right, LONG);
      const count = (frame: Frame): Scalar => Number(b(frame) as Scalar);
      return foldBinary(type, (frame) => operation(a(frame) as Scalar, count(frame)), left, right);
    }
    const common = commonType(lt, rt);
    const operation = binaryOperation(operator, common);
    const a = this.converted(left, common);
    const b = this.converted(right, common);
    const isComparison = ['==', '!=', '<', '<=', '>', '>='].includes(operator);
    const type = isComparison ? INT : common;
    return foldBinary(type, (frame) => operation(a(frame) as Scalar, b(frame) as Scalar), left, right);
  }

  private pointerOffset(pointer: Operand, offset: Operand, sign: 1 | -1, row: number): Operand {
    const type = pointer.type as Extract<CType, { kind: 'pointer' }>;
    if (type.to.kind === 'function') this.error(row, '関数ポインタには、整数を足したり引いたりできません。');
    if (!isComplete(type.to) && type.to.kind !== 'void') {
      this.error(
        row,
        `中身が定義されていない型（${typeName(type.to)}）へのポインタには、整数を足したり引いたりできません。`
      );
    }
    const size = elementSize(type.to);
    const base = pointer.value;
    const index = this.converted(offset, LONG);
    const value = (frame: Frame): Value => {
      const address = base(frame) as number;
      const delta = Number(index(frame)) * size(frame) * sign;
      return offsetAddress(frame, address, delta);
    };
    return { type, value, isAddressConstant: pointer.isAddressConstant && offset.constant !== undefined };
  }

  private pointerDifference(left: Operand, right: Operand, row: number): Operand {
    const lt = left.type as Extract<CType, { kind: 'pointer' }>;
    const rt = right.type as Extract<CType, { kind: 'pointer' }>;
    if (!compatible(unqualified(lt.to), unqualified(rt.to), true)) {
      this.error(row, `型の違うポインタどうし（${typeName(lt)} と ${typeName(rt)}）の差は求められません。`);
    }
    const size = elementSize(lt.to);
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
        return BigInt(Math.trunc((x - y) / size(frame)));
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
        lvalue: { load: () => 0, store: () => {}, address },
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
    const sign = expression.operator === '++' ? 1 : -1;
    let step: (value: Scalar, frame: Frame) => Scalar;
    if (type.kind === 'pointer') {
      if (!isComplete(type.to) && type.to.kind !== 'void') {
        this.error(
          row,
          `中身が定義されていない型（${typeName(type.to)}）へのポインタには、${expression.operator} を使えません。`
        );
      }
      const size = elementSize(type.to);
      step = (value, frame) => offsetAddress(frame, value as number, size(frame) * sign);
    } else if (isArithmetic(type)) {
      if (type.kind === 'int' && type.name === 'bool') {
        step = (value) => (sign === 1 ? 1 : value === 0 ? 1 : 0);
      } else {
        const common = type.kind === 'int' ? commonType(type, INT) : type;
        const operation = binaryOperation(sign === 1 ? '+' : '-', common);
        const one = oneOf(common);
        step = (value) => convertScalar(operation(convertScalar(value, type, common), one), common, type);
      }
    } else {
      this.error(row, `「${expression.operator}」は数かポインタにしか使えません（${typeName(type)}）。`);
    }
    const { load, store } = lvalue;
    const value = expression.prefix
      ? (frame: Frame): Value => {
          const next = step(load(frame) as Scalar, frame);
          store(frame, next);
          return next;
        }
      : (frame: Frame): Value => {
          const previous = load(frame) as Scalar;
          store(frame, step(previous, frame));
          return previous;
        };
    return { type, value };
  }

  private assignment(expression: Extract<Expression, { kind: 'assign' }>): Operand {
    const { row, operator } = expression;
    const target = this.expression(expression.left);
    this.requireModifiable(target, row, operator ? `${operator}=` : '=');
    const type = unqualified(target.type);
    const lvalue = target.lvalue as LValue;
    if (!operator) {
      const source = this.rvalue(expression.right);
      const value = this.convertForAssignment(source, type, 'assignment', row);
      const { store } = lvalue;
      const truncate = lvalue.isBitField ? lvalue.load : undefined;
      return {
        type,
        value: truncate
          ? (frame) => {
              store(frame, value(frame));
              return truncate(frame);
            }
          : (frame) => {
              const result = value(frame);
              store(frame, result);
              return result;
            },
      };
    }
    // `a op= b` is `a = a op b` with `a` evaluated once.
    const current: Operand = { type, value: lvalue.load };
    const right = this.rvalue(expression.right);
    let combined: Operand;
    if (type.kind === 'pointer' && (operator === '+' || operator === '-') && isInteger(right.type)) {
      combined = this.pointerOffset(current, right, operator === '+' ? 1 : -1, row);
    } else {
      if (!isArithmetic(type) || !isArithmetic(right.type)) {
        this.error(
          row,
          `「${operator}=」の左右の型（${typeName(type)} と ${typeName(right.type)}）では計算できません。`
        );
      }
      combined = this.arithmetic(operator, current, right, row);
    }
    const value = this.converted(combined, type);
    const { store } = lvalue;
    const read = lvalue.isBitField ? lvalue.load : undefined;
    return {
      type,
      value: (frame) => {
        const result = value(frame);
        store(frame, result);
        return read ? read(frame) : result;
      },
    };
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
    // The size of a variable-length array is known only when the program runs.
    if (hasVla(type)) return { type: SIZE_T, value: (frame) => BigInt(sizeIn(type, frame.vla)) };
    return constantOperand(SIZE_T, BigInt(sizeOf(type)));
  }

  private conditional(expression: Extract<Expression, { kind: 'conditional' }>): Operand {
    const { row } = expression;
    const condition = this.rvalue(expression.condition);
    this.requireScalar(condition, row, '?');
    const truth = this.truthOf(condition);
    if (!expression.consequent) return this.elvis(condition, this.rvalue(expression.alternative), row);
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

  /** GNU's `c ?: b`, which evaluates `c` once and gives it when it is true. */
  private elvis(condition: Operand, whenFalse: Operand, row: number): Operand {
    const type = this.conditionalType(condition, whenFalse, row);
    const value = condition.value;
    const conditionType = condition.type;
    const isTrue =
      conditionType.kind === 'int' && INT_PROPERTIES[conditionType.name].size === 8
        ? (v: Value) => v !== 0n
        : (v: Value) => v !== 0;
    const otherwise = this.converted(whenFalse, type);
    return {
      type,
      value: (frame) => {
        const result = value(frame) as Scalar;
        return isTrue(result) ? convertScalar(result, conditionType, type) : otherwise(frame);
      },
    };
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
    const size = elementSize(target);
    const base = array.value;
    const offset = this.converted(index, LONG);
    const address = (frame: Frame): number => (base(frame) as number) + Number(offset(frame)) * size(frame);
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
      return { type: fieldType as CType, value: temporary };
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
    const load = (frame: Frame): Value => {
      const address = unit(frame);
      const block = frame.runtime.memory.locate(address, size);
      const offset = address - block.base;
      for (let index = 0; index < size; index++) {
        if (block.initialized[offset + index] === 0) throw new CRuntimeError('uninitialized');
      }
      return readBits(block.bytes, offset, bitOffset, width, type);
    };
    const store = (frame: Frame, value: Value): void => {
      const address = unit(frame);
      const block = frame.runtime.memory.locate(address, size);
      if (block.isReadOnly) throw new CRuntimeError('readOnly');
      const offset = address - block.base;
      writeBits(block.bytes, offset, bitOffset, width, value as Scalar);
      block.initialized.fill(1, offset, offset + size);
    };
    return { type, value: load, lvalue: { load, store, address: unit, isBitField: true } };
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

/** A name that stdarg.h declares, telling that the program included it and may use va_arg. */
export const STDARG_MARKER = '__va_arg_is_declared';

/**
 * Stops at a `va_arg` past the extra arguments, or of a type other than the argument's, which C leaves undefined.
 */
function checkVararg(frame: Frame, address: number, type: CType): void {
  const runtime = frame.runtime;
  const block = runtime.memory.find(address) ?? runtime.memory.find(address - 1);
  const slots = block ? runtime.varargTypes.get(block.base) : undefined;
  if (!block || !slots) throw new CRuntimeError('custom', 'va_list が va_start で始めた可変長引数を指していません。');
  const stored = slots[(address - block.base) / 8];
  if (!stored) throw new CRuntimeError('custom', 'va_arg で、渡された引数より多く読みました。');
  const sameKind =
    stored.kind === type.kind &&
    sizeOf(stored) === sizeOf(type) &&
    (stored.kind !== 'record' || (type.kind === 'record' && stored.info === type.info));
  if (!sameKind) {
    throw new CRuntimeError(
      'custom',
      `va_arg で読んだ型（${typeName(type)}）が、渡された引数の型（${typeName(stored)}）と合いません。`
    );
  }
}

/** The size of the elements a pointer steps over, which a variable-length array decides when the program runs. */
function elementSize(type: CType): (frame: Frame) => number {
  if (!hasVla(type)) {
    const size = sizeOf(type);
    return () => size;
  }
  return (frame) => sizeIn(type, frame.vla);
}

/** Computes the lengths of the variable-length arrays a type name declares before the operand that uses it. */
function withLengths(lengths: ((frame: Frame) => void) | undefined, operand: Operand): Operand {
  if (!lengths) return operand;
  const value = operand.value;
  return {
    type: operand.type,
    value: (frame) => {
      lengths(frame);
      return value(frame);
    },
  };
}

const RELATIONAL = new Set<string>(['<', '>', '<=', '>=']);

/** Names that clang defines in C17 for features the interpreter leaves out. */
const UNSUPPORTED_NAMES: Record<string, string> = {};

/** The names of the current function's name, which C defines as if a `static const char[]` held it. */
const FUNCTION_NAMES = new Set(['__func__', '__FUNCTION__', '__PRETTY_FUNCTION__']);

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
