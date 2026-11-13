import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
import type { RecordValue, Scalar, Value } from './arith';
import { CRuntimeError } from './errors';
import { ByteStream } from './library/support';
import { type Allocation, Memory } from './memory';
import { type PointerRange, replacePointerRanges, slicePointerRanges } from './pointerBounds';
import type { CType, FunctionType } from './types';

/** A block-scope variable of a function, in the order the function declares it. */
export interface LocalInfo {
  name: string;
  type: CType;
  index: number;
  row: number;
  /** Whether the variable lives in memory (an array, a struct, or a variable whose address the program takes). */
  inMemory: boolean;
  /** The size of the variable's block, for one that lives in memory. */
  size: number;
  /** The global that holds a `static` local. */
  staticGlobal?: GlobalInfo;
  isParameter: boolean;
}

export interface GlobalInfo {
  header?: string;
  referencedAt?: number;
  index: number;
  name: string;
  type: CType;
  row: number;
  /** Writes the initial value into the variable's block, which starts zeroed. */
  initialize?: (runtime: Runtime, block: Allocation) => void;
  /** Whether learners see the variable in the trace: one the program declares at file scope and may change. */
  isShown: boolean;
  isReadOnly: boolean;
  /** Whether a definition (rather than only `extern` declarations) gives the variable storage. */
  isDefined: boolean;
}

/** What a statement leaves for the statement around it. */
export const enum Completion {
  Normal = 0,
  Break = 1,
  Continue = 2,
  Return = 3,
  Goto = 4,
}

/** Runs a statement; `entry` is a label inside it to start at, as a `goto` or a `switch` does. */
export type Exec = (frame: Frame, entry?: number) => Completion;

export type NativeFunction = (runtime: Runtime, args: Value[], argTypes: CType[], row: number) => Value | undefined;

export interface FunctionInfo {
  name: string;
  type: FunctionType;
  row: number;
  isDefined: boolean;
  isStatic: boolean;
  hasPlaceholderType?: boolean;
  body?: Exec;
  native?: NativeFunction;
  locals: LocalInfo[];
  params: LocalInfo[];
  slotCount: number;
  isAtomic: boolean;
  /** The function's address, as a pointer to it holds. */
  address?: number;
  /** The header that declares a library function, which the program must include to call it. */
  header?: string;
  /** The row where the program first refers to the function, which must then be defined. */
  referencedAt?: number;
}

export class Frame implements TracedFrame {
  readonly slots: (Scalar | undefined)[];
  /** The addresses of the function's variables that live in memory, by local index. */
  readonly bases: number[] = [];
  readonly blocks = new Map<number, Allocation>();
  /** Which variables are in scope, by local index, for the trace. */
  readonly live: boolean[] = [];
  visibleLocals?: readonly LocalInfo[];
  finalVisibleLocals?: readonly LocalInfo[];
  readonly pointerRanges = new Map<number, PointerRange>();
  returnRange?: PointerRange;
  returnValue: Value | undefined;
  /** The label a `goto` jumps to, while its completion travels to the statement holding the label. */
  gotoLabel = -1;

  constructor(
    readonly runtime: Runtime,
    readonly fn: FunctionInfo,
    readonly callRow: number | undefined
  ) {
    this.slots = Array.from({ length: fn.slotCount });
  }
  enterScope(locals: readonly LocalInfo[]): void {
    for (const local of locals) {
      if (!local.inMemory || local.staticGlobal) continue;
      const block = this.runtime.allocate(local.size, 'stack');
      block.type = local.type;
      block.name = local.name;
      this.bases[local.index] = block.base;
      this.blocks.set(local.index, block);
    }
  }

  exitScope(locals: readonly LocalInfo[]): void {
    for (const local of locals) {
      const index = local.index;
      this.live[index] = false;
      this.slots[index] = undefined;
      this.pointerRanges.delete(index);
      const block = this.blocks.get(index);
      if (block) {
        this.runtime.memory.release(block);
        this.blocks.delete(index);
      }
    }
  }
}

