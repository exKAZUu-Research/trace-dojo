import { MessageChannel, type MessagePort, receiveMessageOnPort, Worker } from 'node:worker_threads';

import { z } from 'zod';

import { type ExecutionBudget, ExecutionLimitError } from '../interpreter/limits';
import { PCRE_WORKER_SOURCE } from './pcreWorker';
import { UnsupportedFeatureError } from './unsupported';

const range = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
const matchOffsets = z.object({ range, groups: z.record(z.string(), range.optional()).optional() });
const response = z.union([
  matchOffsets,
  z.object({ pregError: z.number().int().min(1).max(6) }),
  z.null(),
  z.literal('unsupported'),
]);
export type MatchOffsets = z.infer<typeof matchOffsets>;
export interface PcrePattern {
  source: string;
  options: number;
  restrictCaseless: boolean;
}

interface RegexWorker {
  worker: Worker;
  port: MessagePort;
  subject?: string;
}

let active: RegexWorker | undefined;
const stoppingWorkers = new Set<Worker>();
const MAX_STOPPING_WORKERS = 2;

export function boundedRegexMatch(
  pattern: PcrePattern,
  text: string,
  position: number,
  retry: boolean,
  budget: ExecutionBudget
): MatchOffsets | { pregError: number } | null {
  if (budget.remainingMilliseconds === 0) throw new ExecutionLimitError('time');
  const state = active ?? startWorker();
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  state.port.postMessage({
    pattern,
    position,
    retry,
    subject: state.subject === text ? undefined : text,
    signal,
  });
  state.subject = text;
  if (Atomics.wait(signal, 0, 0, budget.remainingMilliseconds) === 'timed-out') {
    stopWorker(state);
    throw new ExecutionLimitError('time');
  }
  const result = response.safeParse(receiveMessageOnPort(state.port)?.message);
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
  stoppingWorkers.add(state.worker);
  state.port.postMessage({ stop: true });
  state.port.close();
}

function startWorker(): RegexWorker {
  if (stoppingWorkers.size >= MAX_STOPPING_WORKERS) throw new ExecutionLimitError('time');
  const { port1, port2 } = new MessageChannel();
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: port2,
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: 48 },
    });
  } catch (error) {
    port1.close();
    port2.close();
    throw error;
  }
  const state: RegexWorker = { worker, port: port1 };
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
const { workerData: port } = require('node:worker_threads');
${PCRE_WORKER_SOURCE}
let text = Buffer.alloc(0);
port.on('message', ({ pattern, position, retry, subject, signal, reset, stop }) => {
  if (stop) {
    port.close();
    return;
  }
  if (reset) {
    text = Buffer.alloc(0);
    return;
  }
  if (subject !== undefined) text = Buffer.from(subject, 'latin1');
  try {
    port.postMessage(matchPcre(pattern, text, position, retry));
  } catch {
    port.postMessage(undefined);
  } finally {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  }
});
`;
