import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

import { RegExpParser, visitRegExpAST } from '@eslint-community/regexpp';
import { z } from 'zod';

import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import type { RegexpData } from './libRegexp';
import { unitIndex } from './regexpPositions';
import { rt, UnsupportedFeatureError } from './runtime';

const requireFromRoot = createRequire(path.join(process.cwd(), 'package.json'));
const MAX_RESPONSE_BYTES = 64 * 1024;
const wasmPath = requireFromRoot.resolve('@ruby/4.0-wasm-wasi/dist/ruby.wasm');
const bridge = requireFromRoot.resolve('@ruby/wasm-wasi/dist/browser');
const nativePath = requireFromRoot.resolve('./src/ruby/regexpCasefoldProcess.cjs');
const matchSchema = z.union([
  z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).nullable()).nullable(),
  z.enum(['timeout', 'unsupported']),
]);
const batchSchema = z.object({
  from: z.number().int().nonnegative(),
  through: z.number().int().nonnegative(),
  matches: z.array(z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).nullable())),
});
const responseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), id: z.number().int(), result: matchSchema, batch: batchSchema.nullable() }),
  z.object({ status: z.literal('error'), id: z.number().int(), message: z.string() }),
]);
interface NativeProcess {
  child: ChildProcess;
  directory: string;
  sequence: number;
  program: number;
  idle?: ReturnType<typeof setTimeout>;
  error?: Error;
}
let standby: NativeProcess | undefined;
let nextProgram = 0;
const liveProcesses = new Set<NativeProcess>();
const nativeProcesses = new WeakMap<object, NativeProcess>();
const pause = new Int32Array(new SharedArrayBuffer(4));
type NativeRanges = (readonly [number, number] | null)[] | null;
interface NativePattern {
  text: string;
  searches: Map<number, NativeRanges>;
  batch?: z.infer<typeof batchSchema>;
}
const searches = new WeakMap<object, Map<string, Map<string, NativePattern>>>();

export function assertCasefoldParity(
  data: RegexpData,
  text: string,
  start: number,
  result: RegExpExecArray | null,
  anchored: boolean,
  feature = 'Unicode の複数文字 casefold'
): void {
  const pattern = nativePattern(data, text);
  const native = nativeSearch(data, pattern, start);
  const ranges = native && (!anchored || native[0]?.[0] === start) ? native : undefined;
  if (!sameCaptureRanges(ranges, result?.indices, text)) throw new UnsupportedFeatureError(feature);
}

function nativePattern(data: RegexpData, text: string): NativePattern {
  const runtime = rt();
  let sources = searches.get(runtime);
  if (!sources) {
    sources = new Map();
    searches.set(runtime, sources);
  }
  const key = JSON.stringify([data.source, data.ignoreCase, data.extended, data.multiline]);
  let subjects = sources.get(key);
  if (!subjects) {
    assertBoundedPattern(data);
    runtime.chargeSlots(key.length + 1);
    subjects = new Map();
    sources.set(key, subjects);
  }
  let pattern = subjects.get(text);
  if (!pattern) {
    runtime.chargeSlots(text.length + 1);
    pattern = { text, searches: new Map() };
    subjects.set(text, pattern);
  }
  return pattern;
}

export function releaseNativeCasefold(runtime: object): void {
  searches.delete(runtime);
  const state = nativeProcesses.get(runtime);
  if (!state) return;
  nativeProcesses.delete(runtime);
  if (state.error || state.child.exitCode !== null) {
    destroyNativeProcess(state);
    return;
  }
  if (standby) destroyNativeProcess(standby);
  standby = state;
  state.idle = setTimeout(() => destroyNativeProcess(state), 5000);
  state.idle.unref();
}

// code-gauge-allow functionNcss 39 -- The bounded request and its per-run capture cache share one search lifecycle.
function nativeSearch(data: RegexpData, pattern: NativePattern, start: number): NativeRanges {
  const runtime = rt();
  const cached = pattern.searches.get(start);
  if (cached !== undefined) return cached;
  const batch = pattern.batch;
  if (batch && start >= batch.from && start <= batch.through) {
    // oxlint-disable-next-line unicorn/no-null -- A missing native match is represented by null.
    const native = batch.matches.find((ranges) => (ranges[0]?.[0] ?? -1) >= start) ?? null;
    runtime.chargeSlots(1);
    pattern.searches.set(start, native);
    return native;
  }
  const remaining = runtime.budget.remainingMilliseconds;
  if (remaining === 0) throw new ExecutionLimitError('time');
  const deadline = process.hrtime.bigint() + BigInt(remaining) * 1_000_000n;
  const state = nativeProcess(runtime);
  const id = ++state.sequence;
  let response: Extract<z.infer<typeof responseSchema>, { status: 'ok' }>;
  try {
    rmSync(path.join(state.directory, 'response.json'), { force: true });
    writeFileSync(
      path.join(state.directory, 'request.next'),
      JSON.stringify({
        id,
        program: state.program,
        source: data.source,
        text: pattern.text,
        start,
        maxSlots: runtime.remainingSlots,
        maxRanges: MAX_RESPONSE_BYTES / 32,
        flags: (data.ignoreCase ? 1 : 0) | (data.extended ? 2 : 0) | (data.multiline ? 4 : 0),
        timeout: remaining / 1000,
      }),
      { mode: 0o600 }
    );
    renameSync(path.join(state.directory, 'request.next'), path.join(state.directory, `request-${id}.json`));
    response = awaitNativeResult(state, id, deadline);
  } catch (error) {
    nativeProcesses.delete(runtime);
    destroyNativeProcess(state);
    throw error;
  }
  const native = response.result;
  if (native === 'timeout') throw new ExecutionLimitError('time');
  if (native === 'unsupported') throw new UnsupportedFeatureError('Unicode の複数文字 casefold');
  runtime.chargeSlots(1 + (native?.length ?? 0) * 3);
  if (response.batch) {
    runtime.chargeSlots(4 + response.batch.matches.reduce((slots, ranges) => slots + 1 + ranges.length * 3, 0));
    pattern.batch = response.batch;
    runtime.spend(
      response.batch.matches.length + Math.ceil(Math.max(0, response.batch.through - response.batch.from) / 64)
    );
  }
  pattern.searches.set(start, native);
  runtime.spend(Math.ceil(Math.max(1, (native?.[0]?.[1] ?? pattern.text.length) - start) / 64));
  return native;
}

