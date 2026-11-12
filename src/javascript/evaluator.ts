import type {
  Block,
  ClassMember,
  ClassNode,
  DeclarationKind,
  Expression,
  FunctionNode,
  Pattern,
  Program,
  ScopeDeclarations,
  Statement,
  VariableDeclaration,
} from './ast';
import { asyncIteratorOf, AwaitingIterator, createAsyncGeneratorObject, type LoopIterator } from './asyncGenerators';
import { nameFunction, patternNames } from './evaluatorBase';
import { defineAccessor } from './expressionEvaluator';
import { Awaiting, createGeneratorObject, GeneratorReturn, resumedValue, runToEnd, type Steps } from './generators';
import { DONE, ValueIterator } from './iteration';
import {
  defineFunctionProperties,
  expectedArgumentCount,
  mergePrivate,
  privateMethodProperty,
} from './memberProperties';
import { startAsyncFunction } from './promises';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import { StepEvaluator } from './stepEvaluator';
import { isObjectCreation, onlyCalls, onlyCreates, storesReference } from './stepRules';
import {
  appendAll,
  type Binding,
  type ClassField,
  type FunctionBehavior,
  type FunctionFrame,
  isCallable,
  isObject,
  JsFunction,
  type JsObject,
  JsThrow,
  type Key,
  Scope,
  toBoolean,
  UNINITIALIZED,
  type Value,
} from './values';

let nextPrivateId = 0;

type Completion = undefined | { kind: 'break' | 'continue'; label?: string } | { kind: 'return'; value: Value };
type UserBehavior = Extract<FunctionBehavior, { kind: 'user' }>;
type ClassBehavior = Extract<FunctionBehavior, { kind: 'class' }>;

export class Evaluator extends StepEvaluator {
  /** Runs a program in the frame the caller pushed, whose scope becomes the program's own. */
  runProgram(program: Program): void {
    this.instantiate(this.runtime.frame.scope, program.scope);
    runToEnd(this.body(program.body, program.scope));
    this.runtime.eventLoop.run();
  }

  // Statements --------------------------------------------------------------------------------------------------------
  // Statements run as host generators that yield what a generator body's `yield` yields, so that a generator object can
  // suspend its body anywhere; outside generator bodies nothing yields, and `runToEnd` runs them in one go.

  private *statements(statements: Statement[]): Steps<Completion> {
    for (const statement of statements) {
      const completion = yield* this.statement(statement, []);
      if (completion) return completion;
    }
    return undefined;
  }

  /** Evaluates an expression, step by step when it contains a `yield`. */
  private *value(expression: Expression): Steps<Value> {
    return expression.suspends ? yield* this.evaluateSteps(expression) : this.evaluate(expression);
  }

  /** Records the step of binding a loop's target, whose destructuring stores the values it reads out of an object. */
  private stepBinding({ target, stepRow }: Extract<Statement, { kind: 'forOf' | 'forIn' }>, value: Value): void {
    this.runtime.steps.stepBinding(stepRow, !storesReference(target) || (!isObject(value) && value !== null));
  }

