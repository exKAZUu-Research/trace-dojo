import { implicitConversion } from '../conversions';
import { CppException, CppRuntimeError } from '../errors';
import type { Expr, FunctionCandidates, InitializerTarget } from '../expr';
import type { ExpressionCompiler } from '../expressionCompiler';
import { FloatNaN } from '../floatSign';
import {
  constructArray,
  initializeAt,
  installBaseValue,
  invoke,
  makeEach,
  newObject,
  withTemporaries,
  zeroOf,
} from '../objectCompiler';
import type { Eval, Frame } from '../runtime';
import {
  type ClassInfo,
  type ClassType,
  classType,
  type FunctionInfo,
  isArithmetic,
  isConstType,
  isCopyConstructor,
  type Type,
  withConst,
} from '../types';
import { ArrayStore, CObject, endLifetime, FunctionRef, holdValues, Ptr, Store, UNINIT, type Value } from '../values';
import { SequenceValue } from './containerValues';
import type { LibraryClass } from './libraryClass';
import { compareBytes, StringValue } from './string';

/** What a container does with its elements: make them, copy them, assign them, and destroy them. */
export interface ElementOperations {
  type: Type;
  arrayElement?: ElementOperations;
  /** A value-initialized element, as `std::vector<T>(n)` makes. */
  make: (frame: Frame, destination?: CObject) => Value;
  /** Whether the type has a default constructor, which `make` needs. */
  isDefaultConstructible: boolean;
  copy: (frame: Frame, value: Value, destination?: CObject, sourceIsConst?: boolean) => Value;
  /** Assigns `source` to the element `target`, giving the element's new value (the same object for a class). */
  assign: (frame: Frame, target: Value, source: Value) => Value;
  destroy?: (frame: Frame, value: Value) => void;
}

type ElementUse = 'copy' | 'assign' | 'relocate' | 'swap';

type MoveConstruction =
  | { kind: 'copy' | 'string' | 'sequence' | 'members' }
  | { kind: 'array'; array: NonNullable<LibraryClass['aggregateArray']> };

export function checkContainerElement(
  compiler: ExpressionCompiler,
  name: string,
  element: Type,
  row: number,
  allowsConst = false
): void {
  if (element.kind === 'reference') compiler.error(row, `${name} の要素を参照にはできません。`);
  if (element.kind === 'void') compiler.error(row, `${name} の要素を void にはできません。`);
  if (element.kind === 'function' || (element.kind === 'array' && element.length === undefined)) {
    compiler.error(row, `${name} の要素には大きさが決まるオブジェクト型を書いてください。`);
  }
  if (!allowsConst && isConstType(element)) compiler.error(row, `${name} の要素を const 型にはできません。`);
}

export function destroyElements(
  frame: Frame,
  values: readonly Value[],
  destroy: ElementOperations['destroy'],
  order: 'forward' | 'reverse' = 'forward'
): void {
  if (!destroy) return;
  holdValues(frame, values, () => {
    if (order === 'reverse') {
      for (let index = values.length - 1; index >= 0; index--) destroy(frame, values[index]);
    } else for (const value of values) destroy(frame, value);
  });
}

export function swapElements(frame: Frame, a: Ptr, b: Ptr, ops: ElementOperations): void {
  if (ops.arrayElement) {
    const left = a.read() as ArrayStore;
    const right = b.read() as ArrayStore;
    for (let index = 0; index < left.length; index++) {
      frame.runtime.spend();
      swapElements(frame, left.location(index), right.location(index), ops.arrayElement);
    }
    return;
  }
  const swap = swapFunction(ops.type);
  if (swap) {
    invoke(frame, swap, [b], a, swap.row);
    return;
  }
  withTemporaries(frame, () => {
    const value = constructElementFromRvalue(frame, ops.type, a.read());
    if (ops.destroy) frame.temporaries.push({ object: value, destroy: ops.destroy });
    moveAssignElement(frame, a, ops.type, b.read());
    moveAssignElement(frame, b, ops.type, value);
  });
}

