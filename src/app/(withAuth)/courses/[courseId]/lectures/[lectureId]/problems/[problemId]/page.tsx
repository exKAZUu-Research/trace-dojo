import type { NextPage } from 'next';
import { cookies } from 'next/headers';

import { ProblemPageOnClient } from './pageOnClient';

import { logger } from '@/infrastructures/pino';
import { prisma } from '@/infrastructures/prisma';
import type { CourseId, ProblemId } from '@/problems/problemData';
import { getNonNullableSessionOnServer } from '@/utils/session';

type Props = {
  params: Promise<{ courseId: CourseId; lectureId: string; problemId: ProblemId }>;
};

const ProblemPage: NextPage<Props> = async (props) => {
  const session = await getNonNullableSessionOnServer(await cookies());

  const params = await props.params;
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
  if (!incompleteProblemSession) {
    incompleteProblemSession = await prisma.problemSession.create({
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
  }
  logger.debug('incompleteProblemSession: %o', incompleteProblemSession);

  return <ProblemPageOnClient initialProblemSession={incompleteProblemSession} userId={session.superTokensUserId} />;
};

export default ProblemPage;
