// code-gauge-allow-file duplicateLines 17 -- Library types repeat the same shape of method on purpose, each over its own state.
import { LIMITS } from '../interpreter/limits';
import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import { type CompiledProgram, compileSource } from './compiler';
import { runProgram } from './execute';
import {
  BigFloat,
  compareFloats,
  type FloatBits,
  isIntegral,
  shortestDecimal,
  toNumber,
  truncateToBigInt,
} from './floats';
import { sizeOf } from './layout';
import { MemoryFault } from './memoryFault';
import { type Frame, Runtime } from './runtime';
import { UNASSIGNED, undefinedValue } from './semaBase';
import type { Type } from './types';
import { decodeUtf8 } from './utf8';
import {
  ErrorValue,
  isUndefinedMemory,
  NativeHandle,
  NULL,
  Pointer,
  Slice,
  Some,
  type Value,
  ZArray,
  ZStruct,
  ZUnion,
} from './values';

export function traceZigProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const compiled = compileSource(program, {
    atomicRows: new Set(trace.atomicAnnotations.keys()),
  });
  const runtime = new Runtime(input);
  const snapshotter = new Snapshotter(compiled);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.fn.isAtomic,
    variablesOf: (frame) => snapshotter.variablesOf(frame, true),
  });
  runtime.steps.recorder = recorder;
  let finalVars = Object.create(null) as TraceItemVariable;
  // A model program may end with a panic to show how one stops the program.
  const run = runProgram(runtime, compiled, (frame) => {
    finalVars = snapshotter.variablesOf(frame, false).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

interface PreviewPool {
  remaining: number;
  deadline: number;
}

class Snapshotter {
  private readonly previews: PreviewPool = {
    remaining: LIMITS.maxSlots,
    deadline: performance.now() + LIMITS.maxMilliseconds,
  };
  constructor(private readonly program: CompiledProgram) {}

  /**
   * The variables a frame shows: its locals in scope, then, when `withGlobals`, the container-level variables. A
   * method's receiver also shows its fields as `self.x`, as Java's `this.x`.
   */
  // code-gauge-allow functionCognitiveComplexity 16 -- Preserves visible variable order while enforcing the shared preview allowance.
  variablesOf(frame: Frame, withGlobals: boolean): TraceVariables {
    const variables: TraceVariables = {
      vars: Object.create(null) as TraceVariables['vars'],
      referenceVars: Object.create(null) as TraceVariables['referenceVars'],
    };
    if (frame.fn.internal) return variables;
    if (previewRemaining(this.previews) === 0) {
      variables.referenceVars['…'] = TRUNCATED;
      return variables;
    }
    const shown = new Set<string>();
    for (const local of frame.fn.locals) {
      if (previewRemaining(this.previews) === 0) {
        variables.referenceVars['…'] = TRUNCATED;
        break;
      }
      const value = frame.slots[local.slot];
      if (value === UNASSIGNED || local.name.startsWith('\0') || local.name === '_') continue;
      shown.add(local.name);
      addVariable(variables, local.name, value, local.type, this.previews);
      if (local.isReceiver) addReceiverFields(variables, local.name, value, local.type, this.previews);
    }
    if (!withGlobals) return variables;
    for (const global of this.program.globals) {
      if (previewRemaining(this.previews) === 0) {
        variables.referenceVars['…'] = TRUNCATED;
        break;
      }
      if (shown.has(global.name)) continue;
      addVariable(variables, global.name, global.cell.slots[0], global.type, this.previews);
    }
    return variables;
  }
}

type Scalar = TraceItemVariable[string];
const NOT_SCALAR = Symbol('notScalar');
const MAX_SCALAR_EXPANSION = 10_000;
const MAX_DISPLAY_EXPANSION = 2000;
class PreviewBudget {
  constructor(
    private available: number,
    private readonly pool?: PreviewPool
  ) {}

  get remaining(): number {
    return Math.min(this.available, this.pool ? previewRemaining(this.pool) : Infinity);
  }

  spend(cost = 1): boolean {
    const accepted = cost <= this.remaining;
    this.available = Math.max(0, this.available - cost);
    if (this.pool) this.pool.remaining = Math.max(0, this.pool.remaining - cost);
    return accepted;
  }
}
const TRUNCATED: DisplayNode = { kind: 'value', value: '…', verbatim: true };

function addVariable(variables: TraceVariables, name: string, value: Value, type: Type, pool: PreviewPool): void {
  if (isHiddenType(type)) return;
  if (!spendPreview(pool, name.length)) return;
  const scalar = scalarOf(value, type, previewBudget(MAX_SCALAR_EXPANSION, pool));
  if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
  // Arrays and slices also appear as references so that learners can expand their elements.
  if (scalar !== NOT_SCALAR && !isSequence(type)) return;
  const node = displayNodeOf(value, type, new Set(), previewBudget(MAX_DISPLAY_EXPANSION, pool));
  if (node) variables.referenceVars[name] = node;
}

function isHiddenType(type: Type): boolean {
  return type.kind === 'fn' || (type.kind === 'pointer' && type.child.kind === 'fn');
}

function isSequence(type: Type): boolean {
  if (type.kind === 'array') return true;
  if (type.kind === 'pointer')
    return type.size === 'slice' ? !isByte(type.child) : type.child.kind === 'array' && !isByte(type.child.child);
  return false;
}

/** A receiver's fields show as `self.x`, as Java shows `this.x`. */
function addReceiverFields(variables: TraceVariables, name: string, value: Value, type: Type, pool: PreviewPool): void {
  let struct = value;
  let structType = type;
  if (type.kind === 'pointer' && type.size === 'one') {
    struct = (value as Pointer).load();
    structType = type.child;
  }
  if (structType.kind !== 'struct' || !(struct instanceof ZStruct)) return;
  for (const [index, field] of (structType.fields ?? []).entries()) {
    if (!spendPreview(pool, name.length + field.name.length + 1)) break;
    const scalar = scalarOf(struct.slots[index], field.type, previewBudget(MAX_SCALAR_EXPANSION, pool));
    if (scalar !== NOT_SCALAR) variables.vars[`${name}.${field.name}`] = scalar;
  }
}

function isByte(type: Type): boolean {
  return type.kind === 'int' && type.bits === 8 && !type.signed;
}

function isString(type: Type): boolean {
  if (type.kind === 'pointer')
    return type.size === 'slice' ? isByte(type.child) : type.child.kind === 'array' && isByte(type.child.child);
  return false;
}

// code-gauge-allow functionCognitiveComplexity 27 -- Dispatches scalar conversion while sharing one expansion budget.
// code-gauge-allow functionNcss 44 -- Keeps supported scalar type cases together.
function scalarOf(
  value: Value,
  type: Type,
  budget: PreviewBudget = previewBudget(MAX_SCALAR_EXPANSION),
  depth = 0
): Scalar | typeof NOT_SCALAR {
  if (!budget.spend() || depth >= 128) return NOT_SCALAR;
  if (value === UNASSIGNED) return NOT_SCALAR;
  if (unreadableSnapshot(value, type)) return 'undefined';
  if (value instanceof BigFloat && !budget.spend(1 + Math.ceil(Math.abs(value.exponent) / 64))) return NOT_SCALAR;
  switch (type.kind) {
    case 'int':
    case 'comptime_int':
    case 'comptime_float':
    case 'bool': {
      return basicScalar(value, 128, budget);
    }
    case 'float': {
      return floatScalar(value, type.bits, budget);
    }
    case 'enum': {
      const field = type.fields?.find((each) => each.value === value);
      return field ? textScalar(`.${field.name}`, budget) : basicScalar(value, 128, budget);
    }
    case 'error_set': {
      return value instanceof ErrorValue ? textScalar(`error.${value.name}`, budget) : NOT_SCALAR;
    }
    case 'optional': {
      // An optional object is a reference, which shows among the references as Java's null references do.
      if (!hasScalarElements(type.child)) return NOT_SCALAR;
      // oxlint-disable-next-line unicorn/no-null -- The trace format shows null as null.
      if (value === NULL) return null;
      return scalarOf(value instanceof Some ? value.value : value, type.child, budget, depth + 1);
    }
    case 'error_union': {
      if (value instanceof ErrorValue) return textScalar(`error.${value.name}`, budget);
      return scalarOf(value, type.payload, budget, depth + 1);
    }
    case 'pointer': {
      if (isString(type)) {
        return stringScalar(value, budget);
      }
      if (type.size === 'slice' && hasScalarElements(type.child)) {
        return scalarSequence(value as Slice, type.child, budget, depth);
      }
      return NOT_SCALAR;
    }
    case 'array': {
      if (!hasScalarElements(type.child) || !(value instanceof ZArray)) return NOT_SCALAR;
      return scalarSequence(value, type.child, budget, depth);
    }
    default: {
      return NOT_SCALAR;
    }
  }
}

function floatScalar(value: Value, bits: FloatBits, budget: PreviewBudget): Scalar | typeof NOT_SCALAR {
  if (bits > 32 || typeof value !== 'number' || !Number.isFinite(value)) return basicScalar(value, bits, budget);
  const decimal = shortestDecimal(value, bits);
  return Number(`${decimal.sign ? '-' : ''}${decimal.mantissa}e${decimal.exponent}`);
}

function stringScalar(value: Value, budget: PreviewBudget): Scalar | typeof NOT_SCALAR {
  const sequence = sequenceOf(value);
  if (sequence.lengthValue > BigInt(budget.remaining)) return NOT_SCALAR;
  budget.spend(sequence.length);
  return decodeUtf8(Array.from({ length: sequence.length }, (_, index) => Number(sequence.get(index))));
}

function scalarSequence(
  sequence: ZArray | Slice,
  child: Type,
  budget: PreviewBudget,
  depth: number
): Scalar | typeof NOT_SCALAR {
  if (sequence.lengthValue > BigInt(budget.remaining)) return NOT_SCALAR;
  const items: TraceItemVariable[string][] = [];
  for (let index = 0; index < sequence.length; index++) {
    const item = scalarOf(sequenceItem(sequence, child, index), child, budget, depth + 1);
    if (item === NOT_SCALAR) return NOT_SCALAR;
    items.push(item);
  }
  return items;
}

function sequenceOf(value: Value): ZArray | Slice {
  return value instanceof Pointer ? (value.load() as ZArray) : (value as ZArray | Slice);
}

function hasScalarElements(type: Type): boolean {
  if (type.kind === 'array') return hasScalarElements(type.child);
  if (type.kind === 'pointer' && type.size === 'slice' && !isString(type)) return hasScalarElements(type.child);
  if (type.kind === 'optional') return hasScalarElements(type.child);
  return type.kind === 'int' || type.kind === 'float' || type.kind === 'bool' || type.kind === 'enum' || isString(type);
}

function basicScalar(value: Value, bits: FloatBits, budget: PreviewBudget): Scalar | typeof NOT_SCALAR {
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : integerScalar(value, budget);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof BigFloat) {
    const number = toNumber(value);
    if (value.kind !== 'finite' || compareFloats(value, number) === 0) return number;
    if (isIntegral(value)) return integerScalar(truncateToBigInt(value), budget);
    return textScalar(decimalText(value, bits), budget);
  }
  // oxlint-disable-next-line unicorn/no-null -- The trace format shows a missing value as null.
  return null;
}

function integerScalar(value: bigint, budget: PreviewBudget): Scalar | typeof NOT_SCALAR {
  return budget.spend(value.toString().length) ? value : NOT_SCALAR;
}

function textScalar(value: string, budget: PreviewBudget): Scalar | typeof NOT_SCALAR {
  return budget.spend(value.length) ? value : NOT_SCALAR;
}

function decimalText(value: BigFloat, bits: FloatBits): string {
  const decimal = shortestDecimal(value, bits);
  const digits = String(decimal.mantissa);
  const point = digits.length + decimal.exponent;
  const sign = decimal.sign ? '-' : '';
  if (point <= -6 || point > 21) {
    const exponent = point - 1;
    return `${sign}${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}e${exponent >= 0 ? '+' : ''}${exponent}`;
  }
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

// oxlint-disable-next-line unicorn/no-null -- The trace format shows null as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

function displayNodeOf(
  value: Value,
  type: Type,
  seen: Set<unknown>,
  budget: PreviewBudget = previewBudget(MAX_DISPLAY_EXPANSION)
): DisplayNode | undefined {
  if (!budget.spend() || seen.size >= 128) return TRUNCATED;
  try {
    return guardedDisplayNode(value, type, seen, budget);
  } catch (error) {
    if (error instanceof MemoryFault) return { kind: 'value', value: 'undefined', verbatim: true };
    throw error;
  }
}

function guardedDisplayNode(
  value: Value,
  type: Type,
  seen: Set<unknown>,
  budget: PreviewBudget
): DisplayNode | undefined {
  if (typeof value !== 'object' || type.kind === 'optional' || type.kind === 'error_union')
    return displayValue(value, type, seen, budget);
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    return displayValue(value, type, seen, budget);
  } finally {
    seen.delete(value);
  }
}

// code-gauge-allow functionCognitiveComplexity 22 -- Dispatches reference graphs while keeping wrapper payloads transparent.
// code-gauge-allow functionNcss 43 -- Keeps aggregate representation cases together.
function displayValue(value: Value, type: Type, seen: Set<unknown>, budget: PreviewBudget): DisplayNode | undefined {
  if (budget.remaining <= 0) return TRUNCATED;
  if (value === UNASSIGNED) return undefined;
  if (isHiddenType(type)) return undefined;
  if (value instanceof NativeHandle) {
    const turtle = value.state.turtle;
    if (!turtle) return { kind: 'object', entries: {} };
    if (!turtle.isAlive) return undefined;
    return {
      kind: 'object',
      entries: { x: { kind: 'value', value: turtle.x }, y: { kind: 'value', value: turtle.y } },
    };
  }
  const scalar = scalarNodeOf(value, type, budget);
  if (scalar) return scalar;
  switch (type.kind) {
    case 'optional': {
      if (value === NULL) return NULL_NODE;
      return displayNodeOf(value instanceof Some ? value.value : value, type.child, seen, budget);
    }
    case 'error_union': {
      return displayNodeOf(value, type.payload, seen, budget);
    }
    case 'pointer': {
      if (type.size === 'slice') return sequenceNode(value as Slice, type.child, seen, budget);
      const target = (value as Pointer).load();
      return displayNodeOf(target, type.child, seen, budget);
    }
    case 'array': {
      return sequenceNode(value as ZArray, type.child, seen, budget);
    }
    case 'struct': {
      return structNode(value, type, seen, budget);
    }
    case 'union': {
      if (!(value instanceof ZUnion)) return undefined;
      const field = type.fields?.[value.tag];
      if (!field) return undefined;
      const node = displayNodeOf(value.slots[0], field.type, seen, budget);
      return { kind: 'object', entries: node ? { [field.name]: node } : {} };
    }
    default: {
      return undefined;
    }
  }
}

function scalarNodeOf(value: Value, type: Type, budget: PreviewBudget): DisplayNode | undefined {
  const scalar = isSequence(type) && !isString(type) ? NOT_SCALAR : scalarOf(value, type, budget);
  if (scalar !== NOT_SCALAR && !Array.isArray(scalar)) {
    return {
      kind: 'value',
      value: scalar,
      ...(isFloatScalar(type) && typeof scalar === 'string' ? { verbatim: true as const } : {}),
    };
  }
  if (isString(type) && !isUndefinedMemory(value)) {
    const sequence = sequenceOf(value);
    const length = Math.min(sequence.length, budget.remaining);
    budget.spend(length);
    const text = decodeUtf8(Array.from({ length }, (_, index) => Number(sequence.get(index))));
    return { kind: 'value', value: `${text}… (${sequence.lengthValue} bytes)` };
  }
  switch (type.kind) {
    case 'int':
    case 'comptime_int':
    case 'float':
    case 'comptime_float':
    case 'enum':
    case 'error_set': {
      return TRUNCATED;
    }
    default: {
      return undefined;
    }
  }
}

function structNode(
  value: Value,
  type: Extract<Type, { kind: 'struct' }>,
  seen: Set<unknown>,
  budget: PreviewBudget
): DisplayNode | undefined {
  if (!(value instanceof ZStruct)) return undefined;
  const entries = Object.create(null) as Record<string, DisplayNode>;
  for (const [index, field] of (type.fields ?? []).entries()) {
    if (!budget.spend(field.name.length)) {
      let marker = '…';
      while (Object.hasOwn(entries, marker)) marker += '…';
      entries[marker] = TRUNCATED;
      break;
    }
    const node = displayNodeOf(
      field.comptimeValue ? field.comptimeValue.value : value.slots[index],
      field.type,
      seen,
      budget
    );
    if (node) entries[field.name] = node;
  }
  return { kind: type.isTuple ? 'array' : 'object', entries };
}

function isFloatScalar(type: Type): boolean {
  if (type.kind === 'optional') return isFloatScalar(type.child);
  if (type.kind === 'error_union') return isFloatScalar(type.payload);
  return type.kind === 'float' || type.kind === 'comptime_float';
}

function sequenceNode(items: ZArray | Slice, child: Type, seen: Set<unknown>, budget: PreviewBudget): DisplayNode {
  const entries = Object.create(null) as Record<string, DisplayNode>;
  let index = 0;
  while (BigInt(index) < items.lengthValue && budget.remaining > 0) {
    entries[index] = displayNodeOf(sequenceItem(items, child, index), child, seen, budget) ?? NULL_NODE;
    index++;
  }
  if (BigInt(index) < items.lengthValue)
    entries['…'] = { kind: 'value', value: `… (${items.lengthValue} items)`, verbatim: true };
  return { kind: 'array', entries };
}

function previewBudget(remaining: number, pool?: PreviewPool): PreviewBudget {
  return new PreviewBudget(remaining, pool);
}

function previewRemaining(pool: PreviewPool): number {
  if (performance.now() >= pool.deadline) pool.remaining = 0;
  return pool.remaining;
}

function spendPreview(pool: PreviewPool, cost: number): boolean {
  if (cost > previewRemaining(pool)) {
    pool.remaining = 0;
    return false;
  }
  pool.remaining -= cost;
  return true;
}

function unreadableSnapshot(value: Value, type: Type): boolean {
  if (type.kind === 'optional' || type.kind === 'error_union' || !isUndefinedMemory(value)) return false;
  if (value instanceof Slice && type.kind === 'pointer' && type.size === 'slice') {
    return value.undefinedHeader || (value.lengthValue !== 0n && sizeOf(type.child) !== 0);
  }
  return true;
}

function sequenceItem(value: ZArray | Slice, child: Type, index: number): Value {
  return sizeOf(child) === 0 ? undefinedValue(child) : value.get(index);
}
