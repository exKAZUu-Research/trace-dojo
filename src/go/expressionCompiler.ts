// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { LIMITS } from '../interpreter/limits';
import { assignFailure, constantValue, convertible, represent } from './assignability';
import type { CompositeLiteral, Expression, Span } from './ast';
import { CompilerBase } from './compilerBase';
import {
  binaryConstant,
  type Constant,
  ConstantDivisionByZero,
  ConstantOverflow,
  exactInteger,
  parseFloatLiteral,
  rationalToFloat,
  shiftConstant,
  unaryConstant,
} from './constants';
import { conversion, stringToRunesWithMode, toInterface } from './conversions';
import { type Entity, linkEscapeHook, linkEscapeSource, markEscapes, type VarEntity } from './entities';
import { equalityOf, mapKeyOf } from './equality';
import { fma } from './fma';
import { utf8Decode } from './literals';
import { currentRuntime } from './native';
import type { Operand } from './operand';
import { arithmetic, bitwiseNot, negate, ordering, shift } from './operators';
import { type Eval, type Frame, readLocal, writeLocal } from './runtime';
import { boundsPanic, indexPanic, nilPointerPanic, plainPanic, typeAssertionPanic } from './runtimeErrors';
import {
  BASIC,
  type BasicKind,
  coreType,
  defaultType,
  describeType,
  type FuncType,
  identical,
  integerBits,
  isBasic,
  isBoolean,
  isComparable,
  isComplex,
  isFloat,
  isInteger,
  isInterface,
  isNumeric,
  isOrdered,
  isString,
  isUnsigned,
  isUntyped,
  lookupFieldOrMethod,
  missingMethod,
  NO_VALUE,
  RUNE,
  type Type,
  typeString,
  underlying,
} from './types';
import {
  Cell,
  Complex,
  copyValue,
  GoArray,
  type GoMap,
  GoStruct,
  Iface,
  Pointer,
  Slice,
  type Value,
  writeInPlace,
} from './values';

/** Compiles expressions, checking their types as Go's compiler does. */
export abstract class ExpressionCompiler extends CompilerBase {
  protected abstract compileCall(expression: Extract<Expression, { kind: 'call' }>): Operand;
  protected abstract compileFuncLiteral(expression: Extract<Expression, { kind: 'funcLiteral' }>): Operand;
  protected abstract composite(expression: CompositeLiteral, elided: Type | undefined): Operand;

  protected invalid(span: Span): Operand {
    return { mode: 'value', type: BASIC.invalid, span, eval: () => {} };
  }

