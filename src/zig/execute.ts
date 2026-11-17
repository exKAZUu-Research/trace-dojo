import { CompileError } from '../interpreter/diagnostics';
import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRun } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import { type CompiledProgram, compileSource } from './compiler';
import { ExitSignal, processInit } from './library/std';
import { withMemoryAccounting } from './memoryAccounting';
import { MemoryFault } from './memoryFault';
import { Frame, OutOfMemory, Runtime, StackOverflow, ZigPanic } from './runtime';
import { ErrorValue } from './values';

export function executeZigProgram(source: string, input?: ProgramInput): ProgramExecution {
  let compiled: CompiledProgram;
  try {
    compiled = compileSource(source);
  } catch (error) {
    if (error instanceof CompileError) return { kind: 'compileError', diagnostics: error.diagnostics };
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
  try {
    return { kind: 'executed', ...runProgram(new Runtime(input), compiled) };
  } catch (error) {
    if (error instanceof ExecutionLimitError) return { kind: 'limitExceeded', limit: error.limit };
    throw error;
  }
}

/**
 * Runs `main` to its end, to an error it returns, or to a panic.
 *
 * @param onEnd Receives `main`'s frame when it returns, while the frame still holds its variables.
 */
export function runProgram(runtime: Runtime, program: CompiledProgram, onEnd?: (frame: Frame) => void): ProgramRun {
  runtime.bufferMemory = program.bufferMemory;
  return withMemoryAccounting(
    {
      space: program.bufferMemory,
      spend: (cost) => runtime.spend(cost),
      reserve: (count) => runtime.reserveStorage(count),
    },
    () => executeMain(runtime, program, onEnd)
  );
}

function executeMain(runtime: Runtime, program: CompiledProgram, onEnd?: (frame: Frame) => void): ProgramRun {
  for (const global of program.globals) runtime.globals.push(global);
  const { main } = program;
  let uncaughtException: string | undefined;
  try {
    const body = main.body;
    if (!body) throw new Error('main is not compiled');
    const frame = new Frame(runtime, main, undefined, main.slotCount);
    if (program.mainTakesInit) frame.slots[main.paramSlots[0]] = processInit();
    runtime.pushFrame(frame);
    let result;
    try {
      result = body(frame);
    } finally {
      try {
        onEnd?.(frame);
        runtime.collectGarbage();
      } finally {
        runtime.popFrame();
      }
    }
    if (result instanceof ErrorValue) uncaughtException = `error: ${result.name}`;
  } catch (error) {
    uncaughtException = describeUncaught(error);
  }
  runtime.finishOutput();
  return {
    finalBoard: runtime.world.boardText(),
    finalTurtles: runtime.world.turtleTraces(),
    uncaughtException,
    ...runtime.io.output(),
  };
}

function describeUncaught(error: unknown): string | undefined {
  if (error instanceof MemoryFault) return 'Segmentation fault';
  if (error instanceof ExitSignal) return undefined;
  if (error instanceof ZigPanic) return `panic: ${error.text}`;
  if (error instanceof OutOfMemory) return 'error: OutOfMemory';
  // Zig's guard page makes deep recursion crash, whose address differs on every run.
  if (error instanceof StackOverflow || (error instanceof RangeError && /call stack/i.test(error.message))) {
    return 'Segmentation fault';
  }
  throw error;
}
