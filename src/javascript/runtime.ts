// code-gauge-allow-file fileNcss 401 -- One runtime of the JavaScript interpreter, whose state its builtins and evaluator share.
import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import { TurtleWorld } from '../interpreter/turtleWorld';
import { Evaluator } from './evaluator';
import { findReachableTurtles } from './garbageCollection';
import { DONE, type HostIterator, ValueIterator } from './iteration';
import { defineFunctionProperties } from './memberProperties';
import { EventLoop } from './promises';
import { createRealm, type ErrorName, type Realm } from './realm';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import {
  type AccessorProperty,
  appendAll,
  arrayIndexOf,
  type DataProperty,
  type Element,
  HOLE,
  isAccessor,
  isCallable,
  isObject,
  JsArray,
  JsFunction,
  JsObject,
  JsThrow,
  type Key,
  type NativeFunction,
  privateBrandOf,
  privateClassOf,
  privateNameOf,
  type Property,
  type Scope,
  toBoolean,
  type Value,
} from './values';

export class Frame {
  /** Values a pending call or allocation holds outside any variable, which must keep their turtles alive. */
  readonly temporaries: Value[] = [];

  constructor(
    public scope: Scope,
    /** The row of the call that created this frame, or undefined for the program and implicit calls. */
    readonly callRow: number | undefined,
    /** Whether this frame runs a function marked `// atomic`. */
    readonly isAtomic: boolean
  ) {}
}

type Primitive = undefined | null | boolean | number | bigint | string | symbol;

export class Runtime {
  readonly world = new TurtleWorld();
  readonly budget = new ExecutionBudget();
  readonly io: ProgramIO;
  readonly frames: Frame[] = [];
  readonly eventLoop = new EventLoop(this);
  readonly realm: Realm;
  /**
   * The row of the expression being evaluated, from which getters, setters, and conversions that run the program's
   * own functions count as called.
   */
  currentRow: number | undefined;
  readonly steps = new StepTracker();
  readonly evaluator: Evaluator;
  private allocatedSlots = 0;

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
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

