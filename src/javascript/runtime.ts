import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type TurtleState, TurtleWorld } from '../interpreter/turtleWorld';
import { Evaluator } from './evaluator';
import { createRealm, type ErrorName, type Realm } from './realm';
import {
  type AccessorProperty,
  appendAll,
  arrayIndexOf,
  type DataProperty,
  isAccessor,
  isCallable,
  isObject,
  JsArray,
  JsFunction,
  JsObject,
  JsThrow,
  type NativeFunction,
  type Property,
  type Scope,
  UNINITIALIZED,
  type Value,
} from './values';

export class Frame {
  /** Values a pending call or allocation holds outside any variable, which must keep their turtles alive. */
  readonly temporaries: Value[] = [];

  constructor(
    public scope: Scope,
    /** The row of the call that created this frame, or undefined for the program and implicit calls. */
    readonly callRow: number | undefined
  ) {}
}

type Primitive = undefined | null | boolean | number | string;

export class Runtime {
  readonly world = new TurtleWorld();
  readonly budget = new ExecutionBudget();
  readonly frames: Frame[] = [];
  readonly realm: Realm;
  /** Called after a statement on a `// step` row completes. */
  onStep?: (stepId: number) => void;
  readonly evaluator: Evaluator;
  private allocatedSlots = 0;

  constructor() {
    this.realm = createRealm(this);
    this.evaluator = new Evaluator(this);
  }

