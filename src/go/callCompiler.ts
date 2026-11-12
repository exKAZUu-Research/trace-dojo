// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { assignFailure, constantValue, represent } from './assignability';
import type { Expression, Span } from './ast';
import { CompositeCompiler } from './compositeCompiler';
import { binaryConstant, type Constant, exactInteger, type Rational } from './constants';
import { toInterface } from './conversions';
import type { FuncEntity, GenericFunc } from './entities';
import { containsTypeParam, inferFromConstraints, substitute, type Substitution, unify } from './generics';
import { dynamicMethod, invokeMethod, POINTER_METHOD, receiverFor } from './methods';
import { currentRuntime } from './native';
import type { Operand } from './operand';
import { ordering } from './operators';
import { type Eval, evaluateAll, type Frame, GoPanic, type ListEval } from './runtime';
import { nilPointerPanic, panicNilValue, runtimeErrorPanic } from './runtimeErrors';
import { appendValues } from './sliceOps';
import { newTurtle, TURTLE_POINTER } from './turtle';
import {
  ANY,
  BASIC,
  coreType,
  defaultType,
  describeType,
  type FuncType,
  identical,
  isBasic,
  isComplex,
  isFloat,
  isInteger,
  isInterface,
  isNumeric,
  isOrdered,
  isString,
  isUntyped,
  NO_VALUE,
  type Type,
  type TypeParamType,
  underlying,
} from './types';
import { Complex, GoArray, GoFunc, GoMap, Pointer, Slice, type Value } from './values';

/** Builtins whose call has a value that a statement must use, as Go reports `len(s) (value) is not used`. */
const VALUE_BUILTINS = new Set([
  'append',
  'cap',
  'complex',
  'imag',
  'len',
  'make',
  'max',
  'min',
  'new',
  'real',
  'NewTurtle',
]);

export abstract class CallCompiler extends CompositeCompiler {
  // code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of callee.
  protected compileCall(expression: Extract<Expression, { kind: 'call' }>): Operand {
    const callee = this.expression(expression.callee);
    if (this.isInvalid(callee)) {
      for (const arg of expression.args) this.expression(arg);
      return this.invalid(expression);
    }
    switch (callee.mode) {
      case 'type': {
        if (expression.args.length !== 1) {
          this.error(expression, `型 ${describeType(callee.type)} への変換には、値を1つだけ書いてください。`);
          return this.invalid(expression);
        }
        return this.convert(expression, callee.type, this.value(expression.args[0]));
      }
      case 'builtin': {
        const result = this.builtin(expression, callee.builtin as string);
        return { ...result, isCall: true, pureValue: VALUE_BUILTINS.has(callee.builtin as string) } as Operand;
      }
      case 'method': {
        return { ...this.methodCall(expression, callee), isCall: true };
      }
      case 'package': {
        this.asValue(callee);
        return this.invalid(expression);
      }
      default: {
        return { ...this.functionCall(expression, this.asValue(callee)), isCall: true };
      }
    }
  }

  /** Compiles the arguments, spreading a single call with several results over the parameters. */
  protected callArguments(call: Extract<Expression, { kind: 'call' }>, signature: FuncType): ListEval | undefined {
    return this.argumentsFor(call, signature, calleeName(call.callee));
  }

  private argumentsFor(
    expression: Extract<Expression, { kind: 'call' }>,
    signature: FuncType,
    name: string
  ): ListEval | undefined {
    const { params, variadic } = signature;
    if (expression.args.length === 1 && (params.length !== 1 || variadic)) {
      const only = this.expression(expression.args[0]);
      if (only.type.kind === 'tuple') return this.spreadArguments(expression, only, signature, name);
      return this.listArguments(expression, [only], signature, name);
    }
    const operands = expression.args.map((arg) => this.expression(arg));
    for (const operand of operands) {
      if (operand.type.kind === 'tuple') {
        this.error(operand.span, '複数の値を返す関数の呼び出しは、ほかの引数と並べて書けません。');
        return undefined;
      }
    }
    if (variadic) return this.variadicArguments(expression, operands, signature, name);
    return this.listArguments(expression, operands, signature, name);
  }

  private listArguments(span: Span, operands: Operand[], signature: FuncType, name: string): ListEval | undefined {
    if (signature.variadic) return this.variadicArguments(span, operands, signature, name);
    if (operands.length !== signature.params.length) {
      this.argumentCountError(span, operands.length, signature, name);
      return undefined;
    }
    const values = operands.map((operand, index) => this.assign(operand, signature.params[index], '引数'));
    return (frame) => evaluateAll(frame, values);
  }