function requireSwapUse(compiler: ExpressionCompiler, type: Type, row: number): void {
  if (type.kind === 'array') {
    if ((type.length ?? 1) > 0) requireSwapUse(compiler, type.of, row);
    return;
  }
  const swap = swapFunction(type);
  if (swap) {
    swap.nativeUses?.(row);
    return;
  }
  requireMoves(compiler, type, row);
}

export function requireMoves(compiler: ExpressionCompiler, type: Type, row: number): void {
  requireMoveConstruction(compiler, type, row);
  compiler.requireLibraryObjectUse(type, 'move-assign', row);
}

export function requireMoveConstruction(compiler: ExpressionCompiler, type: Type, row: number): void {
  compiler.requireLibraryObjectUse(type, 'move', row);
  compiler.requireLibraryObjectUse(type, 'destroy', row);
}

export function requireDefaultConstruction(compiler: ExpressionCompiler, type: Type, row: number): void {
  compiler.withLibraryAccess(() => compiler.valueInitialized(type, row));
  compiler.requireLibraryObjectUse(type, 'destroy', row);
}

export function movedArgument(compiler: ExpressionCompiler, type: Type, argument: Expr): Eval<Ptr> | undefined {
  if (type.kind !== 'class') return undefined;
  const target: Type = { kind: 'reference', to: withConst(type) };
  const bound = implicitConversion(compiler, argument, target)?.apply(argument);
  if (bound?.isXvalue && !isConstType(bound.type)) return bound.run as Eval<Ptr>;
}

export function requireElementUse(
  compiler: ExpressionCompiler,
  type: Type,
  row: number,
  use: ElementUse,
  sourceIsConst = true
): void {
  if (use === 'swap') {
    requireSwapUse(compiler, type, row);
    return;
  }
  if (use === 'copy' || use === 'relocate') {
    compiler.requireLibraryObjectUse(type, 'copy', row, sourceIsConst);
    compiler.requireLibraryObjectUse(type, 'destroy', row);
  }
  if (use === 'assign' || use === 'relocate') compiler.requireLibraryObjectUse(type, 'assign', row);
}

export function requireRelocation(compiler: ExpressionCompiler, type: Type, row: number): void {
  compiler.requireLibraryObjectUse(type, canTransferElementStorage(type) ? 'move' : 'copy', row);
  compiler.requireLibraryObjectUse(type, 'destroy', row);
}

function swapFunction(type: Type): FunctionInfo | undefined {
  return type.kind === 'class' && type.cls.library ? type.cls.methods.get('swap')?.[0] : undefined;
}

export function assignElement(frame: Frame, location: Ptr, operations: ElementOperations, value: Value): void {
  location.write(operations.assign(frame, location.readRaw(), value));
}

export function moveAssignElement(frame: Frame, location: Ptr, type: Type, value: Value): void {
  location.write(moveValue(frame, type, location.readRaw(), value));
}

export function moveConstructElement(
  frame: Frame,
  operations: ElementOperations,
  source: Value,
  destination?: CObject
): Value {
  return canTransferElementStorage(operations.type)
    ? constructElementFromRvalue(frame, operations.type, source, destination)
    : operations.copy(frame, source, destination);
}

export function canTransferElementStorage(type: Type): boolean {
  if (type.kind === 'array') return type.length === 0 || canTransferElementStorage(type.of);
  if (type.kind !== 'class') return true;
  const { cls } = type;
  if (!cls.isComplete || cls.isNoncopyable) return false;
  const move = moveConstruction(type);
  if (move.kind === 'copy') return canCopyWithoutThrow(type);
  if (move.kind === 'string' || move.kind === 'sequence') return true;
  if (move.kind === 'array') return canTransferElementStorage(move.array.type);
  return (
    (!cls.base || canTransferElementStorage(classType(cls.base))) &&
    cls.ownFields.every((field) => canTransferElementStorage(field.type))
  );
}

