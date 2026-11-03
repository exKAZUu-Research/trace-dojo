import {
  TURTLE_GRAPHICS_BOARD_COLUMNS as COLUMNS,
  TURTLE_GRAPHICS_BOARD_ROWS as ROWS,
  TURTLE_GRAPHICS_EMPTY_COLOR as EMPTY_COLOR,
} from '../constants';
import type { Builtins } from './builtins';
import type { ClassInfo, LocalInfo, MethodInfo } from './types';
import { isSubclass, sameType } from './types';
import { defaultValue, JavaArray, JavaObject, JavaString, type TurtleState, type Value } from './values';

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
  if (message !== undefined) exception.message = new JavaString(message);
  throw new JavaThrow(exception);
}

/** A Java exception in flight. */
export class JavaThrow {
  constructor(readonly value: JavaObject) {}
}

/** Stops a program that exceeds a limit the learner cannot catch. */
export class ExecutionLimitError extends Error {
  constructor(readonly limit: 'operations' | 'output' | 'trace') {
    super(`Execution limit exceeded: ${limit}`);
    this.name = 'ExecutionLimitError';
  }
}

export interface RuntimeLimits {
  maxOperations: number;
  maxCallDepth: number;
  maxArrayElements: number;
  maxOutputLength: number;
}

export interface TurtleWorld {
  board: string[][];
  turtles: JavaObject[];
}

export class Runtime {
  readonly frames: Frame[] = [];
  readonly world: TurtleWorld = {
    board: Array.from({ length: ROWS }, () => Array.from({ length: COLUMNS }, () => EMPTY_COLOR)),
    turtles: [],
  };
  readonly staticValues = new Map<ClassInfo, Value[]>();
  output = '';
  /** Called after a statement on a `// step` row completes. */
  onStep?: (stepId: number) => void;
  private operations = 0;
  private allocatedArrayElements = 0;
  private readonly initializingClasses = new Set<ClassInfo>();
  private readonly dispatchCache = new Map<MethodInfo, Map<ClassInfo, MethodInfo>>();

  constructor(
    readonly builtins: Builtins,
    readonly limits: RuntimeLimits
  ) {}

  spend(cost = 1): void {
    this.operations += cost;
    if (this.operations > this.limits.maxOperations) throw new ExecutionLimitError('operations');
  }

  print(text: string): void {
    this.output += text;
    if (this.output.length > this.limits.maxOutputLength) throw new ExecutionLimitError('output');
  }

  allocateArray(frame: Frame, length: number): void {
    if (length < 0) throwBuiltin(frame, 'NegativeArraySizeException', String(length));
    this.allocatedArrayElements += length;
    this.spend(Math.ceil(length / 64));
    if (this.allocatedArrayElements > this.limits.maxArrayElements)
      throwBuiltin(frame, 'OutOfMemoryError', 'Java heap space');
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
    if (this.frames.length >= this.limits.maxCallDepth && caller) {
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
    if (this.world.turtles.length === 0) return;
    const reached = markReachable(this.gcRoots());
    for (const turtle of this.world.turtles) {
      if (!reached.has(turtle) && turtle.turtle) turtle.turtle.isAlive = false;
    }
    this.world.turtles = this.world.turtles.filter((turtle) => turtle.turtle?.isAlive);
  }

  private gcRoots(): Value[] {
    const roots: Value[] = [];
    for (const frame of this.frames) {
      for (const local of frame.locals) if (local !== UNASSIGNED) roots.push(local);
      roots.push(frame.thisObject, ...frame.temporaries);
    }
    for (const values of this.staticValues.values()) roots.push(...values);
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

  turtleStates(): TurtleState[] {
    return this.world.turtles.flatMap((turtle) => (turtle.turtle ? [turtle.turtle] : []));
  }
}

function markReachable(roots: Value[]): Set<JavaObject | JavaArray> {
  const reached = new Set<JavaObject | JavaArray>();
  const pending = [...roots];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!(value instanceof JavaObject || value instanceof JavaArray) || reached.has(value)) continue;
    reached.add(value);
    pending.push(...(value instanceof JavaObject ? value.fields : value.values));
  }
  return reached;
}
