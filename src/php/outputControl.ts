// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { callValue, consumeInvokedResult } from './callables';
import { callStack } from './calls';
import { deprecated, notice } from './errors';
import { toStr } from './operators';
import { FatalError, PhpThrow, type Runtime, setOutputBuffering } from './runtime';
import type { Value } from './values';

// This module follows PHP's main/output.c, whose buffer stack decides when handlers run and where their output goes.

export const OUTPUT_WRITE = 0;
export const OUTPUT_START = 1;
export const OUTPUT_CLEAN = 2;
export const OUTPUT_FLUSH = 4;
export const OUTPUT_FINAL = 8;

const HANDLER_USER = 0x1;
export const HANDLER_CLEANABLE = 0x10;
export const HANDLER_FLUSHABLE = 0x20;
export const HANDLER_REMOVABLE = 0x40;
export const HANDLER_STDFLAGS = 0x70;
export const HANDLER_STARTED = 0x10_00;
export const HANDLER_DISABLED = 0x20_00;
export const HANDLER_PROCESSED = 0x40_00;
const HANDLER_PRODUCED_OUTPUT = 0x80_00;

const DEFAULT_BUFFER_SIZE = 0x40_00;
const BUFFER_ALIGNMENT = 0x10_00;

/** An output buffer `ob_start` opened. */
export interface OutputBuffer {
  name: string;
  /** The user handler, or undefined for PHP's default output handler, which passes the output along. */
  handler: Value | undefined;
  chunkSize: number;
  flags: number;
  level: number;
  data: string;
  /** The bytes PHP has allocated for the buffer, which `ob_get_status` reports. */
  allocated: number;
}

type Status = 'failure' | 'no-data' | 'success';

interface Context {
  op: number;
  input: string;
  output: string;
}

/** The exception an output handler threw, which PHP raises once the output operation that ran the handler ends. */
let pendingThrow: PhpThrow | undefined;
/** Whether the buffers are closing at the end of the program, when PHP ends with a fatal error if a handler throws. */
let closing = false;

/** Raised when an output handler throws while the buffers close at the end of the program. */
class ClosingFailure {
  constructor(readonly exception: PhpThrow) {}
}

setOutputBuffering((runtime, bytes) => runOperation(() => outputOp(runtime, OUTPUT_WRITE, bytes)));

/** Runs an operation that may call output handlers, then raises the exception one of them threw. */
export function runOperation<T>(operation: () => T): T {
  const outer = pendingThrow;
  pendingThrow = undefined;
  let thrown: PhpThrow | undefined;
  let result: T;
  try {
    result = operation();
  } finally {
    thrown = pendingThrow;
    pendingThrow = outer;
  }
  if (thrown) throw thrown;
  return result;
}

/** The function PHP names in its messages about output handlers: the innermost one running. */
function activeFunctionName(): string {
  const record = callStack.at(-1);
  if (!record) return 'main';
  return record.className ? `${record.className}::${record.name}` : record.name;
}

export function startBuffer(
  runtime: Runtime,
  name: string,
  handler: Value | undefined,
  chunkSize: number,
  flags: number
): void {
  checkLock(runtime, OUTPUT_START);
  const buffer: OutputBuffer = {
    name,
    handler,
    chunkSize,
    flags: (flags & 0xf0) | (handler === undefined ? 0 : HANDLER_USER),
    level: runtime.outputBuffers.length,
    data: '',
    allocated: initialSize(chunkSize),
  };
  runtime.outputBuffers.push(buffer);
}

function initialSize(size: number): number {
  return size > 1 ? size + BUFFER_ALIGNMENT - (size % BUFFER_ALIGNMENT) : DEFAULT_BUFFER_SIZE;
}

/** Ends PHP's fatal error for output buffering started or ended inside an output handler. */
function checkLock(runtime: Runtime, op: number): void {
  if (op === 0 || runtime.outputBuffers.length === 0 || !runtime.runningOutputBuffer) return;
  runtime.outputBuffers.length = 0;
  runtime.runningOutputBuffer = undefined;
  throw new FatalError(
    `${activeFunctionName()}(): Cannot use output buffering in output buffering display handlers`,
    runtime.row
  );
}

