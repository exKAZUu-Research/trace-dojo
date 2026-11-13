import type { Entity, FuncEntity, VarEntity } from '../entities';
import { Printer } from '../fmt';
import { addMethod, currentRuntime, definePackage, fn, namedType, opaqueType, typeEntity } from '../native';
import { ProgramExit, type Runtime } from '../runtime';
import { nilPointerPanic } from '../runtimeErrors';
import { BASIC, ERROR_TYPE, type FuncType, pointerTo, type Type } from '../types';
import { Cell, GoFunc, GoStruct, Iface, type NativeState, Pointer, type Value } from '../values';
import * as goTime from './goTime';
import { IO_WRITER } from './io';
import { OS_PACKAGE } from './os';
import { ANY_SLICE, byteSlice, callMethod, INT, receiverStruct, sliceValues, STRING, stringPanic } from './support';
import { now } from './time';

/** The name of the program's source file, which the file flags print. */
const SOURCE_FILE = 'main.go';

const FLAGS = {
  Ldate: 1,
  Ltime: 2,
  Lmicroseconds: 4,
  Llongfile: 8,
  Lshortfile: 16,
  LUTC: 32,
  Lmsgprefix: 64,
  LstdFlags: 3,
};

/** `*log.Logger`, whose output, prefix, and flags live in `native`. */
const LOGGER = opaqueType(namedType('log', 'Logger', { kind: 'struct', fields: [] }));
const LOGGER_POINTER = pointerTo(LOGGER);
export const LOG_LOGGER_POINTER = LOGGER_POINTER;

interface LoggerState extends NativeState {
  out: Value;
  prefix: string;
  flag: number;
}

function createLoggerState(out: Value, prefix: string, flag: number): LoggerState {
  const state: LoggerState = { out, prefix, flag, clone: () => createLoggerState(state.out, state.prefix, state.flag) };
  return state;
}

function loggerOf(receiver: Value): LoggerState {
  const struct = receiverStruct(receiver);
  struct.native ??= createLoggerState(undefined, '', 0);
  return struct.native as LoggerState;
}

let lastCallLine: number | undefined;

/** The line of the log call being written, which slog's writer for the standard logger reports. */
export function logCallLine(): number | undefined {
  return lastCallLine;
}

export function newLogger(out: Value, prefix: string, flag: bigint): Pointer {
  return new Pointer(new Cell(new GoStruct([], createLoggerState(out, prefix, Number(BigInt.asIntN(32, flag))))), 'v');
}

const standardLoggers = new WeakMap<Runtime, Pointer>();

/** The standard logger of the running program, `log.Default()`, which writes to standard error. */
export function standardLogger(): Pointer {
  const runtime = currentRuntime();
  let std = standardLoggers.get(runtime);
  if (!std) {
    std = newLogger(stderrWriter(), '', BigInt(FLAGS.LstdFlags));
    standardLoggers.set(runtime, std);
  }
  return std;
}

/** `os.Stderr` as an io.Writer. */
function stderrWriter(): Value {
  const stderr = OS_PACKAGE.members.get('Stderr') as VarEntity;
  return new Iface(stderr.type, stderr.library?.());
}

/** A location that a log call reports: a line of the program, `file:line` in Go's own sources, or unknown. */
export type Location = number | string | undefined;

/**
 * The frames of Go 1.27.4 (darwin/arm64) outside the program that runtime.Caller reaches: Output's call of output and
 * output's call of runtime.Caller below the logging call, then runtime.main and goexit above main.
 */
const BELOW_CALL = ['log.go:194', 'log.go:218'];
const ABOVE_MAIN = ['proc.go:302', 'asm_arm64.s:1039'];

/**
 * The location a log call reports: `depth` 1 is the row of the call into the library, and each further level is the
 * row where the enclosing function was called. Rows are 0-based.
 */
export function callerLine(callRow: number | undefined, depth: number): Location {
  if (depth < 1) return BELOW_CALL[-depth];
  if (depth === 1) return callRow === undefined ? undefined : callRow + 1;
  const { frames } = currentRuntime();
  const frame = frames.at(-(depth - 1));
  if (depth - 1 >= frames.length) return ABOVE_MAIN[depth - 1 - frames.length];
  return frame?.callRow === undefined ? undefined : frame.callRow + 1;
}

/** `itoa`: the decimal digits of `i`, zero-padded to `width`. */
function itoa(i: bigint, width: number): string {
  return i.toString().padStart(width, '0');
}

// code-gauge-allow functionCognitiveComplexity 16 -- A transcription of Go's formatHeader.
function formatHeader(t: goTime.Time, prefix: string, flag: number, line: Location): string {
  let buf = flag & FLAGS.Lmsgprefix ? '' : prefix;
  if (flag & (FLAGS.Ldate | FLAGS.Ltime | FLAGS.Lmicroseconds)) {
    if (flag & FLAGS.Ldate) {
      const { year, month, day } = goTime.date(t);
      buf += `${itoa(year, 4)}/${itoa(month, 2)}/${itoa(day, 2)} `;
    }
    if (flag & (FLAGS.Ltime | FLAGS.Lmicroseconds)) {
      const { hour, min, sec } = goTime.clock(t);
      buf += `${itoa(hour, 2)}:${itoa(min, 2)}:${itoa(sec, 2)}`;
      if (flag & FLAGS.Lmicroseconds) buf += `.${itoa(goTime.nanosecond(t) / 1000n, 6)}`;
      buf += ' ';
    }
  }
  if (flag & (FLAGS.Lshortfile | FLAGS.Llongfile)) {
    buf += line === undefined ? '???:0: ' : typeof line === 'string' ? `${line}: ` : `${SOURCE_FILE}:${line}: `;
  }
  if (flag & FLAGS.Lmsgprefix) buf += prefix;
  return buf;
}

