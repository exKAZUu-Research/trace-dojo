import type { ClassMember, Expression } from './ast';
import type { Runtime } from './runtime';
import {
  type AccessorProperty,
  type ClassField,
  isAccessor,
  isCallable,
  isObject,
  JsFunction,
  type JsObject,
  type Key,
  type Property,
  type Value,
} from './values';

type DecoratedMember = Exclude<ClassMember, { kind: 'staticBlock' }>;

/** A member the class defined, with where it lives, which its decorators replace or wrap. */
export interface MemberDefinition {
  member: DecoratedMember;
  key: Key;
  /** What `context.name` gives: the key, or the `#name` of a private member. */
  name: Key;
  isPrivate: boolean;
  /** The property holding a method or accessor, in the class, its prototype, or the private members of either. */
  property?: Property;
  /** The field that stores a field's value, or an auto-accessor's. */
  field?: ClassField;
}

/** The decorators a class and its members evaluated to, in source order. */
export interface EvaluatedDecorators {
  classDecorators: Value[];
  members: Map<ClassMember, Value[]>;
}

/** The functions decorators added with `context.addInitializer`, by when they run. */
export interface DecoratorInitializers {
  /** Run with the class as `this` before its static fields. */
  staticMembers: Value[];
  /** Run with each instance as `this` before its fields. */
  instanceMembers: Value[];
}

/** Evaluates the decorators of a class and then of its members, in source order, as their expressions are written. */
export function evaluateDecorators(
  classDecorators: Expression[] | undefined,
  members: ClassMember[],
  evaluate: (expression: Expression) => Value
): EvaluatedDecorators | undefined {
  if (!classDecorators && !members.some((member) => member.kind !== 'staticBlock' && member.decorators))
    return undefined;
  const evaluated: EvaluatedDecorators = {
    classDecorators: (classDecorators ?? []).map(evaluate),
    members: new Map(),
  };
  for (const member of members)
    if (member.kind !== 'staticBlock' && member.decorators)
      evaluated.members.set(member, member.decorators.map(evaluate));
  return evaluated;
}

/**
 * Applies the decorators of a class's members, as TypeScript's standard decorators do: the methods and accessors before
 * the fields, the static ones of each before the others, and each member's decorators from the last one written.
 */
export function decorateMembers(
  runtime: Runtime,
  definitions: MemberDefinition[],
  decorators: EvaluatedDecorators,
  metadata: JsObject
): DecoratorInitializers {
  const initializers: DecoratorInitializers = { staticMembers: [], instanceMembers: [] };
  const isField = (definition: MemberDefinition): boolean =>
    definition.member.kind === 'field' && !definition.member.isAutoAccessor;
  const order = [
    ...definitions.filter((definition) => !isField(definition) && definition.member.isStatic),
    ...definitions.filter((definition) => !isField(definition) && !definition.member.isStatic),
    ...definitions.filter((definition) => isField(definition) && definition.member.isStatic),
    ...definitions.filter((definition) => isField(definition) && !definition.member.isStatic),
  ];
  for (const definition of order) {
    const applied = decorators.members.get(definition.member);
    if (!applied) continue;
    const added = definition.member.isStatic ? initializers.staticMembers : initializers.instanceMembers;
    for (const decorator of applied.toReversed()) decorateMember(runtime, definition, decorator, added, metadata);
  }
  return initializers;
}

/** Applies a class's decorators from the last one written, returning the class each gives and what they added. */
export function decorateClass(
  runtime: Runtime,
  cls: JsFunction,
  name: string,
  decorators: Value[],
  metadata: JsObject
): { cls: JsFunction; initializers: Value[] } {
  let decorated = cls;
  const initializers: Value[] = [];
  for (const decorator of decorators.toReversed()) {
    const context = decoratorContext(runtime, 'class', name, initializers, metadata);
    const result = runtime.call(requireCallable(runtime, decorator), undefined, [decorated, context]);
    if (result === undefined) continue;
    if (!(result instanceof JsFunction)) runtime.throwError('TypeError', 'class decorators must return a function');
    decorated = result as JsFunction;
  }
  return { cls: decorated, initializers };
}

/** Runs the functions decorators added, with `thisValue` as `this`. */
export function runInitializers(runtime: Runtime, initializers: Value[], thisValue: Value): void {
  for (const initializer of initializers) runtime.call(initializer, thisValue, []);
}