export function moveConstruction(type: ClassType): MoveConstruction {
  if (isConstType(type)) return { kind: 'copy' };
  const { cls } = type;
  if (cls.library?.kind === 'string') return { kind: 'string' };
  if (ownsMovableSequence(type)) return { kind: 'sequence' };
  if (cls.library?.aggregateArray) return { kind: 'array', array: cls.library.aggregateArray };
  return { kind: canMoveFields(cls) ? 'members' : 'copy' };
}

function canCopyWithoutThrow(type: Type): boolean {
  if (type.kind === 'array') return type.length === 0 || canCopyWithoutThrow(type.of);
  if (type.kind !== 'class') return true;
  const { cls } = type;
  if (!cls.isComplete || cls.isNoncopyable) return false;
  const fixedArray = cls.library?.aggregateArray;
  if (fixedArray) return canCopyWithoutThrow(fixedArray.type);
  if (cls.library && cls.library.kind !== 'pair') return cls.operations?.copyIsNoexcept === true;
  // Apple clang++ uses the selected constructor's exception specification for the enclosing implicit move,
  // even when the constructor's default argument could throw.
  if (cls.constructors.some((ctor) => !ctor.native && isCopyConstructor(ctor, cls)))
    return cls.operations?.copyIsNoexcept === true;
  return (
    cls.implicitCopyFromConst &&
    (!cls.base || canCopyWithoutThrow(classType(cls.base))) &&
    cls.ownFields.every((field) => canCopyWithoutThrow(field.type))
  );
}

export function constructElementFromRvalue(frame: Frame, type: Type, source: Value, target?: InitializerTarget): Value {
  if (source === UNINIT) return UNINIT;
  if (type.kind === 'array' && source instanceof ArrayStore) {
    return transferElements(frame, type.of, source.values, target instanceof ArrayStore ? target : undefined);
  }
  if (type.kind !== 'class') return source;
  const { cls } = type;
  const construction = moveConstruction(type);
  if (construction.kind === 'string') {
    const target = new StringValue('');
    target.moveFrom(source as StringValue);
    return target;
  }
  if (construction.kind === 'sequence') return (source as SequenceValue).moveStorage();
  if (construction.kind === 'array')
    return constructMovedArray(frame, construction.array, (source as SequenceValue).items);
  const destination = target instanceof CObject ? target : undefined;
  if (construction.kind === 'members') {
    const move = (): Value => transferSubobjects(frame, cls, source as CObject, destination);
    return canTransferElementStorage(type) ? frame.runtime.withoutOuterHandlers(move) : move();
  }
  return cls.operations?.copy(frame, source, destination) ?? source;
}

function constructMovedArray(frame: Frame, array: NonNullable<LibraryClass['aggregateArray']>, values: Value[]): Value {
  const move = (): Value => array.make(transferElements(frame, array.type.of, values));
  return canTransferElementStorage(array.type) ? frame.runtime.withoutOuterHandlers(move) : move();
}

function transferElements(frame: Frame, type: Type, values: Value[], destination?: ArrayStore): ArrayStore {
  return constructArray(
    frame,
    values.length,
    type,
    (current, target, index) => constructElementFromRvalue(current, type, values[index], target),
    (current, value) => destroyMovedPart(current, type, value),
    destination
  );
}

function transferSubobjects(frame: Frame, cls: ClassInfo, source: CObject, target: CObject | undefined): CObject {
  const destination = newObject(frame, cls, false, target);
  const { base } = cls;
  let baseComplete = false;
  return holdValues(frame, [destination], () => {
    try {
      if (base) {
        destination.cls = base;
        const initialized = constructElementFromRvalue(frame, classType(base), source, destination) as CObject;
        installBaseValue(base, destination, initialized);
        baseComplete = true;
      }
      destination.cls = cls;
      makeEach(
        frame,
        cls.ownFields.length,
        (index) => {
          const field = cls.ownFields[index];
          return initializeAt(
            frame,
            field.type,
            destination.location(field.index),
            destination.values[field.index],
            (target) => constructElementFromRvalue(frame, field.type, source.values[field.index], target)
          );
        },
        (index) => (current, value) => destroyMovedPart(current, cls.ownFields[index].type, value)
      );
      return destination;
    } catch (error) {
      if (error instanceof CppException && base && baseComplete) {
        destination.cls = base;
        base.operations?.destroy?.(frame, destination);
      }
      endLifetime(destination);
      throw error;
    }
  });
}

