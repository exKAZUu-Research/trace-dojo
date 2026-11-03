import type { Expression, Span, TypeSyntax } from './ast';
import { getBuiltins } from './builtins';
import { CompileError } from './diagnostics';
import { type Frame } from './runtime';
import {
  BOOLEAN,
  CHAR,
  type ClassInfo,
  DOUBLE,
  type FieldInfo,
  INT,
  isPrimitive,
  isSubclass,
  isWidening,
  type JavaType,
  type LocalInfo,
  type MethodInfo,
  sameType,
  typeName,
  VOID,
} from './types';
import { type JavaString, type Value } from './values';

export interface CompileOptions {
  /** Statement IDs of the rows annotated with `// step`. */
  stepIdByRow?: ReadonlyMap<number, number>;
}

export type Eval = (frame: Frame) => Value;

/** A statement either completes normally (`undefined`) or abruptly with one of these. */
export type Completion = BreakCompletion | ContinueCompletion | ReturnCompletion;
export interface BreakCompletion {
  kind: 'break';
  label: string | undefined;
}
export interface ContinueCompletion {
  kind: 'continue';
  label: string | undefined;
}
export interface ReturnCompletion {
  kind: 'return';
  value: Value;
}
export type Exec = (frame: Frame) => Completion | undefined;

export interface CompiledValue {
  kind: 'value';
  type: JavaType;
  run: Eval;
  constant?: Value;
}
export type Compiled = CompiledValue | { kind: 'class'; cls: ClassInfo };

export interface Reference {
  type: JavaType;
  /** The field this reference names, whose finality decides whether it may be assigned. */
  field?: FieldInfo;
  isArrayLength?: boolean;
  /** Evaluates the receiver and index once, returning accessors bound to them. */
  bind: (frame: Frame) => { get: () => Value; set: (value: Value) => void };
}

export interface Scope {
  names: Map<string, number>;
  /** Slots declared directly in this scope, cleared when it is left. */
  slots: number[];
}

export interface MethodContext {
  /** Values of final locals initialized with constant expressions. */
  constants: Map<number, Value>;
  cls: ClassInfo;
  isStatic: boolean;
  returnType: JavaType;
  locals: LocalInfo[];
  scopes: Scope[];
  /** Labels of the enclosing statements, innermost last. */
  labels: string[];
  /** Labels written directly before the statement being compiled. */
  loopLabels: string[];
  loopDepth: number;
  switchDepth: number;
  /** The objects or class whose fields this code initializes, where their blank finals may be assigned. */
  initializes: 'instance' | 'static' | undefined;
  /** Whether this code is an initializer block, where `return` is not allowed. */
  isInitializerBlock: boolean;
  /** The exceptions the method declares in its `throws` clause. */
  thrownTypes: readonly ClassInfo[];
  /** The try statements whose try block encloses the code being compiled, innermost last. */
  tries: EnclosingTry[];
  /** The checked exceptions that rethrowing each catch parameter throws: those its try block throws. */
  rethrownTypes: Map<number, ClassInfo[]>;
}

export interface EnclosingTry {
  caughtTypes: ClassInfo[];
  /** The checked exceptions thrown in the try block that reach its catch clauses. */
  thrownTypes: ClassInfo[];
}

/** Name resolution, conversions, and overload resolution shared by the expression and statement compilers. */
export abstract class CompilerBase {
  protected readonly builtins = getBuiltins();
  protected readonly classes = new Map<string, ClassInfo>();
  protected readonly internedStrings = new Map<string, JavaString>();
  protected readonly stepIdByRow: ReadonlyMap<number, number>;
  /** Rows of `// step` annotations that a statement records a step for. */
  protected readonly usedStepRows = new Set<number>();
  private readonly fieldConstants = new Map<FieldInfo, Value>();
  private readonly computingConstants = new Set<FieldInfo>();

  constructor(options: CompileOptions) {
    this.stepIdByRow = options.stepIdByRow ?? new Map();
  }

  protected abstract compileValue(context: MethodContext, expression: Expression, allowsVoid?: boolean): CompiledValue;

  protected error(span: Span, message: string): never {
    throw new CompileError([{ row: span.row, message }]);
  }

