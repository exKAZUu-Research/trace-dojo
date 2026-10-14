import { courseIdToLectureIds, courseIdToLectureIndexToProblemIds } from '../problemData';
import { javaChallengeDefinitions } from './definitions';
import { instantiateJavaChallenge } from './instantiate';
import type { OrdinaryJavaProblemData } from '../../types';

export const isOrdinaryBugProblem = (problemId: string): boolean =>
  javaChallengeDefinitions[problemId]?.problemFormat === 'bugFix';

export const getOrdinaryJavaProblem = (
  problemId: string,
  courseId: string,
  lectureId: string
): OrdinaryJavaProblemData => {
  const definition = javaChallengeDefinitions[problemId];
  if (
    definition?.problemFormat !== 'bugFix' ||
    definition.courseId !== courseId ||
    courseIdToLectureIds[definition.courseId]?.[definition.lectureIndex] !== lectureId ||
    !courseIdToLectureIndexToProblemIds[definition.courseId]?.[definition.lectureIndex]?.includes(problemId)
  )
    throw new Error('Invalid ordinary Java problem location');
  return { problemId, problemFormat: 'bugFix', ...instantiateJavaChallenge(problemId, 'bugFix') };
};
