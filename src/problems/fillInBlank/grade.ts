import type { ProgramExecution } from '../../interpreter/interpreter';
import type { ExecutionLimitError } from '../../interpreter/limits';
import { InterpreterStoppedError } from '../../interpreter/worker/interpreterRunner';
import type { JavaChallengeTarget } from '../javaChallenges/types';
import type { ProblemRunner } from '../problemRunner';
import type { JavaDiagnostic } from './javaDiagnostics';
import { isSameTurtleState } from './javaProgram';

export type FillInBlankVerdict =
  | { status: 'correct' }
  | { status: 'incorrect'; detail: string; diagnostics?: JavaDiagnostic[] }
  /**
   * The answer could not be graded: the interpreter failed to run it ({@link INTERPRETER_FAILURE_DETAIL}), or the
   * problem session changed while it was being sent.
   */
  | { status: 'ungradable'; detail: string };

export const INTERPRETER_FAILURE_DETAIL = 'The interpreter could not run the program.';

const LIMIT_DETAILS: Partial<Record<ExecutionLimitError['limit'], string>> = {
  output: 'The program printed too much output.',
  storage: 'The program wrote too much to files.',
};
const TIME_LIMIT_DETAIL = 'Time limit exceeded.';
const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_LENGTH = 240;

export async function gradeFillInBlankCode(
  runner: ProblemRunner,
  problem: JavaChallengeTarget,
  userProgram: string
): Promise<FillInBlankVerdict> {
  let execution: ProgramExecution;
  try {
    execution = await runner.executeProgram('java', userProgram);
  } catch (error) {
    // The runner stops a program that the interpreter's own limits fail to stop, which is as endless to learners.
    if (error instanceof InterpreterStoppedError && error.reason === 'timeout')
      return { status: 'incorrect', detail: TIME_LIMIT_DETAIL };
    console.error(error);
    return { status: 'ungradable', detail: INTERPRETER_FAILURE_DETAIL };
  }
  switch (execution.kind) {
    case 'compileError': {
      return {
        status: 'incorrect',
        detail: 'Compile error.',
        diagnostics: execution.diagnostics.slice(0, MAX_DIAGNOSTICS).map(({ row, message }) => ({
          line: row + 1,
          message: message.slice(0, MAX_DIAGNOSTIC_LENGTH),
        })),
      };
    }
    case 'limitExceeded': {
      return {
        status: 'incorrect',
        detail: LIMIT_DETAILS[execution.limit] ?? TIME_LIMIT_DETAIL,
      };
    }
    case 'executed': {
      if (execution.uncaughtException) return { status: 'incorrect', detail: 'The program threw an exception.' };
      const expected = { board: problem.finalBoard, turtles: problem.finalTurtles };
      const actual = { board: execution.finalBoard, turtles: execution.finalTurtles };
      return isSameTurtleState(expected, actual)
        ? { status: 'correct' }
        : { status: 'incorrect', detail: 'The final state differs from the expected one.' };
    }
  }
}
