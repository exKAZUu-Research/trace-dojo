import { CompileError } from '../interpreter/diagnostics';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import type { Expression, FieldDeclaration, ImportDeclaration, Span, TypeParameter, TypeSyntax } from './ast';
import { getBuiltins } from './builtins';
import { box, boxedTypeOf, unbox } from './builtinWrappers';
import { boxingTarget, instantiateMethod, isInvocationConvertible, unboxedTypeOf } from './conversions';
import { fitsIn } from './operators';
import { type Frame } from './runtime';
import {
  type ClassInfo,
  erasure,
  type FieldInfo,
  isNumeric,
  isPrimitive,
  isSubclass,
  isWidening,
  type JavaType,
  type LocalInfo,
  type MethodInfo,
  type NumericKind,
  sameType,
  superinterfacesOf,
  typeName,
  type TypeVariable,
  VOID,
} from './types';
import { convertNumber, JavaArray, JavaString, type Value } from './values';

export interface CompileOptions {
  /** Makes the statements that record steps report their rows to `Runtime.steps`. */
  trace?: TraceOptions;
}

export type Eval = (frame: Frame) => Value;

/** A statement either completes normally (`undefined`) or abruptly with one of these. */
export type Completion = BreakCompletion | ContinueCompletion | ReturnCompletion | YieldCompletion;
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
export interface YieldCompletion {
  kind: 'yield';
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
  /** Whether the reference reads a local that a local or anonymous class copied, which it may not assign. */
  isCapture?: boolean;
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
  /** Labels written directly before the enclosing loops, which `continue` may name. */
  continueLabels: string[];
  loopDepth: number;
  switchDepth: number;
  /** The objects or class whose fields this code initializes, where their blank finals may be assigned. */
  initializes: 'instance' | 'static' | undefined;
  /** Whether this code is an initializer block, where `return` is not allowed. */
  isInitializerBlock: boolean;
  /** Whether this code is in a switch expression, which `return` cannot leave. */
  isInSwitchExpression: boolean;
  /** The exceptions the method declares in its `throws` clause. */
  thrownTypes: readonly ClassInfo[];
  /** The try statements whose try block encloses the code being compiled, innermost last. */
  tries: EnclosingTry[];
  /** The checked exceptions that rethrowing each catch parameter throws: those its try block throws. */
  rethrownTypes: Map<number, ClassInfo[]>;
  /** The switch expressions whose bodies enclose the code being compiled, innermost last. */
  switchExpressions: SwitchExpressionTarget[];
  /** The slots of the pattern variables declared so far. */
  patternSlots: number[];
  /** The pattern variables that a statement introduced into its enclosing block. */
  introducedPatternSlots: Set<number>;
  /** For a lambda body, the code around the lambda, whose locals the body may read. */
  enclosing: MethodContext | undefined;
  /** For a lambda body, the enclosing locals it reads, which the lambda copies when it is created. */
  captures: Capture[];
  /** The locals that a lambda reads, which may therefore not be assigned again. */
  capturedSlots: Set<number>;
  /** How many times each local is assigned after its declaration. */
  assignmentCounts: Map<number, number>;
  /** The locals declared without an initializer, which one assignment may initialize and still be effectively final. */
  uninitializedSlots: Set<number>;
  /** For a lambda body, the types of the values it returns, from which a generic method infers its result. */
  returnedTypes?: JavaType[];
}

export interface Capture {
  name: string;
  type: JavaType;
  constant: Value;
  /** Reads the value in the frame that creates the lambda. */
  read: Eval;
}

/** The values a switch expression's yields give, which are converted to its type once all are known. */
export interface SwitchExpressionTarget {
  values: { value: CompiledValue; span: Span }[];
  converters: Eval[];
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
  protected readonly recordsSteps: boolean;
  protected readonly atomicRows: ReadonlySet<number>;
  /** Rows of `// atomic` annotations that a method or constructor declaration claims. */
  protected readonly usedAtomicRows = new Set<number>();
  private readonly fieldConstants = new Map<FieldInfo, Value>();
  private readonly computingConstants = new Set<FieldInfo>();
  /** The type the expression about to be compiled is assigned to, which a diamond `<>` infers its arguments from. */
  private targetType: JavaType | undefined;
  /** The class whose body the code being compiled is in, which decides what simple type names mean. */
  protected typeScope: ClassInfo | undefined;

  constructor(options: CompileOptions) {
    this.recordsSteps = options.trace !== undefined;
    this.atomicRows = new Set(options.trace?.atomicAnnotations.keys());
  }

