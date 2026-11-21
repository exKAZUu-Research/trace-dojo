// code-gauge-allow-file fileNcss 557 -- the compiler of one area of Kotlin, whose parts call each other closely.
import type { Expression, ParameterDecl, PropertyDecl } from './ast';
import type { ArgumentSyntax, Candidate, ResolvedCall } from './callCompiler';
import {
  type Compiled,
  convertRepr,
  type Eval,
  Flow,
  FunctionContext,
  Handoff,
  ReceiverSymbol,
  reprOf,
  Scope,
  typeMismatchMessage,
} from './compilerBase';
import { type FileContext } from './compilerCore';
import { type ClassEntry, DeclarationCompiler, type FunctionEntry, type PropertyEntry } from './declarationCompiler';
import { propertyRepr, returnRepr } from './dispatch';
import { type Frame, MISSING } from './runtime';
import type { ClassSymbol, FunctionSymbol, ParameterSymbol, PropertySymbol } from './symbols';
import { VariableSymbol } from './symbols';
import { anyType, isSubtype, substitutionOf } from './typeRelations';
import { type ClassType, isNonNullClass, type KType, resolved } from './types';
import { KObject, UNIT, type Value } from './values';

/** Compiles the bodies of functions, the accessors and initializers of properties, and the initializers of classes and objects. */
export abstract class BodyCompiler extends DeclarationCompiler {
  // Phase 4: bodies.

  protected compileBodies(): void {
    for (const entry of this.propertyEntries) this.ensurePropertyCompiled(entry);
    // The defaults need the types of the fields, which inferred properties have only now.
    const done = new Set<ClassSymbol>();
    const setDefaults = (cls: ClassSymbol): void => {
      if (done.has(cls) || !this.entryOfClass.has(cls)) return;
      done.add(cls);
      if (cls.superclass) setDefaults(cls.superclass.cls);
      const defaults: Value[] = [...(cls.superclass?.cls.fieldDefaults ?? [])];
      defaults.length = cls.fieldCount;
      for (const property of cls.ownFields) defaults[property.slot as number] = this.defaultValueOf(property.type);
      cls.fieldDefaults = defaults;
    };
    for (const entry of this.classEntries) setDefaults(entry.symbol);
    for (const entry of this.functionEntries) this.ensureFunctionCompiled(entry);
    this.validateOverrideTypes();
    this.validateJvmSignatures();
    for (const entry of this.classEntries) {
      this.file = entry.file;
      this.compileClassInitializer(entry);
    }
  }

  protected ensureReturnType(func: FunctionSymbol, row: number): KType {
    if (func.returnType) return func.returnType;
    const entry = this.entryOfFunction.get(func);
    if (!entry) return this.core.unit.type;
    if (entry.state === 'compiling')
      this.error(row, `関数 ${func.name} は自分を呼んでいるので、戻り値の型を書いてください。`);
    this.ensureFunctionCompiled(entry);
    return func.returnType ?? this.core.unit.type;
  }

  protected ensurePropertyType(property: PropertySymbol, row: number): KType {
    if (property.type) return property.type;
    const entry = this.entryOfProperty.get(property);
    if (!entry) return anyType(true);
    if (entry.state === 'compiling')
      this.error(row, `プロパティ ${property.name} は自分を使っているので、型を書いてください。`);
    this.ensurePropertyCompiled(entry);
    return property.type ?? anyType(true);
  }

