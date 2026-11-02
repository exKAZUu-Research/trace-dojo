import type { OrdinaryJavaProblemData } from '../../types';
import { courseIdToLectureIds, courseIdToLectureIndexToProblemIds } from '../problemData';
import { javaChallengeDefinitions } from './definitions';
import { instantiateJavaChallenge } from './instantiate';

export const isOrdinaryBugProblem = (problemId: string): boolean =>
  javaChallengeDefinitions[problemId]?.problemFormat === 'bugFix';

export const getOrdinaryJavaProblem = (
  problemId: string,
  courseId: string,
  lectureId: string
): OrdinaryJavaProblemData => {
  const problem = findOrdinaryJavaProblem(problemId, courseId, lectureId);
  if (!problem) throw new Error('Invalid ordinary Java problem location');
  return problem;
};

export const findOrdinaryJavaProblem = (
  problemId: string,
  courseId: string,
  lectureId: string
): OrdinaryJavaProblemData | undefined => {
  const definition = javaChallengeDefinitions[problemId];
  if (
    definition?.problemFormat !== 'bugFix' ||
    definition.courseId !== courseId ||
    courseIdToLectureIds[definition.courseId]?.[definition.lectureIndex] !== lectureId ||
    !courseIdToLectureIndexToProblemIds[definition.courseId]?.[definition.lectureIndex]?.includes(problemId)
  )
    return undefined;
  return { problemId, problemFormat: 'bugFix', ...instantiateJavaChallenge(problemId, 'bugFix') };
};
