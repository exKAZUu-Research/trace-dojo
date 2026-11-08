import type { Expression, FunctionNode, MemberExpression, Pattern, PropertyName, ScopeDeclarations } from './ast';
import { DONE } from './iteration';
import type { Runtime } from './runtime';
import { type FunctionFrame, isObject, JsFunction, type JsObject, Scope, UNINITIALIZED, type Value } from './values';

/** How a pattern stores the values it destructures. */
export type BindingMode =
  /** Assigns to existing variables and properties. */
  | 'assign'
  /** Initializes variables that a declaration or a parameter list created in an enclosing scope. */
  | 'initialize';

export type Reference =
  | { kind: 'binding'; name: string }
  | { kind: 'property'; base: Value; key: string }
  | { kind: 'private'; base: Value; name: string }
  | { kind: 'super'; key: string; thisValue: Value };

/** Ends an optional chain whose object was null or undefined. */
export const SHORT_CIRCUIT = Symbol('shortCircuit');

export abstract class EvaluatorBase {
  constructor(readonly runtime: Runtime) {}

  abstract evaluate(expression: Expression): Value;

  abstract createFunction(node: FunctionNode, scope: Scope, homeObject?: JsObject): JsFunction;

  // Scopes ------------------------------------------------------------------------------------------------------------

  /** Creates the variables a scope declares; function declarations become functions at once. */
  instantiate(scope: Scope, declarations: ScopeDeclarations): void {
    const { runtime } = this;
    runtime.allocate(declarations.order.length);
    const lexical = new Map(declarations.lexical.map(({ name, isConst }) => [name, isConst]));
    // The last declaration of a function with a repeated name wins.
    const functions = new Map(declarations.functions.map((fn) => [fn.name, fn]));
    for (const name of declarations.order) {
      const fn = functions.get(name);
      const isConst = lexical.get(name);
      if (fn) scope.bindings.set(name, { value: this.createFunction(fn, scope), isMutable: true });
      else if (isConst !== undefined) scope.bindings.set(name, { value: UNINITIALIZED, isMutable: !isConst });
      // A parameter of the same name keeps its value.
      else if (!scope.bindings.has(name))
        scope.bindings.set(name, { value: undefined, isMutable: true, isHoisted: true });
    }
  }

  /** Runs `run` in a new scope with `declarations`, or in the current one when nothing is declared. */
  withScope<T>(declarations: ScopeDeclarations, run: () => T): T {
    if (declarations.lexical.length === 0 && declarations.functions.length === 0 && declarations.vars.length === 0) {
      return run();
    }
    const frame = this.runtime.frame;
    const outer = frame.scope;
    frame.scope = new Scope(outer);
    try {
      this.instantiate(frame.scope, declarations);
      return run();
    } finally {
      frame.scope = outer;
    }
  }

  /** Runs `run` with the current frame in `scope`. */
  inScope<T>(scope: Scope, run: () => T): T {
    const frame = this.runtime.frame;
    const outer = frame.scope;
    frame.scope = scope;
    try {
      return run();
    } finally {
      frame.scope = outer;
    }
  }

  functionFrame(): FunctionFrame | undefined {
    return this.runtime.frame.scope.nearestFunctionFrame();
  }

  thisValue(): Value {
    const thisValue = this.functionFrame()?.thisValue;
    if (thisValue === UNINITIALIZED) {
      return this.runtime.throwError(
        'ReferenceError',
        "Must call super constructor in derived class before accessing 'this' or returning from derived constructor"
      );
    }
    return thisValue;
  }

  // Variables ---------------------------------------------------------------------------------------------------------

  readVariable(name: string): Value {
    const binding = this.runtime.frame.scope.lookup(name);
    if (!binding) return this.runtime.throwError('ReferenceError', `${name} is not defined`);
    if (binding.value === UNINITIALIZED) {
      return this.runtime.throwError('ReferenceError', `Cannot access '${name}' before initialization`);
    }
    return binding.value;
  }

