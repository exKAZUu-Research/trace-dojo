import type { ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import { TraceRecorder, type TraceVariables } from '../interpreter/traceRecorder';
import type { DisplayNode, TraceItemVariable } from '../problems/trace';
import type { Scalar } from './arith';
import type { CompiledProgram } from './compiler';
import { CRuntimeError } from './errors';
import { compileC, runProgram } from './execute';
import { readBits, readScalar } from './expressionCompiler';
import type { Allocation } from './memory';
import { type Frame, Runtime } from './runtime';
import { type CType, isCharType, sizeOf } from './types';

// code-gauge-allow duplicateLines 15 -- Each language wires its own runtime into the shared TraceRecorder alike.
export function traceCProgram(program: string, trace: TraceOptions, input?: ProgramInput): ProgramRecording {
  const compiled = compileC(program, { trace });
  const runtime = new Runtime(input);
  const snapshotter = new Snapshotter(runtime, compiled);
  const recorder = new TraceRecorder(runtime, {
    isAtomic: (frame) => frame.fn.isAtomic,
    variablesOf: (frame) => snapshotter.variablesOf(frame, true),
  });
  runtime.steps.recorder = recorder;
  let finalVars: TraceItemVariable = {};
  // A model program may end with an error to show how one stops the program.
  const run = runProgram(runtime, compiled, (frame) => {
    finalVars = snapshotter.variablesOf(frame, false).vars;
  });
  return { traceItems: recorder.traceItems, finalVars, ...run };
}

const NOT_SCALAR = Symbol('notScalar');
type Scalarish = TraceItemVariable[string];
// oxlint-disable-next-line unicorn/no-null -- The trace format shows NULL and values never written as null.
const NULL_NODE: DisplayNode = { kind: 'value', value: null };

/** Reads the program's variables as learners see them, without stopping at bytes the program never wrote. */
class Snapshotter {
  constructor(
    private readonly runtime: Runtime,
    private readonly program: CompiledProgram
  ) {}

  /** The variables a frame shows: its own in scope, then the file-scope variables when `withContext`. */
  // code-gauge-allow functionCognitiveComplexity 21 -- Lexical locals, receiver fields, and globals must obey one shadowing order.
  variablesOf(frame: Frame, withContext: boolean): TraceVariables {
    const variables: TraceVariables = { vars: {}, referenceVars: {} };
    const hidesArgs = frame.fn === this.program.main && frame.fn.params.length === 2;
    const locals = frame.visibleLocals ?? frame.fn.locals.filter((local) => frame.live[local.index]);
    for (const local of locals) {
      // main's parameters only receive the launcher's arguments, which these programs never use.
      if (hidesArgs && local.isParameter) continue;
      if (!local.inMemory) {
        const value = frame.slots[local.index];
        if (value !== undefined) this.addVariable(variables, local.name, local.type, { value });
        continue;
      }
      const address = local.staticGlobal
        ? this.runtime.globals[local.staticGlobal.index]?.base
        : frame.bases[local.index];
      if (address !== undefined) this.addVariable(variables, local.name, local.type, { address });
    }
    if (!withContext) return variables;
    this.addReceiverFields(variables, frame);
    for (const global of this.program.globals) {
      if (!global.isShown || locals.some((local) => local.name === global.name)) continue;
      const block = this.runtime.globals[global.index];
      if (block) this.addVariable(variables, global.name, global.type, { address: block.base });
    }
    return variables;
  }

  /**
   * The members of the struct that a function's first parameter points to, as `m->x`: C's way to write a method takes
   * the object as its first parameter, and Java shows the fields of `this` alike.
   */
  private addReceiverFields(variables: TraceVariables, frame: Frame): void {
    const [first] = frame.fn.params;
    if (!first || first.type.kind !== 'pointer' || first.type.to.kind !== 'record' || first.type.to.info.isTurtle)
      return;
    if (!frame.live[first.index] || frame.fn === this.program.main) return;
    const where: Where = first.inMemory
      ? { address: frame.bases[first.index] }
      : { value: frame.slots[first.index] as Scalar };
    const address = this.read(first.type, where);
    if (address === undefined || address === 0) return;
    for (const field of first.type.to.info.fields ?? []) {
      if (field.name === undefined || field.bitWidth !== undefined) continue;
      const scalar = this.scalarOf(field.type, { address: (address as number) + field.offset });
      if (scalar !== NOT_SCALAR && scalar !== undefined) variables.vars[`${first.name}->${field.name}`] = scalar;
    }
  }

  private addVariable(variables: TraceVariables, name: string, type: CType, where: Where): void {
    const scalar = this.scalarOf(type, where);
    if (scalar === undefined) return;
    if (scalar !== NOT_SCALAR) variables.vars[name] = scalar;
    // Arrays also appear as references so that learners can expand their elements.
    const isArray =
      (type.kind === 'array' && !isCharType(type.of)) ||
      (type.kind === 'pointer' && isArrayLike(this.runtime, type, where));
    if (scalar !== NOT_SCALAR && !isArray) return;
    const node = this.nodeOf(type, where, new Set());
    if (node) variables.referenceVars[name] = node;
  }

  /** A value read from a variable or from memory, or undefined for one the program never wrote. */
  private read(type: CType, where: Where): Scalar | undefined {
    if ('value' in where) return where.value;
    const block = this.runtime.memory.find(where.address);
    if (!block) return undefined;
    const offset = where.address - block.base;
    const size = sizeOf(type);
    if (offset + size > block.size) return undefined;
    for (let index = offset; index < offset + size; index++) if (block.initialized[index] !== 255) return undefined;
    return readScalar(block.view, offset, type);
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of type.
  // code-gauge-allow functionNcss 35 -- One display case per C type; helpers isolate strings and pointed-to elements.
  private scalarOf(type: CType, where: Where): Scalarish | typeof NOT_SCALAR | undefined {
    switch (type.kind) {
      case 'int':
      case 'float': {
        const value = this.read(type, where);
        return value === undefined ? undefined : scalarValue(type, value);
      }
      case 'pointer': {
        const value = this.read(type, where);
        if (value === undefined) return undefined;
        if (value === 0) return NOT_SCALAR;
        const block = this.runtime.memory.find(value as number);
        if (!block) return `0x${Number(value).toString(16)}`;
        if (isCharType(type.to)) return this.stringAt(value as number) ?? NOT_SCALAR;
        if (isArrayLike(this.runtime, type, where)) return this.elementsFrom(type.to, value as number);
        return NOT_SCALAR;
      }
      case 'array': {
        if (!('address' in where)) return NOT_SCALAR;
        if (isCharType(type.of)) return this.stringAt(where.address, sizeOf(type)) ?? NOT_SCALAR;
        if (!hasScalarElements(type)) return NOT_SCALAR;
        const elementSize = sizeOf(type.of);
        const items: Scalarish[] = [];
        for (let index = 0; index < (type.length ?? 0); index++) {
          const item = this.scalarOf(type.of, { address: where.address + index * elementSize });
          // oxlint-disable-next-line unicorn/no-null -- The trace format shows values never written as null.
          items.push(item === NOT_SCALAR || item === undefined ? null : item);
        }
        return items as Scalarish;
      }
      default: {
        return NOT_SCALAR;
      }
    }
  }

  /** The elements a pointer into a block of scalars reaches, from the pointer to the block's end. */
  private elementsFrom(type: CType, address: number): Scalarish | typeof NOT_SCALAR {
    if (!isScalarElement(type)) return NOT_SCALAR;
    const block = this.runtime.memory.find(address);
    if (!block) return NOT_SCALAR;
    const size = sizeOf(type);
    const items: Scalarish[] = [];
    for (let at = address; at + size <= block.end; at += size) {
      const item = this.scalarOf(type, { address: at });
      // oxlint-disable-next-line unicorn/no-null -- The trace format shows values never written as null.
      items.push(item === NOT_SCALAR || item === undefined ? null : item);
    }
    return items as Scalarish;
  }

  /** The text of a null-terminated string, read as UTF-8, or undefined when it is no string. */
  private stringAt(address: number, limit = Number.POSITIVE_INFINITY): string | undefined {
    const block = this.runtime.memory.find(address);
    if (!block) return undefined;
    const start = address - block.base;
    let end = start;
    while (end < block.size && end - start < limit && block.initialized[end] === 255 && block.bytes[end] !== 0) end++;
    return new TextDecoder().decode(block.bytes.subarray(start, end));
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of type.
  // code-gauge-allow functionNcss 39 -- One display case per C type; recursion shares the same cycle-detection set.
  private nodeOf(type: CType, where: Where, seen: Set<number>): DisplayNode | undefined {
    switch (type.kind) {
      case 'int':
      case 'float': {
        const value = this.read(type, where);
        return value === undefined
          ? NULL_NODE
          : { kind: 'value', value: scalarValue(type, value) as number | string | boolean };
      }
      case 'pointer': {
        const value = this.read(type, where);
        if (value === undefined) return undefined;
        if (value === 0) return NULL_NODE;
        return this.pointeeNode(type.to, value as number, seen);
      }
      case 'array': {
        if (!('address' in where)) return undefined;
        if (isCharType(type.of)) return { kind: 'value', value: this.stringAt(where.address, sizeOf(type)) ?? '' };
        const size = sizeOf(type.of);
        const entries: Record<string, DisplayNode> = {};
        for (let index = 0; index < (type.length ?? 0); index++) {
          entries[index] = this.nodeOf(type.of, { address: where.address + index * size }, seen) ?? NULL_NODE;
        }
        return { kind: 'array', entries };
      }
      case 'record': {
        if (!('address' in where)) return undefined;
        if (seen.has(where.address)) return undefined;
        seen.add(where.address);
        const entries: Record<string, DisplayNode> = {};
        for (const field of type.info.fields ?? []) {
          if (field.name === undefined) continue;
          const node =
            field.bitWidth === undefined
              ? this.nodeOf(field.type, { address: where.address + field.offset }, seen)
              : this.bitFieldNode(type, field.name, where.address);
          entries[field.name] = node ?? NULL_NODE;
        }
        seen.delete(where.address);
        return { kind: 'object', entries };
      }
      default: {
        return undefined;
      }
    }
  }

  private bitFieldNode(type: Extract<CType, { kind: 'record' }>, name: string, address: number): DisplayNode {
    const field = type.info.field(name);
    const block = this.runtime.memory.find(address);
    if (!field || !block || field.bitWidth === undefined) return NULL_NODE;
    const offset = address - block.base + field.offset;
    if (field.type.kind !== 'int') return NULL_NODE;
    try {
      return {
        kind: 'value',
        value: Number(readBits(block, offset, field.bitOffset ?? 0, field.bitWidth, field.type)),
      };
    } catch (error) {
      if (!(error instanceof CRuntimeError) || error.kind !== 'uninitialized') throw error;
      return NULL_NODE;
    }
  }

  /** What a pointer points to: a turtle, a struct, the elements from it to its block's end, or a single value. */
  private pointeeNode(type: CType, address: number, seen: Set<number>): DisplayNode | undefined {
    const block = this.runtime.memory.find(address);
    if (!block) return { kind: 'value', value: `0x${address.toString(16)}` };
    if (block.turtle) {
      if (!block.turtle.isAlive) return undefined;
      return {
        kind: 'object',
        entries: { x: { kind: 'value', value: block.turtle.x }, y: { kind: 'value', value: block.turtle.y } },
      };
    }
    if (type.kind === 'function' || type.kind === 'void') return undefined;
    if (isCharType(type)) return { kind: 'value', value: this.stringAt(address) ?? '' };
    if (blockIsArray(block, type) && type.kind !== 'record') {
      const size = sizeOf(type);
      const entries: Record<string, DisplayNode> = {};
      let index = 0;
      for (let at = address; at + size <= block.end; at += size)
        entries[index++] = this.nodeOf(type, { address: at }, seen) ?? NULL_NODE;
      return { kind: 'array', entries };
    }
    return this.nodeOf(type, { address }, seen);
  }
}

type Where = { value: Scalar } | { address: number };

function scalarValue(type: CType, value: Scalar): Scalarish {
  if (type.kind === 'float') return type.name === 'float' ? shortestFloat(value as number) : (value as number);
  if (type.kind !== 'int') return Number(value);
  if (type.name === 'bool') return value !== 0;
  // A char shows as the character it holds, as Java's char does.
  if (type.name === 'char') return String.fromCodePoint(Number(value) & 0xff);
  if (type.enumInfo) {
    for (const [name, constant] of type.enumInfo.constants) if (constant === Number(value)) return name;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : (value as bigint);
}

/** The shortest double that rounds to the same float, which is how learners write a float's value. */
function shortestFloat(value: number): number {
  if (!Number.isFinite(value)) return value;
  for (let precision = 1; precision <= 9; precision++) {
    const candidate = Number(value.toPrecision(precision));
    if (Math.fround(candidate) === value) return candidate;
  }
  return value;
}

function isScalarElement(type: CType): boolean {
  return type.kind === 'int' || type.kind === 'float' || (type.kind === 'pointer' && isCharType(type.to));
}

function hasScalarElements(type: CType): boolean {
  if (type.kind === 'array') return isCharType(type.of) || hasScalarElements(type.of);
  return isScalarElement(type);
}

/** Whether a block holds an array of a type: an array variable, or a block from malloc, rather than one value. */
function blockIsArray(block: Allocation, type: CType): boolean {
  if (block.isHeap) return true;
  const declared = block.type;
  return declared?.kind === 'array' && sizeOf(type) <= sizeOf(declared.of) * 1;
}

/** Whether a pointer variable points into an array of scalars, which learners see as the elements it reaches. */
function isArrayLike(runtime: Runtime, type: Extract<CType, { kind: 'pointer' }>, where: Where): boolean {
  if (!isScalarElement(type.to) || isCharType(type.to)) return false;
  let address: number | undefined;
  if ('value' in where) address = where.value as number;
  else {
    const block = runtime.memory.find(where.address);
    if (!block) return false;
    const offset = where.address - block.base;
    address = block.view.getUint32(offset, true) + block.view.getUint32(offset + 4, true) * 2 ** 32;
  }
  const target = address === 0 ? undefined : runtime.memory.find(address);
  return target !== undefined && blockIsArray(target, type.to);
}