  /** Runs a compilation of another declaration in the middle of one, restoring what the current one had. */
  private withSavedState<T>(file: FileContext, compile: () => T): T {
    const savedFile = this.file;
    const savedFlow = this.flow;
    const savedInitialization = this.uninitializedProperties;
    this.file = file;
    this.flow = new Flow();
    this.uninitializedProperties = undefined;
    for (const variable of this.initializerVariables) this.flow.assigned.add(variable);
    try {
      return compile();
    } finally {
      this.file = savedFile;
      this.flow = savedFlow;
      this.uninitializedProperties = savedInitialization;
    }
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Parameters, receivers, defaults, the body, and the frame of a function.
  // code-gauge-allow functionNcss 52 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private ensureFunctionCompiled(entry: FunctionEntry): void {
    if (entry.state !== 'pending') return;
    entry.state = 'compiling';
    this.withSavedState(entry.file, () => {
      const { decl, symbol } = entry;
      const context = new FunctionContext(undefined, false, symbol.name, entry.file.isLibrary, undefined);
      Object.defineProperty(context, 'returnTarget', { value: context });
      context.info.isAtomic = symbol.isAtomic;
      const scope = new Scope(entry.scope, context);
      const thisType = this.addReceivers(scope, context, entry.cls, symbol.extensionReceiver, symbol.name);
      // An object's members show its properties as `Name.x`, as Java's static members do, rather than as `this.x`.
      context.info.showsThis =
        thisType !== undefined && entry.cls !== undefined && !entry.cls.symbol.isObject && !entry.file.isLibrary;
      const variables = symbol.params.map((param, index) =>
        this.newParameter(
          scope,
          context,
          param.name,
          param.isVararg ? this.varargType(param.type) : param.type,
          decl.params[index].row
        )
      );
      const defaults = this.compileParameterDefaults(decl.params, symbol.params, variables, scope, context);
      symbol.defaultsInfo = context.info;
      if (!decl.body) {
        entry.state = 'done';
        return;
      }
      let body: Eval;
      if (decl.body.kind === 'expression') {
        const compiled = this.compileExpression(scope, context, decl.body.expression, symbol.returnType);
        symbol.returnType ??= this.inferredResultType(compiled);
        context.returnType = symbol.returnType;
        body = convertRepr(
          this.expectType(compiled, symbol.returnType, decl.body.expression.row),
          reprOf(this.core, symbol.returnType),
          returnRepr(symbol)
        );
      } else {
        const returnType = symbol.returnType as KType;
        context.returnType = returnType;
        context.returnRepr = returnRepr(symbol);
        const compiled = this.compileStatementsValue(
          scope,
          context,
          decl.body.block.statements,
          undefined,
          true,
          false
        );
        const isUnit = isNonNullClass(returnType, this.core.unit);
        if (!isUnit && !this.flow.isDead) {
          this.error(decl.body.block.endRow, `関数 ${symbol.name} の最後に return を書いてください。`);
        }
        const evaluate = compiled.eval;
        body = (frame) => {
          evaluate(frame);
          return UNIT;
        };
      }
      this.finishFunction(symbol, context, defaults, body);
      entry.state = 'done';
    });
  }

  /** The type a `vararg` parameter has inside its function: an array of its elements. */
  protected abstract varargType(elementType: KType): KType;

  private inferredResultType(compiled: Compiled): KType {
    const type = resolved(compiled.type);
    if (compiled.integerLiteral) return this.primitiveType(this.primitiveOf(type) ?? 'Int');
    return type;
  }

  /** Adds the implicit receivers of a member or extension: the class's instance, and an extension's receiver. */
  private addReceivers(
    scope: Scope,
    context: FunctionContext,
    cls: ClassEntry | undefined,
    extension: KType | undefined,
    label?: string
  ): KType | undefined {
    let thisType: KType | undefined;
    if (cls) {
      thisType = this.thisTypeOf(cls.symbol);
      if (!extension) scope.receiver = new ReceiverSymbol(thisType, context, cls.symbol, cls.symbol.name);
      // An extension declared in an object, as `Int.minutes` in `Duration.Companion`, needs no instance of it.
      else if (!cls.symbol.isObject || !cls.file.isLibrary)
        this.unavailable(cls.symbol.row, 'クラスの中での拡張関数・拡張プロパティの宣言');
    }
    if (extension) {
      scope.receiver = new ReceiverSymbol(extension, context, undefined, label);
      thisType = extension;
    }
    return thisType;
  }

  private finishFunction(
    symbol: FunctionSymbol,
    context: FunctionContext,
    defaults: (Eval | undefined)[],
    body: Eval
  ): void {
    const { info } = context;
    const fillsDefaults = defaults.some((evaluate) => evaluate !== undefined);
    const run: Eval = fillsDefaults
      ? (frame) => {
          for (const [index, evaluate] of defaults.entries()) {
            if (evaluate && frame.locals[index] === MISSING) frame.locals[index] = evaluate(frame);
          }
          return body(frame);
        }
      : body;
    const none: unknown[] = [];
    symbol.invoke = (caller, receiver, args, callRow) =>
      caller.runtime.call(info, caller, none, receiver, args, callRow, run);
  }