// code-gauge-allow functionCognitiveComplexity -- Applies each kind of member's decorator as the standard defines it.
function decorateMember(
  runtime: Runtime,
  definition: MemberDefinition,
  decorator: Value,
  initializers: Value[],
  metadata: JsObject
): void {
  const { member, property, field } = definition;
  const kind = member.kind === 'field' ? (member.isAutoAccessor ? 'accessor' : 'field') : member.kind;
  const context = decoratorContext(runtime, kind, definition.name, initializers, metadata, definition);
  const callable = requireCallable(runtime, decorator);
  if (kind === 'field') {
    const initializer = runtime.call(callable, undefined, [undefined, context]);
    if (initializer !== undefined) addTransform(field, requireCallable(runtime, initializer));
    return;
  }
  if (!property) return;
  if (isAccessor(property)) {
    if (kind === 'accessor') decorateAutoAccessor(runtime, property, field, callable, context);
    else {
      const slot = kind === 'getter' ? 'get' : 'set';
      const result = runtime.call(callable, undefined, [property[slot], context]);
      if (result !== undefined) property[slot] = requireFunction(runtime, result);
    }
    return;
  }
  const result = runtime.call(callable, undefined, [property.value, context]);
  if (result !== undefined) property.value = requireFunction(runtime, result);
}

/** An auto-accessor's decorator, which may replace its getter and setter and transform its initial value. */
function decorateAutoAccessor(
  runtime: Runtime,
  property: AccessorProperty,
  field: ClassField | undefined,
  decorator: Value,
  context: JsObject
): void {
  const target = runtime.newObject();
  runtime.createDataProperty(target, 'get', property.get);
  runtime.createDataProperty(target, 'set', property.set);
  const result = runtime.call(decorator, undefined, [target, context]);
  if (result === undefined) return;
  if (!isObject(result)) runtime.throwError('TypeError', 'accessor decorators must return an object');
  const get = runtime.get(result, 'get');
  const set = runtime.get(result, 'set');
  const init = runtime.get(result, 'init');
  if (get !== undefined) property.get = requireFunction(runtime, get);
  if (set !== undefined) property.set = requireFunction(runtime, set);
  if (init !== undefined) addTransform(field, requireCallable(runtime, init));
}

function requireFunction(runtime: Runtime, value: Value): JsFunction {
  requireCallable(runtime, value);
  return value as JsFunction;
}

function addTransform(field: ClassField | undefined, transform: Value): void {
  if (field) (field.transforms ??= []).push(transform);
}

function decoratorContext(
  runtime: Runtime,
  kind: string,
  name: Key,
  initializers: Value[],
  metadata: JsObject,
  definition?: MemberDefinition
): JsObject {
  const context = runtime.newObject();
  runtime.createDataProperty(context, 'kind', kind);
  runtime.createDataProperty(context, 'name', name);
  if (definition) {
    runtime.createDataProperty(context, 'static', definition.member.isStatic);
    runtime.createDataProperty(context, 'private', definition.isPrivate);
    runtime.createDataProperty(context, 'access', memberAccess(runtime, definition, kind));
  }
  runtime.createDataProperty(context, 'metadata', metadata);
  const addInitializer = runtime.newNativeFunction('addInitializer', 1, ({ runtime: caller, args }) => {
    initializers.push(requireCallable(caller, args[0]));
    return;
  });
  if (kind !== 'field') runtime.createDataProperty(context, 'addInitializer', addInitializer);
  return context;
}

/** `context.access`, whose `has`, `get`, and `set` reach the member on an object as the class's own code would. */
function memberAccess(runtime: Runtime, definition: MemberDefinition, kind: string): JsObject {
  const access = runtime.newObject();
  const { key } = definition;
  const privateKey = definition.isPrivate && typeof key === 'string' ? key : undefined;
  const define = (name: string, length: number, run: (args: Value[]) => Value): void =>
    runtime.createDataProperty(
      access,
      name,
      runtime.newNativeFunction(name, length, ({ args }) => run(args))
    );
  define('has', 1, ([target]) => isObject(target) && hasMember(runtime, target as JsObject, key, privateKey));
  if (kind !== 'setter')
    define('get', 1, ([target]) => (privateKey ? runtime.getPrivate(target, privateKey) : runtime.get(target, key)));
  if (kind === 'field' || kind === 'accessor' || kind === 'setter')
    define('set', 2, ([target, value]) => {
      if (privateKey) runtime.setPrivate(target, privateKey, value);
      else runtime.set(target, key, value);
      return;
    });
  return access;
}

function hasMember(runtime: Runtime, target: JsObject, key: Key, privateKey: string | undefined): boolean {
  return privateKey ? target.privateMembers?.has(privateKey) === true : runtime.hasProperty(target, key);
}

function requireCallable(runtime: Runtime, value: Value): Value {
  if (!isCallable(value)) runtime.throwError('TypeError', `${runtime.describePlain(value)} is not a function`);
  return value;
}
