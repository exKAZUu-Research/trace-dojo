import { CppRuntimeError } from '../errors';
import type { ExpressionCompiler } from '../expressionCompiler';
import { destroyTemporaries, invoke, withTemporaries, zeroOf } from '../objectCompiler';
import type { Frame } from '../runtime';
import { type ClassInfo, type FunctionInfo, isArithmetic, type Type, typeName } from '../types';
import { type ArrayStore, Box, CObject, endLifetime, FunctionRef, Ptr, Store, UNINIT, type Value } from '../values';
import { SequenceValue } from './containerValues';
import { StringValue } from './string';

/** What a container does with its elements: make them, copy them, assign them, and destroy them. */
export interface ElementOperations {
  type: Type;
  /** A value-initialized element, as `std::vector<T>(n)` makes. */
  make: (frame: Frame) => Value;
  /** Whether the type has a default constructor, which `make` needs. */
  isDefaultConstructible: boolean;
  copy: (frame: Frame, value: Value) => Value;
  /** Assigns `source` to the element `target`, giving the element's new value (the same object for a class). */
  assign: (frame: Frame, target: Value, source: Value) => Value;
  destroy?: (frame: Frame, value: Value) => void;
  /** Whether copying or destroying an element runs code the program wrote, which reallocation then shows. */
  hasEffects: boolean;
}

type ElementUse = 'copy' | 'assign' | 'relocate' | 'swap';

export function swapElements(frame: Frame, a: Ptr, b: Ptr, ops: ElementOperations): void {
  if (a.equals(b)) return;
  const swap = swapFunction(ops.type);
  if (swap) {
    invoke(frame, swap, [b], a, swap.row);
    return;
  }
  withTemporaries(frame, () => {
    const value = ops.copy(frame, a.read());
    if (ops.destroy) frame.temporaries.push({ object: value, destroy: ops.destroy });
    assignElement(frame, a, ops, b.read());
    assignElement(frame, b, ops, value);
  });
}

function requireSwapUse(compiler: ExpressionCompiler, type: Type, row: number): void {
  const swap = swapFunction(type);
  if (swap) {
    swap.nativeUses?.(row);
    return;
  }
  compiler.requireLibraryObjectUse(type, 'copy', row);
  compiler.requireLibraryObjectUse(type, 'assign', row);
  compiler.requireLibraryObjectUse(type, 'destroy', row);
}

export function requireElementUse(compiler: ExpressionCompiler, type: Type, row: number, use: ElementUse): void {
  if (use === 'swap') {
    requireSwapUse(compiler, type, row);
    return;
  }
  if (use === 'copy' || use === 'relocate') {
    compiler.requireLibraryObjectUse(type, 'copy', row);
    compiler.requireLibraryObjectUse(type, 'destroy', row);
  }
  if (use === 'assign' || use === 'relocate') compiler.requireLibraryObjectUse(type, 'assign', row);
}

function swapFunction(type: Type): FunctionInfo | undefined {
  return type.kind === 'class' && type.cls.library ? type.cls.methods.get('swap')?.[0] : undefined;
}

export function assignElement(frame: Frame, location: Ptr, operations: ElementOperations, value: Value): void {
  location.write(operations.assign(frame, location.readRaw(), value));
}

export function moveConstructElement(frame: Frame, operations: ElementOperations, source: Value): Value {
  if (source instanceof StringValue) {
    const target = new StringValue('');
    target.moveFrom(source);
    return target;
  }
  if (source instanceof SequenceValue && ownsMovableSequence(operations.type)) return source.moveStorage();
  return operations.copy(frame, source);
}

export function canTransferElementStorage(type: Type): boolean {
  return (type.kind === 'class' && type.cls.library?.kind === 'string') || ownsMovableSequence(type);
}

function ownsMovableSequence(type: Type): boolean {
  const kind = type.kind === 'class' ? type.cls.library?.kind : undefined;
  return kind === 'vector' || kind === 'deque' || kind === 'list';
}

