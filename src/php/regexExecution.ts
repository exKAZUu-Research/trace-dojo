import { MessageChannel, type MessagePort, receiveMessageOnPort, Worker } from 'node:worker_threads';

import { z } from 'zod';

import { type ExecutionBudget, ExecutionLimitError } from '../interpreter/limits';
import { PCRE_WORKER_SOURCE } from './pcreWorker';
import { UnsupportedFeatureError } from './unsupported';

export interface MatchOffsets {
  range: [number, number];
  groups?: Record<string, [number, number] | undefined>;
}
export interface PcrePattern {
  source: string;
  options: number;
  restrictCaseless: boolean;
}

const batchResponse = z.union([
  z.object({
    offsets: z.instanceof(Int32Array),
    nextPosition: z.number().int().nonnegative(),
    nextRetry: z.boolean(),
    done: z.boolean(),
    noEmptyRemaining: z.number().int().nonnegative(),
    lastEnd: z.number().int().nonnegative(),
    pregError: z.number().int().min(1).max(6).optional(),
  }),
  z.literal('unsupported'),
]);

interface RegexWorker {
  worker: Worker;
  port: MessagePort;
  signal: Int32Array;
  /** Set by the worker once it has handled `stop`, which a synchronous caller sees without an event-loop turn. */
  stopped: Int32Array;
  subject?: string;
}

const BATCH_SIZES = [1, 64, 512, 2048] as const;

let active: RegexWorker | undefined;
const stoppingWorkers = new Map<Worker, Int32Array>();
const MAX_STOPPING_WORKERS = 2;

export interface BoundedScanOptions {
  pattern: PcrePattern;
  text: string;
  startPosition: number;
  utf8: boolean;
  budget: ExecutionBudget;
  maxMatches?: number;
  batchBudgetMs?: number;
  noEmptyLimit?: number;
}

export function createBoundedRegexScanner({
  pattern,
  text,
  startPosition,
  utf8,
  budget,
  maxMatches = Infinity,
  batchBudgetMs = 0,
  noEmptyLimit = 0,
}: BoundedScanOptions): () => MatchOffsets | { pregError: number } | undefined {
  let batch: Exclude<z.infer<typeof batchResponse>, 'unsupported'> = {
    offsets: new Int32Array(0),
    nextPosition: startPosition,
    nextRetry: false,
    done: false,
    noEmptyRemaining: noEmptyLimit,
    lastEnd: 0,
  };
  let cursor = 0;
  let batchIndex = 0;
  let remaining = maxMatches;

  return () => {
    for (;;) {
      if (cursor < batch.offsets.length) {
        remaining--;
        return decodeMatch(() => batch.offsets[cursor++]);
      }
      if (batch.pregError !== undefined) {
        const error = batch.pregError;
        batch.pregError = undefined;
        return { pregError: error };
      }
      if (batch.done || remaining <= 0) return;
      const limit = Math.min(BATCH_SIZES[Math.min(batchIndex++, BATCH_SIZES.length - 1)], remaining);
      batch = boundedRegexBatch({
        pattern,
        text,
        position: batch.nextPosition,
        retry: batch.nextRetry,
        utf8,
        limit,
        batchBudgetMs,
        noEmptyRemaining: batch.noEmptyRemaining,
        lastEnd: batch.lastEnd,
        budget,
      });
      cursor = 0;
    }
  };
}

function decodeMatch(next: () => number): MatchOffsets {
  const count = next();
  const start = next();
  const end = next();
  let groups: Record<string, [number, number] | undefined> | undefined;
  for (let group = 1; group < count; group++) {
    const gs = next();
    const ge = next();
    if (gs >= 0) (groups ??= {})[`$${group}`] = [gs, ge];
  }
  return { range: [start, end], groups };
}

interface BatchRequest {
  pattern: PcrePattern;
  text: string;
  position: number;
  retry: boolean;
  utf8: boolean;
  limit: number;
  batchBudgetMs: number;
  noEmptyRemaining: number;
  lastEnd: number;
  budget: ExecutionBudget;
}

