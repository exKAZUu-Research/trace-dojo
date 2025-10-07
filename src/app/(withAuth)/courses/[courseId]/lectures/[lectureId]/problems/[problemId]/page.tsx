import { ProblemPageOnClient } from './pageOnClient';

import { withAuthorizationOnServer } from '@/app/utils/withAuth';
import type { MyAuthorizedNextPageOrLayout } from '@/app/utils/withAuth';
import { logger } from '@/infrastructures/pino';
import { prisma } from '@/infrastructures/prisma';
import type { CourseId, ProblemId } from '@/problems/problemData';

const ProblemPage: MyAuthorizedNextPageOrLayout<{
  courseId: CourseId;
  lectureId: string;
  problemId: ProblemId;
}> = async ({ params, session }) => {
  let incompleteProblemSession = await prisma.problemSession.findFirst({
    where: {
      userId: session.superTokensUserId,
      courseId: params.courseId,
      lectureId: params.lectureId,
      problemId: params.problemId,
      // eslint-disable-next-line unicorn/no-null
      completedAt: null,
    },
  });
  incompleteProblemSession ??= await prisma.problemSession.create({
    data: {
      userId: session.superTokensUserId,
      courseId: params.courseId,
      lectureId: params.lectureId,
      problemId: params.problemId,
      problemVariablesSeed: Date.now().toString(),
      problemType: 'executionResult',
      traceItemIndex: 0,
    },
  });
  logger.debug('incompleteProblemSession: %o', incompleteProblemSession);

  return <ProblemPageOnClient initialProblemSession={incompleteProblemSession} userId={session.superTokensUserId} />;
};

export default withAuthorizationOnServer(ProblemPage);
