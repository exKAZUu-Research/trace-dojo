import { notFound } from 'next/navigation';
import { courseIdToLectureIds, courseIdToLectureIndexToProblemIds } from '@/problems/problemData';
import { problemSessions } from '../../../../../../../../../db/schema';
import { ProblemPageOnClient } from './pageOnClient';

import { withAuthorizationOnServer } from '@/app/utils/withAuth';
import type { MyAuthorizedNextPageOrLayout } from '@/app/utils/withAuth';
import { logger } from '@/infrastructures/pino';
import { db } from '@/infrastructures/database';
import { getLearningPeriodFilter } from '@/learningPeriod';
import { isFillInBlankProblem } from '@/problems/instantiateProblem';
import type { CourseId, ProblemId } from '@/problems/problemData';

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
  incompleteProblemSession ??= db
    .insert(problemSessions)
    .values({
      userId: session.superTokensUserId,
      courseId: params.courseId,
      lectureId: params.lectureId,
      problemId: params.problemId,
      problemVariablesSeed: Date.now().toString(),
      problemType: isFillInBlankProblem(params.problemId) ? 'fillInBlank' : 'executionResult',
      traceItemIndex: 0,
    })
    .returning()
    .get()!;
  logger.debug('incompleteProblemSession: %o', incompleteProblemSession);

  return (
    <ProblemPageOnClient
      key={incompleteProblemSession.id}
      initialProblemSession={incompleteProblemSession}
      userId={session.superTokensUserId}
    />
  );
};

export default withAuthorizationOnServer(ProblemPage);