  // code-gauge-allow functionNcss 54 -- One case per statement kind, each delegating where it grows.
  // code-gauge-allow functionCognitiveComplexity 20 -- One case per statement kind, each delegating where it grows.
  private *statement(statement: Statement, labels: string[]): Steps<Completion> {
    const { runtime } = this;
    runtime.spend();
    switch (statement.kind) {
      case 'expression': {
        const { expression } = statement;
        if (!expression.suspends) {
          runtime.steps.runStatement(statement.stepRow, onlyCalls(expression), () => this.evaluate(expression));
          return undefined;
        }
        yield* this.evaluateSteps(expression);
        runtime.steps.step(statement.stepRow);
        return undefined;
      }
      case 'declaration': {
        if (!statement.declarators.some(({ init }) => init?.suspends)) {
          runtime.steps.runStatement(statement.stepRow, onlyCreates(statement), () =>
            runToEnd(this.declaration(statement))
          );
          return undefined;
        }
        yield* this.declaration(statement);
        runtime.steps.step(statement.stepRow);
        return undefined;
      }
      case 'function':
      case 'empty': {
        return undefined;
      }
      case 'class': {
        this.writeVariable(statement.cls.name, this.evaluateClass(statement.cls), 'initialize');
        return undefined;
      }
      case 'return': {
        const value = statement.value ? yield* this.value(statement.value) : undefined;
        return { kind: 'return', value: statement.awaitsValue ? resumedValue(yield new Awaiting(value)) : value };
      }
      case 'if': {
        if (toBoolean(yield* this.value(statement.test))) return yield* this.statement(statement.consequent, []);
        return statement.alternate ? yield* this.statement(statement.alternate, []) : undefined;
      }
      case 'block': {
        return yield* this.block(statement);
      }
      case 'for': {
        return yield* this.forStatement(statement, labels);
      }
      case 'forOf':
      case 'forIn': {
        return yield* this.forEachStatement(statement, labels);
      }
      case 'while':
      case 'doWhile': {
        for (let first = true; ; first = false) {
          if (!(first && statement.kind === 'doWhile') && !toBoolean(yield* this.value(statement.test)))
            return undefined;
          const result = yield* this.loopBody(statement.body, labels);
          if (result !== 'next') return result;
          runtime.spend();
        }
      }
      case 'break':
      case 'continue': {
        return { kind: statement.kind, label: statement.label };
      }
      case 'labeled': {
        const completion = yield* this.statement(statement.body, [...labels, statement.label]);
        return completion?.kind === 'break' && completion.label === statement.label ? undefined : completion;
      }
      case 'switch': {
        return yield* this.switchStatement(statement);
      }
      case 'throw': {
        throw new JsThrow(yield* this.value(statement.argument));
      }
      case 'try': {
        return yield* this.tryStatement(statement);
      }
    }
  }

  /** Runs `run` in a new scope with `declarations`, or in the current one when nothing is declared. */
  private *scoped<T>(declarations: ScopeDeclarations, run: () => Steps<T>): Steps<T> {
    if (declarations.lexical.length === 0 && declarations.functions.length === 0 && declarations.vars.length === 0) {
      return yield* run();
    }
    const frame = this.runtime.frame;
    const outer = frame.scope;
    frame.scope = new Scope(outer);
    try {
      this.instantiate(frame.scope, declarations);
      return yield* declarations.disposes ? this.disposing(run) : run();
    } finally {
      frame.scope = outer;
    }
  }

  /** Runs the statements of a function body or the program, disposing of what their `using` declarations declared. */
  private body(statements: Statement[], declarations: ScopeDeclarations): Steps<Completion> {
    return declarations.disposes ? this.disposing(() => this.statements(statements)) : this.statements(statements);
  }

  /**
   * Runs `run`, then disposes of the values the `using` declarations in the current scope declared, the last first. An
   * error a disposal throws suppresses the error before it, which a SuppressedError then holds.
   */
  private *disposing<T>(run: () => Steps<T>): Steps<T> {
    const { runtime } = this;
    const scope = runtime.frame.scope;
    let result: T | undefined;
    let completion: JsThrow | GeneratorReturn | undefined;
    try {
      result = yield* run();
    } catch (error) {
      if (!(error instanceof JsThrow) && !(error instanceof GeneratorReturn)) throw error;
      completion = error;
    }
    const disposables = scope.disposables ?? [];
    scope.disposables = undefined;
    for (const { value, method, isAsync } of disposables.toReversed()) {
      try {
        const disposed = method ? runtime.call(method, value, []) : undefined;
        if (isAsync) resumedValue(yield new Awaiting(disposed));
      } catch (error) {
        if (!(error instanceof JsThrow)) throw error;
        completion =
          completion instanceof JsThrow ? new JsThrow(suppressedError(runtime, error.value, completion.value)) : error;
      }
    }
    if (completion) throw completion;
    return result as T;
  }