function boundedRegexBatch({
  pattern,
  text,
  position,
  retry,
  utf8,
  limit,
  batchBudgetMs,
  noEmptyRemaining,
  lastEnd,
  budget,
}: BatchRequest): Exclude<z.infer<typeof batchResponse>, 'unsupported'> {
  if (budget.remainingMilliseconds === 0) throw new ExecutionLimitError('time');
  const state = active ?? startWorker(budget.remainingMilliseconds);
  Atomics.store(state.signal, 0, 0);
  state.port.postMessage({
    pattern,
    position,
    retry,
    utf8,
    limit,
    batchBudgetMs,
    noEmptyRemaining,
    lastEnd,
    subject: state.subject === text ? undefined : text,
    signal: state.signal,
  });
  state.subject = text;
  if (Atomics.wait(state.signal, 0, 0, budget.remainingMilliseconds) === 'timed-out') {
    stopWorker(state);
    throw new ExecutionLimitError('time');
  }
  const result = batchResponse.safeParse(receiveMessageOnPort(state.port)?.message);
  if (!result.success) {
    stopWorker(state);
    throw new Error('Regex worker returned invalid offsets');
  }
  budget.checkClock();
  if (result.data === 'unsupported') throw new UnsupportedFeatureError('ホストエンジンの制限を超える正規表現');
  return result.data;
}

export function releaseBoundedRegexSubject(): void {
  const state = active;
  if (!state || state.subject === undefined) return;
  state.subject = undefined;
  state.port.postMessage({ reset: true });
}

function stopWorker(state: RegexWorker): void {
  if (stoppingWorkers.has(state.worker)) return;
  if (active === state) active = undefined;
  stoppingWorkers.set(state.worker, state.stopped);
  state.port.postMessage({ stop: true });
  state.port.close();
}

function startWorker(remainingMilliseconds: number): RegexWorker {
  for (const [worker, stopped] of stoppingWorkers) if (Atomics.load(stopped, 0) === 1) stoppingWorkers.delete(worker);
  const [oldest, stopped] = stoppingWorkers.entries().next().value ?? [];
  if (oldest && stopped && stoppingWorkers.size >= MAX_STOPPING_WORKERS) {
    if (Atomics.wait(stopped, 0, 0, remainingMilliseconds) === 'timed-out') throw new ExecutionLimitError('time');
    stoppingWorkers.delete(oldest);
  }
  const stoppedFlag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const { port1, port2 } = new MessageChannel();
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { port: port2, stopped: stoppedFlag },
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: 48 },
    });
  } catch (error) {
    port1.close();
    port2.close();
    throw error;
  }
  const state: RegexWorker = {
    worker,
    port: port1,
    signal: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    stopped: stoppedFlag,
  };
  worker.on('error', () => {
    stopWorker(state);
  });
  worker.once('exit', () => {
    stoppingWorkers.delete(worker);
    port1.close();
    if (active === state) active = undefined;
  });
  port1.unref();
  worker.unref();
  active = state;
  return state;
}

const WORKER_SOURCE = `
const { workerData: { port, stopped } } = require('node:worker_threads');
${PCRE_WORKER_SOURCE}
let text = Buffer.alloc(0);
port.on('message', ({ pattern, position, retry, utf8, limit, batchBudgetMs, noEmptyRemaining, lastEnd, subject, signal, reset, stop }) => {
  if (stop) {
    disposePcre();
    port.close();
    Atomics.store(stopped, 0, 1);
    Atomics.notify(stopped, 0);
    return;
  }
  if (reset) {
    text = Buffer.alloc(0);
    return;
  }
  if (subject !== undefined) text = Buffer.from(subject, 'latin1');
  try {
    port.postMessage(matchPcreBatch(pattern, text, position, retry, utf8, limit, batchBudgetMs, noEmptyRemaining, lastEnd));
  } catch {
    port.postMessage(undefined);
  } finally {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  }
});
`;
