import type { ClassMember, Expression } from './ast';
import type { Runtime } from './runtime';
import {
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
  target: JsObject;
  key: Key;
  /** What `context.name` gives: the key, or the `#name` of a private member. */
  name: Key;
  isPrivate: boolean;
  /** The property holding a method or accessor, in the class, its prototype, or the private members of either. */
  property?: Property;
  /** The field that stores a field's value, or an auto-accessor's. */
  field?: ClassField;
  /** What the member's decorators evaluated to, just before its key, as the standard orders them. */
  decorators?: Value[];
}

/** A class definition its decorators apply to: the class, its name, and its members in source order. */
export interface ClassDefinition {
  cls: JsFunction;
  name: string;
  members: MemberDefinition[];
  classDecorators: Value[];
  /** The rows the class's decorators are written on, which call them. */
  classDecoratorRows: number[];
}

/** The class a definition's decorators give, and the functions their `addInitializer` added, by when they run. */
export interface DecoratedClass {
  cls: JsFunction;
  /** Run with the class as `this` before its static fields. */
  staticInitializers: Value[];
  /** Run with each instance as `this` before its fields. */
  instanceInitializers: Value[];
  /** Run with the class the class decorators gave as `this`, after its static fields. */
  classInitializers: Value[];
}

/**
 * Evaluates the decorators of a class, when it or a member has any, before its heritage, as the standard orders them;
 * defining the members evaluates each member's decorators just before its key.
 */
export function evaluateClassDecorators(
  classDecorators: Expression[] | undefined,
  members: ClassMember[],
  evaluate: (expression: Expression) => Value
): Value[] | undefined {
  if (!classDecorators && !members.some((member) => member.kind !== 'staticBlock' && member.decorators))
    return undefined;
  return (classDecorators ?? []).map(evaluate);
}

/**
 * Applies TypeScript's standard decorators to a class definition, in the one order the standard gives: the methods
 * and accessors before the fields, the static ones of each before the others, each member's decorators from the last
 * one written, and then the class's own, all sharing a metadata object that inherits from the nearest decorated base.
 */
export function decorateClassDefinition(runtime: Runtime, definition: ClassDefinition): DecoratedClass {
  const symbol = metadataSymbol(runtime);
  const metadata = classMetadata(runtime, definition.cls, symbol);
  const staticInitializers: Value[] = [];
  const instanceInitializers: Value[] = [];
  const classInitializers: Value[] = [];
  const { temporaries } = runtime.frame;
  const held = temporaries.length;
  temporaries.push(metadata, definition.cls, ...definition.classDecorators);
  try {
    applyMemberDecorators(runtime, definition.members, staticInitializers, instanceInitializers, metadata);
    const cls = applyClassDecorators(runtime, definition, classInitializers, metadata);
    defineMetadataProperty(runtime, cls, symbol, metadata);
    return { cls, staticInitializers, instanceInitializers, classInitializers };
  } finally {
    temporaries.length = held;
  }
}

function applyMemberDecorators(
  runtime: Runtime,
  members: MemberDefinition[],
  staticInitializers: Value[],
  instanceInitializers: Value[],
  metadata: JsObject
): void {
  const { temporaries } = runtime.frame;
  const order = [
    ...members.filter((member) => !isField(member) && member.member.isStatic),
    ...members.filter((member) => !isField(member) && !member.member.isStatic),
    ...members.filter((member) => isField(member) && member.member.isStatic),
    ...members.filter((member) => isField(member) && !member.member.isStatic),
  ];
  for (const member of order) {
    const added = member.member.isStatic ? staticInitializers : instanceInitializers;
    const decorators = member.decorators ?? [];
    if (decorators.length === 0) continue;
    for (const decorator of decorators) temporaries.push(decorator);
    const working = openWorkingDescriptor(member);
    for (let index = decorators.length - 1; index >= 0; index--) {
      decorateMember(runtime, member, index, added, metadata, working);
    }
    if (working) installWorkingDescriptor(runtime, member, working);
  }
}

function applyClassDecorators(
  runtime: Runtime,
  definition: ClassDefinition,
  classInitializers: Value[],
  metadata: JsObject
): JsFunction {
  const { temporaries } = runtime.frame;
  let cls = definition.cls;
  for (let index = definition.classDecorators.length - 1; index >= 0; index--) {
    const context = decoratorContext(runtime, 'class', definition.name, classInitializers, metadata);
    const decorator = requireCallable(runtime, definition.classDecorators[index]);
    const result = callDecorator(runtime, decorator, cls, context, definition.classDecoratorRows[index]);
    if (result === undefined) continue;
    if (!(result instanceof JsFunction)) runtime.throwError('TypeError', 'class decorators must return a function');
    cls = result as JsFunction;
    temporaries.push(cls);
  }
  return cls;
}