function outputOp(runtime: Runtime, op: number, bytes: string): void {
  const buffers = runtime.outputBuffers;
  const context: Context = { op, input: '', output: '' };
  if (buffers.length > 1) {
    context.input = bytes;
    for (let index = buffers.length - 1; index >= 0; index--) if (applyOp(runtime, buffers[index], context)) break;
  } else if (buffers.length === 1) {
    context.input = bytes;
    if ((buffers[0].flags & HANDLER_DISABLED) === 0) handlerOp(runtime, buffers[0], context);
    else pass(context);
  } else context.output = bytes;
  runtime.writeStdout(context.output);
}

/** Applies an operation to one buffer of the stack; true stops passing it down. */
function applyOp(runtime: Runtime, buffer: OutputBuffer, context: Context): boolean {
  const wasDisabled = (buffer.flags & HANDLER_DISABLED) !== 0;
  const status = wasDisabled ? 'failure' : handlerOp(runtime, buffer, context);
  if (status === 'no-data') return true;
  if (status === 'failure' && wasDisabled) {
    if (buffer.level === 0) pass(context);
  } else if (buffer.level > 0) swap(context);
  return false;
}

function pass(context: Context): void {
  context.output = context.input;
  context.input = '';
}

function swap(context: Context): void {
  context.input = context.output;
  context.output = '';
}

// code-gauge-allow functionCognitiveComplexity -- Follows php_output_handler_op, whose ordered cases decide where the output goes.
function handlerOp(runtime: Runtime, buffer: OutputBuffer, context: Context): Status {
  const originalOp = context.op;
  if ((buffer.flags & HANDLER_DISABLED) !== 0) return 'failure';
  checkLock(runtime, context.op);
  if (context.op === OUTPUT_WRITE && runtime.runningOutputBuffer) buffer.flags |= HANDLER_PRODUCED_OUTPUT;
  if (append(runtime, buffer, context.input) && context.op === OUTPUT_WRITE) return 'no-data';
  if ((buffer.flags & HANDLER_STARTED) === 0) context.op |= OUTPUT_START;
  runtime.runningOutputBuffer = buffer;
  let status: Status;
  let stillOpen = true;
  try {
    if (buffer.handler === undefined) {
      context.output = buffer.data;
      status = context.output ? 'success' : 'no-data';
    } else {
      const result = callHandler(buffer.handler, buffer.data, context.op);
      if (result === undefined) status = 'failure';
      else {
        if ((buffer.flags & HANDLER_PRODUCED_OUTPUT) !== 0) {
          buffer.flags |= HANDLER_DISABLED;
          buffer.flags &= ~HANDLER_PRODUCED_OUTPUT;
          deprecated(
            `${activeFunctionName()}(): Producing output from user output handler ${buffer.name} is deprecated`
          );
          stillOpen = runtime.outputBuffers.includes(buffer);
          if (stillOpen) buffer.flags &= ~HANDLER_DISABLED;
        }
        status = result === false ? 'failure' : 'no-data';
        if (typeof result === 'string' && result) {
          context.output = result;
          status = 'success';
        }
      }
    }
    if (stillOpen) buffer.flags |= HANDLER_STARTED;
  } finally {
    runtime.runningOutputBuffer = undefined;
  }
  if (!stillOpen) return status;
  if (status === 'failure') {
    buffer.flags |= HANDLER_DISABLED;
    context.output = buffer.data;
    buffer.data = '';
    buffer.allocated = 0;
  } else {
    if (status === 'no-data') {
      context.input = '';
      context.output = '';
    }
    buffer.data = '';
    buffer.flags |= HANDLER_PROCESSED;
  }
  context.op = originalOp;
  return status;
}

/**
 * Calls a user output handler, returning what it returned as a string or boolean, or undefined when the call failed.
 */
function callHandler(handler: Value, data: string, op: number): string | boolean | undefined {
  if (pendingThrow) return undefined;
  try {
    return consumeInvokedResult(
      () => callValue(handler, [{ v: data }, { v: BigInt(op) }], undefined),
      (value) => (typeof value === 'boolean' ? value : toStr(value))
    );
  } catch (error) {
    if (!(error instanceof PhpThrow)) throw error;
    if (closing) throw new ClosingFailure(error);
    pendingThrow = error;
    return undefined;
  }
}

