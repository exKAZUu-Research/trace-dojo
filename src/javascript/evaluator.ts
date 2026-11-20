// code-gauge-allow-file fileNcss 530 -- Evaluates every kind of function call, class, and statement of the language in one evaluator.
import assert from 'node:assert/strict';

import { createArgumentsObject, mapArguments } from './argumentsObject';
import type {
  Block,
  ClassMember,
  ClassNode,
  Expression,
  FunctionNode,
  Program,
  ScopeDeclarations,
  Statement,
  VariableDeclaration,
} from './ast';
import { createAsyncGeneratorObject } from './asyncGenerators';
import { nameFunction, patternNames } from './evaluatorBase';
import { defineAccessor } from './expressionEvaluator';
import { createGeneratorObject, type Steps } from './generators';
import { DONE, ValueIterator } from './iteration';
import {
  defineFunctionProperties,
  expectedArgumentCount,
  mergePrivate,
  privateMethodProperty,
} from './memberProperties';
import { startAsyncFunction } from './promises';
import { isObjectCreation, onlyCalls, onlyCreates, withoutParentheses } from './stepRules';
import {
  type Completion,
  type Outcome,
  pendingValue,
  suppressedError,
  SuspendableStatementEvaluator,
} from './suspendableStatements';
import {
  appendAll,
  type Binding,
  type ClassField,
  type FunctionBehavior,
  type FunctionFrame,
  isAccessor,
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

type UserBehavior = Extract<FunctionBehavior, { kind: 'user' }>;
type ClassBehavior = Extract<FunctionBehavior, { kind: 'class' }>;

export class Evaluator extends SuspendableStatementEvaluator {
  private readonly constructorScopes = new WeakMap<FunctionFrame, Scope>();
  /** What `this` is for a plain call of a function that is not strict mode code, created when first needed. */
  implicitReceiver: JsObject | undefined;

  /** Runs a program in the frame the caller pushed, whose scope becomes the program's own. */
  runProgram(program: Program): void {
    this.instantiate(this.runtime.frame.scope, program.scope);
    this.body(program.body, program.scope);
    this.runtime.eventLoop.run();
  }

  // Statements --------------------------------------------------------------------------------------------------------

  private statements(statements: Statement[]): Completion {
    for (const statement of statements) {
      const completion = this.statement(statement, []);
      if (completion) return completion;
    }
    return undefined;
  }

  // code-gauge-allow functionNcss 54 -- One case per statement kind, each delegating where it grows.
  // code-gauge-allow functionCognitiveComplexity 22 -- One case per statement kind, each delegating where it grows.
  private statement(statement: Statement, labels: string[]): Completion {
    const { runtime } = this;
    runtime.spend();
    switch (statement.kind) {
      case 'expression': {
        runtime.steps.runStatement(statement.stepRow, onlyCalls(statement.expression), () =>
          this.evaluate(statement.expression)
        );
        return undefined;
      }
      case 'declaration': {
        runtime.steps.runStatement(statement.stepRow, onlyCreates(statement), () => this.declaration(statement));
        return undefined;
      }
      case 'function':
      case 'empty': {
        return undefined;
      }
      case 'class': {
        this.declareClass(statement.cls);
        return undefined;
      }
      case 'return': {
        return { kind: 'return', value: statement.value ? this.evaluate(statement.value) : undefined };
      }
      case 'if': {
        if (toBoolean(this.evaluate(statement.test))) return this.statement(statement.consequent, []);
        return statement.alternate ? this.statement(statement.alternate, []) : undefined;
      }
      case 'block': {
        return this.block(statement);
      }
      case 'for': {
        return this.forStatement(statement, labels);
      }
      case 'forOf':
      case 'forIn': {
        return this.forEachStatement(statement, labels);
      }
      case 'while':
      case 'doWhile': {
        for (let first = true; ; first = false) {
          if (!(first && statement.kind === 'doWhile') && !toBoolean(this.evaluate(statement.test))) return undefined;
          const result = this.loopBody(statement.body, labels);
          if (result !== 'next') return result;
          runtime.spend();
        }
      }
      case 'break':
      case 'continue': {
        return { kind: statement.kind, label: statement.label };
      }
      case 'labeled': {
        const completion = this.statement(statement.body, [...labels, statement.label]);
        return completion?.kind === 'break' && completion.label === statement.label ? undefined : completion;
      }
      case 'switch': {
        return this.switchStatement(statement);
      }
      case 'throw': {
        throw new JsThrow(this.evaluate(statement.argument));
      }
      case 'try': {
        return this.tryStatement(statement);
      }
    }
  }

  /** Runs `run` in a new scope with `declarations`, disposing of what its `using` declarations declared. */
  private scoped<T extends Outcome>(declarations: ScopeDeclarations, run: () => T): T {
    // Enters the scope itself rather than through withScope: every host frame between nested calls costs recursion
    // depth the program can reach.
    const outer = this.enterScope(declarations);
    try {
      return declarations.disposes ? this.disposing(run) : run();
    } finally {
      if (outer) this.runtime.frame.scope = outer;
    }
  }

  /** Runs the statements of a function body or the program, disposing of what their `using` declarations declared. */
  private body(statements: Statement[], declarations: ScopeDeclarations): Completion {
    return declarations.disposes ? this.disposing(() => this.statements(statements)) : this.statements(statements);
  }

  /**
   * Runs `run`, then disposes of the values the `using` declarations in the current scope declared, the last first. An
   * error a disposal throws suppresses the error before it, which a SuppressedError then holds.
   */
  private disposing<T extends Outcome>(run: () => T): T {
    const { runtime } = this;
    const scope = runtime.frame.scope;
    let result: T | undefined;
    let thrown: JsThrow | undefined;
    try {
      result = run();
    } catch (error) {
      if (!(error instanceof JsThrow)) throw error;
      thrown = error;
    }
    const disposables = scope.disposables ?? [];
    // The value the scope returns or throws stays reachable while the disposers run, as do the disposers not run yet.
    const { temporaries } = runtime.frame;
    const held = temporaries.length;
    temporaries.push(pendingValue(result, thrown));
    try {
      for (let disposable = disposables.pop(); disposable; disposable = disposables.pop()) {
        const { value, method } = disposable;
        try {
          if (method) runtime.call(method, value, []);
        } catch (error) {
          if (!(error instanceof JsThrow)) throw error;
          thrown = thrown ? new JsThrow(suppressedError(runtime, error.value, thrown.value)) : error;
          temporaries[held] = thrown.value;
        }
      }
    } finally {
      temporaries.length = held;
    }
    scope.disposables = undefined;
    if (thrown) throw thrown;
    return result as T;
  }

  private block(block: Block): Completion {
    return this.scoped(block.scope, () => this.statements(block.body));
  }

  private declaration(declaration: VariableDeclaration): void {
    for (const { target, init } of declaration.declarators) {
      if (init === undefined) {
        // `var x;` keeps the value x has, while `let x;` initializes it; either shows x from now on.
        if (declaration.declarationKind !== 'var') this.bindPattern(target, undefined, 'initialize');
        else if (target.kind === 'identifier') this.revealVar(target.name);
        continue;
      }
      this.bindDeclared(target, this.evaluate(init, this.classBinding(target)), declaration.declarationKind);
    }
  }

  /** Runs a loop body, returning `'next'` to continue the loop or the completion that ends it. */
  private loopBody(body: Statement, labels: string[]): 'next' | Completion {
    const completion = this.statement(body, []);
    if (!completion) return 'next';
    if (completion.kind === 'return') return completion;
    const isOwn = completion.label === undefined || labels.includes(completion.label);
    if (!isOwn) return completion;
    return completion.kind === 'continue' ? 'next' : undefined;
  }

  // code-gauge-allow duplicateLines 27 -- Mirrors the generator version in suspendableStatements.ts, kept apart so that code without yield or await runs without generator frames.
  private forStatement(statement: Extract<Statement, { kind: 'for' }>, labels: string[]): Completion {
    const { runtime } = this;
    return this.scoped(statement.scope, () => {
      const { update, stepRow, perIterationNames } = statement;
      this.forInit(statement);
      const frame = runtime.frame;
      const outer = frame.scope;
      try {
        this.copyIterationScope(perIterationNames);
        for (;;) {
          if (statement.test && !toBoolean(this.evaluate(statement.test))) return;
          const result = this.loopBody(statement.body, labels);
          if (result !== 'next') return result;
          this.copyIterationScope(perIterationNames);
          if (update) {
            this.evaluate(update);
            runtime.steps.step(stepRow);
          }
          runtime.spend();
        }
      } finally {
        frame.scope = outer;
      }
    });
  }

  /** Runs the init of a `for` header, which records the header's step when it assigns something. */
  private forInit({ init, stepRow }: Extract<Statement, { kind: 'for' }>): void {
    if (init?.kind === 'declaration') {
      this.declaration(init);
      if (init.declarators.some((declarator) => declarator.init)) this.runtime.steps.step(stepRow);
    } else if (init) {
      this.evaluate(init);
      this.runtime.steps.step(stepRow);
    }
  }

  private forEachStatement(statement: Extract<Statement, { kind: 'forOf' | 'forIn' }>, labels: string[]): Completion {
    const { runtime } = this;
    // The loop's let or const names are uninitialized while the iterable is evaluated, so `for (let x of x)` throws.
    const iterable =
      statement.declarationKind && statement.declarationKind !== 'var'
        ? this.withScope(statement.scope, () => this.evaluate(statement.iterable))
        : this.evaluate(statement.iterable);
    const iterator =
      statement.kind === 'forIn'
        ? new ValueIterator(this.forInKeys(iterable))
        : runtime.iterator(iterable, undefined, statement.iterableSource, 'forOf');
    return this.forEachIterations(statement, labels, iterable, iterator);
  }

  /** Runs the iterations of a `for...of` or `for...in` loop, holding the iterable meanwhile. */
  // code-gauge-allow functionNcss 42 -- Inlines what a nested call in the loop body would otherwise pay host frames for.
  // code-gauge-allow duplicateLines 17 -- Mirrors the generator version in suspendableStatements.ts, kept apart so that code without yield or await runs without generator frames.
  private forEachIterations(
    statement: Extract<Statement, { kind: 'forOf' | 'forIn' }>,
    labels: string[],
    iterable: Value,
    iterator: ValueIterator
  ): Completion {
    const { runtime } = this;
    const frame = runtime.frame;
    // Held without runtime.hold, whose callback would add host frames to every nested call in the loop body.
    const held = frame.temporaries.length;
    frame.temporaries.push(iterable);
    let isExhausted = false;
    let completion: 'normal' | 'throw' = 'normal';
    let pending: Value;
    try {
      for (let value = iterator.next(); value !== DONE; value = iterator.next()) {
        runtime.spend();
        const outer = frame.scope;
        try {
          const { declarationKind } = statement;
          if (declarationKind && declarationKind !== 'var') {
            frame.scope = new Scope(outer);
            this.instantiate(frame.scope, statement.scope);
          }
          let result: 'next' | Completion;
          if (statement.scope.disposes) {
            result = this.disposing(() => {
              this.bindIteration(statement, value);
              return this.loopBody(statement.body, labels);
            });
          } else {
            this.bindIteration(statement, value);
            result = this.loopBody(statement.body, labels);
          }
          if (result !== 'next') {
            pending = pendingValue(result);
            return result;
          }
        } finally {
          frame.scope = outer;
        }
      }
      isExhausted = true;
      return undefined;
    } catch (error) {
      if (error instanceof JsThrow) {
        completion = 'throw';
        pending = error.value;
      }
      throw error;
    } finally {
      // Leaving the loop early closes the iterator, which runs a generator's `finally` blocks, while the value the loop
      // returns or throws stays reachable.
      try {
        if (!isExhausted) runtime.hold(pending, () => iterator.close(completion));
      } finally {
        frame.temporaries.length = held;
      }
    }
  }

  /** Binds the loop variable of one iteration and records its step. */
  private bindIteration(statement: Extract<Statement, { kind: 'forOf' | 'forIn' }>, value: Value): void {
    const { declarationKind } = statement;
    if (declarationKind) this.bindDeclared(statement.target, value, declarationKind);
    else this.bindPattern(statement.target, value, 'assign');
    this.stepBinding(statement, value);
  }

  private switchStatement(statement: Extract<Statement, { kind: 'switch' }>): Completion {
    const { runtime } = this;
    const discriminant = this.evaluate(statement.discriminant);
    return runtime.hold(discriminant, () =>
      this.scoped(statement.scope, () => {
        const { cases } = statement;
        for (const switchCase of cases.slice(this.matchingCase(statement, discriminant))) {
          const completion = this.statements(switchCase.body);
          if (completion?.kind === 'break' && completion.label === undefined) return;
          if (completion) return completion;
        }
        return;
      })
    );
  }

  /** The index of the case to start from: the first whose value is strictly equal, else the default, else none. */
  private matchingCase({ cases }: Extract<Statement, { kind: 'switch' }>, discriminant: Value): number {
    const index = cases.findIndex(
      (switchCase) => switchCase.test !== undefined && this.evaluate(switchCase.test) === discriminant
    );
    if (index !== -1) return index;
    const defaultIndex = cases.findIndex((switchCase) => switchCase.test === undefined);
    return defaultIndex === -1 ? cases.length : defaultIndex;
  }

  private tryStatement(statement: Extract<Statement, { kind: 'try' }>): Completion {
    const { handler, finalizer } = statement;
    let outcome = this.catchThrow(() => this.block(statement.block));
    if (outcome.thrown && handler) {
      const { value } = outcome.thrown;
      outcome = this.catchThrow(() =>
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
      const finalCompletion = this.runtime.hold(delayed, () => this.block(finalizer));
      if (finalCompletion) return finalCompletion;
    }
    if (outcome.thrown) throw outcome.thrown;
    return outcome.completion;
  }

  /** Runs `run`, catching the JavaScript exception it throws; limits and host errors still propagate. */
  private catchThrow(run: () => Completion): { completion?: Completion; thrown?: JsThrow } {
    try {
      return { completion: run() };
    } catch (error) {
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
        : {
            thisValue: node.isStrict ? thisValue : this.sloppyThis(thisValue),
            homeObject: behavior.homeObject,
            constructing: undefined,
            newTarget,
            isStrict: node.isStrict,
            hasImplicitThis: !node.isStrict && (thisValue === undefined || thisValue === null),
          },
      true
    );
    if (node.kind === 'arrow') scope.arrowIsStrict = node.isStrict;
    runtime.pushFrame(scope, callRow, node.isAtomic);
    try {
      if (node.isAsync && !node.isGenerator)
        return startAsyncFunction(runtime, runtime.frame, this.asyncBody(fn, node, args));
      this.bindParameters(fn, node, args);
      if (!Array.isArray(node.body)) return this.evaluate(node.body);
      this.instantiate(this.enterBodyScope(node), node.scope);
      if (node.isGenerator) {
        const create = node.isAsync ? createAsyncGeneratorObject : createGeneratorObject;
        return create(runtime, runtime.get(fn, 'prototype'), runtime.frame, this.bodySteps(node.body, node.scope));
      }
      // Inlines `body`, whose frame would cost each call recursion depth.
      const completion = node.scope.disposes
        ? this.disposing(() => this.statements(node.body as Statement[]))
        : this.statements(node.body);
      return completion?.kind === 'return' ? completion.value : undefined;
    } finally {
      runtime.popFrame();
    }
  }

  /**
   * `this` of a call of a function that is not strict mode code, which sees the global object for null or undefined and
   * a box for a primitive.
   */
  private sloppyThis(thisValue: Value): Value {
    if (thisValue !== undefined && thisValue !== null) return this.runtime.toObject(thisValue);
    this.implicitReceiver ??= this.runtime.newObject();
    return this.implicitReceiver;
  }

  /** Runs an async function's body, whose parameters' errors reject its promise as the body's own errors do. */
  private *asyncBody(fn: JsFunction, node: FunctionNode, args: Value[]): Steps<Completion> {
    this.bindParameters(fn, node, args);
    if (!Array.isArray(node.body)) return { kind: 'return', value: yield* this.valueSteps(node.body) };
    this.instantiate(this.enterBodyScope(node), node.scope);
    return yield* this.bodySteps(node.body, node.scope);
  }

  /**
   * The scope a function body declares its names in: the parameters' own one, or, when parameters are patterns or have
   * defaults whose closures must not see the body's declarations, a new one inside it, where a `var` named as a
   * parameter starts with the parameter's value.
   */
  private enterBodyScope(node: FunctionNode): Scope {
    const { frame } = this.runtime;
    const parameters = frame.scope;
    if (node.params.every((param) => param.kind === 'identifier') && (!node.rest || node.rest.kind === 'identifier'))
      return parameters;
    const body = new Scope(parameters);
    for (const name of node.scope.order) {
      const binding = parameters.bindings.get(name);
      if (binding) body.bindings.set(name, { value: binding.value, isMutable: true });
    }
    frame.scope = body;
    return body;
  }

  /** Binds parameters in order after creating them all, so a default reading a later parameter throws as in JavaScript. */
  private bindParameters(fn: JsFunction, node: FunctionNode, args: Value[]): void {
    const { runtime } = this;
    const params = node.rest ? [...node.params, node.rest] : node.params;
    const { bindings } = runtime.frame.scope;
    const names = params.flatMap((param) => patternNames(param));
    runtime.allocate(names.length);
    for (const name of names) bindings.set(name, { value: UNINITIALIZED, isMutable: true });
    if (node.usesArguments) {
      const mapped = !node.isStrict && !node.rest && params.every((param) => param.kind === 'identifier');
      const argumentsObject = createArgumentsObject(runtime, fn, args, mapped);
      bindings.set('arguments', { value: argumentsObject, isMutable: false });
      if (mapped) mapArguments(bindings, names, argumentsObject);
    }
    for (const [index, param] of node.params.entries()) this.bindPattern(param, args[index], 'initialize');
    if (node.rest) this.bindPattern(node.rest, runtime.newArray(args.slice(node.params.length)), 'initialize');
  }

  // Classes -----------------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 19 -- Transcribes the specification's ClassDefinitionEvaluation step by step, whose branches mirror its steps.
  evaluateClass(cls: ClassNode, inferredName?: Key, binding?: Binding): JsFunction {
    const { runtime } = this;
    const { prototypeParent, constructorParent } = this.classParents(cls);
    const classScope = new Scope(runtime.frame.scope);
    if (cls.name) classScope.bindings.set(cls.name, { value: UNINITIALIZED, isMutable: false });
    for (const member of cls.members) {
      if (member.kind === 'staticBlock') continue;
      const { key } = member;
      // Private names live in the class scope, where `#` keeps them apart from variables.
      if (key.kind === 'private' && !classScope.bindings.has(key.name)) {
        const brand = member.kind === 'field' ? 'field' : member.isStatic ? 'static' : 'instance';
        const identity = `${key.name}\0${cls.name}\0${nextPrivateId++}\0${brand}`;
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
      traceBinding: binding,
    };
    const fn = new JsFunction(constructorParent, behavior);
    runtime.allocate(3);
    defineFunctionProperties(fn, cls.name, cls.ctor ? expectedArgumentCount(cls.ctor) : 0);
    if (inferredName !== undefined) nameFunction(runtime, fn, inferredName);
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
    const staticInitializers = this.inScope(classScope, () => this.defineMembers(cls, fn, prototype, behavior));
    if (cls.name) classScope.bindings.set(cls.name, { value: fn, isMutable: false });
    this.initializeStaticMembers(classScope, fn, staticInitializers, binding);
    return fn;
  }

  private initializeStaticMembers(
    classScope: Scope,
    fn: JsFunction,
    initializers: (() => void)[],
    binding: Binding | undefined
  ): void {
    if (binding) binding.initializingClass = fn;
    try {
      this.runtime.hold(fn, () =>
        this.inScope(classScope, () => {
          for (const initialize of initializers) initialize();
        })
      );
    } finally {
      if (binding) binding.initializingClass = undefined;
    }
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
        () => `Class extends value ${runtime.describePlain(superClass)} is not a constructor or null`
      );
    }
    const parentPrototype = runtime.get(superClass, 'prototype');
    if (parentPrototype !== null && !isObject(parentPrototype)) {
      return runtime.throwError(
        'TypeError',
        `Class extends value does not have valid prototype property ${runtime.describePlain(parentPrototype)}`
      );
    }
    return { prototypeParent: parentPrototype, constructorParent: superClass };
  }

  /**
   * Defines the methods and accessors and collects the instance fields, returning what initializes the class itself:
   * its static fields and static blocks in source order.
   */
  // code-gauge-allow functionCognitiveComplexity 23 -- Keeps method definitions and deferred field/static-block initialization in class source order.
  private defineMembers(cls: ClassNode, fn: JsFunction, prototype: JsObject, behavior: ClassBehavior): (() => void)[] {
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
          ? this.fieldInitializer(value, classScope, target, member.key.kind === 'private' ? member.key.name : key)
          : undefined;
        const field: ClassField = {
          key,
          isPrivate,
          initialize,
          stepRow: member.stepRow,
          onlyCalls: value !== undefined && isObjectCreation(value),
        };
        if (member.isStatic) {
          staticInitializers.push(() => this.initializeField(fn, field, member.isTraceConstant));
        } else behavior.fields.push(field);
        continue;
      }
      this.defineMethod(member, key, target, classScope, behavior.fields);
    }
    return staticInitializers;
  }

  private fieldInitializer(
    value: Expression,
    classScope: Scope,
    target: JsObject,
    name: Key
  ): (thisValue: JsObject) => Value {
    const inner = withoutParentheses(value);
    return (thisValue) =>
      this.inScope(this.methodScope(classScope, thisValue, target), () => {
        if (inner.kind === 'classExpression') return this.evaluateClass(inner.cls, name);
        const initialized = this.evaluate(value);
        if (inner.kind === 'functionExpression' && initialized instanceof JsFunction)
          nameFunction(this.runtime, initialized, name);
        return initialized;
      });
  }

  private runStaticBlock(block: Extract<ClassMember, { kind: 'staticBlock' }>, scope: Scope): void {
    this.inScope(scope, () => {
      this.instantiate(scope, block.scope);
      this.body(block.body, block.scope);
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
      isStrict: true,
    });
  }

  private initializeField(target: JsObject, field: ClassField, traceConstant?: true): void {
    const { runtime } = this;
    if (field.property) {
      mergePrivate(runtime, target, privateIdentity(field.key), field.property);
      return;
    }
    this.runtime.steps.runStatement(field.stepRow, field.onlyCalls, () => {
      const value = field.initialize ? field.initialize(target) : undefined;
      const hiddenTraceConstant = value !== undefined && value !== null ? traceConstant : undefined;
      if (field.isPrivate)
        runtime.definePrivate(target, privateIdentity(field.key), {
          value,
          writable: true,
          enumerable: false,
          configurable: false,
          hiddenTraceConstant,
        });
      else {
        runtime.createDataProperty(target, field.key, value);
        const property = hiddenTraceConstant && target.properties.get(field.key);
        if (property && !isAccessor(property)) property.hiddenTraceConstant = true;
      }
    });
  }

  // code-gauge-allow functionNcss 33 -- Parameter binding, field initialization, and constructor returns share the constructing frame and its cleanup.
  constructClass(
    fn: JsFunction,
    behavior: ClassBehavior,
    args: Value[],
    newTarget: JsFunction,
    callRow: number | undefined
  ): JsObject {
    const { runtime } = this;
    const thisValue = behavior.isDerived ? UNINITIALIZED : runtime.newInstance(newTarget);
    const functionFrame: FunctionFrame = {
      thisValue,
      homeObject: behavior.homeObject,
      constructing: fn,
      newTarget,
      isStrict: true,
    };
    const scope = new Scope(behavior.scope, functionFrame);
    this.constructorScopes.set(functionFrame, scope);
    runtime.pushFrame(scope, callRow, behavior.ctor?.isAtomic ?? false);
    try {
      if (thisValue !== UNINITIALIZED) {
        for (const field of behavior.fields) this.initializeField(thisValue, field);
      }
      let result: Value;
      const { ctor } = behavior;
      if (ctor) {
        this.bindParameters(fn, ctor, args);
        const bodyScope = this.enterBodyScope(ctor);
        this.constructorScopes.set(functionFrame, bodyScope);
        this.instantiate(bodyScope, ctor.scope);
        const completion = ctor.scope.disposes
          ? this.disposing(() => this.statements(ctor.body as Statement[]))
          : this.statements(ctor.body as Statement[]);
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

  superCall(args: Value[], callRow: number | undefined, skipsAfterSuper = false): JsObject {
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
      if (!skipsAfterSuper) this.initializeAfterSuper(behavior.node.afterSuper, frame);
    }
    return constructed;
  }

  private initializeAfterSuper(statements: Statement[] | undefined, frame: FunctionFrame): void {
    if (!statements) return;
    const scope = this.constructorScopes.get(frame);
    assert.ok(scope);
    this.inScope(scope, () => this.statements(statements));
  }
}

/** The key of a private member, which is the string identity of its private name rather than a property key. */
function privateIdentity(key: Key): string {
  if (typeof key !== 'string') throw new TypeError('A private name has a string identity');
  return key;
}
