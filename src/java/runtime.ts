import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type TurtleState, TurtleWorld } from '../interpreter/turtleWorld';
import type { Builtins } from './builtins';
import type { ClassInfo, LocalInfo, MethodInfo } from './types';
import { isSubclass, sameType } from './types';
import { defaultValue, JavaArray, JavaObject, JavaString, type Value } from './values';

/** A local that is out of scope or not yet assigned. */
export const UNASSIGNED = Symbol('unassigned');
export type Slot = Value | typeof UNASSIGNED;

export class Frame {
  readonly locals: Slot[];
  /** Values a pending call or allocation holds outside any variable, which must keep their turtles alive. */
  readonly temporaries: Value[] = [];

  constructor(
    readonly runtime: Runtime,
    readonly method: MethodInfo | undefined,
    readonly localInfos: LocalInfo[],
    readonly thisObject: JavaObject | undefined,
    /** The row of the call that created this frame. */
    readonly callRow: number | undefined
  ) {
    this.locals = Array.from({ length: localInfos.length }, () => UNASSIGNED);
  }
}

/** Throws a builtin exception such as `ArithmeticException`. */
export function throwBuiltin(frame: Frame, className: string, message?: string): never {
  const cls = frame.runtime.builtins.classes.get(className);
  if (!cls) throw new Error(`Unknown builtin exception: ${className}`);
  const exception = new JavaObject(cls);
  if (message !== undefined) {
    // Messages may repeat learner strings; charging one for running out of memory would recurse.
    if (className !== 'OutOfMemoryError') frame.runtime.allocateString(frame, message.length);
    exception.message = new JavaString(message);
  }
  throw new JavaThrow(exception);
}

/** A Java exception in flight. */
export class JavaThrow {
  constructor(readonly value: JavaObject) {}
}

export class Runtime {
  readonly frames: Frame[] = [];
  readonly world = new TurtleWorld();
  readonly staticValues = new Map<ClassInfo, Value[]>();
  /** Called with a statement's row after it completes, in a program compiled for tracing; tells whether it recorded. */
  onStep?: (row: number) => boolean;
  /** How many steps `onStep` has recorded, which tells a statement whether the methods it called recorded any. */
  recordedSteps = 0;
  readonly budget = new ExecutionBudget();
  private allocatedSlots = 0;
  private readonly initializingClasses = new Set<ClassInfo>();
  private readonly dispatchCache = new Map<MethodInfo, Map<ClassInfo, MethodInfo>>();

  constructor(readonly builtins: Builtins) {}