export class Runtime implements TracedRuntime<Frame> {
  readonly world = new TurtleWorld();
  readonly budget = new ExecutionBudget();
  readonly steps = new StepTracker();
  readonly memory = new Memory();
  readonly io: ProgramIO;
  readonly frames: Frame[] = [];
  globals: Allocation[] = [];
  /** The blocks of the program's string literals, by the compiler's index. */
  literals: Allocation[] = [];
  readonly strings = new Map<string, Allocation>();
  /** The addresses of the FILE objects of the standard streams. */
  streams = { stdin: -1, stdout: -1, stderr: -1 };
  /** The address of `errno`, when the program includes errno.h. */
  errnoAddress?: number;
  private readonly writers: Record<'stdout' | 'stderr', ByteStream>;
  /** The functions by address. */
  readonly functions = new Map<number, FunctionInfo>();
  returnRange?: PointerRange;
  randomState = 1;
  /** Where `strtok` continues when called with NULL. */
  tokenizerPosition = 0;
  readonly exitHandlers: number[] = [];
  private fallbackErrno = 0;

  get errno(): number {
    return this.errnoAddress === undefined
      ? this.fallbackErrno
      : (loaderOf({ kind: 'int', name: 'int' })(this, this.errnoAddress) as number);
  }

  set errno(value: number) {
    this.fallbackErrno = value;
    if (this.errnoAddress !== undefined) storerOf({ kind: 'int', name: 'int' })(this, this.errnoAddress, value);
  }
  private allocatedSlots = 0;

  constructor(input?: ProgramInput) {
    this.io = new ProgramIO(this.budget, input);
    this.writers = {
      stdout: new ByteStream((text) => this.io.stdout.write(text)),
      stderr: new ByteStream((text) => this.io.stderr.write(text)),
    };
  }

  /** Writes bytes to a standard stream, which shows them as UTF-8 text. */
  output(stream: 'stdout' | 'stderr', bytes: Uint8Array): void {
    this.writers[stream].bytes(bytes);
  }

  flushOutput(): void {
    this.writers.stdout.flush();
    this.writers.stderr.flush();
  }

  spend(cost = 1): void {
    this.budget.spend(cost);
  }

  /** Charges a block of `size` bytes, telling whether the run may still allocate it. */
  reserve(size: number): boolean {
    const slots = Math.ceil(size / 4);
    if (this.allocatedSlots + slots > LIMITS.maxSlots) return false;
    this.allocatedSlots += slots;
    this.spend(Math.ceil(slots / 64));
    return true;
  }

  allocate(size: number, region: 'data' | 'heap' | 'stack' | 'text'): Allocation {
    if (!this.reserve(size)) throw new CRuntimeError('custom', 'メモリを確保しすぎました。');
    return this.memory.allocate(size, region);
  }

  /** The block of a string literal, which identical literals share, as clang merges them. */
  stringLiteral(bytes: Uint8Array): Allocation {
    const key = String.fromCodePoint(...bytes);
    let block = this.strings.get(key);
    if (!block) {
      block = this.allocate(bytes.length, 'data');
      block.bytes.set(bytes);
      block.initialized.fill(255);
      block.isReadOnly = true;
      this.strings.set(key, block);
    }
    return block;
  }