  /**
   * Charges for appending `added` characters to a string being built, which then has `length` characters. Charging
   * only what each part adds keeps building one long string linear.
   */
  extendString(length: number, added: number): void {
    if (length > LIMITS.maxStringLength) this.throwError('RangeError', 'Invalid string length');
    if (added > 0) this.spend(Math.ceil(added / 16));
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

  newArray(elements: Element[]): JsArray {
    this.allocate(elements.length + 1);
    return new JsArray(this.realm.arrayPrototype, elements);
  }

  newNativeFunction(name: string, length: number, run: NativeFunction, isConstructor = false): JsFunction {
    const fn = new JsFunction(this.realm.functionPrototype, { kind: 'native', run, isConstructor });
    defineFunctionProperties(fn, name, length);
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

  getOwnProperty(object: JsObject, key: Key): Property | undefined {
    if (object instanceof JsArray) {
      if (key === 'length')
        return {
          value: object.elements.length,
          writable: !object.frozen,
          enumerable: false,
          configurable: false,
        };
      const index = arrayIndexOf(key);
      if (index !== undefined) {
        const element = index < object.elements.length ? object.elements[index] : HOLE;
        return element === HOLE
          ? undefined
          : { value: element, writable: !object.frozen, enumerable: true, configurable: !object.sealed };
      }
    }
    return object.properties.get(key);
  }

  get(value: Value, key: Key, receiver: Value = value): Value {
    const element = ownElement(value, key);
    if (element !== MISSING) return element;
    for (let current: JsObject | null = this.objectFor(value, key); current; current = current.proto) {
      const property = this.getOwnProperty(current, key);
      if (!property) continue;
      if (!isAccessor(property)) return property.value;
      return property.get ? this.call(property.get, receiver, [], this.currentRow) : undefined;
    }
    return undefined;
  }

  /** The object whose properties `value` has: itself, or the prototype of its primitive type. */
  private objectFor(value: Value, key: Key): JsObject {
    if (value instanceof JsObject) return value;
    if (typeof value === 'string') return this.realm.stringPrototype;
    if (typeof value === 'number') return this.realm.numberPrototype;
    if (typeof value === 'boolean') return this.realm.booleanPrototype;
    if (typeof value === 'symbol') return this.realm.symbolPrototype;
    if (typeof value === 'bigint') return this.realm.bigintPrototype;
    return this.throwError('TypeError', `Cannot read properties of ${String(value)} (reading '${String(key)}')`);
  }

  /**
   * Assigns a property as `target[key] = value` does.
   *
   * @param lookupStart Where the property is looked up instead of `target`, as `super[key] = value` starts at the
   * parent's prototype while acting on `this`.
   */
  set(target: Value, key: Key, value: Value, lookupStart?: JsObject): void {
    if (!(target instanceof JsObject)) {
      if (target === undefined || target === null) {
        this.throwError('TypeError', `Cannot set properties of ${String(target)} (setting '${String(key)}')`);
      }
      return this.throwError(
        'TypeError',
        `Cannot create property '${String(key)}' on ${typeof target} '${String(target)}'`
      );
    }
    if (!lookupStart && target instanceof JsArray && this.setArrayProperty(target, key, value)) return;
    const property = this.findProperty(lookupStart ?? target, key);
    if (property && isAccessor(property)) {
      if (!property.set) {
        this.throwError(
          'TypeError',
          `Cannot set property ${String(key)} of ${this.describe(target)} which has only a getter`
        );
      }
      this.call(property.set, target, [value], this.currentRow);
      return;
    }
    if (property && !property.writable) {
      this.throwError('TypeError', `Cannot assign to read only property '${String(key)}' of ${this.describe(target)}`);
    }
    this.writeOwnData(target, key, value);
  }

  /** Stores a data property of the object assigned to, which an own accessor or a read-only property refuses. */
  private writeOwnData(target: JsObject, key: Key, value: Value): void {
    const own = target.properties.get(key);
    if (own && isAccessor(own)) this.throwError('TypeError', `Cannot redefine property: ${String(key)}`);
    if (own) {
      if (!own.writable)
        this.throwError(
          'TypeError',
          `Cannot assign to read only property '${String(key)}' of ${this.describe(target)}`
        );
      own.value = value;
      return;
    }
    if (!target.extensible)
      this.throwError('TypeError', `Cannot add property ${String(key)}, object is not extensible`);
    this.allocate(1);
    target.properties.set(key, { value, writable: true, enumerable: true, configurable: true });
  }

  /** Sets an element or the length of an array, returning false for any other property. */
  private setArrayProperty(array: JsArray, key: Key, value: Value): boolean {
    const index = arrayIndexOf(key);
    if (index !== undefined) this.setElement(array, index, value);
    else if (key === 'length') this.setLength(array, value);
    else return false;
    return true;
  }

  /** The property `key` of an object or of the nearest prototype that has it. */
  private findProperty(object: JsObject, key: Key): Property | undefined {
    for (let current: JsObject | null = object; current; current = current.proto) {
      const property = this.getOwnProperty(current, key);
      if (property) return property;
    }
    return undefined;
  }

  /** Assigns an element, which a frozen array refuses and a non-extensible one refuses where it has none. */
  setElement(array: JsArray, index: number, value: Value): void {
    const { elements } = array;
    if (index >= elements.length || elements[index] === HOLE) {
      if (!array.extensible) this.throwError('TypeError', `Cannot add property ${index}, object is not extensible`);
    } else if (array.frozen) {
      this.throwError('TypeError', `Cannot assign to read only property '${index}' of object '[object Array]'`);
    }
    if (index >= elements.length) this.grow(array, index + 1);
    elements[index] = value;
  }

  /** The spec's ArraySetLength, which stops shrinking at the last element a sealed array cannot delete. */
  setLength(array: JsArray, value: Value): void {
    const length = this.toNumber(value);
    if (!Number.isInteger(length) || length < 0 || length >= 2 ** 32)
      this.throwError('RangeError', 'Invalid array length');
    const { elements } = array;
    if (array.frozen) {
      this.throwError('TypeError', "Cannot assign to read only property 'length' of object '[object Array]'");
    }
    if (length >= elements.length) {
      this.grow(array, length);
      return;
    }
    if (array.sealed) {
      const last = elements.findLastIndex((element, index) => index >= length && element !== HOLE);
      if (last !== -1) {
        elements.length = last + 1;
        this.throwError('TypeError', `Cannot delete property '${last}' of [object Array]`);
      }
    }
    elements.length = length;
  }

  private grow(array: JsArray, length: number): void {
    const { elements } = array;
    this.allocate(length - elements.length);
    while (elements.length < length) elements.push(HOLE);
  }

  defineProperty(object: JsObject, key: Key, property: Property): void {
    if (object instanceof JsArray && (arrayIndexOf(key) !== undefined || key === 'length')) {
      if (isAccessor(property)) this.throwError('TypeError', 'Accessors on array elements are not supported');
      this.set(object, key, property.value);
      return;
    }
    if (!object.properties.has(key)) this.allocate(1);
    object.properties.set(key, property);
  }

  createDataProperty(object: JsObject, key: Key, value: Value): void {
    this.defineProperty(object, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  deleteProperty(target: Value, key: Key): boolean {
    if (target === undefined || target === null)
      this.throwError('TypeError', 'Cannot convert undefined or null to object');
    if (!(target instanceof JsObject)) return true;
    if (target instanceof JsArray) {
      const index = arrayIndexOf(key);
      // Deleting a hole changes nothing, which a sealed array allows.
      if (index !== undefined && index < target.elements.length && target.elements[index] !== HOLE) {
        if (target.sealed) this.throwError('TypeError', `Cannot delete property '${index}' of [object Array]`);
        target.elements[index] = HOLE;
      }
      if (index !== undefined) return true;
    }
    const property = this.getOwnProperty(target, key);
    if (property && !property.configurable) {
      this.throwError('TypeError', `Cannot delete property '${String(key)}' of ${this.describe(target)}`);
    }
    target.properties.delete(key);
    return true;
  }

  hasProperty(object: JsObject, key: Key): boolean {
    return this.findProperty(object, key) !== undefined;
  }

  /** Own symbol keys in the order they were added, which follow the string keys. */
  ownSymbols(object: JsObject): symbol[] {
    return [...object.properties.keys()].filter((key) => typeof key === 'symbol');
  }

  /** Own string keys in property order: array indices and integer keys ascending, then the rest as added. */
  ownKeys(object: JsObject): string[] {
    const keys: string[] = [];
    if (object instanceof JsArray) {
      this.scan(object.elements.length);
      for (const [index, element] of object.elements.entries()) if (element !== HOLE) keys.push(String(index));
    }
    const integers: number[] = [];
    const others: string[] = [];
    for (const key of object.properties.keys()) {
      if (typeof key === 'symbol') continue;
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

  /** Own enumerable string keys and then symbols, which spread, rest, and `Object.assign` copy. */
  ownEnumerablePropertyKeys(object: JsObject): Key[] {
    const symbols = this.ownSymbols(object).filter((key) => this.getOwnProperty(object, key)?.enumerable);
    return [...this.ownEnumerableKeys(object), ...symbols];
  }

  // Private members -------------------------------------------------------------------------------------------------

  getPrivate(target: Value, name: string): Value {
    const property = this.privateProperty(target, name, 'read');
    if (!isAccessor(property)) return property.value;
    if (!property.get) this.throwError('TypeError', `'${privateNameOf(name)}' was defined without a getter`);
    return this.call(property.get, target, [], this.currentRow);
  }

  setPrivate(target: Value, name: string, value: Value): void {
    const property = this.privateProperty(target, name, 'write');
    if (isAccessor(property)) {
      if (!property.set) this.throwError('TypeError', `'${privateNameOf(name)}' was defined without a setter`);
      this.call(property.set, target, [value], this.currentRow);
      return;
    }
    if (!property.writable) this.throwError('TypeError', `Private method '${privateNameOf(name)}' is not writable`);
    property.value = value;
  }

  definePrivate(target: JsObject, name: string, property: Property): void {
    target.privateMembers ??= new Map();
    if (target.privateMembers.has(name)) {
      this.throwError('TypeError', `Cannot initialize ${privateNameOf(name)} twice on the same object`);
    }
    this.allocate(1);
    target.privateMembers.set(name, property);
  }

  private privateProperty(target: Value, name: string, access: 'read' | 'write'): DataProperty | AccessorProperty {
    const property = target instanceof JsObject ? target.privateMembers?.get(name) : undefined;
    if (property) return property;
    const brand = privateBrandOf(name);
    if (brand === 'field') {
      const direction = access === 'read' ? 'read private member' : 'write private member';
      const preposition = access === 'read' ? 'from' : 'to';
      return this.throwError(
        'TypeError',
        `Cannot ${direction} ${privateNameOf(name)} ${preposition} an object whose class did not declare it`
      );
    }
    const className = privateClassOf(name);
    return this.throwError(
      'TypeError',
      brand === 'static' ? `Receiver must be class ${className}` : `Receiver must be an instance of class ${className}`
    );
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
    return this.evaluator.callFunction(fn, behavior, thisValue, args, callRow);
  }

  construct(fn: Value, args: Value[], newTarget: Value = fn, callRow?: number): JsObject {
    if (!(fn instanceof JsFunction) || !fn.isConstructor) {
      return this.throwError('TypeError', `${this.describe(fn)} is not a constructor`);
    }
    this.spend();
    const target = newTarget as JsFunction;
    const { behavior } = fn;
    if (behavior.kind === 'native') {
      return behavior.run({
        runtime: this,
        thisValue: undefined,
        args,
        newTarget: target,
        callRow,
      }) as JsObject;
    }
    if (behavior.kind === 'class') return this.evaluator.constructClass(fn, behavior, args, target, callRow);
    const thisValue = this.newObject(this.prototypeFor(target, this.realm.objectPrototype));
    const result = this.evaluator.callFunction(fn, behavior, thisValue, args, callRow, target);
    return isObject(result) ? result : thisValue;
  }

  /** The prototype of an object that `new` creates for `newTarget`. */
  prototypeFor(newTarget: JsFunction | undefined, fallback: JsObject): JsObject {
    if (!newTarget) return fallback;
    const prototype = this.get(newTarget, 'prototype');
    return isObject(prototype) ? prototype : fallback;
  }

  pushFrame(scope: Scope, callRow: number | undefined, isAtomic: boolean): Frame {
    if (this.frames.length >= LIMITS.maxCallDepth) this.throwError('RangeError', 'Maximum call stack size exceeded');
    const frame = new Frame(scope, callRow, isAtomic);
    this.frames.push(frame);
    return frame;
  }

  /** Pushes the frame of a suspended generator body again to resume it. */
  resumeFrame(frame: Frame): void {
    if (this.frames.length >= LIMITS.maxCallDepth) this.throwError('RangeError', 'Maximum call stack size exceeded');
    this.frames.push(frame);
  }

  popFrame(): void {
    const frame = this.frames.pop();
    if (frame?.isAtomic) this.steps.completeAtomicCall();
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
    const exotic = this.get(value, WELL_KNOWN_SYMBOLS.toPrimitive);
    if (exotic !== undefined && exotic !== null) {
      const result = this.call(exotic, value, [hint], this.currentRow);
      if (!isObject(result)) return result;
      return this.throwError('TypeError', 'Cannot convert object to primitive value');
    }
    for (const name of hint === 'string' ? ['toString', 'valueOf'] : ['valueOf', 'toString']) {
      const method = this.get(value, name);
      if (isCallable(method)) {
        const result = this.call(method, value, [], this.currentRow);
        if (!isObject(result)) return result;
      }
    }
    return this.throwError('TypeError', 'Cannot convert object to primitive value');
  }

  toNumber(value: Value): number {
    const primitive = this.toPrimitive(value, 'number');
    if (typeof primitive === 'string') this.scan(primitive.length);
    if (typeof primitive === 'symbol') this.throwError('TypeError', 'Cannot convert a Symbol value to a number');
    if (typeof primitive === 'bigint') this.throwError('TypeError', 'Cannot convert a BigInt value to a number');
    return Number(primitive);
  }

  /** Converts a value to a number or a BigInt, as arithmetic operators do before deciding which they compute with. */
  toNumeric(value: Value): number | bigint {
    const primitive = this.toPrimitive(value, 'number');
    return typeof primitive === 'bigint' ? primitive : this.toNumber(primitive);
  }

  toString(value: Value): string {
    const primitive = this.toPrimitive(value, 'string');
    if (typeof primitive === 'symbol') this.throwError('TypeError', 'Cannot convert a Symbol value to a string');
    return String(primitive);
  }

  toPropertyKey(value: Value): Key {
    if (typeof value === 'string' || typeof value === 'symbol') return value;
    const primitive = this.toPrimitive(value, 'string');
    return typeof primitive === 'symbol' ? primitive : String(primitive);
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

  /** The iterator that `for...of`, spread, and array destructuring use: over an array, or a string's code points. */
  /**
   * The iterator of a value, from its `Symbol.iterator` method, which a caller that has already read it passes. A
   * builtin iterator whose `next` is still the builtin one is stepped through directly, reading an array at each step as
   * its iterator does; its `return` is looked up only when a loop closes it.
   */
  iterator(
    value: Value,
    method = value === undefined || value === null ? undefined : this.get(value, WELL_KNOWN_SYMBOLS.iterator)
  ): ValueIterator {
    if (!isCallable(method)) return this.throwError('TypeError', `${this.describe(value)} is not iterable`);
    const iterator = this.call(method, value, [], this.currentRow);
    if (!isObject(iterator))
      return this.throwError('TypeError', 'Result of the Symbol.iterator method is not an object');
    const next = this.get(iterator, 'next');
    const { hostIterator } = iterator;
    if (!hostIterator || !(next instanceof JsFunction) || !this.realm.hostIteratorMethods.has(next)) {
      return new ValueIterator(this.protocolIteration(iterator, next));
    }
    return new ValueIterator({
      next: () => hostIterator.next(),
      close: () => {
        const close = this.get(iterator, 'return');
        if (close instanceof JsFunction && this.realm.hostIteratorMethods.has(close)) hostIterator.close?.();
        else if (close !== undefined && close !== null) this.callReturn(iterator, close);
      },
    });
  }

  /** Steps through an iterator object by calling its `next()`, and its `return()` when a loop leaves it early. */
  protocolIteration(iterator: JsObject, next: Value = this.get(iterator, 'next')): HostIterator {
    return {
      next: () => {
        const result = this.call(next, iterator, [], this.currentRow);
        if (!isObject(result))
          this.throwError('TypeError', `Iterator result ${this.describe(result)} is not an object`);
        return toBoolean(this.get(result, 'done')) ? DONE : this.get(result, 'value');
      },
      close: () => {
        const close = this.get(iterator, 'return');
        if (close !== undefined && close !== null) this.callReturn(iterator, close);
      },
    };
  }

  private callReturn(iterator: JsObject, close: Value): void {
    const result = this.call(close, iterator, [], this.currentRow);
    if (!isObject(result)) this.throwError('TypeError', `Iterator result ${this.describe(result)} is not an object`);
  }

  /** All the values an iterable yields, as spread reads them. */
  iterate(value: Value): Value[] {
    if (value instanceof JsArray) this.scan(value.elements.length);
    return this.iterator(value).rest();
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
    const roots: unknown[] = [];
    for (const frame of this.frames) {
      roots.push(frame.scope);
      appendAll(roots, frame.temporaries);
    }
    appendAll(roots, this.eventLoop.roots());
    const { reached, scanned } = findReachableTurtles(roots);
    this.spend(Math.ceil(scanned / 64));
    this.world.retain((turtle) => reached.has(turtle));
  }
}

const MISSING = Symbol('missing');

/** Reads an array element, an array's length, a string's character, or a string's length without a lookup. */
function ownElement(value: Value, key: Key): Value | typeof MISSING {
  if (typeof value === 'string') {
    if (key === 'length') return value.length;
    const index = arrayIndexOf(key);
    if (index !== undefined) return value[index];
  } else if (value instanceof JsArray) {
    if (key === 'length') return value.elements.length;
    const index = arrayIndexOf(key);
    if (index !== undefined && index < value.elements.length && value.elements[index] !== HOLE) {
      return value.elements[index] as Value;
    }
  }
  return MISSING;
}

/** Defines a non-enumerable data property, as builtin methods and `name` are. */
export function defineHidden(object: JsObject, key: Key, value: Value, writable = true): void {
  object.properties.set(key, { value, writable, enumerable: false, configurable: true });
}
