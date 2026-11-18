import type { Span } from '../ast';
import type { Interpreter } from '../interpreter';
import { type Frame, type Runtime, RustPanic } from '../runtime';
import type { Type } from '../types';
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

export function call(ctx: NativeContext, fn: Value, args: Value[]): Value {
  return ctx.interp.callValue(fn, args, undefined);
}

export function isSome(value: Value): boolean {
  return (deref(value) as EnumValue).variant === 1;
}

export function int(value: Value): number {
  return Number(deref(value) as bigint);
}