  /** Records a value a `using` declaration declares in the current scope, which disposes of it when it ends. */
  private addDisposable(value: Value, kind: DeclarationKind): void {
    const { runtime } = this;
    const isAsync = kind === 'await using';
    const scope = runtime.frame.scope;
    scope.disposables ??= [];
    // An `await using` of null or undefined still awaits when its scope ends.
    if (value === null || value === undefined) {
      if (isAsync) scope.disposables.push({ value, method: undefined, isAsync });
      return;
    }
    if (!isObject(value)) runtime.throwError('TypeError', 'An object is expected with `using` declarations');
    const asyncMethod = isAsync ? runtime.get(value, WELL_KNOWN_SYMBOLS.asyncDispose) : undefined;
    const method = asyncMethod ?? runtime.get(value, WELL_KNOWN_SYMBOLS.dispose);
    if (!isCallable(method)) {
      const key = isAsync ? WELL_KNOWN_SYMBOLS.asyncDispose : WELL_KNOWN_SYMBOLS.dispose;
      return runtime.throwError('TypeError', `${key.toString()} is not a function`);
    }
    scope.disposables.push({ value, method, isAsync });
  }

  /** Keeps `value` reachable for garbage collection while `run` computes with it. */
  private *holding<T>(value: Value, run: () => Steps<T>): Steps<T> {
    const { temporaries } = this.runtime.frame;
    temporaries.push(value);
    try {
      return yield* run();
    } finally {
      temporaries.pop();
    }
  }

  private block(block: Block): Steps<Completion> {
    return this.scoped(block.scope, () => this.statements(block.body));
  }

  private *declaration(declaration: VariableDeclaration): Steps<void> {
    for (const { target, init } of declaration.declarators) {
      if (init === undefined) {
        // `var x;` keeps the value x has, while `let x;` initializes it; either shows x from now on.
        if (declaration.declarationKind !== 'var') this.bindPattern(target, undefined, 'initialize');
        else if (target.kind === 'identifier') this.revealVar(target.name);
        continue;
      }
      this.bindDeclared(target, yield* this.value(init), declaration.declarationKind);
    }
  }

  /** Initializes the variables a declaration declares, recording the value of a `using` one for disposal. */
  private bindDeclared(target: Pattern, value: Value, kind: DeclarationKind): void {
    this.bindPattern(target, value, 'initialize');
    if (kind === 'using' || kind === 'await using') this.addDisposable(value, kind);
  }

  /** Runs a loop body, returning `'next'` to continue the loop or the completion that ends it. */
  private *loopBody(body: Statement, labels: string[]): Steps<'next' | Completion> {
    const completion = yield* this.statement(body, []);
    if (!completion) return 'next';
    if (completion.kind === 'return') return completion;
    const isOwn = completion.label === undefined || labels.includes(completion.label);
    if (!isOwn) return completion;
    return completion.kind === 'continue' ? 'next' : undefined;
  }

  private forStatement(statement: Extract<Statement, { kind: 'for' }>, labels: string[]): Steps<Completion> {
    const { runtime } = this;
    return this.scoped(
      statement.scope,
      function* (this: Evaluator): Steps<Completion> {
        const { update, stepRow, perIterationNames } = statement;
        yield* this.forInit(statement);
        const frame = runtime.frame;
        const outer = frame.scope;
        try {
          this.copyIterationScope(perIterationNames);
          for (;;) {
            if (statement.test && !toBoolean(yield* this.value(statement.test))) return;
            const result = yield* this.loopBody(statement.body, labels);
            if (result !== 'next') return result;
            this.copyIterationScope(perIterationNames);
            if (update) {
              yield* this.value(update);
              runtime.steps.step(stepRow);
            }
            runtime.spend();
          }
        } finally {
          frame.scope = outer;
        }
      }.bind(this)
    );
  }

  /** Runs the init of a `for` header, which records the header's step when it assigns something. */
  private *forInit({ init, stepRow }: Extract<Statement, { kind: 'for' }>): Steps<void> {
    if (init?.kind === 'declaration') {
      yield* this.declaration(init);
      if (init.declarators.some((declarator) => declarator.init)) this.runtime.steps.step(stepRow);
    } else if (init) {
      yield* this.value(init);
      this.runtime.steps.step(stepRow);
    }
  }

