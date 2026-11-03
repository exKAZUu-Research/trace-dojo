import type { Block, ClassNode, FunctionNode, Program, Statement, VariableDeclaration } from './ast';
import { nameFunction } from './evaluatorBase';
import { defineAccessor, ExpressionEvaluator } from './expressionEvaluator';
import {
  type Binding,
  type ClassField,
  type FunctionBehavior,
  type FunctionFrame,
  isObject,
  JsFunction,
  type JsObject,
  JsThrow,
  type Property,
  Scope,
  toBoolean,
  UNINITIALIZED,
  type Value,
} from './values';

type Completion = undefined | { kind: 'break' | 'continue'; label?: string } | { kind: 'return'; value: Value };
type UserBehavior = Extract<FunctionBehavior, { kind: 'user' }>;
type ClassBehavior = Extract<FunctionBehavior, { kind: 'class' }>;

export class Evaluator extends ExpressionEvaluator {
  /** Runs a program in the frame the caller pushed, whose scope becomes the program's own. */
  runProgram(program: Program): void {
    this.instantiate(this.runtime.frame.scope, program.scope);
    this.statements(program.body);
  }

  // Statements --------------------------------------------------------------------------------------------------------

  private statements(statements: Statement[]): Completion {
    for (const statement of statements) {
      const completion = this.statement(statement, []);
      if (completion) return completion;
    }
    return undefined;
  }

  private step(stepId: number | undefined): void {
    if (stepId !== undefined) this.runtime.onStep?.(stepId);
  }