  writeVariable(name: string, value: Value, mode: BindingMode): void {
    const { runtime } = this;
    const binding = runtime.frame.scope.lookup(name);
    if (!binding) return runtime.throwError('ReferenceError', `${name} is not defined`);
    if (mode === 'initialize') {
      binding.value = value;
      binding.isHoisted = false;
      return;
    }
    if (binding.value === UNINITIALIZED)
      runtime.throwError('ReferenceError', `Cannot access '${name}' before initialization`);
    if (!binding.isMutable) runtime.throwError('TypeError', 'Assignment to constant variable.');
    binding.value = value;
    binding.isHoisted = false;
  }

  /** Shows a hoisted `var` once its declaration runs, keeping the value it has. */
  revealVar(name: string): void {
    const binding = this.runtime.frame.scope.lookup(name);
    if (binding) binding.isHoisted = false;
  }

  /**
   * The identity of a private name, which the innermost enclosing class declaring it created, so that a subclass may
   * declare the same name for a member of its own.
   */
  privateKey(name: string): string {
    const key = this.runtime.frame.scope.lookup(name)?.value;
    if (typeof key !== 'string') {
      return this.runtime.throwError('SyntaxError', `Private field '${name}' must be declared in an enclosing class`);
    }
    return key;
  }

  // References --------------------------------------------------------------------------------------------------------

  /** Evaluates the parts of an assignment target before its value, as JavaScript does. */
  reference(target: Pattern): Reference {
    if (target.kind === 'identifier') return { kind: 'binding', name: target.name };
    if (target.kind !== 'member') throw new Error(`Not a simple target: ${target.kind}`);
    return this.memberReference(target);
  }

  memberReference(member: MemberExpression): Reference {
    if (member.object.kind === 'super') {
      const thisValue = this.thisValue();
      return { kind: 'super', key: this.propertyKey(member.property), thisValue };
    }
    const base = this.evaluate(member.object);
    return this.runtime.hold(base, (): Reference => {
      if (member.property.kind === 'private')
        return { kind: 'private', base, name: this.privateKey(member.property.name) };
      return { kind: 'property', base, key: this.propertyKey(member.property) };
    });
  }

  propertyKey(name: PropertyName): string {
    if (name.kind === 'key') return name.key;
    if (name.kind === 'private') return this.privateKey(name.name);
    return this.runtime.toPropertyKey(this.evaluate(name.expression));
  }

  // code-gauge-allow duplicateLines 17 -- Reading and writing a reference switch over the same kinds of reference.
  getReference(reference: Reference): Value {
    const { runtime } = this;
    switch (reference.kind) {
      case 'binding': {
        return this.readVariable(reference.name);
      }
      case 'property': {
        return runtime.get(reference.base, reference.key);
      }
      case 'private': {
        return runtime.getPrivate(reference.base, reference.name);
      }
      case 'super': {
        const home = this.functionFrame()?.homeObject;
        return home?.proto ? runtime.get(home.proto, reference.key, reference.thisValue) : undefined;
      }
    }
  }

  // code-gauge-allow duplicateLines 17 -- Reading and writing a reference switch over the same kinds of reference.
  putReference(reference: Reference, value: Value): void {
    const { runtime } = this;
    switch (reference.kind) {
      case 'binding': {
        this.writeVariable(reference.name, value, 'assign');
        return;
      }
      case 'property': {
        runtime.set(reference.base, reference.key, value);
        return;
      }
      case 'private': {
        runtime.setPrivate(reference.base, reference.name, value);
        return;
      }
      case 'super': {
        // The property is looked up from the parent's prototype, while a setter or a data write acts on `this`.
        const home = this.functionFrame()?.homeObject;
        runtime.set(reference.thisValue, reference.key, value, home?.proto ?? undefined);
        return;
      }
    }
  }

  // Patterns ----------------------------------------------------------------------------------------------------------

  /** Binds a pattern, whose getters and setters count as called from the pattern's row. */
  bindPattern(pattern: Pattern, value: Value, mode: BindingMode): void {
    const { runtime } = this;
    const outerRow = runtime.currentRow;
    runtime.currentRow = pattern.row;
    try {
      this.bindPatternKind(pattern, value, mode);
    } finally {
      runtime.currentRow = outerRow;
    }
  }

