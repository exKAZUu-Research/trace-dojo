// code-gauge-allow-file fileNcss -- the compiler of one area of Kotlin, whose parts call each other closely.
import type { Expression, ParameterDecl, PropertyDecl, SecondaryConstructorDecl } from './ast';
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
import { setReifiedAccess } from './reified';
import { Frame, type FunctionInfo, MISSING, UNASSIGNED } from './runtime';
import type { ClassSymbol, FunctionSymbol, ParameterSymbol, PropertySymbol } from './symbols';
import { VariableSymbol } from './symbols';
import { TailCallSignal, tailCallsOf } from './tailCalls';
import { anyType, isSameType, isSubtype, substitutionOf } from './typeRelations';
import { type ClassType, isNonNullClass, type KType, resolved } from './types';
import { uninitializedCheck } from './uninitialized';
import { KObject, UNIT, type Value } from './values';

/** Compiles the bodies of functions, the accessors and initializers of properties, and the initializers of classes and objects. */
/**
 * The frame of what a class declared in a function body captured for an instance, made when the instance is first
 * initialized from what the declaration stored in the frame that ran it, which a caller's frames lead to.
 */
function localFrameOf(
  caller: Frame,
  instance: KObject,
  cls: ClassSymbol,
  local: { context: FunctionContext; declaringInfo: FunctionInfo; envSlot: number }
): Frame {
  const existing = instance.localFrames?.get(cls) as Frame | undefined;
  if (existing) return existing;
  let declaring: Frame | undefined = caller;
  while (declaring && declaring.info !== local.declaringInfo) declaring = declaring.enclosing;
  if (!declaring) throw new Error(`The class ${cls.name} was used outside the code that declares it`);
  const frame = new Frame(
    caller.runtime,
    local.context.info,
    declaring.locals[local.envSlot] as unknown as unknown[],
    instance,
    undefined
  );
  frame.enclosing = declaring;
  instance.localFrames ??= new Map();
  instance.localFrames.set(cls, frame);
  return frame;
}

/** Runs a `tailrec` function's body again in its frame with the arguments of each tail call it makes of itself. */
function restartingOnTailCalls(run: Eval): Eval {
  return (frame) => {
    for (;;) {
      try {
        return run(frame);
      } catch (error) {
        if (!(error instanceof TailCallSignal) || error.frame !== frame) throw error;
        frame.locals.fill(UNASSIGNED);
        for (const [index, value] of error.args.entries()) frame.locals[index] = value;
        frame.runtime.spend();
      }
    }
  };
}

export abstract class BodyCompiler extends DeclarationCompiler {
  // Phase 4: bodies.

  protected compileBodies(): void {
    for (const entry of this.propertyEntries) this.ensurePropertyCompiled(entry);
    // The defaults need the types of the fields, which inferred properties have only now.
    for (const entry of this.classEntries) this.setFieldDefaults(entry.symbol);
    for (const entry of this.functionEntries) this.ensureFunctionCompiled(entry);
    this.validateOverrideTypes();
    this.validateJvmSignatures();
    for (const entry of this.classEntries) {
      if (this.classesCompiledInScope.has(entry)) continue;
      this.file = entry.file;
      this.compileClassInitializer(entry);
    }
  }

  private readonly laidOutClasses = new Set<ClassSymbol>();

  /** Lays out a class's fields after its superclass's, with the JVM's default value of each field's type. */
  private setFieldDefaults(cls: ClassSymbol): void {
    const entry = this.entryOfClass.get(cls);
    if (!entry || this.laidOutClasses.has(cls)) return;
    this.laidOutClasses.add(cls);
    if (cls.superclass) this.setFieldDefaults(cls.superclass.cls);
    this.layOutFields(entry);
    const defaults: Value[] = [...(cls.superclass?.cls.fieldDefaults ?? [])];
    defaults.length = cls.fieldCount;
    for (const property of cls.ownFields) defaults[property.slot as number] = this.defaultValueOf(property.type);
    cls.fieldDefaults = defaults;
  }

  /** The classes compiled where a function body or an object expression declares them, which the phases skip. */
  private readonly classesCompiledInScope = new Set<ClassEntry>();

  /** What a class declared in a function body captures, which its members read when they run. */
  protected readonly localClasses = new Map<
    ClassSymbol,
    { context: FunctionContext; declaringInfo: FunctionInfo; envSlot: number }
  >();