  protected isInvalid(operand: Operand): boolean {
    return operand.type === BASIC.invalid;
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- One case per expression kind.
  expression(expression: Expression): Operand {
    switch (expression.kind) {
      case 'name': {
        return this.name(expression, true);
      }
      case 'int': {
        return this.constant({ kind: 'int', value: expression.value }, BASIC.untypedInt, expression);
      }
      case 'float': {
        return this.literalConstant(
          expression,
          () => ({ kind: 'float', value: parseFloatLiteral(expression.text) }),
          BASIC.untypedFloat
        );
      }
      case 'imaginary': {
        return this.literalConstant(
          expression,
          () => ({ kind: 'complex', re: { num: 0n, den: 1n }, im: parseFloatLiteral(expression.text.slice(0, -1)) }),
          BASIC.untypedComplex
        );
      }
      case 'rune': {
        return this.constant({ kind: 'int', value: BigInt(expression.value) }, BASIC.untypedRune, expression);
      }
      case 'string': {
        return this.constant({ kind: 'string', value: expression.value }, BASIC.untypedString, expression);
      }
      case 'composite': {
        return this.composite(expression, undefined);
      }
      case 'funcLiteral': {
        return this.compileFuncLiteral(expression);
      }
      case 'paren': {
        const inner = this.expression(expression.expression);
        return { ...inner, span: expression };
      }
      case 'selector': {
        return this.selector(expression);
      }
      case 'index': {
        return this.index(expression);
      }
      case 'slice': {
        return this.sliceExpression(expression);
      }
      case 'typeAssert': {
        return this.typeAssertion(expression);
      }
      case 'call': {
        return this.compileCall(expression);
      }
      case 'unary': {
        return this.unary(expression);
      }
      case 'binary': {
        return this.binary(expression);
      }
      case 'type': {
        const type = this.resolveType(expression.type);
        return { mode: 'type', type, span: expression, eval: () => {} };
      }
    }
  }

  private literalConstant(span: Span, make: () => Constant, type: Type): Operand {
    try {
      return this.constant(make(), type, span);
    } catch (error) {
      if (!(error instanceof ConstantOverflow)) throw error;
      this.error(span, '定数が大きすぎます。');
      return this.invalid(span);
    }
  }

  protected constant(written: Constant, type: Type, span: Span): Operand {
    // A typed floating-point or complex constant holds a value of its type's precision, as Go's compiler rounds it.
    let constant = written;
    if (!isUntyped(type) && (isFloat(type) || isComplex(type))) {
      const represented = represent(written, type);
      if ('constant' in represented) constant = represented.constant;
    }
    const runtimeType = defaultType(type);
    const value = this.representsDefault(constant, runtimeType);
    return { mode: 'constant', type, span, constant, eval: () => value, ssaConstant: always };
  }

  private representsDefault(constant: Constant, type: Type): Value {
    if (type.kind === 'basic' && type.basic === 'untypedNil') return undefined;
    return constantValue(constant, type);
  }

  /** Compiles an expression that must be a single value, rejecting types, packages, and calls without results. */
  value(expression: Expression): Operand {
    return this.asValue(this.expression(expression));
  }

  protected asValue(operand: Operand): Operand {
    switch (operand.mode) {
      case 'type': {
        this.error(operand.span, `${describeType(operand.type)} は型なので、値としては使えません。`);
        return this.invalid(operand.span);
      }
      case 'builtin': {
        this.error(operand.span, `${operand.builtin} は呼び出さないと使えません。`);
        return this.invalid(operand.span);
      }
      case 'package': {
        // Go's compiler does not count this use, so it also reports the import as unused.
        if (operand.package) operand.package.used = false;
        this.error(
          operand.span,
          `パッケージ ${operand.package?.name} は、${operand.package?.name}.名前 の形で使ってください。`
        );
        return this.invalid(operand.span);
      }
      case 'novalue': {
        this.error(operand.span, '結果を返さない関数の呼び出しは、値としては使えません。');
        return this.invalid(operand.span);
      }
      case 'method': {
        this.unsupported(operand.span, 'メソッド値（呼び出さずにメソッドを取り出す書き方）');
        return this.invalid(operand.span);
      }
      default: {
        if (operand.type.kind === 'tuple') {
          this.error(operand.span, `複数の値を返す関数の呼び出しは、1つの値としては使えません。`);
          return this.invalid(operand.span);
        }
        return operand;
      }
    }
  }

  // Names ---------------------------------------------------------------------------------------------------------

  /** Compiles a name; `use` is false for the left side of a plain assignment, which does not count as a use. */
  protected name(expression: Extract<Expression, { kind: 'name' }>, use: boolean): Operand {
    const { name } = expression;
    if (name === '_') {
      this.error(expression, '_ は値としては使えません。');
      return this.invalid(expression);
    }
    const entity = this.lookup(name);
    if (!entity) {
      this.error(expression, `${name} は宣言されていません。`);
      return this.invalid(expression);
    }
    return this.entityOperand(entity, expression, use);
  }

  protected entityOperand(entity: Entity, span: Span, use: boolean): Operand {
    switch (entity.kind) {
      case 'var': {
        if (use) entity.used = true;
        entity.pending?.();
        this.fn?.references.add(entity);
        return this.variableOperand(entity, span);
      }
      case 'const': {
        entity.pending?.();
        entity.used = true;
        if (entity.type === BASIC.invalid) return this.invalid(span);
        return this.constant(entity.value, entity.type, span);
      }
      case 'type': {
        this.useType(entity);
        if (entity.generic) {
          this.error(span, `型 ${entity.name} を使うには、型引数を書いてください。`);
          return this.invalid(span);
        }
        return { mode: 'type', type: entity.type, span, eval: () => {} };
      }
      case 'func': {
        this.fn?.references.add(entity);
        if (entity.generic) {
          return { mode: 'value', type: entity.generic.type, span, eval: () => {}, func: entity };
        }
        return { mode: 'value', type: entity.type, span, eval: () => entity.value(), func: entity };
      }
      case 'builtin': {
        return { mode: 'builtin', type: NO_VALUE, span, builtin: entity.name, eval: () => {} };
      }
      case 'package': {
        return { mode: 'package', type: NO_VALUE, span, package: entity, eval: () => {} };
      }
      case 'nil': {
        return { mode: 'value', type: BASIC.untypedNil, span, eval: () => {} };
      }
    }
  }

  protected variableOperand(entity: VarEntity, span: Span): Operand {
    const { slot } = entity;
    const markUsed = (): void => {
      entity.used = true;
    };
    const { library } = entity;
    if (library) return { mode: 'value', type: entity.type, span, eval: () => library() };
    if (!entity.owner) {
      const prepareStore = (frame: Frame): ((value: Value) => void) => {
        const cell = frame.runtime.globals[slot];
        return (value) => {
          cell.v = writeInPlace(cell.v, value);
        };
      };
      return {
        mode: 'variable',
        type: entity.type,
        span,
        variable: { markUsed },
        eval: (frame) => frame.runtime.globals[slot].v,
        prepareStore,
        store: (frame, value) => prepareStore(frame)(value),
        addressOf: () => (frame) => new Pointer(frame.runtime.globals[slot], 'v'),
      };
    }
    if (entity.owner === this.fn) {
      const factors = entity.productFactors;
      return {
        mode: 'variable',
        type: entity.type,
        span,
        product: factors && {
          left: (frame) => frame.locals[factors.left] as Value,
          right: (frame) => frame.locals[factors.right] as Value,
          enabled: () => !entity.boxed && !entity.writes,
          constant: entity.definedAsConstant,
          order: factors.order,
        },
        ssaConstant:
          entity.definedAsConstant &&
          (() => !entity.boxed && !entity.writes && (entity.definedAsConstant as () => boolean)()),
        variable: { markUsed, entity },
        backingVars: [entity],
        eval: (frame) => readLocal(frame, slot),
        prepareStore: (frame) => (value) => writeLocal(frame, slot, value),
        store: (frame, value) => writeLocal(frame, slot, value),
        addressOf: () => {
          entity.boxed = true;
          markEscapes(entity);
          return (frame) => new Pointer(frame.locals[slot] as Cell, 'v');
        },
      };
    }
    const index = this.capture(entity, this.fn as NonNullable<typeof this.fn>);
    const prepareStore = (frame: Frame): ((value: Value) => void) => {
      const cell = frame.cells[index];
      return (value) => {
        cell.v = writeInPlace(cell.v, value);
      };
    };
    return {
      mode: 'variable',
      type: entity.type,
      span,
      variable: { markUsed },
      eval: (frame) => frame.cells[index].v,
      prepareStore,
      store: (frame, value) => prepareStore(frame)(value),
      addressOf: () => (frame) => new Pointer(frame.cells[index], 'v'),
    };
  }

  protected escapeOperand(operand: Operand): void {
    const variable = operand.variable?.entity;
    if (variable && operand.type === variable.type) markEscapes(variable);
    if (operand.backingVars) {
      for (const entity of operand.backingVars) markEscapes(entity);
    }
    if (operand.nonEscaping) operand.nonEscaping.escapes = true;
  }

  protected recordLocalEscapeAlias(operand: Operand, target: VarEntity): void {
    if (operand.backingVars) {
      for (const source of operand.backingVars) linkEscapeSource(source, target);
    }
    const nonEscaping = operand.nonEscaping;
    if (nonEscaping) {
      linkEscapeHook(() => {
        nonEscaping.escapes = true;
      }, target);
    }
  }

  // Conversions -----------------------------------------------------------------------------------------------------

  /**
   * Converts an operand for storing into a value of `target`: an untyped constant takes the type, a concrete value
   * enters an interface, and structs and arrays are copied. Reports the mismatch as `context` says.
   */
  protected assign(operand: Operand, target: Type, context: string, targetLocal?: VarEntity): Eval {
    if (this.isInvalid(operand) || target === BASIC.invalid) return () => {};
    let value = this.asValue(operand);
    if (this.isInvalid(value)) return () => {};
    if (targetLocal && targetLocal.owner !== undefined && !isInterface(target)) {
      this.recordLocalEscapeAlias(value, targetLocal);
    } else {
      this.escapeOperand(value);
    }
    if (value.resolveUntyped) {
      value = value.resolveUntyped(isInterface(target) ? defaultType(value.type) : target);
      if (this.isInvalid(value)) return () => {};
    }
    if (value.mode === 'constant' && value.constant && isUntyped(value.type)) {
      return this.assignConstant(value, target, context);
    }
    // An untyped boolean from a comparison takes a boolean target's type, or bool otherwise.
    if (value.type === BASIC.untypedBool) value = { ...value, type: isBoolean(target) ? target : BASIC.bool };
    if (value.type.kind === 'basic' && value.type.basic === 'untypedNil') {
      if (assignFailure(value.type, target)) {
        this.error(value.span, `nil は ${describeType(target)} 型の${context}には使えません。`);
      }
      return () => {};
    }
    const failure = assignFailure(value.type, target);
    if (failure) {
      let detail = '';
      if (failure.kind === 'missingMethod') {
        const { missing } = failure;
        if (missing.pointerOnly)
          detail = `（メソッド ${missing.name} はポインタのレシーバを持つので、${describeType(value.type)} ではなく *${describeType(value.type)} が実装しています）`;
        else if (missing.wrongType) detail = `（メソッド ${missing.name} の型が違います）`;
        else detail = `（メソッド ${missing.name} がありません）`;
      }
      this.error(
        value.span,
        `${describeType(value.type)} 型の値は、${describeType(target)} 型の${context}には使えません${detail}。`
      );
      return () => {};
    }
    if (isInterface(target) && !isInterface(value.type)) {
      const box = toInterface(value.type);
      const read = value.eval;
      return (frame) => box(read(frame));
    }
    if (isValueType(target)) {
      const read = value.eval;
      return (frame) => copyValue(read(frame));
    }
    return value.eval;
  }

  private assignConstant(operand: Operand, target: Type, context: string): Eval {
    const constant = operand.constant as Constant;
    if (isInterface(target) || target.kind === 'typeParam') {
      const type = defaultType(operand.type);
      if (target.kind === 'typeParam') {
        // A type parameter's value must work for every type it allows, which the generic check verifies.
        const terms = target.constraint.typeSet?.terms;
        const fits =
          terms !== undefined &&
          terms.length > 0 &&
          terms.every((term) => 'constant' in represent(constant, term.type));
        if (!fits) this.error(operand.span, `定数は ${target.name} 型の${context}には使えません。`);
        return () => {};
      }
      const failure = assignFailure(type, target);
      if (failure) {
        this.error(
          operand.span,
          `${describeType(type)} 型の値は、${describeType(target)} 型の${context}には使えません。`
        );
        return () => {};
      }
      const value = new Iface(type, constantValue(constant, type));
      return () => value;
    }
    const representation = represent(constant, target);
    if ('error' in representation) {
      this.reportRepresentation(operand, target, representation.error, context);
      return () => {};
    }
    const value = constantValue(representation.constant, target);
    return () => value;
  }

  protected reportRepresentation(
    operand: Operand,
    target: Type,
    error: 'overflows' | 'truncated' | 'mismatch',
    context: string
  ): void {
    const text = describeConstant(operand.constant as Constant);
    if (error === 'overflows') this.error(operand.span, `定数 ${text} は ${describeType(target)} 型に収まりません。`);
    else if (error === 'truncated')
      this.error(operand.span, `定数 ${text} は ${describeType(target)} 型では小数部分や虚部が失われます。`);
    else
      this.error(
        operand.span,
        `${describeType(operand.type)} の定数 ${text} は、${describeType(target)} 型の${context}には使えません。`
      );
  }

  /** Gives an untyped value its default type, as a variable declared without a type takes. */
  protected defaulted(operand: Operand): Operand {
    if (!isUntyped(operand.type)) return operand;
    if (operand.type.kind === 'basic' && operand.type.basic === 'untypedNil') {
      this.error(operand.span, 'nil の型を決められません。');
      return this.invalid(operand.span);
    }
    const type = defaultType(operand.type);
    if (operand.resolveUntyped) return operand.resolveUntyped(type);
    if (operand.mode !== 'constant' || !operand.constant) return { ...operand, type };
    const representation = represent(operand.constant, type);
    if ('error' in representation) {
      this.reportRepresentation(operand, type, representation.error, '値');
      return this.invalid(operand.span);
    }
    const value = constantValue(representation.constant, type);
    return { ...operand, type, constant: representation.constant, eval: () => value };
  }

  /** Converts an untyped operand to the type of the other operand of a binary operator. */
  private convertUntyped(operand: Operand, target: Type): Operand {
    if (!isUntyped(operand.type) || isUntyped(target) || this.isInvalid(operand)) return operand;
    if (operand.type.kind === 'basic' && operand.type.basic === 'untypedNil') return { ...operand, type: target };
    if (operand.resolveUntyped) {
      return operand.resolveUntyped(isInterface(target) ? defaultType(operand.type) : target);
    }
    if (operand.mode === 'constant' && operand.constant) {
      if (isInterface(target)) return this.defaulted(operand);
      if (target.kind === 'typeParam') return { ...operand, type: target, eval: () => {} };
      const representation = represent(operand.constant, target);
      if ('error' in representation) {
        this.reportRepresentation(operand, target, representation.error, 'オペランド');
        return this.invalid(operand.span);
      }
      return { ...operand, ...this.constant(representation.constant, target, operand.span) };
    }
    // An untyped boolean from a comparison.
    return { ...operand, type: isBoolean(target) ? target : BASIC.bool };
  }

  // Operators ------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 40 -- One case per unary operator, as the specification lists them.
  private unary(expression: Extract<Expression, { kind: 'unary' }>): Operand {
    const { operator } = expression;
    if (operator === '&') return this.addressOf(expression);
    if (operator === '*') {
      const target = this.expression(expression.operand);
      // `*T` where T is a type is the pointer type, as in the conversion `(*T)(p)`.
      if (target.mode === 'type')
        return {
          mode: 'type',
          type: { kind: 'pointer', element: target.type },
          span: expression,
          eval: () => {},
        };
      const pointer = this.asValue(target);
      return this.isInvalid(pointer) ? pointer : this.dereference(expression, pointer);
    }
    const operand = this.value(expression.operand);
    if (this.isInvalid(operand)) return operand;
    const unaryOp = operator as '+' | '-' | '!' | '^';
    if (operand.resolveUntyped) {
      const resolveOperand = operand.resolveUntyped;
      return {
        mode: 'value',
        type: operand.type,
        span: expression,
        eval: () => {},
        resolveUntyped: (target) => {
          const resolved = resolveOperand(target);
          return this.isInvalid(resolved) ? resolved : this.applyUnary(expression, unaryOp, resolved);
        },
      };
    }
    return this.applyUnary(expression, unaryOp, operand);
  }

  private applyUnary(span: Span, operator: '+' | '-' | '!' | '^', operand: Operand): Operand {
    const type = operand.type;
    const allowed = operator === '!' ? isBoolean(type) : operator === '^' ? isInteger(type) : isNumeric(type);
    if (!allowed) {
      this.error(span, `演算子 ${operator} は ${describeType(type)} 型の値には使えません。`);
      return this.invalid(span);
    }
    if (operand.mode === 'constant' && operand.constant) {
      const unsignedBits =
        operator === '^' && isUnsigned(type) && !isUntyped(type) ? integerBits(basicKind(type)).bits : undefined;
      const constant = unaryConstant(operator, operand.constant, unsignedBits);
      if (!isUntyped(type)) {
        const representation = represent(constant, type);
        if ('error' in representation) {
          this.error(span, `定数 ${describeConstant(constant)} は ${describeType(type)} 型に収まりません。`);
          return this.invalid(span);
        }
        return this.constant(representation.constant, type, span);
      }
      return this.constant(constant, type, span);
    }
    const read = operand.eval;
    if (operator === '+') return { mode: 'value', type, span, eval: read, product: operand.product };
    // -(x*y) stays a product for fusing, as Go's compiler rewrites it to FNMUL.
    if (operator === '-' && operand.product) {
      const { left, right } = operand.product;
      const negated: Eval = (frame) => -(left(frame) as number);
      const apply = negate(type);
      return {
        mode: 'value',
        type,
        span,
        eval: (frame) => apply(read(frame)),
        product: { ...operand.product, left: negated, right },
      };
    }
    if (this.hasTypeParam(type)) return { mode: 'value', type, span, eval: () => {} };
    if (operator === '!') return { mode: 'value', type, span, eval: (frame) => !read(frame) };
    const apply = operator === '-' ? negate(type) : bitwiseNot(type);
    return {
      mode: 'value',
      type,
      span,
      eval: (frame) => apply(read(frame)),
      ssaConstant: operand.ssaConstant,
    };
  }

  protected hasTypeParam(type: Type): boolean {
    return type.kind === 'typeParam';
  }

  private addressOf(expression: Extract<Expression, { kind: 'unary' }>): Operand {
    let inner = expression.operand;
    while (inner.kind === 'paren') inner = inner.expression;
    if (inner.kind === 'composite') {
      const literal = this.composite(inner, undefined);
      const read = literal.eval;
      return {
        mode: 'value',
        type: { kind: 'pointer', element: literal.type },
        span: expression,
        createsObject: true,
        eval: (frame) => new Pointer(new Cell(read(frame)), 'v'),
      };
    }
    const operand = this.expression(inner);
    if (this.isInvalid(operand)) return operand;
    if (operand.mode !== 'variable' || !operand.addressOf) {
      this.error(
        expression,
        'この式のアドレスは取れません（変数・フィールド・配列やスライスの要素だけに & を付けられます）。'
      );
      return this.invalid(expression);
    }
    operand.variable?.markUsed();
    return {
      mode: 'value',
      type: { kind: 'pointer', element: operand.type },
      span: expression,
      eval: operand.addressOf(),
    };
  }

  private dereference(span: Span, operand: Operand): Operand {
    const under = coreType(operand.type);
    if (under?.kind !== 'pointer') {
      this.error(span, `${describeType(operand.type)} 型の値はポインタではないので、* を付けられません。`);
      return this.invalid(span);
    }
    const read = operand.eval;
    const pointer = (frame: Frame): Pointer => {
      const value = read(frame);
      if (!(value instanceof Pointer)) nilPointerPanic();
      return value;
    };
    return {
      mode: 'variable',
      type: under.element,
      span,
      eval: (frame) => pointer(frame).load(),
      prepareStore: (frame) => {
        const target = pointer(frame);
        return (value) => target.store(value);
      },
      store: (frame, value) => pointer(frame).store(value),
      addressOf: () => pointer,
    };
  }

  // code-gauge-allow functionCognitiveComplexity 50 -- The binary operators and their type rules, one at a time.
  private binary(expression: Extract<Expression, { kind: 'binary' }>): Operand {
    return this.binaryOfOperands(
      expression,
      expression.operator,
      this.value(expression.left),
      this.value(expression.right)
    );
  }

  /** Applies a binary operator to compiled operands, as `x op= y` also does. */
  protected binaryOfOperands(span: Span, operator: string, leftOperand: Operand, rightOperand: Operand): Operand {
    const expression = {
      ...span,
      kind: 'binary',
      operator,
      left: leftOperand.span,
      right: rightOperand.span,
    } as unknown as Extract<Expression, { kind: 'binary' }>;
    let left = leftOperand;
    let right = rightOperand;
    if (this.isInvalid(left) || this.isInvalid(right)) return this.invalid(expression);
    if (operator === '<<' || operator === '>>') return this.shiftExpression(expression, left, right);
    if (operator === '&&' || operator === '||') return this.logical(expression, left, right);
    // Untyped operands take the other operand's type, or the larger untyped kind; nil stays nil for comparisons.
    const hasNil = left.type === BASIC.untypedNil || right.type === BASIC.untypedNil;
    if (!hasNil && isUntyped(left.type) && !isUntyped(right.type)) left = this.convertUntyped(left, right.type);
    else if (!hasNil && isUntyped(right.type) && !isUntyped(left.type)) right = this.convertUntyped(right, left.type);
    if (this.isInvalid(left) || this.isInvalid(right)) return this.invalid(expression);
    const isComparison = ['==', '!=', '<', '<=', '>', '>='].includes(operator);
    if (isComparison) return this.comparison(expression, left, right);
    if (
      !identical(left.type, right.type) &&
      !(isUntyped(left.type) && isUntyped(right.type) && sameUntypedFamily(left.type, right.type))
    ) {
      this.error(
        expression,
        `${describeType(left.type)} 型と ${describeType(right.type)} 型の値には、演算子 ${operator} を使えません（型が違います）。`
      );
      return this.invalid(expression);
    }
    const type = isUntyped(left.type) && isUntyped(right.type) ? largerUntyped(left.type, right.type) : left.type;
    if (isUntyped(type) && (left.resolveUntyped || right.resolveUntyped)) {
      return {
        mode: 'value',
        type,
        span: expression,
        eval: () => {},
        resolveUntyped: (target) => {
          const resolvedLeft = this.convertUntyped(left, target);
          const resolvedRight = this.convertUntyped(right, target);
          return this.binaryOfOperands(span, operator, resolvedLeft, resolvedRight);
        },
      };
    }
    if (!allowsBinaryOperator(operator, type)) {
      this.error(expression, `演算子 ${operator} は ${describeType(type)} 型の値には使えません。`);
      return this.invalid(expression);
    }
    if (left.mode === 'constant' && right.mode === 'constant' && left.constant && right.constant) {
      return this.foldBinary(expression, operator, left.constant, right.constant, type);
    }
    const constantDivisor = (operator === '/' || operator === '%') && right.mode === 'constant' && right.constant;
    if (constantDivisor && isInteger(type) && exactInteger(right.constant as Constant) === 0n) {
      this.error(expression.right, '0 で割っています。');
      return this.invalid(expression);
    }
    if (this.hasTypeParam(type)) return { mode: 'value', type, span: expression, eval: () => {} };
    const fused = this.fusedMultiplyAdd(expression, operator, left, right, type);
    if (fused) return fused;
    const apply = arithmetic(operator, type);
    const readLeft = left.eval;
    const readRight = right.eval;
    const ssaConstant = bothConstant(left, right);
    const factors = isFloat(type) && !isUntyped(type) ? fusableFactors(operator, left, right) : undefined;
    if (factors) {
      return {
        mode: 'value',
        type,
        span: expression,
        eval: (frame) => apply(readLeft(frame), readRight(frame)),
        product: { ...factors, constant: ssaConstant, order: this.productOrder(operator, left, right) },
        ssaConstant,
      };
    }
    if (isString(type)) {
      return {
        mode: 'value',
        type,
        span: expression,
        eval: (frame) => {
          const result = (readLeft(frame) as string) + (readRight(frame) as string);
          frame.runtime.checkStringLength(result.length);
          frame.runtime.spend(Math.floor(result.length / 64));
          return result;
        },
      };
    }
    return {
      mode: 'value',
      type,
      span: expression,
      eval: (frame) => apply(readLeft(frame), readRight(frame)),
      ssaConstant,
    };
  }

  /**
   * Fuses `a + x*y`, `a - x*y`, and `x*y - a` into one rounding, as Go's compiler does on arm64.
   */
  private fusedMultiplyAdd(
    span: Span,
    operator: string,
    left: Operand,
    right: Operand,
    type: Type
  ): Operand | undefined {
    if ((operator !== '+' && operator !== '-') || !isFloat(type) || isUntyped(type)) return undefined;
    const round = isBasic(type, 'float32') ? Math.fround : (value: number): number => value;
    const fused = (
      a: Eval,
      product: NonNullable<Operand['product']>,
      productFirst: boolean,
      negateProduct: boolean,
      negateAddend: boolean
    ): Operand => ({
      mode: 'value',
      type,
      span,
      eval: (frame) => {
        // The operands are evaluated in the order they are written.
        const addendFirst = productFirst ? 0 : (a(frame) as number);
        const x = product.left(frame) as number;
        const y = product.right(frame) as number;
        const addend = productFirst ? (a(frame) as number) : addendFirst;
        return round(fma(negateProduct ? -x : x, y, negateAddend ? -addend : addend));
      },
    });
    const plain = (): Operand => {
      const apply = arithmetic(operator, type);
      const readLeft = left.eval;
      const readRight = right.eval;
      return { mode: 'value', type, span, eval: (frame) => apply(readLeft(frame), readRight(frame)) };
    };
    // A product through a variable fuses only while the variable keeps its single definition, and a product of
    // constants is computed before the program runs, so it never fuses.
    const choose = (fusedOperand: Operand, product: NonNullable<Operand['product']>): Operand => {
      const { enabled = always, constant = never } = product;
      const unfused = plain().eval;
      const fusedEval = fusedOperand.eval;
      return {
        ...fusedOperand,
        eval: (frame) => (enabled() && !constant() ? fusedEval(frame) : unfused(frame)),
        ssaConstant: bothConstant(left, right),
      };
    };
    // Of two products, an addition fuses the one computed first, which Go's common subexpression elimination orders
    // first; a subtraction fuses the subtracted one, as its rewrite rules try that form first.
    const leftFirst = !right.product || (left.product !== undefined && left.product.order <= right.product.order);
    if (left.product && (operator === '-' ? !right.product : leftFirst)) {
      return choose(fused(right.eval, left.product, true, false, operator === '-'), left.product);
    }
    if (right.product) return choose(fused(left.eval, right.product, false, operator === '-', false), right.product);
    return undefined;
  }

  /**
   * The position of a product among those the function computes, where the same variables or constants multiplied
   * again keep their first position, as Go's common subexpression elimination keeps the first value.
   */
  private productOrder(operator: string, left: Operand, right: Operand): number {
    const orders = this.fn?.productOrders ?? new Map<string, number>();
    const a = productKeyOf(left);
    const b = productKeyOf(right);
    const key = a !== undefined && b !== undefined ? [operator, ...[a, b].toSorted()].join(' ') : `#${orders.size}`;
    const existing = orders.get(key);
    if (existing !== undefined) return existing;
    orders.set(key, orders.size);
    return orders.size - 1;
  }

  private foldBinary(span: Span, operator: string, a: Constant, b: Constant, type: Type): Operand {
    try {
      const folded = binaryConstant(operator, a, b, isInteger(type));
      if (!isUntyped(type)) {
        const representation = represent(folded, type);
        if ('error' in representation) {
          this.error(span, `定数 ${describeConstant(folded)} は ${describeType(type)} 型に収まりません。`);
          return this.invalid(span);
        }
        return this.constant(representation.constant, type, span);
      }
      return this.constant(folded, type, span);
    } catch (error) {
      if (error instanceof ConstantDivisionByZero) this.error(span, '0 で割っています。');
      else if (error instanceof ConstantOverflow) this.error(span, '定数が大きすぎます。');
      else throw error;
      return this.invalid(span);
    }
  }

  private logical(span: Span, left: Operand, right: Operand): Operand {
    const operator = (span as Extract<Expression, { kind: 'binary' }>).operator;
    if (!isBoolean(left.type) || !isBoolean(right.type)) {
      this.error(span, `演算子 ${operator} は真偽値にしか使えません。`);
      return this.invalid(span);
    }
    let l = left;
    let r = right;
    if (isUntyped(l.type) && !isUntyped(r.type)) l = this.convertUntyped(l, r.type);
    if (isUntyped(r.type) && !isUntyped(l.type)) r = this.convertUntyped(r, l.type);
    if (!identical(l.type, r.type) && !(isUntyped(l.type) && isUntyped(r.type))) {
      this.error(
        span,
        `${describeType(l.type)} 型と ${describeType(r.type)} 型の値には、演算子 ${operator} を使えません（型が違います）。`
      );
      return this.invalid(span);
    }
    const type = isUntyped(l.type) ? BASIC.untypedBool : l.type;
    if (l.mode === 'constant' && r.mode === 'constant' && l.constant && r.constant) {
      return this.constant(binaryConstant(operator, l.constant, r.constant, false), type, span);
    }
    const readLeft = l.eval;
    const readRight = r.eval;
    return {
      mode: 'value',
      type,
      span,
      eval:
        operator === '&&'
          ? (frame) => (readLeft(frame) as boolean) && (readRight(frame) as boolean)
          : (frame) => (readLeft(frame) as boolean) || (readRight(frame) as boolean),
    };
  }

  private comparison(
    expression: Extract<Expression, { kind: 'binary' }>,
    leftOperand: Operand,
    rightOperand: Operand
  ): Operand {
    const { operator } = expression;
    let left = leftOperand;
    let right = rightOperand;
    let type = left.type;
    if (isNil(left)) type = right.type;
    const mismatch = (): Operand => {
      this.error(
        expression,
        `${describeType(left.type)} 型と ${describeType(right.type)} 型の値は比べられません（型が違います）。`
      );
      return this.invalid(expression);
    };
    if (isNil(left) || isNil(right)) {
      const other = isNil(left) ? right : left;
      if (isNil(left) && isNil(right)) {
        this.error(expression, 'nil どうしは比べられません。');
        return this.invalid(expression);
      }
      if (assignFailure(BASIC.untypedNil, other.type)) return mismatch();
    } else if (isUntyped(left.type) && isUntyped(right.type)) {
      if (!sameUntypedFamily(left.type, right.type)) return mismatch();
      if (left.resolveUntyped || right.resolveUntyped) {
        const common = defaultType(largerUntyped(left.type, right.type));
        left = this.convertUntyped(left, common);
        right = this.convertUntyped(right, common);
        if (this.isInvalid(left) || this.isInvalid(right)) return this.invalid(expression);
        type = common;
      } else {
        type = largerUntyped(left.type, right.type);
      }
    } else if (!identical(left.type, right.type)) {
      const leftToRight = !assignFailure(left.type, right.type);
      const rightToLeft = !assignFailure(right.type, left.type);
      if (!leftToRight && !rightToLeft) return mismatch();
      if (isInterface(left.type) !== isInterface(right.type)) {
        return this.mixedInterfaceComparison(expression, left, right, isInterface(right.type) && leftToRight);
      }
      type = leftToRight ? right.type : left.type;
    }
    const ordered = operator !== '==' && operator !== '!=';
    if (ordered && !isOrdered(type)) {
      this.error(expression, `${describeType(type)} 型の値は大小を比べられません。`);
      return this.invalid(expression);
    }
    if (!ordered && !isNil(left) && !isNil(right) && !isComparable(type)) {
      const under = underlying(type);
      const what =
        under.kind === 'slice'
          ? 'スライス'
          : under.kind === 'map'
            ? 'map'
            : under.kind === 'func'
              ? '関数'
              : `${describeType(type)} 型の値`;
      this.error(expression, `${what}は nil としか比べられません。`);
      return this.invalid(expression);
    }
    if (left.mode === 'constant' && right.mode === 'constant' && left.constant && right.constant) {
      return this.constant(
        binaryConstant(operator, left.constant, right.constant, false),
        BASIC.untypedBool,
        expression
      );
    }
    const readLeft = left.eval;
    const readRight = right.eval;
    if (ordered) {
      const compare = ordering(operator);
      return {
        mode: 'value',
        type: BASIC.untypedBool,
        span: expression,
        eval: (frame) => compare(readLeft(frame), readRight(frame)),
      };
    }
    const equal = isNil(left) || isNil(right) ? (a: Value, b: Value) => a === b : equalityOf(type);
    const negated = operator === '!=';
    return {
      mode: 'value',
      type: BASIC.untypedBool,
      span: expression,
      eval: (frame) => equal(readLeft(frame), readRight(frame)) !== negated,
    };
  }

  private mixedInterfaceComparison(
    span: Extract<Expression, { kind: 'binary' }>,
    left: Operand,
    right: Operand,
    leftToRight: boolean
  ): Operand {
    if (span.operator !== '==' && span.operator !== '!=') {
      this.error(span, `インターフェースの値は大小を比べられません。`);
      return this.invalid(span);
    }
    const concrete = leftToRight ? left : right;
    if (!isComparable(concrete.type)) {
      this.error(span, `${describeType(concrete.type)} 型の値は比べられません。`);
      return this.invalid(span);
    }
    const box = toInterface(concrete.type);
    const readConcrete = concrete.eval;
    const readInterface = (leftToRight ? right : left).eval;
    const equal = equalityOf(leftToRight ? right.type : left.type);
    const negated = span.operator === '!=';
    return {
      mode: 'value',
      type: BASIC.untypedBool,
      span,
      eval: (frame) => {
        const a = leftToRight ? box(readConcrete(frame)) : readInterface(frame);
        const b = leftToRight ? readInterface(frame) : box(readConcrete(frame));
        return equal(a, b) !== negated;
      },
    };
  }

  private shiftExpression(
    expression: Extract<Expression, { kind: 'binary' }>,
    leftOperand: Operand,
    rightOperand: Operand
  ): Operand {
    const operator = expression.operator as '<<' | '>>';
    let left = leftOperand;
    let right = rightOperand;
    if (right.resolveUntyped) {
      right = right.resolveUntyped(BASIC.uint);
      if (this.isInvalid(right)) return right;
    }
    if (
      !isInteger(right.type) &&
      !(right.mode === 'constant' && right.constant && exactInteger(right.constant) !== undefined)
    ) {
      this.error(expression.right, `シフトする量には整数を書いてください。`);
      return this.invalid(expression);
    }
    if (right.mode === 'constant' && right.constant) {
      const count = exactInteger(right.constant) as bigint;
      if (count < 0n) {
        this.error(expression.right, 'シフトする量に負の数は使えません。');
        return this.invalid(expression);
      }
      if (left.mode === 'constant' && left.constant) {
        const value = exactInteger(left.constant);
        if (value === undefined || !(isInteger(left.type) || isUntyped(left.type))) {
          this.error(expression.left, `シフトできるのは整数だけです。`);
          return this.invalid(expression);
        }
        const type = isUntyped(left.type) && !isInteger(left.type) ? BASIC.untypedInt : left.type;
        try {
          const shifted = shiftConstant(operator, value, count);
          if (!isUntyped(type)) {
            const representation = represent(shifted, type);
            if ('error' in representation) {
              this.error(expression, `定数 ${describeConstant(shifted)} は ${describeType(type)} 型に収まりません。`);
              return this.invalid(expression);
            }
          }
          return this.constant(shifted, type, expression);
        } catch (error) {
          if (!(error instanceof ConstantOverflow)) throw error;
          this.error(expression, 'シフトの結果の定数が大きすぎます。');
          return this.invalid(expression);
        }
      }
    }
    if (isUntyped(right.type) && !(right.mode === 'constant' && right.constant)) {
      right = this.defaulted(right);
      if (this.isInvalid(right)) return right;
    }
    const readRight =
      right.mode === 'constant' && right.constant
        ? (() => {
            const count = exactInteger(right.constant as Constant) as bigint;
            return () => count;
          })()
        : right.eval;
    if (isUntyped(left.type) && ((left.mode === 'constant' && left.constant) || left.resolveUntyped)) {
      if (left.constant && (left.constant.kind === 'bool' || left.constant.kind === 'string')) {
        this.error(expression.left, 'シフトできるのは整数だけです。');
        return this.invalid(expression);
      }
      const untypedLeft = left;
      return {
        mode: 'value',
        type: left.type,
        span: expression,
        eval: () => {},
        resolveUntyped: (target) => this.resolveUntypedShift(expression, operator, untypedLeft, readRight, target),
      };
    }
    if (isUntyped(left.type)) left = this.defaulted(left);
    if (this.isInvalid(left)) return left;
    if (!isInteger(left.type)) {
      this.error(
        expression.left,
        `シフトできるのは整数だけです（${describeType(left.type)} 型の値が書かれています）。`
      );
      return this.invalid(expression);
    }
    const readLeft = left.eval;
    if (this.hasTypeParam(left.type)) return { mode: 'value', type: left.type, span: expression, eval: () => {} };
    const apply = shift(operator, left.type);
    return {
      mode: 'value',
      type: left.type,
      span: expression,
      eval: (frame) => apply(readLeft(frame) as bigint, readRight(frame) as bigint),
    };
  }

  private resolveUntypedShift(
    expression: Extract<Expression, { kind: 'binary' }>,
    operator: '<<' | '>>',
    untypedLeft: Operand,
    readRight: Eval,
    target: Type
  ): Operand {
    if (target === BASIC.invalid) return this.invalid(expression);
    if (untypedLeft.resolveUntyped) {
      const resolvedInner = untypedLeft.resolveUntyped(target);
      if (this.isInvalid(resolvedInner)) return resolvedInner;
      if (this.hasTypeParam(resolvedInner.type)) {
        return { mode: 'value', type: resolvedInner.type, span: expression, eval: () => {} };
      }
      const apply = shift(operator, resolvedInner.type);
      const readInner = resolvedInner.eval;
      return {
        mode: 'value',
        type: resolvedInner.type,
        span: expression,
        eval: (frame) => apply(readInner(frame) as bigint, readRight(frame) as bigint),
      };
    }
    const leftConstant = untypedLeft.constant as Constant;
    if (target.kind === 'typeParam') {
      if (!isInteger(target)) {
        this.error(expression.left, `シフトできるのは整数だけです（${describeType(target)} 型の値が書かれています）。`);
        return this.invalid(expression);
      }
      for (const term of target.constraint.typeSet?.terms ?? []) {
        const rep = represent(leftConstant, term.type);
        if ('error' in rep) {
          this.reportRepresentation(untypedLeft, term.type, rep.error, 'オペランド');
          return this.invalid(expression);
        }
      }
      return { mode: 'value', type: target, span: expression, eval: () => {} };
    }
    const resolvedTarget = isInterface(target) ? defaultType(untypedLeft.type) : target;
    if (!isInteger(resolvedTarget)) {
      this.error(
        expression.left,
        `シフトできるのは整数だけです（${describeType(resolvedTarget)} 型の値が書かれています）。`
      );
      return this.invalid(expression);
    }
    const representation = represent(leftConstant, resolvedTarget);
    if ('error' in representation) {
      this.reportRepresentation(untypedLeft, resolvedTarget, representation.error, 'オペランド');
      return this.invalid(expression);
    }
    const leftValue = constantValue(representation.constant, resolvedTarget) as bigint;
    const apply = shift(operator, resolvedTarget);
    return {
      mode: 'value',
      type: resolvedTarget,
      span: expression,
      eval: (frame) => apply(leftValue, readRight(frame) as bigint),
    };
  }

  // Selectors -----------------------------------------------------------------------------------------------------

  protected selector(expression: Extract<Expression, { kind: 'selector' }>): Operand {
    if (expression.operand.kind === 'name') {
      const entity = this.lookup(expression.operand.name);
      if (entity?.kind === 'package') {
        const member = this.packageMember(entity, expression.field, expression);
        if (!member) return this.invalid(expression);
        return this.entityOperand(member, expression, true);
      }
    }
    const base = this.expression(expression.operand);
    if (this.isInvalid(base)) return base;
    if (base.mode === 'type') {
      this.unsupported(expression, 'メソッド式（型.メソッド の形で関数として取り出す書き方）');
      return this.invalid(expression);
    }
    const operand = this.asValue(base);
    if (this.isInvalid(operand)) return operand;
    return this.selectMember(expression, operand, expression.field);
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- Fields and methods through embedded fields and pointers.
  protected selectMember(span: Span, operand: Operand, field: string): Operand {
    const type = operand.type;
    if (isBasic(type, 'untypedNil')) {
      this.error(span, `nil には ${field} がありません。`);
      return this.invalid(span);
    }
    const lookupType = type.kind === 'pointer' && underlying(type.element).kind === 'pointer' ? BASIC.invalid : type;
    const selection = lookupFieldOrMethod(lookupType, field);
    if (selection.kind === 'notFound') {
      const named = type.kind === 'pointer' ? type.element : type;
      if (named.kind === 'named' && named.unsupported?.has(field)) {
        this.unsupported(span, `${typeString(named)}.${field}`);
        return this.invalid(span);
      }
      const hint = this.capitalizationHint(type, field);
      this.error(span, `${describeType(type)} 型には ${field} というフィールドやメソッドがありません${hint}。`);
      return this.invalid(span);
    }
    if (selection.kind === 'ambiguous') {
      this.error(span, `${field} は埋め込んだ複数の型にあるので、どれか決められません。`);
      return this.invalid(span);
    }
    operand.variable?.markUsed();
    if (selection.kind !== 'field') {
      return { mode: 'method', type: NO_VALUE, span, eval: () => {}, method: { receiver: operand, selection } };
    }
    return this.fieldOperand(span, operand, selection.path, selection.type);
  }

  private capitalizationHint(type: Type, field: string): string {
    const other =
      field[0] === field[0].toUpperCase()
        ? field[0].toLowerCase() + field.slice(1)
        : field[0].toUpperCase() + field.slice(1);
    return lookupFieldOrMethod(type, other).kind === 'notFound' ? '' : `（${other} ならあります）`;
  }

  /** A field reached through embedded fields, following pointers, which may be nil. */
  protected fieldOperand(span: Span, operand: Operand, path: number[], type: Type): Operand {
    const read = operand.eval;
    const steps = path.slice(0, -1);
    const last = path.at(-1) as number;
    const container = (frame: Frame): GoStruct => {
      let value = read(frame);
      if (value instanceof Pointer) value = value.load();
      else if (value === undefined) nilPointerPanic();
      for (const index of steps) {
        value = (value as GoStruct).fields[index];
        if (value instanceof Pointer) value = value.load();
        else if (value === undefined) nilPointerPanic();
      }
      if (value === undefined) nilPointerPanic();
      return value as GoStruct;
    };
    const throughPointer = underlying(operand.type).kind === 'pointer' || this.pathHasPointer(operand.type, steps);
    const addressable = operand.mode === 'variable' || throughPointer;
    const escapeAddress = throughPointer
      ? undefined
      : () => {
          operand.escapeAddress?.();
          this.escapeOperand(operand);
        };
    return {
      mode: addressable ? 'variable' : 'value',
      type,
      span,
      eval: (frame) => container(frame).fields[last],
      prepareStore: addressable
        ? (frame) => {
            const target = container(frame);
            return (value) => {
              target.fields[last] = writeInPlace(target.fields[last], value);
            };
          }
        : undefined,
      store: addressable
        ? (frame, value) => {
            const target = container(frame);
            target.fields[last] = writeInPlace(target.fields[last], value);
          }
        : undefined,
      addressOf: addressable
        ? () => {
            escapeAddress?.();
            return (frame) => new Pointer(container(frame).fields, last);
          }
        : undefined,
      escapeAddress,
    };
  }

  private pathHasPointer(type: Type, path: number[]): boolean {
    let current = underlying(type);
    if (current.kind === 'pointer') return true;
    for (const index of path) {
      if (current.kind !== 'struct') return false;
      const fieldType = current.fields[index].type;
      if (underlying(fieldType).kind === 'pointer') return true;
      current = underlying(fieldType);
    }
    return false;
  }

  // Index and slice -------------------------------------------------------------------------------------------------

  /** Converts an index to a number, checking it as Go does: an integer, non-negative if constant. */
  protected indexValue(expression: Expression, length?: number): ((frame: Frame) => number) | undefined {
    let operand = this.value(expression);
    if (this.isInvalid(operand)) return undefined;
    if (operand.resolveUntyped) {
      operand = operand.resolveUntyped(BASIC.int);
      if (this.isInvalid(operand)) return undefined;
    }
    if (operand.mode === 'constant' && operand.constant) {
      const value = exactInteger(operand.constant);
      if (value === undefined || !(isInteger(operand.type) || isUntyped(operand.type))) {
        this.error(expression, '添字には整数を書いてください。');
        return undefined;
      }
      if (value < 0n) {
        this.error(expression, `添字 ${value} は負の数です。`);
        return undefined;
      }
      if (length !== undefined && value >= BigInt(length)) {
        this.error(expression, `添字 ${value} は範囲の外です（長さは ${length} です）。`);
        return undefined;
      }
      const index = Number(value);
      return () => index;
    }
    if (!isInteger(operand.type)) {
      this.error(expression, `添字には整数を書いてください（${describeType(operand.type)} 型の値が書かれています）。`);
      return undefined;
    }
    const read = operand.eval;
    return (frame) => {
      const value = read(frame) as bigint;
      return value > 1n << 53n ? Number.MAX_SAFE_INTEGER : value < 0n ? -1 : Number(value);
    };
  }

  private index(expression: Extract<Expression, { kind: 'index' }>): Operand {
    const base = this.expression(expression.operand);
    if (this.isInvalid(base)) return base;
    if (base.mode === 'type' || (base.mode === 'value' && base.func?.generic)) {
      this.unsupported(expression, '型引数を明示する書き方');
      return this.invalid(expression);
    }
    const operand = this.asValue(base);
    if (this.isInvalid(operand)) return operand;
    if (expression.indices.length !== 1) {
      this.error(expression, '添字は1つだけ書いてください。');
      return this.invalid(expression);
    }
    const [indexExpression] = expression.indices;
    const { type, read, viaPointer } = throughArrayPointer(operand);
    if (type.kind === 'map') return this.mapIndex(expression, operand, type.key, type.value);
    if (isString(type) && type.kind === 'basic') return this.stringIndex(expression, operand, indexExpression);
    if (type.kind === 'array') {
      const { length } = type;
      const index = this.indexValue(indexExpression, length);
      if (!index) return this.invalid(expression);
      const element = (frame: Frame): [Value[], number] => {
        const array = read(frame) as GoArray;
        const at = index(frame);
        if (at < 0 || at >= length) indexPanic(at, length);
        return [array.elements, at];
      };
      const escapeAddress = viaPointer
        ? undefined
        : () => {
            operand.escapeAddress?.();
            this.escapeOperand(operand);
          };
      return elementOperand(
        expression,
        type.element,
        operand,
        operand.mode === 'variable' || viaPointer,
        element,
        escapeAddress
      );
    }
    if (type.kind === 'slice') {
      const index = this.indexValue(indexExpression);
      if (!index) return this.invalid(expression);
      const element = (frame: Frame): [Value[], number] => {
        const slice = read(frame) as Slice | undefined;
        const at = index(frame);
        const length = slice?.length ?? 0;
        if (at < 0 || at >= length) indexPanic(at, length);
        return [(slice as Slice).array, (slice as Slice).offset + at];
      };
      const escapeAddress = (): void => {
        operand.escapeAddress?.();
        this.escapeOperand(operand);
      };
      return elementOperand(expression, type.element, operand, true, element, escapeAddress);
    }
    this.error(expression, `${describeType(operand.type)} 型の値には添字を付けられません。`);
    return this.invalid(expression);
  }

  /** `s[i]`, a byte of a string, which is never a constant even when both are constants. */
  private stringIndex(span: Span, operand: Operand, indexExpression: Expression): Operand {
    const text =
      operand.mode === 'constant' && operand.constant?.kind === 'string' ? operand.constant.value : undefined;
    const index = this.indexValue(indexExpression, text?.length);
    if (!index) return this.invalid(span);
    const constantIndex = text === undefined ? undefined : this.constantExpression(indexExpression).value;
    if (text !== undefined && constantIndex !== undefined) {
      const byteValue = BigInt(text.charCodeAt(Number(constantIndex)));
      return { mode: 'value', type: BASIC.uint8, span, eval: () => byteValue, ssaConstant: always };
    }
    const read = operand.eval;
    return {
      mode: 'value',
      type: BASIC.uint8,
      span,
      eval: (frame) => {
        const value = read(frame) as string;
        const at = index(frame);
        if (at < 0 || at >= value.length) indexPanic(at, value.length);
        return BigInt(value.charCodeAt(at));
      },
    };
  }

  private mapIndex(span: Span, operand: Operand, keyType: Type, valueType: Type): Operand {
    const expression = span as Extract<Expression, { kind: 'index' }>;
    const key = this.assign(this.expression(expression.indices[0]), keyType, 'map のキー');
    const read = operand.eval;
    const keyOf = mapKeyOf(keyType);
    const zero = this.zeroOf(valueType);
    const lookup = (frame: Frame): [Value, boolean] => {
      const map = read(frame) as GoMap | undefined;
      const entry = map?.entries.get(keyOf(key(frame)));
      return entry ? [entry.value, true] : [zero(), false];
    };
    const prepareStore = (frame: Frame): ((value: Value) => void) => {
      const map = read(frame) as GoMap | undefined;
      const keyValue = key(frame);
      return (value) => {
        if (!map) plainPanic('assignment to entry in nil map');
        const existing = map.entries.get(keyOf(keyValue));
        if (existing) existing.value = writeInPlace(existing.value, value);
        else {
          frame.runtime.allocate(2);
          map.entries.set(keyOf(keyValue), { key: keyValue, value });
        }
      };
    };
    return {
      mode: 'mapIndex',
      type: valueType,
      span,
      variable: operand.variable,
      eval: (frame) => lookup(frame)[0],
      commaOk: lookup,
      prepareStore,
      store: (frame, value) => prepareStore(frame)(value),
      mapUpdate: (frame, change) => {
        const map = read(frame) as GoMap | undefined;
        const keyValue = key(frame);
        const hashed = keyOf(keyValue);
        const existing = map?.entries.get(hashed);
        const next = change(existing ? existing.value : zero());
        if (!map) plainPanic('assignment to entry in nil map');
        if (existing) existing.value = writeInPlace(existing.value, next);
        else {
          frame.runtime.allocate(2);
          map.entries.set(hashed, { key: keyValue, value: next });
        }
      },
    };
  }

  private sliceExpression(expression: Extract<Expression, { kind: 'slice' }>): Operand {
    const operand = this.value(expression.operand);
    if (this.isInvalid(operand)) return operand;
    const { type, read, viaPointer } = throughArrayPointer(operand);
    if (type.kind === 'array' && !viaPointer && operand.mode !== 'variable') {
      this.error(expression, 'アドレスを取れない配列はスライスにできません。');
      return this.invalid(expression);
    }
    const low = expression.low ? this.indexValue(expression.low) : () => 0;
    const high = expression.high ? this.indexValue(expression.high) : undefined;
    if (!low || (expression.high && !high)) return this.invalid(expression);
    this.checkConstantBounds(expression);
    const bounds = (frame: Frame, length: number, limit: number, limitName: string): [number, number] => {
      const from = low(frame);
      const to = high ? high(frame) : length;
      if (to < 0 || to > limit) boundsPanic(`slice bounds out of range [:${to}] with ${limitName} ${limit}`);
      if (from < 0 || from > to) boundsPanic(`slice bounds out of range [${from}:${to}]`);
      return [from, to];
    };
    if (isString(type) && type.kind === 'basic') {
      const resultType = isUntyped(operand.type) ? BASIC.string : operand.type;
      return {
        mode: 'value',
        type: resultType,
        span: expression,
        eval: (frame) => {
          const text = read(frame) as string;
          return text.slice(...bounds(frame, text.length, text.length, 'length'));
        },
      };
    }
    if (type.kind === 'array') {
      const { length } = type;
      return {
        mode: 'value',
        type: { kind: 'slice', element: type.element },
        span: expression,
        backingVars: viaPointer ? undefined : operand.backingVars,
        eval: (frame) => {
          const array = read(frame) as GoArray;
          const [from, to] = bounds(frame, length, length, 'length');
          return new Slice(array.elements, from, to - from, length - from);
        },
      };
    }
    if (type.kind === 'slice') {
      return {
        mode: 'value',
        type: operand.type,
        span: expression,
        backingVars: operand.backingVars,
        nonEscaping: operand.nonEscaping,
        eval: (frame) => {
          const slice = read(frame) as Slice | undefined;
          const capacity = slice?.capacity ?? 0;
          const [from, to] = bounds(frame, slice?.length ?? 0, capacity, 'capacity');
          return slice && new Slice(slice.array, slice.offset + from, to - from, capacity - from);
        },
      };
    }
    this.error(expression, `${describeType(operand.type)} 型の値はスライスにできません。`);
    return this.invalid(expression);
  }

  private checkConstantBounds(expression: Extract<Expression, { kind: 'slice' }>): void {
    const low = expression.low ? this.constantExpression(expression.low).value : undefined;
    const high = expression.high ? this.constantExpression(expression.high).value : undefined;
    if (low !== undefined && high !== undefined && low > high) {
      this.error(expression, `スライスの範囲が逆になっています（${low} > ${high}）。`);
    }
  }

  // Type assertions -------------------------------------------------------------------------------------------------

  private typeAssertion(expression: Extract<Expression, { kind: 'typeAssert' }>): Operand {
    const operand = this.value(expression.operand);
    if (this.isInvalid(operand)) return operand;
    if (!isInterface(operand.type)) {
      this.error(
        expression.operand,
        `${describeType(operand.type)} 型の値はインターフェースではないので、型の表明は使えません。`
      );
      return this.invalid(expression);
    }
    const target = this.resolveType(expression.type);
    if (target === BASIC.invalid) return this.invalid(expression);
    const ifaceType = underlying(operand.type);
    if (!isInterface(target) && ifaceType.kind === 'interface') {
      const missing = missingMethod(target, ifaceType);
      if (missing) {
        this.error(
          expression,
          `${describeType(target)} 型は ${describeType(operand.type)} を実装していないので、この型の表明は必ず失敗します（メソッド ${missing.name} がありません）。`
        );
        return this.invalid(expression);
      }
    }
    const read = operand.eval;
    const test = this.assertionTest(target);
    const zero = this.zeroOf(target);
    const sourceName = typeString(operand.type);
    const targetName = typeString(target);
    const commaOk = (frame: Frame): [Value, boolean] => {
      const value = read(frame) as Iface | undefined;
      const result = value === undefined ? undefined : test(value);
      return result === undefined ? [zero(), false] : [result.value, true];
    };
    return {
      mode: 'value',
      type: target,
      span: expression,
      commaOk,
      eval: (frame) => {
        const value = read(frame) as Iface | undefined;
        if (value === undefined) typeAssertionPanic(`interface is nil, not ${targetName}`);
        const result = test(value);
        if (result !== undefined) return result.value;
        if (isInterface(target)) {
          const missing = missingMethod(value.type, underlying(target) as never);
          typeAssertionPanic(`${typeString(value.type)} is not ${targetName}: missing method ${missing?.name}`);
        }
        typeAssertionPanic(`${sourceName} is ${typeString(value.type)}, not ${targetName}`);
      },
    };
  }

  /** How a type assertion tests a non-nil interface value: the value it yields, or undefined when it fails. */
  protected assertionTest(target: Type): (value: Iface) => { value: Value } | undefined {
    if (isInterface(target)) {
      const iface = underlying(target);
      return (value) => (iface.kind === 'interface' && !missingMethod(value.type, iface) ? { value } : undefined);
    }
    return (value) => (identical(value.type, target) ? { value: copyValue(value.value) } : undefined);
  }

  // Values ----------------------------------------------------------------------------------------------------------

  protected zeroSlotCount(type: Type, seen = new Set<Type>()): number {
    if (seen.has(type)) return 0;
    const under = underlying(type);
    if (under.kind === 'struct') {
      seen.add(type);
      let total = under.fields.length;
      for (const field of under.fields) {
        total += this.zeroSlotCount(field.type, seen);
        if (total > LIMITS.maxSlots + 1) return LIMITS.maxSlots + 1;
      }
      seen.delete(type);
      return total;
    }
    if (under.kind === 'array') {
      if (under.length === 0) return 0;
      seen.add(type);
      const inner = this.zeroSlotCount(under.element, seen);
      seen.delete(type);
      const total = under.length + under.length * inner;
      return total > LIMITS.maxSlots + 1 ? LIMITS.maxSlots + 1 : total;
    }
    return 0;
  }

  /** Creates the zero value of a type each time it is called, since structs and arrays are mutable. */
  protected zeroOf(type: Type): () => Value {
    const slots = this.zeroSlotCount(type);
    const build = this.buildZeroOf(type);
    if (slots === 0) return build;
    return () => {
      const runtime = currentRuntime();
      runtime.allocate(slots);
      runtime.spend(Math.floor(slots / 64));
      return build();
    };
  }

  private buildZeroOf(type: Type): () => Value {
    const under = underlying(type);
    switch (under.kind) {
      case 'basic': {
        if (isBoolean(under)) return () => false;
        if (isString(under)) return () => '';
        if (isInteger(under)) return () => 0n;
        if (isFloat(under)) return () => 0;
        if (isComplex(under)) return () => new Complex(0, 0);
        return () => {};
      }
      case 'struct': {
        const zeros = under.fields.map((field) => this.buildZeroOf(field.type));
        return () => new GoStruct(zeros.map((zero) => zero()));
      }
      case 'array': {
        const zero = this.buildZeroOf(under.element);
        const { length } = under;
        return () => new GoArray(Array.from({ length }, zero));
      }
      default: {
        return () => {};
      }
    }
  }

  /** The value of a constant expression of integer type, for array lengths and literal keys. */
  protected constantExpression(expression: Expression): { value: bigint | undefined; type: Type } {
    const operand = this.value(expression);
    if (this.isInvalid(operand)) return { value: undefined, type: BASIC.invalid };
    if (operand.mode !== 'constant' || !operand.constant) return { value: undefined, type: operand.type };
    if (!isInteger(operand.type) && !isUntyped(operand.type)) return { value: undefined, type: operand.type };
    return { value: exactInteger(operand.constant), type: operand.type };
  }

  /** Converts an operand with `T(x)`, which the call compiler routes here. */
  // code-gauge-allow functionCognitiveComplexity 25 -- Type conversions including untyped shifts and []rune capacity modes.
  protected convert(span: Span, target: Type, rawOperand: Operand): Operand {
    let operand = rawOperand;
    if (this.isInvalid(operand)) return operand;
    if (operand.resolveUntyped) {
      operand = operand.resolveUntyped(isInterface(target) ? defaultType(operand.type) : target);
      if (this.isInvalid(operand)) return operand;
    }
    if (operand.mode === 'constant' && operand.constant && target.kind !== 'typeParam') {
      const result = this.convertConstant(span, target, operand);
      if (result) return result;
    }
    if (operand.type.kind === 'basic' && operand.type.basic === 'untypedNil') {
      if (assignFailure(operand.type, target)) {
        this.error(span, `nil は ${describeType(target)} 型に変換できません。`);
        return this.invalid(span);
      }
      return { mode: 'value', type: target, span, eval: () => {} };
    }
    const source = isUntyped(operand.type) ? this.defaulted(operand) : operand;
    if (this.isInvalid(source)) return source;
    if (!convertible(source.type, target)) {
      this.error(span, `${describeType(source.type)} 型の値は ${describeType(target)} 型に変換できません。`);
      return this.invalid(span);
    }
    if (this.hasTypeParam(source.type) || this.hasTypeParam(target))
      return { mode: 'value', type: target, span, eval: () => {} };
    if (underlying(source.type).kind === 'slice' && underlying(target).kind === 'pointer') {
      this.unsupported(span, 'スライスから配列へのポインタへの変換');
      return this.invalid(span);
    }
    const targetUnder = underlying(target);
    if (isString(source.type) && targetUnder.kind === 'slice' && isBasic(targetUnder.element, 'int32')) {
      if (operand.mode === 'constant' && operand.constant?.kind === 'string') {
        const text = operand.constant.value;
        const convertConstantRunes = stringToRunesWithMode('constant');
        return {
          mode: 'value',
          type: target,
          span,
          eval: (frame) => convertConstantRunes(text, frame.runtime),
          ssaConstant: always,
        };
      }
      const nonEscaping = { escapes: false };
      const heapRunes = stringToRunesWithMode('heap');
      const stackRunes = stringToRunesWithMode('stack');
      const read = source.eval;
      return {
        mode: 'value',
        type: target,
        span,
        nonEscaping,
        eval: (frame) => (nonEscaping.escapes ? heapRunes : stackRunes)(read(frame), frame.runtime),
        ssaConstant: source.ssaConstant,
      };
    }
    const apply = conversion(source.type, target);
    const read = source.eval;
    return {
      mode: 'value',
      type: target,
      span,
      eval: (frame) => apply(read(frame), frame.runtime),
      ssaConstant: source.ssaConstant,
    };
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- The conversions of constants, as the specification lists them.
  private convertConstant(span: Span, target: Type, operand: Operand): Operand | undefined {
    const constant = operand.constant as Constant;
    const under = underlying(target);
    if (under.kind !== 'basic') return undefined;
    if (isString(target) && constant.kind === 'int' && (isInteger(operand.type) || isUntyped(operand.type))) {
      const rune = constant.value < 0n || constant.value > 0x10_ff_ffn ? 0xff_fdn : constant.value;
      return this.constant({ kind: 'string', value: encodeRuneText(Number(rune)) }, target, span);
    }
    if (isNumeric(target) && (constant.kind === 'int' || constant.kind === 'float' || constant.kind === 'complex')) {
      const representation = represent(constant, target);
      if ('error' in representation) {
        const text = describeConstant(constant);
        if (representation.error === 'truncated')
          this.error(span, `定数 ${text} は ${describeType(target)} 型に変換すると小数部分や虚部が失われます。`);
        else if (representation.error === 'overflows')
          this.error(span, `定数 ${text} は ${describeType(target)} 型に収まりません。`);
        else this.error(span, `定数 ${text} は ${describeType(target)} 型に変換できません。`);
        return this.invalid(span);
      }
      return this.constant(representation.constant, target, span);
    }
    if ((isString(target) && constant.kind === 'string') || (isBoolean(target) && constant.kind === 'bool')) {
      return this.constant(constant, target, span);
    }
    return undefined;
  }
}

function encodeRuneText(rune: number): string {
  const text = String.fromCodePoint(rune);
  let bytes = '';
  for (const byte of new TextEncoder().encode(text)) bytes += String.fromCharCode(byte);
  return bytes;
}

/** Reads through a pointer to an array, which indexing and slicing accept in place of the array. */
function throughArrayPointer(operand: Operand): { type: Type; read: Eval; viaPointer: boolean } {
  const type = coreType(operand.type) ?? operand.type;
  if (type.kind !== 'pointer' || underlying(type.element).kind !== 'array')
    return { type, read: operand.eval, viaPointer: false };
  const readPointer = operand.eval;
  return {
    type: underlying(type.element),
    read: (frame) => {
      const pointer = readPointer(frame);
      if (!(pointer instanceof Pointer)) nilPointerPanic();
      return pointer.load();
    },
    viaPointer: true,
  };
}

/** An element of an array or slice, which `element` locates as its container and index. */
function elementOperand(
  span: Span,
  type: Type,
  operand: Operand,
  addressable: boolean,
  element: (frame: Frame) => [Value[], number],
  escapeAddress?: () => void
): Operand {
  return {
    mode: addressable ? 'variable' : 'value',
    type,
    span,
    variable: operand.variable,
    eval: (frame) => {
      const [elements, at] = element(frame);
      return elements[at];
    },
    prepareStore: addressable
      ? (frame) => {
          const [elements, at] = element(frame);
          return (value) => {
            elements[at] = writeInPlace(elements[at], value);
          };
        }
      : undefined,
    store: addressable
      ? (frame, value) => {
          const [elements, at] = element(frame);
          elements[at] = writeInPlace(elements[at], value);
        }
      : undefined,
    addressOf: addressable
      ? () => {
          escapeAddress?.();
          return (frame) => new Pointer(...element(frame));
        }
      : undefined,
    escapeAddress,
  };
}

/**
 * The factors of a float operation that Go's compiler turns into a multiplication it can fuse: `x*y`, except by 2, 1,
 * or -1, which become `x+x`, `x`, or `-x`, and `x/c` for a constant c whose reciprocal is exact, which becomes
 * `x*(1/c)`.
 */
/** What tells apart the factors of products, for finding the same product again: a variable or a constant. */
function productKeyOf(operand: Operand): string | undefined {
  const entity = operand.variable?.entity;
  if (entity && operand.type === entity.type) return `v${entity.slot}:${entity.name}`;
  if (operand.mode === 'constant') return `c${describeConstant(operand.constant as Constant)}`;
  return undefined;
}

function constantFactor(operand: Operand): number | undefined {
  return operand.mode === 'constant' ? (operand.eval({} as Frame) as number) : undefined;
}

/** Multiplying by these, Go's compiler adds, copies, or negates instead, which leaves nothing to fuse. */
function isTrivialFactor(value: number | undefined): boolean {
  return value === 2 || value === 1 || value === -1;
}

function fusableFactors(operator: string, left: Operand, right: Operand): { left: Eval; right: Eval } | undefined {
  if (operator === '*') {
    if (isTrivialFactor(constantFactor(left)) || isTrivialFactor(constantFactor(right))) return undefined;
    return { left: left.eval, right: right.eval };
  }
  if (operator !== '/') return undefined;
  const divisor = constantFactor(right);
  if (divisor === undefined || divisor === 0 || !Number.isFinite(divisor)) return undefined;
  const reciprocal = 1 / divisor;
  // A reciprocal is exact for powers of two, which a normal double holds exactly.
  if (Math.abs(divisor) !== 2 ** Math.round(Math.log2(Math.abs(divisor))) || !Number.isFinite(reciprocal))
    return undefined;
  if (isTrivialFactor(reciprocal)) return undefined;
  return { left: left.eval, right: () => reciprocal };
}

const always = (): boolean => true;
const never = (): boolean => false;

/** Whether both operands are constants to Go's compiler, which then computes the operation before the program runs. */
function bothConstant(left: Operand, right: Operand): (() => boolean) | undefined {
  const { ssaConstant: a } = left;
  const { ssaConstant: b } = right;
  return a && b && (() => a() && b());
}

function isNil(operand: Operand): boolean {
  return operand.type === BASIC.untypedNil;
}

function isValueType(type: Type): boolean {
  const kind = underlying(type).kind;
  return kind === 'struct' || kind === 'array';
}

function basicKind(type: Type): BasicKind {
  const under = underlying(type);
  return under.kind === 'basic' ? under.basic : 'int';
}

export function sameUntypedFamily(a: Type, b: Type): boolean {
  const fa = untypedFamily(a);
  return fa !== 'other' && fa === untypedFamily(b);
}

function untypedFamily(type: Type): string {
  if (isNumeric(type)) return 'numeric';
  if (isString(type)) return 'string';
  if (isBoolean(type)) return 'bool';
  return 'other';
}

function allowsBinaryOperator(operator: string, type: Type): boolean {
  if (type.kind === 'typeParam') {
    const terms = type.constraint.typeSet?.terms;
    return terms !== undefined && terms.length > 0 && terms.every((term) => allowsBinaryOperator(operator, term.type));
  }
  if (operator === '+') return isNumeric(type) || isString(type);
  if (operator === '%' || operator === '&' || operator === '|' || operator === '^' || operator === '&^') {
    return isInteger(type);
  }
  return isNumeric(type);
}

export function largerUntyped(a: Type, b: Type): Type {
  return untypedRank(a) >= untypedRank(b) ? a : b;
}

function untypedRank(type: Type): number {
  return (
    ({ untypedInt: 0, untypedRune: 1, untypedFloat: 2, untypedComplex: 3 } as Record<string, number>)[
      (type as { basic: string }).basic
    ] ?? 0
  );
}

/** How Go's compiler writes a constant in messages. */
export function describeConstant(constant: Constant): string {
  switch (constant.kind) {
    case 'bool': {
      return String(constant.value);
    }
    case 'string': {
      return JSON.stringify(utf8Decode(constant.value));
    }
    case 'int': {
      return constant.value.toString();
    }
    case 'float': {
      const { num, den, exp } = constant.value;
      if (exp === undefined && den === 1n) return num.toString();
      return String(rationalToFloat(constant.value));
    }
    case 'complex': {
      return `(${rationalToFloat(constant.re)} + ${rationalToFloat(constant.im)}i)`;
    }
  }
}

export type { FuncType };
export { RUNE };