/** Stores output in a buffer; false when the buffer reached its chunk size, so that its handler must run. */
function append(runtime: Runtime, buffer: OutputBuffer, bytes: string): boolean {
  if (bytes.length === 0) return true;
  if (buffer.allocated - buffer.data.length <= bytes.length)
    buffer.allocated += Math.max(
      initialSize(buffer.chunkSize),
      initialSize(bytes.length - (buffer.allocated - buffer.data.length))
    );
  runtime.ensureStringFits(buffer.data.length + bytes.length);
  buffer.data += bytes;
  if (buffer.chunkSize > 0 && buffer.data.length >= buffer.chunkSize) return runtime.runningOutputBuffer !== undefined;
  return true;
}

/** Flushes the innermost buffer to the one below it, as `ob_flush` does; false when it cannot be flushed. */
export function flushBuffer(runtime: Runtime): boolean {
  const buffer = runtime.outputBuffers.at(-1);
  if (!buffer || (buffer.flags & HANDLER_FLUSHABLE) === 0) return false;
  const context: Context = { op: OUTPUT_FLUSH, input: '', output: '' };
  handlerOp(runtime, buffer, context);
  if (context.output) {
    runtime.outputBuffers.pop();
    outputOp(runtime, OUTPUT_WRITE, context.output);
    runtime.outputBuffers.push(buffer);
  }
  return true;
}

/** Discards the innermost buffer's contents, as `ob_clean` does; false when it cannot be cleaned. */
export function cleanBuffer(runtime: Runtime): boolean {
  const buffer = runtime.outputBuffers.at(-1);
  if (!buffer || (buffer.flags & HANDLER_CLEANABLE) === 0) return false;
  handlerOp(runtime, buffer, { op: OUTPUT_CLEAN, input: '', output: '' });
  return true;
}

/**
 * Closes the innermost buffer, passing its output down unless `discard`, as `ob_end_flush` and `ob_end_clean` do;
 * false with PHP's notice when there is none or it cannot be removed.
 */
export function popBuffer(
  runtime: Runtime,
  options: { discard: boolean; force?: boolean; functionName?: string }
): boolean {
  const buffer = runtime.outputBuffers.at(-1);
  const verb = options.discard ? 'discard' : 'send';
  if (!buffer) {
    if (options.functionName) notice(`${options.functionName}(): Failed to ${verb} buffer. No buffer to ${verb}`);
    return false;
  }
  if (!options.force && (buffer.flags & HANDLER_REMOVABLE) === 0) {
    if (options.functionName)
      notice(`${options.functionName}(): Failed to ${verb} buffer of ${buffer.name} (${buffer.level})`);
    return false;
  }
  const context: Context = { op: OUTPUT_FINAL, input: '', output: '' };
  if ((buffer.flags & HANDLER_DISABLED) === 0) {
    if ((buffer.flags & HANDLER_STARTED) === 0) context.op |= OUTPUT_START;
    if (options.discard) context.op |= OUTPUT_CLEAN;
    handlerOp(runtime, buffer, context);
  }
  const index = runtime.outputBuffers.lastIndexOf(buffer);
  if (index !== -1) runtime.outputBuffers.splice(index, 1);
  if (context.output && !options.discard) outputOp(runtime, OUTPUT_WRITE, context.output);
  if (buffer.handler !== undefined) {
    const handler = buffer.handler;
    buffer.handler = null;
    runtime.releaseCallResult(handler);
  }
  return true;
}

/**
 * Closes every buffer at the end of the program, passing its output down. An exception from a handler ends PHP's
 * shutdown with a fatal error printed into the buffers it then discards, so it is returned without being printed.
 */
export function endAllBuffers(runtime: Runtime): PhpThrow | undefined {
  closing = true;
  try {
    while (runtime.outputBuffers.length > 0) popBuffer(runtime, { discard: false, force: true });
    return undefined;
  } catch (error) {
    if (!(error instanceof ClosingFailure)) throw error;
    runtime.outputBuffers.length = 0;
    return error.exception;
  } finally {
    closing = false;
  }
}

/** The status `ob_get_status` reports for a buffer. */
export function bufferStatus(buffer: OutputBuffer): [string, Value][] {
  return [
    ['name', buffer.name],
    ['type', BigInt(buffer.flags & 0xf)],
    ['flags', BigInt(buffer.flags)],
    ['level', BigInt(buffer.level)],
    ['chunk_size', BigInt(buffer.chunkSize)],
    ['buffer_size', BigInt(buffer.allocated)],
    ['buffer_used', BigInt(buffer.data.length)],
  ];
}