  /** Gives the next iteration its own copy of the `let` variables, which closures created in an iteration keep. */
  private copyIterationScope(names: string[]): void {
    if (names.length === 0) return;
    const frame = this.runtime.frame;
    const current = frame.scope;
    const next = new Scope(current.parent);
    for (const name of names) next.bindings.set(name, { ...(current.bindings.get(name) as Binding) });
    frame.scope = next;
  }

  private *forEachStatement(
    statement: Extract<Statement, { kind: 'forOf' | 'forIn' }>,
    labels: string[]
  ): Steps<Completion> {
    const { runtime } = this;
    // The loop's let or const names are uninitialized while the iterable is evaluated, so `for (let x of x)` throws.
    const iterable =
      statement.declarationKind && statement.declarationKind !== 'var'
        ? yield* this.scoped(statement.scope, () => this.value(statement.iterable))
        : yield* this.value(statement.iterable);
    const iterator: LoopIterator =
      statement.kind === 'forIn'
        ? syncLoopIterator(new ValueIterator(this.enumerableKeys(iterable)))
        : statement.isAwait
          ? new AwaitingIterator(runtime, asyncIteratorOf(runtime, iterable))
          : syncLoopIterator(runtime.iterator(iterable));
    return yield* this.holding(iterable, () => this.forEachIterations(statement, labels, iterator));
  }

  private *forEachIterations(
    statement: Extract<Statement, { kind: 'forOf' | 'forIn' }>,
    labels: string[],
    iterator: LoopIterator
  ): Steps<Completion> {
    const { runtime } = this;
    const frame = runtime.frame;
    let isExhausted = false;
    try {
      for (;;) {
        const value = yield* iterator.next();
        if (value === DONE) {
          isExhausted = true;
          return;
        }
        runtime.spend();
        const outer = frame.scope;
        try {
          const { declarationKind } = statement;
          if (declarationKind && declarationKind !== 'var') {
            frame.scope = new Scope(outer);
            this.instantiate(frame.scope, statement.scope);
          }
          const iteration = (): Steps<'next' | Completion> => {
            if (declarationKind) this.bindDeclared(statement.target, value, declarationKind);
            else this.bindPattern(statement.target, value, 'assign');
            this.stepBinding(statement, value);
            return this.loopBody(statement.body, labels);
          };
          const result = yield* statement.scope.disposes ? this.disposing(iteration) : iteration();
          if (result !== 'next') return result;
        } finally {
          frame.scope = outer;
        }
      }
    } finally {
      // Leaving the loop early closes the iterator, which runs a generator's `finally` blocks.
      if (!isExhausted) yield* iterator.close();
    }
  }

