import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { ExecutionLimitError } from '../interpreter/limits';
import type { ProgramExecution, ProgramRecording } from '../interpreter/program';
import type { ProgramInput } from '../interpreter/programIo';
import type { TraceOptions } from '../interpreter/traceAnnotations';

const limitKindSchema = z.enum(['operations', 'time', 'output', 'storage', 'trace']);

const serializedResultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), limit: limitKindSchema }),
]);

const LARGE_STACK_ENV = 'PHP_LARGE_STACK';
const REMAINING_MS_ENV = 'PHP_REMAINING_MS';

const HELPER_SOURCE = `
import fs from 'node:fs';
const encodeValue = (v) => {
  if (typeof v === 'bigint') return { __t: 'b', v: v.toString() };
  if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0)))
    return { __t: 'n', v: Object.is(v, -0) ? '-0' : String(v) };
  if (v instanceof Uint8Array) return { __t: 'u', v: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(encodeValue);
  if (v !== null && typeof v === 'object') {
    // fromEntries defines own properties, so a key named __proto__ stays a key instead of setting the prototype.
    const out = Object.fromEntries(
      Object.entries(v).filter(([, item]) => item !== undefined).map(([k, item]) => [k, encodeValue(item)])
    );
    return Object.hasOwn(v, '__t') ? { __t: 'o', v: out } : out;
  }
  return v;
};
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
const mod = await import(payload.entryPath);
try {
  const result = payload.mode === 'trace'
    ? mod.tracePhpProgram(payload.source, { atomicAnnotations: new Map(payload.atomicAnnotations) }, payload.input)
    : mod.executePhpProgram(payload.source, payload.input);
  process.stdout.write(JSON.stringify({ ok: true, value: encodeValue(result) }));
} catch (error) {
  if (error && typeof error === 'object' && error.name === 'ExecutionLimitError' && typeof error.limit === 'string') {
    process.stdout.write(JSON.stringify({ ok: false, limit: error.limit }));
  } else {
    throw error;
  }
}
`;

export function runExecuteOnLargeStack(
  source: string,
  remainingMs: number,
  input?: ProgramInput
): ProgramExecution | undefined {
  return runOnLargeStack<ProgramExecution>('run.ts', { mode: 'execute', source, input }, remainingMs);
}

export function runTraceOnLargeStack(
  program: string,
  trace: TraceOptions,
  remainingMs: number,
  input?: ProgramInput
): ProgramRecording | undefined {
  return runOnLargeStack<ProgramRecording>(
    'trace.ts',
    { mode: 'trace', source: program, atomicAnnotations: [...trace.atomicAnnotations.entries()], input },
    remainingMs
  );
}

function runOnLargeStack<T>(entryFile: string, payload: Record<string, unknown>, remainingMs: number): T | undefined {
  if (process.env[LARGE_STACK_ENV] === '1') return undefined;
  const timeout = Math.floor(remainingMs);
  if (timeout <= 0) throw new ExecutionLimitError('time');
  try {
    const entryPath = path.resolve(process.cwd(), 'src', 'php', entryFile);
    if (!fs.existsSync(entryPath)) return undefined;
    const completed = spawnSync('bun', ['-e', HELPER_SOURCE], {
      input: JSON.stringify({ ...payload, entryPath }),
      encoding: 'utf8',
      env: { ...process.env, [LARGE_STACK_ENV]: '1', [REMAINING_MS_ENV]: String(timeout) },
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    });
    if ((completed.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT')
      throw new ExecutionLimitError('time');
    if (completed.status !== 0 || !completed.stdout) return undefined;
    const parsed = serializedResultSchema.safeParse(JSON.parse(completed.stdout));
    if (!parsed.success) return undefined;
    if (!parsed.data.ok) throw new ExecutionLimitError(parsed.data.limit);
    return decodeValue(parsed.data.value) as T;
  } catch (error) {
    if (error instanceof ExecutionLimitError) throw error;
    return undefined;
  }
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  switch (record.__t) {
    case 'b': {
      return BigInt(record.v as string);
    }
    case 'n': {
      return record.v === '-0' ? -0 : Number(record.v);
    }
    case 'u': {
      return new Uint8Array(Buffer.from(record.v as string, 'base64'));
    }
    case 'o': {
      return decodeObject(record.v as object);
    }
    default: {
      return decodeObject(record);
    }
  }
}

function decodeObject(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeValue(item)]));
}