  private argumentCountError(span: Span, count: number, signature: FuncType, name: string): void {
    const wanted = signature.params.length;
    const more = count > wanted;
    this.error(
      span,
      `${name} の呼び出しの引数が${more ? '多すぎ' : '足りません'}${more ? 'ます' : ''}（${wanted} 個必要ですが、${count} 個書かれています）。`
    );
  }

  private variadicArguments(span: Span, operands: Operand[], signature: FuncType, name: string): ListEval | undefined {
    const fixed = signature.params.length - 1;
    if (operands.length < fixed) {
      this.error(
        span,
        `${name} の呼び出しの引数が足りません（少なくとも ${fixed} 個必要ですが、${operands.length} 個書かれています）。`
      );
      return undefined;
    }
    const sliceType = signature.params[fixed] as { element: Type };
    const values = operands.map((operand, index) =>
      this.assign(operand, index < fixed ? signature.params[index] : sliceType.element, '引数')
    );
    return (frame) => {
      const evaluated = evaluateAll(frame, values);
      const rest = evaluated.slice(fixed);
      return [
        ...evaluated.slice(0, fixed),
        rest.length === 0 ? undefined : new Slice(rest, 0, rest.length, rest.length),
      ];
    };
  }

  private spreadArguments(span: Span, call: Operand, signature: FuncType, name: string): ListEval | undefined {
    const types = (call.type as { types: Type[] }).types;
    // The conversions of the results call no code of the program, so one holder serves every call.
    let results: Value[] = [];
    const parts = types.map((type, index): Operand => ({
      mode: 'value',
      type,
      span: call.span,
      eval: () => results[index],
    }));
    const args = this.listArguments(span, parts, signature, name);
    if (!args) return undefined;
    const read = call.eval;
    return (frame) => {
      results = read(frame) as unknown as Value[];
      frame.temporaries.push(results);
      try {
        return args(frame);
      } finally {
        frame.temporaries.pop();
      }
    };
  }

