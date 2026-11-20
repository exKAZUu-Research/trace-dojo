import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { ProgramExecution, ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';

const serializedResultSchema = z.object({
  value: z.record(z.string(), z.unknown()),
  stdoutBytesBase64: z.string().optional(),
});

const LARGE_STACK_ENV = 'PHP_LARGE_STACK';

const HELPER_SOURCE = `
import fs from 'node:fs';
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const mod = await import(payload.entryPath);
const result = payload.mode === 'trace'
  ? mod.tracePhpProgram(payload.source, { atomicAnnotations: new Map(payload.atomicAnnotations) }, payload.input)
  : mod.executePhpProgram(payload.source, payload.input);
const stdoutBytesBase64 = result.stdoutBytes instanceof Uint8Array
  ? Buffer.from(result.stdoutBytes).toString('base64')
  : undefined;
const value = { ...result };
delete value.stdoutBytes;
process.stdout.write(JSON.stringify({ value, stdoutBytesBase64 }));
`;

export function runExecuteOnLargeStack(source: string, input?: ProgramInput): ProgramExecution | undefined {
  return runOnLargeStack<ProgramExecution>({
    mode: 'execute',
    entryPath: fileURLToPath(new URL('run.ts', import.meta.url)),
    source,
    input,
  });
}

export function runTraceOnLargeStack(
  program: string,
  trace: TraceOptions,
  input?: ProgramInput
): ProgramRecording | undefined {
  return runOnLargeStack<ProgramRecording>({
    mode: 'trace',
    entryPath: fileURLToPath(new URL('trace.ts', import.meta.url)),
    source: program,
    atomicAnnotations: [...trace.atomicAnnotations.entries()],
    input,
  });
}

function runOnLargeStack<T>(payload: Record<string, unknown>): T | undefined {
  if (process.env[LARGE_STACK_ENV] === '1') return undefined;
  const completed = spawnSync('bun', ['-e', HELPER_SOURCE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, [LARGE_STACK_ENV]: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (completed.status !== 0 || !completed.stdout) return undefined;
  const parsed = serializedResultSchema.safeParse(JSON.parse(completed.stdout));
  if (!parsed.success) return undefined;
  const value = { ...parsed.data.value };
  if (parsed.data.stdoutBytesBase64 !== undefined) {
    value.stdoutBytes = new Uint8Array(Buffer.from(parsed.data.stdoutBytesBase64, 'base64'));
  }
  return value as T;
}