  protected resolveType(syntax: TypeSyntax): JavaType {
    switch (syntax.kind) {
      case 'primitive': {
        return { int: INT, double: DOUBLE, boolean: BOOLEAN, char: CHAR }[syntax.name];
      }
      case 'array': {
        return { kind: 'array', element: this.resolveType(syntax.element) };
      }
      case 'named': {
        const cls = this.classes.get(syntax.name) ?? this.builtins.classes.get(syntax.name);
        if (!cls) this.error(syntax, `この採点環境には、型 ${syntax.name} がありません。`);
        return cls.type;
      }
      case 'var': {
        return this.error(syntax, 'ここでは var を使えません。');
      }
    }
  }

  protected resolveThrowable(syntax: TypeSyntax): ClassInfo {
    const type = this.resolveType(syntax);
    if (type.kind !== 'class' || !isSubclass(type.cls, this.builtins.throwableClass)) {
      this.error(syntax, `${typeName(type)} は例外クラスではありません。`);
    }
    return type.cls;
  }

  protected withDimensions(type: JavaType, dimensions: number): JavaType {
    let result = type;
    for (let index = 0; index < dimensions; index++) result = { kind: 'array', element: result };
    return result;
  }

  protected newContext(
    cls: ClassInfo,
    isStatic: boolean,
    returnType: JavaType,
    thrownTypes: readonly ClassInfo[] = []
  ): MethodContext {
    return {
      constants: new Map(),
      cls,
      isStatic,
      returnType,
      locals: [],
      scopes: [{ names: new Map(), slots: [] }],
      labels: [],
      loopLabels: [],
      loopDepth: 0,
      switchDepth: 0,
      initializes: undefined,
      isInitializerBlock: false,
      thrownTypes,
      tries: [],
      rethrownTypes: new Map(),
    };
  }

  /** Rejects a checked exception that no enclosing catch clause catches and the method does not declare. */
  protected checkThrown(context: MethodContext, span: Span, thrown: readonly ClassInfo[]): void {
    for (const cls of thrown) {
      if (!this.isChecked(cls)) continue;
      const catching = context.tries.findLastIndex((enclosing) =>
        enclosing.caughtTypes.some((caught) => isSubclass(cls, caught))
      );
      for (const enclosing of context.tries.slice(Math.max(catching, 0))) enclosing.thrownTypes.push(cls);
      if (catching !== -1 || context.thrownTypes.some((declared) => isSubclass(cls, declared))) continue;
      this.error(span, `例外 ${cls.name} は、catch するか、throws で宣言する必要があります。`);
    }
  }

  protected isChecked(cls: ClassInfo): boolean {
    return !['RuntimeException', 'Error'].some((name) => isSubclass(cls, this.builtins.classes.get(name) as ClassInfo));
  }

  protected declareLocal(context: MethodContext, span: Span, name: string, type: JavaType): number {
    for (const scope of context.scopes) {
      if (scope.names.has(name)) this.error(span, `変数 ${name} はすでに定義されています。`);
    }
    const slot = context.locals.length;
    context.locals.push({ name, type });
    const scope = context.scopes.at(-1) as Scope;
    scope.names.set(name, slot);
    scope.slots.push(slot);
    return slot;
  }

  protected findLocal(context: MethodContext, name: string): number | undefined {
    for (let index = context.scopes.length - 1; index >= 0; index--) {
      const slot = context.scopes[index].names.get(name);
      if (slot !== undefined) return slot;
    }
    return;
  }

  /**
   * Converts a value for assignment (which also narrows int constants to char) or for method invocation, failing
   * compilation when Java forbids the conversion.
   *
   * @param span The expression converted, where a failed conversion is reported.
   */
  protected convert(
    value: CompiledValue,
    to: JavaType,
    context: 'assignment' | 'invocation',
    span: Span
  ): CompiledValue {
    if (isWidening(value.type, to, this.builtins.objectClass)) {
      return { kind: 'value', type: to, run: value.run, constant: value.constant };
    }
    if (
      context === 'assignment' &&
      to.kind === 'char' &&
      value.type.kind === 'int' &&
      typeof value.constant === 'number' &&
      value.constant >= 0 &&
      value.constant <= 0xff_ff
    ) {
      return { kind: 'value', type: CHAR, run: value.run, constant: value.constant };
    }
    return this.error(span, `${typeName(value.type)} 型の値を ${typeName(to)} 型に変換できません。`);
  }

  /**
   * The value of a constant variable: a final field of primitive or String type initialized with a constant
   * expression, which Java inlines without initializing its class.
   */
  protected constantOf(field: FieldInfo): Value {
    if (!field.isFinal) return;
    return this.initialConstantOf(field);
  }

