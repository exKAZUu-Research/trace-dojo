import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { formatFloat, strInspect, symInspect } from './conversions';
import { regexpDisplayOf } from './libRegexp';
import { structEntriesOf } from './libStruct';
import { timeDisplayOf } from './libTime';
import {
  type HashEntry,
  NIL,
  RArray,
  RBasic,
  RClass,
  RFloat,
  RHash,
  RObject,
  RProc,
  RRange,
  RString,
  RSymbol,
  type Value,
} from './objects';
import { parseRuby } from './parse';
import { runProgram } from './run';
import { type Frame, rt, Runtime, type Scope } from './runtime';

export function traceRubyProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const parsed = parseRuby(program, trace);
  const runtime = new Runtime(input);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.isAtomic,
    variablesOf: (frame) => variablesOf(runtime, frame, true),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with an uncaught exception to show how one stops the program.
  const run = runProgram(runtime, parsed, (frame) => {
    finalVars = variablesOf(runtime, frame, false).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

/**
 * The variables a frame shows: the local variables it sees (a block's include those of the method it was written in),
 * then, when `withContext`, the instance variables of `self` (as Java's `this.x`), the class variables of the
 * program's classes (as Java's static fields), and the global variables.
 */
// code-gauge-allow functionCognitiveComplexity 16 -- Trace collection follows Ruby scope and object kinds while matching the shared trace format.
function variablesOf(runtime: Runtime, frame: Frame, withContext: boolean): TraceVariables {
  const variables: TraceVariables = { vars: {}, referenceVars: {} };
  for (const [name, value] of visibleLocals(frame)) addVariable(variables, name, value);
  if (!withContext) return variables;
  const { self } = frame;
  if (self instanceof RBasic && !(self instanceof RClass) && self.ivars) {
    for (const [name, value] of self.ivars) if (!name.startsWith('@__')) addVariable(variables, name, value);
  }
  if (self instanceof RClass && self.isUserDefined && self.ivars) {
    for (const [name, value] of self.ivars) addVariable(variables, `${self.name}.${name}`, value);
  }
  addClassVariables(variables, runtime.c.Object, new Set());
  for (const [name, value] of runtime.globals) {
    if (!SYSTEM_GLOBALS.has(name)) addVariable(variables, name, value);
  }
  return variables;
}

const SYSTEM_GLOBALS = new Set(['$stdout', '$stderr', '$!', '$,', '$/']);

/** The local variables a frame sees, outermost scope first, each in the order the program first assigned it. */
function visibleLocals(frame: Frame): [string, Value][] {
  const scopes: Scope[] = [];
  for (let scope: Scope | undefined = frame.scope; scope; scope = scope.parent) scopes.unshift(scope);
  const values = new Map<string, Value>();
  for (const scope of scopes) {
    // Anonymous parameters (`*`, `**`, `&`, `...`) are kept under names that are not identifiers.
    for (const [name, value] of scope.vars) if (/^[^*&.]/.test(name)) values.set(name, value);
  }
  return [...values];
}

function addClassVariables(variables: TraceVariables, module: RClass, seen: Set<RClass>): void {
  for (const value of module.constants.values()) {
    if (!(value instanceof RClass) || !value.isUserDefined || seen.has(value)) continue;
    seen.add(value);
    for (const [name, field] of value.classVariables) addVariable(variables, `${value.name}.${name}`, field);
    addClassVariables(variables, value, seen);
  }
}

/** Procs and classes are definitions, not variables, to learners. */
function isVariableValue(value: Value): boolean {
  return !(value instanceof RProc || value instanceof RClass);
}

const MAX_SCALAR_EXPANSION = 10_000;
const MAX_DISPLAY_EXPANSION = 2000;

function addVariable(variables: TraceVariables, name: string, value: Value): void {
  if (!isVariableValue(value)) return;
  const scalar = scalarOf(value, new Set(), { remaining: MAX_SCALAR_EXPANSION });
  if (scalar !== NOT_SCALAR)
    Object.defineProperty(variables.vars, name, {
      value: scalar,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  // Arrays also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !(value instanceof RArray)) return;
  const node = displayNodeOf(value, new Set(), { remaining: MAX_DISPLAY_EXPANSION });
  if (node)
    Object.defineProperty(variables.referenceVars, name, {
      value: node,
      enumerable: true,
      configurable: true,
      writable: true,
    });
}

const NOT_SCALAR = Symbol('notScalar');
type Scalar = TraceItemVariable[string];

// code-gauge-allow duplicateLines 21 -- Trace collection follows Ruby scope and object kinds while matching the shared trace format.
function scalarOf(value: Value, seen: Set<object>, budget: { remaining: number }): Scalar | typeof NOT_SCALAR {
  if (budget.remaining-- <= 0) throw new ExecutionLimitError('trace');
  rt().spend();
  switch (typeof value) {
    case 'bigint': {
      return traceIntOf(value);
    }
    case 'number':
    case 'boolean': {
      return value;
    }
  }
  // oxlint-disable-next-line unicorn/no-null -- The trace format shows nil as null.
  if (value === NIL) return null;
  if (value instanceof RFloat) return value.value;
  if (value instanceof RString) return value.s;
  if (value instanceof RSymbol) return symInspect(value.name);
  if (!(value instanceof RArray) || seen.has(value)) return NOT_SCALAR;
  if (seen.size >= 256) throw new ExecutionLimitError('trace');
  seen.add(value);
  const items: Scalar[] = [];
  for (const item of value.items) {
    const scalar = scalarOf(item, seen, budget);
    if (scalar === NOT_SCALAR) return NOT_SCALAR;
    items.push(scalar);
  }
  seen.delete(value);
  return items as Scalar;
}

function traceIntOf(value: bigint): number | bigint {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}

// oxlint-disable-next-line unicorn/no-null -- The trace format shows nil as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

/** The node showing a value as learners see it, or `undefined` for a value the trace hides. */
function displayNodeOf(value: Value, seen: Set<object>, budget: { remaining: number }): DisplayNode | undefined {
  if (budget.remaining-- <= 0) return { kind: 'value', value: '…' };
  rt().spend();
  if (typeof value === 'bigint') return { kind: 'value', value: traceIntOf(value) };
  if (typeof value !== 'object') return { kind: 'value', value };
  if (value === NIL) return NULL_NODE;
  if (value instanceof RFloat) return { kind: 'value', value: value.value };
  if (value instanceof RString) return { kind: 'value', value: value.s };
  if (value instanceof RSymbol) return { kind: 'value', value: symInspect(value.name) };
  if (!isVariableValue(value) || seen.has(value)) return undefined;
  if (seen.size >= 256) return { kind: 'value', value: '…' };
  if (value instanceof RRange) return { kind: 'value', value: rangeText(value) };
  if (value instanceof RObject && value.turtle) {
    if (!value.turtle.isAlive) return undefined;
    return {
      kind: 'object',
      entries: { x: { kind: 'value', value: value.turtle.x }, y: { kind: 'value', value: value.turtle.y } },
    };
  }
  if (value instanceof RObject && value.data !== undefined) {
    if (value.cls === rt().c.Rational) {
      const { numerator, denominator } = value.data as { numerator: bigint; denominator: bigint };
      return { kind: 'value', value: `(${numerator}/${denominator})` };
    }
    const nativeText = timeDisplayOf(value) ?? regexpDisplayOf(value);
    if (nativeText !== undefined) return { kind: 'value', value: nativeText };
    const members = structEntriesOf(value);
    if (!members) return undefined;
    seen.add(value);
    try {
      const entries: Record<string, DisplayNode> = {};
      for (const [name, member] of members) {
        entries[name] = displayNodeOf(member, seen, budget) ?? NULL_NODE;
        if (budget.remaining <= 0) break;
      }
      return { kind: 'object', entries };
    } finally {
      seen.delete(value);
    }
  }
  seen.add(value);
  try {
    return containerNodeOf(value as RBasic, seen, budget);
  } finally {
    seen.delete(value);
  }
}

function rangeEnd(item: Value): string {
  return item === NIL ? '' : keyText(item, true);
}

function rangeText(value: RRange): string {
  const end = rangeEnd;
  return `${end(value.begin)}${value.exclusive ? '...' : '..'}${end(value.end)}`;
}

// code-gauge-allow functionCognitiveComplexity 16 -- Trace collection follows Ruby scope and object kinds while matching the shared trace format.
function containerNodeOf(value: RBasic, seen: Set<object>, budget: { remaining: number }): DisplayNode {
  const entries: Record<string, DisplayNode> = {};
  if (value instanceof RArray) {
    for (const [index, item] of value.items.entries()) {
      entries[index] = displayNodeOf(item, seen, budget) ?? NULL_NODE;
      if (budget.remaining <= 0) {
        if (index + 1 < value.items.length) markTruncated(entries, String(index + 1));
        break;
      }
    }
    return { kind: 'array', entries };
  }
  if (value instanceof RHash) {
    const ordered: HashEntry[] = [];
    for (const entry of value.map.values()) {
      if (ordered.length >= Math.max(1, budget.remaining)) break;
      ordered.push(entry);
    }
    const labels = keyLabels(ordered.map((entry) => entry.key));
    for (const [index, entry] of ordered.entries()) {
      Object.defineProperty(entries, labels[index], {
        value: displayNodeOf(entry.value, seen, budget) ?? NULL_NODE,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      if (budget.remaining <= 0) {
        if (index + 1 < value.map.size) {
          let marker = '…';
          while (Object.hasOwn(entries, marker)) marker += '…';
          markTruncated(entries, marker);
        }
        break;
      }
    }
  } else addInstanceEntries(entries, value, seen, budget);
  return { kind: 'object', entries };
}

function addInstanceEntries(
  entries: Record<string, DisplayNode>,
  value: RBasic,
  seen: Set<object>,
  budget: { remaining: number }
): void {
  for (const [key, item] of value.ivars ?? []) {
    if (key.startsWith('@__') || !isVariableValue(item)) continue;
    const node = displayNodeOf(item, seen, budget);
    if (node) entries[key] = node;
    if (budget.remaining <= 0) break;
  }
}

function markTruncated(entries: Record<string, DisplayNode>, key: string): void {
  Object.defineProperty(entries, key, {
    value: { kind: 'value', value: '…' },
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Labels a hash's keys, distinct for distinct keys: by their text when no two keys share one, and otherwise by their
 * literals, with equal literals numbered.
 */
function keyLabels(keys: Value[]): string[] {
  const texts = keys.map((key) => keyText(key, false));
  if (new Set(texts).size === texts.length) return texts;
  const literals = keys.map((key) => keyText(key, true));
  const counts = new Map<string, number>();
  for (const literal of literals) counts.set(literal, (counts.get(literal) ?? 0) + 1);
  const positions = new Map<string, number>();
  return literals.map((literal) => {
    if (counts.get(literal) === 1) return literal;
    const position = (positions.get(literal) ?? 0) + 1;
    positions.set(literal, position);
    return `${literal} (${position})`;
  });
}

/** A hash key as text, quoting strings and marking symbols when `quoted`, without running the program's methods. */
function keyText(key: Value, quoted: boolean, seen = new Set<RArray>(), memo = new WeakMap<RArray, string>()): string {
  rt().spend();
  if (key instanceof RString) return boundedKeyText(quoted ? strInspect(key.s) : key.s);
  if (key instanceof RSymbol) return quoted ? symInspect(key.name) : key.name;
  if (typeof key === 'boolean' || typeof key === 'bigint') return String(key);
  if (typeof key === 'number' || key instanceof RFloat) return formatFloat(Number(key));
  if (key === NIL) return 'nil';
  if (key instanceof RArray) {
    if (seen.has(key)) return '[...]';
    const cached = memo.get(key);
    if (cached) return cached;
    seen.add(key);
    try {
      let text = '[';
      for (const [index, item] of key.items.entries()) {
        const part = keyText(item, true, seen, memo);
        if (text.length + part.length + 2 > 4096) {
          text += `… (${key.items.length} items)`;
          break;
        }
        text += `${index > 0 ? ', ' : ''}${part}`;
      }
      text += ']';
      memo.set(key, text);
      return text;
    } finally {
      seen.delete(key);
    }
  }
  return `#<${(key as RBasic).cls.name}>`;
}

function boundedKeyText(text: string): string {
  return text.length <= 4096 ? text : `${text.slice(0, 2048)}…${text.slice(-2048)} (${text.length} chars)`;
}