  protected abstract compileValue(context: MethodContext, expression: Expression, allowsVoid?: boolean): CompiledValue;

  protected error(span: Span, message: string): never {
    throw new CompileError([{ row: span.row, message }]);
  }

  protected resolveType(syntax: TypeSyntax): JavaType {
    switch (syntax.kind) {
      case 'primitive': {
        return { kind: syntax.name };
      }
      case 'array': {
        return { kind: 'array', element: this.resolveType(syntax.element) };
      }
      case 'named': {
        return this.resolveNamedType(syntax);
      }
      case 'wildcard': {
        return this.error(syntax, '? は型引数の中にしか書けません。');
      }
      case 'var': {
        return this.error(syntax, 'ここでは var を使えません。');
      }
    }
  }

  protected resolveNamedType(syntax: Extract<TypeSyntax, { kind: 'named' }>): JavaType {
    if (syntax.qualifier.length === 0) {
      const variable = this.findTypeVariable(syntax.name);
      if (variable) {
        if (syntax.args) this.error(syntax, `型パラメータ ${syntax.name} には型引数を付けられません。`);
        return { kind: 'typeVar', variable };
      }
    }
    const [first, ...rest] = [...syntax.qualifier, syntax.name];
    let cls = this.lookupType(first, this.typeScope);
    for (const name of rest) cls = cls && this.findMemberType(cls, name);
    if (!cls) this.error(syntax, `この採点環境には、型 ${[...syntax.qualifier, syntax.name].join('.')} がありません。`);
    if (!syntax.args) return cls.type;
    const { typeParameters } = cls;
    // The diamond `<>` stands for arguments that the creation infers.
    if (syntax.args.length === 0) return { kind: 'class', cls, args: [] };
    if (typeParameters.length !== syntax.args.length) {
      this.error(
        syntax,
        typeParameters.length === 0
          ? `型 ${cls.name} には型引数を付けられません。`
          : `型 ${cls.name} には ${typeParameters.length} 個の型引数が必要です。`
      );
    }
    return { kind: 'class', cls, args: syntax.args.map((arg) => this.resolveTypeArgument(arg)) };
  }

  protected resolveTypeArgument(syntax: TypeSyntax): JavaType {
    if (syntax.kind === 'wildcard') {
      return {
        kind: 'wildcard',
        bound: syntax.bound && this.resolveTypeArgument(syntax.bound),
        isSuper: syntax.isSuper,
      };
    }
    const type = this.resolveType(syntax);
    if (isPrimitive(type)) {
      const box = `${type.kind[0].toUpperCase()}${type.kind.slice(1)}`
        .replace('Int', 'Integer')
        .replace('Char', 'Character');
      this.error(syntax, `型引数にプリミティブ型 ${type.kind} は使えません。${box} を使ってください。`);
    }
    return type;
  }

  /** The type variables in scope, innermost last. */
  protected readonly typeVariableScopes: Map<string, TypeVariable>[] = [];

  protected findTypeVariable(name: string): TypeVariable | undefined {
    for (let index = this.typeVariableScopes.length - 1; index >= 0; index--) {
      const variable = this.typeVariableScopes[index].get(name);
      if (variable) return variable;
    }
    return;
  }

  /** Runs `compile` with type variables in scope. */
  protected withTypeVariables<T>(variables: readonly TypeVariable[], compile: () => T): T {
    if (variables.length === 0) return compile();
    this.typeVariableScopes.push(new Map(variables.map((variable) => [variable.name, variable])));
    try {
      return compile();
    } finally {
      this.typeVariableScopes.pop();
    }
  }

  /** Declares type parameters, whose bounds may name each other, defaulting a missing bound to `Object`. */
  protected declareTypeParameters(parameters: readonly TypeParameter[]): TypeVariable[] {
    const variables = parameters.map((parameter): TypeVariable => ({ name: parameter.name, bounds: [] }));
    for (const [index, parameter] of parameters.entries()) {
      if (variables.slice(0, index).some((other) => other.name === parameter.name)) {
        this.error(parameter, `型パラメータ ${parameter.name} が重複しています。`);
      }
    }
    this.withTypeVariables(variables, () => {
      for (const [index, parameter] of parameters.entries()) {
        variables[index].bounds =
          parameter.bounds.length > 0
            ? parameter.bounds.map((bound) => this.resolveType(bound))
            : [this.builtins.objectClass.type];
      }
    });
    return variables;
  }

