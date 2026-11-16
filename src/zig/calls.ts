import { PANIC, panic } from './arith';
import type { Expression, ExpressionOf, FunctionDeclaration, Span } from './ast';
import { BuiltinCompiler } from './builtins';
import { FunctionInstance } from './functions';
import { Frame, Jump } from './runtime';
import {
  copyForStorage,
  evaluateHeld,
  FnRef,
  isType,
  known,
  type LocalBinding,
  NATIVE_FN_TYPE,
  NativeFn,
  runtime,
  type Scope,
  type TExpr,
} from './semaBase';
import {
  type Decl,
  type ErrorSetType,
  errorUnionOf,
  type FnType,
  isComptimeOnly,
  type Namespace,
  pointerTo,
  type Type,
  typeName,
  VOID,
} from './types';
import { type FnValue, Pointer, type Value } from './values';

/** What a function body's compilation needs to know about the function. */
export interface FunctionCompilation {
  instance: FunctionInstance;
  syntax: FunctionDeclaration;
  namespace: Namespace;
  paramTypes: readonly Type[];
  returnType: Type;
  inferredErrors?: ErrorSetType;
  /** The types of `anytype` parameters, which an instance fixes. */
  isMethod: boolean;
}

export abstract class CallCompiler extends BuiltinCompiler {
  private readonly instances = new Map<string, FunctionInstance>();
  private readonly instanceIds = new WeakMap<object, number>();
  private nextInstanceId = 1;

  protected abstract compileFunctionBody(compilation: FunctionCompilation): void;
  /** Whether the program records steps, so that compiled functions check for atomic annotations. */
  protected abstract atomicRow(fn: FunctionDeclaration): boolean;

  // Calls -------------------------------------------------------------------------------------------------------------

  protected compileCall(expression: ExpressionOf<'call'>, resultType: Type | undefined): TExpr {
    const { callee } = expression;
    if (callee.kind === 'field') {
      const object = this.compile(callee.object);
      if (object.type.kind === 'type') {
        const member = this.typeMember(this.knownValue(object, '型') as Type, callee.name, callee);
        return this.callValue(member, undefined, expression, resultType);
      }
      const method = this.methodOf(object, callee.name, callee);
      if (method) return this.callValue(method.callee, object, expression, resultType);
      const field = this.fieldAccess(callee);
      return this.callValue(field, undefined, expression, resultType);
    }
    const target = this.compile(callee);
    return this.callValue(target, undefined, expression, resultType);
  }

  /** The declaration a value's type has for a method call `value.name(...)`, if it has one. */
  private methodOf(object: TExpr, name: string, span: Span): { callee: TExpr } | undefined {
    let type = object.type;
    if (type.kind === 'pointer' && type.size === 'one') type = type.child;
    if (type.kind !== 'struct' && type.kind !== 'enum' && type.kind !== 'union') return undefined;
    if (type.kind === 'struct' && this.structFields(type, span).some((field) => field.name === name)) return undefined;
    const decl = this.findDecl(type, name);
    if (!decl) {
      if (type.kind === 'union' && this.unionFields(type).some((field) => field.name === name)) return undefined;
      return this.error(span, `${typeName(type)} 型には、メソッド「${name}」がありません。`);
    }
    return { callee: this.resolveDecl(decl, span) };
  }

  private callValue(
    callee: TExpr,
    receiver: TExpr | undefined,
    expression: ExpressionOf<'call'>,
    resultType: Type | undefined
  ): TExpr {
    const value = callee.value as unknown;
    if (callee.known && value instanceof NativeFn) {
      return value.compileCall(this, {
        span: expression,
        args: expression.args,
        receiver,
        resultType,
      });
    }
    if (callee.known && value instanceof FnRef) {
      return this.callDeclaration(value, receiver, expression, resultType);
    }
    const type = callee.type;
    const fnType =
      type.kind === 'fn' ? type : type.kind === 'pointer' && type.child.kind === 'fn' ? type.child : undefined;
    if (!fnType) return this.error(expression, `${typeName(type)} 型の値は、呼び出せません。`);
    return this.callPointer(callee, fnType, expression);
  }

