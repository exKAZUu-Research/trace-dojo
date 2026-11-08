import { notFound } from 'next/navigation';

import { withAuthorizationOnServer } from '@/app/utils/withAuth';
import type { MyAuthorizedNextPageOrLayout } from '@/app/utils/withAuth';
import { db } from '@/infrastructures/database';
import { logger } from '@/infrastructures/pino';
import { getLearningPeriodFilter } from '@/learningPeriod';
import { instantiateProblem, isFillInBlankProblem } from '@/problems/instantiateProblem';
import { courseIdToLectureIds, courseIdToLectureIndexToProblemIds, getProblemProgram } from '@/problems/problemData';
import type { CourseId, ProblemId } from '@/problems/problemData';

import { problemSessions } from '../../../../../../../../../db/schema';
import { ProblemPageOnClient } from './pageOnClient';

const ProblemPage: MyAuthorizedNextPageOrLayout<{
  courseId: CourseId;
  lectureId: string;
  problemId: ProblemId;
}> = async ({ params, session }) => {
  const lectureIndex = courseIdToLectureIds[params.courseId]?.indexOf(params.lectureId);
  if (
    lectureIndex === undefined ||
    lectureIndex < 0 ||
    !courseIdToLectureIndexToProblemIds[params.courseId]?.[lectureIndex]?.includes(params.problemId) ||
    !getProblemProgram(params.problemId)
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

  const problem = instantiateProblem(params.problemId, incompleteProblemSession.problemVariablesSeed) ?? notFound();

  return (
    <ProblemPageOnClient
      key={incompleteProblemSession.id}
      problem={problem}
      initialProblemSession={incompleteProblemSession}
      userId={session.superTokensUserId}
    />
  );
};

export default withAuthorizationOnServer(ProblemPage);