  /** Compiles an expression whose value is assigned to `type`, which a diamond may infer its type arguments from. */
  protected compileValueFor(context: MethodContext, expression: Expression, type: JavaType): CompiledValue {
    const isCreation = ['new', 'lambda', 'methodRef', 'call'].includes(expression.kind);
    this.targetType = isCreation ? type : undefined;
    try {
      return this.compileValue(context, expression);
    } finally {
      this.targetType = undefined;
    }
  }

  /** Takes the target type of the expression being compiled, which only that expression may use. */
  protected takeTargetType(): JavaType | undefined {
    const type = this.targetType;
    this.targetType = undefined;
    return type;
  }

  /** The one string object that every literal with this text evaluates to. */
  protected internedString(text: string): JavaString {
    let interned = this.internedStrings.get(text);
    if (!interned) {
      interned = new JavaString(text);
      this.internedStrings.set(text, interned);
    }
    return interned;
  }

  /** Runs `compile` with simple type names resolved inside `cls`'s body. */
  protected withTypeScope<T>(cls: ClassInfo | undefined, compile: () => T): T {
    const outer = this.typeScope;
    this.typeScope = cls;
    try {
      return compile();
    } finally {
      this.typeScope = outer;
    }
  }

  /** The classes that single-type imports such as `import java.util.Map.Entry;` name by their simple names. */
  protected readonly importedTypes = new Map<string, ClassInfo>();
  /** The classes whose static members static imports bring in, with the member's name or `undefined` for `*`. */
  protected readonly staticImports: { cls: ClassInfo; member: string | undefined }[] = [];

  /** Resolves the imports that name classes this environment has, leaving the others for their uses to report. */
  protected resolveImports(imports: readonly ImportDeclaration[]): void {
    for (const declaration of imports) {
      const names =
        declaration.isStatic && !declaration.isWildcard ? declaration.names.slice(0, -1) : declaration.names;
      const cls = this.importedClass(names);
      if (!cls) continue;
      if (declaration.isStatic) {
        this.staticImports.push({ cls, member: declaration.isWildcard ? undefined : declaration.names.at(-1) });
      } else if (declaration.isWildcard) {
        for (const [name, member] of cls.memberTypes) this.importedTypes.set(name, member);
      } else {
        this.importedTypes.set(cls.name, cls);
      }
    }
  }

  /** The class a qualified name such as `java.util.Map.Entry` names, skipping its package. */
  protected importedClass(names: readonly string[]): ClassInfo | undefined {
    const start = names.findIndex((name) => this.classes.has(name) || this.builtins.classes.has(name));
    if (start === -1) return;
    let cls = this.classes.get(names[start]) ?? this.builtins.classes.get(names[start]);
    for (const name of names.slice(start + 1)) cls = cls && this.findMemberType(cls, name);
    return cls;
  }

  /** The static members of `name` that static imports bring in, single imports first. */
  protected staticallyImported<T>(name: string, find: (cls: ClassInfo) => T | undefined): T | undefined {
    for (const isSingle of [true, false]) {
      for (const { cls, member } of this.staticImports) {
        if ((member !== undefined) !== isSingle || (member !== undefined && member !== name)) continue;
        const found = find(cls);
        if (found !== undefined) return found;
      }
    }
    return;
  }

  /** The local classes in scope, innermost block last. */
  protected readonly localTypeScopes: Map<string, ClassInfo>[] = [];

  /**
   * Finds the class that a simple name means inside `scope`: a local class in scope, a member type in scope, then a
   * top-level class.
   */
  protected lookupType(name: string, scope: ClassInfo | undefined): ClassInfo | undefined {
    for (let index = this.localTypeScopes.length - 1; index >= 0; index--) {
      const local = this.localTypeScopes[index].get(name);
      if (local) return local;
    }
    for (let current = scope; current; current = current.enclosing) {
      const member = this.findMemberType(current, name);
      if (member) return member;
    }
    return this.importedTypes.get(name) ?? this.classes.get(name) ?? this.builtins.classes.get(name);
  }