// code-gauge-allow functionNcss 33 -- Claiming a warm lease and creating its replacement share process ownership and cleanup.
function nativeProcess(runtime: object): NativeProcess {
  const existing = nativeProcesses.get(runtime);
  if (existing) return existing;
  if (standby) {
    const state = standby;
    standby = undefined;
    clearTimeout(state.idle);
    state.idle = undefined;
    if (!state.error && state.child.exitCode === null) {
      state.program = ++nextProgram;
      nativeProcesses.set(runtime, state);
      return state;
    }
    destroyNativeProcess(state);
  }
  const root = path.join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, 'ruby-native-'));
  try {
    writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ wasm: wasmPath, bridge }), { mode: 0o600 });
    const child = spawn(process.execPath, [nativePath, directory], { stdio: ['pipe', 'ignore', 'ignore'] });
    const state: NativeProcess = { child, directory, sequence: 0, program: ++nextProgram };
    if (liveProcesses.size === 0) process.once('exit', cleanupNativeProcesses);
    liveProcesses.add(state);
    child.on('error', (error) => {
      state.error = error;
    });
    child.unref();
    if (child.stdin instanceof Socket) child.stdin.unref();
    nativeProcesses.set(runtime, state);
    return state;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

// code-gauge-allow functionCognitiveComplexity 19 -- One polling loop checks the hard deadline, process errors and validated atomic responses.
function awaitNativeResult(
  state: NativeProcess,
  id: number,
  deadline: bigint
): Extract<z.infer<typeof responseSchema>, { status: 'ok' }> {
  const responsePath = path.join(state.directory, 'response.json');
  while (true) {
    const remaining = Math.min(
      rt().budget.remainingMilliseconds,
      Number(deadline - process.hrtime.bigint()) / 1_000_000
    );
    if (remaining <= 0) throw new ExecutionLimitError('time');
    if (state.error) throw state.error;
    const fatalPath = path.join(state.directory, 'fatal.json');
    if (existsSync(fatalPath)) {
      const error = z.object({ message: z.string() }).parse(JSON.parse(readFileSync(fatalPath, 'utf8')));
      throw new Error(error.message);
    }
    if (existsSync(responsePath)) {
      if (statSync(responsePath).size > MAX_RESPONSE_BYTES)
        throw new Error('Native regexp result exceeds its capture bound');
      const response = responseSchema.parse(JSON.parse(readFileSync(responsePath, 'utf8')));
      if (response.id === id) {
        if (response.status === 'error') throw new Error(response.message);
        return response;
      }
    }
    Atomics.wait(pause, 0, 0, Math.min(remaining, 1));
  }
}

function cleanupNativeProcesses(): void {
  for (const state of liveProcesses) destroyNativeProcess(state);
}

function destroyNativeProcess(state: NativeProcess): void {
  if (standby === state) standby = undefined;
  clearTimeout(state.idle);
  state.child.kill('SIGKILL');
  rmSync(state.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 1 });
  liveProcesses.delete(state);
  if (liveProcesses.size === 0) process.off('exit', cleanupNativeProcesses);
}

function sameCaptureRanges(
  ranges: readonly (readonly [number, number] | null)[] | undefined,
  actual: RegExpExecArray['indices'],
  text: string
): boolean {
  if (!ranges) return actual === undefined;
  if (!actual || ranges.length !== actual.length) return false;
  return ranges.every((range, index) =>
    range
      ? actual[index]?.[0] === unitIndex(text, range[0]) && actual[index]?.[1] === unitIndex(text, range[1])
      : actual[index] === undefined
  );
}

// The bundled 4.0.0 compiler lacks the 4.0.9 overflow guards, so bound syntax and repeat counts before calling it.
function assertBoundedPattern(data: RegexpData): void {
  if (data.source.length > LIMITS.maxCallDepth) throw new UnsupportedFeatureError('Unicode の複数文字 casefold');
  const ast = new RegExpParser().parsePattern(data.js.source, 0, data.js.source.length, { unicode: true });
  visitRegExpAST(ast, {
    onQuantifierEnter(node) {
      if (node.min > LIMITS.maxCallDepth || (Number.isFinite(node.max) && node.max > LIMITS.maxCallDepth))
        throw new UnsupportedFeatureError('Unicode の複数文字 casefold');
    },
  });
}
