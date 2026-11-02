import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { JavaExecutionResult, JavaExecutor } from '../../src/problems/fillInBlank/javaExecutors';

const outputLimit = 256 * 1024;
let active = 0;
const waiting: (() => void)[] = [];

interface ProcessResult {
  code: number | null;
  stderr: string;
  failure?: 'timeout' | 'outputLimitExceeded';
}

export const localJavaExecutor = createLocalJavaExecutor();

export function createLocalJavaExecutor(root = resolve('.tmp/localJavaExecutor')): JavaExecutor {
  return {
    name: 'local-java-21',
    async execute(program, entryClassName) {
      if (!/^[A-Za-z_$][\w$]*$/.test(entryClassName)) throw new Error('Invalid Java entry class name');
      await acquire();
      let directory: string | undefined;
      try {
        await mkdir(root, { recursive: true });
        directory = await mkdtemp(`${root}/run-`);
        await writeFile(`${directory}/${entryClassName}.java`, program);
        const compilation = await runProcess(
          'javac',
          ['-J-Xmx128m', '--release', '21', '-encoding', 'utf8', `${entryClassName}.java`],
          directory,
          20_000
        );
        if (compilation.failure) return { kind: compilation.failure };
        if (compilation.code === null)
          return { kind: 'unavailable', reason: 'Java compiler was terminated by a signal' };
        if (compilation.code !== 0) return { kind: 'compileError', message: compilation.stderr };
        const execution = await runProcess(
          'java',
          ['-Xmx64m', '-XX:MaxMetaspaceSize=64m', '-cp', directory, entryClassName],
          directory,
          5000
        );
        if (execution.failure) return { kind: execution.failure };
        if (execution.stderr.includes('java.lang.OutOfMemoryError')) return { kind: 'memoryLimitExceeded' };
        if (execution.code !== 0)
          return { kind: 'unavailable', reason: `Java exited ${execution.code}: ${execution.stderr}` };
        return { kind: 'executed', stderr: execution.stderr };
      } catch (error) {
        return { kind: 'unavailable', reason: String(error) } satisfies JavaExecutionResult;
      } finally {
        try {
          if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
          const next = waiting.shift();
          if (next) next();
          else active--;
        }
      }
    },
  };
}

async function acquire(): Promise<void> {
  if (active < 2) active++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderrChunks: Buffer[] = [];
    let bytes = 0;
    let failure: ProcessResult['failure'];
    const stop = (reason: NonNullable<ProcessResult['failure']>): void => {
      failure ??= reason;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const receive = (chunk: Buffer, isStderr: boolean): void => {
      bytes += chunk.length;
      if (bytes > outputLimit) stop('outputLimitExceeded');
      else if (isStderr) stderrChunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => receive(chunk, false));
    child.stderr.on('data', (chunk: Buffer) => receive(chunk, true));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr: Buffer.concat(stderrChunks).toString('utf8'), failure });
    });
  });
}
