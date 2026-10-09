import { randomUUID } from 'node:crypto';

import type { InstantiatedProblem } from '../instantiateProblem';

import { normalizeCompilerDiagnostics } from './compilerDiagnostics';
import type { JavaDiagnostic } from './javaDiagnostics';
import type { JavaExecutor } from './javaExecutors';
import { createJudgeExecutor, createWandboxExecutor } from './javaExecutors';
import {
  buildJavaJudgeProgram,
  findForbiddenJavaPattern,
  isSameTurtleState,
  JAVA_JUDGE_CLASS_NAME,
  MAX_JAVA_PROGRAM_LENGTH,
  parseJavaJudgeOutput,
} from './javaProgram';

// Stages 1 and 2 remain valid in legacy submission history. New grading uses 0, 3, and 4.
export type GradingStage = 0 | 1 | 2 | 3 | 4;

export type FillInBlankGradingResult =
  | { status: 'correct'; stage: GradingStage }
  | { status: 'incorrect'; stage: GradingStage; detail: string; diagnostics?: JavaDiagnostic[] }
  /** No grader could judge the answer (e.g., every Java executor was unavailable). */
  | { status: 'ungradable'; detail: string };

export type FillInBlankVerdict =
  | { status: 'correct' }
  | { status: 'incorrect'; detail: string; diagnostics?: JavaDiagnostic[] }
  | { status: 'ungradable'; detail: string };

export interface GradingOptions {
  /** Executors used for stages 3 and 4, in order. Defaults to Wandbox followed by the judge service. */
  javaExecutors?: JavaExecutor[];
}

const defaultJavaExecutors: JavaExecutor[] = [createWandboxExecutor(), createJudgeExecutor()];

export async function gradeFillInBlankCode(
  problem: InstantiatedProblem,
  userProgram: string,
  options?: GradingOptions
): Promise<FillInBlankGradingResult> {
  const executors = options?.javaExecutors ?? defaultJavaExecutors;
  const forbiddenPattern = findForbiddenJavaPattern(userProgram);
  if (forbiddenPattern) {
    return { status: 'incorrect', stage: 0, detail: `The program uses a forbidden feature: ${forbiddenPattern}` };
  }
  const resultMarker = `__TRACE_DOJO_RESULT_${randomUUID().replaceAll('-', '')}__`;
  const built = buildJavaJudgeProgram(userProgram, resultMarker);
  if (built.program.length > MAX_JAVA_PROGRAM_LENGTH) {
    return { status: 'incorrect', stage: 0, detail: 'The program is too long.' };
  }

  const reasons: string[] = [];
  for (const executor of executors) {
    const stage: GradingStage = executor.name === 'wandbox' ? 3 : 4;
    const result = await executor.execute(built.program, JAVA_JUDGE_CLASS_NAME);
    switch (result.kind) {
      case 'unavailable': {
        reasons.push(`${executor.name}: ${result.reason}`);
        continue;
      }
      case 'compileError': {
        return {
          status: 'incorrect',
          stage,
          detail: 'Compile error.',
          diagnostics: normalizeCompilerDiagnostics(result.message, built),
        };
      }
      case 'timeout': {
        return { status: 'incorrect', stage, detail: 'Time limit exceeded.' };
      }
      case 'memoryLimitExceeded': {
        return { status: 'incorrect', stage, detail: 'The program used too much memory.' };
      }
      case 'outputLimitExceeded': {
        return { status: 'incorrect', stage, detail: 'The program printed too much output.' };
      }
      case 'executed': {
        const actual = parseJavaJudgeOutput(result.stderr, resultMarker);
        if (!actual) {
          return { status: 'incorrect', stage, detail: 'The program did not finish normally.' };
        }
        if (actual.exception) {
          return { status: 'incorrect', stage, detail: 'The program threw an exception.' };
        }
        return isSameTurtleState({ board: problem.finalBoard, turtles: problem.finalTurtles }, actual)
          ? { status: 'correct', stage }
          : { status: 'incorrect', stage, detail: 'The final state differs from the expected one.' };
      }
    }
  }
  return { status: 'ungradable', detail: reasons.join('\n') };
}
