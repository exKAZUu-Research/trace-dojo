import type { Block, ClassMember, ClassNode, FunctionNode, Program, Statement, VariableDeclaration } from './ast';
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

  // code-gauge-allow functionNcss 54 -- One case per statement kind, each delegating where it grows.
  // code-gauge-allow functionCognitiveComplexity 20 -- One case per statement kind, each delegating where it grows.
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
      const { update, stepId, perIterationNames } = statement;
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
            this.step(stepId);
          }
          runtime.spend();
        }
      } finally {
        frame.scope = outer;
      }
    });
  }

  /** Runs the init of a `for` header, which records the header's step when it assigns something. */
  private forInit({ init, stepId }: Extract<Statement, { kind: 'for' }>): void {
    if (init?.kind === 'declaration') {
      this.declaration(init);
      if (init.declarators.some((declarator) => declarator.init)) this.step(stepId);
    } else if (init) {
      this.evaluate(init);
      this.step(stepId);
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
        this.withScope(handler.scope, () => {
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
    const { prototypeParent, constructorParent } = this.classParents(cls);
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

  /** The prototypes of a class's prototype object and of the class itself, which `extends` decides. */
  private classParents(cls: ClassNode): { prototypeParent: JsObject | null; constructorParent: JsObject } {
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
      this.defineMethod(member, key, target, classScope, instanceFields);
    }
    return staticFields;
  }

  /** Defines a method or accessor, which instances get as private members when its name is private. */
  private defineMethod(
    member: Extract<ClassMember, { fn: FunctionNode }>,
    key: string,
    target: JsObject,
    classScope: Scope,
    instanceFields: ClassField[]
  ): void {
    const { runtime } = this;
    const method = this.createFunction(member.fn, classScope, target);
    if (member.key.kind === 'computed') nameFunction(runtime, method, key);
    if (member.key.kind === 'private') {
      const property = privateMethodProperty(member.kind, method);
      if (member.isStatic) mergePrivate(runtime, target, key, property);
      else instanceFields.unshift({ key, isPrivate: true, initialize: undefined, stepId: undefined, property });
    } else if (member.kind === 'method') {
      runtime.defineProperty(target, key, { value: method, writable: true, enumerable: false, configurable: true });
    } else {
      defineAccessor(runtime, target, key, member.kind, method, false);
    }
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

function privateMethodProperty(kind: 'method' | 'getter' | 'setter', method: JsFunction): Property {
  if (kind === 'method') return { value: method, writable: false, enumerable: false, configurable: false };
  return {
    get: kind === 'getter' ? method : undefined,
    set: kind === 'setter' ? method : undefined,
    enumerable: false,
    configurable: false,
  };
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