  /**
   * Compiles the classes a function body or an object expression declares, there, with the bodies of their members,
   * whose contexts capture what they read through their class's capture context.
   */
  protected compileClassesInScope(entries: ClassEntry[]): void {
    const savedFlow = this.flow;
    const savedFile = this.file;
    const savedBase = this.localFlowBase;
    this.localFlowBase = savedFlow.copy();
    try {
      for (const entry of entries) this.classesCompiledInScope.add(entry);
      for (const entry of this.propertyEntries)
        if (entry.cls && entries.includes(entry.cls)) this.ensurePropertyCompiled(entry);
      for (const entry of entries) this.setFieldDefaults(entry.symbol);
      for (const entry of this.functionEntries)
        if (entry.cls && entries.includes(entry.cls)) this.ensureFunctionCompiled(entry);
      this.validateOverrideTypes();
      for (const entry of entries) {
        this.file = entry.file;
        this.compileClassInitializer(entry);
      }
    } finally {
      this.flow = savedFlow;
      this.file = savedFile;
      this.localFlowBase = savedBase;
    }
  }

  /** The flow around a local class's declaration, whose assigned variables its members may read. */
  private localFlowBase: Flow | undefined;

  /** The capture context of a class declared in a function body, the parent of its members' contexts. */
  protected captureParentOf(cls: ClassSymbol | undefined): FunctionContext | undefined {
    return cls ? this.localClasses.get(cls)?.context : undefined;
  }

