import { createORPCClient, type Client } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { z } from 'zod';

export type JavaExecutionResult =
  | { kind: 'executed'; stdout: string; stderr: string; exitCode: number }
  | { kind: 'compileError'; message: string }
  | { kind: 'timeout' }
  | { kind: 'outputLimitExceeded' }
  /** The executor itself is broken or busy (network failure, rate limit, outage), so another executor should be tried. */
  | { kind: 'unavailable'; reason: string };

export interface JavaExecutor {
  name: string;
  execute: (program: string, entryClassName: string) => Promise<JavaExecutionResult>;
}

export const DEFAULT_WANDBOX_COMPILE_URL = 'https://wandbox.org/api/compile.json';
// Matches the JDK the judge runs so both Java stages accept the same language level.
export const DEFAULT_WANDBOX_COMPILER = 'openjdk-jdk-21+35';
/** Both services stop a program well before this, so the ceiling only bounds a hung connection. */
const REQUEST_TIMEOUT_MS = 60_000;

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
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    name: 'wandbox',
    async execute(program, entryClassName) {
      // javac requires the file to be named after the public class, which is the judge wrapper.
      const fileName = `${entryClassName}.java`;
      let response: Response;
      try {
        response = await fetch(compileUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            compiler,
            code: '',
            codes: [{ file: fileName, code: program }],
            'compiler-option-raw': fileName,
            // The security manager keeps the program from reflecting into the judge's state (options are newline-separated).
            'runtime-option-raw': `-Djava.security.manager\n${entryClassName}`,
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
      // `compiler_error` also carries warnings of successful compilations, so only a run that never started counts.
      // Wandbox kills a program that exceeds its time limit with exit status 137 and reports no signal.
      if (signal || (status !== '0' && (status === '137' || /\bKilled\b/.test(program_error ?? '')))) {
        return { kind: 'timeout' };
      }
      if (status !== '0' && !program_output) {
        // The judge always prints once it runs, so a silent failure is either javac or a run that never started.
        return compiler_error
          ? { kind: 'compileError', message: compiler_error }
          : { kind: 'unavailable', reason: `The Wandbox run did not start: ${program_error ?? ''}` };
      }
      return { kind: 'executed', stdout: program_output ?? '', stderr: program_error ?? '', exitCode: Number(status) };
    },
  };
}

export const DEFAULT_JUDGE_URL = 'https://judge.willbooster.com';
/** The judge truncates each stream at this length instead of reporting the limit as exceeded. */
const JUDGE_MAX_OUTPUT_LENGTH = 50_000;
const JUDGE_DECISION_CODE = {
  waitingJudge: 0,
  judgeNotAvailable: 1,
  timeLimitExceeded: 1002,
  outputSizeLimitExceeded: 1004,
  buildError: 1100,
  buildTimeLimitExceeded: 1101,
};

const judgeResponseSchema = z.object({
  decisionCode: z.number(),
  exitStatus: z.number(),
  stdout: z.string(),
  stderr: z.string(),
});

interface JudgeExecuteInput {
  files: { path: string; data: string }[];
}

/**
 * Runs the program on the judge service (https://github.com/WillBooster/judge), which compiles and runs it
 * as an unprivileged sandbox user under OS-level time, memory, and output limits on its own machines.
 */
export function createJudgeExecutor(options?: { url?: string; apiKey?: string; timeoutMs?: number }): JavaExecutor {
  const url = options?.url ?? process.env.JUDGE_URL ?? DEFAULT_JUDGE_URL;
  const apiKey = options?.apiKey ?? process.env.JUDGE_API_KEY;
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  // The judge publishes no client package, so the single procedure this executor calls is typed here.
  const client = createORPCClient<{ v2Execute: Client<Record<never, never>, JudgeExecuteInput, unknown, Error> }>(
    new RPCLink({ url: `${url}/api/orpc`, headers: apiKey ? { 'x-api-key': apiKey } : {} })
  );
  return {
    name: 'judge',
    async execute(program, entryClassName) {
      // The judge renames the file after its public class and runs the class of that name.
      let response: unknown;
      try {
        response = await client.v2Execute(
          { files: [{ path: `${entryClassName}.java`, data: program }] },
          { signal: AbortSignal.timeout(timeoutMs) }
        );
      } catch (error) {
        return { kind: 'unavailable', reason: `Failed to call the judge: ${String(error)}` };
      }
      const parsed = judgeResponseSchema.safeParse(response);
      if (!parsed.success) {
        return { kind: 'unavailable', reason: 'The judge responded with an unexpected body' };
      }
      const { decisionCode, exitStatus, stderr, stdout } = parsed.data;
      switch (decisionCode) {
        case JUDGE_DECISION_CODE.waitingJudge:
        case JUDGE_DECISION_CODE.judgeNotAvailable: {
          return { kind: 'unavailable', reason: `The judge did not run the program: ${stderr}` };
        }
        case JUDGE_DECISION_CODE.buildError: {
          return { kind: 'compileError', message: stderr };
        }
        case JUDGE_DECISION_CODE.buildTimeLimitExceeded:
        case JUDGE_DECISION_CODE.timeLimitExceeded: {
          return { kind: 'timeout' };
        }
        case JUDGE_DECISION_CODE.outputSizeLimitExceeded: {
          return { kind: 'outputLimitExceeded' };
        }
      }
      // Truncated output would hide the result rather than falsify it, but the program is at fault either way.
      return stdout.length >= JUDGE_MAX_OUTPUT_LENGTH
        ? { kind: 'outputLimitExceeded' }
        : { kind: 'executed', stdout, stderr, exitCode: exitStatus };
    },
  };
}