function destroyMovedPart(frame: Frame, type: Type, value: Value): void {
  if (type.kind === 'class') type.cls.operations?.destroy?.(frame, value);
  if (type.kind !== 'array' || !(value instanceof ArrayStore)) return;
  for (let index = value.values.length - 1; index >= 0; index--) {
    const item = value.values[index];
    if (item !== UNINIT) destroyMovedPart(frame, type.of, item);
  }
}

function ownsMovableSequence(type: Type): boolean {
  const kind = type.kind === 'class' ? type.cls.library?.kind : undefined;
  return kind !== undefined && ['vector', 'deque', 'list', 'stack', 'queue', 'priority_queue'].includes(kind);
}

/** The element operations of a type, which the compiler makes while the class it uses is complete. */
export function elementOperations(
  compiler: ExpressionCompiler,
  type: Type,
  row: number,
  use?: ElementUse
): ElementOperations {
  if (use) requireElementUse(compiler, type, row, use);
  if (type.kind === 'array') {
    const element = elementOperations(compiler, type.of, row);
    const length = type.length ?? 0;
    return {
      type,
      arrayElement: element,
      make: (frame) =>
        constructArray(
          frame,
          length,
          type.of,
          (current, target) => element.make(current, target instanceof CObject ? target : undefined),
          element.destroy
        ),
      get isDefaultConstructible() {
        return length === 0 || element.isDefaultConstructible;
      },
      copy: (frame, value, _destination, sourceIsConst) => {
        const source = value as ArrayStore;
        return constructArray(
          frame,
          length,
          type.of,
          (current, target, index) =>
            element.copy(current, source.values[index], target instanceof CObject ? target : undefined, sourceIsConst),
          element.destroy
        );
      },
      assign: (frame, target, source) => {
        const to = target as ArrayStore;
        const from = source as ArrayStore;
        for (let index = 0; index < length; index++) {
          frame.runtime.spend();
          to.values[index] = element.assign(frame, to.values[index], from.values[index]);
        }
        return to;
      },
      destroy: (frame, value) => {
        destroyElements(frame, (value as ArrayStore).values, element.destroy, 'reverse');
        endLifetime(value);
      },
    };
  }
  if (type.kind === 'class') {
    const { cls } = type;
    const operations = cls.operations;
    let checkedDefault = false;
    let construct: ElementOperations['make'] | undefined;
    const findDefault = (): typeof construct => {
      if (!checkedDefault) {
        checkedDefault = true;
        if (cls.isComplete && !cls.isAbstract) construct = defaultConstructor(compiler, cls, row);
      }
      return construct;
    };
    return {
      type,
      make: (frame, destination) => {
        const make = findDefault();
        if (!make) throw new CppRuntimeError('custom', `${cls.name} のオブジェクトは、引数なしでは作れません。`);
        return make(frame, destination);
      },
      get isDefaultConstructible() {
        return findDefault() !== undefined;
      },
      copy: (frame, value, destination, sourceIsConst) => {
        if (cls.isNoncopyable) throw new CppRuntimeError('custom', `${cls.name} のオブジェクトはコピーできません。`);
        return operations?.copy(frame, value, destination, sourceIsConst) ?? value;
      },
      assign: (frame, target, source) => operations?.assign(frame, target, source) ?? target,
      destroy: (frame, value) => {
        operations?.destroy?.(frame, value);
        endLifetime(value);
      },
    };
  }
  const zero = zeroOf(type);
  return {
    type,
    make: () => zero,
    isDefaultConstructible: true,
    copy: (_frame, value) => value,
    assign: (_frame, _target, source) => source,
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
    for (const [index, item] of (source as ArrayStore).values.entries()) {
      frame.runtime.spend();
      to.values[index] = moveValue(frame, type.of, to.values[index], item);
    }
    return to;
  }
  if (type.kind !== 'class') return source;
  const { cls } = type;
  if (target instanceof StringValue && source instanceof StringValue) {
    target.moveFrom(source);
  } else if (target instanceof SequenceValue && source instanceof SequenceValue && ownsMovableSequence(type)) {
    cls.operations?.destroy?.(frame, target);
    target.takeItems(source);
  } else if (target instanceof SequenceValue && source instanceof SequenceValue && cls.library?.aggregateArray) {
    const element = cls.library.aggregateArray.type.of;
    for (const [index, value] of source.items.entries()) {
      frame.runtime.spend();
      target.items[index] = moveValue(frame, element, target.items[index], value);
    }
  } else if (canMoveFields(cls)) {
    const to = target as CObject;
    const from = source as CObject;
    if (cls.base) moveValue(frame, classType(cls.base), to, from);
    for (const field of cls.ownFields)
      to.values[field.index] = moveField(frame, field.type, to.values[field.index], from.values[field.index]);
  } else return cls.operations?.assign(frame, target, source) ?? target;
  return target;
}