  /**
   * What a member of a class declared in a function body runs with: what its context captured, built from the frame
   * of what the class captured, which an instance gets when it is created, and that frame, which leads to the frame
   * that declared the class.
   */
  protected localCapture(
    cls: ClassSymbol | undefined,
    context: FunctionContext
  ): ((caller: Frame, receiver: Value) => { captured: unknown[]; enclosing: Frame | undefined }) | undefined {
    const local = cls && this.localClasses.get(cls);
    if (!local) return undefined;
    const build = this.captureBuilder(local.context, context);
    return (caller, receiver) => {
      const frame = localFrameOf(caller, receiver as KObject, cls, local);
      return { captured: build(frame), enclosing: frame };
    };
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

  /** Starts the flow of code compiled on its own, where only the constructor parameters initializers see are assigned. */
  protected startFlow(): void {
    this.flow = new Flow();
    for (const variable of this.localFlowBase?.assigned ?? []) this.flow.assigned.add(variable);
    for (const variable of this.initializerVariables) this.flow.assigned.add(variable);
  }

  /**
   * Compiles an entry in its own file and flow. A failure leaves the entry pending, as a probe that swallows the
   * error, such as one choosing an overload, must not make a later compilation of it look recursive.
   */
  private withSavedState<T>(entry: FunctionEntry | PropertyEntry, compile: () => T): T {
    const { file } = entry;
    const savedFile = this.file;
    const savedFlow = this.flow;
    const savedInitialization = this.uninitializedProperties;
    this.file = file;
    this.startFlow();
    this.uninitializedProperties = undefined;
    try {
      return this.withOptIns([...this.classOptIns(entry.cls?.symbol), ...entry.symbol.optIns], compile);
    } catch (error) {
      entry.state = 'pending';
      throw error;
    } finally {
      this.file = savedFile;
      this.flow = savedFlow;
      this.uninitializedProperties = savedInitialization;
    }
  }

  // code-gauge-allow functionNcss -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  // code-gauge-allow duplicateLines -- the copies compile the same Kotlin construct in different contexts, whose differences sit between the shared lines.
  private ensureFunctionCompiled(entry: FunctionEntry): void {
    if (entry.state !== 'pending') return;
    entry.state = 'compiling';
    this.withSavedState(entry, () => {
      const { decl, symbol } = entry;
      const context = new FunctionContext(
        this.captureParentOf(entry.cls?.symbol),
        false,
        symbol.name,
        entry.file.isLibrary,
        undefined
      );
      Object.defineProperty(context, 'returnTarget', { value: context });
      context.label = symbol.name;
      if (symbol.isTailrec && decl.body)
        context.tailrec = { symbol, calls: tailCallsOf(decl.body, isNonNullClass(symbol.returnType, this.core.unit)) };
      context.info.isAtomic = symbol.isAtomic;
      let base = this.withOuterReceivers(entry.scope, entry.cls?.symbol, context);
      // An extension declared in a class sees the class's instance, which calls pass, around its extension receiver.
      const dispatch =
        entry.cls && symbol.extensionReceiver && !(entry.cls.symbol.isObject && entry.cls.file.isLibrary)
          ? new ReceiverSymbol(this.thisTypeOf(entry.cls.symbol), context, entry.cls.symbol, entry.cls.symbol.name)
          : undefined;
      if (dispatch) {
        base = new Scope(base, context);
        base.receiver = dispatch;
      }
      const scope = new Scope(base, context);
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
      for (const [index, param] of symbol.contextParameters.entries()) {
        const declared = decl.modifiers.contextParameters?.[index];
        const variable = this.newParameter(
          scope,
          context,
          param.name === '_' ? undefined : param.name,
          param.type,
          declared?.row ?? decl.row
        );
        variable.isContextParameter = true;
        this.flow.assigned.add(variable);
        if (param.name === '_') scope.variables.set(`\0context${index}`, variable);
      }
      if (dispatch) {
        dispatch.slot = context.allocate('\0dispatchReceiver', dispatch.type, false);
        symbol.passesDispatchReceiver = true;
      }
      const reified = symbol.typeParameters.filter((param) => param.isReified);
      if (reified.length > 0 && decl.body) {
        // A call passes the reified type arguments after the arguments, in the frame's next slot.
        const slot = context.allocate('\0typeArguments', this.core.any.type, false);
        for (const [index, param] of reified.entries()) setReifiedAccess(param, { info: context.info, slot, index });
        symbol.passesTypeArguments = true;
      }
      const defaults = this.compileParameterDefaults(decl.params, symbol.params, variables, scope, context);
      symbol.defaultsInfo = context.info;
      if (!decl.body) {
        entry.state = 'done';
        return;
      }
      if (symbol.isSuspend) {
        context.isSuspend = true;
        this.compileSuspendFunction(entry, scope, context, defaults);
        entry.state = 'done';
        return;
      }
      let body: Eval;
      if (decl.body.kind === 'expression') {
        body = this.compileExpressionBody(symbol, decl.body.expression, scope, context);
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

  /** Compiles a suspend function's body as a coroutine's steps, which its `invokeSuspend` runs. */
  protected abstract compileSuspendFunction(
    entry: FunctionEntry,
    scope: Scope,
    context: FunctionContext,
    defaults: (Eval | undefined)[]
  ): void;

  /** The type a `vararg` parameter has inside its function: an array of its elements. */
  protected abstract varargType(elementType: KType): KType;

  /**
   * The type a declaration infers from an object expression: its anonymous type only when the declaration is private,
   * and otherwise the one supertype it names, or `Any`.
   */
  protected approximatedDeclarationType(type: KType, visibility: string): KType {
    if (visibility === 'private' || type.kind !== 'class' || !type.cls.isAnonymous) return type;
    const supertypes = type.cls.supertypes.filter((supertype) => supertype.cls !== this.core.any);
    const approximated = supertypes.length === 1 ? supertypes[0] : this.core.any.type;
    return type.nullable ? { ...approximated, nullable: true } : approximated;
  }

  private inferredResultType(compiled: Compiled): KType {
    const type = resolved(compiled.type);
    if (compiled.integerLiteral) return this.primitiveType(this.primitiveOf(type) ?? 'Int');
    return type;
  }

  /**
   * The scope that sees the instances of the classes around an inner class as implicit receivers, nearest first, as
   * `this@Outer` names them, after the inner class's own instance.
   */
  protected withOuterReceivers(base: Scope, cls: ClassSymbol | undefined, context: FunctionContext): Scope {
    const outers: { cls: ClassSymbol; path: ClassSymbol[] }[] = [];
    let path: ClassSymbol[] = [];
    for (let current = cls; current?.isInner && current.outer; current = current.outer) {
      path = [...path, current];
      outers.push({ cls: current.outer, path });
    }
    let scope = base;
    for (const outer of outers.toReversed()) {
      scope = new Scope(scope, context);
      scope.receiver = new ReceiverSymbol(this.thisTypeOf(outer.cls), context, outer.cls, outer.cls.name, outer.path);
    }
    return scope;
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
    const runs = symbol.isTailrec ? restartingOnTailCalls(run) : run;
    const local = this.localCapture(symbol.owner, context);
    symbol.invoke = local
      ? (caller, receiver, args, callRow) => {
          const { captured, enclosing } = local(caller, receiver);
          return caller.runtime.call(info, caller, captured, receiver, args, callRow, runs, enclosing);
        }
      : (caller, receiver, args, callRow) => caller.runtime.call(info, caller, none, receiver, args, callRow, runs);
  }

  private compileExpressionBody(
    symbol: FunctionSymbol,
    expression: Expression,
    scope: Scope,
    context: FunctionContext
  ): Eval {
    // A declared result type also checks the returns inside the body, as `= if (c) return x else 0` has.
    const declared = symbol.returnType !== undefined;
    if (symbol.returnType) {
      context.returnType = symbol.returnType;
      context.returnRepr = returnRepr(symbol);
    }
    const compiled = this.compileExpression(scope, context, expression, symbol.returnType);
    symbol.returnType ??= this.approximatedDeclarationType(this.inferredResultType(compiled), symbol.visibility);
    // The returns of an inferred body must fit the type its value gives, as a declared one checks them as they compile.
    const returnType = symbol.returnType;
    const misfit = context.returnedTypes.find((type) => !isSubtype(type, returnType));
    if (misfit) this.error(expression.row, typeMismatchMessage(returnType, misfit));
    if (!declared) this.rejectDirectReturn(context, expression.row);
    for (const settle of context.inferredReturns) settle(returnRepr(symbol));
    context.returnType = symbol.returnType;
    return convertRepr(
      this.expectType(compiled, symbol.returnType, expression.row),
      reprOf(this.core, symbol.returnType),
      returnRepr(symbol)
    );
  }

  private ensurePropertyCompiled(entry: PropertyEntry): void {
    if (entry.state !== 'pending') return;
    entry.state = 'compiling';
    this.withSavedState(entry, () => {
      const { decl, symbol } = entry;
      // Initializers run in the class's initializer, whose scope sees the primary constructor's parameters.
      if (decl.initializer && !symbol.type) {
        const context = this.initializerContext(entry);
        const scope = this.initializerScope(entry, context);
        const compiled = this.inPropertyInitializer(entry, context, () =>
          this.compileExpression(scope, context, decl.initializer as Expression)
        );
        const type = this.approximatedDeclarationType(resolved(compiled.type), symbol.visibility);
        symbol.type = compiled.integerLiteral ? this.primitiveType(this.primitiveOf(type) ?? 'Int') : type;
      }
      if (decl.delegate) this.compileMemberDelegate(entry);
      else if (!symbol.type && decl.getter?.body) {
        symbol.type = this.compileAccessorType(entry);
      }
      if (decl.getter?.body) this.withSavedState(entry, () => this.compileGetter(entry));
      if (decl.setter?.body) this.withSavedState(entry, () => this.compileSetter(entry));
      this.validatePropertyStorage(entry);
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
    if (decl.modifiers.keywords.has('const') || (!decl.delegate && !decl.initializer)) return;
    if (initializer.declarationIndex <= entry.declarationIndex)
      this.error(row, `プロパティ ${property.name} には、まだ値が入っていません。`);
  }

  /** The context of a class's initializer, or of the file's for top-level properties. */
  protected initializerContext(entry: { cls: ClassEntry | undefined; file: FileContext }): FunctionContext {
    const key = entry.cls ?? entry.file;
    let context = this.initializerContexts.get(key);
    if (!context) {
      const name = entry.cls ? entry.cls.symbol.name : '<init>';
      context = new FunctionContext(
        this.captureParentOf(entry.cls?.symbol),
        false,
        name,
        entry.file.isLibrary,
        undefined
      );
      context.forbidsReturn = true;
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
    scope = new Scope(
      entry.cls ? this.withOuterReceivers(entry.cls.scope, entry.cls.symbol, context) : entry.scope,
      context
    );
    if (entry.cls) {
      scope.receiver = new ReceiverSymbol(
        this.thisTypeOf(entry.cls.symbol),
        context,
        entry.cls.symbol,
        entry.cls.symbol.name
      );
      const ctor = entry.cls.constructorSymbol;
      // The header's names do not reach the instance it builds, as in Kotlin.
      const headerScope = new Scope(entry.cls.scope, context);
      for (const [index, param] of (ctor?.params ?? []).entries()) {
        const declaration = entry.cls.decl.primaryConstructor?.params[index];
        const variable = this.newParameter(
          headerScope,
          context,
          param.name,
          param.type,
          declaration?.row ?? entry.cls.decl.row
        );
        if (!declaration?.binding) scope.variables.set(param.name, variable);
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

  private validatePropertyStorage(entry: PropertyEntry): void {
    const { decl, symbol } = entry;
    if (entry.cls?.symbol.isValue && !entry.file.isLibrary && this.hasBackingField(decl, symbol))
      this.error(decl.row, 'value class には、値を保持するプロパティを追加できません。');
    if (!this.hasBackingField(decl, symbol)) {
      if (decl.initializer && !decl.modifiers.keywords.has('external'))
        this.error(decl.row, `バッキングフィールドを持たないプロパティ ${decl.name} には初期値を書けません。`);
      return;
    }
    if (entry.cls) return;
    if (!decl.initializer && !symbol.isLateinit)
      this.error(decl.row, `プロパティ ${decl.name} には初期値を書いてください。`);
    this.bindGlobal(entry);
  }

  private bindGlobal(entry: PropertyEntry): void {
    const { symbol } = entry;
    const slot = this.globalDefaults.length;
    this.globalDefaults.push(this.defaultValueOf(symbol.type));
    symbol.slot = slot;
    const { name } = symbol;
    symbol.get ??= symbol.isLateinit
      ? (frame) => uninitializedCheck(frame, frame.runtime.globals[slot], name)
      : (frame) => frame.runtime.globals[slot];
    symbol.set ??= (frame, _receiver, value) => {
      frame.runtime.globals[slot] = value;
    };
  }

  /** The type of a property whose getter gives it, as `val isEmpty get() = size == 0` does. */
  private compileAccessorType(entry: PropertyEntry): KType {
    const body = entry.decl.getter?.body;
    if (body?.kind !== 'expression') this.error(entry.decl.row, `プロパティ ${entry.decl.name} の型を書いてください。`);
    const { context, scope } = this.accessorContext(entry, 'get', true);
    const compiled = this.compileExpression(scope, context, body.expression);
    this.rejectDirectReturn(context, body.expression.row);
    return this.inferredResultType(compiled);
  }

  /** A `return` written directly in an expression body needs a declared result type, as kotlinc requires. */
  private rejectDirectReturn(context: FunctionContext, row: number): void {
    if (context.hasDirectReturn) this.error(row, '= の後の式で return を使うときは、戻り値の型を書いてください。');
  }

  private accessorContext(
    entry: PropertyEntry,
    kind: 'get' | 'set',
    isProbe = false
  ): { context: FunctionContext; scope: Scope } {
    const context = new FunctionContext(
      this.captureParentOf(entry.cls?.symbol),
      false,
      `${kind}-${entry.symbol.name}`,
      entry.file.isLibrary,
      undefined,
      isProbe
    );
    Object.defineProperty(context, 'returnTarget', { value: context });
    context.info.showsThis = entry.cls !== undefined && !entry.cls.symbol.isObject && !entry.file.isLibrary;
    const scope = new Scope(this.withOuterReceivers(entry.scope, entry.cls?.symbol, context), context);
    this.addReceivers(scope, context, entry.cls, entry.symbol.extensionReceiver);
    if (this.canHaveBackingField(entry.decl, entry.symbol)) {
      const field = new VariableSymbol(
        'field',
        entry.symbol.type ?? anyType(true),
        entry.symbol.isVar,
        0,
        -1,
        entry.decl.row
      );
      field.owner = context;
      field.backingField = { property: entry.symbol, receiver: scope.receiver };
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
      if (!this.flow.isDead && !isNonNullClass(type, this.core.unit))
        this.error(body.block.endRow, `get の最後に return を書いてください。`);
      const evaluate = compiled.eval;
      run = (frame) => {
        evaluate(frame);
        return UNIT;
      };
    }
    const { info } = context;
    const none: unknown[] = [];
    const local = this.localCapture(entry.cls?.symbol, context);
    symbol.get = local
      ? (frame, receiver) => {
          const { captured, enclosing } = local(frame, receiver);
          return frame.runtime.call(info, frame, captured, receiver, [], undefined, run, enclosing);
        }
      : (frame, receiver) => frame.runtime.call(info, frame, none, receiver, [], undefined, run);
  }

  private compileSetter(entry: PropertyEntry): void {
    const { symbol, decl } = entry;
    const setter = decl.setter;
    if (!setter?.body) return;
    const { context, scope } = this.accessorContext(entry, 'set');
    const type = symbol.type as KType;
    if (setter.type && !isSameType(type, this.resolveType(scope, setter.type)))
      this.error(setter.row, `set の引数の型は、プロパティ ${symbol.name} の型と同じでなければなりません。`);
    context.returnType = this.core.unit.type;
    const value = this.newParameter(scope, context, setter.parameterName ?? 'value', type, setter.row);
    this.flow.assigned.add(value);
    const compiled =
      setter.body.kind === 'expression'
        ? this.compileForEffect(scope, context, setter.body.expression)
        : this.compileStatementsValue(scope, context, setter.body.block.statements, undefined, true, false);
    const evaluate = compiled.eval;
    const { info } = context;
    const none: unknown[] = [];
    const local = this.localCapture(entry.cls?.symbol, context);
    symbol.set = (frame, receiver, newValue) => {
      const { captured, enclosing } = local?.(frame, receiver) ?? { captured: none, enclosing: undefined };
      frame.runtime.call(
        info,
        frame,
        captured,
        receiver,
        [newValue],
        undefined,
        (inner) => {
          evaluate(inner);
          return UNIT;
        },
        enclosing
      );
    };
  }

  /** A property delegated with `by`, whose delegate's `getValue` and `setValue` read and write it. */
  // code-gauge-allow functionNcss -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private compileMemberDelegate(entry: PropertyEntry): void {
    const { symbol, decl } = entry;
    const context = this.initializerContext(entry);
    const scope = this.initializerScope(entry, context);
    const delegate = this.inPropertyInitializer(entry, context, () =>
      this.compileDelegateExpression(scope, context, decl.delegate as Expression, symbol.type, decl.isVar)
    );
    entry.initializer = delegate;
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
    const globalSlot = entry.cls ? undefined : this.globalDefaults.length;
    if (globalSlot !== undefined) {
      entry.delegateGlobal = globalSlot;
      this.globalDefaults.push(undefined);
    }
    const readDelegate = (frame: Frame, receiver: Value): Value =>
      globalSlot === undefined
        ? (receiver as KObject).fields[entry.delegateSlot as number]
        : frame.runtime.globals[globalSlot];
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

  private compileClassInitializer(entry: ClassEntry): void {
    this.withOptIns(this.classOptIns(entry.symbol), () => this.compileClassInitializerOpted(entry));
  }

  // code-gauge-allow functionNcss -- the parts of the construct this function compiles follow one another, and splitting them would only rename them.
  // code-gauge-allow functionCognitiveComplexity -- each branch is one case of the Kotlin rule this function implements, and they read best side by side.
  private compileClassInitializerOpted(entry: ClassEntry): void {
    const { symbol } = entry;
    if (symbol.isInterface || symbol.isNative) return;
    const owner = { cls: entry, scope: entry.scope, file: entry.file };
    const context = this.initializerContext(owner);
    const scope = this.initializerScope(owner, context);
    this.flow = new Flow();
    for (const variable of this.initializerVariables) this.flow.assigned.add(variable);
    const headerScope = this.constructorHeaderScopes.get(scope) ?? scope;
    // Without a primary constructor, each `constructor(...)` calls the superclass's own constructor.
    const delegatesToSecondaries = !entry.decl.primaryConstructor && entry.secondaryConstructors.length > 0;
    const { defaults, superCall, fieldSteps } = this.compileConstructorHeader(
      entry,
      scope,
      headerScope,
      context,
      delegatesToSecondaries
    );
    const steps = [...fieldSteps, ...this.compileMemberSteps(entry, scope, context)];
    const initializedFlow = this.flow.copy();
    if (!delegatesToSecondaries) this.checkValsInitialized(entry);
    if (symbol.kind === 'enum') this.compileEnumArguments(entry);
    const { info } = context;
    info.isAtomic = entry.constructorSymbol?.isAtomic ?? false;
    const run = (frame: Frame): Value => {
      for (const [index, evaluate] of defaults.entries()) {
        if (evaluate && frame.locals[index] === MISSING) frame.locals[index] = evaluate(frame);
      }
      superCall?.(frame);
      for (const step of steps) step(frame);
      return UNIT;
    };
    const none: unknown[] = [];
    const local = this.localCapture(symbol, context);
    const initialize = (caller: Frame, instance: Value, args: Value[], callRow: number | undefined): void => {
      const { captured, enclosing } = local?.(caller, instance) ?? { captured: none, enclosing: undefined };
      caller.runtime.call(info, caller, captured, instance, args, callRow, run, enclosing);
    };
    symbol.initialize = (frame, instance) => initialize(frame, instance, [], undefined);
    if (symbol.isObject) this.objectInitializers.set(symbol, initialize);
    else if (entry.constructorSymbol && !delegatesToSecondaries)
      this.bindConstructor(symbol, entry.constructorSymbol, initialize);
    this.compileSecondaryConstructors(entry, delegatesToSecondaries ? { steps, flow: initializedFlow } : undefined);
  }

  /**
   * Compiles each `constructor(...)`: its parameters' defaults, the constructor it delegates to, and its body. Without
   * a primary constructor, a delegation to the superclass then runs the class's property initializers and `init`
   * blocks, as `classSteps` does, before the body.
   */
  private compileSecondaryConstructors(
    entry: ClassEntry,
    classSteps: { steps: ((frame: Frame) => void)[]; flow: Flow } | undefined
  ): void {
    const targets = new Map<FunctionSymbol, FunctionSymbol>();
    for (const { decl, symbol: ctor } of entry.secondaryConstructors) {
      this.file = entry.file;
      const context = new FunctionContext(
        this.captureParentOf(entry.symbol),
        false,
        entry.symbol.name,
        entry.file.isLibrary,
        undefined
      );
      Object.defineProperty(context, 'returnTarget', { value: context });
      context.returnType = this.core.unit.type;
      context.returnRepr = 'ref';
      context.info.isAtomic = ctor.isAtomic;
      context.info.showsThis = !entry.file.isLibrary;
      this.secondaryConstructorContexts.set(context, entry);
      const base = this.withOuterReceivers(entry.scope, entry.symbol, context);
      const headerScope = new Scope(base, context);
      this.flow = new Flow();
      const variables = ctor.params.map((param, index) => {
        const variable = this.newParameter(headerScope, context, param.name, param.type, decl.params[index].row);
        this.flow.assigned.add(variable);
        return variable;
      });
      const thisType = this.thisTypeOf(entry.symbol);
      this.headerInstance = thisType;
      let delegate: ((frame: Frame, instance: Value) => void) | undefined;
      let defaults: (Eval | undefined)[];
      try {
        defaults = this.compileParameterDefaults(decl.params, ctor.params, variables, headerScope, context);
        delegate = this.compileConstructorDelegation(entry, ctor, decl, headerScope, context, targets);
      } finally {
        this.headerInstance = undefined;
      }
      if (classSteps && decl.delegation?.kind !== 'this')
        for (const assigned of classSteps.flow.assigned) this.flow.assigned.add(assigned);
      // The constructor `this(...)` calls has initialized every property, which the body may not assign again.
      if (decl.delegation?.kind === 'this')
        for (const property of entry.symbol.ownFields) {
          this.flow.assigned.add(property);
          this.flow.maybeAssigned.add(property);
        }
      const bodyScope = new Scope(headerScope, context);
      bodyScope.receiver = new ReceiverSymbol(thisType, context, entry.symbol, entry.symbol.name);
      const body = this.compileStatementsValue(
        bodyScope,
        context,
        decl.body?.statements ?? [],
        undefined,
        true,
        false
      ).eval;
      if (classSteps && decl.delegation?.kind !== 'this') this.checkValsInitialized(entry);
      const steps = classSteps && decl.delegation?.kind !== 'this' ? classSteps.steps : [];
      const fillsDefaults = defaults.some((evaluate) => evaluate !== undefined);
      const run = (frame: Frame): Value => {
        if (fillsDefaults)
          for (const [index, evaluate] of defaults.entries()) {
            if (evaluate && frame.locals[index] === MISSING) frame.locals[index] = evaluate(frame);
          }
        delegate?.(frame, frame.thisValue);
        for (const step of steps) step(frame);
        body(frame);
        return UNIT;
      };
      const none: unknown[] = [];
      const local = this.localCapture(entry.symbol, context);
      this.bindConstructor(entry.symbol, ctor, (caller, instance, args, callRow) => {
        const { captured, enclosing } = local?.(caller, instance) ?? { captured: none, enclosing: undefined };
        caller.runtime.call(context.info, caller, captured, instance, args, callRow, run, enclosing);
      });
    }
    this.rejectDelegationCycles(entry, targets);
  }

  /** The constructor a `constructor(...)` delegates to: another of its class's with `this(...)`, or the superclass's. */
  private compileConstructorDelegation(
    entry: ClassEntry,
    ctor: FunctionSymbol,
    decl: SecondaryConstructorDecl,
    scope: Scope,
    context: FunctionContext,
    targets: Map<FunctionSymbol, FunctionSymbol>
  ): ((frame: Frame, instance: Value) => void) | undefined {
    const { symbol } = entry;
    const delegation = decl.delegation;
    const args: ArgumentSyntax[] = (delegation?.args ?? []).map((argument) => ({
      row: argument.row,
      name: argument.name,
      value: argument.value,
      isSpread: argument.isSpread,
    }));
    const row = delegation?.row ?? decl.row;
    const callRow = this.recordsSteps && !entry.file.isLibrary && delegation ? row : undefined;
    if (delegation?.kind === 'this') {
      const candidates: Candidate[] = symbol.constructors
        .filter((other) => other !== ctor)
        .map((other) => ({ symbol: other, kind: 'constructor', substitution: new Map(), receiverType: undefined }));
      const call = this.resolveCall(
        scope,
        context,
        [candidates],
        args,
        false,
        [],
        undefined,
        undefined,
        row,
        symbol.name
      );
      targets.set(ctor, call.symbol);
      return this.superInitializer(call, callRow);
    }
    const superclass = symbol.superclass;
    if (!superclass || superclass.cls === this.core.any) {
      if (args.length > 0) this.error(row, 'Any のコンストラクタには引数を渡せません。');
      return undefined;
    }
    const candidates: Candidate[] = superclass.cls.constructors.map((other) => ({
      symbol: other,
      kind: 'constructor',
      substitution: substitutionOf(superclass),
      receiverType: undefined,
    }));
    if (candidates.length === 0) this.error(row, `${superclass.cls.name} のコンストラクタを呼べません。`);
    const call = this.resolveCall(
      scope,
      context,
      [candidates],
      args,
      false,
      [],
      undefined,
      undefined,
      row,
      superclass.cls.name
    );
    return this.superInitializer(call, callRow);
  }

  private rejectDelegationCycles(entry: ClassEntry, targets: Map<FunctionSymbol, FunctionSymbol>): void {
    for (const start of targets.keys()) {
      const seen = new Set<FunctionSymbol>();
      for (let current: FunctionSymbol | undefined = start; current; current = targets.get(current)) {
        if (seen.has(current)) this.error(start.row, 'コンストラクタの委譲が循環しています。');
        seen.add(current);
      }
    }
    void entry;
  }

  /** The contexts of `constructor(...)` bodies, by their classes, where a `val` without an initializer may get its value. */
  private readonly secondaryConstructorContexts = new Map<FunctionContext, ClassEntry>();

  private compileConstructorHeader(
    entry: ClassEntry,
    scope: Scope,
    headerScope: Scope,
    context: FunctionContext,
    delegatesToSecondaries: boolean
  ): {
    defaults: (Eval | undefined)[];
    superCall: ((frame: Frame) => void) | undefined;
    fieldSteps: ((frame: Frame) => void)[];
  } {
    this.headerInstance = scope.receiver?.type;
    try {
      return {
        defaults: this.compileConstructorDefaults(entry, headerScope, context),
        superCall: delegatesToSecondaries ? undefined : this.compileSuperConstructorCall(entry, headerScope, context),
        fieldSteps: this.compileFieldSteps(entry, headerScope, context),
      };
    } finally {
      this.headerInstance = undefined;
    }
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

  /**
   * A default can read the earlier parameters. A caller may pass the argument instead, so what a default's evaluation
   * shows, such as a smart cast or a `Nothing` result, holds only merged with the path that skips it. The body starts
   * with every parameter assigned.
   */
  protected compileParameterDefaults(
    declarations: ParameterDecl[],
    params: ParameterSymbol[],
    variables: VariableSymbol[],
    scope: Scope,
    context: FunctionContext
  ): (Eval | undefined)[] {
    for (const variable of variables) this.flow.assigned.delete(variable);
    return params.map((param, index) => {
      const value = declarations[index]?.defaultValue;
      const skipped = this.flow.copy();
      const evaluate =
        value && this.expectType(this.compileExpression(scope, context, value, param.type), param.type, value.row);
      this.flow = Flow.merge([skipped, this.flow]);
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
    // Each property the primary constructor declares is set in a step of its own, as Java's `this.x = x;` is.
    for (const { param, symbol: property, index } of entry.parameterProperties) {
      const slot = property.slot as number;
      const store = (frame: Frame): void => {
        (frame.thisValue as KObject).fields[slot] = frame.locals[index] as Value;
      };
      steps.push(this.withStep(param.row, store, false));
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
    ctor.invoke = (caller, receiver, args, callRow) => {
      if (isAbstract) return caller.runtime.throwError(caller, 'java.lang.InstantiationError', symbol.qualifiedName);
      this.ensureClassInitialized(caller, symbol);
      const instance = new KObject(symbol, fieldCount());
      // An inner class's constructor takes the instance of the class around it as its receiver.
      if (symbol.isInner) instance.fields[symbol.outerSlot as number] = receiver;
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
      if (property.isAbstract || property.isLateinit || property.slot === undefined) continue;
      if (!this.flow.assigned.has(property)) {
        this.error(member.row, `プロパティ ${member.name} には初期値を書くか、init で値を入れてください。`);
      }
    }
  }

  protected mayInitializeVal(context: FunctionContext, symbol: PropertySymbol): boolean {
    if (!symbol.owner || symbol.slot === undefined) return false;
    const entry = this.entryOfProperty.get(symbol);
    if (!entry || entry.decl.initializer || entry.decl.delegate) return false;
    const owner = this.entryOfClass.get(symbol.owner) as ClassEntry;
    if (this.secondaryConstructorContexts.get(context) === owner && !owner.decl.primaryConstructor) return true;
    return this.initializerContexts.get(owner) === context;
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
    // Unit-returning code yields UNIT, which the Unit object must be for equality to hold.
    if (cls === this.core.unit) return () => UNIT;
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
    evaluators: { info: FunctionInfo; evaluate: ((frame: Frame) => Value[])[] },
    createList: (entries: KObject[]) => KObject
  ): void {
    const state: { values: KObject[]; entries?: KObject } = { values: [] };
    frame.runtime.enumEntries.set(cls, state);
    const initialize = ctor.initialize as NonNullable<FunctionSymbol['initialize']>;
    // The arguments' temporaries live in slots of their own context, apart from the locals of the function running.
    const argumentFrame = new Frame(frame.runtime, evaluators.info, [], undefined, undefined);
    const roots = [state.values, argumentFrame.locals as Value[], argumentFrame.temporaries];
    frame.runtime.withNativeRoots(roots, () => {
      for (const [ordinal, enumEntry] of cls.enumEntries.entries()) {
        const entryClass = cls.enumEntryClasses.get(enumEntry.name);
        const instance = new KObject(entryClass ?? cls);
        instance.native = { name: enumEntry.name, ordinal };
        state.values.push(instance);
        initialize(frame, instance, evaluators.evaluate[ordinal](argumentFrame), undefined);
        entryClass?.initialize?.(frame, instance);
      }
    });
    state.entries = createList(state.values);
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
      const createList = this.enumEntriesValue();
      entry.symbol.initializeEnumEntries = (frame) =>
        this.createEnumEntries(frame, entry.symbol, ctor, { info: context.info, evaluate: evaluators }, createList);
    } finally {
      this.recordsSteps = savedRecords;
    }
  }

  protected compileEnumEntries(cls: ClassSymbol): Compiled {
    const instance = this.objectInstance(cls);
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
        return frame.runtime.enumEntries.get(cls)?.entries;
      },
    };
  }

  /** The class of `entries`, a read-only list of an enum class's constants. */
  protected abstract enumEntriesClass(): ClassSymbol;

  protected abstract enumEntriesValue(): (entries: KObject[]) => KObject;
}
