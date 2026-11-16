import { panic } from '../arith';
import type { Span } from '../ast';
import { bytesToText, byteValues, CONST_U8 } from '../builtins';
import { known, type NativeCall, runtime, type SemaApi, type TExpr } from '../semaBase';
import {
  BOOL,
  CONST_U8_SLICE,
  errorSetOf,
  errorUnionOf,
  type StructType,
  TYPE,
  type Type,
  typeName,
  U8,
  VOID,
} from '../types';
import { ErrorValue, NativeHandle, Pointer, Slice, type Value, ZArray, ZStruct } from '../values';
import { ALLOCATOR, allocatorMembers, heapNamespace } from './heap';
import {
  addMembers,
  compileArgs,
  expectArgs,
  fnMember,
  handle,
  type Member,
  nativeCall,
  nativeStruct,
  typeMember,
} from './native';
import { compilePrint, decodeOutput } from './print';

let std: StructType | undefined;

/** `@import("std")`: the standard library's namespace, whose members resolve on first use. */
export function importStd(): StructType {
  std ??= nativeStruct('std', {
    debug: typeMember(() => DEBUG),
    Io: typeMember(() => IO),
    process: typeMember(() => PROCESS),
    heap: typeMember(() => heapNamespace()),
    mem: typeMember(() => lazyNamespace('mem')),
    fmt: typeMember(() => lazyNamespace('fmt')),
    ascii: typeMember(() => lazyNamespace('ascii')),
    math: typeMember(() => lazyNamespace('math')),
    sort: typeMember(() => lazyNamespace('sort')),
    unicode: typeMember(() => lazyNamespace('unicode')),
    meta: typeMember(() => lazyNamespace('meta')),
    enums: typeMember(() => lazyNamespace('enums')),
    Random: typeMember(() => lazyNamespace('Random')),
    ArrayList: lazyMember('ArrayList'),
    ArrayListUnmanaged: lazyMember('ArrayList'),
    AutoHashMap: lazyMember('AutoHashMap'),
    AutoHashMapUnmanaged: lazyMember('AutoHashMapUnmanaged'),
    StringHashMap: lazyMember('StringHashMap'),
    StringHashMapUnmanaged: lazyMember('StringHashMapUnmanaged'),
    AutoArrayHashMapUnmanaged: lazyMember('AutoArrayHashMapUnmanaged'),
    StringArrayHashMapUnmanaged: lazyMember('StringArrayHashMapUnmanaged'),
    array_hash_map: lazyMember('array_hash_map'),
    PriorityQueue: lazyMember('PriorityQueue'),
    DoublyLinkedList: lazyMember('DoublyLinkedList'),
    SinglyLinkedList: lazyMember('SinglyLinkedList'),
    ...unavailableMembers({
      Thread: 'スレッド（std.Thread）',
      atomic: 'アトミック操作（std.atomic）',
      fs: 'ファイルの読み書き（std.fs）',
      net: 'ネットワーク（std.net）',
      http: 'ネットワーク（std.http）',
      os: 'OS の機能（std.os）',
      posix: 'OS の機能（std.posix）',
      c: 'C との連携（std.c）',
      Build: 'std.Build',
      time: '時刻（std.time）',
      testing: 'テスト（std.testing）',
      json: 'JSON（std.json）',
      crypto: '暗号（std.crypto）',
      compress: '圧縮（std.compress）',
      zig: 'std.zig',
      builtin: 'std.builtin',
      start: 'std.start',
      log: 'ログ（std.log）',
      Target: 'std.Target',
      Progress: 'std.Progress',
    }),
  });
  return std;
}

/** Members that exist in Zig's library but that this grader rejects, with what learners call them. */
function unavailableMembers(members: Record<string, string>): Record<string, () => Member> {
  return Object.fromEntries(
    Object.entries(members).map(([name, what]) => [
      name,
      fnMember(name, (sema, call) => sema.error(call.span, `${what}は、この採点環境では使えません。`)),
    ])
  );
}

/** Library modules that load on first use, to keep the grader's startup light. */
const LAZY = new Map<string, () => Member>();

export function registerLazy(name: string, resolve: () => Member): void {
  LAZY.set(name, resolve);
}

function lazyNamespace(name: string): Type {
  const resolve = LAZY.get(name);
  if (!resolve) throw new Error(`std.${name} is not registered`);
  return resolve().value as Type;
}

function lazyMember(name: string): () => Member {
  return () => {
    const resolve = LAZY.get(name);
    if (!resolve) throw new Error(`std.${name} is not registered`);
    return resolve();
  };
}

// std.debug -----------------------------------------------------------------------------------------------------------