  /** Finds a member type of `cls` or one it inherits from its superclasses and interfaces. */
  protected findMemberType(cls: ClassInfo, name: string): ClassInfo | undefined {
    if (cls.name === name && cls.enclosing === undefined && !cls.isBuiltin) return;
    for (const type of [cls, ...superclassesOf(cls), ...superinterfacesOf(cls)]) {
      const member = type.memberTypes.get(name);
      if (member) return member;
    }
    return;
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
      continueLabels: [],
      loopDepth: 0,
      switchDepth: 0,
      initializes: undefined,
      isInitializerBlock: false,
      isInSwitchExpression: false,
      thrownTypes,
      tries: [],
      rethrownTypes: new Map(),
      switchExpressions: [],
      patternSlots: [],
      introducedPatternSlots: new Set(),
      enclosing: undefined,
      captures: [],
      capturedSlots: new Set(),
      assignmentCounts: new Map(),
      uninitializedSlots: new Set(),
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

  protected declareLocal(
    context: MethodContext,
    span: Span,
    name: string,
    type: JavaType,
    isInitialized = true
  ): number {
    // A lambda's locals may not hide the locals of the code around it.
    for (let current: MethodContext | undefined = context; current; current = current.enclosing) {
      for (const scope of current.scopes) {
        if (scope.names.has(name)) this.error(span, `変数 ${name} はすでに定義されています。`);
      }
    }
    const slot = context.locals.length;
    context.locals.push({ name, type });
    const scope = context.scopes.at(-1) as Scope;
    scope.names.set(name, slot);
    scope.slots.push(slot);
    if (!isInitialized) context.uninitializedSlots.add(slot);
    return slot;
  }

  /**
   * Finds a local of the code around a lambda that the lambda body reads, recording it as a capture; it must be
   * effectively final, as Java requires.
   */
  protected findCapture(
    context: MethodContext,
    span: Span,
    name: string
  ): { index: number; capture: Capture } | undefined {
    const outer = context.enclosing;
    if (!outer) return;
    const index = context.captures.findIndex((capture) => capture.name === name);
    if (index !== -1) return { index, capture: context.captures[index] };
    let capture: Capture;
    const slot = this.findLocal(outer, name);
    if (slot === undefined) {
      const outerCapture = this.findCapture(outer, span, name);
      if (!outerCapture) return;
      const outerIndex = outerCapture.index;
      capture = { ...outerCapture.capture, read: (frame) => frame.captured[outerIndex] };
    } else {
      const allowed = outer.uninitializedSlots.has(slot) ? 1 : 0;
      if ((outer.assignmentCounts.get(slot) ?? 0) > allowed) this.error(span, capturedAssignmentMessage(name));
      outer.capturedSlots.add(slot);
      capture = {
        name,
        type: outer.locals[slot].type,
        constant: outer.constants.get(slot),
        read: (frame) => frame.locals[slot] as Value,
      };
    }
    return { index: context.captures.push(capture) - 1, capture };
  }

  /** Records an assignment to a local, which a lambda that reads it forbids. */
  protected recordAssignment(context: MethodContext, span: Span, slot: number): void {
    if (context.capturedSlots.has(slot)) this.error(span, capturedAssignmentMessage(context.locals[slot].name));
    context.assignmentCounts.set(slot, (context.assignmentCounts.get(slot) ?? 0) + 1);
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
      return isNumeric(value.type) && isNumeric(to)
        ? convertedNumber(value, value.type.kind, to)
        : { ...value, type: to };
    }
    // An assignment narrows a constant of type byte, short, char, or int that fits in byte, short, or char.
    if (
      context === 'assignment' &&
      isNumeric(to) &&
      isNumeric(value.type) &&
      ['byte', 'short', 'char', 'int'].includes(value.type.kind) &&
      typeof value.constant === 'number' &&
      fitsIn(value.constant, to.kind)
    ) {
      return constantValue(to, value.constant);
    }
    const boxed = this.boxedConversion(value, to, context);
    if (boxed) return boxed;
    return this.error(span, `${typeName(value.type)} 型の値を ${typeName(to)} 型に変換できません。`);
  }

  /** Converts by boxing a primitive value or unboxing a wrapper object, then widening the result. */
  protected boxedConversion(
    value: CompiledValue,
    to: JavaType,
    context: 'assignment' | 'invocation'
  ): CompiledValue | undefined {
    // A hole that inference left undecided takes any value, boxed as an argument for an Object parameter would be.
    const target = to.kind === 'wildcard' && to.isHole ? this.builtins.objectClass.type : to;
    let boxType = boxingTarget(this.builtins, value.type, target);
    // An assignment also boxes a constant int that fits in the byte, short, or char that `Byte` and the like box.
    const unboxedTarget = unboxedTypeOf(to);
    if (
      !boxType &&
      context === 'assignment' &&
      to.kind === 'class' &&
      unboxedTarget &&
      isNumeric(unboxedTarget) &&
      typeof value.constant === 'number' &&
      value.type.kind === 'int' &&
      fitsIn(value.constant, unboxedTarget.kind)
    ) {
      boxType = to;
    }
    if (boxType) {
      const { cls } = boxType;
      const { run } = value;
      return { kind: 'value', type: target === to ? to : boxType, run: (frame) => box(frame, cls, run(frame)) };
    }
    const unboxed = this.unboxed(value);
    if (unboxed && isPrimitive(to) && isWidening(unboxed.type, to, this.builtins.objectClass)) {
      return this.convert(unboxed, to, context, { row: 0, endRow: 0, start: 0, end: 0 });
    }
    return;
  }