  // code-gauge-allow functionNcss 70 -- One case per statement kind, each delegating where it grows.
  private statement(statement: Statement, labels: string[]): Completion {
    const { runtime } = this;
    runtime.spend();
    switch (statement.kind) {
      case 'expression': {
        this.evaluate(statement.expression);
        this.step(statement.stepId);
        return undefined;
      }
      case 'declaration': {
        this.declaration(statement);
        this.step(statement.stepId);
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
        const value = statement.value ? this.evaluate(statement.value) : undefined;
        this.step(statement.stepId);
        return { kind: 'return', value };
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

  private block(block: Block): Completion {
    return this.withScope(block.scope, () => this.statements(block.body));
  }

  private declaration(declaration: VariableDeclaration): void {
    for (const { target, init } of declaration.declarators) {
      if (init === undefined) {
        // `var x;` keeps the value x has, while `let x;` initializes it.
        if (declaration.declarationKind !== 'var') this.bindPattern(target, undefined, 'initialize');
        continue;
      }
      this.bindPattern(target, this.evaluate(init), 'initialize');
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

  private forStatement(statement: Extract<Statement, { kind: 'for' }>, labels: string[]): Completion {
    const { runtime } = this;
    return this.withScope(statement.scope, () => {
      const { init, update, stepId, perIterationNames } = statement;
      if (init?.kind === 'declaration') {
        this.declaration(init);
        if (init.declarators.some((declarator) => declarator.init)) this.step(stepId);
      } else if (init) {
        this.evaluate(init);
        this.step(stepId);
      }
      const frame = runtime.frame;
      // Each iteration gets its own copy of the `let` variables, which closures created in it keep.
      const copyBindings = (): void => {
        if (perIterationNames.length === 0) return;
        const current = frame.scope;
        const next = new Scope(current.parent);
        for (const name of perIterationNames) next.bindings.set(name, { ...(current.bindings.get(name) as Binding) });
        frame.scope = next;
      };
      const outer = frame.scope;
      try {
        copyBindings();
        for (;;) {
          if (statement.test && !toBoolean(this.evaluate(statement.test))) return;
          const result = this.loopBody(statement.body, labels);
          if (result !== 'next') return result;
          copyBindings();
          if (update) {
            this.evaluate(update);
            this.step(stepId);
          }
          runtime.spend();
        }
      } finally {
        frame.scope = outer;
      }
    });
  }

  private forEachStatement(statement: Extract<Statement, { kind: 'forOf' | 'forIn' }>, labels: string[]): Completion {
    const { runtime } = this;
    const iterable = this.evaluate(statement.iterable);
    const values = statement.kind === 'forOf' ? runtime.iterate(iterable) : this.enumerableKeys(iterable);
    const frame = runtime.frame;
    return runtime.hold(iterable, () => {
      // An array is read live, so elements added while looping are visited as JavaScript does.
      for (let index = 0; index < values.length; index++) {
        runtime.spend();
        const outer = frame.scope;
        try {
          if (statement.declarationKind && statement.declarationKind !== 'var') {
            frame.scope = new Scope(outer);
            this.instantiate(frame.scope, statement.scope);
          }
          this.bindPattern(statement.target, values[index], statement.declarationKind ? 'initialize' : 'assign');
          this.step(statement.stepId);
          const result = this.loopBody(statement.body, labels);
          if (result !== 'next') return result;
        } finally {
          frame.scope = outer;
        }
      }
      return;
    });
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

  private switchStatement(statement: Extract<Statement, { kind: 'switch' }>): Completion {
    const { runtime } = this;
    const discriminant = this.evaluate(statement.discriminant);
    return runtime.hold(discriminant, () =>
      this.withScope(statement.scope, () => {
        const { cases } = statement;
        let start = cases.findIndex(
          (switchCase) => switchCase.test !== undefined && this.evaluate(switchCase.test) === discriminant
        );
        if (start === -1) start = cases.findIndex((switchCase) => switchCase.test === undefined);
        if (start === -1) return;
        for (const switchCase of cases.slice(start)) {
          const completion = this.statements(switchCase.body);
          if (completion?.kind === 'break' && completion.label === undefined) return;
          if (completion) return completion;
        }
        return;
      })
    );
  }

  private tryStatement(statement: Extract<Statement, { kind: 'try' }>): Completion {
    const { runtime } = this;
    let completion: Completion;
    let pending: JsThrow | undefined;
    try {
      completion = this.block(statement.block);
    } catch (error) {
      if (!(error instanceof JsThrow)) throw error;
      pending = error;
    }
    const { handler, finalizer } = statement;
    if (pending && handler) {
      const thrown = pending.value;
      pending = undefined;
      try {
        completion = this.withScope(handler.scope, () => {
          if (handler.param) this.bindPattern(handler.param, thrown, 'initialize');
          return this.block(handler.body);
        });
      } catch (error) {
        if (!(error instanceof JsThrow)) throw error;
        pending = error;
      }
    }
    if (finalizer) {
      const finalCompletion = runtime.hold(pending?.value, () => this.block(finalizer));
      if (finalCompletion) return finalCompletion;
    }
    if (pending) throw pending;
    return completion;
  }

  // Functions ---------------------------------------------------------------------------------------------------------

  createFunction(node: FunctionNode, scope: Scope, homeObject?: JsObject): JsFunction {
    const { runtime } = this;
    runtime.allocate(3);
    let closure = scope;
    if (node.bindsOwnName) closure = new Scope(scope);
    const fn = new JsFunction(runtime.realm.functionPrototype, { kind: 'user', node, scope: closure, homeObject });
    if (node.bindsOwnName) closure.bindings.set(node.name, { value: fn, isMutable: false });
    defineFunctionProperties(fn, node.name, expectedArgumentCount(node));
    if (node.kind === 'normal') {
      const prototype = runtime.newObject();
      prototype.properties.set('constructor', { value: fn, writable: true, enumerable: false, configurable: true });
      fn.properties.set('prototype', { value: prototype, writable: true, enumerable: false, configurable: false });
    }
    return fn;
  }

  callFunction(behavior: UserBehavior, thisValue: Value, args: Value[], callRow: number | undefined): Value {
    const { runtime } = this;
    const { node } = behavior;
    const scope = new Scope(
      behavior.scope,
      node.kind === 'arrow'
        ? undefined
        : { thisValue, homeObject: behavior.homeObject, constructing: undefined, newTarget: undefined },
      true
    );
    runtime.pushFrame(scope, callRow);
    try {
      this.bindParameters(node, args);
      if (!Array.isArray(node.body)) return this.evaluate(node.body);
      this.instantiate(scope, node.scope);
      const completion = this.statements(node.body);
      return completion?.kind === 'return' ? completion.value : undefined;
    } finally {
      runtime.popFrame();
    }
  }

  private bindParameters(node: FunctionNode, args: Value[]): void {
    for (const [index, param] of node.params.entries()) this.bindPattern(param, args[index], 'define');
    if (node.rest) this.bindPattern(node.rest, this.runtime.newArray(args.slice(node.params.length)), 'define');
  }

  // Classes -----------------------------------------------------------------------------------------------------------

  evaluateClass(cls: ClassNode): JsFunction {
    const { runtime } = this;
    const { realm } = runtime;
    let prototypeParent: JsObject | null = realm.objectPrototype;
    let constructorParent: JsObject = realm.functionPrototype;
    if (cls.superClass) {
      const superClass = this.evaluate(cls.superClass);
      if (superClass === null) {
        // oxlint-disable-next-line unicorn/no-null -- `extends null` leaves the prototype without a parent.
        prototypeParent = null;
      } else if (!(superClass instanceof JsFunction) || !superClass.isConstructor) {
        return runtime.throwError(
          'TypeError',
          `Class extends value ${runtime.describe(superClass)} is not a constructor or null`
        );
      } else {
        const parentPrototype = runtime.get(superClass, 'prototype');
        if (parentPrototype !== null && !isObject(parentPrototype)) {
          return runtime.throwError('TypeError', 'Class extends value does not have valid prototype property');
        }
        prototypeParent = parentPrototype;
        constructorParent = superClass;
      }
    }
    const classScope = new Scope(runtime.frame.scope);
    if (cls.name) classScope.bindings.set(cls.name, { value: UNINITIALIZED, isMutable: false });
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
    fn.properties.set('prototype', { value: prototype, writable: false, enumerable: false, configurable: false });
    prototype.properties.set('constructor', { value: fn, writable: true, enumerable: false, configurable: true });
    const staticFields = this.inScope(classScope, () => this.defineMembers(cls, fn, prototype, behavior.fields));
    if (cls.name) classScope.bindings.set(cls.name, { value: fn, isMutable: false });
    this.inScope(classScope, () => {
      for (const field of staticFields) this.initializeField(fn, field);
    });
    return fn;
  }

  /** Defines the methods and accessors, collecting the fields, which return the static ones to initialize. */
  private defineMembers(
    cls: ClassNode,
    fn: JsFunction,
    prototype: JsObject,
    instanceFields: ClassField[]
  ): ClassField[] {
    const { runtime } = this;
    const staticFields: ClassField[] = [];
    const classScope = runtime.frame.scope;
    for (const member of cls.members) {
      const target = member.isStatic ? fn : prototype;
      const isPrivate = member.key.kind === 'private';
      const key = this.propertyKey(member.key);
      if (member.kind === 'field') {
        const { value } = member;
        const initialize = value
          ? (thisValue: JsObject): Value =>
              this.inScope(this.methodScope(classScope, thisValue, target), () => this.evaluate(value))
          : undefined;
        (member.isStatic ? staticFields : instanceFields).push({ key, isPrivate, initialize, stepId: member.stepId });
        continue;
      }
      const method = this.createFunction(member.fn, classScope, target);
      if (member.key.kind === 'computed') nameFunction(runtime, method, key);
      if (isPrivate) {
        const property: Property =
          member.kind === 'method'
            ? { value: method, writable: false, enumerable: false, configurable: false }
            : {
                get: member.kind === 'getter' ? method : undefined,
                set: member.kind === 'setter' ? method : undefined,
                enumerable: false,
                configurable: false,
              };
        const field: ClassField = { key, isPrivate, initialize: undefined, stepId: undefined, property };
        if (member.isStatic) mergePrivate(runtime, fn, key, property);
        else instanceFields.unshift(field);
      } else if (member.kind === 'method') {
        runtime.defineProperty(target, key, { value: method, writable: true, enumerable: false, configurable: true });
      } else {
        defineAccessor(runtime, target, key, member.kind, method, false);
      }
    }
    return staticFields;
  }

  private methodScope(scope: Scope, thisValue: JsObject, homeObject: JsObject): Scope {
    return new Scope(scope, { thisValue, homeObject, constructing: undefined, newTarget: undefined });
  }

  private initializeField(target: JsObject, field: ClassField): void {
    const { runtime } = this;
    if (field.property) {
      mergePrivate(runtime, target, field.key, field.property);
      return;
    }
    const value = field.initialize ? field.initialize(target) : undefined;
    if (field.isPrivate)
      runtime.definePrivate(target, field.key, { value, writable: true, enumerable: false, configurable: false });
    else runtime.createDataProperty(target, field.key, value);
    this.step(field.stepId);
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
    const functionFrame: FunctionFrame = { thisValue, homeObject: behavior.homeObject, constructing: fn, newTarget };
    const scope = new Scope(behavior.scope, functionFrame);
    runtime.pushFrame(scope, callRow);
    try {
      if (thisValue !== UNINITIALIZED) {
        for (const field of behavior.fields) this.initializeField(thisValue, field);
      }
      let result: Value;
      const { ctor } = behavior;
      if (ctor) {
        this.bindParameters(ctor, args);
        this.instantiate(scope, ctor.scope);
        const completion = this.statements(ctor.body as Statement[]);
        if (completion?.kind === 'return') result = completion.value;
      } else if (behavior.isDerived) {
        this.superCall(args, undefined);
      }
      if (isObject(result)) return result;
      if (result !== undefined)
        runtime.throwError('TypeError', 'Derived constructors may only return object or undefined');
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

  superCall(args: Value[], callRow: number | undefined): void {
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
    const constructed = runtime.construct(parent, args, frame.newTarget, callRow);
    if (frame.thisValue !== UNINITIALIZED)
      runtime.throwError('ReferenceError', 'Super constructor may only be called once');
    frame.thisValue = constructed;
    const { behavior } = constructing;
    if (behavior.kind === 'class') {
      for (const field of behavior.fields) this.initializeField(constructed, field);
    }
  }
}

function mergePrivate(runtime: Evaluator['runtime'], target: JsObject, key: string, property: Property): void {
  const existing = target.privateMembers?.get(key);
  if (existing && !('value' in existing) && !('value' in property)) {
    existing.get ??= property.get;
    existing.set ??= property.set;
    return;
  }
  runtime.definePrivate(target, key, { ...property });
}

function defineFunctionProperties(fn: JsFunction, name: string, length: number): void {
  fn.properties.set('length', { value: length, writable: false, enumerable: false, configurable: true });
  fn.properties.set('name', { value: name, writable: false, enumerable: false, configurable: true });
}

/** The number of parameters before the first default or rest one, which `length` reports. */
function expectedArgumentCount(node: FunctionNode): number {
  const index = node.params.findIndex((param) => param.kind === 'default');
  return index === -1 ? node.params.length : index;
}
