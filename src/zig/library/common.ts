import type { Expression, Span } from '../ast';
import { ZigPanic } from '../runtime';
import { known, runtime, type SemaApi, type TExpr } from '../semaBase';
import {
  BOOL,
  type EnumType,
  errorUnionOf,
  optionalOf,
  sliceOf,
  type StructType,
  type Type,
  typeName,
  USIZE,
} from '../types';
import { NULL, Pointer, Slice, type Value, ZArray } from '../values';
import { ALLOCATOR, ALLOCATOR_ERROR, nativeEnum } from './heap';
import { compileArgs, expectArgs, fnMember, type Member } from './native';

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
  return new Slice(new ZArray(values, 0, values.length), 0, values.length);
}

/** Part of a slice, sharing its elements. */
export function subSlice(slice: Slice, start: number, length: number): Slice {
  return new Slice(slice.target, slice.start + start, length);
}

/** Compiles an argument as a slice of constant elements of a type. */
export function constSlice(sema: SemaApi, arg: Expression, child: Type): TExpr {
  return sema.coerce(sema.compile(arg, sliceOf(child, true)), sliceOf(child, true), arg);
}

export function mutableSlice(sema: SemaApi, arg: Expression, child: Type): TExpr {
  return sema.coerce(sema.compile(arg, sliceOf(child, false)), sliceOf(child, false), arg);
}

/** Whether two elements are equal, as `==` compares them. */
export function equalValues(a: Value, b: Value): boolean {
  if (a instanceof Pointer && b instanceof Pointer) return a.equals(b);
  return a === b;
}

/** Compares two scalars: -1, 0, or 1. */
// code-gauge-allow functionCognitiveComplexity 16 -- Handles each kind of value the operation accepts.
export function compareScalars(a: Value, b: Value): number {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return 0;
}

/** `std.math.Order`. */
export const ORDER: EnumType = nativeEnum('math.Order', ['lt', 'eq', 'gt']);

export function orderValue(comparison: number): bigint {
  return comparison < 0 ? 0n : comparison === 0 ? 1n : 2n;
}

export const OPTIONAL_USIZE = optionalOf(USIZE);

export function optionalIndex(index: number): Value {
  return index < 0 ? NULL : BigInt(index);
}

/** Computes a value from arguments, at compile time when they are all known. */
export function computed(type: Type, args: readonly TExpr[], span: Span, compute: (values: Value[]) => Value): TExpr {
  if (args.every((arg) => arg.known)) {
    try {
      return known(type, compute(args.map((arg) => arg.value)), span);
    } catch (error) {
      // A library function runs when the program does, so a panic for known arguments still happens at run time.
      if (!(error instanceof ZigPanic)) throw error;
    }
  }
  const evaluators = args.map((arg) => arg.eval);
  return runtime(
    type,
    (frame) => {
      frame.runtime.spend(1 + Math.floor(args.length));
      return compute(evaluators.map((evaluate) => evaluate(frame)));
    },
    span
  );
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
