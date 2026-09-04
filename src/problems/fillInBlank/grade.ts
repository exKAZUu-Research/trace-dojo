import { randomUUID } from 'node:crypto';

import type { InstantiatedProblem } from '../instantiateProblem';
import { SCOPE_ERROR_NAME, TRACE_BUDGET_EXCEEDED_MESSAGE, traceProgram } from '../traceProgram';
import { logger } from '../../infrastructures/pino';

import { fillBlanks, normalizeAnswer } from './blanks';
import type { JavaExecutor } from './javaExecutors';
import { createLocalJvmExecutor, createWandboxExecutor } from './javaExecutors';
import {
  buildJavaJudgeProgram,
  findForbiddenJavaPattern,
  isSameTurtleState,
  JAVA_JUDGE_CLASS_NAME,
  MAX_JAVA_PROGRAM_LENGTH,
  parseJavaJudgeOutput,
} from './javaProgram';
import { extractNativeNames, translateJavaFragment, UnsupportedJavaError } from './javaToInstrumented';

/**
 * 0: rejected by the static pre-filter before any Java execution,
 * 1: exact match with the model answers,
 * 2: re-execution with the instrumented (JavaScript) program,
 * 3: execution on Wandbox,
 * 4: execution on the local JVM.
 */
export type GradingStage = 0 | 1 | 2 | 3 | 4;

export type FillInBlankGradingResult =
  | { status: 'correct'; stage: GradingStage }
  | { status: 'incorrect'; stage: GradingStage; detail: string }
  /** No grader could judge the answer (e.g., every Java executor was unavailable). */
  | { status: 'ungradable'; detail: string };

export interface GradingOptions {
  /** Executors used for stages 3 and 4, in order. Defaults to Wandbox followed by the local JVM. */
  javaExecutors?: JavaExecutor[];
}

const defaultJavaExecutors: JavaExecutor[] = [createWandboxExecutor(), createLocalJvmExecutor()];

export async function gradeFillInBlankAnswers(
  problem: InstantiatedProblem,
  answers: readonly string[],
  options?: GradingOptions
): Promise<FillInBlankGradingResult> {
  if (answers.length !== problem.blankAnswers.length) {
    return { status: 'incorrect', stage: 1, detail: 'The number of answers differs from the number of blanks.' };
  }
  if (answers.every((answer, index) => normalizeAnswer(answer) === normalizeAnswer(problem.blankAnswers[index]))) {
    return { status: 'correct', stage: 1 };
  }

  // Stage 2 is authoritative for wrong answers, but its "correct" is provisional: the translator mirrors Java
  // semantics for what it accepts, yet only javac can confirm that the answer is valid Java at all.
  const stage2Result = gradeByInstrumentedProgram(problem, answers);
  if (stage2Result?.status === 'incorrect') return stage2Result;
  const javaResult = await gradeByJavaExecution(problem, answers, options?.javaExecutors ?? defaultJavaExecutors);
  if (javaResult.status === 'ungradable' && stage2Result) {
    logger.warn('No Java executor was available; accepting the stage 2 verdict: %s', javaResult.detail);
    return stage2Result;
  }
  return javaResult;
}

function gradeByInstrumentedProgram(
  problem: InstantiatedProblem,
  answers: readonly string[]
): FillInBlankGradingResult | undefined {
  const nativeNames = extractNativeNames(problem.instrumentedTemplate);
  let translatedAnswers: string[];
  try {
    translatedAnswers = answers.map((answer) => translateJavaFragment(answer, nativeNames));
  } catch (error) {
    if (error instanceof UnsupportedJavaError) return;
    throw error;
  }

  try {
    const actual = traceProgram(
      fillBlanks(problem.instrumentedTemplate, translatedAnswers),
      fillBlanks(problem.displayProgramTemplate, answers),
      problem.languageId,
      { collectTrace: false }
    );
    const isCorrect =
      isSameTurtleState(
        { board: problem.finalBoard, turtles: problem.finalTurtles },
        { board: actual.finalBoard, turtles: actual.finalTurtles }
      ) && stringifyVariables(problem.finalVars) === stringifyVariables(actual.finalVars);
    return isCorrect
      ? { status: 'correct', stage: 2 }
      : { status: 'incorrect', stage: 2, detail: 'The final state differs from the expected one.' };
  } catch (error) {
    // A JavaScript engine error or an exhausted budget may be a translator limitation, so let real Java judge the answer.
    // Errors thrown by the turtle runtime itself (e.g. out of bounds) mirror Java behavior and stay authoritative.
    if (
      error instanceof SyntaxError ||
      error instanceof TypeError ||
      error instanceof ReferenceError ||
      error instanceof RangeError ||
      (error instanceof Error && (error.name === SCOPE_ERROR_NAME || error.message === TRACE_BUDGET_EXCEEDED_MESSAGE))
    ) {
      return;
    }
    return { status: 'incorrect', stage: 2, detail: `The program failed: ${String(error)}` };
  }
}

function stringifyVariables(variables: Record<string, unknown>): string {
  return JSON.stringify(Object.entries(variables).toSorted(([a], [b]) => a.localeCompare(b)));
}

async function gradeByJavaExecution(
  problem: InstantiatedProblem,
  answers: readonly string[],
  executors: JavaExecutor[]
): Promise<FillInBlankGradingResult> {
  const userProgram = fillBlanks(problem.displayProgramTemplate, answers);
  const forbiddenPattern = findForbiddenJavaPattern(userProgram);
  if (forbiddenPattern) {
    return { status: 'incorrect', stage: 0, detail: `The program uses a forbidden feature: ${forbiddenPattern}` };
  }
  const resultMarker = `__TRACE_DOJO_RESULT_${randomUUID().replaceAll('-', '')}__`;
  const program = buildJavaJudgeProgram(userProgram, resultMarker);
  if (program.length > MAX_JAVA_PROGRAM_LENGTH) {
    return { status: 'incorrect', stage: 0, detail: 'The program is too long.' };
  }

  const reasons: string[] = [];
  for (const executor of executors) {
    const stage: GradingStage = executor.name === 'wandbox' ? 3 : 4;
    const result = await executor.execute(program, JAVA_JUDGE_CLASS_NAME);
    switch (result.kind) {
      case 'unavailable': {
        reasons.push(`${executor.name}: ${result.reason}`);
        continue;
      }
      case 'compileError': {
        return { status: 'incorrect', stage, detail: `Compile error: ${result.message}` };
      }
      case 'timeout': {
        return { status: 'incorrect', stage, detail: 'Time limit exceeded.' };
      }
      case 'outputLimitExceeded': {
        return { status: 'incorrect', stage, detail: 'The program printed too much output.' };
      }
      case 'executed': {
        const actual = parseJavaJudgeOutput(result.stdout, resultMarker);
        if (!actual) {
          return { status: 'incorrect', stage, detail: `The program did not finish normally: ${result.stderr}` };
        }
        if (actual.exception) {
          return { status: 'incorrect', stage, detail: `The program threw an exception: ${actual.exception}` };
        }
        return isSameTurtleState({ board: problem.finalBoard, turtles: problem.finalTurtles }, actual)
          ? { status: 'correct', stage }
          : { status: 'incorrect', stage, detail: 'The final state differs from the expected one.' };
      }
    }
  }
  return { status: 'ungradable', detail: reasons.join('\n') };
}