  private bindPatternKind(pattern: Pattern, value: Value, mode: BindingMode): void {
    const { runtime } = this;
    switch (pattern.kind) {
      case 'identifier': {
        this.writeVariable(pattern.name, value, mode);
        return;
      }
      case 'member': {
        const reference = runtime.hold(value, () => this.memberReference(pattern));
        this.putReference(reference, value);
        return;
      }
      case 'default': {
        const resolved = value === undefined ? this.evaluate(pattern.value) : value;
        if (pattern.target.kind === 'identifier' && resolved instanceof JsFunction)
          nameFunction(runtime, resolved, pattern.target.name);
        this.bindPattern(pattern.target, resolved, mode);
        return;
      }
      case 'arrayPattern': {
        runtime.hold(value, () => this.bindArrayPattern(pattern, value, mode));
        return;
      }
      case 'objectPattern': {
        if (value === undefined || value === null) {
          runtime.throwError('TypeError', `Cannot destructure '${String(value)}' as it is ${String(value)}.`);
        }
        runtime.hold(value, () => this.bindObjectPattern(pattern, value, mode));
        return;
      }
    }
  }

  private bindArrayPattern(pattern: Extract<Pattern, { kind: 'arrayPattern' }>, value: Value, mode: BindingMode): void {
    const { runtime } = this;
    // Each binding reads the next value just before it runs, since an earlier default or target may change the array.
    const iterator = runtime.iterator(value);
    for (const element of pattern.elements) {
      const next = iterator.next();
      if (element) this.bindPattern(element, next === DONE ? undefined : next, mode);
    }
    if (pattern.rest) this.bindPattern(pattern.rest, runtime.newArray(iterator.rest()), mode);
  }

  private bindObjectPattern(
    pattern: Extract<Pattern, { kind: 'objectPattern' }>,
    value: Value,
    mode: BindingMode
  ): void {
    const used = new Set<string>();
    for (const property of pattern.properties) {
      const key = this.propertyKey(property.key);
      used.add(key);
      this.bindPattern(property.value, this.runtime.get(value, key), mode);
    }
    if (pattern.rest) this.bindPattern(pattern.rest, this.restObject(value, used), mode);
  }

  private restObject(value: Value, used: Set<string>): JsObject {
    const { runtime } = this;
    const rest = runtime.newObject();
    // A string's characters are its own properties.
    const source = typeof value === 'string' ? runtime.toObject(value) : value;
    if (!isObject(source)) return rest;
    // Held while getters run, so the turtles copied so far stay reachable.
    return runtime.hold(rest, () => {
      for (const key of runtime.ownEnumerableKeys(source)) {
        if (!used.has(key)) runtime.createDataProperty(rest, key, runtime.get(source, key));
      }
      return rest;
    });
  }
}

/** Names a function by the variable or parameter default it was assigned to when it has no name yet. */
export function nameFunction(runtime: Runtime, fn: JsFunction, name: string): void {
  if (runtime.functionName(fn) !== '' || fn.behavior.kind === 'native') return;
  fn.properties.set('name', { value: name, writable: false, enumerable: false, configurable: true });
}

/** The variables a pattern declares, in order. */
export function patternNames(pattern: Pattern): string[] {
  switch (pattern.kind) {
    case 'identifier': {
      return [pattern.name];
    }
    case 'member': {
      return [];
    }
    case 'default': {
      return patternNames(pattern.target);
    }
    case 'arrayPattern': {
      return [...pattern.elements, pattern.rest].flatMap((element) => (element ? patternNames(element) : []));
    }
    case 'objectPattern': {
      return [...pattern.properties.map(({ value }) => value), pattern.rest].flatMap((value) =>
        value ? patternNames(value) : []
      );
    }
  }
}

/** The object a reference reads from, which must stay reachable while the rest of an assignment runs. */
export function referenceBase(reference: Reference): Value {
  if (reference.kind === 'property' || reference.kind === 'private') return reference.base;
  if (reference.kind === 'super') return reference.thisValue;
  return undefined;
}