  protected initialConstantOf(field: FieldInfo): Value {
    if (!field.declaration || this.computingConstants.has(field)) return;
    if (this.fieldConstants.has(field)) return this.fieldConstants.get(field);
    const isConstantType =
      isPrimitive(field.type) || (field.type.kind === 'class' && field.type.cls === this.builtins.stringClass);
    const initializer = field.declaration.declarators.find((declarator) => declarator.name === field.name)?.initializer;
    let constant: Value;
    if (isConstantType && initializer && initializer.kind !== 'arrayInitializer') {
      this.computingConstants.add(field);
      try {
        const compiled = this.convert(
          this.compileValue(this.newContext(field.owner, true, VOID), initializer),
          field.type,
          'assignment',
          initializer
        );
        constant = compiled.constant;
      } catch {
        constant = undefined;
      } finally {
        this.computingConstants.delete(field);
      }
    }
    this.fieldConstants.set(field, constant);
    return constant;
  }

  protected findField(cls: ClassInfo, name: string): FieldInfo | undefined {
    for (let current: ClassInfo | undefined = cls; current; current = current.superclass) {
      const field = current.fields.get(name);
      if (field) return field;
    }
    return;
  }

  protected checkAccess(context: MethodContext, owner: ClassInfo, access: string, span: Span, what: string): void {
    if (access === 'private' && owner !== context.cls) this.error(span, `${what} は private なので使えません。`);
  }

  /** Evaluates arguments left to right, keeping each in `frame.temporaries` until the caller removes them. */
  protected evaluateArguments(frame: Frame, args: Eval[]): Value[] {
    const values: Value[] = [];
    try {
      for (const arg of args) {
        const value = arg(frame);
        values.push(value);
        frame.temporaries.push(value);
      }
    } catch (error) {
      frame.temporaries.length -= values.length;
      throw error;
    }
    return values;
  }

  /** Evaluates the arguments and calls `method`, keeping the arguments reachable during the call. */
  protected invokeWithArguments(
    frame: Frame,
    method: MethodInfo,
    receiver: Value,
    args: Eval[],
    callRow: number | undefined
  ): Value {
    const values = this.evaluateArguments(frame, args);
    try {
      return frame.runtime.invoke(frame, method, receiver, values, callRow);
    } finally {
      frame.temporaries.length -= values.length;
    }
  }

  /** Methods of `cls` and its ancestors named `name`, leaving out those an override hides. */
  protected collectMethods(cls: ClassInfo, name: string): MethodInfo[] {
    const methods: MethodInfo[] = [];
    for (let current: ClassInfo | undefined = cls; current; current = current.superclass) {
      for (const method of current.methods) {
        if (method.name === name && !methods.some((other) => sameParameters(other, method))) methods.push(method);
      }
    }
    return methods;
  }

  /** Picks the most specific applicable method, as Java's overload resolution does without boxing or varargs. */
  protected selectMethod(span: Span, candidates: MethodInfo[], argTypes: JavaType[], what: string): MethodInfo {
    const objectClass = this.builtins.objectClass;
    const applicable = candidates.filter(
      (method) =>
        method.parameterTypes.length === argTypes.length &&
        method.parameterTypes.every((type, index) => isWidening(argTypes[index], type, objectClass))
    );
    if (applicable.length === 0) {
      const given = argTypes.map((type) => typeName(type)).join(', ');
      // This environment implements only part of the standard library, so the message states only what it allows.
      return this.error(span, `この採点環境では、${what} に (${given}) を渡して呼び出すことはできません。`);
    }
    const mostSpecific = applicable.filter((method) =>
      applicable.every(
        (other) =>
          other === method ||
          method.parameterTypes.every((type, index) => isWidening(type, other.parameterTypes[index], objectClass))
      )
    );
    if (mostSpecific.length !== 1) return this.error(span, `${what} の呼び出しがあいまいです。`);
    return mostSpecific[0];
  }
}

export function constantValue(type: JavaType, value: Value): CompiledValue {
  return { kind: 'value', type, run: () => value, constant: value };
}

export function sameParameters(a: MethodInfo, b: MethodInfo): boolean {
  return (
    a.parameterTypes.length === b.parameterTypes.length &&
    a.parameterTypes.every((type, index) => sameType(type, b.parameterTypes[index]))
  );
}