function moveField(frame: Frame, type: Type, target: Value, source: Value): Value {
  if (type.kind !== 'reference') return moveValue(frame, type, target, source);
  const location = target as Ptr;
  const value = (source as Ptr).read();
  if (type.to.kind === 'class') {
    const replacement = type.to.cls.operations?.assign(frame, location.readRaw(), value);
    if (replacement !== undefined) location.write(replacement);
  } else location.write(value);
  return target;
}

function canMoveFields(cls: ClassInfo): boolean {
  return (
    cls.library?.kind === 'pair' ||
    (!cls.library && !cls.hasUserDestructor && !cls.constructors.some((ctor) => isCopyConstructor(ctor, cls)))
  );
}

function defaultConstructor(
  compiler: ExpressionCompiler,
  cls: ClassInfo,
  row: number
): ElementOperations['make'] | undefined {
  try {
    const { run } = compiler.withLibraryAccess(() => compiler.defaultConstructed(cls, row, true));
    return (frame, destination) => run(frame, undefined, destination) as Value;
  } catch {
    return undefined;
  }
}

/** A comparison of two elements, as `<` or a comparator object or function gives it. */
export type Compare = (frame: Frame, a: Value, b: Value) => boolean;

export type ValueComparison<T> = (a: Value, b: Value, frame: Frame) => T;

/** Compares two values of a type with `<` as the library's default comparators do, or undefined when `<` does not apply. */
export function lessThan(type: Type): ValueComparison<number> | undefined {
  if (type.kind === 'reference') return compareReferences(lessThan(type.to));
  if (isArithmetic(type)) {
    return (a, b) => {
      const x = a as number | bigint;
      const y = b as number | bigint;
      return x === y && !(a instanceof FloatNaN) ? 0 : x < y ? -1 : x > y ? 1 : Number.NaN;
    };
  }
  if (type.kind === 'pointer') {
    return (a, b) => (a as Ptr).compareAddress(b as Ptr);
  }
  if (type.kind !== 'class') return undefined;
  const library = type.cls.library;
  if (library?.kind === 'string') {
    return (a, b, frame) => compareBytes(frame, (a as StringValue).bytes, (b as StringValue).bytes);
  }
  if (library?.kind === 'pair') {
    const [first, second] = type.cls.fields;
    const compareFirst = lessThan(first.type);
    const compareSecond = lessThan(second.type);
    if (!compareFirst || !compareSecond) return undefined;
    return (a, b, frame) => {
      const x = a as CObject;
      const y = b as CObject;
      const order = compareFirst(x.values[0], y.values[0], frame);
      return order === 0 ? compareSecond(x.values[1], y.values[1], frame) : order;
    };
  }
  if (library && ['vector', 'deque', 'array', 'list'].includes(library.kind)) {
    const element = lessThan(library.args[0]);
    if (!element) return undefined;
    return (a, b, frame) => {
      const x = (a as SequenceValue).items;
      const y = (b as SequenceValue).items;
      for (let index = 0; index < Math.min(x.length, y.length); index++) {
        frame.runtime.spend();
        const order = element(x[index], y[index], frame);
        if (order !== 0) return order;
      }
      return x.length - y.length;
    };
  }
  return undefined;
}

