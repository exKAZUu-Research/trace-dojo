import { CompileError } from '../../interpreter/diagnostics';
import { transferCost } from '../allocation';
import type { Expression, Span } from '../ast';
import { BigFloat, compareFloats } from '../floats';
import { spendIntegerOperation } from '../integerWork';
import { spendMemory } from '../memoryAccounting';
import { MemoryFault } from '../memoryFault';
import { type Frame, withHeldValues, ZigPanic } from '../runtime';
import {
  copyForStorage,
  evaluateHeld,
  known,
  runtime,
  type SemaApi,
  staticResultOf,
  type TExpr,
  valueEvaluators,
} from '../semaBase';
import {
  BOOL,
  type EnumType,
  errorUnionOf,
  isComptimeOnly,
  optionalOf,
  sliceOf,
  type StructType,
  type Type,
  typeName,
  USIZE,
} from '../types';
import { compileTimeReadable, isUndefinedMemory, NULL, Pointer, Slice, storeInto, type Value, ZArray } from '../values';
import { ALLOCATOR, ALLOCATOR_ERROR, nativeEnum } from './heap';
import { compileArgs, expectArgs, fnMember, type Member } from './native';

export function nativeBudget(sema: SemaApi, frame?: Frame): (cost?: number) => void {
  return frame ? (cost = 1) => frame.runtime.spend(cost) : (cost = 1) => sema.spendCompilation(cost);
}

export function readSliceBytes(slice: Slice, spend: (cost?: number) => void): Uint8Array {
  if (slice.lengthValue !== 0n && isUndefinedMemory(slice)) throw new MemoryFault();
  spend(slice.length);
  return Uint8Array.from({ length: slice.length }, (_, index) => Number(slice.get(index)));
}

export function nativeTransferCost(sema: SemaApi, type: Type, span: Span): number {
  sema.resolveStorage(type, span);
  return transferCost(type);
}

export type Eval = TExpr['eval'];

/** A library function whose first argument is a type, as `std.mem.eql(u8, a, b)`. */
export function generic(
  name: string,
  count: number,
  build: (
    sema: SemaApi,
    call: { span: Span; args: readonly Expression[] },
    type: Type,
    rest: readonly Expression[]
  ) => TExpr
): () => Member {
  return fnMember(name, (sema, call) => {
    const args = expectArgs(sema, call, count, name);
    const type = sema.compileType(args[0]);
    return build(sema, call, type, args.slice(1));
  });
}

/** The elements of a slice, a pointer to an array, or an array value. */
export function elements(value: Value): Value[] {
  if (value instanceof Slice) return value.values();
  if (value instanceof Pointer) return (value.load() as ZArray).values();
  if (value instanceof ZArray) return value.values();
  return [];
}

/** The tuple type `struct { A, B, ... }` of some types. */
export function tupleOf(sema: SemaApi, types: readonly Type[]): StructType {
  return sema.tupleType(types.map((type, index) => ({ name: String(index), type, hasDefault: false })));
}

/** A new slice holding values. */
export function newSlice(values: Value[]): Slice {
  return new Slice(new ZArray(values.map(copyForStorage), 0, values.length), 0, values.length);
}

export function storeSliceValue(slice: Slice, index: number, value: Value): void {
  storeInto(slice.target, slice.start + index, value);
}

export function storeSliceValues(slice: Slice, values: readonly Value[]): void {
  const copied = values.map(copyForStorage);
  for (const [index, value] of copied.entries()) storeSliceValue(slice, index, value);
}

/** Part of a slice, sharing its elements. */
export function subSlice(slice: Slice, start: number | bigint, length: number | bigint): Slice {
  return new Slice(slice.target, slice.start + Number(start), length);
}

/** Compiles an argument as a slice of constant elements of a type. */
export function constSlice(sema: SemaApi, arg: Expression, child: Type): TExpr {
  return sema.coerce(sema.compile(arg, sliceOf(child, true)), sliceOf(child, true), arg);
}

export function mutableSlice(sema: SemaApi, arg: Expression, child: Type): TExpr {
  return sema.coerce(sema.compile(arg, sliceOf(child, false)), sliceOf(child, false), arg);
}

export { scalarValuesEqual as equalValues } from '../values';

// code-gauge-allow functionCognitiveComplexity 18 -- Handles each kind of value the operation accepts.
export function compareScalars(a: Value, b: Value): number {
  if (a instanceof BigFloat && b instanceof BigFloat) return compareFloats(a, b) ?? Number.NaN;
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    spendIntegerOperation(a, b, 'read', spendMemory);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return 0;
}

/** `std.math.Order`. */
export const ORDER: EnumType = nativeEnum('math.Order', ['gt', 'lt', 'eq']);

export const ORDER_GT = 0n;
export const ORDER_LT = 1n;
export const ORDER_EQ = 2n;

export function orderValue(comparison: number): bigint {
  return comparison < 0 ? ORDER_LT : comparison === 0 ? ORDER_EQ : ORDER_GT;
}

export const OPTIONAL_USIZE = optionalOf(USIZE);

export function optionalIndex(index: number | bigint | undefined): Value {
  return index === undefined || index < 0 ? NULL : BigInt(index);
}

/** Calls a native function, evaluating at compilation only when its return type requires it. */
export function computed(
  type: Type,
  args: readonly TExpr[],
  span: Span,
  compute: (values: Value[], frame?: Frame) => Value
): TExpr {
  let result: { value: Value } | undefined;
  const facts = args.map(staticResultOf);
  if (isComptimeOnly(type) && facts.every((fact) => fact && compileTimeReadable(fact.value))) {
    try {
      result = { value: compute(facts.map((fact) => fact!.value)) };
      if (args.every((arg) => arg.known)) return known(type, result.value, span);
    } catch (error) {
      if (!(error instanceof ZigPanic)) throw error;
      throw new CompileError([{ row: span.row, message: `コンパイルのときの計算が失敗しました: ${error.text}` }]);
    }
  }
  const evaluators = valueEvaluators(args);
  return {
    ...runtime(
      type,
      (frame) => {
        frame.runtime.spend(1 + Math.floor(args.length));
        const values = evaluateHeld(frame, evaluators);
        return withHeldValues(
          frame,
          values,
          () => (result ? result.value : compute(values, frame)),
          args.map((arg) => arg.type)
        );
      },
      span
    ),
    staticResult: result,
  };
}

/** An allocating function's result type: `Allocator.Error!T`. */
export function allocating(type: Type): Type {
  return errorUnionOf(ALLOCATOR_ERROR, type);
}

export function allocatorArg(sema: SemaApi, arg: Expression): TExpr {
  const [allocator] = compileArgs(sema, [arg], [ALLOCATOR]);
  return allocator;
}

export function requireIntType(sema: SemaApi, type: Type, span: Span, what: string): void {
  if (type.kind !== 'int') sema.error(span, `${what}の型は整数の型にしてください（${typeName(type)} です）。`);
}

export { BOOL, USIZE };