const DEBUG = nativeStruct('std.debug', {
  print: fnMember('std.debug.print', (sema, call) => {
    const [format, args] = expectArgs(sema, call, 2, 'std.debug.print');
    const print = compilePrint(sema, format, args, call.span);
    return runtime(
      VOID,
      (frame) => {
        frame.runtime.spend();
        frame.runtime.io.stderr.write(decodeOutput(print(frame)));
        return;
      },
      call.span
    );
  }),
  assert: fnMember('std.debug.assert', (sema, call) => {
    const [ok] = compileArgs(sema, expectArgs(sema, call, 1, 'std.debug.assert'), [BOOL]);
    if (ok.known && ok.value === false) sema.error(call.span, 'std.debug.assert の条件が false です。');
    return nativeCall(VOID, [ok], call.span, ([value]) => {
      if (value !== true) panic('reached unreachable code');
      return;
    });
  }),
  panic: fnMember('std.debug.panic', (sema, call) => {
    const [format, args] = expectArgs(sema, call, 2, 'std.debug.panic');
    const print = compilePrint(sema, format, args, call.span);
    return runtime({ kind: 'noreturn' }, (frame) => panic(decodeOutput(print(frame))), call.span);
  }),
});

// std.Io --------------------------------------------------------------------------------------------------------------

/** `std.Io`, whose values (`init.io`) the program passes to I/O functions. */
export const IO: StructType = nativeStruct('Io', {});

/** `std.Io.File`, of which only the standard output and standard error are available. */
const FILE: StructType = nativeStruct('Io.File', {});

/** `std.Io.Writer`, an interface that buffers bytes until it drains them to its stream. */
export const WRITER: StructType = nativeStruct('Io.Writer', {});

/** `std.Io.File.Writer`, whose `interface` field is the `std.Io.Writer` to write through. */
const FILE_WRITER: StructType = nativeStruct('Io.File.Writer', {}, [
  { name: 'interface', type: WRITER, hasDefault: false },
]);

interface WriterState extends Record<string, unknown> {
  /** 1 for standard output, 2 for standard error, or undefined for a fixed buffer. */
  fd: number | undefined;
  buffered: number[];
  capacity: number;
  /** The slice that a fixed writer (`std.Io.Writer.fixed`) fills. */
  fixed?: Slice;
}

const WRITE_FAILED = ErrorValue.of('WriteFailed');
const WRITE_ERROR = errorSetOf(['WriteFailed']);

addIoMembers();