  // code-gauge-allow functionCognitiveComplexity 24 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private ensurePropertyCompiled(entry: PropertyEntry): void {
    if (entry.state !== 'pending') return;
    entry.state = 'compiling';
    this.withSavedState(entry.file, () => {
      const { decl, symbol } = entry;
      // Initializers run in the class's initializer, whose scope sees the primary constructor's parameters.
      if (decl.initializer && !symbol.type) {
        const context = this.initializerContext(entry);
        const scope = this.initializerScope(entry, context);
        const compiled = this.inPropertyInitializer(entry, context, () =>
          this.compileExpression(scope, context, decl.initializer as Expression)
        );
        const type = resolved(compiled.type);
        symbol.type = compiled.integerLiteral ? this.primitiveType(this.primitiveOf(type) ?? 'Int') : type;
      }
      if (decl.delegate) this.compileMemberDelegate(entry);
      else if (!symbol.type && decl.getter?.body) {
        symbol.type = this.compileAccessorType(entry);
      }
      const isPlainTopLevel = !entry.cls && !decl.delegate;
      // The global comes first, as the accessors' `field` is the global and the accessors replace its plain ones.
      if (isPlainTopLevel && this.hasBackingField(decl, symbol)) this.bindGlobal(entry);
      if (decl.getter?.body) this.compileGetter(entry);
      if (decl.setter?.body) this.compileSetter(entry);
      entry.state = 'done';
    });
  }

  private initializerContexts = new Map<ClassEntry | FileContext, FunctionContext>();
  private activeFileInitializers = new Map<FunctionContext, PropertyEntry>();

  protected inPropertyInitializer<T>(entry: PropertyEntry, context: FunctionContext, compile: () => T): T {
    if (entry.cls) return compile();
    const enclosing = this.activeFileInitializers.get(context);
    this.activeFileInitializers.set(context, entry);
    try {
      return compile();
    } finally {
      if (enclosing) this.activeFileInitializers.set(context, enclosing);
      else this.activeFileInitializers.delete(context);
    }
  }

  protected checkGlobalInitialized(context: FunctionContext, property: PropertySymbol, row: number): void {
    const initializer = this.activeFileInitializers.get(context.directExecutionContext());
    const entry = this.entryOfProperty.get(property);
    if (!initializer || !entry || initializer.file !== entry.file) return;
    const { decl } = entry;
    if (decl.modifiers.keywords.has('const') || property.isLateinit || (!decl.delegate && !decl.initializer)) return;
    if (initializer.declarationIndex <= entry.declarationIndex)
      this.error(row, `プロパティ ${property.name} には、まだ値が入っていません。`);
  }

  /** The context of a class's initializer, or of the file's for top-level properties. */
  protected initializerContext(entry: { cls: ClassEntry | undefined; file: FileContext }): FunctionContext {
    const key = entry.cls ?? entry.file;
    let context = this.initializerContexts.get(key);
    if (!context) {
      const name = entry.cls ? entry.cls.symbol.name : '<init>';
      context = new FunctionContext(undefined, false, name, entry.file.isLibrary, undefined);
      context.info.showsThis = entry.cls !== undefined && !entry.cls.symbol.isObject && !entry.file.isLibrary;
      this.initializerContexts.set(key, context);
    }
    return context;
  }

  private initializerScopes = new Map<FunctionContext, Scope>();
  private constructorHeaderScopes = new WeakMap<Scope, Scope>();

  protected initializerScope(
    entry: { cls: ClassEntry | undefined; scope: Scope; file: FileContext },
    context: FunctionContext
  ): Scope {
    let scope = this.initializerScopes.get(context);
    if (scope) return scope;
    scope = new Scope(entry.cls ? entry.cls.scope : entry.scope, context);
    if (entry.cls) {
      scope.receiver = new ReceiverSymbol(
        this.thisTypeOf(entry.cls.symbol),
        context,
        entry.cls.symbol,
        entry.cls.symbol.name
      );
      const ctor = entry.cls.constructorSymbol;
      const headerScope = new Scope(scope, context);
      for (const [index, param] of (ctor?.params ?? []).entries()) {
        const declaration = entry.cls.decl.primaryConstructor?.params[index];
        const variable = this.newParameter(
          headerScope,
          context,
          param.name,
          param.type,
          declaration?.row ?? entry.cls.decl.row
        );
        if (declaration?.binding !== 'var') scope.variables.set(param.name, variable);
        this.flow.assigned.add(variable);
        this.initializerVariables.add(variable);
      }
      this.constructorHeaderScopes.set(scope, headerScope);
    }
    this.initializerScopes.set(context, scope);
    return scope;
  }

  /** The constructor parameters that class initializers see, which every initializer has assigned. */
  protected readonly initializerVariables = new Set<VariableSymbol>();

  private bindGlobal(entry: PropertyEntry): void {
    const { symbol } = entry;
    const slot = this.globalDefaults.length;
    this.globalDefaults.push(this.defaultValueOf(symbol.type));
    symbol.slot = slot;
    symbol.get = (frame) => frame.runtime.globals[slot];
    symbol.set = (frame, _receiver, value) => {
      frame.runtime.globals[slot] = value;
    };
  }

  /** The type of a property whose getter gives it, as `val isEmpty get() = size == 0` does. */
  private compileAccessorType(entry: PropertyEntry): KType {
    const body = entry.decl.getter?.body;
    if (body?.kind !== 'expression') this.error(entry.decl.row, `プロパティ ${entry.decl.name} の型を書いてください。`);
    const { context, scope } = this.accessorContext(entry, 'get');
    const compiled = this.compileExpression(scope, context, body.expression);
    return this.inferredResultType(compiled);
  }

  private accessorContext(entry: PropertyEntry, kind: 'get' | 'set'): { context: FunctionContext; scope: Scope } {
    const context = new FunctionContext(
      undefined,
      false,
      `${kind}-${entry.symbol.name}`,
      entry.file.isLibrary,
      undefined
    );
    Object.defineProperty(context, 'returnTarget', { value: context });
    context.info.showsThis = entry.cls !== undefined && !entry.cls.symbol.isObject && !entry.file.isLibrary;
    const scope = new Scope(entry.scope, context);
    this.addReceivers(scope, context, entry.cls, entry.symbol.extensionReceiver);
    const { slot } = entry.symbol;
    if (slot !== undefined) {
      const field = new VariableSymbol(
        'field',
        entry.symbol.type ?? anyType(true),
        entry.symbol.isVar,
        0,
        -1,
        entry.decl.row
      );
      field.owner = context;
      const storage = (frame: Frame): Value[] =>
        entry.cls ? (frame.thisValue as KObject).fields : frame.runtime.globals;
      field.delegateRead = (frame) => storage(frame)[slot];
      if (entry.symbol.isVar) {
        field.delegateWrite = (frame, value) => {
          storage(frame)[slot] = value;
        };
      }
      scope.variables.set('field', field);
      this.flow.assigned.add(field);
    }
    return { context, scope };
  }

  private compileGetter(entry: PropertyEntry): void {
    const { symbol, decl } = entry;
    const body = decl.getter?.body;
    if (!body) return;
    const { context, scope } = this.accessorContext(entry, 'get');
    const type = symbol.type as KType;
    context.returnType = type;
    context.returnRepr = propertyRepr(symbol);
    let run: Eval;
    if (body.kind === 'expression') {
      const compiled = this.compileExpression(scope, context, body.expression, type);
      run = convertRepr(
        this.expectType(compiled, type, body.expression.row),
        reprOf(this.core, type),
        propertyRepr(symbol)
      );
    } else {
      const compiled = this.compileStatementsValue(scope, context, body.block.statements, undefined, true, false);
      if (!this.flow.isDead) this.error(body.block.endRow, `get の最後に return を書いてください。`);
      const evaluate = compiled.eval;
      run = (frame) => {
        evaluate(frame);
        return UNIT;
      };
    }
    const { info } = context;
    const none: unknown[] = [];
    symbol.get = (frame, receiver) => frame.runtime.call(info, frame, none, receiver, [], undefined, run);
  }

  private compileSetter(entry: PropertyEntry): void {
    const { symbol, decl } = entry;
    const setter = decl.setter;
    if (!setter?.body) return;
    const { context, scope } = this.accessorContext(entry, 'set');
    const type = symbol.type as KType;
    context.returnType = this.core.unit.type;
    const value = this.newVariable(scope, context, setter.parameterName ?? 'value', type, false, setter.row);
    this.flow.assigned.add(value);
    const compiled =
      setter.body.kind === 'expression'
        ? this.compileForEffect(scope, context, setter.body.expression)
        : this.compileStatementsValue(scope, context, setter.body.block.statements, undefined, true, false);
    const evaluate = compiled.eval;
    const { info } = context;
    const none: unknown[] = [];
    symbol.set = (frame, receiver, newValue) => {
      frame.runtime.call(info, frame, none, receiver, [newValue], undefined, (inner) => {
        evaluate(inner);
        return UNIT;
      });
    };
  }

  /** A property delegated with `by`, whose delegate's `getValue` and `setValue` read and write it. */
  // code-gauge-allow functionNcss 42 -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private compileMemberDelegate(entry: PropertyEntry): void {
    const { symbol, decl } = entry;
    const context = this.initializerContext(entry);
    const scope = this.initializerScope(entry, context);
    const delegate = this.inPropertyInitializer(entry, context, () =>
      this.compileDelegateExpression(scope, context, decl.delegate as Expression, symbol.type, decl.isVar)
    );
    entry.initializer = delegate;
    const slot = entry.delegateSlot;
    const holderScope = new Scope(scope, context);
    const holder = new VariableSymbol('\0delegate', delegate.type, false, 0, -1, decl.row);
    holder.owner = context;
    const held = new Handoff<{ delegate: Value; value: Value }>();
    holder.delegateRead = () => held.get().delegate;
    holderScope.variables.set(holder.name, holder);
    this.flow.assigned.add(holder);
    const holderCompiled = this.compileName(holderScope, context, holder.name, decl.row);
    const thisArgument: ArgumentSyntax = entry.cls
      ? { row: decl.row, name: undefined, value: { kind: 'this', row: decl.row, label: undefined } }
      : { row: decl.row, name: undefined, value: { kind: 'null', row: decl.row } };
    const getter = this.compileDelegateCall(
      holderScope,
      context,
      holderCompiled,
      'getValue',
      [thisArgument, this.propertyReference(holderScope, decl.name, decl.row)],
      decl.row
    );
    if (!symbol.type) symbol.type = getter.type;
    else if (!isSubtype(getter.type, symbol.type)) this.error(decl.row, typeMismatchMessage(symbol.type, getter.type));
    const getEval = convertRepr(getter.eval, getter.repr, propertyRepr(symbol));
    // A top-level property's delegate lives in the globals, which the file's initializers fill when the run starts.
    const globalSlot = slot === undefined ? this.globalDefaults.length : undefined;
    if (globalSlot !== undefined) {
      entry.delegateGlobal = globalSlot;
      this.globalDefaults.push(undefined);
    }
    const readDelegate = (frame: Frame, receiver: Value): Value =>
      globalSlot === undefined ? (receiver as KObject).fields[slot as number] : frame.runtime.globals[globalSlot];
    const { info } = context;
    const none: unknown[] = [];
    const runHeld = (frame: Frame, receiver: Value, run: Eval, value?: Value): Value =>
      frame.runtime.call(info, frame, none, receiver, [], undefined, (inner) =>
        held.run(inner, { delegate: readDelegate(frame, receiver), value }, () => run(inner))
      );
    symbol.get = (frame, receiver) => runHeld(frame, receiver, getEval);
    if (decl.isVar) {
      const valueVariable = new VariableSymbol('\0value', symbol.type, false, 0, -1, decl.row);
      valueVariable.owner = context;
      valueVariable.delegateRead = () => held.get().value;
      holderScope.variables.set(valueVariable.name, valueVariable);
      this.flow.assigned.add(valueVariable);
      const setter = this.compileDelegateCall(
        holderScope,
        context,
        holderCompiled,
        'setValue',
        [
          thisArgument,
          this.propertyReference(holderScope, decl.name, decl.row),
          { row: decl.row, name: undefined, value: { kind: 'name', row: decl.row, name: '\0value' } },
        ],
        decl.row
      );
      const setEval = setter.eval;
      symbol.set = (frame, receiver, value) => {
        runHeld(frame, receiver, setEval, value);
      };
    }
  }

  // Classes' initializers.

  // code-gauge-allow functionNcss 35 -- the parts of a class's initializer, from the defaults to the constructor, which follow one another.
  private compileClassInitializer(entry: ClassEntry): void {
    const { symbol } = entry;
    if (symbol.isInterface || symbol.isNative) return;
    const owner = { cls: entry, scope: entry.scope, file: entry.file };
    const context = this.initializerContext(owner);
    const scope = this.initializerScope(owner, context);
    this.flow = new Flow();
    for (const variable of this.initializerVariables) this.flow.assigned.add(variable);
    const headerScope = this.constructorHeaderScopes.get(scope) ?? scope;
    const defaults = this.compileConstructorDefaults(entry, headerScope, context);
    const superCall = this.compileSuperConstructorCall(entry, headerScope, context);
    const steps = [
      ...this.compileFieldSteps(entry, headerScope, context),
      ...this.compileMemberSteps(entry, scope, context),
    ];
    this.checkValsInitialized(entry);
    if (symbol.kind === 'enum') this.compileEnumArguments(entry);
    const info = { ...context.info, isAtomic: entry.constructorSymbol?.isAtomic ?? false };
    const run = (frame: Frame): Value => {
      for (const [index, evaluate] of defaults.entries()) {
        if (evaluate && frame.locals[index] === MISSING) frame.locals[index] = evaluate(frame);
      }
      superCall?.(frame);
      for (const step of steps) step(frame);
      return UNIT;
    };
    const none: unknown[] = [];
    const initialize = (caller: Frame, instance: Value, args: Value[], callRow: number | undefined): void => {
      caller.runtime.call(info, caller, none, instance, args, callRow, run);
    };
    symbol.initialize = (frame, instance) => initialize(frame, instance, [], undefined);
    if (symbol.isObject) this.objectInitializers.set(symbol, initialize);
    else if (entry.constructorSymbol) this.bindConstructor(symbol, entry.constructorSymbol, initialize);
  }

  private compileConstructorDefaults(entry: ClassEntry, scope: Scope, context: FunctionContext): (Eval | undefined)[] {
    const params = entry.constructorSymbol?.params ?? [];
    const variables = params.map(({ name }) => scope.variables.get(name) as VariableSymbol);
    return this.compileParameterDefaults(
      entry.decl.primaryConstructor?.params ?? [],
      params,
      variables,
      scope,
      context
    );
  }

  /** A default can read the earlier parameters. The body starts with every parameter assigned. */
  private compileParameterDefaults(
    declarations: ParameterDecl[],
    params: ParameterSymbol[],
    variables: VariableSymbol[],
    scope: Scope,
    context: FunctionContext
  ): (Eval | undefined)[] {
    for (const variable of variables) this.flow.assigned.delete(variable);
    return params.map((param, index) => {
      const value = declarations[index]?.defaultValue;
      const evaluate =
        value && this.expectType(this.compileExpression(scope, context, value, param.type), param.type, value.row);
      if (evaluate) param.defaultValue = evaluate;
      this.flow.assigned.add(variables[index]);
      return evaluate;
    });
  }

  /** Stores the delegates of `by` and the properties of the primary constructor's parameters into their fields. */
  private compileFieldSteps(entry: ClassEntry, scope: Scope, context: FunctionContext): ((frame: Frame) => void)[] {
    const steps: ((frame: Frame) => void)[] = [];
    for (const field of entry.delegateFields) {
      const compiled = this.compileExpression(scope, context, field.spec.delegate, field.type);
      const evaluate = this.expectType(compiled, field.type, field.spec.row);
      const { slot } = field;
      steps.push((frame) => {
        (frame.thisValue as KObject).fields[slot] = evaluate(frame);
      });
    }
    for (const { symbol: property, index } of entry.parameterProperties) {
      const slot = property.slot as number;
      steps.push((frame) => {
        (frame.thisValue as KObject).fields[slot] = frame.locals[index] as Value;
      });
    }
    return steps;
  }

  /**
   * The property initializers and `init` blocks in the order they are written, where kotlinc rejects reading a property
   * by its name or through `this` before its initializer has run.
   */
  private compileMemberSteps(entry: ClassEntry, scope: Scope, context: FunctionContext): ((frame: Frame) => void)[] {
    const { symbol, decl } = entry;
    const uninitialized = new Set(
      decl.members.flatMap((member) =>
        member.kind === 'property' && (member.initializer || member.delegate)
          ? [this.findOwnProperty(symbol, member.name)]
          : []
      )
    );
    this.uninitializedProperties = { context, properties: uninitialized };
    const steps: ((frame: Frame) => void)[] = [];
    for (const member of decl.members) {
      if (member.kind === 'property') {
        const property = this.findOwnProperty(symbol, member.name);
        const step = this.compilePropertyStep(entry, member, property, scope, context);
        uninitialized.delete(property);
        if (step) steps.push(step);
      } else if (member.kind === 'init') {
        const evaluate = this.compileBlockValue(scope, context, member.block, undefined, true).eval;
        steps.push((frame) => {
          evaluate(frame);
        });
      }
    }
    this.uninitializedProperties = undefined;
    return steps;
  }

  /** The step that stores a property's initializer or delegate into its field, if it has one. */
  private compilePropertyStep(
    entry: ClassEntry,
    member: PropertyDecl,
    property: PropertySymbol,
    scope: Scope,
    context: FunctionContext
  ): ((frame: Frame) => void) | undefined {
    const propertyEntry = this.entryOfProperty.get(property) as PropertyEntry;
    if (member.delegate) {
      const delegate = this.compileDelegateExpression(
        scope,
        context,
        member.delegate,
        member.type ? property.type : undefined,
        member.isVar
      );
      const slot = propertyEntry.delegateSlot as number;
      const evaluate = delegate.eval;
      const store = (frame: Frame): void => {
        (frame.thisValue as KObject).fields[slot] = evaluate(frame);
      };
      return this.withStep(member.row, store, delegate.isCreation === true);
    }
    if (!member.initializer || property.slot === undefined) return undefined;
    const compiled = this.compileExpression(scope, context, member.initializer, property.type);
    const type = property.type as KType;
    const evaluate = convertRepr(
      this.expectType(compiled, type, member.initializer.row),
      reprOf(this.core, type),
      propertyRepr(property)
    );
    const slot = property.slot;
    const store = (frame: Frame): void => {
      (frame.thisValue as KObject).fields[slot] = evaluate(frame);
    };
    if (compiled.constant !== undefined) property.constantInitializer = compiled.constant;
    // An object's property initialized with a constant records no step, as a Java static field's does: the trace
    // shows the constant from the start.
    const isQuiet = entry.symbol.isObject && compiled.constant !== undefined;
    return isQuiet ? store : this.withStep(member.row, store, compiled.isCreation === true);
  }

  /** Makes a class's constructor create an instance and run the initializer on it, after its companion's. */
  private bindConstructor(
    symbol: ClassSymbol,
    ctor: FunctionSymbol,
    initialize: (caller: Frame, instance: Value, args: Value[], callRow: number | undefined) => void
  ): void {
    ctor.initialize = initialize;
    const fieldCount = (): number => symbol.fieldCount;
    const isAbstract = symbol.isAbstract;
    ctor.invoke = (caller, _receiver, args, callRow) => {
      if (isAbstract) return caller.runtime.throwError(caller, 'java.lang.InstantiationError', symbol.qualifiedName);
      this.ensureClassInitialized(caller, symbol);
      const instance = new KObject(symbol, fieldCount());
      caller.runtime.allocate(caller, instance.fields.length + 1);
      initialize(caller, instance, args, callRow);
      return instance;
    };
  }

  protected readonly objectInitializers = new Map<
    ClassSymbol,
    (caller: Frame, instance: Value, args: Value[], callRow: number | undefined) => void
  >();

  /** Rejects a `val` property that neither an initializer nor an `init` block gives a value. */
  private checkValsInitialized(entry: ClassEntry): void {
    for (const member of entry.decl.members) {
      // A property with accessors needs a value only when they use its backing field, which then has a slot.
      if (member.kind !== 'property' || member.initializer || member.delegate) continue;
      const property = this.findOwnProperty(entry.symbol, member.name);
      if (property.isAbstract || property.slot === undefined || property.isLateinit) continue;
      if (!this.flow.assigned.has(property)) {
        this.error(member.row, `プロパティ ${member.name} には初期値を書くか、init で値を入れてください。`);
      }
    }
  }

  protected mayInitializeVal(context: FunctionContext, symbol: PropertySymbol): boolean {
    if (!symbol.owner || symbol.slot === undefined) return false;
    const entry = this.entryOfProperty.get(symbol);
    if (!entry || entry.decl.initializer || entry.decl.delegate) return false;
    return this.initializerContexts.get(this.entryOfClass.get(symbol.owner) as ClassEntry) === context;
  }

  private compileSuperConstructorCall(
    entry: ClassEntry,
    scope: Scope,
    context: FunctionContext
  ): ((frame: Frame) => void) | undefined {
    const { symbol, decl } = entry;
    if (symbol.kind === 'enum') {
      const enumCtor = this.core.enum.constructors[0];
      return (frame) => {
        const instance = frame.thisValue as KObject;
        const native = instance.native as { name: string; ordinal: number };
        (enumCtor.initialize as NonNullable<FunctionSymbol['initialize']>)(
          frame,
          instance,
          [native.name, native.ordinal],
          undefined
        );
      };
    }
    const superclass = symbol.superclass;
    if (!superclass || superclass.cls === this.core.any) return undefined;
    if (superclass.cls.isNative && superclass.cls.constructors.length === 0) return undefined;
    const spec = decl.supers.find(
      (candidate) =>
        candidate.kind === 'constructorCall' &&
        this.resolveType(entry.scope, candidate.type).kind === 'class' &&
        (this.resolveType(entry.scope, candidate.type) as ClassType).cls === superclass.cls
    );
    const args: ArgumentSyntax[] =
      spec?.kind === 'constructorCall'
        ? spec.args.map((argument) => ({ row: argument.row, name: argument.name, value: argument.value }))
        : [];
    const candidates: Candidate[] = superclass.cls.constructors.map((ctor) => ({
      symbol: ctor,
      kind: 'constructor',
      substitution: substitutionOf(superclass),
      receiverType: undefined,
    }));
    if (candidates.length === 0) this.error(decl.row, `${superclass.cls.name} のコンストラクタを呼べません。`);
    const savedRecords = this.recordsSteps;
    const call = this.resolveCall(
      scope,
      context,
      [candidates],
      args,
      false,
      [],
      undefined,
      undefined,
      spec?.row ?? decl.row,
      superclass.cls.name
    );
    this.recordsSteps = savedRecords;
    // A superclass constructor called without arguments, as in `: MyTurtle()`, is part of the step of the
    // constructor that calls it, as Java's implicit `super()` is.
    const isExplicit = spec?.kind === 'constructorCall' && spec.args.length > 0;
    const initializer = this.superInitializer(
      call,
      isExplicit && this.recordsSteps && !entry.file.isLibrary ? spec.row : undefined
    );
    return (frame) => initializer(frame, frame.thisValue);
  }

  /** Runs the superclass's constructor on the instance being created, with the arguments the subclass passes. */
  protected abstract superInitializer(
    call: ResolvedCall,
    callRow: number | undefined
  ): (frame: Frame, instance: Value) => void;

  // Objects and enums.

  objectInstance(cls: ClassSymbol): (frame: Frame) => Value {
    const owner = cls.kind === 'companion' ? (cls.outer ?? cls) : cls;
    return (frame) => {
      this.ensureClassInitialized(frame, owner);
      return frame.runtime.objects.get(cls);
    };
  }

  protected ensureClassInitialized(frame: Frame, cls: ClassSymbol): void {
    frame.runtime.initializeClass(frame, cls, () => {
      if (!cls.isInterface) this.initializeClassParents(frame, cls);
      cls.initializeEnumEntries?.(frame);
      if (cls.isObject) this.createObject(frame, cls);
      if (cls.companion) this.createObject(frame, cls.companion);
    });
  }

  private initializeClassParents(frame: Frame, cls: ClassSymbol): void {
    if (cls.superclass) this.ensureClassInitialized(frame, cls.superclass.cls);
    const seen = new Set<ClassSymbol>();
    const visit = (parent: ClassSymbol): void => {
      if (seen.has(parent) || parent.isLibrary) return;
      seen.add(parent);
      for (const { cls } of parent.interfaces) visit(cls);
      if ([...parent.members.values()].some((members) => members.some((member) => this.contributesJvmDefault(member))))
        this.ensureClassInitialized(frame, parent);
    };
    for (const { cls: parent } of cls.interfaces) visit(parent);
  }

  private createObject(frame: Frame, cls: ClassSymbol): void {
    const instance = new KObject(cls);
    frame.runtime.objects.set(cls, instance);
    const initialize = this.objectInitializers.get(cls);
    if (initialize) initialize(frame, instance, [], undefined);
    else cls.initialize?.(frame, instance);
  }

  private createEnumEntries(
    frame: Frame,
    cls: ClassSymbol,
    ctor: FunctionSymbol,
    evaluators: ((frame: Frame) => Value[])[]
  ): void {
    const instances: KObject[] = [];
    frame.runtime.enumEntries.set(cls, instances);
    const initialize = ctor.initialize as NonNullable<FunctionSymbol['initialize']>;
    for (const [ordinal, enumEntry] of cls.enumEntries.entries()) {
      const instance = new KObject(cls);
      instance.native = { name: enumEntry.name, ordinal };
      instances.push(instance);
      initialize(frame, instance, evaluators[ordinal](frame), undefined);
    }
  }

  /** Compiles the arguments each enum constant passes to its class's constructor, as `RED(0xFF0000)` does. */
  private compileEnumArguments(entry: ClassEntry): void {
    const ctor = entry.constructorSymbol as FunctionSymbol;
    const context = new FunctionContext(
      undefined,
      false,
      `${entry.symbol.name}-entries`,
      entry.file.isLibrary,
      undefined
    );
    const scope = new Scope(entry.scope, context);
    const candidates: Candidate[] = [
      { symbol: ctor, kind: 'constructor', substitution: new Map(), receiverType: undefined },
    ];
    const savedRecords = this.recordsSteps;
    this.recordsSteps = false;
    try {
      const evaluators = entry.decl.enumEntries.map((enumEntry) => {
        const args: ArgumentSyntax[] = enumEntry.args.map((argument) => ({
          row: argument.row,
          name: argument.name,
          value: argument.value,
        }));
        return this.resolveCall(
          scope,
          context,
          [candidates],
          args,
          false,
          [],
          undefined,
          undefined,
          enumEntry.row,
          enumEntry.name
        ).evaluateArgs;
      });
      entry.symbol.initializeEnumEntries = (frame) => this.createEnumEntries(frame, entry.symbol, ctor, evaluators);
    } finally {
      this.recordsSteps = savedRecords;
    }
  }

  protected compileEnumEntries(cls: ClassSymbol): Compiled {
    const instance = this.objectInstance(cls);
    const entries = this.enumEntriesValue(cls);
    return {
      type: {
        kind: 'class',
        cls: this.enumEntriesClass(),
        args: [{ variance: 'inv', type: cls.type }],
        nullable: false,
      },
      repr: 'ref',
      eval: (frame) => {
        instance(frame);
        return entries(frame, frame.runtime.enumEntries.get(cls) ?? []);
      },
    };
  }

  /** The class of `entries`, a read-only list of an enum class's constants. */
  protected abstract enumEntriesClass(): ClassSymbol;

  protected abstract enumEntriesValue(cls: ClassSymbol): (frame: Frame, entries: KObject[]) => Value;
}
