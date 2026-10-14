import { notFound } from 'next/navigation';
import { problemSessions } from '../../../../../../../../../db/schema';
import { ProblemPageOnClient } from './pageOnClient';

import { withAuthorizationOnServer } from '@/app/utils/withAuth';
import type { MyAuthorizedNextPageOrLayout } from '@/app/utils/withAuth';
import { logger } from '@/infrastructures/pino';
import { db } from '@/infrastructures/database';
import { getLearningPeriodFilter } from '@/learningPeriod';
import { isFillInBlankProblem } from '@/problems/instantiateProblem';
import { getOrdinaryJavaProblem, isOrdinaryBugProblem } from '@/problems/javaChallenges/ordinaryProblem';
import type { CourseId, ProblemId } from '@/problems/problemData';

const ProblemPage: MyAuthorizedNextPageOrLayout<{
  courseId: CourseId;
  lectureId: string;
  problemId: ProblemId;
}> = async ({ params, session }) => {
  const javaProblem = isOrdinaryBugProblem(params.problemId)
    ? getOrdinaryJavaProblem(params.problemId, params.courseId, params.lectureId)
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

  return (
    <ProblemPageOnClient
      key={incompleteProblemSession.id}
      javaProblem={javaProblem}
      initialProblemSession={incompleteProblemSession}
      userId={session.superTokensUserId}
    />
  );
};

export default withAuthorizationOnServer(ProblemPage);