  protected resultOperand(span: Span, results: Type[], evaluate: (frame: Frame) => Value | Value[]): Operand {
    // A call with several results evaluates to an array of them, which only assignments and arguments take apart.
    const call = evaluate as Eval;
    if (results.length === 0) return { mode: 'novalue', type: NO_VALUE, span, eval: call, isCall: true };
    if (results.length === 1) return { mode: 'value', type: results[0], span, eval: call, isCall: true };
    return { mode: 'value', type: { kind: 'tuple', types: results }, span, eval: call, isCall: true };
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- Generic and ordinary calls of functions and function values.
  private functionCall(expression: Extract<Expression, { kind: 'call' }>, callee: Operand): Operand {
    if (this.isInvalid(callee)) return callee;
    if (callee.func?.generic) return this.genericCall(expression, callee.func);
    const signature = coreType(callee.type);
    if (signature?.kind !== 'func') {
      this.error(expression, `${describeType(callee.type)} 型の値は関数ではないので、呼び出せません。`);
      for (const arg of expression.args) this.expression(arg);
      return this.invalid(expression);
    }
    const name = calleeName(expression.callee);
    const args = this.argumentsFor(expression, signature, name);
    if (!args) return this.invalid(expression);
    const row = expression.row;
    const direct = callee.func?.direct;
    if (direct) return this.resultOperand(expression, signature.results, (frame) => direct(args(frame), row));
    const read = callee.eval;
    return this.resultOperand(expression, signature.results, (frame) => {
      const fn = read(frame);
      const argValues = args(frame);
      if (!(fn instanceof GoFunc)) nilPointerPanic();
      return fn.call(argValues, row);
    });
  }

  private genericCall(expression: Extract<Expression, { kind: 'call' }>, entity: FuncEntity): Operand {
    const generic = entity.generic as GenericFunc;
    const operands = expression.args.map((arg) => this.expression(arg));
    const mapping = this.inferTypeArguments(expression, generic, operands);
    if (!mapping) return this.invalid(expression);
    const typeArgs = generic.typeParams.map((param) => mapping.get(param.id) as Type);
    if (!this.checkTypeArguments(generic.typeParams, typeArgs, expression)) return this.invalid(expression);
    const signature = substitute(generic.type, mapping, (named, args) =>
      this.instantiateNamed(named, args)
    ) as FuncType;
    const args = this.listArguments(expression, operands, signature, entity.name);
    if (!args) return this.invalid(expression);
    if (typeArgs.some((arg) => containsTypeParam(arg))) {
      return this.resultOperand(expression, signature.results, () => {});
    }
    const instance = generic.instantiate(typeArgs);
    const row = expression.row;
    return this.resultOperand(expression, signature.results, (frame) => instance.call(args(frame), row));
  }

  /** Infers the type arguments of a generic call from its arguments: typed ones first, then untyped defaults. */
  private inferTypeArguments(span: Span, generic: GenericFunc, operands: Operand[]): Substitution | undefined {
    const { typeParams, type } = generic;
    const mapping: Substitution = new Map();
    const params = type.params;
    if (!type.variadic && operands.length !== params.length) {
      this.error(
        span,
        `関数の呼び出しの引数の数が合いません（${params.length} 個必要ですが、${operands.length} 個書かれています）。`
      );
      return undefined;
    }
    const paramFor = (index: number): Type =>
      type.variadic && index >= params.length - 1 ? (params.at(-1) as { element: Type }).element : params[index];
    const untyped: [Type, Operand][] = [];
    for (const [index, operand] of operands.entries()) {
      if (this.isInvalid(operand)) return undefined;
      const param = paramFor(index);
      if (isUntyped(operand.type)) {
        untyped.push([param, operand]);
        continue;
      }
      if (operand.mode === 'novalue' || operand.mode === 'type') return (this.asValue(operand), undefined);
      if (!unify(param, operand.type, mapping, typeParams)) {
        this.error(
          operand.span,
          `${describeType(operand.type)} 型の値は、引数の型 ${describeType(param)} に合いません。`
        );
        return undefined;
      }
    }
    inferFromConstraints(typeParams, mapping);
    for (const [param, operand] of untyped) {
      if (param.kind === 'typeParam' && !mapping.has(param.id) && typeParams.includes(param)) {
        if (isBasic(operand.type, 'untypedNil')) continue;
        mapping.set(param.id, defaultType(operand.type));
      }
    }
    inferFromConstraints(typeParams, mapping);
    const missing = typeParams.find((param) => !mapping.has(param.id));
    if (missing) {
      this.error(span, `型引数 ${missing.name} を推論できません。`);
      return undefined;
    }
    return mapping;
  }

  // Methods ---------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 25 -- Method calls through values, pointers, embedded fields, and interfaces.
  private methodCall(expression: Extract<Expression, { kind: 'call' }>, callee: Operand): Operand {
    const { receiver, selection } = callee.method as NonNullable<Operand['method']>;
    const methodType = selection.method.type;
    const name = (expression.callee as { field?: string }).field ?? selection.method.name;
    const args = this.argumentsFor(expression, methodType, name);
    if (!args) return this.invalid(expression);
    const row = expression.row;
    if (selection.kind === 'interfaceMethod') {
      const readReceiver = this.embeddedReceiver(receiver, selection.path);
      const methodName = selection.method.name;
      return this.resultOperand(expression, methodType.results, (frame) => {
        const iface = readReceiver(frame) as { type: Type; value: Value } | undefined;
        const argValues = args(frame);
        if (!iface) nilPointerPanic();
        const call = dynamicMethod(iface.type, methodName);
        if (!call) throw new Error(`Missing method ${methodName}`);
        return call(iface.value, argValues, row);
      });
    }
    const { method, path } = selection;
    let readReceiver: Eval;
    if (method.pointerReceiver) {
      const pointer = this.pointerReceiver(expression, receiver, path);
      if (!pointer) return this.invalid(expression);
      readReceiver = pointer;
    } else {
      const read = receiver.eval;
      const viaPointer = underlying(receiver.type).kind === 'pointer';
      readReceiver = (frame) => receiverFor(read(frame), path, method, viaPointer);
    }
    return this.resultOperand(expression, methodType.results, (frame) => {
      const value = readReceiver(frame);
      return invokeMethod(method, value, args(frame), row);
    });
  }

  /** Evaluates the embedded field that holds an interface, for a method promoted from it. */
  private embeddedReceiver(receiver: Operand, path: readonly number[]): Eval {
    const read = receiver.eval;
    if (path.length === 0) return read;
    return (frame) => {
      let current = read(frame);
      for (const index of path) {
        if (current instanceof Pointer) current = current.load();
        else if (current === undefined) nilPointerPanic();
        current = (current as { fields: Value[] }).fields[index];
      }
      return current;
    };
  }

  /** The pointer a method with a pointer receiver receives, taking the address of an addressable value. */
  private pointerReceiver(span: Span, receiver: Operand, path: readonly number[]): Eval | undefined {
    const read = receiver.eval;
    if (path.length > 0) {
      // Reaching the embedded field goes through the receiver's struct, which must be addressable unless a pointer
      // leads there.
      const throughPointer = underlying(receiver.type).kind === 'pointer';
      if (!throughPointer && receiver.mode !== 'variable') {
        this.error(span, 'アドレスを取れない値なので、ポインタのレシーバを持つメソッドは呼び出せません。');
        return undefined;
      }
      receiver.variable?.markUsed();
      if (!throughPointer && receiver.addressOf) {
        const address = receiver.addressOf();
        return (frame) => receiverFor(address(frame), path, POINTER_METHOD);
      }
      return (frame) => receiverFor(read(frame), path, POINTER_METHOD);
    }
    if (underlying(receiver.type).kind === 'pointer') return read;
    if (receiver.mode !== 'variable' || !receiver.addressOf) {
      this.error(span, `アドレスを取れない値なので、ポインタのレシーバを持つメソッドは呼び出せません。`);
      return undefined;
    }
    receiver.variable?.markUsed();
    return receiver.addressOf();
  }

  // Builtins --------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 30 -- One case per builtin function.
  private builtin(expression: Extract<Expression, { kind: 'call' }>, name: string): Operand {
    const { args } = expression;
    const count = (min: number, max = min): boolean => {
      if (args.length >= min && args.length <= max) return true;
      this.error(expression, `${name} の引数の数が合いません。`);
      for (const arg of args) this.expression(arg);
      return false;
    };
    switch (name) {
      case 'len':
      case 'cap': {
        return count(1) ? this.lengthBuiltin(expression, name) : this.invalid(expression);
      }
      case 'append': {
        return args.length > 0 ? this.appendBuiltin(expression) : (count(1), this.invalid(expression));
      }
      case 'make': {
        return count(1, 3) ? this.makeBuiltin(expression) : this.invalid(expression);
      }
      case 'new': {
        if (!count(1)) return this.invalid(expression);
        const type = this.typeArgument(args[0]);
        if (!type) return this.invalid(expression);
        const zero = this.zeroOf(type);
        return {
          mode: 'value',
          type: { kind: 'pointer', element: type },
          span: expression,
          createsObject: true,
          eval: () => new Pointer({ v: zero() } as never, 'v'),
        };
      }
      case 'delete': {
        return count(2) ? this.deleteBuiltin(expression) : this.invalid(expression);
      }
      case 'panic': {
        if (!count(1)) return this.invalid(expression);
        const value = this.assign(this.expression(args[0]), ANY, '引数');
        return {
          mode: 'novalue',
          type: NO_VALUE,
          span: expression,
          eval: (frame) => {
            const panicValue = value(frame);
            throw new GoPanic(panicValue ?? panicNilValue());
          },
        };
      }
      case 'recover': {
        if (!count(0)) return this.invalid(expression);
        return { mode: 'value', type: ANY, span: expression, eval: (frame) => frame.runtime.recover(frame) };
      }
      case 'copy': {
        return count(2) ? this.copyBuiltin(expression) : this.invalid(expression);
      }
      case 'min':
      case 'max': {
        return args.length > 0 ? this.minMaxBuiltin(expression, name) : (count(1), this.invalid(expression));
      }
      case 'clear': {
        return count(1) ? this.clearBuiltin(expression) : this.invalid(expression);
      }
      case 'complex': {
        return count(2) ? this.complexBuiltin(expression) : this.invalid(expression);
      }
      case 'real':
      case 'imag': {
        return count(1) ? this.complexPartBuiltin(expression, name) : this.invalid(expression);
      }
      case 'print':
      case 'println': {
        // The builtin prints to standard error, which this environment accepts without showing.
        const values = args.map((arg) => this.defaulted(this.value(arg)).eval);
        return {
          mode: 'novalue',
          type: NO_VALUE,
          span: expression,
          eval: (frame) => {
            for (const value of values) value(frame);
            return;
          },
        };
      }
      case 'close': {
        this.unsupported(expression, 'チャネル（close）');
        return this.invalid(expression);
      }
      case 'NewTurtle': {
        return this.newTurtleBuiltin(expression);
      }
    }
    throw new Error(`Unknown builtin ${name}`);
  }

  private typeArgument(expression: Expression): Type | undefined {
    const operand = this.expression(expression);
    if (this.isInvalid(operand)) return undefined;
    if (operand.mode !== 'type') {
      this.error(expression, 'ここには型を書いてください。');
      return undefined;
    }
    return operand.type;
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- len and cap of each kind of operand, with Go's constant rules.
  private lengthBuiltin(expression: Extract<Expression, { kind: 'call' }>, name: 'len' | 'cap'): Operand {
    const operand = this.value(expression.args[0]);
    if (this.isInvalid(operand)) return operand;
    let type = coreType(operand.type) ?? operand.type;
    const read = operand.eval;
    if (name === 'len' && isString(type) && type.kind === 'basic') {
      if (operand.mode === 'constant' && operand.constant?.kind === 'string') {
        return this.constant({ kind: 'int', value: BigInt(operand.constant.value.length) }, BASIC.int, expression);
      }
      return {
        mode: 'value',
        type: BASIC.int,
        span: expression,
        eval: (frame) => BigInt((read(frame) as string).length),
      };
    }
    if (type.kind === 'pointer' && underlying(type.element).kind === 'array') type = underlying(type.element);
    if (type.kind === 'array') {
      // The length of an array is a constant, unless the expression calls a function.
      if (!containsCall(expression.args[0])) {
        return this.constant({ kind: 'int', value: BigInt(type.length) }, BASIC.int, expression);
      }
      const length = BigInt(type.length);
      return { mode: 'value', type: BASIC.int, span: expression, eval: (frame) => (read(frame), length) };
    }
    if (type.kind === 'slice') {
      return {
        mode: 'value',
        type: BASIC.int,
        span: expression,
        eval: (frame) => {
          const slice = read(frame) as Slice | undefined;
          return BigInt(slice ? (name === 'len' ? slice.length : slice.capacity) : 0);
        },
      };
    }
    if (type.kind === 'map' && name === 'len') {
      return {
        mode: 'value',
        type: BASIC.int,
        span: expression,
        eval: (frame) => BigInt((read(frame) as GoMap | undefined)?.entries.size ?? 0),
      };
    }
    this.error(expression, `${describeType(operand.type)} 型の値には ${name} を使えません。`);
    return this.invalid(expression);
  }

  private appendBuiltin(expression: Extract<Expression, { kind: 'call' }>): Operand {
    const [first, ...rest] = expression.args;
    const slice = this.value(first);
    if (this.isInvalid(slice)) {
      for (const arg of rest) this.expression(arg);
      return slice;
    }
    if (isBasic(slice.type, 'untypedNil')) {
      this.error(
        first,
        'append の最初の引数には、型の決まったスライスを書いてください（nil だけでは型が分かりません）。'
      );
      return this.invalid(expression);
    }
    const sliceType = coreType(slice.type);
    if (sliceType?.kind !== 'slice') {
      this.error(
        first,
        `append の最初の引数にはスライスを書いてください（${describeType(slice.type)} 型の値が書かれています）。`
      );
      return this.invalid(expression);
    }
    const element = sliceType.element;
    const values = rest.map((arg) => this.assign(this.expression(arg), element, '要素'));
    const read = slice.eval;
    const zero = this.zeroOf(element);
    // A local slice variable that never escapes gets its first array on the stack, as Go's compiler allocates it.
    const local = slice.variable?.entity;
    const onStack = (): boolean => local?.owner !== undefined && !local.escapes;
    return {
      mode: 'value',
      type: slice.type,
      span: expression,
      eval: (frame) => {
        const target = read(frame) as Slice | undefined;
        const added = evaluateAll(frame, values);
        return appendValues(target, added, element, zero, (count) => frame.runtime.allocate(count), onStack());
      },
    };
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- make of slices and maps, with Go's checks of sizes.
  private makeBuiltin(expression: Extract<Expression, { kind: 'call' }>): Operand {
    const type = this.typeArgument(expression.args[0]);
    if (!type) return this.invalid(expression);
    const under = coreType(type);
    const sizes = expression.args.slice(1).map((arg) => this.sizeArgument(arg));
    if (sizes.includes(undefined)) return this.invalid(expression);
    const [length, capacity] = sizes as Eval[];
    if (under?.kind === 'slice') {
      if (!length) {
        this.error(expression, 'スライスを make で作るときは、長さを書いてください。');
        return this.invalid(expression);
      }
      const constantLength = this.constantSize(expression.args[1]);
      const constantCapacity = expression.args[2] ? this.constantSize(expression.args[2]) : undefined;
      if (constantLength !== undefined && constantCapacity !== undefined && constantLength > constantCapacity) {
        this.error(expression, `make の長さ ${constantLength} が容量 ${constantCapacity} より大きくなっています。`);
        return this.invalid(expression);
      }
      const zero = this.zeroOf(under.element);
      return {
        mode: 'value',
        type,
        span: expression,
        createsObject: true,
        eval: (frame) => {
          const size = length(frame) as bigint;
          const room = capacity ? (capacity(frame) as bigint) : size;
          if (size < 0n || size > 1n << 48n) runtimeErrorPanic('makeslice: len out of range');
          if (room < size || room > 1n << 48n) runtimeErrorPanic('makeslice: cap out of range');
          frame.runtime.allocate(Number(room));
          const array = Array.from({ length: Number(room) }, zero);
          return new Slice(array, 0, Number(size), Number(room));
        },
      };
    }
    if (under?.kind === 'map') {
      if (expression.args.length > 2) {
        this.error(expression, 'map を make で作るときの引数は、型と大きさの目安の2つまでです。');
        return this.invalid(expression);
      }
      const keyOf = this.mapKeyFunction(under.key);
      return {
        mode: 'value',
        type,
        span: expression,
        createsObject: true,
        eval: (frame) => {
          if (length && (length(frame) as bigint) < 0n) runtimeErrorPanic('makemap: size out of range');
          return new GoMap(keyOf);
        },
      };
    }
    this.error(expression, `make で作れるのはスライスと map だけです（${describeType(type)} 型が書かれています）。`);
    return this.invalid(expression);
  }

  protected abstract mapKeyFunction(type: Type): (key: Value) => unknown;

  private constantSize(expression: Expression | undefined): bigint | undefined {
    if (!expression) return undefined;
    return this.constantExpression(expression).value;
  }

  private sizeArgument(expression: Expression): Eval | undefined {
    const operand = this.value(expression);
    if (this.isInvalid(operand)) return undefined;
    if (operand.mode === 'constant' && operand.constant) {
      const value = exactInteger(operand.constant);
      if (value === undefined) {
        this.error(expression, '大きさには整数を書いてください。');
        return undefined;
      }
      if (value < 0n) {
        this.error(expression, `大きさに負の数 ${value} は使えません。`);
        return undefined;
      }
      return () => value;
    }
    if (!isInteger(operand.type)) {
      this.error(
        expression,
        `大きさには整数を書いてください（${describeType(operand.type)} 型の値が書かれています）。`
      );
      return undefined;
    }
    return operand.eval;
  }

  private deleteBuiltin(expression: Extract<Expression, { kind: 'call' }>): Operand {
    const map = this.value(expression.args[0]);
    if (this.isInvalid(map)) return map;
    const under = coreType(map.type);
    if (under?.kind !== 'map') {
      this.error(
        expression.args[0],
        `delete の最初の引数には map を書いてください（${describeType(map.type)} 型の値が書かれています）。`
      );
      return this.invalid(expression);
    }
    const key = this.assign(this.expression(expression.args[1]), under.key, 'map のキー');
    const read = map.eval;
    return {
      mode: 'novalue',
      type: NO_VALUE,
      span: expression,
      eval: (frame) => {
        const target = read(frame) as GoMap | undefined;
        const keyValue = key(frame);
        target?.entries.delete(target.keyOf(keyValue));
        return;
      },
    };
  }

  private copyBuiltin(expression: Extract<Expression, { kind: 'call' }>): Operand {
    const destination = this.value(expression.args[0]);
    const source = this.value(expression.args[1]);
    if (this.isInvalid(destination) || this.isInvalid(source)) return this.invalid(expression);
    const target = coreType(destination.type);
    const from = coreType(source.type);
    const stringSource = isString(source.type) && target?.kind === 'slice' && isBasic(target.element, 'uint8');
    if (
      target?.kind !== 'slice' ||
      (!stringSource && (from?.kind !== 'slice' || !identical(target.element, from.element)))
    ) {
      this.error(expression, 'copy の引数には、要素の型が同じ2つのスライスを書いてください。');
      return this.invalid(expression);
    }
    const readTarget = destination.eval;
    const readSource = source.eval;
    return {
      mode: 'value',
      type: BASIC.int,
      span: expression,
      eval: (frame) => {
        const to = readTarget(frame) as Slice | undefined;
        const value = readSource(frame);
        const items = stringSource
          ? Array.from(value as string, (char) => BigInt(char.charCodeAt(0)) as Value)
          : ((value as Slice | undefined)?.values() ?? []);
        const count = Math.min(to?.length ?? 0, items.length);
        for (let index = 0; index < count; index++) (to as Slice).set(index, items[index]);
        frame.runtime.spend(Math.floor(count / 16));
        return BigInt(count);
      },
    };
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- min and max over constants and values of ordered types.
  private minMaxBuiltin(expression: Extract<Expression, { kind: 'call' }>, name: 'min' | 'max'): Operand {
    let operands = expression.args.map((arg) => this.value(arg));
    if (operands.some((operand) => this.isInvalid(operand))) return this.invalid(expression);
    const typed = operands.find((operand) => !isUntyped(operand.type));
    if (typed) {
      operands = operands.map((operand) => {
        if (!isUntyped(operand.type)) return operand;
        const converted = this.assign(operand, typed.type, '引数');
        return { ...operand, type: typed.type, mode: 'value', eval: converted };
      });
      if (operands.some((operand) => !identical(operand.type, typed.type))) {
        this.error(expression, `${name} の引数の型が揃っていません。`);
        return this.invalid(expression);
      }
    }
    let type = typed?.type ?? operands[0].type;
    if (!typed) for (const operand of operands) if (rankOf(operand.type) > rankOf(type)) type = operand.type;
    if (!isOrdered(type)) {
      this.error(expression, `${describeType(type)} 型の値は大小を比べられないので、${name} には使えません。`);
      return this.invalid(expression);
    }
    if (operands.every((operand) => operand.mode === 'constant' && operand.constant)) {
      const constants = operands.map((operand) => operand.constant as Constant);
      let chosen = constants[0];
      for (const constant of constants.slice(1)) {
        if ((binaryConstant(name === 'min' ? '<' : '>', constant, chosen, false) as { value: boolean }).value)
          chosen = constant;
      }
      return this.constant(chosen, type, expression);
    }
    const reads = operands.map((operand) => operand.eval);
    const choose = isFloat(type) ? floatExtreme(name) : orderedExtreme(name);
    return {
      mode: 'value',
      type,
      span: expression,
      eval: (frame) => {
        let best = reads[0](frame);
        for (const read of reads.slice(1)) best = choose(best, read(frame));
        return best;
      },
    };
  }

  private clearBuiltin(expression: Extract<Expression, { kind: 'call' }>): Operand {
    const operand = this.value(expression.args[0]);
    if (this.isInvalid(operand)) return operand;
    const under = coreType(operand.type);
    const read = operand.eval;
    if (under?.kind === 'map') {
      return {
        mode: 'novalue',
        type: NO_VALUE,
        span: expression,
        eval: (frame) => ((read(frame) as GoMap | undefined)?.entries.clear(), undefined),
      };
    }
    if (under?.kind === 'slice') {
      const zero = this.zeroOf(under.element);
      return {
        mode: 'novalue',
        type: NO_VALUE,
        span: expression,
        eval: (frame) => {
          const slice = read(frame) as Slice | undefined;
          for (let index = 0; index < (slice?.length ?? 0); index++) (slice as Slice).set(index, zero());
          return;
        },
      };
    }
    this.error(
      expression,
      `clear には map かスライスを書いてください（${describeType(operand.type)} 型の値が書かれています）。`
    );
    return this.invalid(expression);
  }

  private complexBuiltin(expression: Extract<Expression, { kind: 'call' }>): Operand {
    let re = this.value(expression.args[0]);
    let im = this.value(expression.args[1]);
    if (this.isInvalid(re) || this.isInvalid(im)) return this.invalid(expression);
    if (
      re.mode === 'constant' &&
      im.mode === 'constant' &&
      re.constant &&
      im.constant &&
      isUntyped(re.type) &&
      isUntyped(im.type)
    ) {
      const real = represent(re.constant, BASIC.untypedFloat);
      const imaginary = represent(im.constant, BASIC.untypedFloat);
      if ('error' in real || 'error' in imaginary) {
        this.error(expression, 'complex の引数には実数を書いてください。');
        return this.invalid(expression);
      }
      return this.constant(
        { kind: 'complex', re: toRational(real.constant), im: toRational(imaginary.constant) },
        BASIC.untypedComplex,
        expression
      );
    }
    if (isUntyped(re.type) && !isUntyped(im.type))
      re = { ...re, type: im.type, eval: this.assign(re, im.type, '引数') };
    if (isUntyped(im.type) && !isUntyped(re.type))
      im = { ...im, type: re.type, eval: this.assign(im, re.type, '引数') };
    if (isUntyped(re.type)) re = this.defaulted({ ...re, type: BASIC.untypedFloat });
    if (isUntyped(im.type)) im = this.defaulted({ ...im, type: BASIC.untypedFloat });
    if (!isFloat(re.type) || !identical(re.type, im.type)) {
      this.error(expression, 'complex の2つの引数は、同じ浮動小数点数の型にしてください。');
      return this.invalid(expression);
    }
    const type = isBasic(re.type, 'float32') ? BASIC.complex64 : BASIC.complex128;
    const readRe = re.eval;
    const readIm = im.eval;
    return {
      mode: 'value',
      type,
      span: expression,
      eval: (frame) => new Complex(readRe(frame) as number, readIm(frame) as number),
    };
  }

  private complexPartBuiltin(expression: Extract<Expression, { kind: 'call' }>, name: 'real' | 'imag'): Operand {
    const operand = this.value(expression.args[0]);
    if (this.isInvalid(operand)) return operand;
    if (operand.mode === 'constant' && operand.constant && isUntyped(operand.type)) {
      const constant = operand.constant;
      if (constant.kind === 'string' || constant.kind === 'bool') {
        this.error(expression, `${name} には複素数を書いてください。`);
        return this.invalid(expression);
      }
      const part =
        constant.kind === 'complex'
          ? name === 'real'
            ? constant.re
            : constant.im
          : name === 'real'
            ? constant.kind === 'float'
              ? constant.value
              : { num: constant.value, den: 1n }
            : { num: 0n, den: 1n };
      return this.constant({ kind: 'float', value: part }, BASIC.untypedFloat, expression);
    }
    if (!isComplex(operand.type)) {
      this.error(
        expression,
        `${name} には複素数を書いてください（${describeType(operand.type)} 型の値が書かれています）。`
      );
      return this.invalid(expression);
    }
    const type = isBasic(operand.type, 'complex64') ? BASIC.float32 : BASIC.float64;
    const read = operand.eval;
    return {
      mode: 'value',
      type,
      span: expression,
      eval: (frame) => (read(frame) as Complex)[name === 'real' ? 're' : 'im'],
    };
  }

  private newTurtleBuiltin(expression: Extract<Expression, { kind: 'call' }>): Operand {
    const { args } = expression;
    if (args.length > 0 && args.length !== 2 && args.length !== 3) {
      this.error(expression, 'NewTurtle には、引数を書かないか、x と y、または x と y と色を書いてください。');
      for (const arg of args) this.expression(arg);
      return this.invalid(expression);
    }
    const values = args.map((arg, index) =>
      this.assign(this.expression(arg), index < 2 ? BASIC.int : BASIC.string, '引数')
    );
    return {
      mode: 'value',
      type: TURTLE_POINTER,
      span: expression,
      createsObject: true,
      eval: (frame) => newTurtle(values.map((value) => value(frame))),
    };
  }

  /** Wraps a library or program function in a value, for an interface conversion. */
  protected boxed(type: Type): (value: Value) => Value {
    return toInterface(type);
  }

  protected static readonly constantValue = constantValue;
  protected static readonly assignFailure = assignFailure;
  protected static readonly currentRuntime = currentRuntime;
  protected static readonly isNumeric = isNumeric;
  protected static readonly isInterface = isInterface;
  protected static readonly GoArray = GoArray;
}

function calleeName(expression: Expression): string {
  if (expression.kind === 'name') return expression.name;
  if (expression.kind === 'selector') return expression.field;
  return '関数';
}

function containsCall(expression: Expression): boolean {
  switch (expression.kind) {
    case 'call':
    case 'funcLiteral': {
      return true;
    }
    case 'paren': {
      return containsCall(expression.expression);
    }
    case 'selector': {
      return containsCall(expression.operand);
    }
    case 'index': {
      return containsCall(expression.operand) || expression.indices.some(containsCall);
    }
    case 'unary': {
      return containsCall(expression.operand);
    }
    case 'binary': {
      return containsCall(expression.left) || containsCall(expression.right);
    }
    default: {
      return false;
    }
  }
}

/** Picks the smaller or larger of two ordered values. */
function orderedExtreme(name: 'min' | 'max'): (best: Value, value: Value) => Value {
  const better = ordering(name === 'min' ? '<' : '>');
  return (best, value) => (better(value, best) ? value : best);
}

/** Picks as Go's min and max do for floats: NaN wins, and min(-0, 0) is -0 while max(-0, 0) is 0. */
function floatExtreme(name: 'min' | 'max'): (best: Value, value: Value) => Value {
  const ordered = orderedExtreme(name);
  return (best, value) => {
    if (Number.isNaN(best) || Number.isNaN(value)) return Number.NaN;
    if (value === 0 && best === 0) return (name === 'min') === Object.is(value, -0) ? value : best;
    return ordered(best, value);
  };
}

function toRational(constant: Constant): Rational {
  return constant.kind === 'float' ? constant.value : { num: (constant as { value: bigint }).value, den: 1n };
}

function rankOf(type: Type): number {
  return (
    ({ untypedInt: 0, untypedRune: 1, untypedFloat: 2 } as Record<string, number>)[
      (type as { basic?: string }).basic ?? ''
    ] ?? 0
  );
}

export type { Frame, TypeParamType };
