import { getBrowserProblemRunner } from '../browserProblemRunner';
import type { JavaChallengeTarget } from '../javaChallenges/types';
import { type FillInBlankVerdict, gradeFillInBlankCode } from './grade';

/**
 * Grades a learner's program in the interpreter worker and reports the verdict to the server, which stores it.
 *
 * @param report Not called for an answer that could not be graded, which leaves nothing to store.
 */
export async function gradeInBrowser(
  problem: JavaChallengeTarget,
  code: string,
  report: (status: 'correct' | 'incorrect') => Promise<unknown>
): Promise<FillInBlankVerdict> {
  const verdict = await gradeFillInBlankCode(getBrowserProblemRunner(), problem, code);
  if (verdict.status !== 'ungradable') await report(verdict.status);
  return verdict;
}
