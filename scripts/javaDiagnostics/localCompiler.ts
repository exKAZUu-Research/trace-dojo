import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

const timeoutMs = 15_000;
const maxOutputBytes = 128 * 1024;
export const compilerArguments = [
  '-J-Duser.language=en',
  '-J-Duser.country=US',
  '-J-Xmx256m',
  '-encoding',
  'utf8',
  '-proc:none',
  '-implicit:none',
  '-classpath',
  'empty',
  '-sourcepath',
  'empty',
  '-d',
  'classes',
  '-Xmaxerrs',
  '20',
  'TraceDojoJudge.java',
];

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  failure?: string;
}
export type LocalCompilationResult = ProcessResult & {
  kind: 'compiled' | 'compileError' | 'toolError';
};

export async function compileJavaProgram(program: string): Promise<LocalCompilationResult> {
  const parent = resolvePath('.tmp/javaDiagnostics');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(`${parent}/compile-`);
  try {
    await mkdir(`${directory}/empty`);
    await mkdir(`${directory}/classes`);
    await writeFile(`${directory}/TraceDojoJudge.java`, program, 'utf8');
    const result = await runCompiler(compilerArguments, directory);
    return {
      ...result,
      kind:
        result.failure || (result.exitCode !== 0 && result.exitCode !== 1)
          ? 'toolError'
          : result.exitCode === 0
            ? 'compiled'
            : 'compileError',
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function readJavaCompilerVersion(): Promise<string> {
  const result = await runCompiler(['-version'], process.cwd());
  if (result.failure || result.exitCode !== 0)
    throw new Error(`Cannot probe javac: ${result.failure ?? result.stderr}`);
  return `${result.stdout}${result.stderr}`.trim();
}

function runCompiler(args: string[], cwd: string): Promise<ProcessResult> {
  const env = { ...process.env };
  for (const name of ['JDK_JAVAC_OPTIONS', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH']) {
    delete env[name];
  }
  return new Promise((resolve) => {
    const child = spawn('javac', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: string | undefined;
    const stop = (reason: string): void => {
      failure ??= reason;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('javac exceeded its time limit'), timeoutMs);
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      const remaining = maxOutputBytes - outputBytes;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) stop('javac exceeded its output limit');
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', (error) => {
      failure ??= error.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code ?? undefined,
        ...(failure ? { failure } : {}),
      });
    });
  });
}
