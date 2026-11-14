import { ExecutionBudget, LIMITS } from '../interpreter/limits';
import { type ProgramInput, ProgramIO } from '../interpreter/programIo';
import { StepTracker } from '../interpreter/stepTracker';
import type { TracedFrame, TracedRuntime } from '../interpreter/traceRecorder';
import { TurtleWorld } from '../interpreter/turtleWorld';
import type { RecordValue, Scalar, Value } from './arith';
import { CRuntimeError } from './errors';
import { ByteStream } from './library/support';
import { type Allocation, Memory } from './memory';
import {
  type Evaluated,
  narrowByteProvenance,
  type PointerBytes,
  pointerBytesOf,
  type PointerRange,
  replacePointerBytes,
  slicePointerBytes,
  storedPointerBytes,
} from './pointerBounds';
import { alignOf, type CType, type FunctionType, sizeOf } from './types';

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
  /** Whether the variable is a variable-length array, whose block its declaration creates. */
  isVla?: boolean;
  /** The global that holds a `static` local. */
  staticGlobal?: GlobalInfo;
  alignment?: number;
  isParameter: boolean;
}

export interface GlobalInfo {
  alignment?: number;
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
  /** Whether the definition says `inline` without `static` or `extern`, which alone defines no external function. */
  isInlineDefinition?: boolean;
  /** Whether a declaration without `inline` (or with `extern`) makes the definition an external one. */
  hasExternalDeclaration?: boolean;
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
  readonly scalarBytes = new Map<number, PointerBytes>();
  readonly scalarRanges = new Map<number, PointerRange>();
  returnRange?: PointerRange;
  returnBytes?: PointerBytes;
  returnValue: Value | undefined;
  /** The label a `goto` jumps to, while its completion travels to the statement holding the label. */
  gotoLabel = -1;
  /** The address of the block holding a variadic function's extra arguments, which `va_start` points to. */
  varargs = 0;
  /** The lengths of the function's variable-length arrays, by slot, computed when their declarations run. */
  readonly vla: number[] = [];

  constructor(
    readonly runtime: Runtime,
    readonly fn: FunctionInfo,
    readonly callRow: number | undefined
  ) {
    this.slots = Array.from({ length: fn.slotCount });
  }
  assign(index: number, result: Evaluated | undefined): void {
    const type = this.fn.locals[index]?.type;
    if (type?.kind === 'int' && (result?.range || result?.bytes?.size)) this.runtime.hasIntegerProvenance = true;
    this.slots[index] = result?.value as Scalar | undefined;
    if (result?.range) this.scalarRanges.set(index, result.range);
    else this.scalarRanges.delete(index);
    const bytes =
      result?.range && type && sizeOf(type) === 8
        ? type.kind === 'pointer'
          ? pointerBytesOf(result.range, result.value as Scalar)
          : storedPointerBytes(result.range, result.value as Scalar, result.bytes, this.runtime.budget)
        : type?.kind === 'int' && sizeOf(type) === 1 && result
          ? narrowByteProvenance(result.bytes, result.value as Scalar, this.runtime.budget)
          : result?.bytes;
    if (bytes) this.scalarBytes.set(index, bytes);
    else this.scalarBytes.delete(index);
  }

  enterScope(locals: readonly LocalInfo[]): void {
    for (const local of locals) {
      if (!local.inMemory || local.staticGlobal || local.isVla) continue;
      const block = this.runtime.allocate(local.size, 'stack', Math.max(alignOf(local.type), local.alignment ?? 0));
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
      this.assign(index, undefined);
      const block = this.blocks.get(index);
      if (block) {
        this.runtime.memory.release(block);
        this.blocks.delete(index);
      }
    }
  }
}

export class Runtime implements TracedRuntime<Frame> {
  hasIntegerProvenance = false;
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
  returnBytes?: PointerBytes;
  randomState = 1;
  /** Where `strtok` continues when called with NULL. */
  tokenizerPosition = 0;
  readonly exitHandlers: number[] = [];
  /** The static struct tm and string of time.h's functions, created when first used. */
  readonly timeBuffers: { tm?: Allocation; text?: Allocation } = {};
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
  private readonly temporaryScopes: Allocation[][] = [];
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

  allocate(size: number, region: 'data' | 'heap' | 'stack' | 'text', alignment?: number): Allocation {
    if (!this.reserve(size)) throw new CRuntimeError('custom', 'メモリを確保しすぎました。');
    return this.memory.allocate(size, region, alignment);
  }

  fullExpression<T>(run: () => T): T {
    const temporaries: Allocation[] = [];
    this.temporaryScopes.push(temporaries);
    try {
      return run();
    } finally {
      this.temporaryScopes.pop();
      for (const block of temporaries) this.memory.release(block);
    }
  }

