import type { Span } from '../ast';
import type { Interpreter } from '../interpreter';
import { type Frame, type Runtime, RustPanic, UnsupportedAtRun } from '../runtime';
import type { IntName, Type } from '../types';
import { EnumValue, isPlace, type Place, type Value } from '../values';

export interface NativeContext {
  interp: Interpreter;
  runtime: Runtime;
  frame: Frame;
  /** Where the program called the native, which its panics report, as `#[track_caller]` does. */
  span: Span;
  /** The concrete types of the native's type parameters: its impl's, then its own. */
  typeArgs: Type[];
}

export type Native = (args: Value[], ctx: NativeContext) => Value;

export const NATIVES: Record<string, Native> = {};

export function define(natives: Record<string, Native>): void {
  Object.assign(NATIVES, natives);
}

export function panic(ctx: NativeContext, message: string): never {
  throw new RustPanic(message, ctx.span);
}

/** A panic inside a function of the standard library without `#[track_caller]`, which Rust reports where it is. */
export function libraryPanic(ctx: Pick<NativeContext, 'span'>, message: string, location: string): never {
  throw new RustPanic(message, ctx.span, location);
}

/** Where `core/src/num/mod.rs` expands the methods of an integer type, which their panics report. */
export function intImplLocation(name: IntName): string {
  return `core/src/num/mod.rs:${INT_IMPL_ROWS[name]}:5`;
}

const INT_IMPL_ROWS: Record<IntName, number> = {
  i8: 379,
  i16: 404,
  i32: 429,
  i64: 454,
  i128: 479,
  isize: 559,
  u8: 586,
  u16: 1234,
  u32: 1290,
  u64: 1322,
  u128: 1354,
  usize: 1452,
};

export function deref(value: Value): Value {
  let current = value;
  while (isPlace(current)) current = current.get();
  return current;
}

export function placeOf(value: Value): Place {
  if (!isPlace(value)) throw new Error('Expected a place');
  return value;
}

export function some(ctx: NativeContext, value: Value): Value {
  return new EnumValue(ctx.interp.program.adtDef('Option'), 1, [value]);
}

export function none(ctx: NativeContext): Value {
  return new EnumValue(ctx.interp.program.adtDef('Option'), 0, []);
}

export function option(ctx: NativeContext, value: Value | undefined, present: boolean): Value {
  return present ? some(ctx, value) : none(ctx);
}

export function ok(ctx: NativeContext, value: Value): Value {
  return new EnumValue(ctx.interp.program.adtDef('Result'), 0, [value]);
}

export function err(ctx: NativeContext, value: Value): Value {
  return new EnumValue(ctx.interp.program.adtDef('Result'), 1, [value]);
}

export function ordering(ctx: NativeContext, order: number): Value {
  return new EnumValue(ctx.interp.program.adtDef('Ordering'), Math.sign(order) + 1, []);
}

/** The results of running the program's code for each item, the earlier ones kept alive while it runs for the later. */
export function callForEach<T>(
  ctx: NativeContext,
  items: readonly T[],
  run: (item: T, index: number) => Value
): Value[] {
  const results: Value[] = [];
  return ctx.runtime.withRoots([results], () => {
    for (const [index, item] of items.entries()) results.push(run(item, index));
    return results;
  });
}

export function call(ctx: NativeContext, fn: Value, args: Value[]): Value {
  return ctx.interp.callValue(fn, args, undefined);
}

export function isSome(value: Value): boolean {
  return (deref(value) as EnumValue).variant === 1;
}

export function int(value: Value): number {
  return Number(deref(value) as bigint);
}

/** Ends the program on what this interpreter does not support, found while running (`what` names it). */
export function unsupportedAtRun(ctx: NativeContext, what: string): never {
  throw new UnsupportedAtRun(`${what}は、この採点環境では使えません。`, ctx.span);
}
