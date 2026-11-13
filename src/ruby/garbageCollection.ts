import type { TurtleState } from '../interpreter/turtleWorld';
import { RArray, RBasic, RClass, RHash, RObject, RProc, RRange, type Value } from './objects';
import type { Frame, Runtime, Scope } from './runtime';

/** Removes the turtles that nothing the program can still reach refers to, as Java's garbage collection would. */
export function collectGarbage(runtime: Runtime): void {
  if (!runtime.world.hasTurtles) return;
  const reached = new Set<TurtleState>();
  const visited = new Set<object>();
  const pending: Value[] = [];
  const visitScope = (scope: Scope | undefined): void => {
    for (let current = scope; current; current = current.parent) pending.push(...current.vars.values());
  };
  const visitFrame = (frame: Frame): void => {
    pending.push(frame.self, ...frame.temporaries, ...frame.handling);
    visitScope(frame.scope);
    const { extra } = frame;
    if (extra.block) pending.push(extra.block);
    if (extra.args) pending.push(...extra.args);
    if (extra.keywords) pending.push(extra.keywords);
    if (extra.proc) pending.push(extra.proc);
  };
  for (const frame of runtime.frames) visitFrame(frame);
  pending.push(...runtime.globals.values(), ...runtime.held, runtime.c.Object);
  while (pending.length > 0) {
    const value = pending.pop() as Value;
    if (!(value instanceof RBasic) || visited.has(value)) continue;
    visited.add(value);
    if (value.ivars) pending.push(...value.ivars.values());
    if (value.singleton) pending.push(value.singleton);
    if (value instanceof RObject) {
      if (value.turtle) reached.add(value.turtle);
      if (value.exception) pending.push(value.exception.message, value.exception.cause);
      pushData(value.data, pending);
    } else if (value instanceof RArray) {
      pending.push(...value.items);
    } else if (value instanceof RHash) {
      for (const entry of value.map.values()) pending.push(entry.key, entry.value);
      pending.push(value.defaultValue);
      if (value.defaultProc) pending.push(value.defaultProc);
    } else if (value instanceof RRange) {
      pending.push(value.begin, value.end);
    } else if (value instanceof RProc) {
      pending.push(value.self);
      const outer = value.outer as unknown as Frame | undefined;
      if (outer) visitFrame(outer);
      pushData((value as unknown as { data?: unknown }).data, pending);
    } else if (value instanceof RClass) {
      pending.push(...value.constants.values(), ...value.classVariables.values());
      if (value.superclass) pending.push(value.superclass);
      pending.push(...value.includes, ...value.prepends);
    }
  }
  runtime.world.retain((turtle) => reached.has(turtle));
}

/** Visits the values that a library object's native state holds, such as an enumerator's receiver. */
function pushData(data: unknown, pending: Value[]): void {
  if (!data || typeof data !== 'object') return;
  const held = (data as { held?: () => Value[] }).held;
  if (typeof held === 'function') pending.push(...held.call(data));
}