  /** Unboxes a wrapper value, throwing `NullPointerException` for null, or returns `undefined` for other values. */
  protected unboxed(value: CompiledValue): CompiledValue | undefined {
    const type = unboxedTypeOf(value.type);
    if (!type) return;
    const { run } = value;
    return { kind: 'value', type, run: (frame) => unbox(frame, run(frame)) };
  }

  /** A value as an operator sees it: unboxed when it is a wrapper object. */
  protected operand(value: CompiledValue): CompiledValue {
    return this.unboxed(value) ?? value;
  }

  /** A primitive value boxed into its wrapper, as a conditional with a reference branch boxes the other. */
  protected boxedValue(value: CompiledValue): CompiledValue {
    const boxType = boxedTypeOf(this.builtins.wrappers, value.type);
    if (!boxType) return value;
    const { run } = value;
    return { kind: 'value', type: boxType, run: (frame) => box(frame, boxType.cls, run(frame)) };
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
    const { declaration } = field;
    if (!declaration || this.computingConstants.has(field)) return;
    if (this.fieldConstants.has(field)) return this.fieldConstants.get(field);
    return this.withTypeScope(field.owner, () => this.computeInitialConstant(field, declaration));
  }

  private computeInitialConstant(field: FieldInfo, declaration: FieldDeclaration): Value {
    const isConstantType =
      isPrimitive(field.type) || (field.type.kind === 'class' && field.type.cls === this.builtins.stringClass);
    const initializer = declaration.declarators.find((declarator) => declarator.name === field.name)?.initializer;
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

  /** Finds a field of `cls`, its superclasses, or the interfaces they implement. */
  protected findField(cls: ClassInfo, name: string): FieldInfo | undefined {
    for (let current: ClassInfo | undefined = cls; current; current = current.superclass) {
      const field = current.fields.get(name);
      if (field) return field;
      for (const parent of current.interfaces) {
        const inherited = this.findField(parent, name);
        if (inherited) return inherited;
      }
    }
    return;
  }

  /** Private members are accessible anywhere in the top-level class that declares them, nested classes included. */
  protected checkAccess(context: MethodContext, owner: ClassInfo, access: string, span: Span, what: string): void {
    if (access === 'private' && topLevelOf(owner) !== topLevelOf(context.cls)) {
      this.error(span, `${what} は private なので使えません。`);
    }
  }

  /** Compiles an argument, leaving a lambda or method reference to be typed once the method is chosen. */
  protected compileArgument(context: MethodContext, expression: Expression): CompiledValue {
    if (expression.kind === 'lambda' || expression.kind === 'methodRef') {
      const arity = expression.kind === 'lambda' ? expression.parameters.length : undefined;
      return { kind: 'value', type: { kind: 'pending', arity }, run: () => {} };
    }
    return this.compileValue(context, expression);
  }

  /** Converts the arguments of a call to `method`, packing those of a variable arity parameter into an array. */
  protected convertArguments(
    context: MethodContext,
    method: MethodInfo,
    args: readonly CompiledValue[],
    expressions: readonly Expression[]
  ): Eval[] {
    const converted = args.map((arg, index) => {
      const parameterType = method.parameterTypes[index];
      const value =
        arg.type.kind === 'pending' ? this.compileValueFor(context, expressions[index], parameterType) : arg;
      return this.convert(value, parameterType, 'invocation', expressions[index]).run;
    });
    const start = method.varargsStart;
    if (start === undefined) return converted;
    const declared = method.declared ?? method;
    const arrayType = declared.parameterTypes.at(-1) as Extract<JavaType, { kind: 'array' }>;
    const elementType = erasure(method.parameterTypes[start] ?? arrayType.element);
    const trailing = converted.slice(start);
    const packed: Eval = (frame) => {
      const values = this.evaluateArguments(frame, trailing);
      frame.temporaries.length -= values.length;
      frame.runtime.allocateArray(frame, values.length);
      return new JavaArray(elementType, values);
    };
    return [...converted.slice(0, start), packed];
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

  /**
   * Methods of `cls` and its ancestors named `name`, leaving out those an override hides. Interfaces lend only their
   * instance methods, and an interface has those of `Object` too.
   */
  protected collectMethods(cls: ClassInfo, name: string): MethodInfo[] {
    const methods: MethodInfo[] = [];
    const add = (owner: ClassInfo, includesStatic: boolean): void => {
      for (const method of owner.methods) {
        if (method.name !== name || (method.isStatic && !includesStatic)) continue;
        const isHidden = methods.some((other) => sameParameters(other, method) || other.overrides?.has(method));
        if (!isHidden) methods.push(method);
      }
    };
    for (const current of [cls, ...superclassesOf(cls)]) add(current, current.kind !== 'interface' || current === cls);
    for (const parent of superinterfacesOf(cls)) add(parent, false);
    if (cls.kind === 'interface') add(this.builtins.objectClass, false);
    return methods;
  }

  /** Picks the most specific applicable method, as Java's overload resolution does without boxing or varargs. */
  protected selectMethod(
    span: Span,
    candidates: MethodInfo[],
    argTypes: JavaType[],
    what: string,
    targetType?: JavaType,
    presetsOf?: (method: MethodInfo) => Map<TypeVariable, JavaType> | undefined
  ): MethodInfo {
    const objectClass = this.builtins.objectClass;
    const instantiated = candidates.flatMap(
      (method) => instantiateMethod(this.builtins, method, argTypes, targetType, presetsOf?.(method)) ?? []
    );
    // Java first looks for methods applicable without boxing, and boxes only when none is.
    const applicableBy = (allowsBoxing: boolean): MethodInfo[] =>
      instantiated.filter(
        (method) =>
          method.parameterTypes.length === argTypes.length &&
          method.parameterTypes.every((type, index) =>
            isInvocationConvertible(this.builtins, argTypes[index], type, allowsBoxing)
          )
      );
    let applicable = applicableBy(false);
    if (applicable.length === 0) applicable = applicableBy(true);
    // The last phase passes trailing arguments to a variable arity parameter.
    if (applicable.length === 0) {
      applicable = candidates.flatMap((method) => {
        const expanded = expandVarargs(method, argTypes.length);
        const instantiatedVarargs =
          expanded && instantiateMethod(this.builtins, expanded, argTypes, targetType, presetsOf?.(method));
        const fits =
          instantiatedVarargs?.parameterTypes.every((type, index) =>
            isInvocationConvertible(this.builtins, argTypes[index], type, true)
          ) ?? false;
        return fits && instantiatedVarargs ? [instantiatedVarargs] : [];
      });
    }
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

/**
 * A view of a variable arity method that takes `count` arguments, the trailing ones each of the array's element
 * type, or `undefined` when the method takes a fixed number of arguments or too many.
 */
function expandVarargs(method: MethodInfo, count: number): MethodInfo | undefined {
  if (!method.isVarargs) return;
  const fixed = method.parameterTypes.slice(0, -1);
  const arrayType = method.parameterTypes.at(-1) as Extract<JavaType, { kind: 'array' }>;
  if (count < fixed.length) return;
  return {
    ...method,
    parameterTypes: [...fixed, ...Array.from({ length: count - fixed.length }, () => arrayType.element)],
    varargsStart: fixed.length,
    declared: method.declared ?? method,
  };
}

/** Converts a numeric value to the kind `to` by a widening conversion, folding a constant. */
function convertedNumber(value: CompiledValue, from: NumericKind, to: { kind: NumericKind }): CompiledValue {
  if (from === to.kind) return { ...value, type: to };
  const { run } = value;
  return {
    kind: 'value',
    type: to,
    run: (frame) => convertNumber(run(frame), from, to.kind),
    constant: value.constant === undefined ? undefined : convertNumber(value.constant, from, to.kind),
  };
}

function capturedAssignmentMessage(name: string): string {
  return `ラムダ式の中から使うローカル変数 ${name} は、final か実質的に final (一度しか代入しない) である必要があります。`;
}

/** The superclasses of `cls`, nearest first. */
export function superclassesOf(cls: ClassInfo): ClassInfo[] {
  const found: ClassInfo[] = [];
  for (let current = cls.superclass; current; current = current.superclass) found.push(current);
  return found;
}

export function topLevelOf(cls: ClassInfo): ClassInfo {
  let current = cls;
  while (current.enclosing) current = current.enclosing;
  return current;
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