  materialize(value: RecordValue, type: CType): Allocation {
    const temporaries = this.temporaryScopes.at(-1);
    if (!temporaries) throw new Error('A record temporary requires a full-expression lifetime');
    const block = this.allocate(value.bytes.length, 'stack');
    block.type = type;
    storeRecord(this, block.base, value);
    block.isReadOnly = true;
    temporaries.push(block);
    return block;
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
  // code-gauge-allow functionNcss 31 -- Call setup and cleanup share the frame and argument metadata.
  call(
    fn: FunctionInfo,
    args: Value[],
    argTypes: CType[],
    callRow: number | undefined,
    onReturn?: (frame: Frame) => void,
    argMetadata: Pick<Evaluated, 'range' | 'bytes'>[] = []
  ): Value | undefined {
    this.spend();
    if (fn.native) {
      const result = fn.native(this, args, argTypes, callRow ?? 0);
      this.returnRange =
        fn.type.ret.kind === 'pointer' && typeof result === 'number'
          ? argMetadata.map((item) => item.range).find((range) => range && result >= range.start && result <= range.end)
          : undefined;
      this.returnBytes = undefined;
      return result;
    }
    if (!fn.body) throw new CRuntimeError('custom', `関数「${fn.name}」が定義されていません。`);
    if (this.frames.length >= LIMITS.maxCallDepth) throw new CRuntimeError('stackOverflow');
    const frame = new Frame(this, fn, callRow);
    frame.enterScope(fn.params);
    for (const [index, param] of fn.params.entries()) {
      bindParameter(frame, param, args[index], argMetadata[index]);
    }
    if (fn.type.variadic)
      frame.varargs = this.storeVarargs(frame, args.slice(fn.params.length), argTypes.slice(fn.params.length));
    this.frames.push(frame);
    try {
      (fn.body as Exec)(frame);
      onReturn?.(frame);
    } finally {
      this.frames.pop();
      for (const block of frame.blocks.values()) this.memory.release(block);
      if (frame.varargs !== 0) this.varargTypes.delete(frame.varargs);
    }
    if (fn.isAtomic) this.steps.completeAtomicCall();
    this.returnRange = frame.returnRange;
    this.returnBytes = frame.returnBytes;
    return frame.returnValue;
  }

  /**
   * Stores a variadic call's extra arguments in 8-byte slots, as arm64 macOS passes them on the stack, so that `va_arg`
   * reads them through a `va_list` that is a `char *`.
   */
  private storeVarargs(frame: Frame, values: Value[], types: CType[]): number {
    const slots: CType[] = [];
    for (const type of types) {
      slots.push(type);
      for (let extra = 8; extra < sizeOf(type); extra += 8) slots.push(type);
    }
    const block = this.allocate(Math.max(slots.length * 8, 8), 'stack');
    frame.blocks.set(-1, block);
    let offset = 0;
    for (const [index, type] of types.entries()) {
      storeValue(this, block.base + offset, type, values[index]);
      offset += Math.ceil(sizeOf(type) / 8) * 8;
    }
    this.varargTypes.set(block.base, slots);
    return block.base;
  }

  /** The types of the arguments in a block of extra arguments, by 8-byte slot. */
  readonly varargTypes = new Map<number, CType[]>();

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

function bindParameter(
  frame: Frame,
  param: LocalInfo,
  value: Value | undefined,
  metadata?: Pick<Evaluated, 'range' | 'bytes'>
): void {
  frame.live[param.index] = true;
  if (!param.inMemory) {
    frame.assign(param.index, value === undefined ? undefined : { value, ...metadata });
    return;
  }
  storeValue(frame.runtime, frame.bases[param.index], param.type, value, metadata?.range, metadata?.bytes);
}

/** Stores a value of any complete type at an address, which the caller has already converted to the type. */
export function storeValue(
  runtime: Runtime,
  address: number,
  type: CType,
  value: Value | undefined,
  range?: PointerRange,
  bytes?: PointerBytes
): void {
  if (value === undefined) return;
  if (typeof value === 'object') {
    storeRecord(runtime, address, value);
    return;
  }
  storerOf(type)(runtime, address, value);
  const metadata =
    range && sizeOf(type) === 8
      ? type.kind === 'pointer'
        ? pointerBytesOf(range, value)
        : storedPointerBytes(range, value, bytes, runtime.budget)
      : type.kind === 'int' && sizeOf(type) === 1
        ? narrowByteProvenance(bytes, value, runtime.budget)
        : bytes;
  if (metadata) {
    if (type.kind === 'int') runtime.hasIntegerProvenance = true;
    const size = sizeOf(type);
    const block = runtime.memory.locate(address, size);
    replacePointerBytes(block.pointerBytes, address - block.base, size, metadata);
  }
}

export function storeRecord(runtime: Runtime, address: number, value: RecordValue): void {
  const block = runtime.memory.locate(address, value.bytes.length);
  if (block.isReadOnly) throw new CRuntimeError('readOnly');
  const offset = address - block.base;
  replacePointerBytes(block.pointerBytes, offset, value.bytes.length, value.pointerBytes);
  block.bytes.set(value.bytes, offset);
  block.initialized.set(value.initialized, offset);
}

export function loadRecord(runtime: Runtime, address: number, size: number): RecordValue {
  const block = runtime.memory.locate(address, size);
  const offset = address - block.base;
  return {
    pointerBytes: slicePointerBytes(block.pointerBytes, offset, size),
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
    replacePointerBytes(block.pointerBytes, offset, size);
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
