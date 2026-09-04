import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { extractPublicClassName } from './javaProgram';

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

export const DEFAULT_MAX_PENDING_LOCAL_EXECUTIONS = 5;

export interface LocalJvmExecutorOptions {
  /** Directory containing `bin/javac` and `bin/java`. Defaults to `JAVA_HOME`, else the commands on `PATH`. */
  javaHome?: string;
  timeoutMs?: number;
  maxHeapMb?: number;
  /** Executions beyond this queue length are reported as unavailable instead of waiting. */
  maxPendingExecutions?: number;
}

export function createLocalJvmExecutor(options?: LocalJvmExecutorOptions): JavaExecutor {
  const javaHome = options?.javaHome ?? process.env.JAVA_HOME;
  const settings = {
    javacCommand: javaHome ? path.join(javaHome, 'bin', 'javac') : 'javac',
    javaCommand: javaHome ? path.join(javaHome, 'bin', 'java') : 'java',
    timeoutMs: options?.timeoutMs ?? DEFAULT_JAVA_TIMEOUT_MS,
    maxHeapMb: options?.maxHeapMb ?? 128,
  };
  const maxPendingExecutions = options?.maxPendingExecutions ?? DEFAULT_MAX_PENDING_LOCAL_EXECUTIONS;
  // The single Fly machine is small, so Java programs are executed one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  let pendingExecutions = 0;
  return {
    name: 'localJvm',
    execute(program, entryClassName) {
      if (pendingExecutions >= maxPendingExecutions) {
        return Promise.resolve({ kind: 'unavailable', reason: 'The local JVM executor is busy.' });
      }
      pendingExecutions++;
      const run = queue.then(() => executeOnLocalJvm(program, entryClassName, settings));
      queue = run.catch(() => {}).finally(() => pendingExecutions--);
      return run;
    },
  };
}

interface LocalJvmSettings {
  javacCommand: string;
  javaCommand: string;
  timeoutMs: number;
  maxHeapMb: number;
}

/**
 * Compiles with `javac`, then runs under the JVM security manager with an empty policy so that the program
 * cannot touch files, processes, the network, or reflection internals even if it evades the static pre-filter.
 */
async function executeOnLocalJvm(
  program: string,
  entryClassName: string,
  settings: LocalJvmSettings
): Promise<JavaExecutionResult> {
  const directoryPath = await mkdtemp(path.join(tmpdir(), 'trace-dojo-java-'));
  try {
    // javac requires the file to be named after the public class.
    const sourcePath = path.join(directoryPath, `${extractPublicClassName(program) ?? entryClassName}.java`);
    const classesPath = path.join(directoryPath, 'classes');
    const policyPath = path.join(directoryPath, 'judge.policy');
    await Promise.all([writeFile(sourcePath, program), writeFile(policyPath, 'grant {};\n')]);

    const compilation = await runCommand(
      settings.javacCommand,
      ['-J-Xshare:auto', '-J-XX:TieredStopAtLevel=1', '-encoding', 'utf8', '-d', classesPath, sourcePath],
      directoryPath,
      settings.timeoutMs
    );
    if (compilation.kind !== 'executed') return compilation;
    if (compilation.exitCode !== 0) return { kind: 'compileError', message: compilation.stderr };

    return await runCommand(
      settings.javaCommand,
      [
        `-Xmx${settings.maxHeapMb}m`,
        '-XX:+UseSerialGC',
        '-XX:TieredStopAtLevel=1',
        '-Xshare:auto',
        '-Duser.language=en',
        '-Duser.country=US',
        '-Djava.security.manager',
        `-Djava.security.policy==${policyPath}`,
        '-cp',
        classesPath,
        entryClassName,
      ],
      directoryPath,
      settings.timeoutMs
    );
  } finally {
    await rm(directoryPath, { recursive: true, force: true });
  }
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<JavaExecutionResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error && 'code' in error && error.code === 'ENOENT') {
          resolve({ kind: 'unavailable', reason: `Command not found: ${command}` });
        } else if (error && 'killed' in error && error.killed) {
          resolve({ kind: 'timeout' });
        } else {
          const exitCode = error && 'code' in error && typeof error.code === 'number' ? error.code : 0;
          resolve({ kind: 'executed', stdout, stderr, exitCode });
        }
      }
    );
  });
}