  private callPointer(callee: TExpr, fnType: FnType, expression: ExpressionOf<'call'>): TExpr {
    if (expression.args.length !== fnType.params.length) {
      this.error(
        expression,
        `引数の数が合いません（${fnType.params.length} 個が必要ですが、${expression.args.length} 個です）。`
      );
    }
    const args = expression.args.map((arg, index) =>
      this.coerce(this.compile(arg, fnType.params[index]), fnType.params[index], arg)
    );
    const evaluateCallee = callee.eval;
    const evaluators = args.map((arg) => arg.eval);
    const row = expression.row;
    return runtime(
      fnType.returnType,
      (frame) => {
        const fn = (evaluateCallee(frame) as FnValue).fn;
        return this.invoke(fn, evaluateHeld(frame, evaluators), row, frame);
      },
      expression
    );
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- Keeps one operation of the interpreter in one place.
  private callDeclaration(
    ref: FnRef,
    receiver: TExpr | undefined,
    expression: ExpressionOf<'call'>,
    resultType: Type | undefined
  ): TExpr {
    const syntax = ref.decl.syntax;
    const params = syntax.params;
    const argExpressions: (Expression | TExpr)[] = receiver ? [receiver, ...expression.args] : [...expression.args];
    if (argExpressions.length !== params.length) {
      const offset = receiver ? 1 : 0;
      this.error(
        expression,
        `引数の数が合いません（${params.length - offset} 個が必要ですが、${argExpressions.length - offset} 個です）。`
      );
    }
    // A parameter's type may refer to earlier parameters, as `b: @TypeOf(a)` does.
    const declaredTypes: (Type | undefined)[] = [];
    const args: TExpr[] = [];
    for (const [index, arg] of argExpressions.entries()) {
      const declared = this.parameterType(
        ref.decl,
        index,
        args.map((each) => each.type)
      );
      declaredTypes.push(declared);
      const compiled = isTExpr(arg) ? arg : this.compile(arg, declared);
      if (index === 0 && receiver) args.push(this.bindReceiver(compiled, declared, expression));
      else if (declared) args.push(this.coerce(compiled, declared, isTExpr(arg) ? arg.span : arg));
      else args.push(compiled);
    }
    const argTypes = args.map((arg) => arg.type);
    const instance = this.instantiate(ref, argTypes, expression);
    void resultType;
    for (const [index, arg] of args.entries()) {
      if (declaredTypes[index] === undefined && isComptimeOnly(arg.type)) {
        this.error(
          params[index],
          'anytype の引数に、コンパイルのときだけの値（型や comptime_int など）を渡すことは、この採点環境では使えません。'
        );
      }
    }
    const evaluators = args.map((arg) => arg.eval);
    const row = expression.row;
    return runtime(
      instance.returnType,
      (frame) => this.invoke(instance, evaluateHeld(frame, evaluators), row, frame),
      expression
    );
  }

  /** Passes a method's receiver, taking its address or dereferencing it to match the first parameter. */
  private bindReceiver(receiver: TExpr, declared: Type | undefined, span: Span): TExpr {
    if (!declared) return receiver;
    const type = receiver.type;
    if (declared.kind === 'pointer' && declared.size === 'one' && type === declared.child) {
      const address = this.addressOf(receiver);
      if (address.type.kind === 'pointer' && address.type.isConst && !declared.isConst) {
        this.error(
          span,
          `定数の値に対して、ポインタを受け取るメソッドは呼び出せません（${typeName(declared)} 型が必要です）。`
        );
      }
      return this.coerce(address, declared, span);
    }
    if (type.kind === 'pointer' && type.size === 'one' && type.child === declared) {
      return this.dereferenced(receiver, span);
    }
    return this.coerce(receiver, declared, span);
  }

  /** The declared parameter types of a function, with undefined for `anytype` parameters. */
  /** The declared type of a parameter (undefined for `anytype`), seeing the earlier parameters' types. */
  private parameterType(
    decl: Extract<Decl, { kind: 'fn' }>,
    index: number,
    previous: readonly Type[]
  ): Type | undefined {
    const param = decl.syntax.params[index];
    if (!param?.type) return undefined;
    const typeExpression = param.type;
    return this.inParameterScope(decl, previous, () => this.compileType(typeExpression));
  }

  /** Runs code in a function's declaration scope with its first parameters bound, for types that refer to them. */
  private inParameterScope<T>(decl: Extract<Decl, { kind: 'fn' }>, types: readonly Type[], run: () => T): T {
    const locals = new Map<string, LocalBinding>();
    for (const [index, type] of types.entries()) {
      const param = decl.syntax.params[index];
      if (param && param.name !== '_') {
        locals.set(param.name, { kind: 'local', name: param.name, slot: -1, type, isConst: true, known: false });
      }
    }
    const namespace = decl.namespace;
    const scope: Scope = { locals, parent: { namespace, parent: namespace.scope as Scope | undefined } };
    return this.withScope(scope, run);
  }

  /** The instance of a function for argument types, compiling its body the first time. */
  instantiate(ref: FnRef, argTypes: readonly Type[], span: Span): FunctionInstance {
    const { decl } = ref;
    const syntax = decl.syntax;
    const paramTypes: Type[] = [];
    for (const [index, param] of syntax.params.entries()) {
      const type = param.type ? this.parameterType(decl, index, paramTypes) : argTypes[index];
      if (!type)
        this.error(span, `関数「${syntax.name}」は anytype の引数を持つので、呼び出さずに値としては使えません。`);
      paramTypes.push(type);
    }
    const key = `${this.idOf(decl)}(${paramTypes.map((type) => this.idOf(type as object)).join(',')})`;
    const existing = this.instances.get(key);
    if (existing) return existing;
    const { returnType, inferredErrors } = this.inParameterScope(decl, paramTypes, () => {
      const payload = this.compileType(syntax.returnType);
      if (!syntax.inferredErrorSet) return { returnType: payload, inferredErrors: undefined };
      const errors: ErrorSetType = {
        kind: 'error_set',
        names: new Set(),
        inferredFrom: syntax.name,
      };
      return { returnType: errorUnionOf(errors, payload), inferredErrors: errors };
    });
    const instance = new FunctionInstance(syntax.name, paramTypes, returnType);
    instance.isAtomic = this.atomicRow(syntax);
    this.instances.set(key, instance);
    const isMethod = decl.namespace !== this.root;
    const compile = (): void =>
      this.compileFunctionBody({
        instance,
        syntax,
        namespace: decl.namespace,
        paramTypes,
        returnType,
        inferredErrors,
        isMethod,
      });
    // A function that a struct's field defaults refer to compiles after the struct, as Zig analyzes it separately.
    if (this.resolvingFields > 0) this.pendingBodies.push(compile);
    else compile();
    return instance;
  }

  private readonly pendingBodies: (() => void)[] = [];

  /** Compiles the bodies that waited for structs' fields. */
  protected compilePendingBodies(): void {
    while (this.pendingBodies.length > 0) (this.pendingBodies.shift() as () => void)();
  }

  private idOf(object: object): number {
    let id = this.instanceIds.get(object);
    if (id === undefined) {
      id = this.nextInstanceId++;
      this.instanceIds.set(object, id);
    }
    return id;
  }

  /** The function a value calls, for library functions that take a function, such as `std.mem.sort`'s comparator. */
  functionOf(
    value: TExpr,
    span: Span
  ): { call: (frame: Frame, args: Value[]) => Value; params: readonly Type[]; returnType: Type } {
    const ref = value.value as unknown;
    if (value.known && ref instanceof FnRef) {
      const instance = this.instantiate(ref, [], span);
      return {
        call: (frame, args) => this.invoke(instance, args, span.row, frame),
        params: instance.params,
        returnType: instance.returnType,
      };
    }
    const type = value.type;
    const fnType =
      type.kind === 'fn' ? type : type.kind === 'pointer' && type.child.kind === 'fn' ? type.child : undefined;
    if (!fnType) return this.error(span, `関数が必要ですが、${typeName(type)} 型の値です。`);
    const evaluate = value.eval;
    return {
      call: (frame, args) => this.invoke((evaluate(frame) as FnValue).fn, args, span.row, frame),
      params: fnType.params,
      returnType: fnType.returnType,
    };
  }

  callFunction(fn: FunctionInstance, args: Value[], frame: Frame): Value {
    return this.invoke(fn, args, undefined, frame);
  }

  /** Runs a function in a new frame, as the call at `callRow` of the caller's frame. */
  protected invoke(fn: FunctionInstance, args: Value[], callRow: number | undefined, caller: Frame): Value {
    const { runtime: rt } = caller;
    rt.spend();
    if (fn.native) return fn.native(args, caller);
    if (!fn.body) return panic('関数がまだ準備できていません。');
    const frame = new Frame(rt, fn, callRow, fn.slotCount);
    for (const [index, slot] of fn.paramSlots.entries()) frame.slots[slot] = copyForStorage(args[index]);
    rt.pushFrame(frame);
    let result: Value;
    try {
      result = fn.body(frame);
    } finally {
      rt.popFrame();
    }
    if (fn.isAtomic) rt.steps.completeAtomicCall();
    if (fn.returnType.kind === 'noreturn') panic(PANIC.noreturnReturned);
    return result;
  }

  protected receiverLocal(binding: LocalBinding): boolean {
    return binding.name === 'self';
  }

  protected jumpOut(kind: Jump['kind'], target: object, value: Value): never {
    throw new Jump(kind, target, value);
  }

  protected fnPointerType(type: FnType): Type {
    return pointerTo(type, true);
  }

  protected isTypeValue2(value: Value): boolean {
    return isType(value);
  }

  protected voidValue(): TExpr {
    return known(VOID, undefined, { row: 0, col: 0, endRow: 0 });
  }

  protected nativeFnType(): Type {
    return NATIVE_FN_TYPE;
  }

  protected pointerValue(value: Value): value is Pointer {
    return value instanceof Pointer;
  }
}

function isTExpr(value: Expression | TExpr): value is TExpr {
  return 'eval' in value;
}
