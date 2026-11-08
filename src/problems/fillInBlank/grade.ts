import { executeProgram } from '../../interpreter/program';
import type { JavaChallengeTarget } from '../javaChallenges/types';
import type { JavaDiagnostic } from './javaDiagnostics';
import { isSameTurtleState } from './javaProgram';

/** Recorded with each submission; earlier submissions keep 0 to 4, where 3 was Wandbox and 4 the judge service. */
export const GRADING_STAGE = 5;

export type FillInBlankVerdict =
  | { status: 'correct' }
  | { status: 'incorrect'; detail: string; diagnostics?: JavaDiagnostic[] }
  /** The answer could not be graded, e.g., because the problem session changed while it was being sent. */
  | { status: 'ungradable'; detail: string };

export type FillInBlankGradingResult = Exclude<FillInBlankVerdict, { status: 'ungradable' }>;

const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_LENGTH = 240;

export function gradeFillInBlankCode(problem: JavaChallengeTarget, userProgram: string): FillInBlankGradingResult {
  const execution = executeProgram('java', userProgram);
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
        detail: execution.limit === 'output' ? 'The program printed too much output.' : 'Time limit exceeded.',
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