/** Whether two values of a type are equal, as `==` says, or undefined when `==` does not apply. */
export function equalTo(type: Type): ValueComparison<boolean> | undefined {
  if (type.kind === 'reference') return compareReferences(equalTo(type.to));
  if (type.kind === 'pointer') return (a, b) => (a as Ptr).equals(b as Ptr);
  if (type.kind === 'class' && type.cls.library?.kind === 'pair') {
    const [first, second] = type.cls.fields;
    const a1 = equalTo(first.type);
    const a2 = equalTo(second.type);
    if (!a1 || !a2) return undefined;
    return (a, b, frame) =>
      a1((a as CObject).values[0], (b as CObject).values[0], frame) &&
      a2((a as CObject).values[1], (b as CObject).values[1], frame);
  }
  const less = lessThan(type);
  if (!less) return undefined;
  return (a, b, frame) => less(a, b, frame) === 0;
}

function compareReferences<T>(compare: ValueComparison<T> | undefined): ValueComparison<T> | undefined {
  if (compare) return (a, b, frame) => compare((a as Ptr).read(), (b as Ptr).read(), frame);
}

export interface CallbackOperand {
  type: Type;
  category?: 'xvalue' | 'prvalue';
}

export function callbackOperands(
  operands: CallbackOperand[],
  row: number,
  read: (frame: Frame, index: number) => Value
): Expr[] {
  return operands.map(({ type, category }, index) => ({
    type,
    isLvalue: category !== 'prvalue',
    isXvalue: category === 'xvalue',
    row,
    run: (frame) => read(frame, index),
  }));
}

export function predicateCallback(
  compiler: ExpressionCompiler,
  argumentType: Type,
  functions: FunctionCandidates | undefined,
  operands: CallbackOperand[],
  row: number
): ((frame: Frame, ...locations: Ptr[]) => Value) | undefined {
  if (functions) {
    return functionCallback(compiler, functions, operands, row, true);
  }
  if (argumentType.kind === 'class' && argumentType.cls.library?.kind === 'functor' && operands.length === 2) {
    const callee: Expr = { type: argumentType, row, isLvalue: false, run: () => {} };
    return callbackRunner(compiler, operands, row, (args) => compiler.callWith(callee, args, row), true);
  }
  return undefined;
}

export function functionCallback(
  compiler: ExpressionCompiler,
  candidates: FunctionCandidates,
  operands: CallbackOperand[],
  row: number,
  predicate = false
): (frame: Frame, ...locations: Ptr[]) => Value {
  return callbackRunner(compiler, operands, row, (args) => compiler.callCallback(candidates, args, row), predicate);
}

function callbackRunner(
  compiler: ExpressionCompiler,
  operands: CallbackOperand[],
  row: number,
  compile: (args: Expr[]) => Expr,
  predicate: boolean
): (frame: Frame, ...locations: Ptr[]) => Value {
  const argumentsByCall: Ptr[][] = [];
  const args = callbackOperands(operands, row, (_frame, index) => argumentsByCall.at(-1)?.[index]);
  const call = compile(args);
  const condition = predicate ? compiler.condition(call, row) : undefined;
  return (frame, ...locations) =>
    withTemporaries(frame, () => {
      argumentsByCall.push(locations);
      try {
        return condition ? Number(condition(frame)) : (call.run(frame) as Value);
      } finally {
        argumentsByCall.pop();
      }
    });
}

/** Calls a predicate the program passed, which takes elements and gives a value that converts to `bool`. */
export function truthy(value: Value): boolean {
  return value !== 0 && value !== 0n && value !== undefined && !(value instanceof Ptr && value.isNull);
}

export { CObject, FunctionRef, SequenceValue, Store, StringValue };