  step(row: number): void {
    if (this.onStep?.(row)) this.recordedSteps++;
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  /** Charges for a string of `length` built at run time, before it is built. */
  allocateString(frame: Frame, length: number): void {
    if (length > LIMITS.maxStringLength) throwBuiltin(frame, 'OutOfMemoryError', 'Java heap space');
    // Charging every character built bounds what a run can build in all to 16 times its operations.
    this.spend(Math.ceil(length / 16));
  }

  allocateArray(frame: Frame, length: number): void {
    if (length < 0) throwBuiltin(frame, 'NegativeArraySizeException', String(length));
    this.allocateSlots(frame, length);
  }

  allocateObject(frame: Frame, cls: ClassInfo): JavaObject {
    this.allocateSlots(frame, cls.instanceFieldCount + 1);
    return new JavaObject(cls);
  }

  /** Charges for array elements or object fields before they are allocated. */
  private allocateSlots(frame: Frame, count: number): void {
    this.allocatedSlots += count;
    this.spend(Math.ceil(count / 64));
    if (this.allocatedSlots > LIMITS.maxSlots) throwBuiltin(frame, 'OutOfMemoryError', 'Java heap space');
  }

  /** Charges for reading `length` characters of strings, which one native call may do at once. */
  scanString(length: number): void {
    this.spend(Math.ceil(length / 64));
  }

  staticsOf(frame: Frame, cls: ClassInfo): Value[] {
    let values = this.staticValues.get(cls);
    if (!values) {
      this.initializeClass(frame, cls);
      values = this.staticValues.get(cls);
      if (!values) throw new Error(`Class ${cls.name} is not initialized`);
    }
    return values;
  }

  /** Initializes a class on its first active use, superclass first, as the JVM does. */
  initializeClass(frame: Frame, cls: ClassInfo): void {
    if (this.staticValues.has(cls) || this.initializingClasses.has(cls)) return;
    if (cls.superclass) this.initializeClass(frame, cls.superclass);
    this.initializingClasses.add(cls);
    const values: Value[] = Array.from({ length: cls.staticFieldCount });
    for (const field of cls.staticFields) values[field.slot] = field.constant ?? defaultValue(field.type);
    this.staticValues.set(cls, values);
    try {
      if (cls.initializeStatics) {
        const initializerFrame = this.pushFrame(frame, undefined, [], undefined, undefined);
        try {
          cls.initializeStatics(initializerFrame);
        } finally {
          this.popFrame();
        }
      }
    } finally {
      this.initializingClasses.delete(cls);
    }
  }

  pushFrame(
    caller: Frame | undefined,
    method: MethodInfo | undefined,
    locals: LocalInfo[],
    thisObject: JavaObject | undefined,
    callRow: number | undefined
  ): Frame {
    this.spend();
    if (this.frames.length >= LIMITS.maxCallDepth && caller) {
      throwBuiltin(caller, 'StackOverflowError');
    }
    const frame = new Frame(this, method, locals, thisObject, callRow);
    this.frames.push(frame);
    return frame;
  }

  popFrame(): void {
    this.frames.pop();
  }

  /** Removes the turtles that no frame, static field, or pending value can reach any more. */
  collectGarbage(): void {
    if (!this.world.hasTurtles) return;
    const { reached, scanned } = markReachable(this.gcRoots());
    this.spend(Math.ceil(scanned / 64));
    const reachedTurtles = new Set<TurtleState>();
    for (const value of reached) if (value instanceof JavaObject && value.turtle) reachedTurtles.add(value.turtle);
    this.world.retain((turtle) => reachedTurtles.has(turtle));
  }

  private gcRoots(): Value[] {
    const roots: Value[] = [];
    for (const frame of this.frames) {
      for (const local of frame.locals) if (local !== UNASSIGNED) roots.push(local);
      roots.push(frame.thisObject);
      for (const temporary of frame.temporaries) roots.push(temporary);
    }
    for (const values of this.staticValues.values()) for (const value of values) roots.push(value);
    return roots;
  }

  /** Calls `method` with `args`, which the caller keeps in its temporaries so that they stay reachable. */
  invoke(caller: Frame, method: MethodInfo, receiver: Value, args: Value[], callRow: number | undefined): Value {
    if (method.native) {
      this.spend();
      return method.native(caller, receiver, args);
    }
    const code = method.code;
    if (!code) throw new Error(`Method ${method.owner.name}.${method.name} has no code`);
    const frame = this.pushFrame(caller, method, code.locals, receiver as JavaObject | undefined, callRow);
    try {
      for (const [index, arg] of args.entries()) frame.locals[index] = arg;
      return code.run(frame);
    } finally {
      this.onExit?.(frame);
      this.popFrame();
    }
  }

  /** Called when a method returns or throws, while its frame still holds its locals. */
  onExit?: (frame: Frame) => void;

  /** Finds the method that `receiver`'s class runs for a virtual call of `method`. */
  dispatch(receiver: Value, method: MethodInfo): MethodInfo {
    const cls =
      receiver instanceof JavaObject
        ? receiver.cls
        : receiver instanceof JavaString
          ? this.builtins.stringClass
          : this.builtins.objectClass;
    if (cls === method.owner) return method;
    let overrides = this.dispatchCache.get(method);
    if (!overrides) {
      overrides = new Map();
      this.dispatchCache.set(method, overrides);
    }
    let resolved = overrides.get(cls);
    if (!resolved) {
      resolved = method;
      for (
        let current: ClassInfo | undefined = cls;
        current && current !== method.owner;
        current = current.superclass
      ) {
        const found = current.methods.find(
          (candidate) =>
            candidate.name === method.name &&
            !candidate.isStatic &&
            candidate.access !== 'private' &&
            candidate.parameterTypes.length === method.parameterTypes.length &&
            candidate.parameterTypes.every((type, index) => sameType(type, method.parameterTypes[index]))
        );
        if (found) {
          resolved = found;
          break;
        }
      }
      overrides.set(cls, resolved);
    }
    return resolved;
  }

  /** Calls `toString()` on an object as string concatenation does. */
  invokeToString(frame: Frame, object: JavaObject): JavaString | undefined {
    const method = this.builtins.objectClass.methods.find((candidate) => candidate.name === 'toString');
    if (!method) throw new Error('Object.toString is missing');
    frame.temporaries.push(object);
    try {
      return this.invoke(frame, this.dispatch(object, method), object, [], undefined) as JavaString | undefined;
    } finally {
      frame.temporaries.pop();
    }
  }

  isInstance(value: Value, cls: ClassInfo): boolean {
    if (value instanceof JavaObject) return isSubclass(value.cls, cls);
    if (value instanceof JavaString) return cls === this.builtins.stringClass || cls === this.builtins.objectClass;
    if (value instanceof JavaArray) return cls === this.builtins.objectClass;
    return false;
  }
}

function markReachable(roots: Value[]): { reached: Set<JavaObject | JavaArray>; scanned: number } {
  const reached = new Set<JavaObject | JavaArray>();
  const pending: Value[] = [...roots];
  let scanned = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (!(value instanceof JavaObject || value instanceof JavaArray) || reached.has(value)) continue;
    reached.add(value);
    const children = value instanceof JavaObject ? value.fields : value.values;
    scanned += children.length;
    // Pushed one by one: spreading a large array into push() exceeds the engine's argument limit.
    for (const child of children) pushReference(pending, child);
    if (value instanceof JavaObject) pushReference(pending, value.cause);
  }
  return { reached, scanned };
}

function pushReference(pending: Value[], value: Value): void {
  if (value instanceof JavaObject || value instanceof JavaArray) pending.push(value);
}