/** The element operations of a type, which the compiler makes while the class it uses is complete. */
export function elementOperations(
  compiler: ExpressionCompiler,
  type: Type,
  row: number,
  use?: ElementUse
): ElementOperations {
  if (use) requireElementUse(compiler, type, row, use);
  if (type.kind === 'class') {
    const { cls } = type;
    const operations = cls.operations;
    let checkedDefault = false;
    let construct: ((frame: Frame) => Value) | undefined;
    const findDefault = (): typeof construct => {
      if (!checkedDefault) {
        checkedDefault = true;
        if (cls.isComplete && !cls.isAbstract) construct = defaultConstructor(compiler, cls, row);
      }
      return construct;
    };
    return {
      type,
      make: (frame) => {
        const make = findDefault();
        if (!make) throw new CppRuntimeError('custom', `${cls.name} のオブジェクトは、引数なしでは作れません。`);
        return make(frame);
      },
      get isDefaultConstructible() {
        return findDefault() !== undefined;
      },
      copy: (frame, value) => {
        if (cls.isNoncopyable) throw new CppRuntimeError('custom', `${cls.name} のオブジェクトはコピーできません。`);
        return operations?.copy(frame, value) ?? value;
      },
      assign: (frame, target, source) => operations?.assign(frame, target, source) ?? target,
      destroy: (frame, value) => {
        operations?.destroy?.(frame, value);
        endLifetime(value);
      },
      hasEffects:
        !cls.library && (operations?.destroy !== undefined || cls.constructors.some((ctor) => isUserCopy(ctor, cls))),
    };
  }
  const zero = zeroOf(type);
  return {
    type,
    make: () => zero,
    isDefaultConstructible: true,
    copy: (_frame, value) => value,
    assign: (_frame, _target, source) => source,
    hasEffects: false,
  };
}

/**
 * Move-assigns `source` to `target` as `*out = std::move(*in)` does, giving the target's new value. A moved-from
 * `std::string`, vector, deque, or list is left empty, as libc++ leaves it, and a class without a copy constructor or
 * destructor the program declared moves its members; any other value is copied.
 */
export function moveValue(frame: Frame, type: Type, target: Value, source: Value): Value {
  if (target === source || target === UNINIT || source === UNINIT) return source;
  if (type.kind === 'array') {
    const to = target as ArrayStore;
    for (const [index, item] of (source as ArrayStore).values.entries())
      to.values[index] = moveValue(frame, type.of, to.values[index], item);
    return to;
  }
  if (type.kind !== 'class') return source;
  const { cls } = type;
  if (target instanceof StringValue && source instanceof StringValue) {
    target.moveFrom(source);
  } else if (target instanceof SequenceValue && source instanceof SequenceValue && ownsMovableSequence(type)) {
    cls.operations?.destroy?.(frame, target);
    target.takeItems(source);
  } else if (!cls.library && !declaresCopyOrDestructor(cls)) {
    const to = target as CObject;
    const from = source as CObject;
    for (const field of cls.fields)
      to.values[field.index] = moveValue(frame, field.type, to.values[field.index], from.values[field.index]);
  } else cls.operations?.assign(frame, target, source);
  return target;
}

/** Whether a class or a base declares a copy constructor or a destructor, which leaves it without an implicit move. */
function declaresCopyOrDestructor(cls: ClassInfo): boolean {
  for (let current: ClassInfo | undefined = cls; current; current = current.base) {
    if (current.destructor || current.constructors.some((ctor) => isUserCopy(ctor, current as ClassInfo))) return true;
  }
  return false;
}

function isUserCopy(ctor: FunctionInfo, cls: ClassInfo): boolean {
  const [first] = ctor.params;
  return (
    ctor.params.length === 1 &&
    first.type.kind === 'reference' &&
    first.type.to.kind === 'class' &&
    first.type.to.cls === cls
  );
}

function defaultConstructor(
  compiler: ExpressionCompiler,
  cls: ClassInfo,
  row: number
): ((frame: Frame) => Value) | undefined {
  try {
    return compiler.defaultConstructed(cls, row, true).run as (frame: Frame) => Value;
  } catch {
    return undefined;
  }
}

/** A comparison of two elements, as `<` or a comparator object or function gives it. */
export type Compare = (frame: Frame, a: Value, b: Value) => boolean;