  /**
   * Calls a function with arguments already converted to its parameters' types.
   *
   * @param onReturn Receives the callee's frame when it returns, while the frame still holds its variables.
   */
  call(
    fn: FunctionInfo,
    args: Value[],
    argTypes: CType[],
    callRow: number | undefined,
    onReturn?: (frame: Frame) => void,
    argRanges: (PointerRange | undefined)[] = []
  ): Value | undefined {
    this.spend();
    if (fn.native) {
      const result = fn.native(this, args, argTypes, callRow ?? 0);
      this.returnRange =
        fn.type.ret.kind === 'pointer' && typeof result === 'number'
          ? argRanges.find((range) => range && result >= range.start && result <= range.end)
          : undefined;
      return result;
    }
    if (!fn.body) throw new CRuntimeError('custom', `関数「${fn.name}」が定義されていません。`);
    if (this.frames.length >= LIMITS.maxCallDepth) throw new CRuntimeError('stackOverflow');
    const frame = new Frame(this, fn, callRow);
    frame.enterScope(fn.params);
    for (const [index, param] of fn.params.entries()) {
      bindParameter(frame, param, args[index], argRanges[index]);
    }
    this.frames.push(frame);
    try {
      (fn.body as Exec)(frame);
      onReturn?.(frame);
    } finally {
      this.frames.pop();
      for (const block of frame.blocks.values()) this.memory.release(block);
    }
    if (fn.isAtomic) this.steps.completeAtomicCall();
    this.returnRange = frame.returnRange;
    return frame.returnValue;
  }

  /** Removes the turtles that no variable, nor any block a variable reaches, points to any longer. */
  // code-gauge-allow functionCognitiveComplexity 22 -- Root discovery and the reachability worklist share allocation identities; retain the single traversal.
  collectGarbage(): void {
    if (!this.world.hasTurtles) return;
    const reached = new Set<Allocation>();
    const pending: Allocation[] = [];
    const visit = (address: number): void => {
      if (!this.memory.isHeapAddress(address)) return;
      const block = this.memory.find(address);
      if (!block || reached.has(block)) return;
      reached.add(block);
      pending.push(block);
    };
    for (const frame of this.frames) {
      for (const value of frame.slots) if (typeof value === 'number') visit(value);
      if (frame.returnValue !== undefined && typeof frame.returnValue === 'number') visit(frame.returnValue);
    }
    for (const block of this.memory.blocks()) {
      if (block.region === 'stack' || block.region === 'data') pending.push(block);
    }
    while (pending.length > 0) {
      const block = pending.pop() as Allocation;
      for (let offset = 0; offset + 8 <= block.size; offset += 8) {
        visit(block.view.getUint32(offset, true) + block.view.getUint32(offset + 4, true) * 2 ** 32);
      }
    }
    this.world.retain((turtle) => [...reached].some((block) => block.turtle === turtle));
  }
}

function bindParameter(frame: Frame, param: LocalInfo, value: Value | undefined, range?: PointerRange): void {
  frame.live[param.index] = true;
  if (!param.inMemory) {
    frame.slots[param.index] = value as Scalar | undefined;
    if (range) frame.pointerRanges.set(param.index, range);
    return;
  }
  storeValue(frame.runtime, frame.bases[param.index], param.type, value, range);
}

/** Stores a value of any complete type at an address, which the caller has already converted to the type. */
export function storeValue(
  runtime: Runtime,
  address: number,
  type: CType,
  value: Value | undefined,
  range?: PointerRange
): void {
  if (value === undefined) return;
  if (typeof value === 'object') {
    storeRecord(runtime, address, value);
    return;
  }
  storerOf(type)(runtime, address, value);
  if (type.kind === 'pointer' && range) {
    const block = runtime.memory.locate(address, 8);
    block.pointerRanges.set(address - block.base, range);
  }
}

export function storeRecord(runtime: Runtime, address: number, value: RecordValue): void {
  const block = runtime.memory.locate(address, value.bytes.length);
  if (block.isReadOnly) throw new CRuntimeError('readOnly');
  const offset = address - block.base;
  replacePointerRanges(block.pointerRanges, offset, value.bytes.length, value.pointerRanges);
  block.bytes.set(value.bytes, offset);
  block.initialized.set(value.initialized, offset);
}

export function loadRecord(runtime: Runtime, address: number, size: number): RecordValue {
  const block = runtime.memory.locate(address, size);
  const offset = address - block.base;
  return {
    pointerRanges: slicePointerRanges(block.pointerRanges, offset, size),
    bytes: block.bytes.slice(offset, offset + size),
    initialized: block.initialized.slice(offset, offset + size),
  };
}

