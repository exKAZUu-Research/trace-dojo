// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { LIMITS } from '../interpreter/limits';
import { assignFailure, constantValue, represent } from './assignability';
import type { Expression, Span } from './ast';
import { CompositeCompiler } from './compositeCompiler';
import { binaryConstant, type Constant, exactInteger, type Rational } from './constants';
import { toInterface } from './conversions';
import {
  always,
  type FuncEntity,
  type FunctionContext,
  type GenericFunc,
  INLINE_CALL_COST,
  inlinedCall,
  linkArgument,
  type StaticCallee,
  staysLocal,
  type Temporary,
  type VarEntity,
} from './entities';
import { checkKeyHashable } from './equality';
import { describeConstant, largerUntyped, sameUntypedFamily } from './expressionCompiler';
import { containsTypeParam, inferFromConstraints, substitute, type Substitution, unify } from './generics';
import {
  type BoundCall,
  dynamicMethod,
  invokeMethod,
  POINTER_METHOD,
  receiverFor,
  resumeDynamicMethod,
  resumeMethod,
} from './methods';
import { currentRuntime } from './native';
import {
  addFieldConstants,
  allConstant,
  type ConstantParams,
  type Operand,
  type SsaConstant,
  ssaFactsAt,
  type SsaFields,
  type Storage,
} from './operand';
import { ordering } from './operators';
import {
  type Eval,
  evaluateAll,
  type Frame,
  GoPanic,
  type ListEval,
  type StackBuffers,
  type Suspending,
  withTemporary,
} from './runtime';
import { nilPointerPanic, panicNilValue, plainPanic, runtimeErrorPanic } from './runtimeErrors';
import { runtimePrint } from './runtimePrint';
import { closeChannel, makeChannel } from './scheduler';
import { appendValues, inStackBuffer, type StackBuffer } from './sliceOps';
import { sliceMode } from './slicePass';
import { clobberMemory, reachingValue } from './ssaValues';
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
  lookupFieldOrMethod,
  NO_VALUE,
  type Type,
  type TypeParamType,
  underlying,
} from './types';
import {
  Cell,
  type Channel,
  Complex,
  copyValue,
  GoArray,
  GoFunc,
  GoMap,
  type Iface,
  Pointer,
  Slice,
  type Value,
} from './values';

/** Builtins whose call has a value that a statement must use, as Go reports `len(s) (value) is not used`. */
export const VALUE_BUILTINS = new Set(['append', 'cap', 'complex', 'imag', 'len', 'make', 'max', 'min', 'new', 'real']);

/** Builtins whose call neither calls the runtime nor stores to memory. */
const MEMORYLESS_BUILTINS = new Set(['cap', 'complex', 'imag', 'len', 'max', 'min', 'real']);