function addIoMembers(): void {
  addMembers(IO, {
    File: typeMember(() => FILE),
    Writer: typeMember(() => WRITER),
    Reader: fnMember('std.Io.Reader', (sema, call) =>
      sema.error(call.span, '標準入力やファイルからの読み込み（std.Io.Reader）は、この採点環境では使えません。')
    ),
    Dir: fnMember('std.Io.Dir', (sema, call) =>
      sema.error(call.span, 'ファイルの読み書き（std.Io.Dir）は、この採点環境では使えません。')
    ),
    net: fnMember('std.Io.net', (sema, call) =>
      sema.error(call.span, 'ネットワーク（std.Io.net）は、この採点環境では使えません。')
    ),
    Clock: fnMember('std.Io.Clock', (sema, call) =>
      sema.error(call.span, '時刻（std.Io.Clock）は、この採点環境では使えません。')
    ),
  });
  addMembers(FILE, {
    stdout: fnMember('std.Io.File.stdout', (sema, call) => {
      expectArgs(sema, call, 0, 'std.Io.File.stdout');
      return known(FILE, handle('file', { fd: 1 }), call.span);
    }),
    stderr: fnMember('std.Io.File.stderr', (sema, call) => {
      expectArgs(sema, call, 0, 'std.Io.File.stderr');
      return known(FILE, handle('file', { fd: 2 }), call.span);
    }),
    stdin: fnMember('std.Io.File.stdin', (sema, call) =>
      sema.error(call.span, '標準入力（std.Io.File.stdin）は、この採点環境では使えません。')
    ),
    Writer: typeMember(() => FILE_WRITER),
    writer: fnMember('File.writer', (sema, call) => fileWriter(sema, call)),
    writerStreaming: fnMember('File.writerStreaming', (sema, call) => fileWriter(sema, call)),
    writeStreamingAll: fnMember('File.writeStreamingAll', (sema, call) => {
      const receiver = fileOf(sema, call);
      const [, bytes] = compileArgs(sema, expectArgs(sema, call, 2, 'writeStreamingAll'), [IO, CONST_U8_SLICE]);
      const evaluate = receiver.eval;
      return nativeCall(errorUnionOf(WRITE_ERROR, VOID), [bytes], call.span, ([value], frame) => {
        const file = evaluate(frame) as NativeHandle;
        writeStream(frame.runtime.io, file.state.fd as number, byteValues(value).map(Number));
        return;
      });
    }),
    reader: fnMember('File.reader', (sema, call) =>
      sema.error(call.span, '標準入力やファイルからの読み込みは、この採点環境では使えません。')
    ),
  });
  addMembers(WRITER, {
    print: fnMember('Writer.print', (sema, call) => {
      const [format, args] = expectArgs(sema, call, 2, 'print');
      const writer = writerOf(sema, call);
      const print = compilePrint(sema, format, args, call.span);
      return runtime(
        errorUnionOf(WRITE_ERROR, VOID),
        (frame) => writeTo(frame, writer(frame), print(frame)),
        call.span
      );
    }),
    writeAll: fnMember('Writer.writeAll', (sema, call) => {
      const writer = writerOf(sema, call);
      const [bytes] = compileArgs(sema, expectArgs(sema, call, 1, 'writeAll'), [CONST_U8_SLICE]);
      const evaluate = bytes.eval;
      return runtime(
        errorUnionOf(WRITE_ERROR, VOID),
        (frame) => writeTo(frame, writer(frame), byteValues(evaluate(frame)).map(Number)),
        call.span
      );
    }),
    writeByte: fnMember('Writer.writeByte', (sema, call) => {
      const writer = writerOf(sema, call);
      const [byte] = compileArgs(sema, expectArgs(sema, call, 1, 'writeByte'), [U8]);
      const evaluate = byte.eval;
      return runtime(
        errorUnionOf(WRITE_ERROR, VOID),
        (frame) => writeTo(frame, writer(frame), [Number(evaluate(frame) as bigint)]),
        call.span
      );
    }),
    splatByteAll: fnMember('Writer.splatByteAll', (sema, call) => {
      const writer = writerOf(sema, call);
      const [byte, count] = compileArgs(sema, expectArgs(sema, call, 2, 'splatByteAll'), [U8, USIZE_TYPE()]);
      const evaluateByte = byte.eval;
      const evaluateCount = count.eval;
      return runtime(
        errorUnionOf(WRITE_ERROR, VOID),
        (frame) => {
          const repeated = Array.from<number>({
            length: Number(evaluateCount(frame) as bigint),
          }).fill(Number(evaluateByte(frame) as bigint));
          return writeTo(frame, writer(frame), repeated);
        },
        call.span
      );
    }),
    flush: fnMember('Writer.flush', (sema, call) => {
      const writer = writerOf(sema, call);
      expectArgs(sema, call, 0, 'flush');
      return runtime(
        errorUnionOf(WRITE_ERROR, VOID),
        (frame) => {
          const state = writer(frame);
          if (state.fd !== undefined) {
            writeStream(frame.runtime.io, state.fd, state.buffered);
            state.buffered = [];
          }
          return;
        },
        call.span
      );
    }),
    fixed: fnMember('std.Io.Writer.fixed', (sema, call) => {
      const [buffer] = compileArgs(sema, expectArgs(sema, call, 1, 'std.Io.Writer.fixed'), [sliceOfU8()]);
      const evaluate = buffer.eval;
      return runtime(
        WRITER,
        (frame) => {
          const slice = evaluate(frame) as Slice;
          return handle('writer', {
            fd: undefined,
            buffered: [],
            capacity: slice.length,
            fixed: slice,
          } satisfies WriterState);
        },
        call.span
      );
    }),
    buffered: fnMember('Writer.buffered', (sema, call) => {
      const writer = writerOf(sema, call);
      return runtime(
        sliceOfU8(),
        (frame) => {
          const state = writer(frame);
          const slice = state.fixed as Slice;
          return new Slice(slice.target, slice.start, state.buffered.length);
        },
        call.span
      );
    }),
  });
}

function USIZE_TYPE(): Type {
  return { kind: 'int', signed: false, bits: 64, name: 'usize' } as Type;
}

function sliceOfU8(): Type {
  return { kind: 'pointer', size: 'slice', child: U8, isConst: false } as Type;
}

function fileOf(sema: SemaApi, call: NativeCall): TExpr {
  const receiver = call.receiver;
  if (!receiver || (receiver.type !== FILE && !(receiver.type.kind === 'pointer' && receiver.type.child === FILE))) {
    return sema.error(call.span, 'std.Io.File の値に対して呼び出してください。');
  }
  if (receiver.type === FILE) return receiver;
  const evaluate = receiver.eval;
  return runtime(FILE, (frame) => (evaluate(frame) as Pointer).load(), receiver.span);
}

/** `file.writer(io, &buffer)`: a File.Writer whose interface buffers up to the buffer's length. */
function fileWriter(sema: SemaApi, call: NativeCall): TExpr {
  const file = fileOf(sema, call);
  const [, buffer] = expectArgs(sema, call, 2, 'writer');
  const [io] = compileArgs(sema, [call.args[0]], [IO]);
  void io;
  const compiledBuffer = sema.compile(buffer, sliceOfU8());
  const slice = sema.coerce(compiledBuffer, sliceOfU8(), buffer);
  const evaluateFile = file.eval;
  const evaluateBuffer = slice.eval;
  return runtime(
    FILE_WRITER,
    (frame) => {
      const target = evaluateFile(frame) as NativeHandle;
      const capacity = (evaluateBuffer(frame) as Slice).length;
      const state: WriterState = { fd: target.state.fd as number, buffered: [], capacity };
      return new ZStruct([handle('writer', state)]);
    },
    call.span
  );
}