/** Compares two values of a type with `<` as the library's default comparators do, or undefined when `<` does not apply. */
export function lessThan(type: Type): ((a: Value, b: Value) => number) | undefined {
  if (isArithmetic(type)) {
    return (a, b) => {
      const x = a as number | bigint;
      const y = b as number | bigint;
      return x === y ? 0 : x < y ? -1 : x > y ? 1 : Number.NaN;
    };
  }
  if (type.kind === 'pointer') {
    return (a, b) => {
      const p = (a as Ptr).address;
      const q = (b as Ptr).address;
      if (p.store !== q.store) return (p.store?.id ?? -1) - (q.store?.id ?? -1);
      return p.index - q.index;
    };
  }
  if (type.kind !== 'class') return undefined;
  const library = type.cls.library;
  if (library?.kind === 'string') {
    return (a, b) => {
      const x = (a as StringValue).bytes;
      const y = (b as StringValue).bytes;
      return x < y ? -1 : x > y ? 1 : 0;
    };
  }
  if (library?.kind === 'pair') {
    const [first, second] = type.cls.fields;
    const compareFirst = lessThan(first.type);
    const compareSecond = lessThan(second.type);
    if (!compareFirst || !compareSecond) return undefined;
    return (a, b) => {
      const x = a as CObject;
      const y = b as CObject;
      const order = compareFirst(x.values[0], y.values[0]);
      return order === 0 ? compareSecond(x.values[1], y.values[1]) : order;
    };
  }
  if (library && ['vector', 'deque', 'array', 'list'].includes(library.kind)) {
    const element = lessThan(library.args[0]);
    if (!element) return undefined;
    return (a, b) => {
      const x = (a as SequenceValue).items;
      const y = (b as SequenceValue).items;
      for (let index = 0; index < Math.min(x.length, y.length); index++) {
        const order = element(x[index], y[index]);
        if (order !== 0) return order;
      }
      return x.length - y.length;
    };
  }
  return undefined;
}

/** Whether two values of a type are equal, as `==` says, or undefined when `==` does not apply. */
export function equalTo(type: Type): ((a: Value, b: Value) => boolean) | undefined {
  if (type.kind === 'pointer') return (a, b) => (a as Ptr).equals(b as Ptr);
  if (type.kind === 'class' && type.cls.library?.kind === 'pair') {
    const [first, second] = type.cls.fields;
    const a1 = equalTo(first.type);
    const a2 = equalTo(second.type);
    if (!a1 || !a2) return undefined;
    return (a, b) =>
      a1((a as CObject).values[0], (b as CObject).values[0]) && a2((a as CObject).values[1], (b as CObject).values[1]);
  }
  const less = lessThan(type);
  if (!less) return undefined;
  return (a, b) => less(a, b) === 0;
}

/** The location of a value, for passing it by reference to a function the program wrote. */
export function locationOf(value: Value): Ptr {
  return new Ptr(new Box(value), 0);
}

/**
 * A comparator argument of an algorithm or a container: a function's name, or a function object such as
 * `std::greater<int>()`, compiled for two elements of a type, or for arguments of the types `elementType` lists.
 * Gives undefined when the argument is neither.
 */
export function comparatorOf(
  compiler: ExpressionCompiler,
  argumentType: Type,
  functions: FunctionInfo[] | undefined,
  elementType: Type | Type[],
  row: number,
  arity = 2
): ((frame: Frame, callee: Value, ...args: Value[]) => Value) | undefined {
  const types = Array.isArray(elementType) ? elementType : Array.from({ length: arity }, () => elementType);
  if (functions) {
    const call = functionCallback(compiler, functions, types, row);
    return (frame, _callee, ...values) => call(frame, ...values.map(locationOf));
  }
  if (argumentType.kind === 'class' && argumentType.cls.library?.kind === 'functor') {
    const operation = types.length === 2 ? argumentType.cls.library.apply?.(types[0], types[1]) : undefined;
    if (!operation) {
      return compiler.error(row, `${argumentType.cls.name} では ${typeName(types[0])} を比べられません。`);
    }
    return (_frame, _callee, a, b) => operation(a, b);
  }
  return undefined;
}

export function functionCallback(
  compiler: ExpressionCompiler,
  candidates: FunctionInfo[],
  types: Type[],
  row: number
): (frame: Frame, ...locations: Ptr[]) => Value {
  const argumentsByCall: Ptr[][] = [];
  const args = types.map((type, index) => ({
    type,
    isLvalue: true,
    row,
    run: () => argumentsByCall.at(-1)?.[index],
  }));
  const resolved = compiler.resolve('関数', candidates, args, undefined, row);
  const { fn } = resolved;
  if (fn.owner && !fn.isStatic) return compiler.error(row, `メンバ関数 ${fn.displayName} は、関数として渡せません。`);
  const call = compiler.callExpr(resolved, args, undefined, row);
  return (frame, ...locations) => {
    const mark = frame.temporaries.length;
    argumentsByCall.push(locations);
    try {
      return call.run(frame) as Value;
    } finally {
      argumentsByCall.pop();
      destroyTemporaries(frame, mark);
    }
  };
}

/** Calls a predicate the program passed, which takes elements and gives a value that converts to `bool`. */
export function truthy(value: Value): boolean {
  return value !== 0 && value !== 0n && value !== undefined && !(value instanceof Ptr && value.isNull);
}

export { CObject, FunctionRef, SequenceValue, Store, StringValue };
