import { notFound } from 'next/navigation';

import { withAuthorizationOnServer } from '@/app/utils/withAuth';
import type { MyAuthorizedNextPageOrLayout } from '@/app/utils/withAuth';
import { db } from '@/infrastructures/database';
import { logger } from '@/infrastructures/pino';
import { getLearningPeriodFilter } from '@/learningPeriod';
import { instantiateProblem, isFillInBlankProblem } from '@/problems/instantiateProblem';
import { findOrdinaryJavaProblem, isOrdinaryBugProblem } from '@/problems/javaChallenges/ordinaryProblem';
import { courseIdToLectureIds, courseIdToLectureIndexToProblemIds } from '@/problems/problemData';
import type { CourseId, ProblemId } from '@/problems/problemData';

import { problemSessions } from '../../../../../../../../../db/schema';
import { ProblemPageOnClient } from './pageOnClient';

const ProblemPage: MyAuthorizedNextPageOrLayout<{
  courseId: CourseId;
  lectureId: string;
  problemId: ProblemId;
}> = async ({ params, session }) => {
  if (
    !Object.hasOwn(courseIdToLectureIds, params.courseId) ||
    !Object.hasOwn(courseIdToLectureIndexToProblemIds, params.courseId)
  )
    notFound();
  const lectureIndex = courseIdToLectureIds[params.courseId].indexOf(params.lectureId);
  if (
    lectureIndex === -1 ||
    !courseIdToLectureIndexToProblemIds[params.courseId][lectureIndex]?.includes(params.problemId)
  )
    notFound();
  const javaProblem = isOrdinaryBugProblem(params.problemId)
    ? (findOrdinaryJavaProblem(params.problemId, params.courseId, params.lectureId) ?? notFound())
    : undefined;
  let incompleteProblemSession = await db.query.problemSessions.findFirst({
    where: {
      ...getLearningPeriodFilter(),
      userId: session.superTokensUserId,
      courseId: params.courseId,
      lectureId: params.lectureId,
      problemId: params.problemId,
      completedAt: { isNull: true },
    },
  });
  if (
    incompleteProblemSession &&
    javaProblem &&
    (incompleteProblemSession.problemType !== 'bugFix' || incompleteProblemSession.traceItemIndex !== 0)
  )
    notFound();
  incompleteProblemSession ??= db
    .insert(problemSessions)
    .values({
      userId: session.superTokensUserId,
      courseId: params.courseId,
      lectureId: params.lectureId,
      problemId: params.problemId,
      problemVariablesSeed: Date.now().toString(),
      problemType: javaProblem ? 'bugFix' : isFillInBlankProblem(params.problemId) ? 'fillInBlank' : 'executionResult',
      traceItemIndex: 0,
    })
    .returning()
    .get()!;
  logger.debug('incompleteProblemSession: %o', incompleteProblemSession);

  const problem = javaProblem
    ? undefined
    : (instantiateProblem(params.problemId, incompleteProblemSession.problemVariablesSeed) ?? notFound());

  return (
    <ProblemPageOnClient
      key={incompleteProblemSession.id}
      javaProblem={javaProblem}
      problem={problem}
      initialProblemSession={incompleteProblemSession}
      userId={session.superTokensUserId}
    />
  );
};

export default withAuthorizationOnServer(ProblemPage);