  /** The keys `for...in` visits: enumerable string keys of the object and its prototypes, each once. */
  private enumerableKeys(value: Value): string[] {
    const { runtime } = this;
    if (value === undefined || value === null) return [];
    if (typeof value === 'string') return Array.from({ length: value.length }, (_, index) => String(index));
    if (!isObject(value)) return [];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (let current: JsObject | null = value; current; current = current.proto) {
      for (const key of runtime.ownKeys(current)) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (runtime.getOwnProperty(current, key)?.enumerable) keys.push(key);
      }
    }
    return keys;
  }

  private *switchStatement(statement: Extract<Statement, { kind: 'switch' }>): Steps<Completion> {
    const discriminant = yield* this.value(statement.discriminant);
    return yield* this.holding(discriminant, () =>
      this.scoped(
        statement.scope,
        function* (this: Evaluator): Steps<Completion> {
          const { cases } = statement;
          for (const switchCase of cases.slice(yield* this.matchingCase(statement, discriminant))) {
            const completion = yield* this.statements(switchCase.body);
            if (completion?.kind === 'break' && completion.label === undefined) return;
            if (completion) return completion;
          }
          return;
        }.bind(this)
      )
    );
  }

  /** The index of the case to start from: the first whose value is strictly equal, else the default, else none. */
  private *matchingCase({ cases }: Extract<Statement, { kind: 'switch' }>, discriminant: Value): Steps<number> {
    for (const [index, switchCase] of cases.entries()) {
      if (switchCase.test !== undefined && (yield* this.value(switchCase.test)) === discriminant) return index;
    }
    const defaultIndex = cases.findIndex((switchCase) => switchCase.test === undefined);
    return defaultIndex === -1 ? cases.length : defaultIndex;
  }

  private *tryStatement(statement: Extract<Statement, { kind: 'try' }>): Steps<Completion> {
    const { handler, finalizer } = statement;
    let outcome = yield* this.catchThrow(() => this.block(statement.block));
    if (outcome.thrown && handler) {
      const { value } = outcome.thrown;
      outcome = yield* this.catchThrow(() =>
        this.scoped(handler.scope, () => {
          if (handler.param) this.bindPattern(handler.param, value, 'initialize');
          return this.block(handler.body);
        })
      );
    }
    if (finalizer) {
      // The exception or the return value that the finalizer delays must keep its turtles alive meanwhile.
      const delayed = outcome.thrown
        ? outcome.thrown.value
        : outcome.completion?.kind === 'return'
          ? outcome.completion.value
          : undefined;
      const finalCompletion = yield* this.holding(delayed, () => this.block(finalizer));
      if (finalCompletion) return finalCompletion;
    }
    if (outcome.thrown) throw outcome.thrown;
    return outcome.completion;
  }

  /**
   * Runs `run`, catching the JavaScript exception it throws; limits and host errors still propagate. A generator's
   * `return()` resuming it inside `run` completes it as a `return` statement would, so that finalizers run.
   */
  private *catchThrow(run: () => Steps<Completion>): Steps<{ completion?: Completion; thrown?: JsThrow }> {
    try {
      return { completion: yield* run() };
    } catch (error) {
      if (error instanceof GeneratorReturn) return { completion: { kind: 'return', value: error.value } };
      if (!(error instanceof JsThrow)) throw error;
      return { thrown: error };
    }
  }

  // Functions ---------------------------------------------------------------------------------------------------------

  createFunction(node: FunctionNode, scope: Scope, homeObject?: JsObject): JsFunction {
    const { runtime } = this;
    runtime.allocate(3);
    let closure = scope;
    if (node.bindsOwnName) closure = new Scope(scope);
    const fn = new JsFunction(runtime.realm.functionPrototype, {
      kind: 'user',
      node,
      scope: closure,
      homeObject,
    });
    if (node.bindsOwnName) closure.bindings.set(node.name, { value: fn, isMutable: false });
    defineFunctionProperties(fn, node.name, expectedArgumentCount(node));
    if (node.isGenerator) {
      const { asyncGeneratorPrototype, generatorPrototype } = runtime.realm;
      const prototype = runtime.newObject(node.isAsync ? asyncGeneratorPrototype : generatorPrototype);
      fn.properties.set('prototype', { value: prototype, writable: true, enumerable: false, configurable: false });
    } else if (node.kind === 'normal' && !node.isAsync) {
      const prototype = runtime.newObject();
      prototype.properties.set('constructor', {
        value: fn,
        writable: true,
        enumerable: false,
        configurable: true,
      });
      fn.properties.set('prototype', {
        value: prototype,
        writable: true,
        enumerable: false,
        configurable: false,
      });
    }
    return fn;
  }

  callFunction(
    fn: JsFunction,
    behavior: UserBehavior,
    thisValue: Value,
    args: Value[],
    callRow: number | undefined,
    newTarget?: JsFunction
  ): Value {
    const { runtime } = this;
    const { node } = behavior;
    const scope = new Scope(
      behavior.scope,
      node.kind === 'arrow'
        ? undefined
        : { thisValue, homeObject: behavior.homeObject, constructing: undefined, newTarget },
      true
    );
    runtime.pushFrame(scope, callRow, node.isAtomic);
    try {
      if (node.isAsync && !node.isGenerator)
        return startAsyncFunction(runtime, runtime.frame, this.asyncBody(node, args));
      this.bindParameters(node, args);
      if (!Array.isArray(node.body)) return this.evaluate(node.body);
      this.instantiate(scope, node.scope);
      if (node.isGenerator) {
        const create = node.isAsync ? createAsyncGeneratorObject : createGeneratorObject;
        return create(runtime, runtime.get(fn, 'prototype'), runtime.frame, this.body(node.body, node.scope));
      }
      const completion = runToEnd(this.body(node.body, node.scope));
      return completion?.kind === 'return' ? completion.value : undefined;
    } finally {
      runtime.popFrame();
    }
  }

  /** Runs an async function's body, whose parameters' errors reject its promise as the body's own errors do. */
  private *asyncBody(node: FunctionNode, args: Value[]): Steps<Completion> {
    this.bindParameters(node, args);
    if (!Array.isArray(node.body)) return { kind: 'return', value: yield* this.value(node.body) };
    this.instantiate(this.runtime.frame.scope, node.scope);
    return yield* this.body(node.body, node.scope);
  }

  /** Binds parameters in order after creating them all, so a default reading a later parameter throws as in JavaScript. */
  private bindParameters(node: FunctionNode, args: Value[]): void {
    const { runtime } = this;
    if (node.usesArguments) {
      runtime.frame.scope.bindings.set('arguments', {
        value: runtime.newArray([...args]),
        isMutable: false,
      });
    }
    const params = node.rest ? [...node.params, node.rest] : node.params;
    const { bindings } = runtime.frame.scope;
    const names = params.flatMap((param) => patternNames(param));
    runtime.allocate(names.length);
    for (const name of names) bindings.set(name, { value: UNINITIALIZED, isMutable: true });
    for (const [index, param] of node.params.entries()) this.bindPattern(param, args[index], 'initialize');
    if (node.rest) this.bindPattern(node.rest, runtime.newArray(args.slice(node.params.length)), 'initialize');
  }

  // Classes -----------------------------------------------------------------------------------------------------------

  evaluateClass(cls: ClassNode): JsFunction {
    const { runtime } = this;
    const { prototypeParent, constructorParent } = this.classParents(cls);
    const classScope = new Scope(runtime.frame.scope);
    if (cls.name) classScope.bindings.set(cls.name, { value: UNINITIALIZED, isMutable: false });
    for (const member of cls.members) {
      if (member.kind === 'staticBlock') continue;
      const { key } = member;
      // Private names live in the class scope, where `#` keeps them apart from variables.
      if (key.kind === 'private' && !classScope.bindings.has(key.name)) {
        const identity = `${key.name}\0${cls.name}\0${nextPrivateId++}`;
        classScope.bindings.set(key.name, { value: identity, isMutable: false });
      }
    }
    const prototype = runtime.newObject(prototypeParent);
    const behavior: ClassBehavior = {
      kind: 'class',
      node: cls,
      ctor: cls.ctor,
      scope: classScope,
      homeObject: prototype,
      isDerived: cls.superClass !== undefined,
      fields: [],
    };
    const fn = new JsFunction(constructorParent, behavior);
    runtime.allocate(3);
    defineFunctionProperties(fn, cls.name, cls.ctor ? expectedArgumentCount(cls.ctor) : 0);
    fn.properties.set('prototype', {
      value: prototype,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    prototype.properties.set('constructor', {
      value: fn,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    const staticInitializers = this.inScope(classScope, () => this.defineMembers(cls, fn, prototype, behavior.fields));
    if (cls.name) classScope.bindings.set(cls.name, { value: fn, isMutable: false });
    this.inScope(classScope, () => {
      for (const initialize of staticInitializers) initialize();
    });
    return fn;
  }

  /** The prototypes of a class's prototype object and of the class itself, which `extends` decides. */
  private classParents(cls: ClassNode): {
    prototypeParent: JsObject | null;
    constructorParent: JsObject;
  } {
    const { runtime } = this;
    const { realm } = runtime;
    if (!cls.superClass) return { prototypeParent: realm.objectPrototype, constructorParent: realm.functionPrototype };
    const superClass = this.evaluate(cls.superClass);
    // oxlint-disable-next-line unicorn/no-null -- `extends null` leaves the prototype without a parent.
    if (superClass === null) return { prototypeParent: null, constructorParent: realm.functionPrototype };
    if (!(superClass instanceof JsFunction) || !superClass.isConstructor) {
      return runtime.throwError(
        'TypeError',
        `Class extends value ${runtime.describe(superClass)} is not a constructor or null`
      );
    }
    const parentPrototype = runtime.get(superClass, 'prototype');
    if (parentPrototype !== null && !isObject(parentPrototype)) {
      return runtime.throwError('TypeError', 'Class extends value does not have valid prototype property');
    }
    return { prototypeParent: parentPrototype, constructorParent: superClass };
  }

  /**
   * Defines the methods and accessors and collects the instance fields, returning what initializes the class itself:
   * its static fields and static blocks in source order.
   */
  private defineMembers(
    cls: ClassNode,
    fn: JsFunction,
    prototype: JsObject,
    instanceFields: ClassField[]
  ): (() => void)[] {
    const { runtime } = this;
    const staticInitializers: (() => void)[] = [];
    const classScope = runtime.frame.scope;
    for (const member of cls.members) {
      if (member.kind === 'staticBlock') {
        staticInitializers.push(() => this.runStaticBlock(member, this.methodScope(classScope, fn, fn)));
        continue;
      }
      const target = member.isStatic ? fn : prototype;
      const isPrivate = member.key.kind === 'private';
      const key = this.propertyKey(member.key);
      if (member.kind === 'field') {
        const { value } = member;
        const initialize = value
          ? (thisValue: JsObject): Value =>
              this.inScope(this.methodScope(classScope, thisValue, target), () => this.evaluate(value))
          : undefined;
        const field: ClassField = {
          key,
          isPrivate,
          initialize,
          stepRow: member.stepRow,
          onlyCalls: value !== undefined && isObjectCreation(value),
        };
        if (member.isStatic) staticInitializers.push(() => this.initializeField(fn, field));
        else instanceFields.push(field);
        continue;
      }
      this.defineMethod(member, key, target, classScope, instanceFields);
    }
    return staticInitializers;
  }

  private runStaticBlock(block: Extract<ClassMember, { kind: 'staticBlock' }>, scope: Scope): void {
    this.inScope(scope, () => {
      this.instantiate(scope, block.scope);
      runToEnd(this.body(block.body, block.scope));
    });
  }

  /** Defines a method or accessor, which instances get as private members when its name is private. */
  private defineMethod(
    member: Extract<ClassMember, { fn: FunctionNode }>,
    key: Key,
    target: JsObject,
    classScope: Scope,
    instanceFields: ClassField[]
  ): void {
    const { runtime } = this;
    const method = this.createFunction(member.fn, classScope, target);
    if (member.key.kind === 'computed') nameFunction(runtime, method, key);
    if (member.key.kind === 'private') {
      const property = privateMethodProperty(member.kind, method);
      if (member.isStatic) mergePrivate(runtime, target, privateIdentity(key), property);
      else
        instanceFields.unshift({
          key,
          isPrivate: true,
          initialize: undefined,
          stepRow: undefined,
          onlyCalls: false,
          property,
        });
    } else if (member.kind === 'method') {
      runtime.defineProperty(target, key, {
        value: method,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    } else {
      defineAccessor(runtime, target, key, member.kind, method, false);
    }
  }

  private methodScope(scope: Scope, thisValue: JsObject, homeObject: JsObject): Scope {
    return new Scope(scope, {
      thisValue,
      homeObject,
      constructing: undefined,
      newTarget: undefined,
    });
  }

  private initializeField(target: JsObject, field: ClassField): void {
    const { runtime } = this;
    if (field.property) {
      mergePrivate(runtime, target, privateIdentity(field.key), field.property);
      return;
    }
    this.runtime.steps.runStatement(field.stepRow, field.onlyCalls, () => {
      const value = field.initialize ? field.initialize(target) : undefined;
      if (field.isPrivate)
        runtime.definePrivate(target, privateIdentity(field.key), {
          value,
          writable: true,
          enumerable: false,
          configurable: false,
        });
      else runtime.createDataProperty(target, field.key, value);
    });
  }

  constructClass(
    fn: JsFunction,
    behavior: ClassBehavior,
    args: Value[],
    newTarget: JsFunction,
    callRow: number | undefined
  ): JsObject {
    const { runtime } = this;
    const thisValue = behavior.isDerived
      ? UNINITIALIZED
      : runtime.newObject(runtime.prototypeFor(newTarget, runtime.realm.objectPrototype));
    const functionFrame: FunctionFrame = {
      thisValue,
      homeObject: behavior.homeObject,
      constructing: fn,
      newTarget,
    };
    const scope = new Scope(behavior.scope, functionFrame);
    runtime.pushFrame(scope, callRow, behavior.ctor?.isAtomic ?? false);
    try {
      if (thisValue !== UNINITIALIZED) {
        for (const field of behavior.fields) this.initializeField(thisValue, field);
      }
      let result: Value;
      const { ctor } = behavior;
      if (ctor) {
        this.bindParameters(ctor, args);
        this.instantiate(scope, ctor.scope);
        const completion = runToEnd(this.body(ctor.body as Statement[], ctor.scope));
        if (completion?.kind === 'return') result = completion.value;
      } else if (behavior.isDerived) {
        this.superCall(args, undefined);
      }
      if (isObject(result)) return result;
      // A base constructor's primitive result is ignored, while a derived one's is an error.
      if (result !== undefined && behavior.isDerived) {
        runtime.throwError('TypeError', 'Derived constructors may only return object or undefined');
      }
      const constructed = functionFrame.thisValue;
      if (constructed === UNINITIALIZED) {
        return runtime.throwError(
          'ReferenceError',
          "Must call super constructor in derived class before accessing 'this' or returning from derived constructor"
        );
      }
      return constructed as JsObject;
    } finally {
      runtime.popFrame();
    }
  }

  superCall(args: Value[], callRow: number | undefined): JsObject {
    const { runtime } = this;
    const frame = this.functionFrame();
    const constructing = frame?.constructing;
    if (!frame || !constructing || !frame.newTarget)
      return runtime.throwError('SyntaxError', "'super' keyword unexpected here");
    const parent = constructing.proto;
    if (!(parent instanceof JsFunction) || !parent.isConstructor) {
      return runtime.throwError(
        'TypeError',
        `Super constructor ${runtime.describe(parent)} of anonymous class is not a constructor`
      );
    }
    // The arguments stay reachable while the parent initializes its fields, before its parameters hold them.
    const { temporaries } = runtime.frame;
    const held = temporaries.length;
    appendAll(temporaries, args);
    let constructed: JsObject;
    try {
      constructed = runtime.construct(parent, args, frame.newTarget, callRow);
    } finally {
      temporaries.length = held;
    }
    if (frame.thisValue !== UNINITIALIZED)
      runtime.throwError('ReferenceError', 'Super constructor may only be called once');
    frame.thisValue = constructed;
    const { behavior } = constructing;
    if (behavior.kind === 'class') {
      for (const field of behavior.fields) this.initializeField(constructed, field);
    }
    return constructed;
  }
}

/** The key of a private member, which is the string identity of its private name rather than a property key. */
function privateIdentity(key: Key): string {
  if (typeof key !== 'string') throw new TypeError('A private name has a string identity');
  return key;
}

function syncLoopIterator(iterator: ValueIterator): LoopIterator {
  return {
    // oxlint-disable-next-line require-yield -- A sync iterator steps without suspending the loop.
    *next() {
      return iterator.next();
    },
    // oxlint-disable-next-line require-yield -- A sync iterator closes without suspending the loop.
    *close() {
      iterator.close();
    },
  };
}

function suppressedError(runtime: Runtime, error: Value, suppressed: Value): JsObject {
  const object = runtime.newError('SuppressedError', 'An error was suppressed during disposal');
  for (const [key, value] of [
    ['error', error],
    ['suppressed', suppressed],
  ] as const) {
    runtime.defineProperty(object, key, { value, writable: true, enumerable: false, configurable: true });
  }
  return object;
}