/** `Logger.output`: writes the header, the message, and a final newline in one Write call. */
export function output(logger: Value, line: Location, message: string): Value {
  lastCallLine = typeof line === 'number' ? line : undefined;
  const t = now();
  const state = loggerOf(logger);
  let buf = formatHeader(t, state.prefix, state.flag, line) + message;
  if (!buf.endsWith('\n')) buf += '\n';
  currentRuntime().checkStringLength(buf.length);
  if (state.out === undefined) nilPointerPanic();
  return (callMethod(state.out, 'Write', [byteSlice(buf)]) as Value[])[1];
}

/** Whether the standard logger reports file names, which slog.SetDefault keeps for its records. */
export function standardLoggerReportsFiles(): boolean {
  return (loggerOf(standardLogger()).flag & (FLAGS.Lshortfile | FLAGS.Llongfile)) !== 0;
}

export function setStandardOutput(writer: Value, flag: number): void {
  const state = loggerOf(standardLogger());
  state.out = writer;
  state.flag = flag;
}

// Members -----------------------------------------------------------------------------------------------------------

type Formatter = (args: Value[]) => string;

const FORMATTERS: Record<string, { params: Type[]; format: Formatter }> = {
  Print: { params: [ANY_SLICE], format: ([args]) => new Printer().print(sliceValues(args)) },
  Printf: {
    params: [STRING, ANY_SLICE],
    format: ([format, args]) => new Printer().printf(format as string, sliceValues(args)),
  },
  Println: { params: [ANY_SLICE], format: ([args]) => new Printer().println(sliceValues(args)) },
};

type LogImpl = (logger: Value, args: Value[], callRow: number | undefined) => Value | Value[];

/** The printing methods and functions, each the same for a Logger and for the standard logger. */
function printingMembers(): Record<string, { signature: FuncType; impl: LogImpl }> {
  const result: Record<string, { signature: FuncType; impl: LogImpl }> = {};
  for (const [suffix, { params, format }] of Object.entries(FORMATTERS)) {
    const variant = suffix.slice('Print'.length);
    const signature = fn(params, [], true);
    result[suffix] = {
      signature,
      impl: (logger, args, row) => {
        output(logger, callerLine(row, 1), format(args));
        return [];
      },
    };
    result[`Fatal${variant}`] = {
      signature,
      impl: (logger, args, row) => {
        output(logger, callerLine(row, 1), format(args));
        throw new ProgramExit(1);
      },
    };
    result[`Panic${variant}`] = {
      signature,
      impl: (logger, args, row) => {
        const message = format(args);
        output(logger, callerLine(row, 1), message);
        stringPanic(message);
      },
    };
  }
  result.Output = {
    signature: fn([INT, STRING], [ERROR_TYPE]),
    impl: (logger, [depth, text], row) => output(logger, callerLine(row, Number(depth as bigint)), text as string),
  };
  result.SetOutput = {
    signature: fn([IO_WRITER], []),
    impl: (logger, [writer]) => {
      loggerOf(logger).out = writer;
      return [];
    },
  };
  result.Writer = { signature: fn([], [IO_WRITER]), impl: (logger) => loggerOf(logger).out };
  result.Flags = { signature: fn([], [INT]), impl: (logger) => BigInt(loggerOf(logger).flag) };
  result.SetFlags = {
    signature: fn([INT], []),
    impl: (logger, [flag]) => {
      loggerOf(logger).flag = Number(BigInt.asIntN(32, flag as bigint));
      return [];
    },
  };
  result.Prefix = { signature: fn([], [STRING]), impl: (logger) => loggerOf(logger).prefix };
  result.SetPrefix = {
    signature: fn([STRING], []),
    impl: (logger, [prefix]) => {
      loggerOf(logger).prefix = prefix as string;
      return [];
    },
  };
  return result;
}

/** A library function that receives the row of its call, as the file flags report it. */
function functionWithRow(
  name: string,
  signature: FuncType,
  impl: (args: Value[], callRow: number | undefined) => Value | Value[]
): FuncEntity {
  const value = new GoFunc((args, callRow) => impl(args, callRow));
  return { kind: 'func', name, type: signature, value: () => value, direct: (args, callRow) => impl(args, callRow) };
}

const members: Record<string, Entity> = {
  Logger: typeEntity(LOGGER),
  ...Object.fromEntries(
    Object.entries(FLAGS).map(([name, value]) => [
      name,
      {
        kind: 'const',
        name,
        type: BASIC.untypedInt,
        value: { kind: 'int', value: BigInt(value) },
        span: { row: 0, column: 0 },
        used: true,
      } satisfies Entity,
    ])
  ),
  New: functionWithRow('New', fn([IO_WRITER, STRING, INT], [LOGGER_POINTER]), ([out, prefix, flag]) =>
    newLogger(out, prefix as string, flag as bigint)
  ),
  Default: functionWithRow('Default', fn([], [LOGGER_POINTER]), () => standardLogger()),
};

for (const [name, { signature, impl }] of Object.entries(printingMembers())) {
  addMethod(LOGGER, name, signature, (receiver, args, callRow?: number) => impl(receiver, args, callRow), true);
  members[name] = functionWithRow(name, signature, (args, callRow) => impl(standardLogger(), args, callRow));
}

delete members.Llongfile;

/** The log package, without the flag for full file names, which name a directory of the machine that runs Go. */
export const LOG_PACKAGE = definePackage('log', members, ['Llongfile']);
