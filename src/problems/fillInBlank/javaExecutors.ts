import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

export type JavaExecutionResult =
  | { kind: 'executed'; stdout: string; stderr: string; exitCode: number }
  | { kind: 'compileError'; message: string }
  | { kind: 'timeout' }
  /** The executor itself is broken or busy (network failure, rate limit, missing JDK), so another executor should be tried. */
  | { kind: 'unavailable'; reason: string };

export interface JavaExecutor {
  name: string;
  execute: (program: string, entryClassName: string) => Promise<JavaExecutionResult>;
}

export const DEFAULT_WANDBOX_COMPILE_URL = 'https://wandbox.org/api/compile.json';
export const DEFAULT_WANDBOX_COMPILER = 'openjdk-jdk-22+36';
export const DEFAULT_JAVA_TIMEOUT_MS = 10_000;

const wandboxResponseSchema = z.object({
  status: z.string(),
  signal: z.string().optional(),
  compiler_error: z.string().optional(),
  program_output: z.string().optional(),
  program_error: z.string().optional(),
});

export function createWandboxExecutor(options?: {
  compileUrl?: string;
  compiler?: string;
  timeoutMs?: number;
}): JavaExecutor {
  const compileUrl = options?.compileUrl ?? DEFAULT_WANDBOX_COMPILE_URL;
  const compiler = options?.compiler ?? DEFAULT_WANDBOX_COMPILER;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_JAVA_TIMEOUT_MS * 3;
  return {
    name: 'wandbox',
    async execute(program, entryClassName) {
      let response: Response;
      try {
        response = await fetch(compileUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            compiler,
            code: '',
            codes: [{ file: 'Main.java', code: program }],
            'compiler-option-raw': 'Main.java',
            'runtime-option-raw': entryClassName,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return { kind: 'unavailable', reason: `Failed to call Wandbox: ${String(error)}` };
      }
      if (!response.ok) {
        return { kind: 'unavailable', reason: `Wandbox responded with ${response.status}` };
      }
      const parsed = wandboxResponseSchema.safeParse(await response.json().catch(() => {}));
      if (!parsed.success) {
        return { kind: 'unavailable', reason: 'Wandbox responded with an unexpected body' };
      }
      const { compiler_error, program_error, program_output, signal, status } = parsed.data;
      if (compiler_error) return { kind: 'compileError', message: compiler_error };
      if (signal) return { kind: 'timeout' };
      return { kind: 'executed', stdout: program_output ?? '', stderr: program_error ?? '', exitCode: Number(status) };
    },
  };
}

export function createLocalJvmExecutor(options?: {
  javaCommand?: string;
  timeoutMs?: number;
  maxHeapMb?: number;
}): JavaExecutor {
  const javaCommand =
    options?.javaCommand ?? (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java');
  const timeoutMs = options?.timeoutMs ?? DEFAULT_JAVA_TIMEOUT_MS;
  const maxHeapMb = options?.maxHeapMb ?? 128;
  // The single Fly machine is small, so Java programs are executed one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    name: 'localJvm',
    execute(program, entryClassName) {
      const run = queue.then(() => executeOnLocalJvm(program, entryClassName, javaCommand, timeoutMs, maxHeapMb));
      queue = run.catch(() => {});
      return run;
    },
  };
}

async function executeOnLocalJvm(
  program: string,
  entryClassName: string,
  javaCommand: string,
  timeoutMs: number,
  maxHeapMb: number
): Promise<JavaExecutionResult> {
  const directoryPath = await mkdtemp(path.join(tmpdir(), 'trace-dojo-java-'));
  try {
    const filePath = path.join(directoryPath, `${entryClassName}.java`);
    await writeFile(filePath, program);
    return await new Promise((resolve) => {
      execFile(
        javaCommand,
        [
          `-Xmx${maxHeapMb}m`,
          '-XX:+UseSerialGC',
          '-XX:TieredStopAtLevel=1',
          '-Xshare:auto',
          '-Duser.language=en',
          '-Duser.country=US',
          filePath,
        ],
        { cwd: directoryPath, timeout: timeoutMs, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          if (error && 'code' in error && error.code === 'ENOENT') {
            resolve({ kind: 'unavailable', reason: `Java command not found: ${javaCommand}` });
          } else if (error && 'killed' in error && error.killed) {
            resolve({ kind: 'timeout' });
          } else if (error && !stdout && /\.java:\d+: /.test(stderr)) {
            resolve({ kind: 'compileError', message: stderr });
          } else {
            const exitCode = error && 'code' in error && typeof error.code === 'number' ? error.code : 0;
            resolve({ kind: 'executed', stdout, stderr, exitCode });
          }
        }
      );
    });
  } finally {
    await rm(directoryPath, { recursive: true, force: true });
  }
}