/** Whether a member is a field without `accessor`, whose decorators apply after those of methods and accessors. */
function isField(member: MemberDefinition): boolean {
  return member.member.kind === 'field' && !member.member.isAutoAccessor;
}

function metadataSymbol(runtime: Runtime): symbol {
  const symbolCtor = runtime.realm.globals.lookup('Symbol')?.value;
  const supplied = isObject(symbolCtor) ? runtime.get(symbolCtor, 'metadata') : undefined;
  if (typeof supplied === 'symbol') return supplied;
  const { symbolRegistry } = runtime.realm;
  let symbol = symbolRegistry.get('Symbol.metadata');
  if (!symbol) {
    runtime.allocate(1);
    symbol = Symbol('Symbol.metadata');
    symbolRegistry.set('Symbol.metadata', symbol);
  }
  return symbol;
}

/**
 * The metadata object a class's decorators share, which inherits from that of the nearest decorated superclass, as
 * `context.metadata` does under the standard.
 */
function classMetadata(runtime: Runtime, cls: JsFunction, symbol: symbol): JsObject {
  const inherited = cls.proto && runtime.hasProperty(cls.proto, symbol) ? runtime.get(cls.proto, symbol) : undefined;
  // oxlint-disable-next-line unicorn/no-null -- The metadata object of a class without a decorated base has no prototype.
  return runtime.newObject(isObject(inherited) ? inherited : null);
}