type Loader = (runtime: Runtime, address: number) => Scalar;
type Storer = (runtime: Runtime, address: number, value: Scalar) => void;

function checkInitialized(block: Allocation, offset: number, size: number): void {
  const flags = block.initialized;
  for (let index = offset; index < offset + size; index++) {
    if (flags[index] !== 255) throw new CRuntimeError('uninitialized');
  }
}

function read(size: number, get: (view: DataView, offset: number) => Scalar): Loader {
  return (runtime, address) => {
    const block = runtime.memory.locate(address, size);
    const offset = address - block.base;
    checkInitialized(block, offset, size);
    return get(block.view, offset);
  };
}

function write(size: number, set: (view: DataView, offset: number, value: Scalar) => void): Storer {
  return (runtime, address, value) => {
    const block = runtime.memory.locate(address, size);
    if (block.isReadOnly) throw new CRuntimeError('readOnly');
    const offset = address - block.base;
    replacePointerRanges(block.pointerRanges, offset, size);
    set(block.view, offset, value);
    block.initialized.fill(255, offset, offset + size);
  };
}

/** A function reading a scalar of a type from memory, stopping at bytes the program never wrote. */
export function loaderOf(type: CType): Loader {
  switch (type.kind) {
    case 'int': {
      switch (type.name) {
        case 'bool': {
          return read(1, (view, offset) => (view.getUint8(offset) === 0 ? 0 : 1));
        }
        case 'char':
        case 'schar': {
          return read(1, (view, offset) => view.getInt8(offset));
        }
        case 'uchar': {
          return read(1, (view, offset) => view.getUint8(offset));
        }
        case 'short': {
          return read(2, (view, offset) => view.getInt16(offset, true));
        }
        case 'ushort': {
          return read(2, (view, offset) => view.getUint16(offset, true));
        }
        case 'int': {
          return read(4, (view, offset) => view.getInt32(offset, true));
        }
        case 'uint': {
          return read(4, (view, offset) => view.getUint32(offset, true));
        }
        case 'long':
        case 'llong': {
          return read(8, (view, offset) => view.getBigInt64(offset, true));
        }
        default: {
          return read(8, (view, offset) => view.getBigUint64(offset, true));
        }
      }
    }
    case 'float': {
      return type.name === 'float'
        ? read(4, (view, offset) => view.getFloat32(offset, true))
        : read(8, (view, offset) => view.getFloat64(offset, true));
    }
    case 'pointer': {
      return read(8, (view, offset) => view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 2 ** 32);
    }
    default: {
      throw new Error(`No loader for ${type.kind}`);
    }
  }
}

export function storerOf(type: CType): Storer {
  switch (type.kind) {
    case 'int': {
      switch (type.name) {
        case 'bool':
        case 'char':
        case 'schar':
        case 'uchar': {
          return write(1, (view, offset, value) => view.setUint8(offset, Number(value) & 0xff));
        }
        case 'short':
        case 'ushort': {
          return write(2, (view, offset, value) => view.setUint16(offset, Number(value) & 0xff_ff, true));
        }
        case 'int':
        case 'uint': {
          return write(4, (view, offset, value) => view.setUint32(offset, Number(value) >>> 0, true));
        }
        default: {
          return write(8, (view, offset, value) =>
            view.setBigUint64(offset, BigInt.asUintN(64, value as bigint), true)
          );
        }
      }
    }
    case 'float': {
      return type.name === 'float'
        ? write(4, (view, offset, value) => view.setFloat32(offset, value as number, true))
        : write(8, (view, offset, value) => view.setFloat64(offset, value as number, true));
    }
    case 'pointer': {
      return write(8, (view, offset, value) => {
        const address = value as number;
        view.setUint32(offset, address % 2 ** 32, true);
        view.setUint32(offset + 4, Math.floor(address / 2 ** 32), true);
      });
    }
    default: {
      throw new Error(`No storer for ${type.kind}`);
    }
  }
}