export abstract class CallCompiler extends CompositeCompiler {
  // code-gauge-allow functionNcss 34 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
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
        if (result.mode !== 'constant') this.runtimeCallCount++;
        if (!MEMORYLESS_BUILTINS.has(callee.builtin as string)) clobberMemory(this.fn);
        return { ...result, isCall: true, pureValue: VALUE_BUILTINS.has(callee.builtin as string) } as Operand;
      }
      case 'method': {
        const result = this.methodCall(expression, callee);
        if (result.mode !== 'constant') this.runtimeCallCount++;
        clobberMemory(this.fn);
        return { ...result, isCall: true };
      }
      case 'package': {
        this.asValue(callee);
        return this.invalid(expression);
      }
      default: {
        const result = this.functionCall(expression, this.asValue(callee));
        if (result.mode !== 'constant') this.runtimeCallCount++;
        clobberMemory(this.fn);
        return { ...result, isCall: true };
      }
    }
  }

  /** Compiles the arguments, spreading a single call with several results over the parameters. */
  protected callArguments(call: Extract<Expression, { kind: 'call' }>, signature: FuncType): ListEval | undefined {
    return this.argumentsFor(call, signature, calleeName(call.callee));
  }

  /**
   * Compiles the arguments of a call. For a function of the program, `callee` links each argument to its parameter,
   * after `receivers` leading parameters, so that the body decides whether the argument escapes.
   */
  // code-gauge-allow functionCognitiveComplexity 20 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
  // code-gauge-allow functionNcss 32 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
  private argumentsFor(
    expression: Extract<Expression, { kind: 'call' }>,
    signature: FuncType,
    name: string,
    callee?: ProgramCall
  ): ListEval | undefined {
    const { params, variadic } = signature;
    if (expression.spread) return this.spreadSliceArguments(expression, signature, name);
    const outer = this.inAllocatedSlice;
    let operands: Operand[];
    try {
      operands = expression.args.map((arg, index) => {
        this.inAllocatedSlice = variadic && index >= params.length - 1;
        return this.expression(arg);
      });
    } finally {
      this.inAllocatedSlice = outer;
    }
    if (operands.length === 1 && operands[0].type.kind === 'tuple') {
      return this.spreadArguments(expression, operands[0], signature, name);
    }
    if (operands.length === 1 && (params.length !== 1 || variadic)) {
      return this.listArguments(expression, operands, signature, name);
    }
    for (const operand of operands) {
      if (operand.type.kind === 'tuple') {
        this.error(operand.span, '複数の値を返す関数の呼び出しは、ほかの引数と並べて書けません。');
        return undefined;
      }
    }
    if (variadic) return this.variadicArguments(expression, operands, signature, name);
    if (!callee || operands.length !== params.length) return this.listArguments(expression, operands, signature, name);
    const { target, receivers } = callee;
    for (const [index, { ssaConstant, ssaFields }] of operands.entries()) {
      if (ssaConstant) callee.constantArgs[receivers + index] = ssaConstant;
      if (ssaFields) callee.argFields[receivers + index] = ssaFields;
    }
    operands = operands.map((operand, index) =>
      isInterface(params[index])
        ? operand
        : this.sliceArgument(expression.args[index], operand, target, receivers + index)
    );
    return this.listArguments(expression, operands, signature, name, (index) => (value) => {
      this.linkToParameter(callee, receivers + index, value);
    });
  }

  /** A call of a function of the program that Go's compiler resolves, with what stands for its result in the caller. */
  private programCall(target: StaticCallee | undefined, receivers: number): ProgramCall | undefined {
    if (!target) return undefined;
    const constantCaptures = new Map<object, SsaConstant>();
    for (const variable of target.summary.context?.captures.keys() ?? []) {
      const { constant, fields } = variable.owner === this.fn ? reachingValue(this.fn, variable) : {};
      if (constant) constantCaptures.set(variable, constant);
      addFieldConstants(constantCaptures, variable, fields);
    }
    return { target, receivers, result: this.hiddenVariable(), constantArgs: [], argFields: [], constantCaptures };
  }

  /**
   * Makes a value passed to a function of the program share what the body does with the parameter, once the callee
   * is settled; a callee that turns out not to be the call's lets the value escape.
   */
  private linkToParameter(call: ProgramCall, index: number, value: Storage): void {
    const { target } = call;
    const toParam = (params: VarEntity[]): void => {
      const param = params[index];
      if (param) linkArgument(param, value, call.result);
    };
    const link = (holds: boolean): void => {
      if (!holds) {
        this.escapeOperand(value);
        return;
      }
      if (target.summary.params) toParam(target.summary.params);
      else target.summary.pending.push(toParam);
    };
    if (target.holds === always || !this.fn) link(target.holds());
    else outermost(this.fn).onComplete.push(() => link(target.holds()));
  }

  /** `f(a, xs...)`: passes the slice as the variadic parameter itself. */
  private spreadSliceArguments(
    expression: Extract<Expression, { kind: 'call' }>,
    signature: FuncType,
    name: string
  ): ListEval | undefined {
    const operands = expression.args.map((arg) => this.expression(arg));
    if (!signature.variadic) {
      this.error(expression, `${name} は可変個の引数を取らない関数なので、... で渡せません。`);
      return undefined;
    }
    if (operands.length !== signature.params.length) {
      this.argumentCountError(expression, operands.length, signature, name);
      return undefined;
    }
    return this.spreadValues(operands, signature);
  }

  private spreadValues(operands: Operand[], signature: FuncType): ListEval {
    const values = operands.map((operand, index) => this.assign(operand, signature.params[index], '引数'));
    return (frame) => evaluateAll(frame, values);
  }

  private listArguments(
    span: Span,
    operands: Operand[],
    signature: FuncType,
    name: string,
    holderFor?: (index: number) => (value: Operand) => void
  ): ListEval | undefined {
    if (signature.variadic) return this.variadicArguments(span, operands, signature, name);
    if (operands.length !== signature.params.length) {
      this.argumentCountError(span, operands.length, signature, name);
      return undefined;
    }
    const values = operands.map((operand, index) =>
      this.assign(operand, signature.params[index], '引数', holderFor?.(index))
    );
    return (frame) => evaluateAll(frame, values);
  }

  /**
   * A tracked slice variable passed to a function of the program: an inlined call assigns it to the parameter, which
   * lets its array be shared, and otherwise the slice optimization pass understands passing it to a parameter that does
   * not escape, which reads its capacity.
   */
  protected sliceArgument(syntax: Expression, operand: Operand, target: StaticCallee, index: number): Operand {
    const tracking = this.sliceUseOf(syntax)?.tracking;
    if (!tracking) return operand;
    const inlined = (): boolean => inlinedCall(target);
    const transition = this.sliceTransition(syntax, operand, inlined);
    this.understandSlice(syntax, () => inlined() || (target.holds() && !target.summary.params?.[index]?.escapes));
    tracking.capReads.push(() => !inlined());
    return transition;
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
    const { parts, spread } = this.spreadResults(call);
    const args = this.listArguments(span, parts, signature, name);
    return args && spread(args);
  }

  /** The results of a call with several results as operands, which `spread` lets the arguments read. */
  // code-gauge-allow duplicateLines 15 -- The adjacent operations retain distinct Go evaluation and control-flow protocols; merging their adapters would couple those contracts.
  private spreadResults(call: Operand): { parts: Operand[]; spread: (args: ListEval) => ListEval } {
    const types = (call.type as { types: Type[] }).types;
    // The conversions of the results call no code of the program, so one holder serves every call.
    let results: Value[] = [];
    const parts = types.map((type, index): Operand => ({
      mode: 'value',
      type,
      span: call.span,
      callResult: true,
      eval: () => results[index],
    }));
    const read = call.eval;
    return {
      parts,
      spread: (args) => (frame) => {
        results = read(frame) as unknown as Value[];
        frame.temporaries.push(results);
        try {
          return args(frame);
        } finally {
          frame.temporaries.pop();
        }
      },
    };
  }

  protected resultOperand(
    span: Span,
    results: Type[],
    evaluate: (frame: Frame) => Value | Value[],
    /** Makes the call as `evaluate` does, yielding when its goroutine blocks. */
    resume?: (frame: Frame) => Suspending<Value | Value[]>
  ): Operand {
    // A call with several results evaluates to an array of them, which only assignments and arguments take apart.
    const call = resume ? this.suspending(resume, evaluate as Eval) : (evaluate as Eval);
    if (results.length === 0) return { mode: 'novalue', type: NO_VALUE, span, eval: call, isCall: true };
    if (results.length === 1) return { mode: 'value', type: results[0], span, eval: call, isCall: true };
    return { mode: 'value', type: { kind: 'tuple', types: results }, span, eval: call, isCall: true };
  }

  // code-gauge-allow functionCognitiveComplexity 23 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
  // code-gauge-allow functionNcss 36 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
  private functionCall(expression: Extract<Expression, { kind: 'call' }>, callee: Operand): Operand {
    if (this.isInvalid(callee)) return callee;
    if (callee.func?.generic) return this.genericCall(expression, callee.func, callee.typeArgs);
    const signature = coreType(callee.type);
    if (signature?.kind !== 'func') {
      this.error(expression, `${describeType(callee.type)} 型の値は関数ではないので、呼び出せません。`);
      for (const arg of expression.args) this.expression(arg);
      return this.invalid(expression);
    }
    const name = calleeName(expression.callee);
    const target = this.callSite(callee.static?.callee);
    this.chargeCall(target, callee.func ? libraryCallCost(callee.func.name) : INLINE_CALL_COST);
    const call = this.programCall(target, 0);
    const args = this.argumentsFor(expression, signature, name, call);
    if (!args) return this.invalid(expression);
    const row = expression.row;
    const buffers = inlinedStackBuffers(call);
    const direct = callee.func?.direct;
    const read = callee.eval;
    const result = this.resultOperand(
      expression,
      signature.results,
      direct
        ? (frame) => direct(args(frame), row, buffers(frame))
        : (frame) => {
            const fn = read(frame);
            const argValues = withTemporary(frame, fn, () => args(frame));
            if (!(fn instanceof GoFunc)) nilPointerPanic();
            return fn.call(argValues, row, undefined, buffers(frame));
          },
      function* (frame) {
        const fn = direct ? undefined : read(frame);
        const argValues = withTemporary(frame, fn, () => args(frame));
        if (direct)
          return callee.func?.directResume
            ? yield* callee.func.directResume(argValues, row, buffers(frame))
            : direct(argValues, row, buffers(frame));
        if (!(fn instanceof GoFunc)) nilPointerPanic();
        return fn.resume
          ? yield* fn.resume(argValues, row, undefined, buffers(frame))
          : fn.call(argValues, row, undefined, buffers(frame));
      }
    );
    return call
      ? { ...result, ...programCallResult(call, signature.results) }
      : { ...result, ...callee.func?.inlinedResult };
  }

  protected prepareGenericCall(
    expression: Extract<Expression, { kind: 'call' }>,
    entity: FuncEntity,
    written: Type[] = []
  ): { instance: GoFunc | undefined; args: ListEval; results: Type[] } | undefined {
    const generic = entity.generic as GenericFunc;
    let operands = expression.args.map((arg) => this.expression(arg));
    let expand: ((args: ListEval) => ListEval) | undefined;
    if (!expression.spread && operands.length === 1 && operands[0].type.kind === 'tuple') {
      ({ parts: operands, spread: expand } = this.spreadResults(operands[0]));
    }
    const mapping = this.inferTypeArguments(expression, generic, operands, written, expression.spread === true);
    if (!mapping) return undefined;
    const typeArgs = generic.typeParams.map((param) => mapping.get(param.id) as Type);
    if (!this.checkTypeArguments(generic.typeParams, typeArgs, expression)) return undefined;
    if (!this.recordGenericInstantiation(generic.typeParams, typeArgs)) return undefined;
    const signature = substitute(generic.type, mapping, (named, args) =>
      this.instantiateNamed(named, args)
    ) as FuncType;
    const listed = expression.spread
      ? this.spreadValues(operands, signature)
      : this.listArguments(expression, operands, signature, entity.name);
    if (!listed) return undefined;
    const args = expand ? expand(listed) : listed;
    if (typeArgs.some((arg) => containsTypeParam(arg))) {
      return { instance: undefined, args, results: signature.results };
    }
    return { instance: generic.instantiate(typeArgs), args, results: signature.results };
  }

  // code-gauge-allow duplicateLines 16 -- The adjacent operations retain distinct Go evaluation and control-flow protocols; merging their adapters would couple those contracts.
  private genericCall(
    expression: Extract<Expression, { kind: 'call' }>,
    entity: FuncEntity,
    written: Type[] = []
  ): Operand {
    const prepared = this.prepareGenericCall(expression, entity, written);
    if (!prepared) return this.invalid(expression);
    const { instance, args, results } = prepared;
    if (!instance) return this.resultOperand(expression, results, () => {});
    this.chargeCall(undefined, INLINE_CALL_COST);
    const row = expression.row;
    return this.resultOperand(
      expression,
      results,
      (frame) => instance.call(args(frame), row),
      function* (frame) {
        const argValues = args(frame);
        return instance.resume ? yield* instance.resume(argValues, row) : instance.call(argValues, row);
      }
    );
  }

  /** A call of `target` in the function being compiled, counting the calls of a function literal. */
  private callSite(target: StaticCallee | undefined): StaticCallee | undefined {
    if (!target?.summary.closure || !this.fn) return target;
    const sites = this.fn.closureCalls;
    sites.set(target.summary, (sites.get(target.summary) ?? 0) + 1);
    return { ...target, sites };
  }

  /** Adds a call to the inlining cost of the function being compiled: a function of the program's own, or `cost`. */
  private chargeCall(target: StaticCallee | undefined, cost: number): void {
    if (!this.fn) return;
    if (target) this.fn.callees.push(target);
    else this.fn.inlineCost += cost;
  }

  /** Infers the type arguments of a generic call from its arguments: typed ones first, then untyped defaults. */
  // code-gauge-allow functionNcss 50 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
  private inferTypeArguments(
    span: Span,
    generic: GenericFunc,
    operands: Operand[],
    written: Type[],
    spread: boolean
  ): Substitution | undefined {
    const { typeParams, type } = generic;
    if (written.length > typeParams.length) {
      this.error(span, `型引数は ${typeParams.length} 個ですが、${written.length} 個書かれています。`);
      return undefined;
    }
    if (spread && !type.variadic) {
      this.error(span, '可変個の引数を取らない関数には、... で引数を渡せません。');
      return undefined;
    }
    const mapping: Substitution = new Map(written.map((arg, index) => [typeParams[index].id, arg]));
    const params = type.params;
    if ((!type.variadic || spread) && operands.length !== params.length) {
      this.error(
        span,
        `関数の呼び出しの引数の数が合いません（${params.length} 個必要ですが、${operands.length} 個書かれています）。`
      );
      return undefined;
    }
    const paramFor = (index: number): Type =>
      type.variadic && !spread && index >= params.length - 1
        ? (params.at(-1) as { element: Type }).element
        : params[index];
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
    const untypedByParam = new Map<number, { param: TypeParamType; operands: Operand[] }>();
    for (const [param, operand] of untyped) {
      if (param.kind === 'typeParam' && !mapping.has(param.id) && typeParams.includes(param)) {
        if (isBasic(operand.type, 'untypedNil')) continue;
        const group = untypedByParam.get(param.id) ?? { param, operands: [] };
        group.operands.push(operand);
        untypedByParam.set(param.id, group);
      }
    }
    for (const { param, operands: group } of untypedByParam.values()) {
      let chosen = group[0].type;
      for (const operand of group.slice(1)) {
        if (!sameUntypedFamily(chosen, operand.type)) {
          this.error(
            operand.span,
            `${describeType(operand.type)} 型の値は、型引数 ${param.name} のほかの引数（${describeType(chosen)}）と型が合いません。`
          );
          return undefined;
        }
        chosen = largerUntyped(chosen, operand.type);
      }
      mapping.set(param.id, defaultType(chosen));
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

  // code-gauge-allow functionCognitiveComplexity 26 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
  // code-gauge-allow functionNcss 57 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
  private methodCall(expression: Extract<Expression, { kind: 'call' }>, callee: Operand): Operand {
    const { receiver, selection } = callee.method as NonNullable<Operand['method']>;
    if (selection.kind === 'method' && selection.method.typeParams) return this.genericMethodCall(expression, callee);
    const methodType = selection.method.type;
    const name = (expression.callee as { field?: string }).field ?? selection.method.name;
    const summary = selection.kind === 'method' ? selection.method.code?.summary : undefined;
    if (summary) this.fn?.references.add(selection.method);
    const target = summary && { summary, holds: always };
    this.chargeCall(target, INLINE_CALL_COST);
    const call = this.programCall(target, 1);
    const args = this.argumentsFor(expression, methodType, name, call);
    if (!args) return this.invalid(expression);
    const row = expression.row;
    if (selection.kind === 'interfaceMethod') {
      const readReceiver = this.embeddedReceiver(receiver, selection.path);
      const methodName = selection.method.name;
      return this.resultOperand(
        expression,
        methodType.results,
        (frame) => {
          const iface = readReceiver(frame) as { type: Type; value: Value } | undefined;
          const argValues = withTemporary(frame, iface, () => args(frame));
          if (!iface) nilPointerPanic();
          const call = dynamicMethod(iface.type, methodName);
          if (!call) throw new Error(`Missing method ${methodName}`);
          return call(iface.value, argValues, row);
        },
        function* (frame) {
          const iface = readReceiver(frame) as { type: Type; value: Value } | undefined;
          const argValues = withTemporary(frame, iface, () => args(frame));
          if (!iface) nilPointerPanic();
          return yield* resumeDynamicMethod(iface.type, methodName, iface.value, argValues, row);
        }
      );
    }
    const { method, path } = selection;
    let readReceiver: Eval;
    if (method.pointerReceiver) {
      const pointer = this.pointerReceiver(expression, receiver, path, selection.indirect);
      if (!pointer) return this.invalid(expression);
      readReceiver = pointer;
    } else {
      const read = receiver.eval;
      const viaPointer = underlying(receiver.type).kind === 'pointer';
      readReceiver = (frame) => receiverFor(read(frame), path, method, viaPointer);
    }
    const storage = this.receiverStorage(receiver, path, method.pointerReceiver);
    if (storage && call) this.linkToParameter(call, 0, storage);
    else if (storage) this.escapeOperand(storage);
    const buffers = inlinedStackBuffers(call);
    const result = this.resultOperand(
      expression,
      methodType.results,
      (frame) => {
        const value = readReceiver(frame);
        return invokeMethod(
          method,
          value,
          withTemporary(frame, value, () => args(frame)),
          row,
          undefined,
          buffers(frame)
        );
      },
      // The program's methods get their code after their bodies compile, which may come later.
      method.code?.resume || !method.code?.call
        ? function* (frame) {
            const value = readReceiver(frame);
            return yield* resumeMethod(method, value, args(frame), row, undefined, buffers(frame));
          }
        : undefined
    );
    return call ? { ...result, ...programCallResult(call, methodType.results) } : result;
  }

  protected methodValue(callee: Operand): Operand {
    const { receiver, selection } = callee.method as NonNullable<Operand['method']>;
    const span = callee.span;
    if (selection.kind === 'method' && selection.method.typeParams) {
      this.unsupported(span, '型引数を持つメソッドを、呼び出さずに値として使う書き方');
      return this.invalid(span);
    }
    const type = selection.method.type;
    if (selection.kind === 'interfaceMethod') {
      const readReceiver = this.embeddedReceiver(receiver, selection.path);
      const name = selection.method.name;
      return {
        mode: 'value',
        type,
        span,
        eval: (frame) => {
          const iface = readReceiver(frame) as Iface | undefined;
          if (!iface) nilPointerPanic();
          return new GoFunc(
            (args, row, deferredFor, stackBuffers) =>
              (dynamicMethod(iface.type, name) as BoundCall)(iface.value, args, row, deferredFor, stackBuffers),
            [iface],
            (args, row, deferredFor, stackBuffers) =>
              resumeDynamicMethod(iface.type, name, iface.value, args, row, deferredFor, stackBuffers)
          );
        },
      };
    }
    const { method, path } = selection;
    let readReceiver: Eval | undefined;
    if (method.pointerReceiver) readReceiver = this.pointerReceiver(span, receiver, path);
    else {
      const read = receiver.eval;
      readReceiver = (frame) => receiverFor(read(frame), path, method, underlying(receiver.type).kind === 'pointer');
    }
    if (!readReceiver) return this.invalid(span);
    const bound = readReceiver;
    return {
      mode: 'value',
      type,
      span,
      eval: (frame) => {
        const value = bound(frame);
        return new GoFunc(
          (args, row, deferredFor, stackBuffers) =>
            invokeMethod(
              method,
              method.pointerReceiver ? value : copyValue(value),
              args,
              row,
              deferredFor,
              stackBuffers
            ),
          [value],
          (args, row, deferredFor, stackBuffers) =>
            resumeMethod(
              method,
              method.pointerReceiver ? value : copyValue(value),
              args,
              row,
              deferredFor,
              stackBuffers
            )
        );
      },
    };
  }

  protected methodExpression(span: Span, type: Type, name: string): Operand {
    const selection = lookupFieldOrMethod(type, name);
    if (selection.kind !== 'method' && selection.kind !== 'interfaceMethod') {
      this.error(span, `${describeType(type)} 型には ${name} というメソッドがありません。`);
      return this.invalid(span);
    }
    if (
      selection.kind === 'method' &&
      selection.method.pointerReceiver &&
      !selection.indirect &&
      underlying(type).kind !== 'pointer'
    ) {
      this.error(
        span,
        `メソッド ${name} はポインタのレシーバを持つので、(*${describeType(type)}).${name} と書いてください。`
      );
      return this.invalid(span);
    }
    const methodType = selection.method.type;
    const signature: FuncType = {
      kind: 'func',
      params: [type, ...methodType.params],
      results: methodType.results,
      variadic: methodType.variadic,
    };
    const call =
      selection.kind === 'method'
        ? (args: Value[], row?: number, deferredFor?: unknown, stackBuffers?: StackBuffers): Value | Value[] =>
            invokeMethod(
              selection.method,
              receiverFor(args[0], selection.path, selection.method, underlying(type).kind === 'pointer'),
              args.slice(1),
              row,
              deferredFor,
              stackBuffers
            )
        : (args: Value[], row?: number, deferredFor?: unknown, stackBuffers?: StackBuffers): Value | Value[] => {
            const iface = args[0] as Iface | undefined;
            if (!iface) nilPointerPanic();
            return (dynamicMethod(iface.type, name) as BoundCall)(
              iface.value,
              args.slice(1),
              row,
              deferredFor,
              stackBuffers
            );
          };
    const resume =
      selection.kind === 'method'
        ? (args: Value[], row?: number, deferredFor?: unknown, stackBuffers?: StackBuffers) =>
            resumeMethod(
              selection.method,
              receiverFor(args[0], selection.path, selection.method, underlying(type).kind === 'pointer'),
              args.slice(1),
              row,
              deferredFor,
              stackBuffers
            )
        : (args: Value[], row?: number, deferredFor?: unknown, stackBuffers?: StackBuffers) => {
            const iface = args[0] as Iface | undefined;
            if (!iface) nilPointerPanic();
            return resumeDynamicMethod(iface.type, name, iface.value, args.slice(1), row, deferredFor, stackBuffers);
          };
    const value = new GoFunc(call, [], resume);
    return { mode: 'value', type: signature, span, eval: () => value };
  }

  /** A call of a method with its own type parameters, inferred from the arguments as a generic function's are. */
  // code-gauge-allow duplicateLines 16 -- The adjacent operations retain distinct Go evaluation and control-flow protocols; merging their adapters would couple those contracts.
  private genericMethodCall(expression: Extract<Expression, { kind: 'call' }>, callee: Operand): Operand {
    const prepared = this.prepareGenericMethodCall(expression, callee);
    if (!prepared) return this.invalid(expression);
    const { instance, receiver, args, results } = prepared;
    if (!instance) return this.resultOperand(expression, results, () => {});
    const evaluate = (frame: Frame): Value[] => {
      const value = receiver(frame);
      return [value, ...withTemporary(frame, value, () => args(frame))];
    };
    const row = expression.row;
    return this.resultOperand(
      expression,
      results,
      (frame) => instance.call(evaluate(frame), row),
      function* (frame) {
        const values = evaluate(frame);
        return instance.resume ? yield* instance.resume(values, row) : instance.call(values, row);
      }
    );
  }

  protected prepareGenericMethodCall(
    expression: Extract<Expression, { kind: 'call' }>,
    callee: Operand
  ): { instance: GoFunc | undefined; receiver: Eval; args: ListEval; results: Type[] } | undefined {
    const { receiver, selection } = callee.method as NonNullable<Operand['method']>;
    if (selection.kind !== 'method') return undefined;
    const { method, path } = selection;
    const prepared = this.prepareGenericCall(
      expression,
      {
        kind: 'func',
        name: method.name,
        type: method.type,
        value: () => new GoFunc(() => {}),
        generic: {
          typeParams: method.typeParams as TypeParamType[],
          type: method.type,
          instantiate: (types) => {
            const code = method.instantiate?.(types);
            return new GoFunc(
              ([value, ...args], row, deferredFor, stackBuffers) =>
                code?.call?.(value, args, row, deferredFor, stackBuffers) as Value | Value[],
              [],
              function* ([value, ...args], row, deferredFor, stackBuffers) {
                return (
                  code?.resume
                    ? yield* code.resume(value, args, row, deferredFor, stackBuffers)
                    : code?.call?.(value, args, row, deferredFor, stackBuffers)
                ) as Value | Value[];
              }
            );
          },
        },
      },
      callee.typeArgs
    );
    if (!prepared) return undefined;
    const read = receiver.eval;
    const bound = method.pointerReceiver
      ? this.pointerReceiver(expression, receiver, path, selection.indirect)
      : (frame: Frame) => receiverFor(read(frame), path, method, underlying(receiver.type).kind === 'pointer');
    return bound ? { ...prepared, receiver: bound } : undefined;
  }

  /**
   * The local storage a method's receiver refers to: the receiver's address for a pointer receiver, or none for a
   * pointer reached through embedded fields.
   */
  protected receiverStorage(receiver: Operand, path: readonly number[], pointerReceiver: boolean): Storage | undefined {
    if (underlying(receiver.type).kind === 'pointer') {
      return path.length === 0 ? receiver : undefined;
    }
    if (!pointerReceiver) return receiver;
    return receiver.addressStorage;
  }

  /** Evaluates the embedded field that holds an interface, for a method promoted from it. */
  protected embeddedReceiver(receiver: Operand, path: readonly number[]): Eval {
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
  protected pointerReceiver(
    span: Span,
    receiver: Operand,
    path: readonly number[],
    indirect = false
  ): Eval | undefined {
    const read = receiver.eval;
    if (path.length > 0) {
      // Reaching the embedded field goes through the receiver's struct, which must be addressable unless a pointer
      // leads there.
      const throughPointer = indirect || underlying(receiver.type).kind === 'pointer';
      if (!throughPointer && receiver.mode !== 'variable') {
        this.error(span, 'アドレスを取れない値なので、ポインタのレシーバを持つメソッドは呼び出せません。');
        return undefined;
      }
      receiver.variable?.markUsed();
      if (!throughPointer && receiver.addressOf) {
        receiver.addressTaken?.();
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
    receiver.addressTaken?.();
    return receiver.addressOf();
  }

  // Builtins --------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionNcss 57 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
  protected builtin(expression: Extract<Expression, { kind: 'call' }>, name: string): Operand {
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
        return this.newBuiltin(expression, args[0]);
      }
      case 'delete': {
        return count(2) ? this.deleteBuiltin(expression) : this.invalid(expression);
      }
      case 'panic': {
        this.builtinPanicCalls.add(expression);
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
        if (this.fn) this.fn.notInlinable = true;
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
        return this.printBuiltin(expression, name);
      }
      case 'close': {
        return count(1) ? this.closeBuiltin(expression) : this.invalid(expression);
      }
      case 'NewTurtle': {
        return this.newTurtleBuiltin(expression);
      }
    }
    throw new Error(`Unknown builtin ${name}`);
  }

  /** `print` and `println`, which write to standard error in the runtime's own format, apart from fmt's. */
  private printBuiltin(expression: Extract<Expression, { kind: 'call' }>, name: 'print' | 'println'): Operand {
    const operands = expression.args.map((arg) => this.defaulted(this.value(arg)));
    for (const operand of operands) {
      const kind = underlying(operand.type).kind;
      if (!this.isInvalid(operand) && (kind === 'struct' || kind === 'array')) {
        this.error(operand.span, `${describeType(operand.type)} 型の値は ${name} には渡せません。`);
        return this.invalid(expression);
      }
    }
    const values = operands.map((operand) => operand.eval);
    const types = operands.map((operand) => operand.type);
    const line = name === 'println';
    return {
      mode: 'novalue',
      type: NO_VALUE,
      span: expression,
      eval: (frame) => {
        const texts = evaluateAll(frame, values).map((value, index) => runtimePrint(value, types[index]));
        frame.runtime.writeStderr(line ? `${texts.join(' ')}\n` : texts.join(''));
        return;
      },
    };
  }

  private newBuiltin(expression: Extract<Expression, { kind: 'call' }>, arg: Expression): Operand {
    const operand = this.expression(arg);
    if (this.isInvalid(operand)) return operand;
    if (operand.mode === 'type') {
      const zero = this.zeroOf(operand.type);
      return {
        mode: 'value',
        type: { kind: 'pointer', element: operand.type },
        span: expression,
        createsObject: true,
        eval: (frame) => {
          frame.runtime.allocate(1);
          return new Pointer(new Cell(zero()), 'v');
        },
      };
    }
    const value = this.defaulted(this.asValue(operand));
    if (this.isInvalid(value)) return value;
    if (isUntyped(value.type)) {
      this.error(arg, 'new の引数に型の決まらない nil は使えません。');
      return this.invalid(expression);
    }
    this.escapeOperand(value);
    const read = value.eval;
    return {
      mode: 'value',
      type: { kind: 'pointer', element: value.type },
      span: expression,
      createsObject: true,
      eval: (frame) => {
        const evaluated = copyValue(read(frame));
        frame.runtime.allocate(1);
        return new Pointer(new Cell(evaluated), 'v');
      },
    };
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

  // code-gauge-allow functionNcss 32 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
  private lengthBuiltin(expression: Extract<Expression, { kind: 'call' }>, name: 'len' | 'cap'): Operand {
    const { result: operand, hasRuntimeCall } = this.withRuntimeCallTracking(() => this.value(expression.args[0]));
    if (this.isInvalid(operand)) return operand;
    const tracking = this.understandSlice(expression.args[0]);
    if (name === 'cap') tracking?.capReads.push(() => true);
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
      if (!hasRuntimeCall) {
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
    if (type.kind === 'chan') {
      return {
        mode: 'value',
        type: BASIC.int,
        span: expression,
        eval: (frame) => {
          const channel = read(frame) as Channel | undefined;
          return BigInt(
            channel ? (name === 'len' ? (channel.timer ? 0 : channel.buffer.length) : channel.capacity) : 0
          );
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

  // code-gauge-allow functionNcss 31 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
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
    if (expression.spread) return this.appendSpread(expression, slice, sliceType);
    const values = rest.map((arg) => this.assign(this.expression(arg), element, '要素'));
    this.writeOperand(slice);
    const read = slice.eval;
    const zero = this.zeroOf(element);
    // The array that appending to a slice no variable holds allocates escapes where the append's result goes.
    const nonEscaping: Temporary | undefined =
      slice.nonEscaping ?? (slice.backingVars ? undefined : { escapes: false, written: false });
    const stackBuffer = this.appendStackBuffer(first, { ...slice, nonEscaping }, this.inPlaceAppends.get(expression));
    return {
      mode: 'value',
      type: slice.type,
      span: expression,
      backingVars: slice.backingVars,
      nonEscaping,
      eval: (frame) => {
        const target = read(frame) as Slice | undefined;
        const added = evaluateAll(frame, values);
        const stack = stackBuffer(frame);
        const result = appendValues(target, added, element, zero, (count) => frame.runtime.allocate(count), stack);
        if (stack === 'static' && result?.array !== target?.array && inStackBuffer(result)) {
          frame.useStackBuffer(stackBuffer);
        }
        return result;
      },
    };
  }

  /** `append(s, t...)`: the elements of a slice of the same type, or the bytes of a string for a []byte. */
  private appendSpread(
    expression: Extract<Expression, { kind: 'call' }>,
    slice: Operand,
    sliceType: Extract<Type, { kind: 'slice' }>
  ): Operand {
    const { element } = sliceType;
    if (expression.args.length !== 2) {
      for (const arg of expression.args.slice(1)) this.expression(arg);
      this.error(expression, '... で渡すときの append の引数は、スライスと、... を付けた値の2つにしてください。');
      return this.invalid(expression);
    }
    const added = this.value(expression.args[1]);
    if (this.isInvalid(added)) return added;
    const fromString = isString(added.type) && isBasic(element, 'uint8');
    const source = fromString ? this.defaulted(added).eval : this.assign(added, { kind: 'slice', element }, '引数');
    const read = slice.eval;
    const zero = this.zeroOf(element);
    const local = slice.variable?.entity;
    const onStack = (): boolean => local?.owner !== undefined && !local.escapes;
    return {
      mode: 'value',
      type: slice.type,
      span: expression,
      eval: (frame) => {
        const target = read(frame) as Slice | undefined;
        const value = source(frame);
        const values =
          typeof value === 'string'
            ? Array.from(value, (byte) => BigInt(byte.charCodeAt(0)))
            : ((value as Slice | undefined)?.values() ?? []);
        return appendValues(
          target,
          values,
          element,
          zero,
          (count) => frame.runtime.allocate(count),
          onStack() ? 'static' : undefined
        );
      },
    };
  }

  /**
   * `x = append(x, ...)` statements by their append, with whether Go's compiler updates x in memory, which it does when x
   * is not a local variable, or a part of one, that it can keep in registers; such an append never uses the buffer.
   */
  protected readonly inPlaceAppends = new WeakMap<Expression, () => boolean>();

  /**
   * How an append may use the stack buffer, as Go's compiler decides it: the slice optimization pass decides for a
   * variable it optimizes, and otherwise an empty slice whose array stays in the function gets the whole buffer once
   * per call, at the variable's first append or at an append to a slice no variable holds.
   */
  // code-gauge-allow functionCognitiveComplexity 23 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
  private appendStackBuffer(
    syntax: Expression,
    slice: Operand,
    inPlace: (() => boolean) | undefined
  ): (frame: Frame) => StackBuffer | undefined {
    const tracking = this.sliceUseOf(syntax)?.tracking;
    const site = {};
    if (tracking) tracking.firstAppend ??= site;
    const { backingVars: backing, nonEscaping } = slice;
    const local = (frame: Frame): boolean =>
      backing !== undefined && backing.length > 0
        ? backing.every((variable) => variable.owner !== undefined && staysLocal(variable, frame))
        : nonEscaping !== undefined && staysLocal(nonEscaping, frame);
    const plan = (frame: Frame): StackBuffer | undefined => {
      if (inPlace?.()) return undefined;
      if (tracking) {
        const mode = sliceMode(tracking);
        if (mode === 'buffer') return 'buffer';
        if (tracking.firstAppend !== site || (mode !== 'move' && !local(frame))) return undefined;
        return 'static';
      }
      return local(frame) ? 'static' : undefined;
    };
    const stackBuffer = (frame: Frame): StackBuffer | undefined => {
      const stack = plan(frame);
      return stack === 'static' && frame.usedStackBuffer(stackBuffer) ? undefined : stack;
    };
    return stackBuffer;
  }

  // code-gauge-allow functionNcss 55 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
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
      const elemSlots = this.zeroSlotCount(under.element);
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
          const roomNum = Number(room);
          if (roomNum > LIMITS.maxSlots || (elemSlots > 0 && roomNum * elemSlots > LIMITS.maxSlots)) {
            frame.runtime.allocate(LIMITS.maxSlots + 1);
          }
          frame.runtime.allocate(roomNum);
          const array = Array.from({ length: roomNum }, zero);
          return new Slice(array, 0, Number(size), roomNum);
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
          if (length) length(frame);
          return new GoMap(keyOf);
        },
      };
    }
    if (under?.kind === 'chan') {
      if (expression.args.length > 2) {
        this.error(expression, 'チャネルを make で作るときの引数は、型とバッファの大きさの2つまでです。');
        return this.invalid(expression);
      }
      const zero = this.zeroOf(under.element);
      return {
        mode: 'value',
        type,
        span: expression,
        createsObject: true,
        eval: (frame) => {
          const size = length ? (length(frame) as bigint) : 0n;
          if (size < 0n || size > 1n << 31n) plainPanic('makechan: size out of range');
          frame.runtime.allocate(Number(size));
          return makeChannel(Number(size), zero);
        },
      };
    }
    this.error(
      expression,
      `make で作れるのはスライスと map とチャネルだけです（${describeType(type)} 型が書かれています）。`
    );
    return this.invalid(expression);
  }

  protected abstract mapKeyFunction(type: Type): (key: Value) => unknown;

  private closeBuiltin(expression: Extract<Expression, { kind: 'call' }>): Operand {
    const operand = this.value(expression.args[0]);
    if (this.isInvalid(operand)) return operand;
    const type = coreType(operand.type);
    if (type?.kind !== 'chan') {
      this.error(
        expression,
        `close に渡せるのはチャネルだけです（${describeType(operand.type)} 型の値が書かれています）。`
      );
      return this.invalid(expression);
    }
    if (type.dir === 'receive') {
      this.error(expression, '受信専用のチャネルは close できません。');
      return this.invalid(expression);
    }
    const read = operand.eval;
    return {
      mode: 'novalue',
      type: NO_VALUE,
      span: expression,
      eval: (frame) => {
        closeChannel(read(frame) as Channel | undefined);
        return;
      },
    };
  }

  private constantSize(expression: Expression | undefined): bigint | undefined {
    if (!expression) return undefined;
    return this.constantExpression(expression).value;
  }

  private sizeArgument(expression: Expression): Eval | undefined {
    let operand = this.value(expression);
    if (this.isInvalid(operand)) return undefined;
    if (operand.resolveUntyped) {
      operand = operand.resolveUntyped(BASIC.int);
      if (this.isInvalid(operand)) return undefined;
    }
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
      if ('error' in represent(operand.constant, BASIC.int)) {
        this.error(expression, `定数 ${describeConstant(operand.constant)} は int 型に収まりません。`);
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
        if (!target || target.entries.size === 0) checkKeyHashable(under.key, keyValue);
        else target.entries.delete(target.keyOf(keyValue));
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
    this.writeOperand(destination);
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
          : ((value as Slice | undefined)?.values().map(copyValue) ?? []);
        const count = Math.min(to?.length ?? 0, items.length);
        for (let index = 0; index < count; index++) (to as Slice).set(index, items[index]);
        frame.runtime.spend(Math.floor(count / 16));
        return BigInt(count);
      },
    };
  }

  // code-gauge-allow functionNcss 49 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
  private minMaxBuiltin(expression: Extract<Expression, { kind: 'call' }>, name: 'min' | 'max'): Operand {
    let operands = expression.args.map((arg) => this.value(arg));
    if (operands.some((operand) => this.isInvalid(operand))) return this.invalid(expression);
    const typed = operands.find((operand) => !isUntyped(operand.type));
    if (typed) {
      operands = operands.map((operand) => {
        if (!isUntyped(operand.type)) return operand;
        const converted = this.assign(operand, typed.type, '引数');
        if (operand.mode === 'constant' && operand.constant) {
          const rep = represent(operand.constant, typed.type);
          if ('constant' in rep) return this.constant(rep.constant, typed.type, operand.span);
        }
        return { ...operand, type: typed.type, mode: 'value', eval: converted };
      });
      if (operands.some((operand) => !identical(operand.type, typed.type))) {
        this.error(expression, `${name} の引数の型が揃っていません。`);
        return this.invalid(expression);
      }
    }
    let type = typed?.type ?? operands[0].type;
    if (!typed) {
      for (const operand of operands.slice(1)) {
        if (!sameUntypedFamily(type, operand.type)) {
          this.error(expression, `${name} の引数の型が揃っていません。`);
          return this.invalid(expression);
        }
        if (rankOf(operand.type) > rankOf(type)) type = operand.type;
      }
      if (operands.some((operand) => operand.resolveUntyped)) {
        const concrete = defaultType(type);
        operands = operands.map((operand) =>
          operand.resolveUntyped ? operand.resolveUntyped(concrete) : this.defaulted({ ...operand, type })
        );
        if (operands.some((operand) => this.isInvalid(operand))) return this.invalid(expression);
        type = concrete;
      }
    }
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

  // code-gauge-allow functionNcss 35 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
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
    if (isUntyped(re.type) && !isUntyped(im.type)) {
      const converted = this.assign(re, im.type, '引数');
      const rep =
        re.mode === 'constant' && re.constant && isFloat(im.type) ? represent(re.constant, im.type) : undefined;
      re =
        rep && 'constant' in rep
          ? this.constant(rep.constant, im.type, re.span)
          : { ...re, mode: 'value', type: im.type, eval: converted };
    }
    if (isUntyped(im.type) && !isUntyped(re.type)) {
      const converted = this.assign(im, re.type, '引数');
      const rep =
        im.mode === 'constant' && im.constant && isFloat(re.type) ? represent(im.constant, re.type) : undefined;
      im =
        rep && 'constant' in rep
          ? this.constant(rep.constant, re.type, im.span)
          : { ...im, mode: 'value', type: re.type, eval: converted };
    }
    if (isUntyped(re.type))
      re = re.resolveUntyped ? re.resolveUntyped(BASIC.float64) : this.defaulted({ ...re, type: BASIC.untypedFloat });
    if (isUntyped(im.type))
      im = im.resolveUntyped ? im.resolveUntyped(BASIC.float64) : this.defaulted({ ...im, type: BASIC.untypedFloat });
    if (this.isInvalid(re) || this.isInvalid(im)) return this.invalid(expression);
    if (!isFloat(re.type) || !identical(re.type, im.type)) {
      this.error(expression, 'complex の2つの引数は、同じ浮動小数点数の型にしてください。');
      return this.invalid(expression);
    }
    const type = isBasic(re.type, 'float32') ? BASIC.complex64 : BASIC.complex128;
    if (re.mode === 'constant' && im.mode === 'constant' && re.constant && im.constant) {
      return this.constant(
        { kind: 'complex', re: toRational(re.constant), im: toRational(im.constant) },
        type,
        expression
      );
    }
    const readRe = re.eval;
    const readIm = im.eval;
    return {
      mode: 'value',
      type,
      span: expression,
      eval: (frame) => new Complex(readRe(frame) as number, readIm(frame) as number),
      ssaConstant: allConstant(re, im),
      partNegations: [re.negation, im.negation],
    };
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Keeps argument conversion, source evaluation order and call metadata together for this Go operation.
  private complexPartBuiltin(expression: Extract<Expression, { kind: 'call' }>, name: 'real' | 'imag'): Operand {
    let operand = this.value(expression.args[0]);
    if (this.isInvalid(operand)) return operand;
    if (operand.resolveUntyped) {
      operand = operand.resolveUntyped(BASIC.complex128);
      if (this.isInvalid(operand)) return operand;
    }
    if (operand.mode === 'constant' && operand.constant && isUntyped(operand.type)) {
      const constant = operand.constant;
      if (constant.kind === 'string' || constant.kind === 'bool') {
        this.error(expression, `${name} には複素数を書いてください。`);
        return this.invalid(expression);
      }
      const part = extractComplexPart(constant, name);
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
    if (operand.mode === 'constant' && operand.constant) {
      return this.constant({ kind: 'float', value: extractComplexPart(operand.constant, name) }, type, expression);
    }
    const read = operand.eval;
    return {
      mode: 'value',
      type,
      span: expression,
      eval: (frame) => (read(frame) as Complex)[name === 'real' ? 're' : 'im'],
      ssaConstant: operand.ssaConstant,
      negation: operand.partNegations?.[name === 'real' ? 0 : 1],
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

/**
 * A call of a function of the program that Go's compiler resolves: `receivers` leading parameters come before the
 * arguments, and `result` stands for the call's result in the caller, which what the callee returns shares.
 */
interface ProgramCall {
  target: StaticCallee;
  receivers: number;
  result: VarEntity;
  /** Whether each argument is a constant to Go's compiler, by parameter index. */
  constantArgs: SsaConstant[];
  /** What Go's compiler knows of the fields of each struct argument, by parameter index. */
  argFields: (SsaFields | undefined)[];
  /** Whether each variable the callee captures is a constant to Go's compiler where the call is. */
  /** Keyed by the variable, or by `capturedFieldKey` for a field of a struct variable. */
  constantCaptures: Map<object, SsaConstant>;
}

/** The function whose compilation settles every callee resolved in `fn`, as no code outside it assigns its locals. */
function outermost(fn: FunctionContext): FunctionContext {
  let root = fn;
  while (root.parent) root = root.parent;
  return root;
}

/**
 * What the result of a call of a function of the program shares, and what Go's compiler resolves it to once it
 * inlines the call: the value of the callee's one `return` statement, with the parameters bound to the arguments.
 */
function programCallResult(
  call: ProgramCall,
  results: Type[]
): Pick<Operand, 'backingVars' | 'ssaConstant' | 'ssaFields' | 'static'> {
  const backingVars = [call.result];
  if (results.length !== 1) return { backingVars };
  const partAt =
    (path: number[]): SsaConstant =>
    (params) => {
      const returned = inlinedCall(call.target) ? call.target.summary.context?.returnedValues : undefined;
      if (returned?.length !== 1 || !returned[0]) return false;
      const { constant, fields } = returned[0];
      const facts = ssaFactsAt({ ssaConstant: constant, ssaFields: fields }, path);
      return facts?.ssaConstant?.(boundParams(call, params)) ?? false;
    };
  const resultFields = (type: Type, path: number[]): SsaFields | undefined => {
    const under = underlying(type);
    if (under.kind !== 'struct') return undefined;
    return under.fields.map((field, index) => ({
      ssaConstant: partAt([...path, index]),
      ssaFields: resultFields(field.type, [...path, index]),
    }));
  };
  const constant = partAt([]);
  const ssaFields = resultFields(results[0], []);
  return { backingVars, ssaConstant: constant, ssaFields, static: { constant, fields: ssaFields } };
}

/** What a call that Go's compiler inlines knows of its parameters, from the arguments in a frame of the caller. */
function boundParams(call: ProgramCall, caller: ConstantParams | undefined): ConstantParams {
  return {
    constantParam: (index) => call.constantArgs[index]?.(caller) ?? false,
    constantCapture: (key) => argFieldConstants(call).get(key)?.(caller) ?? false,
  };
}

/** The fields of struct arguments that may be constants, keyed by `capturedFieldKey` of the parameter's fields. */
function argFieldConstants(call: ProgramCall): Map<object, SsaConstant> {
  const constants = new Map<object, SsaConstant>();
  const params = call.target.summary.context?.params ?? [];
  for (const [index, fields] of call.argFields.entries())
    if (params[index]) addFieldConstants(constants, params[index], fields);
  return constants;
}

/** The stack buffers a call shares with the caller when Go's compiler inlines it, one set per call site. */
function inlinedStackBuffers(call: ProgramCall | undefined): (frame: Frame) => StackBuffers | undefined {
  const site = {};
  return (frame) =>
    call && inlinedCall(call.target)
      ? frame.inlinedStackBuffers(site, staysLocal(call.result, frame), (caller) => ({
          params: Array.from(call.constantArgs, (constant) => constant?.(caller) ?? false),
          captures: new Set(
            [...call.constantCaptures, ...argFieldConstants(call)].flatMap(([key, constant]) =>
              constant(caller) ? [key] : []
            )
          ),
        }))
      : undefined;
}

/** What Go's inliner charges for calling a library function: the fmt printers inline at a cost of 72 or 73. */
function libraryCallCost(name: string): number {
  return /^[FS]?Print/.test(name) ? 72 : INLINE_CALL_COST;
}

function calleeName(expression: Expression): string {
  if (expression.kind === 'name') return expression.name;
  if (expression.kind === 'selector') return expression.field;
  return '関数';
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

function extractComplexPart(constant: Constant, name: 'real' | 'imag'): Rational {
  if (constant.kind === 'complex') return name === 'real' ? constant.re : constant.im;
  if (name === 'imag') return { num: 0n, den: 1n };
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
