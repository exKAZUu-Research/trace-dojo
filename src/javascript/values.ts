import type { TurtleState } from '../interpreter/turtleWorld';
import type { ClassNode, FunctionNode } from './ast';
import type { GeneratorState } from './generators';
import type { HostIterator } from './iteration';
import type { PromiseState } from './promises';
import type { Runtime } from './runtime';

/** A JavaScript value: primitives are the host's own, BigInts and symbols included, while objects are interpreter objects. */
export type Value = undefined | null | boolean | number | bigint | string | symbol | JsObject;

/** A property key, which JavaScript converts every other value to a string to make. */
export type Key = string | symbol;

export interface DataProperty {
  value: Value;
  writable: boolean;
  enumerable: boolean;
  configurable: boolean;
}

export interface AccessorProperty {
  get: JsFunction | undefined;
  set: JsFunction | undefined;
  enumerable: boolean;
  configurable: boolean;
}

export type Property = DataProperty | AccessorProperty;

export function isAccessor(property: Property): property is AccessorProperty {
  return !('value' in property);
}

/** Makes an object's properties read-only and stops it from gaining new ones, as `Object.freeze` does. */
export function freeze(object: JsObject): void {
  if (object instanceof JsArray) object.frozen = true;
  object.extensible = false;
  for (const property of object.properties.values()) {
    property.configurable = false;
    if (!isAccessor(property)) property.writable = false;
  }
}

export class JsObject {
  readonly properties = new Map<Key, Property>();
  /** `#name` fields, methods, and accessors, keyed by the identity of the class's private name. */
  privateMembers?: Map<string, Property>;
  extensible = true;
  /** Set by the builtin Turtle constructor. */
  turtle?: TurtleState;
  /** Set by the builtin Error constructors, which `Error.prototype.toString` and stack traces rely on. */
  isError = false;
  /** Set by the RegExp constructor and regular expression literals; never run itself, since it keeps no lastIndex. */
  regexp?: RegExp;
  /** Set on a builtin iterator, such as a generator, which loops and spreads step through and close early. */
  hostIterator?: HostIterator;
  /** Set on a generator object. */
  generator?: GeneratorState;
  /** Set on a promise. */
  promise?: PromiseState;

  constructor(public proto: JsObject | null) {}
}

/** An array index without an element, which reads as `undefined` but which most array methods skip. */
export const HOLE = Symbol('hole');
export type Element = Value | typeof HOLE;

export function valueOfElement(element: Element): Value {
  return element === HOLE ? undefined : element;
}

export class JsArray extends JsObject {
  /** Set by Object.freeze, which leaves the elements and the length read-only. */
  frozen = false;

  constructor(
    proto: JsObject | null,
    readonly elements: Element[]
  ) {
    super(proto);
  }
}

export interface NativeCall {
  runtime: Runtime;
  thisValue: Value;
  args: Value[];
  /** The constructor `new` was applied to, or undefined for a call. */
  newTarget: JsFunction | undefined;
  /** The row of the call in the learner's program, which the callbacks it makes count as calls from. */
  callRow: number | undefined;
}

export type NativeFunction = (call: NativeCall) => Value;

export type FunctionBehavior =
  | { kind: 'native'; run: NativeFunction; isConstructor: boolean }
  | {
      kind: 'user';
      node: FunctionNode;
      scope: Scope;
      /** The object whose prototype `super.name` reads, for methods. */
      homeObject?: JsObject;
    }
  | {
      kind: 'class';
      node: ClassNode;
      /** The constructor's body, or undefined for the default one. */
      ctor: FunctionNode | undefined;
      scope: Scope;
      homeObject: JsObject;
      isDerived: boolean;
      /** Instance fields, initialized when the constructor starts (or `super()` returns). */
      fields: ClassField[];
    };

export interface ClassField {
  key: Key;
  isPrivate: boolean;
  initialize: ((thisValue: JsObject) => Value) | undefined;
  stepRow: number | undefined;
  /** Whether the initializer only creates objects, so its step is left to their constructors' steps when they record. */
  onlyCalls: boolean;
  /** A private method or accessor, which every instance gets before its fields. */
  property?: Property;
}

export class JsFunction extends JsObject {
  /** Values a native function's closure keeps, such as what `bind` bound, which garbage collection must see. */
  captured: Value[] = [];

  constructor(
    proto: JsObject | null,
    readonly behavior: FunctionBehavior
  ) {
    super(proto);
  }

  get isConstructor(): boolean {
    const { behavior } = this;
    if (behavior.kind === 'native') return behavior.isConstructor;
    if (behavior.kind === 'class') return true;
    return behavior.node.kind === 'normal' && !behavior.node.isGenerator && !behavior.node.isAsync;
  }
}

/** A variable that a `let`, `const`, or `class` declaration has not reached yet. */
export const UNINITIALIZED = Symbol('uninitialized');

export interface Binding {
  value: Value | typeof UNINITIALIZED;
  isMutable: boolean;
  /** Set on a `var` whose declaration has not run yet, which learners do not see as a variable. */
  isHoisted?: boolean;
}

/** What a function's own scope knows about the call that created it. */
export interface FunctionFrame {
  /** `this`, uninitialized in a derived constructor until `super()` returns. */
  thisValue: Value | typeof UNINITIALIZED;
  homeObject: JsObject | undefined;
  /** The class whose constructor is running, for `super()` and field initialization. */
  constructing: JsFunction | undefined;
  newTarget: JsFunction | undefined;
}

export class Scope {
  readonly bindings = new Map<string, Binding>();

  constructor(
    readonly parent: Scope | undefined,
    /** Set on the scope of a non-arrow function call, which arrow functions inside it share. */
    readonly functionFrame?: FunctionFrame,
    /** Whether a call or the program created this scope, which starts the variables of one function. */
    readonly isCallScope = functionFrame !== undefined
  ) {}

  lookup(name: string): Binding | undefined {
    return this.bindings.get(name) ?? this.parent?.lookup(name);
  }

  nearestFunctionFrame(): FunctionFrame | undefined {
    return this.functionFrame ?? this.parent?.nearestFunctionFrame();
  }
}

/** Thrown through the host stack to carry a JavaScript exception. */
export class JsThrow {
  constructor(readonly value: Value) {}
}

export function isObject(value: Value): value is JsObject {
  return value instanceof JsObject;
}

export function toBoolean(value: Value): boolean {
  return isObject(value) || Boolean(value);
}

export function isCallable(value: Value): value is JsFunction {
  return value instanceof JsFunction;
}

/**
 * Appends `items` one by one: spreading an array that a program built into a call can exceed the host's argument
 * limit.
 */
export function appendAll<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item);
}

/** The `#name` a private key was made from, which each class evaluation makes unique. */
export function privateNameOf(key: string): string {
  return key.split('\0')[0];
}

/** The class that declared a private key, which tells apart members of the same name in a class and its subclass. */
export function privateClassOf(key: string): string {
  return key.split('\0')[1];
}

/** Whether a property key is an array index. */
export function arrayIndexOf(key: Key): number | undefined {
  if (typeof key !== 'string') return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return undefined;
  const index = Number(key);
  return index < 2 ** 32 - 1 ? index : undefined;
}
