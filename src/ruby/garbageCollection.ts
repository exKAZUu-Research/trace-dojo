import type { TurtleState } from '../interpreter/turtleWorld';
import { RArray, RBasic, RClass, RHash, RObject, RProc, RRange, type Value } from './objects';
import type { Frame, Runtime, Scope } from './runtime';

/** Removes the turtles that nothing the program can still reach refers to, as Java's garbage collection would. */
export function collectGarbage(runtime: Runtime): void {
  if (!runtime.world.hasTurtles) return;
  const reached = new Set<TurtleState>();
  const visited = new Set<object>();
  const pending: Value[] = [];
  for (const frame of runtime.frames) pushFrame(frame, pending);
  for (const value of runtime.globals.values()) pending.push(value);
  for (const value of runtime.held) pending.push(value);
  for (const values of runtime.heldArrays) for (const value of values) pending.push(value);
  pending.push(runtime.c.Object);
  while (pending.length > 0) {
    const value = pending.pop() as Value;
    if (!(value instanceof RBasic) || visited.has(value)) continue;
    visited.add(value);
    if (value instanceof RObject && value.turtle) reached.add(value.turtle);
    pushReferences(value, pending);
  }
  runtime.world.retain((turtle) => reached.has(turtle));
}

function pushFrame(frame: Frame, pending: Value[]): void {
  pending.push(frame.self);
  for (const value of frame.temporaries) pending.push(value);
  for (const value of frame.handling) pending.push(value);
  for (let scope: Scope | undefined = frame.scope; scope; scope = scope.parent)
    for (const value of scope.vars.values()) pending.push(value);
  const { extra } = frame;
  if (extra.block) pending.push(extra.block);
  if (extra.args) for (const arg of extra.args) pending.push(arg);
  if (extra.keywords) pending.push(extra.keywords);
  if (extra.proc) pending.push(extra.proc);
}

/** Pushes the values an object refers to. */
// code-gauge-allow functionCognitiveComplexity 18 -- The walker visits each runtime value kind and its reachable fields.
// code-gauge-allow functionNcss 31 -- The walker visits each runtime value kind and its reachable fields.
function pushReferences(value: RBasic, pending: Value[]): void {
  if (value.ivars) for (const item of value.ivars.values()) pending.push(item);
  if (value.singleton) pending.push(value.singleton);
  if (value instanceof RObject) {
    if (value.exception) pending.push(value.exception.message, value.exception.cause);
    pushData(value.data, pending);
  } else if (value instanceof RArray) {
    for (const item of value.items) pending.push(item);
  } else if (value instanceof RHash) {
    for (const entry of value.map.values()) pending.push(entry.key, entry.value);
    pending.push(value.defaultValue, ...(value.defaultProc ? [value.defaultProc] : []));
  } else if (value instanceof RRange) {
    pending.push(value.begin, value.end);
  } else if (value instanceof RProc) {
    pushProcReferences(value, pending);
  } else if (value instanceof RClass) {
    for (const item of value.constants.values()) pending.push(item);
    for (const item of value.classVariables.values()) pending.push(item);
    for (const item of value.includes) pending.push(item);
    for (const item of value.prepends) pending.push(item);
    if (value.superclass) pending.push(value.superclass);
  }
}

function pushProcReferences(value: RProc, pending: Value[]): void {
  pending.push(value.self);
  if (value.captured) for (const item of value.captured) pending.push(item);
  const outer = value.outer as unknown as Frame | undefined;
  if (outer) pushFrame(outer, pending);
}

/** Visits the values that a library object's native state holds, such as an enumerator's receiver. */
function pushData(data: unknown, pending: Value[]): void {
  if (!data || typeof data !== 'object') return;
  const held = (data as { held?: () => Value[] }).held;
  if (typeof held === 'function') for (const item of held.call(data)) pending.push(item);
}