  get frame(): Frame {
    return this.frames.at(-1) as Frame;
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  /** Charges for array elements or properties before they are allocated. */
  allocate(count: number): void {
    this.allocatedSlots += count;
    if (this.allocatedSlots > LIMITS.maxSlots) this.throwError('RangeError', 'Out of memory');
    this.spend(Math.ceil(count / 64));
  }

  /** Charges for a string of `length` built at run time. */
  buildString(length: number): void {
    if (length > LIMITS.maxStringLength) this.throwError('RangeError', 'Invalid string length');
    this.spend(Math.ceil(length / 16));
  }

  /** Charges for reading `length` elements or characters, which one native call may do at once. */
  scan(length: number): void {
    this.spend(Math.ceil(length / 64));
  }

  // Objects ----------------------------------------------------------------------------------------------------------

  newObject(proto: JsObject | null = this.realm.objectPrototype): JsObject {
    this.allocate(1);
    return new JsObject(proto);
  }

  newArray(elements: Value[]): JsArray {
    this.allocate(elements.length + 1);
    return new JsArray(this.realm.arrayPrototype, elements);
  }

  newNativeFunction(name: string, length: number, run: NativeFunction, isConstructor = false): JsFunction {
    const fn = new JsFunction(this.realm.functionPrototype, { kind: 'native', run, isConstructor });
    defineHidden(fn, 'length', length, false);
    defineHidden(fn, 'name', name, false);
    return fn;
  }

  throwError(name: ErrorName, message: string): never {
    throw new JsThrow(this.newError(name, message));
  }

  newError(name: ErrorName, message: string): JsObject {
    const error = new JsObject(this.realm.errorPrototypes[name]);
    error.isError = true;
    defineHidden(error, 'message', message);
    return error;
  }

  getOwnProperty(object: JsObject, key: string): Property | undefined {
    if (object instanceof JsArray) {
      if (key === 'length')
        return { value: object.elements.length, writable: true, enumerable: false, configurable: false };
      const index = arrayIndexOf(key);
      if (index !== undefined) {
        return index < object.elements.length
          ? { value: object.elements[index], writable: true, enumerable: true, configurable: true }
          : undefined;
      }
    }
    return object.properties.get(key);
  }

  get(value: Value, key: string, receiver: Value = value): Value {
    let object: JsObject | null;
    if (value instanceof JsObject) {
      if (value instanceof JsArray) {
        const index = arrayIndexOf(key);
        if (index !== undefined && index < value.elements.length) return value.elements[index];
        if (key === 'length') return value.elements.length;
      }
      object = value;
    } else if (typeof value === 'string') {
      if (key === 'length') return value.length;
      const index = arrayIndexOf(key);
      if (index !== undefined) return index < value.length ? value[index] : undefined;
      object = this.realm.stringPrototype;
    } else if (typeof value === 'number') {
      object = this.realm.numberPrototype;
    } else if (typeof value === 'boolean') {
      object = this.realm.booleanPrototype;
    } else {
      return this.throwError('TypeError', `Cannot read properties of ${String(value)} (reading '${key}')`);
    }
    for (let current: JsObject | null = object; current; current = current.proto) {
      const property = this.getOwnProperty(current, key);
      if (!property) continue;
      if (!isAccessor(property)) return property.value;
      return property.get ? this.call(property.get, receiver, []) : undefined;
    }
    return undefined;
  }

  set(target: Value, key: string, value: Value): void {
    if (!(target instanceof JsObject)) {
      if (target === undefined || target === null) {
        this.throwError('TypeError', `Cannot set properties of ${String(target)} (setting '${key}')`);
      }
      this.throwError('TypeError', `Cannot create property '${key}' on ${typeof target} '${String(target)}'`);
    }
    if (target instanceof JsArray) {
      const index = arrayIndexOf(key);
      if (index !== undefined) {
        this.setElement(target, index, value);
        return;
      }
      if (key === 'length') {
        this.setLength(target, value);
        return;
      }
    }
    for (let current: JsObject | null = target; current; current = current.proto) {
      const property = this.getOwnProperty(current, key);
      if (!property) continue;
      if (isAccessor(property)) {
        if (!property.set)
          this.throwError(
            'TypeError',
            `Cannot set property ${key} of ${this.describe(target)} which has only a getter`
          );
        this.call(property.set, target, [value]);
        return;
      }
      if (!property.writable)
        this.throwError('TypeError', `Cannot assign to read only property '${key}' of ${this.describe(target)}`);
      if (current === target) {
        property.value = value;
        return;
      }
      break;
    }
    if (!target.extensible) this.throwError('TypeError', `Cannot add property ${key}, object is not extensible`);
    this.allocate(1);
    target.properties.set(key, { value, writable: true, enumerable: true, configurable: true });
  }

  setElement(array: JsArray, index: number, value: Value): void {
    const { elements } = array;
    if (index >= elements.length) this.grow(array, index + 1);
    elements[index] = value;
  }

  setLength(array: JsArray, value: Value): void {
    const length = this.toNumber(value);
    if (!Number.isInteger(length) || length < 0 || length >= 2 ** 32)
      this.throwError('RangeError', 'Invalid array length');
    if (length < array.elements.length) array.elements.length = length;
    else this.grow(array, length);
  }

  private grow(array: JsArray, length: number): void {
    const { elements } = array;
    this.allocate(length - elements.length);
    // Holes read as undefined, so the array stays dense.
    while (elements.length < length) elements.push(undefined);
  }

  defineProperty(object: JsObject, key: string, property: Property): void {
    if (object instanceof JsArray && (arrayIndexOf(key) !== undefined || key === 'length')) {
      if (isAccessor(property)) this.throwError('TypeError', 'Accessors on array elements are not supported');
      this.set(object, key, property.value);
      return;
    }
    if (!object.properties.has(key)) this.allocate(1);
    object.properties.set(key, property);
  }

  createDataProperty(object: JsObject, key: string, value: Value): void {
    this.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
  }

  deleteProperty(target: Value, key: string): boolean {
    if (!(target instanceof JsObject)) {
      if (target === undefined || target === null) {
        this.throwError('TypeError', `Cannot convert undefined or null to object`);
      }
      return true;
    }
    if (target instanceof JsArray) {
      const index = arrayIndexOf(key);
      if (index !== undefined) {
        if (index < target.elements.length) {
          if (index === target.elements.length - 1) target.elements.length = index;
          else target.elements[index] = undefined;
        }
        return true;
      }
      if (key === 'length') this.throwError('TypeError', `Cannot delete property 'length' of ${this.describe(target)}`);
    }
    const property = target.properties.get(key);
    if (property && !property.configurable) {
      this.throwError('TypeError', `Cannot delete property '${key}' of ${this.describe(target)}`);
    }
    target.properties.delete(key);
    return true;
  }

  hasProperty(object: JsObject, key: string): boolean {
    for (let current: JsObject | null = object; current; current = current.proto) {
      if (this.getOwnProperty(current, key)) return true;
    }
    return false;
  }

  /** Own string keys in property order: array indices and integer keys ascending, then the rest as added. */
  ownKeys(object: JsObject): string[] {
    const keys: string[] = [];
    if (object instanceof JsArray) {
      this.scan(object.elements.length);
      for (let index = 0; index < object.elements.length; index++) keys.push(String(index));
    }
    const integers: number[] = [];
    const others: string[] = [];
    for (const key of object.properties.keys()) {
      const index = arrayIndexOf(key);
      if (index === undefined) others.push(key);
      else integers.push(index);
    }
    this.scan(integers.length + others.length);
    integers.sort((a, b) => a - b);
    for (const index of integers) keys.push(String(index));
    return [...keys, ...others];
  }

  ownEnumerableKeys(object: JsObject): string[] {
    return this.ownKeys(object).filter((key) => this.getOwnProperty(object, key)?.enumerable);
  }

  // Private members -------------------------------------------------------------------------------------------------

  getPrivate(target: Value, name: string): Value {
    const property = this.privateProperty(target, name);
    if (!isAccessor(property)) return property.value;
    if (!property.get) this.throwError('TypeError', `'${name}' was defined without a getter`);
    return this.call(property.get, target, []);
  }

  setPrivate(target: Value, name: string, value: Value): void {
    const property = this.privateProperty(target, name);
    if (isAccessor(property)) {
      if (!property.set) this.throwError('TypeError', `'${name}' was defined without a setter`);
      this.call(property.set, target, [value]);
      return;
    }
    if (!property.writable) this.throwError('TypeError', `Private method '${name}' is not writable`);
    property.value = value;
  }

  definePrivate(target: JsObject, name: string, property: Property): void {
    target.privateMembers ??= new Map();
    if (target.privateMembers.has(name)) {
      this.throwError('TypeError', `Cannot initialize ${name} twice on the same object`);
    }
    this.allocate(1);
    target.privateMembers.set(name, property);
  }

  private privateProperty(target: Value, name: string): DataProperty | AccessorProperty {
    const property = target instanceof JsObject ? target.privateMembers?.get(name) : undefined;
    if (!property) {
      this.throwError('TypeError', `Cannot read private member ${name} from an object whose class did not declare it`);
    }
    return property;
  }

  // Calls -------------------------------------------------------------------------------------------------------------

  call(fn: Value, thisValue: Value, args: Value[], callRow?: number): Value {
    if (!isCallable(fn)) return this.throwError('TypeError', `${this.describe(fn)} is not a function`);
    this.spend();
    const { behavior } = fn;
    if (behavior.kind === 'native')
      return behavior.run({ runtime: this, thisValue, args, newTarget: undefined, callRow });
    if (behavior.kind === 'class') {
      return this.throwError('TypeError', `Class constructor ${this.functionName(fn)} cannot be invoked without 'new'`);
    }
    return this.evaluator.callFunction(behavior, thisValue, args, callRow);
  }

  construct(fn: Value, args: Value[], newTarget: Value = fn, callRow?: number): JsObject {
    if (!(fn instanceof JsFunction) || !fn.isConstructor) {
      return this.throwError('TypeError', `${this.describe(fn)} is not a constructor`);
    }
    this.spend();
    const target = newTarget as JsFunction;
    const { behavior } = fn;
    if (behavior.kind === 'native') {
      return behavior.run({ runtime: this, thisValue: undefined, args, newTarget: target, callRow }) as JsObject;
    }
    if (behavior.kind === 'class') return this.evaluator.constructClass(fn, behavior, args, target, callRow);
    const thisValue = this.newObject(this.prototypeFor(target, this.realm.objectPrototype));
    const result = this.evaluator.callFunction(behavior, thisValue, args, callRow);
    return isObject(result) ? result : thisValue;
  }

  /** The prototype of an object that `new` creates for `newTarget`. */
  prototypeFor(newTarget: JsFunction | undefined, fallback: JsObject): JsObject {
    if (!newTarget) return fallback;
    const prototype = this.get(newTarget, 'prototype');
    return isObject(prototype) ? prototype : fallback;
  }

  pushFrame(scope: Scope, callRow: number | undefined): Frame {
    if (this.frames.length >= LIMITS.maxCallDepth) this.throwError('RangeError', 'Maximum call stack size exceeded');
    const frame = new Frame(scope, callRow);
    this.frames.push(frame);
    return frame;
  }

  popFrame(): void {
    this.frames.pop();
  }

  /** Keeps `value` reachable for garbage collection while `run` computes with it. */
  hold<T>(value: Value, run: () => T): T {
    const { temporaries } = this.frame;
    temporaries.push(value);
    try {
      return run();
    } finally {
      temporaries.pop();
    }
  }

  // Conversions -------------------------------------------------------------------------------------------------------

  toPrimitive(value: Value, hint: 'number' | 'string' | 'default'): Primitive {
    if (!isObject(value)) return value;
    for (const name of hint === 'string' ? ['toString', 'valueOf'] : ['valueOf', 'toString']) {
      const method = this.get(value, name);
      if (isCallable(method)) {
        const result = this.call(method, value, []);
        if (!isObject(result)) return result;
      }
    }
    return this.throwError('TypeError', 'Cannot convert object to primitive value');
  }

  toNumber(value: Value): number {
    const primitive = this.toPrimitive(value, 'number');
    if (typeof primitive === 'string') this.scan(primitive.length);
    return Number(primitive);
  }

  toString(value: Value): string {
    return String(this.toPrimitive(value, 'string'));
  }

  toPropertyKey(value: Value): string {
    if (typeof value === 'string') return value;
    return this.toString(value);
  }

  toObject(value: Value): JsObject {
    if (isObject(value)) return value;
    if (value === undefined || value === null)
      this.throwError('TypeError', 'Cannot convert undefined or null to object');
    // A string's properties are its UTF-16 code units.
    if (typeof value === 'string') return this.newArray(value.split(''));
    return this.newObject();
  }

  typeOf(value: Value): string {
    if (value === null) return 'object';
    if (value instanceof JsFunction) return 'function';
    if (value instanceof JsObject) return 'object';
    return typeof value;
  }

  looseEquals(left: Value, right: Value): boolean {
    if (left === undefined || left === null || right === undefined || right === null) {
      return (left === undefined || left === null) && (right === undefined || right === null);
    }
    if (isObject(left) && isObject(right)) return left === right;
    if (isObject(left)) return this.looseEquals(this.toPrimitive(left, 'default'), right);
    if (isObject(right)) return this.looseEquals(left, this.toPrimitive(right, 'default'));
    // oxlint-disable-next-line eqeqeq -- The host's loose equality on primitives is JavaScript's.
    return left == right;
  }

  instanceOf(value: Value, constructor: Value): boolean {
    if (!isCallable(constructor)) this.throwError('TypeError', "Right-hand side of 'instanceof' is not callable");
    if (!isObject(value)) return false;
    const prototype = this.get(constructor, 'prototype');
    if (!isObject(prototype)) this.throwError('TypeError', 'Function has non-object prototype in instanceof check');
    for (let current = value.proto; current; current = current.proto) {
      this.spend();
      if (current === prototype) return true;
    }
    return false;
  }

  /** The values `for...of`, spread, and array destructuring read: those of arrays and the characters of strings. */
  iterate(value: Value): Value[] {
    if (value instanceof JsArray) return value.elements;
    if (typeof value === 'string') {
      this.scan(value.length);
      // oxlint-disable-next-line typescript/no-misused-spread -- JavaScript iterates strings by code point.
      return [...value];
    }
    return this.throwError('TypeError', `${this.describe(value)} is not iterable`);
  }

  /** A short description of a value for error messages. */
  describe(value: Value): string {
    if (typeof value === 'string') return JSON.stringify(value.length > 30 ? `${value.slice(0, 30)}...` : value);
    if (value instanceof JsFunction) return this.functionName(value) || 'function';
    if (value instanceof JsArray) return 'array';
    if (value instanceof JsObject) return 'object';
    return String(value);
  }

  functionName(fn: JsFunction): string {
    const name = fn.properties.get('name');
    return name && !isAccessor(name) && typeof name.value === 'string' ? name.value : '';
  }

  // Garbage collection ------------------------------------------------------------------------------------------------

  /** Removes the turtles that no variable, object, or pending value can reach any more. */
  collectGarbage(): void {
    if (!this.world.hasTurtles) return;
    const reached = new Set<TurtleState>();
    const visited = new Set<unknown>();
    const pending: unknown[] = [];
    for (const frame of this.frames) {
      pending.push(frame.scope);
      appendAll(pending, frame.temporaries);
    }
    let scanned = 0;
    while (pending.length > 0) {
      const item = pending.pop();
      if (!(item instanceof JsObject) && !isScope(item)) continue;
      if (visited.has(item)) continue;
      visited.add(item);
      scanned++;
      if (isScope(item)) {
        for (const binding of item.bindings.values()) if (binding.value !== UNINITIALIZED) pending.push(binding.value);
        pending.push(item.parent);
        const frame = item.functionFrame;
        if (frame) pending.push(frame.thisValue, frame.homeObject, frame.constructing, frame.newTarget);
        continue;
      }
      if (item.turtle) reached.add(item.turtle);
      pending.push(item.proto);
      for (const property of item.properties.values()) pushProperty(pending, property);
      if (item.privateMembers) for (const property of item.privateMembers.values()) pushProperty(pending, property);
      if (item instanceof JsArray) {
        scanned += item.elements.length;
        // Pushed one by one: spreading a large array into push() exceeds the engine's argument limit.
        for (const element of item.elements) pending.push(element);
      }
      if (item instanceof JsFunction && item.behavior.kind !== 'native') {
        pending.push(item.behavior.scope, item.behavior.homeObject);
      }
    }
    this.spend(Math.ceil(scanned / 64));
    this.world.retain((turtle) => reached.has(turtle));
  }
}

function isScope(item: unknown): item is Scope {
  return typeof item === 'object' && item !== null && 'bindings' in item && 'parent' in item;
}

function pushProperty(pending: unknown[], property: Property): void {
  if (isAccessor(property)) pending.push(property.get, property.set);
  else pending.push(property.value);
}

/** Defines a non-enumerable data property, as builtin methods and `name` are. */
export function defineHidden(object: JsObject, key: string, value: Value, writable = true): void {
  object.properties.set(key, { value, writable, enumerable: false, configurable: true });
}