/** The state of the writer a method is called on, through `*std.Io.Writer`. */
function writerOf(sema: SemaApi, call: NativeCall): (frame: Parameters<TExpr['eval']>[0]) => WriterState {
  const receiver = call.receiver;
  if (!receiver) return sema.error(call.span, 'std.Io.Writer の値に対して呼び出してください。');
  const type = receiver.type;
  const evaluate = receiver.eval;
  if (type.kind === 'pointer' && type.child === WRITER) {
    return (frame) => ((evaluate(frame) as Pointer).load() as NativeHandle).state as WriterState;
  }
  if (type === WRITER) {
    // A method that takes `*Writer` takes the address of a writer variable or field.
    const address = sema.addressOf(receiver);
    if (address.type.kind === 'pointer' && address.type.isConst) {
      return sema.error(call.span, '定数の std.Io.Writer には書き込めません（var で宣言してください）。');
    }
    const locate = address.eval;
    return (frame) => ((locate(frame) as Pointer).load() as NativeHandle).state as WriterState;
  }
  return sema.error(call.span, `${typeName(type)} 型には、このメソッドがありません。`);
}

/** Writes bytes through a writer: into its buffer, draining the buffer and the bytes when they do not fit. */
function writeTo(frame: Parameters<TExpr['eval']>[0], state: WriterState, bytes: number[]): Value {
  frame.runtime.spend();
  if (state.fixed) {
    if (state.buffered.length + bytes.length > state.capacity) return WRITE_FAILED;
    for (const [index, byte] of bytes.entries()) state.fixed.set(state.buffered.length + index, BigInt(byte));
    state.buffered.push(...bytes);
    return undefined;
  }
  if (state.buffered.length + bytes.length > state.capacity) {
    writeStream(frame.runtime.io, state.fd as number, [...state.buffered, ...bytes]);
    state.buffered = [];
    return undefined;
  }
  state.buffered.push(...bytes);
  return undefined;
}

function writeStream(io: Parameters<TExpr['eval']>[0]['runtime']['io'], fd: number, bytes: readonly number[]): void {
  if (bytes.length === 0) return;
  const text = decodeOutput(bytes);
  if (fd === 2) io.stderr.write(text);
  else io.stdout.write(text);
}

// std.process ---------------------------------------------------------------------------------------------------------

/** `std.process.Init`, which `main` may take to get `io` and the allocators. */
export const PROCESS_INIT: StructType = nativeStruct('process.Init', {}, [
  { name: 'io', type: IO, hasDefault: false },
  { name: 'gpa', type: ALLOCATOR, hasDefault: false },
  {
    name: 'arena',
    type: { kind: 'pointer', size: 'one', child: ALLOCATOR, isConst: true } as Type,
    hasDefault: false,
  },
]);

const PROCESS = nativeStruct('std.process', {
  Init: typeMember(() => PROCESS_INIT),
  exit: fnMember('std.process.exit', (sema, call) => {
    const [code] = compileArgs(sema, expectArgs(sema, call, 1, 'std.process.exit'), [U8]);
    return nativeCall({ kind: 'noreturn' }, [code], call.span, ([value]) => {
      throw new ExitSignal(Number(value as bigint));
    });
  }),
  ...unavailableMembers({
    args: 'コマンドライン引数（std.process.args）',
    argsAlloc: 'コマンドライン引数（std.process.argsAlloc）',
    Child: '外部のプロセス（std.process.Child）',
    getEnvVarOwned: '環境変数（std.process.getEnvVarOwned）',
    Environ: '環境変数（std.process.Environ）',
  }),
});

/** Ends the program as `std.process.exit` does. */
export class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = 'ExitSignal';
  }
}

/** The `std.process.Init` that `main(init: std.process.Init)` receives. */
export function processInit(): Value {
  const gpa = handle('allocator', { name: 'gpa', live: 0 });
  return new ZStruct([
    handle('io', {}),
    gpa,
    new Pointer({ slots: [handle('allocator', { name: 'arena', live: 0 })] }, 0),
  ]);
}

export { allocatorMembers, BOOL, bytesToText, CONST_U8, NativeHandle, TYPE, ZArray };

export function unavailable(sema: SemaApi, span: Span, what: string): never {
  return sema.error(span, `${what}は、この採点環境では使えません。`);
}

export const ERROR_OUT_OF_MEMORY = ErrorValue.of('OutOfMemory');