function defineMetadataProperty(runtime: Runtime, target: JsFunction, symbol: symbol, metadata: JsObject): void {
  runtime.defineProperty(target, symbol, {
    value: metadata,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Runs the functions decorators added, with `thisValue` as `this`, draining one-shot queues when `consume` is set. */
export function runInitializers(runtime: Runtime, initializers: Value[], thisValue: Value, consume = false): void {
  if (consume) {
    while (initializers.length > 0) runtime.call(initializers.shift() as Value, thisValue, []);
    return;
  }
  for (const initializer of initializers) runtime.call(initializer, thisValue, []);
}

interface WorkingDescriptor {
  hasValue: boolean;
  value: Value;
  writable: boolean | undefined;
  hasAccessor: boolean;
  get: JsFunction | undefined;
  set: JsFunction | undefined;
  enumerable: boolean;
  configurable: boolean;
}

const INVALID_DESCRIPTOR_MESSAGE =
  'Invalid property descriptor. Cannot both specify accessors and a value or writable attribute, #<Object>';

function openWorkingDescriptor({
  member,
  target,
  key,
  isPrivate,
  property,
}: MemberDefinition): WorkingDescriptor | undefined {
  if (member.kind === 'field' && !member.isAutoAccessor) return undefined;
  const base = isPrivate || member.kind === 'field' ? property : (target.properties.get(key) ?? property);
  if (!base) return undefined;
  if (isAccessor(base)) {
    return {
      hasValue: false,
      value: undefined,
      writable: undefined,
      hasAccessor: true,
      get: base.get,
      set: base.set,
      enumerable: base.enumerable,
      configurable: base.configurable,
    };
  }
  return {
    hasValue: true,
    value: base.value,
    writable: base.writable,
    hasAccessor: false,
    get: undefined,
    set: undefined,
    enumerable: base.enumerable,
    configurable: base.configurable,
  };
}

function installWorkingDescriptor(
  runtime: Runtime,
  { target, key, isPrivate }: MemberDefinition,
  working: WorkingDescriptor
): void {
  if (working.hasAccessor && (working.hasValue || working.writable !== undefined)) {
    runtime.throwError('TypeError', INVALID_DESCRIPTOR_MESSAGE);
  }
  if (isPrivate) return;
  const installed: Property = working.hasAccessor
    ? { get: working.get, set: working.set, enumerable: working.enumerable, configurable: working.configurable }
    : {
        value: working.value,
        writable: working.writable ?? true,
        enumerable: working.enumerable,
        configurable: working.configurable,
      };
  target.properties.set(key, installed);
}

function decorateMember(
  runtime: Runtime,
  definition: MemberDefinition,
  index: number,
  initializers: Value[],
  metadata: JsObject,
  working: WorkingDescriptor | undefined
): void {
  const { member, field } = definition;
  const callRow = member.decorators?.[index]?.row;
  const kind = member.kind === 'field' ? (member.isAutoAccessor ? 'accessor' : 'field') : member.kind;
  // A field's or an auto-accessor's decorators add initializers that run right after its storage is defined on each
  // instance or the class.
  const added = (kind === 'field' || kind === 'accessor') && field ? (field.initializers ??= []) : initializers;
  const context = decoratorContext(runtime, kind, definition.name, added, metadata, definition);
  const callable = requireCallable(runtime, definition.decorators?.[index]);
  if (kind === 'field') {
    const initializer = callDecorator(runtime, callable, undefined, context, callRow);
    if (initializer !== undefined) addTransform(field, requireCallable(runtime, initializer));
    return;
  }
  if (!working) return;
  if (kind === 'accessor') {
    decorateAutoAccessor(runtime, { working, definition, decorator: callable, context, callRow });
    return;
  }
  applyMethodOrAccessorDecorator(runtime, working, definition, kind, { callable, context, callRow });
}

function applyMethodOrAccessorDecorator(
  runtime: Runtime,
  working: WorkingDescriptor,
  { isPrivate, property }: MemberDefinition,
  kind: 'method' | 'getter' | 'setter',
  { callable, context, callRow }: { callable: Value; context: DecoratorContextHandle; callRow: number | undefined }
): void {
  if (kind === 'getter' || kind === 'setter') {
    const slot = kind === 'getter' ? 'get' : 'set';
    const result = callDecorator(runtime, callable, working[slot], context, callRow);
    if (result === undefined) return;
    const replacement = requireFunction(runtime, result);
    working.hasAccessor = true;
    working[slot] = replacement;
    if (isPrivate && property && isAccessor(property)) property[slot] = replacement;
    return;
  }
  const result = callDecorator(runtime, callable, working.value, context, callRow);
  if (result === undefined) return;
  const replacement = requireFunction(runtime, result);
  working.hasValue = true;
  working.value = replacement;
  if (isPrivate && property && !isAccessor(property)) property.value = replacement;
}

/** An auto-accessor's decorator, which may replace its getter and setter and transform its initial value. */
function decorateAutoAccessor(
  runtime: Runtime,
  {
    working,
    definition: { isPrivate, property, field },
    decorator,
    context,
    callRow,
  }: {
    working: WorkingDescriptor;
    definition: MemberDefinition;
    decorator: Value;
    context: DecoratorContextHandle;
    callRow?: number;
  }
): void {
  const target = runtime.newObject();
  runtime.createDataProperty(target, 'get', working.get);
  runtime.createDataProperty(target, 'set', working.set);
  const result = callDecorator(runtime, decorator, target, context, callRow);
  if (result === undefined) return;
  if (!isObject(result)) runtime.throwError('TypeError', 'accessor decorators must return an object');
  const get = runtime.get(result, 'get');
  const set = runtime.get(result, 'set');
  const init = runtime.get(result, 'init');
  if (get !== undefined)
    updateAccessorSlot(working, isPrivate ? property : undefined, 'get', requireFunction(runtime, get));
  if (set !== undefined)
    updateAccessorSlot(working, isPrivate ? property : undefined, 'set', requireFunction(runtime, set));
  if (init !== undefined) addTransform(field, requireCallable(runtime, init));
}

function updateAccessorSlot(
  working: WorkingDescriptor,
  privateProperty: Property | undefined,
  slot: 'get' | 'set',
  fn: JsFunction
): void {
  working.hasAccessor = true;
  working[slot] = fn;
  if (privateProperty && isAccessor(privateProperty)) privateProperty[slot] = fn;
}

function requireFunction(runtime: Runtime, value: Value): JsFunction {
  requireCallable(runtime, value);
  return value as JsFunction;
}

/** Decorators are applied from the last one written, and their initializers transform the value from the first one. */
function addTransform(field: ClassField | undefined, transform: Value): void {
  if (field) (field.transforms ??= []).unshift(transform);
}

interface DecoratorContextHandle {
  context: JsObject;
  finish: () => void;
}

function callDecorator(
  runtime: Runtime,
  callable: Value,
  target: Value,
  { context, finish }: DecoratorContextHandle,
  callRow?: number
): Value {
  try {
    return runtime.call(callable, undefined, [target, context], callRow);
  } finally {
    finish();
  }
}

function decoratorContext(
  runtime: Runtime,
  kind: string,
  name: Key,
  initializers: Value[],
  metadata: JsObject,
  definition?: MemberDefinition
): DecoratorContextHandle {
  const context = runtime.newObject();
  runtime.createDataProperty(context, 'kind', kind);
  runtime.createDataProperty(context, 'name', name);
  if (definition) {
    runtime.createDataProperty(context, 'static', definition.member.isStatic);
    runtime.createDataProperty(context, 'private', definition.isPrivate);
    runtime.createDataProperty(context, 'access', memberAccess(runtime, definition, kind));
  }
  runtime.createDataProperty(context, 'metadata', metadata);
  const { temporaries } = runtime.frame;
  let finished = false;
  const addInitializer = runtime.newNativeFunction('addInitializer', 1, ({ runtime: caller, args }) => {
    if (finished) caller.throwError('TypeError', 'Already initialized');
    const initializer = requireCallable(caller, args[0]);
    initializers.push(initializer);
    temporaries.push(initializer);
    return;
  });
  runtime.createDataProperty(context, 'addInitializer', addInitializer);
  return {
    context,
    finish: () => {
      finished = true;
    },
  };
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
